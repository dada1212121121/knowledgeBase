//! 对话编解码:LLM 请求与响应的传输形态。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use serde::{Deserialize, Serialize};

/// Embedder 的加载状态。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EmbedderState {
    /// 未加载。
    Unloaded,
    /// 正在加载。
    Loading,
    /// 就绪。
    Ready,
    /// 加载失败。
    Failed(String),
}

/// 一条对话消息(AI)。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ChatMessage {
    /// `system` / `user` / `assistant` / `tool`。
    pub role: String,
    /// 文本内容。
    pub content: Option<String>,
    /// 工具调用。
    pub tool_calls: Vec<ToolCall>,
    /// 工具调用 id(tool 消息)。
    pub tool_call_id: Option<String>,
}

/// 一次工具调用(AI)。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ToolCall {
    /// 调用 id。
    pub id: String,
    /// 工具名。
    pub name: String,
    /// 参数 JSON。
    pub arguments: serde_json::Value,
}

/// 工具定义(AI)。
#[derive(Clone, Debug, Serialize)]
pub struct ToolSpec {
    /// 工具名。
    pub name: String,
    /// 描述。
    pub description: String,
    /// 参数 JSON Schema。
    pub parameters: serde_json::Value,
}

/// 一次对话请求(AI)。
#[derive(Clone, Debug)]
pub struct ChatRequest {
    /// 模型名。
    pub model: String,
    /// 消息列表。
    pub messages: Vec<ChatMessage>,
    /// 可用工具。
    pub tools: Vec<ToolSpec>,
    /// 是否要求 JSON 输出。
    pub json_output: bool,
    /// 是否开启 thinking。
    pub thinking: bool,
    /// 最大输出 token。
    pub max_tokens: Option<u32>,
    /// 采样温度。
    pub temperature: Option<f32>,
}

/// 一次对话响应(AI)。
#[derive(Clone, Debug)]
pub struct ChatResponse {
    /// 助手消息。
    pub message: ChatMessage,
    /// 输入 token 数。
    pub input_tokens: u64,
    /// 输出 token 数。
    pub output_tokens: u64,
    /// 结束原因。
    pub finish_reason: String,
}
