//! 个人资料:显示名、头像(多用户设计说明)。
//!
//! - 改资料 / 头像只认**浏览器会话**。API 令牌(给 AI 代理、脚本用)不能改一个人的头像和名字;
//!   本机 socket 上的超级用户不是某个具体的人,也没有「自己」的资料。
//! - 头像是全站共有的(好友列表、协作光标里别人要看),任何登录用户都能读,不分知识库。
//! - 头像处理见 [`crate::avatar`]:内容嗅探、尺寸上限、转正、居中裁切、重新编码。
//! - 上传按人限速:解码是 CPU 活,不能让一个人拿它压垮服务。
//! - 写请求的 CSRF 检查由认证中间件统一做(会话来源的所有非 GET 请求),这里不重复。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};

use kb_core::KbError;
use kb_core::account::{EmailPurpose, User};
use kb_core::model::identity::UserUpdate;
use serde::Deserialize;
use serde_json::json;

use crate::api::{self, AppState};
use crate::auth::{Identity, session};
use crate::avatar;

/// 显示名最长字符数。
pub const MAX_DISPLAY_NAME: usize = 30;

fn fail(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// 当前请求的登录用户,且必须是浏览器会话。
#[allow(clippy::result_large_err)]
fn session_user(identity: Option<&Identity>) -> Result<Arc<User>, Response> {
    let Some(identity) = identity else {
        return Err(fail(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录"));
    };
    if !identity.acts_as_account() {
        return Err(fail(
            StatusCode::FORBIDDEN,
            "forbidden",
            "只有在浏览器里登录后才能修改个人资料",
        ));
    }
    identity
        .user
        .clone()
        .ok_or_else(|| fail(StatusCode::FORBIDDEN, "forbidden", "没有可修改的账号"))
}

/// 同一个人的头像修改一次只处理一个:上传、删除交错时不会留下孤儿文件,也不会删掉别人刚写的新文件。
#[derive(Default)]
pub struct AvatarLocks {
    held: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl AvatarLocks {
    fn lock_for(&self, user_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut held = self
            .held
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        // 顺手清掉没人在用的条目,免得用户多了以后这张表一直涨
        held.retain(|_, lock| Arc::strong_count(lock) > 1);
        held.entry(user_id.to_owned()).or_default().clone()
    }
}

fn avatar_locks() -> &'static AvatarLocks {
    static LOCKS: std::sync::OnceLock<AvatarLocks> = std::sync::OnceLock::new();
    LOCKS.get_or_init(AvatarLocks::default)
}

// ---------------------------------------------------------------- 显示名

/// `PATCH /api/v1/me/profile` 的请求体。
#[derive(Debug, Deserialize)]
pub struct ProfileRequest {
    /// 新的显示名。
    pub display_name: String,
}

/// Unicode 的「格式字符」(类别 Cf)里会被拿来冒充的那几段:方向覆盖 / 隔离、零宽字符、字节序标记等。
/// 它们不可见却会改变文字的排列,`char::is_control` 管不到。
fn is_invisible_format(ch: char) -> bool {
    matches!(ch,
        '\u{00AD}' // 软连字符
        | '\u{200B}'..='\u{200F}' // 零宽空格 / 连接符 / 从左到右、从右到左标记
        | '\u{202A}'..='\u{202E}' // 方向嵌入与覆盖
        | '\u{2060}'..='\u{2064}' // 词连接符等
        | '\u{2066}'..='\u{2069}' // 方向隔离
        | '\u{FEFF}' // 字节序标记
    )
}

/// 显示名规则:去首尾空白,1–30 个字符,不含换行等控制字符、不可见的方向 / 零宽字符,不含 `<` `>`
/// (页面本来就会转义,这里再拒绝一次,别的使用场景——邮件、日志——也干净)。
pub fn check_display_name(raw: &str) -> Result<String, &'static str> {
    let name = raw.trim();
    let length = name.chars().count();
    if length == 0 {
        return Err("昵称不能为空");
    }
    if length > MAX_DISPLAY_NAME {
        return Err("昵称最多 30 个字");
    }
    if name
        .chars()
        .any(|ch| ch.is_control() || is_invisible_format(ch) || ch == '<' || ch == '>')
    {
        return Err("昵称不能包含换行、不可见字符或 < > 符号");
    }
    Ok(name.to_owned())
}

/// `PATCH /api/v1/me/profile`:改显示名。
pub async fn update_profile(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(body): Json<ProfileRequest>,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let name = match check_display_name(&body.display_name) {
        Ok(name) => name,
        Err(message) => return fail(StatusCode::BAD_REQUEST, "invalid_input", message),
    };
    match state
        .system
        .update_user(
            &user.id,
            UserUpdate {
                display_name: Some(name),
                ..Default::default()
            },
        )
        .await
    {
        Ok(updated) => api::ok(json!({ "display_name": updated.display_name })),
        Err(err) => api::error_response(err),
    }
}

// ---------------------------------------------------------------- 头像

/// `PUT /api/v1/me/avatar`:请求体就是图片本身(不用 multipart,少一层解析)。
pub async fn upload_avatar(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    body: Bytes,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    // 每人每分钟最多 5 次(含失败的):解码是 CPU 活
    let key = format!("avatar:{}", user.id);
    let now = session::now_millis();
    if state.account.limiter.blocked(&key, now) {
        let mut response = fail(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "头像上传太频繁了,请一分钟后再试",
        );
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static("60"));
        return response;
    }
    state.account.limiter.record_failure(&key, now);

    // 解码缩放放到阻塞线程池,不占住处理请求的异步线程
    let normalized = match tokio::task::spawn_blocking(move || avatar::normalize(&body)).await {
        Ok(Ok(png)) => png,
        Ok(Err(err)) => return api::error_response(err),
        Err(err) => {
            tracing::error!(error = %err, "头像处理任务异常退出");
            return api::error_response(KbError::Internal("头像处理失败".to_owned()));
        }
    };

    let lock = avatar_locks().lock_for(&user.id);
    let _guard = lock.lock().await;
    let dir = state.account.avatars_dir.clone();
    let name = avatar::new_file_name(&user.id);
    // 先写文件,再改库,最后删旧文件:任何一步失败都不会让用户处于「库里指向一个不存在的文件」的状态
    {
        let (dir, name, png) = (dir.clone(), name.clone(), normalized);
        match tokio::task::spawn_blocking(move || avatar::write_atomic(&dir, &name, &png)).await {
            Ok(Ok(())) => {}
            Ok(Err(err)) => return api::error_response(err),
            Err(_) => return api::error_response(KbError::Internal("保存头像失败".to_owned())),
        }
    }
    let previous = match state.system.get_user(&user.id).await {
        Ok(Some(current)) => current.avatar,
        Ok(None) => None,
        Err(err) => {
            avatar::remove(&dir, &name);
            return api::error_response(err);
        }
    };
    if let Err(err) = state
        .system
        .update_user(
            &user.id,
            UserUpdate {
                avatar: Some(Some(name.clone())),
                ..Default::default()
            },
        )
        .await
    {
        avatar::remove(&dir, &name);
        return api::error_response(err);
    }
    if let Some(old) = previous.filter(|old| *old != name) {
        avatar::remove(&dir, &old);
    }
    api::ok(json!({ "avatar": name }))
}

/// `DELETE /api/v1/me/avatar`:恢复成默认头像(首字母)。
pub async fn delete_avatar(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let lock = avatar_locks().lock_for(&user.id);
    let _guard = lock.lock().await;
    let previous = match state.system.get_user(&user.id).await {
        Ok(Some(current)) => current.avatar,
        Ok(None) => None,
        Err(err) => return api::error_response(err),
    };
    if let Err(err) = state
        .system
        .update_user(
            &user.id,
            UserUpdate {
                avatar: Some(None),
                ..Default::default()
            },
        )
        .await
    {
        return api::error_response(err);
    }
    if let Some(old) = previous {
        avatar::remove(&state.account.avatars_dir, &old);
    }
    api::ok(json!({ "avatar": null }))
}

/// `GET /api/v1/users/{id}/avatar` 的查询参数。
#[derive(Debug, Deserialize)]
pub struct AvatarQuery {
    /// 地址里带的版本(就是头像文件名)。只用来让浏览器缓存失效,服务端不信它。
    #[serde(default)]
    pub v: Option<String>,
}

/// `GET /api/v1/users/{id}/avatar`:任何登录用户都能读任何人的头像。没有头像返回 404(前端画首字母)。
pub async fn get_avatar(
    State(state): State<Arc<AppState>>,
    Path(user_id): Path<String>,
    Query(query): Query<AvatarQuery>,
    extensions: axum::http::Extensions,
) -> Response {
    if extensions.get::<Identity>().is_none() {
        return fail(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录");
    }
    avatar_image(&state, &user_id, query.v.as_deref()).await
}

/// 读某个用户的头像图片并组装响应(登录用户的 `/users/{id}/avatar` 和分享页的 `/share/{token}/owner-avatar` 共用)。
/// 调用方负责先确认“这个人有权看”。
pub(crate) async fn avatar_image(
    state: &AppState,
    user_id: &str,
    version: Option<&str>,
) -> Response {
    let name = match state.system.get_user(user_id).await {
        Ok(Some(user)) => user.avatar,
        Ok(None) => None,
        Err(err) => return api::error_response(err),
    };
    // 文件名只来自数据库,再校验一遍格式;请求里的任何字符串都不参与拼路径
    let Some(path) = name
        .as_deref()
        .and_then(|name| avatar::file_path(&state.account.avatars_dir, name))
    else {
        return fail(StatusCode::NOT_FOUND, "not_found", "没有头像");
    };
    let Ok(bytes) = tokio::fs::read(&path).await else {
        return fail(StatusCode::NOT_FOUND, "not_found", "没有头像");
    };
    let current = name.unwrap_or_default();
    // 地址里的版本和当前一致才允许长期缓存(换头像后地址会变);对不上说明是旧链接,只让浏览器短暂缓存
    let cache = if version == Some(current.as_str()) {
        "private, max-age=31536000, immutable"
    } else {
        "private, max-age=60"
    };
    let mut response = (StatusCode::OK, bytes).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    // 浏览器不要自作聪明地「嗅探」类型;即使文件被换成了别的东西,也不会被当成网页执行
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline"),
    );
    response
}

/// 一次最多查多少个人的头像(多人编辑的在线名单不会超过这个量级,再大只会是滥用)。
pub const MAX_AVATAR_LOOKUP: usize = 50;
/// 单个 id 的最长字节数;用户 id 是 `usr_` 加一段定长编码,远小于这个值。
const MAX_LOOKUP_ID_BYTES: usize = 64;

#[derive(Debug, Deserialize)]
pub struct AvatarsQuery {
    /// 逗号分隔的用户 id。
    #[serde(default)]
    pub ids: String,
}

/// `GET /api/v1/users/avatars?ids=a,b,c`:一次问清这些人有没有头像,返回 `{ id: 头像文件名 | null }`。
///
/// 多人编辑的在线名单只知道对方的 id。逐个去请求 `/users/{id}/avatar` 的话,没有头像的人每次都是一个 404,
/// 浏览器控制台被刷屏,也白白多了请求;先批量问一次,只给**有头像**的人发图片请求。
/// 权限和 [`get_avatar`] 一致:任何登录用户都能查任何人,所以这里不泄露更多信息;
/// 游客标识和不存在的用户同样答 `null`,不区分「没有这个人」和「这个人没有头像」。
pub async fn get_avatars(
    State(state): State<Arc<AppState>>,
    Query(query): Query<AvatarsQuery>,
    extensions: axum::http::Extensions,
) -> Response {
    if extensions.get::<Identity>().is_none() {
        return fail(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录");
    }
    let ids: Vec<&str> = query
        .ids
        .split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .collect();
    if ids.len() > MAX_AVATAR_LOOKUP {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            &format!("一次最多查 {MAX_AVATAR_LOOKUP} 个人的头像"),
        );
    }
    let mut avatars = serde_json::Map::new();
    for id in ids {
        if id.len() > MAX_LOOKUP_ID_BYTES || id.starts_with("guest:") {
            avatars.insert(id.to_owned(), serde_json::Value::Null);
            continue;
        }
        let name = match state.system.get_user(id).await {
            Ok(Some(user)) => user.avatar,
            Ok(None) => None,
            Err(err) => return api::error_response(err),
        };
        // 文件名只来自数据库,仍按 get_avatar 的规则校验格式,并确认文件真的在:
        // 只有读得出来才算「有头像」,否则前端照这个答案去取图,拿到的还是一个 404
        let present = match name
            .as_deref()
            .and_then(|name| avatar::file_path(&state.account.avatars_dir, name))
        {
            Some(path) => tokio::fs::metadata(&path).await.is_ok(),
            None => false,
        };
        avatars.insert(
            id.to_owned(),
            match (present, name) {
                (true, Some(name)) => serde_json::Value::String(name),
                _ => serde_json::Value::Null,
            },
        );
    }
    api::ok(json!({ "avatars": avatars }))
}

// ---------------------------------------------------------------- 更换邮箱
//
// 换邮箱是接管账号的常见路径(换成自己的邮箱,再用「找回密码」夺走账号),所以:
// ① 要当前密码;② 验证码发到**新**邮箱,证明新邮箱归请求者;③ **旧**邮箱收到通知;
// ④ 验证码绑定申请人——存取的键和哈希里都带用户 id,别人拿到同一个新邮箱的验证码也用不了;
// ⑤ 新邮箱已被占用时页面上的回答和没占用一样(防枚举),只是发的是「已被注册」提醒而不是验证码。

/// 验证码的存取键:`<用户 id>|<新邮箱>`。
fn change_key(user_id: &str, new_email: &str) -> String {
    format!("{user_id}|{new_email}")
}

/// `POST /api/v1/me/email-code` 的请求体。
#[derive(Debug, Deserialize)]
pub struct ChangeEmailCodeRequest {
    /// 要换成的新邮箱。
    pub new_email: String,
    /// 当前密码。
    pub password: String,
}

/// 校验当前密码(与改密码、注销共用 `pw:<用户>` 限速桶)。通过返回 `Ok`,否则是要直接回给客户端的响应。
#[allow(clippy::result_large_err)]
async fn confirm_password(state: &AppState, user: &User, password: &str) -> Result<(), Response> {
    let key = format!("pw:{}", user.id);
    let now = session::now_millis();
    if state.account.limiter.blocked(&key, now) {
        return Err(fail(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "密码输错次数过多,请稍后再试",
        ));
    }
    let stored = state.system.password_hash(&user.id).await.ok().flatten();
    if !stored
        .as_deref()
        .is_some_and(|hash| crate::auth::password::verify_password(password, hash))
    {
        state.account.limiter.record_failure(&key, now);
        return Err(fail(StatusCode::BAD_REQUEST, "invalid_input", "密码不正确"));
    }
    state.account.limiter.reset(&key);
    Ok(())
}

/// `POST /api/v1/me/email-code`:给新邮箱发验证码。
pub async fn change_email_code(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(body): Json<ChangeEmailCodeRequest>,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let config = state.account.config.get();
    if !crate::signup::mail_ready(&config) {
        return fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "unavailable",
            "邮箱功能暂未开放,请联系管理员",
        );
    }
    let new_email = match kb_core::account::normalize_email(&body.new_email) {
        Ok(email) => email,
        Err(err) => return api::error_response(err),
    };
    if user.email.as_deref() == Some(new_email.as_str()) {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "这已经是你现在的邮箱了",
        );
    }
    if let Err(response) = confirm_password(&state, &user, &body.password).await {
        return response;
    }
    let now = session::now_millis();
    // 按「被换上去的邮箱」再限一道:否则一堆账号可以轮流给同一个受害邮箱要验证码
    let target_key = format!("mailto:{new_email}");
    if state.account.limiter.blocked(&target_key, now) {
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "发送太频繁了,请稍后再试",
        );
    }
    state.account.limiter.record_failure(&target_key, now);
    // 全站每分钟发信上限
    match state.system.mails_since(now - 60_000).await {
        Ok(sent) if sent >= i64::from(config.mail.per_minute) => {
            return fail(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "发送太频繁了,请稍后再试",
            );
        }
        Ok(_) => {}
        Err(err) => return api::error_response(err),
    }
    let pepper = match crate::signup::pepper_of(state.system.as_ref()).await {
        Ok(pepper) => pepper,
        Err(err) => return api::error_response(err),
    };
    let key = change_key(&user.id, &new_email);
    let code = kb_core::account::generate_email_code();
    let hash =
        kb_core::account::hash_code(&pepper, EmailPurpose::ChangeEmail.as_str(), &key, &code);
    let ip = extensions
        .get::<crate::auth::ClientIp>()
        .map(|crate::auth::ClientIp(ip)| ip.clone());
    let outcome = state
        .system
        .issue_email_code(
            &key,
            EmailPurpose::ChangeEmail,
            &hash,
            ip.as_deref(),
            i64::from(crate::signup::CODE_TTL_MINUTES) * 60_000,
            kb_core::model::identity::CodeLimits::default(),
            now,
        )
        .await;
    match outcome {
        Ok(kb_core::model::identity::IssueOutcome::Issued { .. }) => {}
        Ok(kb_core::model::identity::IssueOutcome::TooSoon { wait_secs }) => {
            return fail(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                &format!("请 {wait_secs} 秒后再获取验证码"),
            );
        }
        Ok(_) => {
            return fail(
                StatusCode::TOO_MANY_REQUESTS,
                "rate_limited",
                "获取验证码太频繁了,请稍后再试",
            );
        }
        Err(err) => return api::error_response(err),
    }
    // 新邮箱已经是别人的账号:发「已被注册」提醒而不是验证码;页面上的回答完全一样
    let taken = matches!(
        state.system.find_user_by_login(&new_email).await,
        Ok(Some(_))
    );
    let mail = if taken {
        kb_mail::Mail::AlreadyRegistered
    } else {
        kb_mail::Mail::ChangeEmailCode {
            code,
            minutes: crate::signup::CODE_TTL_MINUTES,
        }
    };
    crate::signup::deliver(state.clone(), new_email, mail);
    api::ok(
        json!({ "sent": true, "wait_secs": 60, "ttl_minutes": crate::signup::CODE_TTL_MINUTES }),
    )
}

/// `POST /api/v1/me/email` 的请求体。
#[derive(Debug, Deserialize)]
pub struct ChangeEmailRequest {
    /// 新邮箱。
    pub new_email: String,
    /// 新邮箱收到的验证码。
    pub code: String,
}

/// `POST /api/v1/me/email`:验证码对了就换。旧邮箱收到通知。
pub async fn change_email(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(body): Json<ChangeEmailRequest>,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let new_email = match kb_core::account::normalize_email(&body.new_email) {
        Ok(email) => email,
        Err(err) => return api::error_response(err),
    };
    let code = body.code.trim();
    if !kb_core::account::looks_like_email_code(code) {
        return fail(
            StatusCode::BAD_REQUEST,
            "invalid_input",
            "验证码是 6 位数字",
        );
    }
    // 验证码试错也计数(同一个人每分钟 5 次)
    let guard_key = format!("emailcode:{}", user.id);
    let now = session::now_millis();
    if state.account.limiter.blocked(&guard_key, now) {
        return fail(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "尝试次数过多,请稍后再试",
        );
    }
    let pepper = match crate::signup::pepper_of(state.system.as_ref()).await {
        Ok(pepper) => pepper,
        Err(err) => return api::error_response(err),
    };
    let key = change_key(&user.id, &new_email);
    let candidate =
        kb_core::account::hash_code(&pepper, EmailPurpose::ChangeEmail.as_str(), &key, code);
    let verified = match state
        .system
        .verify_email_code(&key, EmailPurpose::ChangeEmail, &candidate, now)
        .await
    {
        Ok(kb_core::model::identity::VerifyOutcome::Verified { id }) => id,
        Ok(kb_core::model::identity::VerifyOutcome::Wrong { attempts_left }) => {
            state.account.limiter.record_failure(&guard_key, now);
            return fail(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                &format!("验证码不正确,还可以再试 {attempts_left} 次"),
            );
        }
        Ok(kb_core::model::identity::VerifyOutcome::Locked) => {
            return fail(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "验证码错误次数过多,请重新获取",
            );
        }
        Ok(_) => {
            state.account.limiter.record_failure(&guard_key, now);
            return fail(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "验证码已过期,或还没有获取",
            );
        }
        Err(err) => return api::error_response(err),
    };
    let old_email = user.email.clone();
    match state
        .system
        .update_user(
            &user.id,
            UserUpdate {
                email: Some(Some(new_email.clone())),
                // 刚用验证码证明了新邮箱归本人
                email_verified_at: Some(now),
                ..Default::default()
            },
        )
        .await
    {
        Ok(_) => {}
        // 验证码发出之后新邮箱被别人注册了:不换,验证码保持未消耗也没关系(会过期)
        Err(KbError::Exists(_)) => {
            return fail(
                StatusCode::CONFLICT,
                "exists",
                "这个邮箱已经被别的账号使用了",
            );
        }
        Err(err) => return api::error_response(err),
    }
    let _ = state.system.consume_email_code(&verified, now).await;
    state.account.limiter.reset(&guard_key);
    let _ = state
        .system
        .record_audit(
            Some(&user.id),
            "account.email_changed",
            None,
            &json!({ "from": old_email, "to": new_email }),
            None,
        )
        .await;
    // 通知旧邮箱:账号被盗时,这封信是原主人唯一能收到的信号
    if let Some(old) = old_email
        && crate::signup::mail_ready(&state.account.config.get())
    {
        crate::signup::deliver(
            state.clone(),
            old,
            kb_mail::Mail::EmailChanged {
                new_email: new_email.clone(),
            },
        );
    }
    api::ok(json!({ "email": new_email }))
}

// ---------------------------------------------------------------- 账号注销

/// 毫秒时间戳 → `2026-11-04 22:30 (UTC+8)`。
///
/// 用站点时区(`[site] timezone`,默认上海)并写明偏移:收件人可能不在服务器所在时区,
/// 只写“本地时间”会让人猜。
pub(crate) fn time_text(millis: i64) -> String {
    kb_core::timezone::format_at(millis)
}

/// `POST /api/v1/me/deletion` 的请求体。
#[derive(Debug, Deserialize)]
pub struct DeletionRequest {
    /// 当前密码。注销是不可逆的大事,会话被别人借走时不能凭它直接注销账号,所以要再输一次密码。
    pub password: String,
}

/// `POST /api/v1/me/deletion`:申请注销,进入冷静期(默认 7 天,期间可撤销)。
pub async fn request_deletion(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(body): Json<DeletionRequest>,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    // 和「改密码」「换邮箱」共用同一个限速桶:几个入口各留 5 次机会,就等于给攻击者翻倍
    if let Err(response) = confirm_password(&state, &user, &body.password).await {
        return response;
    }
    let now = session::now_millis();
    let cooling = state
        .account
        .config
        .get()
        .accounts
        .deletion_cooling_off_ms();
    match state
        .system
        .request_deletion_detailed(&user.id, now, cooling)
        .await
    {
        Ok((delete_after, newly_requested)) => {
            let _ = state
                .system
                .record_audit(
                    Some(&user.id),
                    "account.deletion_requested",
                    None,
                    &json!({ "delete_after": delete_after }),
                    None,
                )
                .await;
            // 通知本人邮箱:账号被盗时,原主人靠这封信才知道有人在注销他的账号。
            // 邮件没配好或发不出去不影响申请本身(deliver 在后台发,失败只记日志)
            if newly_requested
                && let Some(email) = user.email.clone()
                && crate::signup::mail_ready(&state.account.config.get())
            {
                crate::signup::deliver(
                    state.clone(),
                    email,
                    kb_mail::Mail::DeletionRequested {
                        when: time_text(delete_after),
                    },
                );
            }
            api::ok(json!({ "delete_after": delete_after }))
        }
        Err(err) => api::error_response(err),
    }
}

/// `DELETE /api/v1/me/deletion`:撤销注销申请。
pub async fn cancel_deletion(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    match state
        .system
        .cancel_deletion(&user.id, session::now_millis())
        .await
    {
        Ok(()) => {
            let _ = state
                .system
                .record_audit(
                    Some(&user.id),
                    "account.deletion_cancelled",
                    None,
                    &json!({}),
                    None,
                )
                .await;
            api::ok(json!({ "cancelled": true }))
        }
        Err(err) => api::error_response(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_names_are_trimmed_and_bounded() {
        assert_eq!(check_display_name("  林一  ").unwrap(), "林一");
        assert_eq!(check_display_name("Alice").unwrap(), "Alice");
        assert_eq!(
            check_display_name(&"字".repeat(30))
                .unwrap()
                .chars()
                .count(),
            30
        );
        assert!(check_display_name(&"字".repeat(31)).is_err());
    }

    #[test]
    fn names_that_could_impersonate_or_inject_are_refused() {
        for bad in [
            "",
            "   ",
            "a\nb",
            "a\tb",
            "<script>",
            "a>b",
            "x\u{0}y",
            // 从右到左覆盖:让「管理员」看起来像别的字
            "\u{202e}nimda",
            // 零宽字符:两个看起来一样的名字实际不同
            "ad\u{200b}min",
            "\u{feff}admin",
            "a\u{2066}b",
        ] {
            assert!(check_display_name(bad).is_err(), "{bad:?} 不该通过");
        }
        // 正常的多语言名字、emoji、中间的空格都可以
        for good in ["林 一", "Émile", "山田太郎", "Ana 🌸", "O'Brien", "a-b_c"] {
            assert!(check_display_name(good).is_ok(), "{good:?} 应该通过");
        }
    }

    #[test]
    fn time_text_uses_the_site_calendar_including_leap_rules() {
        // 期望值 = `date -u -d @<秒+8小时>`,即北京时间;不是自己算的
        for (secs, expected) in [
            (0, "1970-01-01 08:00 (UTC+8)"),
            (-86_400, "1969-12-31 08:00 (UTC+8)"),
            (951_782_400, "2000-02-29 08:00 (UTC+8)"), // 2000 是闰年
            (4_107_456_000, "2100-02-28 08:00 (UTC+8)"),
            (4_107_542_400, "2100-03-01 08:00 (UTC+8)"), // 2100 不是闰年:2 月 28 日的下一天是 3 月 1 日
            (1_709_251_199, "2024-03-01 07:59 (UTC+8)"),
            (1_709_251_200, "2024-03-01 08:00 (UTC+8)"),
            (1_792_000_000, "2026-10-15 01:46 (UTC+8)"),
            (1_793_804_711, "2026-11-04 23:05 (UTC+8)"),
            // 9998-12-31 23:59:59 UTC,加 8 小时后进入四位数年份的最后一天
            (253_370_764_799, "9999-01-01 07:59 (UTC+8)"),
        ] {
            assert_eq!(time_text(secs * 1000 + 999), expected, "秒数 {secs}");
        }
    }

    #[test]
    fn avatar_locks_are_per_user_and_do_not_grow_forever() {
        let locks = AvatarLocks::default();
        let a1 = locks.lock_for("usr_a");
        let a2 = locks.lock_for("usr_a");
        let b = locks.lock_for("usr_b");
        assert!(Arc::ptr_eq(&a1, &a2), "同一个人拿到同一把锁");
        assert!(!Arc::ptr_eq(&a1, &b), "不同的人互不阻塞");
        drop((a1, a2, b));
        // 没人持有时,下一次取锁会把旧条目清掉
        let _ = locks.lock_for("usr_c");
        assert!(locks.held.lock().unwrap().len() <= 1);
    }
}
