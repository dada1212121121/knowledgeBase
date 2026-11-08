//! ChatModel 的 OpenAI 兼容客户端(reqwest)与提示词模板。
//!
//! - [`client::OpenAiClient`]:`/chat/completions`,支持 tools、JSON 输出、SSE 流式与
//!   DeepSeek 的 thinking 参数;429 / 5xx 指数退避重试(最多 3 次)。
//! - [`sse`]:SSE 事件与增量解析。
//! - [`mock::MockChatModel`]:没有 API key 时跑通链路与测试。
//!
//! 所有真实调用都要经过服务层的 `LlmGate`(外发闸门),这一层只负责协议。

pub mod client;
pub mod mock;
pub mod sse;

pub use client::{LlmClientConfig, OpenAiClient, SharedChatModel, parse_response};
pub use mock::{MockChatModel, RecordedRequest};
pub use sse::{SseEvent, StreamDelta, delta_of, parse_events};
