//! 文件监听去抖。

use std::path::Path;
use std::time::Duration;

use std::sync::Arc;

use kb_core::config::{Config, ConfigStore};
use kb_service::evolution::watch::{watch_project, watch_project_hot};

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

#[tokio::test]
async fn ten_saves_within_two_seconds_trigger_one_batch() {
    let dir = tempfile::tempdir().expect("临时目录");
    // 用默认的 2 秒去抖
    let (mut rx, _watcher) = watch_project(dir.path(), 2000, Vec::new()).expect("监听");
    tokio::time::sleep(Duration::from_millis(200)).await;

    let file = dir.path().join("src/a.rs");
    write(&file, "fn a() {}\n");
    // 2 秒内连续保存 10 次
    for index in 0..10 {
        write(&file, &format!("fn a() {{ {index} }}\n"));
        tokio::time::sleep(Duration::from_millis(150)).await;
    }

    // 等去抖窗口结束(2 秒)
    let batch = tokio::time::timeout(Duration::from_secs(6), rx.recv())
        .await
        .expect("应在 6 秒内收到批次")
        .expect("批次");
    assert_eq!(batch.paths, vec!["src/a.rs".to_owned()], "只应有一个路径");

    // 去抖窗口内不应再有第二批
    let extra = tokio::time::timeout(Duration::from_millis(2500), rx.recv()).await;
    assert!(extra.is_err(), "10 次保存应合并成 1 次:{extra:?}");
}

#[tokio::test]
async fn ignored_directories_do_not_trigger_indexing() {
    let dir = tempfile::tempdir().expect("临时目录");
    // 与扫描同一套排除规则:默认 glob(含嵌套 node_modules / dist / *.lock)+ 额外 exclude
    let (mut rx, _watcher) = watch_project(
        dir.path(),
        300,
        vec![
            "generated".to_owned(),
            "**/node_modules/**".to_owned(),
            "**/dist/**".to_owned(),
            "**/build/**".to_owned(),
            "**/*.lock".to_owned(),
        ],
    )
    .expect("监听");
    tokio::time::sleep(Duration::from_millis(200)).await;

    write(&dir.path().join("node_modules/pkg/a.js"), "x\n");
    write(&dir.path().join("frontend/node_modules/pkg/y.js"), "x\n");
    write(&dir.path().join("frontend/dist/bundle.js"), "x\n");
    write(&dir.path().join("build/out.txt"), "x\n");
    write(&dir.path().join("Cargo.lock"), "x\n");
    write(&dir.path().join("generated/out.rs"), "y\n");
    write(&dir.path().join(".git/index"), "z\n");

    let result = tokio::time::timeout(Duration::from_millis(1500), rx.recv()).await;
    assert!(result.is_err(), "被忽略目录的变化不应触发:{result:?}");
}

#[tokio::test]
async fn real_source_change_triggers_a_batch() {
    let dir = tempfile::tempdir().expect("临时目录");
    let (mut rx, _watcher) = watch_project(dir.path(), 200, Vec::new()).expect("监听");
    // 先建好目录并等监听生效:新建目录与其中的文件同时出现时,inotify 可能来不及挂上新目录的 watch
    std::fs::create_dir_all(dir.path().join("src")).expect("建目录");
    tokio::time::sleep(Duration::from_millis(300)).await;

    write(&dir.path().join("src/b.rs"), "fn b() {}\n");
    let batch = tokio::time::timeout(Duration::from_secs(3), rx.recv())
        .await
        .expect("应收到批次")
        .expect("批次");
    assert!(
        batch.paths.iter().any(|path| path == "src/b.rs"),
        "{batch:?}"
    );
}

/// 只给真正会被索引的目录挂监听:被排除、被 .gitignore、隐藏的目录一个都不挂。
/// 以前对项目根目录递归监听,node_modules / target 里的几万个目录也都占着内核监听项。
#[tokio::test]
async fn excluded_and_ignored_directories_are_not_watched() {
    let dir = tempfile::tempdir().expect("临时目录");
    for sub in [
        "src/deep",
        "node_modules/pkg",
        "target/debug",
        ".git/objects",
        ".cache",
        "generated",
    ] {
        std::fs::create_dir_all(dir.path().join(sub)).expect("建目录");
    }
    write(&dir.path().join(".gitignore"), "target/\n");

    let (_rx, watcher) = watch_project(
        dir.path(),
        200,
        vec!["generated".to_owned(), "**/node_modules/**".to_owned()],
    )
    .expect("监听");
    // 项目根、src、src/deep;其余全部不监听
    assert_eq!(watcher.watched_dirs(), 3);
}

/// 运行中新建的目录要补挂监听,而且建目录时就同时写进去的文件也不能漏
/// (inotify 来不及给新目录挂监听,这些文件的事件永远收不到,只能靠补挂时列一遍目录)。
#[tokio::test]
async fn new_directories_are_watched_and_existing_files_are_reported() {
    let dir = tempfile::tempdir().expect("临时目录");
    let (mut rx, watcher) = watch_project(dir.path(), 150, Vec::new()).expect("监听");
    assert_eq!(watcher.watched_dirs(), 1);
    tokio::time::sleep(Duration::from_millis(200)).await;

    // 目录和文件几乎同时出现
    write(&dir.path().join("deep/a/b/first.rs"), "fn first() {}\n");
    let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("应收到批次")
        .expect("批次");
    assert!(
        batch.paths.iter().any(|path| path == "deep/a/b/first.rs"),
        "建目录时就写进去的文件不能漏:{batch:?}"
    );
    assert_eq!(watcher.watched_dirs(), 4, "根 + deep + a + b");

    // 目录挂上监听之后,再写的文件靠监听本身收到
    write(&dir.path().join("deep/a/b/second.rs"), "fn second() {}\n");
    let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("应收到第二批")
        .expect("批次");
    assert!(
        batch.paths.iter().any(|path| path == "deep/a/b/second.rs"),
        "{batch:?}"
    );
}

/// 运行中新建的被排除目录同样不挂监听(比如 cargo build 现建出来的 target/)。
#[tokio::test]
async fn new_excluded_directories_stay_unwatched() {
    let dir = tempfile::tempdir().expect("临时目录");
    let (mut rx, watcher) =
        watch_project(dir.path(), 150, vec!["**/node_modules/**".to_owned()]).expect("监听");
    tokio::time::sleep(Duration::from_millis(200)).await;

    write(&dir.path().join("node_modules/pkg/x.js"), "x\n");
    write(&dir.path().join("src/ok.rs"), "fn ok() {}\n");
    let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("应收到批次")
        .expect("批次");
    assert_eq!(batch.paths, vec!["src/ok.rs".to_owned()], "{batch:?}");
    assert_eq!(watcher.watched_dirs(), 2, "只有根和 src");
}

/// 目录被删掉后,它和子目录的监听要从集合里清掉,否则同名目录重建后会被当成已经监听。
#[tokio::test]
async fn removed_directories_leave_the_watched_set() {
    let dir = tempfile::tempdir().expect("临时目录");
    std::fs::create_dir_all(dir.path().join("src/a")).expect("建目录");
    let (mut rx, watcher) = watch_project(dir.path(), 150, Vec::new()).expect("监听");
    assert_eq!(watcher.watched_dirs(), 3, "根 + src + src/a");
    tokio::time::sleep(Duration::from_millis(200)).await;

    std::fs::remove_dir_all(dir.path().join("src")).expect("删目录");
    let _ = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("删除应产生批次");
    assert_eq!(watcher.watched_dirs(), 1, "只剩根目录");

    // 同名重建后要重新挂上
    write(&dir.path().join("src/a/again.rs"), "fn again() {}\n");
    let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("重建后应收到批次")
        .expect("批次");
    assert!(
        batch.paths.iter().any(|path| path == "src/a/again.rs"),
        "{batch:?}"
    );
    assert_eq!(watcher.watched_dirs(), 3);
}

/// 排除规则热更新后(index.exclude 变了),原来被排除的目录要补挂监听,里面已有的文件要补报。
#[tokio::test]
async fn hot_unexcluding_a_directory_starts_watching_it() {
    let dir = tempfile::tempdir().expect("临时目录");
    write(&dir.path().join("vendor/lib/x.js"), "x\n");
    write(&dir.path().join("keep/a.rs"), "fn a() {}\n");

    let mut config = Config::default();
    config.index.exclude = vec!["vendor".to_owned()];
    let store = Arc::new(ConfigStore::new(config.clone()));
    let (mut rx, watcher) =
        watch_project_hot(dir.path(), 150, Vec::new(), store.clone()).expect("监听");
    assert_eq!(watcher.watched_dirs(), 2, "根 + keep;vendor 被排除");
    tokio::time::sleep(Duration::from_millis(200)).await;

    let mut next = config;
    next.index.exclude = Vec::new();
    store.replace(next);
    // 过滤规则在下一批事件到来时按新配置重建,这里用一次普通写入触发
    write(&dir.path().join("keep/trigger.rs"), "fn t() {}\n");
    let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
        .await
        .expect("应收到批次")
        .expect("批次");
    assert!(
        batch.paths.iter().any(|path| path == "vendor/lib/x.js"),
        "放开的目录里已有的文件要补报:{batch:?}"
    );
    assert_eq!(watcher.watched_dirs(), 4, "根 + keep + vendor + vendor/lib");
}

/// 手动探针(默认不跑):`KB_WATCH_PROBE_ROOT=<项目目录> cargo test -p kb-service --test watch -- --ignored --nocapture probe`
/// 打印按默认排除规则挂了多少个监听。只读,不改项目里的任何文件。
#[tokio::test(flavor = "multi_thread")]
#[ignore = "手动探针:需要 KB_WATCH_PROBE_ROOT 指向一个真实项目目录"]
async fn probe_watched_dirs_on_a_real_project() {
    let Ok(root) = std::env::var("KB_WATCH_PROBE_ROOT") else {
        return;
    };
    let exclude = Config::default().index.exclude;
    let started = std::time::Instant::now();
    let root_path = std::path::PathBuf::from(&root);
    let (_rx, watcher) = tokio::task::spawn_blocking(move || {
        watch_project(&root_path, 2000, exclude).expect("监听")
    })
    .await
    .expect("任务");
    println!(
        "PROBE root={root} watched_dirs={} elapsed_ms={}",
        watcher.watched_dirs(),
        started.elapsed().as_millis()
    );
}
