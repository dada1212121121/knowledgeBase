//! 邮箱注册、找回密码、改密码、邀请码、防枚举、限速(多用户设计说明)。
//! 发信走内存发信箱,测试从「已发出的邮件」里把验证码读出来,和真实用户的流程一致。

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode, header};
use kb_core::account::{ROLE_ADMIN, hash_code};
use kb_core::config::{Config, ConfigStore, MailAccount};
use kb_mail::{Mailer, MemoryTransport, Outgoing};
use kb_meta::system::NewInvite;
use kb_web::AppState;
use kb_web::signup::AccountDeps;
use kb_web::source::SocketKind;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Site {
    state: Arc<AppState>,
    config: Arc<ConfigStore>,
    sent: kb_mail::SentLog,
    failing: Arc<std::sync::Mutex<Vec<String>>>,
}

fn mail_config() -> Config {
    let mut config = Config::default();
    config.mail.enabled = true;
    config.mail.primary = MailAccount {
        host: "smtp.example.com".into(),
        username: "noreply@example.com".into(),
        ..MailAccount::default()
    };
    config
}

async fn site_with(config: Config) -> Site {
    let dir = tempfile::tempdir().expect("目录").keep();
    let meta = Arc::new(kb_meta::SqliteMetaStore::open(dir.join("meta.db")).expect("meta"));
    let config = Arc::new(ConfigStore::new(config));
    let transport = MemoryTransport::default();
    let (sent, failing) = (transport.sent.clone(), transport.failing.clone());
    let state = Arc::new(AppState {
        invoker: Arc::new(kb_capability::Invoker::new(
            Arc::new(kb_capability::Registry::new()),
            meta.clone(),
        )),
        started: std::time::Instant::now(),
        version: "test",
        mcp: None,
        events: None,
        meta,
        system: Arc::new(kb_meta::SystemStore::open(dir.join("system.db")).expect("账号库")),
        principals: kb_web::auth::PrincipalCache::default(),
        account: AccountDeps {
            config: config.clone(),
            mailer: Arc::new(Mailer::new(Box::new(transport))),
            passwords: Arc::new(kb_mail::Passwords::default),
            limiter: Arc::new(kb_web::auth::ratelimit::LoginLimiter::new()),
            avatars_dir: dir.join("avatars"),
            home: dir.clone(),
            exports: Arc::new(kb_web::export_api::NoExport),
        },
        ai_enabled: Arc::new(kb_core::features::AiState::on),
        login_limiter: kb_web::auth::ratelimit::LoginLimiter::new(),
        hub: Arc::new(kb_web::EventHub::new()),
        uploads: None,
        agent_grants: Arc::new(kb_web::AgentGrants::new()),
        collab: None,
        office: None,
    });
    Site {
        state,
        config,
        sent,
        failing,
    }
}

async fn site() -> Site {
    site_with(mail_config()).await
}

impl Site {
    /// 发一个公开 POST(带 CSRF 头),可指定对端地址与转发头。
    async fn post(&self, path: &str, body: Value) -> (StatusCode, Value, axum::http::HeaderMap) {
        self.post_from(path, body, "127.0.0.1:4000", &[]).await
    }

    async fn post_from(
        &self,
        path: &str,
        body: Value,
        peer: &str,
        extra: &[(&str, &str)],
    ) -> (StatusCode, Value, axum::http::HeaderMap) {
        let mut builder = Request::builder()
            .method("POST")
            .uri(path)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::HOST, "kb.test")
            .header("x-kb-csrf", "1");
        for (name, value) in extra {
            builder = builder.header(*name, *value);
        }
        let mut request = builder.body(Body::from(body.to_string())).expect("请求");
        request
            .extensions_mut()
            .insert(ConnectInfo(peer.parse::<SocketAddr>().expect("地址")));
        self.send(request).await
    }

    async fn send(&self, request: Request<Body>) -> (StatusCode, Value, axum::http::HeaderMap) {
        let app = kb_web::build(self.state.clone(), SocketKind::Tcp);
        let response = app.oneshot(request).await.expect("响应");
        let (status, headers) = (response.status(), response.headers().clone());
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("体");
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
            headers,
        )
    }

    async fn get_with_session(&self, path: &str, session: &str) -> (StatusCode, Value) {
        let request = Request::builder()
            .uri(path)
            .header(header::COOKIE, format!("kb_session={session}"))
            .body(Body::empty())
            .expect("请求");
        let (status, body, _) = self.send(request).await;
        (status, body)
    }

    /// 等发信任务跑完(发信放在后台),返回第 `n` 封邮件。
    async fn mail(&self, n: usize) -> Outgoing {
        for _ in 0..100 {
            if let Some((_, mail)) = self.sent.lock().unwrap().get(n).cloned() {
                return mail;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!(
            "等不到第 {n} 封邮件;已发 {} 封",
            self.sent.lock().unwrap().len()
        );
    }

    /// 不该有邮件:等一小会儿确认没有。
    async fn assert_no_mail_beyond(&self, n: usize) {
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(self.sent.lock().unwrap().len(), n, "不该多发邮件");
    }

    /// 取验证码并读出来。
    async fn request_code(&self, email: &str, purpose: &str) -> String {
        let before = self.sent.lock().unwrap().len();
        let (status, body, _) = self
            .post(
                "/api/v1/auth/email-code",
                json!({ "email": email, "purpose": purpose }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        code_in(&self.mail(before).await.body)
    }

    async fn register(
        &self,
        email: &str,
        code: &str,
        username: &str,
        password: &str,
        invite: Option<&str>,
    ) -> (StatusCode, Value, axum::http::HeaderMap) {
        let mut body =
            json!({ "email": email, "code": code, "username": username, "password": password });
        if let Some(invite) = invite {
            body["invite"] = json!(invite);
        }
        self.post("/api/v1/auth/register", body).await
    }

    async fn pepper(&self) -> String {
        self.state
            .system
            .get_or_create_secret("pepper", Box::new(kb_core::token::random_secret))
            .await
            .expect("pepper")
    }

    /// 建一个由某个用户创建的邀请码(带不带「自动加好友」),返回明文。
    async fn invite_by(&self, inviter_id: &str, auto_friend: bool) -> String {
        let code = kb_core::account::generate_invite_code();
        self.state
            .system
            .create_invite(NewInvite {
                code_hash: hash_code(&self.pepper().await, "invite", "", &code),
                prefix: kb_core::account::invite_prefix(&code),
                created_by: Some(inviter_id.to_owned()),
                note: String::new(),
                max_uses: 5,
                expires_at: None,
                role_id: None,
                quota_json: "{}".to_owned(),
                auto_friend,
            })
            .await
            .expect("建邀请码");
        code
    }

    /// 建一个邀请码,返回明文。
    async fn invite(&self, max_uses: i64, role: Option<&str>, quota: &str) -> String {
        let code = kb_core::account::generate_invite_code();
        self.state
            .system
            .create_invite(NewInvite {
                code_hash: hash_code(&self.pepper().await, "invite", "", &code),
                prefix: kb_core::account::invite_prefix(&code),
                created_by: None,
                note: String::new(),
                max_uses,
                expires_at: None,
                role_id: role.map(str::to_owned),
                quota_json: quota.to_owned(),
                auto_friend: true,
            })
            .await
            .expect("建邀请码");
        code
    }
}

/// 邮件正文里第一个恰好 6 位的数字串。
fn find_code(body: &str) -> Option<String> {
    let mut run = String::new();
    for ch in body.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit() {
            run.push(ch);
        } else {
            if run.len() == 6 {
                return Some(run);
            }
            run.clear();
        }
    }
    None
}

fn has_code(body: &str) -> bool {
    find_code(body).is_some()
}

fn code_in(body: &str) -> String {
    find_code(body).unwrap_or_else(|| panic!("邮件里找不到 6 位验证码:{body}"))
}

fn session_of(headers: &axum::http::HeaderMap) -> String {
    headers
        .get(header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|raw| {
            raw.split_once('=')
                .and_then(|(_, rest)| rest.split(';').next())
        })
        .expect("应设置会话 cookie")
        .to_owned()
}

const GOOD_PASSWORD: &str = "correct horse battery";

#[tokio::test]
async fn registering_with_an_emailed_code_creates_an_account_and_logs_in() {
    let site = site().await;
    let code = site.request_code("User@Example.com", "register").await;
    let (status, body, headers) = site
        .register("user@example.com", &code, "user_yi", GOOD_PASSWORD, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["username"], "user_yi");
    let cookie = headers.get(header::SET_COOKIE).unwrap().to_str().unwrap();
    assert!(
        cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"),
        "{cookie}"
    );

    // 注册完已经登录:/auth/me 看到自己,有默认角色的功能,没有系统功能
    let (status, me) = site
        .get_with_session("/api/v1/auth/me", &session_of(&headers))
        .await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["data"]["user"]["username"], "user_yi");
    let features: Vec<String> =
        serde_json::from_value(me["data"]["user"]["features"].clone()).unwrap();
    assert!(
        features.contains(&"docs.notes".to_owned())
            && !features.iter().any(|f| f.starts_with("sys.")),
        "{features:?}"
    );
    // 邮箱算已验证,有自己的知识库
    let user = site
        .state
        .system
        .find_user_by_login("user@example.com")
        .await
        .unwrap()
        .expect("用户");
    assert!(user.email_verified_at.is_some());
    assert!(
        site.state
            .system
            .personal_space(&user.id)
            .await
            .unwrap()
            .is_some()
    );
    // 之后用用户名或邮箱 + 密码都能登录
    for login in ["user_yi", "user@example.com"] {
        let (status, body, _) = site
            .post(
                "/api/v1/auth/login",
                json!({ "login": login, "password": GOOD_PASSWORD }),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{login}:{body}");
    }
    // 验证码用过即失效:同一个码不能再注册第二个账号
    let (status, _, _) = site
        .register(
            "user@example.com",
            &code,
            "another_one",
            GOOD_PASSWORD,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn mail_that_is_not_configured_closes_registration_with_a_clear_message() {
    let site = site_with(Config::default()).await;
    let (status, body, _) = site
        .post(
            "/api/v1/auth/email-code",
            json!({ "email": "a@b.com", "purpose": "register" }),
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("暂未开放"),
        "{body}"
    );
    let (status, _, _) = site
        .register("a@b.com", "123456", "abc_def", GOOD_PASSWORD, None)
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    // status 如实告诉前端:注册不开放、邮件没配好
    let (_, status_body, _) = site
        .send(
            Request::builder()
                .uri("/api/v1/auth/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(status_body["data"]["registration_open"], false);
    assert_eq!(status_body["data"]["mail_ready"], false);

    // 开了但没填发件账号,同样算没配好
    let mut half = Config::default();
    half.mail.enabled = true;
    let site = site_with(half).await;
    let (status, ..) = site
        .post(
            "/api/v1/auth/email-code",
            json!({ "email": "a@b.com", "purpose": "register" }),
        )
        .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn the_code_page_reply_does_not_reveal_whether_an_email_is_registered() {
    let site = site().await;
    // 先有一个已注册的人。直接建,不走验证码流程,免得撞上「60 秒内只能要一次」
    site.state
        .system
        .create_user(kb_core::account::NewUser {
            username: "taken_one".into(),
            email: Some("taken@qq.com".into()),
            display_name: None,
            password_hash: "$argon2id$x".into(),
            role_id: kb_core::account::ROLE_USER.into(),
            status: kb_core::account::UserStatus::Active,
            registered_via: "test".into(),
            must_change_password: false,
            email_verified: true,
        })
        .await
        .unwrap();
    let sent_before = site.sent.lock().unwrap().len();

    // 对「已注册」和「没注册」的邮箱要注册验证码:状态码、JSON 一字不差
    let (s1, b1, _) = site
        .post_from(
            "/api/v1/auth/email-code",
            json!({ "email": "taken@qq.com", "purpose": "register" }),
            "127.0.0.1:1",
            &[("cf-connecting-ip", "203.0.113.1")],
        )
        .await;
    let (s2, b2, _) = site
        .post_from(
            "/api/v1/auth/email-code",
            json!({ "email": "fresh@qq.com", "purpose": "register" }),
            "127.0.0.1:1",
            &[("cf-connecting-ip", "203.0.113.2")],
        )
        .await;
    assert_eq!((s1, &b1["data"]), (s2, &b2["data"]), "页面上的回答必须一样");
    assert_eq!(s1, StatusCode::OK);

    // 邮件不一样:已注册的收到的是提醒(没有验证码),新邮箱收到的是验证码
    let existing = site.mail(sent_before).await;
    let fresh = site.mail(sent_before + 1).await;
    let (to_taken, to_fresh) = if existing.to == "taken@qq.com" {
        (existing, fresh)
    } else {
        (fresh, existing)
    };
    assert!(
        !has_code(&to_taken.body),
        "提醒邮件里不能带验证码:{}",
        to_taken.body
    );
    assert!(has_code(&to_fresh.body), "{}", to_fresh.body);

    // 找回密码:没注册的邮箱同样得到「已发送」,但什么都不发
    let sent = site.sent.lock().unwrap().len();
    let (s3, b3, _) = site
        .post_from(
            "/api/v1/auth/email-code",
            json!({ "email": "ghost@qq.com", "purpose": "reset" }),
            "127.0.0.1:1",
            &[("cf-connecting-ip", "203.0.113.3")],
        )
        .await;
    assert_eq!((s3, &b3["data"]), (s1, &b1["data"]));
    site.assert_no_mail_beyond(sent).await;
}

#[tokio::test]
async fn codes_are_rate_limited_and_the_limit_is_per_email_not_global() {
    let site = site().await;
    let ask = |email: &'static str, ip: &'static str| {
        let site = &site;
        async move {
            site.post_from(
                "/api/v1/auth/email-code",
                json!({ "email": email, "purpose": "register" }),
                "127.0.0.1:1",
                &[("cf-connecting-ip", ip)],
            )
            .await
        }
    };
    assert_eq!(ask("a@qq.com", "198.51.100.1").await.0, StatusCode::OK);
    let (status, body, headers) = ask("a@qq.com", "198.51.100.1").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(
        headers.get(header::RETRY_AFTER).is_some(),
        "要告诉客户端多久后重试"
    );
    assert!(
        body["error"]["message"].as_str().unwrap().contains("秒后"),
        "{body}"
    );
    // 别的邮箱、别的人不受影响
    assert_eq!(ask("b@qq.com", "198.51.100.2").await.0, StatusCode::OK);
}

#[tokio::test]
async fn five_wrong_codes_burn_the_code_even_for_the_right_answer() {
    let site = site().await;
    let code = site.request_code("guess@qq.com", "register").await;
    let wrong = if code == "000000" { "111111" } else { "000000" };
    let mut last = Value::Null;
    for n in 0..5 {
        // 每次换个来源 IP,专门测验证码自身的次数上限(而不是按 IP 的限速)
        let ip = format!("198.51.100.{}", 10 + n);
        let (status, body, _) = site
            .post_from(
                "/api/v1/auth/register",
                json!({ "email": "guess@qq.com", "code": wrong, "username": "guesser_x", "password": GOOD_PASSWORD }),
                "127.0.0.1:1",
                &[("cf-connecting-ip", ip.as_str())],
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        last = body;
    }
    assert!(
        last["error"]["message"]
            .as_str()
            .unwrap()
            .contains("重新获取"),
        "第 5 次错误后应提示重新获取:{last}"
    );
    let (status, body, _) = site
        .post_from(
            "/api/v1/auth/register",
            json!({ "email": "guess@qq.com", "code": code, "username": "guesser_x", "password": GOOD_PASSWORD }),
            "127.0.0.1:1",
            &[("cf-connecting-ip", "198.51.100.99")],
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "作废的码连正确答案也不行:{body}"
    );
    assert!(
        site.state
            .system
            .find_user_by_login("guess@qq.com")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn an_invalid_form_does_not_burn_the_code_so_the_user_can_fix_and_retry() {
    let site = site().await;
    let code = site.request_code("retry@qq.com", "register").await;
    // 弱密码、用户名不合法:被拒,但验证码还能用
    assert_eq!(
        site.register("retry@qq.com", &code, "retry_me", "12345678", None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        site.register("retry@qq.com", &code, "x", GOOD_PASSWORD, None)
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    // 用户名已被占
    site.state
        .system
        .create_user(kb_core::account::NewUser {
            username: "taken_name".into(),
            email: None,
            display_name: None,
            password_hash: "$argon2id$x".into(),
            role_id: kb_core::account::ROLE_USER.into(),
            status: kb_core::account::UserStatus::Active,
            registered_via: "test".into(),
            must_change_password: false,
            email_verified: false,
        })
        .await
        .unwrap();
    assert_eq!(
        site.register("retry@qq.com", &code, "taken_name", GOOD_PASSWORD, None)
            .await
            .0,
        StatusCode::CONFLICT
    );
    // 改好之后,同一个验证码成功
    let (status, body, _) = site
        .register("retry@qq.com", &code, "retry_me", GOOD_PASSWORD, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn disposable_and_non_allowlisted_domains_are_refused() {
    let site = site().await;
    let (status, body, _) = site
        .post(
            "/api/v1/auth/email-code",
            json!({ "email": "x@mailinator.com", "purpose": "register" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("一次性")
    );

    let mut config = mail_config();
    config.accounts.email_domain_allowlist = vec!["qq.com".into(), "163.com".into()];
    let site = site_with(config).await;
    assert_eq!(
        site.post(
            "/api/v1/auth/email-code",
            json!({ "email": "a@gmail.com", "purpose": "register" })
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        site.post(
            "/api/v1/auth/email-code",
            json!({ "email": "a@163.com", "purpose": "register" })
        )
        .await
        .0,
        StatusCode::OK
    );
    // 找回密码不受域名限制(老用户的邮箱不能因为后来收紧了白名单就找不回密码)
    assert_eq!(
        site.post(
            "/api/v1/auth/email-code",
            json!({ "email": "old@gmail.com", "purpose": "reset" })
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn closed_registration_refuses_new_accounts_but_not_password_reset() {
    let mut config = mail_config();
    config.accounts.registration_open = false;
    let site = site_with(config).await;
    let (status, body, _) = site
        .post(
            "/api/v1/auth/email-code",
            json!({ "email": "a@qq.com", "purpose": "register" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        site.register("a@qq.com", "123456", "abc_def", GOOD_PASSWORD, None)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        site.post(
            "/api/v1/auth/email-code",
            json!({ "email": "a@qq.com", "purpose": "reset" })
        )
        .await
        .0,
        StatusCode::OK
    );
}

#[tokio::test]
async fn when_an_invite_is_required_it_must_be_valid_and_is_consumed_once() {
    let mut config = mail_config();
    config.accounts.require_invite = true;
    let site = site_with(config).await;
    let invite = site.invite(1, None, "{}").await;

    let code = site.request_code("one@qq.com", "register").await;
    // 没填 / 填错
    let (status, body, _) = site
        .register("one@qq.com", &code, "user_one", GOOD_PASSWORD, None)
        .await;
    assert_eq!(
        (status, body["error"]["message"].as_str().unwrap()),
        (StatusCode::BAD_REQUEST, "注册需要邀请码")
    );
    let (status, body, _) = site
        .register(
            "one@qq.com",
            &code,
            "user_one",
            GOOD_PASSWORD,
            Some("KB-AAAA-BBBB"),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, ..) = site
        .register(
            "one@qq.com",
            &code,
            "user_one",
            GOOD_PASSWORD,
            Some("garbage"),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    // 正确的码,用户随手写成小写、少了横线也认
    let sloppy = invite.to_lowercase().replace('-', " ");
    let (status, body, _) = site
        .register(
            "one@qq.com",
            &code,
            "user_one",
            GOOD_PASSWORD,
            Some(&sloppy),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // 单次码被用掉了:第二个人用同一个码被拒,并且他的验证码没被消耗
    let code2 = site.request_code("two@qq.com", "register").await;
    let (status, body, _) = site
        .register(
            "two@qq.com",
            &code2,
            "user_two",
            GOOD_PASSWORD,
            Some(&invite),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(
        site.state
            .system
            .find_user_by_login("two@qq.com")
            .await
            .unwrap()
            .is_none()
    );
    // 使用记录
    let invites = site.state.system.list_invites(None).await.unwrap();
    assert_eq!(invites[0].used, 1);
    assert_eq!(
        site.state
            .system
            .invite_uses(&invites[0].id)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn an_invite_sets_the_new_users_role_and_quota() {
    let site = site().await;
    let role = site
        .state
        .system
        .create_role(
            "高级用户",
            "",
            vec!["docs.notes".into(), "search.basic".into()],
            false,
        )
        .await
        .unwrap();
    let invite = site.invite(5, Some(&role.id), r#"{"storage_gb": 7}"#).await;
    let code = site.request_code("vip@qq.com", "register").await;
    let (status, body, _) = site
        .register(
            "vip@qq.com",
            &code,
            "vip_user",
            GOOD_PASSWORD,
            Some(&invite),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let user = site
        .state
        .system
        .find_user_by_login("vip_user")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(user.role_id, role.id, "邀请码指定的角色");
    assert!(user.registered_via.starts_with("invite:"));
    let quota = site
        .state
        .system
        .effective_quota(&user.id, &Config::default().quota)
        .await
        .unwrap();
    assert_eq!(quota.storage_gb, 7, "邀请码带的配额覆盖");
    // 这个人的功能就是角色勾选的那两个
    let features = site
        .state
        .system
        .effective_features(&user.id, true.into())
        .await
        .unwrap()
        .effective();
    assert_eq!(features, ["docs.notes", "search.basic"]);
}

#[tokio::test]
async fn nobody_can_register_their_way_into_an_admin_role() {
    // 管理员把默认角色手滑配成了 role_admin,或者邀请码指向管理员角色:注册也只会得到普通用户
    let mut config = mail_config();
    config.accounts.default_role = ROLE_ADMIN.into();
    let site = site_with(config).await;
    let code = site.request_code("sneaky@qq.com", "register").await;
    assert_eq!(
        site.register("sneaky@qq.com", &code, "sneaky_one", GOOD_PASSWORD, None)
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        site.state
            .system
            .find_user_by_login("sneaky_one")
            .await
            .unwrap()
            .unwrap()
            .role_id,
        kb_core::account::ROLE_USER
    );

    let invite = site.invite(1, Some(ROLE_ADMIN), "{}").await;
    let code = site.request_code("sneaky2@qq.com", "register").await;
    assert_eq!(
        site.register(
            "sneaky2@qq.com",
            &code,
            "sneaky_two",
            GOOD_PASSWORD,
            Some(&invite)
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        site.state
            .system
            .find_user_by_login("sneaky_two")
            .await
            .unwrap()
            .unwrap()
            .role_id,
        kb_core::account::ROLE_USER
    );
}

#[tokio::test]
async fn invite_check_tells_the_page_whether_a_code_is_good_without_using_it() {
    let site = site().await;
    let invite = site.invite(1, None, "{}").await;
    let (_, body, _) = site
        .post("/api/v1/auth/invite-check", json!({ "invite": invite }))
        .await;
    assert_eq!(body["data"]["valid"], true);
    // 检查不占用次数:查几次都还有效
    let (_, again, _) = site
        .post(
            "/api/v1/auth/invite-check",
            json!({ "invite": invite.to_lowercase() }),
        )
        .await;
    assert_eq!(again["data"]["valid"], true);
    let (_, bad, _) = site
        .post(
            "/api/v1/auth/invite-check",
            json!({ "invite": "KB-AAAA-BBBB" }),
        )
        .await;
    assert_eq!(bad["data"]["valid"], false);
    // 猜邀请码也会被限速:同一个来源连续猜 5 次后被挡
    for n in 0..5 {
        site.post_from(
            "/api/v1/auth/invite-check",
            json!({ "invite": format!("KB-AAAA-BB{n}B") }),
            "127.0.0.1:1",
            &[("cf-connecting-ip", "198.51.100.77")],
        )
        .await;
    }
    let (status, ..) = site
        .post_from(
            "/api/v1/auth/invite-check",
            json!({ "invite": invite }),
            "127.0.0.1:1",
            &[("cf-connecting-ip", "198.51.100.77")],
        )
        .await;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "批量探测邀请码要被限速"
    );
}

#[tokio::test]
async fn resetting_a_password_with_an_emailed_code_signs_out_every_device() {
    let site = site().await;
    let code = site.request_code("forgot@qq.com", "register").await;
    let (_, _, headers) = site
        .register("forgot@qq.com", &code, "forgot_me", GOOD_PASSWORD, None)
        .await;
    let old_session = session_of(&headers);
    assert_eq!(
        site.get_with_session("/api/v1/auth/me", &old_session)
            .await
            .0,
        StatusCode::OK
    );

    // 注册用的验证码不能拿去重设密码;要新取一个 reset 的
    let reset_code = site.request_code("forgot@qq.com", "reset").await;
    let (status, body, _) = site
        .post(
            "/api/v1/auth/password/reset",
            json!({ "email": "forgot@qq.com", "code": code, "new_password": "brand new password" }),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "注册的码不能用于找回密码:{body}"
    );
    let (status, body, _) = site
        .post(
            "/api/v1/auth/password/reset",
            json!({ "email": "forgot@qq.com", "code": reset_code, "new_password": "12345678" }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "弱密码被拒:{body}");
    let (status, body, _) = site
        .post("/api/v1/auth/password/reset", json!({ "email": "forgot@qq.com", "code": reset_code, "new_password": "brand new password" }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    assert_eq!(
        site.get_with_session("/api/v1/auth/me", &old_session)
            .await
            .0,
        StatusCode::UNAUTHORIZED,
        "旧会话全部失效"
    );
    assert_eq!(
        site.post(
            "/api/v1/auth/login",
            json!({ "login": "forgot_me", "password": GOOD_PASSWORD })
        )
        .await
        .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        site.post(
            "/api/v1/auth/login",
            json!({ "login": "forgot_me", "password": "brand new password" })
        )
        .await
        .0,
        StatusCode::OK
    );
    // 验证码用过就没了
    let (status, ..) = site
        .post("/api/v1/auth/password/reset", json!({ "email": "forgot@qq.com", "code": reset_code, "new_password": "another new password" }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_stranger_cannot_reset_someone_elses_password_without_the_mailed_code() {
    let site = site().await;
    let code = site.request_code("victim@qq.com", "register").await;
    site.register("victim@qq.com", &code, "victim_one", GOOD_PASSWORD, None)
        .await;
    // 陌生人对着受害者的邮箱瞎猜
    for guess in ["000000", "123456", "654321"] {
        let (status, ..) = site
            .post("/api/v1/auth/password/reset", json!({ "email": "victim@qq.com", "code": guess, "new_password": "attacker password" }))
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    // 对根本没发过码的邮箱也是同样的回答
    let (status, body, _) = site
        .post("/api/v1/auth/password/reset", json!({ "email": "nobody@qq.com", "code": "123456", "new_password": "attacker password" }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        site.post(
            "/api/v1/auth/login",
            json!({ "login": "victim_one", "password": GOOD_PASSWORD })
        )
        .await
        .0,
        StatusCode::OK,
        "密码没变"
    );
}

#[tokio::test]
async fn changing_the_password_needs_the_old_one_and_keeps_only_this_device() {
    let site = site().await;
    let code = site.request_code("change@qq.com", "register").await;
    let (_, _, headers) = site
        .register("change@qq.com", &code, "change_me", GOOD_PASSWORD, None)
        .await;
    let this_device = session_of(&headers);
    let (_, _, login) = site
        .post(
            "/api/v1/auth/login",
            json!({ "login": "change_me", "password": GOOD_PASSWORD }),
        )
        .await;
    let other_device = session_of(&login);

    let change = |old: &'static str, new: &'static str, session: String| {
        let site = &site;
        async move {
            let request = Request::builder()
                .method("POST")
                .uri("/api/v1/auth/change-password")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, format!("kb_session={session}"))
                .header(header::HOST, "kb.test")
                .header("x-kb-csrf", "1")
                .body(Body::from(
                    json!({ "old_password": old, "new_password": new }).to_string(),
                ))
                .unwrap();
            let (status, body, _) = site.send(request).await;
            (status, body)
        }
    };
    assert_eq!(
        change(
            "wrong old password",
            "brand new password",
            this_device.clone()
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        change(GOOD_PASSWORD, "12345678", this_device.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST,
        "弱密码"
    );
    assert_eq!(
        change(GOOD_PASSWORD, GOOD_PASSWORD, this_device.clone())
            .await
            .0,
        StatusCode::BAD_REQUEST,
        "新旧一样"
    );
    assert_eq!(
        change(GOOD_PASSWORD, "brand new password", this_device.clone())
            .await
            .0,
        StatusCode::OK
    );

    assert_eq!(
        site.get_with_session("/api/v1/auth/me", &this_device)
            .await
            .0,
        StatusCode::OK,
        "当前设备保持登录"
    );
    assert_eq!(
        site.get_with_session("/api/v1/auth/me", &other_device)
            .await
            .0,
        StatusCode::UNAUTHORIZED,
        "其它设备下线"
    );

    // 旧密码连错 5 次后被限速(防着有人拿到一个会话后爆破旧密码)
    for _ in 0..5 {
        change(
            "not the password",
            "brand new password 2",
            this_device.clone(),
        )
        .await;
    }
    assert_eq!(
        change(
            "brand new password",
            "brand new password 2",
            this_device.clone()
        )
        .await
        .0,
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn public_post_endpoints_require_the_csrf_header() {
    let site = site().await;
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/email-code")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::HOST, "kb.test")
        .body(Body::from(
            json!({ "email": "a@qq.com", "purpose": "register" }).to_string(),
        ))
        .unwrap();
    let (status, ..) = site.send(request).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "别的网站的页面不能替访客去触发发信"
    );
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/email-code")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::HOST, "kb.test")
        .header(header::ORIGIN, "https://evil.example")
        .header("x-kb-csrf", "1")
        .body(Body::from(
            json!({ "email": "a@qq.com", "purpose": "register" }).to_string(),
        ))
        .unwrap();
    assert_eq!(
        site.send(request).await.0,
        StatusCode::FORBIDDEN,
        "Origin 不对"
    );
    site.assert_no_mail_beyond(0).await;
}

#[tokio::test]
async fn people_behind_the_same_proxy_are_limited_separately() {
    // 生产上所有人都从 127.0.0.1(本机代理)进来:靠 CF-Connecting-IP 区分,一个人试错不能锁住别人
    let site = site().await;
    let bad_login = |ip: &'static str| {
        let site = &site;
        async move {
            site.post_from(
                "/api/v1/auth/login",
                json!({ "login": "nobody_here", "password": "wrong password" }),
                "127.0.0.1:1",
                &[("cf-connecting-ip", ip)],
            )
            .await
            .0
        }
    };
    for _ in 0..5 {
        assert_eq!(bad_login("203.0.113.50").await, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(
        bad_login("203.0.113.50").await,
        StatusCode::TOO_MANY_REQUESTS,
        "试错的人被锁"
    );
    assert_eq!(
        bad_login("203.0.113.51").await,
        StatusCode::UNAUTHORIZED,
        "别的人不受影响"
    );
    // 伪造 X-Forwarded-For 第一项换不了桶(取的是最后一项)
    let (status, ..) = site
        .post_from(
            "/api/v1/auth/login",
            json!({ "login": "nobody_here", "password": "x" }),
            "127.0.0.1:1",
            &[("x-forwarded-for", "9.9.9.9, 203.0.113.50")],
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_failing_primary_mailbox_falls_back_and_the_attempt_is_logged() {
    let mut config = mail_config();
    config.mail.backup = MailAccount {
        host: "smtp.163.com".into(),
        username: "spare@163.com".into(),
        ..MailAccount::default()
    };
    let site = site_with(config).await;
    site.failing
        .lock()
        .unwrap()
        .push("noreply@example.com".into());
    let (status, ..) = site
        .post(
            "/api/v1/auth/email-code",
            json!({ "email": "fb@qq.com", "purpose": "register" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let _ = site.mail(0).await;
    assert_eq!(
        site.sent.lock().unwrap()[0].0,
        "spare@163.com",
        "主账号坏了走备用"
    );
    // 发信结果落了记录(管理员排查用),验证码不在记录里
    for _ in 0..50 {
        if !site.state.system.list_mail_log(5).await.unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let log = site.state.system.list_mail_log(5).await.unwrap();
    assert_eq!(
        (log[0].ok, log[0].via.as_deref(), log[0].kind.as_str()),
        (true, Some("backup"), "register_code")
    );
    assert!(
        !format!("{log:?}").contains(&code_in(&site.sent.lock().unwrap()[0].1.body)),
        "发信记录里不能有验证码"
    );
}

#[tokio::test]
async fn the_hot_reloaded_config_takes_effect_on_the_next_request() {
    let site = site().await;
    assert_eq!(
        site.post(
            "/api/v1/auth/email-code",
            json!({ "email": "a@qq.com", "purpose": "register" })
        )
        .await
        .0,
        StatusCode::OK
    );
    // 管理员关闭注册(热更新)
    let mut next = (*site.config.get()).clone();
    next.accounts.registration_open = false;
    site.config.replace(next);
    assert_eq!(
        site.post(
            "/api/v1/auth/email-code",
            json!({ "email": "b@qq.com", "purpose": "register" })
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn an_invite_can_make_the_newcomer_and_the_inviter_friends_and_tells_the_inviter() {
    let site = site().await;
    // 第一个用户会接管主知识库,先垫一个管理员
    for name in ["boss", "inviter"] {
        site.state
            .system
            .create_user(kb_core::account::NewUser {
                username: name.to_owned(),
                email: Some(format!("{name}@qq.com")),
                display_name: None,
                password_hash: "x".to_owned(),
                role_id: if name == "boss" {
                    "role_admin"
                } else {
                    "role_user"
                }
                .to_owned(),
                status: kb_core::account::UserStatus::Active,
                registered_via: "test".to_owned(),
                must_change_password: false,
                email_verified: true,
            })
            .await
            .unwrap();
    }
    let inviter = site
        .state
        .system
        .find_user_by_login("inviter")
        .await
        .unwrap()
        .unwrap();
    let invite = site.invite_by(&inviter.id, true).await;
    let code = site.request_code("friend@qq.com", "register").await;
    let (status, body, _) = site
        .register(
            "friend@qq.com",
            &code,
            "newcomer",
            GOOD_PASSWORD,
            Some(&invite),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let newcomer = site
        .state
        .system
        .find_user_by_login("newcomer")
        .await
        .unwrap()
        .unwrap();
    assert!(
        site.state
            .system
            .are_friends(&inviter.id, &newcomer.id)
            .await
            .unwrap()
    );
    assert!(
        site.state
            .system
            .are_friends(&newcomer.id, &inviter.id)
            .await
            .unwrap()
    );
    let notes = site
        .state
        .system
        .list_notifications(&inviter.id, false, None, 10)
        .await
        .unwrap();
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!(notes[0].kind, "friend_result");
    assert_eq!(notes[0].data["via_invite"], true);
    assert_eq!(notes[0].data["by"]["username"], "newcomer");
    // 新用户那边没有凭空多出一条通知
    assert!(
        site.state
            .system
            .list_notifications(&newcomer.id, false, None, 10)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn an_invite_without_auto_friend_or_without_an_inviter_makes_no_friendship() {
    let site = site().await;
    for name in ["boss", "inviter"] {
        site.state
            .system
            .create_user(kb_core::account::NewUser {
                username: name.to_owned(),
                email: Some(format!("{name}@qq.com")),
                display_name: None,
                password_hash: "x".to_owned(),
                role_id: if name == "boss" {
                    "role_admin"
                } else {
                    "role_user"
                }
                .to_owned(),
                status: kb_core::account::UserStatus::Active,
                registered_via: "test".to_owned(),
                must_change_password: false,
                email_verified: true,
            })
            .await
            .unwrap();
    }
    let inviter = site
        .state
        .system
        .find_user_by_login("inviter")
        .await
        .unwrap()
        .unwrap();
    // 邀请人把「自动加好友」关了
    let off = site.invite_by(&inviter.id, false).await;
    let code = site.request_code("a@qq.com", "register").await;
    let (status, ..) = site
        .register("a@qq.com", &code, "user_a", GOOD_PASSWORD, Some(&off))
        .await;
    assert_eq!(status, StatusCode::OK);
    let user_a = site
        .state
        .system
        .find_user_by_login("user_a")
        .await
        .unwrap()
        .unwrap();
    assert!(
        !site
            .state
            .system
            .are_friends(&inviter.id, &user_a.id)
            .await
            .unwrap()
    );
    // 管理员 / 本机创建的码没有邀请人:没人可加
    let anonymous = site.invite(5, None, "{}").await;
    let code = site.request_code("b@qq.com", "register").await;
    let (status, ..) = site
        .register("b@qq.com", &code, "user_b", GOOD_PASSWORD, Some(&anonymous))
        .await;
    assert_eq!(status, StatusCode::OK);
    let user_b = site
        .state
        .system
        .find_user_by_login("user_b")
        .await
        .unwrap()
        .unwrap();
    assert_eq!(site.state.system.friend_count(&user_b.id).await.unwrap(), 0);
    assert!(
        site.state
            .system
            .list_notifications(&inviter.id, false, None, 10)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn probing_which_usernames_exist_without_a_valid_code_is_rate_limited() {
    let site = site().await;
    let code = site.request_code("first@qq.com", "register").await;
    let (status, body, _) = site
        .register("first@qq.com", &code, "taken_name", GOOD_PASSWORD, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // 没有任何有效验证码:换着用户名试,看哪个返回「已被占用」就是存在的账号。
    // 这种探测每次都要计入失败次数,否则可以不受限制地把用户名列表扫出来
    for attempt in 0..5 {
        let (status, body, _) = site
            .register("probe@qq.com", "000000", "taken_name", GOOD_PASSWORD, None)
            .await;
        assert_eq!(status, StatusCode::CONFLICT, "第 {attempt} 次:{body}");
    }
    let (status, body, _) = site
        .register("probe@qq.com", "000000", "taken_name", GOOD_PASSWORD, None)
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    // 挡住之后,不管用户名占没占用,回答一样,探测不出任何信息
    let (status, _, _) = site
        .register("probe@qq.com", "000000", "unused_name", GOOD_PASSWORD, None)
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
}
