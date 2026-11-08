//! 个人数据导出的 HTTP 面(多用户设计说明)。
//!
//! 真正的打包由 `kb-cli` 里的实现完成(它知道每个用户的知识库在哪、有没有磁盘),
//! web 层只做三件事:认人(浏览器会话)、把请求转给它、把生成好的文件**流式**交给用户。
//! 流式很重要:导出文件可能有几十 GB,不能整个读进内存。

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use kb_core::model::Millis;
use kb_core::{KbError, Result};
use serde::Serialize;
use serde_json::json;

use crate::api::{self, AppState};
use crate::auth::Identity;

/// 一个人当前的导出状态。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum ExportStatus {
    /// 没有导出,可以开始。`today_left` 是今天还能导出几次。
    Idle {
        /// 今天还剩几次。
        today_left: u32,
    },
    /// 正在打包。
    Running {
        /// 已处理字节。
        bytes_done: u64,
        /// 总字节。
        bytes_total: u64,
        /// 原始文件数。
        files: u64,
        /// 笔记条数。
        notes: u64,
    },
    /// 已生成,可以下载。
    Ready {
        /// 文件大小(压缩后)。
        size: u64,
        /// 里面有几个原始文件。
        files: u64,
        /// 里面有几条笔记。
        notes: u64,
        /// 被跳过的东西的说明(符号链接、非法文件名等)。
        skipped: Vec<String>,
        /// 过期时间,到点自动删除。
        expires_at: Millis,
    },
    /// 失败了。
    Failed {
        /// 给用户看的原因。
        reason: String,
    },
}

/// 导出的实现(`kb-cli` 提供)。
#[async_trait]
pub trait PersonalExport: Send + Sync {
    /// 开始一次导出。已有进行中的返回 `Exists`;今天次数用完、磁盘不够返回相应错误。
    async fn start(
        &self,
        user_id: &str,
        space_id: Option<&str>,
        now: Millis,
    ) -> Result<ExportStatus>;
    /// 现在的状态。
    async fn status(&self, user_id: &str, now: Millis) -> Result<ExportStatus>;
    /// 可下载的文件路径与建议文件名;没有或已过期返回 `None`。
    async fn file(&self, user_id: &str, now: Millis) -> Result<Option<(PathBuf, String)>>;
    /// 删掉已生成的文件。
    async fn discard(&self, user_id: &str) -> Result<()>;
}

/// 没接导出的场景(测试、嵌入式):一律不可用。
pub struct NoExport;

#[async_trait]
impl PersonalExport for NoExport {
    async fn start(&self, _: &str, _: Option<&str>, _: Millis) -> Result<ExportStatus> {
        Err(KbError::Unavailable("数据导出没有启用".to_owned()))
    }
    async fn status(&self, _: &str, _: Millis) -> Result<ExportStatus> {
        Err(KbError::Unavailable("数据导出没有启用".to_owned()))
    }
    async fn file(&self, _: &str, _: Millis) -> Result<Option<(PathBuf, String)>> {
        Ok(None)
    }
    async fn discard(&self, _: &str) -> Result<()> {
        Ok(())
    }
}

fn deny(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({ "ok": false, "error": { "code": code, "message": message } })),
    )
        .into_response()
}

/// 当前用户 id 和他的知识库 id;只认浏览器会话。
#[allow(clippy::result_large_err)]
fn browser_user(
    identity: Option<&Identity>,
) -> std::result::Result<(String, Option<String>), Response> {
    let Some(identity) = identity else {
        return Err(deny(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录"));
    };
    if !identity.acts_as_account() {
        return Err(deny(
            StatusCode::FORBIDDEN,
            "forbidden",
            "只有在浏览器里登录后才能导出数据",
        ));
    }
    let user = identity
        .user
        .as_ref()
        .ok_or_else(|| deny(StatusCode::FORBIDDEN, "forbidden", "没有可导出的账号"))?;
    Ok((user.id.clone(), identity.principal.space_id.clone()))
}

/// `POST /api/v1/me/export`:开始导出。
pub async fn start(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    let (user_id, space_id) = match browser_user(extensions.get::<Identity>()) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let now = crate::auth::session::now_millis();
    match state
        .account
        .exports
        .start(&user_id, space_id.as_deref(), now)
        .await
    {
        Ok(status) => api::ok(json!(status)),
        Err(err) => api::error_response(err),
    }
}

/// `GET /api/v1/me/export`:现在的状态。
pub async fn status(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    let (user_id, _) = match browser_user(extensions.get::<Identity>()) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    match state
        .account
        .exports
        .status(&user_id, crate::auth::session::now_millis())
        .await
    {
        Ok(status) => api::ok(json!(status)),
        Err(err) => api::error_response(err),
    }
}

/// `DELETE /api/v1/me/export`:删掉已生成的导出文件。
pub async fn discard(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    let (user_id, _) = match browser_user(extensions.get::<Identity>()) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    match state.account.exports.discard(&user_id).await {
        Ok(()) => api::ok(json!({ "discarded": true })),
        Err(err) => api::error_response(err),
    }
}

/// `GET /api/v1/me/export/download`:下载。流式发送,文件再大也不占内存。
pub async fn download(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
) -> Response {
    let (user_id, _) = match browser_user(extensions.get::<Identity>()) {
        Ok(pair) => pair,
        Err(response) => return response,
    };
    let found = state
        .account
        .exports
        .file(&user_id, crate::auth::session::now_millis())
        .await;
    let (path, filename) = match found {
        Ok(Some(pair)) => pair,
        Ok(None) => {
            return deny(
                StatusCode::NOT_FOUND,
                "not_found",
                "没有可下载的导出文件,或已经过期",
            );
        }
        Err(err) => return api::error_response(err),
    };
    let file = match tokio::fs::File::open(&path).await {
        Ok(file) => file,
        Err(_) => {
            return deny(
                StatusCode::NOT_FOUND,
                "not_found",
                "没有可下载的导出文件,或已经过期",
            );
        }
    };
    let length = file.metadata().await.map(|meta| meta.len()).ok();
    // 流式发送:一块一块读、一块一块发,文件再大也不会整个进内存
    let stream = tokio_util::io::ReaderStream::with_capacity(file, 64 * 1024);
    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/gzip"),
    );
    // 文件名由我们自己生成(只含字母数字和 -_.),放进头里不需要转义;仍然校验一遍
    let safe_name: String = filename
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        .collect();
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{safe_name}\"")) {
        headers.insert(header::CONTENT_DISPOSITION, value);
    }
    if let Some(length) = length
        && let Ok(value) = HeaderValue::from_str(&length.to_string())
    {
        headers.insert(header::CONTENT_LENGTH, value);
    }
    // 里面是用户自己的文件:不让任何中间缓存存它,也不让浏览器当网页打开
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}
