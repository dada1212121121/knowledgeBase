//! Jupyter Notebook(.ipynb)抽取。
//!
//! 结构是 JSON:`cells[]`,每个 cell 有 `cell_type`(markdown / code / raw)、`source`
//! (字符串数组或字符串)、`outputs`(代码单元的输出)。
//!
//! 抽取规则:
//! - markdown 单元 → 按 `#` 层级拆成标题 / 段落(代码围栏也保留);
//! - code 单元 → `Block::Code`,语言取 notebook 的 `metadata.language_info.name`;
//! - 输出里的文本(`stream` / `execute_result` / `error`)作为段落跟在代码后面 —— 检索时
//!   “报错信息”“打印结果”都能命中;
//! - anchor 用单元序号(第 n 个单元)。

use async_trait::async_trait;
use kb_core::model::{Anchor, AnchoredBlock, Block, Confidence, Doc, DocMeta, SourceRef};
use kb_core::ports::Extractor;
use kb_core::{KbError, Result};
use serde_json::Value;

/// Notebook 抽取器。
pub struct IpynbExtractor;

#[async_trait]
impl Extractor for IpynbExtractor {
    fn id(&self) -> &str {
        "application/x-ipynb+json"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if ext.eq_ignore_ascii_case("ipynb") {
            return Confidence::Probable;
        }
        // 魔数:JSON 里同时出现 "cells" 与 "nbformat"
        let head_text = String::from_utf8_lossy(&head[..head.len().min(4096)]);
        if head_text.contains("\"cells\"") && head_text.contains("\"nbformat\"") {
            return Confidence::Certain;
        }
        Confidence::Unlikely
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let text = String::from_utf8_lossy(bytes).into_owned();
        let notebook: Value = serde_json::from_str(&text)
            .map_err(|err| KbError::InvalidInput(format!("notebook 不是合法 JSON: {err}")))?;
        let language = notebook
            .get("metadata")
            .and_then(|meta| meta.get("language_info"))
            .and_then(|info| info.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("python")
            .to_owned();
        let blocks = notebook_blocks(&notebook, &language);
        if blocks.is_empty() {
            return Err(KbError::InvalidInput(
                "notebook 里没有可抽取的单元".to_owned(),
            ));
        }
        Ok(Doc {
            meta: DocMeta {
                source: source.location.clone(),
                title: None,
                lang: language,
                mime: Some("application/x-ipynb+json".to_owned()),
                file_hash: kb_core::hash::content_hash(&text),
                size: bytes.len() as u64,
                mtime: 0,
                project_name: source
                    .project_root
                    .as_ref()
                    .and_then(|root| root.file_name())
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            },
            blocks,
        })
    }
}

/// notebook JSON → 块序列。
pub fn notebook_blocks(notebook: &Value, language: &str) -> Vec<AnchoredBlock> {
    let mut blocks = Vec::new();
    let Some(cells) = notebook.get("cells").and_then(Value::as_array) else {
        return blocks;
    };
    for (index, cell) in cells.iter().enumerate() {
        let anchor = Anchor::Line {
            start: index as u32 + 1,
            end: index as u32 + 1,
        };
        let cell_type = cell
            .get("cell_type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let source = join_source(cell.get("source"));
        match cell_type {
            "markdown" => {
                for block in markdown_blocks(&source) {
                    blocks.push(AnchoredBlock {
                        anchor: anchor.clone(),
                        block,
                    });
                }
            }
            "code" => {
                if !source.trim().is_empty() {
                    blocks.push(AnchoredBlock {
                        anchor: anchor.clone(),
                        block: Block::Code {
                            lang: language.to_owned(),
                            text: source,
                        },
                    });
                }
                // 输出:检索“报错信息”时要能命中
                for output in cell
                    .get("outputs")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    let text = output_text(output);
                    if !text.trim().is_empty() {
                        blocks.push(AnchoredBlock {
                            anchor: anchor.clone(),
                            block: Block::Paragraph {
                                text: format!("输出:{text}"),
                            },
                        });
                    }
                }
            }
            "raw" if !source.trim().is_empty() => {
                blocks.push(AnchoredBlock {
                    anchor,
                    block: Block::Paragraph { text: source },
                });
            }
            _ => {}
        }
    }
    blocks
}

/// `source` / `text` 可能是字符串数组,也可能是单个字符串。
fn join_source(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// 一个输出里的可读文本。
fn output_text(output: &Value) -> String {
    match output.get("output_type").and_then(Value::as_str) {
        Some("stream") => join_source(output.get("text")),
        Some("execute_result") | Some("display_data") => output
            .get("data")
            .map(|data| {
                let mut parts = Vec::new();
                if let Some(text) = data.get("text/plain") {
                    parts.push(join_source(Some(text)));
                }
                parts.join("\n")
            })
            .unwrap_or_default(),
        Some("error") => {
            let name = output
                .get("ename")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let value = output
                .get("evalue")
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!("{name}: {value}")
        }
        _ => String::new(),
    }
}

/// markdown 单元 → 标题 / 段落(复用 HTML 之外的最小规则)。
fn markdown_blocks(text: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut paragraph = String::new();
    let mut in_code = false;
    let mut code = String::new();
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.starts_with("```") {
            if in_code {
                blocks.push(Block::Code {
                    lang: String::new(),
                    text: std::mem::take(&mut code).trim_end().to_owned(),
                });
                in_code = false;
            } else {
                flush_paragraph(&mut paragraph, &mut blocks);
                in_code = true;
            }
            continue;
        }
        if in_code {
            code.push_str(line);
            code.push('\n');
            continue;
        }
        if let Some(level) = heading_level(trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks);
            blocks.push(Block::Heading {
                level,
                text: trimmed[level as usize..].trim().to_owned(),
            });
            continue;
        }
        if trimmed.is_empty() {
            flush_paragraph(&mut paragraph, &mut blocks);
            continue;
        }
        if !paragraph.is_empty() {
            paragraph.push('\n');
        }
        paragraph.push_str(trimmed);
    }
    if in_code && !code.trim().is_empty() {
        blocks.push(Block::Code {
            lang: String::new(),
            text: code.trim_end().to_owned(),
        });
    }
    flush_paragraph(&mut paragraph, &mut blocks);
    blocks
}

fn heading_level(line: &str) -> Option<u8> {
    let hashes = line.chars().take_while(|ch| *ch == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    // `#` 后面必须是空格或行尾
    match line.chars().nth(hashes) {
        Some(' ') | None => Some(hashes as u8),
        _ => None,
    }
}

fn flush_paragraph(paragraph: &mut String, blocks: &mut Vec<Block>) {
    let text = paragraph.trim().to_owned();
    paragraph.clear();
    if !text.is_empty() {
        blocks.push(Block::Paragraph { text });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> SourceRef {
        SourceRef {
            scheme: "file".to_owned(),
            location: "analysis.ipynb".to_owned(),
            project_root: None,
        }
    }

    fn sample() -> String {
        r##"{
          "nbformat": 4,
          "metadata": {"language_info": {"name": "python"}},
          "cells": [
            {"cell_type": "markdown", "source": ["# 数据分析\n", "\n", "这里统计每日活跃。\n"]},
            {"cell_type": "code", "source": ["import pandas as pd\n", "df.head()\n"],
             "outputs": [{"output_type": "execute_result", "data": {"text/plain": ["   a  b\n", "0  1  2"]}}]},
            {"cell_type": "code", "source": ["1/0"], "outputs": [
              {"output_type": "error", "ename": "ZeroDivisionError", "evalue": "division by zero"}]}
          ]
        }"##
        .to_owned()
    }

    #[tokio::test]
    async fn extracts_markdown_code_and_outputs() {
        let doc = IpynbExtractor
            .extract(&source(), sample().as_bytes())
            .await
            .expect("抽取");
        let text = doc.text();
        assert!(text.contains("数据分析"), "{text}");
        assert!(text.contains("这里统计每日活跃"), "{text}");
        assert!(text.contains("import pandas"), "{text}");
        assert!(text.contains("输出:"), "输出应进块:{text}");
        assert!(
            text.contains("ZeroDivisionError"),
            "报错信息应可检索:{text}"
        );
        // 标题层级保留
        assert!(doc
            .blocks
            .iter()
            .any(|block| matches!(&block.block, Block::Heading { level: 1, text } if text.contains("数据分析"))));
        // 代码块语言来自 notebook 元数据
        assert!(
            doc.blocks
                .iter()
                .any(|block| matches!(&block.block, Block::Code { lang, .. } if lang == "python"))
        );
    }

    #[test]
    fn detection_uses_extension_and_magic() {
        assert_eq!(IpynbExtractor.detect(b"{}", "ipynb"), Confidence::Probable);
        assert_eq!(
            IpynbExtractor.detect(b"{\"cells\": [], \"nbformat\": 4}", "json"),
            Confidence::Certain
        );
        assert_eq!(IpynbExtractor.detect(b"{}", "json"), Confidence::Unlikely);
    }

    #[tokio::test]
    async fn broken_json_is_an_error() {
        let error = IpynbExtractor
            .extract(&source(), b"not json")
            .await
            .expect_err("坏 JSON 应报错");
        assert!(matches!(error, KbError::InvalidInput(_)), "{error}");
    }
}
