//! spike：文本先行索引在 Lance 上可不可行（默认不跑）。
//!
//! 这次只碰临时目录，不改生产 schema，也不改 `LanceStore` 的写入路径。目的是回答四个问题：
//! 1. 待嵌入行（`vector = NULL`、`embed_state = 'pending'`）能不能被 FTS 搜到；
//! 2. 向量索引遇到 NULL 向量会怎样；
//! 3. 正常混合检索加上 `embed_state` 过滤后，会不会把 pending 行漏出来；
//! 4. 文本一次 + 向量一次的两倍写入，碎片/磁盘/延迟能不能接受。
//!
//! 用法（真跑，默认 10k 行 × 1024 维）：
//! `cargo test -p kb-store-lance --test text_first_spike -- --ignored --nocapture`
//!
//! 可调参数（只影响这次 spike，不改生产配置）：
//! `KB_SPIKE_ROWS`、`KB_SPIKE_PENDING`、`KB_SPIKE_DIM`、`KB_SPIKE_QUERIES`。
//!
//! 注意：这里故意用原始 lancedb API 做 schema 变更和部分列 merge；生产实现要等 结论出来再动。

use std::sync::Arc;
use std::time::Instant;

use arrow_array::{Array, ArrayRef, RecordBatch, RecordBatchIterator, StringArray};
use arrow_schema::{DataType, Field, Schema};
use futures::TryStreamExt;
use kb_core::model::{ItemStatus, RecordKind, RecordRow};
use kb_core::ports::VectorStore;
use kb_store_lance::{LanceStore, record_schema, rows_to_batch};
use lancedb::DistanceType;
use lancedb::index::scalar::FullTextSearchQuery;
use lancedb::query::{ExecutableQuery, QueryBase, Select};
use lancedb::table::NewColumnTransform;

const TABLE: &str = "text_first_spike";

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn dim() -> usize {
    env_usize("KB_SPIKE_DIM", 1024)
}

fn rows() -> usize {
    env_usize("KB_SPIKE_ROWS", 10_000)
}

fn pending_rows() -> usize {
    env_usize("KB_SPIKE_PENDING", 1_000)
}

fn queries() -> usize {
    env_usize("KB_SPIKE_QUERIES", 50)
}

/// 确定性的伪随机向量；不同 seed 的向量不同，避免“自检索恒为自己”的假象。
fn pseudo_vector(seed: u64, dim: usize) -> Vec<f32> {
    let mut x = seed
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    (0..dim)
        .map(|_| {
            x = x
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((x >> 33) as f32 / (1u64 << 31) as f32) - 0.5
        })
        .collect()
}

fn id_of(seed: usize) -> String {
    format!("{seed:032x}")
}

fn row_of(seed: usize, vector: Option<Vec<f32>>, lex: &str) -> RecordRow {
    RecordRow {
        id: id_of(seed),
        collection: "spike".to_owned(),
        kind: RecordKind::Code,
        lang: Some("rust".to_owned()),
        source: format!("src/{}.rs", seed % 50),
        start_line: Some(1),
        end_line: Some(10),
        symbol: None,
        title: None,
        text: format!("第 {seed} 号文本，lex={lex}"),
        header: format!("spike › src/{}.rs", seed % 50),
        lex: lex.to_owned(),
        tags: Vec::new(),
        status: ItemStatus::Active,
        content_hash: format!("c-{seed}"),
        meta_hash: format!("m-{seed}"),
        embed_input_hash: format!("e-{seed}"),
        updated_at: 1_700_000_000_000,
        anchor: None,
        vector,
    }
}

/// 把旧 schema 的批次扩一列 `embed_state`，模拟 加列后写入 pending/ready 行。
fn batch_with_state(rows: &[RecordRow], state: &str, dim: usize) -> RecordBatch {
    let base = rows_to_batch(rows, record_schema(dim).expect("schema")).expect("批次");
    let mut fields: Vec<Field> = base
        .schema()
        .fields()
        .iter()
        .map(|field| field.as_ref().clone())
        .collect();
    fields.push(Field::new("embed_state", DataType::Utf8, true));
    let schema = Arc::new(Schema::new(fields));
    let mut columns: Vec<ArrayRef> = base.columns().to_vec();
    columns.push(Arc::new(StringArray::from(vec![state; rows.len()])));
    RecordBatch::try_new(schema, columns).expect("扩展 embed_state 后的批次")
}

async fn open(store: &LanceStore, table: &str) -> lancedb::Table {
    store
        .connection()
        .open_table(table.to_owned())
        .execute()
        .await
        .expect("打开表")
}

async fn merge_with_state(store: &LanceStore, table: &str, rows: Vec<RecordRow>, state: &str) {
    let handle = open(store, table).await;
    let batch = batch_with_state(&rows, state, dim());
    let schema = batch.schema();
    let reader: Box<dyn arrow_array::RecordBatchReader + Send> =
        Box::new(RecordBatchIterator::new(vec![Ok(batch)], schema));
    let mut merge = handle.merge_insert(&["id"]);
    merge
        .when_matched_update_all(None)
        .when_not_matched_insert_all();
    merge.execute(reader).await.expect("merge 行");
}

async fn add_embed_state(store: &LanceStore, table: &str) {
    let handle = open(store, table).await;
    let schema = Arc::new(Schema::new(vec![Field::new(
        "embed_state",
        DataType::Utf8,
        true,
    )]));
    handle
        .add_columns()
        .transform(NewColumnTransform::AllNulls(schema))
        .execute()
        .await
        .expect("追加 embed_state 列");
}

async fn set_all_state(store: &LanceStore, table: &str, state: &str) {
    let handle = open(store, table).await;
    handle
        .update()
        .column("embed_state", format!("'{state}'"))
        .execute()
        .await
        .expect("更新 embed_state");
}

async fn count(store: &LanceStore, table: &str, filter: &str) -> u64 {
    store.count(table, Some(filter)).await.expect("计数")
}

async fn collect_ids<Q: ExecutableQuery>(query: Q) -> Vec<String> {
    let batches = query
        .execute()
        .await
        .expect("执行查询")
        .try_collect::<Vec<_>>()
        .await
        .expect("读结果");
    let mut ids = Vec::new();
    for batch in batches {
        if let Some(array) = batch
            .column_by_name("id")
            .and_then(|column| column.as_any().downcast_ref::<StringArray>())
        {
            ids.extend((0..array.len()).map(|index| array.value(index).to_owned()));
        }
    }
    ids
}

fn fts(text: &str) -> FullTextSearchQuery {
    FullTextSearchQuery::new(text.to_owned())
        .with_column("lex".to_owned())
        .expect("FTS 列")
}

async fn fts_ids(handle: &lancedb::Table, text: &str, filter: &str, limit: usize) -> Vec<String> {
    collect_ids(
        handle
            .query()
            .full_text_search(fts(text))
            .only_if(filter)
            .limit(limit)
            .select(Select::columns(&["id"])),
    )
    .await
}

async fn hybrid_ids(
    handle: &lancedb::Table,
    text: &str,
    vector: &[f32],
    filter: &str,
    limit: usize,
) -> Vec<String> {
    collect_ids(
        handle
            .query()
            .full_text_search(fts(text))
            .nearest_to(vector.to_vec())
            .expect("向量")
            .distance_type(DistanceType::Cosine)
            .only_if(filter)
            .limit(limit)
            .select(Select::columns(&["id"])),
    )
    .await
}

async fn vector_ids(
    handle: &lancedb::Table,
    vector: &[f32],
    filter: &str,
    limit: usize,
) -> Vec<String> {
    collect_ids(
        handle
            .query()
            .nearest_to(vector.to_vec())
            .expect("向量")
            .distance_type(DistanceType::Cosine)
            .only_if(filter)
            .limit(limit)
            .select(Select::columns(&["id"])),
    )
    .await
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() as f64 - 1.0) * q).round() as usize]
}

async fn measure(handle: &lancedb::Table, label: &str, mode: &str, filters: &[&str]) -> (f64, f64) {
    let text = "commonprobe";
    let vector = pseudo_vector(4242, dim());
    let mut times = Vec::new();
    for index in 0..queries() {
        // 每轮交替用 pending 与 ready 过滤，避免只测到一种计划。
        let filter = filters[index % filters.len()];
        let started = Instant::now();
        match mode {
            "fts" => {
                fts_ids(handle, text, filter, 10).await;
            }
            "hybrid" => {
                hybrid_ids(handle, text, &vector, filter, 10).await;
            }
            "vector" => {
                vector_ids(handle, &vector, filter, 10).await;
            }
            other => panic!("未知模式 {other}"),
        }
        times.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    times.sort_by(|a, b| a.total_cmp(b));
    let (p50, p95) = (percentile(&times, 0.5), percentile(&times, 0.95));
    println!(
        "  [{label}/{mode}] p50={p50:.2} ms p95={p95:.2} ms n={}",
        times.len()
    );
    (p50, p95)
}

fn dir_bytes(path: &std::path::Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else {
                return 0;
            };
            if meta.is_dir() {
                dir_bytes(&path)
            } else {
                meta.len()
            }
        })
        .sum()
}

async fn stats(store: &LanceStore, table: &str, label: &str, lance_dir: &std::path::Path) -> u64 {
    let stat = store.table_stat(table).await.expect("表状况");
    let bytes = dir_bytes(&lance_dir.join(format!("{table}.lance")));
    println!(
        "  [{label}] rows={} fragments={} data_files={} versions={} disk={:.1} MiB",
        stat.rows,
        stat.fragments,
        stat.data_files,
        stat.versions,
        bytes as f64 / 1024.0 / 1024.0
    );
    bytes
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = " spike：临时目录 + 原始 lancedb API，默认不跑"]
async fn text_first_spike_on_a_temp_lance_table() {
    let dir = tempfile::tempdir().expect("临时目录");
    let lance_dir = dir.path().join("lance");
    let uri = lance_dir.to_string_lossy().to_string();
    let store = LanceStore::connect(uri)
        .await
        .expect("连接 LanceDB")
        .with_retention_secs(0);

    println!(
        "SPIKE rows={} pending={} dim={} queries={}",
        rows(),
        pending_rows(),
        dim(),
        queries()
    );

    // A. 基线：一次写入 ready 行（文本 + 向量同批），这是当前生产路径的简化版。
    let baseline = format!("{TABLE}_baseline");
    store.ensure_table(&baseline, dim()).await.expect("建表");
    let ready_rows: Vec<RecordRow> = (0..rows())
        .map(|seed| {
            row_of(
                seed,
                Some(pseudo_vector(seed as u64, dim())),
                "commonprobe readyprobe",
            )
        })
        .collect();
    let started = Instant::now();
    store
        .upsert(&baseline, ready_rows.clone())
        .await
        .expect("基线写入");
    let baseline_write_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    store.ensure_fts_index(&baseline).await.expect("FTS 索引");
    let baseline_fts_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    store
        .ensure_vector_index(&baseline)
        .await
        .expect("向量索引");
    let baseline_vector_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    store.optimize(&baseline).await.expect("optimize");
    let baseline_optimize_ms = started.elapsed().as_secs_f64() * 1000.0;
    println!(
        "  [baseline] write={baseline_write_ms:.1} ms fts_index={baseline_fts_ms:.1} ms vector_index={baseline_vector_ms:.1} ms optimize={baseline_optimize_ms:.1} ms"
    );
    let baseline_bytes = stats(&store, &baseline, "baseline", &lance_dir).await;
    let baseline_handle = open(&store, &baseline).await;
    measure(&baseline_handle, "baseline", "fts", &["id IS NOT NULL"]).await;
    measure(&baseline_handle, "baseline", "hybrid", &["id IS NOT NULL"]).await;

    // B. 文本先行：先写 10k 行 pending（vector=NULL），再补向量。
    let textfirst = format!("{TABLE}_textfirst");
    store.ensure_table(&textfirst, dim()).await.expect("建表");
    let pending: Vec<RecordRow> = (0..rows())
        .map(|seed| row_of(seed, None, "commonprobe pendingprobe"))
        .collect();
    let started = Instant::now();
    store
        .upsert(&textfirst, pending.clone())
        .await
        .expect("文本阶段写入");
    let text_write_ms = started.elapsed().as_secs_f64() * 1000.0;
    add_embed_state(&store, &textfirst).await;
    set_all_state(&store, &textfirst, "pending").await;
    let started = Instant::now();
    store.ensure_fts_index(&textfirst).await.expect("FTS 索引");
    let text_fts_ms = started.elapsed().as_secs_f64() * 1000.0;
    println!(
        "  [textfirst] text_write={text_write_ms:.1} ms fts_index={text_fts_ms:.1} ms pending={}",
        count(&store, &textfirst, "embed_state = 'pending'").await
    );

    // B1. 全部 pending 时建向量索引：这里要观察 NULL 向量是报错、跳过，还是建出空索引。
    let all_pending_index = store.ensure_vector_index(&textfirst).await;
    match &all_pending_index {
        Ok(()) => println!("  [textfirst] 全 pending 建向量索引: Ok"),
        Err(error) => println!("  [textfirst] 全 pending 建向量索引: Err({error})"),
    }
    let all_pending_handle = open(&store, &textfirst).await;
    let pending_hits = fts_ids(
        &all_pending_handle,
        "pendingprobe",
        "embed_state = 'pending'",
        10,
    )
    .await;
    let ready_hits = fts_ids(
        &all_pending_handle,
        "pendingprobe",
        "(embed_state IS NULL OR embed_state = 'ready')",
        10,
    )
    .await;
    println!(
        "  [textfirst] FTS pending 命中={}（示例 {:?}），ready 过滤命中={}",
        pending_hits.len(),
        pending_hits.first(),
        ready_hits.len()
    );
    assert!(!pending_hits.is_empty(), "pending 行必须能被 FTS 搜到");
    assert!(ready_hits.is_empty(), "ready 过滤不能返回 pending 行");

    // B2. 补向量：用完整批次把 10k 行从 pending 升到 ready。
    let started = Instant::now();
    let ready_again: Vec<RecordRow> = (0..rows())
        .map(|seed| {
            row_of(
                seed,
                Some(pseudo_vector(seed as u64, dim())),
                "commonprobe readyprobe",
            )
        })
        .collect();
    merge_with_state(&store, &textfirst, ready_again, "ready").await;
    let promote_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    store
        .ensure_vector_index(&textfirst)
        .await
        .expect("补完向量后建索引");
    let promoted_vector_ms = started.elapsed().as_secs_f64() * 1000.0;
    let started = Instant::now();
    store
        .optimize(&textfirst)
        .await
        .expect("promote 后 optimize");
    let promoted_optimize_ms = started.elapsed().as_secs_f64() * 1000.0;
    println!(
        "  [textfirst] promote={promote_ms:.1} ms vector_index={promoted_vector_ms:.1} ms optimize={promoted_optimize_ms:.1} ms"
    );
    let promoted_bytes = stats(&store, &textfirst, "promoted", &lance_dir).await;
    let promoted_handle = open(&store, &textfirst).await;
    measure(
        &promoted_handle,
        "promoted",
        "fts",
        &["embed_state = 'ready'"],
    )
    .await;
    measure(
        &promoted_handle,
        "promoted",
        "hybrid",
        &["embed_state = 'ready'"],
    )
    .await;
    measure(
        &promoted_handle,
        "promoted",
        "vector",
        &["embed_state = 'ready'"],
    )
    .await;

    // C. 已建索引后再追加 pending：这正是 的日常状态（旧内容 ready，新内容 pending）。
    let append: Vec<RecordRow> = (rows()..rows() + pending_rows())
        .map(|seed| row_of(seed, None, "commonprobe pendingprobe"))
        .collect();
    let started = Instant::now();
    merge_with_state(&store, &textfirst, append.clone(), "pending").await;
    let append_ms = started.elapsed().as_secs_f64() * 1000.0;
    let append_ids: Vec<String> = append.iter().map(|row| row.id.clone()).collect();
    let append_handle = open(&store, &textfirst).await;
    let pending_after = fts_ids(
        &append_handle,
        "pendingprobe",
        "embed_state = 'pending'",
        10,
    )
    .await;
    let ready_after = fts_ids(
        &append_handle,
        "commonprobe",
        "(embed_state IS NULL OR embed_state = 'ready')",
        100,
    )
    .await;
    let hybrid_after = hybrid_ids(
        &append_handle,
        "commonprobe",
        &pseudo_vector(4242, dim()),
        "(embed_state IS NULL OR embed_state = 'ready')",
        100,
    )
    .await;
    let vector_after = vector_ids(
        &append_handle,
        &pseudo_vector(4242, dim()),
        "(embed_state IS NULL OR embed_state = 'ready')",
        100,
    )
    .await;
    let leaked = |ids: &[String]| ids.iter().filter(|id| append_ids.contains(id)).count();
    println!(
        "  [append-pending] write={append_ms:.1} ms pending={} FTS-pending={} FTS-ready={} hybrid-ready={} vector-ready={}",
        count(&store, &textfirst, "embed_state = 'pending'").await,
        pending_after.len(),
        ready_after.len(),
        hybrid_after.len(),
        vector_after.len()
    );
    println!(
        "  [append-pending] pending 泄漏: FTS-ready={} hybrid-ready={} vector-ready={}",
        leaked(&ready_after),
        leaked(&hybrid_after),
        leaked(&vector_after)
    );
    assert!(
        !pending_after.is_empty(),
        "追加的 pending 行必须能被 FTS 搜到"
    );
    assert_eq!(leaked(&ready_after), 0, "FTS ready 过滤漏出 pending");
    assert_eq!(leaked(&hybrid_after), 0, "hybrid ready 过滤漏出 pending");
    assert_eq!(leaked(&vector_after), 0, "vector ready 过滤漏出 pending");

    let started = Instant::now();
    let optimize_after_pending = store.optimize(&textfirst).await;
    let optimize_after_pending_ms = started.elapsed().as_secs_f64() * 1000.0;
    println!(
        "  [append-pending] optimize={optimize_after_pending_ms:.1} ms result={:?}",
        optimize_after_pending
            .as_ref()
            .map(|_| "Ok")
            .map_err(|e| e.to_string())
    );
    let final_bytes = stats(&store, &textfirst, "final", &lance_dir).await;
    let final_handle = open(&store, &textfirst).await;
    measure(
        &final_handle,
        "final",
        "fts",
        &[
            "embed_state = 'pending'",
            "(embed_state IS NULL OR embed_state = 'ready')",
        ],
    )
    .await;
    // pending 行没有向量，混合查询只会走 FTS；这里只测 ready 一侧，
    // 避免把“FTS-only 结果没有 _distance”误判成产品缺陷（线上会按 degraded 处理）。
    measure(
        &final_handle,
        "final",
        "hybrid",
        &["(embed_state IS NULL OR embed_state = 'ready')"],
    )
    .await;

    // D. 汇总：文本先行总写入 = 文本一次 + 向量一次；与一次性 ready 写入对比。
    println!(
        "SUMMARY baseline_disk={:.1} MiB textfirst_disk={:.1} MiB ratio={:.2}",
        baseline_bytes as f64 / 1024.0 / 1024.0,
        final_bytes as f64 / 1024.0 / 1024.0,
        final_bytes as f64 / baseline_bytes.max(1) as f64
    );
    println!(
        "SUMMARY baseline_write={baseline_write_ms:.1} ms text_phase={text_write_ms:.1} ms promote={promote_ms:.1} ms two_write_total={:.1} ms ratio={:.2}",
        text_write_ms + promote_ms,
        (text_write_ms + promote_ms) / baseline_write_ms.max(0.1)
    );
    println!(
        "SUMMARY promoted_disk={:.1} MiB final_disk={:.1} MiB",
        promoted_bytes as f64 / 1024.0 / 1024.0,
        final_bytes as f64 / 1024.0 / 1024.0
    );
}
