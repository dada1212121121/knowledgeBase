//! 扫描与提取:文件类型、跳过原因、提取元信息。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::{Anchor, Block, Doc, Millis};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/// 文件种类(索引时文档排在代码前面)。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    /// 文档:`*.md` / `*.mdx` / `*.rst` / `*.txt`。
    Doc,
    /// 代码与其他文本。
    Code,
}

impl FileKind {
    /// 数据库里使用的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Doc => "doc",
            Self::Code => "code",
        }
    }
}

/// 跳过文件的原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// 命中排除规则。
    Excluded,
    /// 超过大小上限。
    TooLarge,
    /// 二进制文件(前 8KB 含 NUL)。
    Binary,
    /// 生成代码(`@generated` / `DO NOT EDIT`)。
    Generated,
    /// 读取失败(权限等)。
    Unreadable,
}

impl SkipReason {
    /// 写进 `files.status` 的短字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Excluded => "excluded",
            Self::TooLarge => "too_large",
            Self::Binary => "binary",
            Self::Generated => "generated",
            Self::Unreadable => "unreadable",
        }
    }

    /// 写进 `files.error` 的人类可读说明。
    pub fn detail(self) -> &'static str {
        match self {
            Self::Excluded => "命中排除规则",
            Self::TooLarge => "超过 max_file_bytes",
            Self::Binary => "二进制文件(前 8KB 含 NUL)",
            Self::Generated => "生成代码(@generated / DO NOT EDIT)",
            Self::Unreadable => "读取失败",
        }
    }
}

/// 一次扫描的请求。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanRequest {
    /// 项目根目录。
    pub root: PathBuf,
    /// 只索引这些 glob(空 = 全部)。
    pub include: Vec<String>,
    /// 排除的 glob。
    pub exclude: Vec<String>,
    /// 单文件大小上限。
    pub max_file_bytes: u64,
    /// 旧格式 Office(`.doc` / `.xls` / `.ods`)是否放行:装了转换器时由调用方打开,
    /// 这些文件才会进到索引里被转换后抽取;关着时仍按二进制跳过。
    pub legacy_office: bool,
    /// 插件 extract 声明的 glob(项目内相对路径)。命中的文件即使含 NUL 也放行,
    /// 交给插件解析;没有插件认领时仍按二进制跳过,避免把普通二进制文件当文本索引。
    pub allow_binary: Vec<String>,
}

impl Default for ScanRequest {
    fn default() -> Self {
        Self {
            root: PathBuf::new(),
            include: Vec::new(),
            exclude: Vec::new(),
            max_file_bytes: 204_800,
            legacy_office: false,
            allow_binary: Vec::new(),
        }
    }
}

/// 通过过滤的文件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScanEntry {
    /// 绝对路径。
    pub path: PathBuf,
    /// 项目内相对路径(用 `/` 分隔)。
    pub relative: String,
    /// 字节数。
    pub size: u64,
    /// 修改时间(Unix 毫秒)。
    pub mtime: Millis,
    /// 语言。
    pub lang: String,
    /// 文件种类。
    pub kind: FileKind,
}

/// 被跳过的文件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SkippedEntry {
    /// 项目内相对路径。
    pub relative: String,
    /// 跳过原因。
    pub reason: SkipReason,
}

/// 扫描结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScanOutcome {
    /// 通过过滤、已排序的文件。
    pub files: Vec<ScanEntry>,
    /// 被跳过的文件。
    pub skipped: Vec<SkippedEntry>,
}

/// 解析队列「内容」列用的抽取元信息(从抽取结果的锚点统计出来)。
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ExtractMeta {
    /// 页数(PDF / 图片)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pages: Option<u32>,
    /// 工作表数(xlsx / csv)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheets: Option<u32>,
    /// 幻灯片数(pptx)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slides: Option<u32>,
    /// 抽取成功但没有文字层(需要 OCR / 转写)。
    #[serde(default)]
    pub needs_ocr: bool,
}

impl ExtractMeta {
    /// 从抽取结果的锚点统计元信息。
    ///
    /// - `Page` 锚点 → 页数(取最大页码);
    /// - `Cell` 锚点 → 工作表数(去重);
    /// - `Slide` 锚点 → 幻灯片数(取最大页);
    /// - **没有任何真实文字**、但有图片 / 媒体块 → `needs_ocr`。
    ///
    /// **不算时长**:媒体抽取器给的时间锚点是 `0..60_000` 的占位(不是真实时长),
    /// 采信它会向用户展示假数据,所以拿不到真实时长就不填。
    pub fn from_doc(doc: &Doc) -> Self {
        let mut pages: Option<u32> = None;
        let mut slides: Option<u32> = None;
        let mut sheets: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut has_media_block = false;
        let mut has_untranscribed_media = false;
        let mut has_real_text = false;
        for item in &doc.blocks {
            if matches!(&item.block, Block::Media { transcript } if transcript.as_deref().is_none_or(|text| text.trim().is_empty()))
            {
                has_untranscribed_media = true;
            }
        }
        for item in &doc.blocks {
            match &item.anchor {
                Anchor::Page { page } => pages = Some(pages.map_or(*page, |old| old.max(*page))),
                Anchor::Slide { slide } => {
                    slides = Some(slides.map_or(*slide, |old| old.max(*slide)))
                }
                Anchor::Cell { sheet, .. } => {
                    sheets.insert(sheet.clone());
                }
                Anchor::Time { .. } | Anchor::Line { .. } | Anchor::Quote { .. } => {}
            }
            // 未转写的音视频:抽取器会追加一段「未做转写…」的**提示段落**(锚点是时间),
            // 那是提示不是正文;真实转写在 `Block::Media.transcript` 里。
            let is_media_hint =
                has_untranscribed_media && matches!(item.anchor, Anchor::Time { .. });
            if !is_media_hint {
                has_real_text |= has_real_text_block(&item.block);
            }
            if matches!(item.block, Block::Image { .. } | Block::Media { .. }) {
                has_media_block = true;
            }
        }
        Self {
            pages,
            sheets: (!sheets.is_empty()).then_some(sheets.len() as u32),
            slides,
            // 只有“有图片 / 媒体块、且没有任何真实文字”才算需要 OCR:
            // 抽取器会给未识别的图片塞一句带 “(needs_ocr)” 的**图注**,那是提示不是正文。
            needs_ocr: has_media_block && !has_real_text,
        }
    }
}

/// 这个块里有没有**真实**文字。
///
/// 与 [`Block::text`] 的区别:图注(caption)与媒体提示段落不算正文——
/// 抽取器在“没做 OCR / 没做转写”时会写一句提示,把提示当正文会让 `needs_ocr` 永远为 false。
fn has_real_text_block(block: &Block) -> bool {
    match block {
        Block::Heading { text, .. } | Block::Paragraph { text } | Block::Code { text, .. } => {
            !text.trim().is_empty()
        }
        Block::Table { header, rows } => {
            header.iter().any(|cell| !cell.trim().is_empty())
                || rows
                    .iter()
                    .any(|row| row.iter().any(|cell| !cell.trim().is_empty()))
        }
        Block::Image { ocr_text, .. } => ocr_text
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty()),
        Block::Media { transcript } => transcript
            .as_deref()
            .is_some_and(|text| !text.trim().is_empty()),
    }
}
