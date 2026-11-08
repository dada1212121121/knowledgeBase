//! 请求来源标记(设计规范)。
//!
//! 同一个 Router 同时服务 TCP 与 UDS。中间件给每个请求打上来源标记:
//! UDS → `local`,TCP → `remote`。TCP 来源的放行规则见 [`crate::auth::guard`]。

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::Response;

/// 请求来源。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Unix socket(本机 CLI / MCP,Admin)。
    Local,
    /// `agent.sock`(ACP 伴生进程,Write + 工具组)。
    Agent,
    /// TCP(浏览器 / 局域网)。
    Remote,
}

/// 给请求打来源标记。
///
/// 放行 / 拦截由 [`crate::auth::guard`] 负责(从该版本起 TCP 走会话 / Bearer 鉴权)。
pub async fn mark(kind: SocketKind, mut request: Request, next: Next) -> Response {
    let source = match kind {
        SocketKind::Unix => Source::Local,
        SocketKind::Agent => Source::Agent,
        SocketKind::Tcp => Source::Remote,
    };
    request.extensions_mut().insert(source);
    next.run(request).await
}

/// 监听种类(由两处 `serve` 分别插入)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SocketKind {
    /// `kb.sock`:本机超级用户。
    Unix,
    /// `agent.sock`:ACP 伴生进程,必须带会话令牌。
    Agent,
    /// TCP。
    Tcp,
}
