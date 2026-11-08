//! 伴生与 ACP:AI 会话、权限决定、上下文估算,以及 ACP 子进程的生命周期。
//!
//! 见 [`super::CapabilityBackend`](CapabilityBackend)。

use super::*;

#[async_trait]
pub trait AgentBackend: Send + Sync {
    /// AI 管家:一轮对话。
    async fn agent_send(&self, args: crate::defs::AgentSendArgs) -> Result<Value>;

    /// 编辑器里的 AI 写作(UI-3):无状态,一次请求一次回答,返回 `{ "text": … }`。
    async fn ai_write(&self, args: crate::defs::AiWriteArgs) -> Result<Value>;

    /// AI 管家:确认并执行计划卡片。
    async fn agent_confirm(&self, args: crate::defs::AgentConfirmArgs) -> Result<Value>;

    /// AI 管家:会话记录。MCP 面要按项目 `allow_cloud_llm` 过滤正文。
    async fn agent_history(
        &self,
        ctx: &CallCtx,
        args: crate::defs::AgentHistoryArgs,
    ) -> Result<Value>;

    /// AI 管家:会话列表。
    async fn agent_sessions(&self, args: crate::defs::AgentSessionsArgs) -> Result<Value>;

    /// AI 管家:删除一个会话。
    async fn agent_delete_session(
        &self,
        args: crate::defs::AgentDeleteSessionArgs,
    ) -> Result<Value>;

    /// AI 管家:压缩上下文。
    async fn agent_compress(&self, args: crate::defs::AgentCompressArgs) -> Result<Value>;

    /// AI 管家:重命名会话。
    async fn agent_rename_session(
        &self,
        args: crate::defs::AgentRenameSessionArgs,
    ) -> Result<Value>;

    /// AI 管家:置顶 / 取消置顶会话。
    async fn agent_pin_session(&self, args: crate::defs::AgentPinSessionArgs) -> Result<Value>;

    /// ACP 接入:代理列表。
    async fn acp_agents(&self) -> Result<Value>;

    /// ACP 接入:新增 / 修改自定义代理。
    async fn acp_save_agent(&self, args: crate::defs::AcpSaveAgentArgs) -> Result<Value>;

    /// ACP 接入:删除自定义代理。
    async fn acp_remove_agent(&self, args: crate::defs::AcpAgentIdArgs) -> Result<Value>;

    /// ACP 接入:设置权限策略。
    async fn acp_set_permission(&self, args: crate::defs::AcpPermissionArgs) -> Result<Value>;

    /// ACP 接入:安装代理(npm)。
    async fn acp_install(&self, args: crate::defs::AcpAgentIdArgs) -> Result<Value>;

    /// ACP 接入:卸载代理(npm)。
    async fn acp_uninstall(&self, args: crate::defs::AcpAgentIdArgs) -> Result<Value>;

    /// ACP 接入:设置默认后端。
    async fn acp_set_default(&self, args: crate::defs::AcpDefaultArgs) -> Result<Value>;

    /// ACP 接入:开关沙箱。
    async fn acp_set_sandbox(&self, args: crate::defs::AcpSandboxArgs) -> Result<Value>;

    /// ACP 接入:答复权限请求。
    async fn acp_permission(&self, args: crate::defs::AcpPermissionDecisionArgs) -> Result<Value>;

    /// ACP 接入:测试连接。
    async fn acp_test(&self, args: crate::defs::AcpAgentIdArgs) -> Result<Value>;

    /// ACP 接入:通过代理对话。
    async fn acp_chat(&self, args: crate::defs::AcpChatArgs) -> Result<Value>;

    /// ACP 接入:取消当前轮次。
    async fn acp_cancel(&self, args: crate::defs::AcpCancelArgs) -> Result<Value>;

    /// 上下文增强:估算 token。
    async fn context_estimate(&self, args: crate::defs::ContextEstimateArgs) -> Result<Value>;

    /// 上下文增强:切换模式并投递重嵌入(dry_run 默认 true)。
    async fn apply_context(&self, args: crate::defs::ApplyContextArgs) -> Result<Value>;
}
