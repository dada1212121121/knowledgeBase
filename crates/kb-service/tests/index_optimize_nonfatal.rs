//! `optimize` 报错不该连累整个索引分片。
//!
//! 索引任务在文件已经入库、`job_files` 已经写完**之后**才整理向量表。整理只是合并碎片,
//! 一旦报错(典型是 Lance 的 `Retryable commit conflict`)就把整片判失败,检查点不落盘、
//! 任务被重做,已经做完的索引工作全部作废。这里用一个只让 `optimize` 返回错误的存储装饰器,
//! 验证两处整理(行数阈值触发、全量任务收尾)失败时任务仍然正常完成,并有「整理正常」的对照。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kb_core::model::{
    ChunkFingerprint, FileEntry, FileSlice, Job, JobState, ListQuery, MetaPatch, Project,
    RecordRow, StoreHit, StoreQuery, TableStats,
};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::{FileRepo, ProjectRepo};
use kb_core::{KbError, Result};
use kb_service::jobs::{IndexCheckpoint, IndexJobHandler, JobQueue, NewJob, Worker};
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tokio::sync::watch;

/// 注入的整理错误文案(模仿线上见过的 Lance 提交冲突),日志断言要用。
const INJECTED: &str = "Retryable commit conflict(测试注入)";

/// 委托给真实存储、只让 `optimize` 可选地返回 `Err` 的装饰器,并统计几个关键调用的次数。
///
/// 所有方法都显式委托(包括有默认实现的 `update_meta_batch`、`list_*`、`table_stats`):
/// 默认实现会绕开 Lance 的真实行为(例如 `list_fingerprints` 默认直接报错),装饰器不该改变其余行为。
struct OptimizeStore {
    inner: Arc<dyn VectorStore>,
    /// 为真时 `optimize` 返回错误(不调用真实的整理)。
    fail_optimize: bool,
    optimizes: Arc<AtomicUsize>,
    fts_indexes: Arc<AtomicUsize>,
}

#[async_trait]
impl VectorStore for OptimizeStore {
    async fn ensure_table(&self, table: &str, dim: usize) -> Result<()> {
        self.inner.ensure_table(table, dim).await
    }
    async fn upsert(&self, table: &str, rows: Vec<RecordRow>) -> Result<()> {
        self.inner.upsert(table, rows).await
    }
    async fn update_meta(&self, table: &str, id: &str, patch: MetaPatch) -> Result<()> {
        self.inner.update_meta(table, id, patch).await
    }
    async fn update_meta_batch(
        &self,
        table: &str,
        updates: Vec<(String, MetaPatch)>,
    ) -> Result<()> {
        self.inner.update_meta_batch(table, updates).await
    }
    async fn delete_ids(&self, table: &str, ids: &[String]) -> Result<()> {
        self.inner.delete_ids(table, ids).await
    }
    async fn get(&self, table: &str, ids: &[String]) -> Result<Vec<RecordRow>> {
        self.inner.get(table, ids).await
    }
    async fn search(&self, table: &str, req: &StoreQuery) -> Result<Vec<StoreHit>> {
        self.inner.search(table, req).await
    }
    async fn list(&self, table: &str, query: &ListQuery) -> Result<Vec<RecordRow>> {
        self.inner.list(table, query).await
    }
    async fn list_slices(&self, table: &str, filter: Option<&str>) -> Result<Vec<FileSlice>> {
        self.inner.list_slices(table, filter).await
    }
    async fn list_fingerprints(
        &self,
        table: &str,
        filter: Option<&str>,
    ) -> Result<Vec<ChunkFingerprint>> {
        self.inner.list_fingerprints(table, filter).await
    }
    async fn list_files(&self, table: &str, filter: Option<&str>) -> Result<Arc<Vec<FileEntry>>> {
        self.inner.list_files(table, filter).await
    }
    async fn count(&self, table: &str, filter: Option<&str>) -> Result<u64> {
        self.inner.count(table, filter).await
    }
    async fn optimize(&self, table: &str) -> Result<()> {
        self.optimizes.fetch_add(1, Ordering::SeqCst);
        if self.fail_optimize {
            return Err(KbError::Internal(INJECTED.to_owned()));
        }
        self.inner.optimize(table).await
    }
    async fn ensure_fts_index(&self, table: &str) -> Result<()> {
        self.fts_indexes.fetch_add(1, Ordering::SeqCst);
        self.inner.ensure_fts_index(table).await
    }
    async fn ensure_vector_index(&self, table: &str) -> Result<()> {
        self.inner.ensure_vector_index(table).await
    }
    async fn drop_table(&self, table: &str) -> Result<()> {
        self.inner.drop_table(table).await
    }
    async fn table_stats(&self) -> Result<Vec<TableStats>> {
        self.inner.table_stats().await
    }
}

/// 一次任务跑完后要检查的全部状态。
struct Outcome {
    /// `run_once` 返回的收尾任务。
    job: Job,
    /// 从任务里解出的最终检查点。
    checkpoint: IndexCheckpoint,
    /// `files` 表里已登记的路径(排好序)。
    indexed_paths: Vec<String>,
    /// 向量库里的行数。
    store_rows: u64,
    /// 项目的 `last_indexed_at`。
    last_indexed_at: Option<i64>,
    /// `optimize` 被调用的次数(含失败的)。
    optimizes: usize,
    /// `ensure_fts_index` 被调用的次数。
    fts_indexes: usize,
}

/// 项目目录里的文件数。每个文件是一个只有一个块的小 Rust 函数,所以「块数 = 文件数」。
const FILES: usize = 6;

/// 跑一个索引任务。`incremental` 为真时走「增量 + 指定路径」(保存文件 / git hook 的路径),
/// 否则走全量;`optimize_after_rows` 是行数阈值;`fail_optimize` 让 `optimize` 报错。
/// 每片只处理一个文件,让阈值检查在每个文件之后都会发生。
async fn run_job(incremental: bool, optimize_after_rows: u64, fail_optimize: bool) -> Outcome {
    let env = TestEnv::new().await;
    let dir = tempfile::tempdir().expect("项目目录");
    let mut paths = Vec::new();
    for index in 0..FILES {
        let relative = format!("src/f{index}.rs");
        let path = dir.path().join(&relative);
        std::fs::create_dir_all(path.parent().expect("父目录")).expect("建目录");
        std::fs::write(&path, format!("fn f{index}() -> u32 {{\n    {index}\n}}\n"))
            .expect("写文件");
        paths.push(relative);
    }
    let project = Project {
        id: "p1".to_owned(),
        name: "demo".to_owned(),
        slug: "demo".to_owned(),
        root_path: dir.path().to_string_lossy().into_owned(),
        include: Vec::new(),
        exclude: Vec::new(),
        is_git: false,
        last_commit: None,
        last_indexed_at: None,
        allow_cloud_llm: false,
        extract_enabled: false,
        hooks_installed: false,
        created_at: 1_700_000_000_000,
    };
    ProjectRepo::create(env.meta.as_ref(), project)
        .await
        .expect("项目行");
    let collection =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
            .create_for_project("p1", "demo")
            .await
            .expect("collection");

    let optimizes = Arc::new(AtomicUsize::new(0));
    let fts_indexes = Arc::new(AtomicUsize::new(0));
    let store: Arc<dyn VectorStore> = Arc::new(OptimizeStore {
        inner: env.store.clone(),
        fail_optimize,
        optimizes: optimizes.clone(),
        fts_indexes: fts_indexes.clone(),
    });
    let service = Arc::new(IndexService::new(
        env.meta.clone(),
        store,
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions {
            optimize_after_rows,
            ..IndexOptions::default()
        },
    ));
    let queue = Arc::new(JobQueue::new(env.meta.clone()));
    let new_job = if incremental {
        NewJob::incremental_index("p1", &collection.name, &paths)
    } else {
        NewJob::full_index("p1", &collection.name)
    };
    queue.enqueue(new_job).await.expect("入队");
    let handler = Arc::new(IndexJobHandler::new(service, env.meta.clone(), 1));
    let worker = Worker::new(queue.clone(), handler, watch::channel(false).1);
    let job = worker
        .run_once()
        .await
        .expect("worker 执行")
        .expect("应当取到并跑完这个任务");

    let checkpoint: IndexCheckpoint =
        serde_json::from_str(job.checkpoint_json.as_deref().expect("任务应带检查点"))
            .expect("检查点是合法 JSON");
    let mut indexed_paths = FileRepo::list_paths(env.meta.as_ref(), &collection.name)
        .await
        .expect("列出已索引路径");
    indexed_paths.sort();
    let store_rows = env
        .store
        .count(&collection.active_table, None)
        .await
        .expect("向量库行数");
    let last_indexed_at = ProjectRepo::get(env.meta.as_ref(), "p1")
        .await
        .expect("读项目")
        .expect("项目存在")
        .last_indexed_at;
    Outcome {
        job,
        checkpoint,
        indexed_paths,
        store_rows,
        last_indexed_at,
        optimizes: optimizes.load(Ordering::SeqCst),
        fts_indexes: fts_indexes.load(Ordering::SeqCst),
    }
}

/// 任务正常完成的共同断言:状态 `done`、没有错误、六个文件都入库(元数据与向量库两边)。
fn assert_finished_cleanly(outcome: &Outcome) {
    let job = &outcome.job;
    assert_eq!(job.state, JobState::Done, "任务应正常完成:{job:?}");
    assert_eq!(job.error, None, "整理失败不该出现在任务错误里:{job:?}");
    assert_eq!(outcome.checkpoint.errors, 0, "没有失败文件");
    assert!(outcome.checkpoint.error_samples.is_empty());
    let expected: Vec<String> = (0..FILES).map(|index| format!("src/f{index}.rs")).collect();
    assert_eq!(outcome.indexed_paths, expected, "六个文件都应已入库");
    // 每个文件一个块:嵌入数、向量库行数都应等于文件数(也证明下面按块数的断言成立)
    assert_eq!(outcome.checkpoint.embedded, FILES);
    assert_eq!(outcome.store_rows, FILES as u64);
    assert_eq!(job.progress_done, FILES as u64);
}

// ---------------------------------------------------------------------------------------------
// 行数阈值触发的整理(增量任务)
// ---------------------------------------------------------------------------------------------

/// 对照:整理正常时,阈值每满 2 块整理一次并清零计数(行为不变)。
#[tokio::test]
async fn control_incremental_with_healthy_optimize_resets_the_counter() {
    let outcome = run_job(true, 2, false).await;
    assert_finished_cleanly(&outcome);
    // 六个单块文件、每 2 块一次:第 2、4、6 个文件之后整理;增量任务收尾不再整理
    assert_eq!(outcome.optimizes, 3, "整理正常时每满阈值整理一次");
    assert_eq!(
        outcome.checkpoint.rows_since_optimize, 0,
        "整理成功后计数清零"
    );
}

/// 阈值整理每次都失败:任务照常 `done`,文件入库,没有错误;
/// 计数**不清零**,所以之后每一片都会再试一次(第 2 到第 6 片共 5 次)。
#[tokio::test]
async fn incremental_job_survives_threshold_optimize_failure() {
    let outcome = run_job(true, 2, true).await;
    assert_finished_cleanly(&outcome);
    assert_eq!(
        outcome.checkpoint.rows_since_optimize, outcome.checkpoint.embedded,
        "整理失败时 rows_since_optimize 不能清零,否则下一片不会再试"
    );
    assert_eq!(
        outcome.optimizes, 5,
        "计数没清零,第 2 到第 6 个文件之后都应再试一次整理"
    );
    // 增量任务没有「全量收尾」那次整理,也不建索引以外的东西:last_indexed_at 照常更新
    assert!(outcome.last_indexed_at.is_some(), "last_indexed_at 应更新");
    assert!(outcome.fts_indexes >= 1, "收尾仍应建全文索引");
}

// ---------------------------------------------------------------------------------------------
// 全量任务收尾的整理
// ---------------------------------------------------------------------------------------------

/// 对照:整理正常时,全量任务结束整理一次,然后建索引并更新 `last_indexed_at`。
#[tokio::test]
async fn control_full_with_healthy_optimize_finishes_normally() {
    let outcome = run_job(false, 2000, false).await;
    assert_finished_cleanly(&outcome);
    assert_eq!(outcome.optimizes, 1, "阈值没到,只有收尾那一次整理");
    assert!(outcome.fts_indexes >= 1);
    assert!(outcome.last_indexed_at.is_some());
}

/// 收尾整理失败:全量任务仍然 `done`,继续建索引并更新 `last_indexed_at`。
#[tokio::test]
async fn full_job_survives_tail_optimize_failure() {
    let outcome = run_job(false, 2000, true).await;
    assert_finished_cleanly(&outcome);
    assert_eq!(outcome.optimizes, 1, "只有收尾那一次整理(并且失败了)");
    assert!(outcome.fts_indexes >= 1, "收尾整理失败后仍要继续建全文索引");
    assert!(
        outcome.last_indexed_at.is_some(),
        "收尾整理失败后仍要更新 last_indexed_at"
    );
}

/// 阈值整理与收尾整理都失败:全量任务仍然正常完成。
#[tokio::test]
async fn full_job_survives_threshold_and_tail_optimize_failure() {
    let outcome = run_job(false, 2, true).await;
    assert_finished_cleanly(&outcome);
    assert_eq!(
        outcome.checkpoint.rows_since_optimize, outcome.checkpoint.embedded,
        "阈值整理失败不清零"
    );
    // 第 2 到第 6 个文件之后各试一次,加上收尾一次
    assert_eq!(outcome.optimizes, 6);
    assert!(outcome.fts_indexes >= 1);
    assert!(outcome.last_indexed_at.is_some());
}

// ---------------------------------------------------------------------------------------------
// 日志:失败要有 warn
// ---------------------------------------------------------------------------------------------

/// 把 tracing 事件收进内存的最小订阅者(只用 `tracing` 本身,不给 `kb-service` 加 dev-dependency)。
/// 只收 `index_handler` 模块的事件,免得 Lance 等依赖的调试日志淹没断言。
#[derive(Clone, Default)]
struct Capture {
    events: Arc<Mutex<Vec<(tracing::Level, String)>>>,
}

struct Fields(String);

impl tracing::field::Visit for Fields {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0.insert_str(0, &format!("{value:?}"));
        } else {
            self.0.push_str(&format!(" {}={value:?}", field.name()));
        }
    }
}

impl tracing::Subscriber for Capture {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        metadata.target().contains("index_handler")
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut fields = Fields(String::new());
        event.record(&mut fields);
        self.events
            .lock()
            .expect("日志锁")
            .push((*event.metadata().level(), fields.0));
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

/// 两处整理失败都要各记一条 warn,带 collection 与错误原文。
#[tokio::test]
async fn optimize_failures_are_logged_as_warnings() {
    // 预热:tracing 的回调点第一次执行时才登记并缓存「有没有订阅者感兴趣」;同进程里别的用例
    // 并行跑同样的代码,登记恰好和下面的 set_default 撞上的话会漏掉本线程的订阅者。
    // 先不带订阅者跑一遍同样的场景,让两处 warn 的回调点都登记好。
    run_job(false, 2, true).await;

    let capture = Capture::default();
    let guard = tracing::subscriber::set_default(capture.clone());
    let outcome = run_job(false, 2, true).await;
    drop(guard);
    assert_finished_cleanly(&outcome);

    let events = capture.events.lock().expect("日志锁").clone();
    let warns: Vec<&String> = events
        .iter()
        .filter(|(level, _)| *level == tracing::Level::WARN)
        .map(|(_, text)| text)
        .collect();
    let threshold = warns
        .iter()
        .filter(|text| text.contains("按行数阈值整理向量表失败"))
        .count();
    let tail = warns
        .iter()
        .filter(|text| text.contains("全量索引收尾整理向量表失败"))
        .count();
    assert_eq!(
        threshold, 5,
        "阈值整理失败了 5 次,每次一条 warn:{events:#?}"
    );
    assert_eq!(tail, 1, "收尾整理失败一次,一条 warn:{events:#?}");
    for text in &warns {
        assert!(text.contains("collection="), "warn 要带 collection:{text}");
        assert!(text.contains(INJECTED), "warn 要带错误原文:{text}");
    }
}
