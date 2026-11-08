//! 文件过滤规则（设计规范）。
//!
//! 跳过条件:命中排除 glob、超过大小上限(默认 `max_file_bytes`;办公文档、Markdown 文档、插件认领的
//! 二进制各有自己的上限,见 [`FileFilter::size_limit_for`])、前 8KB 含 NUL 字节(二进制)、
//! 前 5 行含 `@generated` 或 `DO NOT EDIT`(生成代码)。`.gitignore` 由遍历器负责。

use std::path::Path;

use ignore::Match;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::overrides::{Override, OverrideBuilder};
use kb_core::{KbError, Result};

pub use kb_core::model::SkipReason;

/// 读取文件头部时最多看多少字节。
pub const HEAD_BYTES: usize = 8192;
/// 判断“生成代码”时最多看多少行。
pub const GENERATED_LINES: usize = 5;
/// 插件 extract 认领的二进制文件大小上限。
///
/// 宿主请求上限是 32 MB,base64 后膨胀约 1/3;这里留到 16 MB 原文件,既够常见二进制格式,
/// 又不会让一次请求超过宿主上限。超过这个大小仍按 `TooLarge` 跳过。
pub const PLUGIN_BINARY_MAX_BYTES: u64 = 16 * 1024 * 1024;
/// PDF / Office 等办公文档的大小上限(64 MB,与预览页内联读取的上限一致;常量本体在 `kb_core::config`,指南也要用)。
///
/// 这类文件天然比源码大得多(带图的操作手册动辄几 MB),沿用 `max_file_bytes`(默认 200KB)
/// 会把它们全部挡掉;但抽取要把整份文件读进内存,所以仍要有个硬上限,防止误放进来的巨型文件拖垮守护进程。
pub use kb_core::config::RICH_DOC_MAX_BYTES;
/// Markdown 文档的大小上限(2 MiB,常量本体在 `kb_core::config`,写法同 [`RICH_DOC_MAX_BYTES`])。
pub use kb_core::config::TEXT_DOC_MAX_BYTES;

/// 放宽到 [`TEXT_DOC_MAX_BYTES`] 的纯文本文档扩展名。
///
/// 只放 Markdown(`md` / `mdx`),不是 `DOC_EXTENSIONS` 的全集:
/// - Markdown 按标题分块,把真实的架构设计说明拼到 2 MiB 实测约 1560 块(原文 584KB 是 446 块);
///   `txt` / `rst` 走行窗口分块,两种 2 MiB 的合成样本(词典式短行、中文长行)实测都是 3000 多块,
///   而且 `.txt` 里常放分词词典、导出数据这类不是写给人读的大文件,放宽只会把它们灌进索引;
/// - 已有测试把 `.txt` 当作「超过 `max_file_bytes` 就要跳过」的样例,放宽 `.txt` 会改变它们的含义。
///
/// 要放宽别的扩展名,在这里加一项即可(`size_limit_for` 与扫描读头共用这一处判断)。
const LONG_TEXT_DOC_EXTENSIONS: [&str; 2] = ["md", "mdx"];

/// 路径是不是享受 [`TEXT_DOC_MAX_BYTES`] 的纯文本文档(扩展名不区分大小写)。
fn is_long_text_doc(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .is_some_and(|ext| LONG_TEXT_DOC_EXTENSIONS.contains(&ext.as_str()))
}

/// 文件头部的判定结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeadInfo {
    /// 是否二进制。
    pub is_binary: bool,
    /// 是否生成代码。
    pub is_generated: bool,
}

/// 检查文件头部:二进制与生成代码。
pub fn inspect_head(head: &[u8]) -> HeadInfo {
    let is_binary = head.contains(&0);
    let is_generated = if is_binary {
        false
    } else {
        let text = String::from_utf8_lossy(head);
        text.lines().take(GENERATED_LINES).any(is_generated_line)
    };
    HeadInfo {
        is_binary,
        is_generated,
    }
}

/// 判断一行是否是“生成代码”标记(设计规范:前 5 行含 `@generated` 或 `DO NOT EDIT`)。
///
/// `@generated` / `code generated` 不区分大小写;`DO NOT EDIT` 只认大写,
/// 这样普通句子里的 "please do not edit this value" 不会被误判。
fn is_generated_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    if lower.contains("@generated") || lower.contains("code generated") {
        return true;
    }
    line.contains("DO NOT EDIT")
}

/// 排除规则(基于 gitignore 语法的 glob)。
pub struct FileFilter {
    max_file_bytes: u64,
    excludes: Option<Gitignore>,
    /// 旧格式 Office(`.doc` / `.xls` / `.ods`)按办公文档放行(装了转换器时才打开)。
    legacy_office: bool,
    /// 插件 extract 认领的二进制文件(白名单语义:命中 = 放行)。
    allow_binary: Option<Override>,
}

impl FileFilter {
    /// 用排除 glob 构造;`patterns` 为空时不排除任何文件。
    pub fn new(root: &Path, max_file_bytes: u64, patterns: &[String]) -> Result<Self> {
        let excludes = build_ignore(root, patterns)?;
        Ok(Self {
            max_file_bytes,
            excludes,
            legacy_office: false,
            allow_binary: None,
        })
    }

    /// 旧格式 Office 是否放行。装了转换器时打开:这些文件是二进制容器,不放行就会被当成二进制跳过;
    /// 放行后能不能读出文字交给索引时的转换 + 抽取判断。
    pub fn with_legacy_office(mut self, enabled: bool) -> Self {
        self.legacy_office = enabled;
        self
    }

    /// 放行插件 extract 声明的二进制路径。空列表等于不额外放行。
    pub fn with_allow_binary(mut self, root: &Path, patterns: &[String]) -> Result<Self> {
        self.allow_binary = build_whitelist(root, patterns)?;
        Ok(self)
    }

    /// 用已经构造好的匹配器建立过滤器(扫描时给目录剪枝复用)。
    pub fn from_matcher(matcher: Option<Gitignore>, max_file_bytes: u64) -> Self {
        Self {
            max_file_bytes,
            excludes: matcher,
            legacy_office: false,
            allow_binary: None,
        }
    }

    /// 目录是否应该整体跳过(命中排除规则)。
    ///
    /// `**/node_modules/**` 这类模式只匹配目录**里面**的内容,不匹配目录本身,
    /// 所以除了按目录匹配,再用一个探针子路径试一次:命中就说明整个目录都可以剪掉。
    pub fn is_excluded(&self, path: &Path, is_dir: bool) -> bool {
        let Some(matcher) = &self.excludes else {
            return false;
        };
        if matches!(matcher.matched(path, is_dir), Match::Ignore(_)) {
            return true;
        }
        is_dir
            && matches!(
                matcher.matched(path.join("__kb_probe__"), false),
                Match::Ignore(_)
            )
    }

    /// 该路径是不是被插件认领的二进制文件(白名单语义:命中 = 放行)。
    fn is_binary_allowed(&self, path: &Path) -> bool {
        self.allow_binary
            .as_ref()
            .is_some_and(|matcher| matches!(matcher.matched(path, false), Match::Whitelist(_)))
    }

    /// 这个文件的有效大小上限(字节):`size` 超过它就是 [`SkipReason::TooLarge`]。
    ///
    /// 判定顺序与 [`Self::check`] 一致,而且**只有这一处**算上限:`check` 用它判 `TooLarge`,
    /// 扫描器用它决定「要不要读文件头做二进制 / 生成代码判定」。两边各算一遍迟早会不一致——
    /// 上限放宽了、读头的门槛没跟着放宽,200KB 以上的文件就不会被读头,二进制和生成代码的检查等于被绕过。
    ///
    /// - 办公文档(含装了转换器时放行的旧格式 Office):`max(max_file_bytes, RICH_DOC_MAX_BYTES)`;
    /// - 插件认领的二进制:`max(max_file_bytes, PLUGIN_BINARY_MAX_BYTES)`;
    /// - Markdown 文档:`max(max_file_bytes, TEXT_DOC_MAX_BYTES)`;
    /// - 其余(代码、`.txt`、配置、数据文件):`max_file_bytes`。
    ///
    /// 一律取大者:用户把 `max_file_bytes` 调得比专用上限还大时,不会反过来收紧。
    pub fn size_limit_for(&self, path: &Path) -> u64 {
        if crate::lang::is_rich_doc(path)
            || (self.legacy_office && crate::lang::is_legacy_office(path))
        {
            self.max_file_bytes.max(RICH_DOC_MAX_BYTES)
        } else if self.is_binary_allowed(path) {
            self.max_file_bytes.max(PLUGIN_BINARY_MAX_BYTES)
        } else if is_long_text_doc(path) {
            self.max_file_bytes.max(TEXT_DOC_MAX_BYTES)
        } else {
            self.max_file_bytes
        }
    }

    /// 文件是否需要跳过;返回第一个命中的原因。
    pub fn check(&self, path: &Path, size: u64, head: &[u8]) -> Option<SkipReason> {
        if self.is_excluded(path, false) {
            return Some(SkipReason::Excluded);
        }
        let limit = self.size_limit_for(path);
        // 办公文档:是二进制容器,"含 NUL 即二进制"和 200KB 上限都不适用,
        // 能不能读出文字交给抽取器判断(读不出会在索引时记成"跳过"并写明原因)
        if crate::lang::is_rich_doc(path)
            || (self.legacy_office && crate::lang::is_legacy_office(path))
        {
            return (size > limit).then_some(SkipReason::TooLarge);
        }
        if size > limit {
            return Some(SkipReason::TooLarge);
        }
        // 插件认领的二进制文件可以突破普通 max_file_bytes(上限已在 size_limit_for 里放宽),
        // 但仍受插件请求上限约束。
        let binary_allowed = self.is_binary_allowed(path);
        let info = inspect_head(head);
        if info.is_binary && !binary_allowed {
            return Some(SkipReason::Binary);
        }
        if info.is_generated {
            return Some(SkipReason::Generated);
        }
        None
    }
}

/// 构造排除用的 glob 匹配器(gitignore 语义:命中 = 忽略)。
pub fn build_ignore(root: &Path, patterns: &[String]) -> Result<Option<Gitignore>> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut builder = GitignoreBuilder::new(root);
    for pattern in patterns {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            continue;
        }
        builder
            .add_line(None, pattern)
            .map_err(|err| KbError::InvalidInput(format!("非法的 glob {pattern:?}: {err}")))?;
    }
    let matcher = builder
        .build()
        .map_err(|err| KbError::InvalidInput(format!("构造 glob 匹配器失败: {err}")))?;
    Ok(Some(matcher))
}

/// 构造 include 用的白名单匹配器(`ignore::Override` 是白名单语义:命中 = 保留)。
pub fn build_whitelist(root: &Path, patterns: &[String]) -> Result<Option<Override>> {
    if patterns.is_empty() {
        return Ok(None);
    }
    let mut builder = OverrideBuilder::new(root);
    for pattern in patterns {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            continue;
        }
        builder
            .add(pattern)
            .map_err(|err| KbError::InvalidInput(format!("非法的 glob {pattern:?}: {err}")))?;
    }
    let overrides = builder
        .build()
        .map_err(|err| KbError::InvalidInput(format!("构造 glob 匹配器失败: {err}")))?;
    Ok(Some(overrides))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn plugin_allow_binary_bypasses_the_nul_filter() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        let path = base.join("sample.blob");
        std::fs::write(&path, b"a\0b").unwrap();
        let plain = FileFilter::new(base, 1024, &[]).unwrap();
        assert_eq!(
            plain.check(&path, 3, b"a\0b"),
            Some(SkipReason::Binary),
            "没人认领的二进制仍要跳过"
        );
        let allowed = FileFilter::new(base, 1024, &[])
            .unwrap()
            .with_allow_binary(base, &["**/*.blob".to_owned()])
            .unwrap();
        assert_eq!(allowed.check(&path, 3, b"a\0b"), None);
    }

    #[test]
    fn detects_binary_by_nul_byte() {
        assert!(inspect_head(b"abc\0def").is_binary);
        assert!(!inspect_head("中文 utf-8".as_bytes()).is_binary);
        assert!(!inspect_head(b"").is_binary);
    }

    #[test]
    fn detects_generated_markers_in_first_five_lines() {
        assert!(inspect_head(b"// @generated by protoc\nfn a() {}\n").is_generated);
        assert!(inspect_head(b"/* DO NOT EDIT */\n").is_generated);
        assert!(inspect_head(b"// DO NOT EDIT this file\n").is_generated);
        // 常见的生成器头
        assert!(inspect_head(b"// This file is auto-generated. DO NOT EDIT.\n").is_generated);
        assert!(inspect_head(b"# AUTO-GENERATED FILE, DO NOT EDIT\n").is_generated);
        assert!(inspect_head(b"<!-- DO NOT EDIT: generated -->\n").is_generated);
        assert!(inspect_head(b"// Code generated by protoc. DO NOT EDIT.\n").is_generated);
        // 普通句子里的 "do not edit"(小写)不算
        assert!(!inspect_head(b"let note = \"please do not edit this value\";\n").is_generated);
        assert!(!inspect_head(b"// you should not edit this\n").is_generated);
        assert!(!inspect_head(b"// do not edit this file\n").is_generated);
        // 第 6 行才出现不算
        let late = "1\n2\n3\n4\n5\n// @generated\n";
        assert!(!inspect_head(late.as_bytes()).is_generated);
        assert!(!inspect_head(b"fn main() {}\n").is_generated);
    }

    fn filter() -> FileFilter {
        FileFilter::new(
            &PathBuf::from("/repo"),
            100,
            &["**/node_modules/**".to_owned(), "**/*.lock".to_owned()],
        )
        .expect("构造过滤规则")
    }

    #[test]
    fn excluded_paths_and_dirs_are_reported() {
        let filter = filter();
        assert_eq!(
            filter.check(&PathBuf::from("/repo/node_modules/x.js"), 10, b"x"),
            Some(SkipReason::Excluded)
        );
        assert!(filter.is_excluded(&PathBuf::from("/repo/node_modules"), true));
        assert!(!filter.is_excluded(&PathBuf::from("/repo/src"), true));
        assert_eq!(
            filter.check(&PathBuf::from("/repo/Cargo.lock"), 10, b"x"),
            Some(SkipReason::Excluded)
        );
    }

    #[test]
    fn size_binary_and_generated_rules() {
        let filter = filter();
        assert_eq!(
            filter.check(&PathBuf::from("/repo/big.txt"), 101, b"x"),
            Some(SkipReason::TooLarge)
        );
        assert_eq!(
            filter.check(&PathBuf::from("/repo/a.bin"), 10, b"\0\0"),
            Some(SkipReason::Binary)
        );
        assert_eq!(
            filter.check(&PathBuf::from("/repo/gen.rs"), 10, b"// @generated\n"),
            Some(SkipReason::Generated)
        );
        assert_eq!(
            filter.check(&PathBuf::from("/repo/ok.rs"), 10, b"fn main"),
            None
        );
    }

    #[test]
    fn rich_documents_skip_the_binary_and_small_size_rules() {
        let filter = filter();
        // 带 NUL 的 zip 头、远大于 max_file_bytes(100):办公文档照样放行
        for name in [
            "a.docx", "b.PDF", "c.xlsx", "d.pptx", "e.odt", "f.rtf", "g.epub",
        ] {
            assert_eq!(
                filter.check(
                    &PathBuf::from("/repo").join(name),
                    5_000_000,
                    b"PK\x03\x04\0\0"
                ),
                None,
                "{name}"
            );
        }
        // 超过办公文档自己的上限仍然跳过
        assert_eq!(
            filter.check(
                &PathBuf::from("/repo/huge.pdf"),
                RICH_DOC_MAX_BYTES + 1,
                b""
            ),
            Some(SkipReason::TooLarge)
        );
        // 排除规则优先于放行
        let excluded = FileFilter::new(&PathBuf::from("/repo"), 100, &["**/archive/**".to_owned()])
            .expect("构造");
        assert_eq!(
            excluded.check(&PathBuf::from("/repo/archive/old.docx"), 10, b"PK\0"),
            Some(SkipReason::Excluded)
        );
        // 旧版二进制 Office 没装转换器时仍按二进制跳过
        assert_eq!(
            filter.check(&PathBuf::from("/repo/old.doc"), 10, b"\xd0\xcf\0\0"),
            Some(SkipReason::Binary)
        );
        // 配置的 max_file_bytes 比办公文档上限还大时取大者,不会反过来收紧
        let roomy =
            FileFilter::new(&PathBuf::from("/repo"), RICH_DOC_MAX_BYTES * 2, &[]).expect("构造");
        assert_eq!(
            roomy.check(&PathBuf::from("/repo/big.pdf"), RICH_DOC_MAX_BYTES + 1, b""),
            None
        );
    }

    /// 装了转换器(`with_legacy_office(true)`)时,有验证过的旧格式 Office 当办公文档放行;其余照旧。
    #[test]
    fn legacy_office_passes_only_when_the_converter_is_there() {
        let root = PathBuf::from("/repo");
        let off = FileFilter::new(&root, 100, &[]).expect("构造");
        let on = FileFilter::new(&root, 100, &[])
            .expect("构造")
            .with_legacy_office(true);
        let ole = b"\xd0\xcf\x11\xe0\0\0";
        for name in ["old.doc", "old.XLS", "sheet.ods"] {
            let path = root.join(name);
            assert_eq!(
                off.check(&path, 50, ole),
                Some(SkipReason::Binary),
                "{name}"
            );
            assert_eq!(on.check(&path, 50, ole), None, "{name}");
            // 5000 字节超过 100 的文本上限,但办公文档用自己的上限
            assert_eq!(
                off.check(&path, 5000, ole),
                Some(SkipReason::TooLarge),
                "{name}"
            );
            assert_eq!(on.check(&path, 5000, ole), None, "{name}");
        }
        // 没验证过转换质量的格式不放行
        for name in ["old.ppt", "old.odp", "old.wps", "old.et", "old.dps"] {
            assert_eq!(
                on.check(&root.join(name), 10, ole),
                Some(SkipReason::Binary),
                "{name}"
            );
        }
        // 大小上限和办公文档一样是 64 MB
        assert_eq!(
            on.check(&root.join("big.doc"), RICH_DOC_MAX_BYTES + 1, b""),
            Some(SkipReason::TooLarge)
        );
        // 排除规则优先
        let excluded = FileFilter::new(&root, 100, &["**/archive/**".to_owned()])
            .expect("构造")
            .with_legacy_office(true);
        assert_eq!(
            excluded.check(&root.join("archive/old.doc"), 10, ole),
            Some(SkipReason::Excluded)
        );
    }

    #[test]
    fn empty_patterns_never_exclude() {
        let filter = FileFilter::new(&PathBuf::from("/repo"), 10, &[]).expect("构造");
        assert_eq!(filter.check(&PathBuf::from("/repo/ok.rs"), 5, b"x"), None);
        assert!(!filter.is_excluded(&PathBuf::from("/repo/node_modules"), true));
    }

    #[test]
    fn include_patterns_whitelist() {
        let overrides = build_whitelist(&PathBuf::from("/repo"), &["src/**".to_owned()])
            .expect("构造")
            .expect("有模式");
        assert!(matches!(
            overrides.matched(PathBuf::from("/repo/src/a.rs"), false),
            Match::Whitelist(_)
        ));
        // 未命中白名单 = 忽略
        assert!(matches!(
            overrides.matched(PathBuf::from("/repo/docs/a.md"), false),
            Match::Ignore(_)
        ));
    }

    #[test]
    fn glob_builder_tolerates_unusual_patterns() {
        // `ignore` 的 glob 解析很宽容(例如未闭合的 `[` 被当成字面量),
        // 这里只保证不会 panic、且不影响正常匹配。
        let matcher = build_ignore(&PathBuf::from("/repo"), &["a[".to_owned()])
            .expect("构造")
            .expect("有模式");
        assert!(!matches!(
            matcher.matched(PathBuf::from("/repo/ok.rs"), false),
            Match::Ignore(_)
        ));
    }
}
