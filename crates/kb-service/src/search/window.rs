//! Sentence-window 扩展（设计规范）。
//!
//! 代码类结果从源文件补上下 `window_context_lines` 行;源文件已变化或不存在时,
//! 回退到 LanceDB 里存的 `text`(不报错)。
//!
//! 检索路径必须用 [`expand_async`]:一次检索最多展开 `k`(默认 8)条代码命中,每条都要整文件读一遍
//! (单文件上限 200 KB),同步读会把 tokio 工作线程钉在磁盘上,上并发闸门之后就是尾延迟来源。

use std::path::Path;

use kb_core::model::{RecordKind, RecordRow, WindowExplain};

/// 窗口扩展的结果。
#[derive(Clone, Debug, PartialEq)]
pub struct Windowed {
    /// 扩展后的片段。
    pub snippet: String,
    /// 说明。
    pub explain: WindowExplain,
}

/// 展开一条命中(同步版:读盘就在这里发生,测试与同步调用方用)。
///
/// 检索路径请用 [`expand_async`]。语义两者完全一致。
pub fn expand(row: &RecordRow, window_lines: usize, root: Option<&Path>) -> Windowed {
    // 设计规范第 8 步:只有代码类做 sentence-window 扩展,别的类型连一次读盘都不该有
    let content = match root {
        Some(root) if needs_source(row) => std::fs::read_to_string(root.join(&row.source)).ok(),
        _ => None,
    };
    expand_with_content(row, window_lines, content.as_deref())
}

/// 异步版:读盘交给阻塞线程池,不占住 tokio 工作线程。
///
/// 回退规则与 [`expand`] 相同:读不到 / 文件变短 / 内容对不上,都用存储的片段。
pub async fn expand_async(row: &RecordRow, window_lines: usize, root: Option<&Path>) -> Windowed {
    let Some(root) = root else {
        return expand_with_content(row, window_lines, None);
    };
    if !needs_source(row) {
        return expand_with_content(row, window_lines, None);
    }
    let path = root.join(&row.source);
    match tokio::fs::read_to_string(&path).await {
        Ok(content) => expand_with_content(row, window_lines, Some(&content)),
        Err(err) => {
            // 文件被删 / 改名是常事(还没重新索引),不值得 warn;别的错误留一条 debug
            if err.kind() != std::io::ErrorKind::NotFound {
                tracing::debug!(path = %path.display(), error = %err, "读源文件失败,用存下来的片段");
            }
            expand_with_content(row, window_lines, None)
        }
    }
}

/// 这一条要不要去读源文件:代码类且行号可信(否则读了也用不上)。
fn needs_source(row: &RecordRow) -> bool {
    matches!(row.kind, RecordKind::Code)
        && matches!((row.start_line, row.end_line), (Some(start), Some(end)) if start >= 1 && end >= start)
}

/// 行号与窗口计算(不碰文件系统):`content` 为空表示读不到源文件。
fn expand_with_content(row: &RecordRow, window_lines: usize, content: Option<&str>) -> Windowed {
    if row.kind != RecordKind::Code {
        return Windowed {
            snippet: row.text.clone(),
            explain: WindowExplain {
                from: row.start_line.unwrap_or(0).max(0) as u32,
                to: row.end_line.unwrap_or(0).max(0) as u32,
                fallback: true,
            },
        };
    }
    let (start, end) = match (row.start_line, row.end_line) {
        (Some(start), Some(end)) if start >= 1 && end >= start => (start as u32, end as u32),
        _ => {
            return Windowed {
                snippet: row.text.clone(),
                explain: WindowExplain {
                    from: 0,
                    to: 0,
                    fallback: true,
                },
            };
        }
    };
    let Some(content) = content else {
        return Windowed {
            snippet: row.text.clone(),
            explain: WindowExplain {
                from: start,
                to: end,
                fallback: true,
            },
        };
    };
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() || end as usize > lines.len() {
        // 文件变短了:存储的文本仍然可信
        return Windowed {
            snippet: row.text.clone(),
            explain: WindowExplain {
                from: start,
                to: end,
                fallback: true,
            },
        };
    }
    // 文件被改过(还没重新索引)时,行号已经对不上,必须回退到存储文本(设计规范第 8 步)
    if !matches_stored_text(row, &lines) {
        return Windowed {
            snippet: row.text.clone(),
            explain: WindowExplain {
                from: start,
                to: end,
                fallback: true,
            },
        };
    }
    let from = start.saturating_sub(window_lines as u32).max(1);
    let to = (end + window_lines as u32).min(lines.len() as u32);
    let snippet = lines[(from - 1) as usize..to as usize].join("\n");
    Windowed {
        snippet,
        explain: WindowExplain {
            from,
            to,
            fallback: false,
        },
    }
}

/// 存储的 `text` 是否仍然是文件里 `[start_line, end_line]` 的内容。
///
/// 按行比较并忽略行尾空白与 CRLF;行数对不上直接判为已变化。
fn matches_stored_text(row: &RecordRow, lines: &[&str]) -> bool {
    let (Some(start), Some(end)) = (row.start_line, row.end_line) else {
        return false;
    };
    if start < 1 || end < start || end as usize > lines.len() {
        return false;
    }
    let stored: Vec<&str> = row.text.lines().collect();
    let actual: Vec<&str> = lines[(start - 1) as usize..end as usize].to_vec();
    if stored.len() != actual.len() {
        return false;
    }
    stored
        .iter()
        .zip(actual.iter())
        .all(|(left, right)| left.trim_end() == right.trim_end())
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::{ItemStatus, RecordKind};

    fn row(source: &str, start: i32, end: i32) -> RecordRow {
        RecordRow {
            id: "id".to_owned(),
            collection: "proj_demo".to_owned(),
            kind: RecordKind::Code,
            lang: Some("rust".to_owned()),
            source: source.to_owned(),
            start_line: Some(start),
            end_line: Some(end),
            symbol: None,
            title: None,
            text: "stored text".to_owned(),
            header: "h".to_owned(),
            lex: "l".to_owned(),
            tags: Vec::new(),
            status: ItemStatus::Active,
            content_hash: "c".to_owned(),
            meta_hash: "m".to_owned(),
            embed_input_hash: "e".to_owned(),
            updated_at: 0,
            anchor: None,
            vector: None,
        }
    }

    #[test]
    fn expands_from_the_source_file() {
        let dir = tempfile::tempdir().expect("目录");
        let content = (1..=40)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.path().join("a.rs"), content).expect("写");
        let mut target = row("a.rs", 10, 12);
        target.text = "line 10\nline 11\nline 12".to_owned();
        let windowed = expand(&target, 3, Some(dir.path()));
        assert!(!windowed.explain.fallback);
        assert_eq!(windowed.explain.from, 7);
        assert_eq!(windowed.explain.to, 15);
        assert_eq!(windowed.snippet.lines().count(), 9);
        assert!(windowed.snippet.starts_with("line 7"));
        assert!(windowed.snippet.ends_with("line 15"));
    }

    #[test]
    fn clamps_to_file_bounds() {
        let dir = tempfile::tempdir().expect("目录");
        std::fs::write(dir.path().join("a.rs"), "one\ntwo\nthree\n").expect("写");
        let mut target = row("a.rs", 1, 2);
        target.text = "one\ntwo".to_owned();
        let windowed = expand(&target, 10, Some(dir.path()));
        assert_eq!(windowed.explain.from, 1);
        assert_eq!(windowed.explain.to, 3);
    }

    #[test]
    fn falls_back_when_the_file_is_gone() {
        let dir = tempfile::tempdir().expect("目录");
        let windowed = expand(&row("gone.rs", 1, 2), 5, Some(dir.path()));
        assert!(windowed.explain.fallback);
        assert_eq!(windowed.snippet, "stored text");
    }

    #[test]
    fn falls_back_when_the_file_shrank() {
        let dir = tempfile::tempdir().expect("目录");
        std::fs::write(dir.path().join("a.rs"), "one\n").expect("写");
        let windowed = expand(&row("a.rs", 10, 20), 2, Some(dir.path()));
        assert!(windowed.explain.fallback);
        assert_eq!(windowed.snippet, "stored text");
    }

    #[test]
    fn falls_back_when_the_file_changed_above_the_chunk() {
        let dir = tempfile::tempdir().expect("目录");
        let original = "one\ntwo\nthree\nfour\nfive\n";
        std::fs::write(dir.path().join("a.rs"), original).expect("写");
        let mut row = row("a.rs", 2, 3);
        row.text = "two\nthree".to_owned();
        // 未改动时正常展开
        let windowed = expand(&row, 1, Some(dir.path()));
        assert!(!windowed.explain.fallback, "{windowed:?}");

        // 在文件顶部插入两行(还没有重新索引)
        std::fs::write(dir.path().join("a.rs"), format!("new1\nnew2\n{original}")).expect("写");
        let windowed = expand(&row, 1, Some(dir.path()));
        assert!(windowed.explain.fallback, "内容对不上必须回退");
        assert_eq!(windowed.snippet, "two\nthree");
    }

    #[test]
    fn rows_without_lines_fall_back() {
        let windowed = expand(&row("insight:1", 0, 0), 5, None);
        assert!(windowed.explain.fallback);
    }

    // ---------------------------------------------------------------- 异步版

    #[tokio::test]
    async fn the_async_version_expands_the_same_window() {
        let dir = tempfile::tempdir().expect("目录");
        let content = (1..=40)
            .map(|line| format!("line {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        tokio::fs::write(dir.path().join("a.rs"), content)
            .await
            .expect("写");
        let mut target = row("a.rs", 10, 12);
        target.text = "line 10\nline 11\nline 12".to_owned();
        let sync = expand(&target, 3, Some(dir.path()));
        let asynchronous = expand_async(&target, 3, Some(dir.path())).await;
        assert_eq!(sync, asynchronous);
        assert_eq!(asynchronous.explain.from, 7);
    }

    #[tokio::test]
    async fn the_async_version_falls_back_for_a_missing_file() {
        let dir = tempfile::tempdir().expect("目录");
        let windowed = expand_async(&row("gone.rs", 1, 2), 5, Some(dir.path())).await;
        assert!(windowed.explain.fallback);
        assert_eq!(windowed.snippet, "stored text");
    }

    #[tokio::test]
    async fn the_async_version_falls_back_when_the_file_changed() {
        let dir = tempfile::tempdir().expect("目录");
        tokio::fs::write(dir.path().join("a.rs"), "one\ntwo\nthree\n")
            .await
            .expect("写");
        let mut target = row("a.rs", 1, 2);
        target.text = "one\ntwo".to_owned();
        assert!(
            !expand_async(&target, 1, Some(dir.path()))
                .await
                .explain
                .fallback
        );

        tokio::fs::write(dir.path().join("a.rs"), "zero\none\ntwo\nthree\n")
            .await
            .expect("写");
        let windowed = expand_async(&target, 1, Some(dir.path())).await;
        assert!(windowed.explain.fallback, "行号位移之后必须回退");
        assert_eq!(windowed.snippet, "one\ntwo");
    }

    #[tokio::test]
    async fn the_async_version_does_not_touch_the_file_system_for_non_code_rows() {
        let dir = tempfile::tempdir().expect("目录");
        let mut target = row("a.rs", 1, 2);
        target.kind = RecordKind::Doc;
        target.text = "笔记正文".to_owned();
        // 源文件存在也不该用:非代码类一律用存储的正文
        tokio::fs::write(dir.path().join("a.rs"), "one\ntwo\n")
            .await
            .expect("写");
        let windowed = expand_async(&target, 5, Some(dir.path())).await;
        assert_eq!(windowed.snippet, "笔记正文");
        assert!(windowed.explain.fallback);
    }
}
