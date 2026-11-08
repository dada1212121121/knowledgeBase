//! 收尾:会话结束事件触发自动提炼。
//!
//! 覆盖:会话记录 → 对话文本 → 提炼 → `events.result` 写回;没有会话记录路径时
//! 不调用任何 LLM;项目没开提炼时一次 LLM 都不调;会话记录读不了时错误写进
//! `result` 而不是让事件失败;会话事件不会顺带全量重索引。

use std::sync::Arc;

use kb_core::config::EvolutionConfig;
use kb_core::model::ChatResponse;
use kb_core::ports::ChatModel;
use kb_core::ports::repo::{DraftRepo, EventRepo, ProjectRepo};
use kb_llm::MockChatModel;
use kb_service::ProjectService;
use kb_service::evolution::{EventRequest, EventService, EvolutionService};
use kb_service::llm_gate::{GateConfig, LlmGate};
use kb_testkit::TestEnv;

struct Harness {
    env: TestEnv,
    project_id: String,
    /// 项目根目录(测试结束前不能删)。
    #[allow(dead_code)]
    dir: tempfile::TempDir,
}

/// 一个会 panic 的模型:测后台任务 panic 时的收尾(e)。
struct PanicModel;

#[async_trait::async_trait]
impl ChatModel for PanicModel {
    fn id(&self) -> &str {
        "panic"
    }

    async fn chat(&self, _request: kb_core::model::ChatRequest) -> kb_core::Result<ChatResponse> {
        panic!("BOOM-CANARY 内部状态不该外泄");
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

fn candidate_json() -> String {
    serde_json::json!({
        "items": [{
            "title": "音视频转写只走本地 whisper.cpp",
            "body_md": "外发会泄露会议内容,转写固定用本地模型。",
            "kind": "decision",
            "tags": ["隐私"],
            "related_paths": ["crates/kb-extract/src/media.rs"],
            "evidence": "音视频转写必须本地跑 whisper.cpp,不要外发。",
            "confidence": 0.9
        }]
    })
    .to_string()
}

fn review_json() -> String {
    serde_json::json!({
        "decision": "approve",
        "score": 0.9,
        "reasons": ["具体且与证据一致"]
    })
    .to_string()
}

/// Claude Code 会话记录的形状(公开文档字段:type / message.content)。
fn session_jsonl() -> String {
    [
        r#"{"type":"user","message":{"role":"user","content":"音视频转写要不要走云端?"},"cwd":"/tmp/demo"}"#,
        r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"不要,必须本地跑 whisper.cpp。"},{"type":"tool_use","name":"Read","input":{}}]}}"#,
        r#"{"type":"summary","summary":"讨论转写方案"}"#,
    ]
    .join("\n")
}

async fn harness(extract_enabled: bool) -> Harness {
    let env = TestEnv::new().await;
    let service = ProjectService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let dir = tempfile::tempdir().expect("目录");
    std::fs::write(dir.path().join("lib.rs"), "fn main() {}\n").expect("写文件");
    let project = service.add(dir.path(), Some("demo")).await.expect("加项目");
    let mut project = ProjectRepo::get(env.meta.as_ref(), &project.id)
        .await
        .expect("取项目")
        .expect("存在");
    project.extract_enabled = extract_enabled;
    project.allow_cloud_llm = true;
    let project_id = project.id.clone();
    ProjectRepo::update(env.meta.as_ref(), project)
        .await
        .expect("更新项目");
    Harness {
        env,
        project_id,
        dir,
    }
}

fn evolution(
    harness: &Harness,
    extract: Arc<MockChatModel>,
    review: Arc<MockChatModel>,
) -> Arc<EvolutionService> {
    let config = EvolutionConfig {
        review_mode: "ai".to_owned(),
        approve_threshold: 0.7,
        dedup_similarity: 0.99,
        ..EvolutionConfig::default()
    };
    Arc::new(EvolutionService::new(
        harness.env.meta.clone(),
        harness.env.store.clone(),
        harness.env.embedder.clone(),
        LlmGate::new(harness.env.meta.clone(), GateConfig::default()),
        extract as Arc<dyn ChatModel>,
        review as Arc<dyn ChatModel>,
        config,
    ))
}

fn request(root: &str, session: Option<&std::path::Path>) -> EventRequest {
    EventRequest {
        kind: "session_end".to_owned(),
        project_root: root.to_owned(),
        head: None,
        payload: session.map(|path| {
            serde_json::json!({
                "hook": "claude-stop",
                "session_path": path.to_string_lossy(),
            })
        }),
    }
}

/// 取事件表里的 `result` 文本。
async fn result_of(env: &TestEnv, event_id: &str) -> String {
    EventRepo::get(env.meta.as_ref(), event_id)
        .await
        .expect("取事件")
        .expect("事件存在")
        .result
        .unwrap_or_default()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_end_extracts_and_records_result() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone()).with_evolution(evolution(
        &harness,
        extract.clone(),
        review.clone(),
    ));

    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");
    let outcome = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");

    // 会话事件只是“该提炼了”的信号:不投递索引任务(文件变化由监听器负责)
    assert_eq!(outcome.mode, "noop", "{outcome:?}");
    assert!(outcome.job_id.is_none(), "{outcome:?}");
    assert_eq!(outcome.changed_files, 0);

    // events.result 里有索引模式与提炼结果
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await)
            .expect("result 是 JSON");
    assert_eq!(result["index"], "noop", "{result}");
    assert_eq!(result["evolution"]["candidates"], 1, "{result}");
    assert_eq!(result["evolution"]["review_calls"], 1, "{result}");
    assert!(result.get("evolution_error").is_none(), "{result}");

    // 提炼用的输入是会话里的对话文本(工具调用与摘要不进提示词)
    let sent = extract.requests();
    assert_eq!(sent.len(), 1, "提炼应只调一次模型");
    let prompt = sent[0].last_user.clone().unwrap_or_default();
    assert!(prompt.contains("音视频转写要不要走云端?"), "{prompt}");
    assert!(prompt.contains("必须本地跑 whisper.cpp"), "{prompt}");
    assert!(
        !prompt.contains("讨论转写方案"),
        "摘要行不该进提示词:{prompt}"
    );

    // 转正:草稿以 approved 落库(review_mode = ai)
    let drafts = DraftRepo::list(harness.env.meta.as_ref(), None, Default::default())
        .await
        .expect("列草稿");
    assert_eq!(drafts.len(), 1, "{drafts:?}");
    assert_eq!(drafts[0].state, kb_core::model::DraftState::Approved);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_end_without_session_path_calls_no_llm() {
    let harness = harness(true).await;
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone()).with_evolution(evolution(
        &harness,
        extract.clone(),
        review.clone(),
    ));
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let outcome = service
        .handle(request(&project.root_path, None))
        .await
        .expect("处理事件");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await).expect("JSON");
    assert!(result["evolution"]["skipped"].is_string(), "{result}");
    assert_eq!(extract.calls(), 0, "没有会话记录时一次 LLM 都不该调");
    assert_eq!(review.calls(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_end_skips_llm_when_extraction_is_off() {
    let harness = harness(false).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone()).with_evolution(evolution(
        &harness,
        extract.clone(),
        review.clone(),
    ));
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let outcome = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await).expect("JSON");
    assert_eq!(
        result["evolution"]["skipped_unauthorized"], true,
        "{result}"
    );
    assert_eq!(extract.calls(), 0, "项目没开提炼时不该外发");
    assert_eq!(review.calls(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unreadable_session_is_recorded_but_event_still_succeeds() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("bad.jsonl");
    std::fs::write(&session, b"{\"type\":\"user\",\"message\":\"a\"}\n\xff\xfe").expect("写会话");
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone()).with_evolution(evolution(
        &harness,
        extract.clone(),
        review.clone(),
    ));
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let outcome = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("事件本身不该失败");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await).expect("JSON");
    let error = result["evolution_error"].as_str().unwrap_or_default();
    assert!(error.contains("UTF-8"), "{result}");
    assert!(
        !error.contains("/tmp") && !error.contains(harness.dir.path().to_str().unwrap_or("\u{0}")),
        "错误里不该回显绝对路径:{error}"
    );
    assert_eq!(extract.calls(), 0);
}

/// 刚开的空会话(sidecar 已写 cwd、正文 0 字节):不调 LLM,原因写进 `events.result`。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn empty_session_calls_no_llm() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("empty.jsonl");
    std::fs::write(&session, "").expect("写空会话");
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone()).with_evolution(evolution(
        &harness,
        extract.clone(),
        review.clone(),
    ));
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let outcome = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await).expect("JSON");
    assert_eq!(
        result["evolution"]["skipped"], "会话记录里没有可提炼的对话",
        "{result}"
    );
    assert_eq!(extract.calls(), 0, "空会话不该外发");
    assert_eq!(review.calls(), 0);
}

/// 会话记录路径是外部输入:不合法一律不外发,原因写进 `evolution_error`。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_regular_jsonl_files_under_allowed_roots_are_read() {
    let harness = harness(true).await;
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone()).with_evolution(evolution(
        &harness,
        extract.clone(),
        review.clone(),
    ));
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    // 项目根之外的普通 jsonl
    let outside = tempfile::tempdir().expect("目录");
    let outside_file = outside.path().join("session.jsonl");
    std::fs::write(&outside_file, session_jsonl()).expect("写会话");
    // 项目根里的黑名单文件(密钥)
    let env_file = harness.dir.path().join(".env");
    std::fs::write(&env_file, "TOP-SECRET-CANARY=1\n").expect("写 .env");
    // 不是 .jsonl
    let text_file = harness.dir.path().join("notes.txt");
    std::fs::write(&text_file, "随便一段文字\n").expect("写 txt");
    // 目录
    let dir_target = harness.dir.path().join("sessions");
    std::fs::create_dir_all(&dir_target).expect("建目录");

    for (path, expect) in [
        (outside_file.as_path(), "不在允许的目录里"),
        (env_file.as_path(), "禁止读取的路径规则"),
        (text_file.as_path(), "必须是 .jsonl"),
        (dir_target.as_path(), "不是普通文件"),
        (std::path::Path::new("/nonexistent/x.jsonl"), "不存在"),
    ] {
        let outcome = service
            .handle(request(&project.root_path, Some(path)))
            .await
            .expect("处理事件");
        let result: serde_json::Value =
            serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await).expect("JSON");
        let error = result["evolution_error"].as_str().unwrap_or_default();
        assert!(error.contains(expect), "{path:?} → {result}");
        // 不借错误回显绝对路径与系统错误原文
        assert!(!error.contains("/nonexistent"), "{result}");
        assert!(!error.contains("os error"), "{result}");
    }
    assert_eq!(extract.calls(), 0, "不合法的路径一次 LLM 都不该调");
    assert_eq!(review.calls(), 0);
}

/// `Stop` 是每轮触发:同一份会话(大小 / 修改时间没变)再触发一次不该再提炼。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_same_session_is_not_extracted_twice() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    let extract = Arc::new(MockChatModel::script(vec![
        reply(&candidate_json()),
        reply(&candidate_json()),
    ]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone()).with_evolution(evolution(
        &harness,
        extract.clone(),
        review.clone(),
    ));
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let first = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &first.event_id).await).expect("JSON");
    assert_eq!(result["evolution"]["candidates"], 1, "{result}");
    assert_eq!(extract.calls(), 1);

    // 内容没变:第二次只记“没有新内容”,不再调模型
    let second = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &second.event_id).await).expect("JSON");
    assert_eq!(
        result["evolution"]["skipped"], "会话自上次提炼后没有新内容",
        "{result}"
    );
    assert_eq!(extract.calls(), 1, "没新内容不该再调提炼");
    assert_eq!(review.calls(), 1);

    // 会话长出新内容(大小变了)→ 再提炼一次
    std::fs::write(&session, [session_jsonl(), session_jsonl()].join("\n")).expect("追加");
    let third = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &third.event_id).await).expect("JSON");
    assert!(
        result["evolution"]["candidates"].as_u64().is_some(),
        "有新内容应再提炼:{result}"
    );
    assert_eq!(extract.calls(), 2);
}

/// 后台模式:先返回 `pending`,提炼在后台跑完后把同一行事件的结果补上。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn background_extraction_updates_the_same_event() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone())
        .with_evolution(evolution(&harness, extract.clone(), review.clone()))
        .with_background_extraction();
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let outcome = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let first: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await).expect("JSON");
    assert_eq!(first["evolution"]["pending"], true, "{first}");
    assert!(first.get("evolution_error").is_none(), "{first}");

    // 等后台任务写完(最多 5 秒)
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let now: serde_json::Value =
            serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await).expect("JSON");
        if now["evolution"]["candidates"].as_u64() == Some(1) {
            return;
        }
    }
    panic!("后台提炼没有写回结果");
}

/// 后台提炼失败:不能残留 `pending`(a)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn background_failure_clears_the_pending_marker() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    // 提炼模型直接报错(模拟 LLM 5xx / 预算拒绝)
    let extract = Arc::new(MockChatModel::script(vec![ChatResponse {
        message: kb_core::model::ChatMessage {
            role: "assistant".to_owned(),
            content: Some("不是 JSON".to_owned()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        },
        input_tokens: 1,
        output_tokens: 1,
        finish_reason: "stop".to_owned(),
    }]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone())
        .with_evolution(evolution(&harness, extract, review))
        .with_background_extraction();
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let outcome = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    // 等后台跑完
    let mut last = String::new();
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        last = result_of(&harness.env, &outcome.event_id).await;
        if !last.contains("\"pending\"") {
            break;
        }
    }
    let result: serde_json::Value = serde_json::from_str(&last).expect("JSON");
    assert!(
        result.get("evolution").is_none(),
        "失败时不该留下 evolution(尤其 pending):{result}"
    );
    assert!(result.get("evolution_error").is_some(), "{result}");
}

/// 守护进程重启留下的 `pending` 行:启动时收尾,且不挡下一次提炼(b)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn interrupted_pending_is_recovered_and_not_treated_as_extracted() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");
    let metadata = std::fs::metadata(&session).expect("元数据");
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default();
    // 造一条“上一进程留下的 pending 行”
    let stuck = serde_json::json!({
        "index": "noop",
        "changed_files": 0,
        "session_bytes": metadata.len(),
        "session_mtime_ms": mtime,
        "evolution": { "pending": true },
    })
    .to_string();
    let event_id = uuid::Uuid::now_v7().to_string();
    EventRepo::append(
        harness.env.meta.as_ref(),
        kb_core::model::Event {
            id: event_id.clone(),
            kind: "session_end".to_owned(),
            project_id: Some(project.id.clone()),
            payload_json: serde_json::json!({
                "project_root": project.root_path,
                "head": null,
                "payload": { "session_path": session.to_string_lossy() },
            })
            .to_string(),
            received_at: kb_service::llm_gate::today_now_millis(),
            processed_at: Some(kb_service::llm_gate::today_now_millis()),
            result: Some(stuck),
        },
    )
    .await
    .expect("写事件");

    // 启动收尾:改写成失败原因
    let fixed = kb_service::evolution::recover_interrupted_pending(harness.env.meta.clone())
        .await
        .expect("收尾");
    assert_eq!(fixed, 1, "应改写一条");
    let recovered: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &event_id).await).expect("JSON");
    assert_eq!(
        recovered["evolution_error"], "守护进程重启,提炼中断",
        "{recovered}"
    );
    assert!(recovered.get("evolution").is_none(), "{recovered}");

    // 同一份没变的会话再触发:仍然要提炼(不能把 pending / 失败当成“已提炼”)
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone()).with_evolution(evolution(
        &harness,
        extract.clone(),
        review.clone(),
    ));
    let outcome = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await).expect("JSON");
    assert_eq!(result["evolution"]["candidates"], 1, "{result}");
    assert_eq!(extract.calls(), 1);
}

/// 项目没开提炼时同步给结论:后台模式下 `kb hook` 也能当场说明原因。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn disabled_extraction_is_reported_synchronously() {
    let harness = harness(false).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone())
        .with_evolution(evolution(&harness, extract.clone(), review.clone()))
        .with_background_extraction();
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let outcome = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await).expect("JSON");
    assert_eq!(
        result["evolution"]["skipped_unauthorized"], true,
        "{result}"
    );
    assert!(
        result["evolution"].get("pending").is_none(),
        "不该排进后台:{result}"
    );
    assert_eq!(extract.calls(), 0);
}

/// 同一份会话在提炼期间被再次触发:只跑一次(回归用例)。
///
/// Claude 的 `Stop` + `SessionEnd` 连发、用户级与项目级重复注册的 hook、宿主重试
/// 都会走到这里;重复提炼会多花 LLM 额度,还会写进重复的知识条目。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_session_in_flight_is_not_extracted_twice() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    // 提炼模型慢 300 ms:第二次触发时第一份还在跑
    let extract = Arc::new(
        MockChatModel::script(vec![reply(&candidate_json())])
            .with_delay(std::time::Duration::from_millis(300)),
    );
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone())
        .with_evolution(evolution(&harness, extract.clone(), review.clone()))
        .with_background_extraction();
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let first = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("第一次");
    let first_result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &first.event_id).await).expect("JSON");
    assert_eq!(first_result["evolution"]["pending"], true, "{first_result}");

    // 同一份没变的会话立刻再触发一次
    let second = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("第二次");
    let second_result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &second.event_id).await).expect("JSON");
    assert_eq!(
        second_result["evolution"]["skipped"], "提炼进行中",
        "{second_result}"
    );

    // 等第一份跑完:只调一次提炼与一次审核
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let done: serde_json::Value =
            serde_json::from_str(&result_of(&harness.env, &first.event_id).await).expect("JSON");
        if done["evolution"]["candidates"].as_u64() == Some(1) {
            break;
        }
    }
    assert_eq!(extract.calls(), 1, "同一份会话只该提炼一次");
    assert_eq!(review.calls(), 1);

    // 进程级占位在任务结束后释放:内容变了再触发能正常提炼
    std::fs::write(&session, [session_jsonl(), session_jsonl()].join("\n")).expect("追加");
    let third = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("第三次");
    let third_result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &third.event_id).await).expect("JSON");
    assert_eq!(
        third_result["evolution"]["pending"], true,
        "占位应已释放:{third_result}"
    );
}

/// 事件表里有一份**新鲜的** `pending`(同一进程还在跑):不重复提炼。
///
/// 与上一条互为两层守卫:上一条打的是进程内占位,这一条打的是“按事件行判断在途”。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_fresh_pending_row_blocks_a_second_extraction() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");
    let metadata = std::fs::metadata(&session).expect("元数据");
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default();
    let now = kb_service::llm_gate::today_now_millis();
    EventRepo::append(
        harness.env.meta.as_ref(),
        kb_core::model::Event {
            id: uuid::Uuid::now_v7().to_string(),
            kind: "session_end".to_owned(),
            project_id: Some(project.id.clone()),
            payload_json: serde_json::json!({
                "project_root": project.root_path,
                "head": null,
                "payload": { "session_path": session.to_string_lossy() },
            })
            .to_string(),
            received_at: now,
            processed_at: Some(now),
            result: Some(
                serde_json::json!({
                    "index": "noop",
                    "changed_files": 0,
                    "session_bytes": metadata.len(),
                    "session_mtime_ms": mtime,
                    "evolution": { "pending": true },
                })
                .to_string(),
            ),
        },
    )
    .await
    .expect("写事件");

    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone())
        .with_evolution(evolution(&harness, extract.clone(), review.clone()))
        .with_background_extraction();
    let outcome = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &outcome.event_id).await).expect("JSON");
    assert_eq!(result["evolution"]["skipped"], "提炼进行中", "{result}");
    assert_eq!(extract.calls(), 0);
}

/// 并发触发同一份会话:进程级占位挡住,只提炼一次(a)。
///
/// 顺序触发只能测到“事件行里的 pending”,这条用 `Barrier` 让 32 个请求同时进来,
/// 专门打占位那一层(去掉占位时这条会红)。
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_triggers_extract_only_once() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    let extract = Arc::new(
        MockChatModel::script(vec![reply(&candidate_json())])
            .with_delay(std::time::Duration::from_millis(400)),
    );
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = Arc::new(
        EventService::new(harness.env.meta.clone())
            .with_evolution(evolution(&harness, extract.clone(), review.clone()))
            .with_background_extraction(),
    );
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let barrier = Arc::new(tokio::sync::Barrier::new(32));
    let mut handles = Vec::new();
    for _ in 0..32 {
        let service = service.clone();
        let barrier = barrier.clone();
        let root = project.root_path.clone();
        let session = session.clone();
        handles.push(tokio::spawn(async move {
            barrier.wait().await;
            service
                .handle(request(&root, Some(&session)))
                .await
                .expect("处理事件")
        }));
    }
    let mut pending = 0;
    for handle in handles {
        // 用 handle 返回的那一刻的 `result`(后台任务可能已经把库里那行改写了)
        let outcome = handle.await.expect("任务");
        let result: serde_json::Value =
            serde_json::from_str(&outcome.result).expect("result 是 JSON");
        if result["evolution"]["pending"].as_bool() == Some(true) {
            pending += 1;
        }
    }
    assert_eq!(pending, 1, "32 个并发请求里只该有一个真的排进后台");
    // 等后台跑完(提炼 + 审核;`calls` 在延迟之前就自增,所以要等审核那次)
    for _ in 0..80 {
        if review.calls() > 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert_eq!(extract.calls(), 1, "只该提炼一次");
    assert_eq!(review.calls(), 1);
}

/// 老的 `pending`(超过在途窗口)不挡路;窗口内的挡(b)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn only_recent_pending_counts_as_in_flight() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");
    let metadata = std::fs::metadata(&session).expect("元数据");
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default();
    let now = kb_service::llm_gate::today_now_millis();

    let pending_row = |id: &str, age_ms: i64| kb_core::model::Event {
        id: id.to_owned(),
        kind: "session_end".to_owned(),
        project_id: Some(project.id.clone()),
        payload_json: serde_json::json!({
            "project_root": project.root_path,
            "head": null,
            "payload": { "session_path": session.to_string_lossy() },
        })
        .to_string(),
        received_at: now - age_ms,
        processed_at: Some(now - age_ms),
        result: Some(
            serde_json::json!({
                "index": "noop",
                "changed_files": 0,
                "session_bytes": metadata.len(),
                "session_mtime_ms": mtime,
                "evolution": { "pending": true },
            })
            .to_string(),
        ),
    };

    // 16 分钟前:残留,不挡
    EventRepo::append(
        harness.env.meta.as_ref(),
        pending_row("old-pending", 16 * 60 * 1000),
    )
    .await
    .expect("写事件");
    let extract = Arc::new(MockChatModel::script(vec![reply(&candidate_json())]));
    let review = Arc::new(MockChatModel::script(vec![reply(&review_json())]));
    let service = EventService::new(harness.env.meta.clone())
        .with_evolution(evolution(&harness, extract.clone(), review.clone()))
        .with_background_extraction();
    let fresh = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &fresh.event_id).await).expect("JSON");
    assert_eq!(
        result["evolution"]["pending"], true,
        "老的 pending 不该挡住:{result}"
    );

    // 另一份会话,给它自己造一条 14 分钟前的 pending:仍算在途,挡住
    let other = harness.dir.path().join("other.jsonl");
    std::fs::write(&other, session_jsonl()).expect("写会话");
    let other_meta = std::fs::metadata(&other).expect("元数据");
    let other_mtime = other_meta
        .modified()
        .ok()
        .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default();
    EventRepo::append(
        harness.env.meta.as_ref(),
        kb_core::model::Event {
            id: "recent-pending".to_owned(),
            kind: "session_end".to_owned(),
            project_id: Some(project.id.clone()),
            payload_json: serde_json::json!({
                "project_root": project.root_path,
                "head": null,
                "payload": { "session_path": other.to_string_lossy() },
            })
            .to_string(),
            received_at: now - 14 * 60 * 1000,
            processed_at: Some(now - 14 * 60 * 1000),
            result: Some(
                serde_json::json!({
                    "index": "noop",
                    "changed_files": 0,
                    "session_bytes": other_meta.len(),
                    "session_mtime_ms": other_mtime,
                    "evolution": { "pending": true },
                })
                .to_string(),
            ),
        },
    )
    .await
    .expect("写事件");
    let blocked = service
        .handle(request(&project.root_path, Some(&other)))
        .await
        .expect("处理事件");
    let blocked_result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &blocked.event_id).await).expect("JSON");
    assert_eq!(
        blocked_result["evolution"]["skipped"], "提炼进行中",
        "窗口内的 pending 应挡住:{blocked_result}"
    );
}

/// 后台提炼任务 panic:事件写成 `evolution_error`,占位释放,panic 内容不外泄。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_panicking_extraction_is_recorded_and_releases_the_claim() {
    let harness = harness(true).await;
    let session = harness.dir.path().join("session.jsonl");
    std::fs::write(&session, session_jsonl()).expect("写会话");
    let service = EventService::new(harness.env.meta.clone())
        .with_evolution(Arc::new(EvolutionService::new(
            harness.env.meta.clone(),
            harness.env.store.clone(),
            harness.env.embedder.clone(),
            LlmGate::new(harness.env.meta.clone(), GateConfig::default()),
            Arc::new(PanicModel),
            Arc::new(MockChatModel::reply("{}")),
            EvolutionConfig {
                review_mode: "ai".to_owned(),
                ..EvolutionConfig::default()
            },
        )))
        .with_background_extraction();
    let project = ProjectRepo::get(harness.env.meta.as_ref(), &harness.project_id)
        .await
        .expect("取项目")
        .expect("存在");

    let outcome = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let mut last = String::new();
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        last = result_of(&harness.env, &outcome.event_id).await;
        if !last.contains("\"pending\"") {
            break;
        }
    }
    let result: serde_json::Value = serde_json::from_str(&last).expect("JSON");
    assert!(
        result.get("evolution").is_none(),
        "不该留下 pending:{result}"
    );
    let error = result["evolution_error"].as_str().unwrap_or_default();
    assert!(!error.is_empty(), "应记下失败原因:{result}");
    assert!(!error.contains("BOOM-CANARY"), "panic 内容不该外泄:{error}");

    // 占位已释放:内容变了再触发能正常排进后台
    std::fs::write(&session, [session_jsonl(), session_jsonl()].join("\n")).expect("追加");
    let again = service
        .handle(request(&project.root_path, Some(&session)))
        .await
        .expect("处理事件");
    let again_result: serde_json::Value =
        serde_json::from_str(&result_of(&harness.env, &again.event_id).await).expect("JSON");
    assert_eq!(
        again_result["evolution"]["pending"], true,
        "占位应已释放:{again_result}"
    );
}
