//! kb-store-lance 的集成测试:临时目录 + 8 维假向量(设计规范验收)。

use std::sync::Arc;

use arrow_array::RecordBatchIterator;
use arrow_schema::{Field, Schema};
use kb_core::model::{ItemStatus, MetaPatch, RecordKind, RecordRow, SearchMode, StoreQuery};
use kb_core::ports::VectorStore;
use kb_core::{Filter, KbError};
use kb_store_lance::{LanceStore, record_schema, rows_to_batch};

const DIM: usize = 8;
const TABLE: &str = "proj_demo__fake8__v1";

fn vector(seed: f32) -> Vec<f32> {
    (0..DIM).map(|index| seed + index as f32 * 0.01).collect()
}

fn row(
    id: &str,
    text: &str,
    lex: &str,
    source: &str,
    status: ItemStatus,
    tags: &[&str],
) -> RecordRow {
    RecordRow {
        id: id.to_owned(),
        collection: "proj_demo".to_owned(),
        kind: RecordKind::Code,
        lang: Some("rust".to_owned()),
        source: source.to_owned(),
        start_line: Some(1),
        end_line: Some(10),
        symbol: Some("fn demo".to_owned()),
        title: None,
        text: text.to_owned(),
        header: format!("demo › {source} › fn demo"),
        lex: lex.to_owned(),
        tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
        status,
        content_hash: format!("c-{id}"),
        meta_hash: format!("m-{id}"),
        embed_input_hash: format!("e-{id}"),
        updated_at: 1_700_000_000_000,
        anchor: None,
        vector: Some(vector(0.0)),
    }
}

fn query(mode: SearchMode, text: Option<&str>, filter: Filter) -> StoreQuery {
    StoreQuery {
        mode,
        text: text.map(str::to_owned),
        vector: Some(vector(0.0)),
        filter,
        limit: 10,
        offset: 0,
        with_vector: false,
    }
}

async fn setup() -> (tempfile::TempDir, LanceStore) {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = LanceStore::connect(dir.path().join("lance").to_string_lossy().to_string())
        .await
        .expect("连接 LanceDB");
    store.ensure_table(TABLE, DIM).await.expect("建表");
    (dir, store)
}

async fn seed_chinese(store: &LanceStore) {
    store
        .upsert(
            TABLE,
            vec![
                row(
                    "d1",
                    "双哈希增量索引减少重复嵌入",
                    "双哈希 增量索引 减少 重复 嵌入",
                    "src/index.rs",
                    ItemStatus::Active,
                    &["索引"],
                ),
                row(
                    "d2",
                    "守护进程通过本地套接字通信",
                    "守护进程 本地 套接字 通信",
                    "src/daemon.rs",
                    ItemStatus::Active,
                    &["守护"],
                ),
                row(
                    "d3",
                    "hybrid search combines vector and keyword retrieval",
                    "hybrid search combines vector keyword retrieval",
                    "src/search.rs",
                    ItemStatus::Active,
                    &[],
                ),
            ],
        )
        .await
        .expect("写入");
    store.ensure_fts_index(TABLE).await.expect("建全文索引");
}

#[tokio::test]
async fn anchor_roundtrips_through_the_store() {
    use kb_core::model::Anchor;
    let (_dir, store) = setup().await;
    let mut with_anchor = row(
        "000000000000000000000000000000a1",
        "第一页正文",
        "第一页 正文",
        "docs/报告.pdf",
        ItemStatus::Active,
        &[],
    );
    with_anchor.anchor = Some(Anchor::Page { page: 3 });
    let plain = row(
        "000000000000000000000000000000a2",
        "没有位置的块",
        "没有位置 块",
        "src/lib.rs",
        ItemStatus::Active,
        &[],
    );
    store
        .upsert(TABLE, vec![with_anchor, plain])
        .await
        .expect("写入");

    let rows = store
        .get(
            TABLE,
            &[
                "000000000000000000000000000000a1".to_owned(),
                "000000000000000000000000000000a2".to_owned(),
            ],
        )
        .await
        .expect("读回");
    let first = rows
        .iter()
        .find(|row| row.id == "000000000000000000000000000000a1")
        .expect("带 anchor 的行");
    assert_eq!(first.anchor, Some(Anchor::Page { page: 3 }));
    let second = rows
        .iter()
        .find(|row| row.id == "000000000000000000000000000000a2")
        .expect("不带 anchor 的行");
    assert_eq!(second.anchor, None, "没有位置的块不应凭空多出 anchor");

    // 再 ensure_table 一次(旧表补列的逻辑)不应报错
    store.ensure_table(TABLE, DIM).await.expect("重复建表");
}

/// 升级前的老表没有 `embed_state` 列:补列后老行是 NULL,必须仍按 ready 参与检索。
///
/// 这是上线时最危险的一步——如果补列逻辑或 READY_FILTER 写错,
/// 生产里所有老内容会在第一次检索时集体消失,而不是报错。
#[tokio::test]
async fn old_table_without_new_columns_is_upgraded_and_stays_searchable() {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = LanceStore::connect(dir.path().join("lance").to_string_lossy().to_string())
        .await
        .expect("连接 LanceDB");

    // 按当前 schema 造一行,再丢掉 anchor / embed_state 两列,模拟最老的物理表:
    // 补列时 Lance 会把新列追加到 vector 之后,与新表的列顺序完全不同。
    let full = record_schema(DIM).expect("当前 schema");
    let old_fields: Vec<Field> = full
        .fields()
        .iter()
        .filter(|field| !matches!(field.name().as_str(), "anchor" | "embed_state"))
        .map(|field| (**field).clone())
        .collect();
    let old_schema = Arc::new(Schema::new(old_fields));
    store
        .connection()
        .create_empty_table(TABLE.to_owned(), old_schema.clone())
        .execute()
        .await
        .expect("建旧表");

    let old_row = row(
        "e1",
        "升级前的旧表正文",
        "升级前 旧表 正文",
        "docs/old.md",
        ItemStatus::Active,
        &[],
    );
    let batch = rows_to_batch(std::slice::from_ref(&old_row), full).expect("当前批次");
    let keep: Vec<usize> = (0..batch.num_columns())
        .filter(|index| {
            !matches!(
                batch.schema().field(*index).name().as_str(),
                "anchor" | "embed_state"
            )
        })
        .collect();
    let batch = batch.project(&keep).expect("去掉 anchor / embed_state 列");
    let handle = store
        .connection()
        .open_table(TABLE.to_owned())
        .execute()
        .await
        .expect("打开旧表");
    let reader: Box<dyn arrow_array::RecordBatchReader + Send> =
        Box::new(RecordBatchIterator::new(vec![Ok(batch)], old_schema));
    let mut merge = handle.merge_insert(&["id"]);
    merge
        .when_matched_update_all(None)
        .when_not_matched_insert_all();
    merge.execute(reader).await.expect("写旧行");

    // 生产表多半已经建过向量索引:先建索引,确认升级不会让索引或后续写入坏掉。
    store
        .ensure_vector_index(TABLE)
        .await
        .expect("老表建向量索引");
    store.ensure_fts_index(TABLE).await.expect("全文索引");
    // 升级前先检索一次:旧表没有 embed_state,不能把 READY_FILTER 拼进 SQL,
    // 否则嵌入式 `kb search` 在第一次写入(补列)之前就会报“列不存在”。
    let hits = store
        .search(
            TABLE,
            &query(SearchMode::Hybrid, Some("旧表正文"), Filter::default()),
        )
        .await
        .expect("旧表升级前检索");
    assert!(
        hits.iter().any(|hit| hit.row.id == "e1"),
        "升级前的老行必须能搜到"
    );
    // 读条目同样要按实际 schema 取列:老表没有 anchor / embed_state。
    let rows = store
        .get(TABLE, &["e1".to_owned()])
        .await
        .expect("旧表读条目");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "e1");
    assert!(rows[0].anchor.is_none());

    // 升级后继续写入新行：不显式补列，由 `upsert` 按需补出 anchor / embed_state。
    // 补列后的物理列顺序与新建表不同，`rows_to_batch` 必须按列名对齐，
    // 否则下一次增量索引会在升级过的生产表上直接失败。
    let new_row = row(
        "f1",
        "升级后写入的新正文",
        "升级后 写入 新正文",
        "docs/new.md",
        ItemStatus::Active,
        &[],
    );
    store
        .upsert(TABLE, vec![new_row])
        .await
        .expect("升级后写入新行");
    // 重新打开表拿 schema:旧 handle 可能缓存了补列之前的元数据。
    let handle = store
        .connection()
        .open_table(TABLE.to_owned())
        .execute()
        .await
        .expect("重新打开旧表");
    let schema = handle.schema().await.expect("读 schema");
    assert!(
        schema.field_with_name("embed_state").is_ok(),
        "应补出 embed_state"
    );

    let hits = store
        .search(
            TABLE,
            &query(SearchMode::Hybrid, Some("旧表正文"), Filter::default()),
        )
        .await
        .expect("混合检索");
    assert!(
        hits.iter().any(|hit| hit.row.id == "e1"),
        "升级前的老行不能因为 embed_state 为 NULL 被过滤掉"
    );
    let hits = store
        .search(
            TABLE,
            &query(
                SearchMode::Hybrid,
                Some("升级后写入的新正文"),
                Filter::default(),
            ),
        )
        .await
        .expect("检索升级后写入的新行");
    assert!(
        hits.iter().any(|hit| hit.row.id == "f1"),
        "升级后写入的新行必须能被检索到"
    );
}

#[tokio::test]
async fn jieba_full_text_search_hits_chinese_words() {
    let (_dir, store) = setup().await;
    seed_chinese(&store).await;

    let hits = store
        .search(
            TABLE,
            &query(SearchMode::Fts, Some("增量索引"), Filter::default()),
        )
        .await
        .expect("全文检索");
    assert_eq!(hits.len(), 1, "应只命中讲增量索引的块");
    assert_eq!(hits[0].row.id, "d1");
    assert_eq!(hits[0].row.text, "双哈希增量索引减少重复嵌入");

    let hits = store
        .search(
            TABLE,
            &query(SearchMode::Fts, Some("套接字"), Filter::default()),
        )
        .await
        .expect("全文检索");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].row.id, "d2");
}

#[tokio::test]
async fn lex_column_matches_split_identifiers() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![row(
                "d4",
                "fn embedQuery() {}",
                "fn embed query",
                "src/embed.rs",
                ItemStatus::Active,
                &[],
            )],
        )
        .await
        .expect("写入");
    store.ensure_fts_index(TABLE).await.expect("建索引");

    // 驼峰标识符被拆成 "embed query",所以 "embed" 能命中
    let hits = store
        .search(
            TABLE,
            &query(SearchMode::Fts, Some("embed"), Filter::default()),
        )
        .await
        .expect("全文检索");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].row.id, "d4");
}

#[tokio::test]
async fn hybrid_search_returns_relevance_score() {
    let (_dir, store) = setup().await;
    seed_chinese(&store).await;

    let hits = store
        .search(
            TABLE,
            &query(SearchMode::Hybrid, Some("增量索引"), Filter::default()),
        )
        .await
        .expect("混合检索");
    assert!(!hits.is_empty(), "混合检索应有结果");
    assert_eq!(hits[0].row.id, "d1");
    assert!(hits[0].score > 0.0, "_relevance_score 应大于 0");
    // rank 从 1 开始且递增
    for (index, hit) in hits.iter().enumerate() {
        assert_eq!(hit.rank, index + 1);
    }
}

#[tokio::test]
async fn hybrid_search_with_a_filter_that_matches_nothing_is_empty() {
    let (_dir, store) = setup().await;
    seed_chinese(&store).await;

    // 过滤把所有行都排除掉:混合查询会返回一个 0 行、没有列的 batch
    let filter = Filter {
        lang: Some("cobol".to_owned()),
        ..Filter::default()
    };
    let hits = store
        .search(
            TABLE,
            &query(SearchMode::Hybrid, Some("增量索引"), filter.clone()),
        )
        .await
        .expect("混合检索不应报错");
    assert!(hits.is_empty(), "过滤后没有命中:{hits:?}");

    let hits = store
        .search(TABLE, &query(SearchMode::Fts, Some("增量索引"), filter))
        .await
        .expect("全文检索不应报错");
    assert!(hits.is_empty());
}

#[tokio::test]
async fn upsert_update_meta_and_delete_ids() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![
                row("a", "第一块", "第一块", "src/a.rs", ItemStatus::Active, &[]),
                row("b", "第二块", "第二块", "src/b.rs", ItemStatus::Active, &[]),
            ],
        )
        .await
        .expect("写入");
    assert_eq!(store.count(TABLE, None).await.expect("计数"), 2);

    // upsert 同一个 id:行数不变,内容更新
    store
        .upsert(
            TABLE,
            vec![row(
                "a",
                "第一块(改)",
                "第一块 改",
                "src/a.rs",
                ItemStatus::Active,
                &[],
            )],
        )
        .await
        .expect("覆盖");
    assert_eq!(store.count(TABLE, None).await.expect("计数"), 2);
    let loaded = store.get(TABLE, &["a".to_owned()]).await.expect("按 id 取");
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].text, "第一块(改)");

    // update_meta:只改元数据
    store
        .update_meta(
            TABLE,
            "a",
            MetaPatch {
                start_line: Some(99),
                end_line: Some(120),
                title: Some("新标题".to_owned()),
                tags: Some(vec!["决策".to_owned()]),
                status: Some(ItemStatus::Deprecated),
                meta_hash: Some("m-new".to_owned()),
                updated_at: Some(1_700_000_000_999),
                ..MetaPatch::default()
            },
        )
        .await
        .expect("更新元数据");
    let updated = store.get(TABLE, &["a".to_owned()]).await.expect("按 id 取");
    let updated = &updated[0];
    assert_eq!(updated.start_line, Some(99));
    assert_eq!(updated.end_line, Some(120));
    assert_eq!(updated.title.as_deref(), Some("新标题"));
    assert_eq!(updated.tags, ["决策"]);
    assert_eq!(updated.status, ItemStatus::Deprecated);
    assert_eq!(updated.meta_hash, "m-new");
    assert_eq!(updated.updated_at, 1_700_000_000_999);
    // 正文没有被动过
    assert_eq!(updated.text, "第一块(改)");

    // delete_ids
    store
        .delete_ids(TABLE, &["a".to_owned()])
        .await
        .expect("删除");
    assert_eq!(store.count(TABLE, None).await.expect("计数"), 1);
    assert!(
        store
            .get(TABLE, &["a".to_owned()])
            .await
            .expect("按 id 取")
            .is_empty()
    );
}

#[tokio::test]
async fn status_filter_and_quoted_path_prefix() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![
                row(
                    "q1",
                    "含单引号路径的有效块",
                    "含单引号路径的有效块",
                    "it's/a.rs",
                    ItemStatus::Active,
                    &[],
                ),
                row(
                    "q2",
                    "含单引号路径的废弃块",
                    "含单引号路径的废弃块",
                    "it's/b.rs",
                    ItemStatus::Deprecated,
                    &[],
                ),
            ],
        )
        .await
        .expect("写入");
    store.ensure_fts_index(TABLE).await.expect("建索引");

    // 默认状态只取 active
    let hits = store
        .search(
            TABLE,
            &query(SearchMode::Fts, Some("单引号"), Filter::default()),
        )
        .await
        .expect("全文检索");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].row.id, "q1");

    // 显式包含全部三种状态 = 不限
    let all = Filter {
        statuses: ItemStatus::ALL.to_vec(),
        ..Filter::default()
    };
    let hits = store
        .search(TABLE, &query(SearchMode::Fts, Some("单引号"), all))
        .await
        .expect("全文检索");
    assert_eq!(hits.len(), 2);

    // 含单引号的路径前缀过滤不能报错
    let filter = Filter {
        statuses: ItemStatus::ALL.to_vec(),
        path_prefix: Some("it's/a".to_owned()),
        ..Filter::default()
    };
    let hits = store
        .search(TABLE, &query(SearchMode::Fts, Some("单引号"), filter))
        .await
        .expect("带单引号的路径过滤");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].row.source, "it's/a.rs");
}

#[tokio::test]
async fn new_rows_are_searchable_before_optimize_and_indexed_after() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![row(
                "n1",
                "初始块讲配置文件",
                "初始块 配置文件",
                "src/a.rs",
                ItemStatus::Active,
                &[],
            )],
        )
        .await
        .expect("写入");
    store.ensure_fts_index(TABLE).await.expect("建索引");

    // 建索引后再追加一行:未 optimize 时也应能被检索到
    store
        .upsert(
            TABLE,
            vec![row(
                "n2",
                "新增块讲影子表迁移",
                "新增块 影子表 迁移",
                "src/b.rs",
                ItemStatus::Active,
                &[],
            )],
        )
        .await
        .expect("追加");
    let hits = store
        .search(
            TABLE,
            &query(SearchMode::Fts, Some("影子表"), Filter::default()),
        )
        .await
        .expect("全文检索");
    assert_eq!(hits.len(), 1, "未 optimize 时新行也应可检索");
    assert_eq!(hits[0].row.id, "n2");

    let unindexed = unindexed_rows(&store).await;
    assert!(unindexed > 0, "optimize 之前应有未索引行,实际 {unindexed}");

    store.optimize(TABLE).await.expect("optimize");
    assert_eq!(unindexed_rows(&store).await, 0, "optimize 后未索引行应为 0");
}

async fn unindexed_rows(store: &LanceStore) -> u64 {
    let table = store
        .connection()
        .open_table(TABLE.to_owned())
        .execute()
        .await
        .expect("打开表");
    let indices = table.list_indices().await.expect("列出索引");
    let mut total = 0u64;
    for index in indices {
        if let Some(stats) = table.index_stats(&index.name).await.expect("索引统计") {
            total += stats.num_unindexed_rows as u64;
        }
    }
    total
}

#[tokio::test]
async fn invalid_ids_are_rejected_before_touching_sql() {
    let (_dir, store) = setup().await;
    let bad = vec!["x'; DROP TABLE x; --".to_owned()];
    assert!(matches!(
        store.get(TABLE, &bad).await,
        Err(KbError::InvalidInput(_))
    ));
    assert!(matches!(
        store.delete_ids(TABLE, &bad).await,
        Err(KbError::InvalidInput(_))
    ));
    assert!(matches!(
        store
            .update_meta(TABLE, "not-an-id", MetaPatch::default())
            .await,
        Err(KbError::InvalidInput(_))
    ));
}

#[tokio::test]
async fn ensure_table_is_idempotent_and_checks_dimension() {
    let (_dir, store) = setup().await;
    // 同一个维度再调一次:不报错
    store.ensure_table(TABLE, DIM).await.expect("重复建表");
    // 不同维度:明确报错
    assert!(matches!(
        store.ensure_table(TABLE, 16).await,
        Err(KbError::InvalidInput(_))
    ));
    assert_eq!(
        store.table_names().await.expect("列出表"),
        vec![TABLE.to_owned()]
    );
}

#[tokio::test]
async fn drop_table_removes_it() {
    let (_dir, store) = setup().await;
    assert!(
        store
            .table_names()
            .await
            .expect("列出表")
            .contains(&TABLE.to_owned())
    );
    store.drop_table(TABLE).await.expect("删表");
    assert!(store.table_names().await.expect("列出表").is_empty());
    assert!(matches!(
        store.count(TABLE, None).await,
        Err(KbError::NotFound(_))
    ));
}

#[tokio::test]
async fn list_applies_the_filter_and_paginates() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![
                row(
                    "l1",
                    "第一块",
                    "第一块",
                    "src/a.rs",
                    ItemStatus::Active,
                    &[],
                ),
                row(
                    "l2",
                    "第二块",
                    "第二块",
                    "src/b.rs",
                    ItemStatus::Active,
                    &[],
                ),
                row(
                    "l3",
                    "已废弃",
                    "已废弃",
                    "src/c.rs",
                    ItemStatus::Deprecated,
                    &[],
                ),
            ],
        )
        .await
        .expect("写入");

    // 过滤:只取 active
    let filter = Filter {
        statuses: vec![ItemStatus::Active],
        ..Filter::default()
    }
    .to_sql()
    .expect("过滤表达式");
    let query = kb_core::model::ListQuery::new(10, 0).with_filter(filter.clone());
    let rows = store.list(TABLE, &query).await.expect("列表");
    assert_eq!(rows.len(), 2, "deprecated 行不应出现:{rows:?}");

    // 分页:每页 1 条
    let first = store
        .list(
            TABLE,
            &kb_core::model::ListQuery::new(1, 0)
                .with_filter(filter.clone())
                .with_order(Some("source"), true)
                .expect("排序列"),
        )
        .await
        .expect("第一页");
    let second = store
        .list(
            TABLE,
            &kb_core::model::ListQuery::new(1, 1)
                .with_filter(filter)
                .with_order(Some("source"), true)
                .expect("排序列"),
        )
        .await
        .expect("第二页");
    assert_eq!(first.len(), 1);
    assert_eq!(second.len(), 1);
    assert_eq!(first[0].source, "src/a.rs");
    assert_eq!(second[0].source, "src/b.rs");
}

#[tokio::test]
async fn list_rejects_a_column_outside_the_whitelist() {
    let (_dir, _store) = setup().await;
    assert!(
        kb_core::model::ListQuery::new(10, 0)
            .with_order(Some("lex"), true)
            .is_err(),
        "lex 不在白名单里,应被拒"
    );
}

fn file_row(
    id: &str,
    source: &str,
    start: i32,
    tags: &[&str],
    status: ItemStatus,
    updated: i64,
) -> RecordRow {
    let mut record = row(
        id,
        &format!("{id} 的正文"),
        &format!("{id} lex"),
        source,
        status,
        tags,
    );
    record.start_line = Some(start);
    record.end_line = Some(start + 5);
    record.updated_at = updated;
    record.title = Some(format!("{source} › 第{start}节"));
    record
}

#[tokio::test]
async fn list_slices_returns_the_same_metadata_as_a_full_list_without_the_heavy_columns() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![
                file_row(
                    "a1",
                    "docs/a.md",
                    1,
                    &["手册", "x"],
                    ItemStatus::Active,
                    100,
                ),
                file_row("a2", "docs/a.md", 20, &["手册"], ItemStatus::Active, 300),
                file_row("b1", "docs/b.md", 1, &[], ItemStatus::Deprecated, 50),
            ],
        )
        .await
        .expect("写入");
    let slices = store.list_slices(TABLE, None).await.expect("瘦行");
    assert_eq!(slices.len(), 3);
    let full = store
        .list(TABLE, &kb_core::model::ListQuery::new(100, 0))
        .await
        .expect("完整行");
    for slice in &slices {
        let row = full
            .iter()
            .find(|row| row.id == slice.id)
            .expect("同一条记录");
        assert_eq!(
            slice,
            &kb_core::model::FileSlice::from(row),
            "瘦行和完整行的元数据应一致:{}",
            slice.id
        );
    }
    // 归并后:a.md 两块并成一条,标签取并集,更新时间取最大
    let files = kb_core::model::group_by_file(slices);
    assert_eq!(files.len(), 2);
    assert_eq!(
        (
            files[0].first.source.as_str(),
            files[0].chunks,
            files[0].updated_at
        ),
        ("docs/a.md", 2, 300)
    );
    assert_eq!(files[0].tags, vec!["x".to_owned(), "手册".to_owned()]);
    assert_eq!(files[0].first.id, "a1", "代表块是起始行最小的");
}

#[tokio::test]
async fn list_slices_honours_the_filter_and_an_empty_table_is_fine() {
    let (_dir, store) = setup().await;
    assert!(
        store
            .list_slices(TABLE, None)
            .await
            .expect("空表")
            .is_empty()
    );
    store
        .upsert(
            TABLE,
            vec![
                file_row("a1", "docs/a.md", 1, &[], ItemStatus::Active, 1),
                file_row("b1", "src/b.rs", 1, &[], ItemStatus::Superseded, 2),
            ],
        )
        .await
        .expect("写入");
    let only_active = store
        .list_slices(TABLE, Some("status = 'active'"))
        .await
        .expect("过滤");
    assert_eq!(
        only_active
            .iter()
            .map(|s| s.id.as_str())
            .collect::<Vec<_>>(),
        ["a1"]
    );
    assert!(
        store
            .list_slices(TABLE, Some("source = 'nope'"))
            .await
            .expect("无匹配")
            .is_empty()
    );
}

#[tokio::test]
async fn list_slices_does_not_stop_at_one_page() {
    let (_dir, store) = setup().await;
    // 比任何默认页大小都多:3000 个块分在 150 个文件里
    let rows: Vec<RecordRow> = (0..3000)
        .map(|n| {
            file_row(
                &format!("r{n:05}"),
                &format!("docs/f{:03}.md", n % 150),
                (n / 150) + 1,
                &[],
                ItemStatus::Active,
                n as i64,
            )
        })
        .collect();
    for part in rows.chunks(500) {
        store.upsert(TABLE, part.to_vec()).await.expect("写入");
    }
    let slices = store.list_slices(TABLE, None).await.expect("瘦行");
    assert_eq!(slices.len(), 3000, "一个块都不能漏");
    let files = kb_core::model::group_by_file(slices);
    assert_eq!(files.len(), 150);
    assert!(files.iter().all(|file| file.chunks == 20));
}

#[tokio::test]
async fn list_files_is_cached_but_a_write_is_visible_at_once() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![file_row("a1", "docs/a.md", 1, &[], ItemStatus::Active, 1)],
        )
        .await
        .expect("写入");
    let first = store.list_files(TABLE, None).await.expect("第一次");
    let again = store.list_files(TABLE, None).await.expect("第二次");
    assert!(
        std::sync::Arc::ptr_eq(&first, &again),
        "表没变,第二次应直接用缓存的那一份"
    );
    assert_eq!(first.len(), 1);

    // 新增一个块和一个新文件:缓存立刻失效
    store
        .upsert(
            TABLE,
            vec![
                file_row("a2", "docs/a.md", 9, &["新标签"], ItemStatus::Active, 5),
                file_row("b1", "docs/b.md", 1, &[], ItemStatus::Active, 2),
            ],
        )
        .await
        .expect("再写入");
    let fresh = store.list_files(TABLE, None).await.expect("写入后");
    assert!(!std::sync::Arc::ptr_eq(&first, &fresh));
    assert_eq!(fresh.len(), 2);
    assert_eq!(
        (fresh[0].chunks, fresh[0].tags.clone()),
        (2, vec!["新标签".to_owned()])
    );

    // 只改元数据(状态)也算写入
    store
        .update_meta(
            TABLE,
            "b1",
            kb_core::model::MetaPatch {
                status: Some(ItemStatus::Deprecated),
                ..Default::default()
            },
        )
        .await
        .expect("改状态");
    let after_meta = store
        .list_files(TABLE, Some("status = 'active'"))
        .await
        .expect("过滤");
    assert_eq!(
        after_meta
            .iter()
            .map(|f| f.first.source.as_str())
            .collect::<Vec<_>>(),
        ["docs/a.md"]
    );

    // 删除
    store
        .delete_ids(TABLE, &["a1".to_owned(), "a2".to_owned()])
        .await
        .expect("删除");
    assert!(
        store
            .list_files(TABLE, Some("status = 'active'"))
            .await
            .expect("删后")
            .is_empty()
    );
}

#[tokio::test]
async fn list_files_caches_each_filter_separately() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![
                file_row("a1", "docs/a.md", 1, &[], ItemStatus::Active, 1),
                file_row("b1", "src/b.rs", 1, &[], ItemStatus::Superseded, 2),
            ],
        )
        .await
        .expect("写入");
    let all = store.list_files(TABLE, None).await.expect("全部");
    let active = store
        .list_files(TABLE, Some("status = 'active'"))
        .await
        .expect("有效");
    assert_eq!((all.len(), active.len()), (2, 1), "不同过滤条件不能互相串");
    let all_again = store.list_files(TABLE, None).await.expect("再取全部");
    assert!(std::sync::Arc::ptr_eq(&all, &all_again));
}

fn dir_bytes(path: &std::path::Path) -> u64 {
    walk(path)
        .iter()
        .filter_map(|file| std::fs::metadata(file).ok())
        .map(|meta| meta.len())
        .sum()
}

fn walk(path: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            let child = entry.path();
            if child.is_dir() {
                out.extend(walk(&child));
            } else {
                out.push(child);
            }
        }
    }
    out
}

/// 反复小批量改写同一批行(保存、重建索引都是这样)会让旧版本和旧数据文件越攒越多;
/// optimize 要把它们清掉,而且查询结果不能变。
#[tokio::test]
async fn optimize_prunes_superseded_versions_and_keeps_the_data() {
    let dir = tempfile::tempdir().expect("临时目录");
    let lance = dir.path().join("lance");
    let store = LanceStore::connect(lance.to_string_lossy().to_string())
        .await
        .expect("连接 LanceDB")
        .with_retention_secs(0);
    store.ensure_table(TABLE, DIM).await.expect("建表");
    let table_dir = lance.join(format!("{TABLE}.lance"));

    for round in 0..40 {
        let rows: Vec<RecordRow> = (0..8)
            .map(|index| {
                row(
                    &format!("a{index}"),
                    &format!("第 {round} 轮的正文 {index}"),
                    "lex",
                    &format!("src/{index}.rs"),
                    ItemStatus::Active,
                    &[],
                )
            })
            .collect();
        store.upsert(TABLE, rows).await.expect("upsert");
    }
    let versions_before = std::fs::read_dir(table_dir.join("_versions"))
        .expect("版本目录")
        .count();
    let bytes_before = dir_bytes(&table_dir);
    assert!(
        versions_before >= 40,
        "每次写入应产生新版本:{versions_before}"
    );

    store.optimize(TABLE).await.expect("optimize");

    let versions_after = std::fs::read_dir(table_dir.join("_versions"))
        .expect("版本目录")
        .count();
    let bytes_after = dir_bytes(&table_dir);
    assert!(
        versions_after <= 4,
        "旧版本应被清掉:{versions_before} → {versions_after}"
    );
    assert!(
        bytes_after < bytes_before,
        "磁盘占用应下降:{bytes_before} → {bytes_after}"
    );
    assert_eq!(
        store.count(TABLE, None).await.expect("计数"),
        8,
        "数据不能丢"
    );
    let latest = store.get(TABLE, &["a3".to_owned()]).await.expect("取行");
    assert_eq!(latest[0].text, "第 39 轮的正文 3", "留下的是最新内容");
}

/// 默认保留 1 小时:刚写下的版本不会被一次 optimize 清掉(读者可能还拿着它)。
#[tokio::test]
async fn default_retention_keeps_recent_versions() {
    let (dir, store) = setup().await;
    for round in 0..5 {
        store
            .upsert(
                TABLE,
                vec![row(
                    "a",
                    &format!("v{round}"),
                    "lex",
                    "src/a.rs",
                    ItemStatus::Active,
                    &[],
                )],
            )
            .await
            .expect("upsert");
    }
    let versions_dir = dir
        .path()
        .join("lance")
        .join(format!("{TABLE}.lance"))
        .join("_versions");
    let before = std::fs::read_dir(&versions_dir).expect("版本目录").count();
    store.optimize(TABLE).await.expect("optimize");
    let after = std::fs::read_dir(&versions_dir).expect("版本目录").count();
    assert!(after >= before, "一小时内的版本都应保留:{before} → {after}");
}

/// 表目录下 `data/` 里的数据文件名(不含路径)。
fn data_files(table_dir: &std::path::Path) -> std::collections::BTreeSet<String> {
    std::fs::read_dir(table_dir.join("data"))
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// 当前表的片段(数据文件)个数。
async fn fragment_count(store: &LanceStore) -> usize {
    let table = store
        .connection()
        .open_table(TABLE.to_owned())
        .execute()
        .await
        .expect("打开表");
    table
        .stats()
        .await
        .expect("表统计")
        .fragment_stats
        .num_fragments
}

/// 保存一个文件只会追加几行,optimize 不能因此把整张表重写一遍:
/// 先写一个大片段,之后每轮追加一行再 optimize,最初那个大片段的数据文件必须原样留着;
/// 新追加的小片段则要被并起来,片段个数不能随轮数增长。
#[tokio::test]
async fn optimize_does_not_rewrite_the_big_fragment_for_small_appends() {
    let dir = tempfile::tempdir().expect("临时目录");
    let lance = dir.path().join("lance");
    // 保留期设成 0:被替换掉的旧文件会立刻清走,"原样留着"的断言才有意义
    let store = LanceStore::connect(lance.to_string_lossy().to_string())
        .await
        .expect("连接 LanceDB")
        .with_retention_secs(0);
    store.ensure_table(TABLE, DIM).await.expect("建表");
    let table_dir = lance.join(format!("{TABLE}.lance"));

    let base: Vec<RecordRow> = (0..3000)
        .map(|index| {
            row(
                &format!("base{index}"),
                &format!("基线正文 {index}"),
                "lex",
                &format!("src/base{}.rs", index % 50),
                ItemStatus::Active,
                &[],
            )
        })
        .collect();
    store.upsert(TABLE, base).await.expect("写基线");
    let baseline = data_files(&table_dir);
    assert_eq!(baseline.len(), 1, "基线应只有一个数据文件:{baseline:?}");

    for round in 0..12 {
        store
            .upsert(
                TABLE,
                vec![row(
                    &format!("extra{round}"),
                    &format!("第 {round} 次追加"),
                    "lex",
                    "src/extra.rs",
                    ItemStatus::Active,
                    &[],
                )],
            )
            .await
            .expect("追加一行");
        store.optimize(TABLE).await.expect("optimize");
        let now = data_files(&table_dir);
        assert!(
            baseline.is_subset(&now),
            "第 {round} 轮:大片段被重写了 {baseline:?} → {now:?}"
        );
    }

    assert_eq!(store.count(TABLE, None).await.expect("计数"), 3012);
    let fragments = fragment_count(&store).await;
    assert!(fragments <= 2, "小片段应被并起来,实际 {fragments} 个片段");
}

/// 定时整理和任务内整理可能同时落到同一张表(日志里出现过
/// `Retryable commit conflict ... preempted by concurrent transaction Rewrite`),
/// 同一张表的 optimize 必须串行,每一次都要成功。
#[tokio::test]
async fn concurrent_optimize_calls_on_one_table_all_succeed() {
    let (_dir, store) = setup().await;
    for round in 0..8 {
        store
            .upsert(
                TABLE,
                vec![row(
                    &format!("c{round}"),
                    &format!("并发整理 {round}"),
                    "lex",
                    "src/c.rs",
                    ItemStatus::Active,
                    &[],
                )],
            )
            .await
            .expect("写入");
    }
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let store = store.clone();
        tasks.push(tokio::spawn(async move { store.optimize(TABLE).await }));
    }
    for task in tasks {
        task.await
            .expect("任务未 panic")
            .expect("并发 optimize 不应冲突");
    }
    assert_eq!(store.count(TABLE, None).await.expect("计数"), 8);
}

/// 确定性的伪随机向量(线性同余),每个 seed 一条,分量落在 [-0.5, 0.5)。
fn pseudo_vector(seed: u64) -> Vec<f32> {
    let mut x = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    (0..DIM)
        .map(|_| {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((x >> 33) as f32 / (1u64 << 31) as f32) - 0.5
        })
        .collect()
}

/// 纯向量检索的前 10 个 id。
async fn top_ids(store: &LanceStore, vector: &[f32]) -> Vec<String> {
    store
        .search(
            TABLE,
            &StoreQuery {
                mode: SearchMode::Vector,
                text: None,
                vector: Some(vector.to_vec()),
                filter: Filter::default(),
                limit: 10,
                offset: 0,
                with_vector: false,
            },
        )
        .await
        .expect("向量检索")
        .into_iter()
        .map(|hit| hit.row.id)
        .collect()
}

/// H3:建了向量索引之后,召回不能明显下降,新增的行也要能立刻检索到。
/// 门槛 recall@10 ≥ 0.9 是跑之前定下的,不按结果回调。
#[tokio::test]
async fn vector_index_keeps_recall_and_late_rows_stay_searchable() {
    let (_dir, store) = setup().await;
    let rows: Vec<RecordRow> = (0..2000u64)
        .map(|index| {
            let mut item = row(
                &format!("v{index}"),
                &format!("向量测试正文 {index}"),
                "lex",
                &format!("src/{}.rs", index % 40),
                ItemStatus::Active,
                &[],
            );
            item.vector = Some(pseudo_vector(index));
            item
        })
        .collect();
    store.upsert(TABLE, rows).await.expect("写入");

    // 没有索引时的结果就是暴力扫描的精确结果,当作标准答案
    let queries: Vec<Vec<f32>> = (0..20u64).map(|i| pseudo_vector(10_000 + i)).collect();
    let mut truth = Vec::new();
    for query in &queries {
        truth.push(top_ids(&store, query).await);
    }

    store.ensure_vector_index(TABLE).await.expect("建向量索引");
    store
        .ensure_vector_index(TABLE)
        .await
        .expect("重复调用应直接跳过");

    let (mut hit, mut total) = (0usize, 0usize);
    for (query, expected) in queries.iter().zip(&truth) {
        let got = top_ids(&store, query).await;
        hit += expected.iter().filter(|id| got.contains(id)).count();
        total += expected.len();
    }
    let recall = hit as f64 / total as f64;
    println!("RECALL@10 = {recall:.4}");
    assert!(recall >= 0.9, "建索引后召回掉到 {recall:.4}");

    // 建索引之后新增的行还没进索引,检索时要和索引结果一起合并,不能漏
    let mut late = row(
        "late",
        "建索引之后才写入的行",
        "lex",
        "src/late.rs",
        ItemStatus::Active,
        &[],
    );
    late.vector = Some(pseudo_vector(99_999));
    store.upsert(TABLE, vec![late]).await.expect("追加");
    let got = top_ids(&store, &pseudo_vector(99_999)).await;
    assert_eq!(got.first().map(String::as_str), Some("late"), "{got:?}");

    // optimize 把它并进索引之后仍然是第一名
    store.optimize(TABLE).await.expect("optimize");
    let got = top_ids(&store, &pseudo_vector(99_999)).await;
    assert_eq!(got.first().map(String::as_str), Some("late"), "{got:?}");
}

/// H3:表上有了向量索引(带精排倍数)之后,混合检索(全文 + 向量)和带过滤条件的向量检索仍然正确。
#[tokio::test]
async fn hybrid_and_filtered_search_work_with_a_vector_index() {
    let (_dir, store) = setup().await;
    let rows: Vec<RecordRow> = (0..1500u64)
        .map(|index| {
            let mut item = row(
                &format!("h{index}"),
                &format!("混合检索测试正文 {index}"),
                if index == 777 {
                    "稀有词汇 混合 检索"
                } else {
                    "混合 检索"
                },
                &format!("src/{}.rs", index % 30),
                if index % 50 == 0 {
                    ItemStatus::Deprecated
                } else {
                    ItemStatus::Active
                },
                &[],
            );
            item.vector = Some(pseudo_vector(index));
            item
        })
        .collect();
    store.upsert(TABLE, rows).await.expect("写入");
    store.ensure_fts_index(TABLE).await.expect("建全文索引");
    store.ensure_vector_index(TABLE).await.expect("建向量索引");

    // 混合检索:用 777 号行自己的向量 + 它独有的词,它必须排第一
    let hits = store
        .search(
            TABLE,
            &StoreQuery {
                mode: SearchMode::Hybrid,
                text: Some("稀有词汇".to_owned()),
                vector: Some(pseudo_vector(777)),
                filter: Filter::default(),
                limit: 10,
                offset: 0,
                with_vector: false,
            },
        )
        .await
        .expect("混合检索");
    assert_eq!(hits.first().map(|hit| hit.row.id.as_str()), Some("h777"));

    // 带过滤条件的向量检索:默认只取 active,已废弃的行(每 50 行一个)一个都不能出现
    let hits = store
        .search(TABLE, &query(SearchMode::Vector, None, Filter::default()))
        .await
        .expect("向量检索");
    assert!(!hits.is_empty());
    for hit in &hits {
        let number: u64 = hit.row.id.trim_start_matches('h').parse().expect("id 数字");
        assert_ne!(
            number % 50,
            0,
            "已废弃的行不应出现在默认结果里:{}",
            hit.row.id
        );
    }
}

/// 只读诊断:`table_stat` 要如实反映行数 / 碎片 / 数据文件 / 版本数,且不改变任何东西。
///
/// 线上「32 k 行的表比 135 k 行的表慢 4 倍」就是靠这几个数定位的(检索性能说明 ):
/// 那张表的碎片涨到了 588 个,健康表只有 1–3 个。
#[tokio::test]
async fn table_stat_reports_fragments_without_touching_the_table() {
    let (_dir, store) = setup().await;
    // 两次 upsert = 两个碎片(写入各自独立提交,正是线上碎片的来源)
    store
        .upsert(
            TABLE,
            vec![
                row("a", "第一块", "第一块", "src/a.rs", ItemStatus::Active, &[]),
                row("b", "第二块", "第二块", "src/b.rs", ItemStatus::Active, &[]),
            ],
        )
        .await
        .expect("写入");
    store
        .upsert(
            TABLE,
            vec![row(
                "c",
                "第三块",
                "第三块",
                "src/c.rs",
                ItemStatus::Active,
                &[],
            )],
        )
        .await
        .expect("再写");

    let before = store.table_stat(TABLE).await.expect("表状况");
    assert_eq!(before.table, TABLE);
    assert_eq!(before.rows, 3, "行数按实际记录算");
    assert_eq!(before.fragments, 2, "两次 upsert 各留下一个碎片");
    assert_eq!(before.data_files, 2, "每个碎片一个数据文件");
    assert!(before.versions >= 2, "版本数要能反映提交次数");
    assert!(before.index_kind.is_none(), "没建向量索引时不能谎报");
    assert!(before.index_rows.is_none());

    // 只读:取完状况后行数与版本都不该变(诊断接口不能顺手 optimize)
    assert_eq!(store.count(TABLE, None).await.expect("计数"), 3);
    let after = store.table_stat(TABLE).await.expect("再取一次");
    assert_eq!(after.version, before.version, "诊断不该产生新版本");
    assert_eq!(after.fragments, before.fragments);
}

/// `update_meta_batch` 与逐行 `update_meta` 结果等价,但只提交一次。
///
/// 这是检索性能说明 的核心断言:一批补丁一个碎片,而不是一行一个。
#[tokio::test]
async fn update_meta_batch_equals_row_by_row_and_writes_one_fragment() {
    let (_dir, store) = setup().await;
    let ids = ["a", "b", "c", "d"];
    store
        .upsert(
            TABLE,
            ids.iter()
                .map(|id| {
                    row(
                        id,
                        "同一份文档的一块",
                        "同一份文档 块",
                        "src/same.rs",
                        ItemStatus::Active,
                        &[],
                    )
                })
                .collect(),
        )
        .await
        .expect("写入");
    let before = store.table_stat(TABLE).await.expect("表状况");

    // 前两条补丁涉及三列,后两条只改行号:两种形状各一次提交
    let updates = vec![
        (
            "a".to_owned(),
            MetaPatch {
                start_line: Some(10),
                end_line: Some(20),
                meta_hash: Some("m-a2".to_owned()),
                ..MetaPatch::default()
            },
        ),
        (
            "b".to_owned(),
            MetaPatch {
                start_line: Some(21),
                end_line: Some(30),
                meta_hash: Some("m-b2".to_owned()),
                ..MetaPatch::default()
            },
        ),
        (
            "c".to_owned(),
            MetaPatch {
                start_line: Some(31),
                end_line: Some(40),
                ..MetaPatch::default()
            },
        ),
        (
            "d".to_owned(),
            MetaPatch {
                start_line: Some(41),
                end_line: Some(50),
                ..MetaPatch::default()
            },
        ),
    ];
    let commits = store
        .update_meta_batch(TABLE, &updates)
        .await
        .expect("批量改");
    assert_eq!(commits, 2, "两种补丁形状各一次提交");

    let after = store.table_stat(TABLE).await.expect("表状况");
    assert_eq!(after.rows, before.rows, "批量改元数据不增删行");
    // 两次提交最多各留一个碎片;逐行写会是 +4,线上那张表的 588 个碎片就是这么来的
    let commits_u64 = commits as u64;
    assert!(
        after.fragments <= before.fragments + commits_u64,
        "批量改元数据只该多出至多 {commits_u64} 个碎片,实际 {} → {}",
        before.fragments,
        after.fragments
    );

    let loaded = store
        .get(
            TABLE,
            &ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>(),
        )
        .await
        .expect("按 id 取");
    let by_id: std::collections::HashMap<&str, &kb_core::model::RecordRow> =
        loaded.iter().map(|row| (row.id.as_str(), row)).collect();
    assert_eq!(by_id["a"].start_line, Some(10));
    assert_eq!(by_id["a"].meta_hash, "m-a2");
    assert_eq!(by_id["b"].end_line, Some(30));
    assert_eq!(by_id["c"].start_line, Some(31));
    // 没在补丁里的列原样保留(正文不受影响)
    assert_eq!(by_id["a"].text, "同一份文档的一块");
    assert_eq!(by_id["c"].meta_hash, "m-c");
    // 补丁没提到的行不受影响
    assert_eq!(store.count(TABLE, None).await.expect("计数"), 4);

    // 补丁里的 id 不存在时不插入、也不报错(与逐行 update 的静默一致)
    let commits = store
        .update_meta_batch(
            TABLE,
            &[(
                // 合法 id 形状但库里没有这一行
                "ffffffff-0000-0000-0000-000000000000".to_owned(),
                MetaPatch {
                    start_line: Some(1),
                    ..MetaPatch::default()
                },
            )],
        )
        .await
        .expect("不存在的 id");
    assert_eq!(commits, 1);
    assert_eq!(store.count(TABLE, None).await.expect("计数"), 4);

    // 一个文件几十块的真实形状:20 条同形状补丁只该多一个碎片
    let second = "proj_demo__fake8__v2";
    store.ensure_table(second, DIM).await.expect("建第二张表");
    let ids: Vec<String> = (0..20u32).map(|index| format!("{index:032x}")).collect();
    store
        .upsert(
            second,
            ids.iter()
                .map(|id| {
                    row(
                        id,
                        "同一个文件的一块",
                        "同一个文件 块",
                        "src/big.rs",
                        ItemStatus::Active,
                        &[],
                    )
                })
                .collect(),
        )
        .await
        .expect("写入");
    let before = store.table_stat(second).await.expect("表状况");
    let updates: Vec<(String, MetaPatch)> = ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                MetaPatch {
                    start_line: Some(42),
                    end_line: Some(84),
                    ..MetaPatch::default()
                },
            )
        })
        .collect();
    let commits = store
        .update_meta_batch(second, &updates)
        .await
        .expect("批量改");
    assert_eq!(commits, 1, "同形状的 20 条补丁只提交一次");
    let after = store.table_stat(second).await.expect("表状况");
    assert!(
        after.fragments <= before.fragments + 1,
        "20 条补丁只该多一个碎片(逐行写会是 20):{} → {}",
        before.fragments,
        after.fragments
    );
}

/// 并发写入同一张表:多个任务同时 upsert,谁都不能丢。
///
/// 后台现在会同时跑好几个分片(`index.parallel_slices`),同一张表可能有好几个文件同时在提交;
/// 后提交的一方会拿到 `Retryable commit conflict`。丢掉重试就意味着那个文件的块没进库,
/// 所以这里真开 8 个任务各写各的,最后要求全部到齐。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_upserts_all_land() {
    const WRITERS: usize = 8;
    const PER_WRITER: usize = 12;
    let (_dir, store) = setup().await;
    let store = Arc::new(store);

    let mut tasks = Vec::new();
    for writer in 0..WRITERS {
        let store = store.clone();
        tasks.push(tokio::spawn(async move {
            for index in 0..PER_WRITER {
                let id = format!("w{writer:02}-{index:03}");
                store
                    .upsert(
                        TABLE,
                        vec![row(
                            &id,
                            "并发写入",
                            "并发 写入",
                            &id,
                            ItemStatus::Active,
                            &[],
                        )],
                    )
                    .await
                    .expect("并发 upsert 不能失败");
            }
        }));
    }
    for task in tasks {
        task.await.expect("任务没崩");
    }

    let rows = store.count(TABLE, None).await.expect("计数");
    assert_eq!(
        rows as usize,
        WRITERS * PER_WRITER,
        "并发写入的块必须全部落库,少了就是提交冲突被吞掉了"
    );
}
