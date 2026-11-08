//! 运维与后台:配置、令牌、备份、组件(provider / OCR)、索引维护、审计、任务。

use super::*;

/// `test_llm` 的参数(设置页的「测试连接」)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct TestLlmArgs {
    /// 测试用的提示词(默认一句寒暄)。
    #[serde(default)]
    pub prompt: Option<String>,
}

/// `set_llm_key` 的参数(写入 / 清除 `secrets.toml` 里的 LLM API key)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SetLlmKeyArgs {
    /// 新的 API key;空字符串表示清除。
    #[serde(default)]
    pub api_key: String,
}

/// `job_list` 的参数。
///
/// 任务表能累积到上万行(生产上 1.4 万,不带参数时整份 4 MB),所以默认只给第一页 50 个,
/// 运行中和排队的排在最前;筛选在服务端做。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct JobListArgs {
    /// 只看某个状态(queued / running / paused / done / failed / canceled)。和 `states` 可以同时给,取并集。
    #[serde(default)]
    pub state: Option<String>,
    /// 只看这几个状态。
    #[serde(default)]
    pub states: Vec<String>,
    /// 只看这几种类型(index / ingest / migrate / save_insight …)。
    #[serde(default)]
    pub kinds: Vec<String>,
    /// 不看这几种类型。
    #[serde(default)]
    pub exclude_kinds: Vec<String>,
    /// 只看这个 collection 的任务。
    #[serde(default)]
    pub collection: Option<String>,
    /// 第几页(从 1 起,默认 1)。
    #[serde(default)]
    pub page: Option<u32>,
    /// 每页条数(默认 50,最大 200)。
    #[serde(default)]
    pub page_size: Option<u32>,
}

/// 只带一个 id 的参数(`job_get` / `job_cancel` / `item_history` 用)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct JobIdArgs {
    /// 任务 id。
    pub id: String,
}

/// `set_ocr_backend` 的参数(OCR 后端切换)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SetOcrBackendArgs {
    /// `rapidocr` 或 `tesseract`。
    pub backend: String,
    /// 是否顺带打开 OCR(默认不改)。
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// `backup_create` 的参数(设置页「备份」分区)。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct BackupCreateArgs {
    /// 是否把原件(`sources/`)也打进归档;默认不含(体积大,且通常另有副本)。
    #[serde(default)]
    pub include_sources: bool,
}

/// `backup_delete` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct BackupDeleteArgs {
    /// 归档文件名(`backup_status` 里返回的名字)。
    pub name: String,
}

/// `backup_prune` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct BackupPruneArgs {
    /// 只列会被删掉的归档,不真删(默认 false)。
    #[serde(default)]
    pub dry_run: bool,
}

/// `backup_verify` 的参数(恢复流程的第一步:先校验归档再解包)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct BackupVerifyArgs {
    /// 归档文件名(`backup_status` 里返回的名字)。
    pub name: String,
}

/// `deep_search` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DeepSearchArgs {
    /// 问题。
    pub question: String,
    /// 作用域:`project` / `global` / `all`。
    #[serde(default)]
    pub scope: Option<String>,
    /// 项目名或 slug。
    #[serde(default)]
    pub project: Option<String>,
}

/// `provider_set_default` 的参数(组件目录)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ProviderArgs {
    /// 组件种类:`ocr` / `transcribe` / `embed` / `rerank`。
    pub kind: String,
    /// 组件 id(`rapidocr` / `tesseract` / `whisper-cli` …)。
    pub id: String,
}

/// `dedup_insights` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DedupArgs {
    /// collection 名。
    pub collection: String,
    /// 只演练(默认 true:先看计划再执行)。
    #[serde(default = "super::default_true")]
    pub dry_run: bool,
}

/// `consolidate_project` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ConsolidateArgs {
    /// 项目名或 slug。
    pub project: String,
    /// 只演练(默认 true:只聚类出主题,不调 LLM、不写草稿)。
    #[serde(default = "super::default_true")]
    pub dry_run: bool,
}

/// `tune_retrieval` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct TuneRetrievalArgs {
    /// 只给建议、不写配置(默认 true)。
    #[serde(default = "super::default_true")]
    pub dry_run: bool,
    /// 一个 collection 至少多少条反馈才调(默认 5)。
    #[serde(default)]
    pub min_samples: Option<usize>,
    /// 单次调整的最大幅度(默认 0.2,上限 0.2)。
    #[serde(default)]
    pub max_delta: Option<f64>,
}

/// `quality_report` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct QualityReportArgs {
    /// collection 名。
    pub collection: String,
}

/// `eval_run` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct EvalRunArgs {
    /// 黄金集路径。
    #[serde(default)]
    pub set: Option<String>,
    /// 评测的 k。
    #[serde(default)]
    pub k: Option<usize>,
    /// 从黄金集里随机抽 N 条(默认全部)。
    #[serde(default)]
    pub sample: Option<usize>,
    /// 随机种子(默认现取一个毫秒时间戳并写进结果,方便复现同一批用例)。
    #[serde(default)]
    pub seed: Option<u64>,
    /// 重排:on / off / auto(默认 auto = 按配置)。对比两次评测时两次要显式给同一个值。
    #[serde(default)]
    pub rerank: Option<String>,
}

/// `install_hooks` / `uninstall_hooks` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct HooksArgs {
    /// 项目名或 slug。
    pub project: String,
}

/// `migrate_model` / `migrate_plan` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct MigrateArgs {
    /// collection 名(例如 `proj_demo`)。
    pub collection: String,
    /// 目标 embedder id(例如 `fake:16`);必须与当前配置的嵌入器一致。
    pub to: String,
}

/// `set_item_status` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SetStatusArgs {
    /// 记录 id。
    pub id: String,
    /// `active` / `superseded` / `deprecated`。
    pub status: String,
}

/// `supersede_insight` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SupersedeArgs {
    /// 被取代的旧 id。
    pub old_id: String,
    /// 取代它的新 id。
    pub new_id: String,
}

/// `audit_list` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AuditListArgs {
    /// 按操作者过滤。
    #[serde(default)]
    pub actor: Option<String>,
    /// 按能力名过滤。
    #[serde(default)]
    pub capability: Option<String>,
    /// 只看这个时间(Unix 毫秒)之后的记录。
    #[serde(default)]
    pub since: Option<i64>,
    /// 只看某个批次。
    #[serde(default)]
    pub batch_id: Option<String>,
    /// 页码,从 1 起。
    #[serde(default)]
    pub page: Option<u32>,
    /// 每页条数(上限 200)。
    #[serde(default)]
    pub page_size: Option<u32>,
}

/// `revert_batch` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct BatchIdArgs {
    /// 批次 id。
    pub batch_id: String,
}

/// `update_config` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct UpdateConfigArgs {
    /// 配置补丁(与 `config.toml` 同构,只写要改的段)。
    pub patch: serde_json::Value,
    /// 管理级能力必须显式确认。
    #[serde(default)]
    pub confirm: bool,
}

/// `maintain_indexes` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct MaintainIndexesArgs {
    /// 只整理这几个集合;不给就是全部。
    #[serde(default)]
    pub collections: Vec<String>,
    /// 管理级能力必须显式确认。
    #[serde(default)]
    pub confirm: bool,
}

/// `create_token` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct CreateTokenArgs {
    /// 令牌名(唯一)。
    pub name: String,
    /// `mcp`(只能用 MCP 可见面,最多 W 级)或 `api`(Web 面,最多 G 级)。
    #[serde(default)]
    pub scope: Option<String>,
    /// 管理级能力必须显式确认。
    #[serde(default)]
    pub confirm: bool,
}

/// `revoke_token` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct TokenIdArgs {
    /// 令牌 id。
    pub id: String,
    /// 管理级能力必须显式确认。
    #[serde(default)]
    pub confirm: bool,
}

/// `eval_history` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct EvalHistoryArgs {
    /// 最多返回多少条(默认 20,上限 100)。
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `get_batch_progress` / `pause_batch` / `resume_batch` / `cancel_batch` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct BatchArgs {
    /// 批次 id。
    pub batch: String,
    /// 取消时同时撤销整批(`cancel_batch` 用)。
    #[serde(default)]
    pub revert: bool,
}
