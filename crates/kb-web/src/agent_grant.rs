//! 会话级 ACP 伴生令牌。只活在内存里,会话结束就失效。
//!
//! `agent.sock` 上的请求必须带这个令牌。身份固定为 MCP 面、权限上限 Write,
//! 能调的能力再按签发时的工具组过滤。

use std::collections::HashMap;
use std::sync::Mutex;

/// 一次代理会话被允许的范围。
#[derive(Clone, Debug)]
pub struct AgentGrant {
    /// `knowledge` / `jobs` / `insight` / `all`。
    pub tool_groups: Vec<String>,
    /// 会话所属项目(过滤外发正文时用)。
    pub project: Option<String>,
    /// 管家会话 id。
    pub session_id: String,
    /// 发起这次会话的人(用户 + 知识库 + 功能)。伴生进程回调能力时用它,而不是本机超级用户,
    /// 否则别人的代理会话能读到主知识库。`None` 只出现在旧调用方 / 测试里,按本机处理。
    pub principal: Option<kb_capability::Principal>,
    /// 远程 MCP 令牌的「包含共享给我」开关:开了以后 `search_knowledge` 会把别人分享给这个用户的内容也一起搜。
    /// 默认关,免得 AI 工具把别人的文档带进上下文。
    pub include_shared: bool,
}

/// 进程内令牌表。
#[derive(Debug, Default)]
pub struct AgentGrants {
    inner: Mutex<HashMap<String, AgentGrant>>,
}

impl AgentGrants {
    /// 空表。
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// 签发一个新令牌。
    pub fn issue(&self, grant: AgentGrant) -> String {
        let token = kb_core::token::random_secret();
        self.insert_known(token.clone(), grant);
        token
    }

    /// 放入调用方指定的令牌(测试用)。
    pub fn insert_known(&self, token: String, grant: AgentGrant) {
        self.inner
            .lock()
            .expect("agent grants")
            .insert(token, grant);
    }

    /// 按令牌取授权。
    pub fn lookup(&self, token: &str) -> Option<AgentGrant> {
        self.inner.lock().expect("agent grants").get(token).cloned()
    }

    /// 会话结束:这个会话签发的令牌全部作废。
    pub fn revoke_session(&self, session_id: &str) {
        self.inner
            .lock()
            .expect("agent grants")
            .retain(|_, grant| grant.session_id != session_id);
    }
}
