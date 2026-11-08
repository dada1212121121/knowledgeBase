//! HTML 正文抽取。
//!
//! 目标是“检索够用”:去掉脚本、样式、导航、页眉页脚、侧栏与表单,只留正文;
//! 标题按 `h1..h6` 分层,段落按块级标签切。
//!
//! 这里没有引入 `scraper` / html2text(依赖表里标了 ○、且会带进 html5ever 一整棵树):
//! 先用“标签状态机 + 噪声标签剪枝”的启发式,真正的 readability 类算法留到 的质量阶段
//! (见下文)。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Anchor, AnchoredBlock, Block, Confidence, Doc, DocMeta, SourceRef};
use kb_core::ports::Extractor;

/// HTML 抽取器。
pub struct HtmlExtractor;

#[async_trait]
impl Extractor for HtmlExtractor {
    fn id(&self) -> &str {
        "text/html"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        let head_text = String::from_utf8_lossy(&head[..head.len().min(1024)]).to_ascii_lowercase();
        if head_text.contains("<html") || head_text.contains("<!doctype html") {
            return Confidence::Certain;
        }
        if matches!(
            ext.trim_start_matches('.').to_ascii_lowercase().as_str(),
            "html" | "htm" | "xhtml"
        ) {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let html = String::from_utf8_lossy(bytes).into_owned();
        let page = extract_html(&html);
        let mut blocks = Vec::new();
        for (index, item) in page.blocks.into_iter().enumerate() {
            let ordinal = index as u32 + 1;
            blocks.push(AnchoredBlock {
                anchor: Anchor::Line {
                    start: ordinal,
                    end: ordinal,
                },
                block: item,
            });
        }
        Ok(Doc {
            meta: DocMeta {
                source: source.location.clone(),
                title: page.title,
                lang: page.lang,
                mime: Some("text/html".to_owned()),
                file_hash: kb_core::hash::content_hash(&html),
                size: bytes.len() as u64,
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
        })
    }
}

/// 抽取结果。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Page {
    /// `<title>`。
    pub title: Option<String>,
    /// `<html lang>`。
    pub lang: String,
    /// 正文块。
    pub blocks: Vec<Block>,
}

/// 噪声标签:整段跳过。
const NOISE: &[&str] = &[
    "script", "style", "noscript", "nav", "header", "footer", "aside", "form", "svg", "iframe",
    "template", "button", "select", "textarea", "menu",
];

/// 块级标签:遇到它们就断段。
const BLOCK_TAGS: &[&str] = &[
    "p",
    "div",
    "section",
    "article",
    "main",
    "li",
    "ul",
    "ol",
    "dl",
    "dt",
    "dd",
    "tr",
    "blockquote",
    "pre",
    "figure",
    "figcaption",
    "br",
    "hr",
    "td",
    "th",
    "table",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "title",
];

/// 把 HTML 抽成标题 / 段落。
pub fn extract_html(html: &str) -> Page {
    let mut page = Page {
        lang: "zh".to_owned(),
        ..Page::default()
    };
    let mut blocks: Vec<Block> = Vec::new();
    let mut buffer = String::new();
    let mut skip_depth: usize = 0;
    let mut skip_tag = String::new();
    let mut heading: Option<u8> = None;
    let mut in_title = false;
    let mut in_pre = false;

    let mut rest = html;
    while let Some(start) = rest.find('<') {
        // 标签前的文本
        let text = &rest[..start];
        if skip_depth == 0 && !text.trim().is_empty() {
            if in_title {
                page.title
                    .get_or_insert_with(String::new)
                    .push_str(text.trim());
            } else {
                push_text(&mut buffer, text, in_pre);
            }
        }
        rest = &rest[start..];

        // 注释
        if let Some(after) = rest.strip_prefix("<!--") {
            match after.find("-->") {
                Some(end) => {
                    rest = &after[end + 3..];
                    continue;
                }
                None => break,
            }
        }

        // 标签
        let Some(close) = rest.find('>') else { break };
        let tag_body = &rest[1..close];
        let is_end = tag_body.starts_with('/');
        let is_self_closing = tag_body.ends_with('/');
        let name = tag_body
            .trim_start_matches('/')
            .split(|ch: char| ch.is_whitespace() || ch == '/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let attributes = tag_body.to_ascii_lowercase();

        if name == "html"
            && !is_end
            && let Some(lang) = lang_of(&attributes)
        {
            page.lang = lang;
        }

        if NOISE.contains(&name.as_str()) {
            if is_end {
                if skip_depth > 0 && skip_tag == name {
                    skip_depth -= 1;
                }
            } else if !is_self_closing {
                skip_depth += 1;
                skip_tag = name.clone();
            }
            rest = &rest[close + 1..];
            continue;
        }

        if skip_depth > 0 {
            rest = &rest[close + 1..];
            continue;
        }

        match name.as_str() {
            "title" => {
                if is_end {
                    in_title = false;
                    // 标题既记进 meta,也当成一级标题块(检索时能命中)
                    if let Some(title) = page.title.as_mut() {
                        *title = title.trim().to_owned();
                        if !title.is_empty() {
                            blocks.push(Block::Heading {
                                level: 1,
                                text: title.clone(),
                            });
                        }
                    }
                } else {
                    in_title = true;
                    page.title = Some(String::new());
                }
            }
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                if is_end {
                    flush(&mut buffer, &mut blocks, heading.take());
                } else {
                    flush(&mut buffer, &mut blocks, None);
                    heading = Some(name[1..].parse::<u8>().unwrap_or(1));
                }
            }
            "pre" => {
                if is_end {
                    flush(&mut buffer, &mut blocks, None);
                    in_pre = false;
                } else {
                    flush(&mut buffer, &mut blocks, None);
                    in_pre = true;
                }
            }
            "br" => buffer.push('\n'),
            _ if BLOCK_TAGS.contains(&name.as_str()) => {
                flush(&mut buffer, &mut blocks, None);
            }
            _ => {}
        }
        rest = &rest[close + 1..];
    }
    if skip_depth == 0 {
        flush(&mut buffer, &mut blocks, heading.take());
    }
    page.blocks = blocks;
    page
}

fn lang_of(attributes: &str) -> Option<String> {
    let start = attributes.find("lang=")? + 5;
    let rest = attributes[start..].trim_start_matches(['"', '\'']);
    let value: String = rest
        .chars()
        .take_while(|ch| *ch != '"' && *ch != '\'' && !ch.is_whitespace())
        .collect();
    (!value.is_empty()).then_some(value)
}

fn push_text(buffer: &mut String, text: &str, in_pre: bool) {
    let decoded = decode_entities(text);
    if in_pre {
        buffer.push_str(&decoded);
        return;
    }
    let trimmed = decoded.trim();
    if trimmed.is_empty() {
        return;
    }
    if !buffer.is_empty() && !buffer.ends_with([' ', '\n']) {
        buffer.push(' ');
    }
    buffer.push_str(trimmed);
}

fn flush(buffer: &mut String, blocks: &mut Vec<Block>, heading: Option<u8>) {
    let text = buffer.trim().to_owned();
    buffer.clear();
    if text.is_empty() {
        return;
    }
    blocks.push(match heading {
        Some(level) => Block::Heading { level, text },
        None => Block::Paragraph { text },
    });
}

/// 常见实体解码(够检索用)。
pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = rest.find('&') {
        out.push_str(&rest[..index]);
        rest = &rest[index..];
        let Some(end) = rest.find(';').filter(|end| *end <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            "mdash" => Some('—'),
            "ndash" => Some('–'),
            "hellip" => Some('…'),
            "ldquo" => Some('“'),
            "rdquo" => Some('”'),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| {
                    entity
                        .strip_prefix('#')
                        .and_then(|digits| digits.parse::<u32>().ok())
                })
                .and_then(char::from_u32),
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(location: &str) -> SourceRef {
        SourceRef {
            scheme: "file".to_owned(),
            location: location.to_owned(),
            project_root: None,
        }
    }

    #[test]
    fn strips_navigation_and_scripts() {
        let html = r#"<html lang="zh-CN"><head><title>文档站</title>
<style>body{color:red}</style><script>var x=1;</script></head>
<body><nav><a href="/">导航一</a><a href="/docs">导航二</a></nav>
<header>站点头部</header>
<main><h1>安装</h1><p>先安装 Rust,再执行 cargo build。</p>
<h2>配置</h2><p>编辑 config.toml。</p></main>
<footer>版权所有</footer></body></html>"#;
        let page = extract_html(html);
        let text = page
            .blocks
            .iter()
            .map(|block| block.text())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("安装"), "{text}");
        assert!(text.contains("cargo build"), "{text}");
        assert!(text.contains("config.toml"), "{text}");
        for noise in [
            "导航一",
            "导航二",
            "站点头部",
            "版权所有",
            "color:red",
            "var x",
        ] {
            assert!(!text.contains(noise), "噪声 {noise} 不应出现:{text}");
        }
        assert_eq!(page.lang, "zh-cn");
        assert_eq!(page.title.as_deref(), Some("文档站"));
        assert!(
            page.blocks
                .iter()
                .any(|block| matches!(block, Block::Heading { level: 1, .. }))
        );
    }

    #[test]
    fn decodes_entities_and_keeps_preformatted_text() {
        let page =
            extract_html("<p>a &amp; b &lt;c&gt; &#20013;&#25991;</p><pre>line1\nline2</pre>");
        let text = page
            .blocks
            .iter()
            .map(|block| block.text())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(text.contains("a & b <c> 中文"), "{text}");
        assert!(text.contains("line1\nline2"), "pre 里的换行要保留:{text}");
    }

    #[tokio::test]
    async fn extract_returns_anchored_blocks() {
        let doc = HtmlExtractor
            .extract(
                &source("docs/install.html"),
                b"<html><body><h1>T</h1><p>P</p></body></html>",
            )
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 2);
        assert_eq!(doc.blocks[0].anchor, Anchor::Line { start: 1, end: 1 });
        assert_eq!(doc.blocks[1].anchor, Anchor::Line { start: 2, end: 2 });
    }

    #[test]
    fn detection_uses_magic_then_extension() {
        assert_eq!(
            HtmlExtractor.detect(b"<!DOCTYPE html><html>", "txt"),
            Confidence::Certain
        );
        assert_eq!(HtmlExtractor.detect(b"hello", "html"), Confidence::Probable);
        assert_eq!(HtmlExtractor.detect(b"hello", "md"), Confidence::Unlikely);
    }
}
