//! UI-3 验收:编辑器里的 AI 写作经外发闸门调用模型(mock LLM)。
//!
//! 覆盖:AI 总开关关闭时拒绝且不调模型;正常调用的结果去掉模型多包的代码围栏、提示词里带着原文;
//! 用量按 `write` 用途记账;模型什么都没回时报错(不把空串交给编辑器替换选中)。

use std::sync::Arc;

use kb_core::ports::ChatModel;
use kb_core::ports::repo::LlmUsageRepo;
use kb_llm::MockChatModel;
use kb_service::llm_gate::{GateConfig, LlmGate, today};
use kb_service::write_assist::{WriteRequest, run};
use kb_testkit::TestEnv;

#[tokio::test]
async fn ai_switch_off_rejects_without_calling_the_model() {
    let env = TestEnv::new().await;
    let gate = LlmGate::new(
        env.meta.clone(),
        GateConfig {
            ai_enabled: false,
            ..GateConfig::default()
        },
    );
    let mock = Arc::new(MockChatModel::reply("不该被调用"));
    let model: Arc<dyn ChatModel> = mock.clone();
    let request = WriteRequest::new("polish", "一段话", None, None, None).expect("请求");
    let err = run(&gate, &model, &request)
        .await
        .expect_err("AI 关了应拒绝");
    assert!(matches!(err, kb_core::KbError::Forbidden(_)), "{err:?}");
    assert!(mock.requests().is_empty(), "关掉 AI 后不应调用模型");
}

#[tokio::test]
async fn polish_returns_cleaned_text_and_is_billed_as_write() {
    let env = TestEnv::new().await;
    let gate = LlmGate::new(env.meta.clone(), GateConfig::default());
    let mock = Arc::new(MockChatModel::reply("```markdown\n这个功能好用。\n```"));
    let model: Arc<dyn ChatModel> = mock.clone();
    let request =
        WriteRequest::new("polish", "这个功能很好用很好用", None, None, None).expect("请求");
    let text = run(&gate, &model, &request).await.expect("润色");
    assert_eq!(text, "这个功能好用。");
    let sent = mock.requests();
    assert_eq!(sent.len(), 1);
    assert!(
        sent[0]
            .last_user
            .as_deref()
            .is_some_and(|user| user.contains("<原文>\n这个功能很好用很好用\n</原文>")),
        "提示词里要带原文:{:?}",
        sent[0].last_user
    );
    let usage = LlmUsageRepo::usage_of_day(env.meta.as_ref(), &today())
        .await
        .expect("用量");
    assert!(
        usage
            .iter()
            .any(|row| row.purpose == "write" && row.calls == 1),
        "用量应按 write 用途记一笔:{usage:?}"
    );
}

#[tokio::test]
async fn empty_answer_is_an_error_not_an_empty_replacement() {
    let env = TestEnv::new().await;
    let gate = LlmGate::new(env.meta.clone(), GateConfig::default());
    let model: Arc<dyn ChatModel> = Arc::new(MockChatModel::reply("   "));
    let request = WriteRequest::new("summarize", "一大段内容", None, None, None).expect("请求");
    let err = run(&gate, &model, &request)
        .await
        .expect_err("空回答应报错");
    assert!(matches!(err, kb_core::KbError::Upstream(_)), "{err:?}");
}
