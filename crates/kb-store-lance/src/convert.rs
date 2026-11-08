//! `RecordRow` 与 Arrow `RecordBatch` 的互转（设计规范）。

use std::sync::Arc;

use arrow_array::types::Float32Type;
use arrow_array::{
    Array, ArrayRef, FixedSizeListArray, Float32Array, Int32Array, Int64Array, RecordBatch,
    StringArray,
};
use arrow_schema::{DataType, SchemaRef};
use kb_core::model::{FileSlice, ItemStatus, MetaPatch, RecordKind, RecordRow};
use kb_core::{KbError, Result};

use crate::schema::{
    COL_ANCHOR, COL_COLLECTION, COL_CONTENT_HASH, COL_EMBED_INPUT_HASH, COL_EMBED_STATE,
    COL_END_LINE, COL_HEADER, COL_ID, COL_KIND, COL_LANG, COL_LEX, COL_META_HASH, COL_SOURCE,
    COL_START_LINE, COL_STATUS, COL_SYMBOL, COL_TAGS, COL_TEXT, COL_TITLE, COL_UPDATED_AT,
    COL_VECTOR,
};

/// 标签列编码:`,a,b,`;没有标签时为空字符串。
pub fn encode_tags(tags: &[String]) -> String {
    if tags.is_empty() {
        String::new()
    } else {
        format!(",{},", tags.join(","))
    }
}

/// 标签列解码。
pub fn decode_tags(raw: &str) -> Vec<String> {
    raw.trim_matches(',')
        .split(',')
        .filter(|tag| !tag.is_empty())
        .map(str::to_owned)
        .collect()
}

/// 把记录转成一批 Arrow 数据。
pub fn rows_to_batch(rows: &[RecordRow], schema: SchemaRef) -> Result<RecordBatch> {
    let dim = vector_dim(&schema)?;
    let mut ids = Vec::with_capacity(rows.len());
    let mut collections = Vec::with_capacity(rows.len());
    let mut kinds = Vec::with_capacity(rows.len());
    let mut langs: Vec<Option<String>> = Vec::with_capacity(rows.len());
    let mut sources = Vec::with_capacity(rows.len());
    let mut start_lines: Vec<Option<i32>> = Vec::with_capacity(rows.len());
    let mut end_lines: Vec<Option<i32>> = Vec::with_capacity(rows.len());
    let mut symbols: Vec<Option<String>> = Vec::with_capacity(rows.len());
    let mut titles: Vec<Option<String>> = Vec::with_capacity(rows.len());
    let mut texts = Vec::with_capacity(rows.len());
    let mut headers = Vec::with_capacity(rows.len());
    let mut lexes = Vec::with_capacity(rows.len());
    let mut tags = Vec::with_capacity(rows.len());
    let mut statuses = Vec::with_capacity(rows.len());
    let mut content_hashes = Vec::with_capacity(rows.len());
    let mut meta_hashes = Vec::with_capacity(rows.len());
    let mut embed_input_hashes = Vec::with_capacity(rows.len());
    let mut updated_ats = Vec::with_capacity(rows.len());
    let mut anchors: Vec<Option<String>> = Vec::with_capacity(rows.len());
    // 这是这次写入的意图,不看旧行:None 就是「文本已写好、向量还没补」。
    // 老表补出来的 embed_state 是 NULL,和 ready 等价;新写入一律落明确值。
    let mut embed_states = Vec::with_capacity(rows.len());
    let mut vectors: Vec<Option<Vec<Option<f32>>>> = Vec::with_capacity(rows.len());

    for row in rows {
        ids.push(row.id.clone());
        collections.push(row.collection.clone());
        kinds.push(row.kind.as_str().to_owned());
        langs.push(row.lang.clone());
        sources.push(row.source.clone());
        start_lines.push(row.start_line);
        end_lines.push(row.end_line);
        symbols.push(row.symbol.clone());
        titles.push(row.title.clone());
        texts.push(row.text.clone());
        headers.push(row.header.clone());
        lexes.push(row.lex.clone());
        tags.push(encode_tags(&row.tags));
        statuses.push(row.status.as_str().to_owned());
        content_hashes.push(row.content_hash.clone());
        meta_hashes.push(row.meta_hash.clone());
        embed_input_hashes.push(row.embed_input_hash.clone());
        updated_ats.push(row.updated_at);
        anchors.push(
            row.anchor
                .as_ref()
                .and_then(|anchor| serde_json::to_string(anchor).ok()),
        );
        embed_states.push(if row.vector.is_some() {
            "ready"
        } else {
            "pending"
        });
        match &row.vector {
            Some(vector) if vector.len() == dim => {
                vectors.push(Some(vector.iter().map(|value| Some(*value)).collect()));
            }
            Some(vector) => {
                return Err(KbError::InvalidInput(format!(
                    "记录 {} 的向量维度是 {},表要求 {dim}",
                    row.id,
                    vector.len()
                )));
            }
            None => vectors.push(None),
        }
    }

    let vector_array = FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
        vectors,
        i32::try_from(dim).map_err(|_| KbError::Internal(format!("向量维度过大: {dim}")))?,
    );

    // 按列名而不是固定顺序组装:旧表补 `anchor` / `embed_state` 时 Lance 会把新列
    // 追加到 `vector` 之后,与新建表的 schema 顺序不同。按名字取数组才能让升级后的
    // 老表继续接受新写入,否则 `RecordBatch::try_new` 会在 vector 列上类型不匹配。
    let columns: Vec<(&str, ArrayRef)> = vec![
        (COL_ID, Arc::new(StringArray::from(ids))),
        (COL_COLLECTION, Arc::new(StringArray::from(collections))),
        (COL_KIND, Arc::new(StringArray::from(kinds))),
        (COL_LANG, Arc::new(StringArray::from(langs))),
        (COL_SOURCE, Arc::new(StringArray::from(sources))),
        (COL_START_LINE, Arc::new(Int32Array::from(start_lines))),
        (COL_END_LINE, Arc::new(Int32Array::from(end_lines))),
        (COL_SYMBOL, Arc::new(StringArray::from(symbols))),
        (COL_TITLE, Arc::new(StringArray::from(titles))),
        (COL_TEXT, Arc::new(StringArray::from(texts))),
        (COL_HEADER, Arc::new(StringArray::from(headers))),
        (COL_LEX, Arc::new(StringArray::from(lexes))),
        (COL_TAGS, Arc::new(StringArray::from(tags))),
        (COL_STATUS, Arc::new(StringArray::from(statuses))),
        (
            COL_CONTENT_HASH,
            Arc::new(StringArray::from(content_hashes)),
        ),
        (COL_META_HASH, Arc::new(StringArray::from(meta_hashes))),
        (
            COL_EMBED_INPUT_HASH,
            Arc::new(StringArray::from(embed_input_hashes)),
        ),
        (COL_UPDATED_AT, Arc::new(Int64Array::from(updated_ats))),
        (COL_ANCHOR, Arc::new(StringArray::from(anchors))),
        (COL_EMBED_STATE, Arc::new(StringArray::from(embed_states))),
        (COL_VECTOR, Arc::new(vector_array)),
    ];
    let by_name: std::collections::HashMap<&str, ArrayRef> = columns.into_iter().collect();
    let mut ordered = Vec::with_capacity(schema.fields().len());
    for field in schema.fields() {
        let array = by_name.get(field.name().as_str()).ok_or_else(|| {
            KbError::Internal(format!(
                "构造 RecordBatch 失败: schema 缺少列 {}",
                field.name()
            ))
        })?;
        ordered.push(Arc::clone(array));
    }

    RecordBatch::try_new(schema, ordered)
        .map_err(|err| KbError::Internal(format!("构造 RecordBatch 失败: {err}")))
}

/// 补丁涉及哪些列(固定顺序,用作批量提交的分组键)。
pub fn patch_shapes(patch: &MetaPatch) -> Vec<&'static str> {
    let mut columns = Vec::new();
    if patch.start_line.is_some() {
        columns.push(COL_START_LINE);
    }
    if patch.end_line.is_some() {
        columns.push(COL_END_LINE);
    }
    if patch.title.is_some() {
        columns.push(COL_TITLE);
    }
    if patch.symbol.is_some() {
        columns.push(COL_SYMBOL);
    }
    if patch.tags.is_some() {
        columns.push(COL_TAGS);
    }
    if patch.status.is_some() {
        columns.push(COL_STATUS);
    }
    if patch.meta_hash.is_some() {
        columns.push(COL_META_HASH);
    }
    if patch.source.is_some() {
        columns.push(COL_SOURCE);
    }
    if patch.header.is_some() {
        columns.push(COL_HEADER);
    }
    if patch.lex.is_some() {
        columns.push(COL_LEX);
    }
    if patch.embed_input_hash.is_some() {
        columns.push(COL_EMBED_INPUT_HASH);
    }
    if patch.updated_at.is_some() {
        columns.push(COL_UPDATED_AT);
    }
    columns
}

/// 把形状相同的一批元数据补丁拼成一个只含 `id` + 这些列的 Arrow 批次。
///
/// 源批次只带 `id` + 补丁涉及的列:存储层按这些列去找命中行、补齐其余列,
/// 一批补丁因此只产生一次提交、一个碎片。
pub fn patches_to_batch(
    updates: &[(String, MetaPatch)],
    columns: &[&'static str],
    schema: &SchemaRef,
) -> Result<RecordBatch> {
    let id_field = schema
        .field_with_name(COL_ID)
        .map_err(|err| KbError::Internal(format!("表结构缺少 {COL_ID}: {err}")))?
        .clone();
    let mut fields = vec![id_field];
    let mut arrays: Vec<ArrayRef> = vec![Arc::new(StringArray::from(
        updates.iter().map(|(id, _)| id.clone()).collect::<Vec<_>>(),
    ))];
    for column in columns {
        // 用表结构里的字段(类型与可空性照抄),merge_insert 才对得上目标列
        let field = schema
            .field_with_name(column)
            .map_err(|err| KbError::Internal(format!("表结构缺少 {column}: {err}")))?
            .clone();
        // 分组键保证这一列每条补丁都有值;缺了就是分组逻辑坏了,直接报错而不是写空值
        let missing = || KbError::Internal(format!("分组里的补丁缺少列 {column} 的值"));
        let array: ArrayRef = match *column {
            COL_START_LINE => Arc::new(Int32Array::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.start_line.ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_END_LINE => Arc::new(Int32Array::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.end_line.ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_UPDATED_AT => Arc::new(Int64Array::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.updated_at.ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_TAGS => Arc::new(StringArray::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.tags.as_deref().map(encode_tags).ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_STATUS => Arc::new(StringArray::from(
                updates
                    .iter()
                    .map(|(_, patch)| {
                        patch
                            .status
                            .map(|status| status.as_str().to_owned())
                            .ok_or_else(missing)
                    })
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_TITLE => Arc::new(StringArray::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.title.clone().ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_SYMBOL => Arc::new(StringArray::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.symbol.clone().ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_META_HASH => Arc::new(StringArray::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.meta_hash.clone().ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_SOURCE => Arc::new(StringArray::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.source.clone().ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_HEADER => Arc::new(StringArray::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.header.clone().ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_LEX => Arc::new(StringArray::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.lex.clone().ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            COL_EMBED_INPUT_HASH => Arc::new(StringArray::from(
                updates
                    .iter()
                    .map(|(_, patch)| patch.embed_input_hash.clone().ok_or_else(missing))
                    .collect::<Result<Vec<_>>>()?,
            )),
            other => {
                return Err(KbError::Internal(format!("补丁里没有列 {other}")));
            }
        };
        fields.push(field);
        arrays.push(array);
    }
    RecordBatch::try_new(Arc::new(arrow_schema::Schema::new(fields)), arrays)
        .map_err(|err| KbError::Internal(format!("构造补丁批次失败: {err}")))
}

/// 把一批 Arrow 数据还原成记录;`with_vector = false` 时忽略向量列。
pub fn batch_to_rows(batch: &RecordBatch, with_vector: bool) -> Result<Vec<RecordRow>> {
    let strings = |name: &str| -> Result<&StringArray> {
        batch
            .column_by_name(name)
            .and_then(|column| column.as_any().downcast_ref::<StringArray>())
            .ok_or_else(|| KbError::Internal(format!("结果缺少字符串列 {name}")))
    };
    let int32 = |name: &str| -> Result<&Int32Array> {
        batch
            .column_by_name(name)
            .and_then(|column| column.as_any().downcast_ref::<Int32Array>())
            .ok_or_else(|| KbError::Internal(format!("结果缺少 Int32 列 {name}")))
    };
    let int64 = |name: &str| -> Result<&Int64Array> {
        batch
            .column_by_name(name)
            .and_then(|column| column.as_any().downcast_ref::<Int64Array>())
            .ok_or_else(|| KbError::Internal(format!("结果缺少 Int64 列 {name}")))
    };

    let ids = strings(COL_ID)?;
    let collections = strings(COL_COLLECTION)?;
    let kinds = strings(COL_KIND)?;
    let langs = strings(COL_LANG)?;
    let sources = strings(COL_SOURCE)?;
    let start_lines = int32(COL_START_LINE)?;
    let end_lines = int32(COL_END_LINE)?;
    let symbols = strings(COL_SYMBOL)?;
    let titles = strings(COL_TITLE)?;
    let texts = strings(COL_TEXT)?;
    let headers = strings(COL_HEADER)?;
    let lexes = strings(COL_LEX)?;
    let tags = strings(COL_TAGS)?;
    let statuses = strings(COL_STATUS)?;
    let content_hashes = strings(COL_CONTENT_HASH)?;
    let meta_hashes = strings(COL_META_HASH)?;
    let embed_input_hashes = strings(COL_EMBED_INPUT_HASH)?;
    let updated_ats = int64(COL_UPDATED_AT)?;
    // 旧表可能还没有 anchor 列(ensure_table 会补上),读的时候容错
    let anchors = batch
        .column_by_name(COL_ANCHOR)
        .and_then(|column| column.as_any().downcast_ref::<StringArray>());
    let vectors = if with_vector {
        batch
            .column_by_name(COL_VECTOR)
            .and_then(|column| column.as_any().downcast_ref::<FixedSizeListArray>())
    } else {
        None
    };

    let mut rows = Vec::with_capacity(batch.num_rows());
    for index in 0..batch.num_rows() {
        rows.push(RecordRow {
            id: ids.value(index).to_owned(),
            collection: collections.value(index).to_owned(),
            kind: parse_kind(kinds.value(index))?,
            lang: opt_string(langs, index),
            source: sources.value(index).to_owned(),
            start_line: opt_i32(start_lines, index),
            end_line: opt_i32(end_lines, index),
            symbol: opt_string(symbols, index),
            title: opt_string(titles, index),
            text: texts.value(index).to_owned(),
            header: headers.value(index).to_owned(),
            lex: lexes.value(index).to_owned(),
            tags: decode_tags(tags.value(index)),
            status: parse_status(statuses.value(index))?,
            content_hash: content_hashes.value(index).to_owned(),
            meta_hash: meta_hashes.value(index).to_owned(),
            embed_input_hash: embed_input_hashes.value(index).to_owned(),
            updated_at: updated_ats.value(index),
            anchor: anchors.and_then(|array| {
                if array.is_null(index) {
                    return None;
                }
                serde_json::from_str(array.value(index)).ok()
            }),
            vector: vectors.and_then(|array| read_vector(array, index)),
        });
    }
    Ok(rows)
}

/// 把只含 [`crate::schema::slice_columns`] 的一批数据还原成瘦行。
pub fn batch_to_slices(batch: &RecordBatch) -> Result<Vec<FileSlice>> {
    let strings = |name: &str| -> Result<&StringArray> {
        batch
            .column_by_name(name)
            .and_then(|column| column.as_any().downcast_ref::<StringArray>())
            .ok_or_else(|| KbError::Internal(format!("结果缺少字符串列 {name}")))
    };
    let int32 = |name: &str| -> Result<&Int32Array> {
        batch
            .column_by_name(name)
            .and_then(|column| column.as_any().downcast_ref::<Int32Array>())
            .ok_or_else(|| KbError::Internal(format!("结果缺少 Int32 列 {name}")))
    };
    let int64 = |name: &str| -> Result<&Int64Array> {
        batch
            .column_by_name(name)
            .and_then(|column| column.as_any().downcast_ref::<Int64Array>())
            .ok_or_else(|| KbError::Internal(format!("结果缺少 Int64 列 {name}")))
    };
    let ids = strings(COL_ID)?;
    let collections = strings(COL_COLLECTION)?;
    let kinds = strings(COL_KIND)?;
    let langs = strings(COL_LANG)?;
    let sources = strings(COL_SOURCE)?;
    let start_lines = int32(COL_START_LINE)?;
    let end_lines = int32(COL_END_LINE)?;
    let symbols = strings(COL_SYMBOL)?;
    let titles = strings(COL_TITLE)?;
    let tags = strings(COL_TAGS)?;
    let statuses = strings(COL_STATUS)?;
    let updated_ats = int64(COL_UPDATED_AT)?;
    let mut out = Vec::with_capacity(batch.num_rows());
    for index in 0..batch.num_rows() {
        out.push(FileSlice {
            id: ids.value(index).to_owned(),
            collection: collections.value(index).to_owned(),
            kind: parse_kind(kinds.value(index))?,
            lang: opt_string(langs, index),
            source: sources.value(index).to_owned(),
            start_line: opt_i32(start_lines, index),
            end_line: opt_i32(end_lines, index),
            symbol: opt_string(symbols, index),
            title: opt_string(titles, index),
            tags: decode_tags(tags.value(index)),
            status: parse_status(statuses.value(index))?,
            updated_at: updated_ats.value(index),
        });
    }
    Ok(out)
}

fn opt_string(array: &StringArray, index: usize) -> Option<String> {
    (!array.is_null(index)).then(|| array.value(index).to_owned())
}

fn opt_i32(array: &Int32Array, index: usize) -> Option<i32> {
    (!array.is_null(index)).then(|| array.value(index))
}

fn read_vector(array: &FixedSizeListArray, index: usize) -> Option<Vec<f32>> {
    if array.is_null(index) {
        return None;
    }
    let values = array.value(index);
    let floats = values.as_any().downcast_ref::<Float32Array>()?;
    Some(floats.values().to_vec())
}

fn vector_dim(schema: &SchemaRef) -> Result<usize> {
    match schema
        .field_with_name(COL_VECTOR)
        .map(|field| field.data_type())
    {
        Ok(DataType::FixedSizeList(_, dim)) => {
            usize::try_from(*dim).map_err(|_| KbError::Internal(format!("向量维度非法: {dim}")))
        }
        _ => Err(KbError::Internal("schema 缺少 vector 列".to_owned())),
    }
}

fn parse_kind(value: &str) -> Result<RecordKind> {
    match value {
        "code" => Ok(RecordKind::Code),
        "doc" => Ok(RecordKind::Doc),
        "insight" => Ok(RecordKind::Insight),
        "external" => Ok(RecordKind::External),
        "summary" => Ok(RecordKind::Summary),
        other => Err(KbError::Internal(format!("未知的 kind: {other}"))),
    }
}

fn parse_status(value: &str) -> Result<ItemStatus> {
    match value {
        "active" => Ok(ItemStatus::Active),
        "superseded" => Ok(ItemStatus::Superseded),
        "deprecated" => Ok(ItemStatus::Deprecated),
        other => Err(KbError::Internal(format!("未知的 status: {other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::record_schema;

    fn row(id: &str, vector: Option<Vec<f32>>) -> RecordRow {
        RecordRow {
            id: id.to_owned(),
            collection: "proj_demo".to_owned(),
            kind: RecordKind::Code,
            lang: Some("rust".to_owned()),
            source: "src/lib.rs".to_owned(),
            start_line: Some(1),
            end_line: Some(10),
            symbol: Some("fn main".to_owned()),
            title: None,
            text: "fn main() {}".to_owned(),
            header: "demo › src/lib.rs › fn main".to_owned(),
            lex: "fn main".to_owned(),
            tags: vec!["决策".to_owned(), "a".to_owned()],
            status: ItemStatus::Active,
            content_hash: "0000000000000001".to_owned(),
            meta_hash: "0000000000000002".to_owned(),
            embed_input_hash: "0000000000000003".to_owned(),
            updated_at: 1_700_000_000_000,
            anchor: None,
            vector,
        }
    }

    #[test]
    fn tags_roundtrip_through_the_encoded_column() {
        assert_eq!(encode_tags(&[]), "");
        assert_eq!(encode_tags(&["a".to_owned()]), ",a,");
        assert_eq!(encode_tags(&["a".to_owned(), "b".to_owned()]), ",a,b,");
        assert!(decode_tags("").is_empty());
        assert_eq!(decode_tags(",a,b,"), ["a", "b"]);
        assert_eq!(decode_tags("决策"), ["决策"]);
    }

    #[test]
    fn rows_roundtrip_through_arrow() {
        let schema = record_schema(8).expect("schema");
        let rows = vec![row("a", Some(vec![0.1; 8])), row("b", None)];
        let batch = rows_to_batch(&rows, schema).expect("转 batch");
        assert_eq!(batch.num_rows(), 2);
        let back = batch_to_rows(&batch, true).expect("转回记录");
        assert_eq!(back, rows);
    }

    #[test]
    fn vector_can_be_skipped_on_read() {
        let schema = record_schema(8).expect("schema");
        let rows = vec![row("a", Some(vec![0.5; 8]))];
        let batch = rows_to_batch(&rows, schema).expect("转 batch");
        let back = batch_to_rows(&batch, false).expect("转回记录");
        assert!(back[0].vector.is_none());
        assert_eq!(back[0].id, "a");
    }

    #[test]
    fn wrong_vector_dimension_is_rejected() {
        let schema = record_schema(8).expect("schema");
        let err = rows_to_batch(&[row("a", Some(vec![0.0; 4]))], schema);
        assert!(matches!(err, Err(KbError::InvalidInput(_))));
    }
}
