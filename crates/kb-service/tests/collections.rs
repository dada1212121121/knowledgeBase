//! CollectionService 的集成测试:真实 SQLite + 真实 LanceDB(临时目录)+ Fake embedder。

use kb_core::KbError;
use kb_core::model::{ItemStatus, Project, RecordKind, RecordRow};
use kb_core::ports::repo::ProjectRepo;
use kb_service::CollectionService;
use kb_testkit::TestEnv;

fn service(env: &TestEnv) -> CollectionService {
    CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
}

/// 建一个项目行(`collections.project_id` 有外键约束)。
async fn add_project(env: &TestEnv, id: &str, name: &str) {
    ProjectRepo::create(
        env.meta.as_ref(),
        Project {
            id: id.to_owned(),
            name: name.to_owned(),
            slug: kb_core::ids::project_slug(name),
            root_path: format!("/tmp/{name}"),
            include: Vec::new(),
            exclude: Vec::new(),
            is_git: false,
            last_commit: None,
            last_indexed_at: None,
            allow_cloud_llm: false,
            extract_enabled: false,
            hooks_installed: false,
            created_at: 1_700_000_000_000,
        },
    )
    .await
    .expect("建项目行");
}

fn row(id: &str, collection: &str) -> RecordRow {
    RecordRow {
        id: id.to_owned(),
        collection: collection.to_owned(),
        kind: RecordKind::Doc,
        lang: Some("markdown".to_owned()),
        source: "docs/a.md".to_owned(),
        start_line: Some(1),
        end_line: Some(5),
        symbol: None,
        title: Some("标题".to_owned()),
        text: "正文".to_owned(),
        header: "demo › docs/a.md › 标题".to_owned(),
        lex: "正文".to_owned(),
        tags: Vec::new(),
        status: ItemStatus::Active,
        content_hash: format!("c-{id}"),
        meta_hash: format!("m-{id}"),
        embed_input_hash: format!("e-{id}"),
        updated_at: 1_700_000_000_000,
        anchor: None,
        vector: Some(vec![0.1; 8]),
    }
}

#[tokio::test]
async fn ensure_global_creates_sqlite_row_and_physical_table() {
    let env = TestEnv::new().await;
    let service = service(&env);

    let global = service.ensure_global().await.expect("确保 _global");
    assert_eq!(global.name, "_global");
    assert_eq!(global.kind, kb_core::model::CollectionKind::Global);
    assert_eq!(global.embedder_id, "fake:8");
    assert_eq!(global.dim, 8);
    assert_eq!(global.active_table, "_global__fake8__v1");
    assert!(
        env.table_exists("_global__fake8__v1").await,
        "物理表应已创建"
    );

    // 幂等:再调一次不新建
    let again = service.ensure_global().await.expect("再次确保");
    assert_eq!(again.name, global.name);
    assert_eq!(service.list().await.expect("列表").len(), 1);
}

#[tokio::test]
async fn create_for_project_uses_documented_table_name() {
    let env = TestEnv::new().await;
    let service = service(&env);
    service.ensure_global().await.expect("_global");

    add_project(&env, "p1", "SampleApp").await;
    let collection = service
        .create_for_project("p1", "SampleApp")
        .await
        .expect("建项目 collection");
    assert_eq!(collection.name, "proj_sampleapp");
    assert_eq!(collection.kind, kb_core::model::CollectionKind::Project);
    assert_eq!(collection.project_id.as_deref(), Some("p1"));
    assert_eq!(collection.active_table, "proj_sampleapp__fake8__v1");
    assert!(env.table_exists("proj_sampleapp__fake8__v1").await);

    // SQLite 与 LanceDB 状态一致
    let infos = service.list().await.expect("列表");
    assert_eq!(infos.len(), 2);
    let project = infos
        .iter()
        .find(|info| info.name == "proj_sampleapp")
        .expect("列出项目 collection");
    assert_eq!(project.rows, 0);
    assert_eq!(project.dim, 8);
    assert_eq!(project.embedder_id, "fake:8");
    assert!(project.migrating_to.is_none());
}

#[tokio::test]
async fn duplicate_and_invalid_names_are_rejected() {
    let env = TestEnv::new().await;
    let service = service(&env);
    service.ensure_global().await.expect("_global");
    assert!(matches!(
        service
            .create("_global", kb_core::model::CollectionKind::Global, None)
            .await,
        Err(KbError::InvalidInput(_))
    ));
    assert!(matches!(
        service
            .create("Bad-Name", kb_core::model::CollectionKind::Project, None)
            .await,
        Err(KbError::InvalidInput(_))
    ));
}

#[tokio::test]
async fn list_reports_row_counts_from_lance() {
    let env = TestEnv::new().await;
    let service = service(&env);
    let collection = service.ensure_global().await.expect("_global");

    env.store
        .upsert(
            &collection.active_table,
            vec![row("a", "_global"), row("b", "_global")],
        )
        .await
        .expect("写入两行");

    let infos = service.list().await.expect("列表");
    assert_eq!(infos.len(), 1);
    assert_eq!(infos[0].rows, 2, "行数应来自 LanceDB");
}

/// 界面上写"多少条"是按文件 / 笔记算的,不是向量库的块数:一份文档切成几十块也只算一条,
/// 已被取代 / 弃用的不算(和知识库列表默认看到的"全部"一致)。
#[tokio::test]
async fn items_count_files_not_chunks_and_skip_inactive_ones() {
    let env = TestEnv::new().await;
    let service = service(&env);
    let collection = service.ensure_global().await.expect("_global");
    let chunk = |id: &str, source: &str, status: ItemStatus| RecordRow {
        source: source.to_owned(),
        status,
        ..row(id, "_global")
    };
    env.store
        .upsert(
            &collection.active_table,
            vec![
                // 手册.docx 被切成三块
                chunk("a1", "手册.docx", ItemStatus::Active),
                chunk("a2", "手册.docx", ItemStatus::Active),
                chunk("a3", "手册.docx", ItemStatus::Active),
                chunk("b1", "说明.md", ItemStatus::Active),
                chunk("c1", "旧版.md", ItemStatus::Superseded),
            ],
        )
        .await
        .expect("写入");

    let infos = service.list().await.expect("列表");
    assert_eq!(infos[0].rows, 5, "rows 仍是向量库块数(存储和仪表盘用)");
    assert_eq!(
        infos[0].items, 2,
        "items 按文件算,且只算启用的:手册.docx + 说明.md"
    );
}

#[tokio::test]
async fn delete_removes_sqlite_row_and_physical_table() {
    let env = TestEnv::new().await;
    let service = service(&env);
    service.ensure_global().await.expect("_global");
    add_project(&env, "p1", "Demo").await;
    let collection = service
        .create_for_project("p1", "Demo")
        .await
        .expect("建 collection");
    let table = collection.active_table.clone();
    assert!(env.table_exists(&table).await);

    service.delete("proj_demo").await.expect("删除");
    assert!(service.get("proj_demo").await.expect("查询").is_none());
    assert!(!env.table_exists(&table).await, "物理表应被删除");

    // 再删一次报 NotFound
    assert!(matches!(
        service.delete("proj_demo").await,
        Err(KbError::NotFound(_))
    ));
}

#[tokio::test]
async fn get_returns_none_for_unknown_collection() {
    let env = TestEnv::new().await;
    let service = service(&env);
    assert!(service.get("nope").await.expect("查询").is_none());
}

#[tokio::test]
async fn heal_tables_recreates_missing_physical_tables_and_leaves_healthy_ones_alone() {
    let env = TestEnv::new().await;
    let service = service(&env);
    let global = service.ensure_global().await.expect("建 _global");
    // 一张健康的表里有数据,不能被动
    env.store
        .upsert(&global.active_table, vec![row("keep-1", "_global")])
        .await
        .expect("写入");
    assert!(
        service.heal_tables().await.expect("检查").is_empty(),
        "表都在的时候什么也不做"
    );
    assert_eq!(
        env.store.count(&global.active_table, None).await.unwrap(),
        1
    );

    // 模拟从备份恢复:SQLite 还认得这个集合,向量表没了
    env.store
        .drop_table(&global.active_table)
        .await
        .expect("删表");
    assert!(matches!(
        env.store.count(&global.active_table, None).await,
        Err(KbError::NotFound(_))
    ));
    let healed = service.heal_tables().await.expect("补表");
    assert_eq!(healed.len(), 1);
    assert_eq!(healed[0].name, "_global");
    assert_eq!(
        env.store.count(&global.active_table, None).await.unwrap(),
        0,
        "补回来的是空表"
    );
    // 补完之后列集合不再报「表不存在」,再检查一次也是空结果(幂等)
    assert!(service.list().await.is_ok());
    assert!(service.heal_tables().await.unwrap().is_empty());
}
