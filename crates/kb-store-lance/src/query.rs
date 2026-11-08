//! 查询构造与结果解析(设计规范)。
//!
//! 过滤条件**只能**来自 [`kb_core::Filter::to_sql`];这里不拼接任何外部输入。

use arrow_array::{Array, Float32Array, RecordBatch};
use futures::TryStreamExt;
use kb_core::KbError;
use kb_core::Result;
use kb_core::model::{ListQuery, SearchMode, StoreHit, StoreQuery};
use lancedb::DistanceType;
use lancedb::index::scalar::FullTextSearchQuery;
use lancedb::query::{ColumnOrdering, ExecutableQuery, QueryBase, Select};

use crate::convert::batch_to_rows;
use crate::schema::{
    COL_LEX, SCORE_DISTANCE, SCORE_FTS, SCORE_RELEVANCE, non_vector_columns, slice_columns,
};
use crate::schema::{PENDING_FILTER, READY_FILTER};

/// 向量检索的精排倍数:用量化向量先取 `limit × 10` 个候选,再用原始向量重排取前 `limit`。
///
/// 向量索引(IVF-HNSW-SQ)把向量压成 8 位整数,默认只看压缩后的距离,召回会掉。
/// 13.6 万行 × 1024 维的真实表上实测(召回@10,两向量相加这组较难的查询):
/// 默认 0.778,倍数 5 → 0.932,倍数 10 → 0.966;单次检索 p50 4.0 → 7.5 毫秒(暴力扫描 247 毫秒),
/// 单次 CPU 6 → 11 毫秒(暴力扫描约 1000 毫秒)。没有向量索引时这个参数不起作用。
const VECTOR_REFINE_FACTOR: u32 = 10;

/// 该模式下的分数列名。
pub fn score_column(mode: SearchMode) -> &'static str {
    match mode {
        SearchMode::Vector => SCORE_DISTANCE,
        SearchMode::Fts => SCORE_FTS,
        SearchMode::Hybrid => SCORE_RELEVANCE,
    }
}

/// 把调用方的过滤条件与存储层内部条件用 AND 合并。
///
/// 两边都不来自外部原始字符串:调用方是 [`kb_core::Filter::to_sql`],内部条件是常量。
fn combine_filter(filter: Option<String>, extra: Option<&str>) -> Option<String> {
    match (filter, extra) {
        (Some(filter), Some(extra)) => Some(format!("({filter}) AND ({extra})")),
        (Some(filter), None) => Some(filter),
        (None, Some(extra)) => Some(extra.to_owned()),
        (None, None) => None,
    }
}

/// 执行一次存储层查询,返回原始 Arrow 结果。
///
/// `extra` 只由存储层内部传入(当前是 `embed_state` 条件),不会拼接调用方原始输入。
pub async fn run_query(
    table: &lancedb::Table,
    req: &StoreQuery,
    extra: Option<&str>,
) -> Result<Vec<RecordBatch>> {
    let filter = combine_filter(req.filter.to_sql()?, extra);
    let text = || -> Result<String> {
        req.text
            .clone()
            .ok_or_else(|| KbError::InvalidInput("全文检索需要 text".to_owned()))
    };
    let vector = || -> Result<Vec<f32>> {
        req.vector
            .clone()
            .ok_or_else(|| KbError::InvalidInput("向量检索需要 vector".to_owned()))
    };

    let batches = match req.mode {
        SearchMode::Vector => {
            let mut query = table
                .query()
                .nearest_to(vector()?)
                .map_err(lance_error)?
                .distance_type(DistanceType::Cosine)
                .refine_factor(VECTOR_REFINE_FACTOR);
            if let Some(filter) = &filter {
                query = query.only_if(filter);
            }
            query
                .limit(req.limit)
                .offset(req.offset)
                .execute()
                .await
                .map_err(lance_error)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(lance_error)?
        }
        SearchMode::Fts => {
            let fts = FullTextSearchQuery::new(text()?)
                .with_column(COL_LEX.to_owned())
                .map_err(lance_error)?;
            let mut query = table.query().full_text_search(fts);
            if let Some(filter) = &filter {
                query = query.only_if(filter);
            }
            query
                .limit(req.limit)
                .offset(req.offset)
                .execute()
                .await
                .map_err(lance_error)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(lance_error)?
        }
        SearchMode::Hybrid => {
            let fts = FullTextSearchQuery::new(text()?)
                .with_column(COL_LEX.to_owned())
                .map_err(lance_error)?;
            let mut query = table
                .query()
                .full_text_search(fts)
                .nearest_to(vector()?)
                .map_err(lance_error)?
                .distance_type(DistanceType::Cosine)
                .refine_factor(VECTOR_REFINE_FACTOR);
            if let Some(filter) = &filter {
                query = query.only_if(filter);
            }
            query
                .limit(req.limit)
                .offset(req.offset)
                .execute()
                .await
                .map_err(lance_error)?
                .try_collect::<Vec<_>>()
                .await
                .map_err(lance_error)?
        }
    };
    Ok(batches)
}

/// 取等待嵌入的块(含正文),供文本阶段之后的补向量队列使用。
///
/// 只取 `embed_state = 'pending'` 的行,过滤条件仍走 `Filter::to_sql`,与正常检索同一套白名单。
pub async fn run_pending(
    table: &lancedb::Table,
    filter: Option<String>,
    limit: usize,
) -> Result<Vec<RecordBatch>> {
    let filter = combine_filter(filter, Some(PENDING_FILTER));
    let mut query = table.query().select(Select::columns(non_vector_columns()));
    if let Some(filter) = filter {
        query = query.only_if(filter);
    }
    query
        .limit(limit)
        .execute()
        .await
        .map_err(lance_error)?
        .try_collect::<Vec<_>>()
        .await
        .map_err(lance_error)
}

/// 向量检索 / 混合检索要看 `embed_state`,纯全文检索不据此过滤:
/// 文本阶段已经把行写进全文索引,pending 行必须能被 FTS 检索到。
pub fn state_filter(mode: SearchMode) -> Option<&'static str> {
    match mode {
        SearchMode::Vector | SearchMode::Hybrid => Some(READY_FILTER),
        SearchMode::Fts => None,
    }
}

/// 执行一次列表查询(不算分,只按白名单列排序后分页; 的 `list_items`)。
///
/// 排序列来自 [`ListQuery::COLUMNS`],过滤表达式来自 `Filter::to_sql`,
/// 这里不拼接任何调用方原始输入。
pub async fn run_list(table: &lancedb::Table, query: &ListQuery) -> Result<Vec<RecordBatch>> {
    if !ListQuery::COLUMNS.contains(&query.order_by.as_str()) {
        return Err(KbError::InvalidInput(format!(
            "排序列不在白名单内: {}",
            query.order_by
        )));
    }
    let ordering = if query.ascending {
        ColumnOrdering::asc_nulls_last(query.order_by.clone())
    } else {
        ColumnOrdering::desc_nulls_last(query.order_by.clone())
    };
    // 老表可能还没有 `anchor` / `embed_state`:只选实际存在的列,升级前也能列表。
    let schema = table.schema().await.map_err(lance_error)?;
    let columns: Vec<&str> = non_vector_columns()
        .iter()
        .copied()
        .filter(|name| schema.field_with_name(name).is_ok())
        .collect();
    let mut builder = table
        .query()
        .select(Select::columns(&columns))
        .order_by(Some(vec![ordering]));
    if let Some(filter) = &query.filter {
        builder = builder.only_if(filter);
    }
    builder
        .limit(query.limit)
        .offset(query.offset)
        .execute()
        .await
        .map_err(lance_error)?
        .try_collect::<Vec<_>>()
        .await
        .map_err(lance_error)
}

/// 文件级列表用的扫描:只读 [`slice_columns`],一次取回满足过滤条件的全部块。
///
/// 上限用同一过滤条件的计数:不写上限时 Lance 的默认行为取决于版本,写死一个数又怕截断。
/// 计数和扫描之间有新写入的话,多出来的几行这次看不到,下一次刷新就有了。
pub async fn run_slices(table: &lancedb::Table, filter: Option<&str>) -> Result<Vec<RecordBatch>> {
    let total = table
        .count_rows(filter.map(str::to_owned))
        .await
        .map_err(lance_error)?;
    if total == 0 {
        return Ok(Vec::new());
    }
    let mut builder = table.query().select(Select::columns(slice_columns()));
    if let Some(filter) = filter {
        builder = builder.only_if(filter);
    }
    builder
        .limit(total)
        .execute()
        .await
        .map_err(lance_error)?
        .try_collect::<Vec<_>>()
        .await
        .map_err(lance_error)
}

/// 把查询结果转成 [`StoreHit`],并算出统一口径的分数。
///
/// - 向量模式:`score = 1 - _distance`(Cosine 距离);
/// - 全文模式:`score = _score`(BM25);
/// - 混合模式:`score = _relevance_score`(LanceDB 的 RRF 融合分数)。
pub fn to_hits(batches: &[RecordBatch], req: &StoreQuery) -> Result<Vec<StoreHit>> {
    let score_column = score_column(req.mode);
    let mut hits = Vec::new();
    for batch in batches {
        // 混合查询在过滤后没有命中时,返回的 batch 可能是 0 行、且没有任何列
        if batch.num_rows() == 0 {
            continue;
        }
        let rows = batch_to_rows(batch, req.with_vector)?;
        let scores = batch
            .column_by_name(score_column)
            .and_then(|column| column.as_any().downcast_ref::<Float32Array>());
        for (index, row) in rows.into_iter().enumerate() {
            let raw = scores
                .filter(|scores| !scores.is_null(index))
                .map(|scores| scores.value(index))
                .unwrap_or(0.0);
            let score = match req.mode {
                SearchMode::Vector => 1.0 - raw,
                SearchMode::Fts | SearchMode::Hybrid => raw,
            };
            hits.push(StoreHit {
                row,
                score,
                rank: hits.len() + 1,
            });
        }
    }
    Ok(hits)
}

/// LanceDB / Lance 的错误统一映射成 [`KbError::Internal`](参数问题在上层已经校验过)。
fn lance_error(err: impl std::fmt::Display) -> KbError {
    KbError::Internal(format!("lancedb: {err}"))
}
