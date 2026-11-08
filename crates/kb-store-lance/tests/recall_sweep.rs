//! H3 手动探针(默认不跑):在真实表的**副本**上扫描向量检索的 ef / refine_factor / nprobes,
//! 以 `bypass_vector_index`(暴力扫描)的结果为标准答案,量召回、延迟和单次检索 CPU。
//!
//! 用法(只对副本跑,没有向量索引时会建一个,不要指向生产目录):
//! `KB_PROBE_LANCE_DIR=<含 xxx.lance 的目录> KB_PROBE_TABLE=<表名,不带 .lance> \
//!  cargo test -p kb-store-lance --test recall_sweep -- --ignored --nocapture`
//!
//! 两类查询:`mix` = 两条真实向量相加(库里没有现成的最近邻);
//! `row` = 取一条真实向量当查询,标准答案和候选里都去掉它自己(否则最近邻恒为自己,召回虚高)。

use arrow_array::{Array, FixedSizeListArray, Float32Array, RecordBatch, StringArray};
use futures::TryStreamExt;
use kb_core::ports::VectorStore;
use kb_store_lance::{COL_VECTOR, LanceStore};
use lancedb::DistanceType;
use lancedb::index::IndexType;
use lancedb::query::{ExecutableQuery, QueryBase, Select};
use std::time::Instant;

fn cpu_ms() -> u64 {
    let stat = std::fs::read_to_string("/proc/self/stat").unwrap_or_default();
    let rest = stat.rsplit_once(')').map(|(_, rest)| rest).unwrap_or("");
    let fields: Vec<&str> = rest.split_whitespace().collect();
    let utime: u64 = fields.get(11).and_then(|v| v.parse().ok()).unwrap_or(0);
    let stime: u64 = fields.get(12).and_then(|v| v.parse().ok()).unwrap_or(0);
    (utime + stime) * 10
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() as f64 - 1.0) * q).round() as usize]
}

/// (id, 向量)
fn rows_of(batches: &[RecordBatch]) -> Vec<(String, Vec<f32>)> {
    let mut out = Vec::new();
    for batch in batches {
        let (Some(ids), Some(vectors)) = (
            batch
                .column_by_name("id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>()),
            batch
                .column_by_name(COL_VECTOR)
                .and_then(|c| c.as_any().downcast_ref::<FixedSizeListArray>()),
        ) else {
            continue;
        };
        for index in 0..batch.num_rows() {
            let value = vectors.value(index);
            if let Some(floats) = value.as_any().downcast_ref::<Float32Array>() {
                out.push((ids.value(index).to_owned(), floats.values().to_vec()));
            }
        }
    }
    out
}

fn ids_of(batches: &[RecordBatch]) -> Vec<String> {
    let mut out = Vec::new();
    for batch in batches {
        if let Some(ids) = batch
            .column_by_name("id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
        {
            out.extend((0..ids.len()).map(|i| ids.value(i).to_owned()));
        }
    }
    out
}

#[derive(Clone, Copy)]
struct Knobs {
    ef: Option<usize>,
    refine: Option<u32>,
    nprobes: Option<usize>,
    exact: bool,
}

/// 一次向量检索,返回前 `take` 个 id(去掉 `skip` 这个 id)。
async fn search(
    table: &lancedb::Table,
    vector: &[f32],
    knobs: Knobs,
    skip: Option<&str>,
    take: usize,
) -> Vec<String> {
    let mut query = table
        .query()
        .nearest_to(vector.to_vec())
        .expect("nearest_to")
        .distance_type(DistanceType::Cosine)
        .select(Select::columns(&["id"]))
        // 与生产一致:k = 8,每个集合取 k * 3;再多取 1 条,留给去掉自身
        .limit(24 + 1);
    if let Some(ef) = knobs.ef {
        query = query.ef(ef);
    }
    if let Some(refine) = knobs.refine {
        query = query.refine_factor(refine);
    }
    if let Some(nprobes) = knobs.nprobes {
        query = query.nprobes(nprobes);
    }
    if knobs.exact {
        query = query.bypass_vector_index();
    }
    let batches = query
        .execute()
        .await
        .expect("检索")
        .try_collect::<Vec<_>>()
        .await
        .expect("读结果");
    ids_of(&batches)
        .into_iter()
        .filter(|id| Some(id.as_str()) != skip)
        .take(take)
        .collect()
}

struct Case {
    vector: Vec<f32>,
    skip: Option<String>,
}

async fn measure(
    table: &lancedb::Table,
    cases: &[Case],
    knobs: Knobs,
    truth: &[Vec<String>],
) -> (f64, f64, f64, f64) {
    let cpu_before = cpu_ms();
    let mut times = Vec::new();
    let (mut hit, mut total) = (0usize, 0usize);
    for (case, expected) in cases.iter().zip(truth) {
        let started = Instant::now();
        let got = search(table, &case.vector, knobs, case.skip.as_deref(), 10).await;
        times.push(started.elapsed().as_secs_f64() * 1000.0);
        hit += expected.iter().filter(|id| got.contains(id)).count();
        total += expected.len();
    }
    let cpu_each = (cpu_ms() - cpu_before) as f64 / cases.len() as f64;
    times.sort_by(|a, b| a.total_cmp(b));
    (
        hit as f64 / total.max(1) as f64,
        percentile(&times, 0.5),
        percentile(&times, 0.95),
        cpu_each,
    )
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "手动探针:需要 KB_PROBE_LANCE_DIR / KB_PROBE_TABLE 指向真实表的副本"]
async fn sweep_vector_query_knobs_on_a_real_table_copy() {
    let (Ok(dir), Ok(name)) = (
        std::env::var("KB_PROBE_LANCE_DIR"),
        std::env::var("KB_PROBE_TABLE"),
    ) else {
        return;
    };
    let store = LanceStore::connect(dir).await.expect("连接");
    let rows = store.count(&name, None).await.expect("计数");
    let table = store
        .connection()
        .open_table(name.clone())
        .execute()
        .await
        .expect("打开表");

    let has_vector_index = table
        .list_indices()
        .await
        .expect("列索引")
        .iter()
        .any(|index| {
            matches!(
                index.index_type,
                IndexType::IvfHnswSq | IndexType::IvfHnswPq | IndexType::IvfHnswFlat
            )
        });
    if !has_vector_index {
        let started = Instant::now();
        store.ensure_vector_index(&name).await.expect("建向量索引");
        println!(
            "SWEEP built index in {:.1}s",
            started.elapsed().as_secs_f64()
        );
    } else {
        println!("SWEEP index already present");
    }
    let table = store
        .connection()
        .open_table(name.clone())
        .execute()
        .await
        .expect("重新打开表");

    // 从表的不同位置各取一小段,凑出查询用的真实向量
    let mut pool = Vec::new();
    for slot in 0..7u64 {
        let offset = (rows * slot / 7) as usize;
        let batches = table
            .query()
            .select(Select::columns(&["id", COL_VECTOR]))
            .limit(20)
            .offset(offset)
            .execute()
            .await
            .expect("取向量")
            .try_collect::<Vec<_>>()
            .await
            .expect("读向量");
        pool.extend(rows_of(&batches));
    }
    assert!(pool.len() >= 100, "取到的向量太少:{}", pool.len());

    let mix: Vec<Case> = (0..100usize)
        .map(|k| {
            let a = &pool[k].1;
            let b = &pool[(k * 7 + 3) % pool.len()].1;
            Case {
                vector: a.iter().zip(b).map(|(x, y)| x + y).collect(),
                skip: None,
            }
        })
        .collect();
    let row: Vec<Case> = (0..100usize)
        .map(|k| Case {
            vector: pool[k].1.clone(),
            skip: Some(pool[k].0.clone()),
        })
        .collect();

    let exact = Knobs {
        ef: None,
        refine: None,
        nprobes: None,
        exact: true,
    };
    let mut truth_mix = Vec::new();
    for case in &mix {
        truth_mix.push(search(&table, &case.vector, exact, None, 10).await);
    }
    let mut truth_row = Vec::new();
    for case in &row {
        truth_row.push(search(&table, &case.vector, exact, case.skip.as_deref(), 10).await);
    }
    // 预热
    let _ = measure(&table, &mix[..10], exact, &truth_mix[..10]).await;

    println!("SWEEP rows={rows} dim={}", pool[0].1.len());
    let (_, p50, p95, cpu) = measure(&table, &mix, exact, &truth_mix).await;
    println!("SWEEP exact(bypass)  p50={p50:.1}ms p95={p95:.1}ms cpu/query={cpu:.0}ms");

    let grid: [(Option<usize>, Option<u32>, Option<usize>); 10] = [
        (None, None, None),
        (Some(48), None, None),
        (Some(100), None, None),
        (Some(200), None, None),
        (None, Some(2), None),
        (None, Some(5), None),
        (Some(100), Some(2), None),
        // ef 必须不小于 候选数(limit × refine_factor),所以 refine=10 时不单独指定 ef
        (None, Some(10), None),
        (Some(200), Some(5), None),
        (Some(200), Some(5), Some(40)),
    ];
    for (ef, refine, nprobes) in grid {
        let knobs = Knobs {
            ef,
            refine,
            nprobes,
            exact: false,
        };
        let (r_mix, p50, p95, cpu) = measure(&table, &mix, knobs, &truth_mix).await;
        let (r_row, _, _, _) = measure(&table, &row, knobs, &truth_row).await;
        println!(
            "SWEEP ef={ef:?} refine={refine:?} nprobes={nprobes:?} | recall mix={r_mix:.4} row={r_row:.4} | p50={p50:.1}ms p95={p95:.1}ms cpu/query={cpu:.0}ms"
        );
    }
}

/// 混合检索(全文 + 向量,生产实际走的路径)的召回:
/// `KB_PROBE_FLAT_DIR` 指向**没有向量索引**的表副本(标准答案),`KB_PROBE_LANCE_DIR` 指向建了索引的副本。
/// 两边都走 `LanceStore::search`,所以带着生产的精排倍数。
#[tokio::test(flavor = "multi_thread")]
#[ignore = "手动探针:需要 KB_PROBE_FLAT_DIR / KB_PROBE_LANCE_DIR / KB_PROBE_TABLE"]
async fn hybrid_recall_flat_vs_indexed_through_the_store() {
    use kb_core::Filter;
    use kb_core::model::{SearchMode, StoreQuery};
    let (Ok(flat_dir), Ok(index_dir), Ok(name)) = (
        std::env::var("KB_PROBE_FLAT_DIR"),
        std::env::var("KB_PROBE_LANCE_DIR"),
        std::env::var("KB_PROBE_TABLE"),
    ) else {
        return;
    };
    let flat = LanceStore::connect(flat_dir).await.expect("连接(无索引)");
    let indexed = LanceStore::connect(index_dir).await.expect("连接(有索引)");
    let rows = indexed.count(&name, None).await.expect("计数");
    let table = indexed
        .connection()
        .open_table(name.clone())
        .execute()
        .await
        .expect("打开表");
    let mut pool = Vec::new();
    for slot in 0..7u64 {
        let batches = table
            .query()
            .select(Select::columns(&["id", COL_VECTOR]))
            .limit(20)
            .offset((rows * slot / 7) as usize)
            .execute()
            .await
            .expect("取向量")
            .try_collect::<Vec<_>>()
            .await
            .expect("读向量");
        pool.extend(rows_of(&batches));
    }
    let words = [
        "用户", "营养", "订单", "接口", "配置", "数据", "页面", "权限",
    ];
    let queries: Vec<StoreQuery> = (0..100usize)
        .map(|k| {
            let a = &pool[k].1;
            let b = &pool[(k * 7 + 3) % pool.len()].1;
            StoreQuery {
                mode: SearchMode::Hybrid,
                text: Some(words[k % words.len()].to_owned()),
                vector: Some(a.iter().zip(b).map(|(x, y)| x + y).collect()),
                filter: Filter::default(),
                limit: 24,
                offset: 0,
                with_vector: false,
            }
        })
        .collect();

    let top10 = |hits: Vec<kb_core::model::StoreHit>| -> Vec<String> {
        hits.into_iter().take(10).map(|hit| hit.row.id).collect()
    };
    let _ = flat.search(&name, &queries[0]).await.expect("预热");
    let _ = indexed.search(&name, &queries[0]).await.expect("预热");

    let (mut hit, mut total) = (0usize, 0usize);
    let (mut flat_times, mut idx_times) = (Vec::new(), Vec::new());
    let (mut flat_cpu, mut idx_cpu) = (0u64, 0u64);
    for query in &queries {
        let c0 = cpu_ms();
        let t0 = Instant::now();
        let truth = top10(flat.search(&name, query).await.expect("无索引检索"));
        flat_times.push(t0.elapsed().as_secs_f64() * 1000.0);
        let c1 = cpu_ms();
        let t1 = Instant::now();
        let got = top10(indexed.search(&name, query).await.expect("有索引检索"));
        idx_times.push(t1.elapsed().as_secs_f64() * 1000.0);
        let c2 = cpu_ms();
        flat_cpu += c1 - c0;
        idx_cpu += c2 - c1;
        hit += truth.iter().filter(|id| got.contains(id)).count();
        total += truth.len();
    }
    flat_times.sort_by(|a, b| a.total_cmp(b));
    idx_times.sort_by(|a, b| a.total_cmp(b));
    println!(
        "HYBRID recall@10={:.4} | flat p50={:.1}ms p95={:.1}ms cpu/query={}ms | indexed p50={:.1}ms p95={:.1}ms cpu/query={}ms",
        hit as f64 / total.max(1) as f64,
        percentile(&flat_times, 0.5),
        percentile(&flat_times, 0.95),
        flat_cpu / queries.len() as u64,
        percentile(&idx_times, 0.5),
        percentile(&idx_times, 0.95),
        idx_cpu / queries.len() as u64,
    );
}
