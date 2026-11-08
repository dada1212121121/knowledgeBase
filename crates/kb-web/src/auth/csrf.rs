//! CSRF 校验:非 GET 请求必须带 `X-KB-CSRF: 1`,且 `Origin` 为空或与 `Host` 一致。

use axum::http::{HeaderMap, header};
use kb_core::{KbError, Result};

/// 校验请求头;Bearer 请求由调用方跳过(§)。
pub fn check(headers: &HeaderMap) -> Result<()> {
    let csrf = headers
        .get("x-kb-csrf")
        .and_then(|value| value.to_str().ok())
        .map(str::trim);
    if csrf != Some("1") {
        return Err(KbError::Forbidden("缺少 X-KB-CSRF: 1 请求头".to_owned()));
    }
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Ok(());
    };
    let origin = origin
        .to_str()
        .map_err(|_| KbError::Forbidden("Origin 头不是合法 ASCII".to_owned()))?;
    if origin.is_empty() {
        return Ok(());
    }
    let origin_host = origin
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(origin);
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| KbError::Forbidden("缺少 Host 头,无法校验 Origin".to_owned()))?;
    if origin_host != host {
        return Err(KbError::Forbidden(format!(
            "Origin({origin_host})与 Host({host})不一致"
        )));
    }
    Ok(())
}

/// 只读方法不需要 CSRF。
pub fn needs_check(method: &axum::http::Method) -> bool {
    !matches!(
        *method,
        axum::http::Method::GET | axum::http::Method::HEAD | axum::http::Method::OPTIONS
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Method;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).expect("名"),
                value.parse().expect("值"),
            );
        }
        map
    }

    #[test]
    fn requires_the_csrf_header() {
        let map = headers(&[("host", "127.0.0.1:7878")]);
        assert!(check(&map).is_err(), "没有 X-KB-CSRF 必须失败");
        let map = headers(&[("host", "127.0.0.1:7878"), ("x-kb-csrf", "0")]);
        assert!(check(&map).is_err(), "X-KB-CSRF 只能是 1");
    }

    #[test]
    fn accepts_matching_or_absent_origin() {
        let map = headers(&[("host", "127.0.0.1:7878"), ("x-kb-csrf", "1")]);
        assert!(check(&map).is_ok(), "没有 Origin 应通过");
        let map = headers(&[
            ("host", "127.0.0.1:7878"),
            ("x-kb-csrf", "1"),
            ("origin", "http://127.0.0.1:7878"),
        ]);
        assert!(check(&map).is_ok(), "Origin 与 Host 一致应通过");
    }

    #[test]
    fn rejects_a_foreign_origin() {
        let map = headers(&[
            ("host", "127.0.0.1:7878"),
            ("x-kb-csrf", "1"),
            ("origin", "https://evil.example"),
        ]);
        let err = check(&map).expect_err("跨站 Origin 必须失败");
        assert!(matches!(err, KbError::Forbidden(_)), "{err:?}");
    }

    #[test]
    fn only_mutating_methods_need_the_check() {
        assert!(!needs_check(&Method::GET));
        assert!(!needs_check(&Method::HEAD));
        assert!(needs_check(&Method::POST));
        assert!(needs_check(&Method::DELETE));
    }
}
