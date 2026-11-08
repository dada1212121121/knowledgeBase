//! 抽取器注册表:按“魔数 → 扩展名”挑一个抽取器,并统一成 [`Doc`]。

use std::sync::{Arc, OnceLock, PoisonError, RwLock};

use kb_core::model::{Confidence, Doc, SourceRef};
use kb_core::ports::Extractor;
use kb_core::{KbError, Result};

use crate::csv::CsvExtractor;
use crate::eml::EmlExtractor;
use crate::epub::EpubExtractor;
use crate::html::HtmlExtractor;
use crate::ipynb::IpynbExtractor;
use crate::log::LogExtractor;
use crate::media::{ImageExtractor, MediaExtractor};
use crate::odt_rtf::{OdtExtractor, RtfExtractor};
use crate::ooxml::{DocxExtractor, PptxExtractor, XlsxExtractor};
use crate::pdf::PdfExtractor;
use crate::text::{CodeExtractor, MarkdownExtractor, PlainTextExtractor};

/// 抽取器注册表。
///
/// 分两层,因为“谁优先”对这两层是相反的意思:
///
/// - **内置层**(`builtins`,由 [`default_registry`] 注册):**先注册的胜**,顺序是“具体 → 兜底”
///   (Markdown 排在 PlainText 之前、Html 排在 Code 之前)。这些顺序都是历史行为,调过来就是回归
///   ——`html` 同时命中 `HtmlExtractor` 与 `CodeExtractor` 的扩展名表,平手时该由 HTML 抽。
/// - **覆盖层**(`overrides`,由 [`ExtractorRegistry::register_override`] / [`register_global`] 注册):
///   **后注册的胜**,并且平手时压过内置层 —— 插件就是靠这一层盖掉内置实现的。
///
/// 挑选规则三条,顺序不能换:
/// 1. 把握大的优先(魔数命中 `Certain` 压过扩展名命中 `Probable`);
/// 2. 平手时覆盖层压过内置层;
/// 3. 同层平手:覆盖层取后注册的,内置层取先注册的。
#[derive(Clone, Default)]
pub struct ExtractorRegistry {
    builtins: Vec<Arc<dyn Extractor>>,
    overrides: Vec<Arc<dyn Extractor>>,
}

impl ExtractorRegistry {
    /// 空表。
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一个内置抽取器。
    ///
    /// 同层平手时**先**注册的胜,所以顺序 = 具体在前、兜底在后。
    pub fn register(&mut self, extractor: Arc<dyn Extractor>) {
        self.builtins.push(extractor);
    }

    /// 注册一个覆盖实现(插件 / 外部注入)。
    ///
    /// 平手时压过内置层,同层内后注册的胜 —— 这就是“插件覆盖内置”的实现方式。
    pub fn register_override(&mut self, extractor: Arc<dyn Extractor>) {
        self.overrides.push(extractor);
    }

    /// 已注册的抽取器 id(内置在前,覆盖层在后)。
    pub fn ids(&self) -> Vec<&str> {
        self.iter_layers().map(|(item, _)| item.id()).collect()
    }

    /// 挑一个能处理这份输入的抽取器。规则见类型文档。
    pub fn pick(&self, head: &[u8], ext: &str) -> Option<(Arc<dyn Extractor>, Confidence)> {
        // `bool` 标记来自覆盖层,最后组装时丢掉。
        let mut best: Option<(Arc<dyn Extractor>, Confidence, bool)> = None;
        for (extractor, from_override) in self.iter_layers() {
            let confidence = extractor.detect(head, ext);
            if !confidence.is_usable() {
                continue;
            }
            let wins = match &best {
                None => true,
                Some((_, current, current_is_override)) => {
                    confidence > *current
                        || (confidence == *current
                            && match (from_override, *current_is_override) {
                                // 覆盖层压过内置层。
                                (true, false) => true,
                                // 同层平手:覆盖层后注册的胜。
                                (true, true) => true,
                                // 同层平手:内置层先注册的胜。
                                (false, false) => false,
                                (false, true) => false,
                            })
                }
            };
            if wins {
                best = Some((extractor.clone(), confidence, from_override));
            }
        }
        best.map(|(extractor, confidence, _)| (extractor, confidence))
    }

    /// 抽取:没有抽取器时返回 [`KbError::Unavailable`],由调用方决定兜底还是隔离。
    pub async fn extract(&self, source: &SourceRef, bytes: &[u8], ext: &str) -> Result<Doc> {
        let head = &bytes[..bytes.len().min(4096)];
        let Some((extractor, _)) = self.pick(head, ext) else {
            return Err(KbError::Unavailable(format!("没有能处理 .{ext} 的抽取器")));
        };
        extractor.extract(source, bytes).await
    }

    /// 先内置层、后覆盖层。
    fn iter_layers(&self) -> impl Iterator<Item = (&Arc<dyn Extractor>, bool)> {
        self.builtins
            .iter()
            .map(|item| (item, false))
            .chain(self.overrides.iter().map(|item| (item, true)))
    }
}

/// 进程级注册表的单元:存的是**整个表的快照**(`Arc`),不是把锁带在身上。
///
/// 调用方拿到的是 `Arc<ExtractorRegistry>`,可以跨越 `await` 持有;注册时拿写锁**换一个新快照**,
/// 正在跑的抽取继续用旧快照 —— 不需要把读锁带进异步。
static GLOBAL: OnceLock<RwLock<Arc<ExtractorRegistry>>> = OnceLock::new();

fn global_cell() -> &'static RwLock<Arc<ExtractorRegistry>> {
    GLOBAL.get_or_init(|| RwLock::new(Arc::new(default_registry())))
}

/// 进程级注册表的当前快照。
///
/// 守护进程里所有抽取都从这里取,不再各建一份 —— 否则“注册了插件抽取器”在别的模块里看不见。
pub fn global() -> Arc<ExtractorRegistry> {
    global_cell()
        .read()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
}

/// 往进程级注册表里追加一个**覆盖**抽取器(平手时压过内置,是插件覆盖内置的入口)。
///
/// 锁里只有一次 `Vec` 克隆,持锁期间不做 I/O 也不 `await`。
pub fn register_global(extractor: Arc<dyn Extractor>) {
    let mut guard = global_cell()
        .write()
        .unwrap_or_else(PoisonError::into_inner);
    let mut next = (**guard).clone();
    next.register_override(extractor);
    *guard = Arc::new(next);
}

/// 内置抽取器(文本 / Markdown / 代码); 起在这里加 PDF、Office 等。
///
/// **注册顺序 = 内置层的优先顺序**:同层平手时先注册的胜,所以具体格式在前、兜底最宽的
/// `PlainTextExtractor` 放在最后。
pub fn default_registry() -> ExtractorRegistry {
    let mut registry = ExtractorRegistry::new();
    registry.register(Arc::new(MarkdownExtractor));
    registry.register(Arc::new(CsvExtractor::comma()));
    registry.register(Arc::new(CsvExtractor::tab()));
    registry.register(Arc::new(DocxExtractor));
    registry.register(Arc::new(XlsxExtractor));
    registry.register(Arc::new(PptxExtractor));
    registry.register(Arc::new(PdfExtractor));
    registry.register(Arc::new(OdtExtractor));
    registry.register(Arc::new(RtfExtractor));
    registry.register(Arc::new(HtmlExtractor));
    registry.register(Arc::new(IpynbExtractor));
    registry.register(Arc::new(LogExtractor));
    registry.register(Arc::new(EpubExtractor));
    registry.register(Arc::new(EmlExtractor));
    registry.register(Arc::new(ImageExtractor));
    registry.register(Arc::new(MediaExtractor));
    registry.register(Arc::new(CodeExtractor));
    registry.register(Arc::new(PlainTextExtractor));
    registry
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::{Kind, detect};

    #[tokio::test]
    async fn picks_markdown_for_md_files() {
        let registry = default_registry();
        let (extractor, confidence) = registry.pick("# 标题".as_bytes(), "md").expect("应能挑到");
        assert_eq!(extractor.id(), "text/markdown");
        assert_eq!(confidence, Confidence::Probable);
    }

    #[tokio::test]
    async fn extracts_a_markdown_doc() {
        let registry = default_registry();
        let source = SourceRef {
            scheme: "file".to_owned(),
            location: "docs/a.md".to_owned(),
            project_root: None,
        };
        let doc = registry
            .extract(&source, "# 标题\n\n正文\n".as_bytes(), "md")
            .await
            .expect("抽取");
        assert_eq!(doc.meta.source, "docs/a.md");
        assert_eq!(doc.blocks.len(), 2);
        assert!(doc.text().contains("正文"));
    }

    #[tokio::test]
    async fn pdf_and_epub_are_picked_but_legacy_office_is_not() {
        let registry = default_registry();
        let (extractor, _) = registry.pick(b"%PDF-1.7", "pdf").expect("PDF 应能挑到");
        assert_eq!(extractor.id(), "application/pdf");
        let (extractor, _) = registry
            .pick(b"PK\x03\x04mimetype application/epub+zip", "epub")
            .expect("EPUB 应能挑到");
        assert_eq!(extractor.id(), "application/epub+zip");
        // 旧版 Office(复合文档)还没有抽取器 → 上层隔离
        let detected = detect(&[0xd0, 0xcf, 0x11, 0xe0], "doc");
        assert_eq!(detected.kind, Kind::LegacyOffice);
        assert!(registry.pick(&[0xd0, 0xcf, 0x11, 0xe0], "doc").is_none());
        let source = SourceRef {
            scheme: "file".to_owned(),
            location: "a.doc".to_owned(),
            project_root: None,
        };
        let error = registry
            .extract(&source, &[0xd0, 0xcf, 0x11, 0xe0], "doc")
            .await
            .expect_err("应报没有抽取器");
        assert!(matches!(error, KbError::Unavailable(_)), "{error}");
    }

    #[test]
    fn registered_ids_are_listed() {
        let registry = default_registry();
        let ids = registry.ids();
        assert!(ids.contains(&"text/markdown"));
        assert!(ids.contains(&"text/plain"));
        assert!(ids.contains(&"text/x-code"));
    }

    /// 可控的假抽取器:故意只实现 `detect`,用来钉住挑选规则。
    struct FakeExtractor {
        id: &'static str,
        mark: Confidence,
    }

    #[async_trait::async_trait]
    impl Extractor for FakeExtractor {
        fn id(&self) -> &str {
            self.id
        }

        fn detect(&self, _head: &[u8], _ext: &str) -> Confidence {
            self.mark
        }

        async fn extract(&self, _source: &SourceRef, _bytes: &[u8]) -> Result<Doc> {
            Err(KbError::Unavailable("假抽取器不真抽".to_owned()))
        }
    }

    fn fake(id: &'static str, mark: Confidence) -> Arc<dyn Extractor> {
        Arc::new(FakeExtractor { id, mark })
    }

    /// 内置层平手时**先**注册的胜:这条保证了“具体格式在前、兜底在后”的既有顺序不被改写。
    /// 反例:`html` 同时被 `HtmlExtractor` 与 `CodeExtractor` 认领,平手时必须还是 HTML。
    #[test]
    fn builtin_tie_keeps_the_earlier_registration() {
        let mut registry = ExtractorRegistry::new();
        registry.register(fake("specific-first", Confidence::Probable));
        registry.register(fake("generic-later", Confidence::Probable));

        let (extractor, _) = registry.pick(b"", "md").expect("应能挑到");
        assert_eq!(extractor.id(), "specific-first");
    }

    /// 覆盖层平手时**后**注册的胜:同一次运行里装了新版插件,应该盖掉旧版。
    #[test]
    fn override_tie_keeps_the_later_registration() {
        let mut registry = ExtractorRegistry::new();
        registry.register_override(fake("plugin-v1", Confidence::Probable));
        registry.register_override(fake("plugin-v2", Confidence::Probable));

        let (extractor, _) = registry.pick(b"", "md").expect("应能挑到");
        assert_eq!(extractor.id(), "plugin-v2");
    }

    /// 覆盖层压过内置层 —— 这是“插件覆盖内置实现”唯一依赖的那一条规则。
    /// 以前 `pick` 写的是 `>=`,平手判给先注册的,于是插件与内置同为 `Probable` 时永远是内置赢,
    /// 与 `register` 上那句“后注册的优先”相反。
    #[test]
    fn an_override_wins_a_tie_against_a_builtin() {
        let mut registry = ExtractorRegistry::new();
        registry.register(fake("built-in", Confidence::Probable));
        registry.register_override(fake("plugin", Confidence::Probable));

        let (extractor, _) = registry.pick(b"", "md").expect("应能挑到");
        assert_eq!(extractor.id(), "plugin");
    }

    /// 但“把握大者优先”仍然压过层级:魔数命中(`Certain`)的内置实现不会被扩展名命中的覆盖层顶掉。
    #[test]
    fn a_certain_builtin_still_beats_a_probable_override() {
        let mut registry = ExtractorRegistry::new();
        registry.register(fake("built-in-by-magic", Confidence::Certain));
        registry.register_override(fake("plugin-by-extension", Confidence::Probable));

        let (extractor, confidence) = registry.pick(b"", "md").expect("应能挑到");
        assert_eq!(extractor.id(), "built-in-by-magic");
        assert_eq!(confidence, Confidence::Certain);
    }

    /// 进程级注册表:同一份快照,注册进去的覆盖实现在**后面**的 `global` 里也看得见
    /// (这是“插件注入点”的前提)。假货用 `Unlikely`,`pick` 不会选它,不影响其它用例。
    #[test]
    fn global_registry_is_one_snapshot_and_accepts_later_registrations() {
        let before = crate::registry::global().ids().len();
        assert_eq!(crate::registry::global().ids().len(), before);

        crate::registry::register_global(fake("test/fake-injected", Confidence::Unlikely));

        let after = crate::registry::global();
        assert_eq!(after.ids().len(), before + 1);
        assert!(after.ids().contains(&"test/fake-injected"));
        // 把握不够(Unlikely)= 不参与挑选。
        assert!(
            after
                .pick(b"", "md")
                .is_some_and(|(item, _)| item.id() != "test/fake-injected")
        );
    }
}
