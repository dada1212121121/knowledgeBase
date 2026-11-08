//! 从分块结果构造记录行(设计规范)。

use kb_core::hash::{MetaHashInput, content_hash, embed_input_hash, meta_hash, xxh3_hex};
use kb_core::model::{Chunk, FileKind, ItemStatus, Millis, RecordKind, RecordRow, SourceDoc};
use kb_core::text::identifier_words;

/// 计算文件内容哈希。
pub fn file_hash(bytes: &[u8]) -> String {
    xxh3_hex(bytes)
}

/// 嵌入输入:`header + "\n" + text`(与 `embed_input_hash` 的定义一致)。
pub fn embed_text(row: &RecordRow) -> String {
    format!("{}\n{}", row.header, row.text)
}

/// `lex` 列 = header + "\n" + text + "\n" + 拆分后的标识符。
pub fn lex_of(header: &str, text: &str) -> String {
    let words = identifier_words(&format!("{header}\n{text}"));
    if words.is_empty() {
        format!("{header}\n{text}")
    } else {
        format!("{header}\n{text}\n{words}")
    }
}

/// 把一份文档的分块结果转成待写入的记录。
///
/// `kind` 来自扫描结果(`FileKind::Doc` = md/mdx/rst/txt),`tags` 会写进每个块。
pub fn build_rows(
    doc: &SourceDoc,
    chunks: &[Chunk],
    collection: &str,
    embedder_id: &str,
    kind: FileKind,
    tags: &[String],
    now: Millis,
) -> Vec<RecordRow> {
    chunks
        .iter()
        .map(|chunk| {
            let status = ItemStatus::Active;
            let content = content_hash(&chunk.text);
            let meta = meta_hash(&MetaHashInput {
                start_line: Some(chunk.start_line),
                end_line: Some(chunk.end_line),
                title: chunk.title.as_deref(),
                tags,
                status: status.as_str(),
                symbol: chunk.symbol.as_deref(),
            });
            let embed = embed_input_hash(embedder_id, &chunk.header, &chunk.text);
            RecordRow {
                id: kb_core::ids::chunk_id(collection, &doc.source, &chunk.key),
                collection: collection.to_owned(),
                kind: match kind {
                    FileKind::Doc => RecordKind::Doc,
                    FileKind::Code => RecordKind::Code,
                },
                lang: Some(doc.lang.clone()),
                source: doc.source.clone(),
                start_line: Some(chunk.start_line),
                end_line: Some(chunk.end_line),
                symbol: chunk.symbol.clone(),
                title: chunk.title.clone(),
                text: chunk.text.clone(),
                header: chunk.header.clone(),
                lex: lex_of(&chunk.header, &chunk.text),
                tags: tags.to_vec(),
                status,
                content_hash: content,
                meta_hash: meta,
                embed_input_hash: embed,
                updated_at: now,
                anchor: chunk.anchor.clone(),
                vector: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::SourceDoc;

    fn doc() -> SourceDoc {
        SourceDoc {
            source: "src/lib.rs".to_owned(),
            lang: "rust".to_owned(),
            text: "fn main() {}".to_owned(),
            file_hash: "h".to_owned(),
            size: 12,
            mtime: 0,
            project_name: "demo".to_owned(),
        }
    }

    fn chunk(key: &str) -> Chunk {
        Chunk {
            key: key.to_owned(),
            text: "fn main() {}".to_owned(),
            start_line: 1,
            end_line: 1,
            symbol: Some("fn main".to_owned()),
            title: None,
            header: "demo › src/lib.rs › fn main".to_owned(),
            anchor: None,
        }
    }

    #[test]
    fn rows_carry_three_hashes_and_ids() {
        let rows = build_rows(
            &doc(),
            &[chunk("fn main")],
            "proj_demo",
            "fake:8",
            FileKind::Code,
            &[],
            42,
        );
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.id.len(), 32, "块 id 是 32 位十六进制");
        assert_eq!(row.content_hash, content_hash("fn main() {}"));
        assert_eq!(
            row.embed_input_hash,
            embed_input_hash("fake:8", "demo › src/lib.rs › fn main", "fn main() {}")
        );
        assert_eq!(row.updated_at, 42);
        assert_eq!(row.kind, RecordKind::Code);
        assert_eq!(
            row.lex,
            lex_of("demo › src/lib.rs › fn main", "fn main() {}")
        );
    }

    #[test]
    fn lex_contains_header_text_and_identifiers() {
        let lex = lex_of("demo › src/embed.rs › fn embedQuery", "fn embedQuery() {}");
        assert!(lex.starts_with("demo › src/embed.rs › fn embedQuery\n"));
        assert!(lex.contains("fn embedQuery() {}"));
        assert!(
            lex.contains("embed query"),
            "lex 应包含拆分后的标识符:{lex}"
        );
    }

    #[test]
    fn markdown_chunks_are_documents() {
        let doc = doc();
        let rows = build_rows(
            &doc,
            &[chunk("#1")],
            "proj_demo",
            "fake:8",
            FileKind::Doc,
            &[],
            0,
        );
        assert_eq!(rows[0].kind, RecordKind::Doc);
        let rows = build_rows(
            &doc,
            &[chunk("#1")],
            "proj_demo",
            "fake:8",
            FileKind::Code,
            &[],
            0,
        );
        assert_eq!(rows[0].kind, RecordKind::Code);
    }

    #[test]
    fn embed_text_is_header_plus_text() {
        let rows = build_rows(
            &doc(),
            &[chunk("fn main")],
            "proj_demo",
            "fake:8",
            FileKind::Code,
            &[],
            0,
        );
        assert_eq!(
            embed_text(&rows[0]),
            "demo › src/lib.rs › fn main\nfn main() {}"
        );
    }

    #[test]
    fn file_hash_is_xxh3_hex() {
        assert_eq!(file_hash(b"abc").len(), 16);
        assert_eq!(file_hash(b"abc"), file_hash(b"abc"));
        assert_ne!(file_hash(b"abc"), file_hash(b"abd"));
    }
}
