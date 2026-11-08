//! 邮箱注册、找回密码、改密码(多用户设计说明)。
//!
//! 几条贯穿的规则:
//! - **防枚举**:要验证码时,不管邮箱注册过没有,页面上的回答一模一样;发信放到后台任务里,
//!   所以「发了」和「没发」的响应时间也一样。已注册的邮箱收到的是「有人尝试用你的邮箱注册」的提醒。
//! - **限速分三层**:验证码按邮箱 / IP 限频(落库,重启不清零);验证失败 5 次作废;
//!   注册、找回密码接口再按 IP 限失败次数。
//! - **验证码只存哈希**,哈希里带服务器私有的 pepper、邮箱、用途,见 `kb_core::account::hash_code`。
//! - 这些公开 POST 接口也要求 `X-KB-CSRF` 头并检查 `Origin`:不让别的网站的页面替访客的浏览器去发邮件。

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use kb_core::account::{
    EmailPurpose, NewUser, ROLE_USER, UserStatus, check_password_strength, generate_email_code,
    hash_code, looks_like_email_code, normalize_email, normalize_invite_code, normalize_username,
};
use kb_core::config::ConfigStore;
use kb_core::model::identity::{CodeLimits, IssueOutcome, VerifyOutcome};
use kb_core::ports::system::IdentityStore;
use kb_core::{KbError, token};
use kb_mail::{Mail, Mailer, Passwords};
use serde::Deserialize;
use serde_json::json;

use crate::api::{self, AppState};
use crate::auth::ratelimit::LoginLimiter;
use crate::auth::{ClientIp, Identity, csrf, password, session};

/// 验证码有效分钟数。
pub const CODE_TTL_MINUTES: u32 = 10;

/// 读两个发件账号授权码的函数(每次现读 `secrets.toml`,改了立刻生效)。
pub type PasswordSource = Arc<dyn Fn() -> Passwords + Send + Sync>;

/// 账号自助相关的依赖:注册 / 找回密码用的配置、发信器、限速器,以及个人资料用的头像目录。
#[derive(Clone)]
pub struct AccountDeps {
    /// 配置(`[accounts]` / `[mail]` / `[site]` / `[quota]` 热更新)。
    pub config: Arc<ConfigStore>,
    /// 发信器(主备切换)。
    pub mailer: Arc<Mailer>,
    /// 授权码来源。
    pub passwords: PasswordSource,
    /// 注册 / 找回密码 / 邀请码探测的失败限速(按 IP)。
    pub limiter: Arc<LoginLimiter>,
    /// 头像目录(`<KB_HOME>/avatars`,全站共有)。
    pub avatars_dir: std::path::PathBuf,
    /// 数据根目录(`KB_HOME`):编辑器扩展目录这类「全站共有、默认放在根目录下」的东西从这里派生。
    pub home: std::path::PathBuf,
    /// 个人数据导出(`kb-cli` 提供实现)。
    pub exports: Arc<dyn crate::export_api::PersonalExport>,
}

impl AccountDeps {
    /// 没配置邮件的版本(测试、嵌入式 CLI):邮件功能关闭,注册接口返回「暂未开放」。
    pub fn unconfigured() -> Self {
        Self {
            config: Arc::new(ConfigStore::new(kb_core::Config::default())),
            mailer: Arc::new(Mailer::new(Box::new(kb_mail::MemoryTransport::default()))),
            passwords: Arc::new(Passwords::default),
            limiter: Arc::new(LoginLimiter::new()),
            // 没有数据目录的场景(测试、嵌入式):指向一个不存在的位置,读写头像都会失败而不是写到别处
            avatars_dir: std::path::PathBuf::from("/nonexistent/kb-avatars"),
            home: std::path::PathBuf::from("/nonexistent/kb-home"),
            exports: Arc::new(crate::export_api::NoExport),
        }
    }
}

/// 邮件功能是否可用(开了并且至少配好一个发件账号)。
pub fn mail_ready(config: &kb_core::Config) -> bool {
    config.mail.enabled
        && (config.mail.primary.is_configured() || config.mail.backup.is_configured())
}

fn fail(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

fn bad(message: &str) -> Response {
    fail(StatusCode::BAD_REQUEST, "invalid_input", message)
}

fn too_many(message: &str, retry_after: i64) -> Response {
    let mut response = fail(StatusCode::TOO_MANY_REQUESTS, "rate_limited", message);
    if let Ok(value) = retry_after.max(1).to_string().parse() {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn client_ip(extensions: &axum::http::Extensions) -> String {
    extensions
        .get::<ClientIp>()
        .map(|ClientIp(ip)| ip.clone())
        .unwrap_or_else(|| "unknown".to_owned())
}

/// 一次性邮箱域名(小清单,挡最常见的;管理员还能用域名白名单收紧)。
const DISPOSABLE: &[&str] = &[
    "mailinator.com",
    "guerrillamail.com",
    "guerrillamail.net",
    "10minutemail.com",
    "tempmail.com",
    "temp-mail.org",
    "yopmail.com",
    "throwawaymail.com",
    "sharklasers.com",
    "trashmail.com",
    "getnada.com",
    "maildrop.cc",
    "dispostable.com",
    "fakeinbox.com",
    "mailnesia.com",
    "mintemail.com",
    "tempr.email",
    "moakt.com",
];

/// 邮箱域名是否允许注册。返回不允许的原因。
fn domain_policy(config: &kb_core::Config, email: &str) -> Result<(), &'static str> {
    let domain = email.rsplit('@').next().unwrap_or("");
    let allow = &config.accounts.email_domain_allowlist;
    if !allow.is_empty() {
        return if allow
            .iter()
            .any(|item| item.trim().eq_ignore_ascii_case(domain))
        {
            Ok(())
        } else {
            Err("这个邮箱域名暂不支持注册")
        };
    }
    if config.accounts.block_disposable_email && DISPOSABLE.contains(&domain) {
        return Err("不支持一次性邮箱");
    }
    Ok(())
}

/// 校验公开 POST 的 CSRF 头与 Origin;不通过时返回要直接回给客户端的响应。
fn csrf_refusal(headers: &HeaderMap) -> Option<Response> {
    csrf::check(headers).err().map(api::error_response)
}

async fn pepper(state: &AppState) -> Result<String, KbError> {
    pepper_of(state.system.as_ref()).await
}

/// 服务器私有的 pepper(第一次用到时随机生成并存进账号库)。
pub async fn pepper_of(system: &dyn IdentityStore) -> Result<String, KbError> {
    system
        .get_or_create_secret("pepper", Box::new(token::random_secret))
        .await
}

/// 邀请码明文 → 入库的哈希。注册和管理端建码必须用同一个函数,否则永远对不上。
pub async fn invite_hash(system: &dyn IdentityStore, code: &str) -> Result<String, KbError> {
    Ok(invite_digest(&pepper_of(system).await?, code))
}

/// 邀请码哈希的算法本体(`code` 须已规范化为 `KB-XXXX-XXXX`)。
pub fn invite_digest(pepper: &str, code: &str) -> String {
    hash_code(pepper, "invite", "", code)
}

/// 后台发一封邮件并记录结果。放到任务里:响应不等 SMTP,「发了」和「没发」耗时一样。
pub(crate) fn deliver(state: Arc<AppState>, to: String, mail: Mail) {
    tokio::spawn(async move {
        let config = state.account.config.get();
        let outgoing = mail.render(&to, &config.site.name, &config.site.public_url);
        let passwords = (state.account.passwords)();
        let result = state
            .account
            .mailer
            .send(&config.mail, &passwords, &config.site.name, &outgoing)
            .await;
        let (ok, via, error) = match &result {
            Ok(kb_mail::Via::Primary) => (true, Some("primary"), None),
            Ok(kb_mail::Via::Backup) => (true, Some("backup"), None),
            Err(err) => (false, None, Some(err.to_string())),
        };
        if let Err(err) = state
            .system
            .record_mail(&to, mail.kind(), ok, via, error.as_deref())
            .await
        {
            tracing::warn!(error = %err, "记录发信结果失败");
        }
    });
}

// ------------------------------------------------------------------ 取验证码

/// `POST /api/v1/auth/email-code` 的请求体。
#[derive(Debug, Deserialize)]
pub struct EmailCodeRequest {
    /// 邮箱。
    pub email: String,
    /// `register` 或 `reset`。
    pub purpose: String,
}

/// `POST /api/v1/auth/email-code`:给邮箱发验证码。
pub async fn email_code(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    Json(body): Json<EmailCodeRequest>,
) -> Response {
    if let Some(response) = csrf_refusal(&headers) {
        return response;
    }
    let config = state.account.config.get();
    let purpose = match body.purpose.as_str() {
        "register" => EmailPurpose::Register,
        "reset" => EmailPurpose::Reset,
        _ => return bad("用途只能是 register 或 reset"),
    };
    if !mail_ready(&config) {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "邮箱功能暂未开放,请联系管理员",
        );
    }
    if purpose == EmailPurpose::Register && !config.accounts.registration_open {
        return fail(
            StatusCode::FORBIDDEN,
            "forbidden",
            "注册已关闭,请联系管理员",
        );
    }
    let email = match normalize_email(&body.email) {
        Ok(email) => email,
        Err(err) => return api::error_response(err),
    };
    if purpose == EmailPurpose::Register
        && let Err(reason) = domain_policy(&config, &email)
    {
        return bad(reason);
    }
    let ip = client_ip(&extensions);
    let now = session::now_millis();
    // 全站每分钟发信上限:防止被拿来刷邮件
    match state.system.mails_since(now - 60_000).await {
        Ok(sent) if sent >= i64::from(config.mail.per_minute) => {
            return too_many("发送太频繁了,请稍后再试", 30);
        }
        Ok(_) => {}
        Err(err) => return api::error_response(err),
    }
    let pepper = match pepper(&state).await {
        Ok(pepper) => pepper,
        Err(err) => return api::error_response(err),
    };
    let code = generate_email_code();
    let hash = hash_code(&pepper, purpose.as_str(), &email, &code);
    let outcome = state
        .system
        .issue_email_code(
            &email,
            purpose,
            &hash,
            Some(&ip),
            i64::from(CODE_TTL_MINUTES) * 60_000,
            CodeLimits::default(),
            now,
        )
        .await;
    match outcome {
        Ok(IssueOutcome::Issued { .. }) => {}
        Ok(IssueOutcome::TooSoon { wait_secs }) => {
            return too_many(&format!("请 {wait_secs} 秒后再获取验证码"), wait_secs);
        }
        Ok(IssueOutcome::EmailDailyLimit) => {
            return too_many("这个邮箱今天获取验证码太多次了,请明天再试", 3600);
        }
        Ok(IssueOutcome::IpHourlyLimit) => {
            return too_many("你这个网络获取验证码太频繁了,请稍后再试", 600);
        }
        Err(err) => return api::error_response(err),
    }
    // 该发什么邮件:取决于邮箱是否已注册,但页面上的回答不透露这一点
    let existing = state.system.find_user_by_login(&email).await.ok().flatten();
    match (purpose, existing) {
        (EmailPurpose::Register, Some(_)) => {
            deliver(state.clone(), email.clone(), Mail::AlreadyRegistered)
        }
        (EmailPurpose::Register, None) => deliver(
            state.clone(),
            email.clone(),
            Mail::RegisterCode {
                code,
                minutes: CODE_TTL_MINUTES,
            },
        ),
        (EmailPurpose::Reset, Some(user)) if user.status.can_sign_in() => deliver(
            state.clone(),
            email.clone(),
            Mail::ResetCode {
                code,
                minutes: CODE_TTL_MINUTES,
            },
        ),
        // 找回密码:邮箱没注册 / 账号已停用——什么都不发,响应和别的情形一样
        _ => {}
    }
    api::ok(json!({ "sent": true, "wait_secs": 60, "ttl_minutes": CODE_TTL_MINUTES }))
}

// --------------------------------------------------------------------- 注册

/// `POST /api/v1/auth/register` 的请求体。
#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    /// 邮箱。
    pub email: String,
    /// 邮箱验证码。
    pub code: String,
    /// 用户名。
    pub username: String,
    /// 昵称(可选)。
    #[serde(default)]
    pub display_name: Option<String>,
    /// 密码。
    pub password: String,
    /// 邀请码(管理员要求时必填)。
    #[serde(default)]
    pub invite: Option<String>,
}

fn session_cookie(token_value: &str, secure: bool) -> String {
    let mut cookie = format!(
        "{}={token_value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}",
        crate::auth::token::SESSION_COOKIE,
        crate::auth::token::SESSION_TTL_MS / 1000
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

fn is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("https"))
}

/// 验证码校验失败的统一文案;锁定时让用户重新获取。
fn code_failure(outcome: &VerifyOutcome) -> Response {
    match outcome {
        VerifyOutcome::Wrong { attempts_left } => {
            bad(&format!("验证码不正确,还可以再试 {attempts_left} 次"))
        }
        VerifyOutcome::Locked => bad("验证码错误次数过多,请重新获取"),
        _ => bad("验证码已过期,或还没有获取"),
    }
}

/// `POST /api/v1/auth/register`:邮箱 + 验证码 + 用户名 + 密码(+ 邀请码)。
pub async fn register(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    Json(body): Json<RegisterRequest>,
) -> Response {
    if let Some(response) = csrf_refusal(&headers) {
        return response;
    }
    let config = state.account.config.get();
    if !config.accounts.registration_open {
        return fail(
            StatusCode::FORBIDDEN,
            "forbidden",
            "注册已关闭,请联系管理员",
        );
    }
    if !mail_ready(&config) {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "邮箱注册暂未开放,请联系管理员",
        );
    }
    let ip = client_ip(&extensions);
    let limiter_key = format!("reg:{ip}");
    let now = session::now_millis();
    if state.account.limiter.blocked(&limiter_key, now) {
        return too_many("尝试次数过多,请稍后再试", 60);
    }
    let reject = |response: Response| {
        state.account.limiter.record_failure(&limiter_key, now);
        response
    };

    let email = match normalize_email(&body.email) {
        Ok(email) => email,
        Err(err) => return reject(api::error_response(err)),
    };
    if let Err(reason) = domain_policy(&config, &email) {
        return reject(bad(reason));
    }
    let username = match normalize_username(&body.username) {
        Ok(name) => name,
        Err(err) => return reject(api::error_response(err)),
    };
    if let Err(reason) = check_password_strength(&body.password, &username) {
        return reject(bad(reason));
    }
    if !looks_like_email_code(body.code.trim()) {
        return reject(bad("验证码是 6 位数字"));
    }
    let pepper = match pepper(&state).await {
        Ok(pepper) => pepper,
        Err(err) => return api::error_response(err),
    };

    // 邀请码:管理员要求时必填;填了就必须有效(即使没要求,填错也提示,免得用户以为用上了)
    let invite_hash = match body
        .invite
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
    {
        Some(text) => match normalize_invite_code(text) {
            Some(code) => Some(invite_digest(&pepper, &code)),
            None => return reject(bad("邀请码格式不对,应形如 KB-XXXX-XXXX")),
        },
        None if config.accounts.require_invite => return reject(bad("注册需要邀请码")),
        None => None,
    };
    if let Some(hash) = &invite_hash {
        match state.system.peek_invite(hash, now).await {
            Ok(Some(_)) => {}
            Ok(None) => return reject(bad("邀请码无效、已过期或已用完")),
            Err(err) => return api::error_response(err),
        }
    }
    // 用户名先查一遍,免得用户收了验证码、填完才发现名字被占。
    // 这一步不需要有效的验证码就能走到,所以「已被占用」的回答必须计入失败次数:
    // 否则任何人都能不受限制地换着用户名试,把已注册的用户名扫出来。
    if matches!(
        state.system.find_user_by_login(&username).await,
        Ok(Some(_))
    ) {
        return reject(fail(StatusCode::CONFLICT, "exists", "用户名已被占用"));
    }

    let candidate = hash_code(
        &pepper,
        EmailPurpose::Register.as_str(),
        &email,
        body.code.trim(),
    );
    let verified = match state
        .system
        .verify_email_code(&email, EmailPurpose::Register, &candidate, now)
        .await
    {
        Ok(VerifyOutcome::Verified { id }) => id,
        Ok(other) => return reject(code_failure(&other)),
        Err(err) => return api::error_response(err),
    };

    // 占用邀请码(原子):两个人同时用同一个单次码,只有一个拿到
    let invite = match &invite_hash {
        Some(hash) => match state.system.claim_invite(hash, now).await {
            Ok(Some(invite)) => Some(invite),
            Ok(None) => return reject(bad("邀请码刚刚被用完了")),
            Err(err) => return api::error_response(err),
        },
        None => None,
    };

    // 角色:邀请码指定的优先,其次系统默认,角色被删了就退回普通用户
    let wanted_role = invite
        .as_ref()
        .and_then(|invite| invite.role_id.clone())
        .unwrap_or_else(|| config.accounts.default_role.clone());
    let role_id = match state.system.get_role(&wanted_role).await {
        Ok(Some(role)) if !role.all_features => role.id,
        // 注册永远不能直接变成管理员,哪怕有人把默认角色配成了管理员
        _ => ROLE_USER.to_owned(),
    };
    let hash = match password::hash_password(&body.password) {
        Ok(hash) => hash,
        Err(err) => {
            release(&state, invite.as_ref()).await;
            return api::error_response(err);
        }
    };
    let created = state
        .system
        .create_user(NewUser {
            username,
            email: Some(email.clone()),
            display_name: body.display_name.clone(),
            password_hash: hash,
            role_id,
            status: UserStatus::Active,
            registered_via: invite.as_ref().map_or_else(
                || "email".to_owned(),
                |invite| format!("invite:{}", invite.id),
            ),
            must_change_password: false,
            email_verified: true,
        })
        .await;
    let (user, _space) = match created {
        Ok(pair) => pair,
        Err(err) => {
            release(&state, invite.as_ref()).await;
            return api::error_response(err);
        }
    };
    let _ = state.system.consume_email_code(&verified, now).await;
    if let Some(invite) = &invite {
        let _ = state
            .system
            .record_invite_use(&invite.id, &user.id, Some(&ip), now)
            .await;
        if invite.quota_json.trim() != "{}" {
            let _ = state
                .system
                .update_user(
                    &user.id,
                    kb_core::model::identity::UserUpdate {
                        quota_json: Some(invite.quota_json.clone()),
                        ..Default::default()
                    },
                )
                .await;
        }
    }
    // 邀请码带「自动加好友」:新用户和邀请人互为好友,邀请人收到一条通知。
    // 好友数满了、被拉黑、邀请人账号没了都不影响注册本身——这只是锦上添花。
    if let Some(invite) = &invite
        && invite.auto_friend
        && let Some(inviter_id) = &invite.created_by
    {
        auto_friend_inviter(&state, &user, inviter_id, now).await;
    }
    state.account.limiter.reset(&limiter_key);
    let _ = state
        .system
        .record_audit(
            Some(&user.id),
            "register",
            Some(&user.username),
            &json!({ "invite": invite.as_ref().map(|i| i.prefix.clone()) }),
            Some(&ip),
        )
        .await;

    // 注册完直接登录
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let token_value =
        match session::create(state.system.as_ref(), &user.id, Some(ip), user_agent, now).await {
            Ok(token_value) => token_value,
            Err(err) => return api::error_response(err),
        };
    let mut response =
        api::ok(json!({ "registered": true, "logged_in": true, "username": user.username }));
    if let Ok(value) = session_cookie(&token_value, is_https(&headers)).parse() {
        response.headers_mut().insert(header::SET_COOKIE, value);
    }
    response
}

/// 新用户通过邀请码注册后,和邀请人互为好友并通知邀请人。任何一步失败都只记日志。
async fn auto_friend_inviter(
    state: &AppState,
    user: &kb_core::account::User,
    inviter_id: &str,
    now: i64,
) {
    let defaults = state.account.config.get().quota.clone();
    let cap_of = |id: String| {
        let (system, defaults) = (state.system.clone(), defaults.clone());
        async move {
            system
                .effective_quota(&id, &defaults)
                .await
                .map_or(0, |quota| quota.friends_per_user)
        }
    };
    let caps = kb_core::model::identity::Caps {
        me: cap_of(user.id.clone()).await,
        other: cap_of(inviter_id.to_owned()).await,
    };
    match state
        .system
        .make_friends(&user.id, inviter_id, caps, now)
        .await
    {
        Ok(true) => {
            let notifier = crate::notify::Notifier::new(
                state.system.clone(),
                Some(state.hub.clone()),
                state.account.config.clone(),
            );
            notifier
                .send(
                    inviter_id,
                    kb_core::social::kind::FRIEND_RESULT,
                    json!({
                        "accepted": true,
                        "via_invite": true,
                        "by": {
                            "id": user.id,
                            "username": user.username,
                            "display_name": user.display_name,
                            "avatar": user.avatar,
                        },
                    }),
                    now,
                )
                .await;
        }
        Ok(false) => {}
        Err(err) => tracing::warn!(error = %err, "邀请码自动加好友失败"),
    }
}

async fn release(state: &AppState, invite: Option<&kb_core::account::InviteCode>) {
    if let Some(invite) = invite
        && let Err(err) = state.system.release_invite(&invite.id).await
    {
        tracing::warn!(error = %err, "归还邀请码失败");
    }
}

// ----------------------------------------------------------------- 邀请码检查

/// `POST /api/v1/auth/invite-check` 的请求体。
#[derive(Debug, Deserialize)]
pub struct InviteCheckRequest {
    /// 邀请码。
    pub invite: String,
}

/// `POST /api/v1/auth/invite-check`:注册页填完邀请码立刻告诉用户有没有效(不占用次数)。
pub async fn invite_check(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    Json(body): Json<InviteCheckRequest>,
) -> Response {
    if let Some(response) = csrf_refusal(&headers) {
        return response;
    }
    let key = format!("reg:{}", client_ip(&extensions));
    let now = session::now_millis();
    if state.account.limiter.blocked(&key, now) {
        return too_many("尝试次数过多,请稍后再试", 60);
    }
    let Some(code) = normalize_invite_code(&body.invite) else {
        state.account.limiter.record_failure(&key, now);
        return api::ok(json!({ "valid": false, "reason": "邀请码格式不对,应形如 KB-XXXX-XXXX" }));
    };
    let pepper = match pepper(&state).await {
        Ok(pepper) => pepper,
        Err(err) => return api::error_response(err),
    };
    match state
        .system
        .peek_invite(&invite_digest(&pepper, &code), now)
        .await
    {
        Ok(Some(_)) => api::ok(json!({ "valid": true, "code": code })),
        Ok(None) => {
            // 猜邀请码也算失败:挡住批量探测
            state.account.limiter.record_failure(&key, now);
            api::ok(json!({ "valid": false, "reason": "邀请码无效、已过期或已用完" }))
        }
        Err(err) => api::error_response(err),
    }
}

// ------------------------------------------------------------------- 找回密码

/// `POST /api/v1/auth/password/reset` 的请求体。
#[derive(Debug, Deserialize)]
pub struct ResetRequest {
    /// 邮箱。
    pub email: String,
    /// 验证码。
    pub code: String,
    /// 新密码。
    pub new_password: String,
}

/// `POST /api/v1/auth/password/reset`:验证码 + 新密码。成功后这个账号所有设备上的登录都失效。
pub async fn reset_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    Json(body): Json<ResetRequest>,
) -> Response {
    if let Some(response) = csrf_refusal(&headers) {
        return response;
    }
    let config = state.account.config.get();
    if !mail_ready(&config) {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "邮箱功能暂未开放,请联系管理员",
        );
    }
    let ip = client_ip(&extensions);
    let key = format!("reg:{ip}");
    let now = session::now_millis();
    if state.account.limiter.blocked(&key, now) {
        return too_many("尝试次数过多,请稍后再试", 60);
    }
    let reject = |response: Response| {
        state.account.limiter.record_failure(&key, now);
        response
    };
    let email = match normalize_email(&body.email) {
        Ok(email) => email,
        Err(err) => return reject(api::error_response(err)),
    };
    if !looks_like_email_code(body.code.trim()) {
        return reject(bad("验证码是 6 位数字"));
    }
    let pepper = match pepper(&state).await {
        Ok(pepper) => pepper,
        Err(err) => return api::error_response(err),
    };
    let candidate = hash_code(
        &pepper,
        EmailPurpose::Reset.as_str(),
        &email,
        body.code.trim(),
    );
    let verified = match state
        .system
        .verify_email_code(&email, EmailPurpose::Reset, &candidate, now)
        .await
    {
        Ok(VerifyOutcome::Verified { id }) => id,
        Ok(other) => return reject(code_failure(&other)),
        Err(err) => return api::error_response(err),
    };
    // 邮箱没注册的人拿不到有效验证码(根本没发过),走到这里的一定是账号的主人
    let user = match state.system.find_user_by_login(&email).await {
        Ok(Some(user)) if user.status.can_sign_in() => user,
        Ok(_) => return reject(bad("验证码已过期,或还没有获取")),
        Err(err) => return api::error_response(err),
    };
    if let Err(reason) = check_password_strength(&body.new_password, &user.username) {
        return bad(reason);
    }
    let hash = match password::hash_password(&body.new_password) {
        Ok(hash) => hash,
        Err(err) => return api::error_response(err),
    };
    // 不保留任何会话:密码被人拿走过的话,旧登录必须全部失效
    if let Err(err) = state
        .system
        .set_password_hash(&user.id, &hash, false, None)
        .await
    {
        return api::error_response(err);
    }
    let _ = state.system.consume_email_code(&verified, now).await;
    state.account.limiter.reset(&key);
    let _ = state
        .system
        .record_audit(
            Some(&user.id),
            "password.reset",
            None,
            &json!({ "via": "email" }),
            Some(&ip),
        )
        .await;
    api::ok(json!({ "reset": true }))
}

// ------------------------------------------------------------------- 改密码

/// `POST /api/v1/auth/change-password` 的请求体。
#[derive(Debug, Deserialize)]
pub struct ChangePasswordRequest {
    /// 旧密码。
    pub old_password: String,
    /// 新密码。
    pub new_password: String,
}

/// `POST /api/v1/auth/change-password`(已登录):验旧密码,改完后**其它设备**上的登录失效,当前这个保留。
pub async fn change_password(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    Json(body): Json<ChangePasswordRequest>,
) -> Response {
    let Some(identity) = extensions.get::<Identity>().cloned() else {
        return fail(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录");
    };
    let Some(user) = identity.user.as_ref() else {
        return fail(
            StatusCode::FORBIDDEN,
            "forbidden",
            "本机超级用户请用 kb auth set-password",
        );
    };
    let now = session::now_millis();
    let key = format!("pw:{}", user.id);
    if state.account.limiter.blocked(&key, now) {
        return too_many("旧密码输错次数过多,请稍后再试", 60);
    }
    let stored = state.system.password_hash(&user.id).await.ok().flatten();
    if !stored
        .as_deref()
        .is_some_and(|hash| password::verify_password(&body.old_password, hash))
    {
        state.account.limiter.record_failure(&key, now);
        return bad("旧密码不正确");
    }
    if let Err(reason) = check_password_strength(&body.new_password, &user.username) {
        return bad(reason);
    }
    if body.new_password == body.old_password {
        return bad("新密码不能和旧密码一样");
    }
    let hash = match password::hash_password(&body.new_password) {
        Ok(hash) => hash,
        Err(err) => return api::error_response(err),
    };
    let current = session::cookie_token(&headers).map(|raw| crate::auth::token::sha256_hex(&raw));
    if let Err(err) = state
        .system
        .set_password_hash(&user.id, &hash, false, current.as_deref())
        .await
    {
        return api::error_response(err);
    }
    state.account.limiter.reset(&key);
    let _ = state
        .system
        .record_audit(Some(&user.id), "password.change", None, &json!({}), None)
        .await;
    api::ok(json!({ "changed": true }))
}
