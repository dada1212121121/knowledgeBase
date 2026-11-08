//! 反馈调权的统计与建议(纯读,不写配置)。
//!
//! 场景:两个项目 collection,一个有 6 条「有用」反馈、另一个有 6 条「无用」反馈;
//! 建议应该是前者提权、后者降权,且单次幅度不超过 0.2。

use std::collections::BTreeMap;

use kb_core::model::{Collection, Feedback, Page, Project};
use kb_core::ports::repo::{ChunkRepo, FeedbackRepo, ProjectRepo};
use kb_service::{CollectionService, FeedbackTuning, IndexOptions, IndexService, TuneOptions};
use kb_testkit::TestEnv;
use tempfile::TempDir;

struct Fixture {
    env: TestEnv,
    _dir: TempDir,
    collections: Vec<Collection>,
}

async fn fixture() -> Fixture {
    let env = TestEnv::new().await;
    let dir = tempfile::tempdir().expect("临时项目目录");
    let mut collections = Vec::new();
    for (index, name) in ["alpha", "beta"].iter().enumerate() {
        let root = dir.path().join(name);
        std::fs::create_dir_all(root.join("src")).expect("建目录");
        std::fs::write(
            root.join("src/lib.rs"),
            format!("fn {name}_fn() -> u32 {{\n    {index}\n}}\n"),
        )
        .expect("写文件");
        let project = Project {
            id: format!("p{index}"),
            name: (*name).to_owned(),
            slug: (*name).to_owned(),
            root_path: root.to_string_lossy().into_owned(),
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
        let service =
            CollectionService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
        let collection = service
            .create_for_project(&project.id, name)
            .await
            .expect("建 collection");
        let index = IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            IndexOptions::default(),
        );
        index
            .index_project(&project, &collection)
            .await
            .expect("索引");
        collections.push(collection);
    }
    Fixture {
        env,
        _dir: dir,
        collections,
    }
}

async fn chunk_id(fixture: &Fixture, collection: &Collection) -> String {
    let chunks = ChunkRepo::by_path(fixture.env.meta.as_ref(), &collection.name, "src/lib.rs")
        .await
        .expect("读块");
    chunks.first().expect("至少一块").id.clone()
}

async fn record(fixture: &Fixture, item_id: &str, useful: bool) {
    FeedbackRepo::record(
        fixture.env.meta.as_ref(),
        Feedback {
            id: None,
            at: 1_700_000_000_000,
            query: "q".to_owned(),
            item_id: item_id.to_owned(),
            useful,
            note: None,
            source: "web".to_owned(),
        },
    )
    .await
    .expect("写反馈");
}

#[tokio::test]
async fn useful_feedback_raises_the_weight_and_useless_lowers_it() {
    let fixture = fixture().await;
    let alpha = &fixture.collections[0];
    let beta = &fixture.collections[1];
    let alpha_id = chunk_id(&fixture, alpha).await;
    let beta_id = chunk_id(&fixture, beta).await;
    for _ in 0..6 {
        record(&fixture, &alpha_id, true).await;
        record(&fixture, &beta_id, false).await;
    }

    let plan = FeedbackTuning::new(fixture.env.meta.clone(), fixture.env.store.clone())
        .with_options(TuneOptions::default())
        .plan(&BTreeMap::new())
        .await
        .expect("调权计划");

    assert_eq!(plan.feedback, 12);
    assert_eq!(plan.matched, 12, "反馈都能对上记录");
    assert!(
        plan.overall_rate > 0.45 && plan.overall_rate < 0.55,
        "{plan:?}"
    );

    let alpha_suggestion = plan
        .suggestions
        .iter()
        .find(|item| item.collection == alpha.name)
        .expect("alpha 应提权");
    assert!(alpha_suggestion.delta > 0.0, "{alpha_suggestion:?}");
    assert!(alpha_suggestion.delta <= 0.2 + 1e-9, "单次幅度不超过 0.2");
    assert_eq!(alpha_suggestion.samples, 6);

    let beta_suggestion = plan
        .suggestions
        .iter()
        .find(|item| item.collection == beta.name)
        .expect("beta 应降权");
    assert!(beta_suggestion.delta < 0.0, "{beta_suggestion:?}");
    assert!(beta_suggestion.delta >= -0.2 - 1e-9);

    // 分组统计按 (collection, kind, 路径前缀) 给出
    assert!(
        plan.groups
            .iter()
            .any(|group| group.collection == alpha.name
                && group.kind == "code"
                && group.prefix == "src"),
        "{:?}",
        plan.groups
    );
}

#[tokio::test]
async fn too_few_samples_only_produce_a_skip_note() {
    let fixture = fixture().await;
    let alpha = &fixture.collections[0];
    let alpha_id = chunk_id(&fixture, alpha).await;
    record(&fixture, &alpha_id, true).await;

    let plan = FeedbackTuning::new(fixture.env.meta.clone(), fixture.env.store.clone())
        .with_options(TuneOptions::default())
        .plan(&BTreeMap::new())
        .await
        .expect("调权计划");
    assert!(plan.suggestions.is_empty(), "{plan:?}");
    assert!(
        plan.skipped.iter().any(|note| note.contains("至少")),
        "{:?}",
        plan.skipped
    );
}

#[tokio::test]
async fn feedback_for_deleted_items_is_ignored() {
    let fixture = fixture().await;
    record(&fixture, "deadbeefdeadbeef", true).await;
    let plan = FeedbackTuning::new(fixture.env.meta.clone(), fixture.env.store.clone())
        .plan(&BTreeMap::new())
        .await
        .expect("调权计划");
    assert_eq!(plan.feedback, 1);
    assert_eq!(plan.matched, 0, "对不上记录的反馈不算进统计");
    assert!(plan.suggestions.is_empty());
    assert!(
        FeedbackRepo::list(fixture.env.meta.as_ref(), Page::new(10, 0))
            .await
            .expect("列反馈")
            .len()
            == 1,
        "只是不参与统计,不删数据"
    );
}
