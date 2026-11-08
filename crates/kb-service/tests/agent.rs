//! 验收:AI 管家的“计划卡片 → 确认 → 执行 → 可撤销”闭环(mock LLM)。
//!
//! 覆盖:有副作用能力只出卡片不执行、确认后执行并返回批次、参数被篡改时拒绝、
//! 单轮最多 8 次工具调用、未授权项目的正文不外发。

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use kb_core::model::{ChatMessage, ChatRequest, ChatResponse, ToolCall, ToolSpec};
use kb_core::ports::ChatModel;
use kb_core::ports::repo::AgentRepo;
use kb_llm::MockChatModel;
use kb_service::agent::{AgentService, MAX_TOOL_CALLS, ToolRunner, args_hash};
use kb_service::llm_gate::{GateConfig, LlmGate};
use kb_testkit::TestEnv;

/// 假的工具执行器:记录调用,有副作用的能力在 dry_run 时返回计划。
struct FakeRunner {
    calls: AtomicU32,
    allow_llm: bool,
    /// 是否把检索结果里的 collection 当作“未授权”。
    deny_collection: Option<String>,
}

#[async_trait::async_trait]
impl ToolRunner for FakeRunner {
    fn tools(&self) -> Vec<ToolSpec> {
        vec![
            ToolSpec {
                name: "dedup_insights".to_owned(),
                description: "条目去重".to_owned(),
                parameters: serde_json::json!({ "type": "object" }),
            },
            ToolSpec {
                name: "search_knowledge".to_owned(),
                description: "检索".to_owned(),
                parameters: serde_json::json!({ "type": "object" }),
            },
        ]
    }

    fn is_mutating(&self, name: &str) -> bool {
        name == "dedup_insights"
    }

    async fn call(
        &self,
        name: &str,
        args: serde_json::Value,
        dry_run: bool,
    ) -> kb_core::Result<serde_json::Value> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        match name {
            "dedup_insights" if dry_run => Ok(serde_json::json!({
                "plan": { "actions": [{ "op": "dedup_insights", "target": args["collection"] }] },
                "affected": 2,
            })),
            "dedup_insights" => Ok(serde_json::json!({
                "changed": 2,
                "batch_id": "batch-1",
                "meta": { "batch_id": "batch-1" },
            })),
            "search_knowledge" => Ok(serde_json::json!({
                "hits": [{
                    "id": "hit-1",
                    "collection": self.deny_collection.clone().unwrap_or_else(|| "proj_demo".to_owned()),
                    "kind": "doc",
                    "source": "docs/secret.md",
                    "title": "内部文档",
                    "snippet": "这里是正文内容",
                }],
                "jobs": [{ "id": "job-1", "kind": "index", "collection": "proj_demo", "state": "done" }],
                "collections": [{ "name": "proj_demo", "rows": 3 }],
            })),
            other => Err(kb_core::KbError::NotFound(format!("tool {other}"))),
        }
    }

    async fn allows_llm(&self, collections: &[String]) -> kb_core::Result<bool> {
        if !self.allow_llm {
            return Ok(false);
        }
        Ok(!collections
            .iter()
            .any(|name| self.deny_collection.as_deref() == Some(name.as_str())))
    }
}

fn tool_reply(name: &str, args: serde_json::Value) -> ChatResponse {
    ChatResponse {
        message: ChatMessage {
            role: "assistant".to_owned(),
            content: None,
            tool_calls: vec![ToolCall {
                id: "c1".to_owned(),
                name: name.to_owned(),
                arguments: args,
            }],
            tool_call_id: None,
        },
        input_tokens: 10,
        output_tokens: 5,
        finish_reason: "tool_calls".to_owned(),
    }
}

fn text_reply(text: &str) -> ChatResponse {
    ChatResponse {
        message: ChatMessage {
            role: "assistant".to_owned(),
            content: Some(text.to_owned()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        },
        input_tokens: 10,
        output_tokens: 5,
        finish_reason: "stop".to_owned(),
    }
}

fn service(env: &TestEnv, model: Arc<MockChatModel>, runner: Arc<FakeRunner>) -> AgentService {
    AgentService::new(
        env.meta.clone(),
        LlmGate::new(env.meta.clone(), GateConfig::default()),
        model as Arc<dyn ChatModel>,
        runner,
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn mutating_tool_returns_a_card_then_confirm_executes_with_a_batch() {
    let env = TestEnv::new().await;
    let model = Arc::new(MockChatModel::script(vec![
        // 第 1 轮:要合并重复经验(有副作用 → 只出卡片)
        tool_reply(
            "dedup_insights",
            serde_json::json!({ "collection": "proj_demo", "dry_run": true }),
        ),
        // 第 2 轮:看到“等待确认”后收尾
        text_reply("已生成去重计划,请确认后执行"),
    ]));
    let runner = Arc::new(FakeRunner {
        calls: AtomicU32::new(0),
        allow_llm: true,
        deny_collection: None,
    });
    let agent = service(&env, model, runner.clone());
    let reply = agent
        .send("s1", None, "把 proj_demo 里重复的经验合并")
        .await
        .expect("对话");
    assert_eq!(reply.cards.len(), 1, "{reply:?}");
    let card = &reply.cards[0];
    assert_eq!(card.capability, "dedup_insights");
    assert_eq!(card.args_hash, args_hash("dedup_insights", &card.args));
    // 卡片阶段只调了一次(dry_run),没有真执行
    assert_eq!(runner.calls.load(Ordering::SeqCst), 1);

    // 确认执行
    let confirmed = agent
        .confirm("s1", &card.id, &card.args_hash)
        .await
        .expect("确认执行");
    assert_eq!(confirmed.batch_id.as_deref(), Some("batch-1"));
    assert_eq!(confirmed.result["changed"], 2);
    assert_eq!(runner.calls.load(Ordering::SeqCst), 2, "确认后应真执行一次");
    // 会话里有 plan 与 tool 记录
    let history = agent.history("s1").await.expect("历史");
    assert!(history.iter().any(|message| message.role == "plan"));
    assert!(history.iter().any(|message| message.role == "tool"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tampered_arguments_are_rejected() {
    let env = TestEnv::new().await;
    let model = Arc::new(MockChatModel::script(vec![
        tool_reply(
            "dedup_insights",
            serde_json::json!({ "collection": "proj_demo", "dry_run": true }),
        ),
        text_reply("请确认"),
    ]));
    let runner = Arc::new(FakeRunner {
        calls: AtomicU32::new(0),
        allow_llm: true,
        deny_collection: None,
    });
    let agent = service(&env, model, runner.clone());
    let reply = agent.send("s2", None, "合并重复经验").await.expect("对话");
    let card = &reply.cards[0];
    let calls_before = runner.calls.load(Ordering::SeqCst);
    let error = agent
        .confirm("s2", &card.id, "deadbeefdeadbeef")
        .await
        .expect_err("哈希不一致应拒绝");
    assert!(
        matches!(error, kb_core::KbError::InvalidInput(_)),
        "{error}"
    );
    assert_eq!(
        runner.calls.load(Ordering::SeqCst),
        calls_before,
        "拒绝时不应执行"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tool_calls_are_capped_per_turn() {
    let env = TestEnv::new().await;
    // 一直要工具 → 达到上限后必须收尾
    let mut script: Vec<ChatResponse> = (0..MAX_TOOL_CALLS)
        .map(|_| {
            tool_reply(
                "search_knowledge",
                serde_json::json!({ "query": "增量索引" }),
            )
        })
        .collect();
    script.push(text_reply("用尽工具次数后的回答"));
    let model = Arc::new(MockChatModel::script(script));
    let runner = Arc::new(FakeRunner {
        calls: AtomicU32::new(0),
        allow_llm: true,
        deny_collection: None,
    });
    let agent = service(&env, model, runner.clone());
    let reply = agent.send("s3", None, "查一下").await.expect("对话");
    assert_eq!(
        runner.calls.load(Ordering::SeqCst),
        MAX_TOOL_CALLS,
        "单轮最多 {MAX_TOOL_CALLS} 次工具调用"
    );
    assert_eq!(reply.trace.len(), MAX_TOOL_CALLS as usize);
    assert!(reply.text.contains("用尽"), "{}", reply.text);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deltas_are_streamed_to_the_caller() {
    let env = TestEnv::new().await;
    let model = Arc::new(MockChatModel::reply(
        "这是一段比较长的回答,用来验证流式增量确实被分块回调。",
    ));
    let runner = Arc::new(FakeRunner {
        calls: AtomicU32::new(0),
        allow_llm: true,
        deny_collection: None,
    });
    let agent = service(&env, model, runner);
    let mut chunks: Vec<String> = Vec::new();
    let mut finished = false;
    let mut on_delta = |text: &str, done: bool| {
        if !text.is_empty() {
            chunks.push(text.to_owned());
        }
        if done {
            finished = true;
        }
    };
    let reply = agent
        .send_with("s5", None, "说点什么", &mut on_delta)
        .await
        .expect("对话");
    assert!(chunks.len() > 1, "应分成多段回调:{chunks:?}");
    assert!(finished, "最后应有一次 done 回调");
    assert_eq!(chunks.concat(), reply.text, "拼起来应等于完整回答");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn text_from_unauthorized_projects_is_not_sent_to_the_model() {
    let env = TestEnv::new().await;
    let model = Arc::new(MockChatModel::script(vec![
        tool_reply(
            "search_knowledge",
            serde_json::json!({ "query": "内部文档" }),
        ),
        text_reply("只看到了标题"),
    ]));
    let runner = Arc::new(FakeRunner {
        calls: AtomicU32::new(0),
        allow_llm: false,
        deny_collection: Some("proj_secret".to_owned()),
    });
    let agent = service(&env, model, runner);
    agent
        .send("s4", None, "查一下内部文档")
        .await
        .expect("对话");
    // 会话里 assistant 的回复不含正文(正文在工具结果里被替换,模型看到的是脱敏版本)
    let history = agent.history("s4").await.expect("历史");
    let joined: String = history
        .iter()
        .map(|message| message.content_json.clone())
        .collect();
    assert!(
        !joined.contains("这里是正文内容"),
        "未授权项目的正文不应出现在会话记录里:{joined}"
    );
}

/// 一定失败的大模型(验证失败那一轮也会记进会话)。
struct FailingModel;

#[async_trait::async_trait]
impl ChatModel for FailingModel {
    fn id(&self) -> &str {
        "failing"
    }
    async fn chat(&self, _request: ChatRequest) -> kb_core::Result<ChatResponse> {
        Err(kb_core::KbError::Upstream("boom".to_owned()))
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tool_results_become_refs_and_are_persisted() {
    let env = TestEnv::new().await;
    let model = Arc::new(MockChatModel::script(vec![
        tool_reply(
            "search_knowledge",
            serde_json::json!({ "collection": "proj_demo", "query": "x" }),
        ),
        text_reply("找到一条"),
    ]));
    let runner = Arc::new(FakeRunner {
        calls: AtomicU32::new(0),
        allow_llm: true,
        deny_collection: None,
    });
    let agent = service(&env, model, runner);
    let reply = agent.send("s-ref", None, "搜一下").await.expect("对话");
    assert_eq!(reply.trace, vec!["search_knowledge"]);
    let item = reply
        .refs
        .iter()
        .find(|reference| reference.kind == "item")
        .expect("应有条目引用");
    assert_eq!(item.id, "hit-1");
    assert_eq!(item.collection.as_deref(), Some("proj_demo"));
    assert_eq!(item.source.as_deref(), Some("docs/secret.md"));
    assert_eq!(item.label, "内部文档");
    // 任务对象(id + collection + state)不能被当成条目
    let job = reply
        .refs
        .iter()
        .find(|reference| reference.kind == "job")
        .expect("应有任务引用");
    assert_eq!(job.id, "job-1");
    assert!(
        reply
            .refs
            .iter()
            .all(|reference| !(reference.kind == "item" && reference.id == "job-1")),
        "任务不应变成条目引用:{:?}",
        reply.refs
    );
    // collection 列表也能点
    assert!(
        reply
            .refs
            .iter()
            .any(|reference| reference.kind == "collection" && reference.id == "proj_demo"),
        "{:?}",
        reply.refs
    );

    // 持久化:历史里的 assistant 消息带 trace / refs
    let history = agent.history("s-ref").await.expect("历史");
    let assistant = history
        .iter()
        .rev()
        .find(|message| message.role == "assistant")
        .expect("助手消息");
    let value: serde_json::Value =
        serde_json::from_str(&assistant.content_json).expect("内容是 JSON");
    assert_eq!(value["trace"][0], "search_knowledge");
    let persisted = value["refs"].as_array().expect("refs");
    assert!(
        persisted
            .iter()
            .any(|reference| reference["kind"] == "item" && reference["id"] == "hit-1"),
        "{persisted:?}"
    );
    assert!(
        persisted
            .iter()
            .any(|reference| reference["kind"] == "job" && reference["id"] == "job-1"),
        "{persisted:?}"
    );

    // 会话归属项目:从工具参数里的 collection 推断
    let sessions = AgentRepo::sessions(env.meta.as_ref(), 10, Some("demo"))
        .await
        .expect("按项目过滤");
    assert!(
        sessions.iter().any(|session| session.session_id == "s-ref"),
        "{sessions:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_turn_is_recorded_in_history() {
    let env = TestEnv::new().await;
    let agent = AgentService::new(
        env.meta.clone(),
        LlmGate::new(env.meta.clone(), GateConfig::default()),
        Arc::new(FailingModel) as Arc<dyn ChatModel>,
        Arc::new(FakeRunner {
            calls: AtomicU32::new(0),
            allow_llm: true,
            deny_collection: None,
        }),
    );
    let error = agent
        .send("s-err", None, "你好")
        .await
        .expect_err("模型失败应报错");
    assert!(error.to_string().contains("boom"), "{error}");
    let history = agent.history("s-err").await.expect("历史");
    assert_eq!(history.len(), 2, "用户消息 + 失败记录:{history:?}");
    let last = history.last().expect("最后一条");
    assert_eq!(last.role, "assistant");
    let value: serde_json::Value = serde_json::from_str(&last.content_json).expect("JSON");
    assert!(
        value["error"]
            .as_str()
            .is_some_and(|text| text.contains("boom")),
        "{value}"
    );
}

/// 上下文压缩:较早的消息变成摘要,最近的保留原文。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn compression_turns_older_messages_into_a_summary() {
    use kb_core::model::AgentMessage;

    let env = TestEnv::new().await;
    let model = Arc::new(MockChatModel::script(vec![text_reply(
        "摘要:用户在了解知识库的检索能力。",
    )]));
    let runner = Arc::new(FakeRunner {
        calls: AtomicU32::new(0),
        allow_llm: true,
        deny_collection: None,
    });
    let agent = service(&env, model.clone(), runner);

    // 攒 10 条消息(5 轮)
    for index in 0..5 {
        for (role, text) in [
            ("user", format!("旧问题 {index}")),
            ("assistant", format!("旧回答 {index}")),
        ] {
            AgentRepo::append(
                env.meta.as_ref(),
                AgentMessage {
                    session_id: "s-compress".to_owned(),
                    seq: 0,
                    role: role.to_owned(),
                    content_json: serde_json::json!({ "text": text }).to_string(),
                    at: 1_700_000_000_000 + index,
                },
            )
            .await
            .expect("写消息");
        }
    }

    let summary = agent
        .compress("s-compress", None)
        .await
        .expect("压缩")
        .expect("应有摘要");
    assert!(summary.contains("检索能力"), "{summary}");

    let meta = AgentRepo::session_meta(env.meta.as_ref(), "s-compress")
        .await
        .expect("元数据");
    assert_eq!(meta.summary, summary);
    assert_eq!(meta.summary_upto, 8, "最后两条不压");

    // 压缩后发一句话:请求里带摘要,旧消息不再逐条出现
    let reply = agent.send("s-compress", None, "继续").await.expect("发送");
    assert_eq!(reply.text, "摘要:用户在了解知识库的检索能力。");
    let requests = model.requests();
    let last = requests.last().expect("有一次请求");
    assert_eq!(last.last_user.as_deref(), Some("继续"));
}

/// 长会话自动压缩:超过保留窗口后,发消息会先写摘要。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn long_sessions_compress_automatically() {
    use kb_core::model::AgentMessage;

    let env = TestEnv::new().await;
    let model = Arc::new(MockChatModel::script(vec![
        text_reply("自动摘要:用户在整理知识库。"),
        text_reply("好的,继续。"),
    ]));
    let runner = Arc::new(FakeRunner {
        calls: AtomicU32::new(0),
        allow_llm: true,
        deny_collection: None,
    });
    let agent = service(&env, model.clone(), runner);
    for index in 0..12 {
        for (role, text) in [
            ("user", format!("问题 {index}")),
            ("assistant", format!("回答 {index}")),
        ] {
            AgentRepo::append(
                env.meta.as_ref(),
                AgentMessage {
                    session_id: "s-auto".to_owned(),
                    seq: 0,
                    role: role.to_owned(),
                    content_json: serde_json::json!({ "text": text }).to_string(),
                    at: 1_700_000_000_000 + index,
                },
            )
            .await
            .expect("写消息");
        }
    }
    let reply = agent.send("s-auto", None, "再问一句").await.expect("发送");
    assert_eq!(reply.text, "好的,继续。");
    let meta = AgentRepo::session_meta(env.meta.as_ref(), "s-auto")
        .await
        .expect("元数据");
    assert!(meta.summary.contains("自动摘要"), "{meta:?}");
    assert!(meta.summary_upto > 0);
    assert_eq!(model.calls(), 2, "一次摘要 + 一次回答");
}
