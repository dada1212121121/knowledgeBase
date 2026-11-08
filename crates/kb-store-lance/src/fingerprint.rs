//! 块指纹列表:一致性校验用的瘦扫描(只读 id / source / 两个内容哈希 / updated_at)。
//!
//! 独立成文件,避免和 `lib.rs` 里 optimize 的改动互相冲突;写法与 `query::run_slices` 一致。

use arrow_array::{Array, Int64Array, RecordBatch, StringArray};
use futures::TryStreamExt;
use kb_core::model::ChunkFingerprint;
use kb_core::{KbError, Result};
use lancedb::query::{ExecutableQuery, QueryBase, Select};

use crate::lance_error;
use crate::schema::{
    COL_CONTENT_HASH, COL_EMBED_INPUT_HASH, COL_EMBED_STATE, COL_ID, COL_SOURCE, COL_UPDATED_AT,
};

/// 指纹扫描只读这几列:十几万块的表也不会把正文和 1024 维向量读出来再丢掉。
///
/// `embed_state` 只有升级后的表才有:旧表不读这一列,返回的指纹里状态为 `None`。
fn fingerprint_columns(include_state: bool) -> Vec<&'static str> {
    let mut columns = vec![
        COL_ID,
        COL_SOURCE,
        COL_CONTENT_HASH,
        COL_EMBED_INPUT_HASH,
        COL_UPDATED_AT,
    ];
    if include_state {
        columns.push(COL_EMBED_STATE);
    }
    columns
}

/// 一次取回满足过滤条件的全部块指纹。
///
/// 上限用同一过滤条件的计数(与 `run_slices` 相同的理由:不写上限时默认行为取决于 Lance 版本,
/// 写死一个数又怕截断)。计数与扫描之间有新写入的话,多出来的几行这次看不到;
/// 校验是在持独占闸门时跑的,期间没有索引写入,所以不会因此误报。
pub async fn run_fingerprints(
    table: &lancedb::Table,
    filter: Option<&str>,
    include_state: bool,
) -> Result<Vec<ChunkFingerprint>> {
    let total = table
        .count_rows(filter.map(str::to_owned))
        .await
        .map_err(lance_error)?;
    if total == 0 {
        return Ok(Vec::new());
    }
    let columns = fingerprint_columns(include_state);
    let mut builder = table.query().select(Select::columns(&columns));
    if let Some(filter) = filter {
        builder = builder.only_if(filter);
    }
    let batches = builder
        .limit(total)
        .execute()
        .await
        .map_err(lance_error)?
        .try_collect::<Vec<_>>()
        .await
        .map_err(lance_error)?;
    let mut out = Vec::with_capacity(total);
    for batch in &batches {
        out.extend(batch_to_fingerprints(batch)?);
    }
    Ok(out)
}

/// 把只含 [`fingerprint_columns`] 的一批数据还原成指纹。
fn batch_to_fingerprints(batch: &RecordBatch) -> Result<Vec<ChunkFingerprint>> {
    let strings = |name: &str| -> Result<&StringArray> {
        batch
            .column_by_name(name)
            .and_then(|column| column.as_any().downcast_ref::<StringArray>())
            .ok_or_else(|| KbError::Internal(format!("结果缺少字符串列 {name}")))
    };
    let ids = strings(COL_ID)?;
    let sources = strings(COL_SOURCE)?;
    let content_hashes = strings(COL_CONTENT_HASH)?;
    let embed_hashes = strings(COL_EMBED_INPUT_HASH)?;
    let updated_ats = batch
        .column_by_name(COL_UPDATED_AT)
        .and_then(|column| column.as_any().downcast_ref::<Int64Array>())
        .ok_or_else(|| KbError::Internal(format!("结果缺少 Int64 列 {COL_UPDATED_AT}")))?;
    let states = batch
        .column_by_name(COL_EMBED_STATE)
        .and_then(|column| column.as_any().downcast_ref::<StringArray>());
    let mut out = Vec::with_capacity(batch.num_rows());
    for index in 0..batch.num_rows() {
        out.push(ChunkFingerprint {
            id: ids.value(index).to_owned(),
            source: sources.value(index).to_owned(),
            // 哈希列在 schema 里不可空;万一旧表里有空值,当作空串(对账时一定判成不一致,宁可多修一次)
            content_hash: nullable_string(content_hashes, index),
            embed_input_hash: nullable_string(embed_hashes, index),
            updated_at: updated_ats.value(index),
            // 旧表没有 embed_state 列(前面按 schema 裁过),这里保持 None;新表里的 NULL 也是 ready
            embed_state: states.and_then(|states| {
                (!states.is_null(index)).then(|| states.value(index).to_owned())
            }),
        });
    }
    Ok(out)
}

fn nullable_string(array: &StringArray, index: usize) -> String {
    if array.is_null(index) {
        String::new()
    } else {
        array.value(index).to_owned()
    }
}
