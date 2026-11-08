//! 切片、锚点与引用块:检索结果里能画、能跳的那部分。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Millis;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 数据来源引用。
#[derive(Clone, Debug)]
pub struct SourceRef {
    /// `file` / `http` / `pdf`。
    pub scheme: String,
    /// 路径或 URL。
    pub location: String,
    /// 项目根目录。
    pub project_root: Option<PathBuf>,
}

/// 载入后的原始文档。
///
/// 插件钩子要在进程间传它,所以同时实现 `Serialize` / `Deserialize`;
/// 字段保持与索引链路一致,不做改名,避免插件作者和宿主各写一套映射。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SourceDoc {
    /// 项目内相对路径(用 `/` 分隔)或 URL。
    pub source: String,
    /// 语言识别结果,未知时为 `text`。
    pub lang: String,
    /// 正文。
    pub text: String,
    /// 文件内容哈希。
    pub file_hash: String,
    /// 文件大小。
    pub size: u64,
    /// 文件修改时间。
    pub mtime: Millis,
    /// 项目名。
    pub project_name: String,
}

/// 分块结果。
///
/// `Deserialize` 是给插件返回值用的(宿主逐项校验后才写库);
/// 可选字段带默认值,插件可以只填 `key` / `text` / `start_line` / `end_line`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Chunk {
    /// 符号路径(如 `impl Foo::fn bar`)或 `#<序号>`。
    pub key: String,
    /// 块文本。
    pub text: String,
    /// 起始行。
    pub start_line: i32,
    /// 结束行。
    pub end_line: i32,
    /// 符号路径。
    #[serde(default)]
    pub symbol: Option<String>,
    /// 标题。
    #[serde(default)]
    pub title: Option<String>,
    /// 结构化上下文头。
    #[serde(default)]
    pub header: String,
    /// 块在原始文档里的位置(当前阶段 的 anchor;纯文本 / 代码路径为 `None`)。
    #[serde(default)]
    pub anchor: Option<Anchor>,
}

// ---------------------------------------------------------------------------
// 当前阶段:统一中间文档与 Extractor
// ---------------------------------------------------------------------------

/// 类型识别的把握程度。
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    /// 只认得一点点,宁可不用(排最小,挑抽取器时被 `Probable` / `Certain` 压过)。
    Unlikely,
    /// 扩展名命中:大概率对。
    Probable,
    /// 魔数命中:基本可以确定(排最大)。
    Certain,
}

impl Confidence {
    /// 是否值得直接用这个抽取器。
    pub fn is_usable(&self) -> bool {
        matches!(self, Self::Certain | Self::Probable)
    }
}

/// 块在原始文档里的位置(检索命中后能跳回去)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Anchor {
    /// 文本行范围(1 起,含两端)。
    Line {
        /// 起始行。
        start: u32,
        /// 结束行。
        end: u32,
    },
    /// PDF / 图片的页码(1 起)。
    Page {
        /// 页码。
        page: u32,
    },
    /// 表格单元格(例如 `Sheet1!B12`)。
    Cell {
        /// 工作表名。
        sheet: String,
        /// 单元格地址。
        cell: String,
    },
    /// 幻灯片页码(1 起)。
    Slide {
        /// 页号。
        slide: u32,
    },
    /// 音视频的时间段(毫秒)。
    Time {
        /// 起点(毫秒)。
        start_ms: u64,
        /// 终点(毫秒)。
        end_ms: u64,
    },
    /// 选中的一段文字(选区批注)。
    ///
    /// 存摘录和前后各一小段上下文,不存位置:正文被改过、段落挪了,摘录还能找回来;
    /// 同一句话出现多次时靠前后文挑对的那一处;摘录本身被改掉就找不到,评论保留、界面标"原文已改动"。
    /// 只用在批注上,抽取出来的文档块不会有这种锚点。
    Quote {
        /// 选中的文字。
        text: String,
        /// 摘录前面的一小段。
        #[serde(default)]
        prefix: String,
        /// 摘录后面的一小段。
        #[serde(default)]
        suffix: String,
    },
}

/// 选区批注摘录最多多少字(与前端 `MAX_QUOTE_CHARS` 一致)。
pub const MAX_QUOTE_CHARS: usize = 1000;
/// 摘录前后文各最多多少字。前端取 32,这里留一倍余量。
pub const MAX_QUOTE_CONTEXT_CHARS: usize = 64;

impl Anchor {
    /// 调用方传来的锚点是否合法。`Quote` 来自不可信输入:摘录不能为空、不能过长,
    /// 否则一条评论就能往批注表和检索里塞任意大的文本。其它类型只是几个数字 / 短字符串,不检查。
    pub fn validate(&self) -> Result<(), String> {
        if let Self::Quote {
            text,
            prefix,
            suffix,
        } = self
        {
            if text.trim().is_empty() {
                return Err("选区批注的摘录不能为空".to_owned());
            }
            if text.chars().count() > MAX_QUOTE_CHARS {
                return Err(format!("选区批注的摘录不能超过 {MAX_QUOTE_CHARS} 字"));
            }
            if prefix.chars().count() > MAX_QUOTE_CONTEXT_CHARS
                || suffix.chars().count() > MAX_QUOTE_CONTEXT_CHARS
            {
                return Err(format!(
                    "选区批注的前后文各不能超过 {MAX_QUOTE_CONTEXT_CHARS} 字"
                ));
            }
        }
        Ok(())
    }

    /// 给人看的位置说明(`p.12` / `Sheet1!B12` / `00:12–00:32` / 选区批注是摘录的开头)。
    pub fn label(&self) -> String {
        match self {
            Self::Line { start, end } => format!("L{start}-{end}"),
            Self::Page { page } => format!("p.{page}"),
            Self::Cell { sheet, cell } => format!("{sheet}!{cell}"),
            Self::Slide { slide } => format!("slide {slide}"),
            Self::Time { start_ms, end_ms } => {
                format!("{}–{}", clock(*start_ms), clock(*end_ms))
            }
            Self::Quote { text, .. } => {
                let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
                let mut head: String = flat.chars().take(24).collect();
                if flat.chars().count() > 24 {
                    head.push('…');
                }
                format!("“{head}”")
            }
        }
    }
}

/// 毫秒 → `mm:ss`。
fn clock(ms: u64) -> String {
    let total = ms / 1000;
    format!("{:02}:{:02}", total / 60, total % 60)
}

/// 中间文档里的一个块。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Block {
    /// 标题(level 1..=6)。
    Heading {
        /// 层级。
        level: u8,
        /// 标题文本。
        text: String,
    },
    /// 段落。
    Paragraph {
        /// 正文。
        text: String,
    },
    /// 表格(表头 + 行)。
    Table {
        /// 表头。
        header: Vec<String>,
        /// 数据行。
        rows: Vec<Vec<String>>,
    },
    /// 代码块。
    Code {
        /// 语言。
        lang: String,
        /// 代码正文。
        text: String,
    },
    /// 图片(OCR 文本在 填入)。
    Image {
        /// 图注。
        caption: Option<String>,
        /// OCR 识别出的文本。
        ocr_text: Option<String>,
        /// 图片在原文件容器里的条目名(如 docx 的 `word/media/image1.png`)。
        ///
        /// 只有抽取器能从容器里把图片字节原样取出来时才有值;导出 Markdown 副本时据此把图片落盘,
        /// 否则只能留一句占位说明、截图就丢了。它不参与检索文本。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resource: Option<String>,
    },
    /// 音视频(转写文本在 填入)。
    Media {
        /// 转写文本。
        transcript: Option<String>,
    },
}

impl Block {
    /// 纯文本内容(标题 / 段落 / 代码 / OCR / 转写;表格按行拼)。
    pub fn text(&self) -> String {
        match self {
            Self::Heading { text, .. } => text.clone(),
            Self::Paragraph { text } => text.clone(),
            Self::Code { text, .. } => text.clone(),
            Self::Table { header, rows } => {
                let mut out = header.join(" | ");
                for row in rows {
                    out.push('\n');
                    out.push_str(&row.join(" | "));
                }
                out
            }
            Self::Image {
                caption, ocr_text, ..
            } => match (caption, ocr_text) {
                (Some(caption), Some(text)) => format!("{caption}\n{text}"),
                (Some(caption), None) => caption.clone(),
                (None, Some(text)) => text.clone(),
                (None, None) => String::new(),
            },
            Self::Media { transcript } => transcript.clone().unwrap_or_default(),
        }
    }

    /// 是否是可以参与分块的内容块(空块要丢掉)。
    ///
    /// 带原图的图片块没有文字也不算空:抽取器的 `is_empty` 过滤会把它留在文档里,
    /// 导出 Markdown 副本时才有地方把截图放回去;分块器照旧会因为没有文字跳过它。
    pub fn is_empty(&self) -> bool {
        if matches!(
            self,
            Self::Image {
                resource: Some(_),
                ..
            }
        ) {
            return false;
        }
        self.text().trim().is_empty()
    }

    /// 是不是一句“没做 OCR”的提示图注。
    ///
    /// 抽取器给没有文字层的页写的是 `第 N 页没有文字层(needs_ocr)`,那是给预览看的
    /// 提示、不是正文:分块器要跳过它,否则索引里会多出一堆搜不到东西的块(还白占向量)。
    /// 带 OCR 结果的图片块(`ocr_text` 非空)不算提示,照旧入索引。
    pub fn is_ocr_hint(&self) -> bool {
        matches!(
        self,
        Self::Image {
        caption: Some(caption),
        ocr_text: None,
        ..
        } if caption.contains("(needs_ocr)")
        )
    }
}

/// 带位置的一个块。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnchoredBlock {
    /// 位置。
    pub anchor: Anchor,
    /// 内容。
    pub block: Block,
}

/// 中间文档的元信息。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DocMeta {
    /// 来源(项目内相对路径或 URL)。
    pub source: String,
    /// 文档标题(有就用它做 header)。
    pub title: Option<String>,
    /// 语言(`zh` / `en` / 代码语言 …)。
    pub lang: String,
    /// MIME 类型(魔数识别出来的)。
    pub mime: Option<String>,
    /// 内容哈希。
    pub file_hash: String,
    /// 字节数。
    pub size: u64,
    /// 修改时间。
    pub mtime: Millis,
    /// 项目名。
    pub project_name: String,
}

/// 统一中间文档:所有格式先抽成它,再交给 [`crate::ports::DocChunker`]。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Doc {
    /// 元信息。
    pub meta: DocMeta,
    /// 块(顺序即阅读顺序)。
    pub blocks: Vec<AnchoredBlock>,
}

impl Doc {
    /// 拼接全文(调试与兜底用)。
    pub fn text(&self) -> String {
        self.blocks
            .iter()
            .map(|block| block.block.text())
            .filter(|text| !text.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}
