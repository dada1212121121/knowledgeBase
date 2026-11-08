//! 验收:查询增强与深度检索(mock LLM)。
//!
//! 覆盖:多查询合并检索、HyDE 改写解析、深度检索的工具循环、4 轮上限、
//! 出处去重、作用域未授权时直接拒绝且不调用 LLM。

use std::sync::Arc;

use kb_core::model::{ChatMessage, ChatResponse, ToolCall};
use kb_core::ports::ChatModel;
use kb_core::ports::repo::ProjectRepo;
use kb_llm::MockChatModel;
use kb_service::index::IndexOptions;
use kb_service::llm_gate::{GateConfig, LlmGate};
use kb_service::query_enhance::{DeepSearch, QueryEnhancer, search_many};
use kb_service::search::{NoopReranker, SearchOptions, SearchService};
use kb_service::{IndexService, ProjectService};
use kb_testkit::TestEnv;

struct Harness {
    env: TestEnv,
    project_id: String,
    collection: String,
    search: SearchService,
}

async fn harness() -> Harness {
    let env = TestEnv::new().await;
    let projects = ProjectService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let dir = tempfile::tempdir().expect("目录");
    std::fs::write(
        dir.path().join("index.md"),
        "# 增量索引\n\n双哈希用来判断块是否需要重新嵌入。\n\n# 上传\n\n上传走分片续传。\n",
    )
    .expect("写文件");
    let project = projects
        .add(dir.path(), Some("demo"))
        .await
        .expect("加项目");
    let collection = format!("proj_{}", project.slug);
    let mut record = ProjectRepo::get(env.meta.as_ref(), &project.id)
        .await
        .expect("取项目")
        .expect("存在");
    record.allow_cloud_llm = true;
    let project_id = record.id.clone();
    ProjectRepo::update(env.meta.as_ref(), record)
        .await
        .expect("更新");

    // 索引文件
    let index = IndexService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        env.chunker.clone(),
        env.scanner.clone(),
        IndexOptions::default(),
    );
    let record = kb_core::ports::repo::CollectionRepo::get(env.meta.as_ref(), &collection)
        .await
        .expect("取 collection")
        .expect("存在");
    let metadata = std::fs::metadata(dir.path().join("index.md")).expect("元数据");
    let entry = kb_core::model::ScanEntry {
        path: dir.path().join("index.md"),
        relative: "index.md".to_owned(),
        size: metadata.len(),
        mtime: kb_service::index::millis_of(&metadata),
        lang: "markdown".to_owned(),
        kind: kb_core::model::FileKind::Doc,
    };
    let spec = kb_service::index::FileIndexSpec {
        source: "index.md".to_owned(),
        kind: kb_core::model::FileKind::Doc,
        tags: Vec::new(),
    };
    index
        .index_entry_with("demo", &record, &entry, &spec, 1)
        .await
        .expect("索引");

    let search = SearchService::new(
        env.meta.clone(),
        env.store.clone(),
        env.embedder.clone(),
        Arc::new(NoopReranker),
        SearchOptions::default(),
    );
    Harness {
        env,
        project_id,
        collection,
        search,
    }
}

fn reply_with_calls(content: Option<&str>, calls: Vec<ToolCall>) -> ChatResponse {
    let finish = if calls.is_empty() {
        "stop".to_owned()
    } else {
        "tool_calls".to_owned()
    };
    ChatResponse {
        message: ChatMessage {
            role: "assistant".to_owned(),
            content: content.map(str::to_owned),
            tool_calls: calls,
            tool_call_id: None,
        },
        input_tokens: 10,
        output_tokens: 5,
        finish_reason: finish,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn enhancer_parses_hyde_queries_and_falls_back() {
    let harness = harness().await;
    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    // 1) 正常返回三条
    let model = Arc::new(MockChatModel::reply(
        r#"{"queries":["双哈希判断是否需要重新嵌入","增量索引 重嵌入","块内容哈希"]}"#,
    ));
    let enhancer = QueryEnhancer::new(
        LlmGate::new(harness.env.meta.clone(), GateConfig::default()),
        model as Arc<dyn ChatModel>,
    );
    let queries = enhancer
        .enhance(Some(&harness.project_id), "增量索引怎么判断要重嵌入")
        .await;
    assert_eq!(queries.len(), 4, "原问题 + 3 条改写:{queries:?}");
    assert_eq!(queries[0], "增量索引怎么判断要重嵌入");

    // 2) 模型输出坏 JSON → 退回原问题
    let bad = Arc::new(MockChatModel::reply("不是 JSON"));
    let enhancer = QueryEnhancer::new(gate, bad as Arc<dyn ChatModel>);
    let queries = enhancer.enhance(Some(&harness.project_id), "原问题").await;
    assert_eq!(queries, vec!["原问题".to_owned()]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn multi_query_search_merges_hits_by_id() {
    let harness = harness().await;
    let response = search_many(
        &harness.search,
        &[
            "双哈希 重嵌入".to_owned(),
            "增量索引".to_owned(),
            "分片续传".to_owned(),
        ],
        vec![harness.collection.clone()],
        5,
    )
    .await
    .expect("多查询检索");
    assert!(!response.hits.is_empty(), "{response:?}");
    // 同一条目不应重复出现
    let mut ids: Vec<&str> = response.hits.iter().map(|hit| hit.id.as_str()).collect();
    let count = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(ids.len(), count, "合并后不应有重复 id");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deep_search_runs_tool_rounds_and_collects_citations() {
    let harness = harness().await;
    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    // 第 1 轮:调 search_knowledge;第 2 轮:直接回答
    let model = Arc::new(MockChatModel::script(vec![
        reply_with_calls(
            None,
            vec![ToolCall {
                id: "c1".to_owned(),
                name: "search_knowledge".to_owned(),
                arguments: serde_json::json!({ "query": "双哈希 重嵌入", "k": 3 }),
            }],
        ),
        reply_with_calls(Some("双哈希用来判断块是否需要重新嵌入 [id]。"), Vec::new()),
    ]));
    let deep = DeepSearch::new(
        &gate,
        model as Arc<dyn ChatModel>,
        &harness.search,
        harness.env.store.clone(),
        harness.env.meta.as_ref(),
        vec![harness.collection.clone()],
    );
    let result = deep
        .run(Some(&harness.project_id), "增量索引怎么判断要重嵌入")
        .await
        .expect("深度检索");
    assert_eq!(result.rounds, 2, "{result:?}");
    assert!(!result.truncated);
    assert!(!result.trace.is_empty(), "{result:?}");
    assert_eq!(result.trace[0].tool, "search_knowledge");
    assert!(result.trace[0].hits > 0, "{result:?}");
    assert!(!result.citations.is_empty(), "应收集到出处:{result:?}");
    assert!(result.answer.contains("[id]"), "{}", result.answer);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deep_search_stops_after_four_rounds() {
    let harness = harness().await;
    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    // 模型一直要工具:4 轮之后必须收尾(第 5 次调用不带 tools,直接回答)
    let tool_reply = || {
        reply_with_calls(
            None,
            vec![ToolCall {
                id: "c".to_owned(),
                name: "search_knowledge".to_owned(),
                arguments: serde_json::json!({ "query": "增量索引" }),
            }],
        )
    };
    let model = Arc::new(MockChatModel::script(vec![
        tool_reply(),
        tool_reply(),
        tool_reply(),
        tool_reply(),
        reply_with_calls(Some("轮次用尽后的回答"), Vec::new()),
    ]));
    let deep = DeepSearch::new(
        &gate,
        model as Arc<dyn ChatModel>,
        &harness.search,
        harness.env.store.clone(),
        harness.env.meta.as_ref(),
        vec![harness.collection.clone()],
    );
    let result = deep
        .run(Some(&harness.project_id), "问题")
        .await
        .expect("深度检索");
    assert_eq!(result.rounds, 4, "最多 4 轮:{result:?}");
    assert!(result.truncated);
    assert_eq!(result.answer, "轮次用尽后的回答");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unauthorized_scope_is_rejected_without_calling_the_llm() {
    let harness = harness().await;
    let mut record = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");
    record.allow_cloud_llm = false;
    ProjectRepo::update(harness.env.meta.as_ref(), record)
        .await
        .expect("更新");

    let gate = LlmGate::new(harness.env.meta.clone(), GateConfig::default());
    let model = Arc::new(MockChatModel::reply("不该被调用"));
    let deep = DeepSearch::new(
        &gate,
        model.clone() as Arc<dyn ChatModel>,
        &harness.search,
        harness.env.store.clone(),
        harness.env.meta.as_ref(),
        vec![harness.collection.clone()],
    );
    let error = deep
        .run(Some(&harness.project_id), "问题")
        .await
        .expect_err("应拒绝");
    assert!(matches!(error, kb_core::KbError::Forbidden(_)), "{error}");
    assert_eq!(model.calls(), 0, "未授权时不应调用 LLM");
}
