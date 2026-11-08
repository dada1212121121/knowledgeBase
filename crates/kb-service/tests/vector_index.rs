//! H3:行数达到 `vector_index_min_rows` 才自动建向量索引,低于阈值不建(暴力扫描更划算)。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{
    Collection, CollectionKind, ContextMode, MetaPatch, RecordRow, StoreHit, StoreQuery,
};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::CollectionRepo;
use kb_service::{IndexOptions, IndexService};
use kb_testkit::TestEnv;

/// 包一层:`count` 返回设定的行数,并统计两种 `ensure_*_index` 被调用的次数。
/// 其余全部转给真实存储。不真的去建索引:几行假数据训练不了 IVF,这里只验证接线。
struct Probe {
    inner: Arc<dyn VectorStore>,
    rows: u64,
    fts_calls: Arc<AtomicUsize>,
    vector_calls: Arc<AtomicUsize>,
    vector_fails: bool,
}

#[async_trait]
impl VectorStore for Probe {
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
    async fn list(&self, table: &str, query: &kb_core::model::ListQuery) -> Result<Vec<RecordRow>> {
        self.inner.list(table, query).await
    }
    async fn list_slices(
        &self,
        table: &str,
        filter: Option<&str>,
    ) -> Result<Vec<kb_core::model::FileSlice>> {
        self.inner.list_slices(table, filter).await
    }
    async fn list_files(
        &self,
        table: &str,
        filter: Option<&str>,
    ) -> Result<Arc<Vec<kb_core::model::FileEntry>>> {
        self.inner.list_files(table, filter).await
    }
    async fn count(&self, _table: &str, _filter: Option<&str>) -> Result<u64> {
        Ok(self.rows)
    }
    async fn optimize(&self, table: &str) -> Result<()> {
        self.inner.optimize(table).await
    }
    async fn ensure_fts_index(&self, _table: &str) -> Result<()> {
        self.fts_calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn ensure_vector_index(&self, _table: &str) -> Result<()> {
        self.vector_calls.fetch_add(1, Ordering::SeqCst);
        if self.vector_fails {
            return Err(kb_core::KbError::Internal("训练失败(测试)".to_owned()));
        }
        Ok(())
    }
    async fn drop_table(&self, table: &str) -> Result<()> {
        self.inner.drop_table(table).await
    }
}

struct Case {
    fts: Arc<AtomicUsize>,
    vector: Arc<AtomicUsize>,
    result: Result<()>,
}

async fn run(rows: u64, min_rows: u64, vector_fails: bool) -> Case {
    let env = TestEnv::new().await;
    let fts = Arc::new(AtomicUsize::new(0));
    let vector = Arc::new(AtomicUsize::new(0));
    let store: Arc<dyn VectorStore> = Arc::new(Probe {
        inner: env.store.clone(),
        rows,
        fts_calls: fts.clone(),
        vector_calls: vector.clone(),
        vector_fails,
    });
    let service = IndexService::new(
        env.meta.clone(),
        store,
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions {
            vector_index_min_rows: min_rows,
            ..IndexOptions::default()
        },
    );
    let collection = Collection {
        name: "proj_demo".to_owned(),
        kind: CollectionKind::Project,
        project_id: None,
        embedder_id: "fake:8".to_owned(),
        dim: 8,
        active_table: "proj_demo__fake8__v1".to_owned(),
        table_version: 1,
        migrating_to: None,
        migration_started_at: None,
        retired_tables: Vec::new(),
        context_mode: ContextMode::Header,
        created_at: 0,
    };
    CollectionRepo::create(env.meta.as_ref(), collection.clone())
        .await
        .expect("登记 collection");
    let result = service.ensure_indexes(&collection).await;
    Case {
        fts,
        vector,
        result,
    }
}

/// R1b:`[index].vector_index_min_rows` 的默认值要一路传到建索引的判断处(1 万行)。
#[test]
fn the_config_threshold_reaches_index_options() {
    let config = kb_core::Config::default();
    assert_eq!(
        IndexOptions::from_config(&config).vector_index_min_rows,
        10_000,
        "默认配置与建索引判断不能各写一个数"
    );
}

#[tokio::test]
async fn vector_index_is_built_once_the_row_threshold_is_reached() {
    let case = run(10_000, 10_000, false).await;
    case.result.expect("ensure_indexes");
    assert_eq!(case.fts.load(Ordering::SeqCst), 1, "全文索引照常确保");
    assert_eq!(
        case.vector.load(Ordering::SeqCst),
        1,
        "达到阈值应建向量索引"
    );
}

#[tokio::test]
async fn vector_index_is_skipped_below_the_threshold() {
    let case = run(9_999, 10_000, false).await;
    case.result.expect("ensure_indexes");
    assert_eq!(case.fts.load(Ordering::SeqCst), 1);
    assert_eq!(
        case.vector.load(Ordering::SeqCst),
        0,
        "不到阈值不建向量索引"
    );
}

#[tokio::test]
async fn an_empty_table_builds_nothing() {
    let case = run(0, 0, false).await;
    case.result.expect("ensure_indexes");
    assert_eq!(case.fts.load(Ordering::SeqCst), 0);
    assert_eq!(case.vector.load(Ordering::SeqCst), 0, "空表不建任何索引");
}

/// 向量索引建不成(训练失败等)不能挡住全文索引和后面的流程:检索会退回暴力扫描,只是慢一点。
#[tokio::test]
async fn a_failed_vector_index_build_does_not_fail_ensure_indexes() {
    let case = run(12_000, 10_000, true).await;
    case.result
        .expect("向量索引失败只记日志,不应让 ensure_indexes 失败");
    assert_eq!(case.fts.load(Ordering::SeqCst), 1);
    assert_eq!(case.vector.load(Ordering::SeqCst), 1);
}
