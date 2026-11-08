//! 公开 Agent Skill:免登录的静态 Markdown。
//!
//! 内容只有一份,放在 `kb_core::SKILL_MD`;这里只负责 HTTP 头和响应,不做模板替换,
//! 避免把账号信息、站点地址或密钥带进公开缓存。

use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};

/// `GET /skill.md` 与 `GET /api/v1/skill`。两者返回同一份正文。
pub async fn get() -> Response {
    let mut response = (axum::http::StatusCode::OK, kb_core::SKILL_MD).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/markdown; charset=utf-8"),
    );
    // 公开内容、不含用户数据:允许浏览器和中间代理短时间缓存,减轻每次接入的读压力。
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=300"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_contains_no_credentials_or_template_placeholders() {
        for forbidden in ["kb_ak_", "Bearer kb_", "{{"] {
            assert!(
                !kb_core::SKILL_MD.contains(forbidden),
                "公开 Skill 不能包含 {forbidden:?}"
            );
        }
    }

    #[test]
    fn skill_names_the_core_tools_without_inventing_new_ones() {
        for tool in ["search_knowledge", "get_item", "doc_read", "save_insight"] {
            assert!(kb_core::SKILL_MD.contains(tool), "缺少工具 {tool}");
        }
    }

    #[tokio::test]
    async fn response_is_markdown_and_publicly_cacheable() {
        let response = get().await;
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/markdown; charset=utf-8"
        );
        assert_eq!(
            response.headers().get(header::CACHE_CONTROL).unwrap(),
            "public, max-age=300"
        );
        let body = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("读响应体");
        assert_eq!(body.as_ref(), kb_core::SKILL_MD.as_bytes());
    }
}
