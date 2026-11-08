//! 调度器(可注入时钟)。

use std::sync::Arc;

use chrono::{DateTime, FixedOffset, TimeZone, Utc};
use kb_core::model::{ItemStatus, RecordKind, RecordRow};
use kb_service::scheduler::{
    Clock, FixedClock, QualityGate, QualityMeasure, RetentionHook, ScheduleOptions, Scheduler,
};
use kb_service::{IndexOptions, IndexService};
use kb_testkit::TestEnv;

/// 用例里写的时间都按北京时间理解(全站默认时区),再换算成 UTC 交给 `FixedClock`。
fn at(hour: u32, minute: u32) -> DateTime<Utc> {
    let shanghai = FixedOffset::east_opt(8 * 3600).unwrap();
    shanghai
        .with_ymd_and_hms(2026, 10, 20, hour, minute, 0)
        .unwrap()
        .with_timezone(&Utc)
}

async fn build(clock: Arc<FixedClock>) -> (Scheduler, TestEnv) {
    let env = TestEnv::new().await;
    let scheduler = scheduler_on(&env, clock);
    (scheduler, env)
}

/// 在已有的环境上新建一个调度器(模拟知识库被关掉后重新打开)。
fn scheduler_on(env: &TestEnv, clock: Arc<dyn Clock>) -> Scheduler {
    let index = Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ));
    Scheduler::new(
        env.meta.clone(),
        env.store.clone(),
        index,
        ScheduleOptions {
            nightly_at: "03:00".to_owned(),
            optimize_interval_minutes: 60,
            ..ScheduleOptions::default()
        },
        clock,
    )
}

/// 非主知识库空闲被关掉、下次访问再打开时会新建调度器(后半):带上上一个的进度,
/// 不把 optimize 和当天的夜间校验重跑一遍。
#[tokio::test]
async fn a_new_scheduler_continues_from_the_previous_history() {
    let clock = Arc::new(FixedClock::new(at(10, 0)));
    let (first, env) = build(clock.clone()).await;
    first.tick().await.expect("tick");
    let history = first.history();
    assert!(history.last_optimize.is_some(), "跑过 optimize");
    assert!(history.last_nightly.is_some(), "跑过夜间校验");

    // 对照:不带进度的新调度器以为什么都没跑过,两样都会重跑(这正是要避免的)
    let fresh = scheduler_on(&env, clock.clone()).plan();
    assert!(fresh.optimize && fresh.nightly, "对照组");

    let reopened = scheduler_on(&env, clock).with_history(history);
    let plan = reopened.plan();
    assert!(!plan.optimize, "刚 optimize 过,不该重跑");
    assert!(!plan.nightly, "今天已经跑过夜间校验");
    assert_eq!(reopened.history(), history, "进度原样带过去");

    // 带过去的是时间点本身,不是「跑过」的标记:过了间隔照样 optimize
    let later = Arc::new(FixedClock::new(at(11, 1)));
    let plan = scheduler_on(&env, later).with_history(history).plan();
    assert!(plan.optimize, "上次 optimize 已过 61 分钟");
    assert!(!plan.nightly, "同一天");
}

#[tokio::test]
async fn optimize_runs_once_per_interval() {
    let clock = Arc::new(FixedClock::new(at(10, 0)));
    let (scheduler, _env) = build(clock).await;
    let first = scheduler.plan();
    assert!(first.optimize, "第一次 tick 应做 optimize");
    assert!(
        first.nightly,
        "10:00 已过 03:00 且当天没跑过,首次也会触发夜间校验"
    );

    // 记下“跑过”
    scheduler.tick().await.expect("tick");
    let second = scheduler.plan();
    assert!(!second.optimize, "间隔内不应重复 optimize");
    assert!(!second.nightly, "同一天不应重复夜间校验");
}

#[tokio::test]
async fn nightly_uses_local_time_not_utc() {
    // UTC 10:05(按 UTC 已过 03:00),但本地才 02:35——按本地时间**不该**跑。
    // 用 UTC 判断的旧实现会返回 true,所以这条用例能真的抓住回归。
    let clock = Arc::new(FixedClock::with_local(at(10, 5), 2 * 60 + 35));
    let (scheduler, _env) = build(clock).await;
    assert!(
        !scheduler.plan().nightly,
        "本地 02:35 不该跑夜间校验(旧实现按 UTC 判断会误判为到点)"
    );
    // 同一 UTC 时刻,本地 03:05 → 应触发
    let clock = Arc::new(FixedClock::with_local(at(10, 5), 3 * 60 + 5));
    let (scheduler, _env) = build(clock).await;
    assert!(scheduler.plan().nightly);

    // 跑过一次之后,同一本地日期内不再触发(日期与分钟数必须来自同一套本地时钟)
    scheduler.tick().await.expect("tick");
    assert!(!scheduler.plan().nightly, "同一天不应重复夜间校验");
}

#[tokio::test]
async fn nightly_runs_after_the_configured_time_once_a_day() {
    let clock = Arc::new(FixedClock::new(at(2, 30)));
    let (scheduler, _env) = build(clock).await;
    let plan = scheduler.plan();
    assert!(!plan.nightly, "02:30 还没到 03:00");

    // 时钟前进到 03:00 —— 用一个新的调度器(内存里的 last_nightly 在实例里)
    let clock = Arc::new(FixedClock::new(at(3, 0)));
    let (scheduler, _env) = build(clock).await;
    assert!(scheduler.plan().nightly, "03:00 应触发夜间校验");
    scheduler.tick().await.expect("tick");
    assert!(!scheduler.plan().nightly, "同一天只跑一次");
}

#[tokio::test]
async fn nightly_detects_files_that_changed_on_disk() {
    let clock = Arc::new(FixedClock::new(at(3, 5)));
    let (scheduler, env) = build(clock).await;

    // 建项目 + 索引
    let dir = tempfile::tempdir().expect("项目");
    std::fs::write(dir.path().join("a.rs"), "fn a() {}\n").expect("写");
    let project = kb_core::model::Project {
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
    kb_core::ports::repo::ProjectRepo::create(env.meta.as_ref(), project.clone())
        .await
        .expect("写项目");
    let collections = kb_service::CollectionService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
    );
    let collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("建 collection");
    let index = IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    );
    index
        .index_project(&project, &collection)
        .await
        .expect("索引");

    // 磁盘上改文件(模拟漏掉的 hook 事件)
    std::fs::write(dir.path().join("a.rs"), "fn a() { 42 }\n").expect("改文件");
    let report = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(report.resynced, 1, "应投递一个增量任务:{report:?}");

    // 跑掉刚投递的增量任务后,指纹应一致
    let queue = kb_service::jobs::queue::JobQueue::new(env.meta.clone());
    let mut router = kb_service::jobs::worker::JobRouter::new();
    router.register(
        "index",
        Arc::new(kb_service::jobs::IndexJobHandler::new(
            Arc::new(index),
            env.meta.clone(),
            50,
        )),
    );
    let (_tx, rx) = tokio::sync::watch::channel(false);
    kb_service::jobs::worker::Worker::new(Arc::new(queue), Arc::new(router), rx)
        .run_until_idle()
        .await
        .expect("跑任务");

    let report = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(report.resynced, 0, "没有变化不应投递:{report:?}");
}

#[tokio::test]
async fn nightly_detects_new_and_filtered_files() {
    let clock = Arc::new(FixedClock::new(at(3, 5)));
    let (scheduler, env) = build(clock).await;
    let dir = tempfile::tempdir().expect("项目");
    std::fs::write(dir.path().join("a.rs"), "fn a() {}\n").expect("写");
    std::fs::write(dir.path().join("b.rs"), "fn b() {}\n").expect("写");
    let project = kb_core::model::Project {
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
    kb_core::ports::repo::ProjectRepo::create(env.meta.as_ref(), project.clone())
        .await
        .expect("写项目");
    let collections = kb_service::CollectionService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
    );
    let collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("建 collection");
    let index = IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    );
    index
        .index_project(&project, &collection)
        .await
        .expect("索引");

    // 磁盘上新增一个文件:必须被发现(旧实现只看库里已有的路径)
    std::fs::write(dir.path().join("c.rs"), "fn c() {}\n").expect("新增");
    let report = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(report.resynced, 1, "新增文件应触发增量:{report:?}");

    // 跑掉任务后应稳定
    let queue = kb_service::jobs::queue::JobQueue::new(env.meta.clone());
    let mut router = kb_service::jobs::worker::JobRouter::new();
    router.register(
        "index",
        Arc::new(kb_service::jobs::IndexJobHandler::new(
            Arc::new(index),
            env.meta.clone(),
            50,
        )),
    );
    let (_tx, rx) = tokio::sync::watch::channel(false);
    kb_service::jobs::worker::Worker::new(Arc::new(queue), Arc::new(router), rx)
        .run_until_idle()
        .await
        .expect("跑任务");
    let report = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(report.resynced, 0, "没有变化不应再投递:{report:?}");
}

#[tokio::test]
async fn filtered_files_do_not_trigger_nightly_resync() {
    // :被过滤文件(binary/excluded)不能每晚重复投递
    let clock = Arc::new(FixedClock::new(at(3, 5)));
    let (scheduler, env) = build(clock).await;
    let dir = tempfile::tempdir().expect("项目");
    std::fs::write(dir.path().join("a.rs"), "fn a() {}\n").expect("写");
    // 二进制文件:会被扫描器跳过,status = "binary"
    std::fs::write(dir.path().join("blob.bin"), [0u8, 1, 2, 3, 0, 0]).expect("写二进制");
    let project = kb_core::model::Project {
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
    kb_core::ports::repo::ProjectRepo::create(env.meta.as_ref(), project.clone())
        .await
        .expect("写项目");
    let collections = kb_service::CollectionService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
    );
    let collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("建 collection");
    let index = IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    );
    index
        .index_project(&project, &collection)
        .await
        .expect("索引");

    // 第一次夜间校验:没有变化 → 不应投递
    let report = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(report.resynced, 0, "被过滤文件不应触发增量任务:{report:?}");
}

async fn indexable_to_filtered() -> (Scheduler, TestEnv, tempfile::TempDir) {
    let clock = Arc::new(FixedClock::new(at(3, 5)));
    let (scheduler, env) = build(clock).await;
    let dir = tempfile::tempdir().expect("项目");
    std::fs::write(dir.path().join("a.rs"), "fn a() {}\n").expect("写");
    let project = kb_core::model::Project {
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
    kb_core::ports::repo::ProjectRepo::create(env.meta.as_ref(), project.clone())
        .await
        .expect("写项目");
    let collections = kb_service::CollectionService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
    );
    let collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("建 collection");
    let index = IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    );
    index
        .index_project(&project, &collection)
        .await
        .expect("索引");
    (scheduler, env, dir)
}

/// 构造一个和 fixture 用同一套适配器的索引服务。
fn index_service(env: &TestEnv) -> Arc<IndexService> {
    Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ))
}

/// 取最近一条任务里要处理的路径(夜间校验投递的增量任务)。
async fn queued_paths(env: &TestEnv) -> Vec<String> {
    let jobs = kb_core::ports::repo::JobRepo::list(env.meta.as_ref(), None)
        .await
        .expect("读任务");
    let job = jobs.last().expect("夜间校验应投递一条任务");
    assert_eq!(job.kind, "index", "应投递索引任务:{job:?}");
    let payload: kb_service::IndexPayload =
        serde_json::from_str(&job.payload_json).expect("解析 payload");
    assert_eq!(payload.mode, "incremental", "夜间校验应投递增量任务");
    payload.paths
}

/// 跑完队列里的任务。
async fn drain_jobs(env: &TestEnv, index: Arc<IndexService>) {
    let queue = kb_service::jobs::queue::JobQueue::new(env.meta.clone());
    let mut router = kb_service::jobs::worker::JobRouter::new();
    router.register(
        "index",
        Arc::new(kb_service::jobs::IndexJobHandler::new(
            index,
            env.meta.clone(),
            50,
        )),
    );
    let (_tx, rx) = tokio::sync::watch::channel(false);
    kb_service::jobs::worker::Worker::new(Arc::new(queue), Arc::new(router), rx)
        .run_until_idle()
        .await
        .expect("跑任务");
}

/// 读 `files.status`。
async fn file_status(env: &TestEnv, path: &str) -> String {
    kb_core::ports::repo::FileRepo::get(env.meta.as_ref(), "proj_demo", path)
        .await
        .expect("读 files")
        .expect("应有记录")
        .status
}

#[tokio::test]
async fn ok_to_binary_is_detected() {
    // :原来可索引的文件变成二进制 → 夜间校验必须发现
    let (scheduler, env, dir) = indexable_to_filtered().await;
    std::fs::write(dir.path().join("a.rs"), [0u8, 1, 2, 3, 0, 0]).expect("改成二进制");
    let report = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(report.resynced, 1, "ok → binary 应触发:{report:?}");
    assert_eq!(
        queued_paths(&env).await,
        vec!["a.rs".to_owned()],
        "只应重扫状态反转的那一个文件"
    );

    // 跑完任务后 a.rs 登记为 binary,再校验不应重复投递
    drain_jobs(&env, index_service(&env)).await;
    assert_eq!(
        file_status(&env, "a.rs").await,
        "binary",
        "跑完后应是 binary"
    );
    let again = scheduler.nightly().await.expect("再校验");
    assert_eq!(
        again.resynced, 0,
        "已登记为 binary 后不应重复投递:{again:?}"
    );
}

#[tokio::test]
async fn binary_to_text_is_detected() {
    // :被过滤 → 可索引 的状态反转必须被发现。
    // 先让 b.rs **以二进制进入 files 表**(status = "binary"),再做反转;
    // 否则测到的是“新增文件”分支,`scheduler.rs` 里 `row.status != "ok"` 那一支无人守护。
    let (scheduler, env, dir) = indexable_to_filtered().await;
    std::fs::write(dir.path().join("b.rs"), [0u8, 1, 2, 3, 0, 0]).expect("写二进制");
    let collection = kb_core::ports::repo::CollectionRepo::get(env.meta.as_ref(), "proj_demo")
        .await
        .expect("读 collection")
        .expect("存在");
    let project = kb_core::ports::repo::ProjectRepo::get(env.meta.as_ref(), "p1")
        .await
        .expect("读项目")
        .expect("存在");
    index_service(&env)
        .index_project(&project, &collection)
        .await
        .expect("索引(二进制被跳过)");
    assert_eq!(
        file_status(&env, "b.rs").await,
        "binary",
        "前置条件:b.rs 必须以 binary 进入 files 表"
    );

    // 改成文本 → 夜间校验必须发现并投递
    std::fs::write(dir.path().join("b.rs"), "fn b() {}\n").expect("改成文本");
    let report = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(report.resynced, 1, "binary → text 应触发:{report:?}");
    assert_eq!(
        queued_paths(&env).await,
        vec!["b.rs".to_owned()],
        "只应重扫状态反转的那一个文件"
    );

    // 跑完任务后状态变 ok,再校验一次应为 0(不重复投递)
    drain_jobs(&env, index_service(&env)).await;
    assert_eq!(file_status(&env, "b.rs").await, "ok", "跑完后应是 ok");
    let chunks = kb_core::ports::repo::ChunkRepo::count(env.meta.as_ref(), "proj_demo")
        .await
        .expect("chunks count");
    assert_eq!(chunks, 2, "a.rs 与 b.rs 各一块:{chunks}");
    let again = scheduler.nightly().await.expect("再校验");
    assert_eq!(again.resynced, 0, "状态稳定后不应重复投递:{again:?}");
}

#[tokio::test]
async fn nightly_runs_dedup_when_the_service_is_wired() {
    // :夜间顺带跑一次去重;没接去重服务时不动任何东西
    let clock = Arc::new(FixedClock::new(at(3, 5)));
    let (scheduler, env) = build(clock).await;
    let dir = tempfile::tempdir().expect("项目");
    let project = kb_core::model::Project {
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
    kb_core::ports::repo::ProjectRepo::create(env.meta.as_ref(), project)
        .await
        .expect("写项目");
    let collections = kb_service::CollectionService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
    );
    let collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("建 collection");
    for (id, title, created_at) in [("d-old", "旧条目", 1_000), ("d-new", "新条目", 2_000)] {
        let insight = kb_core::model::Insight {
            id: id.to_owned(),
            collection: collection.name.clone(),
            title: title.to_owned(),
            body_md: "同一件事的正文".to_owned(),
            kind: kb_core::model::InsightKind::Decision,
            tags: Vec::new(),
            related_paths: Vec::new(),
            status: kb_core::model::ItemStatus::Active,
            version: 1,
            valid_from: created_at,
            valid_until: None,
            superseded_by: None,
            created_by: "agent".to_owned(),
            batch_id: None,
            created_at,
            updated_at: created_at,
        };
        kb_core::ports::repo::InsightRepo::create(env.meta.as_ref(), insight)
            .await
            .expect("写 insight");
    }

    // 没接去重:报告里是 0,条目状态不变
    let report = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(report.deduped_collections, 0, "{report:?}");
    assert_eq!(report.dedup_pairs, 0, "{report:?}");

    // 接上之后:一对重复被标出,较旧的那条被取代
    let config = kb_core::config::EvolutionConfig {
        dedup_similarity: 0.9,
        ..kb_core::config::EvolutionConfig::default()
    };
    let scheduler = scheduler.with_dedup(Arc::new(kb_service::evolution::DedupService::new(
        env.meta.clone(),
        env.embedder.clone(),
        config,
    )));
    let report = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(report.deduped_collections, 1, "{report:?}");
    assert_eq!(report.dedup_pairs, 1, "{report:?}");
    let old = kb_core::ports::repo::InsightRepo::get(env.meta.as_ref(), "d-old")
        .await
        .expect("读 insight")
        .expect("存在");
    assert_eq!(old.status, kb_core::model::ItemStatus::Superseded);
    assert_eq!(old.superseded_by.as_deref(), Some("d-new"));
}

// ===== 定时备份与保留策略(设置页「备份」的缺口) =====

const HOUR_MS: i64 = 3_600_000;

/// 当前 unix 毫秒。
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .expect("系统时间早于 1970")
}

/// 造一份“已有归档”:名字与修改时间由调用方给(列表按 mtime 排序)。
fn fake_archive(dir: &std::path::Path, name: &str, created_at: i64) {
    let path = dir.join(name);
    std::fs::write(&path, b"fake-archive").expect("写假归档");
    let mtime = std::time::UNIX_EPOCH + std::time::Duration::from_millis(created_at as u64);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .expect("打开假归档")
        .set_modified(mtime)
        .expect("设置修改时间");
}

/// 假快照:写一段固定内容(真实实现是 SQLite 的 `VACUUM INTO`)。
struct FakeSnapshot;

#[async_trait::async_trait]
impl kb_service::backup::DbSnapshot for FakeSnapshot {
    async fn snapshot_to(&self, dest: &std::path::Path) -> kb_core::Result<()> {
        std::fs::write(dest, b"SQLite format 3\0fake")
            .map_err(|err| kb_core::KbError::Internal(format!("写快照失败: {err}")))
    }
}

/// 用同一个测试环境再建一个调度器(时钟可换)。
fn scheduler_for(env: &TestEnv, clock: Arc<FixedClock>) -> Scheduler {
    let index = Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ));
    Scheduler::new(
        env.meta.clone(),
        env.store.clone(),
        index,
        ScheduleOptions {
            nightly_at: "03:00".to_owned(),
            optimize_interval_minutes: 60,
            ..ScheduleOptions::default()
        },
        clock,
    )
}

#[tokio::test]
async fn scheduler_backs_up_and_prunes_on_its_own() {
    let env = TestEnv::new().await;
    let paths = env.paths();
    paths.ensure_dirs().expect("建目录");
    let backups = Arc::new(
        kb_service::backup::BackupService::new(paths, Arc::new(FakeSnapshot)).with_policy(
            kb_service::backup::BackupPolicy {
                enabled: true,
                interval_hours: 24,
                keep_count: 2,
                keep_days: 0,
                include_sources: false,
                mirror_dirs: Vec::new(),
            },
        ),
    );
    // 造两份旧归档(30 / 28 小时前):这一拍备份完,最旧的那份应被清掉
    let now = now_millis();
    fake_archive(
        backups.dir(),
        "kb-20260101-000000.tar.gz",
        now - 30 * HOUR_MS,
    );
    fake_archive(
        backups.dir(),
        "kb-20260102-000000.tar.gz",
        now - 28 * HOUR_MS,
    );

    // 归档的 mtime 是真实时间,所以固定时钟也用真实时间,否则“到点判断”不可复现
    let clock = Arc::new(FixedClock::new(chrono::Utc::now()));
    let scheduler = scheduler_for(&env, clock).with_backup(backups.clone());
    assert!(scheduler.plan().backup, "最新一份已过 24 小时 → 到点");
    scheduler.tick().await.expect("tick");

    let names: Vec<String> = backups
        .entries()
        .expect("列表")
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert_eq!(names.len(), 2, "新建 1 份、留 2 份;实际:{names:?}");
    assert!(
        !names.contains(&"kb-20260101-000000.tar.gz".to_owned()),
        "最旧的那份应被清掉:{names:?}"
    );
    assert!(
        !scheduler.plan().backup,
        "刚备份完,同一拍之后不该再判成到点"
    );
    // 成功也记一笔(设置页据此显示“上次定时备份:成功”)
    let last = backups.last_auto().expect("应记录上次自动备份结果");
    assert!(last.ok, "{last:?}");
    assert!(last.error.is_none(), "{last:?}");
}

#[tokio::test]
async fn scheduler_without_a_backup_service_never_backs_up() {
    let clock = Arc::new(FixedClock::new(at(10, 0)));
    let (scheduler, env) = build(clock).await;
    assert!(!scheduler.plan().backup, "没接备份服务时恒为 false");
    scheduler.tick().await.expect("tick");
    let dir = env.paths().backups_dir().to_path_buf();
    let count = std::fs::read_dir(&dir)
        .map(|read| read.count())
        .unwrap_or(0);
    assert_eq!(count, 0, "没接备份服务时不该产生归档");
}

/// 快照永远失败:定时备份失败只该记日志,不能把整拍带崩。
struct FailingSnapshot;

#[async_trait::async_trait]
impl kb_service::backup::DbSnapshot for FailingSnapshot {
    async fn snapshot_to(&self, _dest: &std::path::Path) -> kb_core::Result<()> {
        Err(kb_core::KbError::Internal("快照失败(测试)".to_owned()))
    }
}

#[tokio::test]
async fn a_failing_backup_does_not_break_the_tick() {
    let env = TestEnv::new().await;
    let paths = env.paths();
    paths.ensure_dirs().expect("建目录");
    // 保留策略收紧到 1 份,并预置两份旧归档:打包失败时清理仍要发生
    let backups = Arc::new(
        kb_service::backup::BackupService::new(paths.clone(), Arc::new(FailingSnapshot))
            .with_policy(kb_service::backup::BackupPolicy {
                keep_count: 1,
                ..kb_service::backup::BackupPolicy::default()
            }),
    );
    let now = now_millis();
    fake_archive(
        backups.dir(),
        "kb-20260101-000000.tar.gz",
        now - 30 * HOUR_MS,
    );
    fake_archive(
        backups.dir(),
        "kb-20260102-000000.tar.gz",
        now - 28 * HOUR_MS,
    );
    let clock = Arc::new(FixedClock::new(chrono::Utc::now()));
    let scheduler = scheduler_for(&env, clock).with_backup(backups.clone());
    assert!(scheduler.plan().backup, "从没备份过 → 到点");

    let (plan, _report) = scheduler
        .tick()
        .await
        .expect("备份失败不该让 tick 返回错误");
    assert!(plan.backup, "这一拍确实尝试过备份");
    // optimize 在备份之后执行:它跑过 → 下一拍不再 optimize
    assert!(
        !scheduler.plan().optimize,
        "备份失败后 optimize 仍应正常执行"
    );
    let names: Vec<String> = backups
        .entries()
        .expect("列表")
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert_eq!(
        names,
        vec!["kb-20260102-000000.tar.gz".to_owned()],
        "打包失败也要按保留策略清理(最新一份永远保留):{names:?}"
    );

    // 失败后要等退避窗口再重试,不能每拍都做一次快照
    assert!(
        !scheduler.plan().backup,
        "失败后应等退避窗口,而不是下一拍立刻重试"
    );
    // 失败原因落盘,设置页能读到(`BackupService` 每次调用都是新实例,内存里看不见)
    let last = backups.last_auto().expect("应记录上次自动备份结果");
    assert!(!last.ok, "{last:?}");
    assert!(
        last.error
            .as_deref()
            .unwrap_or_default()
            .contains("快照失败"),
        "{last:?}"
    );
}

/// 孤儿向量对账碰上索引分片在写(拿不到独占闸门)时只是推后:之后每拍重试,不用干等到下一个整点。
#[tokio::test]
async fn deferred_orphan_reconcile_is_retried_on_the_next_beat() {
    let clock = Arc::new(FixedClock::new(at(10, 0)));
    let env = TestEnv::new().await;
    let index = index_service(&env);
    let gate = index.write_gate();
    let scheduler = Scheduler::new(
        env.meta.clone(),
        env.store.clone(),
        index,
        ScheduleOptions {
            nightly_at: "03:00".to_owned(),
            optimize_interval_minutes: 60,
            ..ScheduleOptions::default()
        },
        clock,
    );
    let collections = kb_service::CollectionService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
    );
    collections.ensure_global().await.expect("建 _global");
    let collection = kb_core::ports::repo::CollectionRepo::get(env.meta.as_ref(), "_global")
        .await
        .expect("读 collection")
        .expect("有 _global");

    // 向量库里有一行、chunks 表里没有:向量化到一半被停下留的孤儿(写入时间很早,过了宽限期)
    let orphan = kb_core::model::RecordRow {
        id: format!("{:032x}", 0xdead_u64),
        collection: collection.name.clone(),
        kind: kb_core::model::RecordKind::Doc,
        lang: None,
        source: "uploads/orphan.xlsx".to_owned(),
        start_line: None,
        end_line: None,
        symbol: None,
        title: None,
        text: "孤儿".to_owned(),
        header: "孤儿".to_owned(),
        lex: "孤儿".to_owned(),
        tags: Vec::new(),
        status: kb_core::model::ItemStatus::Active,
        content_hash: "c".to_owned(),
        meta_hash: "m".to_owned(),
        embed_input_hash: "e".to_owned(),
        updated_at: 1_700_000_000_000,
        anchor: None,
        vector: Some(vec![
            0.1;
            kb_core::ports::Embedder::dim(env.embedder.as_ref())
        ]),
    };
    env.store
        .upsert(&collection.active_table, vec![orphan])
        .await
        .expect("写孤儿");
    let rows = || async {
        env.store
            .count(&collection.active_table, None)
            .await
            .expect("计数")
    };

    // 第一拍:有索引分片在写(占着读锁),对账拿不到独占闸门 → 推后,孤儿还在
    let writer = gate.writer().await;
    scheduler.tick().await.expect("第一拍");
    assert_eq!(rows().await, 1, "有写入在途时不能动向量库");

    // 第二拍:optimize 的间隔还没到(时钟固定),但闸门空了:补上之前跳过的对账
    drop(writer);
    let (plan, _) = scheduler.tick().await.expect("第二拍");
    assert!(!plan.optimize, "这一拍不该是 optimize,否则测不出重试");
    assert_eq!(rows().await, 0, "闸门空出来的下一拍就该清掉");

    // 清完之后不再有待办
    scheduler.retry_pending_reconcile().await;
    assert_eq!(rows().await, 0);
}

/// 可以一格一格往前拨的时钟(热点整理要跨多拍观察)。
struct StepClock {
    base: DateTime<Utc>,
    minutes: std::sync::atomic::AtomicU32,
}

impl StepClock {
    fn new(base: DateTime<Utc>) -> Self {
        Self {
            base,
            minutes: std::sync::atomic::AtomicU32::new(0),
        }
    }

    /// 往前拨到基准时刻之后的第 `minutes` 分钟。
    fn advance_to(&self, minutes: u32) {
        self.minutes
            .store(minutes, std::sync::atomic::Ordering::SeqCst);
    }

    fn now_at(&self) -> DateTime<Utc> {
        self.base
            + chrono::Duration::minutes(
                self.minutes.load(std::sync::atomic::Ordering::SeqCst) as i64
            )
    }
}

impl Clock for StepClock {
    fn now(&self) -> DateTime<Utc> {
        self.now_at()
    }
    fn local_minutes(&self) -> u32 {
        // 与线上 `Clock` 同口径:按站点时区(默认北京时间),不能直接用 UTC 的时和分
        kb_core::timezone::local_minutes(self.now_at().timestamp_millis())
    }
    fn local_date(&self) -> chrono::NaiveDate {
        kb_core::timezone::local_date(self.now_at().timestamp_millis())
    }
}

/// 当前表的碎片数与版本号(走端口方法,测试里拿到的是 `dyn VectorStore`)。
async fn table_shape(env: &TestEnv, table: &str) -> (u64, u64) {
    let stats = env.store.table_stats().await.expect("表状况");
    let stat = stats
        .into_iter()
        .find(|stat| stat.table == table)
        .expect("应能取到这张表");
    (stat.fragments, stat.version)
}

/// 造一行能塞进 LanceDB 的记录(热点整理只关心碎片数,内容随便)。
fn row(collection: &str, index: u32, dim: usize) -> RecordRow {
    RecordRow {
        id: format!("{index:032x}"),
        collection: collection.to_owned(),
        kind: RecordKind::Code,
        lang: Some("rust".to_owned()),
        source: "src/hot.rs".to_owned(),
        start_line: Some(1),
        end_line: Some(2),
        symbol: None,
        title: None,
        text: format!("fn hot_{index}() {{}}"),
        header: String::new(),
        lex: format!("fn hot_{index}() {{}}"),
        tags: Vec::new(),
        status: ItemStatus::Active,
        content_hash: format!("c{index}"),
        meta_hash: format!("m{index}"),
        embed_input_hash: format!("e{index}"),
        updated_at: 1_700_000_000_000,
        anchor: None,
        vector: Some(vec![0.5; dim]),
    }
}

/// :热点表不等整点,版本一变就在 10 分钟内收一次碎片;没写入就不白跑。
///
/// 判据是表版本号,所以「同一批写入被整理过之后不再重复整理」也是这条用例的一部分。
#[tokio::test]
async fn hot_tables_are_compacted_between_hourly_passes() {
    // 01:00 起(不到 03:00,夜间校验不掺进来)
    let clock = Arc::new(StepClock::new(at(1, 0)));
    let env = TestEnv::new().await;
    let project = kb_core::model::Project {
        id: "p1".to_owned(),
        name: "demo".to_owned(),
        slug: "demo".to_owned(),
        root_path: "/tmp/not-used".to_owned(),
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
    kb_core::ports::repo::ProjectRepo::create(env.meta.as_ref(), project)
        .await
        .expect("写项目");
    let collection = kb_service::CollectionService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
    )
    .create_for_project("p1", "demo")
    .await
    .expect("建 collection");
    let table = collection.active_table.clone();
    let scheduler = scheduler_on(&env, clock.clone());

    // 第一拍做整份 optimize:版本号被记下来
    let (plan, _) = scheduler.tick().await.expect("tick");
    assert!(plan.optimize, "第一次 tick 应做整份 optimize");
    assert!(!plan.nightly, "01:00 还没到夜间校验");

    // 模拟索引任务在整点之间连续提交:12 批 → 十几个碎片
    let dim = env.embedder.dim();
    for batch in 0..12u32 {
        let rows: Vec<RecordRow> = (0..8u32)
            .map(|offset| row(&collection.name, batch * 8 + offset, dim))
            .collect();
        env.store.upsert(&table, rows).await.expect("写一批");
    }
    let (fragments_before, _) = table_shape(&env, &table).await;
    assert!(
        fragments_before >= 10,
        "12 批写入应留下十几个碎片,实际 {fragments_before}"
    );

    // 没过热点间隔(10 分钟):不该动
    clock.advance_to(5);
    scheduler.tick().await.expect("tick");
    assert_eq!(
        table_shape(&env, &table).await.0,
        fragments_before,
        "热点间隔内不该整理"
    );

    // 过了热点间隔,版本变过 → 收碎片
    clock.advance_to(12);
    scheduler.tick().await.expect("tick");
    let (settled_fragments, settled_version) = table_shape(&env, &table).await;
    assert!(
        settled_fragments < fragments_before,
        "热点表应被整理:{} → {}",
        fragments_before,
        settled_fragments
    );

    // 再往前拨一段,期间没人写:版本没变,不该再整理(整理会推进版本号)
    clock.advance_to(30);
    scheduler.tick().await.expect("tick");
    let (again_fragments, again_version) = table_shape(&env, &table).await;
    assert_eq!(again_version, settled_version, "没有新写入就不该再整理");
    assert_eq!(again_fragments, settled_fragments, "碎片数也不该变");
}

/// 假的夜间质量门禁:直接给出两期 hit@1(或一个错误),不真跑检索。
struct FakeGate {
    current: f64,
    previous: Option<f64>,
    failure: Option<String>,
}

#[async_trait::async_trait]
impl QualityGate for FakeGate {
    async fn measure(&self) -> kb_core::Result<Option<QualityMeasure>> {
        if let Some(reason) = &self.failure {
            return Err(kb_core::KbError::InvalidInput(reason.clone()));
        }
        Ok(Some(QualityMeasure {
            set_hash: "abc123".to_owned(),
            cases: 15,
            hit_at_1: self.current,
            previous_hit_at_1: self.previous,
        }))
    }
}

/// 读出门禁写下的事件(告警走 `events`,Web 的事件流能看到)。
async fn quality_events(env: &TestEnv) -> Vec<kb_core::model::Event> {
    use kb_core::ports::repo::EventRepo;
    EventRepo::recent(env.meta.as_ref(), 20)
        .await
        .expect("读事件")
        .into_iter()
        .filter(|event| event.kind == "quality_gate")
        .collect()
}

/// :夜间顺带清一次历史表,行数记进报告。
#[tokio::test]
async fn nightly_runs_retention_and_reports_rows() {
    struct FakeRetention {
        counts: Vec<(String, u64)>,
        failure: Option<String>,
    }

    #[async_trait::async_trait]
    impl RetentionHook for FakeRetention {
        async fn prune(&self, _dry_run: bool) -> kb_core::Result<Vec<(String, u64)>> {
            if let Some(reason) = &self.failure {
                return Err(kb_core::KbError::InvalidInput(reason.clone()));
            }
            Ok(self.counts.clone())
        }
    }

    let clock = Arc::new(FixedClock::new(at(3, 0)));
    let env = TestEnv::new().await;
    let scheduler = scheduler_on(&env, clock).with_retention(Arc::new(FakeRetention {
        counts: vec![("jobs".to_owned(), 12), ("events".to_owned(), 30)],
        failure: None,
    }));
    let report = scheduler.nightly().await.expect("夜间校验");
    assert_eq!(report.pruned_rows, 42, "两表合计:{report:?}");

    // 清理失败只告警,夜间校验本身不算失败
    let clock = Arc::new(FixedClock::new(at(3, 0)));
    let env = TestEnv::new().await;
    let scheduler = scheduler_on(&env, clock).with_retention(Arc::new(FakeRetention {
        counts: Vec::new(),
        failure: Some("库被锁了".to_owned()),
    }));
    let report = scheduler.nightly().await.expect("清理失败不影响夜间校验");
    assert_eq!(report.pruned_rows, 0);
}

/// :命中率跌过 5% 要告警并留事件。
#[tokio::test]
async fn nightly_quality_gate_records_a_drop() {
    let clock = Arc::new(FixedClock::new(at(3, 0)));
    let env = TestEnv::new().await;
    let scheduler = scheduler_on(&env, clock).with_quality_gate(Arc::new(FakeGate {
        current: 0.74,
        previous: Some(0.80),
        failure: None,
    }));

    let report = scheduler.nightly().await.expect("夜间校验");
    assert!(report.quality_checked, "门禁应被调用:{report:?}");
    assert!(report.quality_dropped, "跌 0.06 应判为回退:{report:?}");

    let events = quality_events(&env).await;
    assert_eq!(events.len(), 1, "回退应留下一条事件:{events:?}");
    let payload: serde_json::Value =
        serde_json::from_str(&events[0].payload_json).expect("事件负载是 JSON");
    assert_eq!(payload["gate"], "nightly_quality");
    assert_eq!(payload["cases"], 15);
    assert_eq!(payload["set_hash"], "abc123");
    let delta = payload["delta"].as_f64().expect("带 delta");
    assert!((delta - 0.06).abs() < 1e-9, "delta 应为 0.06,实际 {delta}");
}

/// :持平(含正好跌 5% 的边界)不报警、不写事件。
#[tokio::test]
async fn nightly_quality_gate_stays_quiet_without_a_real_drop() {
    let clock = Arc::new(FixedClock::new(at(3, 0)));
    let env = TestEnv::new().await;
    let scheduler = scheduler_on(&env, clock).with_quality_gate(Arc::new(FakeGate {
        current: 0.75,
        previous: Some(0.80),
        failure: None,
    }));

    let report = scheduler.nightly().await.expect("夜间校验");
    assert!(report.quality_checked, "门禁应被调用:{report:?}");
    assert!(!report.quality_dropped, "跌 0.05 不算法回退:{report:?}");
    assert_eq!(quality_events(&env).await.len(), 0, "持平不该产生事件");
}

/// :门禁自己出错只记事件,夜里该做的事(指纹校验等)照常完成。
#[tokio::test]
async fn nightly_quality_gate_failure_is_recorded_but_does_not_fail_the_night() {
    let clock = Arc::new(FixedClock::new(at(3, 0)));
    let env = TestEnv::new().await;
    let scheduler = scheduler_on(&env, clock).with_quality_gate(Arc::new(FakeGate {
        current: 0.0,
        previous: None,
        failure: Some("嵌入器不可用,本次全走纯全文,命中率不能当基线".to_owned()),
    }));

    let report = scheduler.nightly().await.expect("夜间校验不该整体失败");
    assert!(!report.quality_checked, "没跑成不算跑过:{report:?}");
    let events = quality_events(&env).await;
    assert_eq!(events.len(), 1, "失败也要留一条事件:{events:?}");
    let payload: serde_json::Value =
        serde_json::from_str(&events[0].payload_json).expect("事件负载是 JSON");
    assert!(
        payload["error"]
            .as_str()
            .is_some_and(|text| text.contains("嵌入器")),
        "事件里要写清原因:{payload}"
    );
}
