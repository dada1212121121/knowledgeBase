//! `POST /api/v1/events`。
//!
//! 事件处理逻辑在 `kb-service`,这里只定义端口由组装根(`kb-cli`)注入,
//! 保持 `kb-web` 不依赖 `kb-service`（设计规范）。

use std::sync::Arc;

use axum::extract::{Extension, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};

use crate::api::AppState;
use crate::auth::{AuthVia, Identity};

/// 事件处理器。
#[async_trait::async_trait]
pub trait EventSink: Send + Sync {
    /// 处理一条事件,返回要回给调用方的 `data`。
    async fn handle_event(
        &self,
        caller: &crate::auth::Caller,
        request: Value,
    ) -> kb_core::Result<Value>;
}

/// `POST /api/v1/events`。
///
/// **会话记录路径只接受本机(UDS)投递**:`session_end` 带着 `session_path` /
/// `transcript_path` 时,守护进程会去读那个文件并（按项目设置）外发给 LLM。
/// 这条通道只该由本机的 `kb hook` 使用;TCP 上任何身份（含 `scope=mcp` 的令牌）
/// 都不许借它读本机文件。
pub async fn handler(
    State(state): State<Arc<AppState>>,
    Extension(identity): Extension<Identity>,
    body: Option<axum::Json<Value>>,
) -> Response {
    let Some(sink) = state.events.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用事件接收");
    };
    let request = body.map(|axum::Json(value)| value).unwrap_or(Value::Null);
    if !request.is_object() {
        return error(StatusCode::BAD_REQUEST, "invalid_input", "事件体必须是对象");
    }
    if identity.via != AuthVia::Local && carries_session_path(&request) {
        return error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "会话记录路径只接受本机(Unix socket)投递",
        );
    }
    match sink
        .handle_event(&crate::auth::Caller::from(&identity), request)
        .await
    {
        Ok(data) => (
            StatusCode::OK,
            axum::Json(json!({ "ok": true, "data": data })),
        )
            .into_response(),
        Err(err) => {
            let (status, code) = match &err {
                kb_core::KbError::InvalidInput(_) => (StatusCode::BAD_REQUEST, "invalid_input"),
                kb_core::KbError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
                _ => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
            };
            error(status, code, &err.to_string())
        }
    }
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({
            "ok": false,
            "error": { "code": code, "message": message },
        })),
    )
        .into_response()
}

/// 事件体里有没有带会话记录路径。
fn carries_session_path(request: &Value) -> bool {
    let Some(payload) = request.get("payload") else {
        return false;
    };
    ["session_path", "transcript_path"].iter().any(|key| {
        payload
            .get(*key)
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_events_carrying_a_session_path_are_restricted() {
        assert!(carries_session_path(&json!({
            "kind": "session_end",
            "payload": { "session_path": "/tmp/x.jsonl" }
        })));
        assert!(carries_session_path(&json!({
            "kind": "session_end",
            "payload": { "transcript_path": "/tmp/x.jsonl" }
        })));
        // 空串等于没给
        assert!(!carries_session_path(&json!({
            "kind": "session_end",
            "payload": { "session_path": "  " }
        })));
        // git 事件没有路径
        assert!(!carries_session_path(&json!({
            "kind": "git_commit",
            "payload": { "hook": "post-commit" }
        })));
        assert!(!carries_session_path(&json!({ "kind": "session_end" })));
    }
}
