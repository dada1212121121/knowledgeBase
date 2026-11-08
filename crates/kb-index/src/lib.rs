//! 扫描、过滤与分块(设计规范)。
//!
//! - `lang`:按扩展名识别语言与文件种类;
//! - `filter`:大小、二进制、生成代码、排除规则;
//! - `scan`:遵守 `.gitignore` 的目录遍历与排序(文档优先,代码按 mtime 从新到旧)。

pub mod chunk;
pub mod filter;
pub mod lang;
pub mod scan;

pub use chunk::{ChunkOptions, DefaultChunker, MarkdownChunker, PlainChunker, TreeSitterChunker};
pub use filter::{FileFilter, SkipReason};
pub use kb_core::model::{ScanEntry, ScanOutcome, ScanRequest, SkippedEntry};
pub use lang::{
    FileKind, LEGACY_OFFICE_EXTENSIONS, RICH_DOC_EXTENSIONS, detect_lang, is_legacy_office,
    is_rich_doc, kind_of,
};
pub use scan::{FsScanner, scan};
