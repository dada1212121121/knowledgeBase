//! 崩溃恢复与检查点定位。

use std::path::Path;
use std::sync::Arc;

use kb_core::model::{Job, JobState, Project};
use kb_core::ports::repo::{ChunkRepo, FileRepo, JobRepo, MetaStore, ProjectRepo};
use kb_service::jobs::{IndexJobHandler, JobHandler, JobQueue, NewJob, SliceProgress, Worker};
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;
use tokio::sync::watch;

struct Fixture {
    env: TestEnv,
    #[allow(dead_code)]
    dir: TempDir,
    project: Project,
    collection: String,
    service: Arc<IndexService>,
    queue: Arc<JobQueue>,
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
        collection,
        service,
        queue,
    }
}

fn write_file(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

fn handler(fixture: &Fixture) -> Arc<dyn JobHandler> {
    Arc::new(IndexJobHandler::new(
        fixture.service.clone(),
        fixture.env.meta.clone(),
        1,
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

/// 跑一个分片,返回进度。
async fn run_one_slice(fixture: &Fixture, job: &Job) -> (Job, SliceProgress) {
    let handler = handler(fixture);
    let progress = handler.run_slice(job).await.expect("执行分片");
    let updated = fixture
        .queue
        .progress(
            job,
            progress.done,
            progress.total,
            Some(1.0),
            progress.checkpoint.clone(),
        )
        .await
        .expect("更新进度");
    (updated, progress)
}

const FILES: [(&str, &str); 6] = [
    ("src/a.rs", "fn a() -> u32 {\n    1\n}\n"),
    ("src/b.rs", "fn b() -> u32 {\n    2\n}\n"),
    ("src/c.rs", "fn c() -> u32 {\n    3\n}\n"),
    ("src/d.rs", "fn d() -> u32 {\n    4\n}\n"),
    ("src/e.rs", "fn e() -> u32 {\n    5\n}\n"),
    ("src/f.rs", "fn f() -> u32 {\n    6\n}\n"),
];

#[tokio::test]
async fn crashed_job_is_recovered_and_resumes_to_the_same_result() {
    // 参照组:不中断
    let reference = fixture(&FILES).await;
    let reference_collection = CollectionService::new(
        reference.env.meta.clone(),
        reference.env.store.clone(),
        reference.env.embedder.clone(),
    )
    .get(&reference.collection)
    .await
    .expect("查")
    .expect("存在");
    reference
        .service
        .index_project(&reference.project, &reference_collection)
        .await
        .expect("参照索引");
    let expected = chunk_hashes(reference.env.meta.as_ref(), &reference.collection).await;
    assert_eq!(expected.len(), FILES.len());

    // 实验组:只跑 2 个分片,然后“崩溃”(任务停在 running)
    let crashed = fixture(&FILES).await;
    let job = crashed
        .queue
        .enqueue(NewJob::full_index("p1", &crashed.collection))
        .await
        .expect("入队");
    let mut running = crashed.queue.start(&job).await.expect("开始");
    for _ in 0..2 {
        let (updated, _progress) = run_one_slice(&crashed, &running).await;
        running = updated;
    }
    // 模拟崩溃:任务保持 running,没有任何人把它改回 queued
    let stale = crashed
        .queue
        .get(&job.id)
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(stale.state, JobState::Running);
    assert!(stale.progress_done >= 2);

    // 重启:recover 必须把它改回 queued
    let recovered = crashed.queue.recover().await.expect("恢复");
    assert_eq!(recovered, 1, "崩溃留下的 running 任务应被恢复");
    assert_eq!(
        crashed
            .queue
            .get(&job.id)
            .await
            .expect("查询")
            .expect("存在")
            .state,
        JobState::Queued
    );

    let (_tx, rx) = watch::channel(false);
    let worker = Worker::new(crashed.queue.clone(), handler(&crashed), rx);
    while worker.run_once().await.expect("续跑").is_some() {}

    let finished = crashed
        .queue
        .get(&job.id)
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(finished.state, JobState::Done);
    assert_eq!(finished.progress_done, FILES.len() as u64);
    assert_eq!(
        chunk_hashes(crashed.env.meta.as_ref(), &crashed.collection).await,
        expected,
        "崩溃恢复后的 chunks 哈希集合应与不中断时一致"
    );
    // 所有文件都有 files 行(检查点按路径定位,不会因为 mtime 变化漏文件)
    assert_eq!(
        FileRepo::list_paths(crashed.env.meta.as_ref(), &crashed.collection)
            .await
            .expect("列路径")
            .len(),
        FILES.len()
    );
}

#[tokio::test]
async fn checkpoint_survives_files_changing_between_slices() {
    let interrupted = fixture(&FILES).await;
    let job = interrupted
        .queue
        .enqueue(NewJob::full_index("p1", &interrupted.collection))
        .await
        .expect("入队");
    let mut running = interrupted.queue.start(&job).await.expect("开始");
    let (updated, _) = run_one_slice(&interrupted, &running).await;
    running = updated;
    let checkpoint: serde_json::Value =
        serde_json::from_str(running.checkpoint_json.as_deref().expect("检查点")).expect("解析");
    let frozen: Vec<String> = checkpoint["paths"]
        .as_array()
        .expect("paths")
        .iter()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect();
    assert_eq!(frozen.len(), FILES.len(), "检查点应固化文件列表");

    // 让出后修改一个尚未处理的文件(它的 mtime 变新,排序会跑到最前面)
    let remaining = frozen
        .get(running.progress_done as usize)
        .expect("还有未处理的文件")
        .clone();
    let path = interrupted.dir.path().join(&remaining);
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(&path, "fn changed() -> u32 {\n    42\n}\n").expect("改动文件");
    interrupted.queue.yield_job(&running).await.expect("让出");

    // 续跑
    let (_tx, rx) = watch::channel(false);
    let worker = Worker::new(interrupted.queue.clone(), handler(&interrupted), rx);
    while worker.run_once().await.expect("续跑").is_some() {}

    let finished = interrupted
        .queue
        .get(&job.id)
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(finished.state, JobState::Done);
    let paths = FileRepo::list_paths(interrupted.env.meta.as_ref(), &interrupted.collection)
        .await
        .expect("列路径");
    assert_eq!(
        paths.len(),
        FILES.len(),
        "所有文件都应被索引(不能因为 mtime 变化漏掉):{paths:?}"
    );
    // 被改动的文件用的是新内容
    let changed = ChunkRepo::by_path(
        interrupted.env.meta.as_ref(),
        &interrupted.collection,
        &remaining,
    )
    .await
    .expect("读块");
    assert!(!changed.is_empty());
    assert_eq!(changed.len(), 1);
}

#[tokio::test]
async fn skipped_files_are_recorded_and_not_treated_as_vanished() {
    let fixture = fixture(&[
        ("src/a.rs", "fn a() -> u32 {\n    1\n}\n"),
        ("assets/logo.png", "\u{0}\u{0}binary"),
        ("gen.rs", "// @generated\nfn g() {}\n"),
    ])
    .await;
    let collection = CollectionService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    )
    .get(&fixture.collection)
    .await
    .expect("查")
    .expect("存在");
    let report = fixture
        .service
        .index_project(&fixture.project, &collection)
        .await
        .expect("索引");
    assert_eq!(report.deleted_files, 0, "被过滤的文件不应算作消失");

    let files = FileRepo::list_paths(fixture.env.meta.as_ref(), &fixture.collection)
        .await
        .expect("列路径");
    assert!(
        files.contains(&"assets/logo.png".to_owned()),
        "files={files:?}"
    );
    assert!(files.contains(&"gen.rs".to_owned()), "files={files:?}");
    let logo = FileRepo::get(
        fixture.env.meta.as_ref(),
        &fixture.collection,
        "assets/logo.png",
    )
    .await
    .expect("查")
    .expect("存在");
    assert_eq!(logo.status, "binary");
    assert!(
        logo.error
            .as_deref()
            .is_some_and(|error| error.contains("二进制"))
    );
    let generated = FileRepo::get(fixture.env.meta.as_ref(), &fixture.collection, "gen.rs")
        .await
        .expect("查")
        .expect("存在");
    assert_eq!(generated.status, "generated");

    // 再跑一次:记录仍在,不会被当成“消失”
    let again = fixture
        .service
        .index_project(&fixture.project, &collection)
        .await
        .expect("再次索引");
    assert_eq!(again.deleted_files, 0);
    assert_eq!(
        FileRepo::list_paths(fixture.env.meta.as_ref(), &fixture.collection)
            .await
            .expect("列路径")
            .len(),
        3
    );
}

#[tokio::test]
async fn renaming_through_the_job_path_reindexes_under_the_new_name() {
    let fixture = fixture(&[("src/old.rs", "fn only() -> u32 {\n    1\n}\n")]).await;
    let worker = Worker::new(
        fixture.queue.clone(),
        handler(&fixture),
        watch::channel(false).1,
    );
    fixture
        .queue
        .enqueue(NewJob::full_index("p1", &fixture.collection))
        .await
        .expect("入队");
    while worker.run_once().await.expect("跑").is_some() {}
    fixture.env.fake.reset_count();

    std::fs::rename(
        fixture.dir.path().join("src/old.rs"),
        fixture.dir.path().join("src/new.rs"),
    )
    .expect("重命名");
    fixture
        .queue
        .enqueue(NewJob::full_index("p1", &fixture.collection))
        .await
        .expect("入队");
    while worker.run_once().await.expect("跑").is_some() {}

    assert!(
        ChunkRepo::by_path(fixture.env.meta.as_ref(), &fixture.collection, "src/old.rs")
            .await
            .expect("读块")
            .is_empty(),
        "旧路径的块应删除"
    );
    assert_eq!(
        ChunkRepo::by_path(fixture.env.meta.as_ref(), &fixture.collection, "src/new.rs")
            .await
            .expect("读块")
            .len(),
        1
    );
    assert_eq!(
        fixture.env.fake.embedding_count(),
        1,
        "新路径应重新嵌入一次"
    );
}

#[tokio::test]
async fn incremental_paths_that_disappeared_are_cleaned() {
    let fixture = fixture(&[("src/a.rs", "fn a() -> u32 {\n    1\n}\n")]).await;
    // 先全量索引,让 a.rs 有块
    let (_tx, rx) = watch::channel(false);
    let job = fixture
        .queue
        .enqueue(NewJob::full_index("p1", &fixture.collection))
        .await
        .expect("入队");
    let worker = Worker::new(fixture.queue.clone(), handler(&fixture), rx);
    while worker.run_once().await.expect("跑").is_some() {}
    assert_eq!(
        ChunkRepo::by_path(fixture.env.meta.as_ref(), &fixture.collection, "src/a.rs")
            .await
            .expect("读块")
            .len(),
        1
    );

    // 删掉文件,再投一个针对它的增量任务
    std::fs::remove_file(fixture.dir.path().join("src/a.rs")).expect("删除文件");
    fixture
        .queue
        .enqueue(NewJob::incremental_index(
            "p1",
            &fixture.collection,
            &["src/a.rs".to_owned()],
        ))
        .await
        .expect("入队增量");
    let worker = Worker::new(
        fixture.queue.clone(),
        handler(&fixture),
        watch::channel(false).1,
    );
    while worker.run_once().await.expect("跑").is_some() {}

    assert!(
        ChunkRepo::by_path(fixture.env.meta.as_ref(), &fixture.collection, "src/a.rs")
            .await
            .expect("读块")
            .is_empty(),
        "已删除文件的旧块应被清掉"
    );
    let _ = JobRepo::get(fixture.env.meta.as_ref(), &job.id)
        .await
        .expect("查");
}
