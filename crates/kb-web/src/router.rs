//! 同一个 Router 同时服务 TCP 与 UDS(设计规范)。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::Router;
use axum::response::Response;
use axum::routing::{get, post};
use kb_core::{KbError, Result};
use tokio::net::{TcpListener, UnixListener};

use crate::api::{self, AppState};
use crate::source::{self, SocketKind};
use crate::ws;

/// 上传请求体的上限(分片 8 MB,留足余量;`upload.chunk_mb` 最大 64)。
pub const UPLOAD_BODY_LIMIT: usize = 64 * 1024 * 1024;

/// 构建路由表;`kind` 决定来源标记(UDS = local,TCP = remote)。
pub fn build(state: Arc<AppState>, kind: SocketKind) -> Router {
    let auth_state = state.clone();
    let mut router = Router::new()
        .route("/api/v1/health", get(api::health))
        // 公开 Agent Skill:免登录、无用户数据;两个路径返回同一份正文
        .route("/skill.md", get(crate::skill::get))
        .route("/api/v1/skill", get(crate::skill::get))
        .route("/api/v1/auth/status", get(crate::auth::status))
        .route("/api/v1/auth/login", post(crate::auth::login))
        .route(
            "/api/v1/auth/login/totp",
            post(crate::auth::totp::login_totp),
        )
        .route("/api/v1/auth/logout", post(crate::auth::logout))
        .route("/api/v1/auth/totp", get(crate::auth::totp::status))
        .route("/api/v1/auth/totp/setup", post(crate::auth::totp::setup))
        .route(
            "/api/v1/auth/totp/confirm",
            post(crate::auth::totp::confirm),
        )
        .route(
            "/api/v1/auth/totp/disable",
            post(crate::auth::totp::disable),
        )
        .route(
            "/api/v1/auth/totp/recovery",
            post(crate::auth::totp::regenerate_recovery),
        )
        .route("/api/v1/auth/me", get(crate::auth::me))
        .route("/api/v1/auth/email-code", post(crate::signup::email_code))
        .route("/api/v1/auth/register", post(crate::signup::register))
        .route(
            "/api/v1/auth/invite-check",
            post(crate::signup::invite_check),
        )
        .route(
            "/api/v1/auth/password/reset",
            post(crate::signup::reset_password),
        )
        .route(
            "/api/v1/auth/change-password",
            post(crate::signup::change_password),
        )
        .route("/api/v1/auth/password", post(crate::auth::set_password))
        .route(
            "/api/v1/auth/tokens",
            get(crate::auth::list_tokens).post(crate::auth::create_token),
        )
        .route(
            "/api/v1/auth/tokens/{id}",
            axum::routing::delete(crate::auth::revoke_token),
        )
        // 个人资料:显示名、头像。头像地址里不带别人能猜的东西,读取要登录
        .route(
            "/api/v1/me/profile",
            axum::routing::patch(crate::profile::update_profile),
        )
        .route(
            "/api/v1/me/avatar",
            axum::routing::put(crate::profile::upload_avatar)
                .delete(crate::profile::delete_avatar)
                // 放到头像上限的两倍:8–16 MB 的图拿到我们那句清楚的提示(「图片不能超过 8 MB」),
                // 而不是框架的一条空 413。更大的只会来自绕过页面的请求(页面选文件时就按 8 MB 拦了),
                // 直接被框架拒绝,不读进内存
                .layer(axum::extract::DefaultBodyLimit::max(
                    crate::avatar::MAX_UPLOAD_BYTES * 2,
                )),
        )
        .route("/api/v1/users/{id}/avatar", get(crate::profile::get_avatar))
        // 批量问「这些人有没有头像」:多人编辑的在线名单只有 id,先问清再取图,没头像的不产生 404
        .route("/api/v1/users/avatars", get(crate::profile::get_avatars))
        // 更换邮箱:要密码 → 验证码发到新邮箱 → 提交验证码,旧邮箱收到通知
        .route(
            "/api/v1/me/email-code",
            post(crate::profile::change_email_code),
        )
        .route("/api/v1/me/email", post(crate::profile::change_email))
        // 个人数据导出:开始 / 看进度 / 流式下载 / 删除
        .route(
            "/api/v1/me/export",
            get(crate::export_api::status)
                .post(crate::export_api::start)
                .delete(crate::export_api::discard),
        )
        .route(
            "/api/v1/me/export/download",
            get(crate::export_api::download),
        )
        // 账号注销(申请要再输一次密码)
        .route(
            "/api/v1/me/deletion",
            post(crate::profile::request_deletion).delete(crate::profile::cancel_deletion),
        )
        // 用户 admin key:查看、轮换;以及按用户生成的「AI 接入指南」(可下载)
        .route("/api/v1/me/admin-key", get(crate::admin_key::get))
        .route(
            "/api/v1/me/admin-key/rotate",
            post(crate::admin_key::rotate),
        )
        .route("/api/v1/me/ai-guide", get(crate::admin_key::guide))
        // 界面偏好(侧栏状态、密度等):整体读 / 整体替换
        .route(
            "/api/v1/me/prefs",
            get(crate::prefs::get).put(crate::prefs::put),
        )
        // 登录设备
        .route("/api/v1/me/sessions", get(crate::sessions_api::list))
        .route(
            "/api/v1/me/sessions/revoke-others",
            post(crate::sessions_api::revoke_others),
        )
        .route(
            "/api/v1/me/sessions/{id}",
            axum::routing::delete(crate::sessions_api::revoke),
        )
        // 公开分享(无需登录):链接信息、输密码、调白名单能力、读原件、游客改昵称
        .route("/api/v1/share/{token}", get(crate::share_public::info))
        .route(
            "/api/v1/share/{token}/unlock",
            post(crate::share_public::unlock),
        )
        .route(
            "/api/v1/share/{token}/call/{capability}",
            post(crate::share_public::call),
        )
        .route("/api/v1/share/{token}/raw", get(crate::share_public::raw))
        .route(
            "/api/v1/share/{token}/download",
            get(crate::share_public::download),
        )
        .route(
            "/api/v1/share/{token}/owner-avatar",
            get(crate::share_public::owner_avatar),
        )
        .route(
            "/api/v1/share/{token}/collab",
            get(crate::share_public::collab_socket),
        )
        .route(
            "/api/v1/share/{token}/guest",
            post(crate::share_public::rename_guest),
        )
        .route("/api/v1/capabilities", get(api::capabilities))
        // 预览页读原件(图片 / 音频);鉴权与其它 REST 路由一致
        .route("/api/v1/raw", get(api::raw))
        .route("/api/v1/download", get(api::download))
        .route("/api/v1/capabilities/{name}", post(api::call))
        .route("/api/v1/ws", get(ws::handler))
        .route("/api/v1/collab/ws", get(crate::collab_ws::user_handler))
        // 办公文档多人协同:准备、底稿、docx 初始状态、WebSocket
        .route(
            "/api/v1/office/session",
            axum::routing::post(crate::office_ws::session_handler),
        )
        .route("/api/v1/office/base", get(crate::office_ws::base_handler))
        .route("/api/v1/office/seed", get(crate::office_ws::seed_handler))
        .route(
            "/api/v1/office/collab",
            get(crate::office_ws::collab_handler),
        )
        .route("/api/v1/events", post(crate::events::handler))
        // 编辑器扩展:本地可信目录里的清单与静态文件;只对管理员开放,默认关
        .route("/api/v1/editor/extensions", get(crate::editor_ext::list))
        .route(
            "/api/v1/editor/extensions/{id}/{*file}",
            get(crate::editor_ext::file),
        )
        // :上传(分片续传 / 去重预检 / 完成);分片最大 64 MB,默认 2 MB 的 body 限制不够
        .route(
            "/api/v1/uploads",
            post(crate::upload::create)
                .layer(axum::extract::DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        .route(
            "/api/v1/uploads/precheck",
            post(crate::upload::precheck)
                .layer(axum::extract::DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        .route(
            "/api/v1/uploads/{id}",
            get(crate::upload::status)
                .delete(crate::upload::abort)
                .layer(axum::extract::DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        .route(
            "/api/v1/uploads/{id}/parts/{n}",
            axum::routing::put(crate::upload::put_part)
                .layer(axum::extract::DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        // 编辑权:申请 / 心跳(POST,JSON)与交还(DELETE)
        .route(
            "/api/v1/files/lock",
            axum::routing::post(crate::upload::lock_file).delete(crate::upload::unlock_file),
        )
        // 编辑器没改内容就保存出来的字节 ←→ 原件:能不能无损编辑
        .route(
            "/api/v1/files/roundtrip-check",
            axum::routing::post(crate::upload::roundtrip_check)
                .layer(axum::extract::DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        // 上传新版本替换原件:请求体就是新文件,上限与分片一致
        .route(
            "/api/v1/files/replace",
            axum::routing::put(crate::upload::replace_file)
                .layer(axum::extract::DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        .route(
            "/api/v1/uploads/{id}/complete",
            post(crate::upload::complete)
                .layer(axum::extract::DefaultBodyLimit::max(UPLOAD_BODY_LIMIT)),
        )
        .fallback(crate::ui::fallback)
        // 鉴权先于来源标记执行:UDS 放行并打上“本机超级用户”,TCP 必须过会话 / Bearer
        .layer(axum::middleware::from_fn(move |request, next| {
            crate::auth::guard(kind, auth_state.clone(), request, next)
        }))
        .layer(axum::middleware::from_fn(move |request, next| {
            source::mark(kind, request, next)
        }))
        .layer(axum::middleware::from_fn(security_headers))
        // 最外层:文本类响应 gzip(见 compress.rs 的白名单);`/mcp` 在下面单独挂,不经过这一层
        .layer(crate::compress::layer());
    // `/mcp` 只在启用了 http 传输、且是 TCP 监听时挂载;否则 axum 直接返回 404
    if state.mcp.is_some() && kind == SocketKind::Tcp {
        router = router.route("/mcp", axum::routing::any(crate::mcp::handler));
    }
    router.with_state(state)
}

/// 绑定 UDS(先清残留文件,创建后立刻 chmod 0600)。
///
/// 绑定失败要当成致命错误,不能留下“半个守护进程”。
pub fn bind_uds(path: &Path) -> Result<UnixListener> {
    if path.exists() {
        std::fs::remove_file(path).map_err(|err| {
            KbError::Internal(format!("清理残留 socket {} 失败: {err}", path.display()))
        })?;
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
        })?;
    }
    let listener = UnixListener::bind(path)
        .map_err(|err| KbError::Internal(format!("绑定 UDS {} 失败: {err}", path.display())))?;
    set_owner_only(path)?;
    Ok(listener)
}

/// 在已绑定的 UDS 上服务;退出时删掉 socket 文件。
pub async fn serve_uds_listener(
    listener: UnixListener,
    state: Arc<AppState>,
    path: PathBuf,
    kind: SocketKind,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let app = build(state, kind);
    axum::serve(UnixListenerOnly(listener), app.into_make_service())
        .with_graceful_shutdown(wait_shutdown(shutdown))
        .await
        .map_err(|err| KbError::Internal(format!("UDS 服务退出: {err}")))?;
    let _ = std::fs::remove_file(&path);
    Ok(())
}

/// 绑定 TCP。
pub async fn bind_tcp(addr: std::net::SocketAddr) -> Result<TcpListener> {
    TcpListener::bind(addr)
        .await
        .map_err(|err| KbError::Internal(format!("绑定 TCP {addr} 失败: {err}")))
}

/// 在已绑定的 TCP 上服务(早期 之前只有 `/api/v1/health` 可用)。
pub async fn serve_tcp_listener(
    listener: TcpListener,
    state: Arc<AppState>,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Result<()> {
    let app = build(state, SocketKind::Tcp);
    // 关掉 Nagle:协同编辑的 WebSocket 一秒几十上百个小帧,Nagle 遇上对端的延迟确认会让一个帧等 40 毫秒
    // (压测里 20 人同时改表格,p95 从这里来);普通 API 响应也不需要攒包
    let listener = axum::serve::ListenerExt::tap_io(listener, |tcp: &mut tokio::net::TcpStream| {
        if let Err(err) = tcp.set_nodelay(true) {
            tracing::debug!("TCP_NODELAY 设置失败: {err}");
        }
    });
    // 带连接信息启动:登录限速按来源 IP(见 auth::ClientIp)
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(wait_shutdown(shutdown))
    .await
    .map_err(|err| KbError::Internal(format!("TCP 服务退出: {err}")))?;
    Ok(())
}

/// 管理端安全头。已有 CSP 的响应(预览原件的 sandbox)不覆盖。
async fn security_headers(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> Response {
    // 公开分享页:不让搜索引擎收录,也不让令牌经 Referer 带到外链（设计规范）
    let is_share_page = request.uri().path().starts_with("/s/");
    // 在 HTTPS 反向代理后面才带 HSTS(本机明文访问带了,浏览器会把 localhost 锁死在 https 上)
    let via_https = request
        .headers()
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.eq_ignore_ascii_case("https"));
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    if via_https && !headers.contains_key("strict-transport-security") {
        // 一年;不加 includeSubDomains / preload:同域下别的子站不一定都有 HTTPS,这不是我们能替它们决定的
        let _ = headers.insert(
            "strict-transport-security",
            "max-age=31536000".parse().expect("hsts"),
        );
    }
    if is_share_page {
        let _ = headers.insert("x-robots-tag", "noindex, nofollow".parse().expect("robots"));
        let _ = headers.insert("referrer-policy", "no-referrer".parse().expect("referrer"));
    }
    // connect-src 只放 'self' 和 data:，不放任何外部域 / blob: / 通配:
    // Word 编辑引擎在 Worker 里用 fetch("data:image/…") 解码文档里的内嵌图片；没有 connect-src 时回落到 default-src 'self'，
    // data: 的 fetch 被拦（TypeError: Failed to fetch），图片只留下空白版面，页面上也收不到违规事件（违规发生在 Worker 里）。
    // data: 的内容就在 URL 里，fetch 它不产生网络请求，不能借此外发数据。
    if !headers.contains_key("content-security-policy") {
        let _ = headers.insert(
            "content-security-policy",
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' data:; font-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'self'"
                .parse()
                .expect("csp"),
        );
    }
    if !headers.contains_key("x-content-type-options") {
        let _ = headers.insert(
            "x-content-type-options",
            "nosniff".parse().expect("nosniff"),
        );
    }
    if !headers.contains_key("referrer-policy") {
        let _ = headers.insert("referrer-policy", "same-origin".parse().expect("referrer"));
    }
    response
}

async fn wait_shutdown(mut rx: tokio::sync::watch::Receiver<bool>) {
    let _ = rx.wait_for(|value| *value).await;
}

fn set_owner_only(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let permissions = std::fs::Permissions::from_mode(0o600);
    std::fs::set_permissions(path, permissions)
        .map_err(|err| KbError::Internal(format!("chmod 0600 {} 失败: {err}", path.display())))
}

/// axum 需要 `Listener`;这里包一层只为在 accept 前打上 UDS 标记。
struct UnixListenerOnly(UnixListener);

impl axum::serve::Listener for UnixListenerOnly {
    type Io = tokio::net::UnixStream;
    type Addr = tokio::net::unix::SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        loop {
            match self.0.accept().await {
                Ok(pair) => return pair,
                Err(err) => {
                    tracing::warn!(error = %err, "UDS accept 失败");
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
    }

    fn local_addr(&self) -> std::io::Result<Self::Addr> {
        self.0.local_addr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    async fn headers_of(path: &str, upstream_csp: Option<&'static str>) -> axum::http::HeaderMap {
        let app = axum::Router::new()
            .route(
                "/{*rest}",
                axum::routing::get(move || async move {
                    let mut response = Response::new(Body::empty());
                    if let Some(csp) = upstream_csp {
                        response
                            .headers_mut()
                            .insert("content-security-policy", csp.parse().unwrap());
                    }
                    response
                }),
            )
            .layer(axum::middleware::from_fn(security_headers));
        app.oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap()
            .headers()
            .clone()
    }

    /// `connect-src` 只放同源和 `data:`:Word 编辑引擎在 Worker 里 `fetch("data:image/…")` 解码内嵌图片,
    /// 缺了它图片只剩空白版面(而且页面收不到违规事件,很难发现)。但绝不能因此放宽到能外发数据的来源。
    #[tokio::test]
    async fn site_csp_connect_src_allows_data_but_no_external_origin() {
        let headers = headers_of("/index.html", None).await;
        let csp = headers["content-security-policy"].to_str().unwrap();
        let connect = csp
            .split(';')
            .map(str::trim)
            .find(|directive| directive.starts_with("connect-src"))
            .unwrap_or_else(|| {
                panic!("要显式写 connect-src,否则回落 default-src 拦掉 data: 的 fetch:{csp}")
            });
        let sources: Vec<&str> = connect.split_whitespace().skip(1).collect();
        assert!(
            sources.contains(&"'self'"),
            "同源的 fetch / WebSocket 要保留:{connect}"
        );
        assert!(
            sources.contains(&"data:"),
            "引擎解码内嵌图片要用 data: 的 fetch:{connect}"
        );
        // 只允许这两个:任何多出来的来源(通配、https:、blob:、外部域)都可能成为外发数据的通道
        assert_eq!(
            sources.len(),
            2,
            "connect-src 只放 'self' 和 data:,实际:{connect}"
        );
    }

    /// 站点默认 CSP:允许编译 WebAssembly(办公文档编辑引擎),但不放开 JS 的 eval,也不放开内联脚本。
    #[tokio::test]
    async fn site_csp_allows_wasm_but_not_js_eval() {
        let headers = headers_of("/index.html", None).await;
        let csp = headers["content-security-policy"].to_str().unwrap();
        assert!(
            csp.contains("script-src 'self' 'wasm-unsafe-eval';"),
            "{csp}"
        );
        let script_src = csp
            .split(';')
            .map(str::trim)
            .find(|directive| directive.starts_with("script-src"))
            .expect("有 script-src");
        assert!(!csp.contains("'unsafe-eval'"), "不放开 JS 的 eval:{csp}");
        assert!(
            !script_src.contains("'unsafe-inline'"),
            "不放开内联脚本:{script_src}"
        );
        assert!(csp.contains("object-src 'none'") && csp.contains("frame-ancestors 'none'"));
    }

    /// 预览原件时上游自带的 sandbox CSP 不能被站点策略盖掉。
    #[tokio::test]
    async fn an_upstream_csp_is_kept() {
        let headers = headers_of("/raw", Some("sandbox")).await;
        assert_eq!(headers["content-security-policy"], "sandbox");
    }
}
