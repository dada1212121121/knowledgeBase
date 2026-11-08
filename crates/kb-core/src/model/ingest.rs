//! 入库流水线:批次、文件、阶段与阶段事件。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Millis;
use serde::{Deserialize, Serialize};

/// `ingest_files` 表的状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestState {
    /// 已入队,等待处理。
    Queued,
    /// 类型识别 / 解包 / 读盘。
    Extracting,
    /// 分块。
    Chunking,
    /// 向量化。
    Embedding,
    /// 完成(可检索)。
    Done,
    /// 失败(带 error,可重试)。
    Failed,
    /// 隔离(恶意压缩包、损坏文件等;`release_quarantine` 才重新入队)。
    Quarantined,
    /// 被跳过(`skip_file`,例如暂不支持的格式);不算失败,可以再重试。
    Skipped,
}

impl IngestState {
    /// 数据库 / API 里的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Extracting => "extracting",
            Self::Chunking => "chunking",
            Self::Embedding => "embedding",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Quarantined => "quarantined",
            Self::Skipped => "skipped",
        }
    }

    /// 从字符串还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "queued" => Some(Self::Queued),
            "extracting" => Some(Self::Extracting),
            "chunking" => Some(Self::Chunking),
            "embedding" => Some(Self::Embedding),
            "done" => Some(Self::Done),
            "failed" => Some(Self::Failed),
            "quarantined" => Some(Self::Quarantined),
            "skipped" => Some(Self::Skipped),
            _ => None,
        }
    }

    /// 是否已经结束(不会再被 worker 取到)。
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            Self::Done | Self::Failed | Self::Quarantined | Self::Skipped
        )
    }
}

/// `ingest_files` 表:一个待解析 / 已解析的文件。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IngestFile {
    /// 主键(uuid v7)。
    pub id: String,
    /// 归属批次(撤销以批次为单位)。
    pub batch_id: Option<String>,
    /// 所属数据源。
    pub source_id: Option<String>,
    /// 来源上传(压缩包解出来的文件也指向同一个上传)。
    pub upload_id: Option<String>,
    /// 目标 collection。
    pub collection: String,
    /// 集合内相对路径,同时也是检索结果里的 `source`。
    pub rel_path: String,
    /// 磁盘上的绝对路径。
    pub abs_path: String,
    /// 字节数。
    pub size: u64,
    /// 内容的 sha256(去重与秒传用)。
    pub sha256: Option<String>,
    /// 状态。
    pub state: IngestState,
    /// 失败 / 隔离原因。
    pub error: Option<String>,
    /// 入库后的块数。
    pub chunks: u64,
    /// 抽取元信息(页数 / 表数 / 幻灯片 / 时长;JSON 文本,旧行可能为空)。
    pub extract_meta: Option<String>,
    /// 父条目的相对路径:邮件附件指向那封邮件,压缩包里的文件指向那个压缩包。
    ///
    /// 入库完成后据此写一条 `derived_from` 边。放在行里而不是进程内的表,
    /// 是为了让进程重启后重新处理这个文件时还能把边补上。
    pub derived_from: Option<String>,
    /// 入库后的向量数(当前等于块数,保留给 的分阶段计数)。
    pub vectors: u64,
    /// 解析耗时(毫秒)。
    pub elapsed_ms: Option<u64>,
    /// 入队时间。
    pub created_at: Millis,
    /// 最近一次状态变化的时间。
    pub updated_at: Millis,
}

/// 解析流水线的固定阶段:上传 → 类型识别 → 解析/抽取 → 分块 → 向量化 → 写入索引 → 可检索。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestStage {
    /// 上传(字节落地)。
    Upload,
    /// 类型识别(魔数 / 扩展名)。
    Detect,
    /// 解析 / 抽取(压缩包解包、OCR、转写等子步骤都在这一段)。
    Extract,
    /// 分块。
    Chunk,
    /// 向量化。
    Embed,
    /// 写入索引。
    Write,
    /// 可检索(这一阶段结束时文件才算完成)。
    Searchable,
}

impl IngestStage {
    /// 数据库 / API 里的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Detect => "detect",
            Self::Extract => "extract",
            Self::Chunk => "chunk",
            Self::Embed => "embed",
            Self::Write => "write",
            Self::Searchable => "searchable",
        }
    }

    /// 从字符串还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "upload" => Some(Self::Upload),
            "detect" => Some(Self::Detect),
            "extract" => Some(Self::Extract),
            "chunk" => Some(Self::Chunk),
            "embed" => Some(Self::Embed),
            "write" => Some(Self::Write),
            "searchable" => Some(Self::Searchable),
            _ => None,
        }
    }

    /// 七个阶段(顺序即流水线顺序)。
    pub const ALL: [Self; 7] = [
        Self::Upload,
        Self::Detect,
        Self::Extract,
        Self::Chunk,
        Self::Embed,
        Self::Write,
        Self::Searchable,
    ];

    /// 中文名(日志与报告用)。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Upload => "上传",
            Self::Detect => "类型识别",
            Self::Extract => "解析/抽取",
            Self::Chunk => "分块",
            Self::Embed => "向量化",
            Self::Write => "写入索引",
            Self::Searchable => "可检索",
        }
    }
}

/// 一个阶段的状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestStageStatus {
    /// 正在跑。
    Running,
    /// 成功。
    Ok,
    /// 失败(带 error)。
    Failed,
    /// 跳过。
    Skipped,
    /// 隔离。
    Quarantined,
}

impl IngestStageStatus {
    /// 数据库 / API 里的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Ok => "ok",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Quarantined => "quarantined",
        }
    }

    /// 从字符串还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "running" => Some(Self::Running),
            "ok" => Some(Self::Ok),
            "failed" => Some(Self::Failed),
            "skipped" => Some(Self::Skipped),
            "quarantined" => Some(Self::Quarantined),
            _ => None,
        }
    }

    /// 是否已经结束。
    pub fn is_terminal(&self) -> bool {
        !matches!(self, Self::Running)
    }
}

/// `ingest_stage_events` 表:一个文件在某一段流水线上的耗时与产出。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IngestStageEvent {
    /// 自增主键(写入时用 `None`)。
    pub id: Option<i64>,
    /// 文件 id。
    pub file_id: String,
    /// 批次 id。
    pub batch_id: Option<String>,
    /// 阶段。
    pub stage: IngestStage,
    /// 开始时间。
    pub started_at: Millis,
    /// 结束时间(进行中为 `None`)。
    pub ended_at: Option<Millis>,
    /// 状态。
    pub status: IngestStageStatus,
    /// 失败 / 跳过 / 隔离的原因。
    pub error: Option<String>,
    /// 这一阶段产出的块数。
    pub chunks: u64,
    /// 这一阶段产出的向量数。
    pub vectors: u64,
}

/// 批次在流水线上的状态(暂停 / 继续 / 取消)。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IngestBatchState {
    /// 正在跑。
    Running,
    /// 暂停:不再取新文件,在途文件跑完当前阶段就停。
    Paused,
    /// 已取消:在途文件回滚,已完成的保留。
    Canceled,
    /// 全部处理完。
    Done,
}

impl IngestBatchState {
    /// 数据库 / API 里的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Canceled => "canceled",
            Self::Done => "done",
        }
    }

    /// 从字符串还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "running" => Some(Self::Running),
            "paused" => Some(Self::Paused),
            "canceled" => Some(Self::Canceled),
            "done" => Some(Self::Done),
            _ => None,
        }
    }

    /// 是否还能继续处理。
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Running)
    }
}

/// `ingest_batches` 表:一个批次的流水线状态(重启后保持暂停 / 取消)。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct IngestBatch {
    /// 批次 id(与 `batches.id` / `ingest_files.batch_id` 同一个)。
    pub batch_id: String,
    /// 目标 collection。
    pub collection: String,
    /// 状态。
    pub state: IngestBatchState,
    /// 创建时间。
    pub created_at: Millis,
    /// 最近一次状态变化。
    pub updated_at: Millis,
}

/// `list_ingest` 的过滤条件。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IngestFilter {
    /// 只看某个 collection。
    pub collection: Option<String>,
    /// 只看某个批次。
    pub batch_id: Option<String>,
    /// 只看某个数据源。
    pub source_id: Option<String>,
    /// 只看某个状态。
    pub state: Option<IngestState>,
}
