//! 验收:外发闸门。
//!
//! 断言:项目关掉云端 LLM 时拒绝外发;路径黑名单的片段被剔除;正文脱敏;
//! 每次外发在 `llm_sends` 留痕、并按天累加用量。

use std::sync::Arc;

use kb_core::model::{ChatMessage, ChatRequest};
use kb_core::ports::ChatModel;
use kb_core::ports::repo::{LlmUsageRepo, ProjectRepo};
use kb_llm::MockChatModel;
use kb_service::ProjectService;
use kb_service::llm_gate::{Fragment, GateConfig, LlmGate, Purpose};
use kb_testkit::TestEnv;

async fn setup() -> (TestEnv, LlmGate, String) {
    let env = TestEnv::new().await;
    let service = ProjectService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let dir = tempfile::tempdir().expect("目录");
    std::fs::write(dir.path().join("lib.rs"), "fn main() {}\n").expect("写文件");
    let project = service.add(dir.path(), Some("demo")).await.expect("加项目");
    let gate = LlmGate::new(env.meta.clone(), GateConfig::default());
    (env, gate, project.id)
}

fn request(text: &str) -> ChatRequest {
    ChatRequest {
        model: "deepseek-chat".to_owned(),
        messages: vec![ChatMessage {
            role: "user".to_owned(),
            content: Some(text.to_owned()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }],
        tools: Vec::new(),
        json_output: false,
        thinking: false,
        max_tokens: None,
        temperature: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cloud_llm_must_be_enabled_per_project() {
    let (env, gate, project_id) = setup().await;
    let model: Arc<dyn ChatModel> = Arc::new(MockChatModel::reply("不应该被调用"));

    // 默认 allow_cloud_llm = false → 拒绝
    let error = gate
        .send(Some(&project_id), Purpose::Extract, &model, request("你好"))
        .await
        .expect_err("应拒绝外发");
    assert!(matches!(error, kb_core::KbError::Forbidden(_)), "{error}");
    let message = gate
        .prepare(Some(&project_id), &[Fragment::new("src/lib.rs", "内容")])
        .await
        .expect_err("prepare 也应拒绝")
        .to_string();
    assert!(message.contains("allow_cloud_llm"), "{message}");

    // 打开开关后放行
    ProjectRepo::update(env.meta.as_ref(), {
        let mut project = ProjectRepo::get(env.meta.as_ref(), &project_id)
            .await
            .expect("取项目")
            .expect("存在");
        project.allow_cloud_llm = true;
        project
    })
    .await
    .expect("打开开关");
    let response = gate
        .send(Some(&project_id), Purpose::Extract, &model, request("你好"))
        .await
        .expect("放行");
    assert_eq!(response.message.content.as_deref(), Some("不应该被调用"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn blacklisted_paths_are_dropped_and_text_is_redacted() {
    let (env, gate, project_id) = setup().await;
    let mut project = ProjectRepo::get(env.meta.as_ref(), &project_id)
        .await
        .expect("取项目")
        .expect("存在");
    project.allow_cloud_llm = true;
    ProjectRepo::update(env.meta.as_ref(), project)
        .await
        .expect("打开开关");

    let prepared = gate
        .prepare(
            Some(&project_id),
            &[
                Fragment::new("src/lib.rs", "普通的正文"),
                Fragment::new("config/secrets.toml", "API_KEY=super-secret-value"),
                Fragment::new("docs/notes.md", "token = \"ghp_1234567890abcdefghij\""),
            ],
        )
        .await
        .expect("准备外发");
    assert_eq!(prepared.dropped, 1, "黑名单里的片段应被剔除");
    assert!(prepared.text.contains("普通的正文"));
    assert!(
        !prepared.text.contains("super-secret-value"),
        "{}",
        prepared.text
    );
    assert!(prepared.redactions >= 1, "应发生脱敏:{}", prepared.text);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn every_send_is_audited_and_counted() {
    let (env, gate, project_id) = setup().await;
    let mut project = ProjectRepo::get(env.meta.as_ref(), &project_id)
        .await
        .expect("取项目")
        .expect("存在");
    project.allow_cloud_llm = true;
    ProjectRepo::update(env.meta.as_ref(), project)
        .await
        .expect("打开开关");

    let model: Arc<dyn ChatModel> = Arc::new(MockChatModel::reply("好的"));
    gate.send(
        Some(&project_id),
        Purpose::Review,
        &model,
        request("审一下"),
    )
    .await
    .expect("外发");

    // 用量按天累加
    let day = kb_service::llm_gate::today();
    let usages = LlmUsageRepo::usage_of_day(env.meta.as_ref(), &day)
        .await
        .expect("查用量");
    let review: Vec<_> = usages
        .iter()
        .filter(|usage| usage.purpose == "review")
        .collect();
    assert_eq!(review.len(), 1, "{usages:?}");
    assert_eq!(review[0].calls, 1);
    assert!(review[0].input_tokens > 0, "{:?}", review[0]);
}

#[test]
fn purpose_strings_match_the_audit_columns() {
    assert_eq!(Purpose::Extract.as_str(), "extract");
    assert_eq!(Purpose::Review.as_str(), "review");
    assert_eq!(Purpose::Agent.as_str(), "agent");
}

/// `[llm] max_calls_per_hour` 接线后:一小时内超过上限就拒绝(不再只是配置项)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hourly_call_limit_is_enforced() {
    let env = TestEnv::new().await;
    let service = ProjectService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let dir = tempfile::tempdir().expect("目录");
    std::fs::write(dir.path().join("lib.rs"), "fn main() {}\n").expect("写文件");
    let project = service.add(dir.path(), Some("demo")).await.expect("加项目");
    let mut stored = ProjectRepo::get(env.meta.as_ref(), &project.id)
        .await
        .expect("取项目")
        .expect("存在");
    stored.allow_cloud_llm = true;
    ProjectRepo::update(env.meta.as_ref(), stored)
        .await
        .expect("更新");

    let gate = LlmGate::new(
        env.meta.clone(),
        GateConfig {
            max_calls_per_hour: 2,
            ..GateConfig::default()
        },
    );
    let model: Arc<dyn ChatModel> = Arc::new(MockChatModel::reply("好"));
    for _ in 0..2 {
        gate.send(Some(&project.id), Purpose::Extract, &model, request("你好"))
            .await
            .expect("前两次应放行");
    }
    let error = gate
        .send(
            Some(&project.id),
            Purpose::Extract,
            &model,
            request("再来一次"),
        )
        .await
        .expect_err("第三次应被每小时上限拒绝");
    assert!(matches!(error, kb_core::KbError::Unavailable(_)), "{error}");
    assert!(error.to_string().contains("最近一小时"), "{error}");
    // 留痕是三次之外的那两次;被拒的那次不写
    assert_eq!(
        LlmUsageRepo::count_sends_since(env.meta.as_ref(), 0)
            .await
            .expect("数外发"),
        2
    );
}

/// 每日 token 预算:用满之后拒绝(接线后不再是“不限”)。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn daily_token_budget_is_enforced() {
    let env = TestEnv::new().await;
    let service = ProjectService::new(env.meta.clone(), env.store.clone(), env.embedder.clone());
    let dir = tempfile::tempdir().expect("目录");
    std::fs::write(dir.path().join("lib.rs"), "fn main() {}\n").expect("写文件");
    let project = service.add(dir.path(), Some("demo")).await.expect("加项目");
    let mut stored = ProjectRepo::get(env.meta.as_ref(), &project.id)
        .await
        .expect("取项目")
        .expect("存在");
    stored.allow_cloud_llm = true;
    ProjectRepo::update(env.meta.as_ref(), stored)
        .await
        .expect("更新");

    let gate = LlmGate::new(
        env.meta.clone(),
        GateConfig {
            daily_token_budget: 1,
            ..GateConfig::default()
        },
    );
    let model: Arc<dyn ChatModel> = Arc::new(MockChatModel::reply("好"));
    gate.send(Some(&project.id), Purpose::Extract, &model, request("你好"))
        .await
        .expect("第一次应放行");
    let error = gate
        .send(
            Some(&project.id),
            Purpose::Extract,
            &model,
            request("再来一次"),
        )
        .await
        .expect_err("预算用完后应拒绝");
    assert!(matches!(error, kb_core::KbError::Unavailable(_)), "{error}");
    assert!(error.to_string().contains("token 预算"), "{error}");
}

#[tokio::test]
async fn turning_ai_off_blocks_every_outbound_call() {
    let env = TestEnv::new().await;
    let gate = LlmGate::new(
        env.meta.clone(),
        GateConfig {
            ai_enabled: false,
            ..GateConfig::default()
        },
    );
    assert!(
        !gate.allowed(None).await.unwrap(),
        "AI 关闭时全局范围也不放行"
    );
    let error = gate
        .prepare(None, &[Fragment::new("src/lib.rs", "pub fn main() {}")])
        .await
        .expect_err("AI 关闭后不能外发");
    assert!(error.to_string().contains("AI 功能已关闭"), "{error}");
    let on = LlmGate::new(env.meta.clone(), GateConfig::default());
    assert!(on.allowed(None).await.unwrap());
}

// ---------------------------------------------------------------- 按用户记账与每日额度

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use async_trait::async_trait;
use kb_core::ports::UserLlmLedger;

/// 内存账本:额度可随时改,记账可设成失败。
#[derive(Default)]
struct MemLedger {
    limit: AtomicU64,
    used: Mutex<HashMap<(String, String), u64>>,
    fail_record: AtomicBool,
}

impl MemLedger {
    fn with_limit(limit: u64) -> Arc<Self> {
        let ledger = Self::default();
        ledger.limit.store(limit, Ordering::Relaxed);
        Arc::new(ledger)
    }
    fn used_by(&self, user: &str, day: &str) -> u64 {
        *self
            .used
            .lock()
            .unwrap()
            .get(&(user.to_owned(), day.to_owned()))
            .unwrap_or(&0)
    }
}

#[async_trait]
impl UserLlmLedger for MemLedger {
    async fn daily_limit(&self, _user: &str) -> kb_core::Result<u64> {
        Ok(self.limit.load(Ordering::Relaxed))
    }
    async fn used_on(&self, user: &str, day: &str) -> kb_core::Result<u64> {
        Ok(self.used_by(user, day))
    }
    async fn record(
        &self,
        user: &str,
        day: &str,
        _purpose: &str,
        input: u64,
        output: u64,
    ) -> kb_core::Result<()> {
        if self.fail_record.load(Ordering::Relaxed) {
            return Err(kb_core::KbError::Internal("账本写不进去".to_owned()));
        }
        *self
            .used
            .lock()
            .unwrap()
            .entry((user.to_owned(), day.to_owned()))
            .or_default() += input + output;
        Ok(())
    }
}

fn mock() -> (Arc<MockChatModel>, Arc<dyn ChatModel>) {
    let concrete = Arc::new(MockChatModel::reply("好"));
    (concrete.clone(), concrete)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_persons_daily_allowance_runs_out_and_blocks_before_the_model_is_called() {
    let env = TestEnv::new().await;
    let ledger = MemLedger::with_limit(20); // 每次调用 15 token:第一次放行,第二次(累计 15 < 20)放行,第三次(30)拦截
    let gate = LlmGate::new(env.meta.clone(), GateConfig::default())
        .with_user_budget(ledger.clone(), "usr_alice");
    let (counter, model) = mock();
    for _ in 0..2 {
        gate.send(None, Purpose::Agent, &model, request("你好"))
            .await
            .expect("额度内放行");
    }
    assert_eq!(
        ledger.used_by("usr_alice", &kb_service::llm_gate::today()),
        30
    );
    let error = gate
        .send(None, Purpose::Agent, &model, request("再来"))
        .await
        .expect_err("额度用完应拒绝");
    assert!(matches!(error, kb_core::KbError::Unavailable(_)), "{error}");
    let message = error.to_string();
    assert!(
        message.contains("今天的 AI 额度已用完") && message.contains("30 / 上限 20"),
        "{message}"
    );
    assert_eq!(counter.calls(), 2, "被拦截的调用不能真的打到模型");
    // 流式出口同样被拦
    let error = gate
        .send_streaming(
            None,
            Purpose::Agent,
            &model,
            request("流式"),
            &mut |_, _| {},
        )
        .await
        .expect_err("流式也应拒绝");
    assert!(error.to_string().contains("AI 额度"), "{error}");
    assert_eq!(counter.calls(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn allowances_are_per_person_zero_means_unlimited_and_changes_apply_at_once() {
    let env = TestEnv::new().await;
    let ledger = MemLedger::with_limit(15);
    let (_, model) = mock();
    let alice = LlmGate::new(env.meta.clone(), GateConfig::default())
        .with_user_budget(ledger.clone(), "usr_alice");
    let bob = LlmGate::new(env.meta.clone(), GateConfig::default())
        .with_user_budget(ledger.clone(), "usr_bob");
    alice
        .send(None, Purpose::Agent, &model, request("a"))
        .await
        .expect("alice 第一次");
    alice
        .send(None, Purpose::Agent, &model, request("a"))
        .await
        .expect_err("alice 已经用满 15");
    bob.send(None, Purpose::Agent, &model, request("b"))
        .await
        .expect("bob 的额度和 alice 无关");
    // 管理员把额度调大:alice 下一次就能用,不用重启、不用重建闸门
    ledger.limit.store(1_000, Ordering::Relaxed);
    alice
        .send(None, Purpose::Agent, &model, request("a"))
        .await
        .expect("调大后放行");
    // 额度 0 = 不限
    ledger.limit.store(0, Ordering::Relaxed);
    for _ in 0..5 {
        alice
            .send(None, Purpose::Agent, &model, request("a"))
            .await
            .expect("不限");
    }
    // 调小到比已用的还少,立刻拦住
    ledger.limit.store(10, Ordering::Relaxed);
    alice
        .send(None, Purpose::Agent, &model, request("a"))
        .await
        .expect_err("调小后拦截");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn yesterdays_use_does_not_count_today_and_a_gate_without_a_payer_is_not_limited_per_person()
{
    let env = TestEnv::new().await;
    let ledger = MemLedger::with_limit(15);
    ledger
        .used
        .lock()
        .unwrap()
        .insert(("usr_alice".into(), "1999-12-31".into()), 1_000_000);
    let (_, model) = mock();
    let alice = LlmGate::new(env.meta.clone(), GateConfig::default())
        .with_user_budget(ledger.clone(), "usr_alice");
    alice
        .send(None, Purpose::Agent, &model, request("a"))
        .await
        .expect("昨天的不算今天");
    // 没挂付费人的闸门(本机超级用户、后台任务):不受按人额度约束,也不往账本里写
    let anonymous = LlmGate::new(env.meta.clone(), GateConfig::default());
    for _ in 0..3 {
        anonymous
            .send(None, Purpose::Extract, &model, request("x"))
            .await
            .expect("无付费人不限");
    }
    assert_eq!(
        ledger.used.lock().unwrap().len(),
        2,
        "只有 alice 的两行(昨天预置的 + 今天的)"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_ledger_write_failure_does_not_throw_away_an_answer_that_was_already_paid_for() {
    let env = TestEnv::new().await;
    let ledger = MemLedger::with_limit(1_000);
    ledger.fail_record.store(true, Ordering::Relaxed);
    let (_, model) = mock();
    let gate = LlmGate::new(env.meta.clone(), GateConfig::default())
        .with_user_budget(ledger.clone(), "usr_alice");
    let response = gate
        .send(None, Purpose::Agent, &model, request("你好"))
        .await
        .expect("钱已经花了,答案要给用户");
    assert_eq!(response.message.content.as_deref(), Some("好"));
    // 本地留痕照常写
    let usages = LlmUsageRepo::usage_of_day(env.meta.as_ref(), &kb_service::llm_gate::today())
        .await
        .unwrap();
    assert_eq!(usages.iter().map(|u| u.calls).sum::<u32>(), 1);
}
