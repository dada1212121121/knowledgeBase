//! 类型识别:魔数优先、扩展名兜底（设计规范）。
//!
//! 为什么不用 `infer` crate:设计规范的依赖表里没有它,而这里只需要十来种魔数
//! (PDF / OOXML / EPUB / 图片 / 音视频 / zip),一张静态表比一个新依赖更可控(见下文)。

/// 识别出来的格式。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    /// 纯文本。
    Text,
    /// Markdown。
    Markdown,
    /// 源代码。
    Code,
    /// PDF。
    Pdf,
    /// Word(docx)。
    Docx,
    /// Excel(xlsx)。
    Xlsx,
    /// PowerPoint(pptx)。
    Pptx,
    /// EPUB。
    Epub,
    /// 旧版 Office(doc/xls/ppt,复合文档)。
    LegacyOffice,
    /// OpenDocument 文本(odt)。
    Odt,
    /// RTF。
    Rtf,
    /// HTML。
    Html,
    /// 邮件(eml)。
    Eml,
    /// 图片。
    Image,
    /// 音频。
    Audio,
    /// 视频。
    Video,
    /// zip 压缩包。
    Zip,
    /// 其它压缩包(tar / 7z / rar)。
    Archive,
    /// 认不出来。
    Unknown,
}

impl Kind {
    /// 是否是文本类(可以直接当文本索引)。
    pub fn is_text_like(&self) -> bool {
        matches!(self, Self::Text | Self::Markdown | Self::Code)
    }

    /// 是不是二进制(需要抽取器,没有抽取器就进隔离)。
    pub fn is_binary(&self) -> bool {
        !self.is_text_like() && !matches!(self, Self::Unknown)
    }

    /// 给人看的名字。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Text => "纯文本",
            Self::Markdown => "Markdown",
            Self::Code => "代码",
            Self::Pdf => "PDF",
            Self::Docx => "Word",
            Self::Xlsx => "Excel",
            Self::Pptx => "PowerPoint",
            Self::Epub => "EPUB",
            Self::LegacyOffice => "旧版 Office",
            Self::Odt => "OpenDocument 文本",
            Self::Rtf => "RTF",
            Self::Html => "HTML",
            Self::Eml => "邮件",
            Self::Image => "图片",
            Self::Audio => "音频",
            Self::Video => "视频",
            Self::Zip => "zip 压缩包",
            Self::Archive => "压缩包",
            Self::Unknown => "未知",
        }
    }
}

/// 识别结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Detected {
    /// 格式。
    pub kind: Kind,
    /// MIME(魔数命中时有)。
    pub mime: Option<String>,
    /// 是魔数认出来的还是扩展名认出来的。
    pub by_magic: bool,
}

/// 识别一份输入:先看前 4 KB 的魔数,认不出来再看扩展名。
pub fn detect(head: &[u8], ext: &str) -> Detected {
    if let Some((kind, mime)) = by_magic(head) {
        // 魔数只认出「是个 zip」(前 4 KB 里没看到 word/ xl/ ppt/ 之类的主部件路径)时,扩展名是 Office / EPUB / ODT
        // 就按扩展名办:否则一份 docx 会被当压缩包拆成几十个 XML 子条目
        if kind == Kind::Zip {
            let by_ext = by_extension(ext);
            if matches!(
                by_ext,
                Kind::Docx | Kind::Xlsx | Kind::Pptx | Kind::Epub | Kind::Odt
            ) {
                return Detected {
                    kind: by_ext,
                    mime: Some(mime.to_owned()),
                    by_magic: true,
                };
            }
        }
        return Detected {
            kind,
            mime: Some(mime.to_owned()),
            by_magic: true,
        };
    }
    let kind = by_extension(ext);
    Detected {
        kind,
        mime: None,
        by_magic: false,
    }
}

/// 魔数表。
fn by_magic(head: &[u8]) -> Option<(Kind, &'static str)> {
    // 太短的文件不可能有有意义的魔数
    if head.len() < 4 {
        return None;
    }
    if head.starts_with(b"%PDF") {
        return Some((Kind::Pdf, "application/pdf"));
    }
    if head.starts_with(b"{\\rtf") {
        return Some((Kind::Rtf, "application/rtf"));
    }
    if head.starts_with(&[0x50, 0x4b, 0x03, 0x04]) || head.starts_with(&[0x50, 0x4b, 0x05, 0x06]) {
        // zip 容器:OOXML / EPUB / 普通 zip 靠里面的第一段路径区分
        if let Some(kind) = zip_flavour(head) {
            return Some((kind, "application/zip"));
        }
        return Some((Kind::Zip, "application/zip"));
    }
    if head.starts_with(&[0xd0, 0xcf, 0x11, 0xe0]) {
        return Some((Kind::LegacyOffice, "application/x-ole-storage"));
    }
    if head.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some((Kind::Image, "image/png"));
    }
    if head.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some((Kind::Image, "image/jpeg"));
    }
    if head.starts_with(b"GIF8") {
        return Some((Kind::Image, "image/gif"));
    }
    if head.len() >= 12 && &head[..4] == b"RIFF" {
        let format = &head[8..12];
        if format == b"WAVE" {
            return Some((Kind::Audio, "audio/wav"));
        }
        if format == b"AVI " {
            return Some((Kind::Video, "video/x-msvideo"));
        }
    }
    if head.starts_with(b"ID3") {
        return Some((Kind::Audio, "audio/mpeg"));
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        return Some((Kind::Video, "video/mp4"));
    }
    if head.starts_with(b"OggS") {
        return Some((Kind::Audio, "audio/ogg"));
    }
    if head.starts_with(b"fLaC") {
        return Some((Kind::Audio, "audio/flac"));
    }
    if head.starts_with(b"7z\xbc\xaf\x27\x1c") {
        return Some((Kind::Archive, "application/x-7z-compressed"));
    }
    if head.starts_with(b"Rar!") {
        return Some((Kind::Archive, "application/vnd.rar"));
    }
    if head.len() >= 262 && &head[257..262] == b"ustar" {
        return Some((Kind::Archive, "application/x-tar"));
    }
    None
}

/// zip 容器里第一段文件名决定是 docx / xlsx / pptx / epub / odt。
///
/// 只看本地头里的第一段路径就够了:OOXML 的第一个条目固定是 `[Content_Types].xml`,
/// 之后紧跟 `word/`、`xl/` 或 `ppt/`;EPUB 的第一个条目是 `mimetype`。
fn zip_flavour(head: &[u8]) -> Option<Kind> {
    let text = String::from_utf8_lossy(head);
    // ODT 的第一个条目同样是 `mimetype`,内容是 ODF 的 MIME。不单独认出来的话,
    // 解析任务会把它当压缩包拆成 `content.xml` / `styles.xml` 等子条目,
    // `OdtExtractor` 永远不会被调用(收口时发现)。
    // 只认文本文档:ods / odp 没有抽取器,仍按压缩包处理。
    if text.contains("application/vnd.oasis.opendocument.text") {
        return Some(Kind::Odt);
    }
    if text.contains("word/") {
        return Some(Kind::Docx);
    }
    if text.contains("xl/") {
        return Some(Kind::Xlsx);
    }
    if text.contains("ppt/") {
        return Some(Kind::Pptx);
    }
    if text.contains("application/epub+zip") {
        return Some(Kind::Epub);
    }
    None
}

/// 扩展名兜底。
fn by_extension(ext: &str) -> Kind {
    let ext = ext.trim_start_matches('.').to_ascii_lowercase();
    match ext.as_str() {
        "" => Kind::Unknown,
        "md" | "markdown" | "mdx" | "rst" | "txt" | "log" => {
            if ext == "md" || ext == "markdown" || ext == "mdx" {
                Kind::Markdown
            } else {
                Kind::Text
            }
        }
        "rs" | "py" | "pyi" | "js" | "mjs" | "cjs" | "jsx" | "ts" | "tsx" | "go" | "java" | "c"
        | "h" | "cc" | "cpp" | "hpp" | "cs" | "rb" | "php" | "swift" | "kt" | "scala" | "sh"
        | "bash" | "zsh" | "sql" | "toml" | "yaml" | "yml" | "json" | "ini" | "conf" | "css"
        | "scss" | "vue" | "xml" | "lua" | "r" | "m" | "pl" => Kind::Code,
        // HTML 是文档而不是源码:按文本索引会把 `<nav>` / `<script>` 一起塞进块里,
        // 所以这里单独归一类,交给 `HtmlExtractor` 抽正文
        "html" | "htm" | "xhtml" => Kind::Html,
        "pdf" => Kind::Pdf,
        // Office 模板 / 启用宏的变体:容器与正文部件和正式文档一致,只是扩展名不同。
        // 不识别会让带模板扩展名的文件落到 Unknown 或压缩包,链接点开没有预览。
        "docx" | "docm" | "dotx" | "dotm" => Kind::Docx,
        "xlsx" | "xlsm" | "xltx" | "xltm" => Kind::Xlsx,
        "pptx" | "pptm" | "potx" | "potm" | "ppsx" | "ppsm" => Kind::Pptx,
        "doc" | "xls" | "ppt" => Kind::LegacyOffice,
        "epub" => Kind::Epub,
        "odt" => Kind::Odt,
        "rtf" => Kind::Rtf,
        "eml" => Kind::Eml,
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "tif" | "tiff" | "svg" => Kind::Image,
        "mp3" | "wav" | "flac" | "m4a" | "aac" | "ogg" => Kind::Audio,
        "mp4" | "mov" | "mkv" | "avi" | "webm" => Kind::Video,
        "zip" => Kind::Zip,
        "tar" | "gz" | "tgz" | "bz2" | "xz" | "7z" | "rar" => Kind::Archive,
        _ => Kind::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn office_templates_are_recognized_by_extension() {
        // 模板也是 OOXML 容器;扩展名兜底要认出来,不能当压缩包拆
        for (ext, kind) in [
            ("dotx", Kind::Docx),
            ("dotm", Kind::Docx),
            ("docm", Kind::Docx),
            ("xltx", Kind::Xlsx),
            ("xltm", Kind::Xlsx),
            ("potx", Kind::Pptx),
            ("potm", Kind::Pptx),
            ("ppsx", Kind::Pptx),
        ] {
            assert_eq!(detect(b"", ext).kind, kind, "{ext}");
        }
    }

    #[test]
    fn magic_wins_over_extension() {
        // 扩展名说是文本,魔数说是 PDF
        let detected = detect(b"%PDF-1.7\n...", "txt");
        assert_eq!(detected.kind, Kind::Pdf);
        assert!(detected.by_magic);
        assert_eq!(detected.mime.as_deref(), Some("application/pdf"));
    }

    #[test]
    fn ooxml_is_told_apart_by_the_first_entry() {
        let docx = b"PK\x03\x04[Content_Types].xml word/document.xml";
        assert_eq!(detect(docx, "").kind, Kind::Docx);
        let xlsx = b"PK\x03\x04[Content_Types].xml xl/workbook.xml";
        assert_eq!(detect(xlsx, "").kind, Kind::Xlsx);
        let pptx = b"PK\x03\x04[Content_Types].xml ppt/presentation.xml";
        assert_eq!(detect(pptx, "").kind, Kind::Pptx);
        let epub = b"PK\x03\x04mimetype application/epub+zip";
        assert_eq!(detect(epub, "").kind, Kind::Epub);
        let plain = b"PK\x03\x04notes/readme.txt";
        assert_eq!(detect(plain, "zip").kind, Kind::Zip);
    }

    #[test]
    fn odt_is_not_mistaken_for_a_plain_zip() {
        // ODT 也是 zip 容器:若识别成 `Zip`,解析任务会把它当压缩包拆成
        // `mimetype` / `content.xml` 等子条目,`OdtExtractor` 永远不会被调用
        let odt = b"PK\x03\x04mimetypeapplication/vnd.oasis.opendocument.text";
        let detected = detect(odt, "odt");
        assert_eq!(detected.kind, Kind::Odt);
        assert!(!detected.kind.is_text_like(), "ODT 要走抽取器");
        assert!(detected.kind.is_binary());
        // 没有扩展名时靠 mimetype 里的 MIME 认出来
        assert_eq!(detect(odt, "").kind, Kind::Odt);
        // 扩展名兜底
        assert_eq!(detect(b"", "odt").kind, Kind::Odt);
        // 表格 / 演示文稿没有抽取器,仍按压缩包处理(行为不变)
        let ods = b"PK\x03\x04mimetypeapplication/vnd.oasis.opendocument.spreadsheet";
        assert_eq!(detect(ods, "ods").kind, Kind::Zip);
    }

    /// 前 4 KB 里没出现 `word/` / `xl/` / `ppt/` 的真实文档(WPS 常把 customXml、docProps 排在最前面,
    /// 缩略图一大就把正文部件挤出了前 4 KB):魔数只能认出「是 zip」,这时扩展名说是 docx / xlsx / pptx 就信扩展名。
    /// 以前会被当成压缩包拆开,一份 Word 变成三十个 XML 子条目。
    #[test]
    fn an_ooxml_file_whose_main_part_is_past_the_first_4k_is_still_an_office_file() {
        let mut head = b"PK\x03\x04customXml/item1.xml docProps/thumbnail.wmf ".to_vec();
        head.resize(4096, b'x');
        for (ext, kind) in [
            ("docx", Kind::Docx),
            ("xlsx", Kind::Xlsx),
            ("pptx", Kind::Pptx),
            ("DOCX", Kind::Docx),
        ] {
            let detected = detect(&head, ext);
            assert_eq!(
                detected.kind, kind,
                ".{ext} 要按 Office 文件处理,不能当压缩包拆开"
            );
            assert!(detected.by_magic, "确实是 zip,魔数对得上");
            assert!(!matches!(detected.kind, Kind::Zip | Kind::Archive));
        }
        // 扩展名就是 zip(或没有 / 别的):仍是压缩包
        assert_eq!(detect(&head, "zip").kind, Kind::Zip);
        assert_eq!(detect(&head, "").kind, Kind::Zip);
        assert_eq!(
            detect(&head, "txt").kind,
            Kind::Zip,
            "内容是 zip 而扩展名是文本:按内容"
        );
    }

    #[test]
    fn extension_is_the_fallback() {
        let detected = detect(b"hello", "md");
        assert_eq!(detected.kind, Kind::Markdown);
        assert!(!detected.by_magic);
        assert_eq!(detect(b"fn main() {}", "rs").kind, Kind::Code);
        assert_eq!(detect(b"", "unknown-ext").kind, Kind::Unknown);
    }

    #[test]
    fn html_is_a_document_not_source_code() {
        // HTML 要交给 `HtmlExtractor` 抽正文,不能被当成代码按原文索引
        for ext in ["html", "htm", ".html", "XHTML"] {
            let detected = detect(b"<html><body><nav>x</nav><p>body</p></body></html>", ext);
            assert_eq!(detected.kind, Kind::Html, "{ext}");
            assert!(!detected.kind.is_text_like(), "HTML 不能走纯文本索引:{ext}");
            assert!(detected.kind.is_binary(), "HTML 要有抽取器才能入库:{ext}");
        }
        // 其它标记类格式仍然按代码处理
        assert_eq!(detect(b"<config/>", "xml").kind, Kind::Code);
        assert_eq!(
            detect(b"<template><div/></template>", "vue").kind,
            Kind::Code
        );
    }

    #[test]
    fn images_audio_video_archives() {
        assert_eq!(
            detect(&[0x89, b'P', b'N', b'G', 0x0d], "").kind,
            Kind::Image
        );
        assert_eq!(detect(&[0xff, 0xd8, 0xff, 0xe0], "").kind, Kind::Image);
        assert_eq!(
            detect(b"RIFF\x00\x00\x00\x00WAVEfmt ", "").kind,
            Kind::Audio
        );
        assert_eq!(
            detect(b"RIFF\x00\x00\x00\x00AVI LIST", "").kind,
            Kind::Video
        );
        assert_eq!(detect(b"ID3\x03\x00", "").kind, Kind::Audio);
        assert_eq!(detect(b"\x00\x00\x00\x18ftypmp42", "").kind, Kind::Video);
        assert_eq!(detect(b"7z\xbc\xaf\x27\x1c", "").kind, Kind::Archive);
        assert_eq!(
            detect(&[0xd0, 0xcf, 0x11, 0xe0], "").kind,
            Kind::LegacyOffice
        );
    }

    #[test]
    fn text_like_and_binary_helpers() {
        assert!(Kind::Markdown.is_text_like());
        assert!(!Kind::Pdf.is_text_like());
        assert!(Kind::Pdf.is_binary());
        assert!(!Kind::Unknown.is_binary(), "未知类型交给上层决定怎么兜底");
        assert_eq!(Kind::Pdf.label(), "PDF");
    }
}
