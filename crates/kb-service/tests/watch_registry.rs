//! 监听注册表:监听器随项目增、删、改自动对账(风格参照 `tests/watch.rs`)。
//!
//! 观察口径:真实的 `spawn_hot` + 真实的 `EventService` + 真实的 SQLite 任务队列(`kb-testkit`),
//! 不跑 worker,所以文件变化投递出的增量索引任务会一直停在排队中,直接读队列里的任务载荷就能看到
//! 「哪些路径触发了索引」。同一个 collection 排队中的增量任务会合并成一条,所以按路径而不是按条数断言。
//!
//! 每个测试都用几个文件的小目录;注册表在测试结束时随变量释放,监听器随句柄停止。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kb_core::config::{Config, ConfigStore};
use kb_core::model::{JobState, Project};
use kb_core::ports::repo::ProjectRepo;
use kb_service::evolution::{EventService, SyncReport, WatchRegistry};
use kb_service::jobs::queue::JobQueue;
use kb_testkit::TestEnv;
use tempfile::TempDir;

/// 去抖窗口:够短,测试快;写入后几百毫秒内就应该出现任务。
const DEBOUNCE_MS: u64 = 100;
/// 等一个正向事件(应该出现的任务)最多多久。
const POSITIVE_WAIT: Duration = Duration::from_secs(6);
/// 对照事件出现之后,再多等一会儿,让可能泄漏的事件也有时间到达。
const SETTLE: Duration = Duration::from_millis(600);

/// 一个测试用的项目目录。
struct Site {
    dir: TempDir,
}

impl Site {
    fn new() -> Self {
        Self {
            dir: tempfile::tempdir().expect("临时项目目录"),
        }
    }

    /// 规范化后的根目录:`EventService` 会把事件里的根目录 canonicalize 再去匹配项目表,
    /// 项目表里就存规范化后的路径,避免临时目录经过符号链接时匹配不上。
    fn root(&self) -> String {
        std::fs::canonicalize(self.dir.path())
            .expect("规范化项目根目录")
            .to_string_lossy()
            .into_owned()
    }

    fn write(&self, relative: &str, content: &str) {
        write(&self.dir.path().join(relative), content);
    }
}

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

/// 造一个项目实体(`slug` 决定 collection 名 `proj_<slug>`)。
fn project(slug: &str, root: &str, exclude: &[&str]) -> Project {
    Project {
        id: format!("id-{slug}"),
        name: slug.to_owned(),
        slug: slug.to_owned(),
        root_path: root.to_owned(),
        include: Vec::new(),
        exclude: exclude.iter().map(|item| (*item).to_owned()).collect(),
        is_git: false,
        last_commit: None,
        last_indexed_at: None,
        allow_cloud_llm: false,
        extract_enabled: false,
        hooks_installed: false,
        created_at: 1_700_000_000_000,
    }
}

/// 测试夹具:临时 `KB_HOME` + 注册表。
struct Fixture {
    env: TestEnv,
    registry: WatchRegistry,
}

async fn fixture() -> Fixture {
    let env = TestEnv::new().await;
    let store = Arc::new(ConfigStore::new(Config::default()));
    let events = Arc::new(EventService::new(env.meta.clone()));
    let registry = WatchRegistry::new(store, events, DEBOUNCE_MS);
    Fixture { env, registry }
}

impl Fixture {
    /// 把项目写进项目表(`EventService` 靠它把事件对应到项目)。
    async fn register(&self, project: &Project) {
        ProjectRepo::create(self.env.meta.as_ref(), project.clone())
            .await
            .expect("写项目行");
    }

    /// 某个项目的 collection 里,排队中的增量索引任务带过的全部路径。
    async fn queued_paths(&self, slug: &str) -> BTreeSet<String> {
        let queue = JobQueue::new(self.env.meta.clone());
        let collection = format!("proj_{slug}");
        let mut paths = BTreeSet::new();
        for job in queue
            .list(Some(JobState::Queued))
            .await
            .expect("列排队任务")
        {
            if job.collection.as_deref() != Some(collection.as_str()) {
                continue;
            }
            let payload: serde_json::Value =
                serde_json::from_str(&job.payload_json).expect("任务载荷是 JSON");
            if let Some(items) = payload.get("paths").and_then(|value| value.as_array()) {
                paths.extend(
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_owned)),
                );
            }
        }
        paths
    }

    /// 等到某个路径出现在该项目的增量任务里;超时就失败。
    async fn wait_for_path(&self, slug: &str, path: &str) {
        let deadline = tokio::time::Instant::now() + POSITIVE_WAIT;
        loop {
            let seen = self.queued_paths(slug).await;
            if seen.contains(path) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "{}s 内没等到 {slug} 的增量任务带上 {path},现有路径:{seen:?}",
                POSITIVE_WAIT.as_secs()
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// 断言某路径**没有**出现在该项目的增量任务里。调用前应已用别处的对照事件等过一轮,
    /// 这里再多等 [`SETTLE`],给可能泄漏的事件留足到达时间。
    async fn assert_no_path(&self, slug: &str, path: &str) {
        tokio::time::sleep(SETTLE).await;
        let seen = self.queued_paths(slug).await;
        assert!(
            !seen.contains(path),
            "{slug} 不该再收到 {path} 的增量任务,现有路径:{seen:?}"
        );
    }
}

/// 收集注册表打出的日志,用来断言「同样的原因不重复刷日志」。
///
/// 只用 `tracing` 本身实现一个最小的订阅者,不给 `kb-service` 新增 dev-dependency。
/// 订阅者只在当前线程生效;注册表的日志都在异步部分(不在 `spawn_blocking` 里)打出,
/// `#[tokio::test]` 是单线程运行时,所以收得到。
#[derive(Clone, Default)]
struct LogCollector {
    /// (级别, 文本) —— 只收 `watch_registry` 模块的事件。
    lines: Arc<Mutex<Vec<(tracing::Level, String)>>>,
}

impl LogCollector {
    /// 在当前线程装上订阅者;返回的守卫释放后恢复。
    fn install(&self) -> tracing::subscriber::DefaultGuard {
        tracing::subscriber::set_default(self.clone())
    }

    /// 文本里含 `needle` 的日志条数。
    fn count(&self, needle: &str) -> usize {
        self.lines
            .lock()
            .expect("日志锁")
            .iter()
            .filter(|(_, text)| text.contains(needle))
            .count()
    }

    /// 某个级别的日志条数。
    fn count_level(&self, level: tracing::Level) -> usize {
        self.lines
            .lock()
            .expect("日志锁")
            .iter()
            .filter(|(seen, _)| *seen == level)
            .count()
    }
}

/// 把事件的字段拼成一行文本。
struct LineVisitor(String);

impl tracing::field::Visit for LineVisitor {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if !self.0.is_empty() {
            self.0.push(' ');
        }
        self.0.push_str(&format!("{}={value:?}", field.name()));
    }
}

impl tracing::Subscriber for LogCollector {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        metadata.target().contains("watch_registry")
    }

    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }

    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}

    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}

    fn event(&self, event: &tracing::Event<'_>) {
        let mut visitor = LineVisitor(String::new());
        event.record(&mut visitor);
        self.lines
            .lock()
            .expect("日志锁")
            .push((*event.metadata().level(), visitor.0));
    }

    fn enter(&self, _: &tracing::span::Id) {}

    fn exit(&self, _: &tracing::span::Id) {}
}

/// 1. 注册表起来时没有项目;之后加入一个项目 → `sync` → 写文件 → 出现增量任务。
#[tokio::test]
async fn a_project_added_after_startup_gets_a_watcher() {
    let fx = fixture().await;
    let site = Site::new();
    let demo = project("late", &site.root(), &[]);
    fx.register(&demo).await;

    // 启动时项目列表是空的:什么都不挂
    let empty = fx.registry.sync(Vec::new()).await;
    assert_eq!(empty, SyncReport::default(), "{empty:?}");
    assert!(!fx.registry.is_watching(&demo.id));

    // 项目被加进来(`kb project add` 之后下一轮对账看到它)
    let report = fx.registry.sync(vec![demo.clone()]).await;
    assert_eq!(report.started, 1, "{report:?}");
    assert_eq!(report.stopped + report.restarted + report.failed, 0);
    assert!(report.total_dirs >= 1, "至少挂上了根目录:{report:?}");
    assert!(fx.registry.is_watching(&demo.id));

    site.write("src/new.rs", "fn new() {}\n");
    fx.wait_for_path("late", "src/new.rs").await;
}

/// 2. 项目从列表里消失 → `sync` 撤掉监听 → 再写文件不再有新任务。
///
/// 项目行**留在**项目表里:这样即使监听器泄漏了,`EventService` 也认得这个项目、照样投递任务,
/// 测试才能抓到泄漏。如果连行一起删,事件会因为「找不到项目」被吞掉,测试就测不出东西了。
#[tokio::test]
async fn a_removed_project_stops_delivering() {
    let fx = fixture().await;
    let gone = Site::new();
    let kept = Site::new();
    let gone_project = project("gone", &gone.root(), &[]);
    let kept_project = project("kept", &kept.root(), &[]);
    fx.register(&gone_project).await;
    fx.register(&kept_project).await;

    let both = vec![gone_project.clone(), kept_project.clone()];
    assert_eq!(fx.registry.sync(both).await.started, 2);

    // 先确认移除前确实在监听
    gone.write("before.rs", "fn before() {}\n");
    fx.wait_for_path("gone", "before.rs").await;

    let report = fx.registry.sync(vec![kept_project.clone()]).await;
    assert_eq!(report.stopped, 1, "{report:?}");
    assert_eq!(report.started + report.restarted + report.failed, 0);
    assert!(!fx.registry.is_watching(&gone_project.id));
    assert!(fx.registry.is_watching(&kept_project.id));

    // 先写被移除项目,再写仍在监听的项目;后者出现说明这一轮事件都到了,前者仍然没有才算数
    gone.write("after.rs", "fn after() {}\n");
    kept.write("after.rs", "fn after() {}\n");
    fx.wait_for_path("kept", "after.rs").await;
    fx.assert_no_path("gone", "after.rs").await;
}

/// 3. 改项目的 `exclude` → `sync` 重起监听 → 被排除的扩展名不再触发,别的扩展名照常。
#[tokio::test]
async fn changed_exclude_takes_effect() {
    let fx = fixture().await;
    let site = Site::new();
    let before = project("rules", &site.root(), &[]);
    fx.register(&before).await;

    assert_eq!(fx.registry.sync(vec![before.clone()]).await.started, 1);
    // 旧规则没有排除 .log:先证明它会触发(否则后面的「不触发」可能只是本来就不触发)
    site.write("old.log", "x\n");
    fx.wait_for_path("rules", "old.log").await;

    let mut after = before.clone();
    after.exclude = vec!["*.log".to_owned()];
    let report = fx.registry.sync(vec![after.clone()]).await;
    assert_eq!(report.restarted, 1, "{report:?}");
    assert_eq!(report.started + report.stopped + report.failed, 0);
    assert!(fx.registry.is_watching(&after.id));

    // 先写被排除的,再写没被排除的;后者到了,前者还没有才算排除生效
    site.write("new.log", "x\n");
    site.write("new.md", "# new\n");
    fx.wait_for_path("rules", "new.md").await;
    fx.assert_no_path("rules", "new.log").await;
}

/// 项目的根目录换了地方:旧目录不再监听,新目录开始监听。
#[tokio::test]
async fn changed_root_moves_the_watcher() {
    let fx = fixture().await;
    let old_site = Site::new();
    let new_site = Site::new();
    let mut moving = project("moving", &old_site.root(), &[]);
    fx.register(&moving).await;
    assert_eq!(fx.registry.sync(vec![moving.clone()]).await.started, 1);

    // 项目表里的根目录也改掉(`EventService` 按它把事件对应到项目)
    moving.root_path = new_site.root();
    ProjectRepo::update(fx.env.meta.as_ref(), moving.clone())
        .await
        .expect("改项目根目录");
    // 旧目录另外登记成一个「幽灵」项目(不交给注册表):旧监听如果没撤掉,
    // 旧目录里的变化会被 `EventService` 认成它,投递到 `proj_ghost` 里,测试才抓得到泄漏
    let ghost = project("ghost", &old_site.root(), &[]);
    fx.register(&ghost).await;

    let report = fx.registry.sync(vec![moving.clone()]).await;
    assert_eq!(report.restarted, 1, "{report:?}");

    // 先写旧目录,再写新目录;新目录的任务到了,旧目录的仍然没有才算旧监听已撤
    old_site.write("old.rs", "fn old() {}\n");
    new_site.write("here.rs", "fn here() {}\n");
    fx.wait_for_path("moving", "here.rs").await;
    fx.assert_no_path("ghost", "old.rs").await;
}

/// 4. 根目录不存在:不报错、不重复刷日志;目录出现后下一次 `sync` 自动开始监听。
#[tokio::test]
async fn a_missing_root_is_skipped_quietly_and_picked_up_later() {
    let fx = fixture().await;
    let parent = Site::new();
    let root = parent.dir.path().join("not-yet");
    // 父目录规范化后再拼,保证出现后的路径与项目表里的一致
    let root_text = PathBuf::from(parent.root())
        .join("not-yet")
        .to_string_lossy()
        .into_owned();
    let pending = project("pending", &root_text, &[]);
    fx.register(&pending).await;

    let logs = LogCollector::default();
    let _guard = logs.install();

    // 连续三轮,目录一直不存在
    for round in 0..3 {
        let report = fx.registry.sync(vec![pending.clone()]).await;
        assert_eq!(
            (
                report.started,
                report.stopped,
                report.restarted,
                report.failed
            ),
            (0, 0, 0, 0),
            "第 {round} 轮:根目录不存在不算失败也不算变化:{report:?}"
        );
        assert!(!fx.registry.is_watching(&pending.id));
    }
    assert_eq!(
        logs.count("根目录不存在"),
        1,
        "同样的原因只在状态变化时打一次,不能每轮都刷:{:?}",
        logs.lines.lock().expect("日志锁")
    );

    // 目录出现:下一轮自动开始监听
    std::fs::create_dir_all(&root).expect("建项目目录");
    let report = fx.registry.sync(vec![pending.clone()]).await;
    assert_eq!(report.started, 1, "{report:?}");
    assert!(fx.registry.is_watching(&pending.id));
    write(&root.join("appeared.rs"), "fn appeared() {}\n");
    fx.wait_for_path("pending", "appeared.rs").await;

    // 目录又消失:撤掉监听并再记一次(这是新的状态变化);继续缺着不再重复
    std::fs::remove_dir_all(&root).expect("删项目目录");
    let report = fx.registry.sync(vec![pending.clone()]).await;
    assert_eq!(report.stopped, 1, "{report:?}");
    assert!(!fx.registry.is_watching(&pending.id));
    fx.registry.sync(vec![pending.clone()]).await;
    assert_eq!(
        logs.count("根目录不存在"),
        2,
        "目录第二次消失记一次,之后不重复:{:?}",
        logs.lines.lock().expect("日志锁")
    );
}

/// 5. `sync` 幂等:连续两次相同输入,第二次的报告整份为 0。
#[tokio::test]
async fn sync_is_idempotent() {
    let fx = fixture().await;
    let first = Site::new();
    let second = Site::new();
    first.write("src/a.rs", "fn a() {}\n");
    second.write("b.rs", "fn b() {}\n");
    let projects = vec![
        project("one", &first.root(), &["*.log"]),
        project("two", &second.root(), &[]),
    ];

    let report = fx.registry.sync(projects.clone()).await;
    assert_eq!(report.started, 2, "{report:?}");
    assert_eq!(report.failed, 0);
    assert!(report.total_dirs >= 3, "根 ×2 + src:{report:?}");
    let dirs_after_first = fx.registry.watched_dirs();

    for round in 0..2 {
        let again = fx.registry.sync(projects.clone()).await;
        assert_eq!(
            again,
            SyncReport::default(),
            "第 {round} 次重复同步应整份为 0:{again:?}"
        );
        assert!(!again.changed());
    }
    // 没有重起:监听的目录总数不变
    assert_eq!(fx.registry.watched_dirs(), dirs_after_first);
}

/// 6. 单个项目起监听失败不影响其他项目。
///
/// 用「排除规则里有非法 glob」制造失败:测试通常以 root 跑,不可读目录拦不住 root,
/// 而非法 glob 在任何账号下都会让 `FileFilter` 构造失败,结果是确定的。
#[tokio::test]
async fn one_failing_project_does_not_block_the_others() {
    let fx = fixture().await;
    let broken_site = Site::new();
    let healthy_site = Site::new();
    let broken = project("broken", &broken_site.root(), &["{unclosed"]);
    let healthy = project("healthy", &healthy_site.root(), &[]);
    fx.register(&broken).await;
    fx.register(&healthy).await;

    let logs = LogCollector::default();
    let _guard = logs.install();

    // 坏项目排在前面:它失败不能拖住后面的
    let projects = vec![broken.clone(), healthy.clone()];
    let report = fx.registry.sync(projects.clone()).await;
    assert_eq!(report.failed, 1, "{report:?}");
    assert_eq!(report.started, 1, "{report:?}");
    assert!(!fx.registry.is_watching(&broken.id));
    assert!(fx.registry.is_watching(&healthy.id));
    healthy_site.write("ok.rs", "fn ok() {}\n");
    fx.wait_for_path("healthy", "ok.rs").await;

    // 下一轮会重试(失败可能是暂时的),仍失败时同一条警告不重复刷
    let again = fx.registry.sync(projects.clone()).await;
    assert_eq!(again.failed, 1, "仍在重试:{again:?}");
    assert_eq!(again.started + again.stopped + again.restarted, 0);
    assert_eq!(
        logs.count_level(tracing::Level::WARN),
        1,
        "同一个失败只警告一次:{:?}",
        logs.lines.lock().expect("日志锁")
    );

    // 排除规则改对之后,下一轮自动恢复
    let mut fixed = broken.clone();
    fixed.exclude = Vec::new();
    let recovered = fx.registry.sync(vec![fixed.clone(), healthy.clone()]).await;
    assert_eq!(recovered.started, 1, "{recovered:?}");
    assert_eq!(recovered.failed, 0);
    assert!(fx.registry.is_watching(&fixed.id));
}
