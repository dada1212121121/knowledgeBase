//! 注册、邀请码、邮件设置的守护进程级验收(多用户设计说明)。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_registration`
//!
//! 起真实守护进程,通过管理接口配置真实 SMTP(本机 Mailpit,`127.0.0.1:1025`),
//! 然后像真人一样:陌生人要验证码 → 从邮箱里读出来 → 注册 → 登录。
//! 本机没有 Mailpit 时跳过(见 `scripts/dev-instance.sh`),不算失败。

#![cfg(feature = "testkit")]

mod support;

use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{Daemon, create_user, gray_png, http, http_bytes, read_tar_gz, uds};

const SMTP: &str = "127.0.0.1:1025";
const MAILPIT_WEB: u16 = 8025;
const SECRET_AUTH_CODE: &str = "AUTHCODE-must-never-leak-9d41";

fn mailpit_available() -> bool {
    let up = |addr: &str| {
        addr.parse::<SocketAddr>().ok().is_some_and(|addr| {
            TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
        })
    };
    up(SMTP) && up(&format!("127.0.0.1:{MAILPIT_WEB}"))
}

macro_rules! need_mailpit {
    () => {
        if !mailpit_available() {
            eprintln!("跳过:本机没有 Mailpit(127.0.0.1:1025 / 8025)");
            return;
        }
    };
}

/// 每个测试用不同的收件地址,免得和别的测试 / 开发实例留在 Mailpit 里的邮件混在一起。
fn unique(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("{prefix}-{}-{nanos}", std::process::id())
}

/// 从 Mailpit 里取发给 `to` 的最新一封邮件的正文。
fn mail_text_to(to: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let (_, _, found) = http(
            MAILPIT_WEB,
            "GET",
            &format!("/api/v1/search?query=to:{to}"),
            None,
            None,
        );
        if let Some(id) = found["messages"][0]["ID"].as_str() {
            let (_, _, message) = http(
                MAILPIT_WEB,
                "GET",
                &format!("/api/v1/message/{id}"),
                None,
                None,
            );
            return message["Text"].as_str().unwrap_or_default().to_owned();
        }
        assert!(Instant::now() < deadline, "等不到发给 {to} 的邮件");
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// 邮件正文里第一个恰好 6 位的数字串。
fn code_in(text: &str) -> String {
    let mut run = String::new();
    for ch in text.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() {
            run.push(ch);
        } else {
            if run.len() == 6 {
                return run;
            }
            run.clear();
        }
    }
    panic!("邮件里找不到验证码:{text}");
}

struct Site {
    daemon: Daemon,
    admin: String,
}

fn login(port: u16, who: &str, password: &str) -> (u16, String, Value) {
    let (status, headers, body) = http(
        port,
        "POST",
        "/api/v1/auth/login",
        None,
        Some(json!({ "login": who, "password": password })),
    );
    let cookie = headers
        .lines()
        .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
        .and_then(|line| line.split_once('='))
        .map(|(_, rest)| rest.split(';').next().unwrap_or("").to_owned())
        .unwrap_or_default();
    (status, cookie, body)
}

impl Site {
    fn start() -> Self {
        let home = tempfile::tempdir().expect("KB_HOME");
        std::fs::write(
            home.path().join("config.toml"),
            "[embed]\nbackend = \"fake\"\n[server]\nlisten = \"127.0.0.1:0\"\n[quota]\ndisk_reserve_gb = 0\n",
        )
        .expect("配置");
        let daemon = Daemon::start(home);
        let (status, body) = uds(
            &daemon,
            "POST",
            "/api/v1/auth/password",
            json!({ "password": "admin password 1" }),
        );
        assert_eq!(status, 200, "{body}");
        let port = daemon.tcp_port();
        let (status, admin, body) = login(port, "admin", "admin password 1");
        assert_eq!(status, 200, "{body}");
        Self { daemon, admin }
    }

    fn port(&self) -> u16 {
        self.daemon.tcp_port()
    }

    fn call(&self, session: &str, capability: &str, args: Value) -> (u16, Value) {
        let (status, _, body) = http(
            self.port(),
            "POST",
            &format!("/api/v1/capabilities/{capability}"),
            Some(session),
            Some(args),
        );
        match body.get("data") {
            Some(data) if body["ok"] == true => (status, data.clone()),
            _ => (status, body),
        }
    }

    fn admin(&self, capability: &str, args: Value) -> (u16, Value) {
        self.call(&self.admin, capability, args)
    }

    fn post_public(&self, path: &str, body: Value) -> (u16, String, Value) {
        http(self.port(), "POST", path, None, Some(body))
    }

    fn status(&self) -> Value {
        let (_, _, body) = http(self.port(), "GET", "/api/v1/auth/status", None, None);
        body["data"].clone()
    }

    fn patch_config(&self, patch: Value) {
        let (status, body) =
            self.admin("update_config", json!({ "patch": patch, "confirm": true }));
        assert_eq!(status, 200, "{body}");
    }

    /// 配好指向本机 Mailpit 的主发件账号(回环地址允许明文、无授权码)。
    fn configure_local_mail(&self) {
        self.patch_config(json!({ "mail": {
            "enabled": true,
            "primary": { "preset": "custom", "host": "127.0.0.1", "port": 1025,
                         "security": "none", "username": "noreply@kb.test" }
        }}));
    }

    /// 走完「要验证码 → 读邮件 → 注册」,返回 (状态码, 会话 cookie, 响应体)。
    fn sign_up(
        &self,
        email: &str,
        username: &str,
        password: &str,
        invite: Option<&str>,
    ) -> (u16, String, Value) {
        let (status, _, body) = self.post_public(
            "/api/v1/auth/email-code",
            json!({ "email": email, "purpose": "register" }),
        );
        assert_eq!(status, 200, "要验证码失败:{body}");
        let code = code_in(&mail_text_to(email));
        let mut form =
            json!({ "email": email, "code": code, "username": username, "password": password });
        if let Some(invite) = invite {
            form["invite"] = json!(invite);
        }
        let (status, headers, body) = self.post_public("/api/v1/auth/register", form);
        let cookie = headers
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
            .and_then(|line| line.split_once('='))
            .map(|(_, rest)| rest.split(';').next().unwrap_or("").to_owned())
            .unwrap_or_default();
        (status, cookie, body)
    }
}

#[test]
fn a_stranger_signs_up_with_an_emailed_code_after_the_admin_configures_mail() {
    need_mailpit!();
    let site = Site::start();

    // 还没配邮件:状态里如实说明,要验证码得到明确的「暂未开放」
    let status = site.status();
    assert_eq!(status["mail_ready"], false);
    assert_eq!(status["registration_open"], false);
    let (code, _, body) = site.post_public(
        "/api/v1/auth/email-code",
        json!({ "email": "early@kb.test", "purpose": "register" }),
    );
    assert_eq!(code, 503, "{body}");

    // 管理员配置邮件
    site.configure_local_mail();
    let (_, mail) = site.admin("mail_status", json!({}));
    assert_eq!(mail["ready"], true);
    assert_eq!(mail["primary"]["username"], "noreply@kb.test");
    assert_eq!(mail["primary"]["password_set"], false);
    assert!(
        mail["presets"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == "qq")
    );
    assert_eq!(site.status()["registration_open"], true);

    // 授权码只写不读:写进去后,任何接口、配置文件里都不会出现它;文件权限是 0600
    let (code, body) = site.admin(
        "mail_password",
        json!({ "slot": "primary", "password": SECRET_AUTH_CODE, "confirm": true }),
    );
    assert_eq!(code, 200, "{body}");
    assert_eq!(body["password_set"], true);
    let (_, mail) = site.admin("mail_status", json!({}));
    assert_eq!(mail["primary"]["password_set"], true);
    let (_, config) = site.admin("get_config", json!({}));
    for (name, text) in [
        ("mail_status", mail.to_string()),
        ("get_config", config.to_string()),
    ] {
        assert!(!text.contains(SECRET_AUTH_CODE), "{name} 泄露了授权码");
    }
    let home = site.daemon.home.path();
    let secrets = std::fs::read_to_string(home.join("secrets.toml")).expect("secrets.toml");
    assert!(secrets.contains(SECRET_AUTH_CODE));
    assert!(
        !std::fs::read_to_string(home.join("config.toml"))
            .unwrap()
            .contains(SECRET_AUTH_CODE)
    );
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(home.join("secrets.toml"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "secrets.toml 必须只有属主可读写");
    }
    // 含换行的授权码会被拒(防止写坏文件 / 注入)
    let (code, _) = site.admin(
        "mail_password",
        json!({ "slot": "primary", "password": "a\nb", "confirm": true }),
    );
    assert_eq!(code, 400);
    let (code, _) = site.admin(
        "mail_password",
        json!({ "slot": "third", "password": "x", "confirm": true }),
    );
    assert_eq!(code, 400);
    // 清除:Mailpit 不需要授权码,后面真的发信要用空授权码
    let (_, cleared) = site.admin(
        "mail_password",
        json!({ "slot": "primary", "password": "", "confirm": true }),
    );
    assert_eq!(cleared["password_set"], false);
    assert!(
        !std::fs::read_to_string(home.join("secrets.toml"))
            .unwrap_or_default()
            .contains(SECRET_AUTH_CODE)
    );

    // 测试发信:备用账号没配 → 明确说没配,不会假装成功,也不会偷偷用主账号
    let to = format!("{}@kb.test", unique("probe"));
    let (code, result) = site.admin("mail_test", json!({ "slot": "backup", "to": to }));
    assert_eq!(code, 200, "{result}");
    assert_eq!(result["ok"], false);
    assert!(
        result["error"].as_str().unwrap().contains("备用"),
        "{result}"
    );
    // 管理员自己没填邮箱又没指定收件人:要求填写
    let (code, _) = site.admin("mail_test", json!({ "slot": "primary" }));
    assert_eq!(code, 400);
    let (code, result) = site.admin("mail_test", json!({ "slot": "primary", "to": to }));
    assert_eq!((code, &result["ok"]), (200, &json!(true)), "{result}");
    assert!(
        mail_text_to(&to).contains("配置正确"),
        "收到的应是测试邮件(正文说明发件邮箱配置正确)"
    );
    let (_, log) = site.admin("mail_log", json!({ "limit": 5 }));
    assert!(
        log["log"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["to_addr"] == to.as_str() && row["ok"] == true && row["kind"] == "test"),
        "{log}"
    );

    // 陌生人注册
    let email = format!("{}@kb.test", unique("lin"));
    let (status, cookie, body) = site.sign_up(&email, "user_yi", "correct horse battery", None);
    assert_eq!(status, 200, "{body}");
    assert!(!cookie.is_empty(), "注册后应已登录");
    let (code, _, me) = http(site.port(), "GET", "/api/v1/auth/me", Some(&cookie), None);
    assert_eq!(code, 200, "{me}");
    assert_eq!(me["data"]["user"]["username"], "user_yi");
    // 新用户碰不到管理类能力,但有自己的知识库
    let (code, _) = site.call(&cookie, "mail_status", json!({}));
    assert_eq!(code, 403);
    let (code, body) = site.call(&cookie, "list_collections", json!({}));
    assert_eq!(code, 200, "{body}");
    // 同一个邮箱立刻再要验证码:被限频
    let (code, _, _) = site.post_public(
        "/api/v1/auth/email-code",
        json!({ "email": email, "purpose": "reset" }),
    );
    assert_eq!(code, 200, "不同用途各自计时");
    let (code, _, _) = site.post_public(
        "/api/v1/auth/email-code",
        json!({ "email": email, "purpose": "reset" }),
    );
    assert_eq!(code, 429);
    // 之后可用邮箱登录
    assert_eq!(login(site.port(), &email, "correct horse battery").0, 200);
}

#[test]
fn invites_gate_signup_and_carry_a_role_and_quota() {
    need_mailpit!();
    let site = Site::start();
    site.configure_local_mail();
    site.patch_config(json!({ "accounts": { "require_invite": true } }));
    assert_eq!(site.status()["require_invite"], true);

    // 一个授予 docs.notes 的自定义角色
    let (_, role) = site.admin(
        "role_create",
        json!({ "name": "高级用户", "features": ["docs.notes", "search.basic"] }),
    );
    let role_id = role["role"]["id"]
        .as_str()
        .or(role["id"].as_str())
        .expect("角色 id")
        .to_owned();

    // 创建:带角色、配额、有效期;列表里只有前缀没有明文
    let (code, created) = site.admin(
        "invite_create",
        json!({ "note": "内测第一批", "max_uses": 1, "expires_days": 7, "role_id": role_id, "quota": { "storage_gb": 3 } }),
    );
    assert_eq!(code, 200, "{created}");
    let invite = created["invites"][0]["code"]
        .as_str()
        .expect("明文")
        .to_owned();
    assert!(invite.starts_with("KB-"), "{invite}");
    let (_, list) = site.admin("invite_list", json!({}));
    assert!(
        !list.to_string().contains(&invite),
        "列表里不能有邀请码明文"
    );
    assert_eq!(list["invites"][0]["state"], "active");
    assert_eq!(
        list["invites"][0]["invite"]["prefix"],
        created["invites"][0]["invite"]["prefix"]
    );

    // 手滑写错的配额项、授予管理员角色、过期天数越界,都当场被拒
    for bad in [
        json!({ "quota": { "storage_gp": 3 } }),
        json!({ "quota": { "storage_gb": "3" } }),
        json!({ "role_id": "role_admin" }),
        json!({ "role_id": "role_nope" }),
        json!({ "expires_days": 0 }),
        json!({ "max_uses": 0 }),
        json!({ "count": 101 }),
    ] {
        let (code, body) = site.admin("invite_create", bad.clone());
        assert!(
            code == 400 || code == 403,
            "{bad} 应被拒,实际 {code}:{body}"
        );
    }

    // 不带邀请码、带错的码都注册不了
    let email = |name: &str| format!("{}@kb.test", unique(name));
    let (status, _, body) = site.post_public(
        "/api/v1/auth/email-code",
        json!({ "email": email("noinv"), "purpose": "register" }),
    );
    assert_eq!(status, 200, "{body}");
    let first = email("first");
    let (status, _, body) = site.post_public(
        "/api/v1/auth/email-code",
        json!({ "email": first, "purpose": "register" }),
    );
    assert_eq!(status, 200, "{body}");
    let code = code_in(&mail_text_to(&first));
    let form = |invite: Option<&str>| {
        let mut form = json!({ "email": first, "code": code, "username": "first_user", "password": "correct horse battery" });
        if let Some(invite) = invite {
            form["invite"] = json!(invite);
        }
        form
    };
    assert_eq!(site.post_public("/api/v1/auth/register", form(None)).0, 400);
    assert_eq!(
        site.post_public("/api/v1/auth/register", form(Some("KB-AAAA-BBBB")))
            .0,
        400
    );
    // 页面可以先问邀请码有没有效
    let (_, _, check) = site.post_public("/api/v1/auth/invite-check", json!({ "invite": invite }));
    assert_eq!(check["data"]["valid"], true);
    // 正确的码(随手小写也行)
    let (status, _, body) =
        site.post_public("/api/v1/auth/register", form(Some(&invite.to_lowercase())));
    assert_eq!(status, 200, "{body}");

    // 用掉了:状态、使用记录、用户的角色
    let (_, list) = site.admin("invite_list", json!({}));
    assert_eq!(list["invites"][0]["state"], "used_up");
    let invite_id = list["invites"][0]["invite"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (_, uses) = site.admin("invite_uses", json!({ "id": invite_id }));
    assert_eq!(uses["uses"][0]["username"], "first_user");
    let (_, users) = site.admin("user_list", json!({ "q": "first_user" }));
    let user = &users["users"][0];
    assert_eq!(user["role_id"], role_id.as_str(), "{users}");
    assert!(
        user["registered_via"]
            .as_str()
            .unwrap()
            .starts_with("invite:")
    );
    let (code, _, _) = site.post_public("/api/v1/auth/invite-check", json!({ "invite": invite }));
    assert_eq!(code, 200);
    let (_, _, again) = site.post_public("/api/v1/auth/invite-check", json!({ "invite": invite }));
    assert_eq!(again["data"]["valid"], false, "单次码用完后不再有效");

    // 撤销的码不能再用
    let (_, second) = site.admin("invite_create", json!({ "note": "作废" }));
    let (spare, spare_id) = (
        second["invites"][0]["code"].as_str().unwrap().to_owned(),
        second["invites"][0]["invite"]["id"]
            .as_str()
            .unwrap()
            .to_owned(),
    );
    let (code, _) = site.admin("invite_revoke", json!({ "id": spare_id }));
    assert_eq!(code, 200);
    let (code, _) = site.admin("invite_revoke", json!({ "id": spare_id }));
    assert_eq!(code, 404, "重复撤销提示不存在");
    let (_, _, check) = site.post_public("/api/v1/auth/invite-check", json!({ "invite": spare }));
    assert_eq!(check["data"]["valid"], false);
}

#[test]
fn only_the_right_features_can_touch_invites_and_mail() {
    need_mailpit!();
    let site = Site::start();
    site.configure_local_mail();
    create_user(site.daemon.home.path(), "alice", "alice password 1");
    let alice = login(site.port(), "alice", "alice password 1").1;

    // 普通用户:邀请码和邮件设置全部 403
    for (capability, args) in [
        ("invite_create", json!({})),
        ("invite_list", json!({})),
        ("invite_revoke", json!({ "id": "x" })),
        ("invite_uses", json!({ "id": "x" })),
        ("mail_status", json!({})),
        (
            "mail_password",
            json!({ "slot": "primary", "password": "x", "confirm": true }),
        ),
        ("mail_test", json!({ "slot": "primary", "to": "a@kb.test" })),
        ("mail_log", json!({})),
    ] {
        let (code, body) = site.call(&alice, capability, args);
        assert_eq!(code, 403, "{capability} 应拒绝普通用户:{body}");
    }

    // 只有「用户管理」没有「系统设置」的自定义角色:能管邀请码,碰不到邮件设置,也发不出管理员邀请码
    let (_, role) = site.admin(
        "role_create",
        json!({ "name": "用户管理员", "features": ["sys.users"], "dangerous": true }),
    );
    let role_id = role["role"]["id"]
        .as_str()
        .or(role["id"].as_str())
        .unwrap()
        .to_owned();
    let (code, body) = site.admin(
        "user_create",
        json!({ "username": "manager", "password": "manager password 1", "role_id": role_id }),
    );
    assert_eq!(code, 200, "{body}");
    let manager = login(site.port(), "manager", "manager password 1").1;
    let (code, body) = site.call(&manager, "invite_create", json!({ "max_uses": 2 }));
    assert_eq!(code, 200, "{body}");
    let (code, _) = site.call(&manager, "invite_list", json!({}));
    assert_eq!(code, 200);
    let (code, _) = site.call(
        &manager,
        "invite_create",
        json!({ "role_id": "role_admin" }),
    );
    assert_eq!(code, 403, "非管理员不能发出管理员邀请码");
    for (capability, args) in [
        ("mail_status", json!({})),
        (
            "mail_password",
            json!({ "slot": "primary", "password": "x", "confirm": true }),
        ),
        ("mail_test", json!({ "slot": "primary", "to": "a@kb.test" })),
        ("mail_log", json!({})),
    ] {
        let (code, body) = site.call(&manager, capability, args);
        assert_eq!(code, 403, "{capability} 需要系统设置功能:{body}");
    }
}

// ------------------------------------------------------------------ 头像

/// PNG 的宽高(IHDR 在固定偏移)。
fn png_size(bytes: &[u8]) -> (u32, u32) {
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "应是 PNG");
    (
        u32::from_be_bytes(bytes[16..20].try_into().unwrap()),
        u32::from_be_bytes(bytes[20..24].try_into().unwrap()),
    )
}

#[test]
fn a_user_uploads_an_avatar_through_the_real_daemon_and_others_can_see_it() {
    let site = Site::start();
    create_user(site.daemon.home.path(), "alice", "alice password 1");
    create_user(site.daemon.home.path(), "bob", "bob password 1");
    let alice = login(site.port(), "alice", "alice password 1").1;
    let bob = login(site.port(), "bob", "bob password 1").1;
    let alice_id = {
        let (_, _, me) = http(site.port(), "GET", "/api/v1/auth/me", Some(&alice), None);
        me["data"]["user"]["id"].as_str().unwrap().to_owned()
    };

    // 传一张 400×300 的图:服务器应处理成 256×256 的 PNG
    let (status, _, body) = http_bytes(
        site.port(),
        "PUT",
        "/api/v1/me/avatar",
        Some(&alice),
        "application/octet-stream",
        &gray_png(400, 300, 120),
    );
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let name = serde_json::from_slice::<Value>(&body).unwrap()["data"]["avatar"]
        .as_str()
        .unwrap()
        .to_owned();

    // 文件落在 KB_HOME/avatars 下(全站共有,不在 alice 自己的知识库目录里)
    let on_disk = site.daemon.home.path().join("avatars").join(&name);
    assert!(
        on_disk.is_file(),
        "头像应在 KB_HOME/avatars/ 下:{}",
        on_disk.display()
    );
    assert!(
        !site
            .daemon
            .home
            .path()
            .join("spaces")
            .join("avatars")
            .exists()
    );

    // bob 能读到 alice 的头像,是 256×256 的 PNG,带安全头
    let (status, head, bytes) = http_bytes(
        site.port(),
        "GET",
        &format!("/api/v1/users/{alice_id}/avatar?v={name}"),
        Some(&bob),
        "application/json",
        b"",
    );
    assert_eq!(status, 200);
    assert_eq!(png_size(&bytes), (256, 256));
    let head = head.to_ascii_lowercase();
    assert!(
        head.contains("content-type: image/png")
            && head.contains("x-content-type-options: nosniff"),
        "{head}"
    );
    // 没登录读不了
    let (status, ..) = http_bytes(
        site.port(),
        "GET",
        &format!("/api/v1/users/{alice_id}/avatar"),
        None,
        "application/json",
        b"",
    );
    assert_eq!(status, 401);

    // 传一个不是图片的东西:被拒,旧头像不受影响
    let (status, _, body) = http_bytes(
        site.port(),
        "PUT",
        "/api/v1/me/avatar",
        Some(&alice),
        "image/png",
        b"<svg onload=alert(1)></svg>",
    );
    assert_eq!(status, 400, "{}", String::from_utf8_lossy(&body));
    assert!(on_disk.is_file(), "被拒的上传不能动旧头像");

    // 换一张:旧文件被清掉,新文件名不同
    let (status, _, body) = http_bytes(
        site.port(),
        "PUT",
        "/api/v1/me/avatar",
        Some(&alice),
        "application/octet-stream",
        &gray_png(64, 64, 200),
    );
    assert_eq!(status, 200);
    let second = serde_json::from_slice::<Value>(&body).unwrap()["data"]["avatar"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(second, name);
    assert!(!on_disk.exists(), "旧头像文件应被删除");
    assert_eq!(
        std::fs::read_dir(site.daemon.home.path().join("avatars"))
            .unwrap()
            .count(),
        1
    );

    // 改昵称;auth/me 立刻是新名字
    let (status, _, body) = http(
        site.port(),
        "PATCH",
        "/api/v1/me/profile",
        Some(&alice),
        Some(json!({ "display_name": "林一" })),
    );
    assert_eq!(status, 200, "{body}");
    let (_, _, me) = http(site.port(), "GET", "/api/v1/auth/me", Some(&alice), None);
    assert_eq!(me["data"]["user"]["display_name"], "林一");
    assert_eq!(me["data"]["user"]["avatar"], second.as_str());

    // 删除头像 → 404、文件没了
    let (status, ..) = http_bytes(
        site.port(),
        "DELETE",
        "/api/v1/me/avatar",
        Some(&alice),
        "application/json",
        b"",
    );
    assert_eq!(status, 200);
    let (status, ..) = http_bytes(
        site.port(),
        "GET",
        &format!("/api/v1/users/{alice_id}/avatar"),
        Some(&bob),
        "application/json",
        b"",
    );
    assert_eq!(status, 404);
    assert_eq!(
        std::fs::read_dir(site.daemon.home.path().join("avatars"))
            .unwrap()
            .count(),
        0
    );
}

/// 轮询导出状态直到不再是 `running`;返回最终状态的 `data`。
fn wait_export(port: u16, cookie: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let (status, _, body) = http(port, "GET", "/api/v1/me/export", Some(cookie), None);
        assert_eq!(status, 200, "{body}");
        if body["data"]["state"] != "running" {
            return body["data"].clone();
        }
        assert!(Instant::now() < deadline, "导出 30 秒还没做完:{body}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn space_of(port: u16, cookie: &str) -> String {
    let (_, _, me) = http(port, "GET", "/api/v1/auth/me", Some(cookie), None);
    me["data"]["user"]["space_id"]
        .as_str()
        .expect("space_id")
        .to_owned()
}

fn download(port: u16, cookie: Option<&str>) -> (u16, Vec<u8>) {
    let (status, _, bytes) = http_bytes(
        port,
        "GET",
        "/api/v1/me/export/download",
        cookie,
        "application/json",
        b"",
    );
    (status, bytes)
}

fn has(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

#[test]
fn exporting_through_the_real_daemon_packs_my_notes_and_files_and_nothing_else() {
    let site = Site::start();
    let home = site.daemon.home.path().to_path_buf();
    // 数据根目录里的敏感东西:管理员的主知识库就是这个目录,导出不能顺着往上走
    std::fs::write(
        home.join("secrets.toml"),
        "[llm]\napi_key = \"sk-SENTINEL-9f3\"\n",
    )
    .unwrap();
    create_user(&home, "alice", "alice password 1");
    create_user(&home, "bob", "bob password 1");
    let alice = login(site.port(), "alice", "alice password 1").1;
    let bob = login(site.port(), "bob", "bob password 1").1;

    // alice:一条应用里写的笔记(只在 meta.db 里)+ 上传目录里的一个文件 + 两个不该被带走的东西
    let (status, _, created) = http(
        site.port(),
        "POST",
        "/api/v1/capabilities/create_item",
        Some(&alice),
        Some(json!({
            "collection": "_global",
            "title": "导出测试笔记",
            "body": "笔记正文 ALICE-NOTE-BODY",
            "kind": "note",
            "tags": ["t1"],
        })),
    );
    assert_eq!(status, 200, "{created}");
    let note_id = created["data"]["id"].as_str().expect("笔记 id").to_owned();
    let sources = home
        .join("spaces")
        .join(space_of(site.port(), &alice))
        .join("sources");
    std::fs::create_dir_all(sources.join(".quarantine")).unwrap();
    std::fs::write(sources.join("mine.txt"), "ALICE-FILE-BODY").unwrap();
    std::fs::write(sources.join(".quarantine/evil.exe"), "QUARANTINED").unwrap();
    std::os::unix::fs::symlink(home.join("secrets.toml"), sources.join("link-to-secrets")).unwrap();

    // 别人什么都没导出过:下载是 404,没登录是 401
    assert_eq!(download(site.port(), Some(&bob)).0, 404);
    assert_eq!(download(site.port(), None).0, 401);

    let (status, _, started) = http(site.port(), "POST", "/api/v1/me/export", Some(&alice), None);
    assert_eq!(status, 200, "{started}");
    let done = wait_export(site.port(), &alice);
    assert_eq!(done["state"], "ready", "{done}");
    assert_eq!(
        (done["files"].as_u64(), done["notes"].as_u64()),
        (Some(1), Some(1)),
        "{done}"
    );
    assert!(
        done["skipped"].to_string().contains("符号链接"),
        "符号链接要告诉用户没带:{done}"
    );

    let (status, archive) = download(site.port(), Some(&alice));
    assert_eq!(status, 200);
    let members = read_tar_gz(&archive);
    let names: Vec<&str> = members.iter().map(|(name, _)| name.as_str()).collect();
    let note_name = format!("notes/_global/导出测试笔记-{}.md", &note_id[..8]);
    assert_eq!(
        names,
        ["manifest.json", note_name.as_str(), "sources/mine.txt"],
        "归档里只有说明、本人笔记、本人文件"
    );
    let everything: Vec<u8> = members.iter().flat_map(|(_, body)| body.clone()).collect();
    assert!(has(&members[1].1, "ALICE-NOTE-BODY") && has(&members[1].1, "title: \"导出测试笔记\""));
    assert!(has(&members[2].1, "ALICE-FILE-BODY"));
    for forbidden in ["sk-SENTINEL-9f3", "QUARANTINED", "[server]", "argon2"] {
        assert!(!has(&everything, forbidden), "归档里不该有 {forbidden}");
    }

    // 管理员(主知识库 = 数据根目录)导出:同样只有 notes / sources,没有配置、密钥、账号库,也没有 alice 的任何东西
    std::fs::create_dir_all(home.join("sources")).unwrap();
    std::fs::write(home.join("sources/admin.txt"), "ADMIN-FILE-BODY").unwrap();
    let (status, ..) = http(
        site.port(),
        "POST",
        "/api/v1/me/export",
        Some(&site.admin),
        None,
    );
    assert_eq!(status, 200);
    let done = wait_export(site.port(), &site.admin);
    assert_eq!(done["state"], "ready", "{done}");
    let (status, archive) = download(site.port(), Some(&site.admin));
    assert_eq!(status, 200);
    let members = read_tar_gz(&archive);
    for (name, _) in &members {
        assert!(
            name == "manifest.json" || name.starts_with("notes/") || name.starts_with("sources/"),
            "管理员的导出里出现了不该有的成员:{name}"
        );
    }
    let everything: Vec<u8> = members.iter().flat_map(|(_, body)| body.clone()).collect();
    assert!(has(&everything, "ADMIN-FILE-BODY"));
    for forbidden in [
        "sk-SENTINEL-9f3",
        "ALICE-NOTE-BODY",
        "ALICE-FILE-BODY",
        "alice@",
        "argon2",
        "[server]",
    ] {
        assert!(
            !has(&everything, forbidden),
            "管理员的归档里不该有 {forbidden}"
        );
    }

    // bob 下载不到别人的:他的下载仍是 404
    assert_eq!(download(site.port(), Some(&bob)).0, 404);
    // 删除之后下载也是 404
    let (status, ..) = http(
        site.port(),
        "DELETE",
        "/api/v1/me/export",
        Some(&alice),
        None,
    );
    assert_eq!(status, 200);
    assert_eq!(download(site.port(), Some(&alice)).0, 404);
}
