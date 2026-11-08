//! 两步验证(TOTP)接口(多用户设计说明)。
//!
//! - 设置:`setup`(重新输密码,拿到密钥和二维码内容)→ `confirm`(输对第一个码才算开启,同时拿到恢复码);
//! - 登录:密码对了以后如果开了两步验证,**不发会话**,只发一个 5 分钟有效的挑战;
//!   `login_totp` 带着挑战和验证码(或恢复码)来换会话;
//! - 防护:验证码一个时间步只能用一次(原子占用);每个挑战最多试 5 次;每个账号 15 分钟内最多失败 8 次;
//!   关闭、重新生成恢复码都要重新输密码并通过一次验证。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};

use kb_core::account::User;
use kb_core::model::Millis;
use kb_core::token;
use kb_core::totp;
use serde::Deserialize;
use serde_json::json;

use super::{ClientIp, Identity, password, session};
use crate::api::{self, AppState};

/// 挑战有效期。
const CHALLENGE_TTL_MS: Millis = 5 * 60_000;
/// 一个挑战最多试几次。
const CHALLENGE_MAX_ATTEMPTS: u32 = 5;
/// 账号级失败统计的窗口与上限。
const FAILURE_WINDOW_MS: Millis = 15 * 60_000;
const MAX_FAILURES: usize = 8;

struct Challenge {
    user_id: String,
    expires: Millis,
    attempts: u32,
}

fn challenges() -> &'static Mutex<HashMap<String, Challenge>> {
    static TABLE: OnceLock<Mutex<HashMap<String, Challenge>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn failures() -> &'static Mutex<HashMap<String, VecDeque<Millis>>> {
    static TABLE: OnceLock<Mutex<HashMap<String, VecDeque<Millis>>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 先占一个名额再验证:检查「还没到上限」和「记一次尝试」在同一把锁里完成。
///
/// 如果像以前那样先查再验证、验证失败后才记账,两个并发请求会同时通过检查,
/// 攻击者开多个挑战并发试码,就能在窗口内试出远超上限的次数。
/// 返回 `false` 表示已经被锁住(没有占名额)。验证通过后调用 [`release_attempt`] 把这次占用退掉,
/// 验证失败(或中途出错)就让它留着——占用本身就是这次失败的记录。
fn reserve_attempt(user_id: &str, now: Millis) -> bool {
    let mut table = failures().lock().unwrap_or_else(|p| p.into_inner());
    // 顺手清掉过期的账号,表不会一直涨
    table.retain(|_, queue| queue.back().is_some_and(|at| now - at <= FAILURE_WINDOW_MS));
    let queue = table.entry(user_id.to_owned()).or_default();
    while queue.front().is_some_and(|at| now - at > FAILURE_WINDOW_MS) {
        queue.pop_front();
    }
    if queue.len() >= MAX_FAILURES {
        return false;
    }
    queue.push_back(now);
    true
}

/// 验证通过:退回刚才占的那个名额。只退这一个,不清别的——不然攻击者的失败记录会被
/// 本人一次成功的登录抹掉,又得到一轮新的尝试机会。
fn release_attempt(user_id: &str, now: Millis) {
    let mut table = failures().lock().unwrap_or_else(|p| p.into_inner());
    if let Some(queue) = table.get_mut(user_id)
        && let Some(at) = queue.iter().rposition(|at| *at == now)
    {
        queue.remove(at);
    }
}

/// 密码对了、该账号开着两步验证:发一个挑战(只存哈希),前端拿它去换会话。
pub(crate) fn issue_challenge(user_id: &str, now: Millis) -> String {
    let raw = token::random_secret();
    let mut table = challenges().lock().unwrap_or_else(|p| p.into_inner());
    table.retain(|_, challenge| challenge.expires > now);
    table.insert(
        token::sha256_hex(&raw),
        Challenge {
            user_id: user_id.to_owned(),
            expires: now + CHALLENGE_TTL_MS,
            attempts: 0,
        },
    );
    raw
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

fn too_many() -> Response {
    fail(
        StatusCode::TOO_MANY_REQUESTS,
        "rate_limited",
        // 恢复码走的是同一个限速器(check_second_factor 一开始就占名额),所以这里不能建议「换恢复码」
        "验证码输错次数过多,请 15 分钟后再试",
    )
}

fn now_secs(now: Millis) -> u64 {
    (now / 1000).max(0) as u64
}

/// 恢复码在库里的形式:加盐(pepper)的 sha256,库泄露也还原不出可用的码。
async fn recovery_hash(state: &AppState, normalized: &str) -> kb_core::Result<String> {
    let pepper = crate::signup::pepper_of(state.system.as_ref()).await?;
    Ok(token::sha256_hex(&format!(
        "{pepper}|recovery|{normalized}"
    )))
}

/// 校验第二因素(6 位码或恢复码)。通过返回 `Ok()`;不通过返回现成的响应,调用方直接返回。
#[allow(clippy::result_large_err)]
async fn check_second_factor(
    state: &AppState,
    user: &User,
    input: &str,
    now: Millis,
) -> Result<(), Response> {
    if !reserve_attempt(&user.id, now) {
        return Err(too_many());
    }
    let Some(stored) = state
        .system
        .totp_state(&user.id)
        .await
        .map_err(api::error_response)?
    else {
        return Err(bad("没有开启两步验证"));
    };
    let mut ok = false;
    if totp::looks_like_recovery_code(input) {
        if let Some(normalized) = totp::normalize_recovery_code(input) {
            let hash = recovery_hash(state, &normalized)
                .await
                .map_err(api::error_response)?;
            ok = state
                .system
                .use_recovery_code(&user.id, &hash, now)
                .await
                .map_err(api::error_response)?;
            if ok {
                let _ = state
                    .system
                    .record_audit(Some(&user.id), "totp.recovery_used", None, &json!({}), None)
                    .await;
            }
        }
    } else if let Some(secret) = totp::secret_from_base32(&stored.secret_b32)
        && let Some(step) = totp::verify(&secret, input, now_secs(now), stored.last_step)
    {
        // 原子占用这一步:两个并发请求拿同一个码,只有一个成功
        ok = state
            .system
            .claim_totp_step(&user.id, step)
            .await
            .map_err(api::error_response)?;
    }
    if ok {
        release_attempt(&user.id, now);
        Ok(())
    } else {
        let _ = state
            .system
            .record_audit(Some(&user.id), "totp.failed", None, &json!({}), None)
            .await;
        Err(fail(
            StatusCode::UNAUTHORIZED,
            "bad_code",
            "验证码不正确或已经用过",
        ))
    }
}

/// 当前登录的用户(必须是浏览器会话)。
#[allow(clippy::result_large_err)]
fn session_user(identity: Option<&Identity>) -> Result<Arc<User>, Response> {
    let Some(identity) = identity else {
        return Err(fail(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录"));
    };
    if !identity.acts_as_account() {
        return Err(fail(
            StatusCode::FORBIDDEN,
            "forbidden",
            "只有在浏览器里登录后才能设置两步验证",
        ));
    }
    identity
        .user
        .clone()
        .ok_or_else(|| fail(StatusCode::FORBIDDEN, "forbidden", "没有可设置的账号"))
}

/// 重新输入密码(设置 / 关闭这类敏感操作前)。用和改密码同一套限速。
#[allow(clippy::result_large_err)]
async fn reauthenticate(
    state: &AppState,
    user: &User,
    password_input: &str,
    now: Millis,
) -> Result<(), Response> {
    let key = format!("pw:{}", user.id);
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
        .is_some_and(|hash| password::verify_password(password_input, hash))
    {
        state.account.limiter.record_failure(&key, now);
        return Err(fail(StatusCode::UNAUTHORIZED, "bad_password", "密码不正确"));
    }
    state.account.limiter.reset(&key);
    Ok(())
}

/// `GET /api/v1/auth/totp`:当前状态。
pub async fn status(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let enabled = state.system.totp_enabled(&user.id).await.unwrap_or(false);
    let left = state
        .system
        .recovery_codes_left(&user.id)
        .await
        .unwrap_or(0);
    let config = state.account.config.get();
    api::ok(json!({
        "enabled": enabled,
        "recovery_codes_left": if enabled { left } else { 0 },
        "required": config.accounts.require_admin_totp && is_admin_like(extensions.get::<Identity>()),
    }))
}

/// 管理级账号(能管用户的):站点要求强制两步验证时,他们必须开。
pub(crate) fn is_admin_like(identity: Option<&Identity>) -> bool {
    identity.is_some_and(|identity| identity.principal.features.allows("sys.users"))
}

/// `POST /api/v1/auth/totp/setup` 的请求体。
#[derive(Debug, Deserialize)]
pub struct SetupRequest {
    /// 当前密码。
    pub password: String,
}

/// `POST /api/v1/auth/totp/setup`:重新输密码,生成密钥(待确认)。
pub async fn setup(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(body): Json<SetupRequest>,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let now = session::now_millis();
    if let Err(response) = reauthenticate(&state, &user, &body.password, now).await {
        return response;
    }
    let secret = totp::generate_secret();
    let secret_b32 = totp::secret_to_base32(&secret);
    if let Err(err) = state.system.begin_totp(&user.id, &secret_b32, now).await {
        return api::error_response(err);
    }
    let config = state.account.config.get();
    let account = user.email.clone().unwrap_or_else(|| user.username.clone());
    api::ok(json!({
        "secret": secret_b32,
        "otpauth_uri": totp::otpauth_uri(&config.site.name, &account, &secret),
        "issuer": config.site.name,
    }))
}

/// 带验证码的请求体。
#[derive(Debug, Deserialize)]
pub struct CodeRequest {
    /// 6 位验证码(或恢复码)。
    pub code: String,
    /// 当前密码(关闭 / 重新生成恢复码时要)。
    #[serde(default)]
    pub password: Option<String>,
}

/// `POST /api/v1/auth/totp/confirm`:输对第一个码,正式开启,拿到恢复码(只显示这一次)。
pub async fn confirm(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(body): Json<CodeRequest>,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let now = session::now_millis();
    let stored = match state.system.totp_state(&user.id).await {
        Ok(Some(stored)) if !stored.confirmed => stored,
        Ok(_) => return bad("没有待确认的设置,请先点「开启两步验证」"),
        Err(err) => return api::error_response(err),
    };
    let Some(secret) = totp::secret_from_base32(&stored.secret_b32) else {
        return api::error_response(kb_core::KbError::Internal("两步验证密钥损坏".to_owned()));
    };
    // 验证之前先占名额(原子):失败的尝试就留在记录里,通过了再退回
    if !reserve_attempt(&user.id, now) {
        return too_many();
    }
    let Some(step) = totp::verify(&secret, &body.code, now_secs(now), None) else {
        return fail(
            StatusCode::UNAUTHORIZED,
            "bad_code",
            "验证码不正确,请检查手机时间是否准确",
        );
    };
    let codes = totp::generate_recovery_codes();
    let mut hashes = Vec::with_capacity(codes.len());
    for code in &codes {
        let Some(normalized) = totp::normalize_recovery_code(code) else {
            continue;
        };
        match recovery_hash(&state, &normalized).await {
            Ok(hash) => hashes.push(hash),
            Err(err) => return api::error_response(err),
        }
    }
    if let Err(err) = state
        .system
        .confirm_totp(&user.id, step, &hashes, now)
        .await
    {
        return api::error_response(err);
    }
    release_attempt(&user.id, now);
    let _ = state
        .system
        .record_audit(Some(&user.id), "totp.enabled", None, &json!({}), None)
        .await;
    api::ok(json!({ "enabled": true, "recovery_codes": codes }))
}

/// `POST /api/v1/auth/totp/disable`:密码 + 一次验证(或恢复码)才能关。
pub async fn disable(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(body): Json<CodeRequest>,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let config = state.account.config.get();
    if config.accounts.require_admin_totp && is_admin_like(extensions.get::<Identity>()) {
        return fail(
            StatusCode::FORBIDDEN,
            "totp_required",
            "站点要求管理员必须开启两步验证,不能关闭",
        );
    }
    let now = session::now_millis();
    if let Err(response) =
        reauthenticate(&state, &user, body.password.as_deref().unwrap_or(""), now).await
    {
        return response;
    }
    if let Err(response) = check_second_factor(&state, &user, &body.code, now).await {
        return response;
    }
    if let Err(err) = state.system.disable_totp(&user.id).await {
        return api::error_response(err);
    }
    let _ = state
        .system
        .record_audit(Some(&user.id), "totp.disabled", None, &json!({}), None)
        .await;
    api::ok(json!({ "enabled": false }))
}

/// `POST /api/v1/auth/totp/recovery`:密码 + 一次验证,换一批新的恢复码(旧的全部作废)。
pub async fn regenerate_recovery(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(body): Json<CodeRequest>,
) -> Response {
    let user = match session_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let now = session::now_millis();
    if let Err(response) =
        reauthenticate(&state, &user, body.password.as_deref().unwrap_or(""), now).await
    {
        return response;
    }
    if let Err(response) = check_second_factor(&state, &user, &body.code, now).await {
        return response;
    }
    let codes = totp::generate_recovery_codes();
    let mut hashes = Vec::with_capacity(codes.len());
    for code in &codes {
        let Some(normalized) = totp::normalize_recovery_code(code) else {
            continue;
        };
        match recovery_hash(&state, &normalized).await {
            Ok(hash) => hashes.push(hash),
            Err(err) => return api::error_response(err),
        }
    }
    if let Err(err) = state.system.replace_recovery_codes(&user.id, &hashes).await {
        return api::error_response(err);
    }
    let _ = state
        .system
        .record_audit(
            Some(&user.id),
            "totp.recovery_regenerated",
            None,
            &json!({}),
            None,
        )
        .await;
    api::ok(json!({ "recovery_codes": codes }))
}

/// `POST /api/v1/auth/login/totp` 的请求体。
#[derive(Debug, Deserialize)]
pub struct LoginTotpRequest {
    /// 密码那一步发的挑战。
    pub challenge: String,
    /// 6 位验证码或恢复码。
    pub code: String,
}

/// `POST /api/v1/auth/login/totp`:拿挑战 + 验证码换会话。
pub async fn login_totp(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    Json(body): Json<LoginTotpRequest>,
) -> Response {
    let now = session::now_millis();
    let ip = extensions
        .get::<ClientIp>()
        .map(|ClientIp(ip)| ip.clone())
        .unwrap_or_else(|| "unknown".to_owned());
    let key = token::sha256_hex(&body.challenge);
    // 取出挑战并先记一次尝试;超过次数、过期都作废(得重新输密码)
    let user_id = {
        let mut table = challenges().lock().unwrap_or_else(|p| p.into_inner());
        let Some(challenge) = table.get_mut(&key) else {
            return fail(
                StatusCode::UNAUTHORIZED,
                "challenge_expired",
                "登录已超时,请重新输入密码",
            );
        };
        if challenge.expires <= now {
            table.remove(&key);
            return fail(
                StatusCode::UNAUTHORIZED,
                "challenge_expired",
                "登录已超时,请重新输入密码",
            );
        }
        challenge.attempts += 1;
        let user_id = challenge.user_id.clone();
        if challenge.attempts > CHALLENGE_MAX_ATTEMPTS {
            table.remove(&key);
            return fail(
                StatusCode::UNAUTHORIZED,
                "challenge_expired",
                "尝试次数过多,请重新输入密码",
            );
        }
        user_id
    };
    let user = match state.system.get_user(&user_id).await {
        Ok(Some(user)) if user.status.can_sign_in() => user,
        Ok(_) => {
            return fail(
                StatusCode::FORBIDDEN,
                "forbidden",
                "账号已停用,请联系管理员",
            );
        }
        Err(err) => return api::error_response(err),
    };
    if let Err(response) = check_second_factor(&state, &user, &body.code, now).await {
        return response;
    }
    challenges()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(&key);
    super::complete_login(&state, &headers, &user, &ip, now).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 失败表是整个进程共用的全局状态,而 `reserve_attempt` 每次都会按**调用者传入的 `now`** 清掉整张表里
    /// 已过期的账号。生产里所有请求共用同一个墙钟,这样清理没问题;但这几个测试各用各的合成时间,
    /// 「窗口过期」那个把时间拨到 15 分钟之后,会在「并发占名额」那个测试的 64 个线程还在抢的时候
    /// 把它的记录清空,多放进来几个(整套并行跑时约每 5 次失败 1 次)。
    /// 所以碰这张表的测试串行执行,并在开头清空表,不让彼此的合成时间互相干扰。
    fn exclusive_table() -> std::sync::MutexGuard<'static, ()> {
        static SERIAL: Mutex<()> = Mutex::new(());
        let guard = SERIAL.lock().unwrap_or_else(|p| p.into_inner());
        failures().lock().unwrap_or_else(|p| p.into_inner()).clear();
        guard
    }

    #[test]
    fn challenges_are_single_user_and_expire() {
        let raw = issue_challenge("usr_a", 1_000);
        let table = challenges().lock().unwrap();
        let entry = table.get(&token::sha256_hex(&raw)).expect("存了哈希");
        assert_eq!(entry.user_id, "usr_a");
        assert_eq!(entry.expires, 1_000 + CHALLENGE_TTL_MS);
        assert!(!table.contains_key(&raw), "表里不存明文");
    }

    #[test]
    fn attempts_are_reserved_atomically_so_concurrent_guessing_cannot_exceed_the_limit() {
        // 以前是「先查是否锁住、验证失败后才记一次失败」两步,并发的请求会一起通过检查。
        // 现在占名额和检查在同一把锁里:不管多少线程同时来,成功占到的恰好是上限那么多个。
        let _table = exclusive_table();
        let user = "usr_reserve_race";
        let now = 7_000_000;
        let granted = std::sync::atomic::AtomicUsize::new(0);
        // 线程是一个一个起的,临界区又很短,不加栅栏的话前一个线程早就做完了,根本没有交错,
        // 「先查再记」这种非原子写法也能蒙混过关(变异检查实测过)。栅栏让 64 个线程同时放行。
        let start = std::sync::Barrier::new(64);
        std::thread::scope(|scope| {
            for _ in 0..64 {
                scope.spawn(|| {
                    start.wait();
                    if reserve_attempt(user, now) {
                        granted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(
            granted.load(std::sync::atomic::Ordering::SeqCst),
            MAX_FAILURES
        );
        assert!(!reserve_attempt(user, now + 1), "满了就是满了");
    }

    #[test]
    fn a_window_that_has_passed_unlocks_and_a_success_gives_back_only_its_own_slot() {
        let _table = exclusive_table();
        let user = "usr_window_test";
        let t0 = 9_000_000;
        for i in 0..MAX_FAILURES {
            assert!(reserve_attempt(user, t0 + i as i64), "第 {i} 次应放行");
        }
        assert!(
            !reserve_attempt(user, t0 + 100),
            "第 {MAX_FAILURES} 次之后锁住"
        );
        assert!(
            reserve_attempt(user, t0 + FAILURE_WINDOW_MS + 100),
            "窗口过了自动解开"
        );
        // 成功只退自己占的那一个名额,不抹掉别人(攻击者)留下的失败记录
        let other = "usr_release_test";
        let t1 = 20_000_000;
        for i in 0..(MAX_FAILURES - 1) {
            assert!(reserve_attempt(other, t1 + i as i64));
        }
        assert!(reserve_attempt(other, t1 + 500), "最后一个名额");
        release_attempt(other, t1 + 500);
        assert!(reserve_attempt(other, t1 + 501), "退回的名额又能用了");
        assert!(!reserve_attempt(other, t1 + 502), "但之前的失败记录还在");
    }
}
