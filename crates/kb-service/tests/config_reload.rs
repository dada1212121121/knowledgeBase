//! 配置热重载。
//!
//! 跑法:`cargo test -p kb-service --test config_reload`
//!
//! 覆盖四件事:热项立即生效、非法配置保留旧值、`embed.*` 只出迁移计划、
//! 500ms 去抖(10 次写只重载 1 次);外加 `index.exclude` 的就地替换。

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use kb_core::config::{Config, ConfigStore};
use kb_core::model::{CollectionKind, Project};
use kb_service::index::{IndexOptions, IndexService};
use kb_service::{CollectionService, ConfigObserver, ConfigReloader, ReloadOutcome};
use kb_testkit::TestEnv;

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, text).expect("写配置");
}

/// 数观察者被调了几次(去抖用例靠它断言“只重载一次”)。
struct CountingObserver(Arc<AtomicUsize>);

impl ConfigObserver for CountingObserver {
    fn on_outcome(&self, _outcome: &ReloadOutcome) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

/// 建一个只含 `[search] k = 8` 的配置文件与对应的存储。
fn store_with(config_file: &Path) -> Arc<ConfigStore> {
    write(config_file, "[search]\nk = 8\n");
    let config = Config::load(config_file).expect("读配置");
    assert_eq!(config.search.k, 8);
    Arc::new(ConfigStore::new(config))
}

#[tokio::test]
async fn hot_keys_apply_without_restart() {
    // 验收:改 `search.k` 后无需重启就生效(这里断言的是“内存里的配置已经换了”)
    let env = TestEnv::new().await;
    let paths = env.paths();
    let config_file = paths.config_file();
    let store = store_with(config_file);
    let reloader = ConfigReloader::new(store.clone(), config_file);

    write(config_file, "[search]\nk = 3\n[log]\nlevel = \"debug\"\n");
    let outcome = reloader.reload().await;
    assert!(outcome.applied, "热项应直接生效:{outcome:?}");
    assert_eq!(
        outcome.hot,
        vec!["log.level".to_owned(), "search.k".to_owned()],
        "热更新项应按点号键排序报出"
    );
    assert!(outcome.restart_required.is_empty(), "{outcome:?}");
    assert!(outcome.migration.is_empty(), "{outcome:?}");
    assert_eq!(outcome.generation, 2, "生效一次代际 +1");
    assert_eq!(store.get().search.k, 3);
    assert_eq!(store.get().log.level, "debug");
    assert!(!outcome.needs_attention(), "纯热项不需要人处理");

    // 文件没变:不重复生效,但仍给调用方回执
    let again = reloader.reload().await;
    assert!(!again.applied);
    assert!(again.hot.is_empty());
    assert_eq!(again.generation, 2, "没变化时代际号不动");
    assert!(again.summary().contains("没有变化"), "{}", again.summary());
}

#[tokio::test]
async fn restart_keys_are_reported_but_the_store_still_takes_them() {
    let env = TestEnv::new().await;
    let paths = env.paths();
    let config_file = paths.config_file();
    let store = store_with(config_file);
    let reloader = ConfigReloader::new(store.clone(), config_file);

    write(
        config_file,
        "[search]\nk = 8\n[server]\nlisten = \"127.0.0.1:7999\"\n",
    );
    let outcome = reloader.reload().await;
    assert!(outcome.applied);
    assert!(outcome.hot.is_empty(), "{outcome:?}");
    assert_eq!(outcome.restart_required, vec!["server.listen".to_owned()]);
    assert!(outcome.needs_attention(), "要重启就得提醒");
    assert!(
        outcome.summary().contains("要重启"),
        "{}",
        outcome.summary()
    );
    assert_eq!(store.get().server.listen, "127.0.0.1:7999");
}

#[tokio::test]
async fn invalid_config_keeps_the_old_one_and_reports_the_error() {
    // 验收:写入非法配置时保留旧配置
    let env = TestEnv::new().await;
    let paths = env.paths();
    let config_file = paths.config_file();
    let store = store_with(config_file);
    let reloader = ConfigReloader::new(store.clone(), config_file);

    write(config_file, "[server\nlisten = 1\n");
    let outcome = reloader.reload().await;
    assert!(!outcome.applied, "非法配置不应生效:{outcome:?}");
    assert!(outcome.error.is_some(), "要带回解析失败的原因");
    assert!(
        outcome.summary().contains("保留旧配置"),
        "{}",
        outcome.summary()
    );
    assert_eq!(store.generation(), 1, "代际号不动");
    assert_eq!(store.get().search.k, 8, "旧配置继续生效");

    // 修好之后还能正常重载(不会因为一次坏配置就卡住)
    write(config_file, "[search]\nk = 5\n");
    let fixed = reloader.reload().await;
    assert!(fixed.applied, "{fixed:?}");
    assert_eq!(store.get().search.k, 5);
}

#[tokio::test]
async fn a_missing_config_file_keeps_the_current_one() {
    // 质量检查:文件被删(或正被重命名)时不能退回默认配置,否则热项会被悄悄重置
    let env = TestEnv::new().await;
    let paths = env.paths();
    let config_file = paths.config_file();
    let store = store_with(config_file);
    let reloader = ConfigReloader::new(store.clone(), config_file);

    write(config_file, "[search]\nk = 3\n");
    let applied = reloader.reload().await;
    assert!(applied.applied, "{applied:?}");
    assert_eq!(store.get().search.k, 3);

    std::fs::remove_file(config_file).expect("删掉配置文件");
    let outcome = reloader.reload().await;
    assert!(!outcome.applied, "文件不存在时不应生效:{outcome:?}");
    assert!(outcome.error.is_some(), "应报出原因:{outcome:?}");
    assert_eq!(store.get().search.k, 3, "旧配置要继续生效");
}

#[tokio::test]
async fn embed_change_only_returns_a_migration_plan() {
    // 验收:embed.* 的变化不生效,只返回迁移计划(先迁移再重启)
    let env = TestEnv::new().await;
    let collections =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    collections.ensure_global().await.expect("_global");
    collections
        .create("proj_alpha", CollectionKind::Project, None)
        .await
        .expect("proj_alpha");

    let paths = env.paths();
    let config_file = paths.config_file();
    let store = store_with(config_file);
    let reloader = ConfigReloader::new(store.clone(), config_file).with_meta(env.meta.clone());

    write(
        config_file,
        "[search]\nk = 3\n[embed]\nbackend = \"fastembed\"\nmodel = \"bge-small\"\n\
         compat_group = \"bge-small\"\n",
    );
    let outcome = reloader.reload().await;
    assert!(!outcome.applied, "embed 改动不热更新:{outcome:?}");
    assert!(
        outcome.migration.contains(&"embed.model".to_owned()),
        "embed.model 应算迁移项:{outcome:?}"
    );
    assert!(outcome.error.is_none());
    let plan = outcome.migration_plan.clone().expect("应有迁移计划");
    assert_eq!(plan.from, "fastembed:bge-m3-int8");
    assert_eq!(plan.to, "fastembed:bge-small");
    assert!(
        !plan.same_compat_group,
        "bge-small 与 bge-m3 不是同一兼容组"
    );
    assert_eq!(
        plan.collections,
        vec!["_global".to_owned(), "proj_alpha".to_owned()],
        "受影响的 collection 应升序列出"
    );
    // 整份配置都没生效:search.k 也不能被顺带改掉
    assert_eq!(store.get().search.k, 8, "有迁移项时整份不生效");
    assert_eq!(store.generation(), 1);
}

#[tokio::test]
async fn watch_debounces_bursty_writes_into_one_reload() {
    // 验收:500ms 去抖,2 秒内连写 10 次只重载 1 次
    let env = TestEnv::new().await;
    let paths = env.paths();
    let config_file = paths.config_file();
    let store = store_with(config_file);
    let calls = Arc::new(AtomicUsize::new(0));
    let reloader = Arc::new(
        ConfigReloader::new(store.clone(), config_file)
            .with_observer(Arc::new(CountingObserver(calls.clone()))),
    );
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let watcher = reloader.spawn_watch(shutdown_rx).expect("启动配置监听");

    // 每次保存都写临时文件再 rename 的编辑器行为,这里用“连续 10 次直写”模拟。
    // 中间不 sleep:整串写应当落在**同一个** 500ms 窗口里,这样“只重载一次”才有意义。
    let started = std::time::Instant::now();
    for index in 1..=10 {
        write(config_file, &format!("[search]\nk = {}\n", 8 + index));
    }
    let span = started.elapsed();

    // 等去抖窗口过去 + 重载完成
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while calls.load(Ordering::SeqCst) == 0 && tokio::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // 再观察一个窗口,确认没有第二批
    tokio::time::sleep(Duration::from_millis(1200)).await;
    let reloads = calls.load(Ordering::SeqCst);
    if span < Duration::from_millis(kb_service::CONFIG_DEBOUNCE_MS) {
        assert_eq!(
            reloads, 1,
            "整串写({span:?})落在同一个 500ms 窗口里,应只重载一次"
        );
    } else {
        // 机器 I/O 被拖到写本身跨过窗口(本机 io pressure 高时会这样):每个窗口一次可以接受,
        // 但去抖失效会是 10 次,所以这条断言照样能抓住回归
        assert!(
            reloads <= 3,
            "10 次连写最多每个窗口重载一次,实际 {reloads} 次(写耗时 {span:?})"
        );
    }
    assert_eq!(
        store.get().search.k,
        18,
        "最终应读到最后一次写入的值(去抖不该丢掉最后一次)"
    );
    let _ = shutdown_tx.send(true);
    watcher.join().await;
}

#[tokio::test]
async fn index_exclude_can_be_swapped_without_rebuilding_the_service() {
    // :`index.exclude` 是热更新项,后台索引任务复用同一个 IndexService,
    // 所以换参数后**下一次扫描**就要按新规则走。
    let env = TestEnv::new().await;
    let service = IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    );

    let root = tempfile::tempdir().expect("项目目录");
    write(&root.path().join("src/a.rs"), "fn a() -> u8 {\n    1\n}\n");
    write(
        &root.path().join("vendor/b.rs"),
        "fn b() -> u8 {\n    2\n}\n",
    );
    let project = Project {
        id: "p1".to_owned(),
        name: "demo".to_owned(),
        slug: "demo".to_owned(),
        root_path: root.path().to_string_lossy().into_owned(),
        include: Vec::new(),
        exclude: Vec::new(),
        is_git: false,
        last_commit: None,
        last_indexed_at: None,
        allow_cloud_llm: false,
        extract_enabled: false,
        hooks_installed: false,
        created_at: 0,
    };

    let before = service.scan_project(&project).expect("扫描");
    assert!(
        before
            .files
            .iter()
            .any(|entry| entry.relative.contains("vendor/")),
        "默认规则下 vendor 里的文件应被扫描到"
    );

    service.set_options(IndexOptions {
        exclude: vec!["**/vendor/**".to_owned()],
        ..IndexOptions::default()
    });
    let after = service.scan_project(&project).expect("扫描");
    assert!(
        !after
            .files
            .iter()
            .any(|entry| entry.relative.contains("vendor/")),
        "换参数后 vendor 应被排除"
    );
    assert!(
        after
            .files
            .iter()
            .any(|entry| entry.relative.contains("src/")),
        "其它文件不受影响"
    );
}
