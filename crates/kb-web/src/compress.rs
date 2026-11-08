//! HTTP 响应压缩(gzip,卡 A)。
//!
//! 守护进程原来不压缩任何响应:内网和 frp 直连的访问拿到的都是原始字节(任务列表一次 4 MB,gzip 后不到 0.5 MB),
//! 只有走 Cloudflare 的公网访问才被压缩。这里只压文本类响应,下面几类明确不压:
//! - `text/event-stream`(MCP 的 SSE):压缩器会攒数据再吐,流式事件会被卡住;
//! - WebSocket 升级(101,没有正文);
//! - 带 `Content-Range` 的分段响应(视频拖动进度条):压缩后字节偏移就对不上了;
//! - 图片、音视频、压缩包、导出包:本身已经压缩过,再压只费 CPU;
//! - 已经带 `Content-Encoding` 的响应;
//! - 小于 1 KB 的响应(压缩头的开销比省下的还多)。

use axum::http::{HeaderMap, StatusCode, Version, header};
use tower_http::compression::predicate::{Predicate, SizeAbove};
use tower_http::compression::{CompressionLayer, CompressionLevel};

/// 要压缩的内容类型(只看分号前的主类型,大小写不敏感)。
/// wasm 与 TTF / OTF 字体本身不压缩:内嵌的管理端资源有构建期 `.br`(见 `ui.rs`),
/// 只有不接受 br 的客户端(明文 HTTP 的局域网地址)才走到这里现场 gzip,不压的话要多下一倍多。
const COMPRESSIBLE: [&str; 11] = [
    "application/json",
    "application/javascript",
    "text/javascript",
    "text/html",
    "text/css",
    "text/plain",
    "text/markdown",
    "application/manifest+json",
    "application/wasm",
    "font/ttf",
    "font/otf",
];

/// 小于这个字节数的响应不压。
const MIN_BYTES: u16 = 1024;

/// 这个响应的头允许压缩吗(不看大小,大小由 [`SizeAbove`] 判断)。
pub fn compressible(headers: &HeaderMap) -> bool {
    if headers.contains_key(header::CONTENT_RANGE) || headers.contains_key(header::CONTENT_ENCODING)
    {
        return false;
    }
    let Some(kind) = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let main = kind
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    COMPRESSIBLE.contains(&main.as_str())
}

fn by_headers(
    _status: StatusCode,
    _version: Version,
    headers: &HeaderMap,
    _extensions: &axum::http::Extensions,
) -> bool {
    compressible(headers)
}

/// 压缩层:只开 gzip(浏览器都支持;br 在 CPU 上贵得多,这里不值得)。
/// 压缩级别用「快」:这些响应每次都是现算的,不能为省几个字节多花 CPU(守护进程和别的业务同机)。
pub fn layer() -> CompressionLayer<impl Predicate> {
    CompressionLayer::new()
        .no_br()
        .no_deflate()
        .no_zstd()
        .quality(CompressionLevel::Fastest)
        .compress_when(SizeAbove::new(MIN_BYTES).and(by_headers))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::http::{HeaderValue, Request};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use tower::ServiceExt;

    fn headers(pairs: &[(header::HeaderName, &'static str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(name.clone(), HeaderValue::from_static(value));
        }
        map
    }

    #[test]
    fn only_text_like_responses_without_ranges_are_compressible() {
        for kind in [
            "application/json",
            "Application/JSON; charset=utf-8",
            "text/html; charset=utf-8",
            "text/javascript",
            "text/plain",
            "text/markdown; charset=utf-8",
            "application/wasm",
            "font/ttf",
            "font/otf",
        ] {
            assert!(
                compressible(&headers(&[(header::CONTENT_TYPE, kind)])),
                "{kind}"
            );
        }
        for kind in [
            "text/event-stream",
            "image/png",
            "image/svg+xml",
            "video/mp4",
            "application/zip",
            "application/gzip",
            "application/octet-stream",
            "application/pdf",
            "font/woff2",
        ] {
            assert!(
                !compressible(&headers(&[(header::CONTENT_TYPE, kind)])),
                "{kind}"
            );
        }
        assert!(!compressible(&HeaderMap::new()), "没有内容类型的不压");
        assert!(
            !compressible(&headers(&[
                (header::CONTENT_TYPE, "text/plain"),
                (header::CONTENT_RANGE, "bytes 0-99/1000"),
            ])),
            "分段响应不压"
        );
        assert!(
            !compressible(&headers(&[
                (header::CONTENT_TYPE, "application/json"),
                (header::CONTENT_ENCODING, "gzip"),
            ])),
            "已经压过的不再压"
        );
    }

    async fn fetch(path: &str, accept: Option<&str>) -> (Option<String>, Vec<u8>) {
        let big = "x".repeat(8 * 1024);
        let small = "y".repeat(100);
        let app = Router::new()
            .route(
                "/json",
                get(move || {
                    let body = format!("{{\"data\":\"{big}\"}}");
                    async move { ([(header::CONTENT_TYPE, "application/json")], body) }
                }),
            )
            .route(
                "/small",
                get(move || {
                    let body = small.clone();
                    async move { ([(header::CONTENT_TYPE, "application/json")], body) }
                }),
            )
            .route(
                "/sse",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        "data: x\n\n".repeat(500),
                    )
                }),
            )
            .route(
                "/png",
                get(|| async { ([(header::CONTENT_TYPE, "image/png")], vec![7u8; 8 * 1024]) }),
            )
            .route(
                "/range",
                get(|| async {
                    (
                        StatusCode::PARTIAL_CONTENT,
                        [
                            (header::CONTENT_TYPE, "text/plain"),
                            (header::CONTENT_RANGE, "bytes 0-8191/20000"),
                        ],
                        "z".repeat(8 * 1024),
                    )
                        .into_response()
                }),
            )
            .layer(layer());
        let mut request = Request::builder().uri(path);
        if let Some(accept) = accept {
            request = request.header(header::ACCEPT_ENCODING, accept);
        }
        let response = app
            .oneshot(request.body(Body::empty()).expect("请求"))
            .await
            .expect("响应");
        let encoding = response
            .headers()
            .get(header::CONTENT_ENCODING)
            .map(|value| value.to_str().expect("头").to_owned());
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("正文");
        (encoding, bytes.to_vec())
    }

    #[tokio::test]
    async fn json_is_gzipped_only_when_the_client_asks() {
        let (encoding, body) = fetch("/json", Some("gzip, deflate, br")).await;
        assert_eq!(
            encoding.as_deref(),
            Some("gzip"),
            "浏览器支持 br 也只给 gzip"
        );
        assert!(body.len() < 1024, "8 KB 的重复文本压完很小:{}", body.len());
        assert_eq!(&body[..2], &[0x1f, 0x8b], "gzip 魔数");
        let (encoding, body) = fetch("/json", None).await;
        assert_eq!(encoding, None, "客户端没说支持就不压");
        assert!(body.len() > 8 * 1024);
    }

    #[tokio::test]
    async fn streams_media_ranges_and_tiny_bodies_pass_through() {
        for path in ["/sse", "/png", "/range", "/small"] {
            let (encoding, _) = fetch(path, Some("gzip")).await;
            assert_eq!(encoding, None, "{path} 不该被压缩");
        }
    }
}
