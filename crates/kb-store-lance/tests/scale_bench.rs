//! 规模基准(设计规范 ,对应风险 )。
//!
//! 生成 10 万行 1024 维向量,对比“建向量索引前后”的混合查询 p50/p95 与建索引耗时。
//! 默认忽略(数据量大、耗时几分钟):
//!
//! ```bash
//! cargo test -p kb-store-lance --test scale_bench -- --ignored --nocapture
//! ```

use std::time::Instant;

use kb_core::filter::Filter;
use kb_core::model::{ItemStatus, RecordKind, RecordRow, SearchMode, StoreQuery};
use kb_core::ports::VectorStore;
use kb_store_lance::LanceStore;

const ROWS: usize = 100_000;
const DIM: usize = 1024;
const BATCH: usize = 5_000;
const QUERIES: usize = 30;

fn pseudo_random(state: &mut u64) -> f32 {
    // xorshift64*,确定性、无需额外依赖
    *state ^= *state >> 12;
    *state ^= *state << 25;
    *state ^= *state >> 27;
    let value = state.wrapping_mul(0x2545_F491_4F6C_DD1D);
    ((value >> 40) as f32 / 16_777_216.0) - 0.5
}

fn vector(state: &mut u64) -> Vec<f32> {
    let mut out = Vec::with_capacity(DIM);
    for _ in 0..DIM {
        out.push(pseudo_random(state));
    }
    out
}

fn row(id: usize, state: &mut u64) -> RecordRow {
    let words = [
        "hybrid", "search", "index", "daemon", "socket", "chunk", "embed",
    ];
    let text = format!(
        "{} {} {} 第{id}行",
        words[id % words.len()],
        words[(id / 7) % words.len()],
        words[(id / 13) % words.len()]
    );
    RecordRow {
        id: format!("{id:032x}"),
        collection: "bench".to_owned(),
        kind: RecordKind::Code,
        lang: Some("rust".to_owned()),
        source: format!("src/file{}.rs", id % 1000),
        start_line: Some((id % 500) as i32 + 1),
        end_line: Some((id % 500) as i32 + 20),
        symbol: Some(format!("fn handler_{id}")),
        title: None,
        text: text.clone(),
        header: format!("bench › src/file{}.rs › fn handler_{id}", id % 1000),
        // lex 列 = 原文 + 拆分后的词元(这里直接重复一遍文本,足够让全文检索有区分度)
        lex: format!("{text} {text}"),
        tags: Vec::new(),
        status: ItemStatus::Active,
        content_hash: format!("{id:016x}"),
        meta_hash: format!("{id:016x}"),
        embed_input_hash: format!("{id:016x}"),
        updated_at: 0,
        anchor: None,
        vector: Some(vector(state)),
    }
}

fn percentile(mut values: Vec<f64>, p: f64) -> f64 {
    values.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let index = ((values.len() as f64 - 1.0) * p).round() as usize;
    values[index]
}

async fn measure(store: &LanceStore, table: &str, label: &str) -> (f64, f64) {
    let mut state = 0x5EED_1234_5678_9ABC_u64;
    let mut latencies = Vec::with_capacity(QUERIES);
    for round in 0..QUERIES {
        let query = StoreQuery {
            mode: SearchMode::Hybrid,
            text: Some(if round % 2 == 0 {
                "hybrid search".to_owned()
            } else {
                "daemon socket".to_owned()
            }),
            vector: Some(vector(&mut state)),
            filter: Filter::default(),
            limit: 24,
            offset: 0,
            with_vector: false,
        };
        let started = Instant::now();
        let hits = store.search(table, &query).await.expect("检索");
        let elapsed = started.elapsed();
        if round == 0 {
            println!("{label}: 首条查询 {:?},命中 {}", elapsed, hits.len());
        }
        latencies.push(elapsed.as_secs_f64() * 1000.0);
    }
    let p50 = percentile(latencies.clone(), 0.5);
    let p95 = percentile(latencies, 0.95);
    println!("{label}: p50 = {p50:.1} ms, p95 = {p95:.1} ms");
    (p50, p95)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "规模基准:10 万行 × 1024 维,需要几分钟"]
async fn scale_bench_vector_index() {
    let dir = tempfile::tempdir().expect("临时目录");
    let store = LanceStore::connect(dir.path().to_string_lossy().to_string())
        .await
        .expect("连接");
    let table = "bench__fake1024__v1";
    store.ensure_table(table, DIM).await.expect("建表");

    let started = Instant::now();
    let mut state = 0x1234_5678_9ABC_DEF0_u64;
    for batch_start in (0..ROWS).step_by(BATCH) {
        let rows: Vec<RecordRow> = (batch_start..(batch_start + BATCH).min(ROWS))
            .map(|id| row(id, &mut state))
            .collect();
        store.upsert(table, rows).await.expect("写入");
        if batch_start % 25_000 == 0 {
            println!("已写入 {batch_start} 行");
        }
    }
    println!("写入 {ROWS} 行用时 {:?}", started.elapsed());
    store.optimize(table).await.expect("整理");

    let (p50_before, p95_before) = measure(&store, table, "无向量索引").await;

    let started = Instant::now();
    store.ensure_vector_index(table).await.expect("建索引");
    let build = started.elapsed();
    println!("建 IvfHnswSq 索引用时 {build:?}");

    let (p50_after, p95_after) = measure(&store, table, "有向量索引").await;

    println!(
        "结论:向量索引前 p50 {p50_before:.1} ms / p95 {p95_before:.1} ms;\
         后 p50 {p50_after:.1} ms / p95 {p95_after:.1} ms;建索引 {build:?}"
    );
    assert_eq!(store.count(table, None).await.expect("计数"), ROWS as u64);
}
