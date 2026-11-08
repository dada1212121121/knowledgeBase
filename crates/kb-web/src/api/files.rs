//! REST 处理函数(设计规范的请求 / 响应契约)。

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    RANGE,
};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use kb_capability::invoke::CallCtx;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use crate::auth::Identity;

use super::call::error;
use super::*;

pub async fn raw(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RawQuery>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
) -> Response {
    let Some(identity) = extensions.get::<Identity>().cloned() else {
        return error(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录");
    };
    let resolved = match file_raw_for(&state, &identity, &query, &headers).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    match raw_response(&resolved, false).await {
        Ok((response, _)) => response,
        Err(response) => response,
    }
}

/// `GET /api/v1/download?collection=…&path=…`:下载原件。
///
/// 与 `/raw` 的区别只在「怎么下发」:这里不设 64 MB 上限、按附件下发,并支持单段 Range。
/// 鉴权、路径校验、分享范围都复用 `file_raw`,不另开一套。
pub async fn download(
    State(state): State<Arc<AppState>>,
    Query(query): Query<RawQuery>,
    headers: HeaderMap,
    extensions: axum::http::Extensions,
) -> Response {
    let Some(identity) = extensions.get::<Identity>().cloned() else {
        return error(StatusCode::UNAUTHORIZED, "unauthorized", "请先登录");
    };
    let resolved = match file_raw_for(&state, &identity, &query, &headers).await {
        Ok(resolved) => resolved,
        Err(response) => return response,
    };
    match download_response(
        &resolved,
        headers.get(RANGE).and_then(|value| value.to_str().ok()),
    )
    .await
    {
        Ok((response, _)) => response,
        Err(response) => response,
    }
}

/// `/raw` 与 `/download` 共用的入口校验 + `file_raw` 调用。
#[allow(clippy::result_large_err)]
pub(crate) async fn file_raw_for(
    state: &Arc<AppState>,
    identity: &Identity,
    query: &RawQuery,
    headers: &HeaderMap,
) -> std::result::Result<Value, Response> {
    // 与 `call` 同形:先过一遍权限上限(Read 级,这里只是保持入口一致)
    if let Some(capability) = state.invoker.registry().get("file_raw")
        && let Err(err) =
            kb_capability::invoke::check_permission(capability.permission, identity.max_permission)
    {
        return Err(error_response(err));
    }
    // 带上身份:原件只会从调用者自己的知识库里取(没有身份的调用在强制模式下是 401)
    let mut ctx = CallCtx::new(identity.actor.clone(), identity.surface)
        .with_principal(identity.principal.clone());
    // 点名别人的知识库:和 `X-KB-Space` 同样的限制(只认浏览器会话、格式严格校验)
    if let Some(space) = query.space.as_deref() {
        if !identity.acts_as_account() {
            return Err(error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "只有在浏览器里登录后才能打开别人分享的内容",
            ));
        }
        if kb_core::share::ResourceKey::space(space).is_err() {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "space 不合法",
            ));
        }
        ctx.space_override = Some(space.to_owned());
    }
    // 管理员只读查看:同样放在查询参数里(`<img src>` 带不了自定义头),与 space 互斥
    let header_admin_view = headers
        .get("x-kb-admin-view")
        .and_then(|value| value.to_str().ok());
    if let Some(admin_view) = query.admin_view.as_deref().or(header_admin_view) {
        if query.space.is_some() || (query.admin_view.is_some() && header_admin_view.is_some()) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "admin_view 和 space 不能同时使用",
            ));
        }
        if !identity.acts_as_account() {
            return Err(error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "只有在浏览器里登录后才能查看别人的知识库",
            ));
        }
        if !valid_user_id(admin_view) {
            return Err(error(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                "admin_view 不合法",
            ));
        }
        ctx.admin_view = Some(admin_view.to_owned());
    }
    let args = json!({ "collection": query.collection, "path": query.path });
    match state.invoker.call("file_raw", ctx, args).await {
        Ok(response) => Ok(response.data),
        Err(err) => Err(error_response(err)),
    }
}

/// 把 `file_raw` 的结果(路径、类型、大小)变成响应:先看大小再读盘,图片 / 音视频内联,其余按附件下发。
/// 返回响应和文件大小(分享链接据此累计游客流量);失败时的 `Err` 也是一个现成的响应。
#[allow(clippy::result_large_err)]
pub(crate) async fn raw_response(
    resolved: &Value,
    inline_only: bool,
) -> std::result::Result<(Response, u64), Response> {
    let Some(path) = resolved.get("path").and_then(Value::as_str) else {
        return Err(error(StatusCode::NOT_FOUND, "not_found", "找不到原件"));
    };
    let mime = resolved
        .get("mime")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    // 不是图片 / 音视频的(含 SVG、application/octet-stream)一律按附件下发:
    // 直接在管理端同源打开一个被索引的 SVG 会执行其中的脚本
    let inline = matches!(
        mime.split(';').next().unwrap_or_default().trim(),
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/bmp"
            | "audio/mpeg"
            | "audio/wav"
            | "audio/mp4"
            | "audio/flac"
            | "audio/ogg"
            | "video/mp4"
            | "video/webm"
            | "video/quicktime"
    );
    // 分享链接关了「允许下载」:只给能在页面里直接预览的(图片 / 音视频),其余原件不下发。
    // 浏览器里能看到的内容当然也能另存,这条拦的是「下载原件」这个动作,不是内容保密
    if inline_only && !inline {
        return Err(error(
            StatusCode::FORBIDDEN,
            "download_disabled",
            "这个链接不允许下载原件",
        ));
    }
    // 先看大小再读盘:否则一个几 GB 的视频会先把守护进程的内存吃满
    let Some(size) = resolved.get("size").and_then(Value::as_u64) else {
        return Err(error(StatusCode::NOT_FOUND, "not_found", "原件大小未知"));
    };
    if size > MAX_RAW_BYTES {
        return Err(error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "原件超过 64 MB,不走预览内联",
        ));
    }
    // 读取时再套一层上限:canonicalize 与 read 之间仍有极窄的替换窗口(这是已知的替换窗口)
    let bytes = match read_capped(path).await {
        Ok(bytes) => bytes,
        Err(err) => {
            // 不把服务端绝对路径带给客户端;只说明读不到
            let _ = err;
            return Err(error(
                StatusCode::NOT_FOUND,
                "not_found",
                "读取原件失败,文件可能已被移动",
            ));
        }
    };
    let name = resolved
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("file");
    let disposition = if inline { "inline" } else { "attachment" };
    let response = (
        StatusCode::OK,
        [
            ("content-type", mime.to_owned()),
            (
                "content-disposition",
                format!("{disposition}; {}", disposition_name(name)),
            ),
            ("cache-control", "private, max-age=60".to_owned()),
            // 不允许浏览器猜类型,也不允许内联内容执行脚本 / 被当页面嵌入
            ("x-content-type-options", "nosniff".to_owned()),
            (
                "content-security-policy",
                "sandbox; default-src 'none'".to_owned(),
            ),
        ],
        bytes,
    )
        .into_response();
    Ok((response, size))
}

/// 把 `file_raw` 的结果流式下发成附件,支持单段 `Range`(大文件断点续传 / 播放器拖动)。
/// 返回响应和实际发送的字节数(分享链接据此累计游客流量)。
#[allow(clippy::result_large_err)]
pub(crate) async fn download_response(
    resolved: &Value,
    range_header: Option<&str>,
) -> std::result::Result<(Response, u64), Response> {
    let Some(path) = resolved.get("path").and_then(Value::as_str) else {
        return Err(error(StatusCode::NOT_FOUND, "not_found", "找不到原件"));
    };
    let mime = resolved
        .get("mime")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream");
    let Some(size) = resolved.get("size").and_then(Value::as_u64) else {
        return Err(error(StatusCode::NOT_FOUND, "not_found", "原件大小未知"));
    };
    let range = match range_of(range_header, size) {
        Ok(range) => range,
        Err(()) => {
            let mut response = error(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "invalid_range",
                "下载范围不合法",
            );
            // 416 必须带 `Content-Range: bytes */总长`,客户端才知道该从哪里续
            if let Ok(value) = HeaderValue::from_str(&format!("bytes */{size}")) {
                response.headers_mut().insert(CONTENT_RANGE, value);
            }
            return Err(response);
        }
    };
    let mut file = match tokio::fs::File::open(path).await {
        Ok(file) => file,
        Err(err) => {
            // 不把服务端绝对路径带给客户端;只说明读不到
            let _ = err;
            return Err(error(
                StatusCode::NOT_FOUND,
                "not_found",
                "读取原件失败,文件可能已被移动",
            ));
        }
    };
    let (status, start, end) = match range {
        Some((start, end)) => (StatusCode::PARTIAL_CONTENT, start, end),
        None => (StatusCode::OK, 0, size.saturating_sub(1)),
    };
    if let Some((start, _)) = range
        && let Err(err) = file.seek(std::io::SeekFrom::Start(start)).await
    {
        // 不把服务端绝对路径带给客户端;只说明读不到
        let _ = err;
        return Err(error(
            StatusCode::NOT_FOUND,
            "not_found",
            "读取原件失败,文件可能已被移动",
        ));
    }
    let length = if size == 0 { 0 } else { end - start + 1 };
    let name = resolved
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("file");
    let body = Body::from_stream(ReaderStream::new(file.take(length)));
    let mut response = Response::new(body);
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_str(mime)
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(
        CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; {}", disposition_name(name)))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    // `u64` 有现成的 `HeaderValue: From<u64>`,不必走 `from_str` + unwrap
    headers.insert(CONTENT_LENGTH, HeaderValue::from(length));
    headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if status == StatusCode::PARTIAL_CONTENT {
        // 三个 `u64` 的十进制 + 固定 ASCII,拼出来必然是合法头值;真不合法只能是
        // rust-http 改了规则,那种时候宁可炸也不要把 Range 头静默写错
        headers.insert(
            CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{size}"))
                .expect("u64 十进制与固定 ASCII 在 HeaderValue 里必然合法"),
        );
    }
    // 原件可能被仓库内容控制:禁止浏览器猜类型,也不允许它被当页面执行
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static("sandbox; default-src 'none'"),
    );
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok((response, length))
}

/// 解析单段 `Range`。语法不认识 / 越界返回 `Err()`;多段直接忽略(退回整份)。
pub(crate) fn range_of(
    value: Option<&str>,
    size: u64,
) -> std::result::Result<Option<(u64, u64)>, ()> {
    let Some(raw) = value else {
        return Ok(None);
    };
    let Some(spec) = raw.strip_prefix("bytes=") else {
        return Ok(None);
    };
    if spec.contains(',') {
        return Ok(None);
    }
    let Some((left, right)) = spec.split_once('-') else {
        return Err(());
    };
    if size == 0 {
        return Err(());
    }
    if left.is_empty() {
        // `bytes=-N`:最后 N 字节
        let suffix: u64 = right.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        let start = size.saturating_sub(suffix);
        return Ok(Some((start, size - 1)));
    }
    let start: u64 = left.parse().map_err(|_| ())?;
    let end = if right.is_empty() {
        size - 1
    } else {
        right.parse::<u64>().map_err(|_| ())?.min(size - 1)
    };
    if start > end || start >= size {
        return Err(());
    }
    Ok(Some((start, end)))
}

/// RFC 5987 的 `attr-char` 编码:只放行 `ALPHA / DIGIT` 与 ``!#$&+-.^_`|~``,其余全部 `%XX`。
///
/// 不能直接用通用的百分号编码:`'`、`;`、`"` 在通用编码里是原样输出的,
/// 浏览器会把它们当成参数分隔符。
pub(crate) fn encode_rfc5987(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        let ch = *byte as char;
        let attr = ch.is_ascii_alphanumeric()
            || matches!(
                ch,
                '!' | '#' | '$' | '&' | '+' | '-' | '.' | '^' | '_' | '`' | '|' | '~'
            );
        if attr {
            out.push(ch);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 预览内联的最大字节数(再大的文件应该走下载)。
pub(crate) const MAX_RAW_BYTES: u64 = 64 * 1024 * 1024;

/// 最多读 `MAX_RAW_BYTES` 字节;超出就报错,不会把整个文件读进内存。
pub(crate) async fn read_capped(path: &str) -> std::io::Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let file = tokio::fs::File::open(path).await?;
    let mut buffer = Vec::new();
    let read = file
        .take(MAX_RAW_BYTES + 1)
        .read_to_end(&mut buffer)
        .await?;
    if read as u64 > MAX_RAW_BYTES {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "原件超过 64 MB",
        ));
    }
    Ok(buffer)
}

/// `Content-Disposition` 的文件名:ASCII 兜底 + `filename*` 的百分号编码。
///
/// 文件名来自磁盘(可被仓库内容控制),所以要把引号、反斜杠、控制字符都换掉,
/// 中文等非 ASCII 走 RFC 5987 的 `filename*=UTF-8''…`。
pub(crate) fn disposition_name(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_' | ' ') {
                ch
            } else {
                '_'
            }
        })
        .collect();
    format!(
        "filename=\"{ascii}\"; filename*=UTF-8''{}",
        encode_rfc5987(name)
    )
}

/// `file_raw` 的查询参数。
#[derive(Debug, Deserialize)]
pub struct RawQuery {
    /// collection 名。
    pub collection: String,
    /// collection 内的相对路径。
    pub path: String,
    /// 别人分享给我的内容所在的知识库(与 `X-KB-Space` 同义;`<img src>` 带不了自定义头,所以放在查询参数里)。
    #[serde(default)]
    pub space: Option<String>,
    /// 管理员只读查看的目标用户 id(与 `X-KB-Admin-View` 同义;`<img src>` 带不了自定义头,所以放在查询参数里)。
    #[serde(default)]
    pub admin_view: Option<String>,
}

/// 用户 id 的严格校验:`usr_` 开头、长度受限、只允许 ASCII 字母数字与下划线。
pub(crate) fn valid_user_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id.starts_with("usr_")
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}
