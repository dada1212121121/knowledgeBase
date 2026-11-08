//! 写闸门的**确定性**守卫。
//!
//! 按复核意见:此前的守卫依赖“连跑 40 次”这种概率性手段,不保证一次就红。
//! 这里改成直接持锁/注入错误,断言的是**因果**,不是时序巧合:
//!
//! 1. 持有 `gate.migration` 时,`index_project` / `index_global_path` /
//!    `IndexJobHandler::run_slice` 都拿不到读锁 → 一定不会完成;
//! 2. 拿着**切换前**的 collection 快照去写,行必须落在新的 active 表;
//! 3. `drop_table` 的非 `NotFound` 错误必须让迁移失败(不能当成“表不存在”忽略);
//! 4. `fill_missing` 的非 `NotFound` 错误必须写进 `MigrationReport::warnings`
//!    (切换已生效,不能回滚,但也不能只剩一行日志)。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use kb_core::model::{
    ChunkMeta, Collection, ItemStatus, MetaPatch, Project, RecordRow, StoreHit, StoreQuery,
};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::{ChunkRepo, CollectionRepo, ProjectRepo};
use kb_embed::FakeEmbedder;
use kb_service::migration::MigrationService;
use kb_service::write_gate::WriteGate;
use kb_service::{
    CollectionService, IndexJobHandler, IndexOptions, IndexService, JobHandler, JobQueue, NewJob,
};
use kb_testkit::TestEnv;
use tempfile::TempDir;

struct Fixture {
    env: TestEnv,
    #[allow(dead_code)]
    dir: TempDir,
    project: Project,
    collection: Collection,
    gate: WriteGate,
    index: Arc<IndexService>,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("项目");
    std::fs::write(dir.path().join("a.rs"), "fn a() -> u32 {\n    1\n}\n").expect("写文件");
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
        .expect("写项目");
    let collection =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone())
            .create_for_project("p1", "demo")
            .await
            .expect("建 collection");
    let gate = WriteGate::new();
    let index = Arc::new(
        IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            IndexOptions::default(),
        )
        .with_write_gate(gate.clone()),
    );
    index
        .index_project(&project, &collection)
        .await
        .expect("索引");
    Fixture {
        env,
        dir,
        project,
        collection,
        gate,
        index,
    }
}

/// 断言 `future` 在 `hold` 持写锁期间**不会**完成,放开之后能完成。
async fn assert_blocked_by_migration<T, F>(gate: &WriteGate, future: F) -> T
where
    T: Send + 'static,
    F: std::future::Future<Output = T> + Send + 'static,
{
    let guard = gate.migration().await;
    let mut task = tokio::spawn(future);
    // 200ms 足够让一个“没被挡住”的实现跑完(用例里都是 1 个文件)
    let blocked = tokio::time::timeout(Duration::from_millis(200), &mut task).await;
    assert!(
        blocked.is_err(),
        "迁移持写锁期间写路径不应完成(否则说明没拿读锁)"
    );
    drop(guard);
    tokio::time::timeout(Duration::from_secs(30), task)
        .await
        .expect("放开写锁后应能完成")
        .expect("任务不应 panic")
}

#[tokio::test]
async fn index_project_waits_for_the_migration_lock() {
    let fixture = fixture().await;
    let project = fixture.project.clone();
    let collection = fixture.collection.clone();
    let index = fixture.index.clone();
    assert_blocked_by_migration(&fixture.gate, async move {
        index
            .index_project(&project, &collection)
            .await
            .expect("索引");
    })
    .await;
}

#[tokio::test]
async fn index_global_path_waits_for_the_migration_lock() {
    let fixture = fixture().await;
    let collections = CollectionService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
    );
    let global = collections.ensure_global().await.expect("_global");
    let path = fixture.dir.path().join("a.rs");
    let index = fixture.index.clone();
    let global_for_task = global.clone();
    assert_blocked_by_migration(&fixture.gate, async move {
        index
            .index_global_path(&global_for_task, &path, &[])
            .await
            .expect("全局导入");
    })
    .await;
    // 放开之后真的写进去了
    let rows = fixture
        .env
        .store
        .count(&global.active_table, None)
        .await
        .expect("数行");
    assert!(rows > 0, "_global 应已有行");
}

#[tokio::test]
async fn index_job_slice_waits_for_the_migration_lock() {
    let fixture = fixture().await;
    let queue = JobQueue::new(fixture.env.meta.clone());
    let job = queue
        .enqueue(NewJob::full_index(
            &fixture.project.id,
            &fixture.collection.name,
        ))
        .await
        .expect("入队");
    let job = queue.start(&job).await.expect("开始");
    let handler = IndexJobHandler::new(fixture.index.clone(), fixture.env.meta.clone(), 50);
    let handler = Arc::new(handler);
    let job_for_task = job.clone();
    let progress = assert_blocked_by_migration(&fixture.gate, async move {
        handler.run_slice(&job_for_task).await.expect("跑分片")
    })
    .await;
    assert!(
        progress.done > 0 || progress.finished,
        "分片应真的执行了:{progress:?}"
    );
    assert!(
        progress.checkpoint.is_some() || progress.finished,
        "分片应给出检查点:{progress:?}"
    );
}

#[tokio::test]
async fn optimize_waits_for_the_migration_lock() {
    // optimize 会压数据文件、清旧版本,属于 Lance 写路径;迁移持写锁时必须排队,
    // 否则压缩和「切换 active 表」并发,可能把行整理回退役表。
    let fixture = fixture().await;
    let collection = fixture.collection.clone();
    let index = fixture.index.clone();
    assert_blocked_by_migration(&fixture.gate, async move {
        index.optimize(&collection).await.expect("整理");
    })
    .await;
}

#[tokio::test]
async fn ensure_indexes_waits_for_the_migration_lock() {
    // 建 FTS / 向量索引同样是写操作:必须和迁移互斥,且先拿锁再读 active 表。
    let fixture = fixture().await;
    let collection = fixture.collection.clone();
    let index = fixture.index.clone();
    assert_blocked_by_migration(&fixture.gate, async move {
        index.ensure_indexes(&collection).await.expect("建索引");
    })
    .await;
}

#[tokio::test]
async fn a_stale_collection_snapshot_still_writes_the_new_table() {
    // 第 2 条:调用方手里的快照指向切换前的表,写路径必须重新读 active_table
    let fixture = fixture().await;
    let stale = fixture.collection.clone();
    let old_table = stale.active_table.clone();

    MigrationService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
    )
    .with_write_gate(fixture.gate.clone())
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect("迁移");

    let current = CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("读 collection")
        .expect("存在");
    assert_ne!(current.active_table, old_table, "迁移应切换了 active 表");

    // 加一个文件,然后用**旧快照**索引
    std::fs::write(
        fixture.dir.path().join("b.rs"),
        "fn b() -> u32 {\n    2\n}\n",
    )
    .expect("写文件");
    // 迁移后进程用的是**新**嵌入器(真实场景是改配置 + 重启),这里换成 16 维
    let index16 = IndexService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(FakeEmbedder::new(16)),
        fixture.env.chunker.clone(),
        fixture.env.scanner.clone(),
        IndexOptions::default(),
    )
    .with_write_gate(fixture.gate.clone());
    let report = index16
        .index_project(&fixture.project, &stale)
        .await
        .expect("用旧快照索引");
    assert!(
        report.errors.is_empty(),
        "索引不应报错:{:?}(report: {report:?})",
        report.errors
    );
    assert!(report.chunks >= 1, "应有块被写入:{report:?}");
    assert!(report.embedded >= 1, "新嵌入器下应至少重嵌 1 块:{report:?}");

    let new_rows = fixture
        .env
        .store
        .count(&current.active_table, None)
        .await
        .expect("数新表");
    assert!(
        new_rows >= 2,
        "新文件应写进新表(实际 {new_rows} 行,旧表是 {old_table})"
    );
    let chunk_ids: Vec<String> = ChunkRepo::ids_after(
        fixture.env.meta.as_ref(),
        &fixture.collection.name,
        None,
        100,
    )
    .await
    .expect("列块")
    .into_iter()
    .map(|chunk| chunk.id)
    .collect();
    let in_new = fixture
        .env
        .store
        .get(&current.active_table, &chunk_ids)
        .await
        .expect("读新表");
    assert_eq!(
        in_new.len(),
        chunk_ids.len(),
        "所有块都应在新表里(不能写回旧表)"
    );
}

/// 可注入故障的存储:只为 `drop_table` / `get` 制造非 `NotFound` 错误。
struct FaultyStore {
    inner: Arc<dyn VectorStore>,
    fail_drop_table: bool,
    /// `get` 对表名包含这个片段的表返回 `Internal`。
    fail_get_containing: Option<String>,
}

#[async_trait]
impl VectorStore for FaultyStore {
    async fn ensure_table(&self, table: &str, dim: usize) -> kb_core::Result<()> {
        self.inner.ensure_table(table, dim).await
    }
    async fn upsert(&self, table: &str, rows: Vec<RecordRow>) -> kb_core::Result<()> {
        self.inner.upsert(table, rows).await
    }
    async fn update_meta(&self, table: &str, id: &str, patch: MetaPatch) -> kb_core::Result<()> {
        self.inner.update_meta(table, id, patch).await
    }
    async fn delete_ids(&self, table: &str, ids: &[String]) -> kb_core::Result<()> {
        self.inner.delete_ids(table, ids).await
    }
    async fn get(&self, table: &str, ids: &[String]) -> kb_core::Result<Vec<RecordRow>> {
        if let Some(fragment) = &self.fail_get_containing
            && table.contains(fragment.as_str())
        {
            return Err(kb_core::KbError::Internal(format!(
                "注入的读表故障: {table}"
            )));
        }
        self.inner.get(table, ids).await
    }
    async fn search(&self, table: &str, req: &StoreQuery) -> kb_core::Result<Vec<StoreHit>> {
        self.inner.search(table, req).await
    }
    async fn list(
        &self,
        table: &str,
        query: &kb_core::model::ListQuery,
    ) -> kb_core::Result<Vec<RecordRow>> {
        self.inner.list(table, query).await
    }
    async fn count(&self, table: &str, filter: Option<&str>) -> kb_core::Result<u64> {
        self.inner.count(table, filter).await
    }
    async fn optimize(&self, table: &str) -> kb_core::Result<()> {
        self.inner.optimize(table).await
    }
    async fn ensure_fts_index(&self, table: &str) -> kb_core::Result<()> {
        self.inner.ensure_fts_index(table).await
    }
    async fn ensure_vector_index(&self, table: &str) -> kb_core::Result<()> {
        self.inner.ensure_vector_index(table).await
    }
    async fn drop_table(&self, table: &str) -> kb_core::Result<()> {
        if self.fail_drop_table {
            return Err(kb_core::KbError::Internal(format!(
                "注入的删表故障: {table}"
            )));
        }
        self.inner.drop_table(table).await
    }
}

#[tokio::test]
async fn drop_table_errors_other_than_not_found_abort_the_resume() {
    // 第 3 条:续跑时要重建目标表;删表失败(非 NotFound)必须让迁移失败,
    // 否则会往半成品表里继续写
    let fixture = fixture().await;
    let mut collection = fixture.collection.clone();
    // 库里已有 migrating_to → 走续跑分支(会先 drop 目标表)
    collection.migrating_to = Some(format!("{}__fake_16__v2", collection.name));
    collection.migration_started_at = Some(1_700_000_000_000);
    CollectionRepo::update(fixture.env.meta.as_ref(), collection.clone())
        .await
        .expect("写回 collection");

    let store: Arc<dyn VectorStore> = Arc::new(FaultyStore {
        inner: fixture.env.store.clone(),
        fail_drop_table: true,
        fail_get_containing: None,
    });
    let error = MigrationService::new(
        fixture.env.meta.clone(),
        store,
        Arc::new(FakeEmbedder::new(16)),
    )
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect_err("删表失败应中止迁移");
    assert!(
        matches!(error, kb_core::KbError::Internal(_)),
        "应是 Internal:{error:?}"
    );
    // 没有切换
    let current = CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("读")
        .expect("存在");
    assert_eq!(current.active_table, fixture.collection.active_table);
}

#[tokio::test]
async fn fill_missing_failures_are_reported_in_warnings() {
    // 第 4 条:切换之后才发现的问题写进 warnings(不能只剩一行日志)
    let fixture = fixture().await;
    let store: Arc<dyn VectorStore> = Arc::new(FaultyStore {
        inner: fixture.env.store.clone(),
        fail_drop_table: false,
        // 新表名里带 fake_16;旧表是 fake8,不受影响
        fail_get_containing: Some("fake_16".to_owned()),
    });
    let report = MigrationService::new(
        fixture.env.meta.clone(),
        store,
        Arc::new(FakeEmbedder::new(16)),
    )
    .run(&fixture.collection.name, "fake:16", None)
    .await
    .expect("切换已生效,迁移本身应返回 Ok");
    assert!(
        report
            .warnings
            .iter()
            .any(|warning| warning.contains("补齐")),
        "补齐失败要写进 warnings:{report:?}"
    );
    let current = CollectionRepo::get(fixture.env.meta.as_ref(), &fixture.collection.name)
        .await
        .expect("读")
        .expect("存在");
    assert_ne!(
        current.active_table, fixture.collection.active_table,
        "即使补齐失败,切换也已经生效"
    );
}

/// 让 `chunk` 相关的编译期引用不被优化掉(保持与其它用例一致的导入集合)。
#[allow(dead_code)]
fn _types_are_used(_: ChunkMeta, _: ItemStatus) {}
