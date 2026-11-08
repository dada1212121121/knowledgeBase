//! 「登录设备」:看自己有哪些会话、退出某一个、退出其它所有设备(多用户设计说明)。
//!
//! - 只认浏览器会话,API 令牌不能管理登录设备。
//! - 返回给页面的会话 id 是 `sha256("session-id|" + 令牌哈希)` 的前 16 位:和库里的主键无关,
//!   就算出现在截图、日志里也不能拿它做任何事。要退出哪个会话,服务端只在**当前用户自己的**
//!   会话里找这个 id,所以传别人的 id 只会得到「找不到」。
//! - 设备描述由 `devices::describe` 生成固定词汇,**不回显 User-Agent 原文**。

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use kb_core::KbError;
use kb_core::account::UserSession;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::api::{self, AppState};
use crate::auth::token::sha256_hex;
use crate::auth::{Identity, session};
use crate::devices;

fn deny(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({ "ok": false, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// 对外的会话 id(见模块说明)。
pub fn public_id(token_hash: &str) -> String {
    let digest = Sha256::digest(format!("session-id|{token_hash}").as_bytes());
    digest[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 当前请求用的是哪个会话(令牌哈希)。
fn current_hash(headers: &HeaderMap) -> Option<String> {
    session::cookie_token(headers).map(|raw| sha256_hex(&raw))
}

#[allow(clippy::result_large_err)]
fn browser_user(identity: Option<&Identity>) -> Result<String, Response> {
    let Some(identity) = identity else {
        return Err(deny(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录"));
    };
    if !identity.acts_as_account() {
        return Err(deny(
            StatusCode::FORBIDDEN,
            "forbidden",
            "只有在浏览器里登录后才能管理登录设备",
        ));
    }
    identity
        .user
        .as_ref()
        .map(|user| user.id.clone())
        .ok_or_else(|| deny(StatusCode::FORBIDDEN, "forbidden", "没有可管理的账号"))
}

fn view(session: &UserSession, current: Option<&str>) -> serde_json::Value {
    json!({
        "id": public_id(&session.token_hash),
        "current": current == Some(session.token_hash.as_str()),
        "device": devices::describe(session.user_agent.as_deref()),
        "ip": session.ip,
        "created_at": session.created_at,
        "last_seen": session.last_seen,
        "expires_at": session.expires_at,
    })
}

/// `GET /api/v1/me/sessions`
pub async fn list(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
) -> Response {
    let user_id = match browser_user(extensions.get::<Identity>()) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let current = current_hash(&headers);
    match state
        .system
        .list_user_sessions(&user_id, session::now_millis())
        .await
    {
        Ok(sessions) => api::ok(json!({
            "sessions": sessions.iter().map(|s| view(s, current.as_deref())).collect::<Vec<_>>(),
        })),
        Err(err) => api::error_response(err),
    }
}

/// `DELETE /api/v1/me/sessions/{id}`:退出某一个设备。退出的就是当前这个也可以(等同于退出登录)。
pub async fn revoke(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
) -> Response {
    let user_id = match browser_user(extensions.get::<Identity>()) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let sessions = match state
        .system
        .list_user_sessions(&user_id, session::now_millis())
        .await
    {
        Ok(sessions) => sessions,
        Err(err) => return api::error_response(err),
    };
    // 只在这个人自己的会话里找:传别人的 id 就是「找不到」
    let Some(target) = sessions
        .iter()
        .find(|session| public_id(&session.token_hash) == id)
    else {
        return api::error_response(KbError::NotFound(
            "这台设备的登录已经失效或不存在".to_owned(),
        ));
    };
    if let Err(err) = state.system.delete_session(&target.token_hash).await {
        return api::error_response(err);
    }
    let was_current = current_hash(&headers).as_deref() == Some(target.token_hash.as_str());
    let _ = state
        .system
        .record_audit(
            Some(&user_id),
            "session.revoke",
            None,
            &json!({ "current": was_current }),
            None,
        )
        .await;
    api::ok(json!({ "revoked": true, "current": was_current }))
}

/// `POST /api/v1/me/sessions/revoke-others`:退出除当前设备外的所有设备(怀疑账号被盗时用)。
pub async fn revoke_others(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
) -> Response {
    let user_id = match browser_user(extensions.get::<Identity>()) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let Some(current) = current_hash(&headers) else {
        return deny(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录");
    };
    match state
        .system
        .delete_user_sessions(&user_id, Some(&current))
        .await
    {
        Ok(count) => {
            let _ = state
                .system
                .record_audit(
                    Some(&user_id),
                    "session.revoke_others",
                    None,
                    &json!({ "count": count }),
                    None,
                )
                .await;
            api::ok(json!({ "revoked": count }))
        }
        Err(err) => api::error_response(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_ids_are_stable_short_and_unrelated_to_the_database_key() {
        let hash = "a".repeat(64);
        let id = public_id(&hash);
        assert_eq!(id.len(), 16);
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(id, public_id(&hash), "同一个会话每次得到同一个 id");
        assert_ne!(id, public_id(&"b".repeat(64)));
        assert!(
            !hash.contains(&id) && !id.contains(&hash[..8]),
            "id 不是令牌哈希的片段"
        );
    }
}
