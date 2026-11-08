//! 多格式抽取与统一中间文档（设计规范）。
//!
//! - [`detect`]:魔数优先、扩展名兜底(自己维护一张十来种格式的表,不引 `infer`，见下文);
//! - [`Extractor`](kb_core::ports::Extractor) 的实现:纯文本 / Markdown / 代码(起再加
//!   PDF、Office、EPUB、邮件);
//! - [`DocChunkerImpl`]:把 [`Doc`](kb_core::model::Doc) 切成检索块(标题层级、表格按行、幻灯片按页、
//!   媒体按 60 秒窗口),每块带 anchor。
//!
//! 现有 Markdown / 代码 / 纯文本的索引路径不变;这里提供的是“先抽成 Doc 再分块”的通用链路,
//! 供后续格式复用。

pub mod chunker;
pub mod csv;
pub mod csv_edit;
pub mod detect;
pub mod eml;
pub mod epub;
pub mod html;
pub mod ipynb;
pub mod log;
pub mod media;
pub mod ocr;
pub mod odt_rtf;
pub mod office_check;
pub mod ooxml;
pub mod pdf;
pub mod registry;
pub mod text;
pub mod text_codec;
pub mod xlsx_edit;
pub mod zip;

pub use chunker::{DocChunkOptions, DocChunkerImpl};
pub use csv::CsvExtractor;
pub use detect::{Detected, Kind};
pub use eml::{EmlExtractor, EmlMessage, parse_eml};
pub use epub::EpubExtractor;
pub use html::HtmlExtractor;
pub use ipynb::IpynbExtractor;
pub use log::LogExtractor;
pub use media::{ImageExtractor, MediaExtractor};
pub use ocr::{OcrOutcome, TranscribeOutcome, install, ocr_image, transcribe_media};
pub use odt_rtf::{OdtExtractor, RtfExtractor};
pub use ooxml::{DocxExtractor, PptxExtractor, XlsxExtractor};
pub use pdf::PdfExtractor;
pub use registry::{ExtractorRegistry, default_registry};
pub use text::{CodeExtractor, MarkdownExtractor, PlainTextExtractor};
