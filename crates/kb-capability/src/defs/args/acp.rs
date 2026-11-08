//! 伴生与 ACP:会话、权限决定、上下文估算、写入确认。

use super::*;

/// 一条聊天里的 `@` 快捷命令。
///
/// 只有这里列出来的才允许在聊天框里用(白名单),而且每条都绑到一个**非 Admin** 能力;
/// `chat_commands` 会把清单原样给前端,前端只负责渲染和调用,不自己拼能力名。
#[derive(Clone, Debug, Serialize)]
pub struct ChatCommandDef {
    /// 命令 id(`@search` 里的 `search`)。
    pub id: &'static str,
    /// 展示名。
    pub label: &'static str,
    /// 一句话说明。
    pub description: &'static str,
    /// `capability`(调能力)/ `upload`(选文件)/ `navigate`(跳页面)/ `form`(弹表单)。
    pub kind: &'static str,
    /// 绑定的能力名(`kind = capability` 时)。
    pub capability: Option<&'static str>,
    /// 参数名(按顺序,空格分隔)。
    pub args: &'static [&'static str],
    /// 跳转路径(`kind = navigate` 时)。
    pub path: Option<&'static str>,
    /// 交给代理的提示词(`{args}` / `{project}` 会被替换)。
    pub prompt: &'static str,
}

/// 聊天 `@` 快捷命令白名单。
pub const CHAT_COMMANDS: &[ChatCommandDef] = &[
    ChatCommandDef {
        id: "search",
        label: "搜索知识库",
        description: "按关键词检索,结果可直接点开",
        kind: "capability",
        capability: Some("search_knowledge"),
        args: &["query"],
        path: None,
        prompt: "用 knowledgeBase 的 search_knowledge 工具检索「{args}」{project}。用 3-5 条列出最相关结果,每条带来源路径/项目和一句话摘要;找不到就说没有,不要编造。",
    },
    ChatCommandDef {
        id: "projects",
        label: "列出项目",
        description: "看看知识库里有哪些项目",
        kind: "capability",
        capability: Some("list_projects"),
        args: &[],
        path: None,
        prompt: "用 knowledgeBase 的 list_projects 工具列出知识库里的项目,用表格给出名称、slug、根目录。",
    },
    ChatCommandDef {
        id: "collections",
        label: "列出集合",
        description: "集合与行数",
        kind: "capability",
        capability: Some("list_collections"),
        args: &[],
        path: None,
        prompt: "用 knowledgeBase 的 list_collections 工具列出集合和行数,用表格。",
    },
    ChatCommandDef {
        id: "jobs",
        label: "任务队列",
        description: "最近的后台任务",
        kind: "capability",
        capability: Some("job_list"),
        args: &[],
        path: None,
        prompt: "用 knowledgeBase 的 job_list 工具列出最近 10 个任务,给出类型、状态、进度。",
    },
    ChatCommandDef {
        id: "ingest",
        label: "解析队列",
        description: "最近导入 / 解析的文件",
        kind: "capability",
        capability: Some("list_ingest"),
        args: &[],
        path: None,
        prompt: "用 knowledgeBase 的 list_ingest 工具列出最近 10 个导入,给出文件、集合、状态。",
    },
    ChatCommandDef {
        id: "insight",
        label: "新建经验",
        description: "写一条经验到当前项目(或全局)",
        kind: "form",
        capability: Some("save_insight"),
        args: &[],
        path: None,
        prompt: "",
    },
    ChatCommandDef {
        id: "upload",
        label: "上传文件",
        description: "选文件加入解析队列",
        kind: "upload",
        capability: None,
        args: &[],
        path: None,
        prompt: "",
    },
    ChatCommandDef {
        id: "settings",
        label: "打开设置",
        description: "跳到设置页",
        kind: "navigate",
        capability: None,
        args: &[],
        path: Some("/settings"),
        prompt: "",
    },
];

/// `acp_cancel` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AcpCancelArgs {
    /// 管家会话 id。
    pub session_id: String,
}

/// `context_estimate` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ContextEstimateArgs {
    /// collection 名。
    pub collection: String,
}

/// `apply_context` 的参数。`dry_run` 默认 true,确认后才真正切换并投递重嵌入。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ApplyContextArgs {
    /// collection 名。
    pub collection: String,
    /// `header` 或 `llm`。
    pub context_mode: String,
    /// 只估算、不改模式。默认 true。
    #[serde(default = "super::default_dry_run")]
    pub dry_run: bool,
}

/// `acp_chat` 的参数(通过外部 ACP 代理对话)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AcpChatArgs {
    /// 代理 id(`acp_agents` 里的 id)。
    pub agent: String,
    /// 会话 id(留空则新建)。
    #[serde(default)]
    pub session_id: Option<String>,
    /// 用户说的话(发给代理的原文 / 提示词)。
    pub text: String,
    /// 存进历史的展示文本(不给就存 `text`)。
    #[serde(default)]
    pub display_text: Option<String>,
    /// 代理的工作目录(留空 = 项目根目录 / KB_HOME)。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 会话所属项目(留空则沿用会话已有的)。
    #[serde(default)]
    pub project: Option<String>,
}

/// `acp_save_agent` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AcpSaveAgentArgs {
    /// 代理 id。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// 启动命令。
    pub command: String,
    /// 命令行参数。
    #[serde(default)]
    pub args: Vec<String>,
    /// 环境变量。
    #[serde(default)]
    pub env: std::collections::BTreeMap<String, String>,
}

/// `acp_agent_id` 的参数(测试 / 删除)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AcpAgentIdArgs {
    /// 代理 id。
    pub id: String,
}

/// `acp_set_sandbox` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AcpSandboxArgs {
    /// 是否用 bwrap 把代理关进沙箱。
    pub sandbox: bool,
}

/// `acp_permission` 的参数(界面答复代理的权限请求)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AcpPermissionDecisionArgs {
    /// 管家会话 id(留空 = 在所有会话里找最早挂起的那个)。
    #[serde(default)]
    pub session_id: Option<String>,
    /// 请求 id(留空 = 该会话最早挂起的那个)。
    #[serde(default)]
    pub request_id: Option<String>,
    /// 是否允许。
    pub allow: bool,
}

/// `acp_set_default` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AcpDefaultArgs {
    /// 默认后端:代理 id;空串 = 内置模型。
    #[serde(default)]
    pub id: String,
}

/// `acp_set_permission` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AcpPermissionArgs {
    /// `none` / `read` / `all`。
    pub permission: String,
}

/// `agent_send` 的参数(AI 管家)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AgentSendArgs {
    /// 会话 id(留空则新建)。
    #[serde(default)]
    pub session_id: Option<String>,
    /// 用户说的话。
    pub text: String,
    /// 当前所在项目(可选;不给就从工具参数里推断)。
    #[serde(default)]
    pub project: Option<String>,
}

/// `ai_write` 的参数(UI-3 编辑器里的 AI 写作)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AiWriteArgs {
    /// `polish`(润色)/ `summarize`(总结)/ `translate`(翻译)/ `continue`(续写)/ `custom`(按要求)。
    pub action: String,
    /// 选中的文字(续写、按要求写一段时可以为空)。
    #[serde(default)]
    pub text: String,
    /// 光标前的正文(续写 / 按要求时参考;服务端只取最后 4000 字)。
    #[serde(default)]
    pub context: Option<String>,
    /// `custom` 的要求。
    #[serde(default)]
    pub instruction: Option<String>,
    /// 翻译的目标语言(不给 = 中文译英文、其它译中文)。
    #[serde(default)]
    pub target_lang: Option<String>,
}

/// `agent_confirm` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AgentConfirmArgs {
    /// 会话 id。
    pub session_id: String,
    /// 计划卡片 id。
    pub card_id: String,
    /// 卡片上的参数哈希(防篡改)。
    pub args_hash: String,
}

/// `agent_history` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AgentHistoryArgs {
    /// 会话 id。
    pub session_id: String,
}

/// `agent_sessions` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AgentSessionsArgs {
    /// 最多返回多少个会话(默认 50)。
    #[serde(default)]
    pub limit: Option<u32>,
    /// 只看这个项目的会话(空 = 全部)。
    #[serde(default)]
    pub project: Option<String>,
}

/// `agent_rename_session` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AgentRenameSessionArgs {
    /// 会话 id。
    pub session_id: String,
    /// 新标题(空串 = 恢复成“首条用户消息”)。
    pub title: String,
}

/// `agent_pin_session` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AgentPinSessionArgs {
    /// 会话 id。
    pub session_id: String,
    /// 是否置顶。
    pub pinned: bool,
}

/// `agent_compress` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AgentCompressArgs {
    /// 会话 id。
    pub session_id: String,
}

/// `agent_delete_session` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AgentDeleteSessionArgs {
    /// 会话 id。
    pub session_id: String,
}
