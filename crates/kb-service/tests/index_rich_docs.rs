//! 项目扫描里的办公文档(PDF / Word 等):走抽取器入库,读不出文字的记成"跳过"而不是失败。

use std::path::Path;
use std::time::{Duration, SystemTime};

use kb_core::model::Project;
use kb_core::ports::repo::{ChunkRepo, FileRepo, ProjectRepo};
use kb_service::{CollectionService, IndexOptions, IndexReport, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;

const COLLECTION: &str = "proj_demo";

struct Fixture {
    env: TestEnv,
    dir: TempDir,
    project: Project,
    collection: kb_core::model::Collection,
    service: IndexService,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("临时项目目录");
    let env = TestEnv::new().await;
    let project = Project {
        id: "p1".to_owned(),
        name: "demo".to_owned(),
        slug: "demo".to_owned(),
        root_path: dir.path().to_string_lossy().into_owned(),
        include: Vec::new(),
        exclude: Vec::new(),
        is_git: false,
        last_commit: None,
        last_indexed_at: None,
        allow_cloud_llm: false,
        extract_enabled: false,
        hooks_installed: false,
        created_at: 1_700_000_000_000,
    };
    ProjectRepo::create(env.meta.as_ref(), project.clone())
        .await
        .expect("写项目行");
    let collections =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("建 collection");
    let service = IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    );
    Fixture {
        env,
        dir,
        project,
        collection,
        service,
    }
}

fn write_bytes(root: &Path, relative: &str, content: &[u8]) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

/// 造一个 docx:若干段落,可选再带一张截图。
fn docx(paragraphs: &[&str], with_picture: bool) -> Vec<u8> {
    let mut body = String::new();
    for text in paragraphs {
        body.push_str(&format!("<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"));
    }
    if with_picture {
        body.push_str(r#"<w:p><w:r><w:drawing><a:blip r:embed="rId5"/></w:drawing></w:r></w:p>"#);
    }
    let document = format!(
        r#"<?xml version="1.0"?><w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>{body}</w:body></w:document>"#
    );
    let rels = r#"<Relationships><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>"#;
    kb_extract::zip::build_stored_zip(&[
        ("[Content_Types].xml", b"<Types/>"),
        ("word/document.xml", document.as_bytes()),
        ("word/_rels/document.xml.rels", rels.as_bytes()),
        ("word/media/image1.png", b"\x89PNG\r\n\x1a\n\0\0"),
    ])
}

async fn index(fixture: &Fixture) -> IndexReport {
    let report = fixture
        .service
        .index_project(&fixture.project, &fixture.collection)
        .await
        .expect("索引");
    assert!(report.errors.is_empty(), "索引出错:{:?}", report.errors);
    report
}

async fn record(fixture: &Fixture, path: &str) -> kb_core::model::FileRecord {
    FileRepo::get(fixture.env.meta.as_ref(), COLLECTION, path)
        .await
        .expect("查文件记录")
        .unwrap_or_else(|| panic!("{path} 应有文件记录"))
}

async fn chunk_ids(fixture: &Fixture, path: &str) -> Vec<String> {
    ChunkRepo::by_path(fixture.env.meta.as_ref(), COLLECTION, path)
        .await
        .expect("读 chunks")
        .into_iter()
        .map(|meta| meta.id)
        .collect()
}

async fn texts(fixture: &Fixture, ids: &[String]) -> Vec<String> {
    fixture
        .env
        .store
        .get(&fixture.collection.active_table, ids)
        .await
        .expect("查 LanceDB")
        .into_iter()
        .map(|row| row.text)
        .collect()
}

#[tokio::test]
async fn office_documents_are_indexed_and_unreadable_ones_are_skipped_with_a_reason() {
    let fixture = fixture().await;
    let root = fixture.dir.path();
    write_bytes(root, "README.md", "# 项目\n\n说明\n".as_bytes());
    write_bytes(
        root,
        "docs/手册.docx",
        &docx(&["第一步打开系统设置", "第二步点击保存按钮"], true),
    );
    write_bytes(
        root,
        "docs/report.pdf",
        &kb_testkit::pdf::minimal("quarterly revenue report"),
    );
    // 整份只有截图(扫描件):抽不出文字
    write_bytes(root, "docs/扫描件.docx", &docx(&[], true));
    // 损坏的 PDF
    write_bytes(
        root,
        "docs/broken.pdf",
        b"%PDF-1.4 this is not really a pdf",
    );
    // 旧版二进制 Word:抽取器不支持,仍按二进制跳过
    write_bytes(root, "docs/old.doc", &[0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]);

    index(&fixture).await;

    let manual = chunk_ids(&fixture, "docs/手册.docx").await;
    assert!(!manual.is_empty(), "docx 应入库");
    let manual_texts = texts(&fixture, &manual).await.join("\n");
    assert!(
        manual_texts.contains("第一步打开系统设置"),
        "{manual_texts}"
    );
    assert_eq!(record(&fixture, "docs/手册.docx").await.status, "ok");

    let pdf = chunk_ids(&fixture, "docs/report.pdf").await;
    assert!(!pdf.is_empty(), "PDF 应入库");
    assert!(
        texts(&fixture, &pdf)
            .await
            .join("\n")
            .contains("quarterly revenue")
    );

    // 读不出文字的:没有块,记 skipped 并写明原因,不算错误(index 已断言 errors 为空)
    assert!(chunk_ids(&fixture, "docs/扫描件.docx").await.is_empty());
    let scanned = record(&fixture, "docs/扫描件.docx").await;
    assert_eq!(scanned.status, "skipped");
    assert!(
        scanned
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("文字层"),
        "{scanned:?}"
    );

    assert!(chunk_ids(&fixture, "docs/broken.pdf").await.is_empty());
    let broken = record(&fixture, "docs/broken.pdf").await;
    assert_eq!(broken.status, "skipped");
    assert!(
        broken
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("无法解析"),
        "{broken:?}"
    );

    assert!(chunk_ids(&fixture, "docs/old.doc").await.is_empty());
    assert_eq!(record(&fixture, "docs/old.doc").await.status, "binary");
}

#[tokio::test]
async fn unchanged_office_documents_are_not_reprocessed() {
    let fixture = fixture().await;
    let root = fixture.dir.path();
    write_bytes(root, "手册.docx", &docx(&["第一步打开系统设置"], false));
    write_bytes(root, "坏.pdf", b"%PDF-1.4 broken");
    index(&fixture).await;
    let ids = chunk_ids(&fixture, "手册.docx").await;
    assert!(!ids.is_empty());
    fixture.env.fake.reset_count();

    // 再扫一遍:没有任何嵌入,块原样保留
    let report = index(&fixture).await;
    assert_eq!(report.embedded, 0);
    assert_eq!(fixture.env.fake.embedding_count(), 0);
    assert_eq!(chunk_ids(&fixture, "手册.docx").await, ids);

    // 只改修改时间(同步工具常这样):内容哈希没变,不重新嵌入,但要把新时间记下来
    let path = root.join("手册.docx");
    let before = record(&fixture, "手册.docx").await;
    let later = SystemTime::now() + Duration::from_secs(3600);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .expect("打开")
        .set_modified(later)
        .expect("改时间");
    let report = index(&fixture).await;
    assert_eq!(report.embedded, 0);
    assert_eq!(fixture.env.fake.embedding_count(), 0);
    let after = record(&fixture, "手册.docx").await;
    assert_ne!(after.mtime, before.mtime, "新的修改时间应被记下");
    assert_eq!(after.status, "ok");
    assert_eq!(after.file_hash, before.file_hash);

    // 大小和修改时间都没变就信任上次的结果、不再读盘:
    // 这里把内容换成等长的垃圾并还原修改时间,块应当还在(读了盘就会解析失败而被清掉)
    let size = std::fs::metadata(&path).expect("元数据").len() as usize;
    std::fs::write(&path, vec![b'x'; size]).expect("覆盖");
    std::fs::File::options()
        .write(true)
        .open(&path)
        .expect("打开")
        .set_modified(later)
        .expect("还原时间");
    index(&fixture).await;
    assert_eq!(chunk_ids(&fixture, "手册.docx").await, ids);

    // 解析失败的文件同样不会每次扫描都重新解析:记录里的 skipped 被沿用
    let broken = record(&fixture, "坏.pdf").await;
    assert_eq!(broken.status, "skipped");
    index(&fixture).await;
    assert_eq!(
        record(&fixture, "坏.pdf").await.indexed_at,
        broken.indexed_at
    );
}

#[tokio::test]
async fn editing_an_office_document_replaces_its_chunks_and_a_scan_replacement_drops_them() {
    let fixture = fixture().await;
    let root = fixture.dir.path();
    write_bytes(root, "手册.docx", &docx(&["旧版本的说明文字"], false));
    index(&fixture).await;
    let old_ids = chunk_ids(&fixture, "手册.docx").await;
    assert!(!old_ids.is_empty());
    fixture.env.fake.reset_count();

    write_bytes(
        root,
        "手册.docx",
        &docx(&["新版本的说明文字,内容比以前长一些"], false),
    );
    let report = index(&fixture).await;
    assert!(report.embedded >= 1, "内容变了要重新嵌入");
    let new_ids = chunk_ids(&fixture, "手册.docx").await;
    let new_texts = texts(&fixture, &new_ids).await.join("\n");
    assert!(new_texts.contains("新版本的说明文字"), "{new_texts}");
    assert!(
        texts(&fixture, &old_ids)
            .await
            .iter()
            .all(|text| !text.contains("旧版本")),
        "旧内容的向量应已删除"
    );

    // 被换成整份只有截图的版本:旧块要清掉,不能继续搜到过期内容
    write_bytes(root, "手册.docx", &docx(&[], true));
    index(&fixture).await;
    assert!(chunk_ids(&fixture, "手册.docx").await.is_empty());
    assert!(
        texts(&fixture, &new_ids).await.is_empty(),
        "向量库里也不能留着"
    );
    assert_eq!(record(&fixture, "手册.docx").await.status, "skipped");
}

/// 数据导出类的大文件(这里用 3000 段长文字代替 6MB 的 Excel)不能无限制地占着后台 worker:
/// 只入库前 RICH_DOC_MAX_CHUNKS 块,文件记录里写明。
#[tokio::test]
async fn a_huge_office_document_is_capped_and_the_record_says_so() {
    let fixture = fixture().await;
    let paragraph = "数据行内容".repeat(400);
    let paragraphs: Vec<String> = (0..3000).map(|n| format!("{n}-{paragraph}")).collect();
    let refs: Vec<&str> = paragraphs.iter().map(String::as_str).collect();
    write_bytes(fixture.dir.path(), "导出.docx", &docx(&refs, false));

    index(&fixture).await;

    let ids = chunk_ids(&fixture, "导出.docx").await;
    assert_eq!(ids.len(), kb_service::index::RICH_DOC_MAX_CHUNKS);
    let record = record(&fixture, "导出.docx").await;
    assert_eq!(record.status, "ok");
    let note = record.error.unwrap_or_default();
    assert!(note.contains("只索引了前 2000 块"), "{note}");
    // 总块数取决于分块器怎么切长段,这里只要求说明里写了一个大于上限的总数
    let total: usize = note
        .split("共 ")
        .nth(1)
        .and_then(|rest| rest.split(' ').next())
        .and_then(|digits| digits.parse().ok())
        .unwrap_or(0);
    assert!(total > kb_service::index::RICH_DOC_MAX_CHUNKS, "{note}");

    // 再扫一遍不会重新向量化(带说明的记录照样走"没变就跳过")
    fixture.env.fake.reset_count();
    index(&fixture).await;
    assert_eq!(fixture.env.fake.embedding_count(), 0);
}

/// 造一条和已有块同形、但 id 是新的向量库行(模拟"向量化到一半进程被停"留下的孤儿)。
async fn plant_orphans(
    fixture: &Fixture,
    path: &str,
    count: usize,
    updated_at: i64,
    offset: u64,
) -> Vec<String> {
    let ids = chunk_ids(fixture, path).await;
    let template = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &ids[..1])
        .await
        .expect("取模板行")
        .remove(0);
    let planted: Vec<String> = (0..count)
        .map(|n| format!("{:032x}", 0xdead_0000_0000u64 + offset + n as u64))
        .collect();
    let rows = planted
        .iter()
        .map(|id| kb_core::model::RecordRow {
            id: id.clone(),
            source: "uploads/orphan.xlsx".to_owned(),
            updated_at,
            ..template.clone()
        })
        .collect();
    fixture
        .env
        .store
        .upsert(&fixture.collection.active_table, rows)
        .await
        .expect("写孤儿");
    planted
}

async fn store_rows(fixture: &Fixture) -> u64 {
    fixture
        .env
        .store
        .count(&fixture.collection.active_table, None)
        .await
        .expect("计数")
}

#[tokio::test]
async fn reconcile_removes_old_orphans_and_keeps_everything_else() {
    let fixture = fixture().await;
    write_bytes(
        fixture.dir.path(),
        "手册.docx",
        &docx(&["第一步打开系统设置"], false),
    );
    index(&fixture).await;
    let real = chunk_ids(&fixture, "手册.docx").await;
    let before = store_rows(&fixture).await;

    let old = plant_orphans(&fixture, "手册.docx", 5, 1_700_000_000_000, 0).await;
    // 刚写下的(可能是保存笔记等不走索引任务的写入,元数据还没登记)不能动
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let recent = plant_orphans(&fixture, "手册.docx", 2, now, 1000).await;
    assert_eq!(store_rows(&fixture).await, before + 5 + 2);

    let removed = fixture
        .service
        .reconcile_orphans(&fixture.collection)
        .await
        .expect("对账")
        .expect("没有写入在途时应能拿到闸门");
    assert_eq!(removed, 5);
    let all: Vec<String> = [old.clone(), recent.clone(), real.clone()].concat();
    let left = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &all)
        .await
        .unwrap();
    let left_ids: Vec<&str> = left.iter().map(|row| row.id.as_str()).collect();
    assert!(
        old.iter().all(|id| !left_ids.contains(&id.as_str())),
        "旧孤儿应被删"
    );
    assert!(
        recent.iter().all(|id| left_ids.contains(&id.as_str())),
        "近期写入的不能动"
    );
    assert!(
        real.iter().all(|id| left_ids.contains(&id.as_str())),
        "已登记的块不能动"
    );

    // 再对一次:近期的那 2 条仍在宽限期内,什么都不删
    assert_eq!(
        fixture
            .service
            .reconcile_orphans(&fixture.collection)
            .await
            .unwrap(),
        Some(0)
    );
}

#[tokio::test]
async fn reconcile_finds_orphans_even_when_the_row_counts_cancel_out() {
    // 真实故障形态:向量库少 5 行(写了一半)、又多 2 行孤儿,两边行数只差 3,
    // 旧逻辑用「向量库行数 <= 元数据块数」直接判无事发生,这 2 条孤儿永远不清。
    let fixture = fixture().await;
    let mut real = Vec::new();
    for index in 0..5 {
        let path = format!("notes/{index}.md");
        write_bytes(
            fixture.dir.path(),
            &path,
            format!("# 笔记 {index}\n\n第 {index} 篇的内容。\n").as_bytes(),
        );
    }
    index(&fixture).await;
    for index in 0..5 {
        real.extend(chunk_ids(&fixture, &format!("notes/{index}.md")).await);
    }
    assert_eq!(real.len(), 5, "五篇短笔记应各有一块:{real:?}");

    let planted = plant_orphans(&fixture, "notes/0.md", 2, 1_700_000_000_000, 0).await;
    fixture
        .env
        .store
        .delete_ids(&fixture.collection.active_table, &real)
        .await
        .expect("删掉 5 个真实块,模拟元数据有、向量库没有");
    assert_eq!(
        store_rows(&fixture).await,
        2,
        "向量库只剩 2 条孤儿,行数比元数据少,旧逻辑会误判为没有孤儿"
    );

    assert_eq!(
        fixture
            .service
            .reconcile_orphans(&fixture.collection)
            .await
            .expect("对账")
            .expect("没有写入在途时应能拿到闸门"),
        2,
        "行数抵消时仍要按 id 找出并清掉孤儿"
    );
    let left = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &planted)
        .await
        .expect("查孤儿");
    assert!(left.is_empty(), "孤儿应被删掉");
}

#[tokio::test]
async fn reconcile_skips_while_an_index_slice_is_writing() {
    let fixture = fixture().await;
    write_bytes(
        fixture.dir.path(),
        "手册.docx",
        &docx(&["第一步打开系统设置"], false),
    );
    index(&fixture).await;
    plant_orphans(&fixture, "手册.docx", 3, 1_700_000_000_000, 0).await;

    let writer = fixture.service.write_gate().writer().await;
    assert_eq!(
        fixture
            .service
            .reconcile_orphans(&fixture.collection)
            .await
            .unwrap(),
        None,
        "有写入在途时不对账,也不能排队挡住别人"
    );
    drop(writer);
    assert_eq!(
        fixture
            .service
            .reconcile_orphans(&fixture.collection)
            .await
            .unwrap(),
        Some(3)
    );
}

#[tokio::test]
async fn reconcile_refuses_when_most_of_the_store_looks_orphaned() {
    // 例如 meta.db 被旧备份恢复:向量库里大半行在 chunks 表里找不到,自动删会把整库清空
    let fixture = fixture().await;
    write_bytes(
        fixture.dir.path(),
        "手册.docx",
        &docx(&["第一步打开系统设置"], false),
    );
    index(&fixture).await;
    let before = store_rows(&fixture).await;
    plant_orphans(&fixture, "手册.docx", 1100, 1_700_000_000_000, 0).await;

    assert_eq!(
        fixture
            .service
            .reconcile_orphans(&fixture.collection)
            .await
            .unwrap(),
        Some(0)
    );
    assert_eq!(
        store_rows(&fixture).await,
        before + 1100,
        "拒绝时一行都不删"
    );
}

// ---- 项目目录里的旧格式 Office:装了转换器就转成 OOXML 再抽取(原件不动) ----

/// 假的 soffice:把 `$FIXTURE` 当转换结果复制到输出目录,并往 `$COUNTER` 追加一行(数转换了几次)。
/// `$mode` 决定行为:`ok` 复制;`fail` 退出码 1(确定性失败);`slow` 睡很久(用来触发超时)。
fn fake_soffice(
    dir: &Path,
    fixture: &Path,
    counter: &Path,
    mode_file: &Path,
) -> std::path::PathBuf {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(dir.join("program")).expect("建目录");
    let path = dir.join("program").join("soffice");
    let script = format!(
        "#!/bin/sh\nout=''; prev=''; last=''\nfor a in \"$@\"; do\n  if [ \"$prev\" = '--outdir' ]; then out=\"$a\"; fi\n  prev=\"$a\"; last=\"$a\"\ndone\nstem=$(basename \"$last\"); stem=\"${{stem%.*}}\"\necho \"$last\" >> '{counter}'\ncase \"$(cat '{mode}')\" in\n  fail) echo broken >&2; exit 1;;\n  slow) sleep 30;;\n  *) cp '{fixture}' \"$out/$stem.docx\";;\nesac\n",
        counter = counter.display(),
        mode = mode_file.display(),
        fixture = fixture.display(),
    );
    std::fs::write(&path, script).expect("写假 soffice");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("权限");
    path
}

struct LegacyRig {
    fixture: Fixture,
    counter: std::path::PathBuf,
    mode: std::path::PathBuf,
}

impl LegacyRig {
    /// 装了转换器的索引服务;`timeout` 给「慢」的情形用。
    async fn new(timeout: Duration) -> Self {
        let fixture = fixture().await;
        let home = fixture.env.home();
        let converted = home.join("converted.docx");
        std::fs::write(
            &converted,
            docx(&["旧文档里的重要结论:季度预算上调"], false),
        )
        .expect("写转换结果");
        let (counter, mode) = (home.join("count.txt"), home.join("mode.txt"));
        std::fs::write(&mode, "ok").expect("写模式");
        let install = home.join("lo");
        let soffice = fake_soffice(&install, &converted, &counter, &mode);
        let converter = kb_service::office_convert::Converter::new(
            soffice,
            home.join("convert-work"),
            timeout,
            1,
        );
        let service = IndexService::new(
            fixture.env.meta.clone(),
            fixture.env.store.clone(),
            fixture.env.embedder.clone(),
            fixture.env.chunker.clone(),
            fixture.env.scanner.clone(),
            IndexOptions::default(),
        )
        .with_converter(converter);
        Self {
            fixture: Fixture { service, ..fixture },
            counter,
            mode,
        }
    }

    fn set_mode(&self, mode: &str) {
        std::fs::write(&self.mode, mode).expect("写模式");
    }

    fn conversions(&self) -> usize {
        std::fs::read_to_string(&self.counter)
            .map(|text| text.lines().count())
            .unwrap_or(0)
    }
}

const OLE: [u8; 8] = [0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0];

/// 装了转换器:项目里的 .doc 转成 docx 抽取入库、可检索;原件字节不变;文件记录按原件的哈希记。
#[tokio::test]
async fn a_legacy_doc_in_a_project_is_converted_for_indexing_and_the_original_is_untouched() {
    let rig = LegacyRig::new(Duration::from_secs(20)).await;
    let root = rig.fixture.dir.path();
    let mut original = OLE.to_vec();
    original.extend_from_slice(b"legacy word body");
    write_bytes(root, "docs/old.doc", &original);

    index(&rig.fixture).await;

    assert_eq!(rig.conversions(), 1);
    let ids = chunk_ids(&rig.fixture, "docs/old.doc").await;
    assert!(!ids.is_empty(), "转换后的正文应入库");
    let text = texts(&rig.fixture, &ids).await.join("\n");
    assert!(text.contains("季度预算上调"), "{text}");
    let record = record(&rig.fixture, "docs/old.doc").await;
    assert_eq!(record.status, "ok");
    assert_eq!(
        record.file_hash,
        kb_service::index::pipeline::file_hash(&original),
        "记的是原件的哈希,不是转换产物的"
    );
    assert_eq!(
        std::fs::read(root.join("docs/old.doc")).expect("读"),
        original,
        "原件不动"
    );
}

/// 内容没变就不再转换(转换产物每次都不一定相同,也很费时间);内容变了才重做。
#[tokio::test]
async fn an_unchanged_legacy_doc_is_not_converted_again_but_a_changed_one_is() {
    let rig = LegacyRig::new(Duration::from_secs(20)).await;
    let root = rig.fixture.dir.path();
    write_bytes(root, "old.doc", &[OLE.as_slice(), b"v1"].concat());
    index(&rig.fixture).await;
    assert_eq!(rig.conversions(), 1);

    index(&rig.fixture).await;
    assert_eq!(rig.conversions(), 1, "没变,不转换");

    // 只改修改时间(同步工具常这样):内容哈希没变,仍不转换
    let later = SystemTime::now() + Duration::from_secs(120);
    let file = std::fs::File::options()
        .write(true)
        .open(root.join("old.doc"))
        .expect("打开");
    file.set_times(std::fs::FileTimes::new().set_modified(later))
        .expect("改时间");
    index(&rig.fixture).await;
    assert_eq!(rig.conversions(), 1, "只是改了修改时间,内容哈希没变");

    write_bytes(
        root,
        "old.doc",
        &[OLE.as_slice(), b"version two!!"].concat(),
    );
    index(&rig.fixture).await;
    assert_eq!(rig.conversions(), 2, "内容变了才重新转换");
}

/// 转换失败(确定性的):不算索引出错,记成跳过并写明原因;内容没变不再重试。
#[tokio::test]
async fn a_legacy_doc_that_cannot_be_converted_is_skipped_with_a_reason_and_not_retried() {
    let rig = LegacyRig::new(Duration::from_secs(20)).await;
    let root = rig.fixture.dir.path();
    rig.set_mode("fail");
    write_bytes(root, "broken.doc", &[OLE.as_slice(), b"garbage"].concat());
    index(&rig.fixture).await;

    assert!(chunk_ids(&rig.fixture, "broken.doc").await.is_empty());
    let skipped = record(&rig.fixture, "broken.doc").await;
    assert_eq!(skipped.status, "skipped");
    let reason = skipped.error.unwrap_or_default();
    assert!(reason.contains("旧格式转换失败"), "{reason}");
    assert_eq!(rig.conversions(), 1);

    index(&rig.fixture).await;
    assert_eq!(rig.conversions(), 1, "确定性失败、内容没变,不反复重试");
}

/// 转换超时是暂时的(机器忙):不能记成「跳过」把这个文件永远排除,要报出来、下次再试。
#[tokio::test]
async fn a_conversion_timeout_is_reported_and_retried_not_remembered_as_skipped() {
    let rig = LegacyRig::new(Duration::from_millis(400)).await;
    let root = rig.fixture.dir.path();
    rig.set_mode("slow");
    write_bytes(root, "slow.doc", &[OLE.as_slice(), b"slow one"].concat());
    let report = rig
        .fixture
        .service
        .index_project(&rig.fixture.project, &rig.fixture.collection)
        .await
        .expect("索引");
    assert_eq!(report.errors.len(), 1, "{:?}", report.errors);
    assert!(report.errors[0].contains("暂时"), "{:?}", report.errors);
    let status = FileRepo::get(rig.fixture.env.meta.as_ref(), COLLECTION, "slow.doc")
        .await
        .expect("查")
        .map(|record| record.status);
    assert_ne!(status.as_deref(), Some("skipped"), "不能记成跳过");

    // 机器闲下来再扫一遍就转好了
    rig.set_mode("ok");
    index(&rig.fixture).await;
    assert!(!chunk_ids(&rig.fixture, "slow.doc").await.is_empty());
}

/// 没装转换器:旧格式 Office 仍按二进制跳过(现状不变),也不会启动任何转换。
#[tokio::test]
async fn without_a_converter_a_legacy_doc_is_still_skipped_as_binary() {
    let fixture = fixture().await;
    write_bytes(fixture.dir.path(), "docs/old.doc", &OLE);
    index(&fixture).await;
    assert!(chunk_ids(&fixture, "docs/old.doc").await.is_empty());
    assert_eq!(record(&fixture, "docs/old.doc").await.status, "binary");
}

/// 转换器之后被关掉:以前转换入库的块被清掉(不再留着过期的内容),文件回到「二进制跳过」。
#[tokio::test]
async fn turning_the_converter_off_removes_the_converted_chunks() {
    let rig = LegacyRig::new(Duration::from_secs(20)).await;
    write_bytes(
        rig.fixture.dir.path(),
        "old.doc",
        &[OLE.as_slice(), b"x"].concat(),
    );
    index(&rig.fixture).await;
    assert!(!chunk_ids(&rig.fixture, "old.doc").await.is_empty());

    let plain = IndexService::new(
        rig.fixture.env.meta.clone(),
        rig.fixture.env.store.clone(),
        rig.fixture.env.embedder.clone(),
        rig.fixture.env.chunker.clone(),
        rig.fixture.env.scanner.clone(),
        IndexOptions::default(),
    );
    plain
        .index_project(&rig.fixture.project, &rig.fixture.collection)
        .await
        .expect("索引");
    assert!(chunk_ids(&rig.fixture, "old.doc").await.is_empty());
    assert_eq!(record(&rig.fixture, "old.doc").await.status, "binary");
}
