//! Agent 会话:消息与摘要。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Millis;
use serde::{Deserialize, Serialize};

/// AI 管家的一条会话消息。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentMessage {
    /// 会话 id。
    pub session_id: String,
    /// 序号(会话内递增)。
    pub seq: i64,
    /// `system` / `user` / `assistant` / `tool` / `plan`。
    pub role: String,
    /// 内容(JSON:`{"text":…}` 或 `{"card":…}`)。
    pub content_json: String,
    /// 时间。
    pub at: Millis,
}

/// 一条 AI 管家会话的摘要(会话列表用)。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AgentSessionSummary {
    /// 会话 id。
    pub session_id: String,
    /// 第一条用户消息的前 60 个字符(没有就是“新会话”);用户改过就用改后的。
    pub title: String,
    /// 会话所属项目(从工具参数里推断;没有就是空串)。
    pub project: String,
    /// 后端:`builtin`(内置模型)或 `acp`(外部代理)。
    pub backend: String,
    /// 是否置顶。
    pub pinned: bool,
    /// 第一条消息的时间。
    pub created_at: Millis,
    /// 最后一条消息的时间。
    pub last_at: Millis,
    /// 消息条数。
    pub messages: i64,
}

/// 会话的元数据(ACP 映射 + 上下文摘要)。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentSessionMeta {
    /// `builtin` / `acp`。
    pub backend: String,
    /// 会话所属项目。
    pub project: String,
    /// ACP 代理 id。
    pub acp_agent: String,
    /// 代理侧的会话 id。
    pub acp_session: String,
    /// 较早对话的摘要(压缩后)。
    pub summary: String,
    /// 摘要覆盖到的消息序号。
    pub summary_upto: i64,
    /// 这次会话的代理是不是跑在沙箱里。没有记录时当作 true(还没拉起)。
    pub sandboxed: bool,
}
