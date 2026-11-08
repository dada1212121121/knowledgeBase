//! 两步验证(TOTP)的守护进程级验收:真实进程、真实 HTTP、真实的验证码计算。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_totp`

#![cfg(feature = "testkit")]

mod support;

use std::time::{SystemTime, UNIX_EPOCH};

use kb_core::totp;
use serde_json::{Value, json};
use support::{Harness, http};

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// 这一刻的有效验证码。
fn code_now(secret_b32: &str) -> String {
    let secret = totp::secret_from_base32(secret_b32).expect("密钥");
    totp::code_at(&secret, totp::step_of(now()))
}

/// 下一步的码(时钟允许 ±1 步,所以现在就有效)。开启两步验证时已经用掉了「当前这一步」,
/// 之后要再来一个**有效且没用过**的码,就得用它。
fn code_next(secret_b32: &str) -> String {
    let secret = totp::secret_from_base32(secret_b32).expect("密钥");
    totp::code_at(&secret, totp::step_of(now()) + 1)
}

/// 前一步的码(时钟允许 ±1 步,所以也有效;用来在同一次测试里造出「另一个有效码」)。
fn code_previous(secret_b32: &str) -> String {
    let secret = totp::secret_from_base32(secret_b32).expect("密钥");
    totp::code_at(&secret, totp::step_of(now()) - 1)
}

fn api(
    h: &Harness,
    who: Option<&str>,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> (u16, Value) {
    let (status, _, body) = http(h.port(), method, path, who.map(|name| h.cookie(name)), body);
    (status, body)
}

/// 给某人开启两步验证,返回 (密钥, 恢复码)。
fn enable(h: &Harness, who: &str, password: &str) -> (String, Vec<String>) {
    let (status, setup) = api(
        h,
        Some(who),
        "POST",
        "/api/v1/auth/totp/setup",
        Some(json!({ "password": password })),
    );
    assert_eq!(status, 200, "{setup}");
    let secret = setup["data"]["secret"].as_str().unwrap().to_owned();
    assert!(
        setup["data"]["otpauth_uri"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://totp/")
    );
    let (status, done) = api(
        h,
        Some(who),
        "POST",
        "/api/v1/auth/totp/confirm",
        Some(json!({ "code": code_now(&secret) })),
    );
    assert_eq!(status, 200, "{done}");
    let codes: Vec<String> = done["data"]["recovery_codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(codes.len(), totp::RECOVERY_CODES);
    (secret, codes)
}

fn password_login(h: &Harness, name: &str, password: &str) -> (u16, String, Value) {
    http(
        h.port(),
        "POST",
        "/api/v1/auth/login",
        None,
        Some(json!({ "login": name, "password": password })),
    )
}

#[test]
fn setup_needs_the_password_and_a_correct_first_code_and_shows_recovery_codes_once() {
    let h = Harness::start();
    // 没登录:不行
    let (status, _) = api(
        &h,
        None,
        "POST",
        "/api/v1/auth/totp/setup",
        Some(json!({ "password": "x" })),
    );
    assert_eq!(status, 401);
    // 密码不对:不给密钥
    let (status, body) = api(
        &h,
        Some("alice"),
        "POST",
        "/api/v1/auth/totp/setup",
        Some(json!({ "password": "wrong password" })),
    );
    assert_eq!(status, 401, "{body}");
    assert!(body.to_string().contains("密码不正确") && body.get("data").is_none());
    // 密码对:拿到密钥,但还没开启
    let (status, setup) = api(
        &h,
        Some("alice"),
        "POST",
        "/api/v1/auth/totp/setup",
        Some(json!({ "password": "alice password 1" })),
    );
    assert_eq!(status, 200, "{setup}");
    let secret = setup["data"]["secret"].as_str().unwrap().to_owned();
    let (_, state) = api(&h, Some("alice"), "GET", "/api/v1/auth/totp", None);
    assert_eq!(state["data"]["enabled"], false);
    // 第一个码不对:不开启
    let (status, body) = api(
        &h,
        Some("alice"),
        "POST",
        "/api/v1/auth/totp/confirm",
        Some(json!({ "code": "000000" })),
    );
    assert_eq!(status, 401, "{body}");
    assert_eq!(
        password_login(&h, "alice", "alice password 1").2["data"]["logged_in"],
        true,
        "没确认之前登录不受影响"
    );
    // 码对:开启,拿到 8 个恢复码
    let (status, done) = api(
        &h,
        Some("alice"),
        "POST",
        "/api/v1/auth/totp/confirm",
        Some(json!({ "code": code_now(&secret) })),
    );
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["data"]["recovery_codes"].as_array().unwrap().len(), 8);
    let (_, state) = api(&h, Some("alice"), "GET", "/api/v1/auth/totp", None);
    assert_eq!(
        (
            state["data"]["enabled"].clone(),
            state["data"]["recovery_codes_left"].clone()
        ),
        (json!(true), json!(8))
    );
    assert!(!state.to_string().contains(&secret), "状态接口不回显密钥");
    // 已经开启:不能再「开始设置」(会换掉密钥)
    let (status, _) = api(
        &h,
        Some("alice"),
        "POST",
        "/api/v1/auth/totp/setup",
        Some(json!({ "password": "alice password 1" })),
    );
    assert_eq!(status, 409);
}

#[test]
fn login_with_two_steps_gives_no_session_until_a_valid_code_and_a_code_works_only_once() {
    let h = Harness::start();
    let (secret, _) = enable(&h, "alice", "alice password 1");
    // 密码对:只给挑战,没有会话 cookie
    let (status, headers, body) = password_login(&h, "alice", "alice password 1");
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["totp_required"], true);
    assert_eq!(body["data"]["logged_in"], false);
    assert!(
        !headers.to_ascii_lowercase().contains("set-cookie"),
        "还没验证,不能发会话:{headers}"
    );
    assert!(body["data"].get("user").is_none(), "{body}");
    let challenge = body["data"]["challenge"].as_str().unwrap().to_owned();
    // 错的码:拒绝;不存在的挑战:拒绝
    let (status, _, bad) = http(
        h.port(),
        "POST",
        "/api/v1/auth/login/totp",
        None,
        Some(json!({ "challenge": challenge, "code": "123456" })),
    );
    assert_eq!(status, 401, "{bad}");
    let (status, _, _) = http(
        h.port(),
        "POST",
        "/api/v1/auth/login/totp",
        None,
        Some(json!({ "challenge": "nope", "code": code_now(&secret) })),
    );
    assert_eq!(status, 401);
    // 对的码:换到会话(开启时用掉了当前这一步,所以用下一步的码)
    let (status, headers, ok) = http(
        h.port(),
        "POST",
        "/api/v1/auth/login/totp",
        None,
        Some(json!({ "challenge": challenge, "code": code_next(&secret) })),
    );
    assert_eq!(status, 200, "{ok}");
    assert_eq!(ok["data"]["logged_in"], true);
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("set-cookie: kb_session="),
        "{headers}"
    );
    // 挑战只能用一次
    let (status, _, _) = http(
        h.port(),
        "POST",
        "/api/v1/auth/login/totp",
        None,
        Some(json!({ "challenge": challenge, "code": code_previous(&secret) })),
    );
    assert_eq!(status, 401, "用过的挑战作废");
    // 同一个码(同一个时间步)再登录一次:被拒(防重放);换另一个步的码则可以
    let used = code_next(&secret);
    let (_, _, again) = password_login(&h, "alice", "alice password 1");
    let challenge = again["data"]["challenge"].as_str().unwrap().to_owned();
    let (status, _, body) = http(
        h.port(),
        "POST",
        "/api/v1/auth/login/totp",
        None,
        Some(json!({ "challenge": challenge, "code": used })),
    );
    assert_eq!(status, 401, "同一个验证码不能用两次:{body}");
    // 前一步的码不会比已经用掉的那一步更新,也不行
    let (status, _, _) = http(
        h.port(),
        "POST",
        "/api/v1/auth/login/totp",
        None,
        Some(json!({ "challenge": challenge, "code": code_previous(&secret) })),
    );
    assert_eq!(status, 401);
}

#[test]
fn a_challenge_survives_five_wrong_guesses_at_most_and_repeated_failures_lock_the_account() {
    let h = Harness::start();
    let (secret, _) = enable(&h, "alice", "alice password 1");
    let (_, _, body) = password_login(&h, "alice", "alice password 1");
    let challenge = body["data"]["challenge"].as_str().unwrap().to_owned();
    for i in 0..5 {
        let (status, _, body) = http(
            h.port(),
            "POST",
            "/api/v1/auth/login/totp",
            None,
            Some(json!({ "challenge": challenge, "code": format!("{i:06}") })),
        );
        assert_eq!(status, 401, "第 {i} 次:{body}");
    }
    // 第 6 次起:挑战作废,哪怕这回码是对的
    let (status, _, body) = http(
        h.port(),
        "POST",
        "/api/v1/auth/login/totp",
        None,
        Some(json!({ "challenge": challenge, "code": code_now(&secret) })),
    );
    assert_eq!(status, 401);
    assert!(body.to_string().contains("重新输入密码"), "{body}");
    // 账号级:15 分钟内累计失败太多,新挑战也被锁(用对的码也进不去),直到窗口过去
    let mut locked = false;
    for _ in 0..4 {
        let (_, _, body) = password_login(&h, "alice", "alice password 1");
        let fresh = body["data"]["challenge"].as_str().unwrap().to_owned();
        for i in 0..3 {
            let (status, _, _) = http(
                h.port(),
                "POST",
                "/api/v1/auth/login/totp",
                None,
                Some(json!({ "challenge": fresh, "code": format!("9{i:05}") })),
            );
            if status == 429 {
                locked = true;
            }
        }
    }
    assert!(locked, "连续失败后应被限速(429)");
    let (_, _, body) = password_login(&h, "alice", "alice password 1");
    let fresh = body["data"]["challenge"].as_str().unwrap().to_owned();
    let (status, _, _) = http(
        h.port(),
        "POST",
        "/api/v1/auth/login/totp",
        None,
        Some(json!({ "challenge": fresh, "code": code_now(&secret) })),
    );
    assert_eq!(status, 429, "锁定期间对的码也不行");
}

#[test]
fn recovery_codes_log_you_in_once_each_and_can_be_regenerated_with_the_password_and_a_code() {
    let h = Harness::start();
    let (secret, codes) = enable(&h, "alice", "alice password 1");
    let login_with = |code: &str| {
        let (_, _, body) = password_login(&h, "alice", "alice password 1");
        let challenge = body["data"]["challenge"].as_str().unwrap().to_owned();
        http(
            h.port(),
            "POST",
            "/api/v1/auth/login/totp",
            None,
            Some(json!({ "challenge": challenge, "code": code })),
        )
    };
    // 不分大小写、连字符随便:用户抄的时候常常不规整
    let (status, headers, body) = login_with(&codes[0].to_ascii_lowercase().replace('-', " "));
    assert_eq!(status, 200, "{body}");
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("set-cookie: kb_session=")
    );
    // 同一个恢复码第二次用不了
    let (status, _, _) = login_with(&codes[0]);
    assert_eq!(status, 401);
    let (_, state) = api(&h, Some("alice"), "GET", "/api/v1/auth/totp", None);
    assert_eq!(state["data"]["recovery_codes_left"], 7);
    // 重新生成:要密码 + 一次验证;旧的(包括没用过的)全部作废
    let (status, _) = api(
        &h,
        Some("alice"),
        "POST",
        "/api/v1/auth/totp/recovery",
        Some(json!({ "code": code_previous(&secret) })),
    );
    assert_eq!(status, 401, "不带密码不行");
    let (status, fresh) = api(
        &h,
        Some("alice"),
        "POST",
        "/api/v1/auth/totp/recovery",
        Some(json!({ "password": "alice password 1", "code": codes[1] })),
    );
    assert_eq!(status, 200, "{fresh}");
    let new_codes = fresh["data"]["recovery_codes"].as_array().unwrap();
    assert_eq!(new_codes.len(), 8);
    let (status, _, _) = login_with(&codes[2]);
    assert_eq!(status, 401, "旧恢复码作废");
    let (status, _, _) = login_with(new_codes[0].as_str().unwrap());
    assert_eq!(status, 200);
}

#[test]
fn turning_it_off_needs_the_password_and_a_code_and_the_admin_can_reset_a_lost_device() {
    let h = Harness::start();
    let (secret, _) = enable(&h, "alice", "alice password 1");
    // 关闭:缺密码 / 缺码 / 码错,都不行
    let (status, _) = api(
        &h,
        Some("alice"),
        "POST",
        "/api/v1/auth/totp/disable",
        Some(json!({ "code": code_now(&secret) })),
    );
    assert_eq!(status, 401);
    let (status, _) = api(
        &h,
        Some("alice"),
        "POST",
        "/api/v1/auth/totp/disable",
        Some(json!({ "password": "alice password 1", "code": "000000" })),
    );
    assert_eq!(status, 401);
    let (_, state) = api(&h, Some("alice"), "GET", "/api/v1/auth/totp", None);
    assert_eq!(state["data"]["enabled"], true);
    let (status, _) = api(
        &h,
        Some("alice"),
        "POST",
        "/api/v1/auth/totp/disable",
        Some(json!({ "password": "alice password 1", "code": code_next(&secret) })),
    );
    assert_eq!(status, 200);
    assert_eq!(
        password_login(&h, "alice", "alice password 1").2["data"]["logged_in"],
        true,
        "关了以后只用密码"
    );

    // bob 丢了手机:管理员重置;他自己和别的普通用户都不能替别人重置
    let (_bob_secret, _) = enable(&h, "bob", "bob password 1");
    let (status, _) = h.call(
        "alice",
        "user_totp_reset",
        json!({ "user_id": h.id("bob") }),
    );
    assert!(status == 403 || status == 404, "普通用户不能重置:{status}");
    let (_, _, locked_out) = password_login(&h, "bob", "bob password 1");
    assert_eq!(locked_out["data"]["totp_required"], true);
    let reset = h.ok(
        "admin",
        "user_totp_reset",
        json!({ "user_id": h.id("bob") }),
    );
    assert_eq!(reset["was_enabled"], true);
    // 他原来的登录失效了,密码登录不再要验证码
    let (status, _) = api(&h, Some("bob"), "GET", "/api/v1/auth/totp", None);
    assert_eq!(status, 401, "重置后他所有设备上的登录都作废");
    assert_eq!(
        password_login(&h, "bob", "bob password 1").2["data"]["logged_in"],
        true
    );
}

#[test]
fn when_the_site_requires_it_admins_without_two_steps_can_only_set_it_up() {
    let h = Harness::start();
    let config = h.daemon.home.path().join("config.toml");
    let original = std::fs::read_to_string(&config).unwrap();
    std::fs::write(
        &config,
        format!("{original}\n[accounts]\nrequire_admin_totp = true\n"),
    )
    .unwrap();
    // 热更新生效有一点延迟
    let mut blocked = false;
    for _ in 0..40 {
        let (status, body) = h.call("admin", "user_list", json!({}));
        if status == 403 && body.to_string().contains("totp_setup_required") {
            blocked = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    assert!(blocked, "要求开启后,没开两步验证的管理员被拦住");
    // 能做的只有设置两步验证本身和看自己是谁
    let (status, _) = api(&h, Some("admin"), "GET", "/api/v1/auth/me", None);
    assert_eq!(status, 200);
    let (status, body) = api(&h, Some("admin"), "GET", "/api/v1/auth/totp", None);
    assert_eq!(
        (status, body["data"]["required"].clone()),
        (200, json!(true))
    );
    let (secret, _) = enable(&h, "admin", "admin password 1");
    // 开启之后恢复正常;而且不能再关
    let (status, _) = h.call("admin", "user_list", json!({}));
    assert_eq!(status, 200);
    let (status, body) = api(
        &h,
        Some("admin"),
        "POST",
        "/api/v1/auth/totp/disable",
        Some(json!({ "password": "admin password 1", "code": code_previous(&secret) })),
    );
    assert_eq!(status, 403, "{body}");
    // 普通用户不受影响
    let (status, _) = h.call("alice", "list_collections", json!({}));
    assert_eq!(status, 200);
}
