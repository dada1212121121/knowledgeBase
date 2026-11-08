//! 收尾验收:审核收件箱(人工通过 / 修订通过 / 驳回 / 不再提炼)。
//!
//! 用 mock LLM 让草稿以 `review_mode = "human"` 落进收件箱,再走人工那一步。
//! 断言的重点是“人工确认之后到底发生了什么”:转正是否带上关联文件、能否整批撤销、
//! 「不再提炼」是否只存指纹与向量、驳回之后搜索是否真的搜不到。

use std::sync::Arc;

use kb_core::config::EvolutionConfig;
use kb_core::model::{ChatResponse, DraftState, Page, RecordKind};
use kb_core::ports::ChatModel;
use kb_core::ports::repo::{DraftRepo, EvolutionRepo, InsightRepo, ProjectRepo};
use kb_llm::MockChatModel;
use kb_service::ProjectService;
use kb_service::RevertService;
use kb_service::evolution::{ApproveEdits, DraftInbox, EvolutionService};
use kb_service::insight::InsightJobHandler;
use kb_service::jobs::queue::JobQueue;
use kb_service::jobs::{JobRouter, Worker};
use kb_service::llm_gate::{GateConfig, LlmGate};
use kb_service::search::{SearchOptions, SearchRequest, SearchService};
use kb_testkit::TestEnv;

struct Harness {
    env: TestEnv,
    project_id: String,
    collection: String,
}

/// 建项目 + 打开提炼开关 + 进 human 模式(草稿一律进收件箱)。
async fn harness() -> Harness {
    let env = TestEnv::new().await;
    let service = ProjectService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let dir = tempfile::tempdir().expect("目录");
    std::fs::write(dir.path().join("lib.rs"), "fn main() {}\n").expect("写文件");
    let project = service.add(dir.path(), Some("demo")).await.expect("加项目");
    let collection = format!("proj_{}", project.slug);
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
    Harness {
        env,
        project_id,
        collection,
    }
}

fn config() -> EvolutionConfig {
    EvolutionConfig {
        review_mode: "human".to_owned(),
        approve_threshold: 0.7,
        dedup_similarity: 0.99,
        ..EvolutionConfig::default()
    }
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

fn candidate_json(title: &str, body: &str) -> String {
    serde_json::json!({
        "items": [{
            "title": title,
            "body_md": body,
            "kind": "decision",
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
        "reasons": ["具体且与证据一致", "长期有效"]
    })
    .to_string()
}

/// 跑一次提炼,让一条草稿落进收件箱,返回草稿 id。
async fn pending_draft(harness: &Harness, title: &str, body: &str) -> String {
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json(
        title, body,
    ))]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json(
        "approve", 0.9,
    ))]));
    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    let service = EvolutionService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
        gate,
        extract as Arc<dyn ChatModel>,
        review as Arc<dyn ChatModel>,
        config(),
    );
    let outcome = service
        .process(
            &harness.project_id,
            "git_commit",
            "diff --git a/src/index.rs",
        )
        .await
        .expect("处理事件");
    assert_eq!(outcome.candidates, 1, "{outcome:?}");
    let drafts = DraftRepo::list(
        harness.env.meta.as_ref(),
        Some(DraftState::Pending),
        Page::new(10, 0),
    )
    .await
    .expect("列草稿");
    drafts.first().expect("应有待审草稿").id.clone()
}

fn inbox(harness: &Harness) -> DraftInbox {
    DraftInbox::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
    )
}

/// 跑完队列里的任务(转正只写 SQLite,向量由 `save_insight` 任务异步写入 LanceDB)。
async fn drain(harness: &Harness) {
    let mut router = JobRouter::new();
    router.register(
        "save_insight",
        Arc::new(InsightJobHandler::new(
            harness.env.meta.clone(),
            harness.env.store.clone(),
            harness.env.embedder.clone(),
        )),
    );
    let worker = Worker::new(
        Arc::new(JobQueue::new(harness.env.meta.clone())),
        Arc::new(router),
        tokio::sync::watch::channel(false).1,
    );
    while worker.run_once().await.expect("跑任务").is_some() {}
}

async fn search_titles(harness: &Harness, query: &str) -> Vec<String> {
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
async fn list_shows_review_score_reasons_and_evidence() {
    let harness = harness().await;
    let id = pending_draft(&harness, "块哈希不变就不重嵌入", "用内容哈希判断。").await;

    let page = inbox(&harness)
        .list(Some(DraftState::Pending), Page::new(20, 0))
        .await
        .expect("列草稿");
    assert_eq!(page.total, 1);
    assert_eq!(page.counts.pending, 1);
    assert_eq!(page.counts.approved, 0);
    let item = &page.drafts[0];
    assert_eq!(item.id, id);
    assert_eq!(item.project.as_deref(), Some("demo"));
    assert_eq!(item.collection, harness.collection);
    assert_eq!(item.kind, "decision");
    assert_eq!(item.state, "pending");
    // 审核结论摊平给前端
    assert_eq!(item.decision.as_deref(), Some("approve"));
    assert_eq!(item.score, Some(0.9));
    assert_eq!(item.reasons.len(), 2, "{item:?}");
    assert_eq!(item.evidence, vec!["diff 里的片段".to_owned()]);
    // 迁移 0008 之后草稿记住了关联文件
    assert_eq!(item.related_paths, vec!["src/index.rs".to_owned()]);
    assert_eq!(item.tags, vec!["索引".to_owned()]);

    // 按状态过滤:没有已通过的
    let approved = inbox(&harness)
        .list(Some(DraftState::Approved), Page::new(20, 0))
        .await
        .expect("列草稿");
    assert_eq!(approved.total, 0);
    // 非法状态名被拒(参数校验在能力层,这里只验解析函数)
    assert!(kb_service::evolution::inbox::parse_state("nonsense").is_err());
    assert!(
        kb_service::evolution::inbox::parse_state("all")
            .expect("all")
            .is_none()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn approve_promotes_with_paths_and_can_be_reverted() {
    let harness = harness().await;
    let id = pending_draft(&harness, "块哈希不变就不重嵌入", "用内容哈希判断。").await;
    // 收件箱里的草稿在转正前搜不到
    assert!(search_titles(&harness, "块哈希").await.is_empty());

    let outcome = inbox(&harness)
        .approve(&id, &ApproveEdits::default(), "user")
        .await
        .expect("通过");
    assert!(!outcome.revised);
    assert_eq!(outcome.draft_id, id);

    let insight = InsightRepo::get(harness.env.meta.as_ref(), &outcome.insight_id)
        .await
        .expect("取 insight")
        .expect("转正后应有 insight");
    assert_eq!(insight.title, "块哈希不变就不重嵌入");
    assert_eq!(insight.collection, harness.collection);
    // 关联文件不再丢(迁移 0008 之前这里是空的)
    assert_eq!(insight.related_paths, vec!["src/index.rs".to_owned()]);

    let draft = DraftRepo::get(harness.env.meta.as_ref(), &id)
        .await
        .expect("取草稿")
        .expect("存在");
    assert_eq!(draft.state, DraftState::Approved);
    assert_eq!(
        draft.insight_id.as_deref(),
        Some(outcome.insight_id.as_str())
    );
    assert!(draft.decided_at.is_some());

    // 转正会投递一个 `save_insight` 任务(向量由它异步写进 LanceDB)
    let jobs = kb_core::ports::repo::JobRepo::list(harness.env.meta.as_ref(), None)
        .await
        .expect("列任务");
    assert!(
        jobs.iter().any(|job| job.kind == "save_insight"),
        "转正应投递 save_insight 任务:{jobs:?}"
    );
    drain(&harness).await;
    assert!(
        search_titles(&harness, "块哈希")
            .await
            .iter()
            .any(|title| title.contains("块哈希")),
        "跑完任务后应可检索"
    );

    // 整批可撤销:撤销之后 insight 没了,草稿仍是 approved(记录保留)
    let revert = RevertService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
    );
    let report = revert.revert(&outcome.batch_id).await.expect("撤销批次");
    assert!(!report.reverted.is_empty(), "{report:?}");
    assert!(
        InsightRepo::get(harness.env.meta.as_ref(), &outcome.insight_id)
            .await
            .expect("取 insight")
            .is_none(),
        "撤销后 insight 应被删除"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn approve_with_edits_marks_revised_and_uses_new_text() {
    let harness = harness().await;
    let id = pending_draft(&harness, "原标题", "原正文。").await;

    let outcome = inbox(&harness)
        .approve(
            &id,
            &ApproveEdits {
                title: Some("改过的标题".to_owned()),
                body_md: Some("改过的正文,更具体。".to_owned()),
                tags: Some(vec!["索引".to_owned(), "性能".to_owned()]),
            },
            "user",
        )
        .await
        .expect("修订通过");
    assert!(outcome.revised);

    let insight = InsightRepo::get(harness.env.meta.as_ref(), &outcome.insight_id)
        .await
        .expect("取 insight")
        .expect("应有 insight");
    assert_eq!(insight.title, "改过的标题");
    assert_eq!(insight.body_md, "改过的正文,更具体。");
    assert!(insight.tags.contains(&"性能".to_owned()), "{insight:?}");

    let draft = DraftRepo::get(harness.env.meta.as_ref(), &id)
        .await
        .expect("取草稿")
        .expect("存在");
    assert_eq!(draft.state, DraftState::Revised);
    assert_eq!(draft.title, "改过的标题");

    // 已通过的草稿不能再通过一次(不重复建条目),也不能再驳回(驳回不会删掉已转正的条目)
    let error = inbox(&harness)
        .approve(&id, &ApproveEdits::default(), "user")
        .await
        .expect_err("重复通过应被拒");
    assert!(
        matches!(error, kb_core::KbError::InvalidInput(_)),
        "{error}"
    );
    let error = inbox(&harness)
        .reject(&id, true)
        .await
        .expect_err("已转正的草稿不能驳回");
    assert!(
        matches!(error, kb_core::KbError::InvalidInput(_)),
        "{error}"
    );
    // 驳回被拒之后没有写排除表(不然同一条候选会被永久拦住)
    let draft = DraftRepo::get(harness.env.meta.as_ref(), &id)
        .await
        .expect("取草稿")
        .expect("存在");
    assert!(
        !EvolutionRepo::is_excluded(
            harness.env.meta.as_ref(),
            &harness.collection,
            &draft.fingerprint
        )
        .await
        .expect("查排除表")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reject_keeps_it_out_of_the_index_and_can_never_extract() {
    let harness = harness().await;
    let id = pending_draft(&harness, "一次性结论", "这条不该转正。").await;

    let outcome = inbox(&harness).reject(&id, false).await.expect("驳回");
    assert!(!outcome.excluded);
    let draft = DraftRepo::get(harness.env.meta.as_ref(), &id)
        .await
        .expect("取草稿")
        .expect("存在");
    assert_eq!(draft.state, DraftState::Rejected);
    assert!(draft.insight_id.is_none());
    assert_eq!(
        InsightRepo::list(
            harness.env.meta.as_ref(),
            &harness.collection,
            None,
            Page::new(10, 0)
        )
        .await
        .expect("列 insight")
        .len(),
        0,
        "驳回不应产生 insight"
    );
    assert!(search_titles(&harness, "一次性结论").await.is_empty());

    // 再驳回一次是幂等的(不报错、不重复写排除表)
    let again = inbox(&harness).reject(&id, false).await.expect("重复驳回");
    assert!(!again.excluded);

    // 「不再提炼」:写排除表 + 清空正文
    let excluded = inbox(&harness).reject(&id, true).await.expect("不再提炼");
    assert!(excluded.excluded);
    let draft = DraftRepo::get(harness.env.meta.as_ref(), &id)
        .await
        .expect("取草稿")
        .expect("存在");
    assert!(draft.body_md.is_empty(), "不再提炼应清空正文");
    assert_eq!(draft.evidence_json, "[]");
    assert!(
        EvolutionRepo::is_excluded(
            harness.env.meta.as_ref(),
            &harness.collection,
            &draft.fingerprint
        )
        .await
        .expect("查排除表"),
        "应写入排除表"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn never_extract_blocks_the_next_identical_candidate_without_llm_calls() {
    let harness = harness().await;
    let id = pending_draft(&harness, "重复出现的结论", "同一条会被再次提炼。").await;
    inbox(&harness).reject(&id, true).await.expect("不再提炼");

    // 同一条候选再来一次:指纹命中排除表,一次审核都不调
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json(
        "重复出现的结论",
        "同一条会被再次提炼。",
    ))]));
    let review = Arc::new(MockChatModel::script(vec![]));
    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    let service = EvolutionService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
        gate,
        extract as Arc<dyn ChatModel>,
        review.clone() as Arc<dyn ChatModel>,
        config(),
    );
    let outcome = service
        .process(
            &harness.project_id,
            "git_commit",
            "diff --git a/src/index.rs",
        )
        .await
        .expect("处理事件");
    assert_eq!(outcome.review_calls, 0, "命中排除表后不应调用审核模型");
    assert!(outcome.has_skipped_fingerprint(), "{outcome:?}");
    assert_eq!(
        DraftRepo::count(harness.env.meta.as_ref(), Some(DraftState::Pending))
            .await
            .expect("计数"),
        0,
        "不应新建待审草稿"
    );
    assert_eq!(review.calls(), 0);
}

/// 修订后通过的草稿必须能在「已通过」页签里看到。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revised_drafts_show_up_under_the_approved_tab() {
    let harness = harness().await;
    let id = pending_draft(&harness, "原标题", "原正文。").await;
    inbox(&harness)
        .approve(
            &id,
            &ApproveEdits {
                title: Some("改过的标题".to_owned()),
                ..ApproveEdits::default()
            },
            "user",
        )
        .await
        .expect("修订通过");

    let approved = inbox(&harness)
        .list(Some(DraftState::Approved), Page::new(20, 0))
        .await
        .expect("列已通过");
    assert_eq!(
        approved.total, 1,
        "修订通过的草稿应计入「已通过」:{approved:?}"
    );
    assert_eq!(approved.counts.approved, 1);
    assert_eq!(approved.drafts[0].id, id);
    assert_eq!(approved.drafts[0].state, "revised");
    // 待审页签里没有它
    let pending = inbox(&harness)
        .list(Some(DraftState::Pending), Page::new(20, 0))
        .await
        .expect("列待审");
    assert_eq!(pending.total, 0);
    // 全部页签能看到
    let all = inbox(&harness)
        .list(None, Page::new(20, 0))
        .await
        .expect("列全部");
    assert_eq!(all.total, 1);
}

/// 两个“通过”同时进来,只能建出一条 insight(并发保护)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_approvals_create_only_one_insight() {
    let harness = harness().await;
    let id = pending_draft(&harness, "并发通过", "两个标签页同时点。").await;
    let first = inbox(&harness);
    let second = inbox(&harness);
    let left = {
        let id = id.clone();
        async move { first.approve(&id, &ApproveEdits::default(), "user").await }
    };
    let right = {
        let id = id.clone();
        async move { second.approve(&id, &ApproveEdits::default(), "user").await }
    };
    let (left, right) = tokio::join!(left, right);
    let ok = [&left, &right]
        .iter()
        .filter(|result| result.is_ok())
        .count();
    assert_eq!(ok, 1, "只应有一次通过成功:{left:?} / {right:?}");
    let insights = InsightRepo::list(
        harness.env.meta.as_ref(),
        &harness.collection,
        None,
        Page::new(20, 0),
    )
    .await
    .expect("列 insight");
    assert_eq!(insights.len(), 1, "并发通过不应建出两条:{insights:?}");
}

/// 旧实现留下的“approved 但没有 insight_id”的草稿:迁移放回 pending,人工还能通过。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn legacy_approved_row_without_insight_can_still_be_approved() {
    let harness = harness().await;
    let id = pending_draft(&harness, "旧实现留下的行", "正文。").await;
    // 手工造一条旧形状的行:approved + 没有 insight_id
    let mut draft = DraftRepo::get(harness.env.meta.as_ref(), &id)
        .await
        .expect("取草稿")
        .expect("存在");
    draft.state = DraftState::Approved;
    draft.insight_id = None;
    DraftRepo::update(harness.env.meta.as_ref(), draft)
        .await
        .expect("改成旧形状");

    // 守卫只看 insight_id:这类行仍然可以通过(迁移 0009 会把它们放回 pending)
    let outcome = inbox(&harness)
        .approve(&id, &ApproveEdits::default(), "user")
        .await
        .expect("旧行可以通过");
    assert!(!outcome.insight_id.is_empty());
}

/// 标签没变就不算修订。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unchanged_tags_do_not_count_as_a_revision() {
    let harness = harness().await;
    let id = pending_draft(&harness, "标签不变的通过", "正文。").await;
    let draft = DraftRepo::get(harness.env.meta.as_ref(), &id)
        .await
        .expect("取草稿")
        .expect("存在");
    let outcome = inbox(&harness)
        .approve(
            &id,
            &ApproveEdits {
                tags: Some(draft.tags.clone()),
                ..ApproveEdits::default()
            },
            "user",
        )
        .await
        .expect("通过");
    assert!(!outcome.revised, "标签没变不应记成修订");
    let after = DraftRepo::get(harness.env.meta.as_ref(), &id)
        .await
        .expect("取草稿")
        .expect("存在");
    assert_eq!(after.state, DraftState::Approved);
}

/// 转正失败时抢占必须释放:修完还能再点一次通过(质量检查 的失败注入)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn failed_approval_releases_the_claim() {
    let harness = harness().await;
    let id = pending_draft(&harness, "会失败的一次通过", "正文。").await;

    // 把草稿正文清空:转正时 `InsightService::save` 会因为正文为空而失败
    let mut draft = DraftRepo::get(harness.env.meta.as_ref(), &id)
        .await
        .expect("取草稿")
        .expect("存在");
    let good_body = draft.body_md.clone();
    draft.body_md = String::new();
    DraftRepo::update(harness.env.meta.as_ref(), draft)
        .await
        .expect("清空正文");

    let error = inbox(&harness)
        .approve(&id, &ApproveEdits::default(), "user")
        .await
        .expect_err("正文为空时转正应失败");
    assert!(
        matches!(error, kb_core::KbError::InvalidInput(_)),
        "错误类型不对:{error}"
    );

    // 抢占已释放:补回正文后能再通过
    let mut draft = DraftRepo::get(harness.env.meta.as_ref(), &id)
        .await
        .expect("取草稿")
        .expect("存在");
    draft.body_md = good_body;
    DraftRepo::update(harness.env.meta.as_ref(), draft)
        .await
        .expect("补回正文");
    let outcome = inbox(&harness)
        .approve(&id, &ApproveEdits::default(), "user")
        .await
        .expect("重试应成功");
    assert!(!outcome.insight_id.is_empty());
}

/// 抢占过期后可以重来:进程被杀 / 请求取消不会把草稿永久卡住。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn expired_claim_can_be_taken_over() {
    let harness = harness().await;
    let id = pending_draft(&harness, "抢占过期的草稿", "正文。").await;

    let ttl = kb_service::evolution::inbox::CLAIM_TTL_MS;
    let now = kb_service::llm_gate::today_now_millis();
    assert!(
        DraftRepo::claim(harness.env.meta.as_ref(), &id, now, ttl)
            .await
            .expect("抢占"),
        "第一次抢占应成功"
    );
    // 抢占期内第二次抢不到
    assert!(
        !DraftRepo::claim(harness.env.meta.as_ref(), &id, now + 1000, ttl)
            .await
            .expect("抢占"),
        "抢占有效期内不该被第二次抢到"
    );
    // 令牌不对的释放不会清掉别人的抢占
    DraftRepo::release_claim(harness.env.meta.as_ref(), &id, now + 999)
        .await
        .expect("释放");
    assert!(
        !DraftRepo::claim(harness.env.meta.as_ref(), &id, now + 2000, ttl)
            .await
            .expect("抢占"),
        "用错令牌的释放不该生效"
    );
    // 模拟“抢占之后进程被杀”:标记停在 3 个 TTL 之前,approve 应该能接管
    // 用抢到的那个时间戳释放(慢请求不能清掉别人的抢占)
    DraftRepo::release_claim(harness.env.meta.as_ref(), &id, now)
        .await
        .expect("释放");
    assert!(
        DraftRepo::claim(harness.env.meta.as_ref(), &id, now - ttl * 3, ttl)
            .await
            .expect("抢占")
    );
    let outcome = inbox(&harness)
        .approve(&id, &ApproveEdits::default(), "user")
        .await
        .expect("过期抢占应可接管");
    assert!(!outcome.insight_id.is_empty());

    // 启动时的清扫:已转正的行把抢占标记清掉
    let cleared = DraftRepo::clear_stale_claims(
        harness.env.meta.as_ref(),
        kb_service::llm_gate::today_now_millis(),
        kb_service::evolution::inbox::CLAIM_TTL_MS,
    )
    .await
    .expect("清扫");
    assert!(cleared >= 1, "转正过的行应被清扫:{cleared}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unknown_draft_is_not_found() {
    let harness = harness().await;
    let error = inbox(&harness)
        .approve("drf_missing", &ApproveEdits::default(), "user")
        .await
        .expect_err("不存在的草稿");
    assert!(matches!(error, kb_core::KbError::NotFound(_)), "{error}");
    let error = inbox(&harness)
        .reject("drf_missing", false)
        .await
        .expect_err("不存在的草稿");
    assert!(matches!(error, kb_core::KbError::NotFound(_)), "{error}");
    // 计数接口能正常读到空表
    let page = inbox(&harness)
        .list(None, Page::new(10, 0))
        .await
        .expect("全部");
    assert_eq!(page.total, 0);
    let _ = RecordKind::Insight;
}
