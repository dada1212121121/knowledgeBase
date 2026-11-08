//! 系统:配置读写、令牌、集合与项目、门禁(付费方 / 忙碌策略)。

use crate::capability_backend::*;

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn list_collections_impl(&self) -> Result<Value> {
        let collections = CollectionService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
        )
        .list()
        .await?;
        Ok(json!({ "collections": collections }))
    }

    pub(super) async fn list_projects_impl(&self) -> Result<Value> {
        Ok(json!({ "projects": self.projects().list().await? }))
    }

    pub(super) async fn install_hooks_impl(&self, args: HooksArgs) -> Result<Value> {
        let project = self.rt().projects().resolve(&args.project).await?;
        let report = self.install_project_hooks(&project).await?;
        Ok(hooks_json(&report))
    }

    pub(super) async fn uninstall_hooks_impl(&self, args: HooksArgs) -> Result<Value> {
        let project = self.rt().projects().resolve(&args.project).await?;
        let manager = kb_service::evolution::HookManager::open(&project.root_path)?;
        let report = manager.uninstall()?;
        let mut updated = project;
        updated.hooks_installed = false;
        ProjectRepo::update(self.rt().meta.as_ref(), updated).await?;
        Ok(hooks_json(&report))
    }

    pub(super) async fn add_project_impl(&self, args: AddProjectArgs) -> Result<Value> {
        // `ProjectService::add` 对同名同目录是幂等的(返回已有项目),调用方分不出新建还是已有。
        // 钩子只给「这次新建」的项目装:已有项目的钩子可能是用户特意卸掉的,重复登记不该悄悄装回去。
        // 登记前取不到列表就当作新建(装钩子本身是幂等的,最坏是刷新一遍脚本)。
        let known_before: std::collections::HashSet<String> =
            ProjectRepo::list(self.rt().meta.as_ref())
                .await
                .map(|projects| projects.into_iter().map(|project| project.id).collect())
                .unwrap_or_default();
        let project = self
            .projects()
            .add(&args.path, args.name.as_deref())
            .await?;
        let job = self
            .insight()
            .reindex(ReindexRequest {
                project: project.name.clone(),
                mode: Some("full".to_owned()),
                paths: Vec::new(),
                phase: None,
                stop_after_text: false,
            })
            .await?;
        // 登记与投递索引都成功以后才处理钩子,且钩子的任何失败都不能让登记失败:
        // 项目与索引任务已经落库,这里报错只会让调用方以为没建成而重复提交
        let hooks = if known_before.contains(&project.id) {
            json!({
                "installed": project.hooks_installed,
                "reason": "项目已存在,没有改动它的钩子",
            })
        } else {
            self.auto_install_hooks(&project).await
        };
        Ok(json!({ "job_id": job, "project": project.name, "hooks": hooks }))
    }

    pub(super) async fn update_project_impl(&self, args: UpdateProjectArgs) -> Result<Value> {
        let project = self
            .projects()
            .update(
                &args.project,
                kb_service::ProjectPatch {
                    include: args.include,
                    exclude: args.exclude,
                    allow_cloud_llm: args.allow_cloud_llm,
                    extract_enabled: args.extract_enabled,
                },
            )
            .await?;
        let mut job_id = None;
        if args.reindex {
            job_id = Some(
                self.insight()
                    .reindex(ReindexRequest {
                        project: project.name.clone(),
                        mode: Some("full".to_owned()),
                        paths: Vec::new(),
                        phase: None,
                        stop_after_text: false,
                    })
                    .await?,
            );
        }
        Ok(json!({ "project": project, "job_id": job_id }))
    }

    pub(super) async fn remove_project_impl(&self, args: ProjectNameArgs) -> Result<Value> {
        self.projects().remove(&args.project).await?;
        Ok(json!({ "removed": args.project }))
    }

    pub(super) async fn system_status_impl(&self) -> Result<Value> {
        let status = kb_service::system_status::collect(
            self.rt().meta.clone(),
            &self.rt().config(),
            &self.rt().paths,
            200,
        )
        .await?;
        Ok(serde_json::to_value(status)
            .map_err(|err| KbError::Internal(format!("序列化系统状态失败: {err}")))?)
    }

    pub(super) async fn list_skills_impl(&self) -> Result<Value> {
        let registry = self.rt().skills();
        Ok(serde_json::to_value(registry.summary())
            .map_err(|err| KbError::Internal(format!("序列化 skills 失败: {err}")))?)
    }

    pub(super) async fn get_config_impl(&self) -> Result<Value> {
        let config = self.web().get_config().await?;
        Ok(serde_json::to_value(config)
            .map_err(|err| KbError::Internal(format!("序列化配置失败: {err}")))?)
    }

    pub(super) async fn update_config_impl(&self, args: UpdateConfigArgs) -> Result<Value> {
        let update = self.web().update_config(args.patch).await?;
        let mut value = serde_json::to_value(update)
            .map_err(|err| KbError::Internal(format!("序列化配置结果失败: {err}")))?;
        // :文件已经落盘,立刻热重载一次,把“哪些项立即生效 / 哪些要重启”如实告诉调用方
        if let Some(reloader) = &self.reloader {
            let outcome = reloader.reload().await;
            let hot = outcome.hot.clone();
            let restart = outcome.restart_required.clone();
            if let Some(object) = value.as_object_mut() {
                object.insert("generation".to_owned(), json!(outcome.generation));
                // 只有真的发生了一次重载(生效 / 需要迁移 / 出错)才覆盖 `update_config` 自己的回执:
                // 像「embed 改动只给迁移计划、不写文件」这种情况,文件没变,重载结果是“没有变化”,
                // 覆盖会把 web 层算好的 `migration_plan` 冲成 null(质量检查 发现的回归)。
                if outcome.applied || outcome.error.is_some() || !outcome.migration.is_empty() {
                    object.insert("hot".to_owned(), json!(hot));
                    object.insert("restart_keys".to_owned(), json!(restart));
                    object.insert("migration".to_owned(), json!(outcome.migration));
                    object.insert(
                        "migration_plan".to_owned(),
                        serde_json::to_value(&outcome.migration_plan).unwrap_or(Value::Null),
                    );
                    object.insert(
                        "restart_required".to_owned(),
                        json!(!outcome.restart_required.is_empty()),
                    );
                    object.insert("notes".to_owned(), json!(outcome.notes));
                }
                if let Some(error) = &outcome.error {
                    object.insert("error".to_owned(), json!(error));
                }
            }
        }
        if let Some(hub) = &self.hub {
            hub.publish(
                "item.changed",
                json!({ "action": "config.updated", "changed": value["changed"] }),
            );
        }
        Ok(value)
    }

    pub(super) async fn reload_config_impl(&self) -> Result<Value> {
        // 守护进程挂的是带观察者的那个重载器(会推 WS `config.changed` / `config.error`);
        // 嵌入式 / 测试里没有监听,就临时造一个只做“读 → 分 → 生效”的重载器。
        let reloader = match &self.reloader {
            Some(reloader) => reloader.clone(),
            None => Arc::new(
                kb_service::ConfigReloader::new(
                    self.rt().config.clone(),
                    self.rt().paths.config_file(),
                )
                .with_meta(self.rt().meta.clone()),
            ),
        };
        let outcome = reloader.reload().await;
        if let Some(hub) = &self.hub {
            // 观察者已经推过一次;没有观察者时(嵌入式)由这里补一条,让 Web 侧总能收到回执
            hub.publish(
                "item.changed",
                json!({ "action": "config.reloaded", "applied": outcome.applied }),
            );
        }
        serde_json::to_value(outcome)
            .map_err(|err| KbError::Internal(format!("序列化配置重载结果失败: {err}")))
    }

    pub(super) async fn reload_skills_impl(&self) -> Result<Value> {
        let registry = self.rt().reload_skills();
        let warnings = registry.warnings().to_vec();
        if let Some(hub) = &self.hub {
            hub.publish(
                "skills.reloaded",
                json!({
                    "loader_rules": registry.loader_rules().len(),
                    "templates": registry.templates().len(),
                    "warnings": warnings,
                }),
            );
        }
        Ok(json!({
            "dir": registry.dir().map(|dir| dir.display().to_string()),
            "loader_rules": registry
                .loader_rules()
                .iter()
                .map(|rule| json!({ "name": rule.name, "lang": rule.lang, "tags": rule.tags }))
                .collect::<Vec<_>>(),
            "templates": registry
                .templates()
                .iter()
                .map(|template| template.name.clone())
                .collect::<Vec<_>>(),
            "warnings": warnings,
        }))
    }

    pub(super) async fn get_skill_impl(
        &self,
        args: kb_capability::defs::SkillIdArgs,
    ) -> Result<Value> {
        // 读的是内存里已加载的那份:界面列出来的就是这些,编辑的也是它们
        let draft = self.rt().skills().draft(&args.id)?;
        Ok(json!({ "id": args.id, "draft": draft }))
    }

    pub(super) async fn save_skill_impl(
        &self,
        args: kb_capability::defs::SaveSkillArgs,
    ) -> Result<Value> {
        let draft = kb_service::SkillDraft {
            name: args.name,
            kind: args.kind,
            description: args.description,
            enabled: args.enabled,
            glob: args.glob,
            lang: args.lang,
            tags: args.tags,
            stage: args.stage,
            template: args.template,
            required: args.required,
            max_body_chars: args.max_body_chars,
            max_title_chars: args.max_title_chars,
        };
        let root = self.rt().paths.skills_dir().to_path_buf();
        let id = args.id.clone();
        // 写盘 + 校验是同步的小文件操作,放进阻塞线程池
        let saved = tokio::task::spawn_blocking(move || {
            kb_service::SkillRegistry::save(&root, id.as_deref(), &draft)
        })
        .await
        .map_err(|err| KbError::Internal(format!("保存 skill 的线程异常: {err}")))??;
        let reloaded = self.reload_skills().await?;
        Ok(json!({ "id": saved, "created": args.id.is_none(), "reloaded": reloaded }))
    }

    pub(super) async fn list_official_plugins_impl(&self) -> Result<Value> {
        let registry = self.rt().skills();
        Ok(
            serde_json::to_value(kb_service::official_plugins_with(&registry))
                .map_err(|err| KbError::Internal(format!("序列化官方插件失败: {err}")))?,
        )
    }

    pub(super) async fn install_official_plugin_impl(
        &self,
        args: kb_capability::defs::OfficialPluginArgs,
    ) -> Result<Value> {
        let root = self.rt().paths.skills_dir().to_path_buf();
        let id = args.id.clone();
        let overwrite = args.overwrite;
        let info = tokio::task::spawn_blocking(move || {
            kb_service::install_official_plugin(&root, &id, overwrite)
        })
        .await
        .map_err(|err| KbError::Internal(format!("安装官方插件的线程异常: {err}")))??;
        let reloaded = self.reload_skills().await?;
        Ok(json!({
            "id": args.id,
            "plugin": info,
            "reloaded": reloaded,
        }))
    }

    pub(super) async fn uninstall_official_plugin_impl(
        &self,
        args: kb_capability::defs::OfficialPluginArgs,
    ) -> Result<Value> {
        let root = self.rt().paths.skills_dir().to_path_buf();
        let id = args.id.clone();
        tokio::task::spawn_blocking(move || kb_service::uninstall_official_plugin(&root, &id))
            .await
            .map_err(|err| KbError::Internal(format!("卸载官方插件的线程异常: {err}")))??;
        let reloaded = self.reload_skills().await?;
        Ok(json!({ "id": args.id, "deleted": true, "reloaded": reloaded }))
    }

    pub(super) async fn set_skill_enabled_impl(
        &self,
        args: kb_capability::defs::SetSkillEnabledArgs,
    ) -> Result<Value> {
        let root = self.rt().paths.skills_dir().to_path_buf();
        let id = args.id.clone();
        let enabled = args.enabled;
        tokio::task::spawn_blocking(move || {
            kb_service::SkillRegistry::set_enabled(&root, &id, enabled)
        })
        .await
        .map_err(|err| KbError::Internal(format!("切换 skill 状态的线程异常: {err}")))??;
        let reloaded = self.reload_skills().await?;
        Ok(json!({
            "id": args.id,
            "enabled": args.enabled,
            "reloaded": reloaded,
        }))
    }

    pub(super) async fn get_plugin_impl(
        &self,
        args: kb_capability::defs::SkillIdArgs,
    ) -> Result<Value> {
        let draft = self.rt().skills().plugin_draft(&args.id)?;
        Ok(json!({ "id": args.id, "draft": draft }))
    }

    pub(super) async fn save_plugin_impl(
        &self,
        args: kb_capability::defs::SavePluginArgs,
    ) -> Result<Value> {
        let draft: kb_service::PluginDraft = serde_json::from_value(args.draft)
            .map_err(|err| KbError::InvalidInput(format!("插件表单格式不正确: {err}")))?;
        let root = self.rt().paths.skills_dir().to_path_buf();
        let id = args.id.clone();
        let created = id.is_none();
        let saved = tokio::task::spawn_blocking(move || {
            kb_service::SkillRegistry::save_plugin(&root, id.as_deref(), &draft)
        })
        .await
        .map_err(|err| KbError::Internal(format!("保存插件的线程异常: {err}")))??;
        let reloaded = self.reload_skills().await?;
        Ok(json!({ "id": saved, "created": created, "reloaded": reloaded }))
    }

    pub(super) async fn delete_skill_impl(
        &self,
        args: kb_capability::defs::SkillIdArgs,
    ) -> Result<Value> {
        let root = self.rt().paths.skills_dir().to_path_buf();
        let id = args.id.clone();
        tokio::task::spawn_blocking(move || kb_service::SkillRegistry::delete(&root, &id))
            .await
            .map_err(|err| KbError::Internal(format!("删除 skill 的线程异常: {err}")))??;
        let reloaded = self.reload_skills().await?;
        Ok(json!({ "id": args.id, "deleted": true, "reloaded": reloaded }))
    }

    pub(super) async fn create_token_impl(&self, args: CreateTokenArgs) -> Result<Value> {
        let scope = args.scope.as_deref().unwrap_or("mcp");
        let created = self.web().create_token(&args.name, scope).await?;
        Ok(serde_json::to_value(created)
            .map_err(|err| KbError::Internal(format!("序列化令牌失败: {err}")))?)
    }

    pub(super) async fn revoke_token_impl(&self, args: TokenIdArgs) -> Result<Value> {
        let revoked = self.web().revoke_token(&args.id).await?;
        Ok(serde_json::to_value(revoked)
            .map_err(|err| KbError::Internal(format!("序列化令牌失败: {err}")))?)
    }

    pub(super) async fn delete_collection_impl(&self, args: CollectionArgs) -> Result<Value> {
        let deleted = self.web().delete_collection(&args.collection).await?;
        self.forget_shares(kb_core::share::ResourceKey::collection(
            &self.call_space_id(),
            &args.collection,
        ))
        .await;
        Ok(serde_json::to_value(deleted)
            .map_err(|err| KbError::Internal(format!("序列化结果失败: {err}")))?)
    }
}

/// 嵌入后端徽标(设计规范的 `backend` 字段)。
pub fn embed_backend_badge(config: &kb_core::config::Config) -> &'static str {
    if config.accel.enabled {
        "igpu-vulkan"
    } else {
        "cpu-int8"
    }
}

/// 这条事件要不要构造提炼服务(只有会话事件需要模型)。
pub(crate) fn needs_evolution(kind: &str) -> bool {
    kind == "session_end"
}

/// `[llm]` 的两项额度接进外发闸门。
///
/// 此前用 `GateConfig::default`,其 `daily_token_budget = 0` 的含义是“不限”,
/// 等于这两项配置从未生效。
/// 按当前配置造真实的对话客户端;没有可用的 API key 时返回 `None`(调用方决定退回 mock 还是不跑)。
///
/// key 的来源与设置页的「已设置」判定保持一致:
/// 先看 `~/.kb/secrets.toml`,没有再按**当前提供商**回退读它的环境变量
/// (DeepSeek / OpenAI 用 `*_API_KEY`;本地 Ollama 不需要 key)。
pub(crate) fn configured_chat_model(
    paths: &kb_core::paths::KbPaths,
    config: &kb_core::config::Config,
    model_name: &str,
) -> Result<Option<Arc<dyn kb_core::ports::ChatModel>>> {
    let api_key = crate::runtime::llm_api_key(paths).or_else(|| {
        kb_service::llm_providers::env_var_of(&config.llm.provider)
            .and_then(|key| std::env::var(key).ok())
            .filter(|value| !value.trim().is_empty())
    });
    // 本地 Ollama 不校验密钥:当前提供商是 ollama 时用空 key 构造真实客户端,
    // 否则设置页显示「已设置」而运行时仍走 mock。
    let api_key = api_key.or_else(|| (config.llm.provider == "ollama").then(String::new));
    let Some(api_key) = api_key else {
        return Ok(None);
    };
    let client_config =
        kb_llm::LlmClientConfig::new(&config.llm.base_url, api_key).with_model(model_name);
    Ok(Some(Arc::new(kb_llm::OpenAiClient::new(client_config)?)))
}

pub(crate) fn gate_config(config: &kb_core::config::Config) -> kb_service::llm_gate::GateConfig {
    kb_service::llm_gate::GateConfig {
        daily_token_budget: config.llm.daily_token_budget,
        max_calls_per_hour: u64::from(config.llm.max_calls_per_hour),
        ai_enabled: config.ai.enabled,
        ..kb_service::llm_gate::GateConfig::default()
    }
}

impl ServiceBackend {
    /// 给项目装上链式 git 钩子,并把结果记进 `projects.hooks_installed`。
    ///
    /// `install_hooks` 能力和 `add_project` 的默认安装共用这一处,钩子的安装规则(原钩子改名
    /// `.kb-orig` 并先执行、`core.hooksPath` 被别的工具托管时不动)都在 `HookManager` 里,这里不重复。
    async fn install_project_hooks(
        &self,
        project: &kb_core::model::Project,
    ) -> Result<kb_service::evolution::HookReport> {
        let manager = kb_service::evolution::HookManager::open(&project.root_path)?;
        let report = manager.install(self.rt().paths.socket())?;
        // `ProjectRepo::update` 是整行覆盖:`add_project` 刚投递了全量索引,worker 可能已经在写
        // `last_commit` / `last_indexed_at`,所以不能拿调用方手里的旧快照写回,重新读一行只改这一个字段
        match ProjectRepo::get(self.rt().meta.as_ref(), &project.id).await? {
            Some(mut fresh) => {
                fresh.hooks_installed = !report.managed_by_other;
                ProjectRepo::update(self.rt().meta.as_ref(), fresh).await?;
            }
            // 装钩子的过程中项目被删了:钩子文件已经落盘,没有行可记,不当错误
            None => {
                tracing::warn!(project = %project.name, "装完钩子时项目已不存在,没有记录安装状态")
            }
        }
        Ok(report)
    }

    /// 新建项目后尽力装钩子,返回给调用方的 `hooks` 字段(`installed` + `reason`)。
    ///
    /// 只处理 git 项目;自动提炼(`extract_enabled`)与云端大模型(`allow_cloud_llm`)不在这里动,保持默认关。
    /// 任何失败都只记 warn 并写进 `reason`,绝不向上返回错误。
    async fn auto_install_hooks(&self, project: &kb_core::model::Project) -> Value {
        if !project.is_git {
            return json!({ "installed": false, "reason": "不是 git 仓库,没有可装的钩子" });
        }
        match self.install_project_hooks(project).await {
            Ok(report) if report.managed_by_other => json!({
                "installed": false,
                "reason": "仓库的钩子目录由其他工具托管(core.hooksPath),没有改动",
            }),
            Ok(_) => json!({ "installed": true, "reason": Value::Null }),
            Err(err) => {
                tracing::warn!(
                    project = %project.name,
                    error = %err,
                    "新建项目后自动安装「提交后自动索引」钩子失败,项目与索引任务不受影响"
                );
                json!({ "installed": false, "reason": format!("安装钩子失败: {err}") })
            }
        }
    }
}

fn hooks_json(report: &kb_service::evolution::HookReport) -> Value {
    serde_json::json!({
        "hooks_dir": report.hooks_dir,
        "managed_by_other": report.managed_by_other,
        "hooks": report.hooks.iter().map(|hook| serde_json::json!({
            "name": hook.name,
            "installed": hook.installed,
            "has_original": hook.has_original,
        })).collect::<Vec<_>>(),
    })
}

/// 正文被协作的人占着时,这次写入该怎么办。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BusyPolicy {
    /// 没人在协作:照常写。
    Proceed,
    /// 人在协作,调用方是脚本 / 命令行:拒绝(409),让他们去编辑器里改或等大家离开。
    Refuse,
    /// 人在协作,调用方是 AI(助手 / 编码代理):不拒绝,把想改的内容留成一条建议评论,由协作的人决定采不采纳。
    Suggest,
}

/// 调用方是不是 AI。操作者标签见 `CallCtx::actor`:内置助手是 `agent`,编码代理的伴生令牌是 `agent:<会话>`,
/// MCP 客户端是 `mcp:<客户端>`;浏览器会话是 `user`,API 令牌是 `token:<名字>`(脚本,不算 AI)。
pub(crate) fn is_ai_actor(actor: &str) -> bool {
    actor == "agent" || actor.starts_with("agent:") || actor.starts_with("mcp:")
}

/// 文档正被多人编辑时怎么处理这次改动。AI 的改动变成建议评论,脚本和人得到 409。
///
/// 用 admin key 调接口的 AI,操作者标签是 `user`(和浏览器里的本人一样),分不出来;
/// 它按约定带上 `X-KB-Client`(浏览器从不带这个头)就按 AI 处理。冒充这个头的脚本得到的是
/// "建议评论"而不是直接改动,只会更保守,不构成越权。
pub(crate) fn busy_policy(actor: &str, client: Option<&str>, busy: bool) -> BusyPolicy {
    let ai = is_ai_actor(actor) || (matches!(actor, "user" | "local") && client.is_some());
    match (busy, ai) {
        (false, _) => BusyPolicy::Proceed,
        (true, true) => BusyPolicy::Suggest,
        (true, false) => BusyPolicy::Refuse,
    }
}

/// 建议评论的正文:开头的标记让界面能认出这是 AI 的建议,后面是它想要的新内容(太长截断)。
pub(crate) fn suggestion_text(proposed: &str) -> String {
    const MAX_CHARS: usize = 20_000;
    let mut text = String::from("【AI 建议】文档正在被多人编辑,没有直接修改。建议改成:\n\n");
    text.extend(proposed.chars().take(MAX_CHARS));
    if proposed.chars().count() > MAX_CHARS {
        text.push_str("\n……(过长,已截断)");
    }
    text
}

/// 当前调用者有没有 `sources.local`(读服务器路径 / 任意 Git 仓库的来源)。
///
/// 不在能力调用里(守护进程自己的后台任务、嵌入式 CLI)没有调用者,按本机身份放行;
/// 能力调用里没有该功能点就是 403。
/// AI 调用记到谁的额度上:登录用户记他自己;本机超级用户和后台调用没有「人」可记。
pub(crate) fn ai_payer() -> Option<String> {
    kb_capability::current_principal()
        .filter(|principal| !principal.local)
        .map(|principal| principal.user_id)
}

/// 调用者能不能用网页 AI 规范化:它属于后台自动调用模型,跟「自动提炼与审核」同一个功能点。
/// 没有调用者(本机 / 定时任务)时按允许处理,全站开关由后台任务自己再查一次。
pub(crate) fn ai_extract_permitted() -> bool {
    kb_capability::current_principal()
        .is_none_or(|principal| principal.features.allows("ai.extract"))
}

pub(crate) fn require_local_sources() -> Result<()> {
    match kb_capability::current_principal() {
        None => Ok(()),
        Some(principal) if principal.features.allows("sources.local") => Ok(()),
        Some(_) => Err(KbError::Forbidden(
            "本机目录和 Git 来源需要「本机目录来源」功能权限".to_owned(),
        )),
    }
}

#[cfg(test)]
mod gate_tests {
    //! 外发闸门的额度必须来自 `[llm]`(a:改回 `GateConfig::default`
    //! 必须让这条用例变红)。
    use super::gate_config;

    #[test]
    fn llm_quotas_come_from_the_config_file() {
        let mut config = kb_core::config::Config::default();
        config.llm.daily_token_budget = 12_345;
        config.llm.max_calls_per_hour = 7;
        let gate = gate_config(&config);
        assert_eq!(gate.daily_token_budget, 12_345);
        assert_eq!(gate.max_calls_per_hour, 7);
        // 默认配置里两项都是有限值(0 的含义是“不限”)
        let defaults = gate_config(&kb_core::config::Config::default());
        assert!(defaults.daily_token_budget > 0);
        assert!(defaults.max_calls_per_hour > 0);
    }
}

#[cfg(test)]
mod busy_policy_tests {
    use super::*;

    #[test]
    fn ai_actors_are_the_assistant_the_coding_agent_and_mcp_clients_but_not_scripts_or_people() {
        for ai in ["agent", "agent:sess-1", "mcp:claude", "mcp:usr_x"] {
            assert!(is_ai_actor(ai), "{ai}");
        }
        for other in [
            "user",
            "token:ci-script",
            "local",
            "system",
            "agentless",
            "mcpx",
        ] {
            assert!(!is_ai_actor(other), "{other}");
        }
    }

    #[test]
    fn a_busy_document_is_refused_to_scripts_but_becomes_a_suggestion_for_ai() {
        assert_eq!(busy_policy("user", None, false), BusyPolicy::Proceed);
        assert_eq!(busy_policy("agent", None, false), BusyPolicy::Proceed);
        assert_eq!(busy_policy("user", None, true), BusyPolicy::Refuse);
        assert_eq!(busy_policy("token:ci", None, true), BusyPolicy::Refuse);
        assert_eq!(busy_policy("agent:s", None, true), BusyPolicy::Suggest);
        assert_eq!(busy_policy("mcp:c", None, true), BusyPolicy::Suggest);
        // admin key 的调用方是 `user`;带了 X-KB-Client 就是 AI 客户端,改动变成建议评论
        assert_eq!(
            busy_policy("user", Some("claude-code"), true),
            BusyPolicy::Suggest
        );
        assert_eq!(
            busy_policy("user", Some("claude-code"), false),
            BusyPolicy::Proceed
        );
        assert_eq!(
            busy_policy("token:ci", Some("x"), true),
            BusyPolicy::Refuse,
            "令牌是脚本,带不带头都不算 AI"
        )
    }

    #[test]
    fn the_suggestion_is_marked_and_long_proposals_are_cut() {
        let short = suggestion_text("新的正文");
        assert!(short.starts_with("【AI 建议】"), "{short}");
        assert!(short.ends_with("新的正文"));
        let long = suggestion_text(&"字".repeat(30_000));
        assert!(long.contains("已截断"));
        assert!(long.chars().count() < 20_100, "{}", long.chars().count());
    }
}
