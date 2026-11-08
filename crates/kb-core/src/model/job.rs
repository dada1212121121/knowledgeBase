//! 任务与统计:队列、批次、审计、指标、表状况。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Millis;
use serde::{Deserialize, Serialize};

/// `jobs` 表的状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    /// 排队中。
    Queued,
    /// 执行中。
    Running,
    /// 暂停。
    Paused,
    /// 完成。
    Done,
    /// 失败。
    Failed,
    /// 取消。
    Canceled,
}

impl JobState {
    /// 数据库里存储的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Paused => "paused",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }
}

/// `jobs` 表:任务队列。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Job {
    /// 主键。
    pub id: String,
    /// 任务类型(`index` / `save_insight` / `migrate` …)。
    pub kind: String,
    /// 相关 collection。
    pub collection: Option<String>,
    /// 优先级,越大越先执行。
    pub priority: i32,
    /// 状态。
    pub state: JobState,
    /// 对应 `payload_json` 列。
    pub payload_json: String,
    /// 对应 `checkpoint_json` 列。
    pub checkpoint_json: Option<String>,
    /// 列表用的一句话详情(「3 个文件 (a.rs 等)」这类)。
    ///
    /// 列表查询不读 `payload_json`(索引任务的单条能到 3.4 MB),由 [`job_detail_hint`] 从
    /// SQL 里单独取出的几个参数拼出来;取完整任务(`job_get`)时为 `None`,由调用方从
    /// payload 里解出同样的参数再拼一次 —— 拼法只有这一份。
    pub detail: Option<String>,
    /// 已完成的工作量。
    pub progress_done: u64,
    /// 总工作量。
    pub progress_total: Option<u64>,
    /// 速率(指数滑动平均)。
    pub rate: Option<f64>,
    /// 失败原因。
    pub error: Option<String>,
    /// 创建时间。
    pub created_at: Millis,
    /// 开始时间。
    pub started_at: Option<Millis>,
    /// 结束时间。
    pub finished_at: Option<Millis>,
}

/// 任务列表里的一句话详情(前端「详情」列、任务卡、文件清单入口)。
///
/// 任务参数的原文只放在 `payload_json` 里,而列表查询不能读它:生产上单条能到 3.4 MB,
/// 全量拉一遍正好是「任务页加载慢」的根因。所以列表路径在 SQL 里只取几个标量
/// (文件个数、第一个文件、mode、insight_id、batch_id、path),由这里拼接。
///
/// 顺序要和老版直接看 payload 时完全一致:先看 `paths`(1 个 → 文件名;多个 → 「N 个文件
/// (首个 等)」;空数组且 `mode=full` → 全量索引),再看笔记 / 批次 / 单文件,最后看 `mode`。
#[allow(clippy::too_many_arguments)]
pub fn job_detail_hint(
    paths_total: Option<usize>,
    first_path: Option<&str>,
    mode: Option<&str>,
    insight_id: Option<&str>,
    batch_id: Option<&str>,
    path: Option<&str>,
) -> Option<String> {
    if let Some(total) = paths_total {
        if total == 1 {
            return first_path.map(str::to_owned);
        }
        if total > 1 {
            return Some(format!("{total} 个文件 ({} 等)", first_path.unwrap_or("")));
        }
        // 空清单但要求全量重建:没有具体文件可列,写「全量索引」
        if mode == Some("full") {
            return Some("全量索引".to_owned());
        }
    }
    if let Some(id) = insight_id {
        return Some(format!("笔记 {id}"));
    }
    if let Some(id) = batch_id {
        return Some(format!("批次 {id}"));
    }
    if let Some(path) = path {
        return Some(path.to_owned());
    }
    if mode == Some("full") {
        return Some("全量索引".to_owned());
    }
    None
}

/// 一个任务对某个文件做了什么(任务详情「改动的文件」列表的一行)。
///
/// 索引任务每个文件处理完就能知道这些:写入 / 重新嵌入了多少块、只改了元数据、还是失败。
/// 存进 `job_files` 表而不是 `jobs.checkpoint_json`:检查点每个分片都整份重写,
/// 几千个文件会把任务行写到几百 KB,列表和摘要也都不需要它。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct JobFile {
    /// 相对 collection 根的路径。
    pub path: String,
    /// 这次处理的结果。
    pub change: FileChange,
    /// 新写入 / 重新嵌入的块数。
    pub chunks: usize,
    /// 只更新元数据的块数。
    pub meta_chunks: usize,
    /// 删掉的旧块数。
    pub deleted_chunks: usize,
    /// 失败原因(只有 `change = error` 时有)。
    pub error: Option<String>,
    /// 处理时间。
    pub done_at: Millis,
}

/// 单个文件在一次任务里的变化类型。
///
/// 字符串值同时是 `job_files.change` 列和接口里的枚举值,改名要一起改。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileChange {
    /// 知识库里原来没有,这次新建。
    New,
    /// 原来有,内容变了(块被重写 / 重新嵌入)。
    Update,
    /// 内容没变,只更新了元数据(标签、标题、行号等)。
    Meta,
    /// 文件消失或被过滤,旧块被删掉。
    Delete,
    /// 进入了任务但指纹没变,什么都没写。
    Skip,
    /// 处理失败(error 列里有原因)。
    Error,
}

impl FileChange {
    /// 写库 / 接口用的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Update => "update",
            Self::Meta => "meta",
            Self::Delete => "delete",
            Self::Skip => "skip",
            Self::Error => "error",
        }
    }

    /// 从库里的字符串解析;认不出来当坏数据(不静默当成某一类)。
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "new" => Some(Self::New),
            "update" => Some(Self::Update),
            "meta" => Some(Self::Meta),
            "delete" => Some(Self::Delete),
            "skip" => Some(Self::Skip),
            "error" => Some(Self::Error),
            _ => None,
        }
    }

    /// 详情列表的排序权重:失败、删除、新增、更新、只改元数据、没变 —— 越需要看的越前。
    pub fn order(self) -> u8 {
        match self {
            Self::Error => 0,
            Self::Delete => 1,
            Self::New => 2,
            Self::Update => 3,
            Self::Meta => 4,
            Self::Skip => 5,
        }
    }
}

/// 任务列表 / 统计的筛选条件(`job_list` / `job_stats`)。
///
/// 各条件之间是「且」;某个列表为空表示这一项不限。任务表能累积到上万行(生产上 1.4 万),
/// 筛选必须在 SQL 里做,不能整表取出来再在调用方过滤。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JobFilter {
    /// 只要这些状态。
    pub states: Vec<JobState>,
    /// 只要这些类型。
    pub kinds: Vec<String>,
    /// 排除这些类型(AI 总开关关闭时排除自动提炼 / 审核类任务)。
    pub exclude_kinds: Vec<String>,
    /// 只要这些 collection 的任务。
    pub collections: Vec<String>,
}

/// 完成任务用时分段的上界(毫秒,含):10 秒、1 分钟、5 分钟、30 分钟,最后一段收所有更长的。
///
/// 和前端 `utils/jobCharts.ts` 的 `DURATION_EDGES` 一致;几秒的小任务和几十分钟的重建索引不在一个量级,按数量级分段。
pub const JOB_DURATION_EDGES_MS: [i64; 4] = [10_000, 60_000, 300_000, 1_800_000];

/// 任务统计(任务页的指标卡与图表),全部在 SQL 里聚合,不把任务行搬到调用方。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct JobStats {
    /// 符合条件的任务总数。
    pub total: u64,
    /// 六种状态的计数,固定顺序,没有的为 0。
    pub by_state: Vec<(JobState, u64)>,
    /// 出现过的类型和数量(多的在前,同数按名字)。
    pub kinds: Vec<(String, u64)>,
    /// 统计窗口的起点:结束时间(没有结束时间按创建时间)晚于它的任务算「最近」。
    pub recent_since: Millis,
    /// 最近窗口里完成的任务数。
    pub recent_done: u64,
    /// 最近窗口里失败的任务数。
    pub recent_failed: u64,
    /// 最近窗口里取消的任务数。
    pub recent_canceled: u64,
    /// 最近窗口里完成任务的平均用时(毫秒);没有可算的为 `None`。
    pub recent_avg_ms: Option<f64>,
    /// 最早一个排队任务的创建时间。
    pub oldest_queued_at: Option<Millis>,
    /// 最早开始运行的那个运行中任务:`(类型, collection)`。
    pub first_running: Option<(String, Option<String>)>,
    /// 已完成任务的用时分布:按 [`JOB_DURATION_EDGES_MS`] 分 5 段的计数。
    pub duration_buckets: Vec<u64>,
    /// 参与用时统计的已完成任务数(有开始和结束时间的)。
    pub duration_count: u64,
    /// 已完成任务用时的中位数(毫秒)。
    pub duration_median_ms: Option<f64>,
    /// 已完成任务用时的 P95(毫秒,最近秩法)。
    pub duration_p95_ms: Option<f64>,
}

/// 任务时间序列里的一个时间桶(`[start + i × step, start + (i + 1) × step)`)。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct JobBucket {
    /// 这段时间里创建的任务数。
    pub created: u64,
    /// 这段时间里完成的任务数(按结束时间算)。
    pub done: u64,
    /// 这段时间里失败的任务数。
    pub failed: u64,
    /// 这段时间里取消的任务数。
    pub canceled: u64,
    /// 这段时间里完成的任务的平均用时(毫秒);没有可算的为 `None`。
    pub avg_ms: Option<f64>,
    /// 桶结束时还在排队的任务数(已创建、还没开始也没结束)。
    pub queue_depth: u64,
}

/// 任务随时间的变化(任务页的吞吐图、排队深度图)。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct JobSeries {
    /// 第一个桶的起点(毫秒)。
    pub start: Millis,
    /// 每个桶多宽(毫秒)。
    pub step_ms: i64,
    /// 按时间升序的桶,个数固定(没有任务的桶也在,全是 0)。
    pub buckets: Vec<JobBucket>,
}

/// 按天的活动计数(首页 / 系统概览的趋势图、迷你线)。每个数组的长度都等于 `days.len`。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ActivityCounts {
    /// 每天的标签 `YYYY-MM-DD`(站点时区),最后一天是今天。
    pub days: Vec<String>,
    /// 新建的笔记。
    pub notes: Vec<u64>,
    /// 保存过的版本(编辑次数)。
    pub edits: Vec<u64>,
    /// 导入的文件。
    pub imports: Vec<u64>,
    /// 其中解析成功的。
    pub imports_done: Vec<u64>,
    /// 检索次数(检索、代码检索、深度检索,成功的)。
    pub searches: Vec<u64>,
    /// 完成的后台任务。
    pub jobs_done: Vec<u64>,
    /// 云端模型用掉的 token(输入 + 输出)。
    pub ai_tokens: Vec<u64>,
}

/// 导入概况里的一个时间桶(按创建时间归桶)。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct IngestBucket {
    /// 这段时间进来的文件。
    pub total: u64,
    /// 其中解析成功的。
    pub done: u64,
    /// 其中失败的。
    pub failed: u64,
}

/// 导入概况(导入页的状态分布、每小时导入量、失败原因)。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IngestOverview {
    /// 各状态的文件数(没有的状态不出现)。
    pub by_state: Vec<(String, u64)>,
    /// 第一个桶的起点和宽度,以及按时间升序的桶。
    pub start: Millis,
    /// 桶宽(毫秒)。
    pub step_ms: i64,
    /// 桶,个数固定,没有文件的桶全是 0。
    pub buckets: Vec<IngestBucket>,
    /// 失败原因 Top(同样的错误文字合并计数,多的在前)。
    pub top_errors: Vec<(String, u64)>,
}

/// 审计概况(审计页的调用时段热力、最常用的能力)。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AuditOverview {
    /// 7 行(周一到周日)× 24 列(0–23 点)的调用次数,按站点时区(默认上海)。
    pub heat: Vec<Vec<u64>>,
    /// 最常用的能力:`(能力名, 调用次数, 其中失败的)`,多的在前。
    pub top: Vec<(String, u64, u64)>,
    /// 统计范围内参与统计的调用总数。
    pub total: u64,
    /// 其中失败的。
    pub failed: u64,
}

/// 一个时间点的资源读数(落库的是每分钟一行;降采样后一个点代表一个时间桶)。
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize)]
pub struct MetricRow {
    /// 起点(毫秒)。落库时是整分钟,降采样后是桶的起点。
    pub at: i64,
    /// 本机 CPU 使用率,0–1。
    pub cpu: f64,
    /// 这个桶里 CPU 使用率的最大值。
    pub cpu_max: f64,
    /// 已用内存(字节,不含可回收的缓存)。
    pub mem_used: u64,
    /// 内存总量(字节)。
    pub mem_total: u64,
    /// 1 分钟平均负载。
    pub load1: f64,
    /// 数据盘已用(字节)。
    pub disk_used: u64,
    /// 数据盘总量(字节)。
    pub disk_total: u64,
    /// 本服务进程占用的 CPU,占整机的比例 0–1。
    pub proc_cpu: f64,
    /// 本服务进程的常驻内存(字节)。
    pub proc_rss: u64,
}

/// 资源采样保留多久:30 天。
pub const METRIC_KEEP_MS: i64 = 30 * 86_400_000;

/// `batches` 表:可整体撤销的批次。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Batch {
    /// 主键。
    pub id: String,
    /// 操作者。
    pub actor: String,
    /// 描述。
    pub description: String,
    /// 创建时间。
    pub created_at: Millis,
    /// 撤销时间。
    pub reverted_at: Option<Millis>,
}

/// `changes` 表:批次内的单条变更。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Change {
    /// 所属批次。
    pub batch_id: String,
    /// 批次内序号。
    pub seq: u32,
    /// 目标(记录 id 或表名)。
    pub target: String,
    /// 对应 `before_json` 列。
    pub before_json: Option<String>,
    /// 对应 `after_json` 列。
    pub after_json: String,
}

/// 一张物理表在磁盘上的状况(只读诊断,`index_stats` 与 `kb doctor` 用)。
///
/// 碎片数是「一次检索要开多少文件」的直接来源:同一张表碎片从 1 涨到 1500,
/// 每次查询就多出上千次随机读,延迟和 CPU 都会跟着涨(见检索性能说明 )。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableStats {
    /// 表名(`{collection}__{embedder}__v{n}`)。
    pub table: String,
    /// 行数。
    pub rows: u64,
    /// 碎片数(Lance fragment)。
    pub fragments: u64,
    /// 数据文件数(`.lance` 文件;碎片整理后应远小于碎片数)。
    pub data_files: u64,
    /// 当前版本号。
    pub version: u64,
    /// 磁盘上保留的版本清单数(版本越多,元数据与清理开销越大)。
    pub versions: u64,
    /// 向量索引类型(`ivf_hnsw_sq` 等);没有索引是 `None`。
    pub index_kind: Option<String>,
    /// 索引覆盖的行数。
    pub index_rows: Option<u64>,
    /// 还没进索引的行数(整理索引会把它并入)。
    pub index_unindexed_rows: Option<u64>,
    /// 索引建好的时间(毫秒时间戳)。
    pub index_created_at: Option<i64>,
}

/// `audit` 表:每次能力调用一条。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AuditEntry {
    /// 自增主键;写入时用 `None`。
    pub id: Option<i64>,
    /// 时间。
    pub at: Millis,
    /// 操作者。
    pub actor: String,
    /// 能力名。
    pub capability: String,
    /// 对应 `args_json` 列(已脱敏)。
    pub args_json: String,
    /// 是否成功。
    pub ok: bool,
    /// 错误信息。
    pub error: Option<String>,
    /// 所属批次。
    pub batch_id: Option<String>,
    /// 是否 dry_run。
    pub dry_run: bool,
    /// 这次调用耗时(毫秒)。迁移 0020 之前的旧行是 `None`。
    pub took_ms: Option<u64>,
    /// 降级原因(`embedder_loading` / `rerank_timeout` …);没降级或旧行为 `None`。
    pub degraded: Option<String>,
}

/// 审计查询条件。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct AuditFilter {
    /// 按操作者过滤。
    pub actor: Option<String>,
    /// 按能力名过滤。
    pub capability: Option<String>,
    /// 只看这个时间之后的记录。
    pub since: Option<Millis>,
    /// 只看某个批次。
    pub batch_id: Option<String>,
}

/// 按数据源汇总的解析队列统计(数据源页的「+N 今天 / N 失败 · N 隔离」)。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceIngestStats {
    /// 数据源 id(上传 / 无来源的行是 `None`)。
    pub source_id: Option<String>,
    /// 该源累计入队文件数。
    pub total: u64,
    /// 今天新增的文件数(`created_at` 在今天之内)。
    pub today: u64,
    /// 失败数。
    pub failed: u64,
    /// 隔离数。
    pub quarantined: u64,
    /// 还没处理完的数量(排队 / 抽取 / 分块 / 嵌入)。
    pub pending: u64,
}
