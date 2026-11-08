//! 向量索引分段(delta)与数据碎片不能随 optimize 次数线性增长(引擎检查)。
//!
//! 背景:每次 optimize 的「并入索引」都会为新写入的行**新建**一个 delta 分段,分段不会自己合并;
//! 压缩又只合并「被同一组索引覆盖」的相邻碎片,每个小碎片各被自己的 delta 覆盖,于是永远合不到一起。
//! 生产上两张持续写入的表因此积了 159 / 74 个分段、160 多个碎片。
//!
//! 这里用真实的 `LanceStore` + 临时目录 + 8 维向量复现「很多批小写入,每批之后 optimize」的场景。

use kb_core::Filter;
use kb_core::model::{ItemStatus, RecordKind, RecordRow, SearchMode, StoreQuery};
use kb_core::ports::VectorStore;
use kb_store_lance::{LanceStore, MAX_VECTOR_INDEX_SEGMENTS};
use lancedb::index::IndexType;

const DIM: usize = 8;
const TABLE: &str = "proj_deltas__fake8__v1";
/// 建索引前先写这么多行(向量索引训练需要一定数量的行)。
const SEED_ROWS: u64 = 2000;
/// 之后每批写入的行数:很小,模拟编辑几个文件后的增量索引。
const BATCH_ROWS: u64 = 30;

/// 确定性的伪随机向量(线性同余),每个 seed 一条,分量落在 [-0.5, 0.5);不同 seed 的向量互不相同。
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

fn id_of(seed: u64) -> String {
    format!("{seed:032x}")
}

fn row_of(seed: u64) -> RecordRow {
    RecordRow {
        id: id_of(seed),
        collection: "proj_deltas".to_owned(),
        kind: RecordKind::Code,
        lang: Some("rust".to_owned()),
        source: format!("src/{}.rs", seed % 50),
        start_line: Some(1),
        end_line: Some(10),
        symbol: None,
        title: None,
        text: format!("第 {seed} 号测试正文"),
        header: format!("demo › src/{}.rs", seed % 50),
        lex: "lex".to_owned(),
        tags: Vec::new(),
        status: ItemStatus::Active,
        content_hash: format!("c-{seed}"),
        meta_hash: format!("m-{seed}"),
        embed_input_hash: format!("e-{seed}"),
        updated_at: 1_700_000_000_000,
        anchor: None,
        vector: Some(pseudo_vector(seed)),
    }
}

/// 第 `batch` 批小写入的行种子(与初始行、其他批互不重叠)。
fn batch_seeds(batch: u64) -> std::ops::Range<u64> {
    let start = 100_000 + batch * BATCH_ROWS;
    start..start + BATCH_ROWS
}

/// 建好表、写入初始行、建好向量索引并 optimize 一次,返回(临时目录, 库)。
///
/// 旧版本保留期设成 0:这样 optimize 的清理步骤会真的把被替换的文件清掉,碎片数以清单为准不受影响。
async fn setup() -> (tempfile::TempDir, LanceStore) {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = LanceStore::connect(dir.path().join("lance").to_string_lossy().to_string())
        .await
        .expect("连接 LanceDB")
        .with_retention_secs(0);
    store.ensure_table(TABLE, DIM).await.expect("建表");
    store
        .upsert(TABLE, (0..SEED_ROWS).map(row_of).collect())
        .await
        .expect("写入初始行");
    store.ensure_vector_index(TABLE).await.expect("建向量索引");
    store.optimize(TABLE).await.expect("初始 optimize");
    (dir, store)
}

/// 追加一批小写入(一次 upsert = 一个新碎片)。
async fn write_batch(store: &LanceStore, batch: u64) {
    store
        .upsert(TABLE, batch_seeds(batch).map(row_of).collect())
        .await
        .expect("追加一批");
}

/// 向量索引现在有几个分段(delta)。
async fn segments(store: &LanceStore) -> usize {
    let handle = store
        .connection()
        .open_table(TABLE)
        .execute()
        .await
        .expect("打开表");
    let name = handle
        .list_indices()
        .await
        .expect("列索引")
        .into_iter()
        .find(|index| matches!(index.index_type, IndexType::IvfHnswSq))
        .expect("表上应有向量索引")
        .name;
    handle
        .index_stats(&name)
        .await
        .expect("索引统计")
        .expect("索引存在")
        .num_indices
        .expect("向量索引应报告分段数") as usize
}

async fn fragments(store: &LanceStore) -> u64 {
    store.table_stat(TABLE).await.expect("表状况").fragments
}

async fn unindexed_rows(store: &LanceStore) -> u64 {
    store
        .table_stat(TABLE)
        .await
        .expect("表状况")
        .index_unindexed_rows
        .expect("应报告未入索引的行数")
}

/// 用行自己存的向量去查,返回前 10 个 id。
async fn nearest_ids(store: &LanceStore, seed: u64) -> Vec<String> {
    store
        .search(
            TABLE,
            &StoreQuery {
                mode: SearchMode::Vector,
                text: None,
                vector: Some(pseudo_vector(seed)),
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

/// 自检索:对 `seeds` 里的每一行用它自己的向量查,统计 top-1 就是它自己的个数。
async fn self_hits(store: &LanceStore, seeds: impl Iterator<Item = u64>) -> (usize, usize) {
    let (mut hit, mut total) = (0, 0);
    for seed in seeds {
        total += 1;
        if nearest_ids(store, seed).await.first() == Some(&id_of(seed)) {
            hit += 1;
        }
    }
    (hit, total)
}

/// 一批批小写入、每批之后 optimize:分段数有上限,碎片能合并,检索结果不变。
///
/// 改动前:每次 optimize 多一个分段(25 批之后 26 个),每批的小碎片各被自己的分段覆盖、合不掉。
#[tokio::test]
async fn deltas_and_fragments_stay_bounded_across_many_small_batches() {
    let (_dir, store) = setup().await;
    let batches = 25u64;
    let mut max_segments = segments(&store).await;
    let mut max_fragments = fragments(&store).await;
    let mut timeline = Vec::new();
    for batch in 0..batches {
        write_batch(&store, batch).await;
        store.optimize(TABLE).await.expect("optimize");
        let (segs, frags) = (segments(&store).await, fragments(&store).await);
        timeline.push((segs, frags));
        max_segments = max_segments.max(segs);
        max_fragments = max_fragments.max(frags);
        // 每批写完 optimize 之后,这一批的行都必须已经进了索引
        assert_eq!(unindexed_rows(&store).await, 0, "第 {batch} 批没有并进索引");
        // 新写入的行立刻能用自己的向量查到
        let (hit, total) = self_hits(&store, batch_seeds(batch)).await;
        assert_eq!(
            hit, total,
            "第 {batch} 批的行自检索 top-1 掉了:{hit}/{total}"
        );
    }
    println!("(分段数, 碎片数) 随批次: {timeline:?}");

    // 分段数:任何时刻 optimize 之后都不超过 上限 + 1
    assert!(
        max_segments <= MAX_VECTOR_INDEX_SEGMENTS + 1,
        "分段数应有上限 {}:实际最多 {max_segments},过程 {timeline:?}",
        MAX_VECTOR_INDEX_SEGMENTS + 1
    );
    // 碎片:25 批小写入不能留下 25 个小碎片;每次合并分段之后小碎片才合得起来,
    // 所以任何时刻都不超过「底座 + 上限」个,最终比批数少得多
    let final_fragments = fragments(&store).await;
    assert!(
        max_fragments <= MAX_VECTOR_INDEX_SEGMENTS as u64 + 1,
        "碎片数应有上限:最多 {max_fragments},过程 {timeline:?}"
    );
    assert!(
        final_fragments <= batches / 2,
        "碎片数应随分段合并而减少:最终 {final_fragments},批数 {batches},过程 {timeline:?}"
    );

    // 检索结果不变:初始行与所有批次的行,自检索 top-1 都还是自己
    let all_seeds = (0..SEED_ROWS)
        .step_by(10)
        .chain((0..batches).flat_map(batch_seeds));
    let (hit, total) = self_hits(&store, all_seeds).await;
    assert_eq!(hit, total, "合并后自检索 top-1 掉了:{hit}/{total}");
    // 表里的行一个不少
    assert_eq!(
        store.count(TABLE, None).await.expect("计数"),
        SEED_ROWS + batches * BATCH_ROWS
    );
}

/// 阈值以内保持原来的行为:每次 optimize 只多一个分段,不做合并;越过阈值那一次才合并。
#[tokio::test]
async fn nothing_is_merged_while_segments_stay_within_the_limit() {
    let (_dir, store) = setup().await;
    let start = segments(&store).await;
    assert_eq!(start, 1, "建索引后应只有一个分段");

    let mut expected = start;
    let mut batch = 0;
    // 逐批追加,直到分段数刚好到上限:这一路上每次都只该 +1
    while expected < MAX_VECTOR_INDEX_SEGMENTS {
        write_batch(&store, batch).await;
        store.optimize(TABLE).await.expect("optimize");
        expected += 1;
        assert_eq!(
            segments(&store).await,
            expected,
            "分段数没超过上限时不该合并(第 {batch} 批)"
        );
        batch += 1;
    }
    // 未合并时碎片也不会被压缩:每批的小碎片各被自己的分段覆盖
    let before_merge = fragments(&store).await;
    assert!(
        before_merge > MAX_VECTOR_INDEX_SEGMENTS as u64 / 2,
        "未越过上限时不该有额外的合并动作,碎片数 {before_merge}"
    );

    // 再来一批:分段数会到「上限 + 1」,越过上限,这次 optimize 要把它们合并
    write_batch(&store, batch).await;
    store.optimize(TABLE).await.expect("optimize");
    let merged = segments(&store).await;
    assert!(
        merged < MAX_VECTOR_INDEX_SEGMENTS,
        "越过上限的那次 optimize 应把分段合并掉,实际 {merged}"
    );
    let after_merge = fragments(&store).await;
    assert!(
        after_merge < before_merge,
        "分段合并后碎片应能压缩:{before_merge} → {after_merge}"
    );
    let all_seeds = (0..SEED_ROWS)
        .step_by(10)
        .chain((0..=batch).flat_map(batch_seeds));
    let (hit, total) = self_hits(&store, all_seeds).await;
    assert_eq!(hit, total, "合并后自检索 top-1 掉了:{hit}/{total}");
}
