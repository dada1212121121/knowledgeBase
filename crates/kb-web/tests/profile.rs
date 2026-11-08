//! 个人资料与头像的 HTTP 验收(多用户设计说明)。
//!
//! 重点是边界:谁能改、传什么会被拒、被拒时不留任何痕迹(文件、数据库),
//! 以及读取头像时请求里的任何字符串都不能把人带到头像目录之外。

use std::io::Cursor;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use kb_core::account::{NewUser, ROLE_USER, UserStatus};
use kb_core::config::{Config, ConfigStore};
use kb_web::AppState;
use kb_web::signup::AccountDeps;
use kb_web::source::SocketKind;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Site {
    state: Arc<AppState>,
    avatars: PathBuf,
    /// 内存发信箱:`(发件账号, 邮件)`。
    sent: kb_mail::SentLog,
}

async fn site() -> Site {
    build_site(false, Arc::new(kb_web::export_api::NoExport)).await
}

/// 邮件功能打开、主发件账号配好的站点(发信走内存发信箱)。
async fn site_with_mail() -> Site {
    build_site(true, Arc::new(kb_web::export_api::NoExport)).await
}

/// 用指定的导出实现建站点(测导出接口用)。
async fn site_with_exports(exports: Arc<dyn kb_web::export_api::PersonalExport>) -> Site {
    build_site(false, exports).await
}

async fn build_site(mail_on: bool, exports: Arc<dyn kb_web::export_api::PersonalExport>) -> Site {
    let mut config = Config::default();
    if mail_on {
        config.mail.enabled = true;
        config.mail.primary = kb_core::config::MailAccount {
            host: "smtp.example.com".into(),
            username: "noreply@example.com".into(),
            ..Default::default()
        };
    }
    let transport = kb_mail::MemoryTransport::default();
    let sent = transport.sent.clone();
    let dir = tempfile::tempdir().expect("目录").keep();
    let meta = Arc::new(kb_meta::SqliteMetaStore::open(dir.join("meta.db")).expect("meta"));
    let avatars = dir.join("avatars");
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
            config: Arc::new(ConfigStore::new(config)),
            mailer: Arc::new(kb_mail::Mailer::new(Box::new(transport))),
            passwords: Arc::new(kb_mail::Passwords::default),
            limiter: Arc::new(kb_web::auth::ratelimit::LoginLimiter::new()),
            avatars_dir: avatars.clone(),
            home: dir.clone(),
            exports,
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
        avatars,
        sent,
    }
}

/// 一个发出请求的人:会话 cookie 或 Bearer 令牌。
#[derive(Clone)]
struct Who {
    cookie: Option<String>,
    bearer: Option<String>,
    id: String,
}

impl Site {
    async fn user(&self, name: &str) -> Who {
        self.user_with_role(name, ROLE_USER).await
    }

    /// 管理员账号。系统里第一个管理员会接管主知识库(数据根目录本身)。
    async fn admin_user(&self, name: &str) -> Who {
        self.user_with_role(name, kb_core::account::ROLE_ADMIN)
            .await
    }

    async fn user_with_role(&self, name: &str, role: &str) -> Who {
        let hash = kb_web::auth::password::hash_password("correct horse battery").unwrap();
        let (user, _) = self
            .state
            .system
            .create_user(NewUser {
                username: name.to_owned(),
                email: Some(format!("{name}@example.com")),
                display_name: None,
                password_hash: hash,
                role_id: role.to_owned(),
                status: UserStatus::Active,
                registered_via: "test".to_owned(),
                must_change_password: false,
                email_verified: true,
            })
            .await
            .unwrap();
        let (status, headers, body) = self
            .raw(
                Method::POST,
                "/api/v1/auth/login",
                None,
                Some(
                    json!({ "login": name, "password": "correct horse battery" })
                        .to_string()
                        .into_bytes(),
                ),
                &[("content-type", "application/json")],
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let cookie = headers
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|raw| {
                raw.split_once('=')
                    .map(|(_, rest)| rest.split(';').next().unwrap().to_owned())
            })
            .expect("会话 cookie");
        Who {
            cookie: Some(cookie),
            bearer: None,
            id: user.id,
        }
    }

    /// 同一个人再登录一次(另一台设备),可指定它的 User-Agent。
    async fn login_again(&self, name: &str, user_agent: &str) -> Who {
        let (status, headers, body) = self
            .raw(
                Method::POST,
                "/api/v1/auth/login",
                None,
                Some(
                    json!({ "login": name, "password": "correct horse battery" })
                        .to_string()
                        .into_bytes(),
                ),
                &[
                    ("content-type", "application/json"),
                    ("user-agent", user_agent),
                ],
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let cookie = headers
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .and_then(|raw| {
                raw.split_once('=')
                    .map(|(_, rest)| rest.split(';').next().unwrap().to_owned())
            })
            .expect("会话 cookie");
        let id = self
            .state
            .system
            .find_user_by_login(name)
            .await
            .unwrap()
            .unwrap()
            .id;
        Who {
            cookie: Some(cookie),
            bearer: None,
            id,
        }
    }

    async fn sessions_of(&self, who: &Who) -> Vec<Value> {
        let (status, _, body) = self
            .raw(Method::GET, "/api/v1/me/sessions", Some(who), None, &[])
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["data"]["sessions"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    }

    async fn still_signed_in(&self, who: &Who) -> bool {
        self.raw(Method::GET, "/api/v1/auth/me", Some(who), None, &[])
            .await
            .0
            == StatusCode::OK
    }

    /// 给某个人建一个 API 令牌,返回只带 Bearer 的身份。
    async fn token_of(&self, who: &Who) -> Who {
        let (status, _, body) = self
            .send(
                Method::POST,
                "/api/v1/auth/tokens",
                who,
                Some(
                    json!({ "name": "t", "scope": "api" })
                        .to_string()
                        .into_bytes(),
                ),
                &[("content-type", "application/json")],
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let plaintext = body["data"]["token"].as_str().expect("明文令牌").to_owned();
        Who {
            cookie: None,
            bearer: Some(plaintext),
            id: who.id.clone(),
        }
    }

    async fn raw(
        &self,
        method: Method,
        path: &str,
        who: Option<&Who>,
        body: Option<Vec<u8>>,
        extra: &[(&str, &str)],
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let (status, headers, bytes) = self.raw_bytes(method, path, who, body, extra).await;
        (
            status,
            headers,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn raw_bytes(
        &self,
        method: Method,
        path: &str,
        who: Option<&Who>,
        body: Option<Vec<u8>>,
        extra: &[(&str, &str)],
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "kb.test");
        if let Some(who) = who {
            if let Some(cookie) = &who.cookie {
                builder = builder.header(header::COOKIE, format!("kb_session={cookie}"));
            }
            if let Some(token) = &who.bearer {
                builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
        }
        for (name, value) in extra {
            builder = builder.header(*name, *value);
        }
        let mut request = builder
            .body(Body::from(body.unwrap_or_default()))
            .expect("请求");
        request
            .extensions_mut()
            .insert(ConnectInfo("127.0.0.1:4000".parse::<SocketAddr>().unwrap()));
        let app = kb_web::build(self.state.clone(), SocketKind::Tcp);
        let response = app.oneshot(request).await.expect("响应");
        let (status, headers) = (response.status(), response.headers().clone());
        let bytes = axum::body::to_bytes(response.into_body(), 16 << 20)
            .await
            .expect("体");
        (status, headers, bytes.to_vec())
    }

    /// 带 CSRF 头的写请求(浏览器页面都会带)。
    async fn send(
        &self,
        method: Method,
        path: &str,
        who: &Who,
        body: Option<Vec<u8>>,
        extra: &[(&str, &str)],
    ) -> (StatusCode, axum::http::HeaderMap, Value) {
        let mut headers = vec![("x-kb-csrf", "1")];
        headers.extend_from_slice(extra);
        self.raw(method, path, Some(who), body, &headers).await
    }

    async fn put_avatar(&self, who: &Who, bytes: Vec<u8>) -> (StatusCode, Value) {
        let (status, _, body) = self
            .send(
                Method::PUT,
                "/api/v1/me/avatar",
                who,
                Some(bytes),
                &[("content-type", "application/octet-stream")],
            )
            .await;
        (status, body)
    }

    async fn avatar_of(&self, id: &str) -> Option<String> {
        self.state
            .system
            .get_user(id)
            .await
            .unwrap()
            .unwrap()
            .avatar
    }

    fn files(&self) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(&self.avatars)
            .map(|dir| {
                dir.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        names.sort();
        names
    }
}

fn png(w: u32, h: u32, color: [u8; 4]) -> Vec<u8> {
    let mut out = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(RgbaImage::from_pixel(w, h, Rgba(color)))
        .write_to(&mut out, ImageFormat::Png)
        .unwrap();
    out.into_inner()
}

/// PNG 用的 CRC-32(IEEE)。
fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

/// 「图片炸弹」:几十字节的合法 PNG 头,宽高写成 30000×30000。
/// 改了宽高必须重算 IHDR 的 CRC,否则解码器先报「已损坏」,测到的就不是尺寸限制。
fn png_bomb() -> Vec<u8> {
    let mut bomb = png(1, 1, [0, 0, 0, 255]);
    bomb[16..20].copy_from_slice(&30_000u32.to_be_bytes());
    bomb[20..24].copy_from_slice(&30_000u32.to_be_bytes());
    let crc = crc32(&bomb[12..29]);
    bomb[29..33].copy_from_slice(&crc.to_be_bytes());
    // 自检:头现在是合法的,只是尺寸夸张
    let reader = image::ImageReader::with_format(Cursor::new(&bomb), ImageFormat::Png);
    let (w, h) = image::ImageDecoder::dimensions(&reader.into_decoder().expect("头应当合法"));
    assert_eq!((w, h), (30_000, 30_000));
    bomb
}

#[tokio::test]
async fn uploading_an_avatar_stores_a_256_square_png_that_anyone_signed_in_can_read() {
    let site = site().await;
    let alice = site.user("alice").await;
    let bob = site.user("bob").await;
    let (status, body) = site
        .put_avatar(&alice, png(500, 300, [200, 30, 30, 255]))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let name = body["data"]["avatar"].as_str().unwrap().to_owned();
    assert!(
        name.starts_with(&alice.id) && name.ends_with(".png"),
        "{name}"
    );
    assert_eq!(
        site.avatar_of(&alice.id).await.as_deref(),
        Some(name.as_str())
    );
    assert_eq!(
        site.files(),
        std::slice::from_ref(&name),
        "磁盘上只有这一个文件,没有临时文件"
    );

    // alice 自己和 bob 都能读
    for viewer in [&alice, &bob] {
        let (status, headers, bytes) = site
            .raw_bytes(
                Method::GET,
                &format!("/api/v1/users/{}/avatar?v={name}", alice.id),
                Some(viewer),
                None,
                &[],
            )
            .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers[header::CONTENT_TYPE], "image/png");
        assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; sandbox"
        );
        assert!(
            headers[header::CACHE_CONTROL]
                .to_str()
                .unwrap()
                .contains("immutable"),
            "地址带着当前版本,可以长期缓存"
        );
        let image = image::load_from_memory(&bytes).unwrap();
        assert_eq!((image.width(), image.height()), (256, 256));
    }
    // 版本对不上(旧链接):只短暂缓存,不 immutable
    let (_, headers, _) = site
        .raw_bytes(
            Method::GET,
            &format!("/api/v1/users/{}/avatar?v=old", alice.id),
            Some(&bob),
            None,
            &[],
        )
        .await;
    assert!(
        !headers[header::CACHE_CONTROL]
            .to_str()
            .unwrap()
            .contains("immutable")
    );
    // auth/me 带出头像文件名,前端据此拼地址
    let (_, _, me) = site
        .raw(Method::GET, "/api/v1/auth/me", Some(&alice), None, &[])
        .await;
    assert_eq!(me["data"]["user"]["avatar"], name.as_str());
}

#[tokio::test]
async fn reading_requires_login_and_a_missing_avatar_is_a_plain_404() {
    let site = site().await;
    let alice = site.user("alice").await;
    let bob = site.user("bob").await;
    site.put_avatar(&alice, png(64, 64, [1, 2, 3, 255])).await;
    let (status, ..) = site
        .raw_bytes(
            Method::GET,
            &format!("/api/v1/users/{}/avatar", alice.id),
            None,
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "没登录不能读");
    // bob 没有头像
    let (status, ..) = site
        .raw_bytes(
            Method::GET,
            &format!("/api/v1/users/{}/avatar", bob.id),
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // 不存在的用户:同样是 404,不泄露用户是否存在
    let (status, ..) = site
        .raw_bytes(
            Method::GET,
            "/api/v1/users/usr_nobody/avatar",
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn batch_lookup_says_who_has_an_avatar_without_any_404() {
    let site = site().await;
    let alice = site.user("alice").await;
    let bob = site.user("bob").await;
    site.put_avatar(&alice, png(64, 64, [1, 2, 3, 255])).await;
    let name = site.avatar_of(&alice.id).await.expect("alice 有头像");

    let ids = format!("{},{},usr_nobody,guest:访客1234#7", alice.id, bob.id);
    let (status, _, body) = site
        .raw(
            Method::GET,
            &format!("/api/v1/users/avatars?ids={}", ids.replace('#', "%23")),
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let avatars = &body["data"]["avatars"];
    assert_eq!(
        avatars[alice.id.as_str()],
        name.as_str(),
        "有头像的给文件名"
    );
    assert!(
        avatars[bob.id.as_str()].is_null(),
        "没有头像的是 null,不是 404"
    );
    // 不存在的用户和游客与「没有头像」同样是 null:不泄露用户是否存在
    assert!(avatars["usr_nobody"].is_null());
    assert!(avatars["guest:访客1234#7"].is_null());
}

#[tokio::test]
async fn batch_lookup_requires_login_and_bounds_the_request() {
    let site = site().await;
    let alice = site.user("alice").await;
    let (status, ..) = site
        .raw(
            Method::GET,
            "/api/v1/users/avatars?ids=usr_x",
            None,
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "没登录不能查");

    // 空列表是合法的,答空表
    let (status, _, body) = site
        .raw(
            Method::GET,
            "/api/v1/users/avatars?ids=",
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["avatars"], json!({}));

    // 超过上限直接拒绝,不逐个去查库
    let many = (0..51)
        .map(|i| format!("usr_{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let (status, ..) = site
        .raw(
            Method::GET,
            &format!("/api/v1/users/avatars?ids={many}"),
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let fifty = (0..50)
        .map(|i| format!("usr_{i}"))
        .collect::<Vec<_>>()
        .join(",");
    let (status, ..) = site
        .raw(
            Method::GET,
            &format!("/api/v1/users/avatars?ids={fifty}"),
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "正好 50 个可以");
}

#[tokio::test]
async fn batch_lookup_says_null_when_the_file_is_gone_so_the_browser_never_hits_a_404() {
    let site = site().await;
    let alice = site.user("alice").await;
    site.put_avatar(&alice, png(64, 64, [1, 2, 3, 255])).await;
    // 数据库里还记着文件名,文件却被人清掉了(备份恢复、手动清理):前端照这个答案去取图只会拿到 404
    for name in site.files() {
        std::fs::remove_file(site.avatars.join(name)).unwrap();
    }
    let (status, _, body) = site
        .raw(
            Method::GET,
            &format!("/api/v1/users/avatars?ids={}", alice.id),
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["data"]["avatars"][alice.id.as_str()].is_null());
}

#[tokio::test]
async fn a_new_avatar_replaces_the_old_file_and_delete_removes_it() {
    let site = site().await;
    let alice = site.user("alice").await;
    let (_, first) = site.put_avatar(&alice, png(64, 64, [255, 0, 0, 255])).await;
    let first = first["data"]["avatar"].as_str().unwrap().to_owned();
    let (_, second) = site.put_avatar(&alice, png(64, 64, [0, 0, 255, 255])).await;
    let second = second["data"]["avatar"].as_str().unwrap().to_owned();
    assert_ne!(first, second, "每次上传换一个文件名,浏览器缓存才会失效");
    assert_eq!(
        site.files(),
        std::slice::from_ref(&second),
        "旧文件被删掉了,磁盘不会越攒越多"
    );
    assert_eq!(
        site.avatar_of(&alice.id).await.as_deref(),
        Some(second.as_str())
    );

    let (status, _, body) = site
        .send(Method::DELETE, "/api/v1/me/avatar", &alice, None, &[])
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(site.files().is_empty());
    assert_eq!(site.avatar_of(&alice.id).await, None);
    // 重复删除不报错
    let (status, ..) = site
        .send(Method::DELETE, "/api/v1/me/avatar", &alice, None, &[])
        .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn one_users_avatar_change_never_touches_another_users_file() {
    let site = site().await;
    let alice = site.user("alice").await;
    let bob = site.user("bob").await;
    let (_, a) = site.put_avatar(&alice, png(64, 64, [255, 0, 0, 255])).await;
    let (_, b) = site.put_avatar(&bob, png(64, 64, [0, 255, 0, 255])).await;
    let (a, b) = (
        a["data"]["avatar"].as_str().unwrap().to_owned(),
        b["data"]["avatar"].as_str().unwrap().to_owned(),
    );
    site.send(Method::DELETE, "/api/v1/me/avatar", &alice, None, &[])
        .await;
    assert_eq!(
        site.files(),
        std::slice::from_ref(&b),
        "alice 删头像只删她自己的 {a}"
    );
    assert_eq!(site.avatar_of(&bob.id).await.as_deref(), Some(b.as_str()));
}

#[tokio::test]
async fn bad_uploads_are_refused_and_leave_no_trace() {
    let site = site().await;
    let alice = site.user("alice").await;
    let (_, good) = site.put_avatar(&alice, png(64, 64, [9, 9, 9, 255])).await;
    let good = good["data"]["avatar"].as_str().unwrap().to_owned();

    let svg =
        br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#.to_vec();
    let html = b"<html><script>alert(1)</script></html>".to_vec();
    let mut disguised = b"<?php system($_GET[1]); ?>".to_vec();
    disguised.extend_from_slice(&png(8, 8, [0, 0, 0, 255]));
    let bomb = png_bomb();
    // 8–16 MB:到得了我们的处理函数,拿到清楚的提示
    let oversized = vec![0u8; 9 * 1024 * 1024];
    for (index, (name, bytes, wanted_text)) in [
        ("svg", svg, "只支持"),
        ("html", html, "只支持"),
        ("php 前缀", disguised, "只支持"),
        ("空", Vec::new(), "没有收到"),
        ("炸弹", bomb, "太大"),
        // 超过 8 MB:要拿到我们自己那句提示,而不是框架的一条空 413
        ("超大", oversized, "不能超过"),
    ]
    .into_iter()
    .enumerate()
    {
        // 每次换个人以免撞上限速(限速本身另有测试)
        let probe = site.user(&format!("probe{index}")).await;
        let before = site.files();
        let (status, body) = site.put_avatar(&probe, bytes).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{name}:{body}");
        let message = body["error"]["message"].as_str().unwrap_or_default();
        assert!(
            message.contains(wanted_text),
            "{name} 应提示「{wanted_text}」,实际:{body}"
        );
        // 被拒就是被拒:磁盘上没有多出任何文件(含临时文件),这个人的头像也没被设置
        assert_eq!(site.files(), before, "{name} 被拒后不该在磁盘上留下东西");
        assert_eq!(
            site.avatar_of(&probe.id).await,
            None,
            "{name} 被拒后不该设置头像"
        );
    }
    // alice 自己的头像始终没变
    assert_eq!(
        site.avatar_of(&alice.id).await.as_deref(),
        Some(good.as_str())
    );
    assert_eq!(site.files(), [good]);
}

#[tokio::test]
async fn only_a_browser_session_can_change_a_profile() {
    let site = site().await;
    let alice = site.user("alice").await;
    let token = site.token_of(&alice).await;
    let image = png(64, 64, [1, 1, 1, 255]);

    // API 令牌:不能改头像、不能改名、不能删头像
    let (status, ..) = site
        .send(
            Method::PUT,
            "/api/v1/me/avatar",
            &token,
            Some(image.clone()),
            &[("content-type", "application/octet-stream")],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, ..) = site
        .send(
            Method::PATCH,
            "/api/v1/me/profile",
            &token,
            Some(br#"{"display_name":"x"}"#.to_vec()),
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, ..) = site
        .send(Method::DELETE, "/api/v1/me/avatar", &token, None, &[])
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(site.files().is_empty() && site.avatar_of(&alice.id).await.is_none());

    // 没登录
    let (status, ..) = site
        .raw(
            Method::PUT,
            "/api/v1/me/avatar",
            None,
            Some(image),
            &[("x-kb-csrf", "1")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn writes_without_the_csrf_header_or_from_another_origin_are_refused() {
    let site = site().await;
    let alice = site.user("alice").await;
    let image = png(64, 64, [1, 1, 1, 255]);
    // 没带 X-KB-CSRF
    let (status, ..) = site
        .raw(
            Method::PUT,
            "/api/v1/me/avatar",
            Some(&alice),
            Some(image.clone()),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // 带了头但 Origin 是别的网站
    let (status, ..) = site
        .raw(
            Method::PUT,
            "/api/v1/me/avatar",
            Some(&alice),
            Some(image),
            &[("x-kb-csrf", "1"), ("origin", "https://evil.example")],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, ..) = site
        .raw(
            Method::PATCH,
            "/api/v1/me/profile",
            Some(&alice),
            Some(br#"{"display_name":"hacked"}"#.to_vec()),
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(site.files().is_empty());
    assert_eq!(
        site.state
            .system
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .display_name,
        "alice"
    );
}

#[tokio::test]
async fn uploads_are_rate_limited_per_person_not_globally() {
    let site = site().await;
    let alice = site.user("alice").await;
    let bob = site.user("bob").await;
    for n in 0..5 {
        let (status, body) = site.put_avatar(&alice, png(32, 32, [n, 0, 0, 255])).await;
        assert_eq!(status, StatusCode::OK, "第 {n} 次:{body}");
    }
    let (status, headers, body) = site
        .send(
            Method::PUT,
            "/api/v1/me/avatar",
            &alice,
            Some(png(32, 32, [9, 9, 9, 255])),
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(headers.get(header::RETRY_AFTER).is_some());
    // 被拒的垃圾上传同样计数,不能靠传垃圾来无限消耗 CPU
    // bob 不受影响
    let (status, body) = site.put_avatar(&bob, png(32, 32, [1, 1, 1, 255])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn garbage_uploads_count_toward_the_limit_too() {
    let site = site().await;
    let alice = site.user("alice").await;
    for _ in 0..5 {
        let (status, _) = site.put_avatar(&alice, b"not an image".to_vec()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status, _) = site.put_avatar(&alice, png(32, 32, [1, 1, 1, 255])).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "解码失败也消耗限额");
}

#[tokio::test]
async fn a_poisoned_avatar_value_in_the_database_cannot_read_outside_the_directory() {
    let site = site().await;
    let alice = site.user("alice").await;
    let bob = site.user("bob").await;
    // 一个头像目录之外的、看起来很敏感的文件
    let secret = site.avatars.parent().unwrap().join("secret.txt");
    std::fs::write(&secret, "TOP-SECRET").unwrap();
    std::fs::create_dir_all(&site.avatars).unwrap();
    for evil in [
        "../secret.txt",
        "../../etc/passwd",
        "/etc/passwd",
        "usr_x-12345678.png/../../secret.txt",
        "secret.txt",
    ] {
        site.state
            .system
            .update_user(
                &alice.id,
                kb_meta::system::UserUpdate {
                    avatar: Some(Some(evil.to_owned())),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        let (status, _, bytes) = site
            .raw_bytes(
                Method::GET,
                &format!("/api/v1/users/{}/avatar", alice.id),
                Some(&bob),
                None,
                &[],
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{evil}");
        assert!(
            !String::from_utf8_lossy(&bytes).contains("TOP-SECRET"),
            "{evil} 读出了头像目录之外的文件"
        );
    }
    // 请求路径里的 id 也不参与拼路径:穿越写法找不到用户,同样是 404
    for evil_id in ["..%2F..%2Fsecret.txt", "%2e%2e", "usr_x%00"] {
        let (status, _, bytes) = site
            .raw_bytes(
                Method::GET,
                &format!("/api/v1/users/{evil_id}/avatar"),
                Some(&bob),
                None,
                &[],
            )
            .await;
        assert!(
            status == StatusCode::NOT_FOUND || status == StatusCode::BAD_REQUEST,
            "{evil_id}: {status}"
        );
        assert!(!String::from_utf8_lossy(&bytes).contains("TOP-SECRET"));
    }
}

#[tokio::test]
async fn the_display_name_can_be_changed_but_only_to_something_reasonable() {
    let site = site().await;
    let alice = site.user("alice").await;
    let patch = |name: &str| json!({ "display_name": name }).to_string().into_bytes();
    let (status, _, body) = site
        .send(
            Method::PATCH,
            "/api/v1/me/profile",
            &alice,
            Some(patch("  林一  ")),
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["display_name"], "林一", "首尾空白被去掉");
    let (_, _, me) = site
        .raw(Method::GET, "/api/v1/auth/me", Some(&alice), None, &[])
        .await;
    assert_eq!(
        me["data"]["user"]["display_name"], "林一",
        "改名后 auth/me 立刻是新名字"
    );
    for bad in [
        "",
        "   ",
        "<b>x</b>",
        "a\nb",
        &"字".repeat(31),
        "\u{202e}nimda",
    ] {
        let (status, ..) = site
            .send(
                Method::PATCH,
                "/api/v1/me/profile",
                &alice,
                Some(patch(bad)),
                &[("content-type", "application/json")],
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{bad:?}");
    }
    assert_eq!(
        site.state
            .system
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .display_name,
        "林一"
    );
}

#[tokio::test]
async fn exif_location_in_an_uploaded_photo_does_not_survive_storage() {
    let site = site().await;
    let alice = site.user("alice").await;
    // 一张带 GPS 文字的 JPEG
    let mut jpeg = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(
        DynamicImage::ImageRgba8(RgbaImage::from_pixel(120, 90, Rgba([40, 90, 160, 255])))
            .to_rgb8(),
    )
    .write_to(&mut jpeg, ImageFormat::Jpeg)
    .unwrap();
    let jpeg = jpeg.into_inner();
    let mut payload = b"Exif\0\0II*\0\x08\0\0\0\0\0\0\0\0\0GPS:31.2304N,121.4737E".to_vec();
    let len = (payload.len() + 2) as u16;
    let mut tagged = vec![0xFF, 0xD8, 0xFF, 0xE1];
    tagged.extend_from_slice(&len.to_be_bytes());
    tagged.append(&mut payload);
    tagged.extend_from_slice(&jpeg[2..]);
    assert!(tagged.windows(3).any(|w| w == b"GPS"));

    let (status, body) = site.put_avatar(&alice, tagged).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let stored = std::fs::read(site.avatars.join(site.files().first().unwrap())).unwrap();
    assert!(
        !stored.windows(3).any(|w| w == b"GPS") && !stored.windows(7).any(|w| w == b"31.2304"),
        "磁盘上的头像不能带位置信息"
    );
}

#[tokio::test]
async fn a_huge_body_is_rejected_by_the_framework_before_it_is_read() {
    let site = site().await;
    let alice = site.user("alice").await;
    // 超过上限两倍:直接 413,不进处理函数,当然也不会留下任何东西
    let (status, _) = site.put_avatar(&alice, vec![0u8; 17 * 1024 * 1024]).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(site.files().is_empty() && site.avatar_of(&alice.id).await.is_none());
}

const MAC_CHROME: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IPHONE_SAFARI: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1";

#[tokio::test]
async fn the_session_list_shows_only_my_devices_in_plain_words_and_marks_the_current_one() {
    let site = site().await;
    let alice = site.user("alice").await;
    let _bob = site.user("bob").await;
    let laptop = site.login_again("alice", MAC_CHROME).await;
    let phone = site
        .login_again("alice", "<script>alert(1)</script> iPhone Mobile Safari")
        .await;
    let _bob_phone = site.login_again("bob", IPHONE_SAFARI).await;

    let list = site.sessions_of(&laptop).await;
    assert_eq!(list.len(), 3, "alice 登录了三次;bob 的不在里面:{list:?}");
    assert_eq!(
        list.iter().filter(|s| s["current"] == true).count(),
        1,
        "恰好一个是当前设备"
    );
    let devices: Vec<&str> = list.iter().map(|s| s["device"].as_str().unwrap()).collect();
    assert!(devices.contains(&"Chrome · macOS"), "{devices:?}");
    // 看不懂的 UA 只显示固定词汇,不回显原文
    let text = serde_json::to_string(&list).unwrap();
    assert!(
        !text.contains("<script>") && !text.contains("alert(1)"),
        "不能回显 User-Agent 原文:{text}"
    );
    assert!(
        !text.contains("token") && !text.contains("hash"),
        "不能带出令牌或哈希:{text}"
    );
    for session in &list {
        assert_eq!(session["id"].as_str().unwrap().len(), 16);
    }
    // 从另一台设备看,「当前」跟着变
    let from_phone = site.sessions_of(&phone).await;
    let current_device = from_phone.iter().find(|s| s["current"] == true).unwrap();
    let from_laptop_current = list.iter().find(|s| s["current"] == true).unwrap();
    assert_ne!(current_device["id"], from_laptop_current["id"]);
    let _ = alice;
}

#[tokio::test]
async fn signing_out_one_device_ends_only_that_session() {
    let site = site().await;
    let _first = site.user("alice").await;
    let laptop = site.login_again("alice", MAC_CHROME).await;
    let phone = site.login_again("alice", IPHONE_SAFARI).await;
    let phone_id = site
        .sessions_of(&laptop)
        .await
        .into_iter()
        .find(|s| s["device"] == "Safari · iPhone")
        .map(|s| s["id"].as_str().unwrap().to_owned())
        .expect("手机的会话");

    let (status, _, body) = site
        .send(
            Method::DELETE,
            &format!("/api/v1/me/sessions/{phone_id}"),
            &laptop,
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["current"], false);
    assert!(!site.still_signed_in(&phone).await, "手机被踢下线");
    assert!(site.still_signed_in(&laptop).await, "电脑不受影响");
    // 再退一次:已经不存在
    let (status, ..) = site
        .send(
            Method::DELETE,
            &format!("/api/v1/me/sessions/{phone_id}"),
            &laptop,
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn nobody_can_sign_out_someone_elses_device_even_with_a_valid_session_id() {
    let site = site().await;
    let alice = site.user("alice").await;
    let bob = site.user("bob").await;
    let alice_session = site.sessions_of(&alice).await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // bob 拿到了 alice 的会话 id(比如从截图里):照样删不掉
    let (status, ..) = site
        .send(
            Method::DELETE,
            &format!("/api/v1/me/sessions/{alice_session}"),
            &bob,
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(site.still_signed_in(&alice).await, "alice 仍然在线");
    // 用库里真实的令牌哈希当 id 也不行(id 是另一个值)
    let hash = site
        .state
        .system
        .list_user_sessions(&alice.id, 0)
        .await
        .unwrap();
    assert!(hash.is_empty() || hash[0].token_hash != alice_session);
    let real_hash = &site
        .state
        .system
        .list_user_sessions(&alice.id, kb_web::auth::session::now_millis())
        .await
        .unwrap()[0]
        .token_hash;
    let (status, ..) = site
        .send(
            Method::DELETE,
            &format!("/api/v1/me/sessions/{real_hash}"),
            &alice,
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "令牌哈希不是会话 id");
    assert!(site.still_signed_in(&alice).await);
}

#[tokio::test]
async fn sign_out_everywhere_else_keeps_this_device_and_nobody_elses_change() {
    let site = site().await;
    let _first = site.user("alice").await;
    let bob = site.user("bob").await;
    let laptop = site.login_again("alice", MAC_CHROME).await;
    let phone = site.login_again("alice", IPHONE_SAFARI).await;
    let (status, _, body) = site
        .send(
            Method::POST,
            "/api/v1/me/sessions/revoke-others",
            &laptop,
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["revoked"], 2,
        "原来的两个(注册时那个 + 手机)被退出"
    );
    assert!(site.still_signed_in(&laptop).await);
    assert!(!site.still_signed_in(&phone).await);
    assert!(site.still_signed_in(&bob).await, "别人的会话不受影响");
    assert_eq!(site.sessions_of(&laptop).await.len(), 1);
}

#[tokio::test]
async fn managing_devices_needs_a_browser_session_and_the_csrf_header() {
    let site = site().await;
    let alice = site.user("alice").await;
    let token = site.token_of(&alice).await;
    let (status, ..) = site
        .raw(Method::GET, "/api/v1/me/sessions", Some(&token), None, &[])
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "API 令牌不能看登录设备");
    let (status, ..) = site
        .send(
            Method::POST,
            "/api/v1/me/sessions/revoke-others",
            &token,
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, ..) = site
        .raw(Method::GET, "/api/v1/me/sessions", None, None, &[])
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // 写操作没带 CSRF 头
    let (status, ..) = site
        .raw(
            Method::POST,
            "/api/v1/me/sessions/revoke-others",
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // 用 DELETE 去碰 revoke-others:这条路径只注册了 POST,所以是 405,根本不会进到「当成会话 id 去查」,
    // 更不会误触发「退出其它设备」
    let other = site.login_again("alice", IPHONE_SAFARI).await;
    let (status, ..) = site
        .send(
            Method::DELETE,
            "/api/v1/me/sessions/revoke-others",
            &alice,
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert!(site.still_signed_in(&other).await, "没有误触发退出其它设备");
}

#[tokio::test]
async fn signing_out_the_current_device_works_like_logging_out() {
    let site = site().await;
    let alice = site.user("alice").await;
    let current = site.sessions_of(&alice).await[0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, _, body) = site
        .send(
            Method::DELETE,
            &format!("/api/v1/me/sessions/{current}"),
            &alice,
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["current"], true,
        "告诉页面这是当前设备,页面要跳去登录"
    );
    assert!(!site.still_signed_in(&alice).await);
}

// ------------------------------------------------------------------ 账号注销

fn json_body(value: Value) -> Option<Vec<u8>> {
    Some(value.to_string().into_bytes())
}

async fn request_deletion(site: &Site, who: &Who, password: &str) -> (StatusCode, Value) {
    let (status, _, body) = site
        .send(
            Method::POST,
            "/api/v1/me/deletion",
            who,
            json_body(json!({ "password": password })),
            &[("content-type", "application/json")],
        )
        .await;
    (status, body)
}

#[tokio::test]
async fn deleting_an_account_needs_the_password_and_starts_a_cooling_off_period() {
    let site = site().await;
    let _admin = site.user("boss").await; // 第一个用户接管主知识库,让下面的 alice 是普通用户
    let alice = site.user("alice").await;
    let (status, body) = request_deletion(&site, &alice, "wrong password!").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["message"], "密码不正确");
    assert!(
        site.state
            .system
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .delete_after
            .is_none(),
        "密码错就什么都不能发生"
    );

    let before = kb_web::auth::session::now_millis();
    let (status, body) = request_deletion(&site, &alice, "correct horse battery").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let until = body["data"]["delete_after"].as_i64().unwrap();
    let week = 7 * 86_400_000;
    assert!(
        until >= before + week && until <= before + week + 60_000,
        "默认 7 天:{until}"
    );

    // 冷静期内:仍然在线、auth/me 告诉页面期限
    let (status, _, me) = site
        .raw(Method::GET, "/api/v1/auth/me", Some(&alice), None, &[])
        .await;
    assert_eq!(status, StatusCode::OK, "冷静期内账号仍可使用");
    assert_eq!(me["data"]["user"]["delete_after"], until);
    assert_eq!(me["data"]["user"]["status"], "deleting");
    // 可以重新登录(否则没法撤销)
    let again = site.login_again("alice", MAC_CHROME).await;
    assert!(site.still_signed_in(&again).await);
}

#[tokio::test]
async fn asking_twice_keeps_the_original_deadline() {
    let site = site().await;
    let _boss = site.user("boss").await;
    let alice = site.user("alice").await;
    let (_, first) = request_deletion(&site, &alice, "correct horse battery").await;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let (_, second) = request_deletion(&site, &alice, "correct horse battery").await;
    assert_eq!(
        first["data"]["delete_after"],
        second["data"]["delete_after"]
    );
}

#[tokio::test]
async fn the_cooling_off_length_follows_the_admin_setting_and_is_never_zero() {
    let site = site().await;
    let _boss = site.user("boss").await;
    let (alice, bob) = (site.user("alice").await, site.user("bob").await);
    let mut config = (*site.state.account.config.get()).clone();
    config.accounts.deletion_cooling_off_days = 3;
    site.state.account.config.replace(config.clone());
    let before = kb_web::auth::session::now_millis();
    let (_, body) = request_deletion(&site, &alice, "correct horse battery").await;
    let days = (body["data"]["delete_after"].as_i64().unwrap() - before) / 86_400_000;
    assert_eq!(days, 3, "管理员改成 3 天就是 3 天");
    // 管理员手滑写了 0:按 1 天算,不能让用户一点反悔的机会都没有
    config.accounts.deletion_cooling_off_days = 0;
    site.state.account.config.replace(config);
    let before = kb_web::auth::session::now_millis();
    let (_, body) = request_deletion(&site, &bob, "correct horse battery").await;
    let ms = body["data"]["delete_after"].as_i64().unwrap() - before;
    assert!((86_400_000..86_400_000 + 60_000).contains(&ms), "{ms}");
}

#[tokio::test]
async fn cancelling_brings_the_account_back_and_only_works_while_deleting() {
    let site = site().await;
    let _boss = site.user("boss").await;
    let alice = site.user("alice").await;
    let cancel = || site.send(Method::DELETE, "/api/v1/me/deletion", &alice, None, &[]);
    let (status, _, body) = cancel().await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "没在注销中就撤销:{body}");
    request_deletion(&site, &alice, "correct horse battery").await;
    let (status, _, body) = cancel().await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, _, me) = site
        .raw(Method::GET, "/api/v1/auth/me", Some(&alice), None, &[])
        .await;
    assert_eq!(me["data"]["user"]["status"], "active");
    assert!(me["data"]["user"]["delete_after"].is_null());
}

#[tokio::test]
async fn the_owner_of_the_primary_space_and_the_last_admin_cannot_delete_themselves() {
    let site = site().await;
    // 第一个管理员接管主知识库(数据根目录本身),此时也是唯一的管理员
    let boss = site.admin_user("boss").await;
    let (status, body) = request_deletion(&site, &boss, "correct horse battery").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("主知识库"),
        "{body}"
    );
    // 再来一个管理员:「最后一个管理员」这条帮不上忙了,主知识库这条仍然拦着 boss
    let second = site.admin_user("second").await;
    let (status, body) = request_deletion(&site, &boss, "correct horse battery").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "有第二个管理员也一样:{body}");
    // 第二个管理员没有主知识库,可以注销
    let (status, body) = request_deletion(&site, &second, "correct horse battery").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        site.state
            .system
            .get_user(&boss.id)
            .await
            .unwrap()
            .unwrap()
            .status,
        kb_core::account::UserStatus::Active
    );
}

#[tokio::test]
async fn wrong_passwords_share_one_rate_limit_with_changing_the_password() {
    let site = site().await;
    let _boss = site.user("boss").await;
    let alice = site.user("alice").await;
    // 先在「改密码」那边输错 4 次,再来「注销」输错 1 次:合计 5 次就该被挡
    for _ in 0..4 {
        let (status, ..) = site
            .send(
                Method::POST,
                "/api/v1/auth/change-password",
                &alice,
                json_body(
                    json!({ "old_password": "nope nope nope", "new_password": "Brand-New-Pass-1" }),
                ),
                &[("content-type", "application/json")],
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    assert_eq!(
        request_deletion(&site, &alice, "still wrong 1").await.0,
        StatusCode::BAD_REQUEST
    );
    let (status, body) = request_deletion(&site, &alice, "correct horse battery").await;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "两个入口共用一个桶,正确密码也要先等:{body}"
    );
    assert!(
        site.state
            .system
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .delete_after
            .is_none()
    );
}

#[tokio::test]
async fn only_a_browser_session_with_the_csrf_header_can_ask_for_deletion() {
    let site = site().await;
    let _boss = site.user("boss").await;
    let alice = site.user("alice").await;
    let token = site.token_of(&alice).await;
    let body = json_body(json!({ "password": "correct horse battery" }));
    let (status, ..) = site
        .send(
            Method::POST,
            "/api/v1/me/deletion",
            &token,
            body.clone(),
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "API 令牌不能注销账号");
    let (status, ..) = site
        .raw(
            Method::POST,
            "/api/v1/me/deletion",
            None,
            body.clone(),
            &[("x-kb-csrf", "1"), ("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, ..) = site
        .raw(
            Method::POST,
            "/api/v1/me/deletion",
            Some(&alice),
            body,
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "没带 CSRF 头");
    assert!(
        site.state
            .system
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .delete_after
            .is_none()
    );
}

impl Site {
    /// 等后台发信任务把邮件送进发信箱。
    async fn wait_for_mail(&self, count: usize) -> Vec<kb_mail::Outgoing> {
        for _ in 0..100 {
            if self.sent.lock().unwrap().len() >= count {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        self.sent
            .lock()
            .unwrap()
            .iter()
            .map(|(_, mail)| mail.clone())
            .collect()
    }
}

#[tokio::test]
async fn requesting_deletion_emails_the_owner_so_a_hijacked_session_cannot_do_it_silently() {
    let site = site_with_mail().await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let (status, body) = request_deletion(&site, &alice, "correct horse battery").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mails = site.wait_for_mail(1).await;
    assert_eq!(mails.len(), 1, "恰好一封通知");
    assert_eq!(mails[0].to, "alice@example.com");
    assert!(
        mails[0].body.contains("永久删除") && mails[0].body.contains("(UTC+8)"),
        "{}",
        mails[0].body
    );
    // 密码错的申请不会发信(也就不会被人用来骚扰别人的邮箱)
    let bob = site.user("bob").await;
    let (status, _) = request_deletion(&site, &bob, "wrong password!").await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(site.sent.lock().unwrap().len(), 1, "失败的申请不该发信");
    // 重复申请(已在冷静期):不再重复发
    let again = request_deletion(&site, &alice, "correct horse battery").await;
    assert_eq!(again.0, StatusCode::OK);
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(
        site.sent.lock().unwrap().len(),
        1,
        "重复申请(已在冷静期)不该再发,免得原主人的邮箱被刷屏"
    );
}

#[tokio::test]
async fn a_site_without_mail_still_accepts_the_request() {
    let site = site().await; // 邮件没开
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let (status, body) = request_deletion(&site, &alice, "correct horse battery").await;
    assert_eq!(status, StatusCode::OK, "邮件没配好不能挡住注销:{body}");
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(site.sent.lock().unwrap().is_empty());
}

// ------------------------------------------------------------------ 更换邮箱

fn find_code(text: &str) -> Option<String> {
    let mut run = String::new();
    for ch in text.chars().chain(std::iter::once(' ')) {
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

async fn ask_email_code(
    site: &Site,
    who: &Who,
    new_email: &str,
    password: &str,
) -> (StatusCode, Value) {
    let (status, _, body) = site
        .send(
            Method::POST,
            "/api/v1/me/email-code",
            who,
            json_body(json!({ "new_email": new_email, "password": password })),
            &[("content-type", "application/json")],
        )
        .await;
    (status, body)
}

async fn confirm_email(site: &Site, who: &Who, new_email: &str, code: &str) -> (StatusCode, Value) {
    let (status, _, body) = site
        .send(
            Method::POST,
            "/api/v1/me/email",
            who,
            json_body(json!({ "new_email": new_email, "code": code })),
            &[("content-type", "application/json")],
        )
        .await;
    (status, body)
}

const PW: &str = "correct horse battery";

#[tokio::test]
async fn changing_the_email_sends_the_code_to_the_new_address_and_a_notice_to_the_old_one() {
    let site = site_with_mail().await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let (status, body) = ask_email_code(&site, &alice, "Alice.New@Example.com", PW).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let mails = site.wait_for_mail(1).await;
    assert_eq!(
        mails[0].to, "alice.new@example.com",
        "验证码发到新邮箱(已规范成小写),不是旧的"
    );
    let code = find_code(&mails[0].body).expect("邮件里要有验证码");
    // 还没确认:邮箱没变
    assert_eq!(
        site.state
            .system
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .email
            .as_deref(),
        Some("alice@example.com")
    );

    let (status, body) = confirm_email(&site, &alice, "alice.new@example.com", &code).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let user = site
        .state
        .system
        .get_user(&alice.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(user.email.as_deref(), Some("alice.new@example.com"));
    assert!(
        user.email_verified_at.is_some(),
        "刚用验证码证明过,直接是已验证"
    );
    // 旧邮箱收到通知,新地址是脱敏的
    let mails = site.wait_for_mail(2).await;
    let notice = mails
        .iter()
        .find(|mail| mail.to == "alice@example.com")
        .expect("旧邮箱的通知");
    assert!(
        notice.body.contains("a***@example.com") && !notice.body.contains("alice.new@"),
        "{}",
        notice.body
    );
    // 之后用新邮箱能登录,旧邮箱不能
    let (status, ..) = site
        .raw(
            Method::POST,
            "/api/v1/auth/login",
            None,
            json_body(json!({ "login": "alice.new@example.com", "password": PW })),
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, ..) = site
        .raw(
            Method::POST,
            "/api/v1/auth/login",
            None,
            json_body(json!({ "login": "alice@example.com", "password": PW })),
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "旧邮箱不再是登录名");
    // 验证码用过即失效
    let (status, _) = confirm_email(&site, &alice, "alice.new@example.com", &code).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn the_password_is_required_and_a_wrong_one_sends_nothing() {
    let site = site_with_mail().await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let (status, body) =
        ask_email_code(&site, &alice, "other@example.com", "wrong password!").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["message"], "密码不正确");
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(
        site.sent.lock().unwrap().is_empty(),
        "密码不对不能发信(否则会话被盗的人能拿它骚扰别人的邮箱)"
    );
}

#[tokio::test]
async fn a_code_issued_for_one_person_is_useless_to_anyone_else() {
    let site = site_with_mail().await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let bob = site.user("bob").await;
    // alice 申请换到 shared@:验证码发到 shared@
    ask_email_code(&site, &alice, "shared@example.com", PW).await;
    let code = find_code(&site.wait_for_mail(1).await[0].body).unwrap();
    // bob 拿到了这个验证码(比如 shared@ 的主人把它转给了他),想把自己的邮箱也换成 shared@
    let (status, _) = confirm_email(&site, &bob, "shared@example.com", &code).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "验证码绑定了申请人,别人拿着也没用"
    );
    assert_eq!(
        site.state
            .system
            .get_user(&bob.id)
            .await
            .unwrap()
            .unwrap()
            .email
            .as_deref(),
        Some("bob@example.com")
    );
    // alice 自己仍然可以用
    let (status, body) = confirm_email(&site, &alice, "shared@example.com", &code).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn a_code_for_one_address_cannot_be_used_for_another() {
    let site = site_with_mail().await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    ask_email_code(&site, &alice, "mine@example.com", PW).await;
    let code = find_code(&site.wait_for_mail(1).await[0].body).unwrap();
    // 拿「我自己新邮箱」的验证码,去换别的地址
    let (status, _) = confirm_email(&site, &alice, "someone.else@example.com", &code).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        site.state
            .system
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .email
            .as_deref(),
        Some("alice@example.com")
    );
}

#[tokio::test]
async fn registration_and_password_reset_codes_cannot_pose_as_an_email_change_code() {
    let site = site_with_mail().await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let pepper = kb_web::signup::pepper_of(site.state.system.as_ref())
        .await
        .unwrap();
    // 手工给「alice|target@」这个键签发一个注册用途、一个找回密码用途的验证码
    let key = format!("{}|target@example.com", alice.id);
    for purpose in [
        kb_core::account::EmailPurpose::Register,
        kb_core::account::EmailPurpose::Reset,
    ] {
        let hash = kb_core::account::hash_code(&pepper, purpose.as_str(), &key, "424242");
        site.state
            .system
            .issue_email_code(
                &key,
                purpose,
                &hash,
                None,
                600_000,
                kb_meta::system::CodeLimits::default(),
                kb_web::auth::session::now_millis(),
            )
            .await
            .unwrap();
    }
    let (status, _) = confirm_email(&site, &alice, "target@example.com", "424242").await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "别的用途的验证码不能拿来换邮箱"
    );
}

#[tokio::test]
async fn an_address_that_belongs_to_someone_else_looks_the_same_but_never_gets_a_code() {
    let site = site_with_mail().await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let _bob = site.user("bob").await;
    let (status, body) = ask_email_code(&site, &alice, "bob@example.com", PW).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "回答和别的地址一样,不泄露 bob@ 注册过:{body}"
    );
    let mails = site.wait_for_mail(1).await;
    assert_eq!(mails[0].to, "bob@example.com");
    assert!(
        find_code(&mails[0].body).is_none(),
        "发的是「已被注册」提醒,没有验证码:{}",
        mails[0].body
    );
    // 因此怎么试都换不成
    for guess in ["000000", "123456"] {
        let (status, _) = confirm_email(&site, &alice, "bob@example.com", guess).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    assert_eq!(
        site.state
            .system
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .email
            .as_deref(),
        Some("alice@example.com")
    );
}

#[tokio::test]
async fn an_address_taken_after_the_code_was_sent_is_refused_at_the_end() {
    let site = site_with_mail().await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    ask_email_code(&site, &alice, "race@example.com", PW).await;
    let code = find_code(&site.wait_for_mail(1).await[0].body).unwrap();
    // 在 alice 输入验证码之前,别人用 race@ 注册了账号
    let carol = site.user("carol").await;
    site.state
        .system
        .update_user(
            &carol.id,
            kb_meta::system::UserUpdate {
                email: Some(Some("race@example.com".into())),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let (status, body) = confirm_email(&site, &alice, "race@example.com", &code).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(
        site.state
            .system
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .email
            .as_deref(),
        Some("alice@example.com")
    );
}

#[tokio::test]
async fn five_wrong_codes_burn_the_code_even_for_the_right_answer() {
    let site = site_with_mail().await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    ask_email_code(&site, &alice, "burn@example.com", PW).await;
    let code = find_code(&site.wait_for_mail(1).await[0].body).unwrap();
    let wrong = if code == "000000" { "111111" } else { "000000" };
    for _ in 0..5 {
        let (status, _) = confirm_email(&site, &alice, "burn@example.com", wrong).await;
        assert!(status == StatusCode::BAD_REQUEST || status == StatusCode::TOO_MANY_REQUESTS);
    }
    let (status, _) = confirm_email(&site, &alice, "burn@example.com", &code).await;
    assert_ne!(status, StatusCode::OK, "试错 5 次后正确答案也不行");
    assert_eq!(
        site.state
            .system
            .get_user(&alice.id)
            .await
            .unwrap()
            .unwrap()
            .email
            .as_deref(),
        Some("alice@example.com")
    );
}

#[tokio::test]
async fn email_change_needs_a_browser_session_working_mail_and_a_different_address() {
    let on = site_with_mail().await;
    let _boss = on.admin_user("boss").await;
    let alice = on.user("alice").await;
    let token = on.token_of(&alice).await;
    let (status, _) = ask_email_code(&on, &token, "x@example.com", PW).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "API 令牌不能换邮箱");
    let (status, ..) = on
        .raw(
            Method::POST,
            "/api/v1/me/email-code",
            Some(&alice),
            json_body(json!({ "new_email": "x@example.com", "password": PW })),
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "没带 CSRF 头");
    let (status, body) = ask_email_code(&on, &alice, "alice@example.com", PW).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "换成现在的邮箱没有意义:{body}"
    );
    let (status, _) = ask_email_code(&on, &alice, "not-an-email", PW).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // 邮件功能没开:明确说不可用,而不是假装发了
    let off = site().await;
    let _boss = off.admin_user("boss").await;
    let dave = off.user("dave").await;
    let (status, body) = ask_email_code(&off, &dave, "x@example.com", PW).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
}

#[tokio::test]
async fn nobody_can_bomb_one_mailbox_by_rotating_accounts() {
    let site = site_with_mail().await;
    let _boss = site.admin_user("boss").await;
    let mut ok = 0;
    for n in 0..8 {
        let user = site.user(&format!("sender{n}")).await;
        let (status, _) = ask_email_code(&site, &user, "victim@example.com", PW).await;
        if status == StatusCode::OK {
            ok += 1;
        } else {
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        }
    }
    assert_eq!(
        ok, 5,
        "同一个被换上去的邮箱,每分钟最多收 5 封,无论用多少个账号轮流要"
    );
}

// ------------------------------------------------------------------ 个人数据导出(HTTP 面)

mod export_http {
    use std::path::PathBuf;
    use std::sync::Mutex;

    use async_trait::async_trait;
    use kb_core::model::Millis;
    use kb_core::{KbError, Result};
    use kb_web::export_api::{ExportStatus, PersonalExport};

    /// 假的导出实现:记录每次调用的用户 id,返回事先设好的东西。
    #[derive(Default)]
    pub struct Fake {
        pub calls: Mutex<Vec<(String, String, Option<String>)>>,
        pub status: Mutex<Option<ExportStatus>>,
        pub file: Mutex<Option<(PathBuf, String)>>,
        pub start_error: Mutex<Option<KbError>>,
    }

    #[async_trait]
    impl PersonalExport for Fake {
        async fn start(
            &self,
            user_id: &str,
            space_id: Option<&str>,
            _: Millis,
        ) -> Result<ExportStatus> {
            self.calls.lock().unwrap().push((
                "start".into(),
                user_id.into(),
                space_id.map(str::to_owned),
            ));
            match self.start_error.lock().unwrap().take() {
                Some(err) => Err(err),
                None => Ok(ExportStatus::Running {
                    bytes_done: 0,
                    bytes_total: 10,
                    files: 1,
                    notes: 0,
                }),
            }
        }
        async fn status(&self, user_id: &str, _: Millis) -> Result<ExportStatus> {
            self.calls
                .lock()
                .unwrap()
                .push(("status".into(), user_id.into(), None));
            Ok(self
                .status
                .lock()
                .unwrap()
                .clone()
                .unwrap_or(ExportStatus::Idle { today_left: 3 }))
        }
        async fn file(&self, user_id: &str, _: Millis) -> Result<Option<(PathBuf, String)>> {
            self.calls
                .lock()
                .unwrap()
                .push(("file".into(), user_id.into(), None));
            Ok(self.file.lock().unwrap().clone())
        }
        async fn discard(&self, user_id: &str) -> Result<()> {
            self.calls
                .lock()
                .unwrap()
                .push(("discard".into(), user_id.into(), None));
            Ok(())
        }
    }
}

#[tokio::test]
async fn the_export_endpoints_act_for_the_logged_in_person_and_nobody_else() {
    let fake = Arc::new(export_http::Fake::default());
    let site = site_with_exports(fake.clone()).await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let (status, _, body) = site
        .send(Method::POST, "/api/v1/me/export", &alice, None, &[])
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["state"], "running");
    let (_, _, body) = site
        .raw(Method::GET, "/api/v1/me/export", Some(&alice), None, &[])
        .await;
    assert_eq!(body["data"]["state"], "idle");
    assert_eq!(body["data"]["today_left"], 3);
    site.send(Method::DELETE, "/api/v1/me/export", &alice, None, &[])
        .await;
    // 每次调用传的都是会话里的 alice,以及她的知识库 id;请求里没有任何地方能指定「别人」
    let calls = fake.calls.lock().unwrap().clone();
    assert_eq!(calls.len(), 3);
    for (_, user, _) in &calls {
        assert_eq!(user, &alice.id);
    }
    assert!(
        calls[0]
            .2
            .as_deref()
            .is_some_and(|space| space.starts_with("sp_")),
        "{calls:?}"
    );
    // 就算在查询串里写了别人的 id,也不会生效
    let bob = site.user("bob").await;
    site.raw(
        Method::GET,
        &format!("/api/v1/me/export?user={}&user_id={}", bob.id, bob.id),
        Some(&alice),
        None,
        &[],
    )
    .await;
    assert_eq!(fake.calls.lock().unwrap().last().unwrap().1, alice.id);
}

#[tokio::test]
async fn exports_need_a_browser_session_and_the_csrf_header() {
    let fake = Arc::new(export_http::Fake::default());
    let site = site_with_exports(fake.clone()).await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let token = site.token_of(&alice).await;
    for (method, path) in [
        (Method::POST, "/api/v1/me/export"),
        (Method::GET, "/api/v1/me/export"),
        (Method::GET, "/api/v1/me/export/download"),
        (Method::DELETE, "/api/v1/me/export"),
    ] {
        let (status, ..) = site.send(method.clone(), path, &token, None, &[]).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "API 令牌不能导出:{method} {path}"
        );
        let (status, ..) = site
            .raw(method.clone(), path, None, None, &[("x-kb-csrf", "1")])
            .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
    }
    // 写操作没带 CSRF 头
    let (status, ..) = site
        .raw(Method::POST, "/api/v1/me/export", Some(&alice), None, &[])
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, ..) = site
        .raw(Method::DELETE, "/api/v1/me/export", Some(&alice), None, &[])
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(
        fake.calls.lock().unwrap().is_empty(),
        "被拒绝的请求一次都不能到达导出实现"
    );
}

#[tokio::test]
async fn the_download_is_streamed_as_an_attachment_with_no_caching() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("usr_x-0123456789abcdef.tar.gz");
    // 300 KB 的内容,比一块(64 KiB)大得多,确认流式发送不会丢字节
    let content: Vec<u8> = (0..300_000u32).map(|n| (n % 251) as u8).collect();
    std::fs::write(&file, &content).unwrap();
    let fake = Arc::new(export_http::Fake::default());
    *fake.file.lock().unwrap() = Some((file, "usr_x-0123456789abcdef.tar.gz".to_owned()));
    let site = site_with_exports(fake).await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let (status, headers, bytes) = site
        .raw_bytes(
            Method::GET,
            "/api/v1/me/export/download",
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes, content, "字节一个不差");
    assert_eq!(headers[header::CONTENT_TYPE], "application/gzip");
    assert_eq!(
        headers[header::CONTENT_DISPOSITION],
        "attachment; filename=\"usr_x-0123456789abcdef.tar.gz\""
    );
    assert_eq!(headers[header::CONTENT_LENGTH], "300000");
    assert_eq!(headers[header::CACHE_CONTROL], "private, no-store");
    assert_eq!(headers[header::X_CONTENT_TYPE_OPTIONS], "nosniff");
}

#[tokio::test]
async fn a_download_with_nothing_ready_or_a_vanished_file_is_a_plain_404() {
    let fake = Arc::new(export_http::Fake::default());
    let site = site_with_exports(fake.clone()).await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let (status, ..) = site
        .raw_bytes(
            Method::GET,
            "/api/v1/me/export/download",
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "还没有导出");
    // 状态里说有文件,但磁盘上已经没了(被清理任务删了)
    *fake.file.lock().unwrap() = Some((
        PathBuf::from("/nonexistent/usr_x-0123456789abcdef.tar.gz"),
        "usr_x-0123456789abcdef.tar.gz".to_owned(),
    ));
    let (status, ..) = site
        .raw_bytes(
            Method::GET,
            "/api/v1/me/export/download",
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_download_file_name_header_cannot_be_used_to_inject_anything() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("f.tar.gz");
    std::fs::write(&file, b"x").unwrap();
    let fake = Arc::new(export_http::Fake::default());
    // 假设实现被攻破 / 出 bug,给了一个带引号、换行、路径分隔符的文件名
    *fake.file.lock().unwrap() = Some((
        file,
        "evil\"; filename=\"x\r\nSet-Cookie: pwn=1/../../a.tar.gz".to_owned(),
    ));
    let site = site_with_exports(fake).await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    let (status, headers, _) = site
        .raw_bytes(
            Method::GET,
            "/api/v1/me/export/download",
            Some(&alice),
            None,
            &[],
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let disposition = headers[header::CONTENT_DISPOSITION].to_str().unwrap();
    assert!(
        !disposition.contains('\r')
            && !disposition.contains('\n')
            && !disposition.contains('/')
            && disposition.matches('"').count() == 2,
        "{disposition}"
    );
    assert!(
        headers.get(header::SET_COOKIE).is_none(),
        "文件名不能注入别的响应头"
    );
}

#[tokio::test]
async fn errors_from_the_exporter_become_clear_http_answers() {
    let fake = Arc::new(export_http::Fake::default());
    let site = site_with_exports(fake.clone()).await;
    let _boss = site.admin_user("boss").await;
    let alice = site.user("alice").await;
    for (error, wanted) in [
        (
            kb_core::KbError::Exists("已经有一个导出在进行中".into()),
            StatusCode::CONFLICT,
        ),
        (
            kb_core::KbError::Forbidden("今天已经导出 3 次了,请明天再试".into()),
            StatusCode::FORBIDDEN,
        ),
        (
            kb_core::KbError::Unavailable("服务器磁盘空间不足".into()),
            StatusCode::SERVICE_UNAVAILABLE,
        ),
        (
            kb_core::KbError::NotFound("你还没有知识库".into()),
            StatusCode::NOT_FOUND,
        ),
    ] {
        *fake.start_error.lock().unwrap() = Some(error);
        let (status, _, body) = site
            .send(Method::POST, "/api/v1/me/export", &alice, None, &[])
            .await;
        assert_eq!(status, wanted, "{body}");
        assert!(
            body["error"]["message"]
                .as_str()
                .is_some_and(|text| !text.is_empty())
        );
    }
}

// ---------------------------------------------------------------- 界面偏好

#[tokio::test]
async fn prefs_round_trip_and_stay_per_person() {
    let site = site().await;
    let alice = site.user("alice").await;
    let bob = site.user("bob").await;
    let (status, _, body) = site
        .raw(Method::GET, "/api/v1/me/prefs", Some(&alice), None, &[])
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["prefs"], json!({}), "没存过是空对象");

    let prefs = json!({ "ui": { "sidebar": "rail", "sidebarWidth": 232, "density": "compact" } });
    let (status, _, body) = site
        .send(
            Method::PUT,
            "/api/v1/me/prefs",
            &alice,
            Some(json!({ "prefs": prefs }).to_string().into_bytes()),
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (_, _, body) = site
        .raw(Method::GET, "/api/v1/me/prefs", Some(&alice), None, &[])
        .await;
    assert_eq!(body["data"]["prefs"], prefs);
    // 另一个人看到的还是空的:偏好不会串
    let (_, _, body) = site
        .raw(Method::GET, "/api/v1/me/prefs", Some(&bob), None, &[])
        .await;
    assert_eq!(body["data"]["prefs"], json!({}));
}

#[tokio::test]
async fn prefs_need_a_browser_session_and_csrf() {
    let site = site().await;
    let alice = site.user("alice").await;
    let put_body = json!({ "prefs": { "ui": {} } }).to_string().into_bytes();
    // 没登录
    let (status, _, _) = site
        .raw(Method::GET, "/api/v1/me/prefs", None, None, &[])
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // 令牌不是界面
    let token = site.token_of(&alice).await;
    let (status, _, _) = site
        .raw(Method::GET, "/api/v1/me/prefs", Some(&token), None, &[])
        .await;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED,
        "令牌读偏好应被拒绝,实际 {status}"
    );
    let (status, _, _) = site
        .send(
            Method::PUT,
            "/api/v1/me/prefs",
            &token,
            Some(put_body.clone()),
            &[("content-type", "application/json")],
        )
        .await;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::UNAUTHORIZED,
        "令牌写偏好应被拒绝,实际 {status}"
    );
    // 缺 CSRF 头的写请求被拒绝,且什么都没写进去
    let (status, _, _) = site
        .raw(
            Method::PUT,
            "/api/v1/me/prefs",
            Some(&alice),
            Some(put_body),
            &[("content-type", "application/json")],
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(
        site.state.system.get_prefs(&alice.id).await.unwrap(),
        json!({})
    );
}

#[tokio::test]
async fn prefs_reject_bad_shapes_without_touching_the_old_value() {
    let site = site().await;
    let alice = site.user("alice").await;
    let keep = json!({ "ui": { "sidebar": "hidden" } });
    site.state
        .system
        .set_prefs(&alice.id, &keep, 1)
        .await
        .unwrap();
    for bad in [
        json!({ "prefs": [1, 2] }),
        json!({ "prefs": "x" }),
        json!({ "prefs": null }),
        json!({ "prefs": { "k": "x".repeat(kb_meta::system::MAX_PREFS_BYTES) } }),
    ] {
        let (status, _, body) = site
            .send(
                Method::PUT,
                "/api/v1/me/prefs",
                &alice,
                Some(bad.to_string().into_bytes()),
                &[("content-type", "application/json")],
            )
            .await;
        assert!(
            status == StatusCode::BAD_REQUEST || status == StatusCode::UNPROCESSABLE_ENTITY,
            "{bad:.80}: {status} {body}"
        );
    }
    assert_eq!(site.state.system.get_prefs(&alice.id).await.unwrap(), keep);
}
