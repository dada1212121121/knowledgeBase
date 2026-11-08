//! 管理端静态资源。构建产物嵌在二进制里,axum 做 SPA 回退。
//!
//! 预压缩:`npm run build` 的 postbuild(`web-ui/scripts/precompress.mjs`)给文本类 / wasm / TTF·OTF
//! 生成同名 `.br`(brotli 11)与 `.gz`(gzip 9)。这里只内嵌原文件和 `.br`:
//! - 三份都嵌会让二进制再胖一倍多(dist 里 wasm 原文就有 47 MB);
//! - 接受 br 的客户端(HTTPS、localhost)直接拿 `.br`,不吃运行时 CPU,而且比运行时压缩小得多;
//! - 只接受 gzip 的客户端(明文 HTTP 的局域网地址,浏览器不在那里报 br)拿原文件,由外层
//!   [`crate::compress::layer`] 现场用最快档 gzip——所以 wasm / 字体的 MIME 必须准确,它才知道这些能压。

use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use rust_embed::RustEmbed;

/// `web-ui/dist`。路径相对 `crates/kb-web`。`.gz` 不内嵌(见模块说明)。
#[derive(RustEmbed)]
#[folder = "../../web-ui/dist"]
#[exclude = "*.gz"]
#[allow_missing = true]
struct UiAssets;

/// 未匹配的路由:API 与 `/mcp` 保持 JSON 404,其余走静态文件或 `index.html`。
pub async fn fallback(uri: axum::http::Uri, headers: HeaderMap) -> Response {
    let path = uri.path();
    if path.starts_with("/api/") || path == "/mcp" || path.starts_with("/mcp/") {
        return (
            StatusCode::NOT_FOUND,
            [(header::CONTENT_TYPE, "application/json")],
            Body::from(r#"{"ok":false,"error":{"code":"not_found","message":"没有这个接口"}}"#),
        )
            .into_response();
    }
    let accepts_br = accepts_brotli(&headers);
    let rel = path.trim_start_matches('/');
    if !rel.is_empty()
        && let Some(response) = file_response(rel, accepts_br)
    {
        return response;
    }
    file_response("index.html", accepts_br).unwrap_or_else(|| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
            Body::from(
                "<!doctype html><meta charset=utf-8><title>knowledgeBase</title>\
                 <p>管理端还没构建。在仓库里执行 <code>cd web-ui && npm ci && npm run build</code> 后再编译。</p>",
            ),
        )
            .into_response()
    })
}

fn file_response(path: &str, accepts_br: bool) -> Option<Response> {
    let file = UiAssets::get(path)?;
    let compressible = is_compressible(path);
    // 有预压缩版且客户端接受 br 才用;否则发原文件(外层压缩层按 MIME 决定要不要现场 gzip)
    let brotli = if compressible && accepts_br {
        UiAssets::get(&format!("{path}.br"))
    } else {
        None
    };
    let mut response = match brotli {
        Some(encoded) => {
            let mut response = Body::from(encoded.data.into_owned()).into_response();
            response
                .headers_mut()
                .insert(header::CONTENT_ENCODING, HeaderValue::from_static("br"));
            response
        }
        None => Body::from(file.data.into_owned()).into_response(),
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(mime_of(path)),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static(cache_control_of(path)),
    );
    if compressible {
        // 同一地址对不同客户端有两种表示,中间的缓存要分开存
        headers.insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    Some(response)
}

/// 只有 `assets/` 下的文件名带内容哈希,可以永久缓存;index.html、pdfjs/、guide/ 这些文件名不变,每次都要确认
/// (与 `scripts/serve.mjs` 一致,以前这里除了 index.html 全是 immutable,换版后 pdfjs 会一直用旧的)。
fn cache_control_of(path: &str) -> &'static str {
    if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    }
}

/// 与 `scripts/serve.mjs` 的 `COMPRESSIBLE_EXT` 一致:这些扩展名才会有 `.br`。
fn is_compressible(path: &str) -> bool {
    matches!(
        path.rsplit('.').next(),
        Some(
            "html"
                | "js"
                | "mjs"
                | "css"
                | "json"
                | "svg"
                | "wasm"
                | "ttf"
                | "otf"
                | "map"
                | "txt"
                | "ico"
        )
    )
}

/// `Accept-Encoding` 里 br 的 q 值大于 0(显式写了 br,或者用 `*` 兜底)。
fn accepts_brotli(headers: &HeaderMap) -> bool {
    let Some(value) = headers
        .get(header::ACCEPT_ENCODING)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let mut star = None;
    for part in value.split(',') {
        let mut pieces = part.trim().split(';');
        let name = pieces
            .next()
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        let q = pieces
            .filter_map(|param| param.trim().strip_prefix("q="))
            .find_map(|q| q.trim().parse::<f32>().ok())
            .unwrap_or(1.0);
        match name.as_str() {
            "br" => return q > 0.0,
            "*" => star = Some(q > 0.0),
            _ => {}
        }
    }
    star.unwrap_or(false)
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        // 没有正确的 MIME,浏览器不让 `WebAssembly.instantiateStreaming` 流式编译,只能整包下载完再编译
        Some("wasm") => "application/wasm",
        Some("json" | "map") => "application/json",
        Some("webmanifest") => "application/manifest+json",
        Some("pdf") => "application/pdf",
        Some("txt") => "text/plain; charset=utf-8",
        Some("ico") => "image/x-icon",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accept(value: &'static str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static(value));
        headers
    }

    #[test]
    fn brotli_negotiation_follows_q_values() {
        assert!(accepts_brotli(&accept("gzip, deflate, br")));
        assert!(accepts_brotli(&accept("br;q=0.5, gzip")));
        assert!(accepts_brotli(&accept("*")));
        assert!(
            !accepts_brotli(&accept("gzip, deflate")),
            "明文 HTTP 下浏览器只报 gzip"
        );
        assert!(!accepts_brotli(&accept("br;q=0, gzip")), "q=0 表示不接受");
        assert!(!accepts_brotli(&accept("*;q=0")));
        assert!(
            !accepts_brotli(&accept("br;q=0, *")),
            "显式拒绝优先于 * 兜底"
        );
        assert!(!accepts_brotli(&HeaderMap::new()));
    }

    #[test]
    fn engine_and_font_assets_have_real_mime_types() {
        assert_eq!(mime_of("assets/xlsx_wasm_bg-1.wasm"), "application/wasm");
        assert_eq!(
            mime_of("assets/docxWorker-1.mjs"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(mime_of("assets/Carlito-Regular-1.ttf"), "font/ttf");
        assert_eq!(mime_of("assets/NotoSansSC-Regular-1.otf"), "font/otf");
        assert_eq!(
            mime_of("guide/knowledgeBase-user-guide.pdf"),
            "application/pdf"
        );
        assert_eq!(mime_of("manifest.webmanifest"), "application/manifest+json");
        assert_eq!(mime_of("assets/unknown.bin"), "application/octet-stream");
    }

    #[test]
    fn only_hashed_assets_are_immutable() {
        assert_eq!(
            cache_control_of("assets/index-abc.js"),
            "public, max-age=31536000, immutable"
        );
        assert_eq!(cache_control_of("index.html"), "no-cache");
        assert_eq!(
            cache_control_of("pdfjs/cmaps/UniGB-UCS2-H.bcmap"),
            "no-cache"
        );
        assert_eq!(
            cache_control_of("guide/knowledgeBase-user-guide.pdf"),
            "no-cache"
        );
    }

    #[test]
    fn compressible_set_matches_precompress() {
        for path in [
            "a.js", "a.mjs", "a.css", "a.html", "a.wasm", "a.ttf", "a.otf", "a.svg", "a.json",
        ] {
            assert!(is_compressible(path), "{path}");
        }
        for path in ["a.woff2", "a.png", "a.pdf", "a.bcmap", "a.js.br"] {
            assert!(!is_compressible(path), "{path}");
        }
    }

    /// 构建产物在(`npm run build` 之后)时,内嵌资源真的走预压缩:接受 br 拿 `.br`,不接受拿原文件。
    /// 没构建时(CI 只跑 Rust)跳过,不制造假失败。
    #[tokio::test]
    async fn embedded_wasm_is_served_precompressed_when_built() {
        let Some(wasm) = UiAssets::iter().find(|name| name.ends_with(".wasm")) else {
            return;
        };
        let wasm = wasm.into_owned();
        if UiAssets::get(&format!("{wasm}.br")).is_none() {
            return;
        }
        let uri: axum::http::Uri = format!("/{wasm}").parse().unwrap();
        let br = fallback(uri.clone(), accept("gzip, br")).await;
        assert_eq!(br.headers()[header::CONTENT_ENCODING], "br");
        assert_eq!(br.headers()[header::CONTENT_TYPE], "application/wasm");
        assert_eq!(br.headers()[header::VARY], "accept-encoding");
        let br_len = axum::body::to_bytes(br.into_body(), usize::MAX)
            .await
            .unwrap()
            .len();
        let plain = fallback(uri, accept("gzip")).await;
        assert!(plain.headers().get(header::CONTENT_ENCODING).is_none());
        let plain_len = axum::body::to_bytes(plain.into_body(), usize::MAX)
            .await
            .unwrap()
            .len();
        assert!(
            br_len * 2 < plain_len,
            "预压缩版应明显更小:{br_len} vs {plain_len}"
        );
        // .gz 不内嵌(省二进制体积)
        assert!(UiAssets::get(&format!("{wasm}.gz")).is_none());
    }
}
