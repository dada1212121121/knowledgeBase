//! 验收:主题归纳(`consolidate_project`)。
//!
//! 覆盖三条验收要求:
//! - `dry_run`(默认)只聚类、**一次 LLM 都不调**、不写草稿、不改任何状态;
//! - 正式执行时归纳出的条目走 的状态机转正,并能按批次撤销;
//! - 同样的主题再跑一次被指纹拦住(不重复产生条目)。
//!
//! 另外覆盖外发闸门:项目没开 `allow_cloud_llm` 时直接 `Forbidden`,不调 LLM。

use std::sync::Arc;

use kb_core::config::EvolutionConfig;
use kb_core::model::{ChatResponse, DraftState, Insight, ItemStatus, Page};
use kb_core::ports::ChatModel;
use kb_core::ports::repo::{AuditRepo, DraftRepo, EdgeRepo, InsightRepo, ProjectRepo};
use kb_llm::MockChatModel;
use kb_service::evolution::ConsolidateService;
use kb_service::llm_gate::{GateConfig, LlmGate};
use kb_service::{ProjectService, RevertService};
use kb_testkit::TestEnv;

struct Harness {
    env: TestEnv,
    project_id: String,
    collection: String,
}

/// 建一个项目,并按需打开 `allow_cloud_llm`。
async fn harness(allow_cloud_llm: bool, config: EvolutionConfig) -> Harness {
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
    project.allow_cloud_llm = allow_cloud_llm;
    let project_id = project.id.clone();
    ProjectRepo::update(env.meta.as_ref(), project)
        .await
        .expect("更新项目");
    let _ = config;
    Harness {
        env,
        project_id,
        collection,
    }
}

/// 直接往 insights 表塞一条(测试里不走 LLM)。
async fn insert_insight(harness: &Harness, id: &str, title: &str, body: &str, created_at: i64) {
    let insight = Insight {
        id: id.to_owned(),
        collection: harness.collection.clone(),
        title: title.to_owned(),
        body_md: body.to_owned(),
        kind: kb_core::model::InsightKind::Decision,
        tags: Vec::new(),
        related_paths: vec!["src/index.rs".to_owned()],
        status: ItemStatus::Active,
        version: 1,
        valid_from: created_at,
        valid_until: None,
        superseded_by: None,
        created_by: "agent".to_owned(),
        batch_id: None,
        created_at,
        updated_at: created_at,
    };
    InsightRepo::create(harness.env.meta.as_ref(), insight)
        .await
        .expect("写 insight");
}

/// 两条正文相同的条目(假嵌入器下余弦≈1)+ 一条无关条目。
async fn seed_topic(harness: &Harness) {
    insert_insight(
        harness,
        "000000000000000000000000000000c1",
        "增量索引只看内容哈希",
        "块内容哈希没变就不重新嵌入。",
        1_000,
    )
    .await;
    insert_insight(
        harness,
        "000000000000000000000000000000c2",
        "增量索引的双哈希判断",
        "块内容哈希没变就不重新嵌入。",
        2_000,
    )
    .await;
    insert_insight(
        harness,
        "000000000000000000000000000000c3",
        "完全无关的一条",
        "部署脚本要用 setsid 脱离会话。",
        3_000,
    )
    .await;
}

fn config() -> EvolutionConfig {
    EvolutionConfig {
        // 归纳结果直接按 AI 审核转正,便于断言“新建了 1 条”
        review_mode: "ai".to_owned(),
        approve_threshold: 0.7,
        // 去重阈值调高,避免把“归纳条目”与成员判成重复(那是另一条卡的行为)
        dedup_similarity: 0.99,
        // 同一主题的阈值取 0.9:假嵌入器下只有正文相同的两条才聚到一起
        consolidate_similarity: 0.9,
        consolidate_min_members: 2,
        consolidate_max_clusters: 5,
        ..EvolutionConfig::default()
    }
}

fn service(
    harness: &Harness,
    config: EvolutionConfig,
    model: Arc<MockChatModel>,
    review_model: Arc<MockChatModel>,
) -> ConsolidateService {
    ConsolidateService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
        LlmGate::new(harness.env.meta.clone(), GateConfig::default()),
        model as Arc<dyn ChatModel>,
        review_model as Arc<dyn ChatModel>,
        config,
    )
}

fn candidate_json(title: &str, body: &str) -> String {
    serde_json::json!({
        "items": [{
            "title": title,
            "body_md": body,
            "kind": "decision",
            "tags": ["索引"],
            "related_paths": ["src/index.rs"],
            "evidence": "c1,c2",
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

async fn drafts(harness: &Harness) -> Vec<kb_core::model::Draft> {
    DraftRepo::list(harness.env.meta.as_ref(), None, Page::new(20, 0))
        .await
        .expect("列草稿")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dry_run_lists_topics_without_calling_the_llm_or_writing() {
    let harness = harness(true, config()).await;
    seed_topic(&harness).await;
    let model = Arc::new(MockChatModel::reply("{}"));
    let review = Arc::new(MockChatModel::reply("{}"));
    let service = service(&harness, config(), model.clone(), review.clone());

    let report = service
        .run(&harness.project_id, true, "test")
        .await
        .expect("演练");

    assert!(report.dry_run);
    assert_eq!(report.compared, 3, "三条都参与聚类:{report:?}");
    assert_eq!(report.clusters.len(), 1, "只有一对相似:{report:?}");
    let cluster = &report.clusters[0];
    assert_eq!(
        cluster.representative_id, "000000000000000000000000000000c2",
        "代表取最新的那条"
    );
    assert_eq!(cluster.topic, "增量索引的双哈希判断");
    assert_eq!(
        cluster.member_ids(),
        vec![
            "000000000000000000000000000000c2".to_owned(),
            "000000000000000000000000000000c1".to_owned()
        ]
    );
    assert_eq!(report.outcomes.len(), 1, "{report:?}");
    assert!(matches!(
        report.outcomes[0],
        kb_service::evolution::ClusterOutcome::Planned { .. }
    ));
    assert_eq!(report.llm_calls, 0, "演练不许调 LLM");
    assert_eq!(model.calls(), 0, "归纳模型一次都不该被调用");
    assert_eq!(review.calls(), 0, "审核模型一次都不该被调用");
    assert_eq!(report.created, 0);
    assert!(report.batch_id.is_none());
    assert!(drafts(&harness).await.is_empty(), "演练不写草稿");
    // 原有条目状态不变
    let insight = InsightRepo::get(
        harness.env.meta.as_ref(),
        "000000000000000000000000000000c1",
    )
    .await
    .expect("取")
    .expect("存在");
    assert_eq!(insight.status, ItemStatus::Active);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn execution_promotes_one_insight_and_the_batch_is_revertable() {
    let harness = harness(true, config()).await;
    seed_topic(&harness).await;
    let model = Arc::new(MockChatModel::script(vec![reply(&candidate_json(
        "增量索引的双哈希判断",
        "块内容哈希没变就不重新嵌入;元数据哈希变了只更新 meta。",
    ))]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json(
        "approve", 0.9,
    ))]));
    let service = service(&harness, config(), model.clone(), review.clone());

    let report = service
        .run(&harness.project_id, false, "test")
        .await
        .expect("执行");

    assert!(!report.dry_run);
    assert_eq!(report.llm_calls, 1, "每个主题归纳一次");
    assert_eq!(model.calls(), 1);
    assert_eq!(report.created, 1, "{report:?}");
    assert_eq!(report.outcomes.len(), 1);
    assert!(
        matches!(
            &report.outcomes[0],
            kb_service::evolution::ClusterOutcome::Reviewed { .. }
        ),
        "{:?}",
        report.outcomes
    );
    let batch_id = report.batch_id.clone().expect("应记录批次");
    // 归纳结果转正:草稿 approved,insights 里有新条目且带着批次号
    let drafts = drafts(&harness).await;
    assert_eq!(drafts.len(), 1, "{drafts:?}");
    assert_eq!(drafts[0].state, DraftState::Approved);
    let insight_id = drafts[0].insight_id.clone().expect("应记录 insight id");
    let insight = InsightRepo::get(harness.env.meta.as_ref(), &insight_id)
        .await
        .expect("取")
        .expect("转正后应存在");
    assert_eq!(insight.title, "增量索引的双哈希判断");
    assert!(insight.body_md.contains("元数据哈希"), "{insight:?}");
    // 归纳结果带上主题成员的文件(草稿表不存 related_paths,转正后由服务补上)
    assert_eq!(
        insight.related_paths,
        vec!["src/index.rs".to_owned()],
        "{insight:?}"
    );
    let edges = EdgeRepo::by_src(harness.env.meta.as_ref(), &insight_id)
        .await
        .expect("查边");
    assert!(
        edges
            .iter()
            .any(|edge| edge.rel == kb_core::model::EdgeRel::AboutFile
                && edge.dst == "path:src/index.rs"),
        "应写 about_file 边:{edges:?}"
    );
    // 批次里有一条 `insight.create`,撤销就靠它
    let changes = AuditRepo::changes(harness.env.meta.as_ref(), &batch_id)
        .await
        .expect("查批次变更");
    assert_eq!(changes.len(), 1, "{changes:?}");
    assert_eq!(changes[0].target, insight_id);

    // 可撤销:撤销批次后新条目被删掉,原有成员不受影响
    let revert = RevertService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
    );
    let revert_report = revert.revert(&batch_id).await.expect("撤销");
    assert!(!revert_report.reverted.is_empty(), "{revert_report:?}");
    assert!(
        InsightRepo::get(harness.env.meta.as_ref(), &insight_id)
            .await
            .expect("取")
            .is_none(),
        "撤销后归纳条目应被删除"
    );
    for member in [
        "000000000000000000000000000000c1",
        "000000000000000000000000000000c2",
    ] {
        assert!(
            InsightRepo::get(harness.env.meta.as_ref(), member)
                .await
                .expect("取")
                .is_some(),
            "成员条目不该被撤销带走"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_second_run_is_blocked_by_the_fingerprint() {
    let harness = harness(true, config()).await;
    seed_topic(&harness).await;
    let candidate = candidate_json(
        "增量索引的双哈希判断",
        "块内容哈希没变就不重新嵌入;元数据哈希变了只更新 meta。",
    );
    // 两次执行共用一段脚本:归纳两次(内容相同)+ 审核一次(第二次被指纹拦住,不再审核)
    let model = Arc::new(MockChatModel::script(vec![
        reply(&candidate),
        reply(&candidate),
    ]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json(
        "approve", 0.9,
    ))]));
    let service = service(&harness, config(), model.clone(), review.clone());

    let first = service
        .run(&harness.project_id, false, "test")
        .await
        .expect("第一次");
    assert_eq!(first.created, 1, "{first:?}");

    let second = service
        .run(&harness.project_id, false, "test")
        .await
        .expect("第二次");
    assert_eq!(second.created, 0, "同样的归纳结果不该再产生条目");
    assert_eq!(second.llm_calls, 1, "归纳仍会跑一次(聚类照常)");
    assert!(
        matches!(
            &second.outcomes[0],
            kb_service::evolution::ClusterOutcome::Skipped { .. }
        ),
        "{:?}",
        second.outcomes
    );
    assert_eq!(review.calls(), 1, "指纹拦住后不再调审核");
    assert_eq!(drafts(&harness).await.len(), 1, "草稿也只有一条");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unauthorized_project_is_rejected_before_any_llm_call() {
    let harness = harness(false, config()).await;
    seed_topic(&harness).await;
    let model = Arc::new(MockChatModel::script(Vec::new()));
    let review = Arc::new(MockChatModel::script(Vec::new()));
    let service = service(&harness, config(), model.clone(), review.clone());

    let err = service
        .run(&harness.project_id, false, "test")
        .await
        .expect_err("没开 allow_cloud_llm 应被拒");
    assert!(
        matches!(err, kb_core::KbError::Forbidden(_)),
        "错误类型:{err:?}"
    );
    assert_eq!(model.calls(), 0, "被拒时一次都不该调 LLM");
    assert_eq!(review.calls(), 0);
    assert!(drafts(&harness).await.is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_project_without_enough_insights_is_a_no_op() {
    let harness = harness(true, config()).await;
    insert_insight(
        &harness,
        "000000000000000000000000000000d1",
        "只有一条",
        "单条不成主题。",
        1_000,
    )
    .await;
    let model = Arc::new(MockChatModel::reply("{}"));
    let review = Arc::new(MockChatModel::reply("{}"));
    let service = service(&harness, config(), model.clone(), review.clone());

    let report = service
        .run(&harness.project_id, false, "test")
        .await
        .expect("执行");
    assert_eq!(report.compared, 0, "条目不足时不嵌入、不聚类");
    assert!(report.clusters.is_empty());
    assert_eq!(report.llm_calls, 0);
    assert_eq!(model.calls(), 0);
}
