//! kb-meta 的集成测试:迁移幂等、各表 CRUD、外键级联、并发读写。
//!
//! 每个测试用自己的临时目录,不碰真实的 `~/.kb`。

use kb_core::model::{
    ApiToken, AuditEntry, AuditFilter, Batch, Change, ChunkMeta, Collection, CollectionKind,
    ContextMode, Draft, DraftState, Edge, EdgeRel, Event, Feedback, FileChange, FileRecord,
    Insight, InsightKind, ItemStatus, Job, JobFile, JobFilter, JobState, LlmSend, LlmUsage, Page,
    Project, Session,
};
use kb_core::ports::repo::{
    ActivityRepo, AnnotationRepo, AuditRepo, AuthRepo, ChunkRepo, CollectionRepo, DraftRepo,
    EdgeRepo, EventRepo, FeedbackRepo, FileRepo, InsightRepo, JobRepo, LlmUsageRepo, ProjectRepo,
    VersionRepo,
};
use kb_meta::{RetentionTable, SqliteMetaStore};

fn now() -> i64 {
    1_700_000_000_000
}

fn open_store() -> (tempfile::TempDir, SqliteMetaStore) {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开数据库");
    (dir, store)
}

fn project(id: &str, name: &str, root: &str) -> Project {
    Project {
        id: id.to_owned(),
        name: name.to_owned(),
        slug: name.to_lowercase(),
        root_path: root.to_owned(),
        include: vec!["src/**".to_owned()],
        exclude: vec!["target/**".to_owned()],
        is_git: true,
        last_commit: Some("abc123".to_owned()),
        last_indexed_at: None,
        allow_cloud_llm: false,
        extract_enabled: true,
        hooks_installed: false,
        created_at: now(),
    }
}

fn collection(name: &str, project_id: Option<&str>) -> Collection {
    Collection {
        name: name.to_owned(),
        kind: if name == "_global" {
            CollectionKind::Global
        } else {
            CollectionKind::Project
        },
        project_id: project_id.map(str::to_owned),
        embedder_id: "fake:8".to_owned(),
        dim: 8,
        active_table: format!("{name}__fake8__v1"),
        table_version: 1,
        migrating_to: None,
        migration_started_at: None,
        retired_tables: Vec::new(),
        context_mode: ContextMode::Header,
        created_at: now(),
    }
}

fn insight(id: &str, title: &str, superseded_by: Option<&str>) -> Insight {
    Insight {
        id: id.to_owned(),
        collection: "proj_demo".to_owned(),
        title: title.to_owned(),
        body_md: format!("正文 {title}"),
        kind: InsightKind::Decision,
        tags: vec!["决策".to_owned()],
        related_paths: vec!["src/lib.rs".to_owned()],
        status: if superseded_by.is_some() {
            ItemStatus::Superseded
        } else {
            ItemStatus::Active
        },
        version: 1,
        valid_from: now(),
        valid_until: None,
        superseded_by: superseded_by.map(str::to_owned),
        created_by: "mcp:kiro".to_owned(),
        batch_id: None,
        created_at: now(),
        updated_at: now(),
    }
}

fn chunk(id: &str, ordinal: u32) -> ChunkMeta {
    ChunkMeta {
        id: id.to_owned(),
        collection: "proj_demo".to_owned(),
        path: "src/lib.rs".to_owned(),
        ordinal,
        content_hash: format!("c{id}"),
        meta_hash: format!("m{id}"),
        embed_input_hash: format!("e{id}"),
        updated_at: now(),
    }
}

#[tokio::test]
async fn migrations_are_idempotent_across_reopens() {
    // 最新版本号取迁移表,而不是写死:新增迁移(例如 的 0002)时这里仍然成立
    let latest = kb_meta::MIGRATIONS.last().expect("至少一个迁移").0;
    let dir = tempfile::tempdir().expect("临时目录");
    let path = dir.path().join("meta.db");
    let store = SqliteMetaStore::open(&path).expect("首次打开");
    assert_eq!(store.schema_version().await.expect("版本"), latest);
    drop(store);

    // 再次打开 = 再跑一遍迁移,不应报错,版本不变
    let store = SqliteMetaStore::open(&path).expect("再次打开");
    assert_eq!(store.schema_version().await.expect("版本"), latest);

    // 直接用 rusqlite 再跑一次迁移函数也应幂等
    let mut conn = rusqlite::Connection::open(&path).expect("原生连接");
    assert_eq!(kb_meta::run_migrations(&mut conn).expect("迁移"), latest);
    assert_eq!(kb_meta::run_migrations(&mut conn).expect("迁移"), latest);
}

#[tokio::test]
async fn project_crud_and_cwd_matching() {
    let (_dir, store) = open_store();
    ProjectRepo::create(&store, project("p1", "Demo", "/srv/workspace/demo"))
        .await
        .expect("创建");
    let loaded = ProjectRepo::get(&store, "p1")
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(loaded.name, "Demo");
    assert_eq!(loaded.include, ["src/**"]);
    assert!(loaded.is_git);
    assert!(
        ProjectRepo::get_by_name(&store, "Demo")
            .await
            .expect("按名")
            .is_some()
    );
    assert!(
        ProjectRepo::get_by_name(&store, "nope")
            .await
            .expect("按名")
            .is_none()
    );
    assert_eq!(ProjectRepo::list(&store).await.expect("列表").len(), 1);

    let mut updated = loaded.clone();
    updated.name = "Demo2".to_owned();
    updated.allow_cloud_llm = true;
    updated.last_indexed_at = Some(now());
    ProjectRepo::update(&store, updated.clone())
        .await
        .expect("更新");
    let reloaded = ProjectRepo::get(&store, "p1")
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(reloaded.name, "Demo2");
    assert!(reloaded.allow_cloud_llm);
    assert_eq!(reloaded.last_indexed_at, Some(now()));

    // 最长前缀匹配
    assert_eq!(
        ProjectRepo::match_cwd(&store, "/srv/workspace/demo/src/x.rs")
            .await
            .expect("匹配")
            .map(|p| p.id),
        Some("p1".to_owned())
    );
    assert!(
        ProjectRepo::match_cwd(&store, "/srv/workspace/demo2/x")
            .await
            .expect("匹配")
            .is_none()
    );
    assert!(
        ProjectRepo::match_cwd(&store, "/srv/workspace")
            .await
            .expect("匹配")
            .is_none()
    );

    ProjectRepo::delete(&store, "p1").await.expect("删除");
    assert!(
        ProjectRepo::get(&store, "p1")
            .await
            .expect("查询")
            .is_none()
    );
    assert!(
        ProjectRepo::delete(&store, "p1").await.is_err(),
        "重复删除应报 NotFound"
    );
}

#[tokio::test]
async fn collection_switch_active_updates_pointer_and_retired() {
    let (_dir, store) = open_store();
    ProjectRepo::create(&store, project("p1", "Demo", "/tmp/demo"))
        .await
        .expect("项目");
    CollectionRepo::create(&store, collection("proj_demo", Some("p1")))
        .await
        .expect("collection");

    CollectionRepo::switch_active(
        &store,
        "proj_demo",
        "proj_demo__fake8__v2",
        "http:bge-m3",
        1024,
    )
    .await
    .expect("切换");

    let current = CollectionRepo::get(&store, "proj_demo")
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(current.active_table, "proj_demo__fake8__v2");
    assert_eq!(current.table_version, 2);
    assert_eq!(current.embedder_id, "http:bge-m3");
    assert_eq!(current.dim, 1024);
    assert_eq!(current.retired_tables, ["proj_demo__fake8__v1"]);
    assert!(current.migrating_to.is_none());
}

#[tokio::test]
async fn foreign_keys_cascade_from_project_and_collection() {
    let (_dir, store) = open_store();
    ProjectRepo::create(&store, project("p1", "Demo", "/tmp/demo"))
        .await
        .expect("项目");
    CollectionRepo::create(&store, collection("proj_demo", Some("p1")))
        .await
        .expect("collection");
    FileRepo::upsert(
        &store,
        FileRecord {
            collection: "proj_demo".to_owned(),
            path: "src/lib.rs".to_owned(),
            file_hash: "h1".to_owned(),
            size: 10,
            mtime: now(),
            indexed_at: now(),
            status: "ok".to_owned(),
            error: None,
        },
    )
    .await
    .expect("文件");

    // 删项目 → collection 级联删除 → files 级联删除
    ProjectRepo::delete(&store, "p1").await.expect("删除项目");
    assert!(
        CollectionRepo::get(&store, "proj_demo")
            .await
            .expect("查询")
            .is_none()
    );
    assert!(
        FileRepo::get(&store, "proj_demo", "src/lib.rs")
            .await
            .expect("查询文件")
            .is_none(),
        "files 应随 collection 级联删除"
    );

    // 单独删 collection 也会级联删 files
    ProjectRepo::create(&store, project("p2", "Demo2", "/tmp/demo2"))
        .await
        .expect("项目");
    CollectionRepo::create(&store, collection("proj_demo2", Some("p2")))
        .await
        .expect("collection");
    FileRepo::upsert(
        &store,
        FileRecord {
            collection: "proj_demo2".to_owned(),
            path: "a.rs".to_owned(),
            file_hash: "h2".to_owned(),
            size: 1,
            mtime: now(),
            indexed_at: now(),
            status: "ok".to_owned(),
            error: None,
        },
    )
    .await
    .expect("文件");
    CollectionRepo::delete(&store, "proj_demo2")
        .await
        .expect("删除 collection");
    assert!(
        FileRepo::get(&store, "proj_demo2", "a.rs")
            .await
            .expect("查询")
            .is_none()
    );
}

#[tokio::test]
async fn files_and_chunks_crud() {
    let (_dir, store) = open_store();
    ProjectRepo::create(&store, project("p1", "Demo", "/tmp/demo"))
        .await
        .expect("项目");
    CollectionRepo::create(&store, collection("proj_demo", Some("p1")))
        .await
        .expect("collection");

    FileRepo::upsert(
        &store,
        FileRecord {
            collection: "proj_demo".to_owned(),
            path: "src/lib.rs".to_owned(),
            file_hash: "h1".to_owned(),
            size: 100,
            mtime: now(),
            indexed_at: now(),
            status: "ok".to_owned(),
            error: None,
        },
    )
    .await
    .expect("写入");
    // 同一个 (collection, path) 再写一次是 upsert
    FileRepo::upsert(
        &store,
        FileRecord {
            collection: "proj_demo".to_owned(),
            path: "src/lib.rs".to_owned(),
            file_hash: "h2".to_owned(),
            size: 200,
            mtime: now() + 1,
            indexed_at: now() + 2,
            status: "error".to_owned(),
            error: Some("解码失败".to_owned()),
        },
    )
    .await
    .expect("覆盖");
    let file = FileRepo::get(&store, "proj_demo", "src/lib.rs")
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(file.file_hash, "h2");
    assert_eq!(file.size, 200);
    assert_eq!(file.status, "error");
    assert_eq!(file.error.as_deref(), Some("解码失败"));
    assert_eq!(
        FileRepo::list_paths(&store, "proj_demo")
            .await
            .expect("路径"),
        ["src/lib.rs"]
    );

    // chunks:replace_for_path 是整体替换
    ChunkRepo::replace_for_path(
        &store,
        "proj_demo",
        "src/lib.rs",
        vec![chunk("a", 0), chunk("b", 1)],
    )
    .await
    .expect("写入块");
    assert_eq!(
        ChunkRepo::count(&store, "proj_demo").await.expect("计数"),
        2
    );
    let by_path = ChunkRepo::by_path(&store, "proj_demo", "src/lib.rs")
        .await
        .expect("按路径");
    assert_eq!(
        by_path.iter().map(|c| c.ordinal).collect::<Vec<_>>(),
        [0, 1]
    );

    ChunkRepo::replace_for_path(&store, "proj_demo", "src/lib.rs", vec![chunk("c", 0)])
        .await
        .expect("替换");
    assert_eq!(
        ChunkRepo::count(&store, "proj_demo").await.expect("计数"),
        1
    );
    assert_eq!(
        ChunkRepo::by_path(&store, "proj_demo", "src/lib.rs")
            .await
            .expect("按路径")[0]
            .id,
        "c"
    );

    // ids_after / updated_since
    ChunkRepo::replace_for_path(
        &store,
        "proj_demo",
        "src/lib.rs",
        vec![chunk("a", 0), chunk("b", 1), chunk("c", 2)],
    )
    .await
    .expect("写入块");
    let after = ChunkRepo::ids_after(&store, "proj_demo", Some("a"), 10)
        .await
        .expect("翻页");
    assert_eq!(
        after.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["b", "c"]
    );
    let since = ChunkRepo::updated_since(&store, "proj_demo", now() - 1, 10)
        .await
        .expect("按时间");
    assert_eq!(since.len(), 3);
    assert!(
        ChunkRepo::updated_since(&store, "proj_demo", now(), 10)
            .await
            .expect("按时间")
            .is_empty()
    );

    FileRepo::delete(&store, "proj_demo", "src/lib.rs")
        .await
        .expect("删除文件");
    assert!(
        FileRepo::get(&store, "proj_demo", "src/lib.rs")
            .await
            .expect("查询")
            .is_none()
    );
}

#[tokio::test]
async fn insight_crud_version_conflict_and_history() {
    let (_dir, store) = open_store();
    ProjectRepo::create(&store, project("p1", "Demo", "/tmp/demo"))
        .await
        .expect("项目");
    CollectionRepo::create(&store, collection("proj_demo", Some("p1")))
        .await
        .expect("collection");

    // superseded_by 有外键约束,所以从链尾往链头插
    InsightRepo::create(&store, insight("i3", "第三条", None))
        .await
        .expect("i3");
    InsightRepo::create(&store, insight("i2", "第二条", Some("i3")))
        .await
        .expect("i2");
    InsightRepo::create(&store, insight("i1", "第一条", Some("i2")))
        .await
        .expect("i1");

    let loaded = InsightRepo::get(&store, "i2")
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(loaded.title, "第二条");
    assert_eq!(loaded.tags, ["决策"]);

    // 乐观锁:版本正确时 +1
    let mut editing = loaded.clone();
    editing.title = "第二条(改)".to_owned();
    let updated = InsightRepo::update(&store, editing.clone(), 1)
        .await
        .expect("更新");
    assert_eq!(updated.version, 2);
    assert_eq!(updated.title, "第二条(改)");

    // 版本过期 → Conflict
    match InsightRepo::update(&store, editing, 1).await {
        Err(kb_core::KbError::Conflict { expected, actual }) => {
            assert_eq!((expected, actual), (1, 2));
        }
        other => panic!("应返回 Conflict,实际 {other:?}"),
    }

    // 演进链:i1 → i2 → i3
    let chain = InsightRepo::history(&store, "i2").await.expect("演进链");
    assert_eq!(
        chain.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
        ["i1", "i2", "i3"]
    );
    let chain_from_tail = InsightRepo::history(&store, "i3").await.expect("演进链");
    assert_eq!(chain_from_tail.len(), 3);
    assert!(
        InsightRepo::history(&store, "nope").await.is_err(),
        "不存在的 id 应报错"
    );

    // 分页与状态过滤
    let active = InsightRepo::list(
        &store,
        "proj_demo",
        Some(ItemStatus::Active),
        Page::default(),
    )
    .await
    .expect("列表");
    assert_eq!(active.len(), 1);
    let all = InsightRepo::list(&store, "proj_demo", None, Page::default())
        .await
        .expect("列表");
    assert_eq!(all.len(), 3);
    let paged = InsightRepo::list(&store, "proj_demo", None, Page::new(2, 1))
        .await
        .expect("分页");
    assert_eq!(paged.len(), 2);
}

#[tokio::test]
async fn edges_are_added_and_queried_both_ways() {
    let (_dir, store) = open_store();
    let edge = Edge {
        src_id: "i1".to_owned(),
        dst: "path:src/lib.rs".to_owned(),
        rel: EdgeRel::AboutFile,
        created_at: now(),
    };
    EdgeRepo::add(&store, edge.clone()).await.expect("添加");
    EdgeRepo::add(&store, edge).await.expect("重复添加是幂等的");
    assert_eq!(EdgeRepo::by_src(&store, "i1").await.expect("按源").len(), 1);
    assert_eq!(
        EdgeRepo::by_dst(&store, "path:src/lib.rs")
            .await
            .expect("按目标")
            .len(),
        1
    );
    assert_eq!(
        EdgeRepo::by_src(&store, "i1").await.expect("按源")[0].rel,
        EdgeRel::AboutFile
    );
    EdgeRepo::remove(&store, "i1", "path:src/lib.rs", EdgeRel::AboutFile)
        .await
        .expect("删除");
    assert!(
        EdgeRepo::by_src(&store, "i1")
            .await
            .expect("按源")
            .is_empty()
    );
}

fn job_with(
    id: &str,
    state: JobState,
    priority: i32,
    created_at: i64,
    finished_at: Option<i64>,
) -> Job {
    Job {
        id: id.to_owned(),
        kind: "index".to_owned(),
        collection: Some("proj_demo".to_owned()),
        priority,
        state,
        payload_json: "x".repeat(2048),
        checkpoint_json: Some("{\"last\":1}".to_owned()),
        detail: None,
        progress_done: 3,
        progress_total: Some(10),
        rate: None,
        error: None,
        created_at,
        started_at: None,
        finished_at,
    }
}

#[tokio::test]
async fn created_since_returns_only_recent_rows_without_bodies() {
    let (_dir, store) = open_store();
    for (id, created) in [("old", 1_000), ("edge", 5_000), ("new", 9_000)] {
        let mut item = insight(id, id, None);
        item.created_at = created;
        InsightRepo::create(&store, item).await.expect("新建");
    }
    let mut found = InsightRepo::created_since(&store, 5_000)
        .await
        .expect("查询");
    found.sort_by_key(|(_, created)| *created);
    assert_eq!(
        found,
        vec![
            ("proj_demo".to_owned(), 5_000),
            ("proj_demo".to_owned(), 9_000)
        ],
        "边界值算在内,更早的不返回"
    );
}

#[tokio::test]
async fn job_summaries_skip_heavy_columns_but_keep_the_rest() {
    let (_dir, store) = open_store();
    JobRepo::enqueue(&store, job_with("j1", JobState::Queued, 60, 1_000, None))
        .await
        .expect("入队");
    let summaries = JobRepo::list_summaries(&store, None).await.expect("摘要");
    assert_eq!(summaries.len(), 1);
    assert_eq!(summaries[0].payload_json, "");
    assert_eq!(summaries[0].checkpoint_json, None);
    assert_eq!(summaries[0].progress_done, 3);
    assert_eq!(summaries[0].priority, 60);
    // 完整读取不受影响
    let full = JobRepo::list(&store, None).await.expect("完整");
    assert_eq!(full[0].payload_json.len(), 2048);
    assert!(full[0].checkpoint_json.is_some());
    assert_eq!(
        JobRepo::list_summaries(&store, Some(JobState::Done))
            .await
            .expect("按状态")
            .len(),
        0
    );
}

#[tokio::test]
async fn job_counts_recent_and_priority_probe_use_sql() {
    let (_dir, store) = open_store();
    for (id, state, priority, created) in [
        ("a", JobState::Done, 20, 100),
        ("b", JobState::Done, 20, 200),
        ("c", JobState::Failed, 20, 300),
        ("d", JobState::Queued, 60, 400),
    ] {
        JobRepo::enqueue(
            &store,
            job_with(id, state, priority, created, Some(created)),
        )
        .await
        .expect("入队");
    }
    let counts = JobRepo::count_by_state(&store).await.expect("计数");
    let get = |state: JobState| counts.iter().find(|(s, _)| *s == state).map(|(_, n)| *n);
    assert_eq!(counts.len(), 6, "六种状态都要有,缺的补 0");
    assert_eq!(get(JobState::Done), Some(2));
    assert_eq!(get(JobState::Failed), Some(1));
    assert_eq!(get(JobState::Queued), Some(1));
    assert_eq!(get(JobState::Paused), Some(0));

    let recent = JobRepo::recent_summaries(&store, 2).await.expect("最近");
    assert_eq!(
        recent.iter().map(|job| job.id.as_str()).collect::<Vec<_>>(),
        vec!["d", "c"]
    );

    assert!(JobRepo::has_queued_above(&store, 20).await.expect("探测"));
    assert!(!JobRepo::has_queued_above(&store, 60).await.expect("探测"));
}

#[tokio::test]
async fn prune_failed_only_touches_old_failed_jobs() {
    let (_dir, store) = open_store();
    for (id, state, created, finished) in [
        ("old-failed", JobState::Failed, 100, Some(150)),
        ("old-failed-no-finish", JobState::Failed, 120, None),
        ("new-failed", JobState::Failed, 900, Some(950)),
        ("old-done", JobState::Done, 100, Some(150)),
        ("old-canceled", JobState::Canceled, 100, Some(150)),
    ] {
        JobRepo::enqueue(&store, job_with(id, state, 20, created, finished))
            .await
            .expect("入队");
    }
    assert_eq!(
        JobRepo::prune_failed(&store, 500, true)
            .await
            .expect("预览"),
        2
    );
    assert_eq!(
        JobRepo::list(&store, None).await.expect("列表").len(),
        5,
        "预览不能删"
    );
    assert_eq!(
        JobRepo::prune_failed(&store, 500, false)
            .await
            .expect("清理"),
        2
    );
    let left: Vec<String> = JobRepo::list(&store, None)
        .await
        .expect("列表")
        .into_iter()
        .map(|job| job.id)
        .collect();
    assert!(left.contains(&"new-failed".to_owned()));
    assert!(left.contains(&"old-done".to_owned()));
    assert!(left.contains(&"old-canceled".to_owned()));
    assert_eq!(left.len(), 3);
}

#[tokio::test]
async fn prune_history_clears_old_rows_and_keeps_unfinished_jobs() {
    let (_dir, store) = open_store();
    for (id, state, created, finished) in [
        ("old-done", JobState::Done, 100, Some(150)),
        ("old-failed", JobState::Failed, 100, Some(150)),
        ("old-queued", JobState::Queued, 100, None),
        ("old-running", JobState::Running, 100, None),
        ("old-paused", JobState::Paused, 100, Some(150)),
        ("new-done", JobState::Done, 900, Some(950)),
    ] {
        JobRepo::enqueue(&store, job_with(id, state, 20, created, finished))
            .await
            .expect("入队");
    }
    let jobs = RetentionTable::Jobs;
    // 预览不删:只有「已结束且够老」的两条算数,排队/运行/暂停的都不在里面
    assert_eq!(store.prune_history(jobs, 500, true).await.expect("预览"), 2);
    assert_eq!(
        JobRepo::list(&store, None).await.expect("列表").len(),
        6,
        "预览不能删"
    );
    assert_eq!(
        store.prune_history(jobs, 500, false).await.expect("清理"),
        2
    );
    let left: Vec<String> = JobRepo::list(&store, None)
        .await
        .expect("列表")
        .into_iter()
        .map(|job| job.id)
        .collect();
    assert_eq!(left.len(), 4, "只剩在办的和新的:{left:?}");
    for id in ["old-queued", "old-running", "old-paused"] {
        assert!(left.contains(&id.to_owned()), "在办的 {id} 不能被清");
    }
    assert!(left.contains(&"new-done".to_owned()));
    // 再清一次应该是 0(已经清干净了)
    assert_eq!(
        store.prune_history(jobs, 500, false).await.expect("复查"),
        0
    );
}

#[tokio::test]
async fn prune_history_covers_audit_and_events() {
    let (_dir, store) = open_store();
    // 审计:老的 2 条、新的 1 条
    for at in [100, 200, 900] {
        AuditRepo::record(
            &store,
            AuditEntry {
                id: None,
                at,
                actor: "user:demo".to_owned(),
                capability: "kb.search".to_owned(),
                args_json: "{}".to_owned(),
                ok: true,
                error: None,
                batch_id: None,
                dry_run: false,
                took_ms: None,
                degraded: None,
            },
        )
        .await
        .expect("写审计");
    }
    // 事件:老的 1 条、新的 1 条
    for (id, at) in [("e1", 100), ("e2", 900)] {
        EventRepo::append(
            &store,
            Event {
                id: id.to_owned(),
                kind: "manual".to_owned(),
                project_id: None,
                payload_json: "{}".to_owned(),
                received_at: at,
                processed_at: None,
                result: None,
            },
        )
        .await
        .expect("写事件");
    }
    assert_eq!(
        store
            .prune_history(RetentionTable::Audit, 500, false)
            .await
            .expect("清审计"),
        2
    );
    assert_eq!(
        store
            .prune_history(RetentionTable::Events, 500, false)
            .await
            .expect("清事件"),
        1
    );
    let audits = AuditRepo::list(&store, None, Page::new(10, 0))
        .await
        .expect("审计列表");
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0].at, 900);
    let events = EventRepo::recent(&store, 10).await.expect("事件列表");
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].id, "e2");
}

#[tokio::test]
async fn jobs_are_ordered_by_priority_and_requeued_on_restart() {
    let (_dir, store) = open_store();
    for (id, priority) in [("j-low", 20), ("j-high", 100), ("j-mid", 60)] {
        JobRepo::enqueue(
            &store,
            Job {
                id: id.to_owned(),
                kind: "index".to_owned(),
                collection: Some("proj_demo".to_owned()),
                priority,
                state: JobState::Queued,
                payload_json: "{}".to_owned(),
                checkpoint_json: None,
                detail: None,
                progress_done: 0,
                progress_total: Some(10),
                rate: None,
                error: None,
                created_at: now(),
                started_at: None,
                finished_at: None,
            },
        )
        .await
        .expect("入队");
    }

    let first = JobRepo::next_runnable(&store)
        .await
        .expect("取任务")
        .expect("有任务");
    assert_eq!(first.id, "j-high");

    let mut running = first.clone();
    running.state = JobState::Running;
    running.started_at = Some(now());
    running.progress_done = 4;
    running.checkpoint_json = Some(r#"{"last_path":"src/a.rs"}"#.to_owned());
    JobRepo::update(&store, running).await.expect("更新");

    let reloaded = JobRepo::get(&store, "j-high")
        .await
        .expect("查询")
        .expect("存在");
    assert_eq!(reloaded.state, JobState::Running);
    assert_eq!(reloaded.progress_done, 4);
    assert_eq!(
        reloaded.checkpoint_json.as_deref(),
        Some(r#"{"last_path":"src/a.rs"}"#)
    );
    assert_eq!(
        JobRepo::next_runnable(&store)
            .await
            .expect("取任务")
            .expect("有任务")
            .id,
        "j-mid"
    );
    assert_eq!(
        JobRepo::list(&store, Some(JobState::Queued))
            .await
            .expect("列表")
            .len(),
        2
    );

    // 重启恢复
    assert_eq!(JobRepo::requeue_running(&store).await.expect("恢复"), 1);
    assert_eq!(
        JobRepo::get(&store, "j-high")
            .await
            .expect("查询")
            .expect("存在")
            .state,
        JobState::Queued
    );
    assert!(
        JobRepo::get(&store, "j-high")
            .await
            .expect("查询")
            .expect("存在")
            .started_at
            .is_none()
    );
}

/// 造一个任意形状的任务(列表 / 统计测试用)。
#[allow(clippy::too_many_arguments)]
fn job_full(
    id: &str,
    kind: &str,
    collection: Option<&str>,
    state: JobState,
    priority: i32,
    created_at: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
) -> Job {
    Job {
        id: id.to_owned(),
        kind: kind.to_owned(),
        collection: collection.map(str::to_owned),
        priority,
        state,
        payload_json: "p".repeat(512),
        checkpoint_json: Some("{\"done\":1}".to_owned()),
        detail: None,
        progress_done: 1,
        progress_total: Some(2),
        rate: None,
        error: None,
        created_at,
        started_at,
        finished_at,
    }
}

/// 任务列表的「详情」列:SQL 只取几个标量,不读 payload 大列,但详情要和旧版一致。
/// 这里同时覆盖坏 JSON 的行:它不能让整页查询报错。
#[tokio::test]
async fn job_list_detail_comes_from_payload_without_reading_it() {
    let (_dir, store) = open_store();
    let rows = [
        ("single", r#"{"mode":"incremental","paths":["src/a.rs"]}"#),
        (
            "multi",
            r#"{"mode":"incremental","paths":["src/a.rs","src/b.rs","src/c.rs"]}"#,
        ),
        ("full", r#"{"mode":"full","paths":[]}"#),
        ("insight", r#"{"insight_id":"n-1"}"#),
        ("batch", r#"{"batch_id":"b-1"}"#),
        ("file", r#"{"path":"docs/a.md"}"#),
        ("no-detail", r#"{"mode":"incremental"}"#),
        ("broken", "{ this is not json"),
    ];
    for (index, (id, payload)) in rows.iter().enumerate() {
        let mut job = job_full(
            id,
            "index",
            Some("proj_a"),
            JobState::Done,
            20,
            index as i64,
            Some(index as i64 + 1),
            Some(index as i64 + 2),
        );
        job.payload_json = (*payload).to_owned();
        JobRepo::enqueue(&store, job).await.expect("入队");
    }
    let (listed, _) = JobRepo::list_page(&store, JobFilter::default(), Page::new(50, 0))
        .await
        .expect("列表");
    let detail = |id: &str| {
        listed
            .iter()
            .find(|job| job.id == id)
            .and_then(|job| job.detail.clone())
    };
    assert_eq!(detail("single").as_deref(), Some("src/a.rs"));
    assert_eq!(detail("multi").as_deref(), Some("3 个文件 (src/a.rs 等)"));
    assert_eq!(detail("full").as_deref(), Some("全量索引"));
    assert_eq!(detail("insight").as_deref(), Some("笔记 n-1"));
    assert_eq!(detail("batch").as_deref(), Some("批次 b-1"));
    assert_eq!(detail("file").as_deref(), Some("docs/a.md"));
    assert_eq!(detail("no-detail"), None);
    assert_eq!(detail("broken"), None, "坏 JSON 只让这一行没有详情");
    // 摘要依旧不读 payload 大列:详情是 SQL 从 json 里抠出来的标量拼的
    assert!(listed.iter().all(|job| job.payload_json.is_empty()));
}

#[tokio::test]
async fn job_pages_are_ordered_filtered_and_counted_in_sql() {
    let (_dir, store) = open_store();
    let rows = [
        // 结束的:按结束时间倒序
        job_full(
            "d-old",
            "index",
            Some("proj_a"),
            JobState::Done,
            20,
            100,
            Some(110),
            Some(120),
        ),
        job_full(
            "d-new",
            "index",
            Some("proj_a"),
            JobState::Done,
            20,
            200,
            Some(210),
            Some(900),
        ),
        job_full(
            "f-mid",
            "extract",
            Some("proj_b"),
            JobState::Failed,
            20,
            300,
            Some(310),
            Some(500),
        ),
        job_full(
            "c-none",
            "index",
            None,
            JobState::Canceled,
            20,
            400,
            None,
            None,
        ),
        // 排队的:优先级高的在前,同优先级先到的在前
        job_full(
            "q-late",
            "index",
            Some("proj_a"),
            JobState::Queued,
            20,
            800,
            None,
            None,
        ),
        job_full(
            "q-early",
            "index",
            Some("proj_b"),
            JobState::Queued,
            20,
            600,
            None,
            None,
        ),
        job_full(
            "q-urgent",
            "save_insight",
            Some("proj_a"),
            JobState::Queued,
            60,
            950,
            None,
            None,
        ),
        // 运行中的永远在最前
        job_full(
            "r-1",
            "index",
            Some("proj_b"),
            JobState::Running,
            20,
            700,
            Some(705),
            None,
        ),
    ];
    for job in rows {
        JobRepo::enqueue(&store, job).await.expect("入队");
    }
    let ids = |jobs: &[Job]| jobs.iter().map(|job| job.id.clone()).collect::<Vec<_>>();

    let (all, total) = JobRepo::list_page(&store, JobFilter::default(), Page::new(50, 0))
        .await
        .expect("列表");
    assert_eq!(total, 8);
    assert_eq!(
        ids(&all),
        [
            "r-1", "q-urgent", "q-early", "q-late", "d-new", "f-mid", "c-none", "d-old"
        ],
        "运行中 → 排队(执行顺序)→ 按结束时间倒序;没有结束时间的按创建时间"
    );
    assert_eq!(all[0].payload_json, "", "列表只给摘要,不读大列");
    assert_eq!(all[0].checkpoint_json, None);

    // 分页:总数不变,只取这一页
    let (page2, total) = JobRepo::list_page(&store, JobFilter::default(), Page::new(3, 3))
        .await
        .expect("第二页");
    assert_eq!(total, 8);
    assert_eq!(ids(&page2), ["q-late", "d-new", "f-mid"]);

    // 各筛选条件与组合
    let filtered = |filter: JobFilter| {
        let store = &store;
        async move {
            let (jobs, total) = JobRepo::list_page(store, filter, Page::new(50, 0))
                .await
                .expect("筛选");
            assert_eq!(total as usize, jobs.len(), "总数和一页里的条数对得上");
            ids(&jobs)
        }
    };
    assert_eq!(
        filtered(JobFilter {
            states: vec![JobState::Running, JobState::Queued],
            ..JobFilter::default()
        })
        .await,
        ["r-1", "q-urgent", "q-early", "q-late"]
    );
    assert_eq!(
        filtered(JobFilter {
            kinds: vec!["extract".to_owned(), "save_insight".to_owned()],
            ..JobFilter::default()
        })
        .await,
        ["q-urgent", "f-mid"]
    );
    assert_eq!(
        filtered(JobFilter {
            exclude_kinds: vec!["index".to_owned()],
            ..JobFilter::default()
        })
        .await,
        ["q-urgent", "f-mid"]
    );
    assert_eq!(
        filtered(JobFilter {
            states: vec![JobState::Queued],
            collections: vec!["proj_a".to_owned()],
            exclude_kinds: vec!["save_insight".to_owned()],
            ..JobFilter::default()
        })
        .await,
        ["q-late"]
    );
    // 值走绑定参数:带引号的「类型」不会改变 SQL 的含义
    assert!(
        filtered(JobFilter {
            kinds: vec!["index' OR '1'='1".to_owned()],
            ..JobFilter::default()
        })
        .await
        .is_empty()
    );
}

#[tokio::test]
async fn job_stats_match_a_full_scan_computed_by_hand() {
    let (_dir, store) = open_store();
    const DAY: i64 = 86_400_000;
    let now = 30 * DAY;
    let kinds = ["index", "extract", "save_insight", "migrate"];
    let states = [
        JobState::Done,
        JobState::Done,
        JobState::Done,
        JobState::Failed,
        JobState::Canceled,
        JobState::Queued,
        JobState::Running,
        JobState::Paused,
    ];
    // 用时里放上分段边界的值:10 秒、1 分钟、5 分钟、30 分钟都算在下面那一段
    let spans = [
        0, 9_999, 10_000, 10_001, 60_000, 299_999, 300_000, 1_800_000, 1_800_001, 7_200_000,
    ];
    let mut jobs = Vec::new();
    for index in 0..1_200i64 {
        let state = states[(index as usize * 7) % states.len()];
        let kind = kinds[(index as usize * 3) % kinds.len()];
        let collection = match index % 5 {
            0 => None,
            1 | 2 => Some("proj_a"),
            _ => Some("proj_b"),
        };
        // 创建时间铺满 3 天,好让「近 24 小时」只截到一部分
        let created = now - 3 * DAY + index * 216_000;
        let span = spans[(index as usize) % spans.len()];
        let (started, finished) = match state {
            JobState::Queued => (None, None),
            JobState::Running | JobState::Paused => (Some(created + 1_000), None),
            // 有些结束的任务没有开始时间(直接被跳过 / 排队时就取消),不参与用时统计
            _ if index % 11 == 0 => (None, Some(created + span)),
            _ => (Some(created), Some(created + span)),
        };
        let job = job_full(
            &format!("j{index:05}"),
            kind,
            collection,
            state,
            20 + (index % 3) as i32 * 20,
            created,
            started,
            finished,
        );
        JobRepo::enqueue(&store, job.clone()).await.expect("入队");
        jobs.push(job);
    }

    let since = now - DAY;
    let filters = [
        JobFilter::default(),
        JobFilter {
            exclude_kinds: vec!["extract".to_owned()],
            ..JobFilter::default()
        },
        JobFilter {
            collections: vec!["proj_a".to_owned()],
            ..JobFilter::default()
        },
    ];
    for filter in filters {
        let stats = JobRepo::stats(&store, filter.clone(), since)
            .await
            .expect("统计");
        let picked: Vec<&Job> = jobs
            .iter()
            .filter(|job| {
                (filter.exclude_kinds.is_empty() || !filter.exclude_kinds.contains(&job.kind))
                    && (filter.collections.is_empty()
                        || job
                            .collection
                            .as_ref()
                            .is_some_and(|name| filter.collections.contains(name)))
            })
            .collect();
        assert_eq!(stats.total, picked.len() as u64, "{filter:?}");
        for (state, count) in &stats.by_state {
            let expected = picked.iter().filter(|job| job.state == *state).count() as u64;
            assert_eq!(*count, expected, "{state:?} {filter:?}");
        }
        assert_eq!(stats.by_state.len(), 6);
        let kinds_total: u64 = stats.kinds.iter().map(|(_, count)| count).sum();
        assert_eq!(kinds_total, stats.total);

        let recent: Vec<&&Job> = picked
            .iter()
            .filter(|job| job.finished_at.unwrap_or(job.created_at) > since)
            .collect();
        let recent_count =
            |state: JobState| recent.iter().filter(|job| job.state == state).count() as u64;
        assert_eq!(stats.recent_done, recent_count(JobState::Done));
        assert_eq!(stats.recent_failed, recent_count(JobState::Failed));
        assert_eq!(stats.recent_canceled, recent_count(JobState::Canceled));
        let recent_spans: Vec<i64> = recent
            .iter()
            .filter(|job| job.state == JobState::Done)
            .filter_map(|job| Some(job.finished_at? - job.started_at?))
            .collect();
        let avg = recent_spans.iter().sum::<i64>() as f64 / recent_spans.len() as f64;
        assert!((stats.recent_avg_ms.expect("有平均") - avg).abs() < 1e-6);

        assert_eq!(
            stats.oldest_queued_at,
            picked
                .iter()
                .filter(|job| job.state == JobState::Queued)
                .map(|job| job.created_at)
                .min()
        );
        let first_running = picked
            .iter()
            .filter(|job| job.state == JobState::Running)
            .min_by_key(|job| (job.started_at, job.created_at))
            .map(|job| (job.kind.clone(), job.collection.clone()));
        assert_eq!(stats.first_running, first_running);

        let mut done_spans: Vec<i64> = picked
            .iter()
            .filter(|job| job.state == JobState::Done)
            .filter_map(|job| Some(job.finished_at? - job.started_at?))
            .collect();
        done_spans.sort_unstable();
        assert_eq!(stats.duration_count, done_spans.len() as u64);
        let mut buckets = [0u64; 5];
        for span in &done_spans {
            let at = [10_000, 60_000, 300_000, 1_800_000]
                .iter()
                .position(|edge| span <= edge)
                .unwrap_or(4);
            buckets[at] += 1;
        }
        assert_eq!(stats.duration_buckets, buckets.to_vec(), "{filter:?}");
        let n = done_spans.len();
        let median = if n % 2 == 1 {
            done_spans[n / 2] as f64
        } else {
            (done_spans[n / 2 - 1] + done_spans[n / 2]) as f64 / 2.0
        };
        assert_eq!(stats.duration_median_ms, Some(median));
        let rank = ((n as f64) * 0.95).ceil() as usize;
        assert_eq!(stats.duration_p95_ms, Some(done_spans[rank - 1] as f64));
    }
}

#[tokio::test]
async fn job_stats_on_an_empty_table_have_no_averages() {
    let (_dir, store) = open_store();
    let stats = JobRepo::stats(&store, JobFilter::default(), 0)
        .await
        .expect("统计");
    assert_eq!(stats.total, 0);
    assert_eq!(stats.by_state.len(), 6);
    assert!(stats.kinds.is_empty());
    assert_eq!(stats.recent_avg_ms, None);
    assert_eq!(stats.oldest_queued_at, None);
    assert_eq!(stats.first_running, None);
    assert_eq!(stats.duration_buckets, vec![0; 5]);
    assert_eq!(stats.duration_median_ms, None);
    assert_eq!(stats.duration_p95_ms, None);
}

#[tokio::test]
async fn job_series_buckets_created_finished_and_queue_depth() {
    let (_dir, store) = open_store();
    const MIN: i64 = 60_000;
    let t0 = 1_000 * MIN;
    // 窗口:t0 起 6 个 10 分钟的桶
    let rows = [
        // 在桶 0 创建、桶 1 开始、桶 1 完成(用时 4 分钟):排队跨过桶 0 的末尾
        job_full(
            "a",
            "index",
            Some("p"),
            JobState::Done,
            20,
            t0 + 2 * MIN,
            Some(t0 + 12 * MIN),
            Some(t0 + 16 * MIN),
        ),
        // 同一个桶里创建又开始:桶末已不在队里
        job_full(
            "b",
            "index",
            Some("p"),
            JobState::Done,
            20,
            t0 + 21 * MIN,
            Some(t0 + 22 * MIN),
            Some(t0 + 26 * MIN),
        ),
        // 失败的:桶 2 创建、桶 3 开始、桶 3 失败
        job_full(
            "c",
            "extract",
            Some("p"),
            JobState::Failed,
            20,
            t0 + 25 * MIN,
            Some(t0 + 31 * MIN),
            Some(t0 + 33 * MIN),
        ),
        // 窗口前就在排队,到现在还没开始:整个窗口都算排队
        job_full(
            "d",
            "index",
            Some("p"),
            JobState::Queued,
            20,
            t0 - 30 * MIN,
            None,
            None,
        ),
        // 排队时被取消(没开始):取消时刻离开队伍
        job_full(
            "e",
            "index",
            Some("p"),
            JobState::Canceled,
            20,
            t0 + 41 * MIN,
            None,
            Some(t0 + 52 * MIN),
        ),
        // 窗口之外的:不计入
        job_full(
            "old",
            "index",
            Some("p"),
            JobState::Done,
            20,
            t0 - 200 * MIN,
            Some(t0 - 199 * MIN),
            Some(t0 - 198 * MIN),
        ),
    ];
    for job in rows {
        JobRepo::enqueue(&store, job).await.expect("入队");
    }
    let series = JobRepo::series(&store, JobFilter::default(), t0, 10 * MIN, 6)
        .await
        .expect("序列");
    assert_eq!(
        (series.start, series.step_ms, series.buckets.len()),
        (t0, 10 * MIN, 6)
    );
    let col =
        |f: fn(&kb_core::model::JobBucket) -> u64| series.buckets.iter().map(f).collect::<Vec<_>>();
    assert_eq!(col(|b| b.created), [1, 0, 2, 0, 1, 0], "创建按创建时间");
    assert_eq!(col(|b| b.done), [0, 1, 1, 0, 0, 0], "完成按结束时间");
    assert_eq!(col(|b| b.failed), [0, 0, 0, 1, 0, 0]);
    assert_eq!(col(|b| b.canceled), [0, 0, 0, 0, 0, 1]);
    assert_eq!(series.buckets[1].avg_ms, Some(4.0 * MIN as f64), "平均用时");
    assert_eq!(series.buckets[0].avg_ms, None, "没有完成的桶没有平均");
    // 排队深度:d 一直在;a 在桶 0 末还在排(2 分钟创建、12 分钟才开始),桶 1 末已离开;
    // b 同桶创建又开始;c 在桶 2 末在排(25 创建、31 开始);e 在桶 4 末在排(41 创建、52 取消)
    assert_eq!(col(|b| b.queue_depth), [2, 1, 2, 1, 2, 1]);
    // 筛选同样生效:排除 extract 后没有失败
    let filtered = JobRepo::series(
        &store,
        JobFilter {
            exclude_kinds: vec!["extract".to_owned()],
            ..JobFilter::default()
        },
        t0,
        10 * MIN,
        6,
    )
    .await
    .expect("序列");
    assert_eq!(filtered.buckets.iter().map(|b| b.failed).sum::<u64>(), 0);
}

#[tokio::test]
async fn daily_activity_counts_each_table_per_local_day() {
    let (_dir, store) = open_store();
    const DAY: i64 = 86_400_000;
    let start = 20_000 * DAY;
    // 3 天:笔记第 0 天 1 条、第 2 天 2 条;其余表的细节由各自的仓储测试守着,这里只验归桶和跨表
    for (index, day) in [0i64, 2, 2].into_iter().enumerate() {
        let mut item = insight(&format!("n{index}"), "标题", None);
        item.created_at = start + day * DAY + 1_000;
        InsightRepo::create(&store, item).await.expect("新建");
    }
    // 窗口外(前一天)的不计
    let mut outside = insight("out", "标题", None);
    outside.created_at = start - 1;
    InsightRepo::create(&store, outside).await.expect("新建");
    // 任务:第 1 天完成 2 个,第 2 天完成 1 个,另有一个失败的不算
    for (id, state, at) in [
        ("j1", JobState::Done, 1),
        ("j2", JobState::Done, 1),
        ("j3", JobState::Done, 2),
        ("j4", JobState::Failed, 1),
    ] {
        let finished = start + at * DAY + 5_000;
        JobRepo::enqueue(
            &store,
            job_full(
                id,
                "index",
                None,
                state,
                20,
                finished - 1_000,
                Some(finished - 500),
                Some(finished),
            ),
        )
        .await
        .expect("入队");
    }
    let labels = vec![
        "2026-10-30".to_owned(),
        "2026-10-31".to_owned(),
        "2026-11-01".to_owned(),
    ];
    let got = ActivityRepo::activity(&store, start, labels.clone())
        .await
        .expect("活动");
    assert_eq!(got.days, labels);
    assert_eq!(got.notes, [1, 0, 2]);
    assert_eq!(got.jobs_done, [0, 2, 1]);
    for line in [
        &got.edits,
        &got.imports,
        &got.imports_done,
        &got.searches,
        &got.ai_tokens,
    ] {
        assert_eq!(line, &[0, 0, 0], "没有数据的表是 0,长度和天数一致");
    }
}

#[tokio::test]
async fn audit_searches_and_model_tokens_are_counted_by_day() {
    let (_dir, store) = open_store();
    const DAY: i64 = 86_400_000;
    let start = 30_000 * DAY;
    let entry = |capability: &str, ok: bool, at: i64| AuditEntry {
        id: None,
        at,
        actor: "t".to_owned(),
        capability: capability.to_owned(),
        args_json: "{}".to_owned(),
        ok,
        error: None,
        batch_id: None,
        dry_run: false,
        took_ms: None,
        degraded: None,
    };
    for (capability, ok, at) in [
        ("search_knowledge", true, start + 10),
        ("search_knowledge", true, start + 20),
        ("search_knowledge", false, start + 30),
        ("deep_search", true, start + DAY + 5),
        ("list_projects", true, start + DAY + 6),
        ("search_code", true, start + 2 * DAY + 7),
        ("search_code", true, start + 5 * DAY),
    ] {
        AuditRepo::record(&store, entry(capability, ok, at))
            .await
            .expect("审计");
    }
    LlmUsageRepo::add_usage(
        &store,
        LlmUsage {
            day: "2026-11-01".to_owned(),
            model: "m".to_owned(),
            purpose: "extract".to_owned(),
            calls: 1,
            input_tokens: 100,
            output_tokens: 50,
        },
    )
    .await
    .expect("用量");
    LlmUsageRepo::add_usage(
        &store,
        LlmUsage {
            day: "2026-11-01".to_owned(),
            model: "m".to_owned(),
            purpose: "review".to_owned(),
            calls: 1,
            input_tokens: 10,
            output_tokens: 5,
        },
    )
    .await
    .expect("用量");
    LlmUsageRepo::add_usage(
        &store,
        LlmUsage {
            day: "2026-10-01".to_owned(),
            model: "m".to_owned(),
            purpose: "extract".to_owned(),
            calls: 1,
            input_tokens: 999,
            output_tokens: 999,
        },
    )
    .await
    .expect("用量");
    let labels = vec![
        "2026-10-30".to_owned(),
        "2026-10-31".to_owned(),
        "2026-11-01".to_owned(),
    ];
    let got = ActivityRepo::activity(&store, start, labels)
        .await
        .expect("活动");
    assert_eq!(
        got.searches,
        [2, 1, 1],
        "只数成功的检索类调用,别的能力和失败的不算"
    );
    assert_eq!(
        got.ai_tokens,
        [0, 0, 165],
        "同一天各用途合计;窗口外的日期不算"
    );
}

#[tokio::test]
async fn ingest_overview_counts_states_buckets_and_merges_failure_reasons() {
    use kb_core::model::{IngestFile, IngestState};
    use kb_core::ports::repo::IngestRepo;
    let (_dir, store) = open_store();
    const HOUR: i64 = 3_600_000;
    let t0 = 5_000 * HOUR;
    let file = |id: &str, state: IngestState, at: i64, error: Option<&str>| IngestFile {
        id: id.to_owned(),
        batch_id: None,
        source_id: None,
        upload_id: None,
        collection: "_global".to_owned(),
        rel_path: format!("{id}.md"),
        abs_path: format!("/tmp/{id}.md"),
        size: 1,
        sha256: None,
        state,
        error: error.map(str::to_owned),
        chunks: 0,
        vectors: 0,
        extract_meta: None,
        derived_from: None,
        elapsed_ms: None,
        created_at: at,
        updated_at: at,
    };
    for item in [
        file("a", IngestState::Done, t0 + 10, None),
        file("b", IngestState::Done, t0 + 20, None),
        file("c", IngestState::Failed, t0 + HOUR + 5, Some("抽取超时")),
        file("d", IngestState::Failed, t0 + 2 * HOUR, Some("抽取超时")),
        file(
            "e",
            IngestState::Failed,
            t0 + 2 * HOUR + 1,
            Some("读不出文字"),
        ),
        file("f", IngestState::Queued, t0 + 3 * HOUR - 1, None),
        // 窗口之外(前一个小时):状态分布里算,桶里不算
        file("old", IngestState::Done, t0 - 5, None),
    ] {
        IngestRepo::create(&store, item).await.expect("写入");
    }
    let got = ActivityRepo::ingest_overview(&store, t0, HOUR, 3, 5)
        .await
        .expect("概况");
    let state = |name: &str| {
        got.by_state
            .iter()
            .find(|(state, _)| state == name)
            .map(|(_, n)| *n)
    };
    assert_eq!(
        (state("done"), state("failed"), state("queued")),
        (Some(3), Some(3), Some(1))
    );
    assert_eq!(got.by_state[0].1, 3, "多的状态在前");
    let counts = got
        .buckets
        .iter()
        .map(|b| (b.total, b.done, b.failed))
        .collect::<Vec<_>>();
    assert_eq!(counts, [(2, 2, 0), (1, 0, 1), (3, 0, 2)]);
    assert_eq!(
        got.top_errors,
        [("抽取超时".to_owned(), 2), ("读不出文字".to_owned(), 1)]
    );
    let one = ActivityRepo::ingest_overview(&store, t0, HOUR, 3, 1)
        .await
        .expect("概况");
    assert_eq!(one.top_errors.len(), 1, "失败原因只取 Top N");
}

#[tokio::test]
async fn file_status_counts_group_by_collection_and_status() {
    let (_dir, store) = open_store();
    ProjectRepo::create(&store, project("p1", "alpha", "/tmp/alpha"))
        .await
        .expect("项目");
    CollectionRepo::create(&store, collection("proj_alpha", Some("p1")))
        .await
        .expect("集合");
    for (path, status) in [
        ("a.rs", "ok"),
        ("b.rs", "ok"),
        ("c.rs", "ok"),
        ("logo.png", "binary"),
        ("big.csv", "too_large"),
        ("dist/x.js", "excluded"),
    ] {
        FileRepo::upsert(
            &store,
            FileRecord {
                collection: "proj_alpha".to_owned(),
                path: path.to_owned(),
                file_hash: "h".to_owned(),
                size: 1,
                mtime: 1,
                indexed_at: 1,
                status: status.to_owned(),
                error: None,
            },
        )
        .await
        .expect("文件");
    }
    let got = ActivityRepo::file_status_counts(&store)
        .await
        .expect("计数");
    assert_eq!(got.len(), 4);
    assert_eq!(
        got[0],
        ("proj_alpha".to_owned(), "ok".to_owned(), 3),
        "同一个集合里多的状态在前"
    );
    assert!(got.contains(&("proj_alpha".to_owned(), "binary".to_owned(), 1)));
    assert!(got.contains(&("proj_alpha".to_owned(), "too_large".to_owned(), 1)));
    assert!(got.contains(&("proj_alpha".to_owned(), "excluded".to_owned(), 1)));
}

#[tokio::test]
async fn audit_batches_and_changes() {
    let (_dir, store) = open_store();
    let batch_id = AuditRepo::begin_batch(&store, "user", "批量打标签")
        .await
        .expect("开批次");
    AuditRepo::record_change(
        &store,
        &batch_id,
        Change {
            batch_id: batch_id.clone(),
            seq: 0,
            target: "i1".to_owned(),
            before_json: Some(r#"{"tags":[]}"#.to_owned()),
            after_json: r#"{"tags":["决策"]}"#.to_owned(),
        },
    )
    .await
    .expect("记录变更");
    AuditRepo::record_change(
        &store,
        &batch_id,
        Change {
            batch_id: batch_id.clone(),
            seq: 0,
            target: "i2".to_owned(),
            before_json: None,
            after_json: r#"{"tags":["坑"]}"#.to_owned(),
        },
    )
    .await
    .expect("记录变更");

    let batch: Batch = AuditRepo::batch(&store, &batch_id)
        .await
        .expect("查批次")
        .expect("存在");
    assert_eq!(batch.actor, "user");
    assert!(batch.reverted_at.is_none());

    let id = AuditRepo::record(
        &store,
        AuditEntry {
            id: None,
            at: now(),
            actor: "user".to_owned(),
            capability: "edit_item".to_owned(),
            args_json: r#"{"id":"i1"}"#.to_owned(),
            ok: true,
            error: None,
            batch_id: Some(batch_id.clone()),
            dry_run: false,
            took_ms: Some(12),
            degraded: None,
        },
    )
    .await
    .expect("写审计");
    assert!(id > 0);
    AuditRepo::record(
        &store,
        AuditEntry {
            id: None,
            at: now() + 1,
            actor: "mcp:kiro".to_owned(),
            capability: "search_knowledge".to_owned(),
            args_json: "{}".to_owned(),
            ok: false,
            error: Some("invalid input".to_owned()),
            batch_id: None,
            dry_run: true,
            took_ms: Some(3),
            degraded: Some("embedder_loading".to_owned()),
        },
    )
    .await
    .expect("写审计");

    let all = AuditRepo::list(&store, None, Page::default())
        .await
        .expect("审计列表");
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].capability, "search_knowledge", "按时间倒序");
    let filtered = AuditRepo::list(
        &store,
        Some(AuditFilter {
            actor: Some("user".to_owned()),
            ..AuditFilter::default()
        }),
        Page::default(),
    )
    .await
    .expect("按 actor 过滤");
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].batch_id.as_deref(), Some(batch_id.as_str()));
    // 迁移 0020:耗时与降级原因要能写进去也读得回来(线上排查慢查询靠这两列)
    assert_eq!(all[0].took_ms, Some(3));
    assert_eq!(all[0].degraded.as_deref(), Some("embedder_loading"));
    assert_eq!(all[1].took_ms, Some(12));
    assert_eq!(all[1].degraded, None);
}

#[tokio::test]
async fn settings_sessions_and_api_tokens() {
    let (_dir, store) = open_store();
    assert!(
        AuthRepo::get_setting(&store, "password_hash")
            .await
            .expect("读")
            .is_none()
    );
    AuthRepo::set_setting(&store, "password_hash", "argon2-hash")
        .await
        .expect("写");
    AuthRepo::set_setting(&store, "password_hash", "argon2-hash-2")
        .await
        .expect("覆盖");
    assert_eq!(
        AuthRepo::get_setting(&store, "password_hash")
            .await
            .expect("读")
            .as_deref(),
        Some("argon2-hash-2")
    );

    AuthRepo::create_session(
        &store,
        Session {
            token_hash: "th1".to_owned(),
            created_at: now(),
            expires_at: now() + 1000,
            last_seen: now(),
            user_agent: Some("test".to_owned()),
        },
    )
    .await
    .expect("建会话");
    assert!(
        AuthRepo::get_session(&store, "th1")
            .await
            .expect("读")
            .is_some()
    );
    AuthRepo::touch_session(&store, "th1", now() + 10, now() + 2000)
        .await
        .expect("续期");
    let session = AuthRepo::get_session(&store, "th1")
        .await
        .expect("读")
        .expect("存在");
    assert_eq!(session.expires_at, now() + 2000);
    assert_eq!(
        AuthRepo::delete_expired_sessions(&store, now() + 3000)
            .await
            .expect("清理"),
        1
    );
    assert!(
        AuthRepo::get_session(&store, "th1")
            .await
            .expect("读")
            .is_none()
    );

    AuthRepo::create_api_token(
        &store,
        ApiToken {
            id: "t1".to_owned(),
            name: "kiro".to_owned(),
            token_hash: "hash-t1".to_owned(),
            scopes: "mcp".to_owned(),
            created_at: now(),
            last_used: None,
            revoked_at: None,
        },
    )
    .await
    .expect("建令牌");
    assert!(
        AuthRepo::get_api_token(&store, "hash-t1")
            .await
            .expect("读")
            .is_some()
    );
    assert_eq!(
        AuthRepo::list_api_tokens(&store).await.expect("列表").len(),
        1
    );
    AuthRepo::revoke_api_token(&store, "t1", now() + 5)
        .await
        .expect("撤销");
    let token = AuthRepo::get_api_token(&store, "hash-t1")
        .await
        .expect("读")
        .expect("存在");
    assert_eq!(token.revoked_at, Some(now() + 5));

    // 撤销不存在的令牌要报 NotFound,不能静默成功
    let missing = AuthRepo::revoke_api_token(&store, "no-such-token", now() + 6).await;
    assert!(
        matches!(missing, Err(kb_core::KbError::NotFound(_))),
        "撤销未知令牌应返回 NotFound,实际 {missing:?}"
    );

    // 同名令牌要给出可读的提示,而不是裸的 SQLite 约束错误
    let duplicate = AuthRepo::create_api_token(
        &store,
        ApiToken {
            id: "t2".to_owned(),
            name: "kiro".to_owned(),
            token_hash: "hash-t2".to_owned(),
            scopes: "mcp".to_owned(),
            created_at: now(),
            last_used: None,
            revoked_at: None,
        },
    )
    .await;
    match duplicate {
        Err(kb_core::KbError::InvalidInput(message)) => {
            assert!(message.contains("kiro"), "提示里要有令牌名:{message}");
        }
        other => panic!("同名令牌应返回 InvalidInput,实际 {other:?}"),
    }
}

#[tokio::test]
async fn feedback_events_drafts_and_llm_usage() {
    let (_dir, store) = open_store();

    let feedback_id = FeedbackRepo::record(
        &store,
        Feedback {
            id: None,
            at: now(),
            query: "增量索引".to_owned(),
            item_id: "i1".to_owned(),
            useful: true,
            note: Some("准确".to_owned()),
            source: "mcp".to_owned(),
        },
    )
    .await
    .expect("反馈");
    assert!(feedback_id > 0);
    assert_eq!(
        FeedbackRepo::list(&store, Page::default())
            .await
            .expect("列表")
            .len(),
        1
    );

    EventRepo::append(
        &store,
        Event {
            id: "e1".to_owned(),
            kind: "git_commit".to_owned(),
            project_id: Some("p1".to_owned()),
            payload_json: r#"{"head":"abc"}"#.to_owned(),
            received_at: now(),
            processed_at: None,
            result: None,
        },
    )
    .await
    .expect("事件");
    assert_eq!(
        EventRepo::list_unprocessed(&store, 10)
            .await
            .expect("未处理")
            .len(),
        1
    );
    EventRepo::mark_processed(&store, "e1", now() + 1, Some("ok"))
        .await
        .expect("标记");
    assert!(
        EventRepo::list_unprocessed(&store, 10)
            .await
            .expect("未处理")
            .is_empty()
    );
    assert_eq!(
        EventRepo::get(&store, "e1")
            .await
            .expect("读")
            .expect("存在")
            .result
            .as_deref(),
        Some("ok")
    );

    let draft = Draft {
        id: "d1".to_owned(),
        collection: "proj_demo".to_owned(),
        title: "草稿".to_owned(),
        body_md: "正文".to_owned(),
        kind: InsightKind::Pitfall,
        tags: vec!["坑".to_owned()],
        evidence_json: r#"[{"quote":"..."}]"#.to_owned(),
        related_paths: vec!["src/auth.rs".to_owned()],
        extractor_id: "extractor:1".to_owned(),
        event_id: Some("e1".to_owned()),
        state: DraftState::Pending,
        review_json: None,
        insight_id: None,
        fingerprint: String::new(),
        embedding: None,
        embedder_id: None,
        created_at: now(),
        decided_at: None,
    };
    DraftRepo::create(&store, draft.clone())
        .await
        .expect("草稿");
    assert_eq!(
        DraftRepo::list(&store, None, Page::default())
            .await
            .expect("列表")
            .len(),
        1
    );
    assert_eq!(
        DraftRepo::list(&store, Some(DraftState::Approved), Page::default())
            .await
            .expect("列表")
            .len(),
        0
    );
    let mut decided = draft;
    decided.state = DraftState::Approved;
    decided.insight_id = Some("i9".to_owned());
    decided.decided_at = Some(now() + 2);
    DraftRepo::update(&store, decided).await.expect("更新");
    let loaded = DraftRepo::get(&store, "d1")
        .await
        .expect("读")
        .expect("存在");
    assert_eq!(loaded.state, DraftState::Approved);
    assert_eq!(loaded.insight_id.as_deref(), Some("i9"));

    for calls in [1u32, 2] {
        LlmUsageRepo::add_usage(
            &store,
            LlmUsage {
                day: "2026-10-20".to_owned(),
                model: "deepseek-flash".to_owned(),
                purpose: "extract".to_owned(),
                calls,
                input_tokens: 100,
                output_tokens: 10,
            },
        )
        .await
        .expect("用量");
    }
    let usage = LlmUsageRepo::usage_of_day(&store, "2026-10-20")
        .await
        .expect("查用量");
    assert_eq!(usage.len(), 1);
    assert_eq!(usage[0].calls, 3);
    assert_eq!(usage[0].input_tokens, 200);

    let send_id = LlmUsageRepo::record_send(
        &store,
        LlmSend {
            id: None,
            at: now(),
            project_id: Some("p1".to_owned()),
            purpose: "extract".to_owned(),
            chars: 1000,
            redactions: 2,
        },
    )
    .await
    .expect("外发审计");
    assert!(send_id > 0);
    // 每小时调用上限用的计数:从某个时间点起算
    assert_eq!(
        LlmUsageRepo::count_sends_since(&store, 0)
            .await
            .expect("数外发"),
        1
    );
    assert_eq!(
        LlmUsageRepo::count_sends_since(&store, now() + 1_000)
            .await
            .expect("数外发"),
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn fifty_concurrent_readers_and_writers_do_not_deadlock() {
    let (_dir, store) = open_store();
    ProjectRepo::create(&store, project("p1", "Demo", "/tmp/demo"))
        .await
        .expect("项目");
    CollectionRepo::create(&store, collection("proj_demo", Some("p1")))
        .await
        .expect("collection");

    let mut handles = Vec::new();
    for index in 0..50u32 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            // 写:每个任务写一个文件记录
            FileRepo::upsert(
                &store,
                FileRecord {
                    collection: "proj_demo".to_owned(),
                    path: format!("src/f{index}.rs"),
                    file_hash: format!("h{index}"),
                    size: u64::from(index),
                    mtime: now(),
                    indexed_at: now(),
                    status: "ok".to_owned(),
                    error: None,
                },
            )
            .await
            .expect("并发写");
            // 读:列表与计数
            let _ = FileRepo::list_paths(&store, "proj_demo")
                .await
                .expect("并发读");
            let _ = ChunkRepo::count(&store, "proj_demo")
                .await
                .expect("并发计数");
            // 写:审计
            AuditRepo::record(
                &store,
                AuditEntry {
                    id: None,
                    at: now() + i64::from(index),
                    actor: "tester".to_owned(),
                    capability: "concurrent".to_owned(),
                    args_json: "{}".to_owned(),
                    ok: true,
                    error: None,
                    batch_id: None,
                    dry_run: false,
                    took_ms: None,
                    degraded: None,
                },
            )
            .await
            .expect("并发审计");
        }));
    }

    // 10 秒内全部完成即视为没有死锁
    let all = tokio::time::timeout(std::time::Duration::from_secs(10), async {
        for handle in handles {
            handle.await.expect("任务未 panic");
        }
    })
    .await;
    assert!(all.is_ok(), "并发读写出现死锁或超时");

    assert_eq!(
        FileRepo::list_paths(&store, "proj_demo")
            .await
            .expect("路径")
            .len(),
        50
    );
    let audits = AuditRepo::list(
        &store,
        Some(AuditFilter {
            capability: Some("concurrent".to_owned()),
            ..AuditFilter::default()
        }),
        Page::new(100, 0),
    )
    .await
    .expect("审计");
    assert_eq!(audits.len(), 50);
}

/// :读连接池 + WAL 下,读写并发不应出现 `SQLITE_BUSY` / `database is locked`。
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_reads_and_writes_stay_clean() {
    use std::time::{Duration, Instant};

    let dir = tempfile::tempdir().expect("临时目录");
    let store = SqliteMetaStore::open_with_pool(dir.path().join("meta.db"), 4).expect("打开");
    ProjectRepo::create(&store, project("p0", "seed", "/tmp/seed"))
        .await
        .expect("种子项目");

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut tasks = Vec::new();
    // 16 个读任务:项目列表 + collection 列表
    for _ in 0..16 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            let mut errors = Vec::new();
            while Instant::now() < deadline {
                if let Err(err) = ProjectRepo::list(&store).await {
                    errors.push(err.to_string());
                }
                if let Err(err) = CollectionRepo::list(&store).await {
                    errors.push(err.to_string());
                }
            }
            errors
        }));
    }
    // 4 个写任务:建了再删
    for writer in 0..4 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            let mut errors = Vec::new();
            let mut round = 0u32;
            while Instant::now() < deadline {
                let id = format!("w{writer}-{round}");
                let name = format!("w{writer}x{round}");
                let record = project(&id, &name, &format!("/tmp/{id}"));
                if let Err(err) = ProjectRepo::create(&store, record).await {
                    errors.push(err.to_string());
                }
                if let Err(err) = ProjectRepo::delete(&store, &id).await {
                    errors.push(err.to_string());
                }
                round += 1;
            }
            errors
        }));
    }

    let mut all = Vec::new();
    for task in tasks {
        all.extend(task.await.expect("任务未 panic"));
    }
    assert!(all.is_empty(), "并发读写出现错误:{all:?}");
    assert!(
        !all.iter().any(|error| {
            let lower = error.to_lowercase();
            lower.contains("busy") || lower.contains("database is locked")
        }),
        "不应出现 SQLITE_BUSY:{all:?}"
    );
}

/// 并发只读的验收测量:32 个并发只读请求,比较不同池大小的 p50 / p95。
///
/// 跑法:`cargo test -p kb-meta --test meta_store -- --ignored --nocapture p95_of_32`
#[tokio::test(flavor = "multi_thread", worker_threads = 16)]
#[ignore = "验收测量:需要一台不忙的机器,默认不跑"]
async fn p95_of_32_concurrent_reads_across_pool_sizes() {
    use std::time::{Duration, Instant};

    for pool in [1usize, 4, 8] {
        let dir = tempfile::tempdir().expect("临时目录");
        let store =
            SqliteMetaStore::open_with_pool(dir.path().join("meta.db"), pool).expect("打开");
        for index in 0..200 {
            ProjectRepo::create(
                &store,
                project(
                    &format!("p{index}"),
                    &format!("proj{index}"),
                    &format!("/tmp/proj{index}"),
                ),
            )
            .await
            .expect("建项目");
        }
        let mut samples = Vec::new();
        for _ in 0..20 {
            let started = Instant::now();
            let mut tasks = Vec::new();
            for _ in 0..32 {
                let store = store.clone();
                tasks.push(tokio::spawn(async move { ProjectRepo::list(&store).await }));
            }
            for task in tasks {
                task.await.expect("任务未 panic").expect("读成功");
            }
            samples.push(started.elapsed());
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        samples.sort();
        let p50 = samples[samples.len() / 2];
        let p95 = samples[(samples.len() * 95 / 100).min(samples.len() - 1)];
        println!("pool={pool}: p50={p50:?} p95={p95:?}");
    }
}

/// 并发读写的浸泡验收:读写并发 10 分钟,不允许出现 `SQLITE_BUSY`。
///
/// 跑法:`cargo test -p kb-meta --test meta_store -- --ignored --nocapture soak`。
/// 时长可用 `KB_SOAK_SECS` 覆盖(默认 600 秒),便于在 CI 上跑短版本。
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "浸泡测试:默认跑 10 分钟,需要显式 --ignored"]
async fn soak_writes_and_reads_for_ten_minutes() {
    use std::time::{Duration, Instant};

    let seconds: u64 = std::env::var("KB_SOAK_SECS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(600);
    let dir = tempfile::tempdir().expect("临时目录");
    let store = SqliteMetaStore::open_with_pool(dir.path().join("meta.db"), 4).expect("打开");
    ProjectRepo::create(&store, project("p0", "seed", "/tmp/seed"))
        .await
        .expect("种子项目");

    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut tasks = Vec::new();
    for _ in 0..16 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            let mut reads = 0u64;
            let mut errors = Vec::new();
            while Instant::now() < deadline {
                match ProjectRepo::list(&store).await {
                    Ok(_) => reads += 1,
                    Err(err) => errors.push(err.to_string()),
                }
            }
            (reads, errors)
        }));
    }
    for writer in 0..4 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            let mut round = 0u32;
            let mut errors = Vec::new();
            while Instant::now() < deadline {
                let id = format!("s{writer}-{round}");
                let record = project(&id, &format!("s{writer}x{round}"), &format!("/tmp/{id}"));
                if let Err(err) = ProjectRepo::create(&store, record).await {
                    errors.push(err.to_string());
                }
                if let Err(err) = ProjectRepo::delete(&store, &id).await {
                    errors.push(err.to_string());
                }
                round += 1;
            }
            (0, errors)
        }));
    }

    let mut reads = 0u64;
    let mut all = Vec::new();
    for task in tasks {
        let (count, errors) = task.await.expect("任务未 panic");
        reads += count;
        all.extend(errors);
    }
    println!("浸泡 {seconds} 秒:读 {reads} 次,错误 {} 条", all.len());
    assert!(all.is_empty(), "并发读写出现错误:{all:?}");
}

/// 按数据源汇总解析队列(数据源页的「+N 今天 / N 失败 · N 隔离」)。
#[tokio::test]
async fn ingest_stats_are_grouped_by_source() {
    use kb_core::model::{IngestFile, IngestState};
    use kb_core::ports::repo::IngestRepo;

    let (_dir, store) = open_store();
    let today = now();
    let file = |id: &str, source: Option<&str>, state: IngestState, created_at: i64| IngestFile {
        id: id.to_owned(),
        batch_id: None,
        source_id: source.map(str::to_owned),
        upload_id: None,
        collection: "_global".to_owned(),
        rel_path: format!("{id}.md"),
        abs_path: format!("/tmp/{id}.md"),
        size: 1,
        sha256: None,
        state,
        error: None,
        chunks: 0,
        vectors: 0,
        extract_meta: None,
        derived_from: None,
        elapsed_ms: None,
        created_at,
        updated_at: created_at,
    };
    for item in [
        file("a1", Some("s1"), IngestState::Done, today),
        file("a2", Some("s1"), IngestState::Failed, today - 1),
        file("a3", Some("s1"), IngestState::Queued, today - 86_400_000),
        file(
            "b1",
            Some("s2"),
            IngestState::Quarantined,
            today - 86_400_000,
        ),
        file("c1", None, IngestState::Done, today - 86_400_000),
    ] {
        IngestRepo::create(&store, item).await.expect("写入");
    }

    let stats = IngestRepo::stats_by_source(&store, today)
        .await
        .expect("汇总");
    let by_id = |id: &str| {
        stats
            .iter()
            .find(|item| item.source_id.as_deref() == Some(id))
            .cloned()
            .unwrap_or_else(|| panic!("缺 {id}:{stats:?}"))
    };
    let s1 = by_id("s1");
    // 只有 a1 的 created_at 正好等于 since(today),a2 早 1ms 就不算“今天”
    assert_eq!(
        (s1.total, s1.today, s1.failed, s1.pending),
        (3, 1, 1, 1),
        "{s1:?}"
    );
    let s2 = by_id("s2");
    assert_eq!((s2.total, s2.today, s2.quarantined), (1, 0, 1), "{s2:?}");
    // 没有来源的行单独一组(source_id = None)
    assert!(
        stats
            .iter()
            .any(|item| item.source_id.is_none() && item.total == 1),
        "{stats:?}"
    );
}

/// 备份用的快照:`VACUUM INTO` 出来的文件能独立打开,内容与源库一致。
///
/// 顺带守住“目标已存在也能覆盖”:SQLite 的 `VACUUM INTO` 不接受已存在的目标,
/// 所以实现要先删,不然第二次备份会失败。
#[tokio::test]
async fn snapshot_to_writes_a_readable_copy() {
    let (dir, store) = open_store();
    let target = dir.path().join("backup").join("meta.db");
    store.snapshot_to(&target).await.expect("快照成功");
    assert!(target.is_file(), "快照文件应存在");

    // 新开一个库读它:表结构与数据都在
    let copy = SqliteMetaStore::open(target.clone()).expect("打开快照");
    assert_eq!(
        copy.schema_version().await.expect("版本"),
        store.schema_version().await.expect("版本")
    );
    let original = ProjectRepo::list(&store).await.expect("列项目");
    let cloned = ProjectRepo::list(&copy).await.expect("列项目");
    assert_eq!(original.len(), cloned.len());

    // 目标已存在:覆盖成功(第二次备份不能因为同名快照失败)
    std::fs::write(&target, b"stale").expect("写脏数据");
    store.snapshot_to(&target).await.expect("重复快照应覆盖");
    let again = SqliteMetaStore::open(target.clone()).expect("再次打开快照");
    assert_eq!(
        ProjectRepo::list(&again).await.expect("列项目").len(),
        original.len()
    );
}

/// 迁移 0009:旧实现留下的“approved / revised 但没有 insight_id”的草稿要放回收件箱。
#[tokio::test]
async fn migration_0009_puts_unpromoted_drafts_back_to_pending() {
    let (dir, store) = open_store();
    // 造两条旧形状的行:一条 approved 无 insight_id(该被放回 pending),一条 approved 有 insight_id(不该动)
    let mut legacy = draft_row("d-legacy", DraftState::Approved);
    legacy.insight_id = None;
    DraftRepo::create(&store, legacy).await.expect("写旧行");
    let mut promoted = draft_row("d-promoted", DraftState::Approved);
    promoted.insight_id = Some("ins_promoted".to_owned());
    DraftRepo::create(&store, promoted)
        .await
        .expect("写已转正行");

    // 直接把 user_version 拨回 8 再跑一次迁移,模拟从 0008 升级上来
    let path = dir.path().join("meta.db");
    drop(store);
    {
        let conn = rusqlite::Connection::open(&path).expect("打开");
        // 回到 0008 的形状:先把 0010 / 0012 加的列去掉,再回拨 user_version
        conn.execute("ALTER TABLE drafts DROP COLUMN claimed_at", [])
            .expect("去掉 claimed_at");
        conn.execute("ALTER TABLE ingest_files DROP COLUMN derived_from", [])
            .expect("去掉 derived_from");
        // 0017 给 annotations 加的评论串列(和它的索引)也要去掉,否则重跑 0017 会报「duplicate column name」
        conn.execute("DROP INDEX IF EXISTS idx_annotations_parent", [])
            .expect("去掉评论串索引");
        for column in ["parent_id", "resolved_at", "resolved_by", "mentions_json"] {
            conn.execute(&format!("ALTER TABLE annotations DROP COLUMN {column}"), [])
                .expect("去掉 annotations 评论串列");
        }
        // 0014 给 agent_sessions 加的列也要去掉(表本身留着,0013 是 IF NOT EXISTS)
        for column in [
            "backend",
            "acp_agent",
            "acp_session",
            "summary",
            "summary_upto",
            "sandboxed",
        ] {
            conn.execute(
                &format!("ALTER TABLE agent_sessions DROP COLUMN {column}"),
                [],
            )
            .expect("去掉 agent_sessions 列");
        }
        // 0020 给 audit 加的「耗时 / 降级原因」也要去掉,否则重跑 0020 会报「duplicate column name」
        for column in ["took_ms", "degraded"] {
            conn.execute(&format!("ALTER TABLE audit DROP COLUMN {column}"), [])
                .expect("去掉 audit 列");
        }
        // 0021 是文件操作的三张新表,0008 时还不存在;直接整表删掉再迁移,
        // 否则 0021 的 IF NOT EXISTS 会留下已经带 target_collection 的表,0022 再 ADD 就重名。
        for table in ["trash_entries", "path_exclusions", "file_ops"] {
            conn.execute(&format!("DROP TABLE IF EXISTS {table}"), [])
                .expect("去掉文件操作表");
        }
        // 0024给 sources 加的 AI 规范化三列
        for column in ["ai_extract", "extract_prompt", "ai_status_json"] {
            conn.execute(&format!("ALTER TABLE sources DROP COLUMN {column}"), [])
                .expect("去掉 sources 的 AI 规范化列");
        }
        conn.pragma_update(None, "user_version", 8)
            .expect("回拨版本");
    }
    let store = SqliteMetaStore::open(&path).expect("重开(触发迁移)");
    // 断言“迁到最新版本”,不写死数字:0011 加了 events_by_kind,写死的 10 会过期。
    // 基准取一个全新库的版本号(同样走一遍迁移链)。
    let (_fresh_dir, fresh) = open_store();
    let latest = fresh.schema_version().await.expect("版本");
    assert_eq!(store.schema_version().await.expect("版本"), latest);

    let drafts = DraftRepo::list(&store, None, Page::default())
        .await
        .expect("列草稿");
    let by_id = |id: &str| {
        drafts
            .iter()
            .find(|draft| draft.id == id)
            .cloned()
            .expect(id)
    };
    assert_eq!(
        by_id("d-legacy").state,
        DraftState::Pending,
        "没有 insight 的旧行应放回 pending"
    );
    assert!(by_id("d-legacy").decided_at.is_none(), "decided_at 应清空");
    assert_eq!(
        by_id("d-promoted").state,
        DraftState::Approved,
        "已转正的行不该被改"
    );
}

/// 迁移 0010 加的 `claimed_at`:`claim` / `release_claim` / `clear_stale_claims` 的语义。
#[tokio::test]
async fn claims_are_exclusive_expire_and_can_be_cleared() {
    let (_dir, store) = open_store();
    DraftRepo::create(&store, draft_row("d1", DraftState::Pending))
        .await
        .expect("写草稿");
    let ttl = 120_000;
    // 第一次抢到,第二次(未过期)抢不到
    assert!(
        DraftRepo::claim(&store, "d1", 1_000_000, ttl)
            .await
            .expect("抢占")
    );
    assert!(
        !DraftRepo::claim(&store, "d1", 1_000_500, ttl)
            .await
            .expect("抢占")
    );
    // 过期后可以接管
    assert!(
        DraftRepo::claim(&store, "d1", 1_000_000 + ttl + 1, ttl)
            .await
            .expect("抢占")
    );
    // 释放之后又能抢(令牌是抢到时的时间戳)
    DraftRepo::release_claim(&store, "d1", 1_000_000 + ttl + 1)
        .await
        .expect("释放");
    assert!(
        DraftRepo::claim(&store, "d1", 2_000_000, ttl)
            .await
            .expect("抢占")
    );
    // 已转正的行不参与抢占
    let mut promoted = draft_row("d2", DraftState::Approved);
    promoted.insight_id = Some("ins_1".to_owned());
    DraftRepo::create(&store, promoted)
        .await
        .expect("写已转正行");
    assert!(
        !DraftRepo::claim(&store, "d2", 2_000_000, ttl)
            .await
            .expect("抢占")
    );
    // 清扫:只清“已转正”或“已过期”的标记;刚才那次抢占还在有效期内,不该被动
    assert_eq!(
        DraftRepo::clear_stale_claims(&store, 2_000_000, ttl)
            .await
            .expect("清扫"),
        0
    );
    // 时间往前走 2 个 TTL:这次抢占算过期,应被清掉
    assert_eq!(
        DraftRepo::clear_stale_claims(&store, 2_000_000 + ttl * 2, ttl)
            .await
            .expect("清扫"),
        1
    );
    // 不存在的草稿:claim 返回 false,release 不报错
    assert!(
        !DraftRepo::claim(&store, "missing", 2_000_000, ttl)
            .await
            .expect("抢占")
    );
    DraftRepo::release_claim(&store, "missing", 2_000_000)
        .await
        .expect("释放");
}

/// 测试用的草稿行。
fn draft_row(id: &str, state: DraftState) -> Draft {
    Draft {
        id: id.to_owned(),
        collection: "proj_demo".to_owned(),
        title: format!("草稿 {id}"),
        body_md: "正文".to_owned(),
        kind: InsightKind::Pitfall,
        tags: vec!["坑".to_owned()],
        evidence_json: r#"[{"quote":"..."}]"#.to_owned(),
        related_paths: vec!["src/auth.rs".to_owned()],
        extractor_id: "extractor:1".to_owned(),
        event_id: None,
        state,
        review_json: None,
        insight_id: None,
        fingerprint: format!("fp-{id}"),
        embedding: None,
        embedder_id: None,
        created_at: now(),
        decided_at: None,
    }
}

/// `recent_by_kind`:只返回指定种类、按时间倒序、`limit` 生效。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recent_by_kind_filters_sorts_and_limits() {
    let (_dir, store) = open_store();
    ProjectRepo::create(&store, project("p1", "Demo", "/tmp/demo"))
        .await
        .expect("项目");
    let mut ids = Vec::new();
    for index in 0..6u32 {
        let kind = match index % 3 {
            0 => "session_end",
            1 => "file_change",
            _ => "git_commit",
        };
        let id = format!("e{index}");
        EventRepo::append(
            &store,
            Event {
                id: id.clone(),
                kind: kind.to_owned(),
                project_id: Some("p1".to_owned()),
                payload_json: "{}".to_owned(),
                received_at: 1_000 + i64::from(index),
                processed_at: None,
                result: None,
            },
        )
        .await
        .expect("事件");
        ids.push(id);
    }
    let sessions = EventRepo::recent_by_kind(&store, "session_end", 10)
        .await
        .expect("按种类取");
    assert_eq!(
        sessions
            .iter()
            .map(|event| event.id.as_str())
            .collect::<Vec<_>>(),
        vec!["e3", "e0"],
        "只该有 session_end,且新的在前"
    );
    let limited = EventRepo::recent_by_kind(&store, "git_commit", 1)
        .await
        .expect("按种类取");
    assert_eq!(limited.len(), 1, "limit 应生效");
    assert_eq!(limited[0].id, "e5");
    assert!(
        EventRepo::recent_by_kind(&store, "nope", 10)
            .await
            .expect("按种类取")
            .is_empty()
    );
}

/// 删 collection 必须把它名下**所有**派生行一起清掉,否则同名重建后增量 diff 会把孤儿
/// `chunks` 当成“没变的块”跳过,新的向量表永远是空的。
#[tokio::test]
async fn deleting_a_collection_purges_every_derived_row() {
    use kb_core::model::{Anchor, Annotation, ItemVersion};

    let (_dir, store) = open_store();
    ProjectRepo::create(&store, project("p1", "Demo", "/tmp/demo"))
        .await
        .expect("项目");
    CollectionRepo::create(&store, collection("proj_demo", Some("p1")))
        .await
        .expect("collection");

    ChunkRepo::replace_for_path(&store, "proj_demo", "src/lib.rs", vec![chunk("c1", 0)])
        .await
        .expect("chunks");
    InsightRepo::create(&store, insight("i1", "一条经验", None))
        .await
        .expect("insight");
    DraftRepo::create(&store, draft_row("d1", DraftState::Pending))
        .await
        .expect("draft");
    VersionRepo::create(
        &store,
        ItemVersion {
            id: "v1".to_owned(),
            item_id: "i1".to_owned(),
            collection: "proj_demo".to_owned(),
            source: "insight:i1".to_owned(),
            version: 1,
            title: Some("一条经验".to_owned()),
            body: "正文".to_owned(),
            tags: Vec::new(),
            author: Some("user".to_owned()),
            batch_id: None,
            created_at: now(),
        },
    )
    .await
    .expect("version");
    AnnotationRepo::create(
        &store,
        Annotation {
            id: "a1".to_owned(),
            collection: "proj_demo".to_owned(),
            source: "src/lib.rs".to_owned(),
            anchor: Some(Anchor::Line { start: 1, end: 2 }),
            body: "批注".to_owned(),
            author: Some("user".to_owned()),
            record_id: Some("c1".to_owned()),
            parent_id: None,
            resolved_at: None,
            resolved_by: None,
            mentions: Vec::new(),
            created_at: now(),
            updated_at: now(),
        },
    )
    .await
    .expect("annotation");
    EdgeRepo::add(
        &store,
        Edge {
            src_id: "c1".to_owned(),
            dst: "path:src/lib.rs".to_owned(),
            rel: EdgeRel::AboutFile,
            created_at: now(),
        },
    )
    .await
    .expect("edge");

    CollectionRepo::delete(&store, "proj_demo")
        .await
        .expect("删除 collection");

    assert!(
        ChunkRepo::by_path(&store, "proj_demo", "src/lib.rs")
            .await
            .expect("查询 chunks")
            .is_empty(),
        "chunks 必须随 collection 一起删掉"
    );
    assert!(
        InsightRepo::get(&store, "i1")
            .await
            .expect("查询")
            .is_none(),
        "insights 必须随 collection 一起删掉"
    );
    assert!(
        VersionRepo::get(&store, "v1")
            .await
            .expect("查询")
            .is_none(),
        "item_versions 必须随 collection 一起删掉"
    );
    assert!(
        AnnotationRepo::get(&store, "a1")
            .await
            .expect("查询")
            .is_none(),
        "annotations 必须随 collection 一起删掉"
    );
    assert!(
        EdgeRepo::by_src(&store, "c1")
            .await
            .expect("查询")
            .is_empty(),
        "指向被删块的 edges 也要清掉"
    );

    // 同名重建前会先跑 purge_data:即使没有 collections 行,历史孤儿行也要能清掉
    ChunkRepo::replace_for_path(&store, "proj_demo", "src/lib.rs", vec![chunk("c2", 0)])
        .await
        .expect("孤儿 chunks");
    CollectionRepo::purge_data(&store, "proj_demo")
        .await
        .expect("purge");
    assert!(
        ChunkRepo::by_path(&store, "proj_demo", "src/lib.rs")
            .await
            .expect("查询")
            .is_empty(),
        "purge_data 应清掉没有 collection 行的孤儿 chunks"
    );
}

/// 管家会话列表:标题取第一条用户消息,按最后活动倒序;删除只影响指定会话。
#[tokio::test]
async fn agent_sessions_are_listed_and_deleted() {
    use kb_core::model::AgentMessage;
    use kb_core::ports::repo::AgentRepo;

    let (_dir, store) = open_store();
    for (session, text, at) in [
        ("s1", "帮我总结最近更新的内容", now()),
        ("s2", "  第二行才是正文\n第一行\n", now() + 1000),
    ] {
        AgentRepo::append(
            &store,
            AgentMessage {
                session_id: session.to_owned(),
                seq: 0,
                role: "user".to_owned(),
                content_json: serde_json::json!({ "text": text }).to_string(),
                at,
            },
        )
        .await
        .expect("写用户消息");
        AgentRepo::append(
            &store,
            AgentMessage {
                session_id: session.to_owned(),
                seq: 0,
                role: "assistant".to_owned(),
                content_json: serde_json::json!({ "text": "好的" }).to_string(),
                at: at + 1,
            },
        )
        .await
        .expect("写助手消息");
    }
    let sessions = AgentRepo::sessions(&store, 10, None)
        .await
        .expect("会话列表");
    assert_eq!(sessions.len(), 2, "{sessions:?}");
    assert_eq!(sessions[0].session_id, "s2", "按最后活动倒序");
    assert_eq!(sessions[0].title, "第二行才是正文", "标题取第一行非空文本");
    assert_eq!(sessions[0].messages, 2);
    assert_eq!(sessions[1].session_id, "s1");
    assert_eq!(sessions[1].title, "帮我总结最近更新的内容");

    assert_eq!(
        AgentRepo::delete_session(&store, "s1").await.expect("删除"),
        2
    );
    let sessions = AgentRepo::sessions(&store, 10, None)
        .await
        .expect("会话列表");
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].session_id, "s2");
    assert!(
        AgentRepo::list(&store, "s1", 100)
            .await
            .expect("历史")
            .is_empty()
    );
    assert_eq!(
        AgentRepo::delete_session(&store, "missing")
            .await
            .expect("删除空会话"),
        0
    );
}

/// 版本记录的清理:按 id 删(不存在的 id 不报错也不多删),按正文里的片段统计引用数(二进制备份的引用计数靠它)。
#[tokio::test]
async fn versions_can_be_deleted_by_id_and_counted_by_body_fragment() {
    use kb_core::model::ItemVersion;
    let (_dir, store) = open_store();
    ProjectRepo::create(&store, project("p1", "Demo", "/tmp/demo"))
        .await
        .expect("项目");
    CollectionRepo::create(&store, collection("proj_demo", Some("p1")))
        .await
        .expect("collection");
    let make = |id: &str, item: &str, version: i64, body: &str| ItemVersion {
        id: id.to_owned(),
        item_id: item.to_owned(),
        collection: "proj_demo".to_owned(),
        source: "a.docx".to_owned(),
        version,
        title: None,
        body: body.to_owned(),
        tags: Vec::new(),
        author: Some("user".to_owned()),
        batch_id: None,
        created_at: now(),
    };
    for version in [
        make("v1", "item-a", 1, "\0blob:aaaa:10"),
        make("v2", "item-a", 2, "\0blob:bbbb:12"),
        make("v3", "item-b", 1, "\0blob:aaaa:10"),
        make("v4", "item-b", 2, "纯文本版本"),
    ] {
        VersionRepo::create(&store, version).await.expect("version");
    }

    // 同样内容的备份被两个不同文件的版本引用着
    assert_eq!(
        VersionRepo::count_body_containing(&store, "aaaa")
            .await
            .unwrap(),
        2
    );
    assert_eq!(
        VersionRepo::count_body_containing(&store, "bbbb")
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        VersionRepo::count_body_containing(&store, "cccc")
            .await
            .unwrap(),
        0
    );
    // 正文里带通配符的字符不能被当成通配符
    assert_eq!(
        VersionRepo::count_body_containing(&store, "%")
            .await
            .unwrap(),
        0
    );

    // 空列表什么都不删;不存在的 id 不报错;只删指定的
    assert_eq!(VersionRepo::delete_many(&store, &[]).await.unwrap(), 0);
    let removed = VersionRepo::delete_many(&store, &["v1".to_owned(), "nope".to_owned()])
        .await
        .unwrap();
    assert_eq!(removed, 1);
    assert_eq!(
        VersionRepo::count_body_containing(&store, "aaaa")
            .await
            .unwrap(),
        1,
        "另一个文件的引用还在"
    );
    let left = VersionRepo::list(&store, "item-a", 10).await.unwrap();
    assert_eq!(left.iter().map(|v| v.version).collect::<Vec<_>>(), vec![2]);
    assert_eq!(
        VersionRepo::list(&store, "item-b", 10).await.unwrap().len(),
        2,
        "别的文件的版本没被碰"
    );
}

/// AI 的修改建议:存取、按文档列出、只能处理一次(两个人同时点「接受」只生效一次)。
#[tokio::test]
async fn edit_proposals_are_listed_per_document_and_decided_only_once() {
    let dir = tempfile::tempdir().unwrap();
    let store = SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开数据库");
    let proposal = |id: &str, target: &str, at: i64| kb_meta::EditProposal {
        id: id.to_owned(),
        collection: "_global".to_owned(),
        target: target.to_owned(),
        author: "mcp:claude".to_owned(),
        note: "改错别字".to_owned(),
        edits: serde_json::json!([{ "old": "苹裹", "new": "苹果" }]),
        status: "pending".to_owned(),
        result: None,
        created_at: at,
        decided_at: None,
        decided_by: None,
    };
    store
        .proposal_create(proposal("p1", "file:a.md", 1))
        .await
        .unwrap();
    store
        .proposal_create(proposal("p2", "file:a.md", 2))
        .await
        .unwrap();
    store
        .proposal_create(proposal("p3", "note:n1", 3))
        .await
        .unwrap();
    let listed = store
        .proposal_list("_global", "file:a.md", None, 10)
        .await
        .unwrap();
    assert_eq!(
        listed.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        ["p2", "p1"],
        "新的在前,只有这个文档的"
    );
    assert_eq!(listed[0].edits[0]["new"], "苹果");
    assert!(
        store
            .proposal_decide("p1", "accepted", "alice", None, 9)
            .await
            .unwrap()
    );
    assert!(
        !store
            .proposal_decide("p1", "rejected", "bob", None, 10)
            .await
            .unwrap(),
        "处理过的不能再处理"
    );
    let got = store.proposal_get("p1").await.unwrap().unwrap();
    assert_eq!(
        (
            got.status.as_str(),
            got.decided_by.as_deref(),
            got.decided_at
        ),
        ("accepted", Some("alice"), Some(9))
    );
    let pending = store
        .proposal_list("_global", "file:a.md", Some("pending"), 10)
        .await
        .unwrap();
    assert_eq!(pending.len(), 1);
    assert!(store.proposal_get("nope").await.unwrap().is_none());
    store.proposal_fail("p1", "原文找不到了").await.unwrap();
    let failed = store.proposal_get("p1").await.unwrap().unwrap();
    assert_eq!(
        (failed.status.as_str(), failed.result.as_deref()),
        ("failed", Some("原文找不到了"))
    );
}

/// 审计概况:按本地时区的「周几 × 几点」数次数、忽略名单里的能力不算、范围之前的不算、排行按次数。
#[tokio::test]
async fn audit_overview_counts_weekday_hour_in_local_time_and_skips_ignored() {
    let (_dir, store) = open_store();
    const HOUR: i64 = 3_600_000;
    // 1970-01-05 00:00 UTC 是周一
    let monday = 4 * 24 * HOUR;
    let entry = |capability: &str, ok: bool, at: i64| AuditEntry {
        id: None,
        at,
        actor: "t".to_owned(),
        capability: capability.to_owned(),
        args_json: "{}".to_owned(),
        ok,
        error: None,
        batch_id: None,
        dry_run: false,
        took_ms: None,
        degraded: None,
    };
    for (capability, ok, at) in [
        ("search_knowledge", true, monday + HOUR),
        ("search_knowledge", false, monday + HOUR + 600_000),
        ("save_insight", true, monday + 17 * HOUR),
        // 页面自动刷新的读取:忽略
        ("list_projects", true, monday + HOUR),
        // 统计范围之前:不算
        ("search_knowledge", true, monday - HOUR),
    ] {
        AuditRepo::record(&store, entry(capability, ok, at))
            .await
            .expect("写审计");
    }
    // 东八区:周一 09 点有 2 次,周二 01 点有 1 次
    let overview = ActivityRepo::audit_overview(
        &store,
        monday,
        8 * 3600,
        vec!["list_projects".to_owned()],
        8,
    )
    .await
    .expect("审计概况");
    assert_eq!(overview.heat.len(), 7);
    assert!(overview.heat.iter().all(|row| row.len() == 24));
    assert_eq!(overview.heat[0][9], 2);
    assert_eq!(overview.heat[1][1], 1);
    assert_eq!(overview.heat.iter().flatten().sum::<u64>(), 3);
    assert_eq!((overview.total, overview.failed), (3, 1));
    assert_eq!(
        overview.top,
        vec![
            ("search_knowledge".to_owned(), 2, 1),
            ("save_insight".to_owned(), 1, 0)
        ]
    );
    // 忽略名单为空也能跑,list_projects 这时算进去;top 的个数限制生效
    let all = ActivityRepo::audit_overview(&store, monday, 0, vec![], 1)
        .await
        .expect("不忽略");
    assert_eq!(all.total, 4);
    assert_eq!(all.top.len(), 1);
    assert_eq!(all.heat[0][1], 3, "UTC 下周一 01 点是 3 次");
}

/// 一条逐文件结果(测试里只关心变化类型和路径)。
fn job_file(path: &str, change: FileChange) -> JobFile {
    JobFile {
        path: path.to_owned(),
        change,
        chunks: 3,
        meta_chunks: 1,
        deleted_chunks: 0,
        error: (change == FileChange::Error).then(|| "解析失败".to_owned()),
        done_at: 9_000,
    }
}

#[tokio::test]
async fn job_files_keep_the_last_result_and_list_in_change_order() {
    let (_dir, store) = open_store();
    JobRepo::enqueue(&store, job_with("jf", JobState::Running, 20, 1_000, None))
        .await
        .expect("入队");
    JobRepo::record_job_files(
        &store,
        "jf",
        &[
            job_file("z/skip.rs", FileChange::Skip),
            job_file("b/update.rs", FileChange::Update),
            job_file("a/new.rs", FileChange::New),
            job_file("c/meta.rs", FileChange::Meta),
            job_file("d/delete.rs", FileChange::Delete),
            job_file("e/error.rs", FileChange::Error),
        ],
    )
    .await
    .expect("记录");
    // 续跑重写同一个路径:以最后一次为准,不是加一行
    let mut again = job_file("b/update.rs", FileChange::Meta);
    again.chunks = 0;
    JobRepo::record_job_files(&store, "jf", &[again])
        .await
        .expect("覆盖");

    let all = Page::new(50, 0);
    let (files, total, counts) = JobRepo::list_job_files(&store, "jf", all)
        .await
        .expect("清单");
    assert_eq!(total, 6, "覆盖不新增一行");
    // 只返回出现过的类型(没有「更新」就不给 0,前端按缺省 0 处理),顺序固定
    assert_eq!(
        counts,
        vec![
            (FileChange::Error, 1),
            (FileChange::Delete, 1),
            (FileChange::New, 1),
            (FileChange::Meta, 2),
            (FileChange::Skip, 1),
        ],
        "按变化类型统计,顺序固定(失败 → 删除 → 新增 → 更新 → 元数据 → 没变)"
    );
    let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
    assert_eq!(
        paths,
        vec![
            "e/error.rs",
            "d/delete.rs",
            "a/new.rs",
            "b/update.rs",
            "c/meta.rs",
            "z/skip.rs"
        ],
        "失败 / 删除 / 新增在前,没变的最后;同类型按路径"
    );
    assert_eq!(files[0].error.as_deref(), Some("解析失败"));
    assert_eq!(files[3].chunks, 0, "覆盖后的块数是最后一次的结果");
    assert_eq!(files[3].meta_chunks, 1);

    // 分页:第二页两条,总数不变(一页最多 200 条,几千文件的任务靠翻页)
    let (second, total, _) = JobRepo::list_job_files(&store, "jf", Page::new(2, 2))
        .await
        .expect("第二页");
    assert_eq!(total, 6);
    assert_eq!(
        second
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        vec!["a/new.rs", "b/update.rs"]
    );

    // 别的任务、不存在的任务都是空清单:前端据此回退到任务参数里的文件列表
    let (none, none_total, none_counts) = JobRepo::list_job_files(&store, "nope", all)
        .await
        .expect("空");
    assert!(none.is_empty());
    assert_eq!(none_total, 0);
    assert!(none_counts.is_empty());
}

#[tokio::test]
async fn prune_failed_drops_the_file_details_with_the_job() {
    let (_dir, store) = open_store();
    JobRepo::enqueue(
        &store,
        job_with("old", JobState::Failed, 20, 100, Some(150)),
    )
    .await
    .expect("入队");
    JobRepo::record_job_files(&store, "old", &[job_file("a.rs", FileChange::New)])
        .await
        .expect("记录");
    assert_eq!(
        JobRepo::prune_failed(&store, 500, false)
            .await
            .expect("清理"),
        1
    );
    let (files, total, _) = JobRepo::list_job_files(&store, "old", Page::new(50, 0))
        .await
        .expect("清单");
    assert!(files.is_empty(), "任务删掉后明细不能留下");
    assert_eq!(total, 0);
}

#[tokio::test]
async fn pending_embeds_are_written_with_the_chunks_in_one_transaction() {
    let (_dir, store) = open_store();
    // 块和队列一起写:文本阶段提交后两者必须同时可见
    ChunkRepo::replace_for_path_with_pending(
        &store,
        "proj_demo",
        "src/lib.rs",
        vec![chunk("a", 0), chunk("b", 1)],
        &[
            ("a".to_owned(), "src/lib.rs".to_owned()),
            ("b".to_owned(), "src/lib.rs".to_owned()),
        ],
        now(),
    )
    .await
    .expect("写入块与队列");
    assert_eq!(
        ChunkRepo::pending_count(&store, "proj_demo")
            .await
            .expect("计数"),
        2
    );
    // 观测:一条 SQL 同时给出块数、文件数、最早入队时间
    let stats = ChunkRepo::pending_stats(&store, "proj_demo")
        .await
        .expect("队列汇总");
    assert_eq!(stats.chunks, 2);
    assert_eq!(stats.files, 1);
    assert!(stats.oldest_enqueued_at.is_some(), "两行都有入队时间");
    let empty = ChunkRepo::pending_stats(&store, "proj_nobody")
        .await
        .expect("空队列");
    assert_eq!(empty.chunks, 0);
    assert_eq!(empty.files, 0);
    assert_eq!(empty.oldest_enqueued_at, None);
    assert!(
        ChunkRepo::has_pending(&store, "proj_demo")
            .await
            .expect("判定")
    );
    assert_eq!(
        ChunkRepo::pending_for_path(&store, "proj_demo", "src/lib.rs")
            .await
            .expect("按路径"),
        ["a", "b"]
    );
    let first = ChunkRepo::pending_after(&store, "proj_demo", None, 1)
        .await
        .expect("第一页");
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].chunk_id, "a");
    assert_eq!(first[0].path, "src/lib.rs");
    let second = ChunkRepo::pending_after(&store, "proj_demo", Some("a"), 10)
        .await
        .expect("第二页");
    assert_eq!(second.len(), 1);
    assert_eq!(second[0].chunk_id, "b");

    // 同一路径再写一次时旧队列项必须一起换掉,否则会去嵌入已经不存在的旧块
    ChunkRepo::replace_for_path_with_pending(
        &store,
        "proj_demo",
        "src/lib.rs",
        vec![chunk("c", 0)],
        &[("c".to_owned(), "src/lib.rs".to_owned())],
        now(),
    )
    .await
    .expect("替换");
    assert_eq!(
        ChunkRepo::pending_count(&store, "proj_demo")
            .await
            .expect("计数"),
        1
    );
    assert_eq!(
        ChunkRepo::pending_for_path(&store, "proj_demo", "src/lib.rs")
            .await
            .expect("按路径"),
        ["c"]
    );

    // 重复入队不报错也不重复计数
    ChunkRepo::enqueue_pending(
        &store,
        "proj_demo",
        &[("c".to_owned(), "src/lib.rs".to_owned())],
        now(),
    )
    .await
    .expect("重复入队");
    assert_eq!(
        ChunkRepo::pending_count(&store, "proj_demo")
            .await
            .expect("计数"),
        1
    );

    ChunkRepo::clear_pending(&store, "proj_demo", &["c".to_owned()])
        .await
        .expect("出队");
    assert!(
        !ChunkRepo::has_pending(&store, "proj_demo")
            .await
            .expect("判定")
    );

    // 迁移切换后要一次清掉整个 collection 的队列,但不能碰别的 collection
    ChunkRepo::enqueue_pending(
        &store,
        "proj_demo",
        &[("d".to_owned(), "src/lib.rs".to_owned())],
        now(),
    )
    .await
    .expect("入队");
    ChunkRepo::enqueue_pending(
        &store,
        "proj_other",
        &[("e".to_owned(), "src/main.rs".to_owned())],
        now(),
    )
    .await
    .expect("入队");
    ChunkRepo::clear_all_pending(&store, "proj_demo")
        .await
        .expect("清空队列");
    assert_eq!(
        ChunkRepo::pending_count(&store, "proj_demo")
            .await
            .expect("计数"),
        0
    );
    assert_eq!(
        ChunkRepo::pending_count(&store, "proj_other")
            .await
            .expect("计数"),
        1,
        "不能误删别的 collection 的队列"
    );
}
