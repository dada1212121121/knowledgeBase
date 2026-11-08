//! 模型与演进类配置。
//!
//! 由 `config.rs` 拆出:路径不变,入口仍是 `kb_core::config`。
use serde::{Deserialize, Serialize};

/// `[llm]` 配置段
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LlmConfig {
    /// 服务商标识。
    pub provider: String,
    /// OpenAI 兼容的 base URL。
    pub base_url: String,
    /// 提炼用的模型。
    pub extract_model: String,
    /// 审核用的模型(与提炼不同)。
    pub review_model: String,
    /// AI 管家用的模型。
    pub agent_model: String,
    /// 每日 token 预算(**每个模型各一份**,`0` = 不限)。
    ///
    /// 由 `kb-service::llm_gate` 在每次外发前检查:按 `llm_usage` 里**今天、该模型**
    /// 的 `input + output` 求和,达到上限就拒绝(返回 `Unavailable`)。
    pub daily_token_budget: u64,
    /// 每小时最大调用次数(**全局合计**,`0` = 不限)。
    ///
    /// 统计口径是 `llm_sends` 表里最近一小时的行数,即**成功外发**的次数:
    /// 客户端内部重试、失败、超时都不计;提炼 / 审核 / 深度检索 / AI 管家共用这一份额度。
    /// 检查与写入之间没有锁,并发时会略超(软上限)。
    pub max_calls_per_hour: u32,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: "deepseek".to_owned(),
            base_url: "https://api.deepseek.com".to_owned(),
            extract_model: "deepseek-flash".to_owned(),
            review_model: "deepseek-v4-pro".to_owned(),
            agent_model: "deepseek-v4-pro".to_owned(),
            daily_token_budget: 2_000_000,
            max_calls_per_hour: 60,
        }
    }
}

/// `[evolution]`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EvolutionConfig {
    /// 新项目默认是否开启自动提炼。
    pub extract_enabled_default: bool,
    /// `ai` | `ai_then_human` | `human`。
    pub review_mode: String,
    /// 审核通过的分数阈值。
    pub approve_threshold: f64,
    /// 判为重复的向量相似度阈值。
    pub dedup_similarity: f64,
    /// 主题归纳(consolidate_project)的聚类阈值:余弦 ≥ 它算同一主题。
    pub consolidate_similarity: f64,
    /// 一个主题至少几条才值得归纳(少于它不调 LLM)。
    pub consolidate_min_members: usize,
    /// 一次归纳最多处理几个主题(限制 LLM 调用次数)。
    pub consolidate_max_clusters: usize,
    /// 夜间调度是否顺带跑一次去重。
    pub nightly_dedup: bool,
    /// 会话记录允许落在哪些目录(项目根之外)。
    ///
    /// 守护进程与 AI 客户端的 `HOME` 可能不同(本机生产:守护进程 `HOME=/root`,
    /// 会话在 `/home/user/.codeg/.kiro`),所以这里**必须能显式配置**,不能只靠
    /// 守护进程的环境变量去猜。`~` 按守护进程的 `HOME` 展开。
    pub session_roots: Vec<String>,
}

impl Default for EvolutionConfig {
    fn default() -> Self {
        Self {
            extract_enabled_default: false,
            review_mode: "ai".to_owned(),
            approve_threshold: 0.7,
            dedup_similarity: 0.92,
            consolidate_similarity: 0.80,
            consolidate_min_members: 2,
            consolidate_max_clusters: 5,
            nightly_dedup: true,
            session_roots: vec!["~/.claude".to_owned(), "~/.kiro".to_owned()],
        }
    }
}

/// `[ai]`:AI 总开关与各子功能开关(多用户设计说明)。
///
/// 调用大模型或外部编码代理的功能才算 AI;本机运行的检索、重排、OCR、转写不受影响。
/// 总开关关闭后,所有 AI 功能一起消失:界面入口隐藏、能力返回 403、后台提炼 / 审核 / 上下文生成跳过。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AiConfig {
    /// 总开关。
    pub enabled: bool,
    /// 自动提炼与 AI 审核(`ai.extract`)。
    pub extract: bool,
    /// 深度检索与查询改写(`search.deep`)。
    pub deep_search: bool,
    /// 整理:去重建议、主题归纳、质量报告(`ai.organize`)。
    pub organize: bool,
    /// AI 助手(`ai.assistant`)。
    pub assistant: bool,
    /// 编码代理(`ai.acp`)。
    pub acp: bool,
    /// 用 LLM 给分块写上下文(`context_mode = llm`);默认关。
    pub chunk_context: bool,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            extract: true,
            deep_search: true,
            organize: true,
            assistant: true,
            acp: true,
            chunk_context: false,
        }
    }
}

impl AiConfig {
    /// 算成功能点层面的 AI 状态(给 `FeatureSet` 用)。
    pub fn state(&self) -> crate::features::AiState {
        let mut off = std::collections::BTreeSet::new();
        for (flag, feature) in [
            (self.extract, "ai.extract"),
            (self.deep_search, "search.deep"),
            (self.organize, "ai.organize"),
            (self.assistant, "ai.assistant"),
            (self.acp, "ai.acp"),
        ] {
            if !flag {
                off.insert(feature.to_owned());
            }
        }
        crate::features::AiState {
            master: self.enabled,
            off,
        }
    }
}
