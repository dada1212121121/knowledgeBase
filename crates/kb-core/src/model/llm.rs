//! LLM 用量与会话记录。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Millis;
use serde::{Deserialize, Serialize};

/// `llm_usage` 表:按天聚合的用量。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LlmUsage {
    /// 日期(`YYYY-MM-DD`)。
    pub day: String,
    /// 模型名。
    pub model: String,
    /// 用途(`extract` / `review` / `agent` …)。
    pub purpose: String,
    /// 调用次数。
    pub calls: u32,
    /// 输入 token 数。
    pub input_tokens: u64,
    /// 输出 token 数。
    pub output_tokens: u64,
}

/// `llm_sends` 表:每次外发一条审计。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LlmSend {
    /// 自增主键;写入时用 `None`。
    pub id: Option<i64>,
    /// 时间。
    pub at: Millis,
    /// 所属项目。
    pub project_id: Option<String>,
    /// 用途。
    pub purpose: String,
    /// 发送的字符数。
    pub chars: u64,
    /// 脱敏替换的次数。
    pub redactions: u64,
}
