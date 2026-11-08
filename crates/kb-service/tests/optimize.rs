//! `optimize_after_rows` 必须被读取并真的调用 `optimize`。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Collection, MetaPatch, Project, RecordRow, StoreHit, StoreQuery};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::ProjectRepo;
use kb_service::jobs::{IndexJobHandler, JobQueue, NewJob, Worker};
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tokio::sync::watch;

/// 包一层,统计 `optimize` 被调用的次数。
struct CountingStore {
    inner: Arc<dyn VectorStore>,
    optimizes: Arc<AtomicUsize>,
}

#[async_trait]
impl VectorStore for CountingStore {
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
    async fn list(
        &self,
        table: &str,
        query: &kb_core::model::ListQuery,
    ) -> Result<Vec<kb_core::model::RecordRow>> {
        self.inner.list(table, query).await
    }
    async fn count(&self, table: &str, filter: Option<&str>) -> Result<u64> {
        self.inner.count(table, filter).await
    }
    async fn optimize(&self, table: &str) -> Result<()> {
        self.optimizes.fetch_add(1, Ordering::SeqCst);
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
async fn optimize_is_called_after_the_configured_number_of_rows() {
    let env = TestEnv::new().await;
    let dir = tempfile::tempdir().expect("项目目录");
    for index in 0..6 {
        let path = dir.path().join(format!("src/f{index}.rs"));
        std::fs::create_dir_all(path.parent().expect("父目录")).expect("建目录");
        std::fs::write(&path, format!("fn f{index}() -> u32 {{\n    {index}\n}}\n")).expect("写");
    }
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
        .expect("项目行");
    let collection: Collection =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
            .create_for_project("p1", "demo")
            .await
            .expect("collection");

    let optimizes = Arc::new(AtomicUsize::new(0));
    let counting: Arc<dyn VectorStore> = Arc::new(CountingStore {
        inner: env.store.clone(),
        optimizes: optimizes.clone(),
    });
    let service = Arc::new(IndexService::new(
        env.meta.clone(),
        counting,
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions {
            // 6 个文件各 1 块,每 2 块整理一次
            optimize_after_rows: 2,
            ..IndexOptions::default()
        },
    ));
    let queue = Arc::new(JobQueue::new(env.meta.clone()));
    queue
        .enqueue(NewJob::full_index("p1", &collection.name))
        .await
        .expect("入队");
    let handler = Arc::new(IndexJobHandler::new(service, env.meta.clone(), 1));
    let worker = Worker::new(queue.clone(), handler, watch::channel(false).1);
    while worker.run_once().await.expect("跑").is_some() {}

    let calls = optimizes.load(Ordering::SeqCst);
    assert!(
        calls >= 3,
        "每 2 块整理一次 + 任务结束一次,至少应调用 3 次,实际 {calls}"
    );
}

/// 保存一个文件触发的增量任务只写几行,任务结束时不该再整理一遍:
/// 整理交给累计行数阈值和定时调度,否则每次保存都会重写一遍大表。
/// 全量任务不受影响,仍在结束时整理(见上一条测试)。
#[tokio::test]
async fn a_small_incremental_job_does_not_optimize_at_the_end() {
    let env = TestEnv::new().await;
    let dir = tempfile::tempdir().expect("项目目录");
    for index in 0..4 {
        let path = dir.path().join(format!("src/f{index}.rs"));
        std::fs::create_dir_all(path.parent().expect("父目录")).expect("建目录");
        std::fs::write(&path, format!("fn f{index}() -> u32 {{\n    {index}\n}}\n")).expect("写");
    }
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
        .expect("项目行");
    let collection: Collection =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
            .create_for_project("p1", "demo")
            .await
            .expect("collection");

    let optimizes = Arc::new(AtomicUsize::new(0));
    let counting: Arc<dyn VectorStore> = Arc::new(CountingStore {
        inner: env.store.clone(),
        optimizes: optimizes.clone(),
    });
    let service = Arc::new(IndexService::new(
        env.meta.clone(),
        counting,
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        // 阈值取默认值(2000 行):几行改动远远达不到
        IndexOptions::default(),
    ));
    let queue = Arc::new(JobQueue::new(env.meta.clone()));
    let handler = Arc::new(IndexJobHandler::new(service, env.meta.clone(), 50));
    let worker = Worker::new(queue.clone(), handler, watch::channel(false).1);

    // 先全量建一遍索引:结束时整理一次是预期内的
    queue
        .enqueue(NewJob::full_index("p1", &collection.name))
        .await
        .expect("入队全量");
    while worker.run_once().await.expect("跑全量").is_some() {}
    let after_full = optimizes.load(Ordering::SeqCst);
    assert!(after_full >= 1, "全量任务结束时应整理,实际 {after_full}");

    // 改一个文件,只跑这个文件的增量任务
    std::fs::write(
        dir.path().join("src/f1.rs"),
        "fn f1() -> u32 {\n    4242\n}\n",
    )
    .expect("改文件");
    queue
        .enqueue(NewJob::incremental_index(
            "p1",
            &collection.name,
            &["src/f1.rs".to_owned()],
        ))
        .await
        .expect("入队增量");
    while worker.run_once().await.expect("跑增量").is_some() {}

    assert_eq!(
        optimizes.load(Ordering::SeqCst),
        after_full,
        "几行的增量任务结束时不该再调用 optimize"
    );
}
