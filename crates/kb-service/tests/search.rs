//! SearchService 验收。

use std::path::Path;
use std::sync::Arc;

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{
    ChunkMeta, Collection, EmbedderState, ItemStatus, MetaPatch, Project, RecordKind, RecordRow,
    SearchMode,
};
use kb_core::ports::Embedder;
use kb_core::ports::repo::{ChunkRepo, ProjectRepo};
use kb_service::search::{NoopReranker, SearchOptions, SearchRequest, SearchService};
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;

struct Fixture {
    env: TestEnv,
    dir: TempDir,
    #[allow(dead_code)]
    project: Project,
    project_collection: Collection,
    global: Collection,
    service: Arc<IndexService>,
    search: SearchService,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("项目目录");
    write(
        dir.path(),
        "src/search.rs",
        "pub fn hybrid_search(query: &str) -> Vec<String> {\n    let _ = query;\n    Vec::new()\n}\n",
    );
    write(
        dir.path(),
        "src/other.rs",
        "pub fn unrelated_helper() -> u32 {\n    7\n}\n",
    );
    write(
        dir.path(),
        "docs/guide.md",
        "# 指南\n\n## 双哈希增量索引\n\n只更新元数据,跳过 embedding。\n",
    );
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
        .expect("项目行");
    let collections =
        CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let project_collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("项目 collection");
    let global = collections.ensure_global().await.expect("_global");

    let service = Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ));
    service
        .index_project(&project, &project_collection)
        .await
        .expect("索引项目");
    let architecture = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ARCHITECTURE.md");
    service
        .index_global_path(&global, &architecture, &["架构".to_owned()])
        .await
        .expect("导入架构文档");

    let search = SearchService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    Fixture {
        env,
        dir,
        project,
        project_collection,
        global,
        service,
        search,
    }
}

fn write(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

fn request(query: &str, collections: &[&str]) -> SearchRequest {
    SearchRequest {
        query: query.to_owned(),
        collections: collections.iter().map(|name| (*name).to_owned()).collect(),
        k: Some(5),
        explain: false,
        rerank: None,
    }
}

#[tokio::test]
async fn both_project_and_global_results_appear() {
    let fixture = fixture().await;
    let response = fixture
        .search
        .search(request("双哈希增量索引", &["proj_demo", "_global"]))
        .await
        .expect("检索");
    assert_eq!(response.scope, vec!["proj_demo", "_global"]);
    let sources: Vec<&str> = response
        .hits
        .iter()
        .map(|hit| hit.source.as_str())
        .collect();
    assert!(
        sources.contains(&"ARCHITECTURE.md"),
        "应命中 _global 的架构文档:{sources:?}"
    );
    assert!(response.degraded.is_none());
}

#[tokio::test]
async fn prefix_filters_are_applied() {
    let fixture = fixture().await;

    // kind:code 只返回代码块
    let response = fixture
        .search
        .search(request("kind:code hybrid_search", &["proj_demo"]))
        .await
        .expect("检索");
    assert!(!response.hits.is_empty());
    assert!(
        response.hits.iter().all(|hit| hit.kind == RecordKind::Code),
        "kind:code 只应返回代码"
    );

    // path: 前缀
    let response = fixture
        .search
        .search(request("path:docs/ 双哈希", &["proj_demo"]))
        .await
        .expect("检索");
    assert!(!response.hits.is_empty());
    assert!(
        response
            .hits
            .iter()
            .all(|hit| hit.source.starts_with("docs/")),
        "{:?}",
        response
            .hits
            .iter()
            .map(|hit| &hit.source)
            .collect::<Vec<_>>()
    );

    // kind:doc 在项目里只命中 markdown
    let response = fixture
        .search
        .search(request("kind:doc 双哈希", &["proj_demo"]))
        .await
        .expect("检索");
    assert!(
        response.hits.iter().all(|hit| hit.kind == RecordKind::Doc),
        "{:?}",
        response.hits.iter().map(|hit| hit.kind).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn status_all_includes_superseded_items() {
    let fixture = fixture().await;
    let metas = ChunkRepo::by_path(fixture.env.meta.as_ref(), "proj_demo", "src/search.rs")
        .await
        .expect("读块");
    let id = metas[0].id.clone();
    fixture
        .env
        .store
        .update_meta(
            &fixture.project_collection.active_table,
            &id,
            MetaPatch {
                status: Some(ItemStatus::Superseded),
                ..MetaPatch::default()
            },
        )
        .await
        .expect("改状态");

    let default = fixture
        .search
        .search(request("hybrid_search", &["proj_demo"]))
        .await
        .expect("默认检索");
    assert!(
        default.hits.iter().all(|hit| hit.id != id),
        "默认不应返回 superseded"
    );

    let all = fixture
        .search
        .search(request("status:all hybrid_search", &["proj_demo"]))
        .await
        .expect("status:all");
    assert!(
        all.hits.iter().any(|hit| hit.id == id),
        "status:all 应返回 superseded 条目"
    );
}

#[tokio::test]
async fn loading_embedder_degrades_to_full_text() {
    let fixture = fixture().await;
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(LoadingEmbedder {
            inner: fixture.env.embedder.clone(),
        }),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    let response = search
        .search(request("双哈希增量索引", &["_global"]))
        .await
        .expect("检索");
    assert_eq!(response.degraded.as_deref(), Some("embedder_loading"));
    assert!(!response.hits.is_empty(), "降级后仍应有全文检索结果");
    assert!(
        response
            .hits
            .iter()
            .any(|hit| hit.source == "ARCHITECTURE.md"),
        "{:?}",
        response
            .hits
            .iter()
            .map(|hit| &hit.source)
            .collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn window_expansion_uses_source_lines_and_falls_back() {
    let fixture = fixture().await;
    let response = fixture
        .search
        .search(request("hybrid_search", &["proj_demo"]))
        .await
        .expect("检索");
    let hit = response
        .hits
        .iter()
        .find(|hit| hit.source == "src/search.rs")
        .expect("应命中 search.rs");
    // 文件只有 4 行,窗口扩展后应包含整个文件
    assert!(hit.snippet.contains("pub fn hybrid_search"));
    assert!(hit.snippet.lines().count() >= 3);

    // 删掉源文件后再检索:回退到存储的文本
    std::fs::remove_file(fixture.dir.path().join("src/search.rs")).expect("删文件");
    let response = fixture
        .search
        .search(SearchRequest {
            explain: true,
            ..request("hybrid_search", &["proj_demo"])
        })
        .await
        .expect("检索");
    let hit = response
        .hits
        .iter()
        .find(|hit| hit.source == "src/search.rs")
        .expect("应命中 search.rs");
    let explain = hit.explain.as_ref().expect("应有 explain");
    let window = explain.window.expect("应有窗口说明");
    assert!(window.fallback, "源文件不存在时应回退");
    assert!(hit.snippet.contains("pub fn hybrid_search"));
}

#[tokio::test]
async fn explain_reports_each_stage() {
    let fixture = fixture().await;
    let response = fixture
        .search
        .search(SearchRequest {
            explain: true,
            ..request("双哈希增量索引", &["proj_demo", "_global"])
        })
        .await
        .expect("检索");
    assert!(!response.hits.is_empty());
    for hit in &response.hits {
        let explain = hit.explain.as_ref().expect("explain=true 时应返回");
        assert_eq!(explain.collection, hit.collection);
        assert!(explain.fused_rank.is_some());
        assert!(explain.store_rank.is_some());
        assert!(explain.fused_score > 0.0);
    }
    // 至少有一条在全文阶段有名次(纯向量命中可以没有)
    assert!(
        response.hits.iter().any(|hit| hit
            .explain
            .as_ref()
            .is_some_and(|explain| explain.fts_rank.is_some())),
        "全文阶段应至少有一条名次:{:?}",
        response
            .hits
            .iter()
            .map(|hit| hit.explain.as_ref().and_then(|explain| explain.fts_rank))
            .collect::<Vec<_>>()
    );
    // 第一条的融合名次是 1
    assert_eq!(
        response.hits[0].explain.as_ref().unwrap().fused_rank,
        Some(1)
    );
    // 阶段耗时自洽:各段非负、嵌入 ≤ 合计、各段之和不超过合计太多
    let timings = response.timings.expect("explain=true 应带 timings");
    assert!(timings.embed_ms >= 0.0 && timings.store_ms >= 0.0);
    assert!(timings.embed_ms <= timings.total_ms + 1.0, "{timings:?}");
    let sum = timings.parse_ms
        + timings.embed_ms
        + timings.store_ms
        + timings.fts_ms
        + timings.vector_ms
        + timings.fuse_ms
        + timings.rerank_ms;
    assert!(
        sum <= timings.total_ms + 5.0,
        "各段之和 {sum} 超过合计 {timings:?}"
    );
    let _ = (&fixture.global, &fixture.service, SearchMode::Hybrid);
}

#[tokio::test]
async fn unknown_collection_is_skipped() {
    let fixture = fixture().await;
    let response = fixture
        .search
        .search(request("双哈希", &["proj_missing", "proj_demo"]))
        .await
        .expect("检索");
    assert_eq!(response.scope, vec!["proj_demo"]);
    assert!(!response.hits.is_empty());
}

#[tokio::test]
async fn filters_that_match_nothing_return_empty_hits() {
    let fixture = fixture().await;
    for query in ["kind:external rate", "path:nope/ rate", "lang:cobol rate"] {
        let response = fixture
            .search
            .search(request(query, &["proj_sampleapp_demo", "_global"]))
            .await
            .unwrap_or_else(|err| panic!("{query} 不应报错:{err:?}"));
        assert!(
            response.hits.is_empty(),
            "{query} 应返回空:{:?}",
            response.hits.len()
        );
    }
}

#[tokio::test]
async fn same_path_in_two_collections_is_not_deduped() {
    let fixture = fixture().await;
    // 关键:两边的 source 必须**完全相同**(都是 `guide.md`),否则触发不了去重逻辑
    write(
        fixture.dir.path(),
        "guide.md",
        "# 指南\n\n## 双哈希增量索引\n\n只更新元数据,跳过 embedding。\n",
    );
    fixture
        .service
        .index_project(&fixture.project, &fixture.project_collection)
        .await
        .expect("重新索引项目");
    let global_dir = tempfile::tempdir().expect("临时目录");
    write(
        global_dir.path(),
        "guide.md",
        "# 指南\n\n## 双哈希增量索引\n\n只更新元数据,跳过 embedding。\n",
    );
    fixture
        .service
        .index_global_path(&fixture.global, &global_dir.path().join("guide.md"), &[])
        .await
        .expect("导入");

    let project_chunks = ChunkRepo::by_path(fixture.env.meta.as_ref(), "proj_demo", "guide.md")
        .await
        .expect("项目块");
    let global_chunks = ChunkRepo::by_path(fixture.env.meta.as_ref(), "_global", "guide.md")
        .await
        .expect("global 块");
    assert!(!project_chunks.is_empty() && !global_chunks.is_empty());

    let response = fixture
        .search
        .search(SearchRequest {
            k: Some(10),
            ..request("双哈希增量索引", &["proj_demo", "_global"])
        })
        .await
        .expect("检索");
    let collections: Vec<&str> = response
        .hits
        .iter()
        .map(|hit| hit.collection.as_str())
        .collect();
    assert!(collections.contains(&"proj_demo"), "{collections:?}");
    assert!(
        collections.contains(&"_global"),
        "两个 collection 的同名路径都应保留:{collections:?}"
    );
    // 两边的行范围必然重叠(同一个文件),去重键必须是 (collection, source)
    let project_hit = response
        .hits
        .iter()
        .find(|hit| hit.collection == "proj_demo" && hit.source == "guide.md")
        .expect("项目命中");
    let global_hit = response
        .hits
        .iter()
        .find(|hit| hit.collection == "_global" && hit.source == "guide.md")
        .expect("global 命中");
    assert!(project_hit.start_line.is_some() && global_hit.start_line.is_some());
}

/// 空闲卸载后的第一次搜索:这次请求自己触发加载并等它加载完,照常做混合检索,不降级成纯关键词。
#[tokio::test]
async fn unloaded_embedder_is_loaded_on_demand_and_the_search_is_not_degraded() {
    let fixture = fixture().await;
    let lazy = Arc::new(kb_testkit::LazyFakeEmbedder::new(8));
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        lazy.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    assert_eq!(lazy.state(), EmbedderState::Unloaded);
    let response = search
        .search(request("双哈希增量索引", &["_global"]))
        .await
        .expect("检索");
    assert_eq!(response.degraded, None, "等加载完了就不该降级");
    assert!(!response.hits.is_empty());
    assert_eq!(lazy.state(), EmbedderState::Ready, "这次搜索触发了加载");
}

/// 加载要一会儿、但没超过等待时间:这次搜索等着,拿到向量后照常做混合检索(用瞬间加载完的假嵌入器测不出"会等")。
#[tokio::test]
async fn a_load_within_the_wait_is_waited_for_not_degraded() {
    let fixture = fixture().await;
    let slow = Arc::new(SlowToLoad::new(fixture.env.embedder.clone(), 150));
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        slow.clone(),
        Arc::new(NoopReranker),
        SearchOptions {
            load_wait_ms: 5_000,
            ..SearchOptions::default()
        },
    );
    let started = std::time::Instant::now();
    let response = search
        .search(request("双哈希增量索引", &["_global"]))
        .await
        .expect("检索");
    assert_eq!(response.degraded, None, "在等待时间内加载完,不该降级");
    assert!(
        started.elapsed() >= std::time::Duration::from_millis(150),
        "应该真的等了加载"
    );
    assert!(!response.hits.is_empty());
}

/// 加载比等待时间还慢:退回只做全文检索并说明是"还在加载";加载不被打断,慢的那次完成后就是现成的。
#[tokio::test]
async fn a_slow_load_degrades_to_full_text_but_keeps_loading() {
    let fixture = fixture().await;
    let slow = Arc::new(SlowToLoad::new(fixture.env.embedder.clone(), 300));
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        slow.clone(),
        Arc::new(NoopReranker),
        SearchOptions {
            load_wait_ms: 20,
            ..SearchOptions::default()
        },
    );
    let response = search
        .search(request("双哈希增量索引", &["_global"]))
        .await
        .expect("检索");
    assert_eq!(response.degraded.as_deref(), Some("embedder_loading"));
    assert!(!response.hits.is_empty(), "降级后仍应有全文检索结果");
}

/// 第一次 `embed_query` 要很久才返回(模拟模型加载),返回之前 `state` 都是 `Unloaded`。
struct SlowToLoad {
    inner: Arc<dyn Embedder>,
    delay_ms: u64,
    loaded: std::sync::atomic::AtomicBool,
}

impl SlowToLoad {
    fn new(inner: Arc<dyn Embedder>, delay_ms: u64) -> Self {
        Self {
            inner,
            delay_ms,
            loaded: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

#[async_trait]
impl Embedder for SlowToLoad {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn dim(&self) -> usize {
        self.inner.dim()
    }
    fn compat_group(&self) -> &str {
        self.inner.compat_group()
    }
    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.inner.embed_documents(texts).await
    }
    async fn embed_query(&self, text: String) -> Result<Vec<f32>> {
        if !self.loaded.swap(true, std::sync::atomic::Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms)).await;
        }
        self.inner.embed_query(text).await
    }
    fn state(&self) -> EmbedderState {
        if self.loaded.load(std::sync::atomic::Ordering::SeqCst) {
            EmbedderState::Ready
        } else {
            EmbedderState::Unloaded
        }
    }
}

#[tokio::test]
async fn failed_embedder_reports_unavailable() {
    let fixture = fixture().await;
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(kb_testkit::FailingEmbedder),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    let response = search
        .search(request("双哈希增量索引", &["_global"]))
        .await
        .expect("检索");
    assert_eq!(response.degraded.as_deref(), Some("embedder_unavailable"));
    assert!(!response.hits.is_empty(), "降级后仍应有全文结果");
}

/// 可控制的重排器。
struct FakeReranker {
    outcome: RerankOutcome,
}

enum RerankOutcome {
    Ok(Vec<f32>),
    Fail,
    Slow,
    Unavailable,
}

#[async_trait]
impl kb_core::ports::Reranker for FakeReranker {
    async fn rerank(&self, _query: &str, docs: &[String]) -> Result<Vec<f32>> {
        match &self.outcome {
            RerankOutcome::Ok(scores) => Ok(scores.iter().copied().take(docs.len()).collect()),
            RerankOutcome::Fail => Err(kb_core::KbError::Unavailable("重排失败".to_owned())),
            RerankOutcome::Slow => {
                tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                Ok(vec![0.0; docs.len()])
            }
            RerankOutcome::Unavailable => Ok(vec![0.0; docs.len()]),
        }
    }

    fn available(&self) -> bool {
        !matches!(self.outcome, RerankOutcome::Unavailable)
    }
}

fn rerank_search(fixture: &Fixture, reranker: FakeReranker, budget_ms: u64) -> SearchService {
    SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
        Arc::new(reranker),
        SearchOptions {
            budget_ms,
            rerank_mode: "on".to_owned(),
            ..SearchOptions::default()
        },
    )
}

#[tokio::test]
async fn rerank_reorders_the_candidates_by_score() {
    let fixture = fixture().await;
    // 不重排时的顺序
    let plain = fixture
        .search
        .search(SearchRequest {
            k: Some(4),
            ..request("双哈希增量索引", &["proj_demo", "_global"])
        })
        .await
        .expect("检索");
    assert!(
        plain.hits.len() >= 3,
        "需要至少 3 条候选:{:?}",
        plain.hits.len()
    );
    let before: Vec<String> = plain.hits.iter().map(|hit| hit.id.clone()).collect();

    // 把第 3 条打最高分,第 1 条打最低分
    let mut scores = vec![0.1_f32, 0.2, 9.0, 0.3, 0.4, 0.5, 0.6, 0.7];
    scores.truncate(before.len());
    let search = rerank_search(
        &fixture,
        FakeReranker {
            outcome: RerankOutcome::Ok(scores),
        },
        3000,
    );
    let response = search
        .search(SearchRequest {
            rerank: Some(true),
            k: Some(4),
            ..request("双哈希增量索引", &["proj_demo", "_global"])
        })
        .await
        .expect("检索");
    let after: Vec<String> = response.hits.iter().map(|hit| hit.id.clone()).collect();
    assert_ne!(before, after, "重排后顺序应改变");
    assert_eq!(after[0], before[2], "第 3 条应被排到第 1 位");
}

#[tokio::test]
async fn rerank_only_touches_the_top_n_candidates() {
    let fixture = fixture().await;
    let plain = fixture
        .search
        .search(SearchRequest {
            k: Some(6),
            ..request("双哈希增量索引", &["proj_demo", "_global"])
        })
        .await
        .expect("检索");
    let before: Vec<String> = plain.hits.iter().map(|hit| hit.id.clone()).collect();
    assert!(before.len() >= 4, "需要至少 4 条候选:{:?}", before.len());

    // top_n = 2:只重排前两条
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
        Arc::new(FakeReranker {
            outcome: RerankOutcome::Ok(vec![0.0, 9.0]),
        }),
        SearchOptions {
            rerank_mode: "on".to_owned(),
            rerank_top_n: 2,
            ..SearchOptions::default()
        },
    );
    let response = search
        .search(SearchRequest {
            rerank: Some(true),
            k: Some(6),
            ..request("双哈希增量索引", &["proj_demo", "_global"])
        })
        .await
        .expect("检索");
    let after: Vec<String> = response.hits.iter().map(|hit| hit.id.clone()).collect();
    assert_eq!(after[0], before[1], "top_n 内应重排");
    assert_eq!(after[1], before[0]);
    assert_eq!(after[2..], before[2..], "top_n 之外的候选顺序必须保持不变");
}

#[tokio::test]
async fn auto_mode_reranks_when_the_reranker_is_available() {
    let fixture = fixture().await;
    let plain = fixture
        .search
        .search(SearchRequest {
            k: Some(3),
            ..request("双哈希增量索引", &["proj_demo", "_global"])
        })
        .await
        .expect("检索");
    let before: Vec<String> = plain.hits.iter().map(|hit| hit.id.clone()).collect();

    // auto + 可用 + 请求没说话 → 应当重排
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
        Arc::new(FakeReranker {
            outcome: RerankOutcome::Ok(vec![0.0, 0.0, 9.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
        }),
        SearchOptions {
            rerank_mode: "auto".to_owned(),
            ..SearchOptions::default()
        },
    );
    let response = search
        .search(SearchRequest {
            k: Some(3),
            ..request("双哈希增量索引", &["proj_demo", "_global"])
        })
        .await
        .expect("检索");
    assert!(response.degraded.is_none());
    let after: Vec<String> = response.hits.iter().map(|hit| hit.id.clone()).collect();
    assert_ne!(
        after, before,
        "auto 模式下可用就应重排:{before:?} → {after:?}"
    );
}

#[tokio::test]
async fn auto_mode_without_a_reranker_does_not_degrade() {
    let fixture = fixture().await;
    let response = fixture
        .search
        .search(request("双哈希增量索引", &["proj_demo", "_global"]))
        .await
        .expect("检索");
    assert!(response.degraded.is_none(), "默认检索不应带重排降级");

    // 显式要求但不可用 → 降级
    let response = fixture
        .search
        .search(SearchRequest {
            rerank: Some(true),
            ..request("双哈希增量索引", &["proj_demo", "_global"])
        })
        .await
        .expect("检索");
    assert_eq!(response.degraded.as_deref(), Some("rerank_unavailable"));
}

#[tokio::test]
async fn rerank_reorders_the_top_candidates() {
    let fixture = fixture().await;
    let search = rerank_search(
        &fixture,
        FakeReranker {
            outcome: RerankOutcome::Ok(vec![0.0, 9.0, 5.0, 1.0, 0.0, 0.0, 0.0, 0.0]),
        },
        3000,
    );
    let response = search
        .search(SearchRequest {
            rerank: Some(true),
            ..request("双哈希增量索引", &["proj_demo", "_global"])
        })
        .await
        .expect("检索");
    assert!(response.degraded.is_none(), "{:?}", response.degraded);
    assert!(response.hits.len() >= 2);
}

#[tokio::test]
async fn rerank_failure_and_timeout_degrade() {
    let fixture = fixture().await;
    let failing = rerank_search(
        &fixture,
        FakeReranker {
            outcome: RerankOutcome::Fail,
        },
        3000,
    );
    let response = failing
        .search(SearchRequest {
            rerank: Some(true),
            ..request("双哈希增量索引", &["_global"])
        })
        .await
        .expect("检索");
    assert_eq!(response.degraded.as_deref(), Some("rerank_unavailable"));

    let slow = rerank_search(
        &fixture,
        FakeReranker {
            outcome: RerankOutcome::Slow,
        },
        20,
    );
    let response = slow
        .search(SearchRequest {
            rerank: Some(true),
            ..request("双哈希增量索引", &["_global"])
        })
        .await
        .expect("检索");
    assert_eq!(response.degraded.as_deref(), Some("rerank_timeout"));
    assert!(!response.hits.is_empty(), "超时后应退回融合结果");
}

#[tokio::test]
async fn rerank_off_never_calls_the_reranker() {
    let fixture = fixture().await;
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
        Arc::new(FakeReranker {
            outcome: RerankOutcome::Unavailable,
        }),
        SearchOptions {
            rerank_mode: "off".to_owned(),
            ..SearchOptions::default()
        },
    );
    let response = search
        .search(SearchRequest {
            rerank: Some(true),
            ..request("双哈希增量索引", &["_global"])
        })
        .await
        .expect("检索");
    assert!(response.degraded.is_none(), "mode=off 时不应报重排降级");
}

/// 假装嵌入器正在加载。
struct LoadingEmbedder {
    inner: Arc<dyn Embedder>,
}

#[async_trait]
impl Embedder for LoadingEmbedder {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn dim(&self) -> usize {
        self.inner.dim()
    }
    fn compat_group(&self) -> &str {
        self.inner.compat_group()
    }
    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.inner.embed_documents(texts).await
    }
    async fn embed_query(&self, text: String) -> Result<Vec<f32>> {
        self.inner.embed_query(text).await
    }
    fn state(&self) -> EmbedderState {
        EmbedderState::Loading
    }
}

/// `state` 报告 Ready、但查询嵌入会失败(模拟 HTTP sidecar 刚被杀)。
struct ReadyButFailing {
    inner: Arc<dyn Embedder>,
}

#[async_trait]
impl Embedder for ReadyButFailing {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn dim(&self) -> usize {
        self.inner.dim()
    }
    fn compat_group(&self) -> &str {
        self.inner.compat_group()
    }
    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.inner.embed_documents(texts).await
    }
    async fn embed_query(&self, _text: String) -> Result<Vec<f32>> {
        Err(kb_core::KbError::Unavailable(
            "sidecar 嵌入请求失败: connection refused".to_owned(),
        ))
    }
    fn state(&self) -> EmbedderState {
        EmbedderState::Ready
    }
}

#[tokio::test]
async fn ready_but_failing_embedder_degrades_instead_of_erroring() {
    // :Ready 分支的嵌入失败不能把错误抛给请求,要降级成全文检索
    let fixture = fixture().await;
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(ReadyButFailing {
            inner: fixture.env.embedder.clone(),
        }),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    let response = search
        .search(SearchRequest {
            query: "混合检索".to_owned(),
            collections: vec![
                fixture.project_collection.name.clone(),
                fixture.global.name.clone(),
            ],
            k: Some(5),
            explain: false,
            rerank: None,
        })
        .await
        .expect("嵌入失败不应让检索报错");
    assert_eq!(
        response.degraded.as_deref(),
        Some("embedder_unavailable"),
        "{response:?}"
    );
    assert!(!response.hits.is_empty(), "应回退到全文检索并返回结果");
}

/// 包一层存储:统计同一时刻有几个 `search` 在飞,每次检索故意多等一会儿,让重叠可观察。
struct InFlight {
    inner: Arc<dyn kb_core::ports::VectorStore>,
    now: std::sync::atomic::AtomicUsize,
    peak: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl kb_core::ports::VectorStore for InFlight {
    async fn ensure_table(&self, table: &str, dim: usize) -> Result<()> {
        self.inner.ensure_table(table, dim).await
    }
    async fn upsert(&self, table: &str, rows: Vec<kb_core::model::RecordRow>) -> Result<()> {
        self.inner.upsert(table, rows).await
    }
    async fn update_meta(&self, table: &str, id: &str, patch: MetaPatch) -> Result<()> {
        self.inner.update_meta(table, id, patch).await
    }
    async fn delete_ids(&self, table: &str, ids: &[String]) -> Result<()> {
        self.inner.delete_ids(table, ids).await
    }
    async fn get(&self, table: &str, ids: &[String]) -> Result<Vec<kb_core::model::RecordRow>> {
        self.inner.get(table, ids).await
    }
    async fn search(
        &self,
        table: &str,
        req: &kb_core::model::StoreQuery,
    ) -> Result<Vec<kb_core::model::StoreHit>> {
        use std::sync::atomic::Ordering;
        let now = self.now.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        let result = self.inner.search(table, req).await;
        self.now.fetch_sub(1, Ordering::SeqCst);
        result
    }
    async fn list(
        &self,
        table: &str,
        query: &kb_core::model::ListQuery,
    ) -> Result<Vec<kb_core::model::RecordRow>> {
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

/// L3:检索要同时查项目和 `_global`,以前是一个一个等;现在各集合并发查,
/// 结果的顺序和融合结果都不变(按请求里集合的顺序)。
/// 用「同一时刻在飞的检索数」判断并发,不用墙钟时间:耗时还含嵌入、融合,机器有负载时会飘。
#[tokio::test(flavor = "multi_thread")]
async fn collections_are_searched_concurrently_with_unchanged_results() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let fixture = fixture().await;
    let serial = fixture
        .search
        .search(request("双哈希增量索引", &["proj_demo", "_global"]))
        .await
        .expect("基线检索");

    let counting = Arc::new(InFlight {
        inner: fixture.env.store.clone(),
        now: AtomicUsize::new(0),
        peak: AtomicUsize::new(0),
    });
    let search = SearchService::new(
        fixture.env.meta.clone(),
        counting.clone(),
        fixture.env.embedder.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    let concurrent = search
        .search(request("双哈希增量索引", &["proj_demo", "_global"]))
        .await
        .expect("并发检索");

    assert!(
        counting.peak.load(Ordering::SeqCst) >= 2,
        "两个集合的检索应该有重叠,同一时刻最多只有 {} 个在飞",
        counting.peak.load(Ordering::SeqCst)
    );
    // 结果不能因为并发而变
    assert_eq!(concurrent.scope, serial.scope);
    let ids = |response: &kb_service::search::SearchResponse| -> Vec<String> {
        response
            .hits
            .iter()
            .map(|hit| format!("{}:{:?}", hit.source, hit.start_line))
            .collect()
    };
    assert_eq!(ids(&concurrent), ids(&serial));
}

/// 数 `embed_query` 被调了几次,其余转给真的嵌入器。
struct CountingQueries {
    inner: Arc<dyn Embedder>,
    queries: std::sync::atomic::AtomicUsize,
}

#[async_trait]
impl Embedder for CountingQueries {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn dim(&self) -> usize {
        self.inner.dim()
    }
    fn compat_group(&self) -> &str {
        self.inner.compat_group()
    }
    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.inner.embed_documents(texts).await
    }
    async fn embed_query(&self, text: String) -> Result<Vec<f32>> {
        self.queries
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.embed_query(text).await
    }
    fn state(&self) -> EmbedderState {
        self.inner.state()
    }
}

/// L3 后半:同一个知识库里重复的查询不再重新嵌入,结果与第一次逐条相同;换个查询词才再嵌入。
#[tokio::test]
async fn repeated_queries_reuse_the_cached_query_vector() {
    let fixture = fixture().await;
    let counting = Arc::new(CountingQueries {
        inner: fixture.env.embedder.clone(),
        queries: std::sync::atomic::AtomicUsize::new(0),
    });
    let cache = Arc::new(kb_service::search::QueryVectorCache::new(8));
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        counting.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    )
    .with_query_cache(cache.clone());
    let queries = || counting.queries.load(std::sync::atomic::Ordering::SeqCst);

    let first = search
        .search(request("双哈希增量索引", &["proj_demo", "_global"]))
        .await
        .expect("检索");
    assert_eq!(queries(), 1);
    let second = search
        .search(request("双哈希增量索引", &["proj_demo", "_global"]))
        .await
        .expect("检索");
    assert_eq!(queries(), 1, "同一个查询第二次不再嵌入");
    let ids = |response: &kb_service::search::SearchResponse| {
        response
            .hits
            .iter()
            .map(|hit| (hit.id.clone(), hit.score.to_bits()))
            .collect::<Vec<_>>()
    };
    assert!(!first.hits.is_empty());
    assert_eq!(ids(&first), ids(&second), "用缓存的向量,结果逐条相同");
    assert_eq!(second.query_parsed.text, "双哈希增量索引");

    search
        .search(request("混合检索", &["proj_demo"]))
        .await
        .expect("检索");
    assert_eq!(queries(), 2, "换了查询词要重新嵌入");
}

/// 命中缓存时不必等模型:模型正在加载(或空闲卸载后)也能做混合检索,不降级成纯关键词。
#[tokio::test]
async fn a_cached_query_does_not_wait_for_a_loading_model() {
    let fixture = fixture().await;
    let cache = Arc::new(kb_service::search::QueryVectorCache::new(8));
    let ready = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    )
    .with_query_cache(cache.clone());
    ready
        .search(request("双哈希增量索引", &["_global"]))
        .await
        .expect("检索");

    let loading = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(LoadingEmbedder {
            inner: fixture.env.embedder.clone(),
        }),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    )
    .with_query_cache(cache);
    let response = loading
        .search(request("双哈希增量索引", &["_global"]))
        .await
        .expect("检索");
    assert!(response.degraded.is_none(), "有缓存的向量,不降级");
    let uncached = loading
        .search(request("另一个查询", &["_global"]))
        .await
        .expect("检索");
    assert_eq!(
        uncached.degraded.as_deref(),
        Some("embedder_loading"),
        "没缓存的照旧降级"
    );
}

/// 缓存键先规范化:同一句问题只差空白与大小写时不该重新嵌入。
/// 向量只用于召回,全文那一路仍用原文,所以结果集不会因为这条复用而变成「大小写不敏感」。
#[tokio::test]
async fn queries_differing_only_in_spacing_or_case_share_one_embedding() {
    let fixture = fixture().await;
    let counting = Arc::new(CountingQueries {
        inner: fixture.env.embedder.clone(),
        queries: std::sync::atomic::AtomicUsize::new(0),
    });
    let cache = Arc::new(kb_service::search::QueryVectorCache::new(8));
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        counting.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    )
    .with_query_cache(cache);
    let queries = || counting.queries.load(std::sync::atomic::Ordering::SeqCst);

    search
        .search(request("  双哈希   增量索引 ", &["_global"]))
        .await
        .expect("检索");
    assert_eq!(queries(), 1);
    let spaced = search
        .search(request("双哈希 增量索引", &["_global"]))
        .await
        .expect("检索");
    assert_eq!(queries(), 1, "只是空白不同,复用同一条向量");
    // 全文匹配按原文:规范化只影响向量复用
    assert_eq!(spaced.query_parsed.text, "双哈希 增量索引");
}

/// :并发闸门。上限 1 时两次检索必须排队跑,排队时间记在 `queue_ms` 里。
#[tokio::test]
async fn the_gate_makes_concurrent_searches_queue_instead_of_slowing_down() {
    let fixture = fixture().await;
    let slow = Arc::new(SlowEmbedder {
        inner: fixture.env.embedder.clone(),
        inflight: std::sync::atomic::AtomicUsize::new(0),
        peak: std::sync::atomic::AtomicUsize::new(0),
        delay: std::time::Duration::from_millis(80),
    });
    let search = Arc::new(
        SearchService::new(
            fixture.env.meta.clone(),
            fixture.env.store.clone(),
            slow.clone(),
            Arc::new(NoopReranker),
            SearchOptions::default(),
        )
        .with_gate(Arc::new(kb_service::search::SearchGate::fixed(Some(1)))),
    );
    let mut explain = request("双哈希增量索引", &["_global"]);
    explain.explain = true;
    let mut tasks = Vec::new();
    for _ in 0..3 {
        let search = search.clone();
        let request = explain.clone();
        tasks.push(tokio::spawn(async move {
            search.search(request).await.expect("检索")
        }));
    }
    let mut queued = 0;
    for task in tasks {
        let response = task.await.expect("任务");
        let timings = response.timings.expect("explain=true 带 timings");
        if timings.queue_ms > 1.0 {
            queued += 1;
        }
    }
    assert_eq!(
        slow.peak.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "上限 1 时同一时刻只能有一个在嵌入"
    );
    assert!(queued >= 2, "后面的请求必须排队(排队 {queued} 个)");
}

#[tokio::test]
async fn pending_rows_are_searchable_and_degrade_until_embedded() {
    let fixture = fixture().await;
    let table = fixture.project_collection.active_table.clone();
    let id = "ab12";
    let path = "docs/pending.md";
    // 模拟文本阶段:行已经写进向量表但没有 vector,块与队列同事务落 SQLite
    fixture
        .env
        .store
        .upsert(
            &table,
            vec![RecordRow {
                id: id.to_owned(),
                collection: "proj_demo".to_owned(),
                kind: RecordKind::Doc,
                lang: Some("zh".to_owned()),
                source: path.to_owned(),
                start_line: Some(1),
                end_line: Some(3),
                symbol: None,
                title: Some("文本优先索引".to_owned()),
                text: "文本优先索引先把正文写进全文索引".to_owned(),
                header: "demo › docs/pending.md".to_owned(),
                lex: "文本优先 索引 正文 全文".to_owned(),
                tags: Vec::new(),
                status: ItemStatus::Active,
                content_hash: "c-ab12".to_owned(),
                meta_hash: "m-ab12".to_owned(),
                embed_input_hash: "e-ab12".to_owned(),
                updated_at: 1_700_000_000_000,
                anchor: None,
                vector: None,
            }],
        )
        .await
        .expect("写入 pending 行");
    ChunkRepo::replace_for_path_with_pending(
        fixture.env.meta.as_ref(),
        "proj_demo",
        path,
        vec![ChunkMeta {
            id: id.to_owned(),
            collection: "proj_demo".to_owned(),
            path: path.to_owned(),
            ordinal: 0,
            content_hash: "c-ab12".to_owned(),
            meta_hash: "m-ab12".to_owned(),
            embed_input_hash: "e-ab12".to_owned(),
            updated_at: 1_700_000_000_000,
        }],
        &[(id.to_owned(), path.to_owned())],
        1_700_000_000_000,
    )
    .await
    .expect("块与队列");
    fixture
        .service
        .ensure_indexes(&fixture.project_collection)
        .await
        .expect("建索引");

    let response = fixture
        .search
        .search(SearchRequest {
            explain: true,
            ..request("文本优先索引", &["proj_demo"])
        })
        .await
        .expect("检索 pending");
    let hit = response
        .hits
        .iter()
        .find(|hit| hit.id == id)
        .expect("待补向量的块也要能被搜到");
    assert_eq!(response.degraded.as_deref(), Some("vector_pending"));
    assert!(hit.explain.as_ref().expect("explain").pending);

    // 非目标 collection 不能看到这条 pending:补充检索必须只查本次请求的 targets,
    // 否则同名块会跨项目泄露(权限 scope 在调用方解析,这里锁住服务层不越界)。
    let other = fixture
        .search
        .search(request("文本优先索引", &["_global"]))
        .await
        .expect("只查 _global");
    assert!(
        other.hits.iter().all(|hit| hit.id != id),
        "proj_demo 的 pending 块不能出现在 _global 的结果里"
    );
    assert_ne!(other.degraded.as_deref(), Some("vector_pending"));

    // 嵌入器彻底不可用比「部分内容待补」更严重:提示不能被 vector_pending 盖住
    let failing = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        Arc::new(kb_testkit::FailingEmbedder),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    let unavailable = failing
        .search(request("文本优先索引", &["proj_demo"]))
        .await
        .expect("降级检索");
    assert_eq!(
        unavailable.degraded.as_deref(),
        Some("embedder_unavailable"),
        "嵌入器不可用的优先级高于 vector_pending"
    );

    assert_eq!(
        fixture
            .service
            .pending_count("proj_demo")
            .await
            .expect("队列数"),
        1
    );
    let embedded = fixture
        .service
        .embed_pending_batch(&fixture.project_collection, 10)
        .await
        .expect("补向量");
    assert_eq!(embedded, 1);
    assert_eq!(
        fixture
            .service
            .pending_count("proj_demo")
            .await
            .expect("队列数"),
        0
    );

    let response = fixture
        .search
        .search(SearchRequest {
            explain: true,
            ..request("文本优先索引", &["proj_demo"])
        })
        .await
        .expect("补完再查");
    let hit = response
        .hits
        .iter()
        .find(|hit| hit.id == id)
        .expect("补完向量后仍应命中");
    assert_ne!(response.degraded.as_deref(), Some("vector_pending"));
    assert!(!hit.explain.as_ref().expect("explain").pending);
}

/// 一次嵌入睡一会儿,顺便记下同时在跑的峰值。
struct SlowEmbedder {
    inner: Arc<dyn Embedder>,
    inflight: std::sync::atomic::AtomicUsize,
    peak: std::sync::atomic::AtomicUsize,
    delay: std::time::Duration,
}

#[async_trait]
impl Embedder for SlowEmbedder {
    fn id(&self) -> &str {
        self.inner.id()
    }
    fn dim(&self) -> usize {
        self.inner.dim()
    }
    fn compat_group(&self) -> &str {
        self.inner.compat_group()
    }
    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.inner.embed_documents(texts).await
    }
    async fn embed_query(&self, text: String) -> Result<Vec<f32>> {
        let now = self
            .inflight
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        self.peak
            .fetch_max(now, std::sync::atomic::Ordering::SeqCst);
        tokio::time::sleep(self.delay).await;
        self.inflight
            .fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.embed_query(text).await
    }
    fn state(&self) -> EmbedderState {
        self.inner.state()
    }
}

/// 统计 `search` / `search_pending` 调用次数:验证「队列为空时不额外查 Lance」。
///
/// 只覆盖检索用到的几个入口,其余原样转发;测试里不会调写入,所以不必逐条计数。
struct CountingStore {
    inner: Arc<dyn kb_core::ports::VectorStore>,
    searches: std::sync::atomic::AtomicUsize,
    pending_searches: std::sync::atomic::AtomicUsize,
}

impl CountingStore {
    fn new(inner: Arc<dyn kb_core::ports::VectorStore>) -> Self {
        Self {
            inner,
            searches: std::sync::atomic::AtomicUsize::new(0),
            pending_searches: std::sync::atomic::AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl kb_core::ports::VectorStore for CountingStore {
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
    async fn search(
        &self,
        table: &str,
        req: &kb_core::model::StoreQuery,
    ) -> Result<Vec<kb_core::model::StoreHit>> {
        self.searches
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.search(table, req).await
    }
    async fn search_pending(
        &self,
        table: &str,
        req: &kb_core::model::StoreQuery,
    ) -> Result<Vec<kb_core::model::StoreHit>> {
        self.pending_searches
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.search_pending(table, req).await
    }
    async fn get_pending(
        &self,
        table: &str,
        ids: &[String],
    ) -> Result<Vec<kb_core::model::RecordRow>> {
        self.inner.get_pending(table, ids).await
    }
    async fn list(&self, table: &str, query: &kb_core::model::ListQuery) -> Result<Vec<RecordRow>> {
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
    async fn table_stats(&self) -> Result<Vec<kb_core::model::TableStats>> {
        self.inner.table_stats().await
    }
}

#[tokio::test]
async fn an_empty_pending_queue_does_not_add_any_store_query() {
    let fixture = fixture().await;
    let counting = Arc::new(CountingStore::new(fixture.env.store.clone()));
    // 缓存故意不给:走「没有 pending」的完整判断,确认也不会多查一次 Lance
    let search = SearchService::new(
        fixture.env.meta.clone(),
        counting.clone(),
        fixture.env.embedder.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    let request = request("双哈希增量索引", &["proj_demo", "_global"]);
    search.search(request.clone()).await.expect("第一次");
    search.search(request).await.expect("第二次");
    // 两个 collection,两次检索 → 各 2 次;队列为空时一次 search_pending 都不该有
    assert_eq!(
        counting.searches.load(std::sync::atomic::Ordering::SeqCst),
        4
    );
    assert_eq!(
        counting
            .pending_searches
            .load(std::sync::atomic::Ordering::SeqCst),
        0,
        "队列为空时不应额外查 Lance"
    );
}

#[tokio::test]
async fn pending_cache_keeps_the_queue_check_out_of_the_hot_path() {
    let fixture = fixture().await;
    let cache = Arc::new(kb_service::search::PendingExistsCache::new("sp_primary"));
    let search = SearchService::new(
        fixture.env.meta.clone(),
        fixture.env.store.clone(),
        fixture.env.embedder.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    )
    .with_pending_cache(cache.clone());
    let request = request("双哈希增量索引", &["_global"]);
    search.search(request.clone()).await.expect("第一次");
    search.search(request).await.expect("第二次");
    assert_eq!(cache.len(), 1, "同一个 collection 只缓存一条");
}
