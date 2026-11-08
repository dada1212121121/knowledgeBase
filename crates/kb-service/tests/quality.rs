//! 验收:去重(只向量)与质量报告;dry_run 出计划、执行后可撤销。

use kb_core::config::EvolutionConfig;
use kb_core::model::{Feedback, ItemStatus, Page};
use kb_core::ports::repo::{CollectionRepo, EdgeRepo, FeedbackRepo, InsightRepo, ProjectRepo};
use kb_service::evolution::DedupService;
use kb_service::{ProjectService, RevertService};
use kb_testkit::TestEnv;

struct Harness {
    env: TestEnv,
    collection: String,
}

async fn harness(dedup_similarity: f64) -> (Harness, EvolutionConfig) {
    let env = TestEnv::new().await;
    let service = ProjectService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let dir = tempfile::tempdir().expect("目录");
    std::fs::write(dir.path().join("lib.rs"), "fn main() {}\n").expect("写文件");
    let project = service.add(dir.path(), Some("demo")).await.expect("加项目");
    let collection = format!("proj_{}", project.slug);
    let config = EvolutionConfig {
        dedup_similarity,
        ..EvolutionConfig::default()
    };
    (Harness { env, collection }, config)
}

/// 直接往 insights 表塞一条(测试里不走 LLM)。
async fn insert_insight(
    harness: &Harness,
    id: &str,
    title: &str,
    body: &str,
    created_at: i64,
    related_paths: Vec<String>,
) {
    let insight = kb_core::model::Insight {
        id: id.to_owned(),
        collection: harness.collection.clone(),
        title: title.to_owned(),
        body_md: body.to_owned(),
        kind: kb_core::model::InsightKind::Decision,
        tags: Vec::new(),
        related_paths,
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

/// 把向量写进 LanceDB(去重比较从那里取)。
async fn index_insight(harness: &Harness, id: &str, text: &str) {
    let collection = CollectionRepo::get(harness.env.meta.as_ref(), &harness.collection)
        .await
        .expect("取 collection")
        .expect("存在");
    let insight = InsightRepo::get(harness.env.meta.as_ref(), id)
        .await
        .expect("取 insight")
        .expect("存在");
    let vector = harness
        .env
        .embedder
        .embed_documents(vec![text.to_owned()])
        .await
        .expect("嵌入")
        .into_iter()
        .next()
        .expect("向量");
    let row = kb_core::model::RecordRow {
        id: insight.id.clone(),
        collection: insight.collection.clone(),
        kind: kb_core::model::RecordKind::Insight,
        lang: None,
        source: format!("insight:{}", insight.id),
        start_line: None,
        end_line: None,
        symbol: None,
        title: Some(insight.title.clone()),
        text: insight.body_md.clone(),
        header: insight.title.clone(),
        lex: format!("{}\n{}", insight.title, insight.body_md),
        tags: Vec::new(),
        status: ItemStatus::Active,
        content_hash: kb_core::hash::content_hash(&insight.body_md),
        meta_hash: kb_core::hash::meta_hash(&kb_core::hash::MetaHashInput {
            start_line: None,
            end_line: None,
            title: Some(&insight.title),
            tags: &[],
            status: "active",
            symbol: None,
        }),
        embed_input_hash: kb_core::hash::embed_input_hash(
            harness.env.embedder.id(),
            &insight.title,
            &insight.body_md,
        ),
        updated_at: insight.updated_at,
        anchor: None,
        vector: Some(vector),
    };
    harness
        .env
        .store
        .upsert(&collection.active_table, vec![row])
        .await
        .expect("写向量");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dry_run_only_plans_and_execution_is_revertable() {
    // 假嵌入器对无关文本也能给出 0.6~0.8 的余弦,所以阈值取 0.9:
    // 只有“同一段正文”的两条才会被判为重复
    let (harness, config) = harness(0.9).await;
    insert_insight(
        &harness,
        "000000000000000000000000000000a1",
        "旧条目",
        "同一件事的正文",
        1_000,
        vec![],
    )
    .await;
    insert_insight(
        &harness,
        "000000000000000000000000000000a2",
        "新条目",
        "同一件事的正文",
        2_000,
        vec![],
    )
    .await;
    insert_insight(
        &harness,
        "000000000000000000000000000000a3",
        "无关条目",
        "完全不同的事情",
        3_000,
        vec![],
    )
    .await;
    index_insight(
        &harness,
        "000000000000000000000000000000a1",
        "旧条目\n同一件事的正文",
    )
    .await;
    index_insight(
        &harness,
        "000000000000000000000000000000a2",
        "新条目\n同一件事的正文",
    )
    .await;
    index_insight(
        &harness,
        "000000000000000000000000000000a3",
        "无关条目\n完全不同的事情",
    )
    .await;

    let service = DedupService::new(
        harness.env.meta.clone(),
        harness.env.embedder.clone(),
        config.clone(),
    );
    // dry_run:只出计划
    let plan = service
        .dedup(&harness.collection, true, "test")
        .await
        .expect("演练");
    assert!(plan.dry_run);
    assert_eq!(plan.pairs.len(), 1, "{plan:?}");
    assert_eq!(
        plan.pairs[0].keep_id, "000000000000000000000000000000a2",
        "保留较新的一条"
    );
    assert_eq!(
        plan.pairs[0].duplicate_id,
        "000000000000000000000000000000a1"
    );
    assert_eq!(plan.changed, 0);
    assert!(plan.batch_id.is_none());
    // 演练不改任何东西
    let old = InsightRepo::get(
        harness.env.meta.as_ref(),
        "000000000000000000000000000000a1",
    )
    .await
    .expect("取")
    .expect("存在");
    assert_eq!(old.status, ItemStatus::Active);

    // 正式执行:标 superseded + duplicate_of 边
    let executed = service
        .dedup(&harness.collection, false, "test")
        .await
        .expect("执行");
    assert_eq!(executed.changed, 1, "{executed:?}");
    let old = InsightRepo::get(
        harness.env.meta.as_ref(),
        "000000000000000000000000000000a1",
    )
    .await
    .expect("取")
    .expect("存在");
    assert_eq!(old.status, ItemStatus::Superseded);
    assert_eq!(
        old.superseded_by.as_deref(),
        Some("000000000000000000000000000000a2")
    );
    let edges = EdgeRepo::by_src(
        harness.env.meta.as_ref(),
        "000000000000000000000000000000a1",
    )
    .await
    .expect("查边");
    assert!(
        edges
            .iter()
            .any(|edge| edge.rel == kb_core::model::EdgeRel::DuplicateOf
                && edge.dst == "000000000000000000000000000000a2"),
        "{edges:?}"
    );

    // 可撤销:撤销批次后状态回到 active
    let revert = RevertService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
    );
    let report = revert
        .revert(executed.batch_id.as_deref().expect("批次"))
        .await
        .expect("撤销");
    assert!(!report.reverted.is_empty(), "{report:?}");
    let old = InsightRepo::get(
        harness.env.meta.as_ref(),
        "000000000000000000000000000000a1",
    )
    .await
    .expect("取")
    .expect("存在");
    assert_eq!(old.status, ItemStatus::Active, "撤销后应回到 active");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quality_report_counts_duplicates_expired_paths_and_feedback() {
    let (harness, config) = harness(0.5).await;
    insert_insight(
        &harness,
        "000000000000000000000000000000b1",
        "有路径",
        "正文 A",
        1_000,
        vec!["src/a.rs".to_owned()],
    )
    .await;
    insert_insight(
        &harness,
        "000000000000000000000000000000b2",
        "无路径",
        "正文 B",
        2_000,
        vec![],
    )
    .await;
    // 一条过期的
    let mut expired = InsightRepo::get(
        harness.env.meta.as_ref(),
        "000000000000000000000000000000b2",
    )
    .await
    .expect("取")
    .expect("存在");
    expired.valid_until = Some(1);
    InsightRepo::update(harness.env.meta.as_ref(), expired, 1)
        .await
        .expect("改过期");
    // 一条被取代的
    insert_insight(
        &harness,
        "000000000000000000000000000000b3",
        "被取代",
        "正文 C",
        3_000,
        vec![],
    )
    .await;
    let mut superseded = InsightRepo::get(
        harness.env.meta.as_ref(),
        "000000000000000000000000000000b3",
    )
    .await
    .expect("取")
    .expect("存在");
    superseded.status = ItemStatus::Superseded;
    InsightRepo::update(harness.env.meta.as_ref(), superseded, 1)
        .await
        .expect("改状态");
    // 低反馈:对 a 记一次“无用”
    FeedbackRepo::record(
        harness.env.meta.as_ref(),
        Feedback {
            id: None,
            at: 10,
            query: "怎么配置".to_owned(),
            item_id: "000000000000000000000000000000b1".to_owned(),
            useful: false,
            note: None,
            source: "web".to_owned(),
        },
    )
    .await
    .expect("记反馈");

    let service = DedupService::new(
        harness.env.meta.clone(),
        harness.env.embedder.clone(),
        config,
    );
    let report = service
        .quality_report(&harness.collection)
        .await
        .expect("报告");
    assert_eq!(report.active, 2, "a 与 b 是 active:{report:?}");
    assert_eq!(report.inactive, 1, "c 被取代");
    assert_eq!(report.expired, 1, "b 已过期");
    assert_eq!(report.without_paths, 1, "b 没有关联文件");
    assert_eq!(report.low_feedback.len(), 1);
    assert_eq!(
        report.low_feedback[0].id,
        "000000000000000000000000000000b1"
    );
    assert_eq!(report.low_feedback[0].useless, 1);
    assert_eq!(report.duplicates, 0);
    let _ = ProjectRepo::list(harness.env.meta.as_ref()).await;
    let _ = Page::new(1, 0);
}
