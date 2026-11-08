//! tree-sitter 分块的快照与不变量测试(验收)。
//!
//! 快照固定每种语言的输出(key / 行范围 / symbol / header);
//! 另外断言:每块不超过 `max_tokens`(512 与 256 两种配置)、所有非空行都被覆盖、
//! 解析失败时退回窗口分块。

use std::path::PathBuf;

use kb_core::model::SourceDoc;
use kb_core::ports::Chunker;
use kb_core::text::estimate_tokens;
use kb_index::chunk::{ChunkOptions, TreeSitterChunker};
use serde::Serialize;

/// 十二种语言(+ TSX)与对应的 fixture 文件(增加 bash / ruby / php / swift)。
const FIXTURES: [(&str, &str); 13] = [
    ("rust", "rust.rs"),
    ("python", "python.py"),
    ("javascript", "javascript.js"),
    ("typescript", "typescript.ts"),
    ("go", "go.go"),
    ("java", "java.java"),
    ("c", "c.c"),
    ("cpp", "cpp.cpp"),
    ("tsx", "tsx.tsx"),
    ("bash", "bash.sh"),
    ("ruby", "ruby.rb"),
    ("php", "php.php"),
    ("swift", "swift.swift"),
];

/// 快照里只保留 key / 行范围 / symbol / header(正文由覆盖与长度断言把关)。
#[derive(Serialize)]
struct ChunkView<'a> {
    key: &'a str,
    start_line: i32,
    end_line: i32,
    symbol: Option<&'a str>,
    header: &'a str,
}

fn fixture(lang: &str, file: &str) -> SourceDoc {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../kb-testkit/fixtures/code")
        .join(file);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|err| panic!("读取 {} 失败: {err}", path.display()));
    SourceDoc {
        source: format!("fixtures/{file}"),
        lang: lang.to_owned(),
        text,
        file_hash: "h".to_owned(),
        size: 0,
        mtime: 0,
        project_name: "demo".to_owned(),
    }
}

fn chunker(max_tokens: usize) -> TreeSitterChunker {
    TreeSitterChunker::new(ChunkOptions {
        max_tokens,
        ..ChunkOptions::default()
    })
}

macro_rules! snapshot_test {
    ($name:ident, $lang:expr, $file:expr) => {
        #[test]
        fn $name() {
            let doc = fixture($lang, $file);
            let chunks = chunker(512).chunk(&doc);
            assert!(!chunks.is_empty(), "{} 应有分块结果", $lang);
            let views: Vec<ChunkView<'_>> = chunks
                .iter()
                .map(|chunk| ChunkView {
                    key: &chunk.key,
                    start_line: chunk.start_line,
                    end_line: chunk.end_line,
                    symbol: chunk.symbol.as_deref(),
                    header: &chunk.header,
                })
                .collect();
            insta::assert_yaml_snapshot!($lang, views);
        }
    };
}

snapshot_test!(chunk_snapshot_rust, "rust", "rust.rs");
snapshot_test!(chunk_snapshot_python, "python", "python.py");
snapshot_test!(chunk_snapshot_javascript, "javascript", "javascript.js");
snapshot_test!(chunk_snapshot_typescript, "typescript", "typescript.ts");
snapshot_test!(chunk_snapshot_go, "go", "go.go");
snapshot_test!(chunk_snapshot_java, "java", "java.java");
snapshot_test!(chunk_snapshot_c, "c", "c.c");
snapshot_test!(chunk_snapshot_cpp, "cpp", "cpp.cpp");
snapshot_test!(chunk_snapshot_tsx, "tsx", "tsx.tsx");
snapshot_test!(chunk_snapshot_bash, "bash", "bash.sh");
snapshot_test!(chunk_snapshot_ruby, "ruby", "ruby.rb");
snapshot_test!(chunk_snapshot_php, "php", "php.php");
snapshot_test!(chunk_snapshot_swift, "swift", "swift.swift");

#[test]
fn chunk_max_tokens_hold_for_both_limits() {
    for max_tokens in [512usize, 256] {
        for (lang, file) in FIXTURES {
            let doc = fixture(lang, file);
            let chunks = chunker(max_tokens).chunk(&doc);
            assert!(!chunks.is_empty(), "{lang} 应有分块");
            for chunk in &chunks {
                let input = format!("{}\n{}", chunk.header, chunk.text);
                assert!(
                    estimate_tokens(&input) <= max_tokens,
                    "{lang} 的块 {} 超出 max_tokens={max_tokens}:{} 个 token",
                    chunk.key,
                    estimate_tokens(&input)
                );
            }
        }
    }
}

#[test]
fn chunk_every_non_empty_line_is_covered() {
    for (lang, file) in FIXTURES {
        let doc = fixture(lang, file);
        let chunks = chunker(512).chunk(&doc);
        let line_count = doc.text.lines().count();
        let mut covered = vec![false; line_count];
        for chunk in &chunks {
            assert!(
                chunk.start_line >= 1 && chunk.end_line >= chunk.start_line,
                "{lang} 的块 {} 行范围不合法:{}..{}",
                chunk.key,
                chunk.start_line,
                chunk.end_line
            );
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
            assert!(
                covered[index],
                "{lang} 的第 {} 行没有被任何块覆盖:{line}",
                index + 1
            );
        }
    }
}

#[test]
fn chunk_blocks_do_not_overlap() {
    for (lang, file) in FIXTURES {
        let doc = fixture(lang, file);
        let chunks = chunker(512).chunk(&doc);
        let mut previous: Option<(i32, i32, String)> = None;
        for chunk in &chunks {
            if let Some((_, end, key)) = &previous {
                assert!(
                    chunk.start_line > *end,
                    "{lang}: 块 {key} 结束于 {end},块 {} 却从 {} 开始(行范围重叠)",
                    chunk.key,
                    chunk.start_line
                );
            }
            previous = Some((chunk.start_line, chunk.end_line, chunk.key.clone()));
        }
    }
}

#[test]
fn chunk_parse_failure_falls_back_to_window_chunks() {
    let doc = SourceDoc {
        source: "fixtures/broken.rs".to_owned(),
        lang: "rust".to_owned(),
        text: "fn main( {\n    let x = ;\n    let y = 1;\n}\n".to_owned(),
        file_hash: "h".to_owned(),
        size: 0,
        mtime: 0,
        project_name: "demo".to_owned(),
    };
    let chunks = chunker(512).chunk(&doc);
    assert!(!chunks.is_empty());
    assert_eq!(chunks[0].key, "#1", "解析失败应退回窗口分块");
    assert!(chunks.iter().all(|chunk| chunk.symbol.is_none()));
    assert!(chunks.iter().any(|chunk| chunk.text.contains("let y = 1;")));
}
