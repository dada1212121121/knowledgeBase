//! VectorStore 的 LanceDB 实现（设计规范）。
//!
//! - 物理表名由调用方按 `{collection}__{embedder_slug}__v{n}` 生成,通过
//!   `collections.active_table` 解析;**禁止调用 `rename_table`**(开源版不支持)。
//! - 全文索引建在 `lex` 列,分词器固定为 `jieba/default`。
//! - 传给 `only_if` / `delete` 的条件只来自 `kb_core::Filter::to_sql`,
//!   或由通过白名单校验的 id 列表生成。

mod convert;
mod fingerprint;
mod query;
mod schema;

pub use convert::{batch_to_rows, decode_tags, encode_tags, rows_to_batch};
pub use schema::{
    COL_LEX, COL_VECTOR, SCORE_DISTANCE, SCORE_FTS, SCORE_RELEVANCE, non_vector_columns,
    record_schema,
};

use arrow_array::RecordBatchIterator;
use async_trait::async_trait;
use futures::TryStreamExt;
use kb_core::model::{ListQuery, MetaPatch, RecordRow, StoreHit, StoreQuery};
use kb_core::ports::VectorStore;
use kb_core::{KbError, Result};
use lancedb::DistanceType;
use lancedb::index::scalar::FtsIndexBuilder;
use lancedb::index::vector::IvfHnswSqIndexBuilder;
use lancedb::index::{Index, IndexType};
use lancedb::query::{ExecutableQuery, QueryBase, Select};
use lancedb::table::NewColumnTransform;
use lancedb::table::{CompactionOptions, OptimizeAction, OptimizeOptions};

use crate::schema::{COL_ANCHOR, COL_EMBED_STATE, COL_ID, PENDING_FILTER};

/// 压缩时「够大、不必再合并」的片段行数下限。
///
/// Lance 默认把 100 万行以下的片段都当成「可以和邻居合并」,一张 2.9 万行的表里,
/// 每次追加一个小片段,主片段(整张表)就会被连同它一起重写一遍(实测一个下午写了 9 GB)。
/// 目标行数改成表总行数的 1/8(夹在下限和 Lance 默认值之间):主片段已经够大就原样留着,
/// 只把后来追加的小片段互相并起来。
const MIN_COMPACTION_TARGET_ROWS: usize = 1_000;
/// 压缩目标行数的上限,与 Lance 的默认值一致。
const MAX_COMPACTION_TARGET_ROWS: usize = 1024 * 1024;

/// 按表的总行数算压缩的目标片段行数。
fn compaction_target_rows(total_rows: usize) -> usize {
    (total_rows / 8).clamp(MIN_COMPACTION_TARGET_ROWS, MAX_COMPACTION_TARGET_ROWS)
}

/// 同一张物理表的 `optimize` 互斥锁,整个进程共用一份。
///
/// 定时整理和索引任务结束时的整理可能同时落到同一张表,两个 Rewrite 事务会互相抢占,
/// 日志里就是 `Retryable commit conflict ... preempted by concurrent transaction Rewrite`,
/// 输的一方白做一遍重写。键是「库路径 + 表名」,不同知识库的同名表互不影响。
fn optimize_lock(uri: &str, table: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    type Locks =
        std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>>;
    static LOCKS: std::sync::OnceLock<Locks> = std::sync::OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    locks
        .entry(format!("{uri}\u{0}{table}"))
        .or_default()
        .clone()
}

/// 压缩遇到提交冲突时的退避间隔:最多重试 2 次(第一次等 200 ms,第二次等 800 ms)。
///
/// 冲突来自压缩与写入并发(索引任务正在提交);写入通常几百毫秒内就结束,
/// 退避一下再压一次大概率成功,比让这一整轮整理白跑便宜得多。
const COMPACT_BACKOFF: [std::time::Duration; 2] = [
    std::time::Duration::from_millis(200),
    std::time::Duration::from_millis(800),
];

/// 写入(upsert / 删除 / 改元数据)遇到提交冲突时的退避:最多重试 4 次。
///
/// 一个知识库的后台会同时跑好几个分片(`index.parallel_slices`),多张文件同时在提交。
/// 碰撞是正常的、短暂的;而写入失败就意味着这个文件被判 `failed`、用户要手动重跑,
/// 所以比压缩(整理重跑一次无所谓)多给几次、退避也更短。
const WRITE_BACKOFF: [std::time::Duration; 4] = [
    std::time::Duration::from_millis(100),
    std::time::Duration::from_millis(300),
    std::time::Duration::from_millis(800),
    std::time::Duration::from_millis(2000),
];

/// 向量索引分段(delta)数的上限:`optimize` 并入新行之后分段数(含最老的底座)超过它,就把分段合并。
///
/// 为什么需要上限:Lance 13 的 `OptimizeOptions::default` 在「并入索引」时**新建**一个 delta 分段,
/// IVF_HNSW_SQ 的 delta 不会自己合并,所以持续写入的表每整理一次就多一个分段
/// (2026-11 体检时两张热表九天积到 159 / 74 个,各有 171 / 79 个碎片)。
/// 检索要逐个分段查 HNSW 图再合并结果:在 4.7 万行的生产表拷贝上,同一批 200 条自检索查询(预热后),
/// 1~2 个分段 p50 9~11 ms,81 个 24 ms,138~159 个 59 ms,折合每个分段约 0.2~0.3 ms。
///
/// 为什么是 8:8 个分段只多出 2 ms 上下的查询开销,可以忽略;而合并只重写增量分段里的行,
/// 攒到 8 个再合并,摊到每次 optimize 的代价很小(见 `consolidate_index_segments` 的实测)。
/// 分段数在合并后回落到 2,再攒 7 次整理又会触发下一次合并,所以任何时刻整理完都不超过它。
pub const MAX_VECTOR_INDEX_SEGMENTS: usize = 8;

/// `optimize` 的步骤。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OptimizeStep {
    /// 压缩小片段。
    Compact,
    /// 把没进索引的行并进索引。
    Index,
    /// 清理旧版本。
    Prune,
    /// 向量索引分段太多时合并分段,并在合并后再压缩一次。
    MergeIndex,
}

impl OptimizeStep {
    /// 写进错误信息的步骤名。
    fn label(self) -> &'static str {
        match self {
            Self::Compact => "压缩小片段",
            Self::Index => "并入索引",
            Self::Prune => "清理旧版本",
            Self::MergeIndex => "合并索引分段",
        }
    }
}

/// 某一步的失败。
#[derive(Debug)]
struct StepFailure {
    step: OptimizeStep,
    error: KbError,
}

/// 这个错误是不是 Lance 的提交冲突(别的事务抢先提交了)。
///
/// 本 crate 的错误都被 [`lance_error`] 压成了字符串,只能按文字判断;
/// 文字来自 lance-core 的 `Commit conflict for version` / `Retryable commit conflict for version`
/// 与 `Too many concurrent writers`。
fn is_commit_conflict(error: &KbError) -> bool {
    let text = error.to_string().to_lowercase();
    text.contains("commit conflict") || text.contains("too many concurrent writers")
}

/// 执行 `op`,遇到提交冲突就按 `backoff` 逐次等待后重试(`backoff` 有几项就最多重试几次)。
///
/// 其它错误不重试,直接返回。压缩与合并索引分段都是「读一个版本、重写、提交」的重活,
/// 提交时若有写入抢先落盘就会冲突;重试时 `op` 要自己重新打开表(拿最新版本),
/// 否则沿用旧句柄只会看到同一批冲突。
async fn retry_on_conflict<F, Fut>(mut op: F, backoff: &[std::time::Duration]) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let mut retries = 0usize;
    loop {
        match op().await {
            Err(error) if is_commit_conflict(&error) && retries < backoff.len() => {
                tokio::time::sleep(backoff[retries]).await;
                retries += 1;
            }
            other => return other,
        }
    }
}

/// 按顺序执行 optimize 的三步,**一步失败不影响后面的步骤**,返回所有失败(按步骤顺序)。
///
/// 以前三步各自 `?`:压缩遇到提交冲突就整体返回,后面的「并入索引」「清理旧版本」都被跳过,
/// 新写入的行继续靠暴力扫描,旧版本也不清;持续有写入的表上这会反复发生。
///
/// 压缩遇到提交冲突时按 `backoff` 逐次等待后重试(`backoff` 有几项就最多重试几次),
/// 其它错误、其它两步不重试。抽成接收闭包的函数,是为了单元测试不必真的制造 Lance 冲突。
async fn run_optimize_steps<C, CF, I, IF, P, PF>(
    mut compact: C,
    mut index: I,
    mut prune: P,
    backoff: &[std::time::Duration],
) -> Vec<StepFailure>
where
    C: FnMut() -> CF,
    CF: std::future::Future<Output = Result<()>>,
    I: FnMut() -> IF,
    IF: std::future::Future<Output = Result<()>>,
    P: FnMut() -> PF,
    PF: std::future::Future<Output = Result<()>>,
{
    let mut failures = Vec::new();
    let compacted = retry_on_conflict(&mut compact, backoff).await;
    if let Err(error) = compacted {
        failures.push(StepFailure {
            step: OptimizeStep::Compact,
            error,
        });
    }
    if let Err(error) = index().await {
        failures.push(StepFailure {
            step: OptimizeStep::Index,
            error,
        });
    }
    if let Err(error) = prune().await {
        failures.push(StepFailure {
            step: OptimizeStep::Prune,
            error,
        });
    }
    failures
}

/// 向量索引分段太多时合并分段,合并成功后再压缩一次;返回是否做了合并。
///
/// 为什么要合并、为什么合并之后要再压缩一次(引擎检查):
/// 1. 「并入索引」每次新建一个 delta 分段,分段不会自己合并,只增不减;
/// 2. 压缩只合并「被同一组索引覆盖」的相邻碎片(lance 的 `indices_containing_frag`,
///    注释 *We cannot mix indexed and non-indexed fragments*)。每个小碎片各被自己的分段覆盖,
///    彼此都不是邻居候选,永远合不到一起。
///
/// 所以分段数 `segments` 超过 `max_segments` 才动手:保留最老的一段(底座,建索引时训练出来的那一大段,
/// 通常装着绝大部分行),把其余分段合成一个。底座不动,合并的代价只取决于后来增量的行数,
/// 不随整张表变大,压缩时要重映射的索引也小得多。在 11.3 万行的生产表拷贝(4 个分段)上实测:
/// 合并全部 18.9 s,随后压缩 4.0 s、峰值 1.4 GB;保留底座只合并其余的 0.1 s,随后压缩 2.3 s、峰值 0.44 GB。
/// 合并后那些小碎片被同一个分段覆盖,紧接着压缩一次它们才合得起来。
/// 没超过上限(以及表上没有向量索引)什么都不做,行为与以前完全一致。
///
/// 合并与再压缩遇到提交冲突时同样按 `backoff` 重试。合并失败就不再压缩(压缩要的是合并后的结果)。
/// 抽成接收闭包的函数,是为了单元测试不必真的造 Lance 表。
async fn consolidate_index_segments<S, SF, M, MF, C, CF>(
    mut segments: S,
    mut merge: M,
    mut compact: C,
    max_segments: usize,
    backoff: &[std::time::Duration],
) -> Result<bool>
where
    S: FnMut() -> SF,
    SF: std::future::Future<Output = Result<Option<usize>>>,
    M: FnMut(usize) -> MF,
    MF: std::future::Future<Output = Result<()>>,
    C: FnMut() -> CF,
    CF: std::future::Future<Output = Result<()>>,
{
    let Some(count) = segments().await? else {
        return Ok(false);
    };
    // 至少留一段不动,所以上限最小按 1 算,count - 1 不会是 0
    if count <= max_segments.max(1) {
        return Ok(false);
    }
    retry_on_conflict(|| merge(count - 1), backoff).await?;
    retry_on_conflict(&mut compact, backoff).await?;
    Ok(true)
}

/// 把各步失败折成 `optimize` 的返回值:没有失败是 `Ok`,否则返回**第一个**失败的错误。
///
/// 仍然返回错误(而不是吞掉),调度器才不会把这个版本记成「已整理」,下一拍还会再试。
/// 本 crate 不依赖 tracing,所以哪一步失败、其余还有哪些步骤也失败,都写进返回的错误信息里,
/// 由调用方已有的告警日志带出去。
fn optimize_result(failures: Vec<StepFailure>) -> Result<()> {
    let mut failures = failures.into_iter();
    let Some(first) = failures.next() else {
        return Ok(());
    };
    let others: Vec<String> = failures
        .map(|failure| format!("{}:{}", failure.step.label(), error_text(&failure.error)))
        .collect();
    let mut message = format!(
        "optimize 的「{}」步骤失败: {}",
        first.step.label(),
        error_text(&first.error)
    );
    if !others.is_empty() {
        message.push_str(&format!(";另有步骤也失败({})", others.join(";")));
    }
    Err(KbError::Internal(message))
}

/// 错误的正文(`Internal` 去掉 `internal: ` 前缀,避免套娃)。
fn error_text(error: &KbError) -> String {
    match error {
        KbError::Internal(text) => text.clone(),
        other => other.to_string(),
    }
}

/// 单次 `delete` 最多删除的行数（设计规范）。
pub const DELETE_BATCH_SIZE: usize = 500;

/// 默认的索引缓存上限(字节)。
pub const DEFAULT_INDEX_CACHE_BYTES: usize = 512 * 1024 * 1024;
/// 默认的元数据缓存上限(字节)。
pub const DEFAULT_METADATA_CACHE_BYTES: usize = 128 * 1024 * 1024;

static SESSION: std::sync::OnceLock<std::sync::Arc<lance::session::Session>> =
    std::sync::OnceLock::new();

/// 设置共享缓存的容量。**必须在第一次连接之前调用**(守护进程启动时);之后调用无效,返回 `false`。
pub fn configure_cache(index_bytes: usize, metadata_bytes: usize) -> bool {
    SESSION
        .set(std::sync::Arc::new(lance::session::Session::new(
            index_bytes,
            metadata_bytes,
            Default::default(),
        )))
        .is_ok()
}

/// 进程里唯一的 Session;没人配置过就用默认的小上限。
fn shared_session() -> std::sync::Arc<lance::session::Session> {
    SESSION
        .get_or_init(|| {
            std::sync::Arc::new(lance::session::Session::new(
                DEFAULT_INDEX_CACHE_BYTES,
                DEFAULT_METADATA_CACHE_BYTES,
                Default::default(),
            ))
        })
        .clone()
}

/// 基于 LanceDB 的向量 + 全文存储。
#[derive(Clone)]
pub struct LanceStore {
    /// 库路径,给 [`optimize_lock`] 当键用。
    uri: String,
    db: lancedb::Connection,
    files: std::sync::Arc<std::sync::Mutex<FileCache>>,
    /// 旧版本保留多久,`optimize` 时清掉更早的。
    retention: lancedb::table::Duration,
}

/// 旧版本默认保留 1 小时。
///
/// Lance 每次写入都出一个新版本、一批新数据文件,被替换掉的旧文件要等版本被清理才释放。
/// 默认的清理期限是 7 天:知识库反复保存、重建索引时,磁盘上会攒下几十到上百份历史副本
/// (实测一个 2.9 万块的集合占了 15 GB,向量本身只有 112 MB)。读取方拿着的是打开那一刻的版本,
/// 1 小时远比任何一次查询长;这里不开 `delete_unverified`,不会碰还没提交的事务写下的文件。
const DEFAULT_RETENTION_SECS: i64 = 3600;

/// 文件级列表的缓存:按 (表, 过滤条件) 存归并好的结果,表版本变了就作废。
///
/// 浏览器每翻一页、每切一次筛选、每次展开树都要这份列表;一个十几万块的集合,
/// 每次都从头扫一遍要几百毫秒。写入(索引、保存、改标签)都会让表版本前进,所以不会读到旧数据。
/// 归并后的条目数只有块数的几十分之一,64 份缓存占的内存很小。
#[derive(Default)]
struct FileCache {
    entries: std::collections::HashMap<FileCacheKey, (u64, SharedFiles)>,
    /// 插入顺序,超过上限时淘汰最早的。
    order: std::collections::VecDeque<FileCacheKey>,
}

/// 缓存的钥匙:(物理表名, 过滤条件)。
type FileCacheKey = (String, String);
/// 归并好的文件列表,各处共享同一份。
type SharedFiles = std::sync::Arc<Vec<kb_core::model::FileEntry>>;

const FILE_CACHE_ENTRIES: usize = 64;

impl FileCache {
    fn get(
        &self,
        key: &(String, String),
        version: u64,
    ) -> Option<std::sync::Arc<Vec<kb_core::model::FileEntry>>> {
        self.entries
            .get(key)
            .filter(|(cached, _)| *cached == version)
            .map(|(_, files)| files.clone())
    }

    fn put(
        &mut self,
        key: (String, String),
        version: u64,
        files: std::sync::Arc<Vec<kb_core::model::FileEntry>>,
    ) {
        if self.entries.insert(key.clone(), (version, files)).is_none() {
            self.order.push_back(key);
        }
        while self.order.len() > FILE_CACHE_ENTRIES {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }
}

impl std::fmt::Debug for LanceStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LanceStore").finish_non_exhaustive()
    }
}

impl LanceStore {
    /// 连接一个本地 LanceDB 目录。
    ///
    /// 所有连接共用**同一个** Lance `Session`(缓存带容量上限,见 [`configure_cache`])。
    /// 默认每个连接自己建一个 Session,缓存上限是 6 GiB 索引 + 1 GiB 元数据:多用户下每个知识库一个连接,
    /// 几十个知识库一用起来就是几十个这样的上限,实测 4 个用户一上传内存就涨到 3 GB。
    pub async fn connect(uri: impl AsRef<str>) -> Result<Self> {
        let db = lancedb::connect(uri.as_ref())
            .session(shared_session())
            .execute()
            .await
            .map_err(lance_error)?;
        Ok(Self {
            uri: uri.as_ref().to_owned(),
            db,
            files: Default::default(),
            retention: lancedb::table::Duration::seconds(DEFAULT_RETENTION_SECS),
        })
    }

    /// 改旧版本的保留时间(秒)。测试里设成 0,让一次 `optimize` 就清到只剩最新版本。
    pub fn with_retention_secs(mut self, secs: i64) -> Self {
        self.retention = lancedb::table::Duration::seconds(secs.max(0));
        self
    }

    /// 底层连接(迁移 / 运维工具用)。
    pub fn connection(&self) -> &lancedb::Connection {
        &self.db
    }

    /// 列出全部物理表。
    pub async fn table_names(&self) -> Result<Vec<String>> {
        self.db.table_names().execute().await.map_err(lance_error)
    }

    async fn open(&self, table: &str) -> Result<lancedb::Table> {
        self.db
            .open_table(table.to_owned())
            .execute()
            .await
            .map_err(|err| match err {
                lancedb::Error::TableNotFound { name, .. } => {
                    KbError::NotFound(format!("表 {name}"))
                }
                other => lance_error(other),
            })
    }

    async fn exists(&self, table: &str) -> Result<bool> {
        Ok(self.table_names().await?.iter().any(|name| name == table))
    }

    /// 压缩小片段:目标行数按表的总行数算(见 [`compaction_target_rows`])。
    ///
    /// 每次都重新打开表拿最新版本(见 `optimize` 的说明)。
    async fn compact_table(&self, table: &str) -> Result<()> {
        let handle = self.open(table).await?;
        let total_rows = handle.count_rows(None).await.map_err(lance_error)?;
        handle
            .optimize(OptimizeAction::Compact {
                options: CompactionOptions {
                    target_rows_per_fragment: compaction_target_rows(total_rows),
                    ..CompactionOptions::default()
                },
                remap_options: None,
            })
            .await
            .map_err(lance_error)?;
        Ok(())
    }

    /// 向量索引的名字;表上没有向量索引时是 `None`。
    async fn vector_index_name(handle: &lancedb::Table) -> Result<Option<String>> {
        Ok(handle
            .list_indices()
            .await
            .map_err(lance_error)?
            .into_iter()
            .find(|index| {
                matches!(
                    index.index_type,
                    IndexType::IvfHnswSq | IndexType::IvfHnswPq | IndexType::IvfHnswFlat
                )
            })
            .map(|index| index.name))
    }

    /// 向量索引现在有几个分段(delta);没有向量索引(行数还不够建)时是 `None`。
    async fn vector_index_segments(&self, table: &str) -> Result<Option<usize>> {
        let handle = self.open(table).await?;
        let Some(name) = Self::vector_index_name(&handle).await? else {
            return Ok(None);
        };
        let stats = handle.index_stats(&name).await.map_err(lance_error)?;
        Ok(stats
            .and_then(|stats| stats.num_indices)
            .map(|count| count as usize))
    }

    /// 把向量索引最新的 `count` 个分段(连同还没进索引的行)合成一个。
    ///
    /// 只指定向量索引的名字:全文索引不会有这个问题(它始终只有一个分段),
    /// 带上它只会白白把整个全文索引重写一遍。不重训练(`retrain`):那会改聚类中心,
    /// 而且更慢更占内存(11.3 万行 25 s / 1.5 GB,合并同样的分段 19 s / 0.5 GB)。
    async fn merge_vector_index_segments(&self, table: &str, count: usize) -> Result<()> {
        let handle = self.open(table).await?;
        let Some(name) = Self::vector_index_name(&handle).await? else {
            return Ok(());
        };
        handle
            .optimize(OptimizeAction::Index(
                OptimizeOptions::merge(count).index_names(vec![name]),
            ))
            .await
            .map_err(lance_error)?;
        Ok(())
    }

    /// 一张表的物理状况(只读):不建索引、不 optimize、不拿写锁。
    ///
    /// 碎片数是「一次检索要开多少文件」的直接来源——线上 32 k 行的表涨到 1 500 个碎片时,
    /// 单次查询要多开一千多个文件,延迟与 CPU 一起涨(检索性能说明 的证据)。
    pub async fn table_stat(&self, table: &str) -> Result<kb_core::model::TableStats> {
        let handle = self.open(table).await?;
        // 同一份 dataset 句柄既算行数也数碎片,避免开两次
        let dataset = handle
            .dataset()
            .ok_or_else(|| KbError::Internal(format!("表 {table} 不是本地 Lance 表")))?
            .get()
            .await
            .map_err(lance_error)?;
        let rows = dataset.count_rows(None).await.map_err(lance_error)? as u64;
        let fragments = dataset.get_fragments();
        let data_files = fragments
            .iter()
            .map(|fragment| fragment.metadata().files.len() as u64)
            .sum();
        // `_versions` 里的清单个数:版本越多,元数据与每次 commit 的开销越大
        let versions = std::fs::read_dir(std::path::Path::new(dataset.uri()).join("_versions"))
            .map(|dir| dir.flatten().count() as u64)
            .unwrap_or(0);
        // 索引覆盖:向量索引优先(全文索引建了也不算「向量检索走索引」)
        let mut index_kind = None;
        let mut index_rows = None;
        let mut index_unindexed_rows = None;
        let mut index_created_at = None;
        for index in handle.list_indices().await.map_err(lance_error)? {
            if !matches!(
                index.index_type,
                IndexType::IvfHnswSq | IndexType::IvfHnswPq | IndexType::IvfHnswFlat
            ) {
                continue;
            }
            index_kind = Some(index.index_type.to_string());
            index_rows = index.num_indexed_rows;
            index_unindexed_rows = index.num_unindexed_rows;
            index_created_at = index.created_at.map(|at| at.timestamp_millis());
        }
        Ok(kb_core::model::TableStats {
            table: table.to_owned(),
            rows,
            fragments: fragments.len() as u64,
            data_files,
            version: dataset.version().version,
            versions,
            index_kind,
            index_rows,
            index_unindexed_rows,
            index_created_at,
        })
    }

    /// 批量改元数据:**一次提交**写完同一形状的一批补丁。
    ///
    /// 逐行 `update_meta` 每行一个 commit、一个碎片——线上 32 k 行的表散成 588 个碎片,
    /// 主源就是编辑文件后行号位移导致的成百上千次单行元数据更新(检索性能说明 )。
    ///
    /// 实现走 `merge_insert` 的**部分列** upsert:源批次只带 `id` + 补丁涉及的列,
    /// 其余列由存储层从命中行补齐;行不存在时保持原样(元数据补丁只改已存在的块)。
    /// 落盘按批走:同形状的补丁合成一个 Arrow 批次、一次提交。实测一批不新增碎片
    /// (逐行写则一行一个碎片——线上 32 k 行的表因此散成 588 个)。
    pub async fn update_meta_batch(
        &self,
        table: &str,
        updates: &[(String, MetaPatch)],
    ) -> Result<usize> {
        if updates.is_empty() {
            return Ok(0);
        }
        for (id, _) in updates {
            validate_id(id)?;
        }
        // 按「补丁涉及哪些列」分组:不同形状不能塞进同一批(缺的列会被写成空值)
        let mut groups: std::collections::BTreeMap<Vec<&'static str>, Vec<(String, MetaPatch)>> =
            std::collections::BTreeMap::new();
        for (id, patch) in updates {
            groups
                .entry(convert::patch_shapes(patch))
                .or_default()
                .push((id.clone(), patch.clone()));
        }
        let handle = self.open(table).await?;
        let schema = handle.schema().await.map_err(lance_error)?;
        let mut commits = 0usize;
        for (columns, group) in groups {
            // 元数据补丁不涉及任何列(空补丁):不值得为它开一次提交
            if columns.is_empty() {
                continue;
            }
            let batch = convert::patches_to_batch(&group, &columns, &schema)?;
            let batch_schema = batch.schema();
            let reader: Box<dyn arrow_array::RecordBatchReader + Send> =
                Box::new(RecordBatchIterator::new(vec![Ok(batch)], batch_schema));
            let mut merge = handle.merge_insert(&[COL_ID]);
            // 只改命中行:补丁永远不会新增块
            merge.when_matched_update_all(None);
            merge.execute(reader).await.map_err(lance_error)?;
            commits += 1;
        }
        Ok(commits)
    }
}

impl LanceStore {
    /// 一次 `merge_insert`。失败重试时由 [`LanceStore::upsert`] 重新调用(每次都重开表)。
    async fn upsert_once(&self, table: &str, rows: &[RecordRow]) -> Result<()> {
        let mut handle = self.open(table).await?;
        let mut schema = handle.schema().await.map_err(lance_error)?;
        // 升级后的旧表可能还没有 `anchor` / `embed_state`:守护进程启动时会 heal_tables,
        // 但嵌入式 `kb index` 直接连库,不能指望它已经跑过。这里按需补列后再组装批次,
        // 否则一次增量写入就会在旧库上直接失败(生产升级路径必须自愈)。
        if [COL_ANCHOR, COL_EMBED_STATE]
            .iter()
            .any(|name| schema.field_with_name(name).is_err())
        {
            let dim = match schema
                .field_with_name(COL_VECTOR)
                .map(|field| field.data_type())
            {
                Ok(arrow_schema::DataType::FixedSizeList(_, dim)) => usize::try_from(*dim)
                    .map_err(|_| KbError::Internal(format!("表 {table} 的向量维度非法: {dim}")))?,
                Ok(_) => {
                    return Err(KbError::Internal(format!(
                        "表 {table} 的 vector 列不是 FixedSizeList"
                    )));
                }
                Err(_) => {
                    return Err(KbError::Internal(format!(
                        "表 {table} 的 schema 缺少 vector 列"
                    )));
                }
            };
            drop(handle);
            self.ensure_table(table, dim).await?;
            handle = self.open(table).await?;
            schema = handle.schema().await.map_err(lance_error)?;
        }
        let batch = rows_to_batch(rows, schema.clone())?;
        let reader: Box<dyn arrow_array::RecordBatchReader + Send> =
            Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema));
        let mut merge = handle.merge_insert(&["id"]);
        merge
            .when_matched_update_all(None)
            .when_not_matched_insert_all();
        merge.execute(reader).await.map_err(lance_error)?;
        Ok(())
    }

    /// 一次单行 `update`;冲突重试时由 [`LanceStore::update_meta`] 重新调用。
    async fn update_meta_once(&self, table: &str, id: &str, patch: &MetaPatch) -> Result<()> {
        let handle = self.open(table).await?;
        let mut update = handle.update().only_if(format!("id = {}", sql_literal(id)));
        let mut columns = 0usize;
        if let Some(value) = patch.start_line {
            update = update.column(schema::COL_START_LINE, value.to_string());
            columns += 1;
        }
        if let Some(value) = patch.end_line {
            update = update.column(schema::COL_END_LINE, value.to_string());
            columns += 1;
        }
        if let Some(value) = &patch.title {
            update = update.column(schema::COL_TITLE, sql_literal(value));
            columns += 1;
        }
        if let Some(value) = &patch.symbol {
            update = update.column(schema::COL_SYMBOL, sql_literal(value));
            columns += 1;
        }
        if let Some(value) = &patch.tags {
            update = update.column(schema::COL_TAGS, sql_literal(&encode_tags(value)));
            columns += 1;
        }
        if let Some(value) = patch.status {
            update = update.column(schema::COL_STATUS, sql_literal(value.as_str()));
            columns += 1;
        }
        if let Some(value) = &patch.meta_hash {
            update = update.column(schema::COL_META_HASH, sql_literal(value));
            columns += 1;
        }
        if let Some(value) = &patch.source {
            update = update.column(schema::COL_SOURCE, sql_literal(value));
            columns += 1;
        }
        if let Some(value) = &patch.header {
            update = update.column(schema::COL_HEADER, sql_literal(value));
            columns += 1;
        }
        if let Some(value) = &patch.lex {
            update = update.column(schema::COL_LEX, sql_literal(value));
            columns += 1;
        }
        if let Some(value) = &patch.embed_input_hash {
            update = update.column(schema::COL_EMBED_INPUT_HASH, sql_literal(value));
            columns += 1;
        }
        if let Some(value) = patch.updated_at {
            update = update.column(schema::COL_UPDATED_AT, value.to_string());
            columns += 1;
        }
        if columns == 0 {
            return Ok(());
        }
        update.execute().await.map_err(lance_error)?;
        Ok(())
    }

    /// 一次删除(可多批);冲突重试时由 [`LanceStore::delete_ids`] 重新调用。
    async fn delete_ids_once(&self, table: &str, ids: &[String]) -> Result<()> {
        let handle = self.open(table).await?;
        for chunk in ids.chunks(DELETE_BATCH_SIZE) {
            let list = chunk
                .iter()
                .map(|id| sql_literal(id))
                .collect::<Vec<_>>()
                .join(", ");
            let predicate = format!("id IN ({list})");
            handle
                .delete(predicate.as_str())
                .await
                .map_err(lance_error)?;
        }
        Ok(())
    }
}

#[async_trait]
impl VectorStore for LanceStore {
    async fn ensure_table(&self, table: &str, dim: usize) -> Result<()> {
        if self.exists(table).await? {
            let handle = self.open(table).await?;
            let existing = handle.schema().await.map_err(lance_error)?;
            let existing_dim = match existing.field_with_name(COL_VECTOR).map(|f| f.data_type()) {
                Ok(arrow_schema::DataType::FixedSizeList(_, dim)) => *dim,
                _ => {
                    return Err(KbError::Internal(format!(
                        "表 {table} 的 schema 缺少 vector 列"
                    )));
                }
            };
            if existing_dim != i32::try_from(dim).unwrap_or(i32::MAX) {
                return Err(KbError::InvalidInput(format!(
                    "表 {table} 的向量维度是 {existing_dim},与要求的 {dim} 不一致"
                )));
            }
            // 旧表补新列:两列都可空,老行补成全 NULL。
            // `anchor` 是 当前阶段 加的;`embed_state` 是文本优先索引加的,
            // NULL 按 ready 处理,升级前的行不会因为缺标记从检索结果里消失。
            let mut missing = Vec::new();
            for name in [COL_ANCHOR, COL_EMBED_STATE] {
                if existing.field_with_name(name).is_err() {
                    missing.push(arrow_schema::Field::new(
                        name,
                        arrow_schema::DataType::Utf8,
                        true,
                    ));
                }
            }
            if !missing.is_empty() {
                let new_schema = arrow_schema::Schema::new(missing);
                handle
                    .add_columns()
                    .transform(NewColumnTransform::AllNulls(std::sync::Arc::new(
                        new_schema,
                    )))
                    .execute()
                    .await
                    .map_err(lance_error)?;
            }
            return Ok(());
        }
        let schema = record_schema(dim)?;
        self.db
            .create_empty_table(table.to_owned(), schema)
            .execute()
            .await
            .map_err(lance_error)?;
        Ok(())
    }

    async fn upsert(&self, table: &str, rows: Vec<RecordRow>) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        // 并发分片会同时往同一张表提交;冲突时重开表、拿最新版本再写一次
        retry_on_conflict(|| self.upsert_once(table, &rows), &WRITE_BACKOFF).await
    }

    async fn update_meta(&self, table: &str, id: &str, patch: MetaPatch) -> Result<()> {
        validate_id(id)?;
        // 并发写入时 update 也会撞提交冲突:重开表再改一次(patch 是幂等的)
        retry_on_conflict(|| self.update_meta_once(table, id, &patch), &WRITE_BACKOFF).await
    }

    async fn update_meta_batch(
        &self,
        table: &str,
        updates: Vec<(String, MetaPatch)>,
    ) -> Result<()> {
        // 走固有实现(一批一次提交);不覆盖的话 trait 的默认实现会让这里退回逐行写
        LanceStore::update_meta_batch(self, table, &updates).await?;
        Ok(())
    }

    async fn delete_ids(&self, table: &str, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        for id in ids {
            validate_id(id)?;
        }
        // 删除也是提交:并发的 merge / 其它分片的删除会整批重来一次(按 id 删是幂等的)
        retry_on_conflict(|| self.delete_ids_once(table, ids), &WRITE_BACKOFF).await
    }

    async fn get(&self, table: &str, ids: &[String]) -> Result<Vec<RecordRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        for id in ids {
            validate_id(id)?;
        }
        let handle = self.open(table).await?;
        let list = ids
            .iter()
            .map(|id| sql_literal(id))
            .collect::<Vec<_>>()
            .join(", ");
        // 老表可能还没有 `anchor` / `embed_state`:按实际 schema 取列,避免升级前
        // 读条目 / 文件预览直接报“列不存在”。缺的列由 `batch_to_rows` 按缺省值处理。
        let schema = handle.schema().await.map_err(lance_error)?;
        let columns: Vec<&str> = non_vector_columns()
            .iter()
            .copied()
            .filter(|name| schema.field_with_name(name).is_ok())
            .collect();
        let batches = handle
            .query()
            .only_if(format!("id IN ({list})"))
            .select(Select::columns(&columns))
            .limit(ids.len())
            .execute()
            .await
            .map_err(lance_error)?
            .try_collect::<Vec<_>>()
            .await
            .map_err(lance_error)?;
        let mut rows = Vec::new();
        for batch in &batches {
            rows.extend(batch_to_rows(batch, false)?);
        }
        Ok(rows)
    }

    async fn search(&self, table: &str, req: &StoreQuery) -> Result<Vec<StoreHit>> {
        let handle = self.open(table).await?;
        // 向量 / 混合检索只能看已经补好向量的行;文本阶段写入的 pending 行由
        // `search_pending` 单独取出来,在服务层合并。纯全文检索不过滤,
        // 否则文本阶段写完却搜不到,文本优先就失去了意义。
        //
        // 升级前的旧表还没有 `embed_state` 列:这时不能把 READY_FILTER 拼进 SQL,
        // 否则嵌入式 `kb search` 在第一次写入之前就会因为“列不存在”直接报错。
        // 旧表里的行都带向量,等价于全部 ready。
        let has_state = handle
            .schema()
            .await
            .map_err(lance_error)?
            .field_with_name(COL_EMBED_STATE)
            .is_ok();
        let extra = if has_state {
            query::state_filter(req.mode)
        } else {
            None
        };
        let batches = query::run_query(&handle, req, extra).await?;
        query::to_hits(&batches, req)
    }

    async fn search_pending(&self, table: &str, req: &StoreQuery) -> Result<Vec<StoreHit>> {
        let handle = self.open(table).await?;
        // 升级前的旧表没有 `embed_state`，不可能有 pending 行；直接返回空，
        // 避免把 PENDING_FILTER 拼进 SQL 后报“列不存在”。补向量路径会先 ensure_table。
        let schema = handle.schema().await.map_err(lance_error)?;
        if schema.field_with_name(COL_EMBED_STATE).is_err() {
            return Ok(Vec::new());
        }
        // 只走全文:这些行没有向量,nearest_to 的结果没有意义。
        let mut pending = req.clone();
        pending.mode = kb_core::model::SearchMode::Fts;
        pending.vector = None;
        pending.with_vector = false;
        // 只取 pending 行:普通 FTS 会把 ready 行也带回来,那不是「待补向量」的结果。
        let batches = query::run_query(&handle, &pending, Some(PENDING_FILTER)).await?;
        query::to_hits(&batches, &pending)
    }

    async fn get_pending(&self, table: &str, ids: &[String]) -> Result<Vec<RecordRow>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        // id 来自队列,仍然按白名单校验后用 SQL 字面量拼,避免把异常 id 带进过滤表达式。
        for id in ids {
            validate_id(id)?;
        }
        let list = ids
            .iter()
            .map(|id| sql_literal(id))
            .collect::<Vec<_>>()
            .join(", ");
        let handle = self.open(table).await?;
        // 同 search_pending：旧表没有 `embed_state` 时没有 pending 行。
        let schema = handle.schema().await.map_err(lance_error)?;
        if schema.field_with_name(COL_EMBED_STATE).is_err() {
            return Ok(Vec::new());
        }
        let batches =
            query::run_pending(&handle, Some(format!("id IN ({list})")), ids.len()).await?;
        let mut rows = Vec::new();
        for batch in &batches {
            rows.extend(convert::batch_to_rows(batch, false)?);
        }
        Ok(rows)
    }

    async fn list(&self, table: &str, query: &ListQuery) -> Result<Vec<RecordRow>> {
        let handle = self.open(table).await?;
        let batches = query::run_list(&handle, query).await?;
        let mut rows = Vec::new();
        for batch in &batches {
            rows.extend(batch_to_rows(batch, false)?);
        }
        Ok(rows)
    }

    async fn list_slices(
        &self,
        table: &str,
        filter: Option<&str>,
    ) -> Result<Vec<kb_core::model::FileSlice>> {
        let handle = self.open(table).await?;
        let batches = query::run_slices(&handle, filter).await?;
        let mut out = Vec::new();
        for batch in &batches {
            out.extend(convert::batch_to_slices(batch)?);
        }
        Ok(out)
    }

    async fn list_fingerprints(
        &self,
        table: &str,
        filter: Option<&str>,
    ) -> Result<Vec<kb_core::model::ChunkFingerprint>> {
        let handle = self.open(table).await?;
        // 旧表没有 embed_state 列:按 schema 决定读不读,不能让一致性检查在升级前就报错
        let include_state = handle
            .schema()
            .await
            .map(|schema| {
                schema
                    .field_with_name(crate::schema::COL_EMBED_STATE)
                    .is_ok()
            })
            .unwrap_or(false);
        fingerprint::run_fingerprints(&handle, filter, include_state).await
    }

    async fn list_files(
        &self,
        table: &str,
        filter: Option<&str>,
    ) -> Result<std::sync::Arc<Vec<kb_core::model::FileEntry>>> {
        let handle = self.open(table).await?;
        // 新打开的句柄就是最新版本;用这个版本号当缓存的钥匙,扫描也在同一个句柄上做,版本和内容对得上
        let version = handle.version().await.map_err(lance_error)?;
        let key = (table.to_owned(), filter.unwrap_or_default().to_owned());
        if let Ok(cache) = self.files.lock()
            && let Some(hit) = cache.get(&key, version)
        {
            return Ok(hit);
        }
        let batches = query::run_slices(&handle, filter).await?;
        let mut slices = Vec::new();
        for batch in &batches {
            slices.extend(convert::batch_to_slices(batch)?);
        }
        let files = std::sync::Arc::new(kb_core::model::group_by_file(slices));
        if let Ok(mut cache) = self.files.lock() {
            cache.put(key, version, files.clone());
        }
        Ok(files)
    }

    async fn count(&self, table: &str, filter: Option<&str>) -> Result<u64> {
        let handle = self.open(table).await?;
        let rows = handle
            .count_rows(filter.map(str::to_owned))
            .await
            .map_err(lance_error)?;
        Ok(rows as u64)
    }

    async fn optimize(&self, table: &str) -> Result<()> {
        // 同一张表一次只整理一个(见 optimize_lock)
        let lock = optimize_lock(&self.uri, table);
        let _guard = lock.lock().await;
        // 表不存在等"打不开"的错误没有后续步骤可做,直接返回
        self.open(table).await?;
        // 不用 OptimizeAction::All:它的压缩目标是写死的 100 万行,会反复重写整张表。
        // 拆成独立的几步:按表规模压缩小片段 → 把没进索引的行并进索引 → 按我们自己的期限清旧版本,
        // 最后 → 向量索引分段超过上限时合并分段并再压缩一次(见 [`consolidate_index_segments`])。
        // 前三步见 [`run_optimize_steps`];每一步都重新打开表句柄:默认的读一致性是
        // 「打开那一刻的版本」,压缩撞上提交冲突后沿用旧句柄重试,看到的还是同一批冲突。
        let mut failures = run_optimize_steps(
            move || async move { self.compact_table(table).await },
            move || async move {
                self.open(table)
                    .await?
                    .optimize(OptimizeAction::Index(OptimizeOptions::default()))
                    .await
                    .map_err(lance_error)?;
                Ok(())
            },
            move || async move {
                self.open(table)
                    .await?
                    .optimize(OptimizeAction::Prune {
                        older_than: Some(self.retention),
                        delete_unverified: None,
                        error_if_tagged_old_versions: None,
                    })
                    .await
                    .map_err(lance_error)?;
                Ok(())
            },
            &COMPACT_BACKOFF,
        )
        .await;
        // 合并分段放在清理旧版本之后:合并和再压缩产出的新版本本来就在保留期内,
        // 提前清理也清不掉它们,换来的是前三步的行为一点都不变。
        // 被合并掉的旧分段文件由下一次 optimize 的清理步骤(保留期过后)回收。
        if let Err(error) = consolidate_index_segments(
            move || async move { self.vector_index_segments(table).await },
            move |count| async move { self.merge_vector_index_segments(table, count).await },
            move || async move { self.compact_table(table).await },
            MAX_VECTOR_INDEX_SEGMENTS,
            &COMPACT_BACKOFF,
        )
        .await
        {
            failures.push(StepFailure {
                step: OptimizeStep::MergeIndex,
                error,
            });
        }
        optimize_result(failures)
    }

    async fn ensure_fts_index(&self, table: &str) -> Result<()> {
        // 并发分片会给同一张表同时建索引:输的一方拿到的是
        // `This CreateIndex transaction was preempted by concurrent transaction Rewrite`。
        // 每一轮都重开表、重读索引清单:别的分片已经建好了就不再建。
        retry_on_conflict(
            || async {
                let handle = self.open(table).await?;
                let indices = handle.list_indices().await.map_err(lance_error)?;
                if indices
                    .iter()
                    .any(|index| index.index_type == IndexType::FTS)
                {
                    return Ok(());
                }
                let builder = FtsIndexBuilder::default()
                    .base_tokenizer("jieba/default".to_owned())
                    .stem(false)
                    .remove_stop_words(false);
                handle
                    .create_index(&[COL_LEX], Index::FTS(builder))
                    .execute()
                    .await
                    .map(|_| ())
                    .map_err(lance_error)
            },
            &WRITE_BACKOFF,
        )
        .await
    }

    async fn ensure_vector_index(&self, table: &str) -> Result<()> {
        // 同上:并发建索引会撞 `Retryable commit conflict`
        retry_on_conflict(
            || async {
                let handle = self.open(table).await?;
                let indices = handle.list_indices().await.map_err(lance_error)?;
                if indices.iter().any(|index| {
                    matches!(
                        index.index_type,
                        IndexType::IvfHnswSq | IndexType::IvfHnswPq | IndexType::IvfHnswFlat
                    )
                }) {
                    return Ok(());
                }
                let builder = IvfHnswSqIndexBuilder::default().distance_type(DistanceType::Cosine);
                handle
                    .create_index(&[COL_VECTOR], Index::IvfHnswSq(builder))
                    .execute()
                    .await
                    .map(|_| ())
                    .map_err(lance_error)
            },
            &WRITE_BACKOFF,
        )
        .await
    }

    async fn drop_table(&self, table: &str) -> Result<()> {
        self.db
            .drop_table(table.to_owned(), &[])
            .await
            .map_err(lance_error)
    }

    async fn table_stats(&self) -> Result<Vec<kb_core::model::TableStats>> {
        let mut out = Vec::new();
        for table in self.table_names().await? {
            // 单张表坏掉不该让整个诊断失败:跳过它,让调用方看到其余表
            // (本 crate 不依赖 tracing,失败的表由调用方对比表清单发现)
            if let Ok(stats) = self.table_stat(&table).await {
                out.push(stats);
            }
        }
        Ok(out)
    }
}

/// id 白名单:与 `Filter::to_sql` 的 ids 规则一致。
fn validate_id(id: &str) -> Result<()> {
    let valid = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|ch| ch.is_ascii_digit() || matches!(ch, 'a'..='f') || ch == '-');
    if valid {
        Ok(())
    } else {
        Err(KbError::InvalidInput(format!(
            "非法 id {id:?}:只允许 [0-9a-f-],长度 1..=64"
        )))
    }
}

/// SQL 字符串字面量(单引号转义)。
fn sql_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn lance_error(err: impl std::fmt::Display) -> KbError {
    KbError::Internal(format!("lancedb: {err}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_validated_against_the_whitelist() {
        for good in ["abc123", "3f9c0a1e7b2d4c58a6e1f0b9d2c7a413", "a-b"] {
            validate_id(good).unwrap_or_else(|err| panic!("{good} 应该合法: {err}"));
        }
        for bad in [
            "",
            "ABC",
            "a'b",
            "a b",
            "x'; DROP TABLE x; --",
            &"a".repeat(65),
        ] {
            assert!(validate_id(bad).is_err(), "{bad:?} 应该被拒绝");
        }
    }

    #[test]
    fn sql_literals_escape_single_quotes() {
        assert_eq!(sql_literal("plain"), "'plain'");
        assert_eq!(sql_literal("it's"), "'it''s'");
        assert_eq!(sql_literal(""), "''");
        // 双引号不是 SQL 字符串定界符,原样保留
        assert_eq!(sql_literal("a\"b"), "'a\"b'");
    }

    // ---- optimize 三步容错 ----

    use std::cell::RefCell;
    use std::time::Duration;

    /// 测试里不真的等:退避间隔全部为 0。
    const NO_WAIT: [Duration; 2] = [Duration::ZERO, Duration::ZERO];

    fn conflict() -> KbError {
        lance_error(
            "Retryable commit conflict for version 7: This Rewrite transaction was preempted",
        )
    }

    /// 记录每一步被调用的次数与先后。
    #[derive(Default)]
    struct Trace {
        calls: RefCell<Vec<&'static str>>,
    }

    impl Trace {
        fn count(&self, name: &str) -> usize {
            self.calls.borrow().iter().filter(|c| **c == name).count()
        }
    }

    #[tokio::test]
    async fn steps_run_in_order_and_all_ok_means_no_failure() {
        let trace = Trace::default();
        let failures = run_optimize_steps(
            || {
                trace.calls.borrow_mut().push("compact");
                async { Ok(()) }
            },
            || {
                trace.calls.borrow_mut().push("index");
                async { Ok(()) }
            },
            || {
                trace.calls.borrow_mut().push("prune");
                async { Ok(()) }
            },
            &NO_WAIT,
        )
        .await;
        assert!(failures.is_empty());
        assert_eq!(*trace.calls.borrow(), ["compact", "index", "prune"]);
        assert!(optimize_result(failures).is_ok());
    }

    #[tokio::test]
    async fn later_steps_still_run_after_a_failed_compaction() {
        // 以前压缩一失败就 `?` 返回,并入索引和清旧版本都被跳过
        let trace = Trace::default();
        let failures = run_optimize_steps(
            || {
                trace.calls.borrow_mut().push("compact");
                async { Err(KbError::Internal("压缩炸了".to_owned())) }
            },
            || {
                trace.calls.borrow_mut().push("index");
                async { Ok(()) }
            },
            || {
                trace.calls.borrow_mut().push("prune");
                async { Ok(()) }
            },
            &NO_WAIT,
        )
        .await;
        assert_eq!(trace.count("index"), 1, "压缩失败后仍要并入索引");
        assert_eq!(trace.count("prune"), 1, "压缩失败后仍要清旧版本");
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].step, OptimizeStep::Compact);
    }

    #[tokio::test]
    async fn a_failed_middle_step_does_not_block_the_last_one() {
        let trace = Trace::default();
        let failures = run_optimize_steps(
            || async { Ok(()) },
            || async { Err(KbError::Internal("索引炸了".to_owned())) },
            || {
                trace.calls.borrow_mut().push("prune");
                async { Ok(()) }
            },
            &NO_WAIT,
        )
        .await;
        assert_eq!(trace.count("prune"), 1);
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].step, OptimizeStep::Index);
    }

    #[tokio::test]
    async fn the_first_error_is_returned_and_every_failed_step_is_named() {
        let failures = run_optimize_steps(
            || async { Err(KbError::Internal("第一个错误".to_owned())) },
            || async { Err(KbError::Internal("第二个错误".to_owned())) },
            || async { Err(KbError::Internal("第三个错误".to_owned())) },
            &NO_WAIT,
        )
        .await;
        assert_eq!(failures.len(), 3);
        let message = optimize_result(failures)
            .expect_err("有步骤失败必须返回错误,调度器才不会记成已整理")
            .to_string();
        // 开头是第一个失败的步骤与它的错误
        assert!(
            message.contains("「压缩小片段」步骤失败: 第一个错误"),
            "{message}"
        );
        // 其余失败的步骤也写明白,不然只有第一个错误会进日志
        assert!(message.contains("并入索引:第二个错误"), "{message}");
        assert!(message.contains("清理旧版本:第三个错误"), "{message}");
    }

    #[tokio::test]
    async fn a_later_failure_is_returned_when_earlier_steps_succeed() {
        let failures = run_optimize_steps(
            || async { Ok(()) },
            || async { Ok(()) },
            || async { Err(KbError::Internal("清理炸了".to_owned())) },
            &NO_WAIT,
        )
        .await;
        let message = optimize_result(failures)
            .expect_err("应返回错误")
            .to_string();
        assert!(
            message.contains("「清理旧版本」步骤失败: 清理炸了"),
            "{message}"
        );
        assert!(!message.contains("另有步骤"), "只有一步失败: {message}");
    }

    #[tokio::test]
    async fn compaction_retries_a_commit_conflict_twice_then_gives_up() {
        let trace = Trace::default();
        let failures = run_optimize_steps(
            || {
                trace.calls.borrow_mut().push("compact");
                async { Err(conflict()) }
            },
            || {
                trace.calls.borrow_mut().push("index");
                async { Ok(()) }
            },
            || {
                trace.calls.borrow_mut().push("prune");
                async { Ok(()) }
            },
            &NO_WAIT,
        )
        .await;
        assert_eq!(trace.count("compact"), 3, "第一次 + 重试 2 次");
        assert_eq!(failures.len(), 1, "重试用尽才算失败");
        assert_eq!(trace.count("index"), 1);
        assert_eq!(trace.count("prune"), 1);
    }

    #[tokio::test]
    async fn compaction_stops_retrying_once_it_succeeds() {
        let trace = Trace::default();
        let failures = run_optimize_steps(
            || {
                let attempt = {
                    trace.calls.borrow_mut().push("compact");
                    trace.count("compact")
                };
                async move { if attempt < 2 { Err(conflict()) } else { Ok(()) } }
            },
            || async { Ok(()) },
            || async { Ok(()) },
            &NO_WAIT,
        )
        .await;
        assert_eq!(trace.count("compact"), 2, "第二次成功就不再重试");
        assert!(failures.is_empty());
    }

    #[tokio::test]
    async fn other_compaction_errors_and_other_steps_are_not_retried() {
        let trace = Trace::default();
        let failures = run_optimize_steps(
            || {
                trace.calls.borrow_mut().push("compact");
                async { Err(KbError::Internal("磁盘满了".to_owned())) }
            },
            || {
                trace.calls.borrow_mut().push("index");
                async { Err(conflict()) }
            },
            || {
                trace.calls.borrow_mut().push("prune");
                async { Err(conflict()) }
            },
            &NO_WAIT,
        )
        .await;
        assert_eq!(trace.count("compact"), 1, "不是提交冲突就不重试");
        assert_eq!(trace.count("index"), 1, "只有压缩重试");
        assert_eq!(trace.count("prune"), 1, "只有压缩重试");
        assert_eq!(failures.len(), 3);
    }

    #[tokio::test]
    async fn compaction_backs_off_between_retries() {
        // 退避真的会等:两次重试之间至少隔开配置的时间
        let started = std::time::Instant::now();
        let waits = [Duration::from_millis(30), Duration::from_millis(60)];
        let failures = run_optimize_steps(
            || async { Err(conflict()) },
            || async { Ok(()) },
            || async { Ok(()) },
            &waits,
        )
        .await;
        assert_eq!(failures.len(), 1);
        assert!(started.elapsed() >= Duration::from_millis(90));
    }

    // ---- 向量索引分段合并 ----

    /// 跑一次 `consolidate_index_segments`,返回(结果, 合并时收到的 count 列表, 压缩次数, 调用先后)。
    ///
    /// `merge_results` / `compact_results` 按调用顺序依次给出每次调用的结果,用完后一律成功。
    async fn consolidate(
        segments: Result<Option<usize>>,
        max_segments: usize,
        merge_results: Vec<Result<()>>,
        compact_results: Vec<Result<()>>,
    ) -> (Result<bool>, Vec<usize>, usize, Vec<&'static str>) {
        let merges = RefCell::new(Vec::new());
        let compacts = RefCell::new(0usize);
        let order = RefCell::new(Vec::new());
        let segments = RefCell::new(Some(segments));
        let merge_results = RefCell::new(merge_results.into_iter());
        let compact_results = RefCell::new(compact_results.into_iter());
        let result = consolidate_index_segments(
            || {
                let value = segments.borrow_mut().take().expect("只数一次");
                async move { value }
            },
            |count| {
                merges.borrow_mut().push(count);
                order.borrow_mut().push("merge");
                let next = merge_results.borrow_mut().next().unwrap_or(Ok(()));
                async move { next }
            },
            || {
                *compacts.borrow_mut() += 1;
                order.borrow_mut().push("compact");
                let next = compact_results.borrow_mut().next().unwrap_or(Ok(()));
                async move { next }
            },
            max_segments,
            &NO_WAIT,
        )
        .await;
        (
            result,
            merges.into_inner(),
            compacts.into_inner(),
            order.into_inner(),
        )
    }

    #[tokio::test]
    async fn segments_within_the_limit_are_left_alone() {
        // 恰好等于上限也不动:只有「超过」才合并
        for count in [1, 2, 8] {
            let (result, merges, compacts, _) =
                consolidate(Ok(Some(count)), 8, vec![], vec![]).await;
            assert!(!result.expect("不合并也不出错"), "{count} 个分段不该合并");
            assert!(merges.is_empty(), "{count} 个分段不该调用合并");
            assert_eq!(compacts, 0, "没合并就不该多压缩一次");
        }
    }

    #[tokio::test]
    async fn a_table_without_a_vector_index_is_left_alone() {
        let (result, merges, compacts, _) = consolidate(Ok(None), 8, vec![], vec![]).await;
        assert!(!result.expect("没有向量索引不是错误"));
        assert!(merges.is_empty());
        assert_eq!(compacts, 0);
    }

    #[tokio::test]
    async fn too_many_segments_merge_all_but_the_oldest_then_compact_again() {
        let (result, merges, compacts, order) = consolidate(Ok(Some(9)), 8, vec![], vec![]).await;
        assert!(result.expect("合并成功"));
        // 保留最老的一段(底座):9 个分段合并最新的 8 个
        assert_eq!(merges, [8]);
        assert_eq!(compacts, 1);
        // 先合并,再压缩:顺序反了压缩还是合不动
        assert_eq!(order, ["merge", "compact"]);
    }

    #[tokio::test]
    async fn a_huge_backlog_is_merged_in_one_pass() {
        // 生产上积了 159 个分段:一次合并最新的 158 个,只留底座
        let (result, merges, _, _) = consolidate(Ok(Some(159)), 8, vec![], vec![]).await;
        assert!(result.expect("合并成功"));
        assert_eq!(merges, [158]);
    }

    #[tokio::test]
    async fn at_least_one_segment_is_always_kept() {
        // 上限配成 0 也不会让「合并 0 个」或下溢
        let (result, merges, _, _) = consolidate(Ok(Some(2)), 0, vec![], vec![]).await;
        assert!(result.expect("合并成功"));
        assert_eq!(merges, [1]);
        let (result, merges, _, _) = consolidate(Ok(Some(1)), 0, vec![], vec![]).await;
        assert!(!result.expect("只有一个分段不动"));
        assert!(merges.is_empty());
    }

    #[tokio::test]
    async fn merge_and_recompaction_retry_commit_conflicts() {
        let (result, merges, compacts, order) = consolidate(
            Ok(Some(12)),
            8,
            vec![Err(conflict()), Err(conflict())],
            vec![Err(conflict())],
        )
        .await;
        assert!(result.expect("重试之后成功"));
        assert_eq!(merges, [11, 11, 11], "合并冲突两次后第三次成功");
        assert_eq!(compacts, 2, "再压缩冲突一次后第二次成功");
        assert_eq!(
            order,
            ["merge", "merge", "merge", "compact", "compact"],
            "合并成功之前不压缩"
        );
    }

    #[tokio::test]
    async fn a_failed_merge_skips_the_recompaction_and_reports_the_error() {
        // 非冲突错误不重试;合并没成功,压缩也没有意义
        let (result, merges, compacts, _) = consolidate(
            Ok(Some(9)),
            8,
            vec![Err(KbError::Internal("磁盘满了".to_owned()))],
            vec![],
        )
        .await;
        let error = result.expect_err("合并失败必须报出来").to_string();
        assert!(error.contains("磁盘满了"), "{error}");
        assert_eq!(merges.len(), 1, "非冲突错误不重试");
        assert_eq!(compacts, 0);
    }

    #[tokio::test]
    async fn a_merge_conflict_gives_up_after_the_backoff_is_used_up() {
        let (result, merges, compacts, _) = consolidate(
            Ok(Some(9)),
            8,
            vec![Err(conflict()), Err(conflict()), Err(conflict())],
            vec![],
        )
        .await;
        assert!(is_commit_conflict(&result.expect_err("三次都冲突")));
        assert_eq!(merges.len(), 3, "首次 + 两次重试");
        assert_eq!(compacts, 0);
    }

    #[tokio::test]
    async fn a_failed_recompaction_is_reported_after_a_successful_merge() {
        let (result, merges, compacts, _) = consolidate(
            Ok(Some(9)),
            8,
            vec![],
            vec![Err(KbError::Internal("压缩炸了".to_owned()))],
        )
        .await;
        let error = result.expect_err("再压缩失败必须报出来").to_string();
        assert!(error.contains("压缩炸了"), "{error}");
        assert_eq!(merges, [8], "合并已经做完了");
        assert_eq!(compacts, 1);
    }

    #[tokio::test]
    async fn a_failure_to_count_segments_is_reported_without_merging() {
        let (result, merges, compacts, _) = consolidate(
            Err(KbError::Internal("读不了统计".to_owned())),
            8,
            vec![],
            vec![],
        )
        .await;
        assert!(result.is_err());
        assert!(merges.is_empty());
        assert_eq!(compacts, 0);
    }

    #[test]
    fn a_failed_segment_merge_is_named_in_the_error() {
        let message = optimize_result(vec![StepFailure {
            step: OptimizeStep::MergeIndex,
            error: KbError::Internal("合并炸了".to_owned()),
        }])
        .expect_err("有步骤失败必须返回错误")
        .to_string();
        assert!(
            message.contains("「合并索引分段」步骤失败: 合并炸了"),
            "{message}"
        );
    }

    #[test]
    fn production_backoff_is_200ms_then_800ms() {
        assert_eq!(
            COMPACT_BACKOFF,
            [Duration::from_millis(200), Duration::from_millis(800)]
        );
    }

    #[test]
    fn lance_commit_conflicts_are_recognized_by_their_text() {
        assert!(is_commit_conflict(&lance_error(
            "Retryable commit conflict for version 12: x, /rustc/a.rs:1:1"
        )));
        assert!(is_commit_conflict(&lance_error(
            "Commit conflict for version 12: x"
        )));
        assert!(is_commit_conflict(&lance_error(
            "Too many concurrent writers. x"
        )));
        assert!(!is_commit_conflict(&lance_error("No space left on device")));
        assert!(!is_commit_conflict(&KbError::NotFound("表 x".to_owned())));
    }
}
