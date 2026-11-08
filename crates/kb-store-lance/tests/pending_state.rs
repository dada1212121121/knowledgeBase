//! 文本优先索引的存储层契约:正文先落库、向量后补。
//!
//! 这里只测存储层,不涉及队列与调度:
//! - 混合 / 向量检索不能返回还没补向量的行(否则会拿空向量算距离);
//! - 纯全文检索必须能搜到 pending 行(否则文本阶段写完等于没写);
//! - `search_pending` 只返回 pending 行,不能把 ready 行混进补充结果;
//! - `get_pending` 必须按队列 id 精确取,不能被表里其他 pending 行挤掉。

use kb_core::Filter;
use kb_core::model::{ItemStatus, MetaPatch, RecordKind, RecordRow, SearchMode, StoreQuery};
use kb_core::ports::VectorStore;
use kb_store_lance::LanceStore;

const DIM: usize = 8;
const TABLE: &str = "proj_pending__fake8__v1";

fn vector(seed: f32) -> Vec<f32> {
    (0..DIM).map(|index| seed + index as f32 * 0.01).collect()
}

fn row(id: &str, text: &str, source: &str, ready: bool) -> RecordRow {
    RecordRow {
        id: id.to_owned(),
        collection: "proj_pending".to_owned(),
        kind: RecordKind::Doc,
        lang: Some("zh".to_owned()),
        source: source.to_owned(),
        start_line: Some(1),
        end_line: Some(3),
        symbol: None,
        title: Some(text.to_owned()),
        text: text.to_owned(),
        header: format!("demo › {source}"),
        lex: text
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>()
            .join(" "),
        tags: Vec::new(),
        status: ItemStatus::Active,
        content_hash: format!("c-{id}"),
        meta_hash: format!("m-{id}"),
        embed_input_hash: format!("e-{id}"),
        updated_at: 1_700_000_000_000,
        anchor: None,
        vector: ready.then(|| vector(0.1)),
    }
}

async fn setup() -> (tempfile::TempDir, LanceStore) {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = LanceStore::connect(dir.path().join("lance").to_string_lossy().to_string())
        .await
        .expect("连接 LanceDB");
    store.ensure_table(TABLE, DIM).await.expect("建表");
    store.ensure_fts_index(TABLE).await.expect("全文索引");
    store
        .upsert(
            TABLE,
            vec![
                row("a1", "双哈希增量索引减少重复嵌入", "src/index.rs", true),
                row(
                    "b1",
                    "文本优先索引先写正文再补向量",
                    "docs/text-first.md",
                    false,
                ),
                row("c1", "补向量队列可以断点续跑", "docs/resume.md", false),
            ],
        )
        .await
        .expect("写入");
    (dir, store)
}

fn query(mode: SearchMode, text: &str, limit: usize) -> StoreQuery {
    StoreQuery {
        mode,
        text: Some(text.to_owned()),
        vector: (mode != SearchMode::Fts).then(|| vector(0.1)),
        filter: Filter::default(),
        limit,
        offset: 0,
        with_vector: false,
    }
}

#[tokio::test]
async fn hybrid_and_vector_search_skip_pending_rows() {
    let (_dir, store) = setup().await;
    // 查询词同时命中 ready 与 pending:混合检索只应返回 ready
    let hits = store
        .search(TABLE, &query(SearchMode::Hybrid, "索引", 10))
        .await
        .expect("混合检索");
    assert!(
        hits.iter().all(|hit| hit.row.id == "a1"),
        "混合检索返回了 pending 行: {:?}",
        hits.iter().map(|hit| &hit.row.id).collect::<Vec<_>>()
    );

    let hits = store
        .search(TABLE, &query(SearchMode::Vector, "索引", 10))
        .await
        .expect("向量检索");
    assert!(hits.iter().all(|hit| hit.row.id == "a1"));
}

#[tokio::test]
async fn plain_fts_still_finds_pending_rows() {
    let (_dir, store) = setup().await;
    let hits = store
        .search(TABLE, &query(SearchMode::Fts, "文本优先", 10))
        .await
        .expect("全文检索");
    assert_eq!(
        hits.iter()
            .map(|hit| hit.row.id.as_str())
            .collect::<Vec<_>>(),
        vec!["b1"],
        "文本阶段写完的行必须能被全文检索到"
    );
}

#[tokio::test]
async fn search_pending_returns_only_pending_rows() {
    let (_dir, store) = setup().await;
    // 同一个词也命中 ready 行:补充列表不能把它带进来
    let hits = store
        .search_pending(TABLE, &query(SearchMode::Hybrid, "索引", 10))
        .await
        .expect("pending 检索");
    assert!(
        hits.iter()
            .all(|hit| matches!(hit.row.id.as_str(), "b1" | "c1")),
        "pending 检索混进了 ready 行"
    );
    assert!(hits.iter().any(|hit| hit.row.id == "b1"));
}

/// 只改元数据的部分列 upsert 不能把 `embed_state` 从 pending 打回 NULL(ready),
/// 也不能把向量列清空后又被向量检索当成合法行返回。
#[tokio::test]
async fn metadata_patch_keeps_pending_state_and_null_vector() {
    let (_dir, store) = setup().await;
    store
        .update_meta_batch(
            TABLE,
            &[(
                "b1".to_owned(),
                MetaPatch {
                    title: Some("补向量期间改过的标题".to_owned()),
                    ..MetaPatch::default()
                },
            )],
        )
        .await
        .expect("批量改元数据");

    let rows = store
        .get_pending(TABLE, &["b1".to_owned()])
        .await
        .expect("按 id 取 pending");
    assert_eq!(rows.len(), 1, "改元数据后 b1 应仍是 pending");
    assert!(rows[0].vector.is_none(), "pending 行不应凭空多出向量");
    assert_eq!(
        rows[0].title.as_deref(),
        Some("补向量期间改过的标题"),
        "补丁应写入,但不能影响状态列"
    );

    let hits = store
        .search(TABLE, &query(SearchMode::Hybrid, "文本优先", 10))
        .await
        .expect("混合检索");
    assert!(
        hits.iter().all(|hit| hit.row.id != "b1"),
        "改过元数据的 pending 行仍不能进入向量检索"
    );
}

#[tokio::test]
async fn get_pending_takes_exact_ids_not_the_first_page() {
    let (_dir, store) = setup().await;
    // 队列只给了排在后面的 id;按 limit 取一页再过滤会漏掉它
    let rows = store
        .get_pending(TABLE, &["c1".to_owned()])
        .await
        .expect("按 id 取 pending");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "c1");

    // ready 行不能被当成 pending 返回
    let rows = store
        .get_pending(TABLE, &["a1".to_owned()])
        .await
        .expect("按 id 取 pending");
    assert!(rows.is_empty());
}

/// 向量索引建在含 pending 行的表上时不能失败;建完后 pending 行仍被 ready 过滤挡住。
#[tokio::test]
async fn vector_index_handles_mixed_ready_and_pending_rows() {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = LanceStore::connect(dir.path().join("lance").to_string_lossy().to_string())
        .await
        .expect("连接 LanceDB");
    store.ensure_table(TABLE, DIM).await.expect("建表");
    let rows: Vec<RecordRow> = (1..=40)
        .map(|index| {
            let id = format!("{index:x}");
            row(&id, "混合索引正文", "docs/index.md", index % 2 == 0)
        })
        .collect();
    store.upsert(TABLE, rows).await.expect("写入");
    store
        .ensure_vector_index(TABLE)
        .await
        .expect("含 pending 行时建向量索引不应失败");
    let hits = store
        .search(TABLE, &query(SearchMode::Vector, "混合索引正文", 50))
        .await
        .expect("向量检索");
    assert!(!hits.is_empty(), "ready 行应能走索引检索");
    assert!(hits.iter().all(|hit| {
        let value = u32::from_str_radix(&hit.row.id, 16).expect("十六进制 id");
        value % 2 == 0
    }));
}
