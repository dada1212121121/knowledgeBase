//! 用户 admin key 的 HTTP 面,以及「AI 接入指南」的生成与下载。
//!
//! - `GET  /api/v1/me/admin-key`          看自己的 key
//! - `POST /api/v1/me/admin-key/rotate`   轮换(旧 key 立刻失效)
//! - `GET  /api/v1/me/ai-guide`           返回指南正文;加 `?download=1` 变成文件下载
//!
//! 只认「本人亲自操作」:浏览器会话或本人的 admin key(`Identity::acts_as_account`)。
//! API / MCP 令牌不行:令牌是给程序限权用的,让它们读出 admin key 就等于拿到了全权。

use std::sync::Arc;

use axum::Json;
use axum::extract::{Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use kb_capability::Surface;

use kb_core::account::User;
use serde::Deserialize;
use serde_json::json;

use crate::ai_guide::{self, GuideCapability, GuideInput};
use crate::api::{self, AppState};
use crate::auth::Identity;

/// 下载时的文件名。
const GUIDE_FILENAME: &str = "knowledgebase-ai-guide.md";

/// 旧的全站令牌能力:新的认证不认它们生成的令牌,写进指南只会误导 AI。
const LEGACY_CAPABILITIES: &[&str] = &["create_token", "revoke_token"];

fn deny(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// 当前用户;只认浏览器会话和本人的 admin key。
#[allow(clippy::result_large_err)]
fn account_user(identity: Option<&Identity>) -> Result<Arc<User>, Response> {
    let Some(identity) = identity else {
        return Err(deny(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录"));
    };
    if !identity.acts_as_account() {
        return Err(deny(
            StatusCode::FORBIDDEN,
            "forbidden",
            "admin key 只能由本人在浏览器里或用 admin key 本身查看",
        ));
    }
    identity
        .user
        .clone()
        .ok_or_else(|| deny(StatusCode::FORBIDDEN, "forbidden", "没有可用的账号"))
}

/// `GET /api/v1/me/admin-key`。
pub async fn get(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    let user = match account_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    match state.system.ensure_admin_key(&user.id).await {
        Ok(key) => api::ok(json!({
            "admin_key": key.admin_key,
            "created_at": key.created_at,
            "rotated_at": key.rotated_at,
        })),
        Err(err) => api::error_response(err),
    }
}

/// `POST /api/v1/me/admin-key/rotate`:换一把新的,旧的立刻失效。
pub async fn rotate(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    let user = match account_user(extensions.get::<Identity>()) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let now = crate::auth::session::now_millis();
    match state.system.rotate_admin_key(&user.id, now).await {
        Ok(key) => {
            let _ = state
                .system
                .record_audit(Some(&user.id), "admin_key.rotate", None, &json!({}), None)
                .await;
            api::ok(json!({
                "admin_key": key.admin_key,
                "created_at": key.created_at,
                "rotated_at": key.rotated_at,
            }))
        }
        Err(err) => api::error_response(err),
    }
}

/// `GET /api/v1/me/ai-guide` 的查询参数。
#[derive(Debug, Default, Deserialize)]
pub struct GuideQuery {
    /// 非空且不是 `0` / `false`:作为文件下载。
    #[serde(default)]
    pub download: Option<String>,
    /// 页面自己的 origin(`location.origin`)。浏览器知道用户实际是从哪个地址打开的,比服务端猜得准。
    #[serde(default)]
    pub base: Option<String>,
}

/// 站点地址:`base` 参数 > 反向代理转发的 Host / 协议 > 配置里的 `site.public_url`。
/// 只接受「协议 + 主机[:端口]」的形状,别的一律忽略(见 [`ai_guide::is_plain_origin`])。
fn resolve_base(state: &AppState, headers: &HeaderMap, query_base: Option<&str>) -> String {
    let candidate = query_base
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| ai_guide::is_plain_origin(value))
        .or_else(|| {
            let host = headers
                .get("x-forwarded-host")
                .or_else(|| headers.get(header::HOST))
                .and_then(|value| value.to_str().ok())?;
            let proto = headers
                .get("x-forwarded-proto")
                .and_then(|value| value.to_str().ok())
                .filter(|value| matches!(*value, "http" | "https"))
                .unwrap_or("http");
            Some(format!("{proto}://{host}")).filter(|value| ai_guide::is_plain_origin(value))
        });
    candidate.unwrap_or_else(|| {
        state
            .account
            .config
            .get()
            .site
            .public_url
            .trim_end_matches('/')
            .to_owned()
    })
}

/// 这个身份在 Web 面上真能调用的接口:可见面是 Web、权限不超过它的上限、功能点已开通。
fn callable_capabilities(state: &AppState, identity: &Identity) -> Vec<GuideCapability> {
    let registry = state.invoker.registry();
    registry
        .for_surface(Surface::Web)
        .into_iter()
        .filter(|capability| !LEGACY_CAPABILITIES.contains(&capability.name))
        .filter(|capability| {
            kb_capability::invoke::check_permission(capability.permission, identity.max_permission)
                .is_ok()
        })
        .filter_map(|capability| {
            let access = registry.access(capability.name)?;
            identity
                .principal
                .features
                .allows(access.feature)
                .then(|| GuideCapability {
                    name: capability.name.to_owned(),
                    description: capability.description.to_owned(),
                    permission: capability.permission.as_str().to_owned(),
                    mcp: capability.visible_on(Surface::Mcp),
                    feature: access.feature.to_owned(),
                    schema: capability.input_schema.clone(),
                })
        })
        .collect()
}

/// `GET /api/v1/me/ai-guide`。
pub async fn guide(
    State(state): State<Arc<AppState>>,
    Query(query): Query<GuideQuery>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
) -> Response {
    let identity = extensions.get::<Identity>();
    let user = match account_user(identity) {
        Ok(user) => user,
        Err(response) => return response,
    };
    let Some(identity) = identity else {
        return deny(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录");
    };
    let key = match state.system.ensure_admin_key(&user.id).await {
        Ok(key) => key,
        Err(err) => return api::error_response(err),
    };
    let base = resolve_base(&state, &headers, query.base.as_deref());
    let config = state.account.config.get();
    let site = config.site.name.clone();
    let limits = ai_guide::GuideLimits::from_config(&config);
    let generated_at = crate::profile::time_text(crate::auth::session::now_millis());
    let items = callable_capabilities(&state, identity);
    let text = ai_guide::render(
        &GuideInput {
            base: &base,
            key: &key.admin_key,
            username: &user.username,
            display_name: &user.display_name,
            site: &site,
            generated_at: &generated_at,
            limits: &limits,
        },
        &items,
    );
    let download = query
        .download
        .as_deref()
        .is_some_and(|value| !matches!(value.trim(), "" | "0" | "false"));
    let mut response = (StatusCode::OK, text).into_response();
    let out = response.headers_mut();
    out.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/markdown; charset=utf-8"),
    );
    // 里面有 key:不让浏览器或中间代理缓存
    out.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if download {
        out.insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(&format!("attachment; filename=\"{GUIDE_FILENAME}\""))
                .expect("固定文件名是合法的头值"),
        );
    }
    response
}
