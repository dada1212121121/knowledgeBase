//! 任务队列与检查点(验收)。

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use kb_core::Filter;
use kb_core::model::{Job, JobState, Project, SearchMode, StoreQuery};
use kb_core::ports::repo::{ChunkRepo, FileRepo, MetaStore, ProjectRepo};
use kb_service::jobs::{IndexJobHandler, JobHandler, JobQueue, NewJob, SliceProgress, Worker};
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;
use tokio::sync::watch;

const FILES: [(&str, &str); 10] = [
    ("src/f0.rs", "fn f0() -> u32 {\n    0\n}\n"),
    ("src/f1.rs", "fn f1() -> u32 {\n    1\n}\n"),
    ("src/f2.rs", "fn f2() -> u32 {\n    2\n}\n"),
    ("src/f3.rs", "fn f3() -> u32 {\n    3\n}\n"),
    ("src/f4.rs", "fn f4() -> u32 {\n    4\n}\n"),
    ("src/f5.rs", "fn f5() -> u32 {\n    5\n}\n"),
    ("src/f6.rs", "fn f6() -> u32 {\n    6\n}\n"),
    ("src/f7.rs", "fn f7() -> u32 {\n    7\n}\n"),
    ("src/f8.rs", "fn f8() -> u32 {\n    8\n}\n"),
    ("src/f9.rs", "fn f9() -> u32 {\n    9\n}\n"),
];

struct Fixture {
    env: TestEnv,
    #[allow(dead_code)]
    dir: TempDir,
    project: Project,
    service: Arc<IndexService>,
    queue: Arc<JobQueue>,
    collection: String,
}

async fn fixture(files: &[(&str, &str)]) -> Fixture {
    let dir = tempfile::tempdir().expect("临时项目目录");
    for (path, content) in files {
        write_file(dir.path(), path, content);
    }
    let env = TestEnv::new().await;
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
    ProjectRepo::create(env.meta.as_ref(), project.clone())
        .await
        .expect("写项目行");
    let collections =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("建 collection")
        .name;
    let service = Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ));
    let queue = Arc::new(JobQueue::new(env.meta.clone()));
    Fixture {
        env,
        dir,
        project,
        service,
        queue,
        collection,
    }
}

fn write_file(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

/// 让每个分片慢一点的装饰器,便于观察抢占。
struct SlowHandler {
    inner: Arc<dyn JobHandler>,
    delay: Duration,
}

#[async_trait]
impl JobHandler for SlowHandler {
    /// 装饰器要转发通道声明:不转发的话内层的交互通道会被默认值(`Lane::Bulk`)吞掉,
    /// 增量任务就得排在只有一个名额的批量通道后面。
    fn lane(&self, job: &Job) -> kb_service::jobs::slots::Lane {
        self.inner.lane(job)
    }

    async fn run_slice(&self, job: &Job) -> kb_core::Result<SliceProgress> {
        tokio::time::sleep(self.delay).await;
        self.inner.run_slice(job).await
    }
}

fn handler(fixture: &Fixture, slice_files: usize) -> Arc<dyn JobHandler> {
    Arc::new(IndexJobHandler::new(
        fixture.service.clone(),
        fixture.env.meta.clone(),
        slice_files,
    ))
}

async fn chunk_hashes(
    meta: &dyn MetaStore,
    collection: &str,
) -> Vec<(String, String, String, String)> {
    let mut out = Vec::new();
    for path in FileRepo::list_paths(meta, collection)
        .await
        .expect("列路径")
    {
        for chunk in ChunkRepo::by_path(meta, collection, &path)
            .await
            .expect("读块")
        {
            out.push((
                chunk.path,
                chunk.content_hash,
                chunk.meta_hash,
                chunk.embed_input_hash,
            ));
        }
    }
    out.sort();
    out
}

async fn wait_until<F, Fut>(timeout: Duration, mut check: F) -> bool
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let deadline = tokio::time::Instant::now() + timeout;
    while tokio::time::Instant::now() < deadline {
        if check().await {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn higher_priority_job_runs_alongside_the_full_index() {
    let fixture = fixture(&FILES).await;
    let full = fixture
        .queue
        .enqueue(NewJob::full_index("p1", &fixture.collection))
        .await
        .expect("入队全量");

    let (tx, rx) = watch::channel(false);
    // 只给 1 个批量名额:不限的话全量任务会被自己并行的其它片很快跑完,
    // 就看不到「增量插在旧批次中间跑完」;限定 1 个名额才能确认新任务不等 10 个文件
    let worker = Arc::new(
        Worker::new(
            fixture.queue.clone(),
            Arc::new(SlowHandler {
                inner: handler(&fixture, 1),
                delay: Duration::from_millis(15),
            }),
            rx,
        )
        .with_slots(kb_service::jobs::slots::SliceGate::fixed(1)),
    );
    let running = tokio::spawn({
        let worker = worker.clone();
        async move { worker.run().await }
    });

    // 等全量任务开始推进
    let queue = fixture.queue.clone();
    assert!(
        wait_until(Duration::from_secs(5), || {
            let queue = queue.clone();
            let full = full.clone();
            async move {
                let current = queue.get(&full.id).await.expect("查询").expect("存在");
                current.progress_done >= 1
            }
        })
        .await,
        "全量任务应已开始"
    );

    // 投入更高优先级的增量任务
    let incremental = fixture
        .queue
        .enqueue(NewJob::incremental_index(
            "p1",
            &fixture.collection,
            &["src/f3.rs".to_owned()],
        ))
        .await
        .expect("入队增量");
    assert!(incremental.priority > full.priority);

    let queue = fixture.queue.clone();
    let incremental_id = incremental.id.clone();
    assert!(
        wait_until(Duration::from_secs(5), || {
            let queue = queue.clone();
            let id = incremental_id.clone();
            async move {
                let job = queue.get(&id).await.expect("查询").expect("存在");
                job.state == JobState::Done
            }
        })
        .await,
        "增量任务应完成"
    );

    // 抢占的含义是「新任务不必等旧批次做完」:两个任务的执行区间必须重叠。
    // 以前一个知识库只有一个 worker,新上传的编辑要排在几千个文件的导入后面。
    let full_now = fixture
        .queue
        .get(&full.id)
        .await
        .expect("查询")
        .expect("存在");
    let incremental_now = fixture
        .queue
        .get(&incremental.id)
        .await
        .expect("查询")
        .expect("存在");
    let incremental_started = incremental_now.started_at.expect("增量任务应有开始时间");
    let full_finished = full_now.finished_at.expect("全量任务应已结束");
    assert!(
        incremental_started < full_finished,
        "增量任务应和全量任务重叠执行(增量 {incremental_started} / 全量结束 {full_finished})"
    );

    // 全量任务最终也会完成
    let queue = fixture.queue.clone();
    let full_id = full.id.clone();
    assert!(
        wait_until(Duration::from_secs(10), || {
            let queue = queue.clone();
            let id = full_id.clone();
            async move {
                let job = queue.get(&id).await.expect("查询").expect("存在");
                job.state == JobState::Done
            }
        })
        .await,
        "全量任务最终应完成"
    );

    // 收尾:让 worker 退出
    tx.send(true).expect("发关闭信号");
    running
        .await
        .expect("worker 未 panic")
        .expect("worker 正常退出");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interrupted_job_resumes_from_checkpoint_with_identical_result() {
    // 参照组:不中断地跑完
    let reference = fixture(&FILES).await;
    reference
        .service
        .index_project(&reference.project, &reference_collection(&reference).await)
        .await
        .expect("参照索引");
    let reference_hashes = chunk_hashes(reference.env.meta.as_ref(), &reference.collection).await;
    assert_eq!(reference_hashes.len(), FILES.len(), "每个文件一块");

    // 实验组:跑到一半让 worker 停下
    let interrupted = fixture(&FILES).await;
    let job = interrupted
        .queue
        .enqueue(NewJob::full_index("p1", &interrupted.collection))
        .await
        .expect("入队");

    let (tx, rx) = watch::channel(false);
    let worker = Arc::new(Worker::new(
        interrupted.queue.clone(),
        handler(&interrupted, 1),
        rx,
    ));
    let running = tokio::spawn({
        let worker = worker.clone();
        async move { worker.run().await }
    });

    let queue = interrupted.queue.clone();
    let job_id = job.id.clone();
    assert!(
        wait_until(Duration::from_secs(5), || {
            let queue = queue.clone();
            let id = job_id.clone();
            async move {
                let current = queue.get(&id).await.expect("查询").expect("存在");
                current.progress_done >= 3
            }
        })
        .await,
        "任务应推进到 3 个文件以上"
    );
    tx.send(true).expect("发关闭信号");
    running
        .await
        .expect("worker 未 panic")
        .expect("worker 正常退出");

    let stopped = interrupted
        .queue
        .get(&job.id)
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(stopped.state, JobState::Queued, "让出后应回到 queued");
    let checkpoint: serde_json::Value =
        serde_json::from_str(stopped.checkpoint_json.as_deref().expect("应有检查点"))
            .expect("解析检查点");
    let resumed_from = checkpoint["next"].as_u64().expect("next");
    assert!(resumed_from >= 3, "检查点应记录进度:{checkpoint}");
    assert!(stopped.progress_done >= 3);

    // 重启:恢复 + 新 worker 续跑
    assert_eq!(
        interrupted.queue.recover().await.expect("恢复"),
        0,
        "没有 running 任务"
    );
    let (_tx2, rx2) = watch::channel(false);
    let worker2 = Worker::new(interrupted.queue.clone(), handler(&interrupted, 1), rx2);
    while worker2.run_once().await.expect("续跑").is_some() {}

    let finished = interrupted
        .queue
        .get(&job.id)
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(finished.state, JobState::Done);
    assert_eq!(finished.progress_done, FILES.len() as u64);

    let resumed_hashes = chunk_hashes(interrupted.env.meta.as_ref(), &interrupted.collection).await;
    assert_eq!(
        resumed_hashes, reference_hashes,
        "中断续跑后的 chunks 哈希集合应与不中断时一致"
    );
    assert_eq!(
        interrupted.env.fake.embedding_count(),
        reference.env.fake.embedding_count(),
        "续跑不应重复嵌入已完成的文件"
    );
}

async fn reference_collection(fixture: &Fixture) -> kb_core::model::Collection {
    CollectionService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    )
    .get(&fixture.collection)
    .await
    .expect("查 collection")
    .expect("存在")
}

#[tokio::test]
async fn incremental_jobs_for_the_same_collection_are_merged() {
    let fixture = fixture(&FILES).await;
    let first = fixture
        .queue
        .enqueue(NewJob::incremental_index(
            "p1",
            &fixture.collection,
            &["src/f1.rs".to_owned()],
        ))
        .await
        .expect("入队");
    let second = fixture
        .queue
        .enqueue(NewJob::incremental_index(
            "p1",
            &fixture.collection,
            &["src/f2.rs".to_owned(), "src/f1.rs".to_owned()],
        ))
        .await
        .expect("入队");

    assert_eq!(first.id, second.id, "同一 collection 的增量任务应合并");
    let queued = fixture
        .queue
        .list(Some(JobState::Queued))
        .await
        .expect("列表");
    assert_eq!(queued.len(), 1);
    let payload: serde_json::Value =
        serde_json::from_str(&queued[0].payload_json).expect("解析 payload");
    let paths: Vec<&str> = payload["paths"]
        .as_array()
        .expect("paths")
        .iter()
        .filter_map(|value| value.as_str())
        .collect();
    assert_eq!(paths, vec!["src/f1.rs", "src/f2.rs"], "paths 应合并去重");
}

#[tokio::test]
async fn staged_index_jobs_are_not_merged_with_normal_incremental_jobs() {
    let fixture = fixture(&FILES).await;
    let mut staged =
        NewJob::incremental_index("p1", &fixture.collection, &["src/f1.rs".to_owned()]);
    staged.payload["phase"] = serde_json::json!("text");
    staged.payload["stop_after_text"] = serde_json::json!(true);
    let staged_job = fixture.queue.enqueue(staged).await.expect("入队");

    let normal = fixture
        .queue
        .enqueue(NewJob::incremental_index(
            "p1",
            &fixture.collection,
            &["src/f2.rs".to_owned()],
        ))
        .await
        .expect("入队");
    assert_ne!(
        staged_job.id, normal.id,
        "普通增量任务不能被并进只写正文的任务"
    );

    let mut staged_again =
        NewJob::incremental_index("p1", &fixture.collection, &["src/f3.rs".to_owned()]);
    staged_again.payload["phase"] = serde_json::json!("text");
    staged_again.payload["stop_after_text"] = serde_json::json!(true);
    let staged_again = fixture.queue.enqueue(staged_again).await.expect("入队");
    assert_ne!(
        staged_again.id, normal.id,
        "手动阶段任务也不能被并进普通增量任务"
    );
    assert_ne!(
        staged_again.id, staged_job.id,
        "两次手动阶段任务不应互相合并"
    );

    let queued = fixture
        .queue
        .list(Some(JobState::Queued))
        .await
        .expect("列表");
    assert_eq!(queued.len(), 3, "三个阶段应各自独立排队");
}

#[tokio::test]
async fn a_queued_job_with_a_checkpoint_is_not_merged_with_new_incremental_work() {
    // checkpoint 固化了文件顺序 / 阶段；合并只改 payload。已经跑过一片的任务若被合并，
    // 新路径不会进 checkpoint（phase=embed 时更会被整段忽略），最后还标记成功。
    let fixture = fixture(&FILES).await;
    let first = fixture
        .queue
        .enqueue(NewJob::incremental_index(
            "p1",
            &fixture.collection,
            &["src/f1.rs".to_owned()],
        ))
        .await
        .expect("入队");
    fixture
        .queue
        .progress(&first, 1, Some(10), None, Some("{}".to_owned()))
        .await
        .expect("记检查点");
    let second = fixture
        .queue
        .enqueue(NewJob::incremental_index(
            "p1",
            &fixture.collection,
            &["src/f2.rs".to_owned()],
        ))
        .await
        .expect("入队");
    assert_ne!(
        first.id, second.id,
        "已有检查点的任务不能再吸收新路径，否则新路径永远不会被处理"
    );
    let queued = fixture
        .queue
        .list(Some(JobState::Queued))
        .await
        .expect("列表");
    assert_eq!(queued.len(), 2, "两个任务都应独立排队");
}

#[tokio::test]
async fn manual_text_only_incremental_refreshes_the_fts_index() {
    // 手动文本优先的增量:第一次已建好 FTS 索引，第二次写入只有 pending 行。
    // ensure_indexes 看到索引已存在就跳过；如果不收尾 optimize，新行不进全文索引，
    // 补向量之前这些正文完全搜不到。
    let fixture = fixture(&[("src/f0.rs", "fn f0() -> u32 {\n    0\n}\n")]).await;
    let mut first = NewJob::full_index("p1", &fixture.collection);
    first.payload["phase"] = serde_json::json!("text");
    first.payload["stop_after_text"] = serde_json::json!(true);
    fixture.queue.enqueue(first).await.expect("入队首次文本");
    let job = fixture.queue.next().await.expect("取任务").expect("有任务");
    let job = fixture.queue.start(&job).await.expect("开始首次文本");
    let handler = handler(&fixture, 10);
    let first_progress = handler.run_slice(&job).await.expect("首次文本");
    assert!(first_progress.finished);
    let checkpoint: serde_json::Value =
        serde_json::from_str(first_progress.checkpoint.as_deref().expect("检查点"))
            .expect("解析检查点");
    assert!(
        checkpoint["pending"].as_u64().unwrap_or(0) > 0,
        "首次文本应留下待补队列"
    );

    write_file(
        fixture.dir.path(),
        "src/f0.rs",
        "fn f0() -> u32 {\n    let zebra = 1;\n    zebra\n}\n",
    );
    let mut second =
        NewJob::incremental_index("p1", &fixture.collection, &["src/f0.rs".to_owned()]);
    second.payload["phase"] = serde_json::json!("text");
    second.payload["stop_after_text"] = serde_json::json!(true);
    fixture.queue.enqueue(second).await.expect("入队增量文本");
    let job = fixture.queue.next().await.expect("取任务").expect("有任务");
    let job = fixture.queue.start(&job).await.expect("开始增量文本");
    let second_progress = handler.run_slice(&job).await.expect("增量文本");
    assert!(second_progress.finished);
    let checkpoint: serde_json::Value =
        serde_json::from_str(second_progress.checkpoint.as_deref().expect("检查点"))
            .expect("解析检查点");
    assert!(
        checkpoint["pending"].as_u64().unwrap_or(0) > 0,
        "增量文本应留下待补队列"
    );

    let collection = reference_collection(&fixture).await;
    let hits = fixture
        .env
        .store
        .search(
            &collection.active_table,
            &StoreQuery {
                mode: SearchMode::Fts,
                text: Some("zebra".to_owned()),
                vector: None,
                filter: Filter::default(),
                limit: 10,
                offset: 0,
                with_vector: false,
            },
        )
        .await
        .expect("全文检索");
    assert!(
        !hits.is_empty(),
        "手动文本阶段新写入的正文必须马上能被全文检索到"
    );
}

#[tokio::test]
async fn progress_rate_and_checkpoint_are_recorded() {
    let fixture = fixture(&FILES).await;
    let job = fixture
        .queue
        .enqueue(NewJob::full_index("p1", &fixture.collection))
        .await
        .expect("入队");
    let (_tx, rx) = watch::channel(false);
    let worker = Worker::new(fixture.queue.clone(), handler(&fixture, 2), rx);
    let finished = worker.run_once().await.expect("执行").expect("有任务");
    assert_eq!(finished.id, job.id);
    assert_eq!(finished.state, JobState::Done);
    assert_eq!(finished.progress_done, FILES.len() as u64);
    assert_eq!(finished.progress_total, Some(FILES.len() as u64));
    assert!(finished.rate.is_some_and(|rate| rate > 0.0), "应记录速率");
    assert!(finished.started_at.is_some());
    assert!(finished.finished_at.is_some());
    let checkpoint: serde_json::Value =
        serde_json::from_str(finished.checkpoint_json.as_deref().expect("检查点")).expect("解析");
    assert_eq!(checkpoint["next"], FILES.len());
    assert_eq!(checkpoint["errors"], 0);
    // ETA:剩余 5 个文件 × 每个 2 块 ÷ 2 块/秒 = 5 秒
    assert_eq!(
        kb_service::jobs::queue::eta_seconds(5, Some(10), 10, Some(2.0)),
        Some(5.0)
    );
}

/// 一片超过时间预算就在文件之间收尾:这里预算为 0,每片只做一个文件;
/// 任务照样一片一片做完,结果与不限时一致,检查点每片前进一个文件(worker 借此有机会让给更高优先级的任务)。
#[tokio::test]
async fn a_slice_stops_between_files_once_its_time_budget_is_spent() {
    let fixture = fixture(&FILES).await;
    fixture
        .queue
        .enqueue(NewJob::full_index("p1", &fixture.collection))
        .await
        .expect("入队");
    let handler = IndexJobHandler::new(fixture.service.clone(), fixture.env.meta.clone(), 50)
        .with_slice_budget(Duration::ZERO);
    let job = fixture.queue.next().await.expect("取任务").expect("有任务");
    let job = fixture.queue.start(&job).await.expect("开始");

    let first = handler.run_slice(&job).await.expect("第一片");
    assert_eq!(first.done, 1, "预算用完后每片也至少做完一个文件,保证在前进");
    assert!(!first.finished);
    let checkpoint: serde_json::Value =
        serde_json::from_str(first.checkpoint.as_deref().expect("检查点")).expect("解析");
    assert_eq!(checkpoint["next"], 1);

    let mut job = fixture
        .queue
        .progress(&job, first.done, first.total, None, first.checkpoint)
        .await
        .expect("记进度");
    let mut slices = 1;
    loop {
        let progress = handler.run_slice(&job).await.expect("下一片");
        slices += 1;
        if progress.finished {
            assert_eq!(progress.done, FILES.len() as u64);
            break;
        }
        job = fixture
            .queue
            .progress(
                &job,
                progress.done,
                progress.total,
                None,
                progress.checkpoint,
            )
            .await
            .expect("记进度");
        assert!(slices <= FILES.len() + 1, "每片都应前进");
    }
    assert_eq!(slices, FILES.len(), "N 个文件、每片一个");
}

/// 后台同时跑多个任务:一个任务在等嵌入时,别的任务能开始。
///
/// 以前一个知识库只有一个 worker、一次只跑一个任务:一次导入几百个单文件批次时,
/// 一个文件在嵌入,其余文件连解析都排不上,机器大半时间是闲的。
/// 这条用例同时守住「认领必须是原子的」:8 个循环抢 8 个任务,谁都不能重复领。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn worker_runs_several_jobs_at_once() {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct Counting {
        runs: AtomicUsize,
        active: AtomicUsize,
        peak: AtomicUsize,
        seen: Mutex<Vec<String>>,
    }

    #[async_trait]
    impl JobHandler for Counting {
        async fn run_slice(&self, job: &Job) -> kb_core::Result<SliceProgress> {
            self.runs.fetch_add(1, Ordering::SeqCst);
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            self.seen.lock().expect("没被毒化").push(job.id.clone());
            tokio::time::sleep(Duration::from_millis(80)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(SliceProgress {
                done: 1,
                total: Some(1),
                finished: true,
                ..Default::default()
            })
        }
    }

    let fixture = fixture(&FILES).await;
    let handler = Arc::new(Counting::default());
    const JOBS: usize = 8;
    let mut ids = Vec::new();
    for index in 0..JOBS {
        let job = fixture
            .queue
            .enqueue(NewJob {
                kind: "slow".to_owned(),
                collection: Some(format!("proj_{index}")),
                priority: 20,
                payload: serde_json::json!({ "n": index }),
            })
            .await
            .expect("入队");
        ids.push(job.id);
    }

    let (tx, rx) = watch::channel(false);
    let worker = Arc::new(Worker::new(fixture.queue.clone(), handler.clone(), rx));
    let running = tokio::spawn({
        let worker = worker.clone();
        async move { worker.run().await }
    });

    let queue = fixture.queue.clone();
    let all_done = ids.clone();
    assert!(
        wait_until(Duration::from_secs(10), || {
            let queue = queue.clone();
            let all_done = all_done.clone();
            async move {
                for id in &all_done {
                    match queue.get(id).await.expect("查询") {
                        Some(job) if job.state == JobState::Done => {}
                        _ => return false,
                    }
                }
                true
            }
        })
        .await,
        "8 个任务都该跑完"
    );
    assert!(
        handler.peak.load(Ordering::SeqCst) > 1,
        "峰值并发是 1,说明后台还是一次只跑一个任务"
    );
    let mut seen = handler.seen.lock().expect("没被毒化").clone();
    seen.sort();
    let mut expected = ids.clone();
    expected.sort();
    assert_eq!(seen, expected, "每个任务只能被认领一次,不能重不能漏");

    let _ = tx.send(true);
    running.await.expect("worker 正常退出").expect("无错误");
}

/// 上传解析虽然优先级很高(90,要排在积压前面),但它是批量活:走批量名额。
///
/// 只看优先级分通道时,几百个单文件批次全挤在 2 个交互名额上,`index.parallel_slices`
/// 配多大都只有 2 个文件在跑(生产上实测:290 个排队批次、2 个在跑)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn upload_batches_use_the_bulk_lane_not_the_interactive_one() {
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct Holding {
        active: AtomicUsize,
        peak: AtomicUsize,
    }

    #[async_trait]
    impl JobHandler for Holding {
        async fn run_slice(&self, _job: &Job) -> kb_core::Result<SliceProgress> {
            let now = self.active.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(150)).await;
            self.active.fetch_sub(1, Ordering::SeqCst);
            Ok(SliceProgress {
                done: 1,
                total: Some(1),
                finished: true,
                ..Default::default()
            })
        }
    }

    let fixture = fixture(&FILES).await;
    const BATCHES: usize = 4;
    for index in 0..BATCHES {
        fixture
            .queue
            .enqueue(NewJob {
                kind: kb_service::jobs::queue::kind::INGEST.to_owned(),
                collection: Some(fixture.collection.clone()),
                priority: kb_service::jobs::queue::priority::INGEST_UPLOAD,
                payload: serde_json::json!({ "batch_id": format!("b{index}") }),
            })
            .await
            .expect("入队上传批次");
    }

    let handler = Arc::new(Holding::default());
    let (tx, rx) = watch::channel(false);
    let worker = Arc::new(
        Worker::new(fixture.queue.clone(), handler.clone(), rx)
            .with_slots(kb_service::jobs::slots::SliceGate::fixed(BATCHES)),
    );
    let running = tokio::spawn({
        let worker = worker.clone();
        async move { worker.run().await }
    });

    let peak = handler.clone();
    assert!(
        wait_until(Duration::from_secs(10), || {
            let peak = peak.clone();
            async move { peak.peak.load(Ordering::SeqCst) >= BATCHES }
        })
        .await,
        "批量名额给了 {BATCHES} 个,上传批次应跑满;实测峰值 {},交互通道只有 2 个位置",
        handler.peak.load(Ordering::SeqCst)
    );

    let _ = tx.send(true);
    running.await.expect("worker 正常退出").expect("无错误");
}
