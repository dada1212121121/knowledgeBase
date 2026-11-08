//! REST 处理函数(设计规范的请求 / 响应契约)。

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use kb_capability::invoke::{CallCtx, ResponseMeta};
use kb_capability::{Permission, Surface};
use kb_core::KbError;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::Identity;
use crate::source::Source;

use super::files::valid_user_id;
use super::*;

/// `GET /api/v1/capabilities`。
pub async fn capabilities(
    State(state): State<Arc<AppState>>,
    Query(query): Query<CapabilitiesQuery>,
) -> Response {
    let registry = state.invoker.registry();
    let capabilities = match query.surface.as_deref() {
        Some(name) => match parse_surface(name) {
            Some(surface) => registry.describe_surface(surface),
            None => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_input",
                    &format!("未知的可见面 {name}"),
                );
            }
        },
        None => registry
            .all()
            .into_iter()
            .map(|cap| {
                let mut described = cap.describe();
                if let (Some(object), Some(access)) =
                    (described.as_object_mut(), registry.access(cap.name))
                {
                    object.insert("scope".to_owned(), Value::from(access.scope.as_str()));
                    object.insert("feature".to_owned(), Value::from(access.feature));
                }
                described
            })
            .collect(),
    };
    ok(json!({ "capabilities": capabilities }))
}

/// `POST /api/v1/capabilities/{name}` 的查询参数。
#[derive(Debug, Default, Deserialize)]
pub struct CallQuery {
    /// `?dry_run=true`:只演练,不落库。
    #[serde(default)]
    pub dry_run: Option<String>,
}

/// `POST /api/v1/capabilities/{name}`。
pub async fn call(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Query(query): Query<CallQuery>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    body: Option<Json<Value>>,
) -> Response {
    // / :身份只来自鉴权中间件(会话 / Bearer / UDS),不再信任客户端自报的头
    let identity = extensions
        .get::<Identity>()
        .cloned()
        .unwrap_or_else(|| Identity::local(Surface::Web));
    // 权限上限:Bearer(scope=mcp)最多 W 级,所以 G 级能力会被拒
    if let Some(capability) = state.invoker.registry().get(&name) {
        if let Err(err) =
            kb_capability::invoke::check_permission(capability.permission, identity.max_permission)
        {
            return error_response(err);
        }
        // 管理级只允许浏览器会话、本人的 admin key 和本机 kb.sock。Bearer(含 scope=api)与 agent.sock 都不行。
        if capability.permission == Permission::Admin
            && !(identity.is_local() || identity.acts_as_account())
        {
            return error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "管理级能力只允许浏览器会话、admin key 或本机 UDS",
            );
        }
        if let Some(groups) = &identity.tool_groups
            && !kb_capability::defs::tool_group_allows(groups, &name)
        {
            return error(
                StatusCode::FORBIDDEN,
                "forbidden",
                &format!("能力 {name} 不在这个代理的工具组里"),
            );
        }
        if name == "agent_history" && identity.via == crate::auth::AuthVia::Token {
            return error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "agent_history 不对远程令牌开放",
            );
        }
    }
    let mut ctx = CallCtx::new(identity.actor.clone(), identity.surface)
        .with_principal(identity.principal.clone());
    // 设计规范:dry_run 来自查询参数(必需)或 `X-KB-Dry-Run` 头(可选)
    let dry_run_raw = query.dry_run.clone().or_else(|| {
        headers
            .get("x-kb-dry-run")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    });
    if let Some(raw) = dry_run_raw {
        ctx.dry_run = match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" => true,
            "0" | "false" | "no" | "" => false,
            other => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_input",
                    &format!("dry_run 只能是 true / false,收到 {other}"),
                );
            }
        };
    }
    // `X-KB-Space`:浏览别人分享给我的内容时点名对方的知识库。只认浏览器会话:
    // 令牌 / 代理的访问范围由它们自己的设置决定,不能借这个头越过去;格式非法直接 400。
    if let Some(value) = headers.get("x-kb-space") {
        if !identity.acts_as_account() {
            return error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "只有在浏览器里登录后才能打开别人分享的内容",
            );
        }
        let sid = value.to_str().unwrap_or_default();
        if kb_core::share::ResourceKey::space(sid).is_err() {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "X-KB-Space 不合法",
            );
        }
        ctx.space_override = Some(sid.to_owned());
    }
    // `X-KB-Admin-View`:管理员只读查看别人的知识库。只认浏览器会话 / 本人的 admin key;
    // 与 `X-KB-Space` 互斥(一个是分享进来的,一个是管理员巡看,混用说明客户端在乱拼)。
    if let Some(value) = headers.get("x-kb-admin-view") {
        if !identity.acts_as_account() {
            return error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "只有在浏览器里登录后才能查看别人的知识库",
            );
        }
        if ctx.space_override.is_some() {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "X-KB-Admin-View 和 X-KB-Space 不能同时使用",
            );
        }
        let target = value.to_str().unwrap_or_default();
        if !valid_user_id(target) {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "X-KB-Admin-View 不合法",
            );
        }
        ctx.admin_view = Some(target.to_owned());
    }
    // 三个自定义头都必须能严格解码,任何一个失败都是 400
    for (header, slot) in [
        ("x-kb-cwd", HeaderSlot::Cwd),
        ("x-kb-client", HeaderSlot::Client),
        ("x-kb-project", HeaderSlot::Project),
    ] {
        let Some(value) = headers.get(header) else {
            continue;
        };
        let raw = match value.to_str() {
            Ok(raw) => raw,
            Err(_) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_input",
                    &format!("{header} 必须是百分号编码的 ASCII"),
                );
            }
        };
        match kb_core::pct::decode_strict(raw) {
            Ok(decoded) => match slot {
                HeaderSlot::Cwd => ctx.cwd = Some(decoded),
                HeaderSlot::Client => ctx.client = Some(decoded),
                // 设计规范:项目通过请求头传入,放在 CallCtx 里,绝不写进程环境变量
                HeaderSlot::Project => ctx.project = Some(decoded),
            },
            Err(err) => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "invalid_input",
                    &format!("{header} 编码不合法: {err}"),
                );
            }
        }
    }
    let args = body.map(|Json(value)| value).unwrap_or(Value::Null);
    let args = if args.is_null() { json!({}) } else { args };

    // 远程 MCP 令牌开了「包含共享给我」:没有限定集合 / 项目的 `search_knowledge` 改走跨知识库检索
    // (自己的 + 别人共享给我的一起搜)。限定了范围的检索照旧只搜被点名的那个地方。
    // 用户没有分享功能时(检索被拒)静默退回只搜自己的,不把错误甩给 AI 工具。
    if identity.include_shared
        && name == "search_knowledge"
        && let Some(map) = args.as_object()
        // 限定了范围(scope / project / kinds / lang / path_prefix 有值)的检索照旧;
        // query / k / rerank / explain / enhance 只影响怎么搜,不限定去哪搜
        && map.iter().all(|(key, value)| {
            matches!(key.as_str(), "query" | "k" | "rerank" | "explain" | "enhance")
                || value.is_null()
                || value.as_str().is_some_and(str::is_empty)
                || value.as_array().is_some_and(Vec::is_empty)
        })
        && let Some(query) = map.get("query").and_then(Value::as_str)
    {
        let mut shared_ctx = CallCtx::new(identity.actor.clone(), Surface::Web)
            .with_principal(identity.principal.clone());
        shared_ctx.client = ctx.client.clone();
        let mut shared_args = json!({ "query": query, "scope": "all" });
        if let Some(k) = map.get("k").filter(|value| !value.is_null()) {
            shared_args["k"] = k.clone();
        }
        match state
            .invoker
            .call("search_shared", shared_ctx, shared_args)
            .await
        {
            Ok(response) => return ok_with_meta(response.data, response.meta),
            Err(KbError::Forbidden(_) | KbError::NotFound(_)) => {}
            Err(err) => return error_response(err),
        }
    }

    match state.invoker.call(&name, ctx, args).await {
        Ok(response) => ok_with_meta(response.data, response.meta),
        Err(err) => error_response(err),
    }
}

/// 解析可见面。
pub fn parse_surface(name: &str) -> Option<Surface> {
    match name {
        "mcp" | "M" => Some(Surface::Mcp),
        "web" | "W" => Some(Surface::Web),
        "agent" | "A" => Some(Surface::Agent),
        _ => None,
    }
}

/// 成功响应。
pub fn ok(data: Value) -> Response {
    ok_with_meta(
        data,
        ResponseMeta {
            took_ms: 0,
            dry_run: false,
            batch_id: None,
            degraded: None,
            warnings: Vec::new(),
        },
    )
}

pub(crate) fn ok_with_meta(data: Value, meta: ResponseMeta) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "ok": true, "data": data, "meta": meta })),
    )
        .into_response()
}

/// 失败响应（设计规范）。
pub fn error_response(err: KbError) -> Response {
    let (status, code) = match &err {
        KbError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
        KbError::InvalidInput(_) => (StatusCode::BAD_REQUEST, "invalid_input"),
        KbError::Conflict { .. } => (StatusCode::CONFLICT, "conflict"),
        KbError::Exists(_) => (StatusCode::CONFLICT, "exists"),
        KbError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized"),
        KbError::Forbidden(_) => (StatusCode::FORBIDDEN, "forbidden"),
        KbError::Unavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, "unavailable"),
        KbError::Upstream(_) => (StatusCode::BAD_GATEWAY, "upstream"),
        KbError::Internal(_) => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    };
    error(status, code, &err.to_string())
}

pub(crate) fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "ok": false,
            "error": { "code": code, "message": message },
        })),
    )
        .into_response()
}

/// 自定义头对应的 `CallCtx` 字段。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HeaderSlot {
    /// `X-KB-Cwd`
    Cwd,
    /// `X-KB-Client`
    Client,
    /// `X-KB-Project`
    Project,
}

/// 当前请求是否来自 UDS(给需要区分来源的处理函数用)。
pub fn is_local(source: Option<&Source>) -> bool {
    matches!(source, Some(Source::Local))
}

/// 权限上限(早期 的令牌会带上它)。
pub fn max_permission_for(source: Source) -> Permission {
    match source {
        Source::Local => Permission::Admin,
        Source::Agent => Permission::Write,
        Source::Remote => Permission::Read,
    }
}
