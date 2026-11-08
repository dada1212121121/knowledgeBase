//! 行窗口分块(设计规范的兜底路径)。
//!
//! 用于:语言不支持、解析失败、以及超长叶子节点。

use kb_core::model::{Chunk, SourceDoc};
use kb_core::text::estimate_tokens;

use crate::chunk::{ChunkOptions, TokenCount, make_header};

/// 一个窗口片段。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowPiece {
    /// 片段文本。
    pub text: String,
    /// 起始行(1 起)。
    pub start_line: i32,
    /// 结束行(1 起)。
    pub end_line: i32,
}

/// 把一段文本按行切成窗口(带重叠),每片不超过 `max_tokens`。
pub fn split_text(
    text: &str,
    first_line: i32,
    options: &ChunkOptions,
    max_tokens: usize,
) -> Vec<WindowPiece> {
    let lines: Vec<&str> = text.lines().collect();
    if lines.is_empty() {
        return Vec::new();
    }
    let mut pieces = Vec::new();
    let mut start = 0usize;
    while start < lines.len() {
        let mut end = start;
        let mut current = String::new();
        while end < lines.len() && (end - start) < options.window_lines {
            let line = lines[end];
            let candidate = if current.is_empty() {
                line.to_owned()
            } else {
                format!("{current}\n{line}")
            };
            if estimate_tokens(&candidate) > max_tokens {
                if end == start {
                    // 单行本身就超长:按字符切开,行号保持不变
                    for piece in split_long_line(line, max_tokens) {
                        pieces.push(WindowPiece {
                            text: piece,
                            start_line: first_line + start as i32,
                            end_line: first_line + start as i32,
                        });
                    }
                    end += 1;
                    current.clear();
                }
                break;
            }
            current = candidate;
            end += 1;
        }
        if !current.is_empty() {
            pieces.push(WindowPiece {
                text: current,
                start_line: first_line + start as i32,
                end_line: first_line + end as i32 - 1,
            });
        }
        if end >= lines.len() {
            break;
        }
        let next = end.saturating_sub(options.window_overlap).max(start + 1);
        start = next;
    }
    pieces
}

/// 整份文档按窗口分块(语言不支持或解析失败时的兜底)。
pub fn window_chunks(doc: &SourceDoc, options: &ChunkOptions) -> Vec<Chunk> {
    let header = make_header(&doc.project_name, &doc.source, None, None);
    let budget = options
        .max_tokens
        .saturating_sub(estimate_tokens(&header))
        .max(32);
    split_text(&doc.text, 1, options, budget)
        .into_iter()
        .enumerate()
        .map(|(index, piece)| Chunk {
            key: format!("#{}", index + 1),
            text: piece.text,
            start_line: piece.start_line,
            end_line: piece.end_line,
            symbol: None,
            title: None,
            header: header.clone(),
            anchor: None,
        })
        .collect()
}

/// 把超长单行按 token 预算切成多段。
///
/// 逐字符累计 [`TokenCount`] 判断「再放一个字符是否超预算」,不再每个字符都对整段 `current`
/// 重估(单行很长时是 O(n × 预算));切点与整段重估时完全一致。
fn split_long_line(line: &str, max_tokens: usize) -> Vec<String> {
    let mut pieces = Vec::new();
    let mut current = String::new();
    let mut tokens = TokenCount::default();
    for ch in line.chars() {
        let ch_tokens = TokenCount::of_char(ch);
        current.push(ch);
        if tokens.plus(ch_tokens).estimate() > max_tokens {
            current.pop();
            if !current.is_empty() {
                pieces.push(std::mem::take(&mut current));
            }
            current.push(ch);
            tokens = ch_tokens;
        } else {
            tokens = tokens.plus(ch_tokens);
        }
    }
    if !current.is_empty() {
        pieces.push(current);
    }
    pieces
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(text: &str) -> SourceDoc {
        SourceDoc {
            source: "src/a.rs".to_owned(),
            lang: "rust".to_owned(),
            text: text.to_owned(),
            file_hash: "h".to_owned(),
            size: text.len() as u64,
            mtime: 0,
            project_name: "demo".to_owned(),
        }
    }

    #[test]
    fn splits_into_windows_with_overlap() {
        let text = (1..=30)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let options = ChunkOptions {
            window_lines: 10,
            window_overlap: 3,
            ..ChunkOptions::default()
        };
        let pieces = split_text(&text, 1, &options, 1000);
        assert!(pieces.len() >= 3);
        assert_eq!(pieces[0].start_line, 1);
        assert_eq!(pieces[0].end_line, 10);
        // 重叠:第二片从第 8 行开始
        assert_eq!(pieces[1].start_line, 8);
        // 覆盖到最后一行
        assert_eq!(pieces.last().expect("有片段").end_line, 30);
    }

    #[test]
    fn every_piece_stays_within_the_token_budget() {
        let text = (1..=50)
            .map(|i| format!("fn f{i}() {{ let value = {i}; }}"))
            .collect::<Vec<_>>()
            .join("\n");
        let options = ChunkOptions {
            window_lines: 50,
            window_overlap: 5,
            ..ChunkOptions::default()
        };
        let pieces = split_text(&text, 1, &options, 20);
        assert!(pieces.len() > 1);
        for piece in &pieces {
            assert!(
                estimate_tokens(&piece.text) <= 20,
                "片段超出预算:{}",
                estimate_tokens(&piece.text)
            );
        }
    }

    #[test]
    fn single_long_line_is_split_but_keeps_its_line_number() {
        let line = "x".repeat(200);
        let options = ChunkOptions::default();
        let pieces = split_text(&line, 7, &options, 10);
        assert!(pieces.len() > 1);
        for piece in &pieces {
            assert!(estimate_tokens(&piece.text) <= 10);
            assert_eq!(piece.start_line, 7);
            assert_eq!(piece.end_line, 7);
        }
    }

    #[test]
    fn window_chunks_have_keys_and_headers() {
        let text = (1..=5)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let chunks = window_chunks(&doc(&text), &ChunkOptions::default());
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].key, "#1");
        assert_eq!(chunks[0].header, "demo › src/a.rs");
        assert_eq!(chunks[0].start_line, 1);
        assert_eq!(chunks[0].end_line, 5);
    }

    #[test]
    fn empty_text_yields_no_chunks() {
        assert!(window_chunks(&doc(""), &ChunkOptions::default()).is_empty());
    }
}
