//! 二进制文件"上传新版本替换原件":版本历史、恢复、乐观锁、重新索引、备份去重。

use std::sync::Arc;

use kb_core::KbError;
use kb_core::ports::repo::{ChunkRepo, VersionRepo};
use kb_service::IndexService;
use kb_service::edit::{BINARY_MARK, FileEditService};
use kb_service::index::IndexOptions;
use kb_testkit::TestEnv;

const COLLECTION: &str = "_global";

struct Harness {
    env: TestEnv,
    edits: FileEditService,
}

impl Harness {
    async fn new() -> Self {
        let env = TestEnv::new().await;
        kb_service::CollectionService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
        )
        .ensure_global()
        .await
        .expect("建 _global");
        let index = Arc::new(IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            IndexOptions::default(),
        ));
        // 这一组测试看的是版本历史本身,不要被旧版本份数上限清掉(上限有自己的测试,见文件末尾)
        let edits =
            FileEditService::new(env.meta.clone(), index, env.paths()).with_keep_versions(50);
        Self { env, edits }
    }

    fn put(&self, rel: &str, bytes: &[u8]) -> std::path::PathBuf {
        let dir = self.env.paths().sources_dir().join("bin-test");
        std::fs::create_dir_all(&dir).expect("建目录");
        let path = dir.join(rel);
        std::fs::write(&path, bytes).expect("写");
        path
    }

    async fn texts(&self, rel: &str) -> String {
        let collection =
            kb_core::ports::repo::CollectionRepo::get(self.env.meta.as_ref(), COLLECTION)
                .await
                .unwrap()
                .unwrap();
        let ids: Vec<String> = ChunkRepo::by_path(self.env.meta.as_ref(), COLLECTION, rel)
            .await
            .unwrap()
            .into_iter()
            .map(|meta| meta.id)
            .collect();
        self.env
            .store
            .get(&collection.active_table, &ids)
            .await
            .unwrap()
            .into_iter()
            .map(|row| row.text)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn docx(text: &str) -> Vec<u8> {
    let document = format!(
        r#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>"#
    );
    kb_extract::zip::build_stored_zip(&[("word/document.xml", document.as_bytes())])
}

fn sha(bytes: &[u8]) -> String {
    kb_core::hash::sha256_hex_bytes(bytes)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn replacing_a_docx_keeps_the_original_as_version_one_and_reindexes() {
    let harness = Harness::new().await;
    let old = docx("旧版本的操作说明");
    let path = harness.put("手册.docx", &old);
    let new = docx("新版本的操作说明,增加了导出步骤");

    let result = harness
        .edits
        .replace_bytes(COLLECTION, "手册.docx", &new, Some(&sha(&old)), "alice")
        .await
        .expect("替换");
    assert!(!result.unchanged);
    assert_eq!(result.version, 2, "原来的内容记成基线 1,新内容是 2");
    assert_eq!(std::fs::read(&path).unwrap(), new, "原位置写成了新内容");
    assert!(result.chunks > 0, "办公文档按抽取器重新入库");
    assert!(harness.texts("手册.docx").await.contains("增加了导出步骤"));

    let versions =
        VersionRepo::list_by_source(harness.env.meta.as_ref(), COLLECTION, "手册.docx", 10)
            .await
            .unwrap();
    assert_eq!(versions.len(), 2);
    assert!(
        versions
            .iter()
            .all(|version| version.body.starts_with(BINARY_MARK)),
        "二进制版本只存备份标记"
    );
    assert_eq!(versions[1].author.as_deref(), Some("baseline"));
    assert_eq!(versions[0].author.as_deref(), Some("alice"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn restoring_a_binary_version_writes_the_old_bytes_back_as_a_new_version() {
    let harness = Harness::new().await;
    let old = docx("第一版");
    let path = harness.put("报告.docx", &old);
    harness
        .edits
        .replace_bytes(COLLECTION, "报告.docx", &docx("第二版"), None, "a")
        .await
        .unwrap();
    let baseline =
        VersionRepo::list_by_source(harness.env.meta.as_ref(), COLLECTION, "报告.docx", 10)
            .await
            .unwrap()
            .into_iter()
            .find(|version| version.version == 1)
            .unwrap();

    let restored = harness
        .edits
        .restore(&baseline.id, "bob")
        .await
        .expect("恢复");
    assert_eq!(restored.version, 3, "恢复也是新的一版");
    assert_eq!(std::fs::read(&path).unwrap(), old, "字节和第一版一模一样");
    assert!(harness.texts("报告.docx").await.contains("第一版"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_stale_sha_is_refused_and_nothing_changes() {
    let harness = Harness::new().await;
    let current = docx("现在的内容");
    let path = harness.put("表.docx", &current);
    let err = harness
        .edits
        .replace_bytes(
            COLLECTION,
            "表.docx",
            &docx("我的修改"),
            Some(&sha(b"opened earlier")),
            "a",
        )
        .await
        .expect_err("文件在打开后被换过");
    assert!(matches!(err, KbError::InvalidInput(_)), "{err}");
    assert_eq!(std::fs::read(&path).unwrap(), current);
    assert!(
        VersionRepo::list_by_source(harness.env.meta.as_ref(), COLLECTION, "表.docx", 10)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn identical_bytes_empty_files_and_huge_files_are_handled() {
    let harness = Harness::new().await;
    let same = docx("不变");
    harness.put("a.docx", &same);
    let unchanged = harness
        .edits
        .replace_bytes(COLLECTION, "a.docx", &same, None, "a")
        .await
        .unwrap();
    assert!(unchanged.unchanged);
    assert!(
        VersionRepo::list_by_source(harness.env.meta.as_ref(), COLLECTION, "a.docx", 10)
            .await
            .unwrap()
            .is_empty(),
        "内容没变不产生版本"
    );

    assert!(matches!(
        harness
            .edits
            .replace_bytes(COLLECTION, "a.docx", b"", None, "a")
            .await,
        Err(KbError::InvalidInput(_))
    ));
    let huge = vec![0u8; (kb_service::edit::MAX_REPLACE_BYTES + 1) as usize];
    assert!(matches!(
        harness
            .edits
            .replace_bytes(COLLECTION, "a.docx", &huge, None, "a")
            .await,
        Err(KbError::InvalidInput(_))
    ));
    assert!(matches!(
        harness
            .edits
            .replace_bytes(COLLECTION, "../escape.docx", &same, None, "a")
            .await,
        Err(KbError::InvalidInput(_)) | Err(KbError::NotFound(_))
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn backups_are_content_addressed_so_switching_back_and_forth_does_not_grow_storage() {
    let harness = Harness::new().await;
    let a = docx("内容 A");
    let b = docx("内容 B");
    harness.put("来回.docx", &a);
    for round in 0..4 {
        let next = if round % 2 == 0 { &b } else { &a };
        harness
            .edits
            .replace_bytes(COLLECTION, "来回.docx", next, None, "a")
            .await
            .unwrap();
    }
    let root = harness.env.paths().home().join("file-versions");
    let blobs: usize = std::fs::read_dir(&root)
        .unwrap()
        .flatten()
        .map(|dir| std::fs::read_dir(dir.path()).unwrap().count())
        .sum();
    assert_eq!(blobs, 2, "只有两种内容,只存两份");
    assert_eq!(
        VersionRepo::list_by_source(harness.env.meta.as_ref(), COLLECTION, "来回.docx", 20)
            .await
            .unwrap()
            .len(),
        5,
        "基线 + 4 次替换"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_missing_or_tampered_backup_is_reported_instead_of_restoring_garbage() {
    let harness = Harness::new().await;
    harness.put("坏.docx", &docx("一"));
    harness
        .edits
        .replace_bytes(COLLECTION, "坏.docx", &docx("二"), None, "a")
        .await
        .unwrap();
    let baseline =
        VersionRepo::list_by_source(harness.env.meta.as_ref(), COLLECTION, "坏.docx", 10)
            .await
            .unwrap()
            .into_iter()
            .find(|version| version.version == 1)
            .unwrap();
    let root = harness.env.paths().home().join("file-versions");
    for dir in std::fs::read_dir(&root).unwrap().flatten() {
        for file in std::fs::read_dir(dir.path()).unwrap().flatten() {
            std::fs::write(file.path(), b"tampered").unwrap();
        }
    }
    let err = harness
        .edits
        .restore(&baseline.id, "a")
        .await
        .expect_err("备份被改过");
    assert!(err.to_string().contains("对不上"), "{err}");
}

fn xlsx(cells: &str) -> Vec<u8> {
    let workbook = r#"<workbook xmlns:r="r"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
    let rels = r#"<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>"#;
    let sheet = format!("<worksheet><sheetData>{cells}</sheetData></worksheet>");
    kb_extract::zip::build_stored_zip(&[
        ("xl/workbook.xml", workbook.as_bytes()),
        ("xl/_rels/workbook.xml.rels", rels.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
    ])
}

fn cell(sheet: &str, cell: &str, value: &str) -> kb_extract::xlsx_edit::CellEdit {
    kb_extract::xlsx_edit::CellEdit {
        sheet: sheet.to_owned(),
        cell: cell.to_owned(),
        value: value.to_owned(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn editing_sheet_cells_saves_a_new_version_and_the_search_index_follows() {
    let harness = Harness::new().await;
    let original = xlsx(
        r#"<row r="1"><c r="A1" t="inlineStr"><is><t>旧的项目名称</t></is></c><c r="B1"><f>1+1</f><v>2</v></c></row>"#,
    );
    let path = harness.put("预算.xlsx", &original);
    let (formulas, sha) = harness
        .edits
        .sheet_info(COLLECTION, "预算.xlsx")
        .await
        .expect("读表格");
    assert_eq!(formulas.get("预算"), Some(&vec!["B1".to_owned()]));

    let result = harness
        .edits
        .edit_sheet_cells(
            COLLECTION,
            "预算.xlsx",
            &[
                cell("预算", "A1", "新的项目名称"),
                cell("预算", "A2", "多出来的一行"),
            ],
            Some(&sha),
            "alice",
        )
        .await
        .expect("改值");
    assert_eq!(result.version, 2);
    let saved = std::fs::read(&path).unwrap();
    assert_ne!(saved, original);
    let text = harness.texts("预算.xlsx").await;
    assert!(
        text.contains("新的项目名称") && text.contains("多出来的一行"),
        "检索里是改过的内容:{text}"
    );
    assert!(!text.contains("旧的项目名称"));

    // 拿着改之前的 sha 再改一次:冲突,不能盖掉刚才的修改
    let stale = harness
        .edits
        .edit_sheet_cells(
            COLLECTION,
            "预算.xlsx",
            &[cell("预算", "A1", "又改")],
            Some(&sha),
            "bob",
        )
        .await;
    assert!(stale.is_err());
    // 公式格拒绝改,文件不变
    let err = harness
        .edits
        .edit_sheet_cells(
            COLLECTION,
            "预算.xlsx",
            &[cell("预算", "B1", "3")],
            None,
            "bob",
        )
        .await
        .expect_err("公式格");
    assert!(err.to_string().contains("公式"), "{err}");
    assert_eq!(std::fs::read(&path).unwrap(), saved);
    // 不是 xlsx 不行
    harness.put("a.docx", &docx("x"));
    assert!(
        harness
            .edits
            .edit_sheet_cells(COLLECTION, "a.docx", &[cell("预算", "A1", "x")], None, "a")
            .await
            .is_err()
    );
}

// ---- 写回之前检查新文件是不是完整的 Office 包 ----

const TYPES: &str = r#"<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/></Types>"#;

/// 一个完整的 docx:有内容类型、关系、图片。`body` 是正文里的字。
fn complete_docx(body: &str) -> Vec<u8> {
    let document = format!(
        r#"<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>{body}</w:t></w:r></w:p></w:body></w:document>"#
    );
    let root = r#"<Relationships xmlns="r"><Relationship Id="rId1" Type="t" Target="word/document.xml"/></Relationships>"#;
    let rels = r#"<Relationships xmlns="r"><Relationship Id="rId5" Type="image" Target="media/image1.png"/></Relationships>"#;
    kb_extract::zip::build_stored_zip(&[
        ("[Content_Types].xml", TYPES.as_bytes()),
        ("_rels/.rels", root.as_bytes()),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/media/image1.png", b"\x89PNG\r\n\x1a\n"),
    ])
}

/// 原件是完整的:换成缺了关系目标的 / 坏 XML 的 / 根本不是 zip 的,都被拒绝,原文件、版本、索引一点没动。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_broken_replacement_of_a_complete_office_file_is_refused_and_nothing_changes() {
    let harness = Harness::new().await;
    let original = complete_docx("原来的正文");
    let path = harness.put("报告.docx", &original);
    let item_id = FileEditService::item_id(COLLECTION, "报告.docx");

    let without_picture = {
        let entries =
            kb_extract::zip::read_all(&complete_docx("x"), kb_extract::zip::ZipLimits::default())
                .unwrap();
        let refs: Vec<(&str, &[u8])> = entries
            .iter()
            .filter(|entry| entry.name != "word/media/image1.png")
            .map(|entry| (entry.name.as_str(), entry.data.as_slice()))
            .collect();
        kb_extract::zip::build_stored_zip(&refs)
    };
    for (bytes, expect) in [
        (
            b"this is not a zip file".to_vec(),
            "不是一个完整的 Word 文件",
        ),
        (without_picture, "不在包里"),
        (docx("缺内容类型的最小包"), "缺少 [Content_Types].xml"),
    ] {
        let error = harness
            .edits
            .replace_bytes(COLLECTION, "报告.docx", &bytes, None, "tester")
            .await
            .expect_err("应拒绝");
        assert!(matches!(error, KbError::InvalidInput(_)), "{error:?}");
        let text = error.to_string();
        assert!(
            text.contains("没有保存") && text.contains(expect),
            "{expect} → {text}"
        );
    }
    assert_eq!(
        std::fs::read(&path).unwrap(),
        original,
        "原文件一个字节都没动"
    );
    assert_eq!(
        VersionRepo::latest_version(harness.env.meta.as_ref(), &item_id)
            .await
            .unwrap(),
        0,
        "没有产生版本"
    );

    // 完整的新文件正常替换
    let good = complete_docx("新的正文");
    harness
        .edits
        .replace_bytes(COLLECTION, "报告.docx", &good, None, "tester")
        .await
        .expect("完整的可以替换");
    assert_eq!(std::fs::read(&path).unwrap(), good);
}

/// 扩展名是 Office 但原件本身就不完整(手工拼的、损坏的):不设门槛,可以换成任何东西(包括换成好的)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_already_incomplete_original_may_be_replaced_by_anything_including_a_good_file() {
    let harness = Harness::new().await;
    harness.put("旧.docx", &docx("手工拼的最小包"));
    let good = complete_docx("补好的");
    harness
        .edits
        .replace_bytes(COLLECTION, "旧.docx", &good, None, "tester")
        .await
        .expect("不完整的原件可以换成完整的");
}

/// 不是 Office 的文件(图片 / pdf / 文本)不过这道检查。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn non_office_files_are_not_subject_to_the_package_check() {
    let harness = Harness::new().await;
    harness.put("a.pdf", b"%PDF-1.4 old");
    harness
        .edits
        .replace_bytes(
            COLLECTION,
            "a.pdf",
            b"%PDF-1.4 new, not a zip",
            None,
            "tester",
        )
        .await
        .expect("pdf 不检查");
}

// ---- 旧版本份数上限 ----

fn blob_files(env: &TestEnv) -> Vec<std::path::PathBuf> {
    let root = env.paths().home().join("file-versions");
    let mut out = Vec::new();
    if let Ok(prefixes) = std::fs::read_dir(&root) {
        for prefix in prefixes.flatten() {
            if let Ok(files) = std::fs::read_dir(prefix.path()) {
                out.extend(files.flatten().map(|file| file.path()));
            }
        }
    }
    out
}

fn editor_with(env: &TestEnv, keep: usize) -> FileEditService {
    let index = Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ));
    FileEditService::new(env.meta.clone(), index, env.paths()).with_keep_versions(keep)
}

/// 每个文件除了当前这一版,只留 `keep_versions` 份旧的:更早的版本记录和备份文件都删掉,当前的永远在,
/// 还能恢复留着的最旧一份。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_the_configured_number_of_old_versions_is_kept() {
    let harness = Harness::new().await;
    let edits = editor_with(&harness.env, 2);
    let path = harness.put("报告.docx", &complete_docx("v1 原件"));
    let item_id = FileEditService::item_id(COLLECTION, "报告.docx");
    for round in 2..=5 {
        edits
            .replace_bytes(
                COLLECTION,
                "报告.docx",
                &complete_docx(&format!("v{round}")),
                None,
                "tester",
            )
            .await
            .expect("替换");
    }
    // 版本 1 是原件(基线),替换四次得到 2~5。当前 5 + 2 份旧的(4、3)
    let versions = VersionRepo::list(harness.env.meta.as_ref(), &item_id, 100)
        .await
        .unwrap();
    assert_eq!(
        versions.len(),
        3,
        "{:?}",
        versions.iter().map(|v| v.version).collect::<Vec<_>>()
    );
    assert_eq!(
        versions.iter().map(|v| v.version).collect::<Vec<_>>(),
        vec![5, 4, 3]
    );
    assert_eq!(
        blob_files(&harness.env).len(),
        3,
        "备份文件跟着版本记录一起删"
    );
    assert!(std::fs::read(&path).unwrap().windows(2).any(|w| w == b"v5"));

    // 留着的最旧一份(v3 的内容)还能恢复
    let oldest = versions.last().unwrap();
    edits.restore(&oldest.id, "tester").await.expect("恢复");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        complete_docx("v3"),
        "恢复回 v3 的字节"
    );
}

/// 同样内容的备份被别的版本引用着就不能删文件:改回原样再改走,备份不能提前被清掉。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_backup_still_used_by_a_kept_version_is_never_deleted() {
    let harness = Harness::new().await;
    let edits = editor_with(&harness.env, 1);
    let a = complete_docx("甲");
    let b = complete_docx("乙");
    harness.put("来回.docx", &a);
    // a → b → a → b → a:内容只有两种,备份文件最多两个
    for bytes in [&b, &a, &b, &a] {
        edits
            .replace_bytes(COLLECTION, "来回.docx", bytes, None, "tester")
            .await
            .expect("替换");
    }
    let item_id = FileEditService::item_id(COLLECTION, "来回.docx");
    let versions = VersionRepo::list(harness.env.meta.as_ref(), &item_id, 100)
        .await
        .unwrap();
    assert_eq!(versions.len(), 2, "当前 + 1 份旧的");
    for version in &versions {
        let blob = kb_service::edit::blob_size(&version.body);
        assert!(blob.is_some());
    }
    // 留着的两个版本一个是 a 一个是 b,各自的备份文件都还在
    assert_eq!(blob_files(&harness.env).len(), 2);
    for version in &versions {
        edits
            .restore(&version.id, "tester")
            .await
            .expect("留着的版本都能恢复");
    }
}

/// 0 份:保存后旧内容就没了,只剩当前这一版。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn keeping_zero_old_versions_leaves_only_the_current_one() {
    let harness = Harness::new().await;
    let edits = editor_with(&harness.env, 0);
    harness.put("零.docx", &complete_docx("原件"));
    edits
        .replace_bytes(
            COLLECTION,
            "零.docx",
            &complete_docx("新的"),
            None,
            "tester",
        )
        .await
        .expect("替换");
    let item_id = FileEditService::item_id(COLLECTION, "零.docx");
    let versions = VersionRepo::list(harness.env.meta.as_ref(), &item_id, 100)
        .await
        .unwrap();
    assert_eq!(versions.len(), 1);
    assert_eq!(blob_files(&harness.env).len(), 1);
}

// ---- 编辑器「不改直接保存」的无损检查 ----

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_roundtrip_report_tells_lossless_from_lossy_and_broken() {
    let harness = Harness::new().await;
    let original = complete_docx("正文不变");
    harness.put("体检.docx", &original);

    // 1. 一个字节都没变 → 无损
    let report = harness
        .edits
        .roundtrip_report(COLLECTION, "体检.docx", &original)
        .await
        .expect("检查");
    assert!(
        report.valid && report.lossless && report.text_equal,
        "{report:?}"
    );
    assert!(report.changed_parts.is_empty() && report.removed_parts.is_empty());

    // 2. 只是 XML 的写法变了(声明、空白、属性顺序)→ 仍然算无损
    let reformatted = {
        let mut entries =
            kb_extract::zip::read_all(&original, kb_extract::zip::ZipLimits::default()).unwrap();
        for entry in entries.iter_mut() {
            if entry.name == "word/document.xml" {
                let text = String::from_utf8(entry.data.clone()).unwrap();
                entry.data =
                    format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n{text}\n").into_bytes();
            }
        }
        let refs: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|e| (e.name.as_str(), e.data.as_slice()))
            .collect();
        kb_extract::zip::build_stored_zip(&refs)
    };
    let report = harness
        .edits
        .roundtrip_report(COLLECTION, "体检.docx", &reformatted)
        .await
        .unwrap();
    assert!(report.lossless, "写法不同但结构一样:{report:?}");

    // 3. 文字被改了 → 不无损,点出是哪个部件,文字也不一样
    let edited = complete_docx("正文被改了");
    let report = harness
        .edits
        .roundtrip_report(COLLECTION, "体检.docx", &edited)
        .await
        .unwrap();
    assert!(
        report.valid && !report.lossless && !report.text_equal,
        "{report:?}"
    );
    assert_eq!(report.changed_parts, vec!["word/document.xml".to_owned()]);

    // 4. 丢了图片 → 不完整(悬空引用),并报告少了哪个部件
    let entries =
        kb_extract::zip::read_all(&original, kb_extract::zip::ZipLimits::default()).unwrap();
    let refs: Vec<(&str, &[u8])> = entries
        .iter()
        .filter(|e| e.name != "word/media/image1.png")
        .map(|e| (e.name.as_str(), e.data.as_slice()))
        .collect();
    let report = harness
        .edits
        .roundtrip_report(
            COLLECTION,
            "体检.docx",
            &kb_extract::zip::build_stored_zip(&refs),
        )
        .await
        .unwrap();
    assert!(!report.valid && !report.lossless);
    assert!(report.reason.unwrap().contains("不在包里"));
    assert_eq!(
        report.removed_parts,
        vec!["word/media/image1.png".to_owned()]
    );

    // 原件本身就不完整(缺内容类型的最小包):原样存回来也不能说是无损——存回来的文件 Office 打不开
    let minimal = docx("手工拼的最小包");
    harness.put("最小.docx", &minimal);
    let report = harness
        .edits
        .roundtrip_report(COLLECTION, "最小.docx", &minimal)
        .await
        .unwrap();
    assert!(!report.valid && !report.lossless, "{report:?}");
    assert!(
        report.changed_parts.is_empty(),
        "内容一个字节没变,只是本来就不完整"
    );

    // 5. 检查本身不写任何东西
    let item_id = FileEditService::item_id(COLLECTION, "体检.docx");
    assert_eq!(
        VersionRepo::latest_version(harness.env.meta.as_ref(), &item_id)
            .await
            .unwrap(),
        0
    );

    // 不是 Office 文件:拒绝;不存在的文件:报错
    harness.put("a.pdf", b"%PDF");
    assert!(
        harness
            .edits
            .roundtrip_report(COLLECTION, "a.pdf", b"x")
            .await
            .is_err()
    );
    assert!(
        harness
            .edits
            .roundtrip_report(COLLECTION, "没有.docx", &original)
            .await
            .is_err()
    );
}

/// 新文件是完整的、但比原件少了部件(没人引用的图片被清掉了):照常保存,结果里点名少了哪些,界面据此提醒用户。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parts_that_disappear_on_save_are_reported_not_blocked() {
    let harness = Harness::new().await;
    let original = complete_docx("带图片");
    harness.put("图.docx", &original);

    // 去掉图片和指向它的那条关系:包仍然完整
    let entries =
        kb_extract::zip::read_all(&original, kb_extract::zip::ZipLimits::default()).unwrap();
    let refs: Vec<(String, Vec<u8>)> = entries
        .iter()
        .filter(|e| e.name != "word/media/image1.png")
        .map(|e| {
            let data = if e.name == "word/_rels/document.xml.rels" {
                br#"<Relationships xmlns="r"></Relationships>"#.to_vec()
            } else {
                e.data.clone()
            };
            (e.name.clone(), data)
        })
        .collect();
    let slices: Vec<(&str, &[u8])> = refs
        .iter()
        .map(|(n, d)| (n.as_str(), d.as_slice()))
        .collect();
    let cleaned = kb_extract::zip::build_stored_zip(&slices);
    let result = harness
        .edits
        .replace_bytes(COLLECTION, "图.docx", &cleaned, None, "tester")
        .await
        .expect("完整的包照常保存");
    assert_eq!(
        result.parts_removed,
        vec!["word/media/image1.png".to_owned()]
    );

    // 正文改了、部件一个没少:空
    let edited = complete_docx("改过的正文");
    harness.put("不少.docx", &original);
    let result = harness
        .edits
        .replace_bytes(COLLECTION, "不少.docx", &edited, None, "tester")
        .await
        .unwrap();
    assert!(result.parts_removed.is_empty());
}

// ---- 多人协同:一次会话合并成一个版本、房间底稿 ----

/// 停手 2 秒就落地一次:同一个会话的多次落地只占一个版本(更新它),新会话才新增;
/// 否则保留份数一满,协同之前的原件就被挤掉了。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn landings_of_one_collaboration_session_share_one_version() {
    let harness = Harness::new().await;
    let edits = editor_with(&harness.env, 3);
    let original = complete_docx("协同之前");
    let path = harness.put("协同.docx", &original);
    let item_id = FileEditService::item_id(COLLECTION, "协同.docx");

    for round in 1..=6 {
        let result = edits
            .land_session(
                COLLECTION,
                "协同.docx",
                &complete_docx(&format!("第 {round} 次落地")),
                None,
                "甲,乙",
                "office:s1",
            )
            .await
            .expect("落地");
        assert_eq!(result.version, 2, "同一个会话一直是第 2 版");
    }
    let versions = VersionRepo::list(harness.env.meta.as_ref(), &item_id, 100)
        .await
        .unwrap();
    assert_eq!(
        versions.iter().map(|v| v.version).collect::<Vec<_>>(),
        vec![2, 1],
        "原件(基线)还在"
    );
    assert_eq!(versions[0].author.as_deref(), Some("甲,乙"));
    assert_eq!(std::fs::read(&path).unwrap(), complete_docx("第 6 次落地"));
    // 第 2 版的内容是最后一次落地的
    edits
        .restore(&versions[1].id, "tester")
        .await
        .expect("恢复原件");
    assert_eq!(std::fs::read(&path).unwrap(), original);

    // 新的会话新增一版
    let next = edits
        .land_session(
            COLLECTION,
            "协同.docx",
            &complete_docx("第二次协同"),
            None,
            "丙",
            "office:s2",
        )
        .await
        .unwrap();
    assert_eq!(next.version, 4, "恢复占了第 3 版,新会话是第 4 版");
    // 中间夹了别的写入(恢复)之后,旧会话再落地也不会去改别的版本
    let again = edits
        .land_session(
            COLLECTION,
            "协同.docx",
            &complete_docx("旧会话又落地"),
            None,
            "甲",
            "office:s1",
        )
        .await
        .unwrap();
    assert_eq!(again.version, 5);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_session_base_is_the_current_bytes_kept_by_content() {
    let harness = Harness::new().await;
    let original = complete_docx("底稿");
    harness.put("底稿.docx", &original);
    let (sha, size, file) = harness
        .edits
        .session_base(COLLECTION, "底稿.docx")
        .await
        .expect("底稿");
    assert_eq!(sha, self::sha(&original));
    assert_eq!(size, original.len() as u64);
    assert_eq!(std::fs::read(&file).unwrap(), original);
    assert_eq!(
        harness.edits.blob_file(&sha).as_deref(),
        Some(file.as_path())
    );
    // 不合法的哈希、不存在的内容
    for bad in ["../etc/passwd", "ABC", &sha.to_uppercase(), &"0".repeat(64)] {
        assert!(harness.edits.blob_file(bad).is_none(), "{bad}");
    }
}
