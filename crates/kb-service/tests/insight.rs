//! InsightService 验收。

use std::path::Path;
use std::sync::Arc;

use kb_core::KbError;
use kb_core::model::Page;
use kb_core::model::{Collection, EdgeRel, InsightKind, ItemStatus, JobState, Project};
use kb_core::ports::repo::{EdgeRepo, FeedbackRepo, JobRepo, ProjectRepo};
use kb_service::insight::{
    FeedbackRequest, InsightJobHandler, InsightService, ReindexRequest, SaveInsightRequest,
};
use kb_service::jobs::{JobQueue, JobRouter, Worker};
use kb_service::search::{NoopReranker, SearchOptions, SearchRequest, SearchService};
use kb_service::{CollectionService, IndexOptions, IndexService};
use kb_testkit::TestEnv;
use tempfile::TempDir;

struct Fixture {
    env: TestEnv,
    #[allow(dead_code)]
    dir: TempDir,
    project: Project,
    collection: Collection,
    service: InsightService,
    search: SearchService,
    queue: Arc<JobQueue>,
}

async fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("项目目录");
    write(dir.path(), "src/auth.rs", "fn login() {}\n");
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
    let collection = collections
        .create_for_project("p1", "demo")
        .await
        .expect("collection");
    let index = Arc::new(IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    ));
    index
        .index_project(&project, &collection)
        .await
        .expect("索引项目");

    let service = InsightService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let search = SearchService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    let queue = Arc::new(JobQueue::new(env.meta.clone()));
    Fixture {
        env,
        dir,
        project,
        collection,
        service,
        search,
        queue,
    }
}

fn write(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

/// 跑完队列里的所有任务(save_insight 与 index)。
async fn drain(fixture: &Fixture) {
    let mut router = JobRouter::new();
    router.register(
        "save_insight",
        Arc::new(InsightJobHandler::new(
            fixture.env.meta.clone(),
            fixture.env.store.clone(),
            fixture.env.embedder.clone(),
        )),
    );
    router.register(
        "index",
        Arc::new(kb_service::jobs::IndexJobHandler::new(
            Arc::new(IndexService::new(
                fixture.env.meta.clone(),
                fixture.env.store.clone(),
                fixture.env.embedder.clone(),
                fixture.env.chunker.clone(),
                fixture.env.scanner.clone(),
                IndexOptions::default(),
            )),
            fixture.env.meta.clone(),
            4,
        )),
    );
    let worker = Worker::new(
        fixture.queue.clone(),
        Arc::new(router),
        tokio::sync::watch::channel(false).1,
    );
    while worker.run_once().await.expect("跑任务").is_some() {}
}

fn save_request(title: &str, body: &str) -> SaveInsightRequest {
    SaveInsightRequest {
        title: title.to_owned(),
        body_md: body.to_owned(),
        kind: Some(InsightKind::Decision),
        project: Some("demo".to_owned()),
        collection: None,
        global: false,
        tags: vec!["认证".to_owned()],
        related_paths: vec!["src/auth.rs".to_owned()],
        supersedes: None,
        created_by: "mcp:kiro".to_owned(),
        cwd: None,
        strict_links: false,
    }
}

async fn search_ids(fixture: &Fixture, query: &str) -> Vec<String> {
    let response = fixture
        .search
        .search(SearchRequest {
            query: query.to_owned(),
            collections: vec![fixture.collection.name.clone()],
            k: Some(10),
            explain: false,
            rerank: None,
        })
        .await
        .expect("检索");
    response.hits.iter().map(|hit| hit.id.clone()).collect()
}

#[tokio::test]
async fn saved_insight_becomes_searchable_after_the_job_runs() {
    let fixture = fixture().await;
    let saved = fixture
        .service
        .save(save_request(
            "登录鉴权用 Cookie JWT",
            "管理端登录使用 Cookie JWT,登出时写黑名单。",
        ))
        .await
        .expect("保存");
    assert_eq!(saved.collection, "proj_demo");
    assert_eq!(saved.version, 1);

    // 任务还没跑:检索不到
    let before = search_ids(&fixture, "登录鉴权 Cookie JWT").await;
    assert!(!before.contains(&saved.id), "任务完成前不应被检索到");

    drain(&fixture).await;

    let after = search_ids(&fixture, "登录鉴权 Cookie JWT").await;
    assert!(after.contains(&saved.id), "任务完成后应能搜到:{after:?}");
    // 记录形态:kind=insight,source=insight:<id>
    let response = fixture
        .search
        .search(SearchRequest {
            query: "登录鉴权 Cookie JWT".to_owned(),
            collections: vec![fixture.collection.name.clone()],
            k: Some(10),
            explain: false,
            rerank: None,
        })
        .await
        .expect("检索");
    let hit = response
        .hits
        .iter()
        .find(|hit| hit.id == saved.id)
        .expect("应有这条");
    assert_eq!(hit.kind, kb_core::model::RecordKind::Insight);
    assert_eq!(hit.source, format!("insight:{}", saved.id));
    assert_eq!(hit.title.as_deref(), Some("登录鉴权用 Cookie JWT"));

    // 任务确实以 done 结束
    let job = JobRepo::get(fixture.env.meta.as_ref(), &saved.job_id)
        .await
        .expect("查任务")
        .expect("存在");
    assert_eq!(job.state, JobState::Done);
    assert_eq!(job.priority, kb_service::jobs::priority::SAVE_INSIGHT);
}

#[tokio::test]
async fn superseded_insight_is_hidden_by_default() {
    let fixture = fixture().await;
    let old = fixture
        .service
        .save(save_request("旧的鉴权方案", "用 session 存服务端。"))
        .await
        .expect("保存旧条目");
    drain(&fixture).await;

    let mut request = save_request("新的鉴权方案", "改用 Cookie JWT。");
    request.supersedes = Some(old.id.clone());
    let new = fixture.service.save(request).await.expect("保存新条目");
    drain(&fixture).await;

    let default_hits = search_ids(&fixture, "鉴权方案").await;
    assert!(default_hits.contains(&new.id), "{default_hits:?}");
    assert!(
        !default_hits.contains(&old.id),
        "被取代的条目默认不应出现:{default_hits:?}"
    );

    let all = fixture
        .search
        .search(SearchRequest {
            query: "status:all 鉴权方案".to_owned(),
            collections: vec![fixture.collection.name.clone()],
            k: Some(10),
            explain: false,
            rerank: None,
        })
        .await
        .expect("检索");
    let ids: Vec<&str> = all.hits.iter().map(|hit| hit.id.as_str()).collect();
    assert!(
        ids.contains(&old.id.as_str()),
        "status:all 应包含旧条目:{ids:?}"
    );

    // SQLite 里的旧条目也被标成 superseded
    let old_row = fixture.service.get(&old.id).await.expect("查旧条目");
    assert_eq!(old_row.status, ItemStatus::Superseded);
    assert_eq!(old_row.superseded_by.as_deref(), Some(new.id.as_str()));
}

#[tokio::test]
async fn item_history_returns_the_full_chain() {
    let fixture = fixture().await;
    let first = fixture
        .service
        .save(save_request("方案 v1", "第一版"))
        .await
        .expect("v1");
    let mut request = save_request("方案 v2", "第二版");
    request.supersedes = Some(first.id.clone());
    let second = fixture.service.save(request).await.expect("v2");
    let mut request = save_request("方案 v3", "第三版");
    request.supersedes = Some(second.id.clone());
    let third = fixture.service.save(request).await.expect("v3");

    for id in [&first.id, &second.id, &third.id] {
        let chain = fixture.service.history(id).await.expect("演进链");
        let ids: Vec<&str> = chain.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids.len(), 3, "从 {id} 出发应看到三条:{ids:?}");
        assert!(ids.contains(&first.id.as_str()));
        assert!(ids.contains(&third.id.as_str()));
    }
}

#[tokio::test]
async fn feedback_is_recorded() {
    let fixture = fixture().await;
    let id = fixture
        .service
        .feedback(FeedbackRequest {
            query: "登录鉴权".to_owned(),
            item_id: "abc123".to_owned(),
            useful: false,
            note: Some("答非所问".to_owned()),
            source: "mcp".to_owned(),
        })
        .await
        .expect("记录反馈");
    assert!(id > 0);

    let rows = FeedbackRepo::list(fixture.env.meta.as_ref(), Page::new(20, 0))
        .await
        .expect("列反馈");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].item_id, "abc123");
    assert!(!rows[0].useful);
    assert_eq!(rows[0].note.as_deref(), Some("答非所问"));
}

#[tokio::test]
async fn saving_without_any_scope_is_invalid_input() {
    let fixture = fixture().await;
    let mut request = save_request("没有作用域", "正文");
    request.project = None;
    request.global = false;
    // 确保环境变量不干扰
    // SAFETY: 测试内单线程修改
    unsafe { std::env::remove_var("KB_PROJECT") };
    let error = fixture.service.save(request).await.expect_err("应报错");
    assert!(matches!(error, KbError::InvalidInput(_)), "{error:?}");
}

#[tokio::test]
async fn save_uses_cwd_when_no_project_is_given() {
    let fixture = fixture().await;
    let mut request = save_request("按 cwd 落项目", "正文");
    request.project = None;
    request.cwd = Some(fixture.project.root_path.clone());
    let saved = fixture.service.save(request).await.expect("按 cwd 保存");
    assert_eq!(saved.collection, "proj_demo", "应按 cwd 匹配到项目");

    // cwd 不匹配任何项目时仍然报错
    let mut request = save_request("无作用域", "正文");
    request.project = None;
    request.cwd = Some("/tmp/definitely-not-a-project".to_owned());
    let error = fixture.service.save(request).await.expect_err("应报错");
    assert!(matches!(error, KbError::InvalidInput(_)), "{error:?}");
}

#[tokio::test]
async fn related_paths_and_supersede_write_edges() {
    let fixture = fixture().await;
    let old = fixture
        .service
        .save(save_request("旧", "旧正文"))
        .await
        .expect("旧");
    let mut request = save_request("新", "新正文");
    request.supersedes = Some(old.id.clone());
    request.related_paths = vec!["src/auth.rs".to_owned(), "docs/auth.md".to_owned()];
    let new = fixture.service.save(request).await.expect("新");

    let edges = EdgeRepo::by_src(fixture.env.meta.as_ref(), &new.id)
        .await
        .expect("查边");
    let about: Vec<&str> = edges
        .iter()
        .filter(|edge| edge.rel == EdgeRel::AboutFile)
        .map(|edge| edge.dst.as_str())
        .collect();
    assert!(about.contains(&"path:src/auth.rs"), "{about:?}");
    assert!(about.contains(&"path:docs/auth.md"), "{about:?}");
    assert!(
        edges
            .iter()
            .any(|edge| edge.rel == EdgeRel::Supersedes && edge.dst == old.id),
        "应写 supersedes 边:{edges:?}"
    );
}

#[tokio::test]
async fn reindex_enqueues_an_index_job() {
    let fixture = fixture().await;
    let job_id = fixture
        .service
        .reindex(ReindexRequest {
            project: "demo".to_owned(),
            mode: Some("incremental".to_owned()),
            paths: vec!["src/auth.rs".to_owned()],
            phase: None,
            stop_after_text: false,
        })
        .await
        .expect("投递");
    let job = JobRepo::get(fixture.env.meta.as_ref(), &job_id)
        .await
        .expect("查")
        .expect("存在");
    assert_eq!(job.kind, "index");
    assert_eq!(job.collection.as_deref(), Some("proj_demo"));
    assert_eq!(job.state, JobState::Queued);

    let error = fixture
        .service
        .reindex(ReindexRequest {
            project: "demo".to_owned(),
            mode: Some("bogus".to_owned()),
            paths: Vec::new(),
            phase: None,
            stop_after_text: false,
        })
        .await
        .expect_err("非法 mode 应报错");
    assert!(matches!(error, KbError::InvalidInput(_)));
}

#[tokio::test]
async fn set_status_updates_sqlite_and_lancedb() {
    let fixture = fixture().await;
    let saved = fixture
        .service
        .save(save_request("状态测试", "正文内容"))
        .await
        .expect("保存");
    drain(&fixture).await;

    fixture
        .service
        .set_status(&saved.id, ItemStatus::Deprecated)
        .await
        .expect("改状态");
    let row = fixture.service.get(&saved.id).await.expect("查");
    assert_eq!(row.status, ItemStatus::Deprecated);

    let hits = fixture
        .env
        .store
        .get(
            &fixture.collection.active_table,
            std::slice::from_ref(&saved.id),
        )
        .await
        .expect("查 LanceDB");
    assert_eq!(hits[0].status, ItemStatus::Deprecated, "LanceDB 状态应同步");

    // 默认检索不再返回
    let default_hits = search_ids(&fixture, "状态测试").await;
    assert!(!default_hits.contains(&saved.id));
    let _ = &fixture.project;
}

#[tokio::test]
async fn saved_note_writes_its_links_and_can_be_found_as_backlink() {
    let fixture = fixture().await;
    let mut request = save_request(
        "引用测试",
        "看 [说明](README.md) 和 [[01a19f63-f0ea-72fe-aa19-9998f6e2e5ad]]",
    );
    request.strict_links = true;
    let saved = fixture.service.save(request).await.expect("保存");

    let links = kb_core::ports::repo::DocLinkRepo::links_from(
        fixture.env.meta.as_ref(),
        "note",
        &saved.collection,
        &saved.id,
    )
    .await
    .expect("读链接");
    assert_eq!(links.len(), 2);
    assert!(links.iter().any(|link| link.target_kind == "file"
        && link.target_collection.as_deref() == Some(saved.collection.as_str())
        && link.target_id.as_deref() == Some("README.md")));
    assert!(links.iter().any(|link| link.target_kind == "note"
        && link.target_id.as_deref() == Some("01a19f63-f0ea-72fe-aa19-9998f6e2e5ad")));

    let backlinks = kb_core::ports::repo::DocLinkRepo::links_to(
        fixture.env.meta.as_ref(),
        "note",
        &saved.collection,
        "01a19f63-f0ea-72fe-aa19-9998f6e2e5ad",
        20,
    )
    .await
    .expect("反查");
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source_id, saved.id);
}

#[tokio::test]
async fn strict_links_rejects_a_broken_reference_before_saving() {
    let fixture = fixture().await;
    let mut request = save_request("坏引用", "[越界](../../outside.md)");
    request.strict_links = true;
    let error = fixture.service.save(request).await.expect_err("应拒绝");
    assert!(matches!(error, KbError::InvalidInput(_)));
}
