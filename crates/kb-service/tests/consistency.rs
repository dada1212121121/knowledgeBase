//! 元数据 `chunks` 表 ⇄ 向量库的一致性:校验(`verify_chunks`)、失效(`invalidate_files`)、
//! 夜间自愈(`Scheduler::nightly` / 每拍补做)。
//!
//! 背景(此前的检查):生产上有文件在 `chunks` 里有记录、向量库里一行都没有,`files` 行又是 ok、哈希与磁盘一致,
//! 增量索引每晚都判 skip,永远补不上。这里全部用真实的 SQLite + 真实的 Lance(临时目录)复现。

use std::path::Path;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use chrono::{DateTime, FixedOffset, TimeZone, Utc};
use kb_core::model::{
    Collection, ItemStatus, ListQuery, MetaPatch, Project, RecordKind, RecordRow, StoreHit,
    StoreQuery,
};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::{ChunkRepo, FileRepo, ProjectRepo};
use kb_core::{KbError, Result};
use kb_service::index::ConsistencyReport;
use kb_service::jobs::{IndexJobHandler, JobQueue, JobRouter, Worker};
use kb_service::scheduler::{FixedClock, ScheduleOptions, Scheduler};
use kb_service::search::{NoopReranker, SearchOptions, SearchRequest, SearchService};
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;

struct Fixture {
    env: TestEnv,
    dir: TempDir,
    project: Project,
    collection: Collection,
    index: Arc<IndexService>,
}

fn write_file(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

/// 建项目 + collection + 索引服务,并把 `files` 全部索引一遍。
async fn fixture(files: &[(&str, String)]) -> Fixture {
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
    let collection =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
            .create_for_project("p1", "demo")
            .await
            .expect("建 collection");
    let index = Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ));
    let report = index
        .index_project(&project, &collection)
        .await
        .expect("索引");
    assert!(report.errors.is_empty(), "索引出错:{:?}", report.errors);
    Fixture {
        env,
        dir,
        project,
        collection,
        index,
    }
}

/// 三个函数各自成块(`index_incremental` 里同样的样本,标识符带独一无二的记号,搜索时认得出来)。
fn rust_file(marker: &str) -> String {
    format!(
        "pub fn {marker}_first() -> u32 {{\n    1\n}}\n\npub fn {marker}_second() -> u32 {{\n    2\n}}\n\npub fn {marker}_third() -> u32 {{\n    3\n}}\n"
    )
}

/// 标准夹具:alpha(3 块)、beta、一个与 alpha 路径前缀相同的文档,外加一篇 Markdown。
async fn standard_fixture() -> Fixture {
    fixture(&[
        ("src/alpha.rs", rust_file("alpha_unique_marker")),
        ("src/beta.rs", rust_file("beta_unique_marker")),
        // 路径以 `src/alpha.rs` 开头:按前缀匹配的实现会把它一起删掉
        (
            "src/alpha.rs.txt",
            "alpha 的说明文字,和 alpha.rs 没有关系。\n".to_owned(),
        ),
        (
            "docs/guide.md",
            "# 指南\n\n## 第一节\n\n这是第一节的内容。\n\n## 第二节\n\n这是第二节的内容。\n"
                .to_owned(),
        ),
    ])
    .await
}

fn table(fixture: &Fixture) -> &str {
    &fixture.collection.active_table
}

/// 向量库里某个文件(`source` 精确相等)的全部块 id,不分种类。
async fn store_ids_of(fixture: &Fixture, path: &str) -> Vec<String> {
    fixture
        .env
        .store
        .list_slices(table(fixture), None)
        .await
        .expect("列块")
        .into_iter()
        .filter(|slice| slice.source == path)
        .map(|slice| slice.id)
        .collect()
}

/// 元数据里某个文件的块数。
async fn meta_count_of(fixture: &Fixture, path: &str) -> usize {
    ChunkRepo::by_path(fixture.env.meta.as_ref(), &fixture.collection.name, path)
        .await
        .expect("读 chunks")
        .len()
}

/// 绕过索引服务,直接从向量库里删掉某个文件的全部行(模拟「元数据有、向量库没有」)。返回删了几行。
async fn wipe_from_store(fixture: &Fixture, path: &str) -> usize {
    let ids = store_ids_of(fixture, path).await;
    fixture
        .env
        .store
        .delete_ids(table(fixture), &ids)
        .await
        .expect("删行");
    ids.len()
}

async fn verify(fixture: &Fixture) -> ConsistencyReport {
    fixture
        .index
        .verify_chunks(&fixture.collection)
        .await
        .expect("校验")
        .expect("没有写入在途时应拿得到闸门")
}

/// 跑完队列里的全部任务(增量索引)。
async fn run_queued_jobs(fixture: &Fixture) {
    let mut router = JobRouter::new();
    router.register(
        "index",
        Arc::new(IndexJobHandler::new(
            fixture.index.clone(),
            fixture.env.meta.clone(),
            50,
        )),
    );
    let (_tx, rx) = tokio::sync::watch::channel(false);
    Worker::new(
        Arc::new(JobQueue::new(fixture.env.meta.clone())),
        Arc::new(router),
        rx,
    )
    .run_until_idle()
    .await
    .expect("跑任务");
}

/// 排队中的任务各自要处理哪些路径。
async fn queued_paths(fixture: &Fixture) -> Vec<Vec<String>> {
    let queue = JobQueue::new(fixture.env.meta.clone());
    let mut out = Vec::new();
    for job in queue
        .list(Some(kb_core::model::JobState::Queued))
        .await
        .expect("列任务")
    {
        assert_eq!(job.kind, "index");
        assert_eq!(job.collection.as_deref(), Some("proj_demo"));
        let payload: serde_json::Value = serde_json::from_str(&job.payload_json).expect("payload");
        assert_eq!(payload["mode"], "incremental");
        out.push(
            payload["paths"]
                .as_array()
                .expect("paths")
                .iter()
                .map(|path| path.as_str().expect("路径").to_owned())
                .collect(),
        );
    }
    out
}

/// 能不能在项目里搜到某个文件。
async fn search_finds(fixture: &Fixture, query: &str, path: &str) -> bool {
    // 重建后的新行要并进全文索引,搜索才稳定
    fixture
        .index
        .ensure_indexes(&fixture.collection)
        .await
        .expect("建索引");
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    let response = search
        .search(SearchRequest {
            query: query.to_owned(),
            collections: vec![fixture.collection.name.clone()],
            k: Some(10),
            explain: false,
            rerank: None,
        })
        .await
        .expect("检索");
    response.hits.iter().any(|hit| hit.source == path)
}

// ---------------------------------------------------------------------------------------------
// verify_chunks
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_clean_index_reports_zero_everywhere() {
    let fixture = standard_fixture().await;
    let report = verify(&fixture).await;
    assert!(report.meta_rows >= 4, "夹具应该产生若干块:{report:?}");
    assert_eq!(report.store_rows, report.meta_rows, "{report:?}");
    assert_eq!(report.missing_in_store, 0);
    assert_eq!(report.stale_in_store, 0);
    assert_eq!(report.orphans_in_store, 0);
    assert!(report.files.is_empty());
    assert!(!report.stale_unchecked, "Lance 支持指纹,过期检测应真的做了");
    assert!(report.is_clean());
    assert_eq!(report, {
        // 只读:再校验一遍结果完全一样
        verify(&fixture).await
    });
}

#[tokio::test]
async fn rows_deleted_from_the_store_are_reported_missing_for_that_path_only() {
    let fixture = standard_fixture().await;
    let total = verify(&fixture).await.meta_rows;
    let alpha_chunks = meta_count_of(&fixture, "src/alpha.rs").await;
    assert_eq!(alpha_chunks, 3, "三个函数应切成三块");
    assert_eq!(wipe_from_store(&fixture, "src/alpha.rs").await, 3);

    let report = verify(&fixture).await;
    assert_eq!(report.missing_in_store, 3, "{report:?}");
    assert_eq!(report.stale_in_store, 0);
    assert_eq!(report.orphans_in_store, 0, "删行不会产生孤儿");
    assert_eq!(report.meta_rows, total);
    assert_eq!(report.store_rows, total - 3);
    assert_eq!(
        report.files.keys().map(String::as_str).collect::<Vec<_>>(),
        ["src/alpha.rs"],
        "只有被删的那个文件有差异,前缀相同的 alpha.rs.txt 与别的文件不受影响"
    );
    let divergence = report.files["src/alpha.rs"];
    assert_eq!((divergence.missing, divergence.stale), (3, 0));
    assert!(!report.is_clean());
}

#[tokio::test]
async fn a_row_with_other_hashes_is_reported_stale() {
    let fixture = standard_fixture().await;
    let ids = store_ids_of(&fixture, "src/beta.rs").await;
    assert_eq!(ids.len(), 3);

    // 同 id、同来源,只改哈希:一个改 content_hash,一个改 embed_input_hash
    let rows = fixture
        .env
        .store
        .get(table(&fixture), &ids[..2])
        .await
        .expect("取行");
    assert_eq!(rows.len(), 2);
    let mut changed = Vec::new();
    for (index, mut row) in rows.into_iter().enumerate() {
        if index == 0 {
            row.content_hash = "cccccccccccccccc".to_owned();
        } else {
            row.embed_input_hash = "eeeeeeeeeeeeeeee".to_owned();
        }
        row.vector = Some(vec![0.25; 8]);
        changed.push(row);
    }
    fixture
        .env
        .store
        .upsert(table(&fixture), changed)
        .await
        .expect("覆盖两行");

    let report = verify(&fixture).await;
    assert_eq!(report.stale_in_store, 2, "{report:?}");
    assert_eq!(report.missing_in_store, 0);
    assert_eq!(report.orphans_in_store, 0);
    assert_eq!(report.store_rows, report.meta_rows, "行数一样,差异只在哈希");
    let divergence = report.files["src/beta.rs"];
    assert_eq!((divergence.missing, divergence.stale), (0, 2));
    assert_eq!(report.files.len(), 1);
}

#[tokio::test]
async fn rows_unknown_to_the_metadata_are_orphans_that_are_reported_but_left_alone() {
    let fixture = standard_fixture().await;
    let before = verify(&fixture).await;
    let mut orphan = fixture
        .env
        .store
        .get(
            table(&fixture),
            &store_ids_of(&fixture, "src/beta.rs").await[..1],
        )
        .await
        .expect("取行")
        .remove(0);
    orphan.id = format!("{:032x}", 0xdead_beef_u64);
    orphan.source = "src/ghost.rs".to_owned();
    orphan.vector = Some(vec![0.5; 8]);
    fixture
        .env
        .store
        .upsert(table(&fixture), vec![orphan])
        .await
        .expect("写孤儿");

    let report = verify(&fixture).await;
    assert_eq!(report.orphans_in_store, 1, "{report:?}");
    assert_eq!(report.store_rows, before.store_rows + 1);
    assert_eq!(report.missing_in_store + report.stale_in_store, 0);
    assert!(report.files.is_empty(), "孤儿不进「有差异的文件」");
    assert!(!report.is_clean());
    // 只报告不处理:孤儿还在
    assert_eq!(store_ids_of(&fixture, "src/ghost.rs").await.len(), 1);
}

/// 只实现必需方法的存储替身:没有覆盖 `list_fingerprints`,用的就是 trait 的默认实现(返回错误)。
struct NoFingerprintStore {
    inner: Arc<dyn VectorStore>,
}

#[async_trait]
impl VectorStore for NoFingerprintStore {
    async fn ensure_table(&self, table: &str, dim: usize) -> Result<()> {
        self.inner.ensure_table(table, dim).await
    }
    async fn upsert(&self, table: &str, rows: Vec<RecordRow>) -> Result<()> {
        self.inner.upsert(table, rows).await
    }
    async fn update_meta(&self, table: &str, id: &str, patch: MetaPatch) -> Result<()> {
        self.inner.update_meta(table, id, patch).await
    }
    async fn delete_ids(&self, table: &str, ids: &[String]) -> Result<()> {
        self.inner.delete_ids(table, ids).await
    }
    async fn get(&self, table: &str, ids: &[String]) -> Result<Vec<RecordRow>> {
        self.inner.get(table, ids).await
    }
    async fn search(&self, table: &str, req: &StoreQuery) -> Result<Vec<StoreHit>> {
        self.inner.search(table, req).await
    }
    async fn list(&self, table: &str, query: &ListQuery) -> Result<Vec<RecordRow>> {
        self.inner.list(table, query).await
    }
    async fn count(&self, table: &str, filter: Option<&str>) -> Result<u64> {
        self.inner.count(table, filter).await
    }
    async fn optimize(&self, table: &str) -> Result<()> {
        self.inner.optimize(table).await
    }
    async fn ensure_fts_index(&self, table: &str) -> Result<()> {
        self.inner.ensure_fts_index(table).await
    }
    async fn ensure_vector_index(&self, table: &str) -> Result<()> {
        self.inner.ensure_vector_index(table).await
    }
    async fn drop_table(&self, table: &str) -> Result<()> {
        self.inner.drop_table(table).await
    }
}

#[tokio::test]
async fn a_store_without_fingerprints_still_finds_missing_rows_but_skips_the_stale_check() {
    let fixture = standard_fixture().await;
    // 先在真实存储上造一个缺失、一个过期
    wipe_from_store(&fixture, "src/alpha.rs").await;
    let beta = store_ids_of(&fixture, "src/beta.rs").await;
    let mut row = fixture
        .env
        .store
        .get(table(&fixture), &beta[..1])
        .await
        .expect("取行")
        .remove(0);
    row.content_hash = "0000".to_owned();
    row.vector = Some(vec![0.1; 8]);
    fixture
        .env
        .store
        .upsert(table(&fixture), vec![row])
        .await
        .expect("改哈希");

    // 换一个不支持指纹的替身再校验
    let plain: Arc<dyn VectorStore> = Arc::new(NoFingerprintStore {
        inner: fixture.env.store.clone(),
    });
    assert!(
        matches!(
            plain.list_fingerprints(table(&fixture), None).await,
            Err(KbError::Internal(_))
        ),
        "默认实现应返回错误,这样现有替身才不用改"
    );
    let index = IndexService::new(
        fixture.env.meta.clone(),
        plain,
        fixture.env.embedder.clone(),
        fixture.env.chunker.clone(),
        fixture.env.scanner.clone(),
        IndexOptions::default(),
    );
    let report = index
        .verify_chunks(&fixture.collection)
        .await
        .expect("不支持指纹不算失败")
        .expect("闸门空闲");
    assert!(report.stale_unchecked);
    assert_eq!(report.missing_in_store, 3, "缺失照样查得出来:{report:?}");
    assert_eq!(report.stale_in_store, 0, "过期检测被跳过");
    assert_eq!(report.orphans_in_store, 0);
    assert_eq!(
        report.files.keys().map(String::as_str).collect::<Vec<_>>(),
        ["src/alpha.rs"]
    );
}

#[tokio::test]
async fn verify_returns_none_while_an_index_slice_holds_the_gate() {
    let fixture = standard_fixture().await;
    wipe_from_store(&fixture, "src/alpha.rs").await;

    let writer = fixture.index.write_gate().writer().await;
    assert!(
        fixture
            .index
            .verify_chunks(&fixture.collection)
            .await
            .expect("拿不到闸门不是错误")
            .is_none(),
        "有索引分片在写时必须拿不到,否则会把写到一半的状态误判成差异"
    );
    drop(writer);
    let report = fixture
        .index
        .verify_chunks(&fixture.collection)
        .await
        .expect("校验")
        .expect("闸门释放后应拿得到");
    assert_eq!(report.missing_in_store, 3);
}

// ---------------------------------------------------------------------------------------------
// invalidate_files
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn invalidate_then_incremental_index_rebuilds_a_file_the_skip_path_would_never_fix() {
    let fixture = standard_fixture().await;
    let query = "kind:code alpha_unique_marker_first";
    assert!(
        search_finds(&fixture, query, "src/alpha.rs").await,
        "前置:索引完应能搜到"
    );
    assert_eq!(wipe_from_store(&fixture, "src/alpha.rs").await, 3);
    assert!(
        !search_finds(&fixture, query, "src/alpha.rs").await,
        "前置:向量库里没了就搜不到"
    );

    // 对照(这就是生产上的现象):文件没变、元数据有块,增量索引直接 skip,缺口补不上
    let entry = fixture
        .index
        .scan_project(&fixture.project)
        .expect("扫描")
        .files
        .into_iter()
        .find(|entry| entry.relative == "src/alpha.rs")
        .expect("alpha 在磁盘上");
    let stats = fixture
        .index
        .index_entry(&fixture.project, &fixture.collection, &entry)
        .await
        .expect("增量索引");
    assert_eq!(stats.embedded, 0, "文件哈希没变,直接 skip");
    assert!(store_ids_of(&fixture, "src/alpha.rs").await.is_empty());
    assert_eq!(verify(&fixture).await.missing_in_store, 3, "缺口仍在");

    // 失效 → 重建
    let others_before = (
        meta_count_of(&fixture, "src/beta.rs").await,
        meta_count_of(&fixture, "src/alpha.rs.txt").await,
        meta_count_of(&fixture, "docs/guide.md").await,
        store_ids_of(&fixture, "src/alpha.rs.txt").await,
    );
    let cleared = fixture
        .index
        .invalidate_files(&fixture.collection, &["src/alpha.rs".to_owned()])
        .await
        .expect("失效");
    assert_eq!(cleared, 1);
    assert_eq!(
        meta_count_of(&fixture, "src/alpha.rs").await,
        0,
        "元数据块清空"
    );
    assert!(
        FileRepo::get(fixture.env.meta.as_ref(), "proj_demo", "src/alpha.rs")
            .await
            .expect("读 files")
            .is_none(),
        "files 行删掉,下次才不会走哈希 skip"
    );
    // 其它文件一个字节都没动,包括路径前缀相同的 alpha.rs.txt
    assert_eq!(
        others_before,
        (
            meta_count_of(&fixture, "src/beta.rs").await,
            meta_count_of(&fixture, "src/alpha.rs.txt").await,
            meta_count_of(&fixture, "docs/guide.md").await,
            store_ids_of(&fixture, "src/alpha.rs.txt").await,
        )
    );
    assert!(!store_ids_of(&fixture, "src/beta.rs").await.is_empty());
    assert!(
        verify(&fixture).await.is_clean(),
        "失效后两边都没有 alpha,互相一致"
    );

    // 排增量任务重建:只有 alpha 重新嵌入
    fixture.env.fake.reset_count();
    kb_service::jobs::JobQueue::new(fixture.env.meta.clone())
        .enqueue(kb_service::jobs::NewJob::incremental_index(
            "p1",
            "proj_demo",
            &["src/alpha.rs".to_owned()],
        ))
        .await
        .expect("入队");
    run_queued_jobs(&fixture).await;

    assert_eq!(fixture.env.fake.embedding_count(), 3, "只重嵌 alpha 的三块");
    assert_eq!(store_ids_of(&fixture, "src/alpha.rs").await.len(), 3);
    assert_eq!(meta_count_of(&fixture, "src/alpha.rs").await, 3);
    let report = verify(&fixture).await;
    assert!(report.is_clean(), "重建后再次校验应干净:{report:?}");
    assert!(
        search_finds(&fixture, query, "src/alpha.rs").await,
        "重建后能搜到"
    );
}

#[tokio::test]
async fn invalidate_removes_every_code_or_doc_row_of_the_path_but_nothing_else() {
    let fixture = standard_fixture().await;
    let alpha_ids = store_ids_of(&fixture, "src/alpha.rs").await;
    // 该路径下还有一行元数据不认识的代码块(没登记完的残留),以及一行同 source 的洞察
    let mut template = fixture
        .env
        .store
        .get(table(&fixture), &alpha_ids[..1])
        .await
        .expect("取行")
        .remove(0);
    template.vector = Some(vec![0.5; 8]);
    let mut leftover = template.clone();
    leftover.id = format!("{:032x}", 0xabc_u64);
    let mut insight = template;
    insight.id = format!("{:032x}", 0xdef_u64);
    insight.kind = RecordKind::Insight;
    insight.status = ItemStatus::Active;
    fixture
        .env
        .store
        .upsert(table(&fixture), vec![leftover.clone(), insight.clone()])
        .await
        .expect("写入残留与洞察");

    fixture
        .index
        .invalidate_files(&fixture.collection, &["src/alpha.rs".to_owned()])
        .await
        .expect("失效");

    let remaining = store_ids_of(&fixture, "src/alpha.rs").await;
    assert_eq!(
        remaining,
        [insight.id.clone()],
        "向量库里元数据不认识的 code 行也要清掉;别的种类(洞察)不归索引管,不能动"
    );
}

#[tokio::test]
async fn invalidate_ignores_duplicate_and_unknown_paths_and_empty_input() {
    let fixture = standard_fixture().await;
    assert_eq!(
        fixture
            .index
            .invalidate_files(&fixture.collection, &[])
            .await
            .expect("空"),
        0
    );
    let cleared = fixture
        .index
        .invalidate_files(
            &fixture.collection,
            &[
                "src/alpha.rs".to_owned(),
                "src/alpha.rs".to_owned(),
                "src/never-indexed.rs".to_owned(),
            ],
        )
        .await
        .expect("失效");
    assert_eq!(cleared, 2, "重复路径只算一次;不存在的路径无害地计入处理");
    assert!(verify(&fixture).await.is_clean());
    assert!(!store_ids_of(&fixture, "src/beta.rs").await.is_empty());
}

#[tokio::test]
async fn invalidate_does_not_touch_the_path_with_a_quote_in_it() {
    // 路径只用来比较,不拼进 SQL:带单引号的路径既不报错,也不会误伤别的文件
    let fixture = standard_fixture().await;
    let before = verify(&fixture).await;
    let cleared = fixture
        .index
        .invalidate_files(&fixture.collection, &["src/o'brien.rs".to_owned()])
        .await
        .expect("失效");
    assert_eq!(cleared, 1);
    assert_eq!(verify(&fixture).await, before);
}

#[tokio::test]
async fn invalidate_refuses_while_the_gate_is_busy_and_changes_nothing() {
    let fixture = standard_fixture().await;
    let before = verify(&fixture).await;
    let writer = fixture.index.write_gate().writer().await;
    let err = fixture
        .index
        .invalidate_files(&fixture.collection, &["src/alpha.rs".to_owned()])
        .await
        .expect_err("闸门被占着不能动手");
    assert!(matches!(err, KbError::Unavailable(_)), "{err:?}");
    drop(writer);
    assert_eq!(verify(&fixture).await, before, "什么都没动");
    assert_eq!(meta_count_of(&fixture, "src/alpha.rs").await, 3);
}

// ---------------------------------------------------------------------------------------------
// 夜间自愈
// ---------------------------------------------------------------------------------------------

/// 用例里的时间按北京时间理解(全站默认时区)。
fn at(hour: u32, minute: u32) -> DateTime<Utc> {
    FixedOffset::east_opt(8 * 3600)
        .unwrap()
        .with_ymd_and_hms(2026, 10, 20, hour, minute, 0)
        .unwrap()
        .with_timezone(&Utc)
}

fn scheduler_for(fixture: &Fixture, clock_at: DateTime<Utc>) -> Scheduler {
    Scheduler::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.index.clone(),
        ScheduleOptions {
            nightly_at: "03:00".to_owned(),
            optimize_interval_minutes: 60,
            ..ScheduleOptions::default()
        },
        Arc::new(FixedClock::new(clock_at)),
    )
}

#[tokio::test]
async fn nightly_on_a_clean_index_verifies_and_changes_nothing() {
    let fixture = standard_fixture().await;
    let report = scheduler_for(&fixture, at(3, 5))
        .nightly()
        .await
        .expect("夜间校验");
    assert_eq!(report.verified_collections, 1, "{report:?}");
    assert_eq!(report.divergent_files, 0);
    assert_eq!(report.repaired_files, 0);
    assert_eq!(report.resynced, 0);
    assert!(
        queued_paths(&fixture).await.is_empty(),
        "没有差异就不排任务"
    );
}

#[tokio::test]
async fn nightly_repairs_a_file_missing_from_the_store_and_queues_its_rebuild() {
    let fixture = standard_fixture().await;
    wipe_from_store(&fixture, "src/alpha.rs").await;
    let query = "kind:code alpha_unique_marker_second";
    assert!(!search_finds(&fixture, query, "src/alpha.rs").await, "前置");

    let report = scheduler_for(&fixture, at(3, 5))
        .nightly()
        .await
        .expect("夜间校验");
    assert_eq!(report.verified_collections, 1, "{report:?}");
    assert_eq!(report.divergent_files, 1);
    assert_eq!(report.repaired_files, 1);
    assert_eq!(report.resynced, 0, "磁盘上没有改动,不是指纹校验投递的");
    assert_eq!(
        queued_paths(&fixture).await,
        vec![vec!["src/alpha.rs".to_owned()]],
        "只为这一个文件排增量任务"
    );
    // 其余文件原样
    assert!(!store_ids_of(&fixture, "src/beta.rs").await.is_empty());
    assert_eq!(meta_count_of(&fixture, "src/beta.rs").await, 3);

    // 把任务跑完:恢复、一致、搜得到
    run_queued_jobs(&fixture).await;
    assert!(verify(&fixture).await.is_clean());
    assert_eq!(store_ids_of(&fixture, "src/alpha.rs").await.len(), 3);
    assert!(search_finds(&fixture, query, "src/alpha.rs").await);

    // 第二晚:没有差异了
    let again = scheduler_for(&fixture, at(3, 5))
        .nightly()
        .await
        .expect("第二晚");
    assert_eq!((again.divergent_files, again.repaired_files), (0, 0));
    assert!(queued_paths(&fixture).await.is_empty());
}

#[tokio::test]
async fn nightly_repairs_a_stale_chunk_too() {
    let fixture = standard_fixture().await;
    let beta = store_ids_of(&fixture, "src/beta.rs").await;
    let mut row = fixture
        .env
        .store
        .get(table(&fixture), &beta[..1])
        .await
        .expect("取行")
        .remove(0);
    row.content_hash = "stale".to_owned();
    row.embed_input_hash = "stale".to_owned();
    row.vector = Some(vec![0.1; 8]);
    fixture
        .env
        .store
        .upsert(table(&fixture), vec![row])
        .await
        .expect("改成旧哈希");

    let report = scheduler_for(&fixture, at(3, 5))
        .nightly()
        .await
        .expect("夜间校验");
    assert_eq!((report.divergent_files, report.repaired_files), (1, 1));
    run_queued_jobs(&fixture).await;
    assert!(verify(&fixture).await.is_clean(), "重建后哈希重新对上");
}

/// 造 `total` 个各只有一块的小文件,索引完。
async fn many_single_chunk_files(total: usize) -> Fixture {
    let files: Vec<(String, String)> = (0..total)
        .map(|n| {
            (
                format!("src/f{n:03}.rs"),
                format!("pub fn only_{n}() -> u32 {{\n    {n}\n}}\n"),
            )
        })
        .collect();
    let borrowed: Vec<(&str, String)> = files
        .iter()
        .map(|(path, content)| (path.as_str(), content.clone()))
        .collect();
    fixture(&borrowed).await
}

#[tokio::test]
async fn nightly_refuses_to_repair_a_divergence_above_the_guard() {
    // 60 个文件各 1 块:阈值 = max(50, 60 × 20%) = 50。擦掉 55 个 → 55 > 50,判定为恢复备份或换库
    let fixture = many_single_chunk_files(60).await;
    assert_eq!(verify(&fixture).await.meta_rows, 60, "前置:每个文件一块");
    for n in 0..55 {
        wipe_from_store(&fixture, &format!("src/f{n:03}.rs")).await;
    }

    let report = scheduler_for(&fixture, at(3, 5))
        .nightly()
        .await
        .expect("夜间校验");
    assert_eq!(report.verified_collections, 1);
    assert_eq!(report.divergent_files, 55, "差异照样如实报告");
    assert_eq!(report.repaired_files, 0, "超过护栏不能自动修:{report:?}");
    assert!(queued_paths(&fixture).await.is_empty(), "不排任务");
    // 一点都没动:元数据块、files 行都还在,缺口也还在
    let after = verify(&fixture).await;
    assert_eq!((after.meta_rows, after.missing_in_store), (60, 55));
    for n in 0..55 {
        let path = format!("src/f{n:03}.rs");
        assert!(
            FileRepo::get(fixture.env.meta.as_ref(), "proj_demo", &path)
                .await
                .unwrap()
                .is_some(),
            "{path} 的 files 行不能被删"
        );
    }
}

#[tokio::test]
async fn nightly_repairs_a_divergence_exactly_at_the_guard() {
    // 同样 60 块,擦掉 50 个:50 不大于 max(50, 12),照常修
    let fixture = many_single_chunk_files(60).await;
    for n in 0..50 {
        wipe_from_store(&fixture, &format!("src/f{n:03}.rs")).await;
    }
    let report = scheduler_for(&fixture, at(3, 5))
        .nightly()
        .await
        .expect("夜间校验");
    assert_eq!((report.divergent_files, report.repaired_files), (50, 50));
    assert_eq!(queued_paths(&fixture).await.len(), 1);
    run_queued_jobs(&fixture).await;
    assert!(verify(&fixture).await.is_clean());
}

#[tokio::test]
async fn nightly_repairs_at_most_200_files_per_collection_and_continues_the_next_night() {
    // 201 个各 1 块的文件 + 一篇有很多小节的文档撑大元数据块数,让 201 块的差异落在护栏之内
    // (阈值 = 总块数 × 20%),这样限制住修复数量的只能是「每晚 200 个文件」。
    let big_doc: String = (0..1200)
        .map(|n| format!("## 小节{n}\n\n小节{n}的内容,专门用来多凑一些块。\n\n"))
        .collect();
    let mut files: Vec<(String, String)> = (0..201)
        .map(|n| {
            (
                format!("src/f{n:03}.rs"),
                format!("pub fn only_{n}() -> u32 {{\n    {n}\n}}\n"),
            )
        })
        .collect();
    files.push(("docs/big.md".to_owned(), big_doc));
    let borrowed: Vec<(&str, String)> = files
        .iter()
        .map(|(path, content)| (path.as_str(), content.clone()))
        .collect();
    let fixture = fixture(&borrowed).await;
    let meta_rows = verify(&fixture).await.meta_rows;
    assert!(
        meta_rows >= 201 * 5,
        "前置:总块数要够大,201 块的差异才在护栏(20%)之内,实际 {meta_rows}"
    );
    for n in 0..201 {
        wipe_from_store(&fixture, &format!("src/f{n:03}.rs")).await;
    }

    let scheduler = scheduler_for(&fixture, at(3, 5));
    let first = scheduler.nightly().await.expect("第一晚");
    assert_eq!(first.divergent_files, 201, "{first:?}");
    assert_eq!(first.repaired_files, 200, "单晚最多 200 个文件");
    let jobs = queued_paths(&fixture).await;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].len(), 200);
    assert_eq!(jobs[0].first().map(String::as_str), Some("src/f000.rs"));
    assert_eq!(jobs[0].last().map(String::as_str), Some("src/f199.rs"));
    // 第 201 个没碰:files 行还在
    assert!(
        FileRepo::get(fixture.env.meta.as_ref(), "proj_demo", "src/f200.rs")
            .await
            .unwrap()
            .is_some()
    );

    // 任务跑完后只剩一个,第二晚接着修
    run_queued_jobs(&fixture).await;
    let second = scheduler_for(&fixture, at(3, 5))
        .nightly()
        .await
        .expect("第二晚");
    assert_eq!((second.divergent_files, second.repaired_files), (1, 1));
    assert_eq!(
        queued_paths(&fixture).await,
        vec![vec!["src/f200.rs".to_owned()]]
    );
    run_queued_jobs(&fixture).await;
    assert!(verify(&fixture).await.is_clean());
}

#[tokio::test]
async fn non_project_collections_are_reported_but_never_repaired() {
    let fixture = standard_fixture().await;
    let collections = CollectionService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    );
    let global = collections.ensure_global().await.expect("_global");
    // 往 _global 导入一篇文档,再把它的行从向量库里擦掉
    let doc = fixture.dir.path().join("docs/guide.md");
    fixture
        .index
        .index_global_path(&global, &doc, &[])
        .await
        .expect("导入");
    let ids: Vec<String> = fixture
        .env
        .store
        .list_slices(&global.active_table, None)
        .await
        .expect("列块")
        .into_iter()
        .map(|slice| slice.id)
        .collect();
    assert!(!ids.is_empty());
    fixture
        .env
        .store
        .delete_ids(&global.active_table, &ids)
        .await
        .expect("擦掉");

    let report = scheduler_for(&fixture, at(3, 5))
        .nightly()
        .await
        .expect("夜间校验");
    assert_eq!(
        report.verified_collections, 2,
        "项目集合与 _global 都校验了"
    );
    assert_eq!(
        report.divergent_files, 1,
        "_global 的差异如实报告:{report:?}"
    );
    assert_eq!(
        report.repaired_files, 0,
        "_global 没有项目可排增量任务,不修"
    );
    assert!(queued_paths(&fixture).await.is_empty());
    let still = fixture
        .index
        .verify_chunks(&global)
        .await
        .unwrap()
        .expect("闸门空闲");
    assert_eq!(still.missing_in_store, ids.len(), "什么都没动");
}

#[tokio::test]
async fn a_busy_gate_defers_verification_and_the_next_beat_finishes_it() {
    let fixture = standard_fixture().await;
    wipe_from_store(&fixture, "src/alpha.rs").await;
    // 固定在 10:00:第一拍会 optimize + 夜间校验;第二拍两者都不到点,只做每拍的补做
    let scheduler = scheduler_for(&fixture, at(10, 0));

    // 第一拍:有索引分片在写(占着读锁)→ 校验推后,什么都不能动
    let writer = fixture.index.write_gate().writer().await;
    let (plan, report) = scheduler.tick().await.expect("第一拍");
    assert!(plan.nightly);
    assert_eq!(
        report.verified_collections, 0,
        "拿不到闸门,不算校验过:{report:?}"
    );
    assert_eq!(report.repaired_files, 0);
    assert_eq!(meta_count_of(&fixture, "src/alpha.rs").await, 3, "没动");
    assert!(queued_paths(&fixture).await.is_empty());

    // 第二拍:闸门空出来了,推后的校验补做
    drop(writer);
    let (plan, _) = scheduler.tick().await.expect("第二拍");
    assert!(
        !plan.optimize && !plan.nightly,
        "这一拍只有补做,否则测不出重试"
    );
    assert_eq!(meta_count_of(&fixture, "src/alpha.rs").await, 0, "已失效");
    assert_eq!(
        queued_paths(&fixture).await,
        vec![vec!["src/alpha.rs".to_owned()]]
    );

    // 做成之后不再重复:再来一拍不会再排任务
    scheduler.tick().await.expect("第三拍");
    scheduler.retry_pending_verify().await;
    assert_eq!(queued_paths(&fixture).await.len(), 1, "待办已清空");

    run_queued_jobs(&fixture).await;
    assert!(verify(&fixture).await.is_clean());
}

// ---------------------------------------------------------------------------------------------
// 日志:夜间分步耗时与不一致告警
// ---------------------------------------------------------------------------------------------

/// 把 tracing 事件收进内存的最小订阅者(测试只用 `tracing` 本身,不引入 subscriber 依赖)。
#[derive(Clone, Default)]
struct Capture {
    events: Arc<Mutex<Vec<(tracing::Level, String)>>>,
}

struct Fields(String);

impl tracing::field::Visit for Fields {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.0.insert_str(0, &format!("{value:?}"));
        } else {
            self.0.push_str(&format!(" {}={value:?}", field.name()));
        }
    }
}

impl tracing::Subscriber for Capture {
    fn enabled(&self, _: &tracing::Metadata<'_>) -> bool {
        true
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(1)
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        let mut fields = Fields(String::new());
        event.record(&mut fields);
        self.events
            .lock()
            .unwrap()
            .push((*event.metadata().level(), fields.0));
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

#[tokio::test]
async fn nightly_logs_one_info_line_with_every_stage_timing_and_warns_about_divergence() {
    // 预热:tracing 的回调点(callsite)第一次执行时才登记并缓存「有没有订阅者感兴趣」。
    // 同一个测试进程里别的用例在并行跑同样的代码,登记恰好和下面的 set_default 撞上的话,
    // 缓存会漏掉本线程的订阅者,日志就抓不到。先在一份相同的夹具上不带订阅者跑一遍,
    // 让回调点都登记好,set_default 重算兴趣时就不会再被并发登记打断。
    let warm = standard_fixture().await;
    wipe_from_store(&warm, "src/alpha.rs").await;
    scheduler_for(&warm, at(3, 5))
        .nightly()
        .await
        .expect("预热");

    let fixture = standard_fixture().await;
    wipe_from_store(&fixture, "src/alpha.rs").await;
    let capture = Capture::default();
    let guard = tracing::subscriber::set_default(capture.clone());
    scheduler_for(&fixture, at(3, 5))
        .nightly()
        .await
        .expect("夜间校验");
    drop(guard);

    let events = capture.events.lock().unwrap().clone();
    let timing: Vec<&(tracing::Level, String)> = events
        .iter()
        .filter(|(_, message)| message.starts_with("夜间校验耗时"))
        .collect();
    assert_eq!(timing.len(), 1, "汇总只有一行:{events:#?}");
    assert_eq!(timing[0].0, tracing::Level::INFO);
    let line = &timing[0].1;
    for label in [
        "总计=",
        "指纹=",
        "建索引=",
        "去重=",
        "清理=",
        "门禁=",
        "一致性=",
    ] {
        let at = line
            .find(label)
            .unwrap_or_else(|| panic!("缺 {label}:{line}"));
        let digits: String = line[at + label.len()..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        assert!(!digits.is_empty(), "{label} 后面应是毫秒数:{line}");
        assert!(
            line[at + label.len() + digits.len()..].starts_with("ms"),
            "{line}"
        );
    }
    // 按执行顺序排列
    let positions: Vec<usize> = [
        "总计=",
        "指纹=",
        "建索引=",
        "去重=",
        "清理=",
        "门禁=",
        "一致性=",
    ]
    .iter()
    .map(|label| line.find(label).unwrap())
    .collect();
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]), "{line}");

    let warn = events
        .iter()
        .find(|(level, message)| {
            *level == tracing::Level::WARN && message.contains("元数据与向量库不一致")
        })
        .unwrap_or_else(|| panic!("应有一条不一致告警:{events:#?}"));
    for needle in [
        "proj_demo",
        "missing_chunks=3",
        "stale_chunks=0",
        "files=1",
        "src/alpha.rs",
    ] {
        assert!(warn.1.contains(needle), "告警里缺 {needle}:{}", warn.1);
    }
}

#[tokio::test]
async fn the_guard_warning_says_to_rebuild_by_hand() {
    // 预热原因见上一个日志用例
    let warm = many_single_chunk_files(60).await;
    for n in 0..55 {
        wipe_from_store(&warm, &format!("src/f{n:03}.rs")).await;
    }
    scheduler_for(&warm, at(3, 5))
        .nightly()
        .await
        .expect("预热");

    let fixture = many_single_chunk_files(60).await;
    for n in 0..55 {
        wipe_from_store(&fixture, &format!("src/f{n:03}.rs")).await;
    }
    let capture = Capture::default();
    let guard = tracing::subscriber::set_default(capture.clone());
    scheduler_for(&fixture, at(3, 5))
        .nightly()
        .await
        .expect("夜间校验");
    drop(guard);
    let events = capture.events.lock().unwrap().clone();
    assert!(
        events
            .iter()
            .any(|(level, message)| *level == tracing::Level::WARN
                && message.contains("差异过大,不自动修复,请人工重建索引")),
        "{events:#?}"
    );
}
