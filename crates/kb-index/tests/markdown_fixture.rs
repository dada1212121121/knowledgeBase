//! Markdown 分块的快照与不变量测试(验收)。
//!
//! fixture 是 `ARCHITECTURE.md` 的副本（设计规范）。

use std::path::PathBuf;

use kb_core::model::SourceDoc;
use kb_core::ports::Chunker;
use kb_index::chunk::{ChunkOptions, DefaultChunker};
use serde::Serialize;

fn fixture() -> SourceDoc {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../kb-testkit/fixtures/docs/architecture_copy.md");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("读取 {} 失败: {err}", path.display()));
    SourceDoc {
        source: "fixtures/architecture_copy.md".to_owned(),
        lang: "markdown".to_owned(),
        text,
        file_hash: "h".to_owned(),
        size: 0,
        mtime: 0,
        project_name: "kb".to_owned(),
    }
}

fn chunker(max_tokens: usize) -> DefaultChunker {
    DefaultChunker::new(ChunkOptions {
        max_tokens,
        ..ChunkOptions::default()
    })
}

#[derive(Serialize)]
struct ChunkView<'a> {
    key: &'a str,
    title: Option<&'a str>,
    start_line: i32,
    end_line: i32,
}

#[test]
fn chunk_snapshot_architecture_headings() {
    let doc = fixture();
    let chunks = chunker(512).chunk(&doc);
    assert!(chunks.len() > 20, "应该切成很多小节,实际 {}", chunks.len());
    let views: Vec<ChunkView<'_>> = chunks
        .iter()
        .map(|chunk| ChunkView {
            key: &chunk.key,
            title: chunk.title.as_deref(),
            start_line: chunk.start_line,
            end_line: chunk.end_line,
        })
        .collect();
    insta::assert_yaml_snapshot!("architecture_headings", views);
}

#[test]
fn chunk_heading_paths_are_correct() {
    let doc = fixture();
    let chunks = chunker(512).chunk(&doc);
    // 设计规范的标题路径应是 "… › 14. 演进优化 › 14.1 双哈希增量索引 (来源: Notion \"Page State\")"
    let section = chunks
        .iter()
        .find(|chunk| chunk.key.contains("14.1"))
        .expect("应有 14.1 小节");
    let title = section.title.as_deref().expect("小节应有标题");
    assert!(title.contains("14.1"), "title = {title}");
    assert!(title.contains('›'), "title 应包含父级标题:{title}");
    assert!(
        section
            .header
            .starts_with("kb › fixtures/architecture_copy.md › ")
    );
    assert!(section.header.contains("14.1"));
    // 正文确实属于该小节
    assert!(section.text.contains("14.1") || section.text.contains("双哈希"));
}

#[test]
fn chunk_fenced_code_blocks_are_never_split() {
    let doc = fixture();
    let chunks = chunker(512).chunk(&doc);
    for (start_line, end_line) in fenced_blocks(&doc.text) {
        let covering = chunks
            .iter()
            .any(|chunk| chunk.start_line <= start_line && chunk.end_line >= end_line);
        assert!(covering, "代码块 {start_line}..{end_line} 被切断了");
    }
}

#[test]
fn chunk_every_non_empty_line_is_covered() {
    let doc = fixture();
    let chunks = chunker(512).chunk(&doc);
    let mut covered = vec![false; doc.text.lines().count()];
    for chunk in &chunks {
        for line in chunk.start_line..=chunk.end_line {
            if let Some(slot) = covered.get_mut((line - 1) as usize) {
                *slot = true;
            }
        }
    }
    for (index, line) in doc.text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        assert!(covered[index], "第 {} 行没有被任何块覆盖:{line}", index + 1);
    }
}

#[test]
fn chunk_plain_text_files_use_window_chunks() {
    let doc = SourceDoc {
        source: "notes.txt".to_owned(),
        lang: "text".to_owned(),
        text: (1..=80)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n"),
        file_hash: "h".to_owned(),
        size: 0,
        mtime: 0,
        project_name: "demo".to_owned(),
    };
    let chunks = chunker(512).chunk(&doc);
    assert!(chunks.len() >= 2);
    assert!(chunks.iter().all(|chunk| chunk.key.starts_with('#')));
}

/// 找出所有围栏代码块的 (起始行, 结束行),1 起。
fn fenced_blocks(text: &str) -> Vec<(i32, i32)> {
    let mut blocks = Vec::new();
    let mut start: Option<i32> = None;
    for (index, line) in text.lines().enumerate() {
        let line_number = index as i32 + 1;
        if line.trim_start().starts_with("```") {
            match start {
                Some(begin) => {
                    blocks.push((begin, line_number));
                    start = None;
                }
                None => start = Some(line_number),
            }
        }
    }
    blocks
}
