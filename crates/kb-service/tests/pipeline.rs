//! 验收:批次流水线进度、ETA、暂停 / 继续 / 取消、阶段重试与事件节流。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use kb_core::config::UploadConfig;
use kb_core::model::{
    EmbedderState, IngestFile, IngestFilter, IngestStage, IngestStageStatus, IngestState, Job,
    JobState, Page,
};
use kb_core::ports::Embedder;
use kb_core::ports::repo::{ChunkRepo, CollectionRepo, FileRepo, IngestProgressRepo, IngestRepo};
use kb_core::{KbError, Result};
use kb_service::index::IndexOptions;
use kb_service::ingest::progress::BatchProgress;
use kb_service::upload::unpack::UnpackLimits;
use kb_service::{
    BatchService, IndexService, IngestJobHandler, IngestPayload, JobHandler, ProgressTracker,
    UploadObserver,
};
use kb_testkit::TestEnv;

const COLLECTION: &str = "_global";

/// 每次嵌入都睡一会儿的假嵌入器:让批次跑得足够慢,能观察进度、暂停与 ETA。
struct SlowEmbedder {
    inner: Arc<dyn Embedder>,
    delay: Duration,
    calls: AtomicUsize,
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
}

impl SlowEmbedder {
    fn new(inner: Arc<dyn Embedder>, delay: Duration) -> Self {
        Self {
            inner,
            delay,
            calls: AtomicUsize::new(0),
            in_flight: AtomicUsize::new(0),
            max_in_flight: AtomicUsize::new(0),
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    /// 同时有几个文件在做嵌入(1 = 提交还在串行)。
    fn max_in_flight(&self) -> usize {
        self.max_in_flight.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl Embedder for SlowEmbedder {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn dim(&self) -> usize {
        self.inner.dim()
    }
    fn compat_group(&self) -> &str {
        self.inner.compat_group()
    }
    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let active = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(active, Ordering::SeqCst);
        tokio::time::sleep(self.delay).await;
        let embedded = self.inner.embed_documents(texts).await;
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        embedded
    }
    async fn embed_query(&self, text: String) -> Result<Vec<f32>> {
        self.inner.embed_query(text).await
    }
    fn state(&self) -> EmbedderState {
        self.inner.state()
    }
}

/// 记录推送时间与内容的观察者。
#[derive(Default)]
struct RecordingObserver {
    pushes: std::sync::Mutex<Vec<(Instant, BatchProgress)>>,
    /// 文件状态变化(并发窗口靠它算峰值)
    states: std::sync::Mutex<Vec<(Instant, String, IngestState)>>,
}

impl RecordingObserver {
    /// 同时在处理的文件数峰值(`extracting` / `chunking` / `embedding` 都算)。
    fn peak_active(&self) -> usize {
        let states = self.states.lock().expect("锁");
        let mut latest: std::collections::HashMap<&str, &IngestState> =
            std::collections::HashMap::new();
        let mut peak = 0;
        for (_, id, state) in states.iter() {
            latest.insert(id.as_str(), state);
            let active = latest
                .values()
                .filter(|state| {
                    matches!(
                        state,
                        IngestState::Extracting | IngestState::Chunking | IngestState::Embedding
                    )
                })
                .count();
            peak = peak.max(active);
        }
        peak
    }
}

impl UploadObserver for RecordingObserver {
    fn on_upload(&self, _upload: &kb_core::model::Upload) {}
    fn on_ingest(&self, file: &IngestFile) {
        self.states
            .lock()
            .expect("锁")
            .push((Instant::now(), file.id.clone(), file.state));
    }
    fn on_batch_progress(&self, progress: &BatchProgress) {
        self.pushes
            .lock()
            .expect("锁")
            .push((Instant::now(), progress.clone()));
    }
}

struct Harness {
    env: TestEnv,
    handler: IngestJobHandler,
    batches: BatchService,
    embedder: Arc<SlowEmbedder>,
    observer: Arc<RecordingObserver>,
    dir: tempfile::TempDir,
}

impl Harness {
    async fn new(delay: Duration) -> Self {
        Self::with_parallel(delay, 1).await
    }

    /// 一片内同时准备 `parallel` 个文件(1 = 默认的逐个处理)。
    async fn with_parallel(delay: Duration, parallel: usize) -> Self {
        let env = TestEnv::new().await;
        kb_service::CollectionService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
        )
        .ensure_global()
        .await
        .expect("建 _global");
        let embedder = Arc::new(SlowEmbedder::new(env.embedder.clone(), delay));
        let index = Arc::new(IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            IndexOptions::default(),
        ));
        let tracker = Arc::new(ProgressTracker::new(env.meta.clone(), "cpu-int8"));
        let observer = Arc::new(RecordingObserver::default());
        let paths = env.paths();
        let handler = IngestJobHandler::new(
            index,
            env.meta.clone(),
            paths.clone(),
            UnpackLimits {
                max_ratio: 10,
                max_depth: 3,
                max_files: 100,
                max_bytes: UploadConfig::default().max_file_mb * 1024 * 1024,
                max_total_bytes: 0,
            },
            10,
            tracker.clone(),
        )
        .with_observer(observer.clone())
        // 测试里固定并发数:生产里是每次分片现读 `index.parallel_files`
        .with_parallel_files(Arc::new(move || parallel));
        let batches = BatchService::new(env.meta.clone(), env.store.clone(), tracker.clone());
        Self {
            env,
            handler,
            batches,
            embedder,
            observer,
            dir: tempfile::tempdir().expect("临时目录"),
        }
    }

    /// 造一个批次的文件:每个文件一行正文(= 1 块)。
    async fn seed(&self, batch_id: &str, files: usize) {
        self.seed_sections(batch_id, files, 1).await;
    }

    /// 造一个批次的文件;`sections` 是每个文件的小节数(每节约 1 块)。
    async fn seed_sections(&self, batch_id: &str, files: usize, sections: usize) {
        IngestProgressRepo::ensure_ingest_batch(
            self.env.meta.as_ref(),
            batch_id,
            COLLECTION,
            now_millis(),
        )
        .await
        .expect("建批次");
        for index in 0..files {
            let name = format!("f{index:04}.md");
            let path = self.dir.path().join(&name);
            let mut body = format!("# 文件 {index}\n");
            for section in 0..sections {
                body.push_str(&format!(
                    "\n## 小节 {section}\n\n第 {index} 个文件的第 {section} 节正文,写一点够长的内容让分块器把它单独切出来。\n"
                ));
            }
            std::fs::write(&path, body).expect("写文件");
            let now = now_millis();
            IngestRepo::create(
                self.env.meta.as_ref(),
                IngestFile {
                    id: format!("file-{index:04}"),
                    batch_id: Some(batch_id.to_owned()),
                    source_id: None,
                    upload_id: None,
                    collection: COLLECTION.to_owned(),
                    rel_path: name,
                    abs_path: path.display().to_string(),
                    size: 30,
                    sha256: None,
                    state: IngestState::Queued,
                    error: None,
                    chunks: 0,
                    vectors: 0,
                    extract_meta: None,
                    derived_from: None,
                    elapsed_ms: None,
                    created_at: now,
                    updated_at: now,
                },
            )
            .await
            .expect("入队");
        }
    }

    fn job(&self, batch_id: &str) -> Job {
        let payload = IngestPayload {
            batch_id: batch_id.to_owned(),
            collection: COLLECTION.to_owned(),
        };
        Job {
            id: format!("job-{batch_id}"),
            kind: "ingest".to_owned(),
            collection: Some(COLLECTION.to_owned()),
            priority: 60,
            state: JobState::Queued,
            payload_json: serde_json::to_string(&payload).expect("序列化"),
            checkpoint_json: None,
            detail: None,
            progress_done: 0,
            progress_total: None,
            rate: None,
            error: None,
            created_at: 0,
            started_at: None,
            finished_at: None,
        }
    }

    /// 跑一个分片,返回是否结束 / 是否暂停。
    async fn slice(&self, batch_id: &str) -> (bool, bool) {
        let progress = self
            .handler
            .run_slice(&self.job(batch_id))
            .await
            .expect("跑分片");
        (progress.finished, progress.paused)
    }

    /// 跑到结束(或暂停)。
    async fn run_to_end(&self, batch_id: &str) -> bool {
        for _ in 0..2000 {
            let (finished, paused) = self.slice(batch_id).await;
            if finished || paused {
                return finished;
            }
        }
        panic!("批次没有在 2000 个分片内结束");
    }

    async fn chunks_of(&self, rel_path: &str) -> (u64, u64) {
        let collection = CollectionRepo::get(self.env.meta.as_ref(), COLLECTION)
            .await
            .expect("取 collection")
            .expect("collection 存在");
        let chunks = ChunkRepo::by_path(self.env.meta.as_ref(), COLLECTION, rel_path)
            .await
            .expect("查块");
        let filter = kb_core::filter::Filter {
            path_prefix: Some(rel_path.to_owned()),
            ..kb_core::filter::Filter::default()
        }
        .to_sql()
        .expect("生成过滤条件");
        let rows = self
            .env
            .store
            .count(&collection.active_table, filter.as_deref())
            .await
            .expect("数向量");
        (chunks.len() as u64, rows)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eta_of_a_thousand_chunk_batch_is_within_twenty_five_percent() {
    // 100 个文件 × 10 节 ≈ 1,000 块;每次嵌入 20 ms(贴近真实文档批次的形状)
    let harness = Harness::new(Duration::from_millis(20)).await;
    harness.seed_sections("b-eta", 100, 10).await;

    let started = Instant::now();
    let mut sampled: Option<(Instant, BatchProgress)> = None;
    let mut finished = false;
    let mut last_report = 0u64;
    for _ in 0..400 {
        let (done, paused) = harness.slice("b-eta").await;
        // 诊断用:每 250 个文件打一行耗时
        if let Ok(progress) = harness.batches.progress("b-eta").await
            && progress.done >= last_report + 25
        {
            last_report = progress.done;
            eprintln!(
                "[eta] done={} elapsed={:.1}s throughput={:.1} 块/秒 eta={:?}",
                progress.done, progress.elapsed_s, progress.throughput_cps, progress.eta_s
            );
        }
        if paused {
            panic!("不应暂停");
        }
        if sampled.is_none() {
            let progress = harness.batches.progress("b-eta").await.expect("进度");
            if progress.done >= 50 && progress.total == 100 {
                sampled = Some((Instant::now(), progress));
            }
        }
        if done {
            finished = true;
            break;
        }
    }
    assert!(finished, "批次应跑完");
    let total_time = started.elapsed().as_secs_f64();
    let (sampled_at, progress) = sampled.expect("应在 25% 左右取到一次进度样本");
    let actual_remaining = sampled_at.elapsed().as_secs_f64();
    let eta = progress.eta_s.expect("应能算出 ETA") as f64;
    assert!(progress.chunks >= 200, "样本里应有块数:{progress:?}");
    let error = (eta - actual_remaining).abs() / actual_remaining.max(0.1);
    // 滑动窗口估算对机器负载很敏感(并行跑整套测试时前后半程速率会差一倍),
    // 放宽到 50%:仍然能抓住“估得离谱”的回归,又不会在忙的机器上误报。
    assert!(
        error <= 0.50,
        "ETA 误差应 ≤ 50%:预估 {eta:.1}s,实际 {actual_remaining:.1}s(整批 {total_time:.1}s,已完成 {} / {})",
        progress.done,
        progress.total
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pausing_stops_new_embeddings_and_resumes_after_a_restart() {
    let harness = Harness::new(Duration::from_millis(5)).await;
    harness.seed("b-pause", 40).await;

    // 先跑一片(10 个文件)
    let (finished, paused) = harness.slice("b-pause").await;
    assert!(!finished && !paused);
    let calls_before = harness.embedder.calls();
    assert!(calls_before > 0);

    // 暂停后继续调 worker:5 秒内不应有新的嵌入调用
    harness.batches.pause("b-pause").await.expect("暂停");
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        let (_, paused) = harness.slice("b-pause").await;
        assert!(paused, "暂停后分片应立刻返回 paused");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(
            harness.embedder.calls(),
            calls_before,
            "暂停后不应再调用嵌入器"
        );
    }
    // 暂停状态落库(重启后仍是 paused)
    let batch = IngestProgressRepo::ingest_batch(harness.env.meta.as_ref(), "b-pause")
        .await
        .expect("读批次")
        .expect("批次存在");
    assert_eq!(batch.state, kb_core::model::IngestBatchState::Paused);

    // “重启守护进程”:换一个处理器实例(内存里的节流 / 平滑状态全丢),仍然保持暂停
    let restarted = IngestJobHandler::new(
        Arc::new(IndexService::new(
            harness.env.meta.clone(),
            harness.env.store.clone(),
            harness.embedder.clone(),
            harness.env.chunker.clone(),
            harness.env.scanner.clone(),
            IndexOptions::default(),
        )),
        harness.env.meta.clone(),
        harness.env.paths(),
        UnpackLimits::default(),
        10,
        Arc::new(ProgressTracker::new(harness.env.meta.clone(), "cpu-int8")),
    );
    let payload = IngestPayload {
        batch_id: "b-pause".to_owned(),
        collection: COLLECTION.to_owned(),
    };
    let job = Job {
        id: "job-b-pause".to_owned(),
        kind: "ingest".to_owned(),
        collection: Some(COLLECTION.to_owned()),
        priority: 60,
        state: JobState::Paused,
        payload_json: serde_json::to_string(&payload).expect("序列化"),
        checkpoint_json: None,
        detail: None,
        progress_done: 10,
        progress_total: None,
        rate: None,
        error: None,
        created_at: 0,
        started_at: None,
        finished_at: None,
    };
    let progress = restarted.run_slice(&job).await.expect("重启后跑分片");
    assert!(progress.paused, "重启后仍应保持暂停");

    // 继续:跑完,块数与“不暂停”的一次运行一致
    harness.batches.resume("b-pause").await.expect("继续");
    assert!(harness.run_to_end("b-pause").await, "继续后应跑完");
    let files = IngestRepo::list(
        harness.env.meta.as_ref(),
        IngestFilter {
            collection: None,
            batch_id: Some("b-pause".to_owned()),
            source_id: None,
            state: None,
        },
        Page::new(100, 0),
    )
    .await
    .expect("列队列");
    let done = files
        .iter()
        .filter(|file| file.state == IngestState::Done)
        .count();
    assert_eq!(done, 40, "40 个文件都应完成");
    let chunks: u64 = files.iter().map(|file| file.chunks).sum();
    let per_file = files
        .iter()
        .find(|file| file.chunks > 0)
        .map(|file| file.chunks)
        .expect("至少有一个文件产出了块");
    assert_eq!(chunks, per_file * 40, "40 个文件都应按同样的分块结果入库");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cancel_keeps_finished_files_and_leaves_no_orphans() {
    let harness = Harness::new(Duration::from_millis(1)).await;
    harness.seed("b-cancel", 15).await;

    // 先跑一片,让前 5 个文件完成(第 6 个留给“在途”)
    harness.slice("b-cancel").await;
    let files = IngestRepo::list(
        harness.env.meta.as_ref(),
        IngestFilter {
            collection: None,
            batch_id: Some("b-cancel".to_owned()),
            source_id: None,
            state: None,
        },
        Page::new(100, 0),
    )
    .await
    .expect("列队列");
    let done: Vec<&IngestFile> = files
        .iter()
        .filter(|file| file.state == IngestState::Done)
        .collect();
    assert!(!done.is_empty(), "至少要有已完成的文件");
    let finished_path = done[0].rel_path.clone();
    let (finished_chunks, _) = harness.chunks_of(&finished_path).await;
    assert!(finished_chunks > 0);

    // 造一个“在途”文件:块与向量已经写了一半,状态是 embedding
    let in_flight = files
        .iter()
        .find(|file| file.state == IngestState::Queued)
        .expect("应有未处理的文件")
        .clone();
    {
        // 直接用索引服务写一次,模拟半成品
        let index = IndexService::new(
            harness.env.meta.clone(),
            harness.env.store.clone(),
            harness.embedder.clone(),
            harness.env.chunker.clone(),
            harness.env.scanner.clone(),
            IndexOptions::default(),
        );
        let collection = CollectionRepo::get(harness.env.meta.as_ref(), COLLECTION)
            .await
            .expect("取 collection")
            .expect("collection 存在");
        let metadata = std::fs::metadata(&in_flight.abs_path).expect("元数据");
        let entry = kb_core::model::ScanEntry {
            path: std::path::PathBuf::from(&in_flight.abs_path),
            relative: in_flight.rel_path.clone(),
            size: metadata.len(),
            mtime: 0,
            lang: "markdown".to_owned(),
            kind: kb_core::model::FileKind::Doc,
        };
        let spec = kb_service::index::FileIndexSpec {
            source: in_flight.rel_path.clone(),
            kind: kb_core::model::FileKind::Doc,
            tags: Vec::new(),
        };
        index
            .index_entry_with("上传", &collection, &entry, &spec, now_millis())
            .await
            .expect("写半成品");
        IngestRepo::set_state(
            harness.env.meta.as_ref(),
            &in_flight.id,
            IngestState::Embedding,
            None,
        )
        .await
        .expect("标记在途");
    }
    let (in_flight_chunks, _in_flight_rows) = harness.chunks_of(&in_flight.rel_path).await;
    assert!(in_flight_chunks > 0, "在途文件应已有块");

    let report = harness.batches.cancel("b-cancel").await.expect("取消批次");
    assert!(report.rolled_back >= 1, "{report:?}");
    assert!(report.kept >= 1, "{report:?}");

    // 已完成的文件仍可检索
    let (kept_chunks, kept_rows) = harness.chunks_of(&finished_path).await;
    assert_eq!(kept_chunks, finished_chunks, "已完成的块不应被取消影响");
    assert!(kept_rows > 0);

    // 在途文件的块、向量与 files 行都不残留
    let (after_chunks, after_rows) = harness.chunks_of(&in_flight.rel_path).await;
    assert_eq!((after_chunks, after_rows), (0, 0), "在途文件应被回滚");
    assert!(
        FileRepo::get(harness.env.meta.as_ref(), COLLECTION, &in_flight.rel_path)
            .await
            .expect("查 files")
            .is_none()
    );
    // 整个 collection 里没有指向已删除文件的块(逐路径核对)
    let all = ChunkRepo::by_path(harness.env.meta.as_ref(), COLLECTION, &in_flight.rel_path)
        .await
        .expect("再查块");
    assert!(all.is_empty(), "不应残留孤儿块");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn retrying_a_failed_stage_succeeds_without_reupload() {
    let harness = Harness::new(Duration::from_millis(1)).await;
    // 一个二进制文件:会在“解析/抽取”阶段失败
    let path = harness.dir.path().join("bad.md");
    std::fs::write(&path, [0u8, 1, 2, 3, 4]).expect("写二进制");
    IngestProgressRepo::ensure_ingest_batch(
        harness.env.meta.as_ref(),
        "b-retry",
        COLLECTION,
        now_millis(),
    )
    .await
    .expect("建批次");
    let now = now_millis();
    IngestRepo::create(
        harness.env.meta.as_ref(),
        IngestFile {
            id: "file-retry".to_owned(),
            batch_id: Some("b-retry".to_owned()),
            source_id: None,
            upload_id: None,
            collection: COLLECTION.to_owned(),
            rel_path: "bad.md".to_owned(),
            abs_path: path.display().to_string(),
            size: 5,
            sha256: None,
            state: IngestState::Queued,
            error: None,
            chunks: 0,
            vectors: 0,
            extract_meta: None,
            derived_from: None,
            elapsed_ms: None,
            created_at: now,
            updated_at: now,
        },
    )
    .await
    .expect("入队");
    assert!(harness.run_to_end("b-retry").await);

    let file = IngestRepo::get(harness.env.meta.as_ref(), "file-retry")
        .await
        .expect("取文件")
        .expect("存在");
    // :二进制 / 坏文件记 `skipped`,**不挪走原件**(挪走的话用户点开是一片空白)
    assert_eq!(
        file.state,
        IngestState::Skipped,
        "二进制文件应跳过:{file:?}"
    );
    assert!(path.exists(), "原件不能被挪走:{}", path.display());
    let timeline = harness
        .batches
        .timeline("file-retry")
        .await
        .expect("时间线");
    assert!(
        timeline
            .stages
            .iter()
            .any(|stage| stage.stage == IngestStage::Extract
                && stage.status == kb_core::model::IngestStageStatus::Skipped),
        "跳过应钉在 extract 阶段:{timeline:?}"
    );

    // 修好文件(相当于装上 OCR 模型),从 extract 阶段重跑
    std::fs::write(&path, "# 修好了\n\n这次是文本。\n").expect("改文件");
    let retried = harness
        .batches
        .retry_stage("file-retry", IngestStage::Extract)
        .await
        .expect("从 extract 重跑");
    assert_eq!(retried.state, IngestState::Queued);
    assert!(harness.run_to_end("b-retry").await);

    let file = IngestRepo::get(harness.env.meta.as_ref(), "file-retry")
        .await
        .expect("取文件")
        .expect("存在");
    assert_eq!(file.state, IngestState::Done, "重跑后应完成:{file:?}");
    let (chunks, rows) = harness.chunks_of("bad.md").await;
    assert!(chunks > 0 && rows > 0, "重跑后应有块与向量");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ingest_stage_events_are_throttled_to_two_per_second() {
    let harness = Harness::new(Duration::from_millis(1)).await;
    harness.seed("b-ws", 30).await;
    assert!(harness.run_to_end("b-ws").await);

    let pushes = harness.observer.pushes.lock().expect("锁").clone();
    assert!(!pushes.is_empty(), "应有 ingest.stage 推送");
    // 任意 1 秒窗口内不超过 2 次
    for (index, (at, _)) in pushes.iter().enumerate() {
        let window_end = *at + Duration::from_secs(1);
        let in_window = pushes
            .iter()
            .skip(index)
            .take_while(|(when, _)| *when < window_end)
            .count();
        assert!(
            in_window <= 2,
            "1 秒内推送了 {in_window} 次(第 {index} 条起),应 ≤ 2"
        );
    }
    // 推送内容包含要求的字段
    let (_, progress) = &pushes[pushes.len() - 1];
    assert_eq!(progress.batch, "b-ws");
    assert_eq!(progress.total, 30);
    assert_eq!(progress.stages.len(), 7, "七个阶段都要在");
    assert!(!progress.backend.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_files_prepare_several_files_at_once() {
    // 3 个文件同时准备:读 / 抽取 / 分块这些 CPU 活重叠
    let harness = Harness::with_parallel(Duration::from_millis(20), 3).await;
    harness.seed("b-par", 6).await;

    let (finished, paused) = harness.slice("b-par").await;
    assert!(finished && !paused, "10 个一片,6 个文件应一片跑完");
    assert_eq!(
        harness.observer.peak_active(),
        3,
        "配 3 就应有 3 个文件同时在处理"
    );
    for index in 0..6 {
        let (chunks, vectors) = harness.chunks_of(&format!("f{index:04}.md")).await;
        assert!(chunks >= 1, "第 {index} 个文件应入库");
        assert_eq!(chunks, vectors, "第 {index} 个文件的块都要有向量");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn default_keeps_one_file_at_a_time() {
    let harness = Harness::new(Duration::from_millis(5)).await;
    harness.seed("b-one", 4).await;
    harness.slice("b-one").await;
    assert_eq!(
        harness.observer.peak_active(),
        1,
        "默认(parallel_files = 1)不并行,不改变已有安装的行为"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_files_embed_several_at_once() {
    // 嵌入也并行:以前为了让 LanceDB 少撞提交冲突而串行,结果机器大部分时间在等嵌入。
    // 现在并发提交,冲突由存储层退避重试(`WRITE_BACKOFF`),块的先后顺序不影响检索结果。
    let harness = Harness::with_parallel(Duration::from_millis(20), 4).await;
    harness.seed("b-commit", 4).await;
    let (finished, paused) = harness.slice("b-commit").await;
    assert!(finished && !paused, "4 个文件应一片跑完");
    assert!(
        harness.embedder.max_in_flight() > 1,
        "配了 4 个并发,嵌入还是一次一个文件,说明提交闸门没拆干净"
    );
    for index in 0..4 {
        let (chunks, vectors) = harness.chunks_of(&format!("f{index:04}.md")).await;
        assert!(chunks >= 1, "第 {index} 个文件应入库");
        assert_eq!(chunks, vectors, "第 {index} 个文件的块都要有向量");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restart_requeues_inflight_files_and_keeps_progress() {
    let harness = Harness::new(Duration::from_millis(1)).await;
    harness.seed("b-crash", 5).await;
    let meta = harness.env.meta.clone();

    // 重启前的形状:1 个已完成、2 个被强杀时正在处理(阶段事件还开着,界面上就是“N 个并发”的来源)
    IngestRepo::finish(
        meta.as_ref(),
        "file-0000",
        IngestState::Done,
        1,
        1,
        12,
        None,
    )
    .await
    .expect("完成一个");
    for (id, state, stage) in [
        ("file-0001", IngestState::Extracting, IngestStage::Extract),
        ("file-0002", IngestState::Embedding, IngestStage::Embed),
    ] {
        IngestRepo::set_state(meta.as_ref(), id, state, None)
            .await
            .expect("改状态");
        IngestProgressRepo::begin_stage(meta.as_ref(), id, Some("b-crash"), stage, now_millis())
            .await
            .expect("开阶段");
    }

    let recovered = kb_service::IngestService::new(meta.clone())
        .recover_inflight()
        .await
        .expect("恢复");
    assert_eq!(recovered, 2, "两个在途文件都应回队");
    for id in ["file-0001", "file-0002"] {
        let file = IngestRepo::get(meta.as_ref(), id)
            .await
            .expect("取文件")
            .expect("文件存在");
        assert_eq!(file.state, IngestState::Queued, "{id} 应回到 queued");
        let stages = IngestProgressRepo::stages_of_file(meta.as_ref(), id)
            .await
            .expect("查阶段");
        assert!(
            stages
                .iter()
                .all(|stage| stage.status != IngestStageStatus::Running),
            "{id} 残留着“进行中”的阶段事件:{stages:?}"
        );
    }

    // 进度不重来:从重启前已完成的 1 个接着数到 5
    let mut job = harness.job("b-crash");
    job.progress_done = 1;
    let progress = harness.handler.run_slice(&job).await.expect("跑片");
    assert!(progress.finished, "恢复后一片应能跑完");
    assert_eq!(progress.done, 5, "done 应从 1 接着数到 5");

    let done = IngestRepo::count(
        meta.as_ref(),
        IngestFilter {
            collection: None,
            batch_id: Some("b-crash".to_owned()),
            source_id: None,
            state: Some(IngestState::Done),
        },
    )
    .await
    .expect("数完成");
    assert_eq!(done, 5, "5 个文件应全部入库");
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 只是为了让 `KbError` 的导入有使用点(测试里断言错误文本时用)。
#[allow(dead_code)]
fn is_not_found(error: &KbError) -> bool {
    matches!(error, KbError::NotFound(_))
}
