//! 文本 / Markdown / 代码文件的每文件块数上限(`TEXT_FILE_MAX_CHUNKS`)。
//!
//! 办公文档早就有 `RICH_DOC_MAX_CHUNKS`;文本路径放宽体积上限之后也需要一道,
//! 否则病态输入(每两行一个标题)能切出几万块,占着唯一的写 worker 好几个小时。
//!
//! 这里直接调用 `index_entry` / `index_entry_with` 处理写在临时目录里的文件,不经过扫描器
//! (扫描器的体积上限与本测试无关),也不用文件监听器。

use std::path::Path;
use std::time::UNIX_EPOCH;

use kb_core::model::{Collection, FileRecord, Project, ScanEntry};
use kb_core::ports::repo::{ChunkRepo, FileRepo, ProjectRepo};
use kb_service::index::{FileIndexSpec, TEXT_FILE_MAX_CHUNKS};
use kb_service::{CollectionService, FileStats, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;

const COLLECTION: &str = "proj_demo";

/// 病态 Markdown 的标题数。每个标题带一行正文、自成一块,所以总块数就是这个数,
/// 比上限多 600 块,既明显超限,又不让测试慢下来。文件约 65 KB,也在扫描器现行的 200 KB 以内。
const PATHOLOGICAL_SECTIONS: usize = 3600;

/// 病态 Rust 文件里的小函数个数:每个函数是一个定义节点、自成一块。
const PATHOLOGICAL_FUNCTIONS: usize = 3300;

struct Fixture {
    env: TestEnv,
    dir: TempDir,
    project: Project,
    collection: Collection,
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
    assert_eq!(collection.name, COLLECTION);
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

fn write_file(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

/// 按磁盘上的真实状态造一条扫描结果(语言与种类用扫描器同一套判定函数)。
fn scan_entry(root: &Path, relative: &str) -> ScanEntry {
    let path = root.join(relative);
    let meta = std::fs::metadata(&path).expect("读文件元数据");
    let mtime = meta
        .modified()
        .expect("修改时间")
        .duration_since(UNIX_EPOCH)
        .expect("修改时间晚于 1970")
        .as_millis() as i64;
    ScanEntry {
        lang: kb_index::detect_lang(&path).to_owned(),
        kind: kb_index::kind_of(&path),
        size: meta.len(),
        relative: relative.to_owned(),
        path,
        mtime,
    }
}

/// 走默认入口(无标签)索引一个文件。
async fn index_file(fixture: &Fixture, relative: &str) -> FileStats {
    let entry = scan_entry(fixture.dir.path(), relative);
    fixture
        .service
        .index_entry(&fixture.project, &fixture.collection, &entry)
        .await
        .expect("索引文件")
}

/// 带标签索引:有标签时不走「文件哈希没变就跳过」的快路径,强制走完整的分块 → diff,
/// 用来验证截断本身是确定的、不会引起重复嵌入。
async fn index_file_with_tags(fixture: &Fixture, relative: &str, tags: &[&str]) -> FileStats {
    let entry = scan_entry(fixture.dir.path(), relative);
    let spec = FileIndexSpec {
        source: entry.relative.clone(),
        kind: entry.kind,
        tags: tags.iter().map(|tag| (*tag).to_owned()).collect(),
    };
    fixture
        .service
        .index_entry_with(
            &fixture.project.name,
            &fixture.collection,
            &entry,
            &spec,
            1_700_000_000_000,
        )
        .await
        .expect("带标签索引文件")
}

async fn record(fixture: &Fixture, path: &str) -> FileRecord {
    FileRepo::get(fixture.env.meta.as_ref(), COLLECTION, path)
        .await
        .expect("查文件记录")
        .unwrap_or_else(|| panic!("{path} 应有文件记录"))
}

/// 该文件在 chunks 表里的 id(按 ordinal 排好)。
async fn chunk_ids(fixture: &Fixture, path: &str) -> Vec<String> {
    let mut metas = ChunkRepo::by_path(fixture.env.meta.as_ref(), COLLECTION, path)
        .await
        .expect("读 chunks");
    metas.sort_by_key(|meta| meta.ordinal);
    metas.into_iter().map(|meta| meta.id).collect()
}

/// 向量库里某种类的行数。
async fn store_rows(fixture: &Fixture, kind: &str) -> u64 {
    fixture
        .env
        .store
        .count(
            &fixture.collection.active_table,
            Some(&format!("kind = '{kind}'")),
        )
        .await
        .expect("数向量库行")
}

/// 每两行一个 H1 标题的病态 Markdown(一行标题 + 一行正文)。
fn pathological_markdown(sections: usize) -> String {
    let mut text = String::new();
    for index in 0..sections {
        text.push_str(&format!("# 标题{index}\n正文{index}\n"));
    }
    text
}

/// 有几千个小函数的 Rust 文件:每个函数一个定义节点,tree-sitter 分块器让每个定义各自成块。
fn pathological_rust(functions: usize) -> String {
    let mut text = String::new();
    for index in 0..functions {
        text.push_str(&format!("fn f{index}() -> u32 {{\n    {index}\n}}\n\n"));
    }
    text
}

fn cap_note(total: usize) -> String {
    format!(
        "内容较多,只索引了前 {TEXT_FILE_MAX_CHUNKS} 块(共 {total} 块);查看和编辑读的是原文件,不受影响"
    )
}

/// 病态 Markdown:恰好只入库前 `TEXT_FILE_MAX_CHUNKS` 块,状态仍是 ok,文件记录里写明总块数。
#[tokio::test]
async fn pathological_markdown_is_capped_and_the_file_record_says_so() {
    let fixture = fixture().await;
    write_file(
        fixture.dir.path(),
        "docs/huge.md",
        &pathological_markdown(PATHOLOGICAL_SECTIONS),
    );

    let stats = index_file(&fixture, "docs/huge.md").await;

    assert_eq!(stats.chunks, TEXT_FILE_MAX_CHUNKS);
    assert_eq!(stats.embedded, TEXT_FILE_MAX_CHUNKS, "只嵌入保留下来的块");
    assert_eq!(fixture.env.fake.embedding_count(), TEXT_FILE_MAX_CHUNKS);

    let ids = chunk_ids(&fixture, "docs/huge.md").await;
    assert_eq!(ids.len(), TEXT_FILE_MAX_CHUNKS, "chunks 表恰好 3000 行");
    assert_eq!(
        store_rows(&fixture, "doc").await,
        TEXT_FILE_MAX_CHUNKS as u64,
        "向量库里也恰好 3000 行"
    );

    let record = record(&fixture, "docs/huge.md").await;
    assert_eq!(record.status, "ok", "超限不算失败");
    let note = record.error.expect("超限要在文件记录里写明");
    assert!(note.contains("只索引了前"), "{note}");
    assert_eq!(note, cap_note(PATHOLOGICAL_SECTIONS));

    // 留下的必须是文件最前面的 3000 块,而不是随便哪 3000 块
    let rows = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &ids)
        .await
        .expect("查 LanceDB");
    assert_eq!(rows.len(), TEXT_FILE_MAX_CHUNKS);
    let last_kept = format!("标题{}\n", TEXT_FILE_MAX_CHUNKS - 1);
    let first_dropped = format!("标题{}\n", TEXT_FILE_MAX_CHUNKS);
    assert!(rows.iter().any(|row| row.text.contains(&last_kept)));
    assert!(rows.iter().all(|row| !row.text.contains(&first_dropped)));
}

/// 正常大小的文件不受影响:块数是真实块数,error 为空。
#[tokio::test]
async fn normal_files_are_not_affected() {
    let fixture = fixture().await;
    write_file(
        fixture.dir.path(),
        "docs/guide.md",
        &pathological_markdown(50),
    );
    write_file(
        fixture.dir.path(),
        "src/lib.rs",
        "fn alpha() -> u32 {\n    1\n}\n\nfn beta() -> u32 {\n    2\n}\n",
    );

    let guide = index_file(&fixture, "docs/guide.md").await;
    let lib = index_file(&fixture, "src/lib.rs").await;

    assert_eq!(guide.chunks, 50);
    assert_eq!(lib.chunks, 2);
    assert_eq!(chunk_ids(&fixture, "docs/guide.md").await.len(), 50);
    assert_eq!(chunk_ids(&fixture, "src/lib.rs").await.len(), 2);
    for path in ["docs/guide.md", "src/lib.rs"] {
        let record = record(&fixture, path).await;
        assert_eq!(record.status, "ok");
        assert_eq!(record.error, None, "{path} 没超限,不该有提示");
    }
}

/// 同一份超限内容重复索引,强制跳过快路径(带标签)走完整 diff:截断的是固定前缀,
/// 所以不重复嵌入、块 id 不变,文件记录里的提示也还在。
#[tokio::test]
async fn reindexing_capped_content_does_not_embed_again() {
    let fixture = fixture().await;
    write_file(
        fixture.dir.path(),
        "docs/huge.md",
        &pathological_markdown(PATHOLOGICAL_SECTIONS),
    );

    let first = index_file_with_tags(&fixture, "docs/huge.md", &["t"]).await;
    assert_eq!(first.embedded, TEXT_FILE_MAX_CHUNKS);
    let ids_before = chunk_ids(&fixture, "docs/huge.md").await;
    fixture.env.fake.reset_count();

    let second = index_file_with_tags(&fixture, "docs/huge.md", &["t"]).await;

    assert_eq!(fixture.env.fake.embedding_count(), 0, "第二次不该再嵌入");
    assert_eq!(second.embedded, 0);
    assert_eq!(second.updated_meta, 0);
    assert_eq!(second.deleted_chunks, 0);
    assert_eq!(second.chunks, TEXT_FILE_MAX_CHUNKS);
    assert_eq!(chunk_ids(&fixture, "docs/huge.md").await, ids_before);
    assert_eq!(
        store_rows(&fixture, "doc").await,
        TEXT_FILE_MAX_CHUNKS as u64
    );
    let record = record(&fixture, "docs/huge.md").await;
    assert_eq!(record.error, Some(cap_note(PATHOLOGICAL_SECTIONS)));
}

/// 走默认入口(无标签)的快路径:文件哈希没变直接跳过,不嵌入,提示也不会被抹掉。
#[tokio::test]
async fn unchanged_capped_file_is_skipped_and_keeps_its_note() {
    let fixture = fixture().await;
    write_file(
        fixture.dir.path(),
        "docs/huge.md",
        &pathological_markdown(PATHOLOGICAL_SECTIONS),
    );
    index_file(&fixture, "docs/huge.md").await;
    fixture.env.fake.reset_count();

    let again = index_file(&fixture, "docs/huge.md").await;

    assert_eq!(fixture.env.fake.embedding_count(), 0);
    assert_eq!(again.embedded, 0);
    assert_eq!(again.chunks, TEXT_FILE_MAX_CHUNKS);
    let record = record(&fixture, "docs/huge.md").await;
    assert_eq!(record.error, Some(cap_note(PATHOLOGICAL_SECTIONS)));
}

/// 内容之后缩回上限以内:提示清掉,多余的旧块在 chunks 表和向量库里都删掉。
#[tokio::test]
async fn shrinking_below_the_cap_clears_the_note_and_the_stale_chunks() {
    let fixture = fixture().await;
    write_file(
        fixture.dir.path(),
        "docs/huge.md",
        &pathological_markdown(PATHOLOGICAL_SECTIONS),
    );
    index_file(&fixture, "docs/huge.md").await;
    assert!(record(&fixture, "docs/huge.md").await.error.is_some());

    // 缩到 40 个标题:前 40 块与之前完全相同,其余 2960 块要删
    write_file(
        fixture.dir.path(),
        "docs/huge.md",
        &pathological_markdown(40),
    );
    let stats = index_file(&fixture, "docs/huge.md").await;

    assert_eq!(stats.chunks, 40);
    assert_eq!(
        stats.deleted_chunks,
        TEXT_FILE_MAX_CHUNKS - 40,
        "超出的旧块要删掉"
    );
    let record = record(&fixture, "docs/huge.md").await;
    assert_eq!(record.status, "ok");
    assert_eq!(record.error, None, "不再超限,提示要清掉");
    assert_eq!(chunk_ids(&fixture, "docs/huge.md").await.len(), 40);
    assert_eq!(
        store_rows(&fixture, "doc").await,
        40,
        "向量库里的旧块也删了"
    );
}

/// 仍然超限但总块数变了:提示里的总数跟着最新内容走,保留块数仍是上限。
#[tokio::test]
async fn capped_note_follows_the_latest_total() {
    let fixture = fixture().await;
    write_file(
        fixture.dir.path(),
        "docs/huge.md",
        &pathological_markdown(PATHOLOGICAL_SECTIONS),
    );
    index_file(&fixture, "docs/huge.md").await;

    write_file(
        fixture.dir.path(),
        "docs/huge.md",
        &pathological_markdown(TEXT_FILE_MAX_CHUNKS + 200),
    );
    let stats = index_file(&fixture, "docs/huge.md").await;

    assert_eq!(stats.chunks, TEXT_FILE_MAX_CHUNKS);
    assert_eq!(stats.deleted_chunks, 0, "保留的前缀没变,不删块");
    let record = record(&fixture, "docs/huge.md").await;
    assert_eq!(record.error, Some(cap_note(TEXT_FILE_MAX_CHUNKS + 200)));
    assert_eq!(
        chunk_ids(&fixture, "docs/huge.md").await.len(),
        TEXT_FILE_MAX_CHUNKS
    );
}

/// 代码文件同样受限。构造:3300 个互不相同的小函数(`fn f0 -> u32 { 0 }` 的多行写法)写进一个 `.rs`,
/// tree-sitter 分块器把每个函数定义切成独立一块,总块数 3300,超过上限 300。
#[tokio::test]
async fn code_files_are_capped_too() {
    let fixture = fixture().await;
    write_file(
        fixture.dir.path(),
        "src/many.rs",
        &pathological_rust(PATHOLOGICAL_FUNCTIONS),
    );

    let stats = index_file(&fixture, "src/many.rs").await;

    assert_eq!(stats.chunks, TEXT_FILE_MAX_CHUNKS);
    assert_eq!(
        chunk_ids(&fixture, "src/many.rs").await.len(),
        TEXT_FILE_MAX_CHUNKS
    );
    assert_eq!(
        store_rows(&fixture, "code").await,
        TEXT_FILE_MAX_CHUNKS as u64
    );
    let record = record(&fixture, "src/many.rs").await;
    assert_eq!(record.status, "ok");
    assert_eq!(record.error, Some(cap_note(PATHOLOGICAL_FUNCTIONS)));
}
