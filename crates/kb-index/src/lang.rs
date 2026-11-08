//! 按扩展名识别语言与文件种类（设计规范）。

use std::path::Path;

pub use kb_core::model::FileKind;

/// 文档类扩展名(设计规范的排序规则用)。
pub const DOC_EXTENSIONS: [&str; 4] = ["md", "mdx", "rst", "txt"];

/// 需要先经抽取器(`kb-extract`)才能读出文字的办公 / 电子书文档扩展名。
///
/// 它们是二进制容器(zip / PDF),按"前 8KB 含 NUL 就是二进制"的规则会被整个跳过,
/// 项目里的操作手册、报表、周报因此一直搜不到;这些格式改走抽取 → 文档分块的链路。
/// 旧版 `.doc` / `.xls` / `.ppt` 抽取器不支持,不在这里,仍按二进制跳过。
pub const RICH_DOC_EXTENSIONS: [&str; 7] = ["pdf", "docx", "pptx", "xlsx", "odt", "rtf", "epub"];

/// 旧格式 Office 扩展名:没有抽取器,装了转换器(LibreOffice)才能读。只列有真实样本验证过转换质量、
/// 且本身没有抽取器的三种;`odt` / `rtf` 已有抽取器,`ppt` / `odp` / `wps` / `et` / `dps` 没有样本验证过。
pub const LEGACY_OFFICE_EXTENSIONS: [&str; 3] = ["doc", "xls", "ods"];

/// 路径是不是需要转换器才能读的旧格式 Office 文档。
pub fn is_legacy_office(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .is_some_and(|ext| LEGACY_OFFICE_EXTENSIONS.contains(&ext.as_str()))
}

/// 路径是不是需要抽取器的办公 / 电子书文档。
pub fn is_rich_doc(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .is_some_and(|ext| RICH_DOC_EXTENSIONS.contains(&ext.as_str()))
}

/// 按扩展名识别语言;未知扩展名返回 `text`。
pub fn detect_lang(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    match extension.as_deref() {
        Some("rs") => "rust",
        Some("py" | "pyi") => "python",
        Some("js" | "mjs" | "cjs" | "jsx") => "javascript",
        Some("tsx") => "tsx",
        Some("ts" | "mts" | "cts") => "typescript",
        Some("go") => "go",
        Some("java") => "java",
        Some("c" | "h") => "c",
        Some("cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx") => "cpp",
        // :新增四种语言的 tree-sitter 分块
        Some("sh" | "bash" | "zsh") => "bash",
        Some("rb" | "rake" | "gemspec") => "ruby",
        Some("php" | "phtml") => "php",
        Some("swift") => "swift",
        Some("md" | "mdx") => "markdown",
        Some(
            "rst" | "txt" | "toml" | "yaml" | "yml" | "json" | "sql" | "ini" | "conf" | "cfg"
            | "csv" | "html" | "css",
        ) => "text",
        _ => "text",
    }
}

/// 按扩展名判断文件种类(文档 / 代码)。
pub fn kind_of(path: &Path) -> FileKind {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    match extension.as_deref() {
        Some(ext)
            if DOC_EXTENSIONS.contains(&ext)
                || RICH_DOC_EXTENSIONS.contains(&ext)
                || LEGACY_OFFICE_EXTENSIONS.contains(&ext) =>
        {
            FileKind::Doc
        }
        _ => FileKind::Code,
    }
}

/// 语言名是否属于文档类(markdown 或纯文本)。
pub fn is_doc_lang(lang: &str) -> bool {
    matches!(lang, "markdown" | "text")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn lang(name: &str) -> &'static str {
        detect_lang(&PathBuf::from(name))
    }

    #[test]
    fn detects_code_languages() {
        assert_eq!(lang("src/main.rs"), "rust");
        assert_eq!(lang("app.py"), "python");
        assert_eq!(lang("index.js"), "javascript");
        assert_eq!(lang("component.tsx"), "tsx");
        assert_eq!(lang("main.go"), "go");
        assert_eq!(lang("Main.java"), "java");
        assert_eq!(lang("lib.c"), "c");
        assert_eq!(lang("lib.hpp"), "cpp");
        // :新增四种
        assert_eq!(lang("deploy.sh"), "bash");
        assert_eq!(lang("tools/rake.rb"), "ruby");
        assert_eq!(lang("index.php"), "php");
        assert_eq!(lang("App.swift"), "swift");
        // 没有 tree-sitter 语法的语言仍然走窗口分块(识别为 text)
        assert_eq!(lang("Main.kt"), "text");
    }

    #[test]
    fn detects_docs_and_text() {
        assert_eq!(lang("README.md"), "markdown");
        assert_eq!(lang("guide.mdx"), "markdown");
        assert_eq!(lang("notes.txt"), "text");
        assert_eq!(lang("config.toml"), "text");
        assert_eq!(lang("unknown.zzz"), "text");
        assert_eq!(lang("Makefile"), "text");
    }

    #[test]
    fn legacy_office_is_recognised_separately_from_rich_documents() {
        for name in ["old.doc", "OLD.XLS", "sheet.ods"] {
            assert!(is_legacy_office(&PathBuf::from(name)), "{name}");
            assert!(
                !is_rich_doc(&PathBuf::from(name)),
                "{name}:不是有抽取器的格式"
            );
            assert_eq!(kind_of(&PathBuf::from(name)), FileKind::Doc, "{name}");
        }
        // 有抽取器的、没验证过转换质量的、普通文件都不算
        for name in [
            "a.docx", "b.odt", "c.rtf", "d.ppt", "e.odp", "f.wps", "g.md", "doc",
        ] {
            assert!(!is_legacy_office(&PathBuf::from(name)), "{name}");
        }
    }

    #[test]
    fn rich_documents_are_recognised_and_count_as_docs() {
        for name in [
            "a.pdf", "b.DOCX", "c.pptx", "d.xlsx", "e.odt", "f.rtf", "g.epub",
        ] {
            assert!(is_rich_doc(&PathBuf::from(name)), "{name}");
            assert_eq!(kind_of(&PathBuf::from(name)), FileKind::Doc, "{name}");
        }
        // 旧版 Office、纯文本、没有扩展名的都不算
        for name in [
            "old.doc",
            "old.xls",
            "old.ppt",
            "a.md",
            "notes.txt",
            "noext",
        ] {
            assert!(!is_rich_doc(&PathBuf::from(name)), "{name}");
        }
    }

    #[test]
    fn extension_matching_is_case_insensitive() {
        assert_eq!(lang("MAIN.RS"), "rust");
        assert_eq!(lang("Doc.MD"), "markdown");
    }

    #[test]
    fn doc_kind_covers_the_four_documented_extensions() {
        for name in ["a.md", "b.mdx", "c.rst", "d.txt"] {
            assert_eq!(kind_of(&PathBuf::from(name)), FileKind::Doc, "{name}");
        }
        for name in ["a.rs", "b.toml", "c.json", "noext"] {
            assert_eq!(kind_of(&PathBuf::from(name)), FileKind::Code, "{name}");
        }
        assert!(is_doc_lang("markdown"));
        assert!(is_doc_lang("text"));
        assert!(!is_doc_lang("rust"));
    }
}
