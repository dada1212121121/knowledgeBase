//! 中间文档分块器:标题层级、表格按行(表头随块)、幻灯片按页、媒体按 60 秒窗口。
//!
//! 与现有 `kb-index` 的 Markdown / 代码分块器**并存**:那两条路径保持不变,这里服务的是
//! “先抽成 [`Doc`] 再分块”的通用链路(PDF / Office / EPUB 等格式走它)。

use kb_core::model::{Anchor, Block, Chunk, Doc};
use kb_core::ports::DocChunker;
use kb_core::text::estimate_tokens;

/// 分块参数。
#[derive(Clone, Debug)]
pub struct DocChunkOptions {
    /// 每块的目标 token 数(超出就切开)。
    pub target_tokens: usize,
    /// 媒体的时间窗(毫秒),默认 60 秒。
    pub media_window_ms: u64,
    /// 项目名(进 header)。
    pub project_name: String,
}

impl Default for DocChunkOptions {
    fn default() -> Self {
        Self {
            target_tokens: 512,
            media_window_ms: 60_000,
            project_name: String::new(),
        }
    }
}

impl DocChunkOptions {
    /// 从配置构造(与 `[index] target_tokens` 对齐)。
    pub fn from_config(target_tokens: usize, project_name: impl Into<String>) -> Self {
        Self {
            target_tokens: target_tokens.max(64),
            project_name: project_name.into(),
            ..Self::default()
        }
    }
}

/// 中间文档分块器。
pub struct DocChunkerImpl {
    options: DocChunkOptions,
}

impl DocChunkerImpl {
    /// 构造。
    pub fn new(options: DocChunkOptions) -> Self {
        Self { options }
    }
}

impl DocChunker for DocChunkerImpl {
    fn chunk_doc(&self, doc: &Doc) -> Vec<Chunk> {
        let mut chunks: Vec<Chunk> = Vec::new();
        // 标题路径(面包屑):每遇到一个标题就更新
        let mut trail: Vec<(u8, String)> = Vec::new();
        // 当前正在累积的段落(标题之间的内容)
        let mut buffer: Vec<(Anchor, String)> = Vec::new();

        for anchored in &doc.blocks {
            match &anchored.block {
                Block::Heading { level, text } => {
                    flush(&mut chunks, &mut buffer, &trail, doc, &self.options);
                    trail.retain(|(current, _)| current < level);
                    trail.push((*level, text.clone()));
                    // 标题本身也是内容:放进缓冲区,后面没有正文时它自己就是一块
                    buffer.push((anchored.anchor.clone(), text.clone()));
                }
                Block::Table { header, rows } => {
                    // 表格按行切:每块都带上表头,anchor 落在这一行的单元格上
                    flush(&mut chunks, &mut buffer, &trail, doc, &self.options);
                    let sheet = match &anchored.anchor {
                        Anchor::Cell { sheet, .. } => sheet.clone(),
                        _ => "table".to_owned(),
                    };
                    // 只有表头、没有数据行(只有一行内容的工作表):表头本身就是内容,切成一块
                    if rows.is_empty() && header.iter().any(|cell| !cell.trim().is_empty()) {
                        let anchor = match &anchored.anchor {
                            Anchor::Cell { .. } => Anchor::Cell {
                                sheet: sheet.clone(),
                                cell: "R1".to_owned(),
                            },
                            other => other.clone(),
                        };
                        chunks.push(make_chunk(
                            &chunks.len(),
                            header.join(" | "),
                            anchor,
                            &trail,
                            doc,
                            &self.options,
                        ));
                    }
                    for (index, row) in rows.iter().enumerate() {
                        let mut text = header.join(" | ");
                        text.push('\n');
                        text.push_str(&row.join(" | "));
                        let anchor = match &anchored.anchor {
                            Anchor::Cell { .. } => Anchor::Cell {
                                sheet: sheet.clone(),
                                cell: format!("R{}", index + 2),
                            },
                            other => other.clone(),
                        };
                        chunks.push(make_chunk(
                            &chunks.len(),
                            text,
                            anchor,
                            &trail,
                            doc,
                            &self.options,
                        ));
                    }
                }
                Block::Media { transcript } => {
                    flush(&mut chunks, &mut buffer, &trail, doc, &self.options);
                    let Some(transcript) =
                        transcript.as_deref().filter(|text| !text.trim().is_empty())
                    else {
                        continue;
                    };
                    for (anchor, piece) in
                        split_media(&anchored.anchor, transcript, self.options.media_window_ms)
                    {
                        chunks.push(make_chunk(
                            &chunks.len(),
                            piece,
                            anchor,
                            &trail,
                            doc,
                            &self.options,
                        ));
                    }
                }
                // 没有 OCR 文字的图片块:图注要么是空,要么是抽取器写的
                // `第 N 页没有文字层(needs_ocr)` 提示 —— 都不是正文。
                // 带 OCR 结果的图片块(`ocr_text` 非空)走下面的默认分支照常入索引
                Block::Image { .. }
                    if anchored.block.is_empty() || anchored.block.is_ocr_hint() => {}
                block => {
                    let text = block.text();
                    if text.trim().is_empty() {
                        continue;
                    }
                    // 换页 / 换幻灯片就切一块(卡片的“幻灯片按页”)
                    if let Some((last, _)) = buffer.last()
                        && !same_scope(last, &anchored.anchor)
                    {
                        flush(&mut chunks, &mut buffer, &trail, doc, &self.options);
                    }
                    buffer.push((anchored.anchor.clone(), text));
                    // 累积超预算就切一块
                    let tokens: usize = buffer.iter().map(|(_, text)| estimate_tokens(text)).sum();
                    if tokens >= self.options.target_tokens {
                        flush(&mut chunks, &mut buffer, &trail, doc, &self.options);
                    }
                }
            }
        }
        flush(&mut chunks, &mut buffer, &trail, doc, &self.options);
        chunks
    }
}

/// 两个 anchor 是否属于同一页 / 同一张幻灯片(是的话可以合成一块)。
fn same_scope(left: &Anchor, right: &Anchor) -> bool {
    match (left, right) {
        (Anchor::Page { page: a }, Anchor::Page { page: b }) => a == b,
        (Anchor::Slide { slide: a }, Anchor::Slide { slide: b }) => a == b,
        (Anchor::Cell { sheet: a, .. }, Anchor::Cell { sheet: b, .. }) => a == b,
        (Anchor::Page { .. }, _) | (_, Anchor::Page { .. }) => false,
        (Anchor::Slide { .. }, _) | (_, Anchor::Slide { .. }) => false,
        _ => true,
    }
}

/// 把缓冲区合成一个块(必要时按预算再切)。
fn flush(
    chunks: &mut Vec<Chunk>,
    buffer: &mut Vec<(Anchor, String)>,
    trail: &[(u8, String)],
    doc: &Doc,
    options: &DocChunkOptions,
) {
    if buffer.is_empty() {
        return;
    }
    let anchor = buffer[0].0.clone();
    let text = buffer
        .iter()
        .map(|(_, text)| text.trim())
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    buffer.clear();
    for piece in split_by_budget(&text, options.target_tokens) {
        chunks.push(make_chunk(
            &chunks.len(),
            piece,
            anchor.clone(),
            trail,
            doc,
            options,
        ));
    }
}

/// 造一个块:key 用 `#<序号>`,header 是 `项目 › 文件 › 标题路径`。
fn make_chunk(
    ordinal: &usize,
    text: String,
    anchor: Anchor,
    trail: &[(u8, String)],
    doc: &Doc,
    options: &DocChunkOptions,
) -> Chunk {
    let title = trail.last().map(|(_, text)| text.clone());
    let mut header = String::new();
    if !options.project_name.is_empty() {
        header.push_str(&options.project_name);
        header.push_str(" › ");
    }
    header.push_str(&doc.meta.source);
    for (_, item) in trail {
        header.push_str(" › ");
        header.push_str(item);
    }
    let (start_line, end_line) = match &anchor {
        Anchor::Line { start, end } => (*start as i32, *end as i32),
        _ => (0, 0),
    };
    Chunk {
        key: format!("#{ordinal}"),
        text,
        start_line,
        end_line,
        symbol: None,
        title,
        header,
        anchor: Some(anchor),
    }
}

/// 按 token 预算切分(按段落优先,段落太长再按句子/字符兜底)。
fn split_by_budget(text: &str, budget: usize) -> Vec<String> {
    let budget = budget.max(64);
    if estimate_tokens(text) <= budget {
        return vec![text.to_owned()];
    }
    let mut pieces = Vec::new();
    let mut current = String::new();
    for paragraph in text.split("\n\n") {
        if estimate_tokens(paragraph) > budget {
            // 单段就超预算:按行再按字符切
            if !current.is_empty() {
                pieces.push(std::mem::take(&mut current));
            }
            let mut line_buffer = String::new();
            for line in paragraph.lines() {
                if estimate_tokens(&line_buffer) + estimate_tokens(line) > budget
                    && !line_buffer.is_empty()
                {
                    pieces.push(std::mem::take(&mut line_buffer));
                }
                if estimate_tokens(line) > budget {
                    // 单行都超:按字符硬切
                    let mut chunk = String::new();
                    for ch in line.chars() {
                        chunk.push(ch);
                        if estimate_tokens(&chunk) >= budget {
                            pieces.push(std::mem::take(&mut chunk));
                        }
                    }
                    line_buffer.push_str(&chunk);
                } else {
                    line_buffer.push_str(line);
                    line_buffer.push('\n');
                }
            }
            if !line_buffer.trim().is_empty() {
                pieces.push(line_buffer.trim_end().to_owned());
            }
            continue;
        }
        if estimate_tokens(&current) + estimate_tokens(paragraph) > budget && !current.is_empty() {
            pieces.push(std::mem::take(&mut current));
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(paragraph);
    }
    if !current.trim().is_empty() {
        pieces.push(current);
    }
    pieces
        .into_iter()
        .filter(|piece| !piece.trim().is_empty())
        .collect()
}

/// 把媒体转写按时间窗切开;没有时间戳时按窗口数均分文本。
fn split_media(anchor: &Anchor, transcript: &str, window_ms: u64) -> Vec<(Anchor, String)> {
    let window_ms = window_ms.max(1_000);
    let (start, end) = match anchor {
        Anchor::Time { start_ms, end_ms } => (*start_ms, *end_ms),
        _ => (0, window_ms),
    };
    let span = end.saturating_sub(start).max(1);
    let windows = span.div_ceil(window_ms).max(1);
    if windows == 1 {
        return vec![(
            Anchor::Time {
                start_ms: start,
                end_ms: start + span,
            },
            transcript.to_owned(),
        )];
    }
    // 没有逐句时间戳:按字符比例均分(有转写时间戳后 会给出精确分段)
    let chars: Vec<char> = transcript.chars().collect();
    let per_window = chars.len().div_ceil(windows as usize).max(1);
    chars
        .chunks(per_window)
        .enumerate()
        .map(|(index, slice)| {
            let from = start + index as u64 * window_ms;
            (
                Anchor::Time {
                    start_ms: from,
                    end_ms: (from + window_ms).min(start + span),
                },
                slice.iter().collect::<String>(),
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::{AnchoredBlock, DocMeta};

    fn doc(blocks: Vec<AnchoredBlock>) -> Doc {
        Doc {
            meta: DocMeta {
                source: "docs/a.md".to_owned(),
                title: None,
                lang: "zh".to_owned(),
                mime: None,
                file_hash: "h".to_owned(),
                size: 0,
                mtime: 0,
                project_name: "demo".to_owned(),
            },
            blocks,
        }
    }

    fn heading(level: u8, text: &str, line: u32) -> AnchoredBlock {
        AnchoredBlock {
            anchor: Anchor::Line {
                start: line,
                end: line,
            },
            block: Block::Heading {
                level,
                text: text.to_owned(),
            },
        }
    }

    fn paragraph(text: &str, line: u32) -> AnchoredBlock {
        AnchoredBlock {
            anchor: Anchor::Line {
                start: line,
                end: line,
            },
            block: Block::Paragraph {
                text: text.to_owned(),
            },
        }
    }

    #[test]
    fn headings_become_the_header_path() {
        let chunker = DocChunkerImpl::new(DocChunkOptions::from_config(512, "demo"));
        let chunks = chunker.chunk_doc(&doc(vec![
            heading(1, "第一章", 1),
            paragraph("正文一", 2),
            heading(2, "小节", 3),
            paragraph("正文二", 4),
        ]));
        assert_eq!(chunks.len(), 2);
        assert!(chunks[0].header.contains("第一章"), "{:?}", chunks[0]);
        assert!(
            chunks[1].header.contains("第一章 › 小节"),
            "{:?}",
            chunks[1]
        );
        // 标题本身也是内容:第一块的 anchor 落在标题行,正文跟着标题
        assert_eq!(chunks[0].anchor, Some(Anchor::Line { start: 1, end: 1 }));
        assert!(chunks[0].text.contains("第一章"), "{:?}", chunks[0]);
        assert!(chunks[0].text.contains("正文一"), "{:?}", chunks[0]);
        assert!(chunks[1].text.contains("小节"), "{:?}", chunks[1]);
        assert_eq!(chunks[1].title.as_deref(), Some("小节"));
    }

    #[test]
    fn tables_are_split_by_row_with_header() {
        let chunker = DocChunkerImpl::new(DocChunkOptions::default());
        let chunks = chunker.chunk_doc(&doc(vec![AnchoredBlock {
            anchor: Anchor::Cell {
                sheet: "Sheet1".to_owned(),
                cell: "A1".to_owned(),
            },
            block: Block::Table {
                header: vec!["名称".to_owned(), "数量".to_owned()],
                rows: vec![
                    vec!["甲".to_owned(), "1".to_owned()],
                    vec!["乙".to_owned(), "2".to_owned()],
                ],
            },
        }]));
        assert_eq!(chunks.len(), 2, "两行 → 两块");
        for chunk in &chunks {
            assert!(chunk.text.contains("名称 | 数量"), "表头要随每一行");
        }
        assert_eq!(
            chunks[1].anchor,
            Some(Anchor::Cell {
                sheet: "Sheet1".to_owned(),
                cell: "R3".to_owned()
            })
        );
    }

    /// 只有一行内容的工作表:这一行被当成表头,没有数据行。以前这样的表一块都切不出来,里面的字搜不到
    /// (在线编辑器保存的、只写了一行的表格,以及任何只有一行的工作表)。现在表头本身成一块。
    #[test]
    fn a_table_with_only_a_header_row_is_still_one_chunk() {
        let chunker = DocChunkerImpl::new(DocChunkOptions::default());
        let chunks = chunker.chunk_doc(&doc(vec![AnchoredBlock {
            anchor: Anchor::Cell {
                sheet: "预算".to_owned(),
                cell: "A1".to_owned(),
            },
            block: Block::Table {
                header: vec!["季度预算 机密".to_owned(), "2".to_owned()],
                rows: Vec::new(),
            },
        }]));
        assert_eq!(chunks.len(), 1);
        assert!(
            chunks[0].text.contains("季度预算 机密 | 2"),
            "{:?}",
            chunks[0]
        );
        assert_eq!(
            chunks[0].anchor,
            Some(Anchor::Cell {
                sheet: "预算".to_owned(),
                cell: "R1".to_owned()
            })
        );
        // 表头全是空的就什么都不产生
        let empty = chunker.chunk_doc(&doc(vec![AnchoredBlock {
            anchor: Anchor::Cell {
                sheet: "空".to_owned(),
                cell: "A1".to_owned(),
            },
            block: Block::Table {
                header: vec![" ".to_owned()],
                rows: Vec::new(),
            },
        }]));
        assert!(empty.is_empty());
    }

    #[test]
    fn slides_and_media_follow_the_anchor() {
        let chunker = DocChunkerImpl::new(DocChunkOptions::default());
        let chunks = chunker.chunk_doc(&doc(vec![
            AnchoredBlock {
                anchor: Anchor::Slide { slide: 1 },
                block: Block::Paragraph {
                    text: "第一页".to_owned(),
                },
            },
            AnchoredBlock {
                anchor: Anchor::Slide { slide: 2 },
                block: Block::Paragraph {
                    text: "第二页".to_owned(),
                },
            },
        ]));
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[1].anchor, Some(Anchor::Slide { slide: 2 }));
    }

    #[test]
    fn long_media_transcript_is_split_into_minute_windows() {
        let chunker = DocChunkerImpl::new(DocChunkOptions::default());
        let transcript: String = "这是一段转写内容。".repeat(120);
        let chunks = chunker.chunk_doc(&doc(vec![AnchoredBlock {
            anchor: Anchor::Time {
                start_ms: 0,
                end_ms: 180_000,
            },
            block: Block::Media {
                transcript: Some(transcript),
            },
        }]));
        assert_eq!(chunks.len(), 3, "180 秒按 60 秒窗口切三块");
        for (index, chunk) in chunks.iter().enumerate() {
            match &chunk.anchor {
                Some(Anchor::Time { start_ms, .. }) => assert_eq!(*start_ms, index as u64 * 60_000),
                other => panic!("应是时间锚点:{other:?}"),
            }
        }
    }

    #[test]
    fn long_paragraphs_are_split_by_budget() {
        let chunker = DocChunkerImpl::new(DocChunkOptions::from_config(100, "demo"));
        let body = "很长的正文。".repeat(200);
        let chunks = chunker.chunk_doc(&doc(vec![paragraph(&body, 1)]));
        assert!(chunks.len() > 1, "超预算要切开");
        for chunk in &chunks {
            assert!(
                estimate_tokens(&chunk.text) <= 120,
                "每块不应明显超预算:{}",
                estimate_tokens(&chunk.text)
            );
        }
        // 内容不丢
        let joined: String = chunks.iter().map(|chunk| chunk.text.clone()).collect();
        assert_eq!(joined.chars().filter(|ch| *ch == '。').count(), 200);
    }

    #[test]
    fn empty_blocks_produce_no_chunks() {
        let chunker = DocChunkerImpl::new(DocChunkOptions::default());
        let chunks = chunker.chunk_doc(&doc(vec![
            paragraph("   ", 1),
            AnchoredBlock {
                anchor: Anchor::Page { page: 1 },
                block: Block::Image {
                    caption: None,
                    ocr_text: None,
                    resource: None,
                },
            },
            // 带原图、没有文字的图片(docx 截图)也不产生块
            AnchoredBlock {
                anchor: Anchor::Page { page: 1 },
                block: Block::Image {
                    caption: None,
                    ocr_text: None,
                    resource: Some("word/media/image1.png".to_owned()),
                },
            },
        ]));
        assert!(chunks.is_empty(), "{chunks:?}");
    }

    /// `needs_ocr` 提示图注不是正文:不能进索引(否则会搜到“第 1 页没有文字层”)。
    #[test]
    fn ocr_hint_captions_do_not_become_chunks() {
        let chunker = DocChunkerImpl::new(DocChunkOptions::default());
        let chunks = chunker.chunk_doc(&doc(vec![
            paragraph("第一页有正文。", 1),
            AnchoredBlock {
                anchor: Anchor::Page { page: 2 },
                block: Block::Image {
                    caption: Some("第 2 页没有文字层(needs_ocr)".to_owned()),
                    ocr_text: None,
                    resource: None,
                },
            },
        ]));
        let text: String = chunks.iter().map(|chunk| chunk.text.clone()).collect();
        assert!(!text.contains("needs_ocr"), "提示图注进了索引:{text}");
        assert!(text.contains("第一页有正文"));
    }
}
