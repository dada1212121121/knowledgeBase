//! 数据源:source 的增改、导入与重跑。

use super::*;

/// `refresh_sources` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct RefreshSourcesArgs {
    /// 只演练:列出到点的数据源,不真的刷新。
    #[serde(default)]
    pub dry_run: bool,
}

/// `add_source` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AddSourceArgs {
    /// 来源类型:local_dir / git / web / note(上传与压缩包由上传接口创建)。
    pub kind: String,
    /// 显示名(默认取路径 / 仓库名)。
    #[serde(default)]
    pub name: Option<String>,
    /// 本地路径 / 仓库地址 / 网页 URL;`note` 时是正文。
    #[serde(default)]
    pub uri: Option<String>,
    /// 目标 collection。
    pub collection: String,
    /// 标签。
    #[serde(default)]
    pub tags: Vec<String>,
    /// include glob。
    #[serde(default)]
    pub include: Vec<String>,
    /// exclude glob。
    #[serde(default)]
    pub exclude: Vec<String>,
    /// 网页抓取深度(1..=3)。
    #[serde(default)]
    pub depth: Option<u32>,
    /// 网页域名白名单。
    #[serde(default)]
    pub allow_hosts: Vec<String>,
    /// 定时刷新间隔(分钟)。
    #[serde(default)]
    pub refresh_minutes: Option<u64>,
    /// 网页来源:抓到的页面是否再交给内置模型整理成规范化结果(不给 = 系统默认)。
    #[serde(default)]
    pub ai_extract: Option<bool>,
    /// 网页来源的提取要求(≤2000 字;留空 = 自动判断页面类型、尽量全面地整理)。
    #[serde(default)]
    pub extract_prompt: Option<String>,
}

/// `update_source` 的参数(只改给出的字段)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct UpdateSourceArgs {
    /// 数据源 id。
    pub id: String,
    /// 显示名。
    #[serde(default)]
    pub name: Option<String>,
    /// 地址(本地目录 / 网页 / 笔记可改)。
    #[serde(default)]
    pub uri: Option<String>,
    /// 目标 collection。
    #[serde(default)]
    pub collection: Option<String>,
    /// 标签。
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// include glob。
    #[serde(default)]
    pub include: Option<Vec<String>>,
    /// exclude glob。
    #[serde(default)]
    pub exclude: Option<Vec<String>>,
    /// 网页抓取深度。
    #[serde(default)]
    pub depth: Option<u32>,
    /// 网页域名白名单。
    #[serde(default)]
    pub allow_hosts: Option<Vec<String>>,
    /// 定时刷新间隔(分钟;`0` 表示关掉)。
    #[serde(default)]
    pub refresh_minutes: Option<u64>,
    /// 网页来源:AI 规范化开关。
    #[serde(default)]
    pub ai_extract: Option<bool>,
    /// 网页来源:提取要求(给空串改回自动;改了之后下次同步按新要求重新整理)。
    #[serde(default)]
    pub extract_prompt: Option<String>,
}

/// `list_ingest` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ListIngestArgs {
    /// 只看某个 collection。
    #[serde(default)]
    pub collection: Option<String>,
    /// 只看某个批次。
    #[serde(default)]
    pub batch_id: Option<String>,
    /// 只看某个状态:queued / extracting / chunking / embedding / done / failed / quarantined。
    #[serde(default)]
    pub state: Option<String>,
    /// 页码,从 1 起。
    #[serde(default)]
    pub page: Option<u32>,
    /// 每页条数(上限 200)。
    #[serde(default)]
    pub page_size: Option<u32>,
}

/// `retry_file_stage` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct RetryStageArgs {
    /// ingest 文件 id。
    pub id: String,
    /// 从哪个阶段重跑:upload / detect / extract / chunk / embed / write / searchable。
    #[serde(default)]
    pub stage: Option<String>,
}

/// 只带一组文件 id 的参数(`retry_ingest` 用)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct IngestIdsArgs {
    /// 要处理的 ingest 文件 id。
    pub ids: Vec<String>,
}
