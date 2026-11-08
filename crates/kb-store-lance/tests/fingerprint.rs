//! `LanceStore::list_fingerprints`:一致性校验用的块指纹列表(真实 LanceDB + 临时目录)。

use kb_core::Filter;
use kb_core::KbError;
use kb_core::model::{ChunkFingerprint, ItemStatus, RecordKind, RecordRow};
use kb_core::ports::VectorStore;
use kb_store_lance::LanceStore;

const DIM: usize = 8;
const TABLE: &str = "proj_demo__fake8__v1";

/// id 必须是 `[0-9a-f-]` 白名单内的十六进制串。
fn id_of(number: u64) -> String {
    format!("{number:032x}")
}

fn row(number: u64, kind: RecordKind, source: &str) -> RecordRow {
    RecordRow {
        id: id_of(number),
        collection: "proj_demo".to_owned(),
        kind,
        lang: Some("rust".to_owned()),
        source: source.to_owned(),
        start_line: Some(1),
        end_line: Some(10),
        symbol: None,
        title: None,
        text: format!("正文 {number}"),
        header: format!("demo › {source}"),
        lex: format!("正文 {number}"),
        tags: Vec::new(),
        status: ItemStatus::Active,
        content_hash: format!("content-{number}"),
        meta_hash: format!("meta-{number}"),
        embed_input_hash: format!("embed-{number}"),
        updated_at: 1_700_000_000_000 + number as i64,
        anchor: None,
        vector: Some(vec![0.5; DIM]),
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

/// 按 id 排序后再比较:Lance 的扫描顺序不作保证。
fn sorted(mut fingerprints: Vec<ChunkFingerprint>) -> Vec<ChunkFingerprint> {
    fingerprints.sort_by(|a, b| a.id.cmp(&b.id));
    fingerprints
}

#[tokio::test]
async fn fingerprints_carry_the_stored_values_and_embed_state() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![
                row(1, RecordKind::Code, "src/a.rs"),
                row(2, RecordKind::Doc, "docs/b.md"),
            ],
        )
        .await
        .expect("写入");

    let got = sorted(store.list_fingerprints(TABLE, None).await.expect("指纹"));
    assert_eq!(
        got,
        vec![
            ChunkFingerprint {
                id: id_of(1),
                source: "src/a.rs".to_owned(),
                content_hash: "content-1".to_owned(),
                embed_input_hash: "embed-1".to_owned(),
                updated_at: 1_700_000_000_001,
                embed_state: Some("ready".to_owned()),
            },
            ChunkFingerprint {
                id: id_of(2),
                source: "docs/b.md".to_owned(),
                content_hash: "content-2".to_owned(),
                embed_input_hash: "embed-2".to_owned(),
                updated_at: 1_700_000_000_002,
                embed_state: Some("ready".to_owned()),
            },
        ]
    );
}

#[tokio::test]
async fn the_kind_filter_keeps_only_code_and_doc_rows() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![
                row(1, RecordKind::Code, "src/a.rs"),
                row(2, RecordKind::Doc, "docs/b.md"),
                // 洞察 / 外部资料 / 摘要不经过 chunks 表,校验时必须被过滤掉
                row(3, RecordKind::Insight, "insight:abc"),
                row(4, RecordKind::External, "https://example.com/x"),
                row(5, RecordKind::Summary, "docs/"),
            ],
        )
        .await
        .expect("写入");

    // 过滤条件用结构化的 Filter 生成,与生产里的写法一致
    let filter = Filter {
        kinds: vec![RecordKind::Code, RecordKind::Doc],
        statuses: ItemStatus::ALL.to_vec(),
        ..Filter::default()
    }
    .to_sql()
    .expect("过滤条件")
    .expect("有条件");

    let got = sorted(
        store
            .list_fingerprints(TABLE, Some(&filter))
            .await
            .expect("指纹"),
    );
    let ids: Vec<&str> = got.iter().map(|fp| fp.id.as_str()).collect();
    assert_eq!(ids, [id_of(1), id_of(2)]);
    assert_eq!(
        store
            .list_fingerprints(TABLE, None)
            .await
            .expect("全部")
            .len(),
        5,
        "不带过滤时五行都在"
    );
}

#[tokio::test]
async fn an_empty_table_gives_an_empty_list() {
    let (_dir, store) = setup().await;
    assert!(
        store
            .list_fingerprints(TABLE, None)
            .await
            .expect("空表")
            .is_empty()
    );
}

#[tokio::test]
async fn a_missing_table_is_a_not_found_error() {
    let (_dir, store) = setup().await;
    let err = store
        .list_fingerprints("no_such_table", None)
        .await
        .expect_err("表不存在应报错");
    assert!(matches!(err, KbError::NotFound(_)), "{err:?}");
}

#[tokio::test]
async fn fingerprints_follow_upserts_and_deletes() {
    let (_dir, store) = setup().await;
    store
        .upsert(
            TABLE,
            vec![
                row(1, RecordKind::Code, "src/a.rs"),
                row(2, RecordKind::Code, "src/a.rs"),
            ],
        )
        .await
        .expect("写入");

    // 同 id 换了内容:指纹里的哈希跟着变(这正是校验判定「过期块」的依据)
    let mut changed = row(1, RecordKind::Code, "src/a.rs");
    changed.content_hash = "content-changed".to_owned();
    changed.embed_input_hash = "embed-changed".to_owned();
    store.upsert(TABLE, vec![changed]).await.expect("覆盖");
    // 删掉一行:指纹里也消失
    store.delete_ids(TABLE, &[id_of(2)]).await.expect("删除");

    let got = store.list_fingerprints(TABLE, None).await.expect("指纹");
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].id, id_of(1));
    assert_eq!(got[0].content_hash, "content-changed");
    assert_eq!(got[0].embed_input_hash, "embed-changed");
}

#[tokio::test]
async fn a_table_with_many_rows_and_fragments_is_listed_completely() {
    let (_dir, store) = setup().await;
    // 分几次写,留下多个碎片;总数跨过 2000(列表翻页的常见页大小),不能被截断
    let mut next = 0u64;
    for _ in 0..3 {
        let batch: Vec<RecordRow> = (0..900)
            .map(|_| {
                next += 1;
                row(next, RecordKind::Doc, &format!("docs/{}.md", next % 40))
            })
            .collect();
        store.upsert(TABLE, batch).await.expect("写入一批");
    }
    let got = store.list_fingerprints(TABLE, None).await.expect("指纹");
    assert_eq!(got.len(), 2700);
    let distinct: std::collections::BTreeSet<&str> = got.iter().map(|fp| fp.id.as_str()).collect();
    assert_eq!(distinct.len(), 2700, "每个 id 恰好出现一次");
}
