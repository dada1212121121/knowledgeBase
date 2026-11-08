//! 用户界面偏好的 HTTP 面:`GET/PUT /api/v1/me/prefs`。
//!
//! 偏好是「这个人在浏览器里的习惯」(侧栏收起、密度、外观),换一台设备登录也该保留,所以放在服务端。
//! 只认浏览器会话:API 令牌是给程序用的,没有「界面」;本机 socket 上的超级用户也不是某个具体的人。
//! 内容由前端自己定义,服务端只限制形状与大小(见 `AccountRepo::set_prefs`)。

use std::sync::Arc;

use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::{self, AppState};
use crate::auth::Identity;

fn deny(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// 当前登录用户 id;必须是浏览器会话。
#[allow(clippy::result_large_err)]
fn browser_user_id(identity: Option<&Identity>) -> Result<String, Response> {
    let Some(identity) = identity else {
        return Err(deny(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录"));
    };
    if !identity.acts_as_account() {
        return Err(deny(
            StatusCode::FORBIDDEN,
            "forbidden",
            "界面偏好只能在浏览器里读写",
        ));
    }
    identity
        .user
        .as_ref()
        .map(|user| user.id.clone())
        .ok_or_else(|| deny(StatusCode::FORBIDDEN, "forbidden", "没有可用的账号"))
}

/// `PUT /api/v1/me/prefs` 的请求体。
#[derive(Debug, Deserialize)]
pub struct PrefsBody {
    /// 整体替换成这个对象。
    pub prefs: Value,
}

/// `GET /api/v1/me/prefs`:读偏好(没存过是空对象)。
pub async fn get(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    let user_id = match browser_user_id(extensions.get::<Identity>()) {
        Ok(id) => id,
        Err(response) => return response,
    };
    match state.system.get_prefs(&user_id).await {
        Ok(prefs) => api::ok(json!({ "prefs": prefs })),
        Err(err) => api::error_response(err),
    }
}

/// `PUT /api/v1/me/prefs`:整体替换。
pub async fn put(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(body): Json<PrefsBody>,
) -> Response {
    let user_id = match browser_user_id(extensions.get::<Identity>()) {
        Ok(id) => id,
        Err(response) => return response,
    };
    let now = crate::auth::session::now_millis();
    match state.system.set_prefs(&user_id, &body.prefs, now).await {
        Ok(()) => api::ok(json!({ "prefs": body.prefs })),
        Err(err) => api::error_response(err),
    }
}
