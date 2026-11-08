//! 鉴权。
//!
//! - **UDS 来源** = 本机超级用户(本地 CLI / `kb mcp` 走这条),不需要登录,落在主知识库;
//! - **TCP 来源** 必须带会话 cookie 或 `Authorization: Bearer kb_<令牌>`,二者都属于某个**用户**,
//!   请求带着这个用户的 [`Principal`](知识库 + 最终生效的功能)进入能力层;
//! - 会话令牌 7 天有效、滑动续期,cookie 为 `HttpOnly; SameSite=Strict; Path=/`;
//! - 非 GET 请求(会话鉴权)还要过 CSRF:带 `X-KB-CSRF: 1`,且 `Origin` 为空或与 `Host` 一致;
//! - 密码是 argon2id 哈希,存在 `system.db` 的用户行里;首个管理员由 `kb auth set-password` 创建;
//! - 令牌只存 sha256;`scope = mcp` 只能用 MCP 可见面的能力(最多 W 级),`scope = api` 走 Web 面(最多 G 级)。

pub mod clientip;
pub mod csrf;
pub mod password;
pub mod ratelimit;
pub mod session;
pub mod token;
pub mod totp;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use kb_capability::{Permission, Principal, Surface};

use kb_core::KbError;
use kb_core::account::{NewUser, PRIMARY_SPACE_ID, ROLE_ADMIN, User, UserStatus, UserToken};
use kb_core::ports::system::IdentityStore;
use serde::Deserialize;
use serde_json::json;

use crate::api::{self, AppState};
use crate::source::SocketKind;

/// 不需要登录的路径(健康检查、登录、登录状态、公开 Skill)。
pub const PUBLIC_PATHS: [&str; 9] = [
    "/api/v1/health",
    "/api/v1/auth/login",
    // 密码对了、开着两步验证的账号用挑战 + 验证码换会话
    "/api/v1/auth/login/totp",
    "/api/v1/auth/status",
    // 注册与找回密码:没有账号的人也要能用(各自有限速、CSRF 头和防枚举)
    "/api/v1/auth/email-code",
    "/api/v1/auth/register",
    "/api/v1/auth/invite-check",
    "/api/v1/auth/password/reset",
    // 公开 Skill:只有“怎么用”,没有账号信息或密钥;与 /skill.md 是同一份正文
    "/api/v1/skill",
];

/// 鉴权方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthVia {
    /// Unix socket(本机超级用户)。
    Local,
    /// 会话 cookie。
    Session,
    /// Bearer 令牌。
    Token,
    /// 用户自己的 admin key(`kb_ak_…`):以本人身份调用本人权限内的全部接口,等同于登录了浏览器。
    AdminKey,
    /// `agent.sock` 上的会话级伴生令牌。
    Agent,
}

/// 客户端 IP(由 [`guard`] 从 `ConnectInfo` 取出,登录限速用)。
#[derive(Clone, Debug)]
pub struct ClientIp(pub String);

/// 通过鉴权后的身份(由 [`guard`] 放进请求扩展,`api::call` 只认它)。
#[derive(Clone, Debug)]
pub struct Identity {
    /// 操作者。
    pub actor: String,
    /// 可见面。
    pub surface: Surface,
    /// 权限上限。
    pub max_permission: Permission,
    /// 怎么鉴权的。
    pub via: AuthVia,
    /// `Some` = 只能调用这些 MCP 工具组(ACP 伴生身份)。`None` = 不限制。
    pub tool_groups: Option<Vec<String>>,
    /// 多用户身份:谁、哪个知识库、最终能用哪些功能。能力调用、事件过滤、上传都用它。
    pub principal: Principal,
    /// 登录用户本人(会话 / 令牌来源才有)。
    pub user: Option<Arc<User>>,
    /// 令牌 / MCP 会话是否「包含共享给我」(见 [`AgentGrant::include_shared`])。
    pub include_shared: bool,
}

impl Identity {
    /// 本机超级用户。
    pub fn local(surface: Surface) -> Self {
        Self {
            actor: "local".to_owned(),
            surface,
            max_permission: Permission::Admin,
            via: AuthVia::Local,
            tool_groups: None,
            principal: Principal::local(),
            user: None,
            include_shared: false,
        }
    }

    /// ACP 伴生进程:MCP 面,权限上限 Write,工具组由签发时决定。
    ///
    /// 身份(用户 + 知识库)取自签发这个令牌的那次会话;旧的没带身份的授权按本机处理。
    pub fn agent(session_id: &str, tool_groups: Vec<String>, principal: Option<Principal>) -> Self {
        Self {
            actor: format!("agent:{session_id}"),
            surface: Surface::Mcp,
            max_permission: Permission::Write,
            via: AuthVia::Agent,
            tool_groups: Some(tool_groups),
            principal: principal.unwrap_or_else(Principal::local),
            user: None,
            include_shared: false,
        }
    }

    /// 带上「包含共享给我」开关。
    #[must_use]
    pub fn with_include_shared(mut self, include_shared: bool) -> Self {
        self.include_shared = include_shared;
        self
    }

    /// 是不是「本人亲自操作」:浏览器会话或本人的 admin key。
    /// 以前写成 `via == Session` 的地方(改资料、导出数据、管理令牌、两步验证、打开别人分享的内容……)
    /// 都认这个,这样拿 admin key 的 AI 能做本人在浏览器里能做的所有事。API 令牌和 MCP 令牌不算。
    pub fn acts_as_account(&self) -> bool {
        matches!(self.via, AuthVia::Session | AuthVia::AdminKey)
    }

    /// 是否本机来源(改密码、管理令牌只允许它)。
    pub fn is_local(&self) -> bool {
        self.via == AuthVia::Local
    }

    /// 这个身份能看哪些推送事件。
    pub fn viewer(&self) -> crate::hub::Viewer {
        crate::hub::Viewer {
            space_id: if self.principal.local {
                Some(PRIMARY_SPACE_ID.to_owned())
            } else {
                self.principal.space_id.clone()
            },
            system: self.principal.features.allows("sys.ops"),
            // 本机超级用户不是具体的某个人;其余身份用他自己的 id
            user_id: (!self.principal.local).then(|| self.principal.user_id.clone()),
        }
    }
}

/// 调用上传 / 事件后端时带上的调用者(后端据此选知识库)。
#[derive(Clone, Debug)]
pub struct Caller {
    /// 审计里的操作者。
    pub actor: String,
    /// 调用者身份。
    pub principal: Principal,
}

impl From<&Identity> for Caller {
    fn from(identity: &Identity) -> Self {
        Self {
            actor: identity.actor.clone(),
            principal: identity.principal.clone(),
        }
    }
}

/// 用户 → 身份(知识库 + 功能集合)的短时缓存。
///
/// 每个请求都要算一次最终生效的功能(角色勾选 + 用户例外 + AI 总开关),要查几次库。
/// 缓存 5 秒:管理员改了角色或例外,最多 5 秒后对在线用户生效(设计规范的「10 秒内」)。
#[derive(Default)]
pub struct PrincipalCache {
    inner: Mutex<HashMap<String, (Instant, Principal)>>,
}

/// 缓存时长。
const PRINCIPAL_TTL: Duration = Duration::from_secs(5);

impl PrincipalCache {
    /// 取(或算出)一个用户的身份。
    pub async fn principal_for(
        &self,
        system: &dyn IdentityStore,
        user: &User,
        ai: &kb_core::features::AiState,
    ) -> kb_core::Result<Principal> {
        // 缓存键带上 AI 开关状态:管理员一关 AI,下一个请求就按新状态重算
        let key = format!(
            "{}|{}{}",
            user.id,
            u8::from(ai.master),
            ai.off.iter().cloned().collect::<Vec<_>>().join(",")
        );
        if let Ok(guard) = self.inner.lock()
            && let Some((at, principal)) = guard.get(&key)
            && at.elapsed() < PRINCIPAL_TTL
        {
            return Ok(principal.clone());
        }
        let features = system.effective_features(&user.id, ai.clone()).await?;
        let space = system.personal_space(&user.id).await?;
        let principal = match space {
            Some(space) => Principal::user(user.id.clone(), space.id, features),
            // 没有个人知识库的用户(不应出现):有身份、能用账号级功能,但碰不到任何知识库
            None => Principal {
                user_id: user.id.clone(),
                space_id: None,
                features: Arc::new(features),
                local: false,
            },
        };
        if let Ok(mut guard) = self.inner.lock() {
            guard.retain(|_, (at, _)| at.elapsed() < PRINCIPAL_TTL * 4);
            guard.insert(key, (Instant::now(), principal.clone()));
        }
        Ok(principal)
    }

    /// 立即让某个用户的缓存失效(本进程里改了角色 / 例外 / 状态之后调用)。
    pub fn invalidate(&self, user_id: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.retain(|key, _| !key.starts_with(&format!("{user_id}|")));
        }
    }

    /// 清空(AI 总开关、角色大改之后)。
    pub fn clear(&self) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.clear();
        }
    }
}

/// 从 `X-KB-Source` 头取可见面(UDS 来源用它区分 mcp / web / agent)。
fn surface_from_header(headers: &HeaderMap) -> Surface {
    match headers
        .get("x-kb-source")
        .and_then(|value| value.to_str().ok())
    {
        Some("mcp") => Surface::Mcp,
        Some("agent") => Surface::Agent,
        _ => Surface::Web,
    }
}

/// 令牌 scope → (可见面, 权限上限)。
fn token_scope(scopes: &str) -> (Surface, Permission) {
    match scopes.trim() {
        "mcp" => (Surface::Mcp, Permission::Write),
        _ => (Surface::Web, Permission::Govern),
    }
}

/// `Authorization: Bearer <value>`,不要求 `kb_` 前缀(agent.sock 的会话令牌没有前缀)。
fn authorization_value(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let rest = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))?;
    let value = rest.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let rest = raw
        .strip_prefix("Bearer ")
        .or_else(|| raw.strip_prefix("bearer "))?;
    let value = rest.trim();
    if value.starts_with(token::TOKEN_PREFIX) && value.len() > token::TOKEN_PREFIX.len() {
        Some(value.to_owned())
    } else {
        None
    }
}

fn unauthorized(message: &str) -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "ok": false,
            "error": { "code": "unauthorized", "message": message },
        })),
    )
        .into_response()
}

/// 鉴权中间件:UDS 直接放行,TCP 必须通过会话或 Bearer。
pub async fn guard(
    kind: SocketKind,
    state: Arc<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    if kind == SocketKind::Unix {
        let surface = surface_from_header(request.headers());
        request.extensions_mut().insert(Identity::local(surface));
        return next.run(request).await;
    }
    if kind == SocketKind::Agent {
        let path = request.uri().path();
        let capability = path == "/api/v1/health"
            || path == "/api/v1/capabilities"
            || path.starts_with("/api/v1/capabilities/");
        if !capability {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({
                    "ok": false,
                    "error": { "code": "forbidden", "message": "agent.sock 只开放能力调用" },
                })),
            )
                .into_response();
        }
        let Some(raw) = authorization_value(request.headers()) else {
            return unauthorized("agent.sock 需要会话令牌");
        };
        let Some(grant) = state.agent_grants.lookup(&raw) else {
            return unauthorized("会话令牌无效或已失效");
        };
        request.extensions_mut().insert(
            Identity::agent(&grant.session_id, grant.tool_groups, grant.principal)
                .with_include_shared(grant.include_shared),
        );
        return next.run(request).await;
    }
    // 限速 / 审计按真实客户端 IP:生产上所有请求都经本机代理进来,对端永远是回环地址,
    // 规则见 `clientip`(只在对端是回环时才信转发头,并且不取客户端可伪造的第一项)
    let client_ip = clientip::resolve(
        request
            .extensions()
            .get::<ConnectInfo<std::net::SocketAddr>>()
            .map(|ConnectInfo(addr)| addr.ip()),
        request.headers(),
    );
    request.extensions_mut().insert(ClientIp(client_ip));

    let path = request.uri().path().to_owned();
    // 管理端页面和静态资源不带会话也能打开;接口本身仍要登录
    if !path.starts_with("/api/") && path != "/mcp" && !path.starts_with("/mcp/") {
        return next.run(request).await;
    }
    if PUBLIC_PATHS.contains(&path.as_str()) || path == "/mcp" {
        return next.run(request).await;
    }
    // 公开的分享接口(游客也能用):每个处理函数自己校验链接、密码和访问范围,见 `share_public`
    if path.starts_with("/api/v1/share/") {
        return next.run(request).await;
    }

    let now = session::now_millis();
    let ai = (state.ai_enabled)();
    if let Some(raw) = bearer(request.headers()) {
        // admin key(kb_ak_ 开头)不在 api_tokens 表里,单独查;其余照旧按 API 令牌处理
        if raw.starts_with(token::ADMIN_KEY_PREFIX) {
            return match admin_key_identity(&state, &raw, &ai).await {
                Ok(Some(identity)) => {
                    // 管理员的 key 也受「必须开两步验证」策略约束,和浏览器会话、API 令牌一致
                    if let Some(response) = admin_totp_gate(&state, &path, &identity).await {
                        return response;
                    }
                    request.extensions_mut().insert(identity);
                    next.run(request).await
                }
                Ok(None) => unauthorized("admin key 无效:可能已经轮换,或者账号已被停用"),
                Err(err) => api::error_response(err),
            };
        }
        match token_identity(&state, &raw, now, &ai).await {
            Ok(Some(identity)) => {
                // 站点要求管理员开两步验证时,管理员的 API 令牌也一样:不然拿到令牌就能绕过这条策略
                if let Some(response) = admin_totp_gate(&state, &path, &identity).await {
                    return response;
                }
                request.extensions_mut().insert(identity);
                return next.run(request).await;
            }
            Ok(None) => return unauthorized("令牌无效或已撤销"),
            Err(err) => return api::error_response(err),
        }
    }

    if let Some(raw) = session::cookie_token(request.headers()) {
        match session::authenticate(state.system.as_ref(), &raw, now).await {
            Ok(Some((_, user))) => {
                if csrf::needs_check(request.method())
                    && let Err(err) = csrf::check(request.headers())
                {
                    return api::error_response(err);
                }
                let principal = match state
                    .principals
                    .principal_for(state.system.as_ref(), &user, &ai)
                    .await
                {
                    Ok(principal) => principal,
                    Err(err) => return api::error_response(err),
                };
                let identity = Identity {
                    actor: "user".to_owned(),
                    surface: Surface::Web,
                    max_permission: Permission::Admin,
                    via: AuthVia::Session,
                    tool_groups: None,
                    principal,
                    user: Some(Arc::new(user)),
                    include_shared: false,
                };
                // 站点要求管理级账号必须开两步验证:没开的只能访问 /api/v1/auth/ 下的接口
                // (设置两步验证、看自己是谁、退出),其它一律拒绝——服务端强制,不靠前端自觉
                if let Some(response) = admin_totp_gate(&state, &path, &identity).await {
                    return response;
                }
                request.extensions_mut().insert(identity);
                return next.run(request).await;
            }
            Ok(None) => return unauthorized("会话不存在或已过期,请重新登录"),
            Err(err) => return api::error_response(err),
        }
    }

    unauthorized("请先登录")
}

/// 站点要求管理级账号必须开两步验证([accounts] require_admin_totp),而这个账号没开:
/// 返回要拒绝的响应(`/api/v1/auth/` 下的接口放行,好让他去设置)。浏览器会话和 API 令牌共用这一道。
/// 查两步验证状态出错按「没开」处理,即拒绝(宁可误拦也不放行)。
async fn admin_totp_gate(state: &AppState, path: &str, identity: &Identity) -> Option<Response> {
    if path.starts_with("/api/v1/auth/")
        || !state.account.config.get().accounts.require_admin_totp
        || !totp::is_admin_like(Some(identity))
    {
        return None;
    }
    let account = identity.user.as_ref()?;
    if state
        .system
        .totp_enabled(&account.id)
        .await
        .unwrap_or(false)
    {
        return None;
    }
    Some(
        (
            StatusCode::FORBIDDEN,
            Json(json!({
                "ok": false,
                "error": {
                    "code": "totp_setup_required",
                    "message": "站点要求管理员开启两步验证,请先到个人设置里开启",
                },
            })),
        )
            .into_response(),
    )
}

/// admin key → 身份。key 不存在、已被轮换掉、主人被停用都返回 `None`。
///
/// 身份和浏览器会话一样(`Surface::Web`、权限上限 Admin,实际能做什么仍由主人的功能点和角色决定),
/// 区别只有 `via`:没有会话 cookie,所以不需要 CSRF 头;`actor` 仍是 `user`,
/// 这样 `save_insight` 这类按操作者标记作者的接口照常工作。
pub(crate) async fn admin_key_identity(
    state: &AppState,
    plaintext: &str,
    ai: &kb_core::features::AiState,
) -> kb_core::Result<Option<Identity>> {
    let Some(user) = state.system.find_user_by_admin_key(plaintext).await? else {
        return Ok(None);
    };
    let principal = state
        .principals
        .principal_for(state.system.as_ref(), &user, ai)
        .await?;
    Ok(Some(Identity {
        actor: "user".to_owned(),
        surface: Surface::Web,
        max_permission: Permission::Admin,
        via: AuthVia::AdminKey,
        tool_groups: None,
        principal,
        user: Some(Arc::new(user)),
        include_shared: false,
    }))
}

/// Bearer 令牌 → 身份。令牌无效、已撤销、主人被停用都返回 `None`。
pub(crate) async fn token_identity(
    state: &AppState,
    plaintext: &str,
    now: i64,
    ai: &kb_core::features::AiState,
) -> kb_core::Result<Option<Identity>> {
    let hash = token::sha256_hex(plaintext);
    let Some((found, user)) = state.system.find_token(&hash).await? else {
        return Ok(None);
    };
    // 最近使用时间一分钟才写一次,别让每个 API 请求都落一次库
    if found.last_used.is_none_or(|at| now - at > 60_000) {
        let system = state.system.clone();
        let id = found.id.clone();
        tokio::spawn(async move {
            let _ = system.touch_token(&id, now).await;
        });
    }
    let principal = state
        .principals
        .principal_for(state.system.as_ref(), &user, ai)
        .await?;
    let (surface, max_permission) = token_scope(&found.scopes);
    Ok(Some(Identity {
        actor: format!("token:{}", found.name),
        surface,
        max_permission,
        via: AuthVia::Token,
        tool_groups: None,
        principal,
        user: Some(Arc::new(user)),
        include_shared: found.include_shared,
    }))
}

/// 一份「摆设」哈希:查不到用户时也对它做一次 argon2 校验,让「用户不存在」和「密码错」耗时一致,
/// 不给枚举用户名的人留下时间差。
fn dummy_hash() -> &'static str {
    static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HASH.get_or_init(|| {
        password::hash_password("dummy-password-for-timing-only").unwrap_or_default()
    })
}

/// 给前端看的用户摘要(不含任何密码相关字段)。
fn user_json(user: &User, principal: &Principal) -> serde_json::Value {
    json!({
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "email_verified": user.email_verified_at.is_some(),
        "display_name": user.display_name,
        "avatar": user.avatar,
        "role_id": user.role_id,
        "status": user.status.as_str(),
        "must_change_password": user.must_change_password,
        // 注销冷静期结束的时间;不在注销中是 null。页面据此显示「账号将于 X 删除」的横幅
        "delete_after": user.delete_after,
        "space_id": principal.space_id,
        "features": principal.features.effective(),
        "ai_enabled": principal.features.ai_enabled(),
    })
}

/// `GET /api/v1/auth/status`。
pub async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let users = state.system.count_users().await.unwrap_or(0);
    let logged_in = match session::cookie_token(&headers) {
        Some(raw) => session::authenticate(state.system.as_ref(), &raw, session::now_millis())
            .await
            .ok()
            .flatten()
            .is_some(),
        None => false,
    };
    let config = state.account.config.get();
    api::ok(json!({
        // 兼容旧前端:有账号就当作「已设置密码」
        "password_set": users > 0,
        "setup_required": users == 0,
        "logged_in": logged_in,
        // 登录 / 注册页据此决定显示什么:不暴露任何服务器内部信息
        "registration_open": config.accounts.registration_open && crate::signup::mail_ready(&config),
        "require_invite": config.accounts.require_invite,
        "mail_ready": crate::signup::mail_ready(&config),
        "site": { "name": config.site.name, "tagline": config.site.tagline, "timezone": config.site.timezone },
    }))
}

/// `GET /api/v1/auth/me`:当前登录的用户、知识库和最终生效的功能(前端据此显示 / 隐藏入口)。
pub async fn me(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let Some(identity) = request.extensions().get::<Identity>().cloned() else {
        return unauthorized("请先登录");
    };
    // 部署开关:关掉后前端不显示「查看」,后端也会在闸门里拒绝
    let inspect = state.account.config.get().admin.inspect_enabled;
    match &identity.user {
        Some(user) => api::ok(json!({
            "local": false,
            "user": user_json(user, &identity.principal),
            "admin_inspect_enabled": inspect,
        })),
        None => api::ok(json!({
            "local": true,
            "user": null,
            "features": identity.principal.features.effective(),
            "ai_enabled": identity.principal.features.ai_enabled(),
            "admin_inspect_enabled": inspect,
        })),
    }
}

/// `POST /api/v1/auth/login` 的请求体。
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    /// 用户名或邮箱。旧前端不带它:系统里只有一个账号时按这个账号处理。
    #[serde(default, alias = "username")]
    pub login: Option<String>,
    /// 密码明文(只在内存里待一瞬间,不写日志)。
    pub password: String,
}

/// 是否走 https(反向代理转发时看 `X-Forwarded-Proto`)。
fn is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("https"))
}

fn session_cookie(token: &str, secure: bool) -> String {
    let mut cookie = format!(
        "{}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
        token::SESSION_COOKIE,
        token::SESSION_TTL_MS / 1000
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

fn cleared_cookie() -> String {
    format!(
        "{}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        token::SESSION_COOKIE
    )
}

/// 登录被限速时的回答(来源 IP 和被试账号两把锁共用,看不出是哪一把)。
fn login_rate_limited() -> Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "ok": false,
            "error": { "code": "rate_limited", "message": "登录失败次数过多,请稍后再试" },
        })),
    )
        .into_response()
}

/// 登录失败的统一回答:不区分「没有这个用户」和「密码不对」。
const BAD_CREDENTIALS: &str = "用户名或密码不正确";

/// `POST /api/v1/auth/login`。
pub async fn login(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    Json(body): Json<LoginRequest>,
) -> Response {
    let ip = extensions
        .get::<ClientIp>()
        .map(|ClientIp(ip)| ip.clone())
        .unwrap_or_else(|| "unknown".to_owned());
    let now = session::now_millis();
    // 第一把锁:来源 IP(防单个来源猛试)
    if state.login_limiter.blocked(&ip, now) {
        return login_rate_limited();
    }
    let identifier = body
        .login
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let candidate: Option<User> = match identifier {
        Some(login) => state.system.find_user_by_login(login).await.ok().flatten(),
        None => {
            // 旧前端只发密码:系统里只有一个账号时没有歧义,按它登录;否则必须写明是谁
            match state.system.list_users(Default::default(), 2, 0).await {
                Ok((users, 1)) => users.into_iter().next(),
                Ok((_, 0)) => {
                    return api::error_response(KbError::InvalidInput(
                        "还没有账号:请先在服务器上执行 `kb auth set-password` 创建管理员"
                            .to_owned(),
                    ));
                }
                Ok(_) => {
                    return api::error_response(KbError::InvalidInput(
                        "请输入用户名或邮箱".to_owned(),
                    ));
                }
                Err(err) => return api::error_response(err),
            }
        }
    };
    // 第二把锁:被试的账号(防换 IP 的分布式猜密码)。键用账号 id——用户名和邮箱是同一个人,
    // 不能靠换着写绕开;没有这个账号时用输入的文字,这样「存在 / 不存在」的表现完全一样,猜不出谁注册过。
    let account_key = match (&candidate, identifier) {
        (Some(user), _) => format!("acct:{}", user.id),
        (None, Some(text)) => format!("acct:?{}", text.to_lowercase()),
        (None, None) => "acct:?".to_owned(),
    };
    if state.login_limiter.blocked_in(
        &account_key,
        now,
        ratelimit::ACCOUNT_WINDOW_MS,
        ratelimit::ACCOUNT_MAX_FAILURES,
    ) {
        return login_rate_limited();
    }
    let stored = match &candidate {
        Some(user) => state.system.password_hash(&user.id).await.ok().flatten(),
        None => None,
    };
    let verified =
        password::verify_password(&body.password, stored.as_deref().unwrap_or(dummy_hash()))
            && stored.is_some();
    let Some(user) = candidate.filter(|_| verified) else {
        state.login_limiter.record_failure(&ip, now);
        state
            .login_limiter
            .record_failure_in(&account_key, now, ratelimit::ACCOUNT_WINDOW_MS);
        let _ = state
            .system
            .record_audit(None, "login.failed", identifier, &json!({}), Some(&ip))
            .await;
        return unauthorized(BAD_CREDENTIALS);
    };
    if !user.status.can_sign_in() {
        return api::error_response(KbError::Forbidden("账号已停用,请联系管理员".to_owned()));
    }
    // 注意:成功登录**不清**失败记录。攻击者拿自己的账号登录成功,就能把自己对别人账号的
    // 失败次数清零,窗口被无限续期;记录只随窗口自然过期。
    // 开着两步验证:密码对了还不能发会话,只发一个挑战,验证码对了再换(见 `totp::login_totp`)。
    // 查不出来(数据库抖动)时**拒绝登录**,不能当成「没开两步验证」放行。
    let totp_on = match state.system.totp_enabled(&user.id).await {
        Ok(enabled) => enabled,
        Err(err) => return api::error_response(err),
    };
    if totp_on {
        let challenge = totp::issue_challenge(&user.id, now);
        return api::ok(json!({
            "logged_in": false,
            "totp_required": true,
            "challenge": challenge,
        }));
    }
    complete_login(&state, &headers, &user, &ip, now).await
}

/// 登录收尾:建会话、记审计、下发 cookie。密码直接通过和两步验证通过后共用。
pub(crate) async fn complete_login(
    state: &AppState,
    headers: &HeaderMap,
    user: &User,
    ip: &str,
    now: i64,
) -> Response {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let created = session::create(
        state.system.as_ref(),
        &user.id,
        Some(ip.to_owned()),
        user_agent,
        now,
    )
    .await;
    let principal = state
        .principals
        .principal_for(state.system.as_ref(), user, &(state.ai_enabled)())
        .await;
    match (created, principal) {
        (Ok(token), Ok(principal)) => {
            let _ = state.system.touch_login(&user.id, now).await;
            let _ = state
                .system
                .record_audit(Some(&user.id), "login", None, &json!({}), Some(ip))
                .await;
            let mut response = api::ok(json!({
                "logged_in": true,
                "user": user_json(user, &principal),
            }));
            if let Ok(value) = session_cookie(&token, is_https(headers)).parse() {
                response.headers_mut().insert(header::SET_COOKIE, value);
            }
            response
        }
        (Err(err), _) | (_, Err(err)) => api::error_response(err),
    }
}

/// `POST /api/v1/auth/logout`。
pub async fn logout(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(raw) = session::cookie_token(&headers)
        && let Err(err) = session::logout(state.system.as_ref(), &raw).await
    {
        return api::error_response(err);
    }
    let mut response = api::ok(json!({ "logged_in": false }));
    if let Ok(value) = cleared_cookie().parse() {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

/// `POST /api/v1/auth/password` 的请求体。
#[derive(Debug, Deserialize)]
pub struct PasswordRequest {
    /// 新密码明文。
    pub password: String,
    /// 给谁设;不写 = 主知识库的所有者(第一个管理员),还没有任何账号时创建 `admin`。
    #[serde(default)]
    pub username: Option<String>,
}

/// 主知识库的所有者(第一个管理员)。
async fn primary_admin(system: &dyn IdentityStore) -> kb_core::Result<Option<User>> {
    let Some(space) = system.get_space(PRIMARY_SPACE_ID).await? else {
        return Ok(None);
    };
    system.get_user(&space.owner_id).await
}

/// 主知识库的所有者;还没有就建一个**占位管理员**:用户名 `admin`,密码是没人知道的随机串,
/// 登录不了,直到本机执行 `kb auth set-password` 设置真正的密码。
///
/// 本机在设置密码之前就要建令牌(`kb auth token create`)是老用法,令牌必须有主人,所以需要这个占位。
async fn ensure_primary_admin(system: &dyn IdentityStore) -> kb_core::Result<User> {
    if let Some(user) = primary_admin(system).await? {
        return Ok(user);
    }
    let placeholder = password::hash_password(&token::random_secret())?;
    let (user, _) = system
        .create_user(NewUser {
            username: "admin".to_owned(),
            email: None,
            display_name: Some("管理员".to_owned()),
            password_hash: placeholder,
            role_id: ROLE_ADMIN.to_owned(),
            status: UserStatus::Active,
            registered_via: "cli".to_owned(),
            must_change_password: false,
            email_verified: false,
        })
        .await?;
    Ok(user)
}

/// `POST /api/v1/auth/password`(只允许 UDS 来源,即 `kb auth set-password`)。
///
/// 没有任何账号时创建第一个管理员 `admin`;已有账号时给指定用户(默认是主知识库所有者)改密码,
/// 并让他的其它会话全部失效。
pub async fn set_password(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let Some(identity) = request.extensions().get::<Identity>().cloned() else {
        return unauthorized("请先登录");
    };
    if !identity.is_local() {
        return api::error_response(KbError::Forbidden("密码只能在本机通过 CLI 设置".to_owned()));
    }
    let body = match axum::body::to_bytes(request.into_body(), 64 * 1024).await {
        Ok(bytes) => bytes,
        Err(err) => {
            return api::error_response(KbError::InvalidInput(format!("读取请求体失败: {err}")));
        }
    };
    let parsed: PasswordRequest = match serde_json::from_slice(&body) {
        Ok(parsed) => parsed,
        Err(err) => {
            return api::error_response(KbError::InvalidInput(format!("请求体不合法: {err}")));
        }
    };
    let hash = match password::hash_password(&parsed.password) {
        Ok(hash) => hash,
        Err(err) => return api::error_response(err),
    };
    let target = match parsed
        .username
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Some(name) => match state.system.find_user_by_login(name).await {
            Ok(Some(user)) => Some(user),
            Ok(None) => {
                return api::error_response(KbError::NotFound(format!("用户 {name}")));
            }
            Err(err) => return api::error_response(err),
        },
        None => match primary_admin(state.system.as_ref()).await {
            Ok(user) => user,
            Err(err) => return api::error_response(err),
        },
    };
    let result = match target {
        Some(user) => state
            .system
            .set_password_hash(&user.id, &hash, false, None)
            .await
            .map(|()| user.username),
        None => state
            .system
            .create_user(NewUser {
                username: "admin".to_owned(),
                email: None,
                display_name: Some("管理员".to_owned()),
                password_hash: hash,
                role_id: ROLE_ADMIN.to_owned(),
                status: UserStatus::Active,
                registered_via: "cli".to_owned(),
                must_change_password: false,
                email_verified: false,
            })
            .await
            .map(|(user, _)| user.username),
    };
    match result {
        Ok(username) => {
            state.principals.clear();
            let _ = state
                .system
                .record_audit(
                    None,
                    "password.set",
                    Some(&username),
                    &json!({ "via": "cli" }),
                    None,
                )
                .await;
            api::ok(json!({ "password_set": true, "username": username }))
        }
        Err(err) => api::error_response(err),
    }
}

/// `POST /api/v1/auth/tokens` 的请求体。
#[derive(Debug, Deserialize)]
pub struct CreateTokenRequest {
    /// 名字(同一用户下唯一)。
    pub name: String,
    /// `mcp` 或 `api`。
    #[serde(default = "default_scope")]
    pub scope: String,
    /// 远程 MCP 是否也搜「别人分享给我的」内容。默认否:AI 工具会把检索结果带进对话上下文,
    /// 别人的文档不该在没有明确同意的情况下流出去。
    #[serde(default)]
    pub include_shared: bool,
}

fn default_scope() -> String {
    "mcp".to_owned()
}

/// 令牌管理:允许本机(UDS)、**浏览器会话**和本人的 **admin key**,拒绝 API / MCP 令牌。
///
/// 设置页的「访问令牌」要能列出令牌;API 令牌仍然不能管理令牌,避免一个 api 令牌给自己提权。
/// admin key 是本人的全权凭据(用它创建 MCP 令牌是它的主要用途之一)。
/// 返回令牌的**主人**:会话 = 登录的用户;本机 = 主知识库的所有者(第一个管理员)。
async fn token_owner(state: &AppState, identity: Option<&Identity>) -> Result<User, Box<Response>> {
    let Some(identity) = identity else {
        return Err(Box::new(unauthorized("请先登录")));
    };
    if let Some(user) = &identity.user
        && identity.acts_as_account()
    {
        return Ok(user.as_ref().clone());
    }
    if identity.is_local() {
        return ensure_primary_admin(state.system.as_ref())
            .await
            .map_err(|err| Box::new(api::error_response(err)));
    }
    Err(Box::new(api::error_response(KbError::Forbidden(
        "令牌管理需要本机会话或 UDS".to_owned(),
    ))))
}

/// `POST /api/v1/auth/tokens`。
pub async fn create_token(State(state): State<Arc<AppState>>, request: Request) -> Response {
    // 先把身份从请求里取出来:`Request` 不是 Sync,不能带着它的引用跨 await
    let identity = request.extensions().get::<Identity>().cloned();
    let owner = match token_owner(&state, identity.as_ref()).await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    // 创建令牌属于「API 令牌与 MCP」功能(本机超级用户不受限)
    if let Some(identity) = &identity
        && !identity.principal.features.allows("api.tokens")
    {
        return api::error_response(KbError::Forbidden("你的账号没有开通这个功能".to_owned()));
    }
    let body = match axum::body::to_bytes(request.into_body(), 64 * 1024).await {
        Ok(bytes) => bytes,
        Err(err) => {
            return api::error_response(KbError::InvalidInput(format!("读取请求体失败: {err}")));
        }
    };
    let parsed: CreateTokenRequest = match serde_json::from_slice(&body) {
        Ok(parsed) => parsed,
        Err(err) => {
            return api::error_response(KbError::InvalidInput(format!("请求体不合法: {err}")));
        }
    };
    if parsed.name.trim().is_empty() {
        return api::error_response(KbError::InvalidInput("令牌名不能为空".to_owned()));
    }
    let scope = parsed.scope.trim();
    if scope != "mcp" && scope != "api" {
        return api::error_response(KbError::InvalidInput("scope 只能是 mcp 或 api".to_owned()));
    }
    let plaintext = format!("{}{}", token::TOKEN_PREFIX, token::random_secret());
    let now = session::now_millis();
    let created = UserToken {
        id: uuid::Uuid::now_v7().to_string(),
        user_id: owner.id.clone(),
        name: parsed.name.trim().to_owned(),
        token_hash: token::sha256_hex(&plaintext),
        scopes: scope.to_owned(),
        include_shared: parsed.include_shared && scope == "mcp",
        created_at: now,
        last_used: None,
        revoked_at: None,
    };
    if let Err(err) = state.system.create_token(created.clone()).await {
        return api::error_response(err);
    }
    let _ = state
        .system
        .record_audit(
            Some(&owner.id),
            "token.create",
            Some(&created.name),
            &json!({ "scope": scope }),
            None,
        )
        .await;
    api::ok(json!({
        "id": created.id,
        "name": created.name,
        "scope": created.scopes,
        // 明文只在这里出现一次
        "token": plaintext,
    }))
}

/// `GET /api/v1/auth/tokens`:只列**自己的**令牌。
pub async fn list_tokens(State(state): State<Arc<AppState>>, request: Request) -> Response {
    let identity = request.extensions().get::<Identity>().cloned();
    let owner = match token_owner(&state, identity.as_ref()).await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    match state.system.list_tokens(&owner.id).await {
        Ok(tokens) => {
            let rows: Vec<serde_json::Value> = tokens
                .iter()
                .map(|token| {
                    json!({
                        "id": token.id,
                        "name": token.name,
                        "scope": token.scopes,
                        "include_shared": token.include_shared,
                        "created_at": token.created_at,
                        "last_used": token.last_used,
                        "revoked_at": token.revoked_at,
                    })
                })
                .collect();
            api::ok(json!({ "tokens": rows }))
        }
        Err(err) => api::error_response(err),
    }
}

/// `DELETE /api/v1/auth/tokens/{id}`:只能撤销**自己的**令牌,别人的当作不存在。
pub async fn revoke_token(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
    request: Request,
) -> Response {
    let identity = request.extensions().get::<Identity>().cloned();
    let owner = match token_owner(&state, identity.as_ref()).await {
        Ok(owner) => owner,
        Err(response) => return *response,
    };
    let now = session::now_millis();
    match state.system.revoke_token(&owner.id, &id, now).await {
        Ok(true) => api::ok(json!({ "id": id, "revoked_at": now })),
        Ok(false) => api::error_response(KbError::NotFound(format!("令牌 {id}"))),
        Err(err) => api::error_response(err),
    }
}
