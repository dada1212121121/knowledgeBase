//! EPUB 抽取:zip + `META-INF/container.xml` + OPF spine,按章节顺序抽正文。
//!
//! 章节顺序以 OPF 的 `<spine>` 为准(不是文件名顺序),每章复用 [`crate::html::extract_html`]
//! 的正文抽取;章节标题取该章 `<title>` 或第一个标题块。

use async_trait::async_trait;
use kb_core::model::{Anchor, AnchoredBlock, Block, Confidence, Doc, DocMeta, SourceRef};
use kb_core::ports::Extractor;
use kb_core::{KbError, Result};
use quick_xml::Reader;
use quick_xml::events::Event;

use crate::html::extract_html;
use crate::zip::{ZipLimits, read_all};

/// EPUB。
pub struct EpubExtractor;

#[async_trait]
impl Extractor for EpubExtractor {
    fn id(&self) -> &str {
        "application/epub+zip"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if !crate::zip::looks_like_zip(head) {
            return Confidence::Unlikely;
        }
        if head
            .windows(20)
            .any(|window| window == b"application/epub+zip")
        {
            return Confidence::Certain;
        }
        if ext.eq_ignore_ascii_case("epub") {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let entries = read_all(bytes, ZipLimits::default())
            .map_err(|err| KbError::InvalidInput(err.to_string()))?;
        let container = entries
            .iter()
            .find(|entry| entry.name == "META-INF/container.xml")
            .ok_or_else(|| KbError::InvalidInput("epub 缺少 META-INF/container.xml".to_owned()))?;
        let opf_path = rootfile_of(&container.text()).ok_or_else(|| {
            KbError::InvalidInput("epub 的 container.xml 里没有 rootfile".to_owned())
        })?;
        let opf = entries
            .iter()
            .find(|entry| entry.name == opf_path)
            .ok_or_else(|| KbError::InvalidInput(format!("epub 缺少 {opf_path}")))?;
        let (manifest, spine) = opf_structure(&opf.text());
        let base = opf_path.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");

        let mut blocks: Vec<AnchoredBlock> = Vec::new();
        let mut chapter = 0u32;
        for id in spine {
            let Some(href) = manifest.get(&id) else {
                continue;
            };
            let path = if base.is_empty() {
                href.clone()
            } else {
                format!("{base}/{href}")
            };
            let Some(entry) = entries.iter().find(|entry| entry.name == path) else {
                continue;
            };
            chapter += 1;
            let page = extract_html(&entry.text());
            // 章节标题:优先 <title>,否则用第一个标题块
            let title = page.title.clone().or_else(|| {
                page.blocks.iter().find_map(|block| match block {
                    Block::Heading { text, .. } => Some(text.clone()),
                    _ => None,
                })
            });
            if let Some(title) = title.clone() {
                blocks.push(AnchoredBlock {
                    anchor: Anchor::Line {
                        start: chapter,
                        end: chapter,
                    },
                    block: Block::Heading {
                        level: 1,
                        text: title,
                    },
                });
            }
            for block in page.blocks {
                if block.is_empty() {
                    continue;
                }
                blocks.push(AnchoredBlock {
                    anchor: Anchor::Line {
                        start: chapter,
                        end: chapter,
                    },
                    block,
                });
            }
        }

        if blocks.is_empty() {
            return Err(KbError::InvalidInput("epub 里没有可抽取的章节".to_owned()));
        }
        Ok(Doc {
            meta: DocMeta {
                source: source.location.clone(),
                title: None,
                lang: "zh".to_owned(),
                mime: Some("application/epub+zip".to_owned()),
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
            blocks,
        })
    }
}

/// `container.xml` → rootfile 的完整路径。
fn rootfile_of(xml: &str) -> Option<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) | Ok(Event::Empty(start))
                if start.name().as_ref() == b"rootfile" =>
            {
                let value = start
                    .try_get_attribute("full-path")
                    .ok()
                    .flatten()
                    .and_then(|attr| {
                        attr.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                            .ok()
                    })
                    .map(|value| value.into_owned());
                if value.is_some() {
                    return value;
                }
            }
            Ok(Event::Eof) | Err(_) => return None,
            _ => {}
        }
    }
}

/// OPF → (id → href 的清单, spine 的 id 顺序)。
fn opf_structure(xml: &str) -> (std::collections::HashMap<String, String>, Vec<String>) {
    let mut manifest = std::collections::HashMap::new();
    let mut spine = Vec::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) | Ok(Event::Empty(start)) => match start.name().as_ref() {
                b"item" => {
                    let id = start
                        .try_get_attribute("id")
                        .ok()
                        .flatten()
                        .and_then(|attr| {
                            attr.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .ok()
                        })
                        .map(|value| value.into_owned());
                    let href = start
                        .try_get_attribute("href")
                        .ok()
                        .flatten()
                        .and_then(|attr| {
                            attr.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .ok()
                        })
                        .map(|value| value.into_owned());
                    let media = start
                        .try_get_attribute("media-type")
                        .ok()
                        .flatten()
                        .and_then(|attr| {
                            attr.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .ok()
                        })
                        .map(|value| value.into_owned())
                        .unwrap_or_default();
                    if let (Some(id), Some(href)) = (id, href)
                        && (media.is_empty() || media.contains("html"))
                    {
                        manifest.insert(id, href);
                    }
                }
                b"itemref" => {
                    if let Some(idref) = start
                        .try_get_attribute("idref")
                        .ok()
                        .flatten()
                        .and_then(|attr| {
                            attr.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                                .ok()
                        })
                        .map(|value| value.into_owned())
                    {
                        spine.push(idref);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    (manifest, spine)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
        crate::zip::build_stored_zip(entries)
    }

    fn source(location: &str) -> SourceRef {
        SourceRef {
            scheme: "file".to_owned(),
            location: location.to_owned(),
            project_root: None,
        }
    }

    fn epub_bytes() -> Vec<u8> {
        let container = r#"<?xml version="1.0"?><container><rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
</rootfiles></container>"#;
        let opf = r#"<?xml version="1.0"?><package><manifest>
<item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
<item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
</manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>"#;
        let chapter1 = r#"<html><head><title>第一章 起步</title></head><body>
<nav>导航</nav><h1>第一章 起步</h1><p>先安装工具链。</p></body></html>"#;
        let chapter2 = r#"<html><head><title>第二章 进阶</title></head><body>
<p>再配置索引。</p></body></html>"#;
        zip_of(&[
            ("mimetype", b"application/epub+zip"),
            ("META-INF/container.xml", container.as_bytes()),
            ("OEBPS/content.opf", opf.as_bytes()),
            ("OEBPS/chapter1.xhtml", chapter1.as_bytes()),
            ("OEBPS/chapter2.xhtml", chapter2.as_bytes()),
        ])
    }

    #[tokio::test]
    async fn extracts_chapters_in_spine_order() {
        let doc = EpubExtractor
            .extract(&source("book.epub"), &epub_bytes())
            .await
            .expect("抽取");
        let text = doc.text();
        assert!(text.contains("第一章"), "{text}");
        assert!(text.contains("第二章"), "{text}");
        // spine 顺序:第一章在前(即使 manifest 里 c2 写在前面)
        let first = text.find("第一章").expect("第一章");
        let second = text.find("第二章").expect("第二章");
        assert!(first < second, "章节顺序应按 spine:{text}");
        assert!(!text.contains("导航"), "导航应被剪掉:{text}");
        // 章节锚点:第 1 章与第 2 章不同
        let chapters: Vec<u32> = doc
            .blocks
            .iter()
            .map(|block| match block.anchor {
                Anchor::Line { start, .. } => start,
                _ => 0,
            })
            .collect();
        assert!(
            chapters.contains(&1) && chapters.contains(&2),
            "{chapters:?}"
        );
    }

    #[test]
    fn detection_requires_the_epub_mimetype() {
        assert_eq!(
            EpubExtractor.detect(&epub_bytes(), "epub"),
            Confidence::Certain
        );
        assert_eq!(
            EpubExtractor.detect(b"PK\x03\x04xx", "epub"),
            Confidence::Probable
        );
        assert_eq!(EpubExtractor.detect(b"plain", "txt"), Confidence::Unlikely);
    }
}
