//! 办公文档(docx / xlsx / pptx)的包级检查:**写回之前**和**无损往返**两处用。
//!
//! 编辑器(浏览器里的引擎)把整份文件交回来,服务器不能照单全收。这里不依赖任何编辑引擎,
//! 只看 OOXML 包本身——检查者不该和被检查者共用同一套代码,否则引擎的 bug 会把检查一起带偏:
//!
//! - [`validate`]:交上来的是不是一个 Office 打开时不会提示「需要修复」的包——zip 能读、有 `[Content_Types].xml` 和主文件、
//!   每个 XML 部件格式正确、每个部件都有内容类型、每条内部关系的目标都在包里(缺了目标 Word / Excel 会弹修复);
//! - [`compare`]:两个包逐部件比。XML 部件按**结构**比(忽略标签之间的空白、属性顺序、XML 声明后的换行),其余部件逐字节比。
//!   「不改直接保存应该一模一样」就靠它判断,不一样会列出是哪几个部件。

use std::collections::{BTreeMap, BTreeSet};

use quick_xml::Reader;
use quick_xml::events::Event;

use crate::zip::{ZipLimits, read_all};

/// 办公文档的三大类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OfficeKind {
    /// Word。
    Docx,
    /// Excel。
    Xlsx,
    /// PowerPoint。
    Pptx,
}

impl OfficeKind {
    /// 按扩展名认(含带宏的和模板);不认识的返回 `None`。
    pub fn from_extension(extension: &str) -> Option<Self> {
        match extension
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str()
        {
            "docx" | "docm" | "dotx" | "dotm" => Some(Self::Docx),
            "xlsx" | "xlsm" | "xltx" | "xltm" => Some(Self::Xlsx),
            "pptx" | "pptm" | "potx" | "potm" | "ppsx" | "ppsm" => Some(Self::Pptx),
            _ => None,
        }
    }

    /// 合法的包里一定有的主文件。
    pub fn main_part(self) -> &'static str {
        match self {
            Self::Docx => "word/document.xml",
            Self::Xlsx => "xl/workbook.xml",
            Self::Pptx => "ppt/presentation.xml",
        }
    }

    /// 给人看的名字。
    pub fn label(self) -> &'static str {
        match self {
            Self::Docx => "Word",
            Self::Xlsx => "Excel",
            Self::Pptx => "PowerPoint",
        }
    }
}

/// 检查通过时的概况。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackageInfo {
    /// 哪一类。
    pub kind: OfficeKind,
    /// 部件数(不含目录条目)。
    pub parts: usize,
}

/// 内容类型表。
#[derive(Default)]
struct ContentTypes {
    defaults: BTreeSet<String>,
    overrides: BTreeSet<String>,
}

impl ContentTypes {
    fn parse(xml: &str) -> Result<Self, String> {
        let mut reader = Reader::from_str(xml);
        let mut out = Self::default();
        loop {
            match reader.read_event() {
                Ok(Event::Start(tag) | Event::Empty(tag)) => match tag.local_name().as_ref() {
                    b"Default" => {
                        if let Some(extension) = attribute(&tag, b"Extension") {
                            out.defaults.insert(extension.to_ascii_lowercase());
                        }
                    }
                    b"Override" => {
                        if let Some(part) = attribute(&tag, b"PartName") {
                            out.overrides
                                .insert(part.trim_start_matches('/').to_owned());
                        }
                    }
                    _ => {}
                },
                Ok(Event::Eof) => break,
                Err(err) => return Err(format!("[Content_Types].xml 格式不对:{err}")),
                _ => {}
            }
        }
        Ok(out)
    }

    fn covers(&self, name: &str) -> bool {
        if self.overrides.contains(name) {
            return true;
        }
        name.rsplit_once('.')
            .is_some_and(|(_, extension)| self.defaults.contains(&extension.to_ascii_lowercase()))
    }
}

fn attribute(tag: &quick_xml::events::BytesStart<'_>, key: &[u8]) -> Option<String> {
    tag.attributes()
        .flatten()
        .find(|attribute| attribute.key.local_name().as_ref() == key)
        .and_then(|attribute| {
            attribute
                .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                .ok()
                .map(|value| value.into_owned())
        })
}

/// XML 是否格式正确(标签配对、能读到结尾)。
fn well_formed(xml: &[u8]) -> Result<(), String> {
    let text = std::str::from_utf8(xml).map_err(|_| "不是合法的 UTF-8".to_owned())?;
    let mut reader = Reader::from_str(text);
    let mut depth = 0i64;
    loop {
        match reader.read_event() {
            Ok(Event::Start(_)) => depth += 1,
            Ok(Event::End(_)) => depth -= 1,
            Ok(Event::Eof) => break,
            Err(err) => return Err(err.to_string()),
            _ => {}
        }
        if depth < 0 {
            return Err("结束标签多了".to_owned());
        }
    }
    if depth != 0 {
        return Err("有标签没有结束".to_owned());
    }
    Ok(())
}

/// `_rels/.rels`、`xl/_rels/workbook.xml.rels` 这类关系文件管的是哪个部件所在的目录。
fn rels_base(rels_name: &str) -> String {
    // `a/b/_rels/c.xml.rels` → 源部件 `a/b/c.xml` → 目录 `a/b/`
    let (dir, _) = rels_name.rsplit_once('/').unwrap_or(("", rels_name));
    let parent = dir.strip_suffix("_rels").unwrap_or(dir);
    parent.to_owned()
}

/// 把关系里的 `Target` 解析成包内的部件名(处理 `../` 和绝对路径 `/word/x.xml`)。
fn resolve_target(base: &str, target: &str) -> String {
    if let Some(absolute) = target.strip_prefix('/') {
        return absolute.to_owned();
    }
    let mut parts: Vec<&str> = base.split('/').filter(|part| !part.is_empty()).collect();
    for piece in target.split('/') {
        match piece {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// 检查交上来的字节是不是一个完整的 Office 包。`extension` 决定它该是哪一类。
pub fn validate(bytes: &[u8], extension: &str) -> Result<PackageInfo, String> {
    let kind = OfficeKind::from_extension(extension).ok_or_else(|| {
        format!(
            ".{} 不是 Word / Excel / PowerPoint 的新格式",
            extension.trim_start_matches('.')
        )
    })?;
    let limits = ZipLimits {
        max_file_bytes: 256 * 1024 * 1024,
        max_total_bytes: 1024 * 1024 * 1024,
        max_entries: 20_000,
    };
    let entries = read_all(bytes, limits)
        .map_err(|err| format!("不是一个完整的 {} 文件:{err}", kind.label()))?;
    let parts: BTreeMap<&str, &[u8]> = entries
        .iter()
        .filter(|entry| !entry.name.ends_with('/'))
        .map(|entry| (entry.name.as_str(), entry.data.as_slice()))
        .collect();
    let label = kind.label();
    let content_types = parts
        .get("[Content_Types].xml")
        .ok_or_else(|| format!("缺少 [Content_Types].xml,{label} 会打不开"))?;
    let types = ContentTypes::parse(&String::from_utf8_lossy(content_types))?;
    if !parts.contains_key(kind.main_part()) {
        return Err(format!(
            "缺少 {} —— 这不是一个 {label} 文件(或者主文件丢了)",
            kind.main_part()
        ));
    }
    for (name, data) in &parts {
        if name.ends_with(".xml") || name.ends_with(".rels") {
            well_formed(data).map_err(|err| format!("{name} 格式不对:{err}"))?;
        }
        if *name != "[Content_Types].xml" && !types.covers(name) {
            return Err(format!("{name} 没有登记内容类型,{label} 会提示需要修复"));
        }
    }
    for (name, data) in &parts {
        if !name.ends_with(".rels") {
            continue;
        }
        let base = rels_base(name);
        let mut reader = Reader::from_str(std::str::from_utf8(data).unwrap_or_default());
        loop {
            match reader.read_event() {
                Ok(Event::Start(tag) | Event::Empty(tag))
                    if tag.local_name().as_ref() == b"Relationship" =>
                {
                    if attribute(&tag, b"TargetMode")
                        .is_some_and(|mode| mode.eq_ignore_ascii_case("External"))
                    {
                        continue;
                    }
                    let Some(target) = attribute(&tag, b"Target") else {
                        continue;
                    };
                    let resolved = resolve_target(&base, &target);
                    if !parts.contains_key(resolved.as_str()) && !resolved.is_empty() {
                        return Err(format!(
                            "{name} 指向的 {resolved} 不在包里,{label} 会提示需要修复"
                        ));
                    }
                }
                Ok(Event::Eof) => break,
                Err(_) => break,
                _ => {}
            }
        }
    }
    Ok(PackageInfo {
        kind,
        parts: parts.len(),
    })
}

/// 两个包的差别。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PackageDiff {
    /// 内容不同的部件。
    pub changed: Vec<String>,
    /// 旧包有、新包没有的部件。
    pub removed: Vec<String>,
    /// 新包有、旧包没有的部件。
    pub added: Vec<String>,
}

impl PackageDiff {
    /// 没有任何差别。
    pub fn is_identical(&self) -> bool {
        self.changed.is_empty() && self.removed.is_empty() && self.added.is_empty()
    }
}

/// 开始标签的指纹:标签名 + 排序后的属性。
fn open_tag(tag: &quick_xml::events::BytesStart<'_>) -> String {
    let mut attributes: Vec<String> = tag
        .attributes()
        .flatten()
        .map(|attribute| {
            format!(
                "{}={}",
                String::from_utf8_lossy(attribute.key.as_ref()),
                attribute
                    .normalized_value(quick_xml::XmlVersion::Implicit1_0)
                    .map(|value| value.into_owned())
                    .unwrap_or_default()
            )
        })
        .collect();
    attributes.sort();
    format!(
        "<{} {}>",
        String::from_utf8_lossy(tag.name().as_ref()),
        attributes.join(" ")
    )
}

/// 每次保存都会被编辑器更新(或第一次保存时新加上)的文档属性(`docProps/core.xml`):最后修改时间、最后修改者、修订号。
/// 它们变了、多了、少了都不算「内容被改写」;作者、创建时间、标题这类别的字段变了仍然算。
const VOLATILE_CORE_PROPERTIES: &[&str] = &["modified", "lastModifiedBy", "revision"];

/// XML 的结构指纹:忽略 XML 声明、注释、标签之间的空白和属性顺序;`<a></a>` 与 `<a/>` 视为一样。
/// `ignore` 里列出的元素(按不带前缀的名字)整个跳过:有没有、里面是什么都不比。
fn canonical_xml(data: &[u8], ignore: &[&str]) -> Option<Vec<String>> {
    let text = std::str::from_utf8(data).ok()?;
    let mut reader = Reader::from_str(text);
    let mut out = Vec::new();
    // 正在跳过的元素嵌套了几层(0 = 没在跳过)
    let mut skipping = 0usize;
    let ignored = |tag: &quick_xml::events::BytesStart<'_>| {
        ignore
            .iter()
            .any(|name| tag.local_name().as_ref() == name.as_bytes())
    };
    loop {
        match reader.read_event() {
            Ok(Event::Start(tag)) => {
                if skipping > 0 || ignored(&tag) {
                    skipping += 1;
                } else {
                    out.push(open_tag(&tag));
                }
            }
            Ok(Event::Empty(tag)) => {
                if skipping == 0 && !ignored(&tag) {
                    out.push(open_tag(&tag));
                    out.push("</>".to_owned());
                }
            }
            Ok(Event::End(_)) => {
                if skipping > 0 {
                    skipping -= 1;
                } else {
                    out.push("</>".to_owned());
                }
            }
            Ok(Event::Text(_) | Event::CData(_)) if skipping > 0 => {}
            Ok(Event::Text(text)) => {
                let value = text
                    .decode()
                    .map(|value| value.into_owned())
                    .unwrap_or_default();
                if !value.trim().is_empty() {
                    out.push(format!("#{value}"));
                }
            }
            Ok(Event::CData(data)) => out.push(format!("#{}", String::from_utf8_lossy(&data))),
            Ok(Event::Eof) => break,
            Err(_) => return None,
            _ => {}
        }
    }
    Some(out)
}

/// 逐部件比较两个包(见模块文档)。任何一个读不了就报错。
pub fn compare(old: &[u8], new: &[u8]) -> Result<PackageDiff, String> {
    let limits = ZipLimits::default();
    let old_entries = read_all(old, limits).map_err(|err| format!("原文件读不了:{err}"))?;
    let new_entries = read_all(new, limits).map_err(|err| format!("新文件读不了:{err}"))?;
    let old_parts: BTreeMap<&str, &[u8]> = old_entries
        .iter()
        .filter(|entry| !entry.name.ends_with('/'))
        .map(|entry| (entry.name.as_str(), entry.data.as_slice()))
        .collect();
    let new_parts: BTreeMap<&str, &[u8]> = new_entries
        .iter()
        .filter(|entry| !entry.name.ends_with('/'))
        .map(|entry| (entry.name.as_str(), entry.data.as_slice()))
        .collect();
    let mut diff = PackageDiff::default();
    for (name, data) in &old_parts {
        match new_parts.get(name) {
            None => diff.removed.push((*name).to_owned()),
            Some(other) if other == data => {}
            Some(other) => {
                let is_xml = name.ends_with(".xml") || name.ends_with(".rels");
                let ignore: &[&str] = if *name == "docProps/core.xml" {
                    VOLATILE_CORE_PROPERTIES
                } else {
                    &[]
                };
                let same_structure = is_xml
                    && match (canonical_xml(data, ignore), canonical_xml(other, ignore)) {
                        (Some(left), Some(right)) => left == right,
                        _ => false,
                    };
                if !same_structure {
                    diff.changed.push((*name).to_owned());
                }
            }
        }
    }
    for name in new_parts.keys() {
        if !old_parts.contains_key(name) {
            diff.added.push((*name).to_owned());
        }
    }
    Ok(diff)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::zip::build_stored_zip;

    const TYPES: &str = r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="x"/></Types>"#;
    const ROOT_RELS: &str = r#"<Relationships xmlns="r"><Relationship Id="rId1" Type="t" Target="word/document.xml"/></Relationships>"#;
    const DOC: &str = r#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>"#;
    const DOC_RELS: &str = r#"<Relationships xmlns="r"><Relationship Id="rId5" Type="image" Target="media/image1.png"/><Relationship Id="rId6" Type="link" Target="https://example.com" TargetMode="External"/></Relationships>"#;

    fn docx(overrides: &[(&str, &str)]) -> Vec<u8> {
        let mut entries: Vec<(String, Vec<u8>)> = vec![
            ("[Content_Types].xml".into(), TYPES.as_bytes().to_vec()),
            ("_rels/.rels".into(), ROOT_RELS.as_bytes().to_vec()),
            ("word/document.xml".into(), DOC.as_bytes().to_vec()),
            (
                "word/_rels/document.xml.rels".into(),
                DOC_RELS.as_bytes().to_vec(),
            ),
            (
                "word/media/image1.png".into(),
                b"\x89PNG\r\n\x1a\n".to_vec(),
            ),
        ];
        for (name, content) in overrides {
            if let Some(entry) = entries.iter_mut().find(|(existing, _)| existing == name) {
                entry.1 = content.as_bytes().to_vec();
            } else {
                entries.push(((*name).to_owned(), content.as_bytes().to_vec()));
            }
        }
        let refs: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(name, data)| (name.as_str(), data.as_slice()))
            .collect();
        build_stored_zip(&refs)
    }

    fn without(bytes: &[u8], drop: &str) -> Vec<u8> {
        let entries = read_all(bytes, ZipLimits::default()).expect("读");
        let refs: Vec<(&str, &[u8])> = entries
            .iter()
            .filter(|entry| entry.name != drop)
            .map(|entry| (entry.name.as_str(), entry.data.as_slice()))
            .collect();
        build_stored_zip(&refs)
    }

    const CORE_BEFORE: &str = r#"<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:creator>张三</dc:creator><cp:lastModifiedBy>张三</cp:lastModifiedBy><dcterms:modified>2026-05-03T02:08:42Z</dcterms:modified><cp:revision>1</cp:revision></cp:coreProperties>"#;

    /// 保存一次,编辑器一定会更新「最后修改时间 / 最后修改者 / 修订号」;这几项变了不算内容被改写。
    /// 作者、创建时间这类别的字段变了仍然算。
    #[test]
    fn saving_updates_the_modified_stamp_without_counting_as_a_content_change() {
        let before = docx(&[("docProps/core.xml", CORE_BEFORE)]);
        let stamped = docx(&[(
            "docProps/core.xml",
            r#"<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:creator>张三</dc:creator><cp:lastModifiedBy>李四</cp:lastModifiedBy><dcterms:modified>2026-11-01T10:12:29.668Z</dcterms:modified><cp:revision>2</cp:revision></cp:coreProperties>"#,
        )]);
        assert!(compare(&before, &stamped).unwrap().is_identical());

        // 作者变了:算
        let other_author = docx(&[(
            "docProps/core.xml",
            &CORE_BEFORE.replace(
                "<dc:creator>张三</dc:creator>",
                "<dc:creator>王五</dc:creator>",
            ),
        )]);
        assert_eq!(
            compare(&before, &other_author).unwrap().changed,
            vec!["docProps/core.xml"]
        );
        // 原来没有这几项、保存时新加上(有的文档从没写过最后修改时间):也不算
        let bare = docx(&[(
            "docProps/core.xml",
            r#"<cp:coreProperties xmlns:cp="c" xmlns:dc="d" xmlns:dcterms="t"><dc:creator>张三</dc:creator></cp:coreProperties>"#,
        )]);
        assert!(compare(&bare, &before).unwrap().is_identical());
        assert!(compare(&before, &bare).unwrap().is_identical());
        // 别的字段多了 / 少了:算
        let titled = docx(&[(
            "docProps/core.xml",
            &CORE_BEFORE.replace("<dc:creator>", "<dc:title>标题</dc:title><dc:creator>"),
        )]);
        assert_eq!(
            compare(&before, &titled).unwrap().changed,
            vec!["docProps/core.xml"]
        );
        // 同名元素出现在别的部件里不享受这个豁免
        let one = docx(&[(
            "word/document.xml",
            r#"<w:document xmlns:w="w"><w:modified>甲</w:modified></w:document>"#,
        )]);
        let two = docx(&[(
            "word/document.xml",
            r#"<w:document xmlns:w="w"><w:modified>乙</w:modified></w:document>"#,
        )]);
        assert_eq!(
            compare(&one, &two).unwrap().changed,
            vec!["word/document.xml"]
        );
        let body = docx(&[("word/document.xml", &DOC.replace("正文", "改过的正文"))]);
        assert_eq!(
            compare(&docx(&[]), &body).unwrap().changed,
            vec!["word/document.xml"]
        );
    }

    #[test]
    fn a_complete_package_passes_and_reports_its_kind() {
        let info = validate(&docx(&[]), "docx").expect("应通过");
        assert_eq!(info.kind, OfficeKind::Docx);
        assert_eq!(info.parts, 5);
        // 带宏的、模板的扩展名也认
        assert!(validate(&docx(&[]), "DOCM").is_ok());
    }

    #[test]
    fn every_way_a_package_makes_word_ask_for_repair_is_refused_with_the_reason() {
        let good = docx(&[]);
        for (bytes, expect) in [
            (b"not a zip".to_vec(), "不是一个完整的 Word 文件"),
            (
                without(&good, "[Content_Types].xml"),
                "缺少 [Content_Types].xml",
            ),
            (
                without(&good, "word/document.xml"),
                "缺少 word/document.xml",
            ),
            // 关系指向的图片没了:Word 会弹「需要修复」
            (
                without(&good, "word/media/image1.png"),
                "word/media/image1.png 不在包里",
            ),
            // XML 坏了
            (
                docx(&[("word/document.xml", "<w:document><w:body></w:document>")]),
                "word/document.xml 格式不对",
            ),
            // 新增了一个没登记内容类型的部件
            (
                docx(&[("word/extra.bin", "x")]),
                "word/extra.bin 没有登记内容类型",
            ),
        ] {
            let error = validate(&bytes, "docx").expect_err("应拒绝");
            assert!(error.contains(expect), "{expect} → {error}");
        }
        // 扩展名不是 Office 新格式
        assert!(validate(&good, "doc").is_err());
        // docx 当成 xlsx 交上来:主文件对不上
        let error = validate(&good, "xlsx").expect_err("类别不对");
        assert!(error.contains("xl/workbook.xml"), "{error}");
    }

    #[test]
    fn external_links_and_absolute_targets_are_resolved_correctly() {
        // 外部链接不要求在包里;`/word/document.xml` 这种绝对路径和 `../` 都要能解析
        let rels = r#"<Relationships xmlns="r"><Relationship Id="a" Type="t" Target="/word/document.xml"/><Relationship Id="b" Type="t" Target="../word/document.xml"/></Relationships>"#;
        assert!(
            validate(
                &docx(&[
                    ("word/_rels/document.xml.rels", rels),
                    ("word/media/image1.png", "x")
                ]),
                "docx"
            )
            .is_ok()
        );
        assert_eq!(
            resolve_target("xl/", "worksheets/sheet1.xml"),
            "xl/worksheets/sheet1.xml"
        );
        assert_eq!(
            resolve_target("xl/worksheets/", "../sharedStrings.xml"),
            "xl/sharedStrings.xml"
        );
        assert_eq!(resolve_target("", "/docProps/app.xml"), "docProps/app.xml");
        assert_eq!(rels_base("_rels/.rels"), "");
        assert_eq!(rels_base("xl/_rels/workbook.xml.rels"), "xl/");
    }

    #[test]
    fn identical_packages_have_no_diff_and_benign_xml_rewrites_are_not_a_difference() {
        let original = docx(&[]);
        assert!(compare(&original, &original).expect("比").is_identical());
        // 引擎重新序列化的常见差别:XML 声明后多一个换行、标签之间多空白、属性换了顺序、<a></a> 写成 <a/>
        let rewritten = docx(&[
            (
                "word/document.xml",
                "<?xml version=\"1.0\"?>\n<w:document xmlns:w=\"w\">\n  <w:body><w:p>\n<w:r><w:t>正文</w:t></w:r></w:p></w:body></w:document>",
            ),
            (
                "word/_rels/document.xml.rels",
                r#"<Relationships xmlns="r"><Relationship Type="image" Target="media/image1.png" Id="rId5"></Relationship><Relationship TargetMode="External" Id="rId6" Type="link" Target="https://example.com"/></Relationships>"#,
            ),
        ]);
        let diff = compare(&original, &rewritten).expect("比");
        assert!(diff.is_identical(), "{diff:?}");
    }

    #[test]
    fn real_differences_are_listed_by_part() {
        let original = docx(&[]);
        // 正文改了一个字、图片换了字节、多了一个部件、少了一个部件
        let edited = docx(&[
            ("word/document.xml", &DOC.replace("正文", "改过")),
            ("word/media/image1.png", "different"),
            ("word/header1.xml", "<w:hdr xmlns:w=\"w\"/>"),
        ]);
        let diff = compare(&original, &edited).expect("比");
        assert_eq!(
            diff.changed,
            vec!["word/document.xml", "word/media/image1.png"]
        );
        assert_eq!(diff.added, vec!["word/header1.xml"]);
        assert!(diff.removed.is_empty());
        let shrunk = without(&original, "word/media/image1.png");
        assert_eq!(
            compare(&original, &shrunk).expect("比").removed,
            vec!["word/media/image1.png"]
        );
        // 文字一样但属性值不同也算不同
        let attr = docx(&[(
            "word/document.xml",
            &DOC.replace("xmlns:w=\"w\"", "xmlns:w=\"w2\""),
        )]);
        assert_eq!(
            compare(&original, &attr).expect("比").changed,
            vec!["word/document.xml"]
        );
        assert!(compare(b"x", &original).is_err());
    }
}
