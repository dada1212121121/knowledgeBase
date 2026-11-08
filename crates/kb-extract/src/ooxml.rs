//! OOXML 抽取器:docx / xlsx / pptx。
//!
//! 三者都是 zip + XML:先按条目名取出主文档,再用 `quick-xml` 拉出文字、表格与幻灯片。
//! 位置用 anchor 记录:
//! - docx → `Anchor::Line`(段落序号;Word 的“页”要排版才能算,这里用段落序)
//! - xlsx → `Anchor::Cell { sheet, cell }`(合并单元格按左上角的值展开)
//! - pptx → `Anchor::Slide { slide }`(含备注)

use async_trait::async_trait;
use kb_core::model::{Anchor, AnchoredBlock, Block, Confidence, Doc, DocMeta, SourceRef};
use kb_core::ports::Extractor;
use kb_core::{KbError, Result};
use quick_xml::Reader;
use quick_xml::events::Event;
use std::collections::HashMap;

use crate::zip::{ZipEntry, ZipLimits, read_all};

/// Word(docx)。
pub struct DocxExtractor;

#[async_trait]
impl Extractor for DocxExtractor {
    fn id(&self) -> &str {
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if !crate::zip::looks_like_zip(head) {
            return Confidence::Unlikely;
        }
        if head.windows(5).any(|window| window == b"word/") {
            return Confidence::Certain;
        }
        if ext.eq_ignore_ascii_case("docx") {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let entries = read_all(bytes, ZipLimits::default())
            .map_err(|err| KbError::InvalidInput(err.to_string()))?;
        let main = find_entry(&entries, "word/document.xml")
            .ok_or_else(|| KbError::InvalidInput("docx 缺少 word/document.xml".to_owned()))?;
        // 正文里的图片只写着关系 id(`r:embed="rId5"`),真正的文件在 `_rels` 里查
        let images = find_entry(&entries, "word/_rels/document.xml.rels")
            .map(|rels| docx_image_targets(&rels.text()))
            .unwrap_or_default();
        let blocks = docx_blocks(&main.text(), &images);
        Ok(doc_of(source, "docx", blocks, bytes))
    }
}

/// Excel(xlsx)。
pub struct XlsxExtractor;

#[async_trait]
impl Extractor for XlsxExtractor {
    fn id(&self) -> &str {
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if !crate::zip::looks_like_zip(head) {
            return Confidence::Unlikely;
        }
        if head.windows(3).any(|window| window == b"xl/") {
            return Confidence::Certain;
        }
        if ext.eq_ignore_ascii_case("xlsx") {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let entries = read_all(bytes, ZipLimits::default())
            .map_err(|err| KbError::InvalidInput(err.to_string()))?;
        let shared = entries
            .iter()
            .find(|entry| entry.name == "xl/sharedStrings.xml")
            .map(|entry| shared_strings(&entry.text()))
            .unwrap_or_default();
        let names = sheet_names(&entries);
        let mut blocks = Vec::new();
        for (index, entry) in entries
            .iter()
            .filter(|entry| entry.name.starts_with("xl/worksheets/sheet"))
            .enumerate()
        {
            let sheet = names
                .get(index)
                .cloned()
                .unwrap_or_else(|| format!("Sheet{}", index + 1));
            blocks.extend(xlsx_blocks(&sheet, &entry.text(), &shared));
        }
        Ok(doc_of(source, "xlsx", blocks, bytes))
    }
}

/// PowerPoint(pptx)。
pub struct PptxExtractor;

#[async_trait]
impl Extractor for PptxExtractor {
    fn id(&self) -> &str {
        "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    }

    fn detect(&self, head: &[u8], ext: &str) -> Confidence {
        if !crate::zip::looks_like_zip(head) {
            return Confidence::Unlikely;
        }
        if head.windows(4).any(|window| window == b"ppt/") {
            return Confidence::Certain;
        }
        if ext.eq_ignore_ascii_case("pptx") {
            Confidence::Probable
        } else {
            Confidence::Unlikely
        }
    }

    async fn extract(&self, source: &SourceRef, bytes: &[u8]) -> Result<Doc> {
        let entries = read_all(bytes, ZipLimits::default())
            .map_err(|err| KbError::InvalidInput(err.to_string()))?;
        let mut slides: Vec<(u32, &ZipEntry)> = entries
            .iter()
            .filter_map(|entry| {
                let number = slide_number(&entry.name, "ppt/slides/slide")?;
                Some((number, entry))
            })
            .collect();
        slides.sort_by_key(|(number, _)| *number);
        if slides.is_empty() {
            return Err(KbError::InvalidInput("pptx 里没有幻灯片".to_owned()));
        }
        let mut blocks = Vec::new();
        for (number, entry) in slides {
            let text = pptx_text(&entry.text());
            if !text.trim().is_empty() {
                blocks.push(AnchoredBlock {
                    anchor: Anchor::Slide { slide: number },
                    block: Block::Paragraph { text },
                });
            }
            // 演讲者备注跟在正文后面,同一页
            let notes_name = format!("ppt/notesSlides/notesSlide{number}.xml");
            if let Some(notes) = entries.iter().find(|entry| entry.name == notes_name) {
                let notes = pptx_text(&notes.text());
                if !notes.trim().is_empty() {
                    blocks.push(AnchoredBlock {
                        anchor: Anchor::Slide { slide: number },
                        block: Block::Paragraph {
                            text: format!("备注:{notes}"),
                        },
                    });
                }
            }
        }
        Ok(doc_of(source, "pptx", blocks, bytes))
    }
}

/// 找条目(容忍 `./` 前缀)。
fn find_entry<'a>(entries: &'a [ZipEntry], name: &str) -> Option<&'a ZipEntry> {
    entries
        .iter()
        .find(|entry| entry.name == name || entry.name.ends_with(&format!("/{name}")))
}

/// 从路径里取幻灯片序号。
fn slide_number(name: &str, prefix: &str) -> Option<u32> {
    let rest = name.strip_prefix(prefix)?;
    let digits: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn doc_of(source: &SourceRef, kind: &str, blocks: Vec<AnchoredBlock>, bytes: &[u8]) -> Doc {
    Doc {
        meta: DocMeta {
            source: source.location.clone(),
            title: None,
            lang: "zh".to_owned(),
            mime: Some(format!("application/{kind}")),
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

/// 文本事件(容错解码)。
fn text_of(event: &quick_xml::events::BytesText<'_>) -> String {
    event
        .decode()
        .map(|value| value.into_owned())
        .unwrap_or_default()
}

/// 读一个属性(`w:val` 这种带前缀的名字)。
fn attr(event: &quick_xml::events::BytesStart<'_>, name: &[u8]) -> Option<String> {
    event
        .try_get_attribute(name)
        .ok()
        .flatten()
        .and_then(|value| {
            value
                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .ok()
        })
        .map(|value| value.into_owned())
}

/// 读 `word/_rels/document.xml.rels`:关系 id → 图片在 zip 里的条目名(如 `word/media/image1.png`)。
///
/// 只收内嵌图片(类型以 `/image` 结尾、不是外部链接)。目标路径相对 `word/`,要拼上并折掉 `..`;
/// 以 `/` 开头的是相对包根的绝对写法。
pub fn docx_image_targets(rels: &str) -> HashMap<String, String> {
    let mut reader = Reader::from_str(rels);
    let mut out = HashMap::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag) | Event::Empty(tag)) if tag.name().as_ref() == b"Relationship" => {
                let is_image = attr(&tag, b"Type").is_some_and(|kind| kind.ends_with("/image"));
                let external = attr(&tag, b"TargetMode").is_some_and(|mode| mode == "External");
                if let (true, false, Some(id), Some(target)) =
                    (is_image, external, attr(&tag, b"Id"), attr(&tag, b"Target"))
                {
                    out.insert(id, resolve_part_path("word", &target));
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// 把关系里的相对目标解析成 zip 条目名:`base` 是源部件所在目录(无首尾 `/`)。
fn resolve_part_path(base: &str, target: &str) -> String {
    let mut parts: Vec<&str> = if target.starts_with('/') {
        Vec::new()
    } else {
        base.split('/').filter(|part| !part.is_empty()).collect()
    };
    for segment in target.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// 一个节点是不是图片引用,是的话返回关系 id。
///
/// 现代 Word 用 DrawingML 的 `a:blip r:embed`;旧式 / 兼容写法是 VML 的 `v:imagedata r:id`。
/// 链接到外部的图(`r:link`)不在文档包里,取不到字节,不算。
fn image_rel_id(tag: &quick_xml::events::BytesStart<'_>) -> Option<String> {
    match tag.name().as_ref() {
        b"a:blip" => attr(tag, b"r:embed"),
        b"v:imagedata" => attr(tag, b"r:id"),
        _ => None,
    }
}

/// 记下一个节点引用的图片(同一段落 / 表格里重复引用同一张只记一次;兼容写法的备选分支不记)。
fn collect_image(
    tag: &quick_xml::events::BytesStart<'_>,
    fallback_depth: u32,
    into: &mut Vec<String>,
) {
    if fallback_depth > 0 {
        return;
    }
    if let Some(id) = image_rel_id(tag)
        && !into.contains(&id)
    {
        into.push(id);
    }
}

/// 把收集到的图片引用输出成图片块;关系表里查不到的(外链 / 图表 / SmartArt)直接略过。
fn push_images(
    blocks: &mut Vec<AnchoredBlock>,
    ordinal: &mut u32,
    ids: Vec<String>,
    images: &HashMap<String, String>,
) {
    for id in ids {
        let Some(resource) = images.get(&id) else {
            continue;
        };
        *ordinal += 1;
        blocks.push(AnchoredBlock {
            anchor: Anchor::Line {
                start: *ordinal,
                end: *ordinal,
            },
            block: Block::Image {
                caption: None,
                ocr_text: None,
                resource: Some(resource.clone()),
            },
        });
    }
}

/// docx:`word/document.xml` → 标题 / 段落 / 表格 / 图片。
///
/// `images` 是 [`docx_image_targets`] 的结果。图片按出现顺序各成一个带 `resource` 的图片块,
/// 紧跟在它所在的段落后面;表格单元格里的图片放在这张表后面(单元格不能再嵌块)。
pub fn docx_blocks(xml: &str, images: &HashMap<String, String>) -> Vec<AnchoredBlock> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut blocks = Vec::new();
    let mut paragraph = String::new();
    let mut heading_level: Option<u8> = None;
    let mut in_text = false;
    let mut table: Option<(Vec<Vec<String>>, Vec<String>)> = None;
    let mut cell = String::new();
    let mut ordinal = 0u32;
    let mut paragraph_images: Vec<String> = Vec::new();
    let mut table_images: Vec<String> = Vec::new();
    // `mc:AlternateContent` 里同一张图会在 Choice 和 Fallback 各写一遍,只认 Choice
    let mut fallback_depth = 0u32;

    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => match start.name().as_ref() {
                b"w:p" => {
                    paragraph.clear();
                    heading_level = None;
                }
                b"w:pStyle" => {
                    if let Some(style) = attr(&start, b"w:val") {
                        heading_level = heading_level_of(&style);
                    }
                }
                b"w:t" => in_text = true,
                b"w:tbl" => table = Some((Vec::new(), Vec::new())),
                b"w:tr" => {
                    if let Some((rows, _)) = table.as_mut() {
                        rows.push(Vec::new());
                    }
                }
                b"mc:Fallback" => fallback_depth += 1,
                _ => {
                    let target = if table.is_some() {
                        &mut table_images
                    } else {
                        &mut paragraph_images
                    };
                    collect_image(&start, fallback_depth, target);
                }
            },
            Ok(Event::Empty(empty)) => {
                if empty.name().as_ref() == b"w:pStyle"
                    && let Some(style) = attr(&empty, b"w:val")
                {
                    heading_level = heading_level_of(&style);
                }
                let target = if table.is_some() {
                    &mut table_images
                } else {
                    &mut paragraph_images
                };
                collect_image(&empty, fallback_depth, target);
            }
            Ok(Event::Text(text)) => {
                if in_text {
                    paragraph.push_str(&text_of(&text));
                }
            }
            Ok(Event::End(end)) => match end.name().as_ref() {
                b"w:t" => in_text = false,
                b"w:tc" => {
                    if let Some((rows, _)) = table.as_mut()
                        && let Some(row) = rows.last_mut()
                    {
                        row.push(std::mem::take(&mut cell));
                    }
                }
                b"w:p" => {
                    let body = paragraph.trim().to_owned();
                    // 表格单元格里的段落属于单元格,不单独成块
                    if table.is_some() {
                        if !body.is_empty() {
                            if !cell.is_empty() {
                                cell.push(' ');
                            }
                            cell.push_str(&body);
                        }
                        continue;
                    }
                    if !body.is_empty() {
                        ordinal += 1;
                        let block = match heading_level {
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
                    push_images(
                        &mut blocks,
                        &mut ordinal,
                        std::mem::take(&mut paragraph_images),
                        images,
                    );
                }
                b"w:tbl" => {
                    if let Some((rows, _)) = table.take() {
                        ordinal += 1;
                        let mut rows = rows;
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
                    push_images(
                        &mut blocks,
                        &mut ordinal,
                        std::mem::take(&mut table_images),
                        images,
                    );
                }
                b"mc:Fallback" => fallback_depth = fallback_depth.saturating_sub(1),
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
    }
    blocks
}

/// `Heading1` / `标题 1` / `1` 都算一级标题。
fn heading_level_of(style: &str) -> Option<u8> {
    let lower = style.to_ascii_lowercase();
    let digits: String = lower.chars().filter(|ch| ch.is_ascii_digit()).collect();
    if lower.contains("heading") || style.contains("标题") {
        return digits
            .parse::<u8>()
            .ok()
            .filter(|level| (1..=6).contains(level));
    }
    None
}

/// xlsx:工作表名(按 workbook.xml 的顺序)。
fn sheet_names(entries: &[ZipEntry]) -> Vec<String> {
    let Some(workbook) = find_entry(entries, "xl/workbook.xml") else {
        return Vec::new();
    };
    let xml = workbook.text();
    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(true);
    let mut names = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) | Ok(Event::Empty(start))
                if start.name().as_ref() == b"sheet" =>
            {
                if let Some(name) = attr(&start, b"name") {
                    names.push(name);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    names
}

/// `xl/sharedStrings.xml` → 字符串表。
fn shared_strings(xml: &str) -> Vec<String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut strings = Vec::new();
    let mut current = String::new();
    let mut in_item = false;
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => match start.name().as_ref() {
                b"si" => {
                    in_item = true;
                    current.clear();
                }
                b"t" => in_text = true,
                _ => {}
            },
            Ok(Event::Text(text)) => {
                if in_item && in_text {
                    current.push_str(&text_of(&text));
                }
            }
            Ok(Event::End(end)) => match end.name().as_ref() {
                b"t" => in_text = false,
                b"si" => {
                    strings.push(std::mem::take(&mut current));
                    in_item = false;
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    strings
}

/// 一个工作表的单元格:`(地址, 值)`。
fn xlsx_cells(xml: &str, shared: &[String]) -> Vec<(String, String)> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut cells = Vec::new();
    let mut cell_ref = String::new();
    let mut cell_type = String::new();
    let mut value = String::new();
    let mut inline = String::new();
    let mut in_value = false;
    let mut in_inline = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => match start.name().as_ref() {
                b"c" => {
                    cell_ref = attr(&start, b"r").unwrap_or_default();
                    cell_type = attr(&start, b"t").unwrap_or_default();
                    value.clear();
                    inline.clear();
                }
                b"v" => in_value = true,
                b"is" => in_inline = true,
                b"t" => in_inline = true,
                _ => {}
            },
            Ok(Event::Text(text)) => {
                if in_value {
                    value.push_str(&text_of(&text));
                } else if in_inline {
                    inline.push_str(&text_of(&text));
                }
            }
            Ok(Event::End(end)) => match end.name().as_ref() {
                b"v" => in_value = false,
                b"is" => in_inline = false,
                b"c" => {
                    let text = match cell_type.as_str() {
                        "s" => value
                            .parse::<usize>()
                            .ok()
                            .and_then(|index| shared.get(index).cloned())
                            .unwrap_or_default(),
                        "inlineStr" => inline.clone(),
                        _ => value.clone(),
                    };
                    if !cell_ref.is_empty() && !text.trim().is_empty() {
                        cells.push((cell_ref.clone(), text));
                    }
                    cell_ref.clear();
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    cells
}

/// 一个工作表 → 一个表格块(第一行当表头,其余按行)。
///
/// 合并单元格按左上角的值展开到整个区域(要求),这样检索命中任意一格都能看到内容。
fn xlsx_blocks(sheet: &str, xml: &str, shared: &[String]) -> Vec<AnchoredBlock> {
    let mut cells = xlsx_cells(xml, shared);
    let merged = xlsx_merges(xml);
    if !merged.is_empty() {
        let mut map: std::collections::HashMap<(u32, u32), String> = cells
            .iter()
            .map(|(reference, text)| {
                let (column, row) = split_cell(reference);
                ((row, column), text.clone())
            })
            .collect();
        for (from, to) in merged {
            let (from_column, from_row) = split_cell(&from);
            let (to_column, to_row) = split_cell(&to);
            let value = map
                .get(&(from_row, from_column))
                .cloned()
                .unwrap_or_default();
            for row in from_row..=to_row {
                for column in from_column..=to_column {
                    map.entry((row, column)).or_insert_with(|| value.clone());
                }
            }
        }
        cells = map
            .into_iter()
            .filter(|(_, text)| !text.trim().is_empty())
            .map(|((row, column), text)| (format!("{}{row}", column_name(column)), text))
            .collect();
        cells.sort_by_key(|(reference, _)| {
            let (column, row) = split_cell(reference);
            (row, column)
        });
    }
    if cells.is_empty() {
        return Vec::new();
    }
    // 按行分组:`A1` → 行 1
    let mut rows: Vec<(u32, Vec<(u32, String)>)> = Vec::new();
    for (reference, text) in cells {
        let (column, row) = split_cell(&reference);
        match rows.last_mut() {
            Some((current, values)) if *current == row => values.push((column, text)),
            _ => rows.push((row, vec![(column, text)])),
        }
    }
    let mut table_rows: Vec<Vec<String>> = Vec::new();
    for (_, mut values) in rows {
        values.sort_by_key(|(column, _)| *column);
        table_rows.push(values.into_iter().map(|(_, text)| text).collect());
    }
    let header = if table_rows.is_empty() {
        Vec::new()
    } else {
        table_rows.remove(0)
    };
    let block = Block::Table {
        header,
        rows: table_rows,
    };
    if block.is_empty() {
        return Vec::new();
    }
    vec![AnchoredBlock {
        anchor: Anchor::Cell {
            sheet: sheet.to_owned(),
            cell: "R1".to_owned(),
        },
        block,
    }]
}

/// 读 `mergeCells`:`A1:B2` → (左上, 右下)。
fn xlsx_merges(xml: &str) -> Vec<(String, String)> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut merges = Vec::new();
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) | Ok(Event::Empty(start))
                if start.name().as_ref() == b"mergeCell" =>
            {
                if let Some(reference) = attr(&start, b"ref")
                    && let Some((from, to)) = reference.split_once(':')
                {
                    merges.push((from.to_owned(), to.to_owned()));
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    merges
}

/// 列号 → 列名(`1` → `A`,`27` → `AA`)。
fn column_name(mut column: u32) -> String {
    let mut name = String::new();
    while column > 0 {
        let remainder = ((column - 1) % 26) as u8;
        name.insert(0, (b'A' + remainder) as char);
        column = (column - 1) / 26;
    }
    name
}

/// `AB12` → (列号 1 起, 行号 1 起)。
fn split_cell(reference: &str) -> (u32, u32) {
    let mut column = 0u32;
    let mut row = 0u32;
    for ch in reference.chars() {
        if ch.is_ascii_alphabetic() {
            column = column * 26 + (ch.to_ascii_uppercase() as u32 - 'A' as u32 + 1);
        } else if ch.is_ascii_digit() {
            row = row * 10 + (ch as u32 - '0' as u32);
        }
    }
    (column.max(1), row.max(1))
}

/// pptx:一页里的所有文字(按段落换行)。
fn pptx_text(xml: &str) -> String {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut out = String::new();
    let mut in_text = false;
    loop {
        match reader.read_event() {
            Ok(Event::Start(start)) => match start.name().as_ref() {
                b"a:t" => in_text = true,
                b"a:p" if !out.is_empty() => out.push('\n'),
                _ => {}
            },
            Ok(Event::Text(text)) => {
                if in_text {
                    out.push_str(&text_of(&text));
                }
            }
            Ok(Event::End(end)) => {
                if end.name().as_ref() == b"a:t" {
                    in_text = false;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out.trim().to_owned()
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
    async fn docx_yields_headings_paragraphs_and_tables() {
        let document = r#"<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度报告</w:t></w:r></w:p>
<w:p><w:r><w:t>这是第一段正文。</w:t></w:r></w:p>
<w:tbl>
  <w:tr><w:tc><w:p><w:r><w:t>项目</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>金额</w:t></w:r></w:p></w:tc></w:tr>
  <w:tr><w:tc><w:p><w:r><w:t>甲</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
</w:body></w:document>"#;
        let bytes = zip_of(&[
            ("word/document.xml", document.as_bytes()),
            ("[Content_Types].xml", b"<Types/>"),
        ]);
        let doc = DocxExtractor
            .extract(&source("报告.docx"), &bytes)
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
                assert_eq!(header, &vec!["项目".to_owned(), "金额".to_owned()]);
                assert_eq!(rows.len(), 1);
                assert_eq!(rows[0], vec!["甲".to_owned(), "100".to_owned()]);
            }
            other => panic!("应是表格:{other:?}"),
        }
    }

    const RELS: &str = r#"<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image2.jpeg"/>
<Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../customXml/shot.png"/>
<Relationship Id="rId8" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/remote.png" TargetMode="External"/>
<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>
</Relationships>"#;

    #[test]
    fn image_targets_resolve_relative_to_word_and_skip_external() {
        let targets = docx_image_targets(RELS);
        assert_eq!(
            targets.get("rId5").map(String::as_str),
            Some("word/media/image1.png")
        );
        assert_eq!(
            targets.get("rId6").map(String::as_str),
            Some("word/media/image2.jpeg")
        );
        assert_eq!(
            targets.get("rId7").map(String::as_str),
            Some("customXml/shot.png"),
            "`..` 要折叠到包根"
        );
        assert!(!targets.contains_key("rId8"), "外链图片取不到字节");
        assert!(!targets.contains_key("rId9"), "超链接不是图片");
        assert!(!targets.contains_key("rId1"), "样式表不是图片");
        assert_eq!(
            resolve_part_path("word", "/word/media/a.png"),
            "word/media/a.png"
        );
    }

    #[tokio::test]
    async fn docx_images_become_blocks_in_reading_order() {
        // 第一段:文字 + 一张图;第二段:只有图(用 mc:AlternateContent 包着,Fallback 里重复写了一遍);
        // 表格单元格里还有一张;最后一段引用了关系表里没有的 id(图表之类),应被略过
        let document = r#"<?xml version="1.0"?>
<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r" xmlns:mc="mc" xmlns:v="v"><w:body>
<w:p><w:r><w:t>第一步:打开设置</w:t></w:r><w:r><w:drawing><a:graphic><a:graphicData><a:blip r:embed="rId5"/></a:graphicData></a:graphic></w:drawing></w:r></w:p>
<w:p><w:r><mc:AlternateContent><mc:Choice><w:drawing><a:blip r:embed="rId6"></a:blip></w:drawing></mc:Choice><mc:Fallback><w:pict><v:imagedata r:id="rId6"/></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>截图</w:t></w:r><w:r><w:drawing><a:blip r:embed="rId7"/></w:drawing></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>说明</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:drawing><a:blip r:embed="rId404"/></w:drawing></w:r></w:p>
</w:body></w:document>"#;
        let bytes = zip_of(&[
            ("word/document.xml", document.as_bytes()),
            ("word/_rels/document.xml.rels", RELS.as_bytes()),
            ("word/media/image1.png", b"PNG1"),
        ]);
        let doc = DocxExtractor
            .extract(&source("手册.docx"), &bytes)
            .await
            .expect("抽取");
        let shape: Vec<String> = doc
            .blocks
            .iter()
            .map(|item| match &item.block {
                Block::Paragraph { text } => format!("P:{text}"),
                Block::Table { header, .. } => format!("T:{}", header.join("|")),
                Block::Image { resource, .. } => {
                    format!("I:{}", resource.as_deref().unwrap_or("-"))
                }
                other => format!("{other:?}"),
            })
            .collect();
        assert_eq!(
            shape,
            vec![
                "P:第一步:打开设置",
                "I:word/media/image1.png",
                // Fallback 里重复的那张不再算一遍
                "I:word/media/image2.jpeg",
                "T:截图",
                "I:customXml/shot.png",
            ],
            "{shape:?}"
        );
        // 有正文时不算"需要 OCR"
        assert!(!kb_core::model::ExtractMeta::from_doc(&doc).needs_ocr);
    }

    #[tokio::test]
    async fn docx_with_only_pictures_is_flagged_as_needing_ocr() {
        // 整份只有截图:项目扫描据此记成"跳过",不会塞一堆没有文字的块进索引
        let document = r#"<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>
</w:body></w:document>"#;
        let bytes = zip_of(&[
            ("word/document.xml", document.as_bytes()),
            ("word/_rels/document.xml.rels", RELS.as_bytes()),
        ]);
        let doc = DocxExtractor
            .extract(&source("图.docx"), &bytes)
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 1, "图片块不能被当空块丢掉");
        assert!(kb_core::model::ExtractMeta::from_doc(&doc).needs_ocr);
    }

    #[tokio::test]
    async fn docx_without_a_rels_part_keeps_working_and_drops_images() {
        let document = r#"<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
<w:p><w:r><w:t>只有文字</w:t></w:r><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>
</w:body></w:document>"#;
        let bytes = zip_of(&[("word/document.xml", document.as_bytes())]);
        let doc = DocxExtractor
            .extract(&source("a.docx"), &bytes)
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 1, "{:?}", doc.blocks);
        assert!(matches!(doc.blocks[0].block, Block::Paragraph { .. }));
    }

    #[tokio::test]
    async fn xlsx_reads_shared_strings_and_sheets() {
        let workbook = r#"<workbook xmlns="x"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
        let shared = r#"<sst><si><t>名称</t></si><si><t>数量</t></si><si><t>甲</t></si></sst>"#;
        let sheet = r#"<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>7</v></c></row>
</sheetData></worksheet>"#;
        let bytes = zip_of(&[
            ("xl/workbook.xml", workbook.as_bytes()),
            ("xl/sharedStrings.xml", shared.as_bytes()),
            ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
        ]);
        let doc = XlsxExtractor
            .extract(&source("预算.xlsx"), &bytes)
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 1);
        match &doc.blocks[0].block {
            Block::Table { header, rows } => {
                assert_eq!(header, &vec!["名称".to_owned(), "数量".to_owned()]);
                assert_eq!(rows, &vec![vec!["甲".to_owned(), "7".to_owned()]]);
            }
            other => panic!("应是表格:{other:?}"),
        }
        assert_eq!(
            doc.blocks[0].anchor,
            Anchor::Cell {
                sheet: "预算".to_owned(),
                cell: "R1".to_owned()
            }
        );
    }

    #[tokio::test]
    async fn pptx_reads_slides_and_notes() {
        let slide = r#"<p:sld><p:cSld><p:spTree><p:sp><p:txBody>
<a:p><a:r><a:t>第一页标题</a:t></a:r></a:p>
<a:p><a:r><a:t>要点一</a:t></a:r></a:p>
</p:txBody></p:sp></p:spTree></p:cSld></p:sld>"#;
        let notes = r#"<p:notes><a:p><a:r><a:t>讲稿:先讲背景</a:t></a:r></a:p></p:notes>"#;
        let bytes = zip_of(&[
            ("ppt/slides/slide1.xml", slide.as_bytes()),
            ("ppt/notesSlides/notesSlide1.xml", notes.as_bytes()),
        ]);
        let doc = PptxExtractor
            .extract(&source("汇报.pptx"), &bytes)
            .await
            .expect("抽取");
        assert_eq!(doc.blocks.len(), 2, "{:?}", doc.blocks);
        assert_eq!(doc.blocks[0].anchor, Anchor::Slide { slide: 1 });
        let text = doc.blocks[0].block.text();
        assert!(
            text.contains("第一页标题") && text.contains("要点一"),
            "{text}"
        );
        assert!(doc.blocks[1].block.text().contains("先讲背景"));
    }

    #[tokio::test]
    async fn xlsx_merged_cells_are_expanded() {
        let workbook = r#"<workbook><sheets><sheet name="汇总" sheetId="1"/></sheets></workbook>"#;
        let sheet = r#"<worksheet><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>季度</t></is></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Q1</t></is></c><c r="B2"><v>100</v></c></row>
<row r="3"><c r="B3"><v>200</v></c></row>
</sheetData><mergeCells count="1"><mergeCell ref="A2:A3"/></mergeCells></worksheet>"#;
        let bytes = zip_of(&[
            ("xl/workbook.xml", workbook.as_bytes()),
            ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
        ]);
        let doc = XlsxExtractor
            .extract(&source("汇总.xlsx"), &bytes)
            .await
            .expect("抽取");
        match &doc.blocks[0].block {
            Block::Table { rows, .. } => {
                // A2:A3 合并 → 第二行也应出现 Q1
                assert_eq!(rows[0], vec!["Q1".to_owned(), "100".to_owned()]);
                assert_eq!(rows[1], vec!["Q1".to_owned(), "200".to_owned()]);
            }
            other => panic!("应是表格:{other:?}"),
        }
    }

    #[test]
    fn column_numbers_round_trip_to_names() {
        assert_eq!(column_name(1), "A");
        assert_eq!(column_name(26), "Z");
        assert_eq!(column_name(27), "AA");
        assert_eq!(column_name(52), "AZ");
    }

    #[test]
    fn cell_references_parse_columns_and_rows() {
        assert_eq!(split_cell("A1"), (1, 1));
        assert_eq!(split_cell("B12"), (2, 12));
        assert_eq!(split_cell("AA3"), (27, 3));
    }

    #[test]
    fn heading_styles_are_recognised() {
        assert_eq!(heading_level_of("Heading2"), Some(2));
        assert_eq!(heading_level_of("标题 3"), Some(3));
        assert_eq!(heading_level_of("Normal"), None);
    }
}
