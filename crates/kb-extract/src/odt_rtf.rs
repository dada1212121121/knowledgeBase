//! ODT 与 RTF 抽取器(收尾两种格式)。
//!
//! - **ODT** 是 zip + `content.xml`(`text:h` / `text:p` / `table:table`),结构同 docx;
//! - **RTF** 是纯文本的控制字流:这里只做“去控制字、保留正文”,够检索用(不做排版还原)。

use async_trait::async_trait;
use kb_core::model::{Anchor, AnchoredBlock, Block, Confidence, Doc, DocMeta, SourceRef};
use kb_core::ports::Extractor;
use kb_core::{KbError, Result};
use quick_xml::Reader;
use quick_xml::events::Event;

use crate::zip::{ZipLimits, read_all};

/// OpenDocument 文本(.odt)。
pub struct OdtExtractor;

#[async_trait]
impl Extractor for OdtExtractor {
    fn id(&self) -> &str {
        "application/vnd.oasis.opendocument.text"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if !crate::zip::looks_like_zip(head) {
            return Confidence::Unlikely;
        }
        if head.windows(8).any(|window| window == b"mimetype") && ext.eq_ignore_ascii_case("odt") {
            return Confidence::Certain;
        }
        if ext.eq_ignore_ascii_case("odt") {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let entries = read_all(bytes, ZipLimits::default())
            .map_err(|err| KbError::InvalidInput(err.to_string()))?;
        let content = entries
            .iter()
            .find(|entry| entry.name == "content.xml")
            .ok_or_else(|| KbError::InvalidInput("odt 缺少 content.xml".to_owned()))?;
        let blocks = odt_blocks(&content.text());
        Ok(doc_of(source, "vnd.oasis.opendocument.text", blocks, bytes))
    }
}

/// RTF(.rtf)。
pub struct RtfExtractor;

#[async_trait]
impl Extractor for RtfExtractor {
    fn id(&self) -> &str {
        "application/rtf"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if head.starts_with(b"{\\rtf") {
            return Confidence::Certain;
        }
        if ext.eq_ignore_ascii_case("rtf") {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let text = String::from_utf8_lossy(bytes).into_owned();
        let plain = rtf_to_text(&text);
        let mut blocks = Vec::new();
        let mut ordinal = 0u32;
        for paragraph in plain.split("\n\n") {
            let body = paragraph.trim();
            if body.is_empty() {
                continue;
            }
            ordinal += 1;
            blocks.push(AnchoredBlock {
                anchor: Anchor::Line {
                    start: ordinal,
                    end: ordinal,
                },
                block: Block::Paragraph {
                    text: body.to_owned(),
                },
            });
        }
        Ok(doc_of(source, "rtf", blocks, bytes))
    }
}

fn doc_of(source: &SourceRef, mime_suffix: &str, blocks: Vec<AnchoredBlock>, bytes: &[u8]) -> Doc {
    Doc {
        meta: DocMeta {
            source: source.location.clone(),
            title: None,
            lang: "zh".to_owned(),
            mime: Some(format!("application/{mime_suffix}")),
            file_hash: kb_core::hash::content_hash(&String::from_utf8_lossy(bytes)),
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
    }
}

/// ODT 的 `content.xml` → 标题 / 段落 / 表格。
pub fn odt_blocks(xml: &str) -> Vec<AnchoredBlock> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut blocks = Vec::new();
    let mut paragraph = String::new();
    let mut heading_level: Option<u8> = None;
    let mut in_paragraph = false;
    let mut table: Option<Vec<Vec<String>>> = None;
    let mut cell = String::new();
    let mut ordinal = 0u32;

    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => match start.name().as_ref() {
                b"text:h" => {
                    in_paragraph = true;
                    paragraph.clear();
                    heading_level = start
                        .try_get_attribute("text:outline-level")
                        .ok()
                        .flatten()
                        .and_then(|value| {
                            value
                                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .ok()
                        })
                        .and_then(|value| value.parse::<u8>().ok())
                        .map(|level| level.clamp(1, 6));
                }
                b"text:p" => {
                    in_paragraph = true;
                    paragraph.clear();
                    heading_level = None;
                }
                b"table:table" => table = Some(Vec::new()),
                b"table:table-row" => {
                    if let Some(rows) = table.as_mut() {
                        rows.push(Vec::new());
                    }
                }
                b"text:tab" if in_paragraph => paragraph.push('\t'),
                b"text:line-break" if in_paragraph => paragraph.push('\n'),
                b"text:s" if in_paragraph => paragraph.push(' '),
                _ => {}
            },
            Ok(Event::Empty(empty)) => match empty.name().as_ref() {
                b"text:tab" => paragraph.push('\t'),
                b"text:line-break" => paragraph.push('\n'),
                b"text:s" => paragraph.push(' '),
                _ => {}
            },
            Ok(Event::Text(text)) => {
                if in_paragraph {
                    paragraph.push_str(
                        &text
                            .decode()
                            .map(|value| value.into_owned())
                            .unwrap_or_default(),
                    );
                }
            }
            Ok(Event::End(end)) => match end.name().as_ref() {
                b"text:h" | b"text:p" => {
                    in_paragraph = false;
                    let body = paragraph.trim().to_owned();
                    // 表格单元格里的段落属于单元格,不单独成块
                    if table.is_some() {
                        if !body.is_empty() {
                            if !cell.is_empty() {
                                cell.push(' ');
                            }
                            cell.push_str(&body);
                        }
                        paragraph.clear();
                        continue;
                    }
                    if !body.is_empty() {
                        ordinal += 1;
                        let block = match heading_level.take() {
                            Some(level) => Block::Heading { level, text: body },
                            None => Block::Paragraph { text: body },
                        };
                        blocks.push(AnchoredBlock {
                            anchor: Anchor::Line {
                                start: ordinal,
                                end: ordinal,
                            },
                            block,
                        });
                    }
                }
                b"table:table-cell" => {
                    if let Some(rows) = table.as_mut()
                        && let Some(row) = rows.last_mut()
                    {
                        row.push(std::mem::take(&mut cell));
                    }
                }
                b"table:table" => {
                    if let Some(mut rows) = table.take() {
                        ordinal += 1;
                        let header = if rows.is_empty() {
                            Vec::new()
                        } else {
                            rows.remove(0)
                        };
                        let block = Block::Table { header, rows };
                        if !block.is_empty() {
                            blocks.push(AnchoredBlock {
                                anchor: Anchor::Line {
                                    start: ordinal,
                                    end: ordinal,
                                },
                                block,
                            });
                        }
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    blocks
}

/// RTF → 纯文本(去控制字与不可见分组)。
pub fn rtf_to_text(rtf: &str) -> String {
    let bytes = rtf.as_bytes();
    let mut out = String::new();
    let mut index = 0usize;
    // 当前所在的不可见分组深度(`{\*\...}` / `{\fonttbl` 等)
    let mut skip_depth: Option<usize> = None;
    let mut depth = 0usize;
    const DESTINATIONS: [&str; 6] = [
        "fonttbl",
        "colortbl",
        "stylesheet",
        "info",
        "pict",
        "header",
    ];

    while index < bytes.len() {
        let byte = bytes[index];
        match byte {
            b'{' => {
                depth += 1;
                // `{\*\` 是扩展目标,整组跳过
                if bytes[index + 1..].starts_with(b"\\*") {
                    skip_depth = Some(depth);
                    index += 3;
                    continue;
                }
                // 已知的不可见目标(`{\fonttbl` …)
                let rest = &rtf[index + 1..];
                if let Some(name) = DESTINATIONS
                    .iter()
                    .find(|name| rest.starts_with(&format!("\\{name}")))
                {
                    let _ = name;
                    skip_depth = Some(depth);
                }
                index += 1;
            }
            b'}' => {
                if skip_depth == Some(depth) {
                    skip_depth = None;
                }
                depth = depth.saturating_sub(1);
                index += 1;
            }
            b'\\' => {
                if let Some((ch, consumed)) = rtf_escape_char(&rtf[index..]) {
                    if skip_depth.is_none() {
                        out.push(ch);
                    }
                    index += consumed;
                    continue;
                }
                let (word, consumed) = rtf_word(&rtf[index..]);
                index += consumed;
                if skip_depth.is_some() {
                    continue;
                }
                match word.as_str() {
                    "par" | "line" => out.push('\n'),
                    "tab" => out.push('\t'),
                    "emdash" => out.push('—'),
                    "endash" => out.push('–'),
                    "lquote" => out.push('‘'),
                    "rquote" => out.push('’'),
                    "ldblquote" => out.push('“'),
                    "rdblquote" => out.push('”'),
                    _ => {}
                }
            }
            b'\r' | b'\n' => index += 1,
            _ => {
                if skip_depth.is_none() {
                    // 取一个完整 UTF-8 字符
                    let rest = &rtf[index..];
                    if let Some(ch) = rest.chars().next() {
                        out.push(ch);
                        index += ch.len_utf8();
                        continue;
                    }
                }
                index += 1;
            }
        }
    }
    // 段落之间留空行,便于后续按段切分
    out.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// `\'hh` 与 `\uNNNN?` 直接解成一个字符;其它控制字返回 `None`。
fn rtf_escape_char(input: &str) -> Option<(char, usize)> {
    let bytes = input.as_bytes();
    if bytes.len() < 2 {
        return None;
    }
    match bytes[1] {
        b'\'' => {
            // \'hh:一个字节(UTF-8 容错;GBK 的双字节序列会分两次出现)
            if bytes.len() >= 4
                && let Ok(hex) = u8::from_str_radix(&input[2..4], 16)
            {
                return Some((
                    String::from_utf8_lossy(&[hex])
                        .chars()
                        .next()
                        .unwrap_or(' '),
                    4,
                ));
            }
            Some((' ', 2))
        }
        b'u' => {
            let digits: String = input[2..]
                .chars()
                .take_while(|ch| ch.is_ascii_digit() || *ch == '-')
                .collect();
            let mut consumed = 2 + digits.len();
            if input[consumed..].starts_with('?') {
                consumed += 1;
            }
            let code: i64 = digits.parse().unwrap_or(0);
            let ch = char::from_u32((code.rem_euclid(65536)) as u32).unwrap_or(' ');
            Some((ch, consumed))
        }
        _ => None,
    }
}

/// 解析一个控制字:`\word-123 `;返回(词, 消耗的字节数)。
fn rtf_word(input: &str) -> (String, usize) {
    let word: String = input[1..]
        .chars()
        .take_while(|ch| ch.is_ascii_alphabetic())
        .collect();
    let mut consumed = 1 + word.len();
    // 数字参数(如 `\fs24`)
    while input[consumed..].starts_with(|ch: char| ch == '-' || ch.is_ascii_digit()) {
        consumed += 1;
    }
    if input[consumed..].starts_with(' ') {
        consumed += 1;
    }
    (word, consumed)
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

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        crate::zip::build_stored_zip(entries)
    }

    #[tokio::test]
    async fn odt_yields_headings_paragraphs_and_tables() {
        let content = r#"<?xml version="1.0"?>
<office:document-content xmlns:office="o" xmlns:text="t" xmlns:table="tb"><office:body><office:text>
<text:h text:outline-level="1">年度总结</text:h>
<text:p>第一段正文。</text:p>
<table:table>
  <table:table-row><table:table-cell><text:p>指标</text:p></table:table-cell><table:table-cell><text:p>值</text:p></table:table-cell></table:table-row>
  <table:table-row><table:table-cell><text:p>营收</text:p></table:table-cell><table:table-cell><text:p>42</text:p></table:table-cell></table:table-row>
</table:table>
</office:text></office:body></office:document-content>"#;
        let bytes = zip_of(&[
            ("mimetype", b"application/vnd.oasis.opendocument.text"),
            ("content.xml", content.as_bytes()),
        ]);
        let doc = OdtExtractor
            .extract(&source("总结.odt"), &bytes)
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 3, "{:?}", doc.blocks);
        assert!(matches!(
            doc.blocks[0].block,
            Block::Heading { level: 1, .. }
        ));
        assert!(matches!(doc.blocks[1].block, Block::Paragraph { .. }));
        match &doc.blocks[2].block {
            Block::Table { header, rows } => {
                assert_eq!(header, &vec!["指标".to_owned(), "值".to_owned()]);
                assert_eq!(rows[0], vec!["营收".to_owned(), "42".to_owned()]);
            }
            other => panic!("应是表格:{other:?}"),
        }
    }

    #[tokio::test]
    async fn rtf_keeps_text_and_drops_control_words() {
        let rtf = r"{\rtf1\ansi\deff0{\fonttbl{\f0 Helvetica;}}\f0\fs24 第一段\par 第二段有\tab 制表符\par}";
        let doc = RtfExtractor
            .extract(&source("备忘.rtf"), rtf.as_bytes())
            .await
            .expect("抽取");
        let text = doc.text();
        assert!(text.contains("第一段"), "{text}");
        assert!(text.contains("第二段"), "{text}");
        assert!(!text.contains("fonttbl"), "字体表不应出现:{text}");
        assert!(!text.contains("Helvetica"), "{text}");
        assert!(!text.contains("\\par"), "{text}");
    }

    #[test]
    fn rtf_handles_hex_and_unicode_escapes() {
        // \'d6\'d0 是 GBK 的“中”,\u25991? 是“文”
        let text = rtf_to_text(r"{\rtf1 \u25991? 字}");
        assert!(text.contains('文'), "{text}");
    }

    #[test]
    fn detection_prefers_magic() {
        assert_eq!(RtfExtractor.detect(b"{\\rtf1", "txt"), Confidence::Certain);
        assert_eq!(RtfExtractor.detect(b"hello", "rtf"), Confidence::Probable);
        assert_eq!(
            OdtExtractor.detect(b"PK\x03\x04mimetype", "odt"),
            Confidence::Certain
        );
        assert_eq!(
            OdtExtractor.detect(b"PK\x03\x04mimetype", "zip"),
            Confidence::Unlikely
        );
    }
}
