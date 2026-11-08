//! 多人在线编辑的 WebSocket 接口(多用户设计说明)。
//!
//! 两个入口共用一个连接循环:
//! - `GET /api/v1/collab/ws?doc=<资源键>`:登录用户(会话 cookie,走统一的鉴权守卫);
//! - `GET /api/v1/share/{token}/collab?doc=<资源键>`:经分享链接进来的登录用户或游客(在 `share_public` 里)。
//!
//! 握手时检查 `Origin`(浏览器跨站发起的 WebSocket 会带上自己的来源),算一次权限;
//! 权限的重新核对由房间定期做([`WebCollabAuth`]),授权被降级 / 收回后连接立刻变只读或断开。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use kb_collab::{Access, CollabAuth, CollabHub, DocKind, DocRef, Frame, JoinRequest, Participant};

use kb_core::account::User;
use kb_core::ports::system::IdentityStore;
use kb_core::share::{Action, DocRef as ShareDoc, ResourceKey, Role};
use kb_core::{KbError, Result};
use serde::Deserialize;

use crate::api::{self, AiSwitch, AppState, error};
use crate::auth::Identity;
use crate::auth::session;
use kb_core::config::ConfigStore;

/// 心跳间隔。Cloudflare 对闲置 WebSocket 约 100 秒断开,25 秒一次留足余量。
const PING_EVERY: Duration = Duration::from_secs(25);
/// 超过这么久没收到客户端的任何帧(包括 pong)就当它死了。
const DEAD_AFTER: Duration = Duration::from_secs(80);
/// 每个用户同时最多的协作连接数(多个标签页、多台设备)。
const MAX_CONNS_PER_USER: usize = 20;

/// 协作接口的依赖(放在 `AppState.collab`,没有 = 功能未启用)。
pub struct CollabEndpoint {
    /// 协作中心。
    pub hub: Arc<CollabHub>,
    limits: Mutex<HashMap<String, usize>>,
}

impl CollabEndpoint {
    /// 构造。
    pub fn new(hub: Arc<CollabHub>) -> Arc<Self> {
        Arc::new(Self {
            hub,
            limits: Mutex::new(HashMap::new()),
        })
    }

    /// 占一个连接名额;满了返回 `None`。名额随返回的守卫释放。
    pub(crate) fn reserve(self: &Arc<Self>, key: String, cap: usize) -> Option<ConnSlot> {
        let mut limits = self.limits.lock().ok()?;
        let used = limits.entry(key.clone()).or_insert(0);
        if *used >= cap {
            return None;
        }
        *used += 1;
        Some(ConnSlot {
            endpoint: self.clone(),
            key,
        })
    }
}

/// 一个连接名额。
pub(crate) struct ConnSlot {
    endpoint: Arc<CollabEndpoint>,
    key: String,
}

impl Drop for ConnSlot {
    fn drop(&mut self) {
        if let Ok(mut limits) = self.endpoint.limits.lock()
            && let Some(used) = limits.get_mut(&self.key)
        {
            *used = used.saturating_sub(1);
            if *used == 0 {
                limits.remove(&self.key);
            }
        }
    }
}

/// 查询参数。
#[derive(Debug, Deserialize)]
pub struct CollabQuery {
    /// 文档的资源键(规范字符串)。
    pub doc: String,
}

/// 资源键 → 协作文档。只有笔记和文件能协作:笔记和 Markdown 文件是所见即所得结构,其它文件是纯文本结构。
pub fn parse_doc(key: &str) -> Result<(ResourceKey, DocRef)> {
    let resource = ResourceKey::parse(key)?;
    let kind = match &resource {
        ResourceKey::Doc {
            doc: ShareDoc::Insight(_),
            ..
        } => DocKind::Rich,
        ResourceKey::Doc {
            doc: ShareDoc::File(path),
            ..
        } => DocKind::for_file(path),
        _ => {
            return Err(KbError::InvalidInput(
                "只有笔记和文本文件可以多人在线编辑".to_owned(),
            ));
        }
    };
    // 键用规范写法(ResourceKey 的 Display),房间和落地都按它索引
    let doc = DocRef {
        key: resource.to_string(),
        kind,
    };
    Ok((resource, doc))
}

/// 链接凭据的指纹:令牌尾号(重置令牌会变)加访问密码哈希(设置 / 修改密码会变)的 sha256 前 16 位。
/// 连接建立时记进上下文,之后每次复核权限都和链接现在的指纹比,对不上就断开。
pub fn link_epoch(record: &kb_core::model::identity::LinkRecord) -> String {
    let material = format!(
        "{}|{}",
        record.link.token_hint,
        record.password_hash.as_deref().unwrap_or("")
    );
    kb_core::token::sha256_hex(&material)[..16].to_owned()
}

/// 浏览器握手的来源检查:跨站页面发起的 WebSocket 会带上它自己的 Origin。
/// 没有 Origin(命令行工具、同源的老式请求)放行,身份仍然靠 cookie / 令牌。
pub fn origin_ok(headers: &HeaderMap, public_url: &str) -> bool {
    let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let strip = |url: &str| -> String {
        url.trim_end_matches('/')
            .split_once("://")
            .map_or(url.to_owned(), |(_, rest)| rest.to_owned())
            .to_ascii_lowercase()
    };
    let origin_host = strip(origin);
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(str::to_ascii_lowercase);
    if host.as_deref() == Some(origin_host.as_str()) {
        return true;
    }
    !public_url.is_empty() && strip(public_url) == origin_host
}

/// 一个人的显示名。
fn display_name(user: &User) -> String {
    if user.display_name.trim().is_empty() {
        user.username.clone()
    } else {
        user.display_name.clone()
    }
}

/// 房间用的权限核对:连接建立时和之后定期调用。
pub struct WebCollabAuth {
    system: Arc<dyn IdentityStore>,
    config: Arc<ConfigStore>,
    ai: AiSwitch,
}

impl WebCollabAuth {
    /// 构造。
    pub fn new(
        system: Arc<dyn IdentityStore>,
        config: Arc<ConfigStore>,
        ai: AiSwitch,
    ) -> Arc<Self> {
        Arc::new(Self { system, config, ai })
    }

    /// 登录用户直接打开一篇文档(没有链接)。
    pub async fn user_access(&self, user: &User, key: &ResourceKey, now: i64) -> Access {
        if !user.status.can_sign_in() {
            return Access::Denied;
        }
        let Ok(features) = self.system.effective_features(&user.id, (self.ai)()).await else {
            return Access::Denied;
        };
        if !features.allows("collab.edit") {
            return Access::Denied;
        }
        let Ok(Some(role)) = self.system.role_of(&user.id, key, now).await else {
            return Access::Denied;
        };
        let editing_feature = match key {
            ResourceKey::Doc {
                doc: ShareDoc::File(_),
                ..
            } => "docs.edit_text",
            _ => "docs.notes",
        };
        if role.allows(Action::Edit) && features.allows(editing_feature) {
            Access::Write
        } else if role.allows(Action::View) {
            Access::Read
        } else {
            Access::Denied
        }
    }

    /// 经分享链接打开。游客只拿链接按系统参数降级后的角色;登录用户拿自己的授权和链接角色中较高的。
    ///
    /// `epoch` 是连接建立时链接凭据的指纹(见 [`link_epoch`])。链接重置过令牌、或者改过密码之后指纹就变了,
    /// 这时链接本身仍然「有效」,但拿着旧凭据连进来的人必须被请出去。
    pub async fn link_access(
        &self,
        link_id: &str,
        epoch: Option<&str>,
        who: &Participant,
        key: &ResourceKey,
        now: i64,
    ) -> Access {
        let Ok(Some(record)) = self.system.get_link(link_id).await else {
            return Access::Denied;
        };
        if record.link.state(now) != kb_core::share::link::LinkState::Active {
            return Access::Denied;
        }
        if epoch.is_some_and(|epoch| epoch != link_epoch(&record)) {
            return Access::Denied;
        }
        // 所有者账号不可用,链接一起失效
        let owner_ok = match self.system.space_owner(&record.link.space_id).await {
            Ok(Some(owner)) => matches!(
                self.system.get_user(&owner).await,
                Ok(Some(user)) if user.status == kb_core::account::UserStatus::Active
            ),
            _ => false,
        };
        if !owner_ok || !record.roots().iter().any(|root| key.is_within(root)) {
            return Access::Denied;
        }
        let share = self.config.get().share.clone();
        let role = if who.id.starts_with("guest:") {
            kb_core::share::link::link_role(&record.link, false, &share, now)
        } else {
            let Ok(Some(user)) = self.system.get_user(&who.id).await else {
                return Access::Denied;
            };
            if !user.status.can_sign_in() {
                return Access::Denied;
            }
            let own = self.system.role_of(&user.id, key, now).await.ok().flatten();
            own.max(kb_core::share::link::link_role(
                &record.link,
                true,
                &share,
                now,
            ))
        };
        match role {
            Some(role) if role.allows(Action::Edit) => Access::Write,
            Some(role) if role >= Role::Viewer => Access::Read,
            _ => Access::Denied,
        }
    }
}

#[async_trait]
impl CollabAuth for WebCollabAuth {
    async fn access(&self, doc: &DocRef, who: &Participant, ctx: &str) -> Access {
        let Ok(key) = ResourceKey::parse(&doc.key) else {
            return Access::Denied;
        };
        let now = session::now_millis();
        if let Some(rest) = ctx.strip_prefix("link:") {
            // `link:<链接 id>:<凭据指纹>`;没有指纹的旧写法也认(按不核对指纹处理)
            let (link_id, epoch) = match rest.split_once(':') {
                Some((id, epoch)) => (id, Some(epoch)),
                None => (rest, None),
            };
            return self.link_access(link_id, epoch, who, &key, now).await;
        }
        match self.system.get_user(&who.id).await {
            Ok(Some(user)) => self.user_access(&user, &key, now).await,
            _ => Access::Denied,
        }
    }
}

/// `GET /api/v1/collab/ws`:登录用户的协作连接。
pub async fn user_handler(
    State(state): State<Arc<AppState>>,
    Extension(identity): Extension<Identity>,
    Query(query): Query<CollabQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(endpoint) = state.collab.clone() else {
        return error(StatusCode::NOT_FOUND, "collab_disabled", "在线协作没有启用");
    };
    let config = state.account.config.get();
    if !origin_ok(&headers, &config.site.public_url) {
        return error(StatusCode::FORBIDDEN, "bad_origin", "不允许的来源");
    }
    let Some(user) = identity.user.clone() else {
        return error(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录");
    };
    let (key, doc) = match parse_doc(&query.doc) {
        Ok(parsed) => parsed,
        Err(err) => return api::error_response(err),
    };
    let auth = WebCollabAuth::new(
        state.system.clone(),
        state.account.config.clone(),
        state.ai_enabled.clone(),
    );
    let access = auth.user_access(&user, &key, session::now_millis()).await;
    if access == Access::Denied {
        // 和「内容不存在」同一个回答:不暴露别人的文档存不存在
        return error(StatusCode::NOT_FOUND, "not_found", "没有找到这个内容");
    }
    if !endpoint.hub.doc_exists(&doc).await {
        return error(StatusCode::NOT_FOUND, "not_found", "没有找到这个内容");
    }
    let Some(slot) = endpoint.reserve(format!("user:{}", user.id), MAX_CONNS_PER_USER) else {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_connections",
            "打开的协作窗口太多,请关掉一些再试",
        );
    };
    let join = JoinRequest {
        doc,
        who: Participant {
            id: user.id.clone(),
            name: display_name(&user),
        },
        ctx: String::new(),
        writable: access == Access::Write,
    };
    serve(upgrade, endpoint, join, slot)
}

/// 升级并跑连接循环。
pub(crate) fn serve(
    upgrade: WebSocketUpgrade,
    endpoint: Arc<CollabEndpoint>,
    join: JoinRequest,
    slot: ConnSlot,
) -> Response {
    upgrade
        .max_message_size(8 * 1024 * 1024)
        .on_upgrade(move |socket| run(socket, endpoint, join, slot))
}

async fn close_with(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_owned().into(),
        })))
        .await;
}

async fn run(
    mut socket: WebSocket,
    endpoint: Arc<CollabEndpoint>,
    join: JoinRequest,
    slot: ConnSlot,
) {
    // 名额随这个函数结束释放
    let _slot = slot;
    let mut session = match endpoint.hub.join(join).await {
        Ok(session) => session,
        Err(err) => {
            tracing::debug!(error = %err, "协作连接加入房间失败");
            close_with(&mut socket, 1013, &err.to_string()).await;
            return;
        }
    };
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let mut last_seen = tokio::time::Instant::now();
    loop {
        tokio::select! {
            frame = session.recv() => match frame {
                Some(Frame::Binary(bytes)) => {
                    if socket.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                Some(Frame::Close { code, reason }) => {
                    close_with(&mut socket, code, &reason).await;
                    break;
                }
                // 房间那边把这条连接摘掉了(被踢,队列满时关闭帧塞不进去):关掉让客户端重连补齐
                None => {
                    close_with(&mut socket, 1013, "连接已被服务端关闭,请重连").await;
                    break;
                }
            },
            message = socket.recv() => match message {
                Some(Ok(Message::Binary(bytes))) => {
                    last_seen = tokio::time::Instant::now();
                    session.send(&bytes).await;
                }
                Some(Ok(Message::Ping(_) | Message::Pong(_) | Message::Text(_))) => {
                    last_seen = tokio::time::Instant::now();
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
            },
            _ = ping.tick() => {
                if last_seen.elapsed() > DEAD_AFTER {
                    break;
                }
                if socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    break;
                }
            }
        }
    }
    session.leave().await;
}
