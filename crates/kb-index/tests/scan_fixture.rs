//! 用 `kb-testkit/fixtures/repo1` 验证扫描与过滤(验收)。

use std::path::PathBuf;

use kb_core::config::Config;
use kb_core::model::ScanRequest;
use kb_index::filter::SkipReason;
use kb_index::lang::FileKind;
use kb_index::scan::scan;

fn fixture_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../kb-testkit/fixtures/repo1")
}

fn options() -> ScanRequest {
    ScanRequest {
        root: fixture_root(),
        include: Vec::new(),
        exclude: Config::default().index.exclude,
        max_file_bytes: 1024,
        legacy_office: false,
        allow_binary: Vec::new(),
    }
}

#[test]
fn scan_fixture_repo_filters_gitignore_deps_binaries_generated_and_locks() {
    let result = scan(&options()).expect("扫描 fixture");
    let kept: Vec<&str> = result
        .files
        .iter()
        .map(|file| file.relative.as_str())
        .collect();

    // 保留:文档 + 8 种语言的源码 + README
    for expected in [
        "README.md",
        "docs/guide.md",
        "docs/readme.txt",
        "src/main.rs",
        "src/app.py",
        "src/app.js",
        "src/component.tsx",
        "src/main.go",
        "src/Main.java",
        "src/lib.c",
        "src/lib.cpp",
    ] {
        assert!(
            kept.contains(&expected),
            "{expected} 应该被保留;实际 {kept:?}"
        );
    }

    // 文档排在代码前面
    let first_code = kept
        .iter()
        .position(|path| {
            !path.ends_with(".md")
                && !path.ends_with(".mdx")
                && !path.ends_with(".rst")
                && !path.ends_with(".txt")
        })
        .expect("有代码文件");
    assert!(
        kept[..first_code]
            .iter()
            .all(|path| path.ends_with(".md") || path.ends_with(".txt")),
        "文档应排在代码之前:{kept:?}"
    );
    assert_eq!(result.files[0].kind, FileKind::Doc);

    // 被跳过的文件与原因
    let skipped: Vec<(&str, SkipReason)> = result
        .skipped
        .iter()
        .map(|file| (file.relative.as_str(), file.reason))
        .collect();
    for expected in [
        ("package-lock.json", SkipReason::Excluded),
        ("assets/logo.png", SkipReason::Binary),
        ("generated.rs", SkipReason::Generated),
        ("huge.txt", SkipReason::TooLarge),
    ] {
        assert!(
            skipped.contains(&expected),
            "应以 {:?} 跳过 {};实际 {skipped:?}",
            expected.1,
            expected.0
        );
    }

    // node_modules 整个目录被剪掉,.gitignore 命中的文件由遍历器直接忽略:
    // 它们既不在保留列表,也不在跳过列表
    for ignored in [
        "node_modules/pkg/index.js",
        "ignored.log",
        "ignored_dir/a.rs",
    ] {
        assert!(!kept.contains(&ignored), "{ignored} 不应被索引");
        assert!(
            !skipped.iter().any(|(path, _)| *path == ignored),
            "{ignored} 应由 .gitignore 直接忽略"
        );
    }
}

#[test]
fn scan_fixture_repo_languages_are_detected() {
    let result = scan(&options()).expect("扫描 fixture");
    let lang_of = |relative: &str| -> String {
        result
            .files
            .iter()
            .find(|file| file.relative == relative)
            .map(|file| file.lang.clone())
            .unwrap_or_else(|| panic!("{relative} 不在结果里"))
    };
    assert_eq!(lang_of("src/main.rs"), "rust");
    assert_eq!(lang_of("src/app.py"), "python");
    assert_eq!(lang_of("src/app.js"), "javascript");
    assert_eq!(lang_of("src/component.tsx"), "tsx");
    assert_eq!(lang_of("src/main.go"), "go");
    assert_eq!(lang_of("src/Main.java"), "java");
    assert_eq!(lang_of("src/lib.c"), "c");
    assert_eq!(lang_of("src/lib.cpp"), "cpp");
    assert_eq!(lang_of("README.md"), "markdown");
    assert_eq!(lang_of("docs/readme.txt"), "text");
}

/// 装了转换器时(`legacy_office`),项目里的旧格式 Office 进到扫描结果里;没装时仍记成二进制跳过。
#[test]
fn legacy_office_files_are_scanned_only_when_asked() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    std::fs::create_dir_all(root.join("docs")).expect("建目录");
    std::fs::write(root.join("docs/old.doc"), b"\xd0\xcf\x11\xe0\0\0 word").expect("写");
    std::fs::write(root.join("docs/old.ppt"), b"\xd0\xcf\x11\xe0\0\0 ppt").expect("写");
    std::fs::write(root.join("docs/notes.md"), b"# notes\n").expect("写");
    let request = |legacy_office| ScanRequest {
        root: root.to_path_buf(),
        include: Vec::new(),
        exclude: Vec::new(),
        max_file_bytes: 1024,
        legacy_office,
        allow_binary: Vec::new(),
    };
    let paths = |outcome: &kb_core::model::ScanOutcome| {
        outcome
            .files
            .iter()
            .map(|entry| entry.relative.clone())
            .collect::<Vec<_>>()
    };
    let skipped = |outcome: &kb_core::model::ScanOutcome| {
        outcome
            .skipped
            .iter()
            .map(|entry| entry.relative.clone())
            .collect::<Vec<_>>()
    };

    let off = scan(&request(false)).expect("扫描");
    assert_eq!(paths(&off), vec!["docs/notes.md"]);
    assert!(skipped(&off).contains(&"docs/old.doc".to_owned()));

    let on = scan(&request(true)).expect("扫描");
    let mut found = paths(&on);
    found.sort();
    assert_eq!(found, vec!["docs/notes.md", "docs/old.doc"], "{found:?}");
    assert!(
        skipped(&on).contains(&"docs/old.ppt".to_owned()),
        "没验证过的 ppt 仍跳过"
    );
}
