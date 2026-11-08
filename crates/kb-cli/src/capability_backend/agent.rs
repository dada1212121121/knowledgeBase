//! 助手:会话与上下文预算、工具调用器、技能与插件的读写与开关。

use crate::capability_backend::*;

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn agent_sessions_impl(&self, args: AgentSessionsArgs) -> Result<Value> {
        let sessions = AgentRepo::sessions(
            self.rt().meta.as_ref(),
            args.limit.unwrap_or(50),
            args.project
                .as_deref()
                .filter(|value| !value.trim().is_empty()),
        )
        .await?;
        Ok(json!({ "sessions": sessions }))
    }

    pub(super) async fn agent_compress_impl(&self, args: AgentCompressArgs) -> Result<Value> {
        let agent = self.agent_service().await?;
        let summary = agent.compress(&args.session_id, None).await?;
        Ok(json!({
            "compressed": summary.is_some(),
            "summary": summary.unwrap_or_default(),
        }))
    }

    pub(super) async fn agent_rename_session_impl(
        &self,
        args: AgentRenameSessionArgs,
    ) -> Result<Value> {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default();
        let renamed =
            AgentRepo::rename_session(self.rt().meta.as_ref(), &args.session_id, &args.title, at)
                .await?;
        if !renamed {
            return Err(KbError::NotFound(format!("会话 {}", args.session_id)));
        }
        Ok(json!({ "session_id": args.session_id, "title": args.title }))
    }

    pub(super) async fn context_estimate_impl(&self, args: ContextEstimateArgs) -> Result<Value> {
        let service = self.context_service().await?;
        let estimate = service.estimate(&args.collection).await?;
        Ok(serde_json::to_value(estimate)
            .map_err(|err| KbError::Internal(format!("序列化估算失败: {err}")))?)
    }

    pub(super) async fn apply_context_impl(&self, args: ApplyContextArgs) -> Result<Value> {
        let mode = match args.context_mode.trim() {
            "header" => kb_core::model::ContextMode::Header,
            "llm" => kb_core::model::ContextMode::Llm,
            other => {
                return Err(KbError::InvalidInput(format!(
                    "context_mode 只能是 header 或 llm,收到 {other}"
                )));
            }
        };
        let service = self.context_service().await?;
        let estimate = service.estimate(&args.collection).await?;
        if args.dry_run {
            return Ok(json!({
                "dry_run": true,
                "estimate": estimate,
                "context_mode": mode.as_str(),
            }));
        }
        let mut record =
            kb_core::ports::repo::CollectionRepo::get(self.rt().meta.as_ref(), &args.collection)
                .await?
                .ok_or_else(|| KbError::NotFound(format!("collection {}", args.collection)))?;
        let project = match record.project_id.clone() {
            Some(id) => kb_core::ports::repo::ProjectRepo::get(self.rt().meta.as_ref(), &id)
                .await?
                .ok_or_else(|| KbError::NotFound(format!("project {id}")))?,
            None => {
                return Err(KbError::Forbidden(
                    "这个 collection 没有所属项目,不能外发".to_owned(),
                ));
            }
        };
        if mode == kb_core::model::ContextMode::Llm && !project.allow_cloud_llm {
            return Err(KbError::Forbidden(
                "该项目的 allow_cloud_llm=false,拒绝外发".to_owned(),
            ));
        }
        record.context_mode = mode;
        kb_core::ports::repo::CollectionRepo::update(self.rt().meta.as_ref(), record).await?;
        const APPLY_LIMIT: usize = 64;
        let applied = if mode == kb_core::model::ContextMode::Llm {
            service
                .apply(&args.collection, Some(&project.id), APPLY_LIMIT)
                .await?
        } else {
            kb_service::context::ContextApplyResult {
                collection: args.collection.clone(),
                ..kb_service::context::ContextApplyResult::default()
            }
        };
        let job_id = self
            .insight()
            .reindex(kb_service::insight::ReindexRequest {
                project: project.name.clone(),
                mode: Some("full".to_owned()),
                paths: Vec::new(),
                phase: None,
                stop_after_text: false,
            })
            .await?;
        Ok(json!({
            "dry_run": false,
            "estimate": estimate,
            "applied": applied,
            "applied_limit": APPLY_LIMIT,
            "note": "每次最多新生成 64 块上下文;已经缓存的不占名额,下次调用会继续后面还没生成的块",
            "context_mode": mode.as_str(),
            "job_id": job_id,
        }))
    }

    pub(super) async fn agent_pin_session_impl(&self, args: AgentPinSessionArgs) -> Result<Value> {
        let at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default();
        let pinned =
            AgentRepo::pin_session(self.rt().meta.as_ref(), &args.session_id, args.pinned, at)
                .await?;
        if !pinned {
            return Err(KbError::NotFound(format!("会话 {}", args.session_id)));
        }
        Ok(json!({ "session_id": args.session_id, "pinned": args.pinned }))
    }

    pub(super) async fn agent_delete_session_impl(
        &self,
        args: AgentDeleteSessionArgs,
    ) -> Result<Value> {
        // 先确认会话是自己的:别人会话 id 在缓存里时不能替他把代理关掉
        if self.acp_session_taken_by_other(&args.session_id).await {
            return Err(KbError::NotFound(format!("会话 {}", args.session_id)));
        }
        self.shutdown_acp_session(&args.session_id).await;
        let deleted = AgentRepo::delete_session(self.rt().meta.as_ref(), &args.session_id).await?;
        if deleted == 0 {
            return Err(KbError::NotFound(format!("会话 {}", args.session_id)));
        }
        Ok(json!({ "deleted": deleted }))
    }

    pub(super) async fn agent_send_impl(&self, args: AgentSendArgs) -> Result<Value> {
        let session = args
            .session_id
            .clone()
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string());
        let agent = self.agent_service().await?;
        // 流式:正文增量通过 WS `agent.delta` 推给页面
        let hub = self.hub.clone();
        let session_for_delta = session.clone();
        let mut on_delta = move |text: &str, final_chunk: bool| {
            if let Some(hub) = &hub {
                hub.publish(
                    "agent.delta",
                    json!({
                        "session_id": session_for_delta,
                        "text": text,
                        "done": final_chunk,
                    }),
                );
            }
        };
        let reply = agent
            .send_with(&session, args.project.as_deref(), &args.text, &mut on_delta)
            .await?;
        Ok(json!({
            "session_id": session,
            "text": reply.text,
            "cards": reply.cards,
            "trace": reply.trace,
            "refs": reply.refs,
        }))
    }

    pub(super) async fn ai_write_impl(&self, args: AiWriteArgs) -> Result<Value> {
        let request = kb_service::write_assist::WriteRequest::new(
            &args.action,
            &args.text,
            args.context.as_deref(),
            args.instruction.as_deref(),
            args.target_lang.as_deref(),
        )?;
        // 用 AI 助手同一个模型。没配密钥时不退回 mock:mock 的固定回答会被当成「改写结果」替换掉用户选中的文字
        let config = self.rt().config();
        let Some(model) =
            configured_chat_model(&self.rt().paths, &config, &config.llm.agent_model)?
        else {
            return Err(KbError::Unavailable(
                "还没有配置大模型的访问密钥,管理员在「系统设置 → 模型」里填好之后才能用 AI 写作"
                    .to_owned(),
            ));
        };
        let text = kb_service::write_assist::run(&self.llm_gate(), &model, &request).await?;
        Ok(json!({ "text": text }))
    }

    pub(super) async fn agent_confirm_impl(&self, args: AgentConfirmArgs) -> Result<Value> {
        let agent = self.agent_service().await?;
        let result = agent
            .confirm(&args.session_id, &args.card_id, &args.args_hash)
            .await?;
        Ok(serde_json::to_value(result)
            .map_err(|err| KbError::Internal(format!("序列化确认结果失败: {err}")))?)
    }

    pub(super) async fn agent_history_impl(
        &self,
        ctx: &CallCtx,
        args: AgentHistoryArgs,
    ) -> Result<Value> {
        if let Some(own) = ctx.actor.strip_prefix("agent:")
            && own != args.session_id
        {
            let allowed = self
                .history_allow
                .lock()
                .await
                .get(own)
                .is_some_and(|ids| ids.iter().any(|id| id == &args.session_id));
            if !allowed {
                return Err(KbError::Forbidden(
                    "代理只能读自己这场会话,以及本轮 @ 引用过的会话".to_owned(),
                ));
            }
        }
        let agent = self.agent_service().await?;
        let meta = AgentRepo::session_meta(self.rt().meta.as_ref(), &args.session_id).await?;
        let mut messages = agent.history(&args.session_id).await?;
        if ctx.surface == kb_capability::Surface::Mcp {
            let project = if meta.project.is_empty() {
                None
            } else {
                kb_core::ports::repo::ProjectRepo::get_by_name(
                    self.rt().meta.as_ref(),
                    &meta.project,
                )
                .await?
            };
            let allowed = project
                .as_ref()
                .is_some_and(|project| project.allow_cloud_llm);
            if !allowed {
                for message in &mut messages {
                    message.content_json =
                        json!({ "text": "(正文未外发:该项目的 allow_cloud_llm=false)" })
                            .to_string();
                }
            }
        }
        Ok(json!({
            "messages": messages,
            "summary": meta.summary,
            "summary_upto": meta.summary_upto,
            "backend": meta.backend,
            "acp_agent": meta.acp_agent,
            "sandboxed": meta.sandboxed,
        }))
    }
}

/// 会话记录允许落在哪些目录:`[evolution] session_roots`。
///
/// 守护进程与 AI 客户端的 `HOME` 可能不同(本机生产:守护进程 `HOME=/root`,
/// 真实会话在 `/home/user/.codeg/.kiro`),所以不能只靠自己的环境变量去猜 ——
/// 默认值仍是 `~/.claude` / `~/.kiro`,部署时按实际位置显式配置。
pub(crate) fn session_roots(config: &kb_core::config::Config) -> Vec<std::path::PathBuf> {
    session_roots_in(
        config,
        std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .as_deref(),
    )
}

/// 同 [`session_roots`],但 `HOME` 可注入(测试用;`set_var` 在 edition 2024 是 unsafe)。
fn session_roots_in(
    config: &kb_core::config::Config,
    home: Option<&std::path::Path>,
) -> Vec<std::path::PathBuf> {
    let roots: Vec<std::path::PathBuf> = config
        .evolution
        .session_roots
        .iter()
        .filter_map(|root| {
            let trimmed = root.trim();
            if trimmed == "~" {
                return Some(home?.to_path_buf());
            }
            match trimmed.strip_prefix("~/") {
                Some(rest) => Some(home?.join(rest)),
                None => Some(std::path::PathBuf::from(trimmed)),
            }
        })
        .collect();
    // 配错的根(目录不存在)会让会话静默跳过:同一路径只提示一次(进程内去重),
    // 默认根(`~/.claude` / `~/.kiro`)本来就可能只装了一个,降级为 debug。
    let defaults = default_session_roots(home);
    for root in &roots {
        if root.is_dir() {
            continue;
        }
        // 同一路径只告警一次(进程内去重)
        let first_time = warned_roots()
            .lock()
            .map(|mut warned| warned.insert(root.clone()))
            .unwrap_or(false);
        if !first_time {
            continue;
        }
        if defaults.contains(root) {
            tracing::debug!(root = %root.display(), "默认的会话记录目录不存在,已跳过");
        } else {
            tracing::warn!(
                root = %root.display(),
                "evolution.session_roots 里的目录不存在,这个目录下的会话不会被提炼"
            );
        }
    }
    roots
}

/// 默认根(`~/.claude` / `~/.kiro`),用来区分“用户显式配错”与“这台机器没装那个客户端”。
fn default_session_roots(home: Option<&std::path::Path>) -> Vec<std::path::PathBuf> {
    home.map(|home| vec![home.join(".claude"), home.join(".kiro")])
        .unwrap_or_default()
}

/// 已经告警过的根(进程内去重,避免每个事件刷一行)。
fn warned_roots() -> &'static std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>> {
    static WARNED: std::sync::OnceLock<
        std::sync::Mutex<std::collections::HashSet<std::path::PathBuf>>,
    > = std::sync::OnceLock::new();
    WARNED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

impl ServiceBackend {
    /// AI 管家服务(工具执行走能力注册表)。
    /// AI 管家专属对话模型:有 key 连大模型,无 key 回复友好助手向导,不返回内部 json
    async fn agent_chat_model(&self) -> Result<Arc<dyn kb_core::ports::ChatModel>> {
        let api_key = crate::runtime::llm_api_key(&self.rt().paths).or_else(|| {
            let provider = self.rt().config().llm.provider.clone();
            kb_service::llm_providers::env_var_of(&provider)
                .and_then(|key| std::env::var(key).ok())
                .filter(|value| !value.trim().is_empty())
        });
        let api_key =
            api_key.or_else(|| (self.rt().config().llm.provider == "ollama").then(String::new));
        if api_key.is_some() {
            let model = self.rt().config().llm.agent_model.clone();
            return self.chat_model_for(&model).await;
        } else {
            Ok(Arc::new(kb_llm::MockChatModel::reply(
                "您好！我是您的知识库 AI 管家。我可以协助您检索项目知识、阅读文档代码、梳理开发经验。

当前系统运行于本地离线模式（尚未配置云端大模型 API 密钥）。
• 如需解锁深度多轮推理与大模型智能解答，您可以在「设置 → LLM 提供商」中配置 DeepSeek / OpenAI API Key，或在本地启动 Ollama。
• 在此期间，您可以随时使用顶部的「全局检索 ⌘K」或左侧「浏览器」工作台浏览并管理全部本地知识库！"
            )))
        }
    }

    /// 上下文增强。
    async fn context_service(&self) -> Result<kb_service::context::ContextService> {
        Ok(kb_service::context::ContextService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.llm_gate(),
            self.chat_model().await?,
        ))
    }

    /// AI 管家服务(工具执行走能力注册表)。
    async fn agent_service(&self) -> Result<kb_service::agent::AgentService> {
        let invoker = self
            .invoker
            .get()
            .cloned()
            .ok_or_else(|| KbError::Internal("AI 管家没有接上能力调用器".to_owned()))?;
        let runner = Arc::new(CapabilityToolRunner {
            principal: kb_capability::current_principal(),
            invoker,
            meta: self.rt().meta.clone(),
        });
        Ok(kb_service::agent::AgentService::new(
            self.rt().meta.clone(),
            self.llm_gate(),
            self.agent_chat_model().await?,
            runner,
        ))
    }

    /// 外发闸门(每次构造都很轻)。
    ///
    /// 在某个登录用户的能力调用里,账记在**他**名下;本机超级用户和守护进程自己的后台任务
    /// 没有「人」可记,只受 `[llm]` 的全站预算约束。
    pub(crate) fn llm_gate(&self) -> kb_service::llm_gate::LlmGate {
        let config = gate_config(&self.rt().config());
        let gate = kb_service::llm_gate::LlmGate::new(self.rt().meta.clone(), config);
        match (&self.llm_ledger, kb_capability::current_principal()) {
            (Some(ledger), Some(principal)) if !principal.local => {
                gate.with_user_budget(ledger.clone(), principal.user_id)
            }
            _ => gate,
        }
    }

    /// 指定模型名的对话客户端(有 key 用真实客户端,没有就用 mock)。
    pub(crate) async fn chat_model_for(
        &self,
        model_name: &str,
    ) -> Result<Arc<dyn kb_core::ports::ChatModel>> {
        match configured_chat_model(&self.rt().paths, &self.rt().config(), model_name)? {
            Some(model) => Ok(model),
            None => Ok(Arc::new(kb_llm::MockChatModel::reply(
                "{\"queries\":[],\"decision\":\"reject\",\"score\":0}",
            ))),
        }
    }

    /// 提炼 / 检索增强用的对话模型。
    pub(crate) async fn chat_model(&self) -> Result<Arc<dyn kb_core::ports::ChatModel>> {
        let model = self.rt().config().llm.extract_model.clone();
        self.chat_model_for(&model).await
    }

    /// 作用域里第一个项目 id(给闸门判定用;没有就是 `None`)。
    pub(crate) async fn project_id_of(&self, collections: &[String]) -> Option<String> {
        for name in collections {
            if let Ok(Some(collection)) = CollectionRepo::get(self.rt().meta.as_ref(), name).await
                && let Some(project_id) = collection.project_id
            {
                return Some(project_id);
            }
        }
        None
    }

    /// 自动提炼(收尾阶段):提炼与审核各取一个模型实例(无 key 时都是 mock)。
    pub(crate) async fn evolution_service(
        &self,
    ) -> Result<kb_service::evolution::EvolutionService> {
        Ok(kb_service::evolution::EvolutionService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
            self.llm_gate(),
            self.chat_model().await?,
            self.chat_model().await?,
            self.rt().config().evolution.clone(),
        )
        .with_skills(self.rt().skills()))
    }

    /// 审核收件箱(收尾阶段)。
    pub(crate) fn draft_inbox(&self) -> kb_service::evolution::DraftInbox {
        kb_service::evolution::DraftInbox::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
        )
    }
}

/// AI 管家的工具执行器:把能力注册表里“可见面含 A、权限 ≤ G”的能力暴露成 LLM 工具。
struct CapabilityToolRunner {
    invoker: Arc<kb_capability::invoke::Invoker>,
    meta: Arc<dyn kb_core::ports::repo::MetaStore>,
    /// 发起这次管家对话的人。工具调用以他的身份回调能力;没有身份就拒绝(fail closed)。
    principal: Option<kb_capability::Principal>,
}

#[async_trait]
impl kb_service::agent::ToolRunner for CapabilityToolRunner {
    fn tools(&self) -> Vec<kb_core::model::ToolSpec> {
        self.invoker
            .registry()
            .for_surface(kb_capability::registry::Surface::Agent)
            .into_iter()
            // 管家自己那几个能力(发消息 / 会话管理)不能再当工具给模型:会递归
            .filter(|capability| !capability.name.starts_with("agent_"))
            .filter(|capability| {
                capability.permission <= kb_capability::registry::Permission::Govern
            })
            .map(|capability| kb_core::model::ToolSpec {
                name: capability.name.to_owned(),
                description: capability.description.to_owned(),
                parameters: capability.input_schema.clone(),
            })
            .collect()
    }

    fn is_mutating(&self, name: &str) -> bool {
        self.invoker
            .registry()
            .get(name)
            .map(|capability| capability.side_effect)
            .unwrap_or(false)
    }

    async fn call(
        &self,
        name: &str,
        args: serde_json::Value,
        dry_run: bool,
    ) -> Result<serde_json::Value> {
        let Some(principal) = self.principal.clone() else {
            return Err(KbError::Unauthorized);
        };
        let ctx = kb_capability::invoke::CallCtx {
            actor: "agent".to_owned(),
            surface: kb_capability::registry::Surface::Agent,
            cwd: None,
            client: None,
            project: None,
            dry_run,
            batch_id: None,
            principal: Some(principal),
            // AI 管家 / ACP 回调能力永远在调用者自己的知识库里,不带「点名别人」
            space_override: None,
            admin_view: None,
            link: None,
        };
        let response = self.invoker.call(name, ctx, args).await?;
        Ok(serde_json::json!({
            "data": response.data,
            "meta": {
                "batch_id": response.meta.batch_id,
                "dry_run": response.meta.dry_run,
                "warnings": response.meta.warnings,
            },
        }))
    }

    async fn allows_llm(&self, collections: &[String]) -> Result<bool> {
        kb_service::query_enhance::scope_allows_llm(self.meta.as_ref(), collections).await
    }
}

#[cfg(test)]
mod roots_tests {
    //! `[evolution] session_roots` 的展开(b:忽略配置必须让用例变红)。
    use super::session_roots_in;
    use std::path::Path;

    #[test]
    fn session_roots_expand_tilde_and_keep_absolute_paths() {
        let mut config = kb_core::config::Config::default();
        config.evolution.session_roots = vec![
            "/home/user/.codeg/.claude".to_owned(),
            "~/.kiro".to_owned(),
            "~".to_owned(),
        ];
        let home = Path::new("/home/tester");
        let roots = session_roots_in(&config, Some(home));
        assert_eq!(
            roots,
            vec![
                std::path::PathBuf::from("/home/user/.codeg/.claude"),
                std::path::PathBuf::from("/home/tester/.kiro"),
                std::path::PathBuf::from("/home/tester"),
            ]
        );

        // 没有 HOME 时 `~/…` 被丢掉,绝对路径仍保留
        let roots = session_roots_in(&config, None);
        assert_eq!(
            roots,
            vec![std::path::PathBuf::from("/home/user/.codeg/.claude")]
        );
    }
}
