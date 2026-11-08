//! 上传接口 `POST /api/v1/uploads`。
//!
//! 与能力调用(`/api/v1/capabilities/{name}`)分开,是因为上传要收发**二进制分片**:
//! 能力包装层的入参是 JSON,塞不下 8 MB 的分片。
//!
//! 协议:
//! - `POST   /api/v1/uploads`                声明文件 → 分片规划 + 已收分片(续传)
//! - `GET    /api/v1/uploads/{id}`           续传信息
//! - `PUT    /api/v1/uploads/{id}/parts/{n}` 写一个分片(请求体是原始字节,`X-KB-Part-Sha256` 可选)
//! - `POST   /api/v1/uploads/{id}/complete`  合并 + 校验 + 入解析队列
//! - `DELETE /api/v1/uploads/{id}`           取消
//! - `POST   /api/v1/uploads/precheck`       去重预检(秒传)
//!
//! 鉴权走 [`crate::auth::guard`]:TCP 来源要会话或 Bearer,非 GET 还要 CSRF 头;
//! 这里再要求至少 W 级权限(上传会写库)。

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use kb_capability::Permission;
use kb_core::KbError;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::api::AppState;
use crate::auth::{Caller, Identity};

/// 上传相关的后端(由组装根 `kb-cli` 实现,`kb-web` 不依赖 `kb-service`)。
#[async_trait::async_trait]
pub trait UploadApi: Send + Sync {
    /// 新建上传。
    async fn create_upload(
        &self,
        caller: &Caller,
        request: CreateUploadRequest,
    ) -> kb_core::Result<Value>;
    /// 续传信息。
    async fn upload_status(&self, caller: &Caller, upload_id: &str) -> kb_core::Result<Value>;
    /// 写一个分片。
    async fn put_part(
        &self,
        caller: &Caller,
        upload_id: &str,
        part_no: u32,
        bytes: Vec<u8>,
        sha256: Option<String>,
    ) -> kb_core::Result<Value>;
    /// 完成上传。
    async fn complete_upload(&self, caller: &Caller, upload_id: &str) -> kb_core::Result<Value>;
    /// 取消上传。
    async fn abort_upload(&self, caller: &Caller, upload_id: &str) -> kb_core::Result<Value>;
    /// 去重预检。
    async fn precheck(&self, caller: &Caller, request: PrecheckRequest) -> kb_core::Result<Value>;
    /// 编辑器把没改过的文档重新保存了一遍,和原件比:这个引擎能不能无损地处理这份文档。
    async fn roundtrip_check(
        &self,
        caller: &Caller,
        request: RoundtripCheckRequest,
        bytes: Vec<u8>,
    ) -> kb_core::Result<Value>;
    /// 申请(或用同一个会话再次申请 = 心跳)这份文件的编辑权。
    async fn lock_file(&self, caller: &Caller, request: FileLockRequest) -> kb_core::Result<Value>;
    /// 交还编辑权(只有持有者的会话能交还)。
    async fn unlock_file(
        &self,
        caller: &Caller,
        request: FileUnlockRequest,
    ) -> kb_core::Result<Value>;
    /// 用新内容替换一个已有文件(上传新版本),旧内容留在版本历史里。
    async fn replace_file(
        &self,
        caller: &Caller,
        request: ReplaceFileRequest,
        bytes: Vec<u8>,
    ) -> kb_core::Result<Value>;
}

/// `POST /api/v1/files/lock` 的请求体:申请或续上编辑权。
#[derive(Clone, Debug, Deserialize)]
pub struct FileLockRequest {
    /// collection 名。
    pub collection: String,
    /// 文件(集合内相对路径)。
    pub path: String,
    /// 编辑器窗口的随机编号(每个标签页一个);同一个编号再次申请就是心跳。
    pub session: String,
    /// 别人持有着也强行接手(界面上要用户明确确认)。
    #[serde(default)]
    pub take_over: bool,
}

/// `DELETE /api/v1/files/lock` 的查询参数:交还编辑权。
#[derive(Clone, Debug, Deserialize)]
pub struct FileUnlockRequest {
    /// collection 名。
    pub collection: String,
    /// 文件(集合内相对路径)。
    pub path: String,
    /// 编辑器窗口的随机编号。
    pub session: String,
}

/// `POST /api/v1/files/roundtrip-check` 的查询参数(请求体是编辑器重新保存出来的字节)。
#[derive(Clone, Debug, Deserialize)]
pub struct RoundtripCheckRequest {
    /// collection 名。
    pub collection: String,
    /// 原文件(集合内相对路径)。
    pub path: String,
}

/// `PUT /api/v1/files/replace` 的查询参数(请求体是新文件的原始字节)。
#[derive(Clone, Debug, Deserialize)]
pub struct ReplaceFileRequest {
    /// collection 名。
    pub collection: String,
    /// 要替换的文件(集合内相对路径)。
    pub path: String,
    /// 打开时那份内容的 sha256(`file_info` 返回的);给了就做乐观锁。
    #[serde(default)]
    pub expected_sha256: Option<String>,
    /// 编辑器窗口的编号(见 `FileLockRequest`)。文件的编辑权在**别的**窗口手里时,带不带这个都会被拒绝;
    /// 没有人持有编辑权时照旧可以替换(命令行、旧客户端)。
    #[serde(default)]
    pub session: Option<String>,
}

/// `POST /api/v1/uploads` 的请求体。
#[derive(Clone, Debug, Deserialize)]
pub struct CreateUploadRequest {
    /// 文件名。
    pub name: String,
    /// 字节数。
    pub size: u64,
    /// 客户端算的整体 sha256(可空;秒传与整体校验用)。
    #[serde(default)]
    pub sha256: Option<String>,
    /// 集合内相对路径(文件夹上传时带目录)。
    #[serde(default)]
    pub rel_path: Option<String>,
    /// 目标 collection。
    pub collection: String,
    /// 标签。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 共享批次 id(同一个文件夹用同一个)。
    #[serde(default)]
    pub batch: Option<String>,
    /// 同名不同内容的策略:`skip` / `overwrite` / `keep_both`。
    #[serde(default)]
    pub strategy: Option<String>,
}

/// 预检的一条。
#[derive(Clone, Debug, Deserialize)]
pub struct PrecheckItemRequest {
    /// 集合内相对路径。
    pub rel_path: String,
    /// 字节数。
    pub size: u64,
    /// 客户端算的 sha256。
    pub sha256: String,
}

/// `POST /api/v1/uploads/precheck` 的请求体。
#[derive(Clone, Debug, Deserialize)]
pub struct PrecheckRequest {
    /// 目标 collection。
    pub collection: String,
    /// 要预检的文件。
    pub files: Vec<PrecheckItemRequest>,
}

/// `POST /api/v1/uploads`。
pub async fn create(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(request): Json<CreateUploadRequest>,
) -> Response {
    let Some(api) = state.uploads.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用上传接口");
    };
    let Some(identity) = allow_write(&extensions) else {
        return forbidden();
    };
    match api.create_upload(&Caller::from(&identity), request).await {
        Ok(data) => ok(data),
        Err(err) => error_response(err),
    }
}

/// `GET /api/v1/uploads/{id}`。
pub async fn status(
    State(state): State<Arc<AppState>>,
    Path(upload_id): Path<String>,
    extensions: axum::http::Extensions,
) -> Response {
    let Some(api) = state.uploads.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用上传接口");
    };
    let Some(identity) = allow_upload(&extensions) else {
        return forbidden();
    };
    match api
        .upload_status(&Caller::from(&identity), &upload_id)
        .await
    {
        Ok(data) => ok(data),
        Err(err) => error_response(err),
    }
}

/// `PUT /api/v1/uploads/{id}/parts/{n}`。
pub async fn put_part(
    State(state): State<Arc<AppState>>,
    Path((upload_id, part_no)): Path<(String, u32)>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
    body: Bytes,
) -> Response {
    let Some(api) = state.uploads.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用上传接口");
    };
    let Some(identity) = allow_write(&extensions) else {
        return forbidden();
    };
    let sha256 = headers
        .get("x-kb-part-sha256")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    match api
        .put_part(
            &Caller::from(&identity),
            &upload_id,
            part_no,
            body.to_vec(),
            sha256,
        )
        .await
    {
        Ok(data) => ok(data),
        Err(err) => error_response(err),
    }
}

/// `POST /api/v1/uploads/{id}/complete`。
pub async fn complete(
    State(state): State<Arc<AppState>>,
    Path(upload_id): Path<String>,
    extensions: axum::http::Extensions,
) -> Response {
    let Some(api) = state.uploads.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用上传接口");
    };
    let Some(identity) = allow_write(&extensions) else {
        return forbidden();
    };
    match api
        .complete_upload(&Caller::from(&identity), &upload_id)
        .await
    {
        Ok(data) => ok(data),
        Err(err) => error_response(err),
    }
}

/// `DELETE /api/v1/uploads/{id}`。
pub async fn abort(
    State(state): State<Arc<AppState>>,
    Path(upload_id): Path<String>,
    extensions: axum::http::Extensions,
) -> Response {
    let Some(api) = state.uploads.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用上传接口");
    };
    let Some(identity) = allow_write(&extensions) else {
        return forbidden();
    };
    match api.abort_upload(&Caller::from(&identity), &upload_id).await {
        Ok(data) => ok(data),
        Err(err) => error_response(err),
    }
}

/// `POST /api/v1/uploads/precheck`。
pub async fn precheck(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(request): Json<PrecheckRequest>,
) -> Response {
    let Some(api) = state.uploads.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用上传接口");
    };
    let Some(identity) = allow_upload(&extensions) else {
        return forbidden();
    };
    match api.precheck(&Caller::from(&identity), request).await {
        Ok(data) => ok(data),
        Err(err) => error_response(err),
    }
}

/// `PUT /api/v1/files/replace?collection=…&path=…&expected_sha256=…`:上传新版本替换原件。
///
/// 和普通上传分开:普通上传是"把一个新文件放进知识库",这里是"换掉一个已有文件的内容"——
/// 位置不变(项目目录里的文件也是原地替换)、旧内容进版本历史可恢复。文件不大(上限 64 MB),一次传完,
/// 不走分片续传。要同时开通上传和编辑两个功能。
pub async fn replace_file(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(request): axum::extract::Query<ReplaceFileRequest>,
    extensions: axum::http::Extensions,
    body: Bytes,
) -> Response {
    let Some(api) = state.uploads.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用上传接口");
    };
    let Some(identity) = allow_write(&extensions)
        .filter(|identity| identity.principal.features.allows("docs.edit_text"))
    else {
        return error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "当前身份不能替换文件(需要同时开通上传和编辑功能,令牌也不能是只读的)",
        );
    };
    match api
        .replace_file(&Caller::from(&identity), request, body.to_vec())
        .await
    {
        Ok(data) => ok(data),
        Err(err) => error_response(err),
    }
}

/// 在线编辑要的身份:能编辑、能上传(和替换文件一致),但不要求写权限之外的东西。
fn editor_identity(extensions: &axum::http::Extensions) -> Option<Identity> {
    allow_upload(extensions).filter(|identity| identity.principal.features.allows("docs.edit_text"))
}

/// `POST /api/v1/files/lock`:申请或续上编辑权(心跳)。
///
/// 返回 `{ held: bool, ttl_secs, holder, took_over_from }`:`held` 为假时 `holder` 是现在持有的人(账号、
/// 开始时间、最近一次心跳距今几秒),界面据此显示「某某正在编辑」并退回只读。
pub async fn lock_file(
    State(state): State<Arc<AppState>>,
    extensions: axum::http::Extensions,
    Json(request): Json<FileLockRequest>,
) -> Response {
    let Some(api) = state.uploads.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用上传接口");
    };
    let Some(identity) = editor_identity(&extensions) else {
        return error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "当前身份不能编辑文件(需要同时开通上传和编辑功能)",
        );
    };
    match api.lock_file(&Caller::from(&identity), request).await {
        Ok(data) => ok(data),
        Err(err) => error_response(err),
    }
}

/// `DELETE /api/v1/files/lock?collection=…&path=…&session=…`:交还编辑权。
pub async fn unlock_file(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(request): axum::extract::Query<FileUnlockRequest>,
    extensions: axum::http::Extensions,
) -> Response {
    let Some(api) = state.uploads.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用上传接口");
    };
    let Some(identity) = editor_identity(&extensions) else {
        return error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "当前身份不能编辑文件(需要同时开通上传和编辑功能)",
        );
    };
    match api.unlock_file(&Caller::from(&identity), request).await {
        Ok(data) => ok(data),
        Err(err) => error_response(err),
    }
}

/// `POST /api/v1/files/roundtrip-check?collection=…&path=…`:检查编辑器能不能无损地处理这份文档。
///
/// 请求体是编辑器**没改任何内容**就保存出来的字节;服务器拿它和原件比(见 `FileEditService::roundtrip_report`),
/// 回答「无损 / 哪些部件变了 / 文字是否一样」。不写任何东西,所以只要求能编辑,不要求写权限。
pub async fn roundtrip_check(
    State(state): State<Arc<AppState>>,
    axum::extract::Query(request): axum::extract::Query<RoundtripCheckRequest>,
    extensions: axum::http::Extensions,
    body: Bytes,
) -> Response {
    let Some(api) = state.uploads.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用上传接口");
    };
    let Some(identity) = allow_upload(&extensions)
        .filter(|identity| identity.principal.features.allows("docs.edit_text"))
    else {
        return error(
            StatusCode::FORBIDDEN,
            "forbidden",
            "当前身份不能编辑文件(需要同时开通上传和编辑功能)",
        );
    };
    match api
        .roundtrip_check(&Caller::from(&identity), request, body.to_vec())
        .await
    {
        Ok(data) => ok(data),
        Err(err) => error_response(err),
    }
}

/// 至少要 W 级权限(上传会写库),并且账号开通了「上传文件与附件」功能。
fn allow_write(extensions: &axum::http::Extensions) -> Option<Identity> {
    let identity = allow_upload(extensions)?;
    kb_capability::invoke::check_permission(Permission::Write, identity.max_permission).ok()?;
    Some(identity)
}

/// 有身份,并且开通了上传功能(读状态、预检也要)。
fn allow_upload(extensions: &axum::http::Extensions) -> Option<Identity> {
    let identity = extensions.get::<Identity>().cloned()?;
    identity
        .principal
        .features
        .allows("docs.upload")
        .then_some(identity)
}

fn forbidden() -> Response {
    error(
        StatusCode::FORBIDDEN,
        "forbidden",
        "当前身份没有上传权限(账号没有开通上传功能,或令牌是只读的)",
    )
}

fn ok(data: Value) -> Response {
    (StatusCode::OK, Json(json!({ "ok": true, "data": data }))).into_response()
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "ok": false,
            "error": { "code": code, "message": message },
        })),
    )
        .into_response()
}

/// `KbError` → HTTP 响应(与 `api::error_response` 同一套映射)。
fn error_response(err: KbError) -> Response {
    crate::api::error_response(err)
}
