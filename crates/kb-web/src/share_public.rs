//! 公开的分享链接接口(多用户设计说明):`/api/v1/share/{token}/…`。
//!
//! 这些路径**不要求登录**(游客也能用),所以每一步都自己把关:
//! 1. 令牌格式 → 链接是否存在 / 开着 / 没过期 / 没撤销 → 所有者账号是否可用;
//! 2. 访问者是谁:有会话 cookie 的登录用户,否则是游客(`kb_guest` cookie,库里只存哈希);
//! 3. 他通过这个链接能拿到什么角色(访问范围、系统参数对游客的降级、他自己的授权取高者);
//! 4. 密码:对输错的 IP 5 次锁 10 分钟;输对后发一个只对这个链接有效、24 小时的签名 cookie;
//! 5. 真正读写内容走 `Invoker`,带上 [`LinkGrant`]:分享闸门只放行白名单里的能力,
//!    并且只在链接指向的资源范围内。游客得不到任何其它 API。
//!
//! 响应头:`X-Robots-Tag: noindex`、`Referrer-Policy: no-referrer`(令牌别经 Referer 泄露到外链)。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use kb_capability::invoke::LinkGrant;
use kb_capability::{CallCtx, Principal, Surface};

use kb_core::account::User;
use kb_core::model::Millis;
use kb_core::model::identity::{Guest, LinkRecord};
use kb_core::share::link::{
    LOCKOUT_MS, LinkState, MAX_PASSWORD_FAILURES, guest_ceiling, link_role,
};
use kb_core::share::{Action, ResourceKey, Role};
use kb_core::token::{random_secret, sha256_hex};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{self, AppState};
use crate::auth::{ClientIp, session};

/// 游客 cookie 名。
pub const GUEST_COOKIE: &str = "kb_guest";
const GUEST_TTL_SECS: i64 = 30 * 86_400;
const UNLOCK_TTL_MS: i64 = 24 * 3_600_000;
/// 每个 IP 每分钟最多多少次公开分享请求。
pub const REQUESTS_PER_MINUTE: usize = 120;
/// 游客每分钟最多多少次写操作(评论 / 编辑),按访客 + IP。
pub const GUEST_WRITES_PER_MINUTE: usize = 30;

/// 通过链接可以调用的能力(与分享闸门的白名单一致;这里先挡一道,闸门还会再判断)。
const LINK_CAPABILITIES: &[&str] = &[
    "get_item",
    "list_items",
    "file_preview",
    "file_raw",
    "check_links",
    "list_annotations",
    "add_annotation",
    "edit_item",
    "save_file",
];
/// 其中会改动内容的。
const WRITES: &[&str] = &["add_annotation", "edit_item", "save_file"];

fn fail(status: StatusCode, code: &str, message: &str) -> Response {
    private(
        (
            status,
            Json(json!({ "ok": false, "error": { "code": code, "message": message } })),
        )
            .into_response(),
    )
}

/// 公开分享响应的统一头:不让搜索引擎收录,不让令牌经 Referer 外泄。
fn private(mut response: Response) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        "x-robots-tag",
        HeaderValue::from_static("noindex, nofollow"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}

// ---------------------------------------------------------------- 限速

fn windows() -> &'static Mutex<HashMap<String, VecDeque<i64>>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, VecDeque<i64>>>> = OnceLock::new();
    WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 滑动窗口计数:`key` 在 `window_ms` 内已有 `limit` 次就返回 `false`,否则记一次返回 `true`。
fn allow(key: &str, limit: usize, window_ms: i64, now: Millis) -> bool {
    let mut map = windows()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    // 顺手清掉过期的键,表不会随访客数无限增长
    if map.len() > 10_000 {
        map.retain(|_, queue| queue.back().is_some_and(|at| now - at < 600_000));
    }
    let queue = map.entry(key.to_owned()).or_default();
    while queue.front().is_some_and(|at| now - at >= window_ms) {
        queue.pop_front();
    }
    if queue.len() >= limit {
        return false;
    }
    queue.push_back(now);
    true
}

fn failures() -> &'static Mutex<HashMap<String, VecDeque<i64>>> {
    static FAILURES: OnceLock<Mutex<HashMap<String, VecDeque<i64>>>> = OnceLock::new();
    FAILURES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 一个链接一天最多登记多少个新游客(超出的照常能看,只是不再写进游客表)。
const MAX_NEW_GUESTS_PER_LINK_PER_DAY: usize = 2000;

/// 一个链接上所有来源加起来,10 分钟内最多允许多少次输错密码。
///
/// 只按(链接, IP)限速的话,攻击者轮换 IP(代理池)就能对 4 位密码做在线暴力破解;
/// 这是不分来源的总上限。
const LINK_MAX_PASSWORD_FAILURES: usize = 20;

/// 为什么被挡:是这个来源自己输错太多,还是整个链接被总锁了。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PasswordLock {
    /// 这个 IP 对这个链接输错太多次。
    Address,
    /// 这个链接上所有来源加起来输错太多次。
    Link,
}

/// 先占名额再验证:检查「(链接, IP) 有没有到上限」「整个链接有没有到上限」和「记一次尝试」
/// 在同一把锁里完成。分开做的话(先查、验证失败后再记),并发的请求会一起通过检查。
/// 返回 `Some(原因)` 表示被挡住,没有占名额;`None` 表示占到了名额——
/// 验证失败就让它留着(占用本身就是这次失败的记录),验证通过调用 [`release_password_attempt`]。
fn reserve_password_attempt(link_id: &str, ip: &str, now: Millis) -> Option<PasswordLock> {
    let mut map = failures()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    // 键里有攻击者能随便造的 IP:表太大时顺手清掉过期的
    if map.len() > 10_000 {
        map.retain(|_, queue| queue.back().is_some_and(|at| now - at < LOCKOUT_MS));
    }
    let per_ip_key = format!("{link_id}|{ip}");
    let per_link_key = format!("{link_id}|*");
    for key in [&per_ip_key, &per_link_key] {
        let queue = map.entry(key.clone()).or_default();
        while queue.front().is_some_and(|at| now - at >= LOCKOUT_MS) {
            queue.pop_front();
        }
    }
    if map[&per_ip_key].len() >= MAX_PASSWORD_FAILURES as usize {
        return Some(PasswordLock::Address);
    }
    if map[&per_link_key].len() >= LINK_MAX_PASSWORD_FAILURES {
        return Some(PasswordLock::Link);
    }
    for key in [per_ip_key, per_link_key] {
        map.entry(key).or_default().push_back(now);
    }
    None
}

/// 密码输对了:这个来源的失败记录清掉(他证明了自己知道密码);链接总数里只退回刚才占的那一个,
/// 不抹掉别人(攻击者)留下的失败记录。
fn release_password_attempt(link_id: &str, ip: &str, now: Millis) {
    let mut map = failures()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    map.remove(&format!("{link_id}|{ip}"));
    if let Some(queue) = map.get_mut(&format!("{link_id}|*"))
        && let Some(at) = queue.iter().rposition(|at| *at == now)
    {
        queue.remove(at);
    }
}

// ---------------------------------------------------------------- cookie

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';').find_map(|part| {
        let (key, value) = part.trim().split_once('=')?;
        (key == name && !value.is_empty()).then(|| value.to_owned())
    })
}

fn unlock_cookie_name(link_id: &str) -> String {
    format!("kb_share_{link_id}")
}

/// 解锁 cookie 的签名:密码一改(哈希变了)旧 cookie 全部失效;链接 id 进签名,换个链接用不了。
fn unlock_signature(pepper: &str, record: &LinkRecord, expires_at: Millis) -> String {
    sha256_hex(&format!(
        "{pepper}|unlock|{}|{}|{expires_at}",
        record.link.id,
        record.password_hash.as_deref().unwrap_or("")
    ))
}

fn is_secure(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("https"))
}

fn set_cookie(response: &mut Response, cookie: String) {
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
}

// ---------------------------------------------------------------- 访问判定

enum Visitor {
    User(Arc<User>, Principal),
    Guest {
        secret_hash: String,
        new_secret: Option<String>,
    },
}

struct Access {
    record: LinkRecord,
    visitor: Visitor,
    /// 通过这个链接(含自己的授权取高者)拿到的角色。
    role: Role,
    /// 还需要输密码。
    locked: bool,
    /// 访问者是游客时,他的记录(已登记)。
    guest: Option<Guest>,
    ip: String,
}

async fn pepper(state: &AppState) -> String {
    state
        .system
        .get_or_create_secret("pepper", Box::new(random_secret))
        .await
        .unwrap_or_default()
}

fn client_ip(request_ip: Option<&ClientIp>) -> String {
    request_ip.map_or_else(|| "unknown".to_owned(), |ip| ip.0.clone())
}

/// 校验链接并判定访问者能得到什么。出错直接是现成的响应。
#[allow(clippy::result_large_err)]
async fn load(
    state: &AppState,
    token: &str,
    headers: &HeaderMap,
    ip: &str,
    now: Millis,
) -> Result<Access, Response> {
    if !allow(&format!("req|{ip}"), REQUESTS_PER_MINUTE, 60_000, now) {
        return Err(fail(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "请求太频繁,请稍后再试",
        ));
    }
    let record = match state.system.find_link_by_token(token).await {
        Ok(Some(record)) => record,
        Ok(None) => {
            return Err(fail(
                StatusCode::NOT_FOUND,
                "link_not_found",
                "链接不存在或已失效",
            ));
        }
        Err(err) => return Err(api::error_response(err)),
    };
    match record.link.state(now) {
        LinkState::Active => {}
        LinkState::Closed => {
            return Err(fail(
                StatusCode::GONE,
                "link_closed",
                "所有者关闭了这个链接",
            ));
        }
        LinkState::Expired => return Err(fail(StatusCode::GONE, "link_expired", "这个链接已过期")),
        LinkState::Revoked => {
            return Err(fail(StatusCode::GONE, "link_revoked", "这个链接已被撤销"));
        }
    }
    // 所有者账号不可用(停用 / 注销中 / 已删除):链接一起失效
    let owner_ok = match state.system.space_owner(&record.link.space_id).await {
        Ok(Some(owner)) => matches!(
            state.system.get_user(&owner).await,
            Ok(Some(user)) if user.status == kb_core::account::UserStatus::Active
        ),
        _ => false,
    };
    if !owner_ok {
        return Err(fail(
            StatusCode::GONE,
            "link_unavailable",
            "这个链接暂时不可用",
        ));
    }

    // 访问者:会话 cookie 对应的登录用户,否则游客
    let user = match session::cookie_token(headers) {
        Some(raw) => session::authenticate(state.system.as_ref(), &raw, now)
            .await
            .ok()
            .flatten()
            .map(|(_, user)| user),
        None => None,
    };
    let share = state.account.config.get().share.clone();
    let visitor_role;
    let visitor = match user {
        Some(user) => {
            let ai = (state.ai_enabled)();
            let principal = state
                .principals
                .principal_for(state.system.as_ref(), &user, &ai)
                .await
                .map_err(api::error_response)?;
            // 他自己在这些资源上的最高授权角色(所有者在自己的知识库里是 owner)
            let mut own = None;
            for root in record.roots() {
                if let Ok(Some(role)) = state.system.role_of(&user.id, &root, now).await {
                    own = own.max(Some(role));
                }
            }
            let from_link = link_role(&record.link, true, &share, now);
            visitor_role = own.max(from_link);
            Visitor::User(Arc::new(user), principal)
        }
        None => {
            visitor_role = link_role(&record.link, false, &share, now);
            let existing = cookie_value(headers, GUEST_COOKIE);
            let (secret, fresh) = match existing {
                Some(secret) if secret.len() >= 20 => (secret, None),
                _ => {
                    let secret = random_secret();
                    (secret.clone(), Some(secret))
                }
            };
            Visitor::Guest {
                secret_hash: sha256_hex(&secret),
                new_secret: fresh,
            }
        }
    };
    let Some(role) = visitor_role else {
        return Err(match &visitor {
            Visitor::Guest { .. }
                if record.link.audience == kb_core::share::link::Audience::LoggedIn =>
            {
                fail(
                    StatusCode::UNAUTHORIZED,
                    "login_required",
                    "这个链接需要登录后访问",
                )
            }
            Visitor::Guest { .. } if guest_ceiling(&share).is_none() => fail(
                StatusCode::FORBIDDEN,
                "guests_disabled",
                "管理员暂时关闭了游客访问",
            ),
            Visitor::Guest { .. } => fail(
                StatusCode::UNAUTHORIZED,
                "login_required",
                "这个链接需要登录后访问",
            ),
            Visitor::User(..) => fail(
                StatusCode::FORBIDDEN,
                "no_access",
                "你没有权限访问这个内容,可以向所有者申请",
            ),
        });
    };

    // 密码:只有「权限是靠链接拿到的」才需要;已经是协作者的人不用输
    let has_own_access = match &visitor {
        Visitor::User(user, _) => {
            let mut any = false;
            for root in record.roots() {
                if state
                    .system
                    .role_of(&user.id, &root, now)
                    .await
                    .ok()
                    .flatten()
                    .is_some()
                {
                    any = true;
                }
            }
            any
        }
        Visitor::Guest { .. } => false,
    };
    let mut locked = false;
    if record.link.has_password && !has_own_access {
        let pepper = pepper(state).await;
        let unlocked = cookie_value(headers, &unlock_cookie_name(&record.link.id))
            .and_then(|value| {
                let (expiry, signature) = value.split_once('.')?;
                let expiry: Millis = expiry.parse().ok()?;
                (expiry > now && signature == unlock_signature(&pepper, &record, expiry))
                    .then_some(())
            })
            .is_some();
        locked = !unlocked;
    }

    // 游客第一次通过校验才登记(被拒的请求不往库里写东西)。
    // 不带 cookie 的每次访问都是一个新游客身份,所以新游客要限量:一个链接一天最多登记这么多个,
    // 超出的照常能看(身份靠 cookie 里的随机串保持稳定),只是不再往库里写——否则有人反复清 cookie 访问,
    // 就能把游客表灌满(单个来源每分钟 120 次的限速拦不住很多来源)。
    let guest = match (&visitor, locked) {
        (
            Visitor::Guest {
                secret_hash,
                new_secret,
            },
            false,
        ) => {
            let may_register = new_secret.is_none()
                || allow(
                    &format!("newguest|{}", record.link.id),
                    MAX_NEW_GUESTS_PER_LINK_PER_DAY,
                    86_400_000,
                    now,
                );
            if may_register {
                state
                    .system
                    .touch_guest(secret_hash, &record.link.id, Some(ip), now)
                    .await
                    .ok()
            } else {
                None
            }
        }
        _ => None,
    };
    Ok(Access {
        record,
        visitor,
        role,
        locked,
        guest,
        ip: ip.to_owned(),
    })
}

impl Access {
    /// 游客的 cookie(只有新游客需要下发)。
    fn attach_cookie(&self, response: &mut Response, headers: &HeaderMap) {
        if let Visitor::Guest {
            new_secret: Some(secret),
            ..
        } = &self.visitor
        {
            let mut cookie = format!(
                "{GUEST_COOKIE}={secret}; HttpOnly; SameSite=Lax; Path=/; Max-Age={GUEST_TTL_SECS}"
            );
            if is_secure(headers) {
                cookie.push_str("; Secure");
            }
            set_cookie(response, cookie);
        }
    }

    fn is_guest(&self) -> bool {
        matches!(self.visitor, Visitor::Guest { .. })
    }

    /// 给 `Invoker` 用的身份:登录用户用自己的;游客是一个没有知识库、功能点按角色给的临时身份。
    fn principal(&self) -> Principal {
        match &self.visitor {
            Visitor::User(_, principal) => principal.clone(),
            Visitor::Guest { secret_hash, .. } => {
                // 游客能用的功能点只够做链接允许的事:评论要「批注」,编辑要「笔记」和「在线编辑文本」
                let mut features = Vec::new();
                if self.role >= Role::Commenter {
                    features.push("docs.annotate".to_owned());
                }
                if self.role >= Role::Editor {
                    features.push("docs.notes".to_owned());
                    features.push("docs.edit_text".to_owned());
                }
                // 昵称写进身份:审计里看到的是「guest:小王#3fa9c1」,而不是一串哈希
                let nickname = self
                    .guest
                    .as_ref()
                    .map_or("访客", |guest| guest.nickname.as_str());
                Principal {
                    user_id: format!("guest:{nickname}#{}", &secret_hash[..6]),
                    space_id: None,
                    features: Arc::new(kb_core::features::FeatureSet::resolve(
                        features,
                        Vec::new(),
                        Vec::new(),
                        kb_core::features::AiState {
                            master: false,
                            off: Default::default(),
                        },
                    )),
                    local: false,
                }
            }
        }
    }

    /// 审计里的操作者:游客写成「访客 昵称(经链接 …)」,方便所有者在历史里认出来、回退。
    fn actor(&self) -> String {
        match (&self.visitor, &self.guest) {
            (Visitor::User(user, _), _) => user.id.clone(),
            (Visitor::Guest { .. }, Some(guest)) => {
                format!(
                    "guest:{}(经链接 {})",
                    guest.nickname, self.record.link.token_hint
                )
            }
            _ => "guest".to_owned(),
        }
    }

    fn grant(&self) -> LinkGrant {
        LinkGrant {
            link_id: self.record.link.id.clone(),
            space_id: self.record.link.space_id.clone(),
            role: self.role,
            roots: self.record.roots(),
            guest: self.is_guest(),
        }
    }
}

// ---------------------------------------------------------------- 接口

#[allow(clippy::result_large_err)]
fn token_ok(token: &str) -> Result<(), Response> {
    if kb_core::share::link::looks_like_token(token) {
        Ok(())
    } else {
        Err(fail(
            StatusCode::NOT_FOUND,
            "link_not_found",
            "链接不存在或已失效",
        ))
    }
}

/// `GET /api/v1/share/{token}`:链接信息。每调用一次算一次打开。
pub async fn info(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
) -> Response {
    if let Err(response) = token_ok(&token) {
        return response;
    }
    let now = session::now_millis();
    let ip = client_ip(extensions.get::<ClientIp>());
    let access = match load(&state, &token, &headers, &ip, now).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    let config = state.account.config.get();
    let mut response = if access.locked {
        // 还没输对密码:只透露「需要密码」和站点名,不透露标题、内容、类型
        api::ok(
            json!({ "state": "locked", "requires_password": true, "site": { "name": config.site.name, "timezone": config.site.timezone } }),
        )
    } else {
        let user_id = match &access.visitor {
            Visitor::User(user, _) => Some(user.id.as_str()),
            Visitor::Guest { .. } => None,
        };
        let _ = state
            .system
            .record_link_view(&access.record.link.id, user_id, now)
            .await;
        let link = &access.record.link;
        let visitor = match (&access.visitor, &access.guest) {
            (Visitor::User(user, _), _) => {
                json!({ "kind": "user", "id": user.id, "username": user.username, "display_name": user.display_name, "avatar": user.avatar })
            }
            (Visitor::Guest { .. }, Some(guest)) => {
                json!({ "kind": "guest", "nickname": guest.nickname })
            }
            _ => json!({ "kind": "guest" }),
        };
        let watermark_text = link.watermark.then(|| {
            let who = match &access.visitor {
                Visitor::User(user, _) => user.display_name.clone(),
                Visitor::Guest { .. } => "访客".to_owned(),
            };
            format!("{who} · {}", crate::profile::time_text(now))
        });
        let owner = match state.system.space_owner(&link.space_id).await {
            Ok(Some(id)) => state.system.get_user(&id).await.ok().flatten(),
            _ => None,
        };
        api::ok(json!({
            "state": "active",
            "requires_password": false,
            "site": { "name": config.site.name, "timezone": config.site.timezone },
            "space_id": link.space_id,
            "bundle": link.resource_key.is_none(),
            "title": link.title,
            "roots": access.record.roots().iter().map(ResourceKey::to_target).collect::<Vec<_>>(),
            "role": access.role,
            "can": {
                "view": access.role.allows(Action::View),
                "comment": access.role.allows(Action::Comment),
                "edit": access.role.allows(Action::Edit),
                "download": link.allow_download && access.role.allows(Action::Download),
            },
            "allow_download": link.allow_download,
            "watermark": watermark_text,
            "visitor": visitor,
            "owner": owner.map(|user| json!({ "display_name": user.display_name, "avatar": user.avatar, "id": user.id })),
            "audience": link.audience,
        }))
    };
    access.attach_cookie(&mut response, &headers);
    private(response)
}

/// `POST /api/v1/share/{token}/unlock` 的请求体。
#[derive(Debug, Deserialize)]
pub struct UnlockBody {
    /// 访问密码。
    pub password: String,
}

/// `POST /api/v1/share/{token}/unlock`:输密码。
pub async fn unlock(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    Json(body): Json<UnlockBody>,
) -> Response {
    if let Err(response) = crate::auth::csrf::check(&headers).map_err(api::error_response) {
        return response;
    }
    if let Err(response) = token_ok(&token) {
        return response;
    }
    let now = session::now_millis();
    let ip = client_ip(extensions.get::<ClientIp>());
    let access = match load(&state, &token, &headers, &ip, now).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    let link_id = access.record.link.id.clone();
    // 没设密码的链接不需要解锁,也不占名额
    let Some(stored) = access.record.password_hash.clone() else {
        return api::ok(json!({ "unlocked": true }));
    };
    if let Some(lock) = reserve_password_attempt(&link_id, &ip, now) {
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            "locked",
            match lock {
                PasswordLock::Address => "输错次数太多,请 10 分钟后再试",
                PasswordLock::Link => "这个链接被输错密码的次数太多,已暂时锁定,请 10 分钟后再试",
            },
        );
    }
    // argon2 校验是 CPU 活,放到阻塞线程里
    let candidate = body.password;
    let verified = tokio::task::spawn_blocking(move || {
        crate::auth::password::verify_password(&candidate, &stored)
    })
    .await
    .unwrap_or(false);
    if !verified {
        // 名额已经在验证前占了,留着就是这次失败的记录
        return fail(StatusCode::UNAUTHORIZED, "wrong_password", "访问密码不正确");
    }
    release_password_attempt(&link_id, &ip, now);
    let pepper = pepper(&state).await;
    let expiry = now + UNLOCK_TTL_MS;
    let signature = unlock_signature(&pepper, &access.record, expiry);
    let mut response = api::ok(json!({ "unlocked": true }));
    let mut cookie = format!(
        "{}={expiry}.{signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}",
        unlock_cookie_name(&link_id),
        UNLOCK_TTL_MS / 1000
    );
    if is_secure(&headers) {
        cookie.push_str("; Secure");
    }
    set_cookie(&mut response, cookie);
    access.attach_cookie(&mut response, &headers);
    private(response)
}

/// 游客写操作只允许改标题和正文:其它属性(标签、种类、状态)不接受,就算请求里带了也丢掉。
fn sanitize_for_guest(capability: &str, args: Value) -> Value {
    if capability != "edit_item" {
        return args;
    }
    let mut kept = serde_json::Map::new();
    for field in ["id", "version", "title", "body"] {
        if let Some(value) = args.get(field) {
            kept.insert(field.to_owned(), value.clone());
        }
    }
    Value::Object(kept)
}

/// `POST /api/v1/share/{token}/call/{capability}`:通过链接调用白名单里的能力。
pub async fn call(
    State(state): State<Arc<AppState>>,
    Path((token, capability)): Path<(String, String)>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    body: Option<Json<Value>>,
) -> Response {
    if let Err(response) = crate::auth::csrf::check(&headers).map_err(api::error_response) {
        return response;
    }
    if let Err(response) = token_ok(&token) {
        return response;
    }
    if !LINK_CAPABILITIES.contains(&capability.as_str()) {
        return fail(
            StatusCode::FORBIDDEN,
            "forbidden",
            "通过分享链接不能进行这个操作",
        );
    }
    let now = session::now_millis();
    let ip = client_ip(extensions.get::<ClientIp>());
    let access = match load(&state, &token, &headers, &ip, now).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    if access.locked {
        return fail(
            StatusCode::UNAUTHORIZED,
            "password_required",
            "需要先输入访问密码",
        );
    }
    let is_write = WRITES.contains(&capability.as_str());
    if is_write && access.is_guest() {
        let key = format!("gw|{}|{}", access.record.link.id, access.ip);
        if !allow(&key, GUEST_WRITES_PER_MINUTE, 60_000, now) {
            return fail(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "操作太频繁,请稍后再试",
            );
        }
    }
    let args = body.map(|Json(value)| value).unwrap_or(Value::Null);
    let args = if args.is_null() { json!({}) } else { args };
    let args = if access.is_guest() {
        sanitize_for_guest(&capability, args)
    } else {
        args
    };

    let ctx = CallCtx::new(access.actor(), Surface::Web)
        .with_principal(access.principal())
        .with_link(access.grant());
    let mut response = match state.invoker.call(&capability, ctx, args).await {
        Ok(done) => {
            if is_write {
                join_as_collaborator(&state, &access, now).await;
            }
            api::ok_with_meta(done.data, done.meta)
        }
        Err(err) => api::error_response(err),
    };
    access.attach_cookie(&mut response, &headers);
    private(response)
}

/// 登录用户通过评论 / 编辑型链接第一次动手时,把他记成协作者(来源 `link:<id>`)。
/// 以后链接被撤销、重置也不影响他已有的协作者身份,所有者要收回就在协作者列表里单独移除他。
/// 游客不记(没有账号可记);已经有同样或更高权限的人不动;只查看的访问者不用记。
async fn join_as_collaborator(state: &AppState, access: &Access, now: Millis) {
    let Visitor::User(user, _) = &access.visitor else {
        return;
    };
    if access.role < Role::Commenter {
        return;
    }
    let role = access.role.min(Role::Editor);
    for root in access.record.roots() {
        let have = state
            .system
            .role_of(&user.id, &root, now)
            .await
            .ok()
            .flatten();
        if have.is_some_and(|have| have >= role) {
            continue;
        }
        let via = format!("link:{}", access.record.link.id);
        if let Err(err) = state
            .system
            .set_grant(
                &root,
                &user.id,
                role,
                &via,
                &access.record.link.created_by,
                now,
                None,
            )
            .await
        {
            tracing::warn!(error = %err, "把通过链接编辑的人记成协作者失败");
        }
    }
}

/// `GET /api/v1/share/{token}/raw` 的查询参数。
#[derive(Debug, Deserialize)]
pub struct RawQuery {
    /// 集合名。
    pub collection: String,
    /// 集合内相对路径。
    pub path: String,
}

/// `GET /api/v1/share/{token}/raw`:读链接范围内的原件(图片、音视频、下载)。
/// 游客的流量按链接按天累计,超过系统参数的上限就拒绝。
pub async fn raw(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Query(query): Query<RawQuery>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
) -> Response {
    if let Err(response) = token_ok(&token) {
        return response;
    }
    let now = session::now_millis();
    let ip = client_ip(extensions.get::<ClientIp>());
    let access = match load(&state, &token, &headers, &ip, now).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    if access.locked {
        return fail(
            StatusCode::UNAUTHORIZED,
            "password_required",
            "需要先输入访问密码",
        );
    }
    let day = site_day(now);
    let cap_bytes = u64::from(state.account.config.get().share.guest_link_gb_per_day) * (1 << 30);
    if access.is_guest()
        && cap_bytes > 0
        && state
            .system
            .link_bytes(&access.record.link.id, &day)
            .await
            .unwrap_or(0)
            >= cap_bytes
    {
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            "traffic_limit",
            "这个链接今天的访问流量已达上限,请明天再试",
        );
    }
    let ctx = CallCtx::new(access.actor(), Surface::Web)
        .with_principal(access.principal())
        .with_link(access.grant());
    let args = json!({ "collection": query.collection, "path": query.path });
    let resolved = match state.invoker.call("file_raw", ctx, args).await {
        Ok(done) => done.data,
        Err(err) => return api::error_response(err),
    };
    let mut response = match api::raw_response(&resolved, !access.record.link.allow_download).await
    {
        Ok((response, size)) => {
            if access.is_guest() {
                let _ = state
                    .system
                    .add_link_bytes(&access.record.link.id, &day, size)
                    .await;
            }
            response
        }
        Err(response) => response,
    };
    access.attach_cookie(&mut response, &headers);
    private(response)
}

/// `GET /api/v1/share/{token}/download`:链接访客下载原件。
///
/// 和 `/raw` 共用同一套链接校验与流量记账,但这里只做「下载」:
/// 关掉「允许下载」的链接一律 403,不因为文件是图片 / 视频就放行。
pub async fn download(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Query(query): Query<RawQuery>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
) -> Response {
    if let Err(response) = token_ok(&token) {
        return response;
    }
    let now = session::now_millis();
    let ip = client_ip(extensions.get::<ClientIp>());
    let access = match load(&state, &token, &headers, &ip, now).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    if access.locked {
        return fail(
            StatusCode::UNAUTHORIZED,
            "password_required",
            "需要先输入访问密码",
        );
    }
    if !access.record.link.allow_download {
        return fail(
            StatusCode::FORBIDDEN,
            "download_disabled",
            "这个链接不允许下载原件",
        );
    }
    let day = site_day(now);
    let cap_bytes = u64::from(state.account.config.get().share.guest_link_gb_per_day) * (1 << 30);
    if access.is_guest()
        && cap_bytes > 0
        && state
            .system
            .link_bytes(&access.record.link.id, &day)
            .await
            .unwrap_or(0)
            >= cap_bytes
    {
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            "traffic_limit",
            "这个链接今天的访问流量已达上限,请明天再试",
        );
    }
    let ctx = CallCtx::new(access.actor(), Surface::Web)
        .with_principal(access.principal())
        .with_link(access.grant());
    let args = json!({ "collection": query.collection, "path": query.path });
    let resolved = match state.invoker.call("file_raw", ctx, args).await {
        Ok(done) => done.data,
        Err(err) => return api::error_response(err),
    };
    let mut response = match api::download_response(
        &resolved,
        headers
            .get(axum::http::header::RANGE)
            .and_then(|value| value.to_str().ok()),
    )
    .await
    {
        Ok((response, size)) => {
            if access.is_guest() {
                let _ = state
                    .system
                    .add_link_bytes(&access.record.link.id, &day, size)
                    .await;
            }
            response
        }
        Err(response) => response,
    };
    access.attach_cookie(&mut response, &headers);
    private(response)
}

/// `GET /api/v1/share/{token}/owner-avatar`:分享人的头像。
///
/// 游客没有登录,`/users/{id}/avatar` 对他们是 401,页面上「谁分享给你」就只能画首字母。这里改成按链接校验:
/// 链接有效、没被密码挡住,才给这个链接所属知识库的所有者的头像(和页面上显示的分享人是同一个人)。
pub async fn owner_avatar(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Query(query): Query<crate::profile::AvatarQuery>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
) -> Response {
    if let Err(response) = token_ok(&token) {
        return response;
    }
    let now = session::now_millis();
    let ip = client_ip(extensions.get::<ClientIp>());
    let access = match load(&state, &token, &headers, &ip, now).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    if access.locked {
        return fail(
            StatusCode::UNAUTHORIZED,
            "password_required",
            "需要先输入访问密码",
        );
    }
    let owner = match state.system.space_owner(&access.record.link.space_id).await {
        Ok(Some(id)) => id,
        Ok(None) => return fail(StatusCode::NOT_FOUND, "not_found", "没有头像"),
        Err(err) => return api::error_response(err),
    };
    crate::profile::avatar_image(&state, &owner, query.v.as_deref()).await
}

/// `POST /api/v1/share/{token}/guest` 的请求体。
#[derive(Debug, Deserialize)]
pub struct GuestBody {
    /// 新昵称。
    pub nickname: String,
}

/// `POST /api/v1/share/{token}/guest`:游客改自己的昵称。
pub async fn rename_guest(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    Json(body): Json<GuestBody>,
) -> Response {
    if let Err(response) = crate::auth::csrf::check(&headers).map_err(api::error_response) {
        return response;
    }
    if let Err(response) = token_ok(&token) {
        return response;
    }
    let now = session::now_millis();
    let ip = client_ip(extensions.get::<ClientIp>());
    let access = match load(&state, &token, &headers, &ip, now).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    let (Visitor::Guest { secret_hash, .. }, false) = (&access.visitor, access.locked) else {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "只有游客需要起昵称",
        );
    };
    let mut response = match state
        .system
        .set_guest_nickname(secret_hash, &body.nickname)
        .await
    {
        Ok(nickname) => api::ok(json!({ "nickname": nickname })),
        Err(err) => api::error_response(err),
    };
    access.attach_cookie(&mut response, &headers);
    private(response)
}

fn site_day(now: Millis) -> String {
    // 站点时区的自然日,和 LLM 用量按同一个口径
    kb_core::timezone::day_key(now)
}

/// `GET /api/v1/share/{token}/collab?doc=…`:经分享链接的协作连接(登录用户或游客)。
///
/// 和其它公开接口一样先过链接状态、所有者账号、访问密码;文档必须落在链接范围内,
/// 能不能编辑取决于链接角色(游客还要按系统参数降级)。
pub async fn collab_socket(
    State(state): State<Arc<AppState>>,
    Path(token): Path<String>,
    Query(query): Query<crate::collab_ws::CollabQuery>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    upgrade: axum::extract::ws::WebSocketUpgrade,
) -> Response {
    if let Err(response) = token_ok(&token) {
        return response;
    }
    let Some(endpoint) = state.collab.clone() else {
        return fail(StatusCode::NOT_FOUND, "collab_disabled", "在线协作没有启用");
    };
    let config = state.account.config.get();
    if !crate::collab_ws::origin_ok(&headers, &config.site.public_url) {
        return fail(StatusCode::FORBIDDEN, "bad_origin", "不允许的来源");
    }
    let now = session::now_millis();
    let ip = client_ip(extensions.get::<ClientIp>());
    let access = match load(&state, &token, &headers, &ip, now).await {
        Ok(access) => access,
        Err(response) => return response,
    };
    if access.locked {
        return fail(
            StatusCode::UNAUTHORIZED,
            "password_required",
            "需要先输入访问密码",
        );
    }
    let (key, doc) = match crate::collab_ws::parse_doc(&query.doc) {
        Ok(parsed) => parsed,
        Err(err) => return api::error_response(err),
    };
    // 文档必须在链接范围内;范围外一律 404,和「不存在」同一个回答
    if !access.record.roots().iter().any(|root| key.is_within(root)) || access.role < Role::Viewer {
        return fail(StatusCode::NOT_FOUND, "not_found", "没有找到这个内容");
    }
    if !endpoint.hub.doc_exists(&doc).await {
        return fail(StatusCode::NOT_FOUND, "not_found", "没有找到这个内容");
    }
    let principal = access.principal();
    let (who, slot_key, cap) = match &access.visitor {
        Visitor::User(user, _) => (
            kb_collab::Participant {
                id: user.id.clone(),
                name: if user.display_name.trim().is_empty() {
                    user.username.clone()
                } else {
                    user.display_name.clone()
                },
            },
            format!("user:{}", user.id),
            20,
        ),
        Visitor::Guest { .. } => (
            kb_collab::Participant {
                id: principal.user_id.clone(),
                name: access
                    .guest
                    .as_ref()
                    .map_or_else(|| "访客".to_owned(), |guest| guest.nickname.clone()),
            },
            format!("guest-ip:{ip}"),
            10,
        ),
    };
    let Some(slot) = endpoint.reserve(slot_key, cap) else {
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            "too_many_connections",
            "打开的协作窗口太多,请关掉一些再试",
        );
    };
    let join = kb_collab::JoinRequest {
        doc,
        who,
        ctx: format!(
            "link:{}:{}",
            access.record.link.id,
            crate::collab_ws::link_epoch(&access.record)
        ),
        writable: access.role.allows(Action::Edit),
    };
    let mut response = crate::collab_ws::serve(upgrade, endpoint, join, slot);
    access.attach_cookie(&mut response, &headers);
    response
}
