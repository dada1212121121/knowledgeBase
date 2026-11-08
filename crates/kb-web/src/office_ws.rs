//! 办公文档(Word / Excel / PowerPoint)多人实时协同的接口。
//!
//! - `POST /api/v1/office/session`:打开前的准备(能不能协同、格式、房间底稿的哈希、无损检查的结论);
//! - `GET  /api/v1/office/base?doc=…&sha=…`:房间底稿的原字节(按内容寻址,可以永久缓存);
//! - `GET  /api/v1/office/seed?doc=…`:docx 的初始状态(xlsx / pptx 不需要:同一份字节打开状态天然相同);
//! - `GET  /api/v1/office/collab?doc=…`:WebSocket,y-sync 帧原样进出。
//!
//! 守护进程这一侧只做鉴权、限额和转发,不解 CRDT;房间和副本在 office-worker 里(见 `kb-cli/src/office_collab.rs`)。
//! 权限和笔记的多人编辑同一套:登录用户按自己的授权(可写 = 能编辑文件,只读 = 能查看),握手时检查 `Origin`。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::Json;
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use kb_collab::Access;
use kb_core::Result;
use kb_core::account::User;
use kb_core::share::{DocRef as ShareDoc, ResourceKey};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::api::{self, AppState, error};
use crate::auth::Identity;
use crate::auth::session;
use crate::collab_ws::{WebCollabAuth, origin_ok};

/// 心跳间隔(和笔记的协作连接一样:Cloudflare 对闲置 WebSocket 约 100 秒断开)。
const PING_EVERY: Duration = Duration::from_secs(25);
/// 超过这么久没收到客户端的任何帧就当它死了。
const DEAD_AFTER: Duration = Duration::from_secs(80);
/// 单帧上限:引擎自己的协同帧上限是 16 MiB。
const MAX_FRAME: usize = 16 * 1024 * 1024;

/// 一条连接上的人(光标旁显示的名字由服务端决定,不信客户端自己报的)。
#[derive(Clone, Debug)]
pub struct OfficeUser {
    /// 用户 id。
    pub id: String,
    /// 显示名。
    pub name: String,
}

/// 发给浏览器的东西。
#[derive(Debug)]
pub enum OfficeOut {
    /// 一帧 y-sync 数据。
    Frame(Vec<u8>),
    /// 关闭连接(码、原因)。
    Close(u16, String),
}

/// 一条连接在房间里的句柄:收到的帧交给它;丢掉(连接断开)时离开房间。
pub trait OfficeConnHandle: Send + Sync {
    /// 浏览器发来的一帧。
    fn frame(&self, bytes: Vec<u8>);
}

/// 加入房间的结果。
pub struct OfficeConn {
    /// 发给浏览器的东西。
    pub rx: mpsc::Receiver<OfficeOut>,
    /// 往房间送帧;丢掉即离开。
    pub handle: Box<dyn OfficeConnHandle>,
}

/// 守护进程实现的协同后端。
#[async_trait]
pub trait OfficeCollabApi: Send + Sync {
    /// 打开前的准备:返回 `{ mode: "collab" | "single", format, base_sha, size, writable, reason?, report? }`。
    /// `force`:无损检查没过、但文字不变时,用户确认要继续编辑。
    async fn prepare(
        &self,
        key: &ResourceKey,
        user: &OfficeUser,
        access: Access,
        force: bool,
    ) -> Result<Value>;
    /// 房间底稿的原字节。`sha` 必须是这个文档当前房间的底稿(或它曾经的底稿)。
    async fn base(&self, key: &ResourceKey, sha: &str) -> Result<Vec<u8>>;
    /// docx 的初始状态。
    async fn seed(&self, key: &ResourceKey) -> Result<Vec<u8>>;
    /// 加入房间。
    async fn join(
        &self,
        key: &ResourceKey,
        user: &OfficeUser,
        access: Access,
    ) -> Result<OfficeConn>;
}

/// 查询参数 / 请求体里的文档键。
#[derive(Debug, Deserialize)]
pub struct OfficeDocQuery {
    /// 资源键(规范字符串,和笔记协作的 `doc` 一样)。
    pub doc: String,
    /// 底稿哈希(只有 `base` 用)。
    #[serde(default)]
    pub sha: Option<String>,
}

/// `POST /api/v1/office/session` 的请求体。
#[derive(Debug, Deserialize)]
pub struct OfficeSessionRequest {
    /// 资源键。
    pub doc: String,
    /// 无损检查没过时用户确认要继续编辑。
    #[serde(default)]
    pub force: bool,
}

fn display_name(user: &User) -> String {
    if user.display_name.trim().is_empty() {
        user.username.clone()
    } else {
        user.display_name.clone()
    }
}

/// 只认文件;Office 格式由后端再判断一次。
fn parse_file_key(doc: &str) -> std::result::Result<ResourceKey, Box<Response>> {
    let key = ResourceKey::parse(doc).map_err(|err| Box::new(api::error_response(err)))?;
    match &key {
        ResourceKey::Doc {
            doc: ShareDoc::File(_),
            ..
        } => Ok(key),
        _ => Err(Box::new(error(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "只有 Word / Excel / PowerPoint 文件能在这里协同编辑",
        ))),
    }
}

/// 鉴权:登录用户、按授权算出读写。看不到的文档和不存在的一样回 404。
async fn authorize(
    state: &AppState,
    identity: &Identity,
    doc: &str,
) -> std::result::Result<(Arc<dyn OfficeCollabApi>, ResourceKey, OfficeUser, Access), Box<Response>>
{
    let Some(api) = state.office.clone() else {
        return Err(Box::new(error(
            StatusCode::NOT_FOUND,
            "office_collab_disabled",
            "办公文档协同没有启用",
        )));
    };
    let Some(user) = identity.user.clone() else {
        return Err(Box::new(error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "请先登录",
        )));
    };
    let key = parse_file_key(doc)?;
    let auth = WebCollabAuth::new(
        state.system.clone(),
        state.account.config.clone(),
        state.ai_enabled.clone(),
    );
    let access = auth.user_access(&user, &key, session::now_millis()).await;
    if access == Access::Denied {
        return Err(Box::new(error(
            StatusCode::NOT_FOUND,
            "not_found",
            "没有找到这个内容",
        )));
    }
    let who = OfficeUser {
        id: user.id.clone(),
        name: display_name(&user),
    };
    Ok((api, key, who, access))
}

/// `POST /api/v1/office/session`。
pub async fn session_handler(
    State(state): State<Arc<AppState>>,
    Extension(identity): Extension<Identity>,
    Json(request): Json<OfficeSessionRequest>,
) -> Response {
    let (api, key, who, access) = match authorize(&state, &identity, &request.doc).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    match api.prepare(&key, &who, access, request.force).await {
        Ok(data) => Json(serde_json::json!({ "ok": true, "data": data })).into_response(),
        Err(err) => api::error_response(err),
    }
}

/// `GET /api/v1/office/base`。内容按哈希寻址,同一个哈希永远是同一份字节:可以永久缓存,第二次打开不用再下载。
pub async fn base_handler(
    State(state): State<Arc<AppState>>,
    Extension(identity): Extension<Identity>,
    Query(query): Query<OfficeDocQuery>,
) -> Response {
    let (api, key, _, _) = match authorize(&state, &identity, &query.doc).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let Some(sha) = query.sha.as_deref() else {
        return error(StatusCode::BAD_REQUEST, "invalid_input", "缺少 sha");
    };
    match api.base(&key, sha).await {
        Ok(bytes) => {
            let mut response = bytes.into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            );
            // 私有缓存:内容和权限有关,不能让共享缓存存下来给别人
            headers.insert(
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, max-age=31536000, immutable"),
            );
            response
        }
        Err(err) => api::error_response(err),
    }
}

/// `GET /api/v1/office/seed`。
pub async fn seed_handler(
    State(state): State<Arc<AppState>>,
    Extension(identity): Extension<Identity>,
    Query(query): Query<OfficeDocQuery>,
) -> Response {
    let (api, key, _, _) = match authorize(&state, &identity, &query.doc).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    match api.seed(&key).await {
        Ok(bytes) => {
            let mut response = bytes.into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            );
            headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            response
        }
        Err(err) => api::error_response(err),
    }
}

/// `GET /api/v1/office/collab`:WebSocket。
pub async fn collab_handler(
    State(state): State<Arc<AppState>>,
    Extension(identity): Extension<Identity>,
    Query(query): Query<OfficeDocQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let config = state.account.config.get();
    if !origin_ok(&headers, &config.site.public_url) {
        return error(StatusCode::FORBIDDEN, "bad_origin", "不允许的来源");
    }
    let (api, key, who, access) = match authorize(&state, &identity, &query.doc).await {
        Ok(found) => found,
        Err(response) => return *response,
    };
    let conn = match api.join(&key, &who, access).await {
        Ok(conn) => conn,
        Err(err) => return api::error_response(err),
    };
    upgrade
        .max_message_size(MAX_FRAME)
        .on_upgrade(move |socket| run(socket, conn))
}

async fn close_with(socket: &mut WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.to_owned().into(),
        })))
        .await;
}

async fn run(mut socket: WebSocket, conn: OfficeConn) {
    let OfficeConn { mut rx, handle } = conn;
    let mut ping = tokio::time::interval(PING_EVERY);
    ping.tick().await;
    let mut last_seen = tokio::time::Instant::now();
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(OfficeOut::Frame(bytes)) => {
                    if socket.send(Message::Binary(bytes.into())).await.is_err() {
                        break;
                    }
                }
                Some(OfficeOut::Close(code, reason)) => {
                    close_with(&mut socket, code, &reason).await;
                    break;
                }
                None => {
                    close_with(&mut socket, 1013, "协同服务把连接关了,请重连").await;
                    break;
                }
            },
            message = socket.recv() => match message {
                Some(Ok(Message::Binary(bytes))) => {
                    last_seen = tokio::time::Instant::now();
                    handle.frame(bytes.to_vec());
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
    // handle 在这里被丢掉:离开房间
    drop(handle);
}
