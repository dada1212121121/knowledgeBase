//! Arrow schema（设计规范）。
//!
//! 所有 collection 共用同一份 schema,只有向量维度不同。
//! `vector` 是 `FixedSizeList<Float32, dim>`,内部元素字段名 `item`,可空。

use std::sync::Arc;

use arrow_schema::{DataType, Field, Schema, SchemaRef};
use kb_core::{KbError, Result};

/// 记录 id。
pub const COL_ID: &str = "id";
/// collection 名。
pub const COL_COLLECTION: &str = "collection";
/// 记录种类。
pub const COL_KIND: &str = "kind";
/// 语言。
pub const COL_LANG: &str = "lang";
/// 来源(相对路径 / URL / `insight:<id>`)。
pub const COL_SOURCE: &str = "source";
/// 起始行。
pub const COL_START_LINE: &str = "start_line";
/// 结束行。
pub const COL_END_LINE: &str = "end_line";
/// 符号路径。
pub const COL_SYMBOL: &str = "symbol";
/// 标题。
pub const COL_TITLE: &str = "title";
/// 原始块文本。
pub const COL_TEXT: &str = "text";
/// 结构化上下文头。
pub const COL_HEADER: &str = "header";
/// 全文检索列。
pub const COL_LEX: &str = "lex";
/// 标签(编码为 `,a,b,`)。
pub const COL_TAGS: &str = "tags";
/// 状态。
pub const COL_STATUS: &str = "status";
/// `xxh3(text)`
pub const COL_CONTENT_HASH: &str = "content_hash";
/// 元数据哈希。
pub const COL_META_HASH: &str = "meta_hash";
/// 嵌入输入哈希。
pub const COL_EMBED_INPUT_HASH: &str = "embed_input_hash";
/// 更新时间(Unix 毫秒)。
pub const COL_UPDATED_AT: &str = "updated_at";
/// 块位置(当前阶段,JSON 编码的 `Anchor`)。
pub const COL_ANCHOR: &str = "anchor";
/// 向量列。
pub const COL_VECTOR: &str = "vector";
/// 嵌入状态:`ready`(已有向量)/ `pending`(文本已入库、等待嵌入)。
///
/// 老表没有这一列(`ensure_table` 会补成全 NULL),NULL 一律按 `ready` 处理:
/// 升级前写入的行都已经带向量,不能因为缺标记就从检索结果里消失。
pub const COL_EMBED_STATE: &str = "embed_state";
/// 「这一行已经有向量」的过滤条件。NULL 是升级前写的老行,按 ready 处理。
pub const READY_FILTER: &str = "(embed_state = 'ready' OR embed_state IS NULL)";
/// 「这一行还在等向量」的过滤条件。
pub const PENDING_FILTER: &str = "embed_state = 'pending'";

/// 向量检索返回的距离列。
pub const SCORE_DISTANCE: &str = "_distance";
/// 全文检索返回的 BM25 分数列。
pub const SCORE_FTS: &str = "_score";
/// 混合检索返回的 RRF 融合分数列。
pub const SCORE_RELEVANCE: &str = "_relevance_score";

/// 除向量以外的全部列(检索默认只取这些)。
/// 文件级列表只需要的列:没有正文、上下文头、全文列、哈希、锚点和向量。
pub fn slice_columns() -> &'static [&'static str] {
    &[
        COL_ID,
        COL_COLLECTION,
        COL_KIND,
        COL_LANG,
        COL_SOURCE,
        COL_START_LINE,
        COL_END_LINE,
        COL_SYMBOL,
        COL_TITLE,
        COL_TAGS,
        COL_STATUS,
        COL_UPDATED_AT,
    ]
}

pub fn non_vector_columns() -> &'static [&'static str] {
    &[
        COL_ID,
        COL_COLLECTION,
        COL_KIND,
        COL_LANG,
        COL_SOURCE,
        COL_START_LINE,
        COL_END_LINE,
        COL_SYMBOL,
        COL_TITLE,
        COL_TEXT,
        COL_HEADER,
        COL_LEX,
        COL_TAGS,
        COL_STATUS,
        COL_CONTENT_HASH,
        COL_META_HASH,
        COL_EMBED_INPUT_HASH,
        COL_UPDATED_AT,
        COL_ANCHOR,
        COL_EMBED_STATE,
    ]
}

/// 构造物理表的 schema。
pub fn record_schema(dim: usize) -> Result<SchemaRef> {
    let dim = i32::try_from(dim)
        .map_err(|_| KbError::InvalidInput(format!("向量维度过大,无法写入 Arrow schema: {dim}")))?;
    Ok(Arc::new(Schema::new(vec![
        Field::new(COL_ID, DataType::Utf8, false),
        Field::new(COL_COLLECTION, DataType::Utf8, false),
        Field::new(COL_KIND, DataType::Utf8, false),
        Field::new(COL_LANG, DataType::Utf8, true),
        Field::new(COL_SOURCE, DataType::Utf8, false),
        Field::new(COL_START_LINE, DataType::Int32, true),
        Field::new(COL_END_LINE, DataType::Int32, true),
        Field::new(COL_SYMBOL, DataType::Utf8, true),
        Field::new(COL_TITLE, DataType::Utf8, true),
        Field::new(COL_TEXT, DataType::Utf8, false),
        Field::new(COL_HEADER, DataType::Utf8, false),
        Field::new(COL_LEX, DataType::Utf8, false),
        Field::new(COL_TAGS, DataType::Utf8, false),
        Field::new(COL_STATUS, DataType::Utf8, false),
        Field::new(COL_CONTENT_HASH, DataType::Utf8, false),
        Field::new(COL_META_HASH, DataType::Utf8, false),
        Field::new(COL_EMBED_INPUT_HASH, DataType::Utf8, false),
        Field::new(COL_UPDATED_AT, DataType::Int64, false),
        Field::new(COL_ANCHOR, DataType::Utf8, true),
        Field::new(COL_EMBED_STATE, DataType::Utf8, true),
        Field::new(
            COL_VECTOR,
            DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, true)), dim),
            true,
        ),
    ])))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_has_every_documented_column() {
        let schema = record_schema(8).expect("schema");
        let names: Vec<&str> = schema.fields().iter().map(|f| f.name().as_str()).collect();
        for expected in [
            "id",
            "collection",
            "kind",
            "lang",
            "source",
            "start_line",
            "end_line",
            "symbol",
            "title",
            "text",
            "header",
            "lex",
            "tags",
            "status",
            "content_hash",
            "meta_hash",
            "embed_input_hash",
            "updated_at",
            "anchor",
            "embed_state",
            "vector",
        ] {
            assert!(names.contains(&expected), "缺少列 {expected}");
        }
        assert_eq!(names.len(), 21);
    }

    #[test]
    fn nullability_matches_the_spec() {
        let schema = record_schema(8).expect("schema");
        let field = |name: &str| schema.field_with_name(name).expect("列存在").clone();
        for nullable in [
            "lang",
            "start_line",
            "end_line",
            "symbol",
            "title",
            "anchor",
            "embed_state",
            "vector",
        ] {
            assert!(field(nullable).is_nullable(), "{nullable} 应可空");
        }
        for required in [
            "id",
            "collection",
            "kind",
            "source",
            "text",
            "lex",
            "tags",
            "status",
        ] {
            assert!(!field(required).is_nullable(), "{required} 不应可空");
        }
    }

    #[test]
    fn vector_is_fixed_size_list_of_float32() {
        let schema = record_schema(8).expect("schema");
        let vector = schema.field_with_name(COL_VECTOR).expect("向量列");
        match vector.data_type() {
            DataType::FixedSizeList(item, dim) => {
                assert_eq!(*dim, 8);
                assert_eq!(item.name(), "item");
                assert_eq!(item.data_type(), &DataType::Float32);
                assert!(item.is_nullable(), "内部元素字段可空");
            }
            other => panic!("向量列类型不对: {other:?}"),
        }
    }

    #[test]
    fn huge_dimension_is_rejected() {
        assert!(record_schema(usize::MAX).is_err());
    }
}
