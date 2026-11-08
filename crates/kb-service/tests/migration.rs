//! 换模型迁移(8 维 → 16 维)。

use std::sync::Arc;

use kb_core::model::{
    ChunkMeta, Collection, ItemStatus, MetaPatch, Project, RecordKind, RecordRow, StoreHit,
    StoreQuery,
};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::{ChunkRepo, CollectionRepo, MetaStore, ProjectRepo};
use kb_embed::FakeEmbedder;
use kb_service::migration::MigrationService;
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;

struct Fixture {
    env: TestEnv,
    #[allow(dead_code)]
    dir: TempDir,
    #[allow(dead_code)]
    project: Project,
    collection: Collection,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("项目");
    std::fs::write(
        dir.path().join("a.rs"),
        "fn a() -> u32 {\n    1\n}\n\nfn b() -> u32 {\n    2\n}\n",
    )
    .expect("写文件");
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
        .expect("写项目");
    let collections =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
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
    Fixture {
        env,
        dir,
        project,
        collection,
    }
}

impl Fixture {
    /// 迁移与索引共享的写闸门(这个文件里的用例大多不需要注入,给个独立的即可)。
    fn gate_or_new(&self) -> kb_service::write_gate::WriteGate {
        kb_service::write_gate::WriteGate::new()
    }
}

#[tokio::test]
async fn dry_run_estimates_rows_and_time() {
    let fixture = fixture().await;
    let service = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    );
    let plan = service
        .plan(&fixture.collection.name, "fake:16")
        .await
        .expect("估算");
    assert_eq!(plan.rows, 2, "两个函数应切成两块:{plan:?}");
    assert_eq!(plan.from_table, fixture.collection.active_table);
    assert_ne!(plan.to_table, plan.from_table);
    assert!(!plan.can_switch_without_reembed, "8 维与 16 维不同组");
}

#[tokio::test]
async fn migration_switches_the_active_table_and_keeps_rows() {
    let fixture = fixture().await;
    let service = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    );
    let report = service
        .run(&fixture.collection.name, "fake:16", None)
        .await
        .expect("迁移");
    assert_eq!(report.rows, 2, "{report:?}");
    assert!(!report.resumed);

    let after = CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("读")
        .expect("存在");
    assert_eq!(after.active_table, report.to_table, "应切到新表");
    assert_eq!(after.dim, 16);
    assert_eq!(after.embedder_id, "fake:16");
    assert!(
        after.retired_tables.contains(&report.retired_table),
        "旧表应进退役列表:{after:?}"
    );
    assert!(after.migrating_to.is_none(), "迁移状态应清空");
    assert_eq!(
        fixture
            .env
            .store
            .count(&after.active_table, None)
            .await
            .expect("count"),
        2
    );
}

#[tokio::test]
async fn queries_and_writes_work_during_migration() {
    let fixture = fixture().await;
    // 迁移前再写一条 insight(写旧表)
    let service = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    );
    let plan = service
        .plan(&fixture.collection.name, "fake:16")
        .await
        .expect("估算");
    // 迁移中途读旧表:不应报错
    let old_rows = fixture
        .env
        .store
        .count(&plan.from_table, None)
        .await
        .expect("读旧表");
    assert_eq!(old_rows, 2);

    let report = service
        .run(&fixture.collection.name, "fake:16", None)
        .await
        .expect("迁移");
    // 迁移后按 active_table 查询
    let after = CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("读")
        .expect("存在");
    let ids: Vec<String> = ChunkRepo::ids_after(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        None,
        10,
    )
    .await
    .expect("取块 id")
    .into_iter()
    .map(|chunk| chunk.id)
    .collect();
    let rows = fixture
        .env
        .store
        .get(&after.active_table, &ids)
        .await
        .expect("读新表");
    assert_eq!(rows.len(), ids.len(), "新表应能按 id 读回:{report:?}");
}

#[tokio::test]
async fn migration_resumes_from_a_checkpoint() {
    let fixture = fixture().await;
    let service = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    );
    // 取第一块的 id 当检查点(模拟“处理到一半被杀掉”)
    let chunks = ChunkRepo::ids_after(fixture.env.meta.as_ref(), &fixture.collection.name, None, 1)
        .await
        .expect("取块");
    let checkpoint = chunks.first().map(|chunk| chunk.id.clone());
    assert!(checkpoint.is_some());
    let checkpoint = checkpoint.expect("检查点");

    // 模拟“第一块已经写完新表就被杀掉”:手工复制第一块到新表
    let plan = service
        .plan(&fixture.collection.name, "fake:16")
        .await
        .expect("估算");
    fixture
        .env
        .store
        .ensure_table(&plan.to_table, 16)
        .await
        .expect("建新表");
    let rows = fixture
        .env
        .store
        .get(&plan.from_table, std::slice::from_ref(&checkpoint))
        .await
        .expect("读旧表");
    let mut copied = rows;
    for row in copied.iter_mut() {
        row.vector = Some(vec![0.5; 16]);
    }
    fixture
        .env
        .store
        .upsert(&plan.to_table, copied)
        .await
        .expect("写新表");

    let report = service
        .run(&fixture.collection.name, "fake:16", Some(checkpoint))
        .await
        .expect("续跑");
    assert!(report.resumed, "应标记为续跑");
    assert_eq!(report.rows, 2, "续跑后两表条数应一致:{report:?}");
}

/// 兼容组为 `8` 的嵌入器:模拟“同组不同后端”的切换(fastembed:bge-m3-int8 ↔ http:bge-m3)。
struct GroupEmbedder {
    inner: FakeEmbedder,
}

#[async_trait::async_trait]
impl kb_core::ports::Embedder for GroupEmbedder {
    fn id(&self) -> &str {
        "fake:8-int8"
    }
    fn dim(&self) -> usize {
        8
    }
    fn compat_group(&self) -> &str {
        "8"
    }
    fn state(&self) -> kb_core::model::EmbedderState {
        kb_core::model::EmbedderState::Ready
    }
    async fn embed_documents(&self, texts: Vec<String>) -> kb_core::Result<Vec<Vec<f32>>> {
        self.inner.embed_documents(texts).await
    }
    async fn embed_query(&self, text: String) -> kb_core::Result<Vec<f32>> {
        self.inner.embed_query(text).await
    }
}

#[tokio::test]
async fn same_compat_group_is_flagged_as_switchable() {
    let fixture = fixture().await;
    let service = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(GroupEmbedder {
            inner: FakeEmbedder::new(8),
        }),
    );
    let plan = service
        .plan(&fixture.collection.name, "fake:8-int8")
        .await
        .expect("估算");
    assert!(
        plan.can_switch_without_reembed,
        "同 compat_group 应提示可免迁移:{plan:?}"
    );
}

/// 300 块的项目 + 迁移期间并发改写/删除 + 查询,验证迁移能在有限时间内完成。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn migration_survives_concurrent_writes_and_deletions() {
    let dir = tempfile::tempdir().expect("项目");
    for index in 0..300 {
        std::fs::write(
            dir.path().join(format!("f{index}.rs")),
            format!("fn f{index}() -> u32 {{\n    {index}\n}}\n"),
        )
        .expect("写文件");
    }
    let env = TestEnv::new().await;
    let project = Project {
        id: "p1".to_owned(),
        name: "big".to_owned(),
        slug: "big".to_owned(),
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
        .expect("写项目");
    let collections =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let collection = collections
        .create_for_project("p1", "big")
        .await
        .expect("建 collection");
    // 索引服务与迁移共享同一把写闸门
    let gate = kb_service::WriteGate::new();
    let index = std::sync::Arc::new(
        IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            IndexOptions::default(),
        )
        .with_write_gate(gate.clone()),
    );
    index
        .index_project(&project, &collection)
        .await
        .expect("首次索引");
    let before = env
        .store
        .count(&collection.active_table, None)
        .await
        .expect("count");
    assert_eq!(before, 300, "应有 300 块");

    // 记下将被删除的 10 个文件的块 id:迁移后新表里绝不能留下这些行
    let mut doomed_ids: Vec<String> = Vec::new();
    for index in 0..10 {
        let path = format!("f{index}.rs");
        for chunk in ChunkRepo::by_path(env.meta.as_ref(), &collection.name, &path)
            .await
            .expect("读块")
        {
            doomed_ids.push(chunk.id);
        }
    }
    assert_eq!(doomed_ids.len(), 10, "被删除的 10 个文件各有 1 块");

    let service = std::sync::Arc::new(
        MigrationService::new(
            env.meta.clone(),
            env.store.clone(),
            std::sync::Arc::new(FakeEmbedder::new(16)),
        )
        .with_write_gate(gate.clone()),
    );

    // 并发:迁移的同时改写 300 个文件(全部重索引)并删掉 10 个文件
    let migrator = {
        let service = service.clone();
        let name = collection.name.clone();
        tokio::spawn(async move { service.run(&name, "fake:16", None).await })
    };
    let writer = {
        let index = index.clone();
        let project = project.clone();
        // 故意传迁移前的 collection 快照:写闸门要求服务自己重新读
        let collection = collection.clone();
        let dir = dir.path().to_path_buf();
        tokio::spawn(async move {
            for index in 0..300 {
                std::fs::write(
                    dir.join(format!("f{index}.rs")),
                    format!("fn f{index}() -> u32 {{\n    {}\n}}\n", index + 1000),
                )
                .expect("改写");
            }
            for index in 0..10 {
                std::fs::remove_file(dir.join(format!("f{index}.rs"))).expect("删除");
            }
            index.index_project(&project, &collection).await
        })
    };
    let _ = writer.await.expect("写入任务").expect("重索引");
    let report = tokio::time::timeout(std::time::Duration::from_secs(120), migrator)
        .await
        .expect("迁移应在 120 秒内结束(旧实现会死循环)")
        .expect("迁移任务")
        .expect("迁移成功");

    let after = CollectionRepo::get(env.meta.as_ref(), &collection.name)
        .await
        .expect("读")
        .expect("存在");
    let chunks_now = ChunkRepo::count(env.meta.as_ref(), &collection.name)
        .await
        .expect("chunks count");
    let new_rows = env
        .store
        .count(&after.active_table, None)
        .await
        .expect("新表");
    // 写闸门之后不再放宽:并发迁移结束时新表行数必须严格等于 chunks
    assert_eq!(
        new_rows, chunks_now,
        "并发迁移后 active 表行数必须等于 chunks 表:{report:?}"
    );
    assert_eq!(chunks_now, 290, "300 个文件删掉 10 个后应剩 290 块");
    // `report.rows` 是迁移**完成那一刻**的快照(在写锁内统计),不对它和事后的
    // `chunks_now` 比较:写入任务可能在切换之后才删掉那 10 个文件,行数会合法地变。
    // 快照语义由静止场景的 `fill_missing_...` 与 `migration_switches_...` 用例断言。
    assert!(
        report.rows == 290 || report.rows == 300,
        "迁移完成时的行数只能是删除前后的两种取值:{report:?}"
    );

    // 已删除文件的块绝不能留在新表里(用迁移前记下的 id 查）
    let leftover = env
        .store
        .get(&after.active_table, &doomed_ids)
        .await
        .expect("读新表");
    assert!(
        leftover.is_empty(),
        "已删除文件的块残留在新表:{}",
        leftover
            .iter()
            .map(|row| row.source.clone())
            .collect::<Vec<_>>()
            .join(",")
    );

    // 连续第二次迁移(A → B → C):同样严格相等,并确认不会从更早的退役表补行
    let quiesced = MigrationService::new(
        env.meta.clone(),
        env.store.clone(),
        std::sync::Arc::new(FakeEmbedder::new(32)),
    )
    .with_write_gate(gate.clone());
    let second = quiesced
        .run(&collection.name, "fake:32", None)
        .await
        .expect("第二次迁移");
    let chunks_after = ChunkRepo::count(env.meta.as_ref(), &collection.name)
        .await
        .expect("chunks count");
    let active_rows = env.store.count(&second.to_table, None).await.expect("新表");
    assert_eq!(
        active_rows, chunks_after,
        "第二次迁移后 active 表行数必须等于 chunks 表:{second:?}"
    );
    assert_eq!(
        second.rows, chunks_after,
        "报告的 rows 也应是 chunks 数:{second:?}"
    );
    let leftover_second = env
        .store
        .get(&second.to_table, &doomed_ids)
        .await
        .expect("读新表");
    assert!(
        leftover_second.is_empty(),
        "已删除文件的块在第二次迁移后又出现:{}",
        leftover_second
            .iter()
            .map(|row| row.source.clone())
            .collect::<Vec<_>>()
            .join(",")
    );
}

#[tokio::test]
async fn resume_drops_orphan_rows_from_the_previous_run() {
    // :上次进程写进新表、后来对应块被删掉的行,续跑后必须消失
    let fixture = fixture().await;
    let service = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    );
    let plan = service
        .plan(&fixture.collection.name, "fake:16")
        .await
        .expect("估算");
    fixture
        .env
        .store
        .ensure_table(&plan.to_table, 16)
        .await
        .expect("建新表");
    // 手工塞一条“孤儿行”:id 不在 chunks 里
    let orphan = kb_core::model::RecordRow {
        id: "deadbeef-0001".to_owned(),
        collection: fixture.collection.name.clone(),
        kind: kb_core::model::RecordKind::Code,
        lang: Some("rust".to_owned()),
        source: "gone.rs".to_owned(),
        start_line: Some(1),
        end_line: Some(2),
        symbol: None,
        title: None,
        text: "fn gone() {}".to_owned(),
        header: "gone".to_owned(),
        lex: String::new(),
        tags: Vec::new(),
        status: kb_core::model::ItemStatus::Active,
        content_hash: String::new(),
        meta_hash: String::new(),
        embed_input_hash: String::new(),
        updated_at: 1,
        anchor: None,
        vector: Some(vec![0.0; 16]),
    };
    fixture
        .env
        .store
        .upsert(&plan.to_table, vec![orphan])
        .await
        .expect("写孤儿行");
    assert_eq!(
        fixture
            .env
            .store
            .count(&plan.to_table, None)
            .await
            .expect("count"),
        1,
        "此时新表里只有这一条孤儿行"
    );

    let chunks = ChunkRepo::ids_after(fixture.env.meta.as_ref(), &fixture.collection.name, None, 1)
        .await
        .expect("取块");
    let checkpoint = chunks.first().map(|chunk| chunk.id.clone()).expect("块");
    let report = service
        .run(&fixture.collection.name, "fake:16", Some(checkpoint))
        .await
        .expect("续跑");

    let orphans = fixture
        .env
        .store
        .get(&report.to_table, &["deadbeef-0001".to_owned()])
        .await
        .expect("查孤儿行");
    assert!(orphans.is_empty(), "续跑后孤儿行应被清掉");
    let expected = ChunkRepo::count(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("chunks");
    assert_eq!(report.rows, expected, "新表应只含 chunks 里的块:{report:?}");
}

#[tokio::test]
async fn cli_style_rerun_after_interruption_uses_migrating_to() {
    // :`kb migrate` 总是传 None checkpoint;上次中断留下 `migrating_to` 时必须按续跑处理
    let fixture = fixture().await;
    let service = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    );
    let plan = service
        .plan(&fixture.collection.name, "fake:16")
        .await
        .expect("估算");
    // 模拟“上次进程写到一半被杀”:库里留下 migrating_to + 目标表里有一行残留
    let mut broken = CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("读")
        .expect("存在");
    broken.migrating_to = Some(plan.to_table.clone());
    broken.migration_started_at = Some(1);
    CollectionRepo::update(fixture.env.meta.as_ref(), broken)
        .await
        .expect("写迁移状态");
    fixture
        .env
        .store
        .ensure_table(&plan.to_table, 16)
        .await
        .expect("建表");
    let leftover = kb_core::model::RecordRow {
        id: "deadbeef-0002".to_owned(),
        collection: fixture.collection.name.clone(),
        kind: kb_core::model::RecordKind::Code,
        lang: Some("rust".to_owned()),
        source: "half.rs".to_owned(),
        start_line: Some(1),
        end_line: Some(1),
        symbol: None,
        title: None,
        text: "fn half() {}".to_owned(),
        header: "half".to_owned(),
        lex: String::new(),
        tags: Vec::new(),
        status: kb_core::model::ItemStatus::Active,
        content_hash: String::new(),
        meta_hash: String::new(),
        embed_input_hash: String::new(),
        updated_at: 1,
        anchor: None,
        vector: Some(vec![0.0; 16]),
    };
    fixture
        .env
        .store
        .upsert(&plan.to_table, vec![leftover])
        .await
        .expect("写残留行");

    // CLI 语义:checkpoint = None
    let report = service
        .run(&fixture.collection.name, "fake:16", None)
        .await
        .expect("续跑");
    assert!(report.resumed, "有 migrating_to 时应按续跑处理:{report:?}");
    let orphans = fixture
        .env
        .store
        .get(&report.to_table, &["deadbeef-0002".to_owned()])
        .await
        .expect("查残留");
    assert!(orphans.is_empty(), "残留行应被清掉");
    let expected = ChunkRepo::count(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("chunks");
    assert_eq!(report.rows, expected, "{report:?}");
}

/// 在迁移“建向量索引”这一步(条数校验之后、切换之前)注入一次写入,
/// 用来钉住切换窗口与 `fill_missing` 的行为。
struct SwitchWindowStore {
    inner: Arc<dyn VectorStore>,
    meta: Arc<dyn MetaStore>,
    collection: String,
    /// 注入的行写进哪张表(本次退役的旧表,或更早的退役表)。
    into_table: String,
    injected_id: String,
    /// 目标表的维度(旧表各自的维度不同)。
    vector_len: usize,
    injected: std::sync::Mutex<bool>,
}

impl SwitchWindowStore {
    fn new(
        inner: Arc<dyn VectorStore>,
        meta: Arc<dyn MetaStore>,
        collection: &str,
        into_table: &str,
        injected_id: &str,
        vector_len: usize,
    ) -> Self {
        Self {
            inner,
            meta,
            collection: collection.to_owned(),
            into_table: into_table.to_owned(),
            injected_id: injected_id.to_owned(),
            vector_len,
            injected: std::sync::Mutex::new(false),
        }
    }

    /// 注入一次“窗口内的写入”:SQLite 里登记块 + 往旧表写一行。
    async fn inject(&self) {
        let now = 1_700_000_999_000;
        let chunk = ChunkMeta {
            id: self.injected_id.clone(),
            collection: self.collection.clone(),
            path: "late.rs".to_owned(),
            ordinal: 0,
            content_hash: "late-content".to_owned(),
            meta_hash: "late-meta".to_owned(),
            embed_input_hash: "late-embed".to_owned(),
            updated_at: now,
        };
        ChunkRepo::replace_for_path(self.meta.as_ref(), &self.collection, "late.rs", vec![chunk])
            .await
            .expect("登记窗口内写入的块");
        let row = RecordRow {
            id: self.injected_id.clone(),
            collection: self.collection.clone(),
            kind: RecordKind::Code,
            lang: Some("rust".to_owned()),
            source: "late.rs".to_owned(),
            start_line: Some(1),
            end_line: Some(2),
            symbol: Some("late".to_owned()),
            title: None,
            text: "fn late() {}".to_owned(),
            header: "late.rs".to_owned(),
            lex: "fn late".to_owned(),
            tags: Vec::new(),
            status: ItemStatus::Active,
            content_hash: "late-content".to_owned(),
            meta_hash: "late-meta".to_owned(),
            embed_input_hash: "late-embed".to_owned(),
            updated_at: now,
            anchor: None,
            vector: Some(vec![0.25; self.vector_len]),
        };
        self.inner
            .upsert(&self.into_table, vec![row])
            .await
            .expect("把窗口内的写入写进旧表");
    }
}

#[async_trait::async_trait]
impl VectorStore for SwitchWindowStore {
    async fn ensure_table(&self, table: &str, dim: usize) -> kb_core::Result<()> {
        self.inner.ensure_table(table, dim).await
    }

    async fn upsert(&self, table: &str, rows: Vec<RecordRow>) -> kb_core::Result<()> {
        self.inner.upsert(table, rows).await
    }

    async fn update_meta(&self, table: &str, id: &str, patch: MetaPatch) -> kb_core::Result<()> {
        self.inner.update_meta(table, id, patch).await
    }

    async fn delete_ids(&self, table: &str, ids: &[String]) -> kb_core::Result<()> {
        self.inner.delete_ids(table, ids).await
    }

    async fn get(&self, table: &str, ids: &[String]) -> kb_core::Result<Vec<RecordRow>> {
        self.inner.get(table, ids).await
    }

    async fn search(&self, table: &str, req: &StoreQuery) -> kb_core::Result<Vec<StoreHit>> {
        self.inner.search(table, req).await
    }

    async fn list(
        &self,
        table: &str,
        query: &kb_core::model::ListQuery,
    ) -> kb_core::Result<Vec<kb_core::model::RecordRow>> {
        self.inner.list(table, query).await
    }

    async fn count(&self, table: &str, filter: Option<&str>) -> kb_core::Result<u64> {
        self.inner.count(table, filter).await
    }

    async fn optimize(&self, table: &str) -> kb_core::Result<()> {
        self.inner.optimize(table).await
    }

    async fn ensure_fts_index(&self, table: &str) -> kb_core::Result<()> {
        self.inner.ensure_fts_index(table).await
    }

    async fn ensure_vector_index(&self, table: &str) -> kb_core::Result<()> {
        self.inner.ensure_vector_index(table).await?;
        let first = {
            let mut flag = self.injected.lock().expect("注入标记锁");
            let first = !*flag;
            *flag = true;
            first
        };
        if first {
            self.inject().await;
        }
        Ok(())
    }

    async fn drop_table(&self, table: &str) -> kb_core::Result<()> {
        self.inner.drop_table(table).await
    }
}

#[tokio::test]
async fn fill_missing_copies_rows_written_into_the_retired_table_during_the_switch_window() {
    // :条数校验之后、切换之前写进旧表的块,切换后必须补进新表。
    // 回退 `fill_missing` 的调用(或让它只从更早的退役表补),这个用例必须失败。
    let fixture = fixture().await;
    let store: Arc<dyn VectorStore> = Arc::new(SwitchWindowStore::new(
        fixture.env.store.clone(),
        fixture.env.meta.clone(),
        &fixture.collection.name,
        &fixture.collection.active_table,
        "deadbeef-1001",
        8,
    ));
    let service = MigrationService::new(
        fixture.env.meta.clone(),
        store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    );
    let report = service
        .run(&fixture.collection.name, "fake:16", None)
        .await
        .expect("迁移");
    let rows = store
        .get(&report.to_table, &["deadbeef-1001".to_owned()])
        .await
        .expect("读新表");
    assert_eq!(
        rows.len(),
        1,
        "切换窗口内写进旧表的块必须补进新表:{report:?}"
    );
    let chunks = ChunkRepo::count(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("chunks count");
    assert_eq!(
        report.rows, chunks,
        "报告的 rows 应与 chunks 一致:{report:?}"
    );
}

#[tokio::test]
async fn fill_missing_does_not_read_older_retired_tables() {
    // 迁移两次(A→B→C):第二次切换窗口里的写入只落在**更早**的退役表 A 里。
    // `fill_missing` 只能读本次退役的 B;从 A 补行会把陈旧向量带进新表。
    let fixture = fixture().await;
    let first = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    )
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect("第一次迁移");
    let store: Arc<dyn VectorStore> = Arc::new(SwitchWindowStore::new(
        fixture.env.store.clone(),
        fixture.env.meta.clone(),
        &fixture.collection.name,
        &first.retired_table,
        "deadbeef-2002",
        8,
    ));
    let second = MigrationService::new(
        fixture.env.meta.clone(),
        store.clone(),
        Arc::new(FakeEmbedder::new(32)),
    )
    .run(&fixture.collection.name, "fake:32", None)
    .await
    .expect("第二次迁移");
    let rows = store
        .get(&second.to_table, &["deadbeef-2002".to_owned()])
        .await
        .expect("读新表");
    assert!(
        rows.is_empty(),
        "不能从更早的退役表补行(陈旧向量):{second:?}"
    );
}

/// 保存一条 insight 并把它的嵌入任务跑完(迁移要搬的就是这一行)。
async fn save_and_embed_insight(fixture: &Fixture, title: &str, body: &str) -> String {
    use kb_core::model::InsightKind;
    use kb_service::insight::{InsightJobHandler, SaveInsightRequest};
    use kb_service::jobs::JobHandler;

    let service = kb_service::InsightService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    );
    let saved = service
        .save(SaveInsightRequest {
            title: title.to_owned(),
            body_md: body.to_owned(),
            kind: Some(InsightKind::Decision),
            project: Some("demo".to_owned()),
            collection: None,
            global: false,
            tags: vec!["迁移".to_owned()],
            related_paths: Vec::new(),
            supersedes: None,
            created_by: "user".to_owned(),
            cwd: None,
            strict_links: false,
        })
        .await
        .expect("保存 insight");
    let job = kb_core::ports::repo::JobRepo::get(fixture.env.meta.as_ref(), &saved.job_id)
        .await
        .expect("读任务")
        .expect("任务存在");
    InsightJobHandler::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    )
    .run_slice(&job)
    .await
    .expect("嵌入 insight");
    saved.id
}

#[tokio::test]
async fn migration_moves_insight_rows_too() {
    // / (b):以前只搬 chunks,换模型后 insight 在新表里不存在
    let fixture = fixture().await;
    let insight_id = save_and_embed_insight(
        &fixture,
        "换模型要一起搬经验条目",
        "迁移只搬 chunks 会丢 insight。",
    )
    .await;
    let chunks = ChunkRepo::count(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("数块");

    let service = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    );
    let plan = service
        .plan(&fixture.collection.name, "fake:16")
        .await
        .expect("估算");
    assert_eq!(plan.insight_rows, 1, "估算要算上 insight:{plan:?}");
    assert_eq!(plan.rows, chunks + 1, "总行数 = chunks + insights:{plan:?}");

    let report = service
        .run(&fixture.collection.name, "fake:16", None)
        .await
        .expect("迁移");
    assert_eq!(report.rows, chunks + 1, "新表行数应含 insight:{report:?}");

    let collection = CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("读 collection")
        .expect("存在");
    assert_ne!(collection.active_table, fixture.collection.active_table);
    assert_eq!(collection.embedder_id, "fake:16");
    assert_eq!(collection.dim, 16);

    let rows = fixture
        .env
        .store
        .get(&collection.active_table, std::slice::from_ref(&insight_id))
        .await
        .expect("读新表");
    assert_eq!(rows.len(), 1, "insight 行应已搬到新表");
    assert_eq!(rows[0].kind, RecordKind::Insight);
    assert_eq!(rows[0].title.as_deref(), Some("换模型要一起搬经验条目"));
    assert_eq!(
        rows[0].vector.as_ref().map(Vec::len),
        None,
        "get() 默认不取向量"
    );
    // 新表里的向量是 16 维(用新嵌入器重算过),可用向量检索验证
    let hits = fixture
        .env
        .store
        .search(
            &collection.active_table,
            &StoreQuery {
                mode: kb_core::model::SearchMode::Vector,
                text: None,
                vector: Some(
                    fixture
                        .env
                        .embedder
                        .embed_query("换模型要一起搬经验条目".to_owned())
                        .await
                        .map(|vector| {
                            let mut widened = vec![0.0f32; 16];
                            for (index, value) in vector.iter().enumerate().take(16) {
                                widened[index] = *value;
                            }
                            widened
                        })
                        .expect("查询向量"),
                ),
                filter: kb_core::Filter {
                    kinds: vec![RecordKind::Insight],
                    statuses: ItemStatus::ALL.to_vec(),
                    ..kb_core::Filter::default()
                },
                limit: 5,
                offset: 0,
                with_vector: false,
            },
        )
        .await
        .expect("新表检索");
    assert!(
        hits.iter().any(|hit| hit.row.id == insight_id),
        "新表里应能检索到 insight:{:?}",
        hits.iter()
            .map(|hit| hit.row.id.clone())
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn retired_tables_do_not_grow_without_bound() {
    // ③:退役表列表只保留最近 MAX_RETIRED_TABLES 张
    let fixture = fixture().await;
    let mut collection = fixture.collection.clone();
    collection.retired_tables = (0..kb_service::migration::MAX_RETIRED_TABLES)
        .map(|index| format!("proj_demo__fake_8__old{index}"))
        .collect();
    CollectionRepo::update(fixture.env.meta.as_ref(), collection)
        .await
        .expect("写回 collection");

    let service = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    );
    service
        .run(&fixture.collection.name, "fake:16", None)
        .await
        .expect("迁移");

    let collection = CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("读 collection")
        .expect("存在");
    assert_eq!(
        collection.retired_tables.len(),
        kb_service::migration::MAX_RETIRED_TABLES,
        "退役表列表应被封顶:{:?}",
        collection.retired_tables
    );
    assert_eq!(
        collection.retired_tables.last().map(String::as_str),
        Some(fixture.collection.active_table.as_str()),
        "最新退役的表应留在列表末尾"
    );
}

/// 把一次迁移按任务分片跑完,返回每个分片的进度。
async fn run_as_job(
    handler: &kb_service::jobs::MigrateJobHandler,
    job: &kb_core::model::Job,
) -> Vec<kb_service::jobs::SliceProgress> {
    use kb_service::jobs::JobHandler;
    let mut slices = Vec::new();
    for _ in 0..100 {
        let progress = handler.run_slice(job).await.expect("跑迁移分片");
        let finished = progress.finished;
        slices.push(progress);
        if finished {
            return slices;
        }
    }
    panic!("迁移分片没有结束:{slices:?}");
}

#[tokio::test]
async fn migrate_job_reports_progress_and_finishes() {
    // :迁移入队执行,进度 / 总数由 worker 落库并推送
    use kb_service::jobs::{MigrateJobHandler, NewJob};
    use kb_service::migration::MigrationService;

    let fixture = fixture().await;
    let insight_id =
        save_and_embed_insight(&fixture, "迁移任务要搬经验", "insight 也要进新表。").await;
    let chunks = ChunkRepo::count(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("数块");

    let service = Arc::new(
        MigrationService::new(
            fixture.env.meta.clone(),
            fixture.env.store.clone(),
            Arc::new(FakeEmbedder::new(16)),
        )
        .with_write_gate(fixture.gate_or_new()),
    );
    let handler = MigrateJobHandler::new(service);
    let queue = kb_service::jobs::JobQueue::new(fixture.env.meta.clone());
    let job = queue
        .enqueue(NewJob {
            kind: "migrate".to_owned(),
            collection: Some(fixture.collection.name.clone()),
            priority: kb_service::jobs::priority::MIGRATE,
            payload: serde_json::json!({
                "collection": fixture.collection.name,
                "to": "fake:16",
            }),
        })
        .await
        .expect("入队");

    let slices = run_as_job(&handler, &job).await;
    assert!(slices.len() >= 2, "应有多个分片(复制 + 收尾):{slices:?}");
    // 进度单调不减,分母是 chunks + insights
    let mut previous = 0u64;
    for slice in &slices {
        assert!(slice.done >= previous, "进度不应回退:{slices:?}");
        previous = slice.done;
        assert_eq!(slice.total, Some(chunks + 1), "分母应含 insight:{slices:?}");
    }
    let last = slices.last().expect("至少一片");
    assert!(last.finished, "最后一片应完成:{last:?}");
    // 中间分片带检查点,便于观察与重启判定
    assert!(
        slices[..slices.len() - 1]
            .iter()
            .all(|slice| slice.checkpoint.is_some()),
        "中间分片应带检查点:{slices:?}"
    );

    let collection = CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("读")
        .expect("存在");
    assert_eq!(collection.embedder_id, "fake:16");
    assert!(collection.migrating_to.is_none());
    let rows = fixture
        .env
        .store
        .get(&collection.active_table, &[insight_id])
        .await
        .expect("读新表");
    assert_eq!(rows.len(), 1, "insight 行应在新表里");
}

#[tokio::test]
async fn migrate_job_rebuilds_the_target_table_after_a_restart() {
    // 进程重启后内存状态丢失:按续跑处理(重建目标表从头复制）
    use kb_service::jobs::{MigrateJobHandler, NewJob};
    use kb_service::migration::MigrationService;

    let fixture = fixture().await;
    let service = Arc::new(
        MigrationService::new(
            fixture.env.meta.clone(),
            fixture.env.store.clone(),
            Arc::new(FakeEmbedder::new(16)),
        )
        .with_write_gate(fixture.gate_or_new()),
    );
    let queue = kb_service::jobs::JobQueue::new(fixture.env.meta.clone());
    let job = queue
        .enqueue(NewJob {
            kind: "migrate".to_owned(),
            collection: Some(fixture.collection.name.clone()),
            priority: kb_service::jobs::priority::MIGRATE,
            payload: serde_json::json!({
                "collection": fixture.collection.name,
                "to": "fake:16",
            }),
        })
        .await
        .expect("入队");

    // 第一个“进程”:只跑一片就丢掉
    {
        let handler = MigrateJobHandler::new(service.clone());
        let first = {
            use kb_service::jobs::JobHandler;
            handler.run_slice(&job).await.expect("第一片")
        };
        assert!(!first.finished, "第一片不应完成:{first:?}");
    }

    // 第二个“进程”:库里已有 checkpoint_json,应按续跑重建目标表并跑完
    let resumed_job = kb_core::model::Job {
        checkpoint_json: Some(r#"{"phase":"copy"}"#.to_owned()),
        detail: None,
        ..job.clone()
    };
    let handler = MigrateJobHandler::new(service);
    let slices = run_as_job(&handler, &resumed_job).await;
    assert!(slices.last().expect("最后一片").finished);

    let collection = CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("读")
        .expect("存在");
    assert_eq!(collection.embedder_id, "fake:16");
    // 条数必须对得上(重建后不能多出行)
    let chunks = ChunkRepo::count(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("数块");
    let rows = fixture
        .env
        .store
        .count(&collection.active_table, None)
        .await
        .expect("数行");
    assert_eq!(rows, chunks, "重建后新表行数应等于 chunks");
}

// ───────────────────────── embed_input_hash 随嵌入器一起迁移 ─────────────────────────
//
// `embed_input_hash = xxh3(嵌入器 id ‖ header ‖ "\n" ‖ text)`,嵌入器 id 是它的输入。
// 迁移只换向量不换这个哈希的话,命中插件的文件(要「重新分块再 diff」)在迁移之后的任何一次
// 全量扫描里都会被判成「每个块的嵌入输入都变了」,整份重嵌入。

use kb_core::hash::embed_input_hash;
use kb_core::ports::Embedder;
use kb_service::SkillRegistry;

/// SQLite 里某个 collection 的全部块(按 id 升序)。
async fn all_chunks(env: &TestEnv, collection: &str) -> Vec<ChunkMeta> {
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let batch = ChunkRepo::ids_after(env.meta.as_ref(), collection, after.as_deref(), 100)
            .await
            .expect("翻页取块");
        if batch.is_empty() {
            return out;
        }
        after = batch.last().map(|chunk| chunk.id.clone());
        out.extend(batch);
    }
}

/// 读 collection 当前的元数据。
async fn current_collection(env: &TestEnv, name: &str) -> Collection {
    CollectionRepo::get(env.meta.as_ref(), name)
        .await
        .expect("读 collection")
        .expect("collection 存在")
}

/// 断言 active 表里每个块的哈希 == 用 `embedder_id` 重算的值,并且 SQLite `chunks` 里同 id 的值与 Lance 相等。
///
/// 返回检查了多少个块(调用方据此确认不是空转)。
async fn assert_hashes_follow_embedder(
    env: &TestEnv,
    collection: &str,
    embedder_id: &str,
) -> usize {
    let active = current_collection(env, collection).await;
    let chunks = all_chunks(env, collection).await;
    let ids: Vec<String> = chunks.iter().map(|chunk| chunk.id.clone()).collect();
    let rows = env
        .store
        .get(&active.active_table, &ids)
        .await
        .expect("读 active 表");
    assert_eq!(rows.len(), chunks.len(), "active 表应含全部块");
    for row in &rows {
        let expected = embed_input_hash(embedder_id, &row.header, &row.text);
        assert_eq!(
            row.embed_input_hash, expected,
            "Lance 里的 embed_input_hash 应按 {embedder_id} 重算:{}",
            row.id
        );
        let chunk = chunks
            .iter()
            .find(|chunk| chunk.id == row.id)
            .expect("SQLite 里有同 id 的块");
        assert_eq!(
            chunk.embed_input_hash, row.embed_input_hash,
            "SQLite chunks 的 embed_input_hash 应与 Lance 一致:{}",
            row.id
        );
    }
    rows.len()
}

#[tokio::test]
async fn migration_rewrites_embed_input_hash_in_lance_and_sqlite() {
    let fixture = fixture().await;
    let insight_id =
        save_and_embed_insight(&fixture, "哈希要跟着嵌入器走", "insight 行本来就是对的。").await;
    let before = all_chunks(&fixture.env, &fixture.collection.name).await;
    assert!(!before.is_empty(), "夹具应已索引出块");
    // 迁移前两边都是旧嵌入器(fake:8)的口径
    let old_rows = fixture
        .env
        .store
        .get(
            &fixture.collection.active_table,
            &before.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
        )
        .await
        .expect("读旧表");
    for row in &old_rows {
        assert_eq!(
            row.embed_input_hash,
            embed_input_hash("fake:8", &row.header, &row.text),
            "前提:迁移前哈希按 fake:8 算"
        );
    }

    let report = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    )
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect("迁移");
    assert!(report.warnings.is_empty(), "不应有告警:{report:?}");

    let checked =
        assert_hashes_follow_embedder(&fixture.env, &fixture.collection.name, "fake:16").await;
    assert_eq!(checked, before.len());
    // 哈希确实换了口径,不是碰巧相等
    for chunk in all_chunks(&fixture.env, &fixture.collection.name).await {
        let old = before.iter().find(|old| old.id == chunk.id).expect("同 id");
        assert_ne!(chunk.embed_input_hash, old.embed_input_hash, "{}", chunk.id);
    }

    // insight 行:`chunks` 里没有它,Lance 里的哈希本来就按新嵌入器 id 算,写回不能动它
    let active = current_collection(&fixture.env, &fixture.collection.name).await;
    let rows = fixture
        .env
        .store
        .get(&active.active_table, std::slice::from_ref(&insight_id))
        .await
        .expect("读 insight 行");
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].embed_input_hash,
        embed_input_hash("fake:16", &rows[0].header, &rows[0].text),
        "insight 行的哈希按新嵌入器 id 算"
    );
    assert_eq!(
        all_chunks(&fixture.env, &fixture.collection.name)
            .await
            .len(),
        before.len(),
        "写回不能给 chunks 凭空多出 insight 行"
    );
}

#[tokio::test]
async fn hash_writeback_does_not_touch_updated_at_or_other_columns() {
    // updated_at 是迁移追平的水位线:写回哈希时动了它,追平就会把没变的块再复制一遍
    let fixture = fixture().await;
    let before = all_chunks(&fixture.env, &fixture.collection.name).await;
    assert!(!before.is_empty());

    MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    )
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect("迁移");

    let after = all_chunks(&fixture.env, &fixture.collection.name).await;
    assert_eq!(after.len(), before.len());
    for (old, new) in before.iter().zip(&after) {
        assert_eq!(old.id, new.id);
        assert_eq!(
            old.updated_at, new.updated_at,
            "updated_at 不能变:{}",
            old.id
        );
        assert_eq!(old.collection, new.collection);
        assert_eq!(old.path, new.path);
        assert_eq!(old.ordinal, new.ordinal);
        assert_eq!(old.content_hash, new.content_hash);
        assert_eq!(old.meta_hash, new.meta_hash);
        assert_ne!(
            old.embed_input_hash, new.embed_input_hash,
            "只有 embed_input_hash 应该变:{}",
            old.id
        );
    }
}

/// 命中插件的夹具:`[index]` 规则给 `.rs` / `.md` 加标签。
///
/// 只要插件规则有 lang / tags / 钩子,`index_entry_with` 就不走「文件哈希没变就跳过」的快路径,
/// 每次都重新分块再和 SQLite 里的块 diff —— 生产上 md / json / yaml 等占大头的就是这条路径。
struct PluginFixture {
    env: TestEnv,
    project_dir: TempDir,
    #[allow(dead_code)]
    skills_dir: TempDir,
    project: Project,
    collection: Collection,
    skills: Arc<SkillRegistry>,
}

async fn plugin_fixture() -> PluginFixture {
    let project_dir = tempfile::tempdir().expect("项目目录");
    std::fs::write(
        project_dir.path().join("a.rs"),
        "fn a() -> u32 {\n    1\n}\n\nfn b() -> u32 {\n    2\n}\n",
    )
    .expect("写 a.rs");
    std::fs::create_dir_all(project_dir.path().join("notes")).expect("建目录");
    std::fs::write(
        project_dir.path().join("notes/guide.md"),
        "# 指南\n\n第一段说明。\n\n## 安装\n\n安装步骤。\n\n## 使用\n\n使用方法。\n",
    )
    .expect("写 guide.md");
    let skills_dir = tempfile::tempdir().expect("skills 目录");
    let plugin = skills_dir.path().join("tagger");
    std::fs::create_dir_all(&plugin).expect("建插件目录");
    std::fs::write(
        plugin.join("manifest.toml"),
        r#"
type = "plugin"
name = "tagger"
[index]
include = ["**/*.rs", "**/*.md"]
tags = ["plugin-hit"]
"#,
    )
    .expect("写 manifest");
    let skills = Arc::new(SkillRegistry::load(skills_dir.path(), false));
    assert!(skills.warnings().is_empty(), "{:?}", skills.warnings());
    // 前提:两类文件都命中插件,否则下面测的是快路径,不是「重新分块再 diff」
    assert!(!skills.match_plugins("demo", "a.rs").is_empty());
    assert!(!skills.match_plugins("demo", "notes/guide.md").is_empty());

    let env = TestEnv::new().await;
    let project = Project {
        id: "p1".to_owned(),
        name: "demo".to_owned(),
        slug: "demo".to_owned(),
        root_path: project_dir.path().to_string_lossy().into_owned(),
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
        .expect("写项目");
    let collection =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
            .create_for_project("p1", "demo")
            .await
            .expect("建 collection");
    let fixture = PluginFixture {
        env,
        project_dir,
        skills_dir,
        project,
        collection,
        skills,
    };
    let report = fixture
        .index_with(fixture.env.embedder.clone())
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("首次索引");
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert!(report.embedded > 0, "首次索引应嵌入过块:{report:?}");
    fixture
}

impl PluginFixture {
    /// 用指定嵌入器构造索引服务(模拟守护进程换了嵌入器配置后重启)。
    fn index_with(&self, embedder: Arc<dyn Embedder>) -> IndexService {
        IndexService::new(
            self.env.meta.clone(),
            self.env.store.clone(),
            embedder,
            self.env.chunker.clone(),
            self.env.scanner.clone(),
            IndexOptions::default(),
        )
        .with_skills(self.skills.clone())
    }
}

#[tokio::test]
async fn reindexing_unchanged_plugin_files_after_migration_embeds_nothing() {
    // 关键性质:迁移完、文件一个字节没动,再跑全量扫描,嵌入器调用次数必须是 0
    let fixture = plugin_fixture().await;
    let new_embedder = Arc::new(FakeEmbedder::new(16));
    let report = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        new_embedder.clone(),
    )
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect("迁移");
    assert!(report.warnings.is_empty(), "{report:?}");
    assert!(new_embedder.embedding_count() > 0, "迁移本身要嵌入过");

    // 守护进程重启后用新嵌入器建索引服务;两遍(第二遍相当于下一次全量扫描)
    let index = fixture.index_with(new_embedder.clone());
    for round in 1..=2 {
        new_embedder.reset_count();
        let report = index
            .index_project(&fixture.project, &fixture.collection)
            .await
            .expect("迁移后再索引");
        assert!(report.errors.is_empty(), "{:?}", report.errors);
        assert!(report.chunks > 0, "应处理到块:{report:?}");
        assert_eq!(
            report.embedded, 0,
            "第 {round} 遍:文件没变,不应重嵌入:{report:?}"
        );
        assert_eq!(
            new_embedder.embedding_count(),
            0,
            "第 {round} 遍:嵌入器调用次数应为 0"
        );
    }
}

#[tokio::test]
async fn editing_one_function_after_migration_reembeds_only_that_chunk() {
    // 没修之前:迁移后改一行,命中插件的文件所有块都要重嵌入(一次性代价)
    let fixture = plugin_fixture().await;
    let new_embedder = Arc::new(FakeEmbedder::new(16));
    MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        new_embedder.clone(),
    )
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect("迁移");

    // 行数不变,只改 fn b 的返回值
    std::fs::write(
        fixture.project_dir.path().join("a.rs"),
        "fn a() -> u32 {\n    1\n}\n\nfn b() -> u32 {\n    3\n}\n",
    )
    .expect("改文件");
    new_embedder.reset_count();
    let report = fixture
        .index_with(new_embedder.clone())
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("再索引");
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.embedded, 1, "只有被改的那个块要重嵌入:{report:?}");
    assert_eq!(new_embedder.embedding_count(), 1);
}

/// 把 active 表和 SQLite 里的 `embed_input_hash` 都改回 `old_embedder_id` 口径。
///
/// 这正是修复之前的迁移留下的状态(也是生产上已经迁完的 4 个小集合现在的样子)。
async fn make_hashes_stale(env: &TestEnv, collection: &str, old_embedder_id: &str) {
    let active = current_collection(env, collection).await;
    let chunks = all_chunks(env, collection).await;
    let ids: Vec<String> = chunks.iter().map(|chunk| chunk.id.clone()).collect();
    let rows = env
        .store
        .get(&active.active_table, &ids)
        .await
        .expect("读表");
    let mut stale = std::collections::BTreeMap::new();
    for row in &rows {
        let hash = embed_input_hash(old_embedder_id, &row.header, &row.text);
        env.store
            .update_meta(
                &active.active_table,
                &row.id,
                MetaPatch {
                    embed_input_hash: Some(hash.clone()),
                    ..MetaPatch::default()
                },
            )
            .await
            .expect("改 Lance 哈希");
        stale.insert(row.id.clone(), hash);
    }
    let mut paths: Vec<String> = chunks.iter().map(|chunk| chunk.path.clone()).collect();
    paths.sort();
    paths.dedup();
    for path in paths {
        let mut group: Vec<ChunkMeta> = chunks
            .iter()
            .filter(|chunk| chunk.path == path)
            .cloned()
            .collect();
        for chunk in &mut group {
            chunk.embed_input_hash = stale[&chunk.id].clone();
        }
        ChunkRepo::replace_for_path(env.meta.as_ref(), collection, &path, group)
            .await
            .expect("改 SQLite 哈希");
    }
}

#[tokio::test]
async fn migrating_to_the_same_embedder_refreshes_stale_hashes() {
    // 修复前已经迁完的集合:嵌入器 id 已经是新的,哈希还是旧口径。
    // 「迁到自己」(新建 __v<n+1> 表重新复制)必须能把它们刷对。
    let fixture = plugin_fixture().await;
    let embedder = Arc::new(FakeEmbedder::new(16));
    MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        embedder.clone(),
    )
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect("第一次迁移");
    let first = current_collection(&fixture.env, &fixture.collection.name).await;
    assert!(
        first.active_table.ends_with("__v2"),
        "{}",
        first.active_table
    );

    make_hashes_stale(&fixture.env, &fixture.collection.name, "fake:8").await;
    let chunks = all_chunks(&fixture.env, &fixture.collection.name).await;
    let rows = fixture
        .env
        .store
        .get(
            &first.active_table,
            &chunks.iter().map(|c| c.id.clone()).collect::<Vec<_>>(),
        )
        .await
        .expect("读表");
    assert!(
        rows.iter()
            .all(|row| row.embed_input_hash != embed_input_hash("fake:16", &row.header, &row.text)),
        "前提:哈希已经是旧口径"
    );

    // 迁到自己
    let second_report = MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        embedder.clone(),
    )
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect("迁到自己");
    assert!(second_report.warnings.is_empty(), "{second_report:?}");

    let second = current_collection(&fixture.env, &fixture.collection.name).await;
    assert!(
        second.active_table.ends_with("__v3"),
        "{}",
        second.active_table
    );
    assert_eq!(second.active_table, second_report.to_table);
    assert_eq!(second.embedder_id, "fake:16");
    assert_eq!(second_report.retired_table, first.active_table);
    assert_eq!(
        second.retired_tables,
        vec![
            fixture.collection.active_table.clone(),
            first.active_table.clone()
        ],
        "两张旧表都应在退役列表里(旧的在前)"
    );
    assert_eq!(
        second_report.rows as usize,
        chunks.len(),
        "{second_report:?}"
    );
    assert_eq!(
        fixture
            .env
            .store
            .count(&second.active_table, None)
            .await
            .expect("数行") as usize,
        chunks.len()
    );
    let checked =
        assert_hashes_follow_embedder(&fixture.env, &fixture.collection.name, "fake:16").await;
    assert_eq!(checked, chunks.len());

    // 修好之后,同一批没动过的文件再扫一遍不会重嵌入
    embedder.reset_count();
    let report = fixture
        .index_with(embedder.clone())
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("再索引");
    assert!(report.errors.is_empty(), "{:?}", report.errors);
    assert_eq!(report.embedded, 0, "{report:?}");
    assert_eq!(embedder.embedding_count(), 0);
}

/// 迁移「建向量索引」之后,往新表的 `get` 注入失败:模拟切换后读新表出错。
///
/// 用来钉住「切换后写回哈希失败只告警、不让迁移整体失败」。
struct GetFailsAfterIndexStore {
    inner: Arc<dyn VectorStore>,
    /// 注入点之后读哪张表会失败(`ensure_vector_index` 那张,即迁移的目标表)。
    armed_table: std::sync::Mutex<Option<String>>,
}

#[async_trait::async_trait]
impl VectorStore for GetFailsAfterIndexStore {
    async fn ensure_table(&self, table: &str, dim: usize) -> kb_core::Result<()> {
        self.inner.ensure_table(table, dim).await
    }

    async fn upsert(&self, table: &str, rows: Vec<RecordRow>) -> kb_core::Result<()> {
        self.inner.upsert(table, rows).await
    }

    async fn update_meta(&self, table: &str, id: &str, patch: MetaPatch) -> kb_core::Result<()> {
        self.inner.update_meta(table, id, patch).await
    }

    async fn delete_ids(&self, table: &str, ids: &[String]) -> kb_core::Result<()> {
        self.inner.delete_ids(table, ids).await
    }

    async fn get(&self, table: &str, ids: &[String]) -> kb_core::Result<Vec<RecordRow>> {
        let armed = self.armed_table.lock().expect("注入锁").clone();
        if armed.as_deref() == Some(table) {
            return Err(kb_core::KbError::Internal("注入的读新表失败".to_owned()));
        }
        self.inner.get(table, ids).await
    }

    async fn search(&self, table: &str, req: &StoreQuery) -> kb_core::Result<Vec<StoreHit>> {
        self.inner.search(table, req).await
    }

    async fn list(
        &self,
        table: &str,
        query: &kb_core::model::ListQuery,
    ) -> kb_core::Result<Vec<RecordRow>> {
        self.inner.list(table, query).await
    }

    async fn count(&self, table: &str, filter: Option<&str>) -> kb_core::Result<u64> {
        self.inner.count(table, filter).await
    }

    async fn optimize(&self, table: &str) -> kb_core::Result<()> {
        self.inner.optimize(table).await
    }

    async fn ensure_fts_index(&self, table: &str) -> kb_core::Result<()> {
        self.inner.ensure_fts_index(table).await
    }

    async fn ensure_vector_index(&self, table: &str) -> kb_core::Result<()> {
        self.inner.ensure_vector_index(table).await?;
        *self.armed_table.lock().expect("注入锁") = Some(table.to_owned());
        Ok(())
    }

    async fn drop_table(&self, table: &str) -> kb_core::Result<()> {
        self.inner.drop_table(table).await
    }
}

#[tokio::test]
async fn hash_writeback_failure_is_a_warning_not_a_failed_migration() {
    let fixture = fixture().await;
    let store: Arc<dyn VectorStore> = Arc::new(GetFailsAfterIndexStore {
        inner: fixture.env.store.clone(),
        armed_table: std::sync::Mutex::new(None),
    });
    let report = MigrationService::new(
        fixture.env.meta.clone(),
        store,
        Arc::new(FakeEmbedder::new(16)),
    )
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect("写回哈希失败不能让迁移整体失败");

    let after = current_collection(&fixture.env, &fixture.collection.name).await;
    assert_eq!(after.active_table, report.to_table, "迁移已经生效");
    assert_eq!(after.embedder_id, "fake:16");
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("embed_input_hash")),
        "写回失败要进 warnings:{:?}",
        report.warnings
    );
}
