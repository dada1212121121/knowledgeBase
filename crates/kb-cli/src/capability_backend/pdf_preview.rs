//! PDF 预览的文字层:直接复用建索引时落库的块,不再重新抽取。
//!
//! PDF 的「块」在入库阶段已经由文本层 / OCR 产生,`file_preview` 再抽一次对扫描件等于
//! 重跑整份 OCR。这里只把落库块换成界面需要的 `{anchor, kind, text}` 形状。

use serde_json::{Value, json};

/// 返回 `(抽取器 id, 预览块)`。
///
/// 没有落库块时不报抽取器,让界面按“暂无文字层”处理;空文本块跳过,免得文字层出现空段落。
pub(super) fn preview(chunks: &[Value]) -> (Option<String>, Vec<Value>) {
    if chunks.is_empty() {
        return (None, Vec::new());
    }
    (Some("application/pdf".to_owned()), blocks_of_chunks(chunks))
}

fn blocks_of_chunks(chunks: &[Value]) -> Vec<Value> {
    chunks
        .iter()
        .filter_map(|chunk| {
            let text = chunk.get("text")?.as_str()?;
            if text.trim().is_empty() {
                return None;
            }
            Some(json!({
                "anchor": chunk.get("anchor").cloned().unwrap_or(Value::Null),
                "kind": "paragraph",
                "text": text,
            }))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::preview;

    /// PDF 预览不该再走抽取器:落库块已经带了页码和文字,直接复用。
    #[test]
    fn pdf_preview_blocks_reuse_indexed_chunks() {
        let chunks = vec![
            serde_json::json!({
                "anchor": { "kind": "page", "page": 3 },
                "text": "合同金额一百万",
            }),
            serde_json::json!({
                "anchor": { "kind": "page", "page": 4 },
                "text": "   ",
            }),
        ];
        let (extractor, blocks) = preview(&chunks);
        assert_eq!(extractor.as_deref(), Some("application/pdf"));
        assert_eq!(blocks.len(), 1, "空块不该出现在文字层里");
        assert_eq!(blocks[0]["kind"].as_str(), Some("paragraph"));
        assert_eq!(blocks[0]["text"].as_str(), Some("合同金额一百万"));
        assert_eq!(
            blocks[0]["anchor"]["page"].as_u64(),
            Some(3),
            "页码要保留,搜索联动靠它"
        );
    }

    #[test]
    fn empty_chunks_do_not_report_an_extractor() {
        let (extractor, blocks) = preview(&[]);
        assert_eq!(extractor, None);
        assert!(blocks.is_empty());
    }
}
