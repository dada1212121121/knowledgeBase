//! Markdown 文档的体积上限放宽。
//!
//! 背景:`max_file_bytes`(默认 200KB)原先对所有文本文件一视同仁,生产上 584KB 的
//! `ARCHITECTURE.md` 等设计文档因此被记成 `too_large`、搜不到。现在 Markdown(`.md` / `.mdx`)
//! 的上限取 `max(max_file_bytes, TEXT_DOC_MAX_BYTES)`(2 MiB),代码文件与 `.txt` 不变。
//!
//! 这里全部在临时目录里真实写文件、走 `scan`,证明放宽后:
//! - 该放行的放行、该跳的仍跳;
//! - 200KB~2MiB 的文档仍会被读头,二进制 / 生成代码判定没有被绕过。

use std::path::Path;

use kb_core::config::{Config, RICH_DOC_MAX_BYTES, TEXT_DOC_MAX_BYTES};
use kb_core::model::{ScanOutcome, ScanRequest};
use kb_index::filter::{FileFilter, PLUGIN_BINARY_MAX_BYTES, SkipReason};
use kb_index::lang::{FileKind, kind_of};
use kb_index::scan::scan;

const KB: usize = 1024;
const MIB: usize = 1024 * 1024;

/// 默认配置的 `max_file_bytes`(200KB),测试里直接用生产默认值。
fn default_limit() -> u64 {
    Config::default().index.max_file_bytes
}

/// 造一段恰好 `len` 字节的正常文本:多行、含中文、不含 NUL,也不含生成代码标记。
fn text_of_len(len: usize) -> Vec<u8> {
    let line = "# 小节\n这是一行普通的说明文字,用来凑够文件体积。\n";
    let mut text = String::with_capacity(len + line.len());
    while text.len() < len {
        text.push_str(line);
    }
    // 截断点不能落在汉字中间,否则不是合法 UTF-8;不够的部分用 ASCII 空格补齐
    let mut cut = len;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    let mut bytes = text.into_bytes();
    bytes.resize(len, b' ');
    bytes
}

fn write(root: &Path, relative: &str, content: &[u8]) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

fn request(root: &Path, max_file_bytes: u64) -> ScanRequest {
    ScanRequest {
        root: root.to_path_buf(),
        include: Vec::new(),
        exclude: Vec::new(),
        max_file_bytes,
        legacy_office: false,
        allow_binary: Vec::new(),
    }
}

fn kept(outcome: &ScanOutcome, relative: &str) -> bool {
    outcome.files.iter().any(|file| file.relative == relative)
}

fn skip_reason(outcome: &ScanOutcome, relative: &str) -> Option<SkipReason> {
    outcome
        .skipped
        .iter()
        .find(|entry| entry.relative == relative)
        .map(|entry| entry.reason)
}

/// 断言某个文件被放行:在 `files` 里,不在 `skipped` 里。
fn assert_kept(outcome: &ScanOutcome, relative: &str) {
    assert!(
        kept(outcome, relative),
        "{relative} 应当被放行,实际跳过原因: {:?}",
        skip_reason(outcome, relative)
    );
    assert_eq!(skip_reason(outcome, relative), None, "{relative}");
}

/// 断言某个文件被跳过,且原因正确。
fn assert_skipped(outcome: &ScanOutcome, relative: &str, reason: SkipReason) {
    assert!(!kept(outcome, relative), "{relative} 不应被放行");
    assert_eq!(skip_reason(outcome, relative), Some(reason), "{relative}");
}

#[test]
fn markdown_of_300kb_is_kept_under_default_limit() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    write(root, "ARCHITECTURE.md", &text_of_len(300 * KB));

    let outcome = scan(&request(root, default_limit())).expect("扫描");

    assert_kept(&outcome, "ARCHITECTURE.md");
    let entry = outcome
        .files
        .iter()
        .find(|file| file.relative == "ARCHITECTURE.md")
        .expect("放行的文件");
    assert_eq!(entry.size, (300 * KB) as u64);
    assert_eq!(entry.lang, "markdown");
    assert_eq!(entry.kind, FileKind::Doc);
}

#[test]
fn markdown_variants_share_the_relaxed_limit() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    write(root, "a.mdx", &text_of_len(300 * KB));
    // 扩展名不区分大小写,和 detect_lang / kind_of 一致
    write(root, "B.MD", &text_of_len(300 * KB));

    let outcome = scan(&request(root, default_limit())).expect("扫描");

    assert_kept(&outcome, "a.mdx");
    assert_kept(&outcome, "B.MD");
}

#[test]
fn markdown_of_3mib_is_still_too_large() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    write(root, "huge.md", &text_of_len(3 * MIB));

    let outcome = scan(&request(root, default_limit())).expect("扫描");

    assert_skipped(&outcome, "huge.md", SkipReason::TooLarge);
}

#[test]
fn markdown_limit_is_exactly_text_doc_max_bytes() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    write(root, "edge.md", &text_of_len(TEXT_DOC_MAX_BYTES as usize));
    write(
        root,
        "over.md",
        &text_of_len(TEXT_DOC_MAX_BYTES as usize + 1),
    );

    let outcome = scan(&request(root, default_limit())).expect("扫描");

    assert_eq!(TEXT_DOC_MAX_BYTES, 2 * 1024 * 1024, "上限就是 2 MiB");
    assert_kept(&outcome, "edge.md");
    assert_skipped(&outcome, "over.md", SkipReason::TooLarge);
}

#[test]
fn code_and_data_files_keep_the_max_file_bytes_limit() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    write(root, "src/big.rs", &text_of_len(300 * KB));
    write(root, "data/big.json", &text_of_len(300 * KB));
    write(root, "src/small.rs", &text_of_len(10 * KB));

    let outcome = scan(&request(root, default_limit())).expect("扫描");

    assert_skipped(&outcome, "src/big.rs", SkipReason::TooLarge);
    assert_skipped(&outcome, "data/big.json", SkipReason::TooLarge);
    assert_kept(&outcome, "src/small.rs");
}

/// `.txt` 虽然在 `DOC_EXTENSIONS` 里(排序时算文档),但**不放宽**:
/// 它走行窗口分块、2 MiB 会出 3000 多块,而且常是分词词典 / 导出数据(生产上 4.9MB 的 `dict.txt`);
/// 同时已有的 `filter.rs` / `scan.rs` / `scan_fixture.rs` 测试都把 `.txt` 当成「超过上限要跳过」的样例。
/// `.rst` 同理(也是行窗口分块)。
#[test]
fn txt_and_rst_are_not_relaxed() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    write(root, "notes.txt", &text_of_len(300 * KB));
    write(root, "guide.rst", &text_of_len(300 * KB));
    write(root, "small.txt", &text_of_len(10 * KB));

    let outcome = scan(&request(root, default_limit())).expect("扫描");

    assert_skipped(&outcome, "notes.txt", SkipReason::TooLarge);
    assert_skipped(&outcome, "guide.rst", SkipReason::TooLarge);
    assert_kept(&outcome, "small.txt");
    // 它们仍是「文档」类,只是不享受放宽
    assert_eq!(kind_of(Path::new("notes.txt")), FileKind::Doc);
}

#[test]
fn markdown_with_nul_in_first_8kb_is_binary_not_kept() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    let mut content = text_of_len(300 * KB);
    // NUL 落在前 8KB 以内:放宽上限后,这份 300KB 的文档仍必须被读头并判成二进制
    content[100] = 0;
    write(root, "broken.md", &content);

    let outcome = scan(&request(root, default_limit())).expect("扫描");

    assert_skipped(&outcome, "broken.md", SkipReason::Binary);
}

#[test]
fn markdown_with_generated_marker_is_generated_not_kept() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    let mut at_generated = b"<!-- @generated by tool -->\n".to_vec();
    at_generated.extend(text_of_len(300 * KB));
    write(root, "api.md", &at_generated);
    let mut do_not_edit = "<!-- DO NOT EDIT: 由脚本生成 -->\n".as_bytes().to_vec();
    do_not_edit.extend(text_of_len(500 * KB));
    write(root, "refs.md", &do_not_edit);

    let outcome = scan(&request(root, default_limit())).expect("扫描");

    assert_skipped(&outcome, "api.md", SkipReason::Generated);
    assert_skipped(&outcome, "refs.md", SkipReason::Generated);
}

#[test]
fn larger_max_file_bytes_is_never_tightened() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    write(root, "big.md", &text_of_len(3 * MIB));
    write(root, "huger.md", &text_of_len(5 * MIB));
    write(root, "src/big.rs", &text_of_len(3 * MIB));

    // 用户把上限调到 4MiB:Markdown 取大者(4MiB),不会被收紧回 2MiB
    let outcome = scan(&request(root, 4 * MIB as u64)).expect("扫描");

    assert_kept(&outcome, "big.md");
    assert_skipped(&outcome, "huger.md", SkipReason::TooLarge);
    // 代码文件就是 4MiB 这个上限
    assert_kept(&outcome, "src/big.rs");
}

#[test]
fn exclude_rules_still_win_over_the_relaxed_limit() {
    let dir = tempfile::tempdir().expect("临时目录");
    let root = dir.path();
    write(root, "docs/secret.md", &text_of_len(300 * KB));
    write(root, "docs/new.md", &text_of_len(300 * KB));
    let mut req = request(root, default_limit());
    req.exclude = vec!["**/secret.md".to_owned()];

    let outcome = scan(&req).expect("扫描");

    // 排除规则排在大小判定之前:放宽大小上限不会把被排除的文件放回来
    assert_skipped(&outcome, "docs/secret.md", SkipReason::Excluded);
    assert_kept(&outcome, "docs/new.md");
}

/// `size_limit_for` 是 `check` 与扫描读头共用的唯一口径:逐类断言,
/// 并确认办公文档 / 插件二进制的上限没有被这次改动碰到。
#[test]
fn size_limit_for_covers_every_file_class() {
    let root = Path::new("/repo");
    let filter = FileFilter::new(root, 100, &[]).expect("构造");
    let limit = |name: &str| filter.size_limit_for(&root.join(name));

    // Markdown:放宽到 2 MiB
    assert_eq!(limit("a.md"), TEXT_DOC_MAX_BYTES);
    assert_eq!(limit("docs/B.MDX"), TEXT_DOC_MAX_BYTES);
    // 代码 / 配置 / .txt / .rst:仍是 max_file_bytes
    for name in ["a.rs", "a.json", "a.yaml", "a.txt", "a.rst", "Makefile"] {
        assert_eq!(limit(name), 100, "{name}");
    }
    // 办公文档:64MB 不变
    for name in [
        "a.pdf", "a.docx", "a.xlsx", "a.pptx", "a.odt", "a.rtf", "a.epub",
    ] {
        assert_eq!(limit(name), RICH_DOC_MAX_BYTES, "{name}");
    }
    // 旧格式 Office:没装转换器时当普通文件(100),装了才是 64MB
    assert_eq!(limit("old.doc"), 100);
    let with_converter = FileFilter::new(root, 100, &[])
        .expect("构造")
        .with_legacy_office(true);
    assert_eq!(
        with_converter.size_limit_for(&root.join("old.doc")),
        RICH_DOC_MAX_BYTES
    );
    // 插件认领的二进制:16MB 不变;没被认领的文件不受影响
    let with_plugin = FileFilter::new(root, 100, &[])
        .expect("构造")
        .with_allow_binary(root, &["**/*.blob".to_owned()])
        .expect("白名单");
    assert_eq!(
        with_plugin.size_limit_for(&root.join("x.blob")),
        PLUGIN_BINARY_MAX_BYTES
    );
    assert_eq!(with_plugin.size_limit_for(&root.join("x.bin")), 100);

    // 配置值比专用上限还大时,一律取大者
    let roomy = FileFilter::new(root, RICH_DOC_MAX_BYTES * 2, &[]).expect("构造");
    for name in ["a.md", "a.pdf", "a.rs"] {
        assert_eq!(
            roomy.size_limit_for(&root.join(name)),
            RICH_DOC_MAX_BYTES * 2,
            "{name}"
        );
    }
}

/// 直接走 `check`:300KB 的文档头部干净才放行;超过有效上限一个字节就是 TooLarge。
#[test]
fn check_applies_head_rules_to_relaxed_documents() {
    let root = Path::new("/repo");
    let filter = FileFilter::new(root, default_limit(), &[]).expect("构造");
    let path = root.join("docs/plan.md");
    let size = 300 * KB as u64;

    assert_eq!(filter.check(&path, size, b"# plan\n"), None);
    assert_eq!(
        filter.check(&path, size, b"# plan\0\n"),
        Some(SkipReason::Binary)
    );
    assert_eq!(
        filter.check(&path, size, b"<!-- @generated -->\n"),
        Some(SkipReason::Generated)
    );
    assert_eq!(
        filter.check(&path, TEXT_DOC_MAX_BYTES + 1, b"# plan\n"),
        Some(SkipReason::TooLarge)
    );
    // 代码文件同样大小仍然 TooLarge
    assert_eq!(
        filter.check(&root.join("src/lib.rs"), size, b"fn main() {}\n"),
        Some(SkipReason::TooLarge)
    );
}
