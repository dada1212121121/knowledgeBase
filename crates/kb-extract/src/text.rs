//! 文本类抽取器:纯文本 / Markdown / 代码。
//!
//! 这三类现在就能抽成 [`Doc`],后续格式(PDF / Office / EPUB / 邮件 / 压缩包)按同一接口加。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Anchor, AnchoredBlock, Block, Confidence, Doc, DocMeta, SourceRef};
use kb_core::ports::Extractor;
use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// 纯文本:一个段落块,anchor 覆盖全文行范围。
pub struct PlainTextExtractor;

#[async_trait]
impl Extractor for PlainTextExtractor {
    fn id(&self) -> &str {
        "text/plain"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        // 有 NUL 就肯定不是文本
        if head.contains(&0u8) {
            return Confidence::Unlikely;
        }
        match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
            "txt" | "log" | "rst" | "" => Confidence::Probable,
            _ => Confidence::Unlikely,
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let text = String::from_utf8_lossy(bytes).into_owned();
        let anchor = line_anchor(&text, 1);
        Ok(doc_of(
            source,
            &text,
            vec![AnchoredBlock {
                anchor,
                block: Block::Paragraph { text: text.clone() },
            }],
        ))
    }
}

/// Markdown:标题、段落、代码块、表格分别成块,带行号 anchor。
pub struct MarkdownExtractor;

#[async_trait]
impl Extractor for MarkdownExtractor {
    fn id(&self) -> &str {
        "text/markdown"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if head.contains(&0u8) {
            return Confidence::Unlikely;
        }
        match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
            "md" | "markdown" | "mdx" => Confidence::Probable,
            _ => Confidence::Unlikely,
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let text = String::from_utf8_lossy(bytes).into_owned();
        Ok(doc_of(source, &text, markdown_blocks(&text)))
    }
}

/// 代码:整份文件一个代码块(分块交给 DocChunker 按 token 预算切)。
pub struct CodeExtractor;

#[async_trait]
impl Extractor for CodeExtractor {
    fn id(&self) -> &str {
        "text/x-code"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if head.contains(&0u8) {
            return Confidence::Unlikely;
        }
        let ext = ext.trim_start_matches('.').to_ascii_lowercase();
        if CODE_EXTENSIONS.contains(&ext.as_str()) {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let text = String::from_utf8_lossy(bytes).into_owned();
        let lang = source
            .location
            .rsplit_once('.')
            .map(|(_, ext)| ext.to_owned())
            .unwrap_or_else(|| "text".to_owned());
        let anchor = line_anchor(&text, 1);
        Ok(doc_of(
            source,
            &text,
            vec![AnchoredBlock {
                anchor,
                block: Block::Code {
                    text: text.clone(),
                    lang,
                },
            }],
        ))
    }
}

/// 代码扩展名(与 `kb-index::lang` 的识别保持一致的范围)。
const CODE_EXTENSIONS: &[&str] = &[
    "rs", "py", "pyi", "js", "mjs", "cjs", "jsx", "ts", "tsx", "go", "java", "c", "h", "cc", "cpp",
    "hpp", "cs", "rb", "php", "swift", "kt", "scala", "sh", "bash", "zsh", "sql", "toml", "yaml",
    "yml", "json", "ini", "conf", "css", "scss", "html", "htm", "vue", "xml", "lua", "r", "m",
    "pl",
];

/// 组装一份 Doc。
fn doc_of(source: &SourceRef, text: &str, blocks: Vec<AnchoredBlock>) -> Doc {
    Doc {
        meta: DocMeta {
            source: source.location.clone(),
            title: None,
            lang: "zh".to_owned(),
            mime: None,
            file_hash: kb_core::hash::content_hash(text),
            size: text.len() as u64,
            mtime: 0,
            project_name: source
                .project_root
                .as_ref()
                .and_then(|root| root.file_name())
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_default(),
        },
        blocks: blocks
            .into_iter()
            .filter(|block| !block.block.is_empty())
            .collect(),
    }
}

/// 从第 `first_line` 行开始的 anchor,结束行按文本里的换行数算。
fn line_anchor(text: &str, first_line: u32) -> Anchor {
    let lines = text.lines().count().max(1) as u32;
    Anchor::Line {
        start: first_line,
        end: first_line + lines - 1,
    }
}

/// 字节偏移 → 行号(1 起)。
fn line_at(text: &str, offset: usize) -> u32 {
    let offset = offset.min(text.len());
    (text[..offset].matches('\n').count() as u32) + 1
}

/// Markdown → 块序列。
fn markdown_blocks(text: &str) -> Vec<AnchoredBlock> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    let parser = Parser::new_ext(text, options).into_offset_iter();

    let mut blocks: Vec<AnchoredBlock> = Vec::new();
    let mut paragraph = String::new();
    let mut paragraph_start = 0usize;
    let mut heading: Option<(u8, String, usize)> = None;
    let mut code: Option<(String, String, usize)> = None;
    let mut table: Option<(Vec<String>, Vec<Vec<String>>, usize)> = None;
    let mut row: Vec<String> = Vec::new();
    let mut in_header = false;

    let flush_paragraph =
        |paragraph: &mut String, start: &mut usize, blocks: &mut Vec<AnchoredBlock>| {
            let body = paragraph.trim();
            if !body.is_empty() {
                blocks.push(AnchoredBlock {
                    anchor: line_anchor_at(text, *start, body),
                    block: Block::Paragraph {
                        text: body.to_owned(),
                    },
                });
            }
            paragraph.clear();
            *start = 0;
        };

    for (event, range) in parser {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                flush_paragraph(&mut paragraph, &mut paragraph_start, &mut blocks);
                heading = Some((heading_level(level), String::new(), range.start));
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, title, start)) = heading.take() {
                    let title = title.trim().to_owned();
                    if !title.is_empty() {
                        blocks.push(AnchoredBlock {
                            anchor: line_anchor_at(text, start, &title),
                            block: Block::Heading { level, text: title },
                        });
                    }
                }
            }
            Event::Start(Tag::Paragraph) => {
                if paragraph.is_empty() {
                    paragraph_start = range.start;
                }
            }
            Event::End(TagEnd::Paragraph) => {
                flush_paragraph(&mut paragraph, &mut paragraph_start, &mut blocks);
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                let lang = match kind {
                    CodeBlockKind::Fenced(info) => info.trim().to_owned(),
                    CodeBlockKind::Indented => String::new(),
                };
                code = Some((lang, String::new(), range.start));
            }
            Event::End(TagEnd::CodeBlock) => {
                if let Some((lang, body, start)) = code.take() {
                    let body = body.trim_end().to_owned();
                    if !body.trim().is_empty() {
                        blocks.push(AnchoredBlock {
                            anchor: line_anchor_at(text, start, &body),
                            block: Block::Code { lang, text: body },
                        });
                    }
                }
            }
            Event::Start(Tag::Table(_)) => {
                flush_paragraph(&mut paragraph, &mut paragraph_start, &mut blocks);
                table = Some((Vec::new(), Vec::new(), range.start));
            }
            Event::Start(Tag::TableHead) => in_header = true,
            Event::End(TagEnd::TableHead) => {
                // 表头没有 TableRow 事件,在 TableHead 结束时收走
                if let Some((header, _, _)) = table.as_mut() {
                    *header = std::mem::take(&mut row);
                }
                in_header = false;
            }
            Event::End(TagEnd::TableRow) => {
                if let Some((header, rows, _)) = table.as_mut() {
                    if in_header {
                        *header = std::mem::take(&mut row);
                    } else {
                        rows.push(std::mem::take(&mut row));
                    }
                }
                in_header = false;
            }
            Event::End(TagEnd::Table) => {
                if let Some((header, rows, start)) = table.take() {
                    let body = Block::Table {
                        header: header.clone(),
                        rows: rows.clone(),
                    };
                    if !body.is_empty() {
                        blocks.push(AnchoredBlock {
                            anchor: line_anchor_at(text, start, &body.text()),
                            block: body,
                        });
                    }
                }
            }
            Event::Text(value) => {
                if let Some((_, title, _)) = heading.as_mut() {
                    title.push_str(&value);
                } else if let Some((_, body, _)) = code.as_mut() {
                    body.push_str(&value);
                } else if table.is_some() {
                    row.push(value.trim().to_owned());
                } else {
                    paragraph.push_str(&value);
                }
            }
            Event::Code(value) => {
                if table.is_some() {
                    row.push(value.to_string());
                } else if heading.is_some() {
                    if let Some((_, title, _)) = heading.as_mut() {
                        title.push_str(&value);
                    }
                } else {
                    paragraph.push_str(&value);
                }
            }
            Event::SoftBreak | Event::HardBreak => paragraph.push('\n'),
            _ => {}
        }
    }
    flush_paragraph(&mut paragraph, &mut paragraph_start, &mut blocks);
    blocks
}

/// 按起始偏移与正文算行号 anchor。
fn line_anchor_at(text: &str, start: usize, body: &str) -> Anchor {
    let first = line_at(text, start);
    let lines = body.lines().count().max(1) as u32;
    Anchor::Line {
        start: first,
        end: first + lines - 1,
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> SourceRef {
        SourceRef {
            scheme: "file".to_owned(),
            location: "docs/a.md".to_owned(),
            project_root: None,
        }
    }

    #[tokio::test]
    async fn markdown_becomes_heading_paragraph_code_and_table_blocks() {
        let text = "# 标题\n\n第一段。\n\n```rust\nfn f() {}\n```\n\n| 列 A | 列 B |\n|---|---|\n| 1 | 2 |\n";
        let doc = MarkdownExtractor
            .extract(&source(), text.as_bytes())
            .await
            .expect("抽取");
        let kinds: Vec<&str> = doc
            .blocks
            .iter()
            .map(|block| match block.block {
                Block::Heading { .. } => "heading",
                Block::Paragraph { .. } => "paragraph",
                Block::Code { .. } => "code",
                Block::Table { .. } => "table",
                _ => "other",
            })
            .collect();
        assert_eq!(kinds, vec!["heading", "paragraph", "code", "table"]);
        // 表格保留表头
        match &doc.blocks[3].block {
            Block::Table { header, rows } => {
                assert_eq!(header, &vec!["列 A".to_owned(), "列 B".to_owned()]);
                assert_eq!(rows.len(), 1);
            }
            other => panic!("第三块应是表格:{other:?}"),
        }
        // 行号 anchor 单调
        let lines: Vec<u32> = doc
            .blocks
            .iter()
            .map(|block| match block.anchor {
                Anchor::Line { start, .. } => start,
                _ => 0,
            })
            .collect();
        assert!(lines.windows(2).all(|pair| pair[0] <= pair[1]), "{lines:?}");
    }

    #[tokio::test]
    async fn plain_text_is_one_paragraph_with_line_anchor() {
        let doc = PlainTextExtractor
            .extract(&source(), b"a\nb\nc\n")
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 1);
        assert_eq!(
            doc.blocks[0].anchor,
            Anchor::Line { start: 1, end: 3 },
            "三行文本的 anchor 覆盖 1..=3"
        );
    }

    #[tokio::test]
    async fn code_is_one_block_with_language() {
        let doc = CodeExtractor
            .extract(
                &SourceRef {
                    scheme: "file".to_owned(),
                    location: "src/lib.rs".to_owned(),
                    project_root: None,
                },
                b"fn main() {}\n",
            )
            .await
            .expect("抽取");
        match &doc.blocks[0].block {
            Block::Code { lang, .. } => assert_eq!(lang, "rs"),
            other => panic!("应是代码块:{other:?}"),
        }
    }

    #[test]
    fn empty_blocks_are_dropped() {
        let text = "# 标题\n\n\n\n   \n";
        let blocks = markdown_blocks(text);
        assert!(blocks.iter().all(|block| !block.block.is_empty()));
        assert_eq!(blocks.len(), 1, "只有标题一块");
    }

    #[test]
    fn detection_prefers_magic_and_falls_back_to_extension() {
        use kb_core::ports::Extractor;
        assert_eq!(
            MarkdownExtractor.detect(b"# hi", "md"),
            Confidence::Probable
        );
        assert_eq!(
            MarkdownExtractor.detect(b"# hi", "txt"),
            Confidence::Unlikely
        );
        assert_eq!(
            PlainTextExtractor.detect(&[0u8, 1, 2], "txt"),
            Confidence::Unlikely,
            "有 NUL 就不是文本"
        );
        assert_eq!(
            CodeExtractor.detect(b"fn f() {}", "rs"),
            Confidence::Probable
        );
    }
}
