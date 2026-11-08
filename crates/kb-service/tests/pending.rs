//! 文本优先索引的服务层回归。
//!
//! 这里特意走 `index_entry_mode(..., TextOnly)`,而不是手工往 Lance 里塞 pending 行:
//! 真实事故是「普通文本文件的分块尾段忘了把 mode 传下去」,文本阶段悄悄退化成
//! 正文 + 向量一次写完——队列空着、任务报告一切正常,只有 e2e 才看得出来。

use kb_core::Filter;
use kb_core::model::{
    Collection, FileKind, Project, RecordKind, ScanEntry, SearchMode, StoreQuery,
};
use kb_core::ports::repo::{ChunkRepo, ProjectRepo};
use kb_service::index::IndexMode;
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;

struct Fixture {
    env: TestEnv,
    #[allow(dead_code)]
    dir: TempDir,
    project: Project,
    collection: Collection,
    service: IndexService,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("项目目录");
    std::fs::create_dir_all(dir.path().join("docs")).expect("建目录");
    std::fs::write(
        dir.path().join("docs/pending.md"),
        "# 文本优先\n\n正文先落库,向量后补。\n",
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
        .expect("项目行");
    let collections =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("项目 collection");
    let service = IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    );
    Fixture {
        env,
        dir,
        project,
        collection,
        service,
    }
}

fn entry(fixture: &Fixture) -> ScanEntry {
    let path = fixture.dir.path().join("docs/pending.md");
    let metadata = std::fs::metadata(&path).expect("文件元信息");
    ScanEntry {
        path,
        relative: "docs/pending.md".to_owned(),
        size: metadata.len(),
        mtime: 1_700_000_000_000,
        lang: "markdown".to_owned(),
        kind: FileKind::Doc,
    }
}

async fn fts_ids(fixture: &Fixture) -> Vec<String> {
    fixture
        .env
        .store
        .search(
            &fixture.collection.active_table,
            &StoreQuery {
                mode: SearchMode::Fts,
                text: Some("正文".to_owned()),
                vector: None,
                filter: Filter::default(),
                limit: 10,
                offset: 0,
                with_vector: false,
            },
        )
        .await
        .expect("全文检索")
        .into_iter()
        .map(|hit| hit.row.id)
        .collect()
}

#[tokio::test]
async fn text_only_index_writes_chunks_without_vectors_then_embeds_them() {
    let fixture = fixture().await;
    let stats = fixture
        .service
        .index_entry_mode(
            &fixture.project,
            &fixture.collection,
            &entry(&fixture),
            IndexMode::TextOnly,
        )
        .await
        .expect("文本阶段索引");
    assert!(stats.pending > 0, "文本阶段应把块放进补队列");
    assert_eq!(stats.embedded, 0, "文本阶段不能调用向量模型");
    assert_eq!(
        fixture.env.fake.embedding_count(),
        0,
        "文本阶段一次嵌入都不该发生"
    );
    assert_eq!(
        ChunkRepo::pending_count(fixture.env.meta.as_ref(), &fixture.collection.name)
            .await
            .expect("队列数"),
        stats.pending as u64
    );

    // 全文索引能立刻搜到,向量/混合检索则必须过滤 pending 行。
    fixture
        .service
        .ensure_indexes(&fixture.collection)
        .await
        .expect("建索引");
    let ids = fts_ids(&fixture).await;
    assert!(!ids.is_empty(), "文本阶段写完就应该能被全文检索到");
    let ready = fixture
        .env
        .store
        .search(
            &fixture.collection.active_table,
            &StoreQuery {
                mode: SearchMode::Vector,
                text: Some("正文".to_owned()),
                vector: Some(
                    fixture
                        .env
                        .embedder
                        .embed_query("正文".to_owned())
                        .await
                        .expect("查询向量"),
                ),
                filter: Filter::default(),
                limit: 10,
                offset: 0,
                with_vector: false,
            },
        )
        .await
        .expect("向量检索");
    assert!(ready.is_empty(), "向量检索不能返回还没补向量的块");

    // 补向量之后队列排空、同一批块可被向量检索命中。
    let embedded = fixture
        .service
        .embed_pending_batch(&fixture.collection, 10)
        .await
        .expect("补向量");
    assert_eq!(embedded, stats.pending);
    assert_eq!(
        ChunkRepo::pending_count(fixture.env.meta.as_ref(), &fixture.collection.name)
            .await
            .expect("队列数"),
        0
    );
    assert_eq!(fixture.env.fake.embedding_count(), stats.pending + 1);
    let ready = fixture
        .env
        .store
        .search(
            &fixture.collection.active_table,
            &StoreQuery {
                mode: SearchMode::Vector,
                text: Some("正文".to_owned()),
                vector: Some(
                    fixture
                        .env
                        .embedder
                        .embed_query("正文".to_owned())
                        .await
                        .expect("查询向量"),
                ),
                filter: Filter::default(),
                limit: 10,
                offset: 0,
                with_vector: false,
            },
        )
        .await
        .expect("向量检索");
    assert!(!ready.is_empty(), "补完向量后应按向量命中");
    assert_eq!(ready[0].row.kind, RecordKind::Doc);
}

#[tokio::test]
async fn text_only_does_not_turn_a_ready_row_back_into_pending() {
    // 补向量阶段是「先 upsert 向量、再删队列」:崩溃会在队列里留下已经 ready 的 id。
    // 这时再跑一次 `--text-only` 不能照着队列把这些行重新写成 pending,否则会把
    // 已经补好的向量抹掉,检索当场退化成全文。
    let fixture = fixture().await;
    fixture
        .service
        .index_entry_mode(
            &fixture.project,
            &fixture.collection,
            &entry(&fixture),
            IndexMode::TextOnly,
        )
        .await
        .expect("文本阶段索引");
    let queued = ChunkRepo::pending_after(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        None,
        100,
    )
    .await
    .expect("读队列");
    assert!(!queued.is_empty());
    fixture
        .service
        .embed_pending_batch(&fixture.collection, 100)
        .await
        .expect("补向量");
    assert_eq!(
        ChunkRepo::pending_count(fixture.env.meta.as_ref(), &fixture.collection.name)
            .await
            .expect("队列数"),
        0
    );
    let stale: Vec<(String, String)> = queued
        .iter()
        .map(|item| (item.chunk_id.clone(), item.path.clone()))
        .collect();
    ChunkRepo::enqueue_pending(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        &stale,
        1_700_000_000_000,
    )
    .await
    .expect("模拟崩溃后残留队列");

    let stats = fixture
        .service
        .index_entry_mode(
            &fixture.project,
            &fixture.collection,
            &entry(&fixture),
            IndexMode::TextOnly,
        )
        .await
        .expect("再跑文本阶段");
    assert_eq!(stats.pending, 0, "ready 行不该被重新标成 pending");
    assert_eq!(
        ChunkRepo::pending_count(fixture.env.meta.as_ref(), &fixture.collection.name)
            .await
            .expect("队列数"),
        0,
        "残留队列应被整体重置清掉"
    );
    let vector = fixture
        .env
        .embedder
        .embed_query("正文".to_owned())
        .await
        .expect("查询向量");
    let hits = fixture
        .env
        .store
        .search(
            &fixture.collection.active_table,
            &StoreQuery {
                mode: SearchMode::Vector,
                text: Some("正文".to_owned()),
                vector: Some(vector),
                filter: Filter::default(),
                limit: 10,
                offset: 0,
                with_vector: false,
            },
        )
        .await
        .expect("向量检索");
    assert!(!hits.is_empty(), "已经补好的向量必须还在");
}

#[tokio::test]
async fn text_only_restores_a_pending_row_that_disappeared_from_lance() {
    // 队列是「待补向量」的真源,但 Lance 里的 pending 行可能被孤儿对账 / 手工删除。
    // 过滤残留队列时若把「行不存在」也当成 ready,这个块会被判成 Skip,随后队列被清空,
    // 于是它永远没有向量、也不会再入队 —— 必须按「行不存在 => 重新写 pending」处理。
    let fixture = fixture().await;
    fixture
        .service
        .index_entry_mode(
            &fixture.project,
            &fixture.collection,
            &entry(&fixture),
            IndexMode::TextOnly,
        )
        .await
        .expect("文本阶段索引");
    let queued = ChunkRepo::pending_after(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        None,
        100,
    )
    .await
    .expect("读队列");
    let missing = queued[0].chunk_id.clone();
    fixture
        .env
        .store
        .delete_ids(
            &fixture.collection.active_table,
            std::slice::from_ref(&missing),
        )
        .await
        .expect("模拟 Lance 行丢失");
    assert!(
        fixture
            .env
            .store
            .get(
                &fixture.collection.active_table,
                std::slice::from_ref(&missing)
            )
            .await
            .expect("读行")
            .is_empty()
    );

    let stats = fixture
        .service
        .index_entry_mode(
            &fixture.project,
            &fixture.collection,
            &entry(&fixture),
            IndexMode::TextOnly,
        )
        .await
        .expect("再跑文本阶段");
    assert!(stats.pending > 0, "丢失的 pending 行必须重新入队");
    assert_eq!(
        ChunkRepo::pending_count(fixture.env.meta.as_ref(), &fixture.collection.name)
            .await
            .expect("队列数"),
        stats.pending as u64
    );
    let restored = fixture
        .env
        .store
        .get(
            &fixture.collection.active_table,
            std::slice::from_ref(&missing),
        )
        .await
        .expect("读行");
    assert_eq!(restored.len(), 1, "丢失的 pending 行必须补回 Lance");
    assert_eq!(restored[0].id, missing);
}

#[tokio::test]
async fn embed_pending_refuses_to_drop_a_chunk_whose_lance_row_is_missing() {
    // 队列里的块如果还在 chunks 表、LanceDB 行却没了,直接出队会让它永远没有向量。
    // 补向量必须报错(提示重跑文本阶段),而不是静默把队列项删掉。
    let fixture = fixture().await;
    fixture
        .service
        .index_entry_mode(
            &fixture.project,
            &fixture.collection,
            &entry(&fixture),
            IndexMode::TextOnly,
        )
        .await
        .expect("文本阶段索引");
    let queued = ChunkRepo::pending_after(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        None,
        100,
    )
    .await
    .expect("读队列");
    let missing = queued[0].chunk_id.clone();
    fixture
        .env
        .store
        .delete_ids(&fixture.collection.active_table, &[missing])
        .await
        .expect("模拟 Lance 行丢失");

    let err = fixture
        .service
        .embed_pending_batch(&fixture.collection, 100)
        .await
        .expect_err("行丢失时必须报错");
    assert!(
        err.to_string().contains("向量行在 LanceDB 里不存在"),
        "错误要说清楚是向量行丢了: {err}"
    );
    assert_eq!(
        ChunkRepo::pending_count(fixture.env.meta.as_ref(), &fixture.collection.name)
            .await
            .expect("队列数"),
        1,
        "坏行必须留在队列里,不能被静默出队"
    );
}

#[tokio::test]
async fn embed_pending_drops_a_stale_queue_for_rows_that_are_already_ready() {
    // 补向量是「upsert 向量 → 删队列」:崩溃会留下已经 ready 的 id。补向量重跑时
    // 这些 id 不能当成「Lance 行丢了」报错,而应该直接出队。
    let fixture = fixture().await;
    fixture
        .service
        .index_entry_mode(
            &fixture.project,
            &fixture.collection,
            &entry(&fixture),
            IndexMode::TextOnly,
        )
        .await
        .expect("文本阶段索引");
    let queued = ChunkRepo::pending_after(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        None,
        100,
    )
    .await
    .expect("读队列");
    fixture
        .service
        .embed_pending_batch(&fixture.collection, 100)
        .await
        .expect("补向量");
    let before = fixture.env.fake.embedding_count();
    ChunkRepo::enqueue_pending(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        &queued
            .iter()
            .map(|item| (item.chunk_id.clone(), item.path.clone()))
            .collect::<Vec<_>>(),
        1_700_000_000_000,
    )
    .await
    .expect("模拟崩溃后残留队列");

    let embedded = fixture
        .service
        .embed_pending_batch(&fixture.collection, 100)
        .await
        .expect("补向量重跑");
    assert_eq!(embedded, 0, "已经是 ready 的行不需要再嵌入");
    assert_eq!(
        fixture.env.fake.embedding_count(),
        before,
        "不能重复调用嵌入器"
    );
    assert_eq!(
        ChunkRepo::pending_count(fixture.env.meta.as_ref(), &fixture.collection.name)
            .await
            .expect("队列数"),
        0,
        "残留队列应被清掉"
    );
}
