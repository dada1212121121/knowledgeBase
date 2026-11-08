//! AI 管家（设计规范）。
//!
//! 一轮对话:LLM 拿到“能力注册表里可见面含 A、权限 ≤ G”的工具,最多调 8 次;
//! **有副作用的能力先 dry_run**,把计划做成卡片给用户确认,确认时校验参数哈希再正式执行
//! (正式执行会开批次,可撤销)。会话记录写 `agent_messages`。
//!
//! 与其它模块的边界:
//! - 工具清单与执行由 [`ToolRunner`] 提供(`kb-cli` 用能力注册表实现),本模块只管对话与卡片;
//! - 外发统一过 [`LlmGate`](crate::llm_gate::LlmGate);工具结果里来自未授权项目的正文会被替换成
//!   “(正文未外发)”标记,只留标题 / 路径。

use std::sync::Arc;

use kb_core::model::{AgentMessage, ChatMessage, ChatRequest, Millis, ToolSpec};
use kb_core::ports::ChatModel;
use kb_core::ports::repo::{AgentRepo, MetaStore};
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::llm_gate::{LlmGate, Purpose};

/// 单轮最多几次工具调用。
pub const MAX_TOOL_CALLS: u32 = 8;

/// 上下文压缩:保留最近多少条消息原文。
const KEEP_RECENT_MESSAGES: usize = 12;
/// 至少攒够多少条 / 多少字才值得压缩。
const COMPRESS_MIN_MESSAGES: usize = 8;
const COMPRESS_MIN_CHARS: usize = 4_000;
/// 工具结果进模型上下文时的上限(超出截断,避免一次检索把上下文撑爆)。
const MAX_TOOL_RESULT_CHARS: usize = 6_000;
/// 摘要本身的长度上限(超了只留最后一段)。
const MAX_SUMMARY_CHARS: usize = 2_000;

/// 压缩摘要的提示词。
const COMPRESS_PROMPT: &str = "把下面这段「知识库管家」与用户的对话压缩成不超过 300 字的中文摘要。\
保留:用户的目标、已经确认的决定、涉及的项目 / 文件 / 条目 id、还没做完的事;不要编造。\
只输出摘要正文。";

/// 系统提示词。
pub const AGENT_PROMPT: &str = "你是知识库管家,可以调用工具完成知识库里的各种操作:检索与浏览、\
新建/编辑条目与经验、审核草稿、导入与解析(本地目录 / 全局)、管理项目与数据源、查看任务与批次、\
评测、备份等。有副作用的操作会先生成一张“计划卡片”让用户确认,你只需说明你要做什么;\
用户确认后才会真正执行。回答用中文,简洁;工具结果里的条目 / 项目 / 任务会自动变成可点击的引用,\
你可以在正文里用标题和列表把结果讲清楚。不确定用哪个工具时,先用 list_* / search_* 查清楚再动手。";

/// 工具执行器(由外壳实现)。
#[async_trait::async_trait]
pub trait ToolRunner: Send + Sync {
    /// 可用工具(已按可见面 A、权限 ≤ G 过滤)。
    fn tools(&self) -> Vec<ToolSpec>;
    /// 这个能力有没有副作用(有就先 dry_run)。
    fn is_mutating(&self, name: &str) -> bool;
    /// 执行一次调用;`dry_run = true` 时只返回计划。
    async fn call(&self, name: &str, args: Value, dry_run: bool) -> Result<Value>;
    /// 给定检索结果里的 collection,是否允许把正文外发。
    async fn allows_llm(&self, collections: &[String]) -> Result<bool>;
}

/// 一张待确认的计划卡片。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PlanCard {
    /// 卡片 id(确认时用)。
    pub id: String,
    /// 能力名。
    pub capability: String,
    /// 原始参数。
    pub args: Value,
    /// 参数哈希(确认时校验,防篡改)。
    pub args_hash: String,
    /// dry_run 返回的计划。
    pub plan: Value,
}

/// 一次对话的结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AgentReply {
    /// 助手文本。
    pub text: String,
    /// 待确认的卡片。
    pub cards: Vec<PlanCard>,
    /// 工具调用轨迹(能力名)。
    pub trace: Vec<String>,
    /// 工具结果里出现的条目 / 项目 / 批次 / 任务(前端渲染成可点击的跳转)。
    pub refs: Vec<AgentRef>,
}

/// 工具结果里可以点开的东西。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AgentRef {
    /// `item` / `project` / `batch` / `job`。
    pub kind: String,
    /// 条目 id / 项目 slug / 批次 id / 任务 id。
    pub id: String,
    /// 展示用的名字(标题 / 项目名 / 批次号)。
    pub label: String,
    /// 条目所属 collection(项目 / 批次没有)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection: Option<String>,
    /// 条目相对路径(给 UI 显示副标题)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// 确认结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ConfirmResult {
    /// 执行结果。
    pub result: Value,
    /// 所属批次(可撤销)。
    pub batch_id: Option<String>,
}

/// AI 管家服务。
pub struct AgentService {
    meta: Arc<dyn MetaStore>,
    gate: LlmGate,
    model: Arc<dyn ChatModel>,
    runner: Arc<dyn ToolRunner>,
}

impl AgentService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        gate: LlmGate,
        model: Arc<dyn ChatModel>,
        runner: Arc<dyn ToolRunner>,
    ) -> Self {
        Self {
            meta,
            gate,
            model,
            runner,
        }
    }

    /// 发一条消息,跑一轮(最多 8 次工具调用)。
    pub async fn send(
        &self,
        session_id: &str,
        project_id: Option<&str>,
        text: &str,
    ) -> Result<AgentReply> {
        self.send_with(session_id, project_id, text, &mut |_, _| {})
            .await
    }

    /// 同 [`Self::send`],但把助手的正文增量回调出去(`agent.delta` 推送用)。
    pub async fn send_with(
        &self,
        session_id: &str,
        project_id: Option<&str>,
        text: &str,
        on_delta: &mut (dyn for<'a> FnMut(&'a str, bool) + Send),
    ) -> Result<AgentReply> {
        // 长会话先压缩:较早的消息变成一段摘要,最近的保留原文
        if let Err(err) = self.compress_history(session_id, project_id).await {
            tracing::warn!(error = %err, "压缩上下文失败,继续用完整历史");
        }
        let meta = AgentRepo::session_meta(self.meta.as_ref(), session_id).await?;
        let history = AgentRepo::list(self.meta.as_ref(), session_id, 500).await?;
        let mut messages = context_messages(&history, &meta, text);
        AgentRepo::append(
            self.meta.as_ref(),
            AgentMessage {
                session_id: session_id.to_owned(),
                seq: 0,
                role: "user".to_owned(),
                content_json: json!({ "text": text }).to_string(),
                at: now_millis(),
            },
        )
        .await?;
        // 会话元数据:确保列表里有这一行(项目可能稍后从工具参数里补)
        AgentRepo::touch_session(self.meta.as_ref(), session_id, project_id, now_millis()).await?;

        let mut project_hint: Option<String> = None;
        let outcome = self
            .run_turns(
                session_id,
                project_id,
                &mut messages,
                on_delta,
                &mut project_hint,
            )
            .await;
        match outcome {
            Ok((text, cards, trace, refs)) => {
                AgentRepo::append(
                    self.meta.as_ref(),
                    AgentMessage {
                        session_id: session_id.to_owned(),
                        seq: 0,
                        role: "assistant".to_owned(),
                        content_json: json!({
                            "text": text,
                            "trace": trace,
                            "refs": refs,
                        })
                        .to_string(),
                        at: now_millis(),
                    },
                )
                .await?;
                if let Some(project) = project_hint {
                    AgentRepo::touch_session(
                        self.meta.as_ref(),
                        session_id,
                        Some(&project),
                        now_millis(),
                    )
                    .await?;
                }
                Ok(AgentReply {
                    text,
                    cards,
                    trace,
                    refs,
                })
            }
            Err(err) => {
                // 失败也记一笔:切回这个会话时能看到“这一轮为什么没有回复”
                let _ = AgentRepo::append(
                    self.meta.as_ref(),
                    AgentMessage {
                        session_id: session_id.to_owned(),
                        seq: 0,
                        role: "assistant".to_owned(),
                        content_json: json!({ "text": "", "error": err.to_string() }).to_string(),
                        at: now_millis(),
                    },
                )
                .await;
                Err(err)
            }
        }
    }

    /// 跑一轮工具循环,返回 (正文, 卡片, 轨迹, 引用)。
    async fn run_turns(
        &self,
        session_id: &str,
        project_id: Option<&str>,
        messages: &mut Vec<ChatMessage>,
        on_delta: &mut (dyn for<'a> FnMut(&'a str, bool) + Send),
        project_hint: &mut Option<String>,
    ) -> Result<(String, Vec<PlanCard>, Vec<String>, Vec<AgentRef>)> {
        let mut cards = Vec::new();
        let mut trace = Vec::new();
        let mut refs: Vec<AgentRef> = Vec::new();
        let mut calls = 0u32;
        loop {
            let request = ChatRequest {
                model: self.model.id().to_owned(),
                messages: messages.clone(),
                tools: self.runner.tools(),
                json_output: false,
                thinking: false,
                max_tokens: Some(2048),
                temperature: Some(0.2),
            };
            // 最后一段回答走流式:边生成边推给前端
            let response = self
                .gate
                .send_streaming(project_id, Purpose::Agent, &self.model, request, on_delta)
                .await?;
            let tool_calls = response.message.tool_calls.clone();
            let text = response.message.content.clone().unwrap_or_default();
            if tool_calls.is_empty() || calls >= MAX_TOOL_CALLS {
                // 模型什么都没返回(常见于模型名写错 / 网关不支持流式 / 空回复):
                // 给调用方一个能看懂的错,而不是一条空消息。
                if text.trim().is_empty() && cards.is_empty() {
                    return Err(KbError::Upstream(
                        "模型没有返回任何内容:检查模型名是否存在于该服务商、端点是否支持流式请求"
                            .to_owned(),
                    ));
                }
                return Ok((text, cards, trace, refs));
            }
            messages.push(ChatMessage {
                role: "assistant".to_owned(),
                content: Some(text),
                tool_calls: tool_calls.clone(),
                tool_call_id: None,
            });
            for call in tool_calls {
                calls += 1;
                trace.push(call.name.clone());
                if project_hint.is_none() {
                    *project_hint = project_hint_of(&call.arguments);
                }
                let mutating = self.runner.is_mutating(&call.name);
                if mutating {
                    // 有副作用:只拿计划,做成卡片等用户确认
                    let plan = self
                        .runner
                        .call(&call.name, call.arguments.clone(), true)
                        .await?;
                    collect_refs(&plan, &mut refs);
                    let card = PlanCard {
                        id: uuid::Uuid::now_v7().to_string(),
                        capability: call.name.clone(),
                        args: call.arguments.clone(),
                        args_hash: args_hash(&call.name, &call.arguments),
                        plan,
                    };
                    AgentRepo::append(
                        self.meta.as_ref(),
                        AgentMessage {
                            session_id: session_id.to_owned(),
                            seq: 0,
                            role: "plan".to_owned(),
                            content_json: json!({ "card": card }).to_string(),
                            at: now_millis(),
                        },
                    )
                    .await?;
                    cards.push(card);
                    messages.push(ChatMessage {
                        role: "tool".to_owned(),
                        content: Some(
                            json!({
                                "status": "awaiting_confirmation",
                                "note": "已生成计划卡片,等待用户确认后才会执行",
                            })
                            .to_string(),
                        ),
                        tool_calls: Vec::new(),
                        tool_call_id: Some(call.id),
                    });
                    continue;
                }
                let result = self
                    .runner
                    .call(&call.name, call.arguments.clone(), false)
                    .await?;
                collect_refs(&result, &mut refs);
                let result = self.redact_result(result).await?;
                messages.push(ChatMessage {
                    role: "tool".to_owned(),
                    content: Some(truncate_chars(&result.to_string(), MAX_TOOL_RESULT_CHARS)),
                    tool_calls: Vec::new(),
                    tool_call_id: Some(call.id),
                });
            }
        }
    }

    /// 需要时把较早的消息压成摘要(增量:在已有摘要后面追加新压掉的部分)。
    async fn compress_history(
        &self,
        session_id: &str,
        project_id: Option<&str>,
    ) -> Result<Option<String>> {
        let meta = AgentRepo::session_meta(self.meta.as_ref(), session_id).await?;
        let history = AgentRepo::list(self.meta.as_ref(), session_id, 500).await?;
        let candidates: Vec<&AgentMessage> = history
            .iter()
            .filter(|message| message.role != "plan" && message.seq > meta.summary_upto)
            .collect();
        if candidates.len() <= KEEP_RECENT_MESSAGES {
            return Ok(None);
        }
        let drop_count = candidates.len() - KEEP_RECENT_MESSAGES;
        let to_summarize = &candidates[..drop_count];
        let chars: usize = to_summarize
            .iter()
            .map(|message| message_text(message).chars().count())
            .sum();
        if to_summarize.len() < COMPRESS_MIN_MESSAGES && chars < COMPRESS_MIN_CHARS {
            return Ok(None);
        }
        let summary = self
            .summarize(project_id, &meta.summary, to_summarize)
            .await?;
        let upto = to_summarize.last().map(|message| message.seq).unwrap_or(0);
        AgentRepo::set_summary(self.meta.as_ref(), session_id, &summary, upto, now_millis())
            .await?;
        Ok(Some(summary))
    }

    /// 手动压缩:把除最后两条以外的消息都压掉(设置页 / 会话菜单用)。
    pub async fn compress(
        &self,
        session_id: &str,
        project_id: Option<&str>,
    ) -> Result<Option<String>> {
        let meta = AgentRepo::session_meta(self.meta.as_ref(), session_id).await?;
        let history = AgentRepo::list(self.meta.as_ref(), session_id, 500).await?;
        let mut candidates: Vec<&AgentMessage> = history
            .iter()
            .filter(|message| message.role != "plan" && message.seq > meta.summary_upto)
            .collect();
        if candidates.len() <= 2 {
            return Ok(None);
        }
        candidates.truncate(candidates.len() - 2);
        if candidates.is_empty() {
            return Ok(None);
        }
        let summary = self
            .summarize(project_id, &meta.summary, &candidates)
            .await?;
        let upto = candidates.last().map(|message| message.seq).unwrap_or(0);
        AgentRepo::set_summary(self.meta.as_ref(), session_id, &summary, upto, now_millis())
            .await?;
        Ok(Some(summary))
    }

    /// 调模型写摘要(失败不影响主流程,由调用方决定是否忽略)。
    async fn summarize(
        &self,
        project_id: Option<&str>,
        previous: &str,
        messages: &[&AgentMessage],
    ) -> Result<String> {
        let mut transcript = String::new();
        if !previous.trim().is_empty() {
            transcript.push_str("已有摘要:\n");
            transcript.push_str(previous.trim());
            transcript.push_str("\n\n新增对话:\n");
        }
        for message in messages {
            let who = match message.role.as_str() {
                "user" => "用户",
                "assistant" => "管家",
                _ => continue,
            };
            let text = message_text(message);
            if text.trim().is_empty() {
                continue;
            }
            transcript.push_str(who);
            transcript.push(':');
            transcript.push_str(&truncate_chars(text.trim(), 600));
            transcript.push('\n');
        }
        if transcript.trim().is_empty() {
            return Ok(previous.to_owned());
        }
        let request = ChatRequest {
            model: self.model.id().to_owned(),
            messages: vec![
                ChatMessage {
                    role: "system".to_owned(),
                    content: Some(COMPRESS_PROMPT.to_owned()),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "user".to_owned(),
                    content: Some(transcript),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                },
            ],
            tools: Vec::new(),
            json_output: false,
            thinking: false,
            max_tokens: Some(500),
            temperature: Some(0.2),
        };
        let response = self
            .gate
            .send(project_id, Purpose::Agent, &self.model, request)
            .await?;
        let summary = response.message.content.unwrap_or_default();
        let summary = summary.trim();
        if summary.is_empty() {
            return Ok(previous.to_owned());
        }
        // 摘要太长只留最后一段,避免它自己变成新的上下文炸弹
        Ok(truncate_tail(summary, MAX_SUMMARY_CHARS))
    }

    /// 确认并执行一张卡片(校验参数哈希)。
    pub async fn confirm(
        &self,
        session_id: &str,
        card_id: &str,
        args_hash_expected: &str,
    ) -> Result<ConfirmResult> {
        let history = AgentRepo::list(self.meta.as_ref(), session_id, 500).await?;
        let mut found: Option<PlanCard> = None;
        for message in &history {
            if message.role != "plan" {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&message.content_json) else {
                continue;
            };
            if let Ok(card) = serde_json::from_value::<PlanCard>(
                value.get("card").cloned().unwrap_or(Value::Null),
            ) && card.id == card_id
            {
                found = Some(card);
            }
        }
        let card = found.ok_or_else(|| KbError::NotFound(format!("计划卡片 {card_id}")))?;
        // 防篡改:参数哈希必须与生成卡片时一致
        if args_hash(&card.capability, &card.args) != args_hash_expected
            || args_hash_expected != card.args_hash
        {
            return Err(KbError::InvalidInput(
                "参数与计划卡片不一致,拒绝执行".to_owned(),
            ));
        }
        let result = self
            .runner
            .call(&card.capability, card.args.clone(), false)
            .await?;
        let batch_id = result
            .get("meta")
            .and_then(|meta| meta.get("batch_id"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .or_else(|| {
                result
                    .get("batch_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            });
        AgentRepo::append(
            self.meta.as_ref(),
            AgentMessage {
                session_id: session_id.to_owned(),
                seq: 0,
                role: "tool".to_owned(),
                content_json: json!({
                    "text": format!("已执行 {}", card.capability),
                    "card_id": card.id,
                    "result": result,
                })
                .to_string(),
                at: now_millis(),
            },
        )
        .await?;
        Ok(ConfirmResult { result, batch_id })
    }

    /// 会话记录。
    pub async fn history(&self, session_id: &str) -> Result<Vec<AgentMessage>> {
        AgentRepo::list(self.meta.as_ref(), session_id, 200).await
    }

    /// 工具结果脱敏:未授权项目的正文不外发,只留标题 / 路径。
    async fn redact_result(&self, value: Value) -> Result<Value> {
        let Some(hits) = value.get("hits").and_then(Value::as_array) else {
            return Ok(value);
        };
        let mut collections: Vec<String> = hits
            .iter()
            .filter_map(|hit| hit.get("collection").and_then(Value::as_str))
            .map(str::to_owned)
            .collect();
        collections.sort();
        collections.dedup();
        if collections.is_empty() || self.runner.allows_llm(&collections).await? {
            return Ok(value);
        }
        let redacted: Vec<Value> = hits
            .iter()
            .map(|hit| {
                json!({
                    "id": hit.get("id"),
                    "source": hit.get("source"),
                    "title": hit.get("title"),
                    "snippet": "(正文未外发:该项目的 allow_cloud_llm=false)",
                })
            })
            .collect();
        let mut value = value;
        value["hits"] = Value::Array(redacted);
        Ok(value)
    }
}

/// 参数哈希:能力名 + 规范化后的参数 JSON。
pub fn args_hash(capability: &str, args: &Value) -> String {
    let canonical = canonical_json(args);
    kb_core::hash::xxh3_hex(format!("{capability}\n{canonical}").as_bytes())
}

/// 规范化 JSON(对象键排序,便于稳定哈希)。
fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            let mut out = String::from("{");
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_default());
                out.push(':');
                out.push_str(&canonical_json(&map[*key]));
            }
            out.push('}');
            out
        }
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().map(canonical_json).collect();
            format!("[{}]", parts.join(","))
        }
        other => other.to_string(),
    }
}

/// 从工具结果里收集可点击的引用(条目 / 项目 / 批次 / 任务)。
///
/// 结果形状由各能力决定,这里按“常见字段”递归扫一遍:
/// - 条目:`{id, collection, source?, title?}`(search / get_item / list_items);
/// - 项目:`{project: {name, slug}, collection}`(list_projects);
/// - 批次 / 任务:`batch_id` / `job_id`。
///
/// 去重后最多留 12 条,避免一次检索把聊天撑爆。
fn collect_refs(value: &Value, out: &mut Vec<AgentRef>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_refs(item, out);
            }
        }
        Value::Object(map) => {
            if let Some(project) = map.get("project").and_then(Value::as_object) {
                let name = project
                    .get("name")
                    .and_then(Value::as_str)
                    .or_else(|| project.get("slug").and_then(Value::as_str));
                if let Some(name) = name {
                    push_ref(
                        out,
                        AgentRef {
                            kind: "project".to_owned(),
                            id: project
                                .get("slug")
                                .and_then(Value::as_str)
                                .unwrap_or(name)
                                .to_owned(),
                            label: name.to_owned(),
                            collection: map
                                .get("collection")
                                .and_then(Value::as_str)
                                .map(str::to_owned),
                            source: None,
                        },
                    );
                }
            }
            // 任务对象也有 id + collection(还有 state),别把它当成条目
            let is_job = map.get("state").and_then(Value::as_str).is_some();
            if is_job {
                if let Some(id) = map.get("id").and_then(Value::as_str) {
                    push_ref(
                        out,
                        AgentRef {
                            kind: "job".to_owned(),
                            id: id.to_owned(),
                            label: "任务".to_owned(),
                            collection: None,
                            source: None,
                        },
                    );
                }
            } else if let (Some(id), Some(collection)) = (
                map.get("id").and_then(Value::as_str),
                map.get("collection").and_then(Value::as_str),
            ) {
                // 条目:有 source,或 kind 是记录种类(避免把其它 id+collection 的东西当成条目)
                let kind = map.get("kind").and_then(Value::as_str).unwrap_or_default();
                let record_kind =
                    matches!(kind, "code" | "doc" | "insight" | "external" | "summary");
                let source = map
                    .get("source")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !source.is_empty() || record_kind {
                    let label = map
                        .get("title")
                        .and_then(Value::as_str)
                        .filter(|title| !title.is_empty())
                        .unwrap_or(source);
                    push_ref(
                        out,
                        AgentRef {
                            kind: "item".to_owned(),
                            id: id.to_owned(),
                            label: label.to_owned(),
                            collection: Some(collection.to_owned()),
                            source: (!source.is_empty()).then(|| source.to_owned()),
                        },
                    );
                }
            }
            // collection 列表(name + rows)→ 浏览器切到该集合
            if let (Some(name), Some(_rows)) = (
                map.get("name").and_then(Value::as_str),
                map.get("rows").and_then(Value::as_u64),
            ) && (name.starts_with("proj_") || name == "_global")
            {
                push_ref(
                    out,
                    AgentRef {
                        kind: "collection".to_owned(),
                        id: name.to_owned(),
                        label: name.to_owned(),
                        collection: Some(name.to_owned()),
                        source: None,
                    },
                );
            }
            if let Some(batch) = map.get("batch_id").and_then(Value::as_str) {
                push_ref(
                    out,
                    AgentRef {
                        kind: "batch".to_owned(),
                        id: batch.to_owned(),
                        label: "批次".to_owned(),
                        collection: None,
                        source: None,
                    },
                );
            }
            if let Some(job) = map.get("job_id").and_then(Value::as_str) {
                push_ref(
                    out,
                    AgentRef {
                        kind: "job".to_owned(),
                        id: job.to_owned(),
                        label: "任务".to_owned(),
                        collection: None,
                        source: None,
                    },
                );
            }
            for value in map.values() {
                collect_refs(value, out);
            }
        }
        _ => {}
    }
}

fn push_ref(out: &mut Vec<AgentRef>, candidate: AgentRef) {
    if candidate.id.is_empty() || out.len() >= 12 {
        return;
    }
    if out
        .iter()
        .any(|existing| existing.kind == candidate.kind && existing.id == candidate.id)
    {
        return;
    }
    out.push(candidate);
}

/// 拼出这一轮要发给模型的消息:系统提示 + 摘要 + 未压缩的历史 + 当前用户消息。
fn context_messages(
    history: &[AgentMessage],
    meta: &kb_core::model::AgentSessionMeta,
    text: &str,
) -> Vec<ChatMessage> {
    let mut messages = vec![ChatMessage {
        role: "system".to_owned(),
        content: Some(AGENT_PROMPT.to_owned()),
        tool_calls: Vec::new(),
        tool_call_id: None,
    }];
    if !meta.summary.trim().is_empty() {
        messages.push(ChatMessage {
            role: "system".to_owned(),
            content: Some(format!(
                "此前对话的摘要(较早的内容已压缩,细节可让用户再确认):\n{}",
                meta.summary
            )),
            tool_calls: Vec::new(),
            tool_call_id: None,
        });
    }
    for message in history {
        if message.seq <= meta.summary_upto || message.role == "plan" {
            // 计划卡片不进模型上下文(确认后才执行)
            continue;
        }
        let parsed: Value = serde_json::from_str(&message.content_json).unwrap_or(Value::Null);
        messages.push(ChatMessage {
            role: message.role.clone(),
            content: parsed
                .get("text")
                .and_then(Value::as_str)
                .map(str::to_owned),
            tool_calls: Vec::new(),
            tool_call_id: None,
        });
    }
    messages.push(ChatMessage {
        role: "user".to_owned(),
        content: Some(text.to_owned()),
        tool_calls: Vec::new(),
        tool_call_id: None,
    });
    messages
}

/// 一条消息的正文。
fn message_text(message: &AgentMessage) -> String {
    serde_json::from_str::<Value>(&message.content_json)
        .ok()
        .and_then(|value| value.get("text").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default()
}

/// 截断到 `max` 个字符,加省略号。
fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push_str("\n…(已截断)");
    out
}

/// 只留最后 `max` 个字符。
fn truncate_tail(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_owned();
    }
    chars[chars.len() - max..].iter().collect()
}

/// 从工具参数里猜会话属于哪个项目(`project` 或 `proj_xxx` 形式的 collection)。
fn project_hint_of(args: &Value) -> Option<String> {
    if let Some(project) = args
        .get("project")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return Some(project.to_owned());
    }
    args.get("collection")
        .and_then(Value::as_str)
        .and_then(|collection| collection.strip_prefix("proj_"))
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn now_millis() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn args_hash_is_stable_across_key_order() {
        let a = json!({ "collection": "proj_x", "dry_run": true });
        let b = json!({ "dry_run": true, "collection": "proj_x" });
        assert_eq!(
            args_hash("dedup_insights", &a),
            args_hash("dedup_insights", &b)
        );
    }

    #[test]
    fn args_hash_changes_with_capability_or_args() {
        let args = json!({ "collection": "proj_x" });
        assert_ne!(args_hash("a", &args), args_hash("b", &args));
        assert_ne!(
            args_hash("a", &args),
            args_hash("a", &json!({ "collection": "proj_y" }))
        );
    }

    #[test]
    fn prompt_tells_the_model_about_cards() {
        assert!(AGENT_PROMPT.contains("计划卡片"));
        assert_eq!(MAX_TOOL_CALLS, 8);
    }
}
