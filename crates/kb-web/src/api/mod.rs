//! REST 处理函数(设计规范的请求 / 响应契约)。

//! 拆成两半(2026-11-08,超长文件棘轮):
//! - `files`:原始字节 / 下载两条大路,以及 Range、文件名编码这些支撑件;
//! - `call`:能力目录与 `call` 转发、权限口径、响应包装。

use std::sync::Arc;

use axum::extract::State;
#[cfg(test)]
use axum::http::StatusCode;
#[cfg(test)]
use axum::http::header::{ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_RANGE};
use axum::response::Response;
use kb_capability::invoke::Invoker;
use serde::Deserialize;
use serde_json::json;

mod call;
mod files;

pub(crate) use call::*;

// 原来这两个在 `pub mod api` 里是 `pub fn`,外面(`kb-web` 的其它模块)随时可能用;
// 拆完还留成公开面,避免下次有人从别的模块调时才发现它悄悄没了。
pub use call::{is_local, max_permission_for};
pub(crate) use files::*;

/// 系统层面的 AI 开关状态的读取函数(每个请求读一次,配置热重载后立即生效)。
pub type AiSwitch = Arc<dyn Fn() -> kb_core::features::AiState + Send + Sync>;

/// 应用状态。
pub struct AppState {
    /// 能力调用器。
    pub invoker: Arc<Invoker>,
    /// 进程启动时间。
    pub started: std::time::Instant,
    /// 版本号。
    pub version: &'static str,
    /// `/mcp` 端点;`None` = 没有启用(路由不存在,返回 404)。
    pub mcp: Option<std::sync::Arc<crate::mcp::McpEndpoint>>,
    /// 事件接收;`None` = 没有启用(路由返回 404)。
    pub events: Option<std::sync::Arc<dyn crate::events::EventSink>>,
    /// 主知识库的元数据存储(旧的单库调用方用;鉴权已经搬到 `system`)。
    pub meta: std::sync::Arc<dyn kb_core::ports::repo::MetaStore>,
    /// 账号库:用户、角色、会话、令牌。
    ///
    /// 这里只认端口(六个子域 + 聚合),实现是 `kb_meta::SystemStore` 还是别的什么,
    /// 接入层不知道也不该知道 —— 组合根负责注入。
    pub system: std::sync::Arc<dyn kb_core::ports::system::IdentityStore>,
    /// 用户 → 身份(知识库 + 功能集合)的短时缓存。
    pub principals: crate::auth::PrincipalCache,
    /// 注册 / 找回密码要用的依赖:配置、发信器、授权码读取。
    pub account: crate::signup::AccountDeps,
    /// AI 开关的当前状态(总开关 + 被单独关掉的 AI 功能点)。
    pub ai_enabled: AiSwitch,
    /// 登录失败限速(进程内)。
    pub login_limiter: crate::auth::ratelimit::LoginLimiter,
    /// 服务端事件推送(`/api/v1/ws`)。
    pub hub: std::sync::Arc<crate::hub::EventHub>,
    /// 上传接口;`None` = 没有启用(路由返回 404)。
    pub uploads: Option<std::sync::Arc<dyn crate::upload::UploadApi>>,
    /// ACP 伴生进程的会话令牌(只在内存里)。
    pub agent_grants: std::sync::Arc<crate::agent_grant::AgentGrants>,
    /// 多人在线编辑;`None` = 没有启用(协作接口返回 404)。
    pub collab: Option<std::sync::Arc<crate::collab_ws::CollabEndpoint>>,
    /// 办公文档多人协同(没有 = 没启用,打开时退回单人编辑)。
    pub office: Option<std::sync::Arc<dyn crate::office_ws::OfficeCollabApi>>,
}

/// `GET /api/v1/capabilities` 的查询参数。
#[derive(Debug, Deserialize)]
pub struct CapabilitiesQuery {
    /// 只列这个可见面的能力(`mcp` / `web` / `agent`)。
    #[serde(default)]
    pub surface: Option<String>,
}

/// `GET /api/v1/health`。
pub async fn health(State(state): State<Arc<AppState>>) -> Response {
    ok(json!({
        "status": "ok",
        "version": state.version,
    }))
}

/// `GET /api/v1/raw?collection=…&path=…`:预览页读原件(图片 / 音频 / 视频)。
///
/// 只允许 collection 内的相对路径(能力 `file_raw` 会再校验一次);
/// 单文件上限 64 MB —— 预览页只读图片与音视频,再大的文件应该走下载而不是内联。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disposition_name_escapes_quotes_and_semicolons() {
        let value = disposition_name("a\"b;c.md");
        assert!(value.contains("filename=\"a_b_c.md\""), "{value}");
        assert!(value.contains("filename*=UTF-8''a%22b%3Bc.md"), "{value}");
    }

    #[test]
    fn disposition_name_percent_encodes_non_ascii() {
        let value = disposition_name("报告.pdf");
        // ASCII 兜底名把非 ASCII 换成 `_`,filename* 里是 UTF-8 的百分号编码
        assert!(value.contains("filename=\"__.pdf\""), "{value}");
        assert!(
            value.contains("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"),
            "{value}"
        );
    }

    #[test]
    fn encode_rfc5987_keeps_only_attr_chars() {
        assert_eq!(encode_rfc5987("a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(encode_rfc5987("a b"), "a%20b");
        assert_eq!(encode_rfc5987("a'b"), "a%27b");
    }

    #[test]
    fn range_of_handles_single_ranges_and_rejects_out_of_bounds() {
        assert_eq!(range_of(None, 10), Ok(None));
        assert_eq!(range_of(Some("bytes=2-4"), 10), Ok(Some((2, 4))));
        assert_eq!(range_of(Some("bytes=8-"), 10), Ok(Some((8, 9))));
        assert_eq!(range_of(Some("bytes=-3"), 10), Ok(Some((7, 9))));
        // 多段不支持:忽略 Range,退整份(不能凭一段 Range 的头只发一段)
        assert_eq!(range_of(Some("bytes=0-1,4-5"), 10), Ok(None));
        // 越界 / 倒序 / 空文件:416
        assert_eq!(range_of(Some("bytes=10-12"), 10), Err(()));
        assert_eq!(range_of(Some("bytes=5-2"), 10), Err(()));
        assert_eq!(range_of(Some("bytes=-0"), 10), Err(()));
        assert_eq!(range_of(Some("bytes=0-"), 0), Err(()));
    }

    #[tokio::test]
    async fn download_response_streams_whole_and_range_with_416_headers() {
        let mut file = tempfile::NamedTempFile::new().expect("临时文件");
        std::io::Write::write_all(&mut file, b"0123456789").expect("写入");
        let resolved = json!({
            "path": file.path(),
            "name": "报告.txt",
            "size": 10,
            "mime": "text/plain"
        });

        let (response, sent) = download_response(&resolved, None).await.expect("整份");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(sent, 10);
        assert_eq!(response.headers()[ACCEPT_RANGES], "bytes");
        // 下载一律按附件,不允许在浏览器里当页面打开
        let disposition = response.headers()[CONTENT_DISPOSITION].to_str().unwrap();
        assert!(disposition.starts_with("attachment;"), "{disposition}");
        let body = axum::body::to_bytes(response.into_body(), 64)
            .await
            .expect("body");
        assert_eq!(&body[..], b"0123456789");

        let (response, sent) = download_response(&resolved, Some("bytes=2-4"))
            .await
            .expect("区间");
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(sent, 3);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes 2-4/10");
        let body = axum::body::to_bytes(response.into_body(), 64)
            .await
            .expect("body");
        assert_eq!(&body[..], b"234");

        let response = download_response(&resolved, Some("bytes=99-"))
            .await
            .expect_err("越界");
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes */10");
    }
}
