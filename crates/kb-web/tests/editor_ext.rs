//! 编辑器扩展加载器的 HTTP 验收。
//!
//! 重点是三件事:谁能读(只有管理员)、开关(默认关、热更新)、文件接口出不了扩展目录
//! (`../`、编码绕过、符号链接)。清单校验与路径函数的细节在 `src/editor_ext.rs` 的单元测试里。

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserStatus};
use kb_core::config::{Config, ConfigStore};
use kb_web::AppState;
use kb_web::signup::AccountDeps;
use kb_web::source::SocketKind;
use serde_json::{Value, json};
use tower::ServiceExt;

const MANIFEST: &str = r#"
id = "kb.demo"
name = "演示扩展"
version = "1.0.0"
api_version = 1
permissions = ["document.read", "ui"]

[[contributes.commands]]
id = "kb.demo.run"
title = "运行"
"#;

struct Site {
    state: Arc<AppState>,
    config: Arc<ConfigStore>,
    /// 临时目录(数据根目录);析构时整棵删除
    home: tempfile::TempDir,
}

#[derive(Clone)]
struct Who {
    cookie: Option<String>,
    bearer: Option<String>,
}

impl Site {
    /// `extensions` = `[editor] extensions` 开关;`dir` = `[editor] extensions_dir`。
    async fn new(extensions: bool, dir: Option<&str>) -> Self {
        let mut config = Config::default();
        config.editor.extensions = extensions;
        config.editor.extensions_dir = dir.map(str::to_owned);
        let config = Arc::new(ConfigStore::new(config));
        let home = tempfile::tempdir().expect("目录");
        let meta =
            Arc::new(kb_meta::SqliteMetaStore::open(home.path().join("meta.db")).expect("meta"));
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
            system: Arc::new(
                kb_meta::SystemStore::open(home.path().join("system.db")).expect("账号库"),
            ),
            principals: kb_web::auth::PrincipalCache::default(),
            account: AccountDeps {
                config: config.clone(),
                mailer: Arc::new(kb_mail::Mailer::new(Box::new(
                    kb_mail::MemoryTransport::default(),
                ))),
                passwords: Arc::new(kb_mail::Passwords::default),
                limiter: Arc::new(kb_web::auth::ratelimit::LoginLimiter::new()),
                avatars_dir: home.path().join("avatars"),
                home: home.path().to_path_buf(),
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
        Self {
            state,
            config,
            home,
        }
    }

    /// 默认位置 `<KB_HOME>/editor-extensions`。
    fn ext_root(&self) -> PathBuf {
        self.home.path().join("editor-extensions")
    }

    /// 在 `root` 下放一个合法扩展 `kb.demo`,再在 `root` 的上一级放一个不该被读到的机密文件。
    fn install_demo(root: &Path) {
        let ext = root.join("kb.demo");
        std::fs::create_dir_all(ext.join("lib")).unwrap();
        std::fs::write(ext.join("manifest.toml"), MANIFEST).unwrap();
        std::fs::write(ext.join("index.js"), "export default { activate() {} }\n").unwrap();
        std::fs::write(ext.join("lib/util.js"), "export const n = 1\n").unwrap();
        std::fs::write(ext.join("style.css"), "a{color:red}").unwrap();
        std::fs::write(ext.join("data.json"), "{\"a\":1}").unwrap();
        std::fs::write(
            ext.join("icon.svg"),
            "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
        )
        .unwrap();
        std::fs::write(root.join("secret.js"), "SECRET").unwrap();
        std::fs::write(root.parent().unwrap().join("secret.js"), "SECRET").unwrap();
    }

    async fn login(&self, name: &str, role: &str) -> Who {
        let hash = kb_web::auth::password::hash_password("correct horse battery").unwrap();
        self.state
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
        let (status, headers, _) = self
            .send(
                Method::POST,
                "/api/v1/auth/login",
                None,
                Some(json!({ "login": name, "password": "correct horse battery" }).to_string()),
                SocketKind::Tcp,
            )
            .await;
        assert_eq!(status, StatusCode::OK);
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
        }
    }

    async fn admin(&self) -> Who {
        self.login("boss", ROLE_ADMIN).await
    }

    /// 管理员给自己建一个 API 令牌:令牌是给程序用的,不该能取扩展代码。
    async fn api_token_of(&self, who: &Who) -> Who {
        let request = json!({ "name": "t", "scope": "api" }).to_string();
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri("/api/v1/auth/tokens")
            .header(header::HOST, "kb.test")
            .header("x-kb-csrf", "1")
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(cookie) = &who.cookie {
            builder = builder.header(header::COOKIE, format!("kb_session={cookie}"));
        }
        let mut request = builder.body(Body::from(request)).unwrap();
        request
            .extensions_mut()
            .insert(ConnectInfo("127.0.0.1:4000".parse::<SocketAddr>().unwrap()));
        let response = kb_web::build(self.state.clone(), SocketKind::Tcp)
            .oneshot(request)
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        Who {
            cookie: None,
            bearer: Some(body["data"]["token"].as_str().expect("明文令牌").to_owned()),
        }
    }

    async fn send(
        &self,
        method: Method,
        path: &str,
        who: Option<&Who>,
        body: Option<String>,
        kind: SocketKind,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        let mut builder = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "kb.test");
        if body.is_some() {
            builder = builder
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-kb-csrf", "1");
        }
        if let Some(who) = who {
            if let Some(cookie) = &who.cookie {
                builder = builder.header(header::COOKIE, format!("kb_session={cookie}"));
            }
            if let Some(token) = &who.bearer {
                builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
            }
        }
        let mut request = builder
            .body(Body::from(body.unwrap_or_default()))
            .expect("请求");
        request
            .extensions_mut()
            .insert(ConnectInfo("127.0.0.1:4000".parse::<SocketAddr>().unwrap()));
        let response = kb_web::build(self.state.clone(), kind)
            .oneshot(request)
            .await
            .expect("响应");
        let (status, headers) = (response.status(), response.headers().clone());
        let bytes = axum::body::to_bytes(response.into_body(), 16 << 20)
            .await
            .expect("体");
        (status, headers, bytes.to_vec())
    }

    async fn get(
        &self,
        path: &str,
        who: Option<&Who>,
    ) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        self.send(Method::GET, path, who, None, SocketKind::Tcp)
            .await
    }

    async fn list(&self, who: Option<&Who>) -> (StatusCode, Value) {
        let (status, _, bytes) = self.get("/api/v1/editor/extensions", who).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[tokio::test]
async fn the_switch_is_off_by_default_and_the_list_says_so() {
    let site = Site::new(false, None).await;
    Site::install_demo(&site.ext_root());
    let admin = site.admin().await;

    let (status, body) = site.list(Some(&admin)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["enabled"], false);
    assert_eq!(
        body["data"]["extensions"],
        json!([]),
        "关着时连目录里有什么都不暴露"
    );
    assert!(body["data"].get("dir").is_none());

    // 文件接口:关着就当不存在,脚本拿不到
    let (status, _, bytes) = site
        .get("/api/v1/editor/extensions/kb.demo/index.js", Some(&admin))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{}", text(&bytes));
}

#[tokio::test]
async fn the_list_has_the_documented_shape_and_validates_each_manifest() {
    let site = Site::new(true, None).await;
    Site::install_demo(&site.ext_root());
    // 一个坏扩展:清单里 api_version 太新
    let bad = site.ext_root().join("kb.future");
    std::fs::create_dir_all(&bad).unwrap();
    std::fs::write(
        bad.join("manifest.toml"),
        "id = \"kb.future\"\nname = \"f\"\nversion = \"1.0.0\"\napi_version = 2\n",
    )
    .unwrap();
    let admin = site.admin().await;

    let (status, body) = site.list(Some(&admin)).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["ok"], true);
    assert_eq!(body["data"]["enabled"], true);
    assert_eq!(body["data"]["dir"], site.ext_root().display().to_string());
    let list = body["data"]["extensions"].as_array().expect("数组");
    assert_eq!(list.len(), 2);

    let demo = list
        .iter()
        .find(|item| item["id"] == "kb.demo")
        .expect("demo");
    assert_eq!(demo["dir"], "kb.demo");
    assert_eq!(demo["error"], Value::Null);
    let manifest = &demo["manifest"];
    assert_eq!(manifest["name"], "演示扩展");
    assert_eq!(manifest["version"], "1.0.0");
    assert_eq!(manifest["api_version"], 1);
    assert_eq!(manifest["entry"], "index.js");
    assert_eq!(manifest["permissions"], json!(["document.read", "ui"]));
    assert_eq!(
        manifest["contributes"]["commands"],
        json!([{ "id": "kb.demo.run", "title": "运行" }])
    );
    assert_eq!(manifest["contributes"]["panels"], json!([]));

    let future = list
        .iter()
        .find(|item| item["id"] == "kb.future")
        .expect("future");
    assert_eq!(future["manifest"], Value::Null);
    assert!(
        future["error"].as_str().unwrap().contains("更新版本"),
        "{future}"
    );
}

#[tokio::test]
async fn only_administrators_can_read_the_list_or_the_files() {
    let site = Site::new(true, None).await;
    Site::install_demo(&site.ext_root());
    let admin = site.admin().await;
    let user = site.login("alice", ROLE_USER).await;
    let token = site.api_token_of(&admin).await;

    for path in [
        "/api/v1/editor/extensions",
        "/api/v1/editor/extensions/kb.demo/index.js",
    ] {
        let (status, _, _) = site.get(path, Some(&admin)).await;
        assert_eq!(status, StatusCode::OK, "管理员 {path}");
        let (status, _, bytes) = site.get(path, Some(&user)).await;
        assert_eq!(
            status,
            StatusCode::FORBIDDEN,
            "普通用户 {path}:{}",
            text(&bytes)
        );
        assert!(!text(&bytes).contains("activate"), "403 不能带出脚本内容");
        let (status, _, _) = site.get(path, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "未登录 {path}");
        // 管理员的 API 令牌不是浏览器:拿不到扩展代码
        let (status, _, _) = site.get(path, Some(&token)).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "API 令牌 {path}");
    }
}

#[tokio::test]
async fn the_local_socket_superuser_is_allowed_without_a_login() {
    let site = Site::new(true, None).await;
    Site::install_demo(&site.ext_root());
    let (status, _, bytes) = site
        .send(
            Method::GET,
            "/api/v1/editor/extensions",
            None,
            None,
            SocketKind::Unix,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{}", text(&bytes));
    let body: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["data"]["extensions"].as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn files_are_served_with_the_right_type_and_no_cache() {
    let site = Site::new(true, None).await;
    Site::install_demo(&site.ext_root());
    let admin = site.admin().await;

    for (file, mime) in [
        ("index.js", "text/javascript; charset=utf-8"),
        ("lib/util.js", "text/javascript; charset=utf-8"),
        ("style.css", "text/css; charset=utf-8"),
        ("data.json", "application/json"),
        ("icon.svg", "image/svg+xml"),
    ] {
        let (status, headers, bytes) = site
            .get(
                &format!("/api/v1/editor/extensions/kb.demo/{file}"),
                Some(&admin),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{file}: {}", text(&bytes));
        assert_eq!(headers[header::CONTENT_TYPE], mime, "{file}");
        assert_eq!(headers[header::CACHE_CONTROL], "no-cache", "{file}");
        assert_eq!(headers["x-content-type-options"], "nosniff", "{file}");
        assert!(!bytes.is_empty());
    }
    // 内容原样
    let (_, _, bytes) = site
        .get("/api/v1/editor/extensions/kb.demo/index.js", Some(&admin))
        .await;
    assert_eq!(text(&bytes), "export default { activate() {} }\n");
    // SVG 在同源直接打开会执行脚本,所以带沙箱 CSP
    let (_, headers, _) = site
        .get("/api/v1/editor/extensions/kb.demo/icon.svg", Some(&admin))
        .await;
    assert_eq!(headers[header::CONTENT_SECURITY_POLICY], "sandbox");
    let (_, headers, _) = site
        .get("/api/v1/editor/extensions/kb.demo/index.js", Some(&admin))
        .await;
    assert!(
        !headers.contains_key(header::CONTENT_SECURITY_POLICY)
            || headers[header::CONTENT_SECURITY_POLICY] != "sandbox"
    );
}

#[tokio::test]
async fn the_manifest_other_types_and_missing_files_are_not_served() {
    let site = Site::new(true, None).await;
    Site::install_demo(&site.ext_root());
    std::fs::write(site.ext_root().join("kb.demo/notes.txt"), "x").unwrap();
    let admin = site.admin().await;
    for (file, expected) in [
        ("manifest.toml", StatusCode::BAD_REQUEST),
        ("notes.txt", StatusCode::BAD_REQUEST),
        ("missing.js", StatusCode::NOT_FOUND),
    ] {
        let (status, _, bytes) = site
            .get(
                &format!("/api/v1/editor/extensions/kb.demo/{file}"),
                Some(&admin),
            )
            .await;
        assert_eq!(status, expected, "{file}: {}", text(&bytes));
    }
    let (status, _, _) = site
        .get(
            "/api/v1/editor/extensions/kb.nothing/index.js",
            Some(&admin),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn path_traversal_over_http_never_reaches_files_outside_the_extension() {
    let site = Site::new(true, None).await;
    Site::install_demo(&site.ext_root());
    let admin = site.admin().await;
    let base = "/api/v1/editor/extensions";
    let attempts = [
        // 字面 `..`
        format!("{base}/kb.demo/../secret.js"),
        format!("{base}/kb.demo/../../secret.js"),
        format!("{base}/kb.demo/lib/../../secret.js"),
        // 百分号编码的 `..` 与斜杠
        format!("{base}/kb.demo/%2e%2e/secret.js"),
        format!("{base}/kb.demo/%2E%2E/secret.js"),
        format!("{base}/kb.demo/..%2Fsecret.js"),
        format!("{base}/kb.demo/..%2f..%2fsecret.js"),
        format!("{base}/kb.demo/lib%2f..%2f..%2fsecret.js"),
        // 双重编码
        format!("{base}/kb.demo/%252e%252e/secret.js"),
        format!("{base}/kb.demo/%252e%252e%252fsecret.js"),
        // 反斜杠、NUL、绝对路径
        format!("{base}/kb.demo/..%5csecret.js"),
        format!("{base}/kb.demo/index.js%00.css"),
        format!("{base}/kb.demo//etc/passwd.js"),
        format!("{base}/kb.demo/%2fetc%2fpasswd.js"),
        // id 段里穿越
        format!("{base}/../secret.js"),
        format!("{base}/%2e%2e/secret.js"),
        format!("{base}/kb.demo%2f..%2fkb.demo/index.js"),
        format!("{base}/..%2fkb.demo/index.js"),
    ];
    for path in attempts {
        let (status, _, bytes) = site.get(&path, Some(&admin)).await;
        assert!(
            !text(&bytes).contains("SECRET"),
            "{path} 读到了目录外的文件"
        );
        assert!(
            !status.is_success(),
            "{path} 应被拒绝,实际 {status}:{}",
            text(&bytes)
        );
    }
    // 对照:同样的接口读合法文件是通的,说明上面的失败不是接口本身坏了
    let (status, _, _) = site
        .get(&format!("{base}/kb.demo/index.js"), Some(&admin))
        .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn symlinks_cannot_be_used_to_escape_or_alias() {
    let site = Site::new(true, None).await;
    Site::install_demo(&site.ext_root());
    let ext = site.ext_root().join("kb.demo");
    let outside = site.home.path().join("secret.js");
    std::os::unix::fs::symlink(&outside, ext.join("leak.js")).unwrap();
    std::os::unix::fs::symlink(site.home.path(), ext.join("up")).unwrap();
    std::os::unix::fs::symlink(ext.join("index.js"), ext.join("alias.js")).unwrap();
    let admin = site.admin().await;
    for file in ["leak.js", "up/secret.js", "alias.js"] {
        let (status, _, bytes) = site
            .get(
                &format!("/api/v1/editor/extensions/kb.demo/{file}"),
                Some(&admin),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{file}: {}", text(&bytes));
        assert!(!text(&bytes).contains("SECRET"));
    }
}

#[tokio::test]
async fn the_switch_and_the_directory_follow_config_changes_without_a_restart() {
    let site = Site::new(false, None).await;
    // 自定义目录(相对 KB_HOME)
    let custom = site.home.path().join("my-ext");
    Site::install_demo(&custom);
    let admin = site.admin().await;

    let (_, body) = site.list(Some(&admin)).await;
    assert_eq!(body["data"]["enabled"], false);

    let mut config = (*site.config.get()).clone();
    config.editor.extensions = true;
    config.editor.extensions_dir = Some("my-ext".to_owned());
    site.config.replace(config);
    let (_, body) = site.list(Some(&admin)).await;
    assert_eq!(body["data"]["enabled"], true);
    assert_eq!(
        body["data"]["extensions"].as_array().unwrap().len(),
        1,
        "{body}"
    );
    let (status, _, _) = site
        .get("/api/v1/editor/extensions/kb.demo/index.js", Some(&admin))
        .await;
    assert_eq!(status, StatusCode::OK);

    // 默认目录里没有东西 → 空列表而不是报错
    let mut config = (*site.config.get()).clone();
    config.editor.extensions_dir = None;
    site.config.replace(config);
    let (status, body) = site.list(Some(&admin)).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["data"]["extensions"], json!([]));

    // 再关掉:文件立即不可取
    let mut config = (*site.config.get()).clone();
    config.editor.extensions = false;
    config.editor.extensions_dir = Some("my-ext".to_owned());
    site.config.replace(config);
    let (status, _, _) = site
        .get("/api/v1/editor/extensions/kb.demo/index.js", Some(&admin))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_site_csp_is_not_relaxed_for_extension_scripts() {
    // 扩展脚本靠同源 import 加载,所以 script-src 仍然只有 'self'(+wasm);管理端页面的 CSP 不为扩展放宽
    let site = Site::new(true, None).await;
    Site::install_demo(&site.ext_root());
    let admin = site.admin().await;
    let (_, headers, _) = site.get("/api/v1/editor/extensions", Some(&admin)).await;
    let csp = headers[header::CONTENT_SECURITY_POLICY]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(
        csp.contains("script-src 'self' 'wasm-unsafe-eval';"),
        "{csp}"
    );
    assert!(
        !csp.contains("unsafe-inline'")
            || !csp
                .split(';')
                .any(|d| d.trim().starts_with("script-src") && d.contains("unsafe-inline")),
        "{csp}"
    );
    assert!(
        !csp.contains("'unsafe-eval'") && !csp.contains("blob:"),
        "{csp}"
    );
}

/// 仓库里的示例扩展清单:后端真实解析出来的 JSON 必须等于夹具里的快照。
/// 前端的单测和 e2e 夹具读同一份快照当作「后端返回的 manifest」,所以示例改了而快照没改会在这里变红。
#[test]
fn the_word_count_example_manifest_parses_to_the_shared_snapshot() {
    let toml = include_str!("../../../web-ui/examples/editor-word-count/manifest.toml");
    let snapshot: Value =
        serde_json::from_str(include_str!("fixtures/editor-word-count.manifest.json")).unwrap();
    let manifest = kb_web::editor_ext::parse_manifest_toml(toml).expect("示例清单应当合法");
    assert_eq!(serde_json::to_value(&manifest).unwrap(), snapshot);
}

/// 示例目录原样复制到扩展目录就能被识别:目录名 = id,入口存在,权限只有读文档和画界面。
#[test]
fn the_word_count_example_installs_by_copying_its_directory() {
    let site_home = tempfile::tempdir().unwrap();
    let target = site_home.path().join("editor-extensions/kb.word-count");
    std::fs::create_dir_all(&target).unwrap();
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web-ui/examples/editor-word-count");
    for name in ["manifest.toml", "index.js"] {
        std::fs::copy(source.join(name), target.join(name)).unwrap();
    }
    let entries = kb_web::editor_ext::scan_extensions(&site_home.path().join("editor-extensions"));
    assert_eq!(entries.len(), 1);
    assert!(entries[0].error.is_none(), "{:?}", entries[0].error);
    let manifest = entries[0].manifest.as_ref().unwrap();
    assert_eq!(manifest.permissions, ["document.read", "ui"]);
    let (bytes, mime) = kb_web::editor_ext::read_extension_file(
        &site_home.path().join("editor-extensions"),
        "kb.word-count",
        &manifest.entry,
    )
    .expect("入口能取到");
    assert!(mime.starts_with("text/javascript"));
    assert!(
        std::str::from_utf8(&bytes)
            .unwrap()
            .contains("export default")
    );
}

/// 待办清单示例(注册新格式:Codec + 内容面)的清单:后端真实解析出来的 JSON 必须等于夹具快照,
/// 文件浏览页入口的 e2e 读同一份快照当作「后端返回的 manifest」。
#[test]
fn the_todo_format_example_manifest_parses_to_the_shared_snapshot() {
    let toml = include_str!("../../../web-ui/examples/editor-todo-format/manifest.toml");
    let snapshot: Value =
        serde_json::from_str(include_str!("fixtures/editor-todo-format.manifest.json")).unwrap();
    let manifest = kb_web::editor_ext::parse_manifest_toml(toml).expect("示例清单应当合法");
    assert_eq!(serde_json::to_value(&manifest).unwrap(), snapshot);
}

/// 待办清单示例原样复制到扩展目录就能被识别:目录名 = id,入口存在,
/// 权限是读 / 写文档(Codec)和画界面(内容面),接管的只有 .kbtodo。
#[test]
fn the_todo_format_example_installs_by_copying_its_directory() {
    let site_home = tempfile::tempdir().unwrap();
    let target = site_home.path().join("editor-extensions/kb.todo-format");
    std::fs::create_dir_all(&target).unwrap();
    let source =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web-ui/examples/editor-todo-format");
    for name in ["manifest.toml", "index.js"] {
        std::fs::copy(source.join(name), target.join(name)).unwrap();
    }
    let entries = kb_web::editor_ext::scan_extensions(&site_home.path().join("editor-extensions"));
    assert_eq!(entries.len(), 1);
    assert!(entries[0].error.is_none(), "{:?}", entries[0].error);
    let manifest = entries[0].manifest.as_ref().unwrap();
    assert_eq!(
        manifest.permissions,
        ["document.read", "document.write", "ui"]
    );
    assert_eq!(manifest.contributes.codecs[0].extensions, ["kbtodo"]);
    assert_eq!(manifest.contributes.surfaces[0].extensions, ["kbtodo"]);
    let (bytes, mime) = kb_web::editor_ext::read_extension_file(
        &site_home.path().join("editor-extensions"),
        "kb.todo-format",
        &manifest.entry,
    )
    .expect("入口能取到");
    assert!(mime.starts_with("text/javascript"));
    assert!(
        std::str::from_utf8(&bytes)
            .unwrap()
            .contains("export default")
    );
}

/// 取文档里某种围栏代码块:返回 (围栏信息串, 内容)。
fn fenced_blocks(doc: &str) -> Vec<(String, String)> {
    let mut blocks = Vec::new();
    let mut lines = doc.lines();
    while let Some(line) = lines.next() {
        let Some(info) = line.trim_start().strip_prefix("```") else {
            continue;
        };
        let info = info.trim().to_owned();
        let mut body = String::new();
        for inner in lines.by_ref() {
            if inner.trim_start().starts_with("```") {
                break;
            }
            body.push_str(inner);
            body.push('\n');
        }
        blocks.push((info, body));
    }
    blocks
}

/// `docs/EDITOR_EXTENSIONS.md` 里的示例清单都能被后端真实解析器接受,配置示例是合法的 `[editor]` 配置。
/// 前端的 `docs.spec.ts` 会把同一批清单用另一个解析器再跑一遍,两边一起守住文档不说假话。
#[test]
fn the_examples_in_the_docs_are_accepted_by_the_real_parser() {
    let doc = include_str!("../../../docs/EDITOR_EXTENSIONS.md");
    let blocks = fenced_blocks(doc);
    let manifests: Vec<_> = blocks
        .iter()
        .filter(|(info, _)| info.starts_with("toml example="))
        .collect();
    assert!(
        manifests.len() >= 9,
        "文档里应有 9 个示例清单,实际 {}",
        manifests.len()
    );
    for (info, body) in &manifests {
        let manifest = kb_web::editor_ext::parse_manifest_toml(body)
            .unwrap_or_else(|errors| panic!("文档示例 {info} 的清单不合法:{errors:?}"));
        assert_eq!(manifest.api_version, 1, "{info}");
    }
    // 安装说明里的 [editor] 配置块
    let config_blocks: Vec<_> = blocks
        .iter()
        .filter(|(info, body)| info == "toml" && body.contains("[editor]"))
        .collect();
    assert_eq!(config_blocks.len(), 1);
    let config: Config = toml::from_str(&config_blocks[0].1).expect("文档里的配置示例能解析");
    config.validate().expect("文档里的配置示例是合法配置");
    assert!(config.editor.extensions);
    // 文档里的字段表示例也要合法
    let table = blocks
        .iter()
        .find(|(info, body)| info == "toml" && body.contains("id = \"kb.word-count\""))
        .expect("manifest.toml 字段表示例");
    kb_web::editor_ext::parse_manifest_toml(&table.1).expect("字段表示例是合法清单");
}
