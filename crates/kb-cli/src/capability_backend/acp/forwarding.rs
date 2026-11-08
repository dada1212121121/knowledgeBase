//! 会话消息往浏览器推的那条转发链:OwnerHub、转发任务、@ 提及解析、上下文种子。

use crate::capability_backend::*;

struct OwnerHub {
    hub: Arc<kb_web::EventHub>,
    owner: String,
}

impl OwnerHub {
    pub(crate) fn publish(&self, kind: &str, data: Value) {
        if self.owner == "local" {
            self.hub.publish(kind, data);
        } else {
            self.hub.publish_to_user(&self.owner, kind, data);
        }
    }
}

/// 把代理的增量转发到 WS,并累积正文 / 工具标题。
#[allow(clippy::too_many_arguments)]
pub(crate) fn spawn_acp_forwarder(
    mut events: tokio::sync::mpsc::Receiver<kb_acp::AcpEvent>,
    session: String,
    hub: Option<Arc<kb_web::EventHub>>,
    text: Arc<tokio::sync::Mutex<String>>,
    trace: Arc<tokio::sync::Mutex<Vec<String>>>,
    pending: Arc<tokio::sync::Mutex<std::collections::HashMap<String, Vec<String>>>>,
    turn_slot: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    owner: String,
) {
    // 转发任务是 `tokio::spawn` 出来的,不继承能力调用的任务局部路由,直接 `publish` 的事件就没有知识库标签,
    // 只有管理员看得到:普通用户收不到自己代理的回复,管理员却能看到所有人的。所以按属主点名推送。
    let hub = hub.map(|hub| OwnerHub { hub, owner });
    tokio::spawn(async move {
        while let Some(event) = events.recv().await {
            match event {
                kb_acp::AcpEvent::Update { update, .. } => {
                    if let Some(("text", chunk)) = kb_acp::text_of(&update) {
                        text.lock().await.push_str(&chunk);
                        if let Some(hub) = &hub {
                            hub.publish(
                                "acp.update",
                                json!({ "session_id": session, "kind": "text", "text": chunk }),
                            );
                        }
                        continue;
                    }
                    if let Some(("thought", chunk)) = kb_acp::text_of(&update) {
                        if let Some(hub) = &hub {
                            hub.publish(
                                "acp.update",
                                json!({ "session_id": session, "kind": "thought", "text": chunk }),
                            );
                        }
                        continue;
                    }
                    let value = serde_json::to_value(&update).unwrap_or(Value::Null);
                    if let Some(title) = value.get("title").and_then(Value::as_str) {
                        trace.lock().await.push(title.to_owned());
                        if let Some(hub) = &hub {
                            hub.publish(
                                "acp.update",
                                json!({ "session_id": session, "kind": "tool", "title": title }),
                            );
                        }
                        continue;
                    }
                    if let Some(hub) = &hub {
                        hub.publish(
                            "acp.update",
                            json!({ "session_id": session, "kind": "update", "update": value }),
                        );
                    }
                }
                kb_acp::AcpEvent::PermissionRequest {
                    request_id,
                    tool,
                    options,
                    ..
                } => {
                    pending
                        .lock()
                        .await
                        .entry(session.clone())
                        .or_default()
                        .push(request_id.clone());
                    if let Some(hub) = &hub {
                        hub.publish(
                            "acp.update",
                            json!({
                            "session_id": session,
                            "kind": "permission_request",
                            "request_id": request_id,
                            "tool": tool,
                            "options": options.iter().map(|choice| json!({
                            "id": choice.id,
                            "name": choice.name,
                            "kind": choice.kind,
                            })).collect::<Vec<_>>(),
                            }),
                        );
                    }
                }
                kb_acp::AcpEvent::Permission {
                    tool,
                    allowed,
                    reason,
                    ..
                } => {
                    pending.lock().await.remove(&session);
                    if let Some(hub) = &hub {
                        hub.publish(
                            "acp.update",
                            json!({
                            "session_id": session,
                            "kind": "permission",
                            "tool": tool,
                            "allowed": allowed,
                            "reason": reason,
                            }),
                        );
                    }
                }
                kb_acp::AcpEvent::TurnFinished { .. } => {
                    if let Some(sender) = turn_slot.lock().await.take() {
                        let _ = sender.send(());
                    }
                }
            }
        }
    });
}

/// 提示词里 `kb://session/<id>` 引用的会话(给 `@会话` 用)。
pub(crate) fn mentioned_session_ids(text: &str) -> Vec<String> {
    let marker = "kb://session/";
    let mut rest = text;
    let mut out = Vec::new();
    while let Some(index) = rest.find(marker) {
        let tail = &rest[index + marker.len()..];
        let end = tail
            .find(|ch: char| ch == ')' || ch.is_whitespace())
            .unwrap_or(tail.len());
        let id = &tail[..end];
        if !id.is_empty() && !out.iter().any(|existing| existing == id) {
            out.push(id.to_owned());
        }
        rest = &tail[end..];
    }
    out
}

/// 新起的代理没有上下文:把最近几条对话压成一段提示。
pub(crate) fn acp_context_seed(history: &[kb_core::model::AgentMessage]) -> String {
    let mut lines = Vec::new();
    for message in history.iter().rev().take(6).rev() {
        if message.role == "plan" {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&message.content_json) else {
            continue;
        };
        let Some(text) = value.get("text").and_then(Value::as_str) else {
            continue;
        };
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let clipped: String = text.chars().take(300).collect();
        let who = if message.role == "user" {
            "用户"
        } else {
            "管家"
        };
        lines.push(format!("{who}:{clipped}"));
    }
    if lines.is_empty() {
        String::new()
    } else {
        format!("(以下是之前的对话,供你了解上下文)\n{}", lines.join("\n"))
    }
}

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(crate) async fn acp_chat_impl(&self, args: AcpChatArgs) -> Result<Value> {
        let settings = kb_service::acp_registry::load(&self.acp_settings_path());
        let def = kb_service::acp_registry::find(&settings, &args.agent)
            .ok_or_else(|| KbError::NotFound(format!("ACP 代理 {}", args.agent)))?;
        let policy = kb_acp::PermissionPolicy::parse(&settings.permission);
        let session = args
            .session_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let at = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or_default()
        };

        let meta = AgentRepo::session_meta(self.rt().meta.as_ref(), &session).await?;
        let project = args
            .project
            .clone()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| {
                if meta.project.is_empty() {
                    None
                } else {
                    Some(meta.project.clone())
                }
            });
        // 按会话加锁,只包住“查找 / 拉起”,不把其它会话的对话堵住
        let session_lock = self.session_lock(&session).await;
        let _session_guard = session_lock.lock().await;
        // 会话 id 已经被别人的代理占着:当成不存在,不能接上,也不能覆盖
        if self.acp_session_taken_by_other(&session).await {
            return Err(KbError::NotFound(format!("会话 {session}")));
        }
        let cached = self.owned_acp(&session).await;
        let entry = match cached {
            Some(entry) => entry,
            None => {
                let owner = self.acp_owner();
                let restricted = self.acp_restricted();
                self.acquire_acp_slot(&owner, &session, &settings).await?;
                let created = self
                    .create_acp_entry(
                        &def,
                        policy,
                        &args,
                        &meta,
                        project.as_deref(),
                        &session,
                        &settings,
                        &owner,
                    )
                    .await;
                self.acp_slots.lock().await.remove(&session);
                let _ = restricted;
                created?
            }
        };
        if self.acp_restricted() {
            // 工作目录不能无限涨:超过上限就不再开始新的一轮,提示用户清理
            self.ensure_workspace_room(&settings).await?;
        }
        let _prompt_guard = entry.prompt_lock.lock().await;
        drop(_session_guard);
        if let Ok(mut at_used) = entry.last_used.lock() {
            *at_used = std::time::Instant::now();
        }

        // 落用户消息 + 会话元数据(历史里存展示文本;发给代理的可能是提示词)
        let display = args
            .display_text
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| args.text.clone());
        AgentRepo::append(
            self.rt().meta.as_ref(),
            AgentMessage {
                session_id: session.clone(),
                seq: 0,
                role: "user".to_owned(),
                content_json: json!({ "text": display }).to_string(),
                at: at(),
            },
        )
        .await?;
        AgentRepo::touch_session(
            self.rt().meta.as_ref(),
            &session,
            args.project.as_deref(),
            at(),
        )
        .await?;

        // 新起的代理没有上下文:把最近几条对话压成一段提示带上
        let mut prompt = args.text.clone();
        if !entry.resumed
            && let Ok(mut history) = AgentRepo::list(self.rt().meta.as_ref(), &session, 10).await
        {
            // 刚写入的当前用户消息不算“历史”,别把这一轮的问题再当上下文喂一遍
            if history.last().is_some_and(|message| message.role == "user") {
                history.pop();
            }
            let seed = acp_context_seed(&history);
            if !seed.is_empty() {
                prompt = format!("{seed}\n\n用户:{prompt}");
            }
        }

        // 只认用户这一轮的原文。上下文种子里有助手回复,不能从那里授权。
        let mentioned = mentioned_session_ids(&args.text);
        if !mentioned.is_empty() {
            let mut allow = self.history_allow.lock().await;
            let ids = allow.entry(session.clone()).or_default();
            for id in mentioned {
                if !ids.iter().any(|existing| existing == &id) {
                    ids.push(id);
                }
            }
        }
        let (turn_tx, turn_rx) = tokio::sync::oneshot::channel();
        *entry.turn_slot.lock().await = Some(turn_tx);
        let timeout = std::time::Duration::from_secs(settings.turn_timeout_secs.max(1));
        let outcome = entry
            .client
            .prompt_timeout(&entry.acp_session, &prompt, timeout)
            .await;
        // 结束标记到了就收尾;没到也最多再等半秒,避免代理输出慢时被截断
        if outcome.is_ok() {
            let _ = tokio::time::timeout(std::time::Duration::from_millis(500), turn_rx).await;
        }
        let (text, trace) = {
            let mut buffer = entry.text.lock().await;
            let text = buffer.clone();
            buffer.clear();
            let trace = entry.trace.lock().await.clone();
            (text, trace)
        };
        match outcome {
            Ok(outcome) => {
                AgentRepo::append(
                    self.rt().meta.as_ref(),
                    AgentMessage {
                        session_id: session.clone(),
                        seq: 0,
                        role: "assistant".to_owned(),
                        content_json: json!({
                        "text": text,
                        "trace": trace,
                        "acp_agent": def.id,
                        })
                        .to_string(),
                        at: at(),
                    },
                )
                .await?;
                if let Some(hub) = &self.hub {
                    hub.publish(
                        "acp.update",
                        json!({ "session_id": session, "kind": "done" }),
                    );
                }
                Ok(json!({
                "session_id": session,
                "text": text,
                "trace": trace,
                "stop_reason": outcome.stop_reason,
                "backend": "acp",
                "agent": def.id,
                "sandboxed": entry.sandboxed,
                }))
            }
            Err(err) => {
                let _ = AgentRepo::append(
                    self.rt().meta.as_ref(),
                    AgentMessage {
                        session_id: session.clone(),
                        seq: 0,
                        role: "assistant".to_owned(),
                        content_json: json!({ "text": text, "error": err.to_string() }).to_string(),
                        at: at(),
                    },
                )
                .await;
                // 坏连接不要留着
                self.shutdown_acp_session(&session).await;
                Err(err)
            }
        }
    }

    pub(crate) async fn acp_cancel_impl(&self, args: AcpCancelArgs) -> Result<Value> {
        let entry = self.owned_acp(&args.session_id).await.ok_or_else(|| {
            KbError::NotFound(format!("会话 {} 没有正在运行的代理", args.session_id))
        })?;
        entry.client.cancel(&entry.acp_session).await?;
        Ok(json!({ "cancelled": true, "session_id": args.session_id }))
    }
}
