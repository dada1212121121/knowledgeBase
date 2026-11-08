//! 索引任务的两个可靠性问题(体检 早期、AI):
//!
//! - 早期:文件在任务开头的扫描快照里,处理它之前已被删。以前读盘失败被记成 `FileChange::Error`、
//!   `checkpoint.errors += 1`、WARN;现在磁盘上确实没了就按删除处理。
//! - AI:文件内容哈希没变、只是修改时间变了,以前直接跳过却不把新的 size / mtime 写回 `files`,
//!   夜间 `fingerprint_diff`(比 size + mtime)因此每晚都把它当成「变了」重复排任务。
//!
//! 全部走隔离夹具:真实的 SQLite / Lance(临时目录)、确定性的 `FakeEmbedder`、真实的 `FsScanner`。

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use chrono::{TimeZone, Utc};
use kb_core::model::{
    Collection, FileChange, FileRecord, Job, JobFile, JobState, Page, Project, ScanOutcome,
    ScanRequest,
};
use kb_core::ports::Scanner;
use kb_core::ports::repo::{ChunkRepo, FileRepo, JobRepo, ProjectRepo};
use kb_service::jobs::{IndexJobHandler, JobHandler, JobQueue, NewJob, Worker};
use kb_service::scheduler::{FixedClock, ScheduleOptions, Scheduler};
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;
use tokio::sync::watch;

const SAMPLE: &str = "fn alpha() -> u32 {\n    1\n}\n\nfn beta() -> u32 {\n    2\n}\n\nfn gamma() -> u32 {\n    3\n}\n";

struct Fixture {
    env: TestEnv,
    dir: TempDir,
    project: Project,
    collection: Collection,
    /// 用真实 `FsScanner` 的索引服务。
    service: Arc<IndexService>,
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
        .expect("建 collection");
    let service = service_with(&env, env.scanner.clone());
    let fixture = Fixture {
        env,
        dir,
        project,
        collection,
        service,
    };
    // 先把初始文件全部索引好,后面每条用例都从「已经索引过」的状态出发
    let report = fixture
        .service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("首次索引");
    assert!(report.errors.is_empty(), "首次索引出错:{:?}", report.errors);
    fixture
}

fn service_with(env: &TestEnv, scanner: Arc<dyn Scanner>) -> Arc<IndexService> {
    Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        scanner,
        IndexOptions::default(),
    ))
}

fn write_file(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

/// 把文件的修改时间设成指定的 Unix 毫秒(内容不动)。
fn set_mtime_millis(path: &Path, millis: i64) {
    let time = UNIX_EPOCH + Duration::from_millis(millis as u64);
    std::fs::File::options()
        .write(true)
        .open(path)
        .expect("打开文件")
        .set_modified(time)
        .expect("改修改时间");
}

/// 「扫描完成之后、处理文件之前」磁盘又变了的扫描器。
///
/// 先交给真实扫描器扫一遍(结果里仍然有那个文件,就是任务开头的快照),
/// 再执行一次 `after_scan`(例如把文件删掉),只执行第一次,后面的扫描原样返回。
/// 这正是生产上编辑器临时文件 / 目录改名造成的竞态。
struct RacingScanner {
    inner: Arc<dyn Scanner>,
    after_scan: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl RacingScanner {
    fn new(inner: Arc<dyn Scanner>, after_scan: impl FnOnce() + Send + 'static) -> Arc<Self> {
        Arc::new(Self {
            inner,
            after_scan: Mutex::new(Some(Box::new(after_scan))),
        })
    }
}

impl Scanner for RacingScanner {
    fn scan(&self, request: &ScanRequest) -> kb_core::Result<ScanOutcome> {
        let outcome = self.inner.scan(request)?;
        if let Some(action) = self.after_scan.lock().expect("锁").take() {
            action();
        }
        Ok(outcome)
    }
}

/// 入队并把队列跑空,返回跑完后的任务。
async fn run_job(fixture: &Fixture, service: Arc<IndexService>, new_job: NewJob) -> Job {
    let queue = Arc::new(JobQueue::new(fixture.env.meta.clone()));
    let job = queue.enqueue(new_job).await.expect("入队");
    run_queue(fixture, service, queue.clone()).await;
    queue.get(&job.id).await.expect("查任务").expect("任务在")
}

/// 把队列里已有的任务跑空(夜间校验自己会往同一个元数据库里投递任务)。
async fn run_queue(fixture: &Fixture, service: Arc<IndexService>, queue: Arc<JobQueue>) {
    let handler: Arc<dyn JobHandler> =
        Arc::new(IndexJobHandler::new(service, fixture.env.meta.clone(), 50));
    let (_shutdown, rx) = watch::channel(false);
    Worker::new(queue, handler, rx)
        .run_until_idle()
        .await
        .expect("跑任务");
}

async fn job_files(fixture: &Fixture, job: &Job) -> Vec<JobFile> {
    JobRepo::list_job_files(
        fixture.env.meta.as_ref(),
        &job.id,
        Page {
            limit: 100,
            offset: 0,
        },
    )
    .await
    .expect("任务文件清单")
    .0
}

fn change_of_path(files: &[JobFile], path: &str) -> FileChange {
    files
        .iter()
        .find(|file| file.path == path)
        .unwrap_or_else(|| panic!("job_files 里应有 {path}:{files:?}"))
        .change
}

/// 任务检查点里的错误数(`checkpoint.errors`)。
fn checkpoint_errors(job: &Job) -> u64 {
    let checkpoint: serde_json::Value =
        serde_json::from_str(job.checkpoint_json.as_deref().expect("任务应有检查点"))
            .expect("检查点是 JSON");
    checkpoint["errors"].as_u64().expect("检查点里有 errors")
}

async fn file_record(fixture: &Fixture, path: &str) -> Option<FileRecord> {
    FileRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name, path)
        .await
        .expect("查 files")
}

async fn chunk_metas(fixture: &Fixture, path: &str) -> Vec<kb_core::model::ChunkMeta> {
    ChunkRepo::by_path(fixture.env.meta.as_ref(), &fixture.collection.name, path)
        .await
        .expect("查 chunks")
}

async fn store_rows(fixture: &Fixture) -> u64 {
    fixture
        .env
        .store
        .count(&fixture.collection.active_table, None)
        .await
        .expect("向量库行数")
}

/// 扫描磁盘取某个文件当下的条目(带真实的 size / mtime)。
fn scan_entry(fixture: &Fixture, relative: &str) -> kb_core::model::ScanEntry {
    fixture
        .service
        .scan_project(&fixture.project)
        .expect("扫描")
        .files
        .into_iter()
        .find(|entry| entry.relative == relative)
        .unwrap_or_else(|| panic!("扫描结果里应有 {relative}"))
}

// ───────────────────────── 早期:文件在入队后消失 ─────────────────────────

/// 公共场景:`gone.rs` 与 `keep.rs` 都已索引;任务扫描完之后 `gone.rs` 被删。
/// `new_job` 决定跑增量还是全量。
async fn run_job_while_a_file_vanishes(new_job: NewJob) -> (Fixture, Job, u64, usize) {
    let fixture = fixture(&[("gone.rs", SAMPLE), ("keep.rs", "fn keep() {}\n")]).await;
    let gone_chunks = chunk_metas(&fixture, "gone.rs").await.len();
    assert!(gone_chunks > 0, "前提:gone.rs 已有块");
    assert!(file_record(&fixture, "gone.rs").await.is_some());
    let rows_before = store_rows(&fixture).await;

    let victim = fixture.dir.path().join("gone.rs");
    let racing = RacingScanner::new(fixture.env.scanner.clone(), move || {
        std::fs::remove_file(&victim).expect("删文件");
    });
    let service = service_with(&fixture.env, racing);
    let job = run_job(&fixture, service, new_job).await;
    (fixture, job, rows_before, gone_chunks)
}

async fn assert_vanished_file_was_cleaned_as_a_delete(
    fixture: &Fixture,
    job: &Job,
    rows_before: u64,
    gone_chunks: usize,
) {
    assert_eq!(job.state, JobState::Done, "任务应正常结束:{job:?}");
    assert_eq!(job.error, None, "消失的文件不是任务错误:{:?}", job.error);
    assert_eq!(checkpoint_errors(job), 0, "checkpoint.errors 应为 0");

    let files = job_files(fixture, job).await;
    assert!(
        files.iter().all(|file| file.change != FileChange::Error),
        "job_files 里不该有 Error:{files:?}"
    );
    assert_eq!(change_of_path(&files, "gone.rs"), FileChange::Delete);
    let gone = files.iter().find(|file| file.path == "gone.rs").unwrap();
    assert_eq!(gone.deleted_chunks, gone_chunks, "要记下清掉了多少块");
    assert_eq!(gone.error, None);

    assert!(
        file_record(fixture, "gone.rs").await.is_none(),
        "files 行应被清掉"
    );
    assert!(
        chunk_metas(fixture, "gone.rs").await.is_empty(),
        "chunks 应被清掉"
    );
    assert_eq!(
        store_rows(fixture).await,
        rows_before - gone_chunks as u64,
        "向量库里 gone.rs 的块应被删掉,别的文件的不动"
    );
    assert!(
        file_record(fixture, "keep.rs").await.is_some(),
        "没消失的文件不受影响"
    );
}

#[tokio::test]
async fn incremental_job_treats_a_file_deleted_after_the_scan_as_a_delete() {
    let (fixture, job, rows_before, gone_chunks) =
        run_job_while_a_file_vanishes(NewJob::incremental_index(
            "p1",
            "proj_demo",
            &["gone.rs".to_owned(), "keep.rs".to_owned()],
        ))
        .await;
    assert_vanished_file_was_cleaned_as_a_delete(&fixture, &job, rows_before, gone_chunks).await;
    let files = job_files(&fixture, &job).await;
    assert_eq!(change_of_path(&files, "keep.rs"), FileChange::Skip);
}

#[tokio::test]
async fn full_job_treats_a_file_deleted_after_the_scan_as_a_delete() {
    // 全量任务结束时的 `remove_vanished` 用的是同一份扫描快照(里面还有这个文件),
    // 清不到它:只有逐文件的失败分支处理对了,这条才会绿。
    let (fixture, job, rows_before, gone_chunks) =
        run_job_while_a_file_vanishes(NewJob::full_index("p1", "proj_demo")).await;
    assert_vanished_file_was_cleaned_as_a_delete(&fixture, &job, rows_before, gone_chunks).await;
}

#[tokio::test]
async fn a_file_that_still_exists_but_cannot_be_read_is_still_an_error() {
    // 对照组:读不了但还在磁盘上,不能当删除清掉它的索引。
    // 测试进程可能是 root(权限位 0o000 对 root 无效),所以用「原路径换成同名目录」制造读失败:
    // 路径仍然存在,`std::fs::read` 报 EISDIR。
    let fixture = fixture(&[("broken.rs", SAMPLE), ("keep.rs", "fn keep() {}\n")]).await;
    let chunks_before = chunk_metas(&fixture, "broken.rs").await;
    assert!(!chunks_before.is_empty(), "前提:broken.rs 已有块");
    let record_before = file_record(&fixture, "broken.rs").await.expect("files 行");
    let rows_before = store_rows(&fixture).await;

    let victim = fixture.dir.path().join("broken.rs");
    let racing = RacingScanner::new(fixture.env.scanner.clone(), move || {
        std::fs::remove_file(&victim).expect("删文件");
        std::fs::create_dir(&victim).expect("换成同名目录");
    });
    let service = service_with(&fixture.env, racing);
    let job = run_job(
        &fixture,
        service,
        NewJob::incremental_index(
            "p1",
            "proj_demo",
            &["broken.rs".to_owned(), "keep.rs".to_owned()],
        ),
    )
    .await;

    assert_eq!(job.state, JobState::Done);
    assert_eq!(checkpoint_errors(&job), 1, "读不了的文件仍计入错误");
    assert!(
        job.error
            .as_deref()
            .is_some_and(|e| e.contains("broken.rs")),
        "错误样本里应点名这个文件:{:?}",
        job.error
    );
    let files = job_files(&fixture, &job).await;
    assert_eq!(change_of_path(&files, "broken.rs"), FileChange::Error);
    let broken = files.iter().find(|file| file.path == "broken.rs").unwrap();
    assert!(broken.error.is_some(), "Error 要带原因");
    assert_eq!(change_of_path(&files, "keep.rs"), FileChange::Skip);

    // 失败不改动已有索引
    assert_eq!(
        file_record(&fixture, "broken.rs").await,
        Some(record_before)
    );
    assert_eq!(chunk_metas(&fixture, "broken.rs").await, chunks_before);
    assert_eq!(store_rows(&fixture).await, rows_before);
}

// ───────────────────────── AI:哈希一致时刷新指纹 ─────────────────────────

#[tokio::test]
async fn touching_a_file_refreshes_size_and_mtime_without_embedding() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    let record_before = file_record(&fixture, "src/lib.rs").await.expect("files 行");
    let chunks_before = chunk_metas(&fixture, "src/lib.rs").await;
    assert!(!chunks_before.is_empty());

    // 只改修改时间(git checkout、同步工具、touch 都是这样),内容一个字节不动
    let new_mtime = record_before.mtime + 3_600_000;
    set_mtime_millis(&fixture.dir.path().join("src/lib.rs"), new_mtime);
    let entry = scan_entry(&fixture, "src/lib.rs");
    assert_eq!(entry.mtime, new_mtime, "前提:磁盘上的 mtime 已经变了");
    assert_ne!(entry.mtime, record_before.mtime);

    fixture.env.fake.reset_count();
    let stats = fixture
        .service
        .index_entry(&fixture.project, &fixture.collection, &entry)
        .await
        .expect("增量索引");
    assert_eq!(stats.embedded, 0, "内容没变不该嵌入:{stats:?}");
    assert_eq!(stats.updated_meta, 0);
    assert_eq!(stats.deleted_chunks, 0);
    assert_eq!(stats.chunks, chunks_before.len(), "仍把已有块数计入");
    assert_eq!(fixture.env.fake.embedding_count(), 0);

    let record_after = file_record(&fixture, "src/lib.rs").await.expect("files 行");
    assert_eq!(record_after.mtime, new_mtime, "新的 mtime 应被写回");
    assert_eq!(record_after.size, entry.size);
    // 其余字段原样保留:不是一次「重新索引」
    assert_eq!(
        record_after,
        FileRecord {
            mtime: new_mtime,
            ..record_before
        }
    );
    assert_eq!(
        chunk_metas(&fixture, "src/lib.rs").await,
        chunks_before,
        "块一行都不动(包括 updated_at)"
    );
}

#[tokio::test]
async fn an_untouched_file_is_not_rewritten() {
    // 指纹本来就对得上时不该白写一次 files(也就不动 indexed_at 之外的任何东西)
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    let before = file_record(&fixture, "src/lib.rs").await.expect("files 行");
    let entry = scan_entry(&fixture, "src/lib.rs");
    fixture.env.fake.reset_count();
    let stats = fixture
        .service
        .index_entry(&fixture.project, &fixture.collection, &entry)
        .await
        .expect("增量索引");
    assert_eq!(stats.embedded, 0);
    assert_eq!(fixture.env.fake.embedding_count(), 0);
    assert_eq!(file_record(&fixture, "src/lib.rs").await, Some(before));
}

#[tokio::test]
async fn nightly_stops_resyncing_a_touched_file_after_one_round() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE), ("src/other.rs", "fn other() {}\n")]).await;
    let clock = Arc::new(FixedClock::new(
        Utc.with_ymd_and_hms(2026, 10, 20, 3, 5, 0).unwrap(),
    ));
    let scheduler = Scheduler::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.service.clone(),
        ScheduleOptions::default(),
        clock,
    );
    assert_eq!(
        scheduler.nightly().await.expect("夜间校验").resynced,
        0,
        "前提:刚索引完指纹一致"
    );

    // 只改 mtime
    let record = file_record(&fixture, "src/lib.rs").await.expect("files 行");
    set_mtime_millis(
        &fixture.dir.path().join("src/lib.rs"),
        record.mtime + 3_600_000,
    );

    let first = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(first.resynced, 1, "第一次:指纹对不上,投递一个增量任务");

    // 跑掉刚投递的任务:内容没变 → 不嵌入,只补记指纹
    let queue = Arc::new(JobQueue::new(fixture.env.meta.clone()));
    let handler: Arc<dyn JobHandler> = Arc::new(IndexJobHandler::new(
        fixture.service.clone(),
        fixture.env.meta.clone(),
        50,
    ));
    let (_shutdown, rx) = watch::channel(false);
    fixture.env.fake.reset_count();
    let job = Worker::new(queue, handler, rx)
        .run_once()
        .await
        .expect("跑任务")
        .expect("夜间校验投递的任务");
    assert_eq!(job.state, JobState::Done);
    assert_eq!(fixture.env.fake.embedding_count(), 0, "不该重新嵌入");
    let files = job_files(&fixture, &job).await;
    assert_eq!(change_of_path(&files, "src/lib.rs"), FileChange::Skip);

    let second = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(
        second.resynced, 0,
        "第二次:指纹已补记,不该再投递:{second:?}"
    );
}

#[tokio::test]
async fn changed_content_is_still_embedded() {
    // 回归:跳过条件只认内容哈希,不能因为补记指纹就放宽。
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    let path = fixture.dir.path().join("src/lib.rs");
    let before = file_record(&fixture, "src/lib.rs").await.expect("files 行");

    // 1) 内容变了、长度和修改时间都不变(夜间校验看不出来,但哈希能):必须重新嵌入
    let tampered = SAMPLE.replace("    1\n", "    7\n");
    assert_eq!(tampered.len(), SAMPLE.len());
    std::fs::write(&path, &tampered).expect("改内容");
    set_mtime_millis(&path, before.mtime);
    let entry = scan_entry(&fixture, "src/lib.rs");
    assert_eq!((entry.size, entry.mtime), (before.size, before.mtime));
    fixture.env.fake.reset_count();
    let stats = fixture
        .service
        .index_entry(&fixture.project, &fixture.collection, &entry)
        .await
        .expect("增量索引");
    assert!(stats.embedded > 0, "内容变了必须重新嵌入:{stats:?}");
    assert!(fixture.env.fake.embedding_count() > 0);
    let after = file_record(&fixture, "src/lib.rs").await.expect("files 行");
    assert_ne!(after.file_hash, before.file_hash, "哈希要更新");

    // 2) 内容和修改时间都变了:照样重新嵌入,并记下新的 size / mtime
    let grown = format!("{tampered}\nfn delta() -> u32 {{\n    4\n}}\n");
    std::fs::write(&path, &grown).expect("改内容");
    set_mtime_millis(&path, before.mtime + 7_200_000);
    let entry = scan_entry(&fixture, "src/lib.rs");
    fixture.env.fake.reset_count();
    let stats = fixture
        .service
        .index_entry(&fixture.project, &fixture.collection, &entry)
        .await
        .expect("增量索引");
    assert!(stats.embedded > 0, "内容变了必须重新嵌入:{stats:?}");
    let last = file_record(&fixture, "src/lib.rs").await.expect("files 行");
    assert_eq!(last.size, grown.len() as u64);
    assert_eq!(last.mtime, before.mtime + 7_200_000);
    assert_ne!(last.file_hash, after.file_hash);
}
