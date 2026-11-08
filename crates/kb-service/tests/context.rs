//! 验收:LLM 上下文增强(按 content_hash 缓存、header 末段替换、token 估算)。

use std::sync::Arc;

use kb_core::model::RecordRow;
use kb_core::ports::ChatModel;
use kb_core::ports::repo::{CollectionRepo, ContextRepo, ProjectRepo};
use kb_llm::MockChatModel;
use kb_service::ProjectService;
use kb_service::context::{ContextService, ESTIMATE_TOKENS_PER_CHUNK, replace_last_segment};
use kb_service::llm_gate::{GateConfig, LlmGate};
use kb_testkit::TestEnv;

struct Harness {
    env: TestEnv,
    project_id: String,
    collection: String,
}

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
    project.allow_cloud_llm = true;
    let project_id = project.id.clone();
    ProjectRepo::update(env.meta.as_ref(), project)
        .await
        .expect("更新");
    Harness {
        env,
        project_id,
        collection,
    }
}

/// 往 collection 里写一个块(带 header)。`updated_at` 越大,列表越靠前。
async fn put_chunk(
    harness: &Harness,
    id: &str,
    text: &str,
    header: &str,
    updated_at: i64,
) -> RecordRow {
    let collection = CollectionRepo::get(harness.env.meta.as_ref(), &harness.collection)
        .await
        .expect("取 collection")
        .expect("存在");
    let vector = harness
        .env
        .embedder
        .embed_documents(vec![format!("{header}\n{text}")])
        .await
        .expect("嵌入")
        .pop()
        .expect("向量");
    let row = RecordRow {
        id: id.to_owned(),
        collection: harness.collection.clone(),
        kind: kb_core::model::RecordKind::Code,
        lang: Some("rust".to_owned()),
        source: "src/lib.rs".to_owned(),
        start_line: Some(1),
        end_line: Some(5),
        symbol: Some("fn main".to_owned()),
        title: Some("fn main".to_owned()),
        text: text.to_owned(),
        header: header.to_owned(),
        lex: format!("{header}\n{text}"),
        tags: Vec::new(),
        status: kb_core::model::ItemStatus::Active,
        content_hash: kb_core::hash::content_hash(text),
        meta_hash: "m".to_owned(),
        embed_input_hash: kb_core::hash::embed_input_hash(harness.env.embedder.id(), header, text),
        updated_at,
        anchor: None,
        vector: Some(vector),
    };
    harness
        .env
        .store
        .upsert(&collection.active_table, vec![row.clone()])
        .await
        .expect("写块");
    row
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn apply_replaces_the_header_and_caches_by_content_hash() {
    let harness = harness().await;
    let original = put_chunk(
        &harness,
        "000000000000000000000000000000c1",
        "fn main() { println!(\"hi\"); }",
        "proj_demo › src/lib.rs › fn main",
        1,
    )
    .await;

    let model = Arc::new(MockChatModel::reply("程序入口,打印一行问候语"));
    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    let service = ContextService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        gate,
        model.clone() as Arc<dyn ChatModel>,
    );

    let estimate = service.estimate(&harness.collection).await.expect("估算");
    assert_eq!(estimate.chunks, 1);
    assert_eq!(estimate.llm_calls, 1, "还没缓存,需要一次 LLM 调用");
    assert_eq!(estimate.estimated_tokens, ESTIMATE_TOKENS_PER_CHUNK);

    let result = service
        .apply(&harness.collection, Some(&harness.project_id), 100)
        .await
        .expect("应用");
    assert_eq!(result.llm_calls, 1);
    assert_eq!(result.cached, 0);
    assert_eq!(result.rewritten, 1);

    // header 的最后一段被替换,embed_input_hash 跟着变
    let collection = CollectionRepo::get(harness.env.meta.as_ref(), &harness.collection)
        .await
        .expect("取")
        .expect("存在");
    let rows = harness
        .env
        .store
        .get(&collection.active_table, std::slice::from_ref(&original.id))
        .await
        .expect("读回");
    let row = rows.first().expect("块存在");
    assert_eq!(
        row.header,
        replace_last_segment(&original.header, "程序入口,打印一行问候语")
    );
    let new_hash =
        kb_core::hash::embed_input_hash(harness.env.embedder.id(), &row.header, &row.text);
    assert_ne!(
        new_hash, original.embed_input_hash,
        "header 变了,嵌入输入哈希也应改变"
    );

    // 第二次:命中缓存,不再调用 LLM
    let second = service
        .apply(&harness.collection, Some(&harness.project_id), 100)
        .await
        .expect("再应用");
    assert_eq!(second.llm_calls, 0, "同一 content_hash 不应重复问 LLM");
    assert_eq!(second.cached, 1);
    assert_eq!(model.calls(), 1, "模型只应被调用一次");
    // 缓存里确实存了
    let cached = ContextRepo::get_context(harness.env.meta.as_ref(), &original.content_hash)
        .await
        .expect("查缓存");
    assert_eq!(cached.as_deref(), Some("程序入口,打印一行问候语"));
}

/// 已缓存的块不占名额,否则每次都停在同一批,后面的块永远轮不到。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cached_chunks_do_not_consume_the_apply_budget() {
    let harness = harness().await;
    let cached = put_chunk(
        &harness,
        "000000000000000000000000000000c3",
        "fn cached() {}",
        "proj_demo › src/lib.rs › fn cached",
        20,
    )
    .await;
    let fresh = put_chunk(
        &harness,
        "000000000000000000000000000000c4",
        "fn fresh() {}",
        "proj_demo › src/lib.rs › fn fresh",
        1,
    )
    .await;
    ContextRepo::put_context(
        harness.env.meta.as_ref(),
        &cached.content_hash,
        "已经缓存的说明",
        "mock",
        1,
    )
    .await
    .expect("预热缓存");

    let model = Arc::new(MockChatModel::reply("新生成的说明"));
    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    let service = ContextService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        gate,
        model.clone() as Arc<dyn ChatModel>,
    );
    let result = service
        .apply(&harness.collection, Some(&harness.project_id), 1)
        .await
        .expect("应用");
    assert_eq!(result.cached, 1);
    assert_eq!(result.llm_calls, 1, "名额应留给还没缓存的块");
    assert_eq!(model.calls(), 1);

    let collection = CollectionRepo::get(harness.env.meta.as_ref(), &harness.collection)
        .await
        .expect("取")
        .expect("存在");
    let rows = harness
        .env
        .store
        .get(&collection.active_table, std::slice::from_ref(&fresh.id))
        .await
        .expect("读回");
    let row = rows.first().expect("块存在");
    assert_eq!(
        row.header,
        replace_last_segment(&fresh.header, "新生成的说明")
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unauthorized_project_is_rejected_by_the_gate() {
    let harness = harness().await;
    // 关掉云端 LLM
    let mut project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取")
        .expect("存在");
    project.allow_cloud_llm = false;
    ProjectRepo::update(harness.env.meta.as_ref(), project)
        .await
        .expect("更新");
    put_chunk(
        &harness,
        "000000000000000000000000000000c2",
        "fn helper() {}",
        "proj_demo › src/lib.rs › fn helper",
        1,
    )
    .await;

    let model = Arc::new(MockChatModel::reply("不该被调用"));
    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    let service = ContextService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        gate,
        model.clone() as Arc<dyn ChatModel>,
    );
    let error = service
        .apply(&harness.collection, Some(&harness.project_id), 10)
        .await
        .expect_err("应拒绝");
    assert!(matches!(error, kb_core::KbError::Forbidden(_)), "{error}");
    assert_eq!(model.calls(), 0, "未授权时不应调用 LLM");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn missing_collection_is_not_found() {
    let harness = harness().await;
    let model = Arc::new(MockChatModel::reply("x"));
    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    let service = ContextService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        gate,
        model as Arc<dyn ChatModel>,
    );
    let error = service
        .estimate("proj_missing")
        .await
        .expect_err("应报不存在");
    assert!(matches!(error, kb_core::KbError::NotFound(_)), "{error}");
}
