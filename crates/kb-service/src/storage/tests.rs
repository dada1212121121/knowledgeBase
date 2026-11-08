use super::*;

struct Space {
    _dir: tempfile::TempDir,
    paths: KbPaths,
}

fn space() -> Space {
    let dir = tempfile::tempdir().unwrap();
    let paths = KbPaths::from_home(dir.path());
    paths.ensure_dirs().unwrap();
    Space { _dir: dir, paths }
}

fn put(path: &Path, bytes: usize) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, vec![7u8; bytes]).unwrap();
}

#[test]
fn every_part_is_counted_separately_and_symlinks_are_not_followed() {
    let space = space();
    put(&space.paths.sources_dir().join("a/doc.pdf"), 1_000);
    put(&space.paths.sources_dir().join("b.txt"), 24);
    put(&space.paths.uploads_dir().join("u1/part.0"), 300);
    put(&space.paths.lance_dir().join("t.lance/data/x.bin"), 5_000);
    put(space.paths.meta_db(), 80);
    let wal = format!("{}-wal", space.paths.meta_db().display());
    put(Path::new(&wal), 20);
    // 指向目录外大文件的符号链接:不能让一个人靠它把别人的文件算进自己名下,也不能当成没有的东西报错
    let outside = tempfile::tempdir().unwrap();
    put(&outside.path().join("huge.bin"), 99_999);
    std::os::unix::fs::symlink(
        outside.path().join("huge.bin"),
        space.paths.sources_dir().join("link.bin"),
    )
    .unwrap();
    let usage = measure_space(&space.paths);
    assert_eq!(
        (
            usage.sources_bytes,
            usage.uploads_bytes,
            usage.vectors_bytes,
            usage.meta_bytes
        ),
        (1_024, 300, 5_000, 100)
    );
    assert_eq!(usage.total(), 6_424);
}

#[test]
fn an_empty_or_missing_space_measures_zero() {
    let dir = tempfile::tempdir().unwrap();
    let paths = KbPaths::from_home(dir.path().join("nowhere"));
    assert_eq!(measure_space(&paths), SpaceUsage::default());
}

#[test]
fn the_agent_workspace_counts_and_belongs_to_each_space() {
    let dir = tempfile::tempdir().unwrap();
    let root = KbPaths::from_home(dir.path());
    // 主知识库的工作目录在根目录,其它知识库各有各的
    assert_eq!(root.agent_workspace(), dir.path().join("agent-workspace"));
    let alice = root.for_space("sp_alice").unwrap();
    let bob = root.for_space("sp_bob").unwrap();
    assert_eq!(
        alice.agent_workspace(),
        dir.path().join("spaces/sp_alice/agent-workspace")
    );
    assert_ne!(alice.agent_workspace(), bob.agent_workspace());
    put(&alice.agent_workspace().join("big.bin"), 700);
    put(&alice.agent_workspace().join("sub/small.bin"), 30);
    put(&bob.agent_workspace().join("other.bin"), 5);
    let usage = measure_space(&alice);
    assert_eq!(usage.workspace_bytes, 730);
    assert_eq!(usage.total(), 730, "工作目录计入配额合计");
    assert_eq!(measure_space(&bob).workspace_bytes, 5, "别人的不算在我头上");
}

#[tokio::test]
async fn the_cache_serves_for_the_ttl_then_remeasures() {
    let space = space();
    put(&space.paths.sources_dir().join("a"), 100);
    let meter = StorageMeter::new(Duration::from_millis(80));
    assert_eq!(meter.usage("sp1", &space.paths).await.sources_bytes, 100);
    put(&space.paths.sources_dir().join("b"), 50);
    assert_eq!(
        meter.usage("sp1", &space.paths).await.sources_bytes,
        100,
        "缓存期内不重数"
    );
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(meter.usage("sp1", &space.paths).await.sources_bytes, 150);
    // 删了东西:主动失效,马上能看到释放出来的空间
    std::fs::remove_file(space.paths.sources_dir().join("b")).unwrap();
    meter.invalidate("sp1");
    assert_eq!(meter.usage("sp1", &space.paths).await.sources_bytes, 100);
}

#[tokio::test]
async fn reservations_stop_concurrent_uploads_from_jointly_exceeding_the_limit() {
    let space = space();
    put(&space.paths.sources_dir().join("existing"), 400);
    let meter = StorageMeter::new(Duration::from_secs(60));
    let paths = space.paths.clone();
    // 上限 1000,已用 400:每个请求要 100,最多放行 6 个;20 个同时来
    let mut tasks = Vec::new();
    for _ in 0..20 {
        let (meter, paths) = (meter.clone(), paths.clone());
        tasks.push(tokio::spawn(async move {
            meter.reserve("sp1", &paths, 100, 1_000).await.is_ok()
        }));
    }
    let mut granted = 0;
    for task in tasks {
        if task.await.unwrap() {
            granted += 1;
        }
    }
    assert_eq!(granted, 6, "400 + 6×100 = 1000 刚好满,第 7 个起都被拒");
}

#[tokio::test]
async fn a_refusal_names_the_numbers_and_the_hidden_part_and_changes_nothing() {
    let space = space();
    let gib = 1024u64 * 1024 * 1024;
    put(&space.paths.lance_dir().join("v.bin"), 2_000_000);
    let meter = StorageMeter::new(Duration::from_secs(60));
    let error = meter
        .reserve("sp1", &space.paths, gib, gib)
        .await
        .expect_err("装不下");
    let text = error.to_string();
    assert!(matches!(error, KbError::InvalidInput(_)), "{text}");
    assert!(
        text.contains("1 GB") && text.contains("含向量索引"),
        "要让用户明白那部分看不见的空间也算:{text}"
    );
    // 被拒的请求不占预留:小一点的随后能过
    meter
        .reserve("sp1", &space.paths, 1_000, gib)
        .await
        .expect("被拒的请求没占位置");
}

#[tokio::test]
async fn a_limit_of_zero_means_unlimited_and_never_touches_the_disk() {
    let meter = StorageMeter::new(Duration::from_secs(60));
    let nowhere = KbPaths::from_home("/definitely/not/here");
    meter
        .reserve("sp1", &nowhere, u64::MAX, 0)
        .await
        .expect("不限");
}

#[tokio::test]
async fn remeasuring_clears_reservations_because_the_bytes_have_landed() {
    let space = space();
    let meter = StorageMeter::new(Duration::from_millis(60));
    meter
        .reserve("sp1", &space.paths, 900, 1_000)
        .await
        .unwrap();
    assert!(
        meter
            .reserve("sp1", &space.paths, 200, 1_000)
            .await
            .is_err()
    );
    // 上传落盘了(这 900 字节现在是真实文件),再等缓存过期重数
    put(&space.paths.sources_dir().join("landed"), 900);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(
        meter
            .reserve("sp1", &space.paths, 200, 1_000)
            .await
            .is_err(),
        "重数后 900 是真实用量,不是预留,仍然装不下 200"
    );
    assert!(meter.reserve("sp1", &space.paths, 100, 1_000).await.is_ok());
}

#[tokio::test]
async fn a_cold_cache_hit_by_many_requests_is_measured_exactly_once() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let meter = StorageMeter::with_measurer(
        Duration::from_secs(60),
        Arc::new(move |_| {
            counter.fetch_add(1, Ordering::SeqCst);
            // 数得慢一点,让别的请求都赶上来排队
            std::thread::sleep(Duration::from_millis(60));
            SpaceUsage {
                sources_bytes: 10,
                ..Default::default()
            }
        }),
    );
    let paths = KbPaths::from_home("/nowhere");
    let mut tasks = Vec::new();
    for _ in 0..10 {
        let (meter, paths) = (meter.clone(), paths.clone());
        tasks.push(tokio::spawn(async move {
            meter.usage("sp1", &paths).await.sources_bytes
        }));
    }
    for task in tasks {
        assert_eq!(task.await.unwrap(), 10);
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "排队的请求醒来后直接用第一个人的结果"
    );
}

#[tokio::test]
async fn only_reservations_that_predate_a_measurement_are_cleared_by_it() {
    let meter = StorageMeter::new(Duration::from_secs(60));
    let paths = KbPaths::from_home("/nowhere");
    // 预留 100;统计开始时看到的预留是 100;统计期间又来了一个 50;统计结束只清掉那 100
    meter
        .reserve("sp1", &paths, 100, u64::MAX / 2)
        .await
        .unwrap();
    let before = meter.reserved_now("sp1");
    assert_eq!(before, 100);
    meter
        .reserve("sp1", &paths, 50, u64::MAX / 2)
        .await
        .unwrap();
    meter.store_after("sp1", SpaceUsage::default(), before);
    assert_eq!(
        meter.reserved_now("sp1"),
        50,
        "统计期间新占的位置不能被擦掉"
    );
    // 擦过头也不会变成负数
    meter.store_after("sp1", SpaceUsage::default(), 9_999);
    assert_eq!(meter.reserved_now("sp1"), 0);
}
