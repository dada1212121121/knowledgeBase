//! ACP 代理目录(参考 codeg 的「插拔式」做法):
//!
//! - 内置几个常见的 ACP 适配器(claude / codex / deepseek / gemini / kiro);
//! - 用户可以在设置里加自定义代理(command / args / env),存在 `<KB_HOME>/acp.toml`;
//! - 权限策略(none / read / all)也在这里,决定代理请求执行工具时客户端怎么答复。

use std::collections::BTreeMap;
use std::path::Path;

use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};

/// 一个 ACP 代理的定义。
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AcpAgentDef {
    /// 稳定 id(`claude` / `my-agent` …)。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// 可执行文件。
    pub command: String,
    /// 命令行参数。
    #[serde(default)]
    pub args: Vec<String>,
    /// 额外环境变量。
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// npm 安装规格(例如 `@agentclientprotocol/claude-agent-acp@0.94.0`);空 = 需要用户自己装。
    #[serde(default)]
    pub npm: String,
    /// 官方安装说明(没有 npm 包时展示)。
    #[serde(default)]
    pub docs: String,
}

/// `acp.toml` 的内容(只存用户自定义的部分 + 全局策略)。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AcpSettings {
    /// `none` / `read` / `all`。
    #[serde(default = "default_permission")]
    pub permission: String,
    /// 默认后端:空 = 内置模型,否则是代理 id。
    #[serde(default)]
    pub default_agent: String,
    /// 是否用 bwrap 把代理关进沙箱(默认开)。
    #[serde(default = "default_sandbox")]
    pub sandbox: bool,
    /// 交给代理的 MCP 工具组(`knowledge` / `jobs` / `insight` / `docs`;空 = 全部)。
    /// 默认只有 `knowledge`(写经验和重建索引要在设置里打开)。
    #[serde(default = "default_tool_groups")]
    pub tool_groups: Vec<String>,
    /// 沙箱起不来时是否允许不隔离就启动。默认否。
    #[serde(default)]
    pub allow_unsandboxed: bool,
    /// 是否允许把 sh / bash / env 当作代理命令。默认否。
    #[serde(default)]
    pub allow_shell_commands: bool,
    /// 代理空闲这么多分钟后回收。
    #[serde(default = "default_idle_minutes")]
    pub idle_minutes: u64,
    /// 全站同时活着的代理上限(含正在排队占位的)。
    #[serde(default = "default_max_agents")]
    pub max_agents: u32,
    /// 每个用户同时活着的代理会话数(普通用户;默认 1)。
    #[serde(default = "default_max_per_user")]
    pub max_per_user: u32,
    /// 全站名额满了时最多排队等多久(秒),超时才报「繁忙」。
    #[serde(default = "default_queue_wait")]
    pub queue_wait_secs: u64,
    /// 普通用户每个会话的工作目录大小上限(MB);超过后不再开始新的一轮,直到清理。
    #[serde(default = "default_workspace_mb")]
    pub workspace_mb: u64,
    /// 普通用户的代理进程 CPU 时间上限(秒,单进程)。0 = 不限。
    #[serde(default = "default_user_cpu_secs")]
    pub user_cpu_secs: u64,
    /// 普通用户的代理能写的单个文件大小上限(MB)。0 = 不限。
    #[serde(default = "default_user_fsize_mb")]
    pub user_fsize_mb: u64,
    /// 一轮对话的超时(秒)。
    #[serde(default = "default_turn_timeout")]
    pub turn_timeout_secs: u64,
    /// 用户自定义的代理。
    #[serde(default)]
    pub agents: Vec<AcpAgentDef>,
}

fn default_sandbox() -> bool {
    true
}

fn default_tool_groups() -> Vec<String> {
    vec!["knowledge".to_owned()]
}

fn default_idle_minutes() -> u64 {
    10
}

fn default_max_agents() -> u32 {
    // 设计规范:全站同时 8 个会话
    8
}

fn default_max_per_user() -> u32 {
    1
}

fn default_queue_wait() -> u64 {
    60
}

fn default_workspace_mb() -> u64 {
    512
}

fn default_user_cpu_secs() -> u64 {
    // 30 分钟:与方案里「单次最长时长」一致
    1800
}

fn default_user_fsize_mb() -> u64 {
    512
}

fn default_turn_timeout() -> u64 {
    300
}

fn default_permission() -> String {
    // 默认最严:所有工具调用都要界面确认;读/搜/取可在设置里放开
    "none".to_owned()
}

impl Default for AcpSettings {
    fn default() -> Self {
        Self {
            permission: default_permission(),
            default_agent: String::new(),
            sandbox: default_sandbox(),
            tool_groups: default_tool_groups(),
            allow_unsandboxed: false,
            allow_shell_commands: false,
            idle_minutes: default_idle_minutes(),
            max_agents: default_max_agents(),
            max_per_user: default_max_per_user(),
            queue_wait_secs: default_queue_wait(),
            workspace_mb: default_workspace_mb(),
            user_cpu_secs: default_user_cpu_secs(),
            user_fsize_mb: default_user_fsize_mb(),
            turn_timeout_secs: default_turn_timeout(),
            agents: Vec::new(),
        }
    }
}

/// 内置代理(参考 codeg 的 19 个;命令在本机不存在时,设置页显示「未安装」)。
///
/// `npm` 是可直接 `npm install -g` 的包(带版本);没有 npm 包的(Binary / 厂商安装器)
/// 只给 `docs`,由用户自己安装后按命令探测。
pub fn builtin_agents() -> Vec<AcpAgentDef> {
    fn agent(
        id: &str,
        name: &str,
        command: &str,
        args: &[&str],
        npm: &str,
        docs: &str,
    ) -> AcpAgentDef {
        AcpAgentDef {
            id: id.to_owned(),
            name: name.to_owned(),
            command: command.to_owned(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            env: BTreeMap::new(),
            npm: npm.to_owned(),
            docs: docs.to_owned(),
        }
    }
    vec![
        agent(
            "claude",
            "Claude Code",
            "claude-agent-acp",
            &[],
            "@agentclientprotocol/claude-agent-acp@0.94.0",
            "",
        ),
        agent(
            "codex",
            "Codex",
            "codex-acp",
            &[],
            "@agentclientprotocol/codex-acp@2.2.2",
            "",
        ),
        agent(
            "gemini",
            "Gemini",
            "gemini",
            &["--acp", "--skip-trust"],
            "@google/gemini-cli@0.60.0",
            "",
        ),
        agent(
            "openclaw",
            "OpenClaw",
            "openclaw",
            &["acp"],
            "openclaw@2026.9.8",
            "",
        ),
        agent("cline", "Cline", "cline", &["--acp"], "cline@3.0.73", ""),
        agent(
            "opencode",
            "OpenCode",
            "opencode",
            &["acp"],
            "",
            "https://opencode.ai/docs/",
        ),
        agent(
            "hermes",
            "Hermes",
            "hermes",
            &["acp"],
            "hermes-agent@0.22.2",
            "",
        ),
        agent(
            "codebuddy",
            "CodeBuddy",
            "codebuddy",
            &["--acp"],
            "@tencent-ai/codebuddy-code@2.171.0",
            "",
        ),
        agent(
            "kimi",
            "Kimi Code",
            "kimi",
            &["acp"],
            "@moonshot-ai/kimi-code@2.3.0",
            "",
        ),
        agent("pi", "Pi", "pi-acp", &[], "pi-acp@0.0.34", ""),
        agent(
            "grok",
            "Grok",
            "grok",
            &["agent", "stdio"],
            "@xai-official/grok@1.0.62",
            "",
        ),
        agent(
            "cursor",
            "Cursor Agent",
            "cursor-agent",
            &["acp"],
            "",
            "https://cursor.com/cli",
        ),
        agent(
            "zcode",
            "ZCode",
            "zcode-acp-server",
            &["server"],
            "zcode-acp-server@0.76.2",
            "",
        ),
        agent(
            "deepseek",
            "DeepSeek",
            "deepseek-acp",
            &[],
            "deepseek-acp@0.9.0",
            "",
        ),
        agent(
            "qoder",
            "Qoder",
            "qoder",
            &["--acp"],
            "@qoder-ai/qodercli@1.1.75",
            "",
        ),
        agent(
            "antigravity",
            "Antigravity",
            "agy_acp_server",
            &[],
            "",
            "https://antigravity.google/",
        ),
        agent(
            "kiro",
            "Kiro",
            "kiro",
            &["acp"],
            "",
            "https://kiro.dev/docs/getting-started/installation/",
        ),
        agent(
            "trae",
            "Trae",
            "traecli",
            &["acp", "serve"],
            "",
            "https://www.trae.ai/",
        ),
        agent(
            "command-code",
            "Command Code",
            "command-code",
            &["acp"],
            "command-code@1.86.3",
            "",
        ),
    ]
}

/// 一个代理的「地址 / 密钥 / 模型」对应的环境变量(照 codeg 的 `agent_env_keys`)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AgentEnvKeys {
    /// API 地址。
    pub base: &'static str,
    /// 密钥。
    pub key: &'static str,
    /// 模型。
    pub model: &'static str,
}

/// 代理自己的配置目录(home 相对路径),沙箱里按需只读/读写挂进去。
pub fn config_dirs(id: &str) -> &'static [&'static str] {
    match id {
        "claude" => &[".claude"],
        "codex" => &[".codex"],
        "deepseek" => &[".dsh"],
        "gemini" => &[".gemini", ".config/gemini"],
        "grok" => &[".grok"],
        "kimi" => &[".kimi-code"],
        "qoder" => &[".qoder"],
        "cursor" => &[".cursor"],
        "opencode" => &[".config/opencode", ".local/share/opencode"],
        "cline" => &[".cline"],
        "hermes" => &[".hermes"],
        "pi" => &[".pi"],
        "antigravity" => &[".antigravity"],
        "trae" => &[".trae"],
        "command-code" => &[".command-code"],
        "openclaw" => &[".openclaw"],
        "codebuddy" => &[".codebuddy"],
        _ => &[],
    }
}

/// 已知代理的环境变量映射(没有的返回 `None`,只给通用 env 表)。
pub fn env_keys(id: &str) -> Option<AgentEnvKeys> {
    let (base, key, model) = match id {
        "claude" => (
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_MODEL",
        ),
        "gemini" => ("GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY", "GEMINI_MODEL"),
        "kimi" => (
            "KIMI_MODEL_BASE_URL",
            "KIMI_MODEL_API_KEY",
            "KIMI_MODEL_NAME",
        ),
        "grok" => ("GROK_XAI_API_BASE_URL", "XAI_API_KEY", "GROK_DEFAULT_MODEL"),
        "cursor" => ("CURSOR_API_BASE_URL", "CURSOR_API_KEY", "CURSOR_MODEL"),
        "deepseek" => (
            "DEEPSEEK_BASE_URL",
            "DEEPSEEK_API_KEY",
            "DEEPSEEK_ACP_MODEL",
        ),
        "qoder" => (
            "QODER_BASE_URL",
            "QODER_PERSONAL_ACCESS_TOKEN",
            "QODER_MODEL",
        ),
        "antigravity" => ("AGY_BASE_URL", "GEMINI_API_KEY", "AGY_ACP_DEFAULT_MODEL"),
        "cline" => ("CLINE_BASE_URL", "CLINE_API_KEY", "CLINE_MODEL"),
        "kiro" => ("KIRO_BASE_URL", "KIRO_API_KEY", "KIRO_MODEL"),
        _ => return None,
    };
    Some(AgentEnvKeys { base, key, model })
}

/// 内置 + 自定义(同 id 时自定义覆盖内置)。
pub fn all_agents(settings: &AcpSettings) -> Vec<AcpAgentDef> {
    let mut agents = builtin_agents();
    for custom in &settings.agents {
        if let Some(existing) = agents.iter_mut().find(|agent| agent.id == custom.id) {
            *existing = custom.clone();
        } else {
            agents.push(custom.clone());
        }
    }
    agents
}

/// 按 id 找代理。
pub fn find(settings: &AcpSettings, id: &str) -> Option<AcpAgentDef> {
    all_agents(settings)
        .into_iter()
        .find(|agent| agent.id == id)
}

/// 校验一个代理定义(id / 命令不能空,id 只允许字母数字与 `-_.`)。
pub fn validate(agent: &AcpAgentDef) -> Result<()> {
    if agent.id.trim().is_empty() {
        return Err(KbError::InvalidInput("代理 id 不能为空".to_owned()));
    }
    if !agent
        .id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(KbError::InvalidInput(
            "代理 id 只能用字母、数字、-、_、.".to_owned(),
        ));
    }
    if agent.command.trim().is_empty() {
        return Err(KbError::InvalidInput("启动命令不能为空".to_owned()));
    }
    Ok(())
}

/// 读 `acp.toml`(不存在返回默认值)。
pub fn load(path: &Path) -> AcpSettings {
    let Ok(text) = std::fs::read_to_string(path) else {
        return AcpSettings::default();
    };
    match toml::from_str(&text) {
        Ok(settings) => settings,
        Err(err) => {
            tracing::warn!(path = %path.display(), %err, "acp.toml 解析失败,用默认配置");
            AcpSettings::default()
        }
    }
}

/// 写 `acp.toml`(先写临时文件再改名)。
pub fn save(path: &Path, settings: &AcpSettings) -> Result<()> {
    let text = toml::to_string_pretty(settings)
        .map_err(|err| KbError::Internal(format!("序列化 acp.toml 失败: {err}")))?;
    let temp = path.with_extension("toml.tmp");
    std::fs::write(&temp, text)
        .map_err(|err| KbError::Internal(format!("写 {} 失败: {err}", temp.display())))?;
    std::fs::rename(&temp, path)
        .map_err(|err| KbError::Internal(format!("替换 {} 失败: {err}", path.display())))?;
    // 里面可能有 API key:和 secrets.toml 一样只给属主读
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 命令是否可执行(在 PATH 上,或给出了可执行文件路径)。空文件、没有执行位的不算。
pub fn command_available(command: &str) -> bool {
    command_available_in(command, &[])
}

/// 同 [`command_available`],额外再找这些目录(例如 `<KB_HOME>/acp-tools/bin`)。
pub fn command_available_in(command: &str, extra_dirs: &[std::path::PathBuf]) -> bool {
    if command.contains('/') {
        return is_executable(Path::new(command));
    }
    if extra_dirs
        .iter()
        .any(|dir| is_executable(&dir.join(command)))
    {
        return true;
    }
    std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).any(|dir| is_executable(&dir.join(command))))
        .unwrap_or(false)
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.is_file()
            && path
                .metadata()
                .map(|meta| meta.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// 不能直接当代理命令的解释器。
const SHELL_COMMANDS: &[&str] = &[
    "sh", "bash", "dash", "zsh", "fish", "csh", "ksh", "env", "busybox",
];

/// 自定义代理的 command:绝对路径或 PATH 上的命令,默认不允许 shell / env。
pub fn validate_command(command: &str, allow_shell: bool) -> Result<()> {
    let command = command.trim();
    if command.is_empty() {
        return Err(KbError::InvalidInput("启动命令不能为空".to_owned()));
    }
    let name = Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(command);
    if !allow_shell && SHELL_COMMANDS.contains(&name) {
        return Err(KbError::InvalidInput(
            "不允许把 sh / bash / env 这类解释器直接作为代理命令;需要的话在 acp.toml 设 allow_shell_commands = true"
                .to_owned(),
        ));
    }
    let path = Path::new(command);
    if path.is_absolute() {
        if !is_executable(path) {
            return Err(KbError::InvalidInput(format!(
                "命令不存在或不可执行: {command}"
            )));
        }
        return Ok(());
    }
    if command.contains('/') {
        return Err(KbError::InvalidInput(
            "请使用绝对路径,或 PATH 上的命令名".to_owned(),
        ));
    }
    let builtin = builtin_agents()
        .into_iter()
        .any(|agent| agent.command == command);
    if builtin || command_available(command) {
        return Ok(());
    }
    Err(KbError::InvalidInput(format!(
        "PATH 上找不到可执行的命令 {command}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_agent_overrides_a_builtin_with_the_same_id() {
        let mut settings = AcpSettings::default();
        settings.agents.push(AcpAgentDef {
            id: "claude".to_owned(),
            name: "我的 Claude".to_owned(),
            command: "/opt/claude-acp".to_owned(),
            args: vec!["--verbose".to_owned()],
            env: BTreeMap::from([("KEY".to_owned(), "v".to_owned())]),
            ..AcpAgentDef::default()
        });
        let agents = all_agents(&settings);
        let claude = agents
            .iter()
            .find(|agent| agent.id == "claude")
            .expect("claude");
        assert_eq!(claude.name, "我的 Claude");
        assert_eq!(claude.command, "/opt/claude-acp");
        assert_eq!(claude.args, vec!["--verbose".to_owned()]);
        assert_eq!(agents.len(), builtin_agents().len(), "同 id 不应新增");
    }

    #[test]
    fn builtin_catalog_covers_the_agents_codeg_ships() {
        let agents = builtin_agents();
        assert_eq!(agents.len(), 19, "内置代理数量");
        for agent in &agents {
            assert!(!agent.command.is_empty(), "{} 缺命令", agent.id);
            assert!(
                !agent.npm.is_empty() || !agent.docs.is_empty(),
                "{} 既没有 npm 包也没有安装说明",
                agent.id
            );
        }
        let ids: Vec<&str> = agents.iter().map(|agent| agent.id.as_str()).collect();
        for expected in [
            "claude",
            "codex",
            "gemini",
            "deepseek",
            "kiro",
            "cursor",
            "command-code",
        ] {
            assert!(ids.contains(&expected), "{expected} 不在目录里");
        }
    }

    #[test]
    fn validate_rejects_empty_or_weird_ids() {
        let mut agent = AcpAgentDef {
            id: "ok-id_1".to_owned(),
            name: "x".to_owned(),
            command: "cmd".to_owned(),
            ..AcpAgentDef::default()
        };
        assert!(validate(&agent).is_ok());
        agent.id = "bad id".to_owned();
        assert!(validate(&agent).is_err());
        agent.id = "ok".to_owned();
        agent.command = "  ".to_owned();
        assert!(validate(&agent).is_err());
    }

    #[test]
    fn settings_round_trip_through_toml() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("acp.toml");
        let mut settings = AcpSettings {
            permission: "all".to_owned(),
            default_agent: "mine".to_owned(),
            sandbox: false,
            tool_groups: vec!["knowledge".to_owned()],
            ..AcpSettings::default()
        };
        settings.agents = vec![AcpAgentDef {
            id: "mine".to_owned(),
            name: "Mine".to_owned(),
            command: "mine-acp".to_owned(),
            args: vec!["--x".to_owned()],
            env: BTreeMap::from([("A".to_owned(), "b".to_owned())]),
            ..AcpAgentDef::default()
        }];
        save(&path, &settings).expect("保存");
        let loaded = load(&path);
        assert_eq!(loaded.permission, "all");
        assert_eq!(loaded.default_agent, "mine");
        assert!(!loaded.sandbox);
        assert_eq!(loaded.tool_groups, vec!["knowledge".to_owned()]);
        assert_eq!(loaded.agents, settings.agents);
        settings.permission = "read".to_owned();
        save(&path, &settings).expect("再保存");
        assert_eq!(load(&path).permission, "read");
    }
}
