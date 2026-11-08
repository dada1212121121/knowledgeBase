//! IndexService 增量逻辑(验收)。
//!
//! 六个场景都用 FakeEmbedder 的嵌入次数计数器断言。

use std::path::Path;

use kb_core::model::{Collection, ItemStatus, Project, RecordKind};
use kb_core::ports::repo::{ChunkRepo, FileRepo, ProjectRepo};
use kb_service::{CollectionService, IndexOptions, IndexReport, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;

struct Fixture {
    env: TestEnv,
    dir: TempDir,
    project: Project,
    collection: Collection,
    service: IndexService,
}

/// 当前表的碎片数与版本号(检索性能说明 的两个观察量)。
///
/// 版本号才是提交次数的直接证据:每次 commit +1,不看落盘细节;
/// 碎片数则受存储层的落盘模式影响(整行重写 vs 贴列),只能作参考。
async fn table_shape(fixture: &Fixture) -> (u64, u64) {
    let stats = fixture
        .env
        .store
        .table_stats()
        .await
        .expect("表状况")
        .into_iter()
        .find(|stats| stats.table == fixture.collection.active_table)
        .expect("应能取到这张表");
    (stats.fragments, stats.version)
}

async fn fixture(files: &[(&str, &str)]) -> Fixture {
    let dir = tempfile::tempdir().expect("临时项目目录");
    for (path, content) in files {
        write_file(dir.path(), path, content);
    }
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

fn write_file(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
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

const SAMPLE: &str = r#"fn alpha() -> u32 {
    1
}

fn beta() -> u32 {
    2
}

fn gamma() -> u32 {
    3
}
"#;

#[tokio::test]
async fn first_index_embeds_every_chunk() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    let report = index(&fixture).await;
    assert_eq!(report.indexed_files, 1);
    assert_eq!(report.chunks, 3, "三个函数应切成三块");
    assert_eq!(report.embedded, 3);
    assert_eq!(
        fixture.env.fake.embedding_count(),
        3,
        "首次索引的嵌入次数应等于块数"
    );
    assert_eq!(report.updated_meta, 0);
}

#[tokio::test]
async fn second_run_embeds_nothing() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    index(&fixture).await;
    fixture.env.fake.reset_count();

    let report = index(&fixture).await;
    assert_eq!(report.embedded, 0);
    assert_eq!(
        fixture.env.fake.embedding_count(),
        0,
        "没有变化不应重新嵌入"
    );
    assert_eq!(report.chunks, 3, "块仍然存在");
}

#[tokio::test]
async fn shifting_lines_only_updates_metadata() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    index(&fixture).await;
    let (fragments_before, _) = table_shape(&fixture).await;
    fixture.env.fake.reset_count();

    // 在 beta 上方插入 3 行空行:只有行号变化
    let shifted = SAMPLE.replace("fn beta() -> u32 {", "\n\n\nfn beta() -> u32 {");
    write_file(fixture.dir.path(), "src/lib.rs", &shifted);

    let report = index(&fixture).await;
    assert_eq!(report.embedded, 0, "行号变化不应触发重新嵌入");
    assert!(report.updated_meta >= 1, "应走 update_meta 路径");
    assert_eq!(fixture.env.fake.embedding_count(), 0);
    // 元数据补丁攒成一批提交:碎片不随块数涨
    let (fragments_after, _) = table_shape(&fixture).await;
    assert!(
        fragments_after <= fragments_before + 2,
        "行号位移不该让碎片暴涨:{} → {}",
        fragments_before,
        fragments_after
    );

    // LanceDB 里的行号与 meta_hash 已更新
    let metas = ChunkRepo::by_path(fixture.env.meta.as_ref(), "proj_demo", "src/lib.rs")
        .await
        .expect("读 chunks");
    let beta = metas
        .iter()
        .find(|meta| meta.meta_hash != metas[0].meta_hash || meta.ordinal == 1)
        .expect("应有多块");
    let rows = fixture
        .env
        .store
        .get(
            &fixture.collection.active_table,
            &metas.iter().map(|meta| meta.id.clone()).collect::<Vec<_>>(),
        )
        .await
        .expect("查 LanceDB");
    assert_eq!(rows.len(), metas.len());
    for row in &rows {
        let meta = metas
            .iter()
            .find(|meta| meta.id == row.id)
            .expect("应能对上");
        assert_eq!(row.meta_hash, meta.meta_hash, "meta_hash 应与 SQLite 一致");
        assert!(row.start_line.is_some());
    }
    // beta 的行号确实后移了(原来从第 5 行开始)
    let beta_row = rows
        .iter()
        .find(|row| row.text.contains("fn beta"))
        .expect("应找到 beta");
    assert_eq!(
        beta_row.start_line,
        Some(8),
        "插入 3 行空行后 beta 应从第 8 行开始"
    );
    let _ = beta;
}

/// 一个文件几十个块、行号整体位移:碎片数不该跟着块数涨(回归防线)。
///
/// 线上 `proj_knowledgebase` 32 k 行散成 588 个碎片,主源就是这条路径一行一个提交;
/// 把批量提交改回逐行,本用例会红。
#[tokio::test]
async fn shifting_lines_in_a_long_file_does_not_multiply_fragments() {
    // 30 个函数,每个一块
    let mut source = String::new();
    for index in 0..30 {
        source.push_str(&format!("fn item_{index}() -> u32 {{\n    {index}\n}}\n\n"));
    }
    let fixture = fixture(&[("src/long.rs", &source)]).await;
    let report = index(&fixture).await;
    assert_eq!(report.chunks, 30, "应切成 30 块");
    let (fragments_before, version_before) = table_shape(&fixture).await;
    fixture.env.fake.reset_count();

    // 文件头插 5 行:所有块的行号都位移,正文不变
    let shifted = format!("\n\n\n\n\n{source}");
    write_file(fixture.dir.path(), "src/long.rs", &shifted);
    let report = index(&fixture).await;
    assert_eq!(report.embedded, 0, "只是行号变化");
    assert!(report.updated_meta >= 25, "大部分块要走元数据补丁");
    let (fragments_after, version_after) = table_shape(&fixture).await;
    // 33 次提交(逐行写)是实测过的数字,这里留 5 的余量给同一批里的其它提交
    assert!(
        version_after <= version_before + 5,
        "{} 条元数据补丁不该一次一提交(逐行写就是 {} 个版本):版本 {} → {}",
        report.updated_meta,
        report.updated_meta,
        version_before,
        version_after
    );
    assert!(
        fragments_after <= fragments_before + 2,
        "{} 条元数据补丁不该多出几十个碎片:{} → {}",
        report.updated_meta,
        fragments_before,
        fragments_after
    );
}

#[tokio::test]
async fn changing_one_body_embeds_only_that_chunk() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    index(&fixture).await;
    fixture.env.fake.reset_count();

    let changed = SAMPLE.replace("    2\n", "    42\n");
    write_file(fixture.dir.path(), "src/lib.rs", &changed);

    let report = index(&fixture).await;
    assert_eq!(report.embedded, 1, "只应重新嵌入被改动的块");
    assert_eq!(fixture.env.fake.embedding_count(), 1);
    assert_eq!(report.updated_meta, 0);
}

#[tokio::test]
async fn deleting_a_file_removes_its_chunks_everywhere() {
    let fixture = fixture(&[
        ("src/lib.rs", SAMPLE),
        ("src/other.rs", "fn other() -> u32 {\n    7\n}\n"),
    ])
    .await;
    let first = index(&fixture).await;
    assert_eq!(first.chunks, 4);

    let other_chunks = ChunkRepo::by_path(fixture.env.meta.as_ref(), "proj_demo", "src/other.rs")
        .await
        .expect("读 chunks");
    assert_eq!(other_chunks.len(), 1);
    let other_id = other_chunks[0].id.clone();

    // 删掉文件后重新索引
    std::fs::remove_file(fixture.dir.path().join("src/other.rs")).expect("删除文件");
    let report = index(&fixture).await;
    assert_eq!(report.deleted_files, 1);

    assert!(
        ChunkRepo::by_path(fixture.env.meta.as_ref(), "proj_demo", "src/other.rs")
            .await
            .expect("读 chunks")
            .is_empty(),
        "chunks 表里应已删除"
    );
    assert!(
        FileRepo::get(fixture.env.meta.as_ref(), "proj_demo", "src/other.rs")
            .await
            .expect("读 files")
            .is_none(),
        "files 表里应已删除"
    );
    let remaining = fixture
        .env
        .store
        .get(&fixture.collection.active_table, &[other_id])
        .await
        .expect("查 LanceDB");
    assert!(remaining.is_empty(), "LanceDB 里应已删除");
    assert_eq!(
        fixture
            .env
            .store
            .count(&fixture.collection.active_table, None)
            .await
            .expect("计数"),
        3,
        "只剩另一个文件的 3 块"
    );
}

#[tokio::test]
async fn renaming_a_file_reembeds_under_the_new_path() {
    let fixture = fixture(&[("src/old.rs", "fn only() -> u32 {\n    1\n}\n")]).await;
    index(&fixture).await;
    fixture.env.fake.reset_count();

    std::fs::rename(
        fixture.dir.path().join("src/old.rs"),
        fixture.dir.path().join("src/new.rs"),
    )
    .expect("重命名");

    let report = index(&fixture).await;
    assert_eq!(report.deleted_files, 1, "旧路径应被清理");
    assert_eq!(report.embedded, 1, "新路径需要重新嵌入(header 含路径)");
    assert_eq!(fixture.env.fake.embedding_count(), 1);

    let old = ChunkRepo::by_path(fixture.env.meta.as_ref(), "proj_demo", "src/old.rs")
        .await
        .expect("读 chunks");
    assert!(old.is_empty(), "旧路径的块应删除");
    let new = ChunkRepo::by_path(fixture.env.meta.as_ref(), "proj_demo", "src/new.rs")
        .await
        .expect("读 chunks");
    assert_eq!(new.len(), 1, "新路径应有块");
}

#[tokio::test]
async fn markdown_with_duplicate_headings_indexes_cleanly() {
    let fixture = fixture(&[(
        "docs/guide.md",
        "# Doc\n\n## Example\n\n第一段\n\n## Example\n\n第二段\n",
    )])
    .await;
    let report = index(&fixture).await;
    assert_eq!(
        report.errors.len(),
        0,
        "不应因为同名标题失败:{:?}",
        report.errors
    );
    assert_eq!(report.chunks, 3);
    assert_eq!(report.embedded, 3);

    fixture.env.fake.reset_count();
    let again = index(&fixture).await;
    assert_eq!(again.embedded, 0, "第二次不应重新嵌入");
    assert_eq!(fixture.env.fake.embedding_count(), 0);

    let metas = ChunkRepo::by_path(fixture.env.meta.as_ref(), "proj_demo", "docs/guide.md")
        .await
        .expect("读块");
    assert_eq!(metas.len(), 3, "chunks 表应有 3 行");
    let rows = fixture
        .env
        .store
        .count(&fixture.collection.active_table, None)
        .await
        .expect("计数");
    assert_eq!(rows, 3, "LanceDB 行数应与 chunks 表一致");
}

#[tokio::test]
async fn indexed_rows_are_searchable_by_content() {
    let fixture = fixture(&[("src/lib.rs", SAMPLE)]).await;
    index(&fixture).await;
    let rows = fixture
        .env
        .store
        .get(
            &fixture.collection.active_table,
            &ChunkRepo::by_path(fixture.env.meta.as_ref(), "proj_demo", "src/lib.rs")
                .await
                .expect("读 chunks")
                .into_iter()
                .map(|meta| meta.id)
                .collect::<Vec<_>>(),
        )
        .await
        .expect("查 LanceDB");
    assert_eq!(rows.len(), 3);
    assert!(rows.iter().all(|row| row.kind == RecordKind::Code));
    assert!(rows.iter().all(|row| row.status == ItemStatus::Active));
    assert!(rows.iter().any(|row| row.text.contains("fn beta")));
    assert!(
        rows.iter().all(|row| row.vector.is_none()),
        "get 默认不取向量"
    );
    assert!(rows.iter().all(|row| row.lex.contains("alpha")
        || row.lex.contains("beta")
        || row.lex.contains("gamma")));
}

/// 删掉 collection 再同名重建后,必须能重新索引出数据。
///
/// 旧实现只删 `collections` 行,孤儿 `chunks` 留在库里;重建后的增量 diff 会把这些块
/// 当成“没变”直接跳过,新的向量表一行都没有 —— 任务还是 done,检索却永远为空。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn recreating_a_deleted_collection_reindexes_from_scratch() {
    let fixture = fixture(&[("src/lib.rs", "pub fn hello() -> u32 {\n    1\n}\n")]).await;
    let first = index(&fixture).await;
    assert!(first.chunks > 0, "{first:?}");
    let rows = fixture
        .env
        .store
        .count(&fixture.collection.active_table, None)
        .await
        .expect("计数");
    assert!(rows > 0, "首次索引应有行");

    // 删除集合(Web 端的「删除集合」),再同名重建
    let collections = CollectionService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    );
    collections.delete("proj_demo").await.expect("删除集合");
    assert!(
        ChunkRepo::by_path(fixture.env.meta.as_ref(), "proj_demo", "src/lib.rs")
            .await
            .expect("查 chunks")
            .is_empty(),
        "删集合必须把 chunks 一起清掉"
    );
    let recreated = collections
        .create_for_project("p1", "demo")
        .await
        .expect("同名重建");

    let second = fixture
        .service
        .index_project(&fixture.project, &recreated)
        .await
        .expect("重新索引");
    assert!(second.chunks > 0, "{second:?}");
    let rows = fixture
        .env
        .store
        .count(&recreated.active_table, None)
        .await
        .expect("计数");
    assert!(
        rows > 0,
        "同名重建后 LanceDB 必须有数据(旧实现这里恒为 0),实际 {rows}"
    );
}
