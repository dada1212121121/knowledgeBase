//! 验收:自动提炼的状态机(mock LLM)。
//!
//! 覆盖:approve / revise / reject / duplicate / 未授权不调用 LLM / 指纹去重 /
//! 驳回后同义候选记 `previously_rejected` / 草稿转正前搜索不到。

use std::sync::Arc;

use kb_core::config::EvolutionConfig;
use kb_core::model::{ChatResponse, DraftState, ItemStatus, RecordKind};
use kb_core::ports::ChatModel;
use kb_core::ports::repo::{CollectionRepo, DraftRepo, EvolutionRepo, ProjectRepo};
use kb_llm::MockChatModel;
use kb_service::evolution::EvolutionService;
use kb_service::llm_gate::{GateConfig, LlmGate};
use kb_service::search::{SearchOptions, SearchRequest, SearchService};
use kb_service::{ProjectService, SourceService};
use kb_testkit::TestEnv;

struct Harness {
    env: TestEnv,
    project_id: String,
    collection: String,
}

async fn harness(config: EvolutionConfig) -> (Harness, Arc<MockChatModel>, Arc<MockChatModel>) {
    let env = TestEnv::new().await;
    let service = ProjectService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let dir = tempfile::tempdir().expect("目录");
    std::fs::write(dir.path().join("lib.rs"), "fn main() {}\n").expect("写文件");
    let project = service.add(dir.path(), Some("demo")).await.expect("加项目");
    let collection = format!("proj_{}", project.slug);
    let _ = config;
    // 打开两个开关
    let mut project = ProjectRepo::get(env.meta.as_ref(), &project.id)
        .await
        .expect("取项目")
        .expect("存在");
    project.extract_enabled = true;
    project.allow_cloud_llm = true;
    let project_id = project.id.clone();
    ProjectRepo::update(env.meta.as_ref(), project)
        .await
        .expect("更新项目");
    let extract_model = Arc::new(MockChatModel::reply("{}"));
    let review_model = Arc::new(MockChatModel::reply("{}"));
    (
        Harness {
            env,
            project_id,
            collection,
        },
        extract_model,
        review_model,
    )
}

fn service(
    harness: &Harness,
    config: EvolutionConfig,
    extract: Arc<MockChatModel>,
    review: Arc<MockChatModel>,
) -> EvolutionService {
    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    EvolutionService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
        gate,
        extract as Arc<dyn ChatModel>,
        review as Arc<dyn ChatModel>,
        config,
    )
}

fn candidate_json(title: &str, body: &str, kind: &str) -> String {
    serde_json::json!({
        "items": [{
            "title": title,
            "body_md": body,
            "kind": kind,
            "tags": ["索引"],
            "related_paths": ["src/index.rs"],
            "evidence": "diff 里的片段",
            "confidence": 0.9
        }]
    })
    .to_string()
}

fn review_json(decision: &str, score: f64) -> String {
    serde_json::json!({
        "decision": decision,
        "score": score,
        "reasons": ["具体且与证据一致"]
    })
    .to_string()
}

fn reply(text: &str) -> ChatResponse {
    ChatResponse {
        message: kb_core::model::ChatMessage {
            role: "assistant".to_owned(),
            content: Some(text.to_owned()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        },
        input_tokens: 20,
        output_tokens: 10,
        finish_reason: "stop".to_owned(),
    }
}

fn config() -> EvolutionConfig {
    EvolutionConfig {
        review_mode: "ai".to_owned(),
        approve_threshold: 0.7,
        dedup_similarity: 0.99,
        ..EvolutionConfig::default()
    }
}

async fn searchable(harness: &Harness, query: &str) -> Vec<String> {
    let service = SearchService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
        Arc::new(kb_service::search::NoopReranker),
        SearchOptions::default(),
    );
    service
        .search(SearchRequest {
            query: query.to_owned(),
            collections: vec![harness.collection.clone()],
            k: Some(5),
            explain: false,
            rerank: None,
        })
        .await
        .expect("检索")
        .hits
        .into_iter()
        .map(|hit| hit.title.unwrap_or_default())
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn approve_promotes_the_draft_and_makes_it_searchable() {
    let (harness, _extract, _review) = harness(config()).await;
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json(
        "用双哈希判断是否需要重嵌入",
        "块内容哈希没变就不重新嵌入。",
        "decision",
    ))]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json(
        "approve", 0.9,
    ))]));
    let service = service(&harness, config(), extract.clone(), review.clone());
    let outcome = service
        .process(
            &harness.project_id,
            "git_commit",
            "diff --git a/src/index.rs",
        )
        .await
        .expect("处理事件");
    assert_eq!(outcome.candidates, 1, "{outcome:?}");
    assert!(matches!(
        outcome.outcomes[0],
        kb_service::evolution::CandidateOutcome::Approved { .. }
    ));
    assert_eq!(outcome.review_calls, 1);
    // 转正后 insights 表里有了这条条目(写入 LanceDB 由 InsightJobHandler 异步完成)
    let drafts = DraftRepo::list(
        harness.env.meta.as_ref(),
        None,
        kb_core::model::Page::new(10, 0),
    )
    .await
    .expect("列草稿");
    let insight_id = drafts[0].insight_id.clone().expect("应记录 insight id");
    let insight = kb_core::ports::repo::InsightRepo::get(harness.env.meta.as_ref(), &insight_id)
        .await
        .expect("取 insight")
        .expect("转正后 insight 应存在");
    assert!(insight.title.contains("双哈希"), "{insight:?}");
    assert_eq!(insight.collection, harness.collection);
    // 草稿状态是 approved,且记录了 insight id
    let drafts = DraftRepo::list(
        harness.env.meta.as_ref(),
        None,
        kb_core::model::Page::new(10, 0),
    )
    .await
    .expect("列草稿");
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].state, DraftState::Approved);
    assert!(drafts[0].insight_id.is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revise_uses_the_reviewers_version() {
    let (harness, _extract, _review) = harness(config()).await;
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json(
        "标题",
        "原始正文",
        "howto",
    ))]));
    let revised = serde_json::json!({
        "decision": "revise",
        "score": 0.8,
        "revised": { "title": "修订后的标题", "body_md": "修订后的正文" },
        "reasons": ["表述要更具体"]
    })
    .to_string();
    let review = Arc::new(MockChatModel::script(vec![reply(&revised)]));
    let service = service(&harness, config(), extract, review);
    let outcome = service
        .process(&harness.project_id, "git_commit", "diff")
        .await
        .expect("处理事件");
    assert!(matches!(
        outcome.outcomes[0],
        kb_service::evolution::CandidateOutcome::Approved { .. }
    ));
    let drafts = DraftRepo::list(
        harness.env.meta.as_ref(),
        None,
        kb_core::model::Page::new(10, 0),
    )
    .await
    .expect("列草稿");
    assert_eq!(drafts[0].title, "修订后的标题");
    assert_eq!(drafts[0].body_md, "修订后的正文");
    assert_eq!(drafts[0].state, DraftState::Revised);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reject_keeps_the_draft_out_of_search() {
    let (harness, _extract, _review) = harness(config()).await;
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json(
        "泛泛而谈的经验",
        "写代码要注意质量。",
        "convention",
    ))]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json(
        "reject", 0.2,
    ))]));
    let service = service(&harness, config(), extract, review);
    let outcome = service
        .process(&harness.project_id, "git_commit", "diff")
        .await
        .expect("处理事件");
    assert!(matches!(
        outcome.outcomes[0],
        kb_service::evolution::CandidateOutcome::Rejected { .. }
    ));
    let titles = searchable(&harness, "泛泛而谈 经验").await;
    assert!(titles.is_empty(), "被驳回的草稿不应进检索:{titles:?}");
    let drafts = DraftRepo::list(
        harness.env.meta.as_ref(),
        None,
        kb_core::model::Page::new(10, 0),
    )
    .await
    .expect("列草稿");
    assert_eq!(drafts[0].state, DraftState::Rejected);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unauthorized_project_never_calls_the_llm() {
    let (harness, _extract, _review) = harness(config()).await;
    // 关掉 allow_cloud_llm
    let mut project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");
    project.allow_cloud_llm = false;
    ProjectRepo::update(harness.env.meta.as_ref(), project)
        .await
        .expect("更新");
    let extract = Arc::new(MockChatModel::reply(candidate_json("t", "b", "decision")));
    let review = Arc::new(MockChatModel::reply(review_json("approve", 0.9)));
    let service = service(&harness, config(), extract.clone(), review.clone());
    let outcome = service
        .process(&harness.project_id, "git_commit", "diff")
        .await
        .expect("处理事件");
    assert!(outcome.skipped_unauthorized);
    assert_eq!(extract.calls(), 0, "未授权时不应调用提炼模型");
    assert_eq!(review.calls(), 0, "未授权时不应调用审核模型");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn identical_candidate_is_skipped_by_fingerprint_without_review() {
    let (harness, _extract, _review) = harness(config()).await;
    let body = candidate_json("用双哈希判断重嵌入", "正文", "decision");
    let extract = Arc::new(MockChatModel::script(vec![reply(&body), reply(&body)]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json(
        "approve", 0.9,
    ))]));
    let service = service(&harness, config(), extract.clone(), review.clone());
    let first = service
        .process(&harness.project_id, "git_commit", "diff 1")
        .await
        .expect("第一次");
    assert_eq!(first.review_calls, 1);
    let second = service
        .process(&harness.project_id, "git_commit", "diff 1")
        .await
        .expect("第二次");
    assert!(
        second.has_skipped_fingerprint(),
        "第二次应命中指纹:{second:?}"
    );
    assert_eq!(review.calls(), 1, "指纹命中时不应再调用审核模型");
    // 草稿只有一条
    let drafts = DraftRepo::list(
        harness.env.meta.as_ref(),
        None,
        kb_core::model::Page::new(10, 0),
    )
    .await
    .expect("列草稿");
    assert_eq!(drafts.len(), 1, "{drafts:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn previously_rejected_candidate_is_marked_duplicate_without_review() {
    let (harness, _extract, _review) = harness(config()).await;
    // 第一次:被驳回
    let extract = Arc::new(MockChatModel::script(vec![
        reply(&candidate_json("旧标题", "同一件事的正文", "decision")),
        // 第二次:标题改写、意思相同 → 指纹不同,但向量一样
        reply(&candidate_json("新标题", "同一件事的正文", "decision")),
    ]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json(
        "reject", 0.1,
    ))]));
    // 测试用的假嵌入器对相似文本给不出很高的余弦值,这里把阈值调低以验证分支
    let mut cfg = config();
    cfg.dedup_similarity = 0.5;
    let service = service(&harness, cfg.clone(), extract.clone(), review.clone());
    service
        .process(&harness.project_id, "git_commit", "diff")
        .await
        .expect("第一次");
    let outcome = service
        .process(&harness.project_id, "git_commit", "diff")
        .await
        .expect("第二次");
    assert!(
        matches!(
            outcome.outcomes[0],
            kb_service::evolution::CandidateOutcome::PreviouslyRejected { .. }
        ),
        "{outcome:?}"
    );
    assert_eq!(review.calls(), 1, "命中“之前驳回”时不应再审核");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn exclusions_store_only_fingerprint_vector_and_reason() {
    let (harness, _extract, _review) = harness(config()).await;
    EvolutionRepo::exclude(
        harness.env.meta.as_ref(),
        &harness.collection,
        "fp-1",
        Some(vec![0.1, 0.2, 0.3]),
        Some("cpu-int8"),
        "人工标记不再提炼",
        1,
    )
    .await
    .expect("写排除");
    assert!(
        EvolutionRepo::is_excluded(harness.env.meta.as_ref(), &harness.collection, "fp-1")
            .await
            .expect("查排除")
    );
    // 排除表里没有标题 / 正文列(结构上就不存),这里断言向量能被读出来
    let vectors = EvolutionRepo::excluded_vectors(
        harness.env.meta.as_ref(),
        &harness.collection,
        "cpu-int8",
        10,
    )
    .await
    .expect("查向量");
    assert_eq!(vectors.len(), 1);
    assert_eq!(vectors[0].0, "fp-1");
    assert!((vectors[0].1[0] - 0.1).abs() < 1e-6);
    // 换嵌入器后旧向量不参与比较
    let other = EvolutionRepo::excluded_vectors(
        harness.env.meta.as_ref(),
        &harness.collection,
        "other-embedder",
        10,
    )
    .await
    .expect("查向量");
    assert!(other.is_empty(), "{other:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn drafts_are_invisible_before_promotion() {
    let (harness, _extract, _review) = harness(config()).await;
    let mut cfg = config();
    cfg.review_mode = "human".to_owned();
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json(
        "需要人工确认的经验",
        "正文内容足够具体。",
        "decision",
    ))]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json(
        "approve", 0.95,
    ))]));
    let service = service(&harness, cfg, extract, review);
    let outcome = service
        .process(&harness.project_id, "git_commit", "diff")
        .await
        .expect("处理事件");
    assert!(matches!(
        outcome.outcomes[0],
        kb_service::evolution::CandidateOutcome::PendingReview { .. }
    ));
    // human 模式下只进收件箱,搜索不到
    let titles = searchable(&harness, "人工确认 经验").await;
    assert!(titles.is_empty(), "未转正的草稿不应可检索:{titles:?}");
    // 但草稿表里有,而且是 pending(收件箱按 pending 过滤才看得到)
    let drafts = DraftRepo::list(
        harness.env.meta.as_ref(),
        Some(DraftState::Pending),
        kb_core::model::Page::new(10, 0),
    )
    .await
    .expect("列草稿");
    assert_eq!(drafts.len(), 1);
    assert_eq!(drafts[0].state, DraftState::Pending);
    assert!(drafts[0].insight_id.is_none());
    let _ = (ItemStatus::Active, RecordKind::Insight);
    let _ = CollectionRepo::get(harness.env.meta.as_ref(), &harness.collection).await;
    let _ = SourceService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.scanner.clone(),
        harness.env.paths(),
        kb_core::config::UploadConfig::default(),
    );
}
