//! 外发闸门。
//!
//! 所有发往云端的 LLM 调用都必须经过 [`LlmGate::send`],它负责四件事:
//! 1. **项目开关**:`project.allow_cloud_llm = false` 时直接拒绝(`Forbidden`);
//! 2. **路径黑名单**:命中的片段整段剔除(不进提示词);
//! 3. **脱敏**:正文走 `kb_core::redact`,替换次数记进 `llm_sends`;
//! 4. **留痕**:每次外发写一条 `llm_sends`(字符数 / 脱敏次数),并累加当日用量;
//! 5. **按人记账**(多用户):挂了 [`UserBudget`] 的闸门在外发前检查付费人当天的额度,调完记一笔,用完当天拒绝。
//!
//! 调用方只拿到“脱敏后的文本”,看不到原始内容 —— 这样即使以后加了新的调用点,
//! 也不会绕过闸门。

use std::sync::Arc;

use kb_core::model::{LlmSend, LlmUsage};
use kb_core::ports::repo::{LlmUsageRepo, MetaStore, ProjectRepo};
use kb_core::ports::{ChatModel, UserLlmLedger};
use kb_core::{KbError, Result};

/// 外发用途(写进 `llm_sends.purpose`)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    /// 提炼 insight。
    Extract,
    /// 审核草稿。
    Review,
    /// AI 管家。
    Agent,
    /// 主题归纳(`consolidate_project`)。
    Consolidate,
    /// 网页来源的 AI 规范化。
    WebExtract,
    /// 编辑器里的 AI 写作(UI-3):润色 / 总结 / 翻译 / 续写选中的文字。
    Write,
}

impl Purpose {
    /// 字符串形式(与审计 / 用量的 `purpose` 一致)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Extract => "extract",
            Self::Review => "review",
            Self::Agent => "agent",
            Self::Consolidate => "consolidate",
            Self::WebExtract => "web_extract",
            Self::Write => "write",
        }
    }
}

/// 闸门配置。
#[derive(Clone, Debug)]
pub struct GateConfig {
    /// 路径黑名单(子串匹配,例如 `secrets/`、`.env`)。
    pub path_blacklist: Vec<String>,
    /// 每日 token 预算(0 = 不限)。
    pub daily_token_budget: u64,
    /// 每小时最大调用次数(0 = 不限)。
    pub max_calls_per_hour: u64,
    /// AI 总开关(`[ai] enabled`)。关了任何外发一律拒绝——后台提炼、审核、整理都经过这里,
    /// 不管是哪个用户触发的,还是 git hook 自动触发的。
    pub ai_enabled: bool,
}

impl Default for GateConfig {
    fn default() -> Self {
        Self {
            path_blacklist: vec![
                ".env".to_owned(),
                "secrets".to_owned(),
                "id_rsa".to_owned(),
                ".pem".to_owned(),
            ],
            daily_token_budget: 0,
            max_calls_per_hour: 0,
            ai_enabled: true,
        }
    }
}

/// 一次外发的准备结果(闸门放行后由调用方拼提示词)。
#[derive(Clone, Debug, PartialEq)]
pub struct Prepared {
    /// 脱敏后的文本。
    pub text: String,
    /// 被剔除的路径数。
    pub dropped: usize,
    /// 脱敏替换次数。
    pub redactions: usize,
}

/// 待外发的一段内容(带来源路径,用于黑名单判定)。
#[derive(Clone, Debug)]
pub struct Fragment {
    /// 来源路径(项目内相对路径)。
    pub path: String,
    /// 正文。
    pub text: String,
}

impl Fragment {
    /// 构造。
    pub fn new(path: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            text: text.into(),
        }
    }
}

/// 外发闸门(构造很轻,克隆只是复制两个 `Arc` / 配置)。
#[derive(Clone)]
pub struct LlmGate {
    meta: Arc<dyn MetaStore>,
    config: GateConfig,
    user: Option<UserBudget>,
}

/// 这个闸门替谁付费、账记在哪。
#[derive(Clone)]
pub struct UserBudget {
    ledger: Arc<dyn UserLlmLedger>,
    user_id: String,
}

impl LlmGate {
    /// 构造。
    pub fn new(meta: Arc<dyn MetaStore>, config: GateConfig) -> Self {
        Self {
            meta,
            config,
            user: None,
        }
    }

    /// 让这个闸门替 `user_id` 付费:外发前查他今天的额度,调完记账。
    ///
    /// 谁来付:用户自己触发的调用记他自己;后台任务(提炼、审核)记知识库的主人。
    /// 本机超级用户 / 不属于任何人的调用不要挂(没有人可以记)。
    pub fn with_user_budget(
        mut self,
        ledger: Arc<dyn UserLlmLedger>,
        user_id: impl Into<String>,
    ) -> Self {
        self.user = Some(UserBudget {
            ledger,
            user_id: user_id.into(),
        });
        self
    }

    /// 付费人当天的额度检查。用完返回 `Unavailable`,文案是给用户看的。
    ///
    /// 这是「先查后调」:并发的几次调用可能一起通过检查,最多超出各自那一次调用的用量,
    /// 下一次检查就会拦住——额度是防滥用的闸,不是精确到 token 的预扣。
    async fn check_user_budget(&self) -> Result<()> {
        let Some(user) = &self.user else {
            return Ok(());
        };
        let limit = user.ledger.daily_limit(&user.user_id).await?;
        if limit == 0 {
            return Ok(());
        }
        let used = user.ledger.used_on(&user.user_id, &today()).await?;
        if used >= limit {
            return Err(KbError::Unavailable(format!(
                "今天的 AI 额度已用完(已用 {used} / 上限 {limit} token),明天 0 点(站点时区)后恢复,也可以联系管理员调整额度"
            )));
        }
        Ok(())
    }

    /// 记一笔付费人的用量。模型已经调完、钱已经花了,记账失败不能让这次调用也跟着失败,只告警。
    async fn record_user(&self, purpose: Purpose, response: &kb_core::model::ChatResponse) {
        let Some(user) = &self.user else {
            return;
        };
        if let Err(err) = user
            .ledger
            .record(
                &user.user_id,
                &today(),
                purpose.as_str(),
                response.input_tokens,
                response.output_tokens,
            )
            .await
        {
            tracing::warn!(user = %user.user_id, error = %err, "记录 LLM 用量失败,这次调用没有计入额度");
        }
    }

    /// 项目是否允许外发(`None` = 全局,视为允许)。
    pub async fn allowed(&self, project_id: Option<&str>) -> Result<bool> {
        if !self.config.ai_enabled {
            return Ok(false);
        }
        let Some(project_id) = project_id else {
            return Ok(true);
        };
        let project = ProjectRepo::get(self.meta.as_ref(), project_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("project {project_id}")))?;
        Ok(project.allow_cloud_llm)
    }

    /// 准备一次外发:检查开关、剔黑名单、脱敏。
    ///
    /// 返回的文本才可以进提示词;原始 [`Fragment`] 不会被带出去。
    pub async fn prepare(
        &self,
        project_id: Option<&str>,
        fragments: &[Fragment],
    ) -> Result<Prepared> {
        if !self.config.ai_enabled {
            return Err(KbError::Forbidden("AI 功能已关闭".to_owned()));
        }
        if !self.allowed(project_id).await? {
            return Err(KbError::Forbidden(
                "该项目的 allow_cloud_llm=false,拒绝外发".to_owned(),
            ));
        }
        let mut kept = Vec::new();
        let mut dropped = 0usize;
        for fragment in fragments {
            if self.is_blacklisted(&fragment.path) {
                dropped += 1;
                continue;
            }
            kept.push(fragment.text.clone());
        }
        let joined = kept.join("\n\n");
        let (text, redactions) = kb_core::redact::redact_with_count(&joined);
        Ok(Prepared {
            text,
            dropped,
            redactions,
        })
    }

    /// 一次外发:闸门放行后调用模型,并把用量与留痕写库。
    pub async fn send(
        &self,
        project_id: Option<&str>,
        purpose: Purpose,
        model: &Arc<dyn ChatModel>,
        request: kb_core::model::ChatRequest,
    ) -> Result<kb_core::model::ChatResponse> {
        if !self.allowed(project_id).await? {
            return Err(KbError::Forbidden(
                "该项目的 allow_cloud_llm=false,拒绝外发".to_owned(),
            ));
        }
        self.check_budget(model.id()).await?;
        self.check_user_budget().await?;
        // 请求里的消息也要过一遍脱敏(调用方可能直接塞了原文)
        let mut request = request;
        let mut redactions = 0usize;
        let mut chars = 0usize;
        for message in &mut request.messages {
            if let Some(content) = &message.content {
                let (text, count) = kb_core::redact::redact_with_count(content);
                chars += text.chars().count();
                redactions += count;
                message.content = Some(text);
            }
        }
        let response = model.chat(request).await?;
        // 先记付费人的账:本地留痕(下面)失败会提前返回,但钱已经花了
        self.record_user(purpose, &response).await;
        self.record(
            project_id,
            purpose,
            model.id(),
            &response,
            chars,
            redactions,
        )
        .await?;
        Ok(response)
    }

    /// 同 [`Self::send`],但走流式(正文增量交给回调)。脱敏与留痕逻辑完全一致。
    pub async fn send_streaming(
        &self,
        project_id: Option<&str>,
        purpose: Purpose,
        model: &Arc<dyn ChatModel>,
        request: kb_core::model::ChatRequest,
        on_delta: &mut (dyn for<'a> FnMut(&'a str, bool) + Send),
    ) -> Result<kb_core::model::ChatResponse> {
        if !self.allowed(project_id).await? {
            return Err(KbError::Forbidden(
                "该项目的 allow_cloud_llm=false,拒绝外发".to_owned(),
            ));
        }
        self.check_budget(model.id()).await?;
        self.check_user_budget().await?;
        let mut request = request;
        let mut redactions = 0usize;
        let mut chars = 0usize;
        for message in &mut request.messages {
            if let Some(content) = &message.content {
                let (text, count) = kb_core::redact::redact_with_count(content);
                chars += text.chars().count();
                redactions += count;
                message.content = Some(text);
            }
        }
        let response = model.chat_stream(request, on_delta).await?;
        self.record_user(purpose, &response).await;
        self.record(
            project_id,
            purpose,
            model.id(),
            &response,
            chars,
            redactions,
        )
        .await?;
        Ok(response)
    }

    fn is_blacklisted(&self, path: &str) -> bool {
        let lower = path.to_ascii_lowercase();
        self.config
            .path_blacklist
            .iter()
            .any(|pattern| lower.contains(&pattern.to_ascii_lowercase()))
    }

    /// 预算检查:每小时调用次数与当日 token(超出返回 `Unavailable`)。
    async fn check_budget(&self, model: &str) -> Result<()> {
        if self.config.max_calls_per_hour > 0 {
            let hour_ago = now_millis() - 3_600_000;
            let calls = LlmUsageRepo::count_sends_since(self.meta.as_ref(), hour_ago).await?;
            if calls >= self.config.max_calls_per_hour {
                return Err(KbError::Unavailable(format!(
                    "最近一小时已外发 {calls} 次(上限 {}),稍后再试",
                    self.config.max_calls_per_hour
                )));
            }
        }
        if self.config.daily_token_budget == 0 {
            return Ok(());
        }
        let day = today();
        let usages = LlmUsageRepo::usage_of_day(self.meta.as_ref(), &day).await?;
        let used: u64 = usages
            .iter()
            .filter(|usage| usage.model == model)
            .map(|usage| usage.input_tokens + usage.output_tokens)
            .sum();
        if used >= self.config.daily_token_budget {
            return Err(KbError::Unavailable(format!(
                "今日 token 预算已用完({used}/{}),明天再试",
                self.config.daily_token_budget
            )));
        }
        Ok(())
    }

    /// 写用量与留痕。
    async fn record(
        &self,
        project_id: Option<&str>,
        purpose: Purpose,
        model: &str,
        response: &kb_core::model::ChatResponse,
        chars: usize,
        redactions: usize,
    ) -> Result<()> {
        LlmUsageRepo::add_usage(
            self.meta.as_ref(),
            LlmUsage {
                day: today(),
                model: model.to_owned(),
                purpose: purpose.as_str().to_owned(),
                calls: 1,
                input_tokens: response.input_tokens,
                output_tokens: response.output_tokens,
            },
        )
        .await?;
        LlmUsageRepo::record_send(
            self.meta.as_ref(),
            LlmSend {
                id: None,
                at: now_millis(),
                project_id: project_id.map(str::to_owned),
                purpose: purpose.as_str().to_owned(),
                chars: chars as u64,
                redactions: redactions as u64,
            },
        )
        .await?;
        Ok(())
    }
}

/// 当前时间的毫秒值(给“到点刷新”这类判断用)。
pub fn today_now_millis() -> i64 {
    now_millis()
}

/// 当前站点时区里的 `YYYY-MM-DD`(与用量表的按日记账一致)。
pub fn today() -> String {
    day_text(now_millis())
}

/// 毫秒时间戳在**站点时区**里的日期,`YYYY-MM-DD`。
pub fn day_text(millis: i64) -> String {
    kb_core::timezone::day_key(millis)
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blacklist_matches_case_insensitively() {
        let config = GateConfig::default();
        let hit = |path: &str| {
            let lower = path.to_ascii_lowercase();
            config
                .path_blacklist
                .iter()
                .any(|pattern| lower.contains(&pattern.to_ascii_lowercase()))
        };
        assert!(hit("config/secrets/db.toml"));
        assert!(hit(".ENV"));
        assert!(hit("certs/server.PEM"));
        assert!(!hit("src/lib.rs"));
    }

    #[test]
    fn today_is_iso_date() {
        let day = today();
        assert_eq!(day.len(), 10, "{day}");
        assert_eq!(&day[4..5], "-");
        assert_eq!(&day[7..8], "-");
        assert_eq!(
            kb_core::timezone::day_key(0),
            "1970-01-01",
            "纪元时刻在上海是 1 月 1 日 08:00"
        );
        // 2026-10-28 23:59:59 UTC 在上海已经是 10-29
        assert_eq!(
            day_text(1_793_231_999_000),
            "2026-10-29",
            "日界按北京时间,不按 UTC"
        );
    }
}
