//! ACP 的能力方法:清单、会话、聊天、沙箱。两段 `impl ServiceBackend` 都在这里。

use crate::capability_backend::acp::forwarding::spawn_acp_forwarder;
use crate::capability_backend::*;

impl ServiceBackend {
    /// 按会话 id 找代理,只认自己的:别人的会话和不存在同样处理。
    pub(crate) async fn owned_acp(&self, session: &str) -> Option<CachedAcp> {
        let owner = self.acp_owner();
        self.acp
            .lock()
            .await
            .get(session)
            .filter(|entry| entry.owner == owner)
            .cloned()
    }

    /// 这个会话 id 在缓存里是别人的吗(是 → 不能用,也不能当成新会话覆盖)。
    pub(crate) async fn acp_session_taken_by_other(&self, session: &str) -> bool {
        let owner = self.acp_owner();
        self.acp
            .lock()
            .await
            .get(session)
            .is_some_and(|entry| entry.owner != owner)
    }

    /// 代理的工作目录:显式 cwd 必须落在已登记项目根下;否则用会话项目根,再不行用空的工作目录。
    pub(crate) async fn acp_cwd(
        &self,
        args: &AcpChatArgs,
        meta: &kb_core::model::AgentSessionMeta,
    ) -> Result<std::path::PathBuf> {
        if self.acp_restricted() {
            // 普通用户没有项目目录可选(项目集合只有管理员能加),代理只能待在自己的工作目录里
            if args
                .cwd
                .as_deref()
                .is_some_and(|value| !value.trim().is_empty())
            {
                return Err(KbError::InvalidInput(
                    "代理只能在你自己的工作目录里运行,不能指定其它目录".to_owned(),
                ));
            }
            let workspace = self.rt().paths.agent_workspace().to_path_buf();
            let _ = std::fs::create_dir_all(&workspace);
            return Ok(workspace);
        }
        if let Some(cwd) = args.cwd.as_deref().filter(|value| !value.trim().is_empty()) {
            return self.checked_project_cwd(std::path::Path::new(cwd)).await;
        }
        let project = args
            .project
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| meta.project.clone());
        if !project.is_empty()
            && let Ok(found) = self.rt().projects().resolve(&project).await
        {
            return Ok(std::path::PathBuf::from(found.root_path));
        }
        let workspace = self.rt().paths.agent_workspace().to_path_buf();
        let _ = std::fs::create_dir_all(&workspace);
        Ok(workspace)
    }

    /// 显式 cwd:消解后必须在某个已登记项目根下面。
    pub(crate) async fn checked_project_cwd(
        &self,
        cwd: &std::path::Path,
    ) -> Result<std::path::PathBuf> {
        let projects = kb_core::ports::repo::ProjectRepo::list(self.rt().meta.as_ref()).await?;
        let roots: Vec<std::path::PathBuf> = projects
            .into_iter()
            .map(|project| std::path::PathBuf::from(project.root_path))
            .collect();
        if !kb_acp::sandbox::cwd_within_projects(cwd, &roots) {
            return Err(KbError::InvalidInput(
                "cwd 必须是已登记项目的根目录或其子目录".to_owned(),
            ));
        }
        Ok(kb_acp::sandbox::resolve_scope(cwd).unwrap_or_else(|| cwd.to_path_buf()))
    }

    /// ACP 代理定义 → 启动参数。
    ///
    /// 内置代理(deepseek / openai / anthropic)用 KB 自己存的 key 兜底注入环境变量,
    /// 用户不用在 ACP 里再配一遍;自定义代理自己设了同名变量时以它为准。
    ///
    /// 只在 **base_url 是官方端点** 时注入:KB 里配的是第三方代理(自建网关)时,
    /// 把那个 key 发给官方 API 既无效也不安全,交给代理自己的登录态。
    pub(crate) fn acp_spec(
        &self,
        def: &kb_service::acp_registry::AcpAgentDef,
        cwd: &std::path::Path,
        sandbox: bool,
    ) -> kb_acp::AgentSpec {
        let mut env = def.env.clone();
        let official = match def.id.as_str() {
            "deepseek" => "https://api.deepseek.com",
            "openai" => "https://api.openai.com",
            "anthropic" => "https://api.anthropic.com",
            _ => "",
        };
        let base_url = self.rt().config().llm.base_url.clone();
        // 站点自己的 LLM key 只给管理员的代理用。普通用户的代理拿到它,就能绕开按人记账的每日额度
        // (代理直接调官方接口,不经过 KB 的额度闸门),还能把 key 带走。
        if !self.acp_restricted()
            && let Some(name) = kb_service::llm_providers::env_var_of(&def.id)
            && !official.is_empty()
            && base_url.starts_with(official)
            && let Some(key) = crate::runtime::llm_api_key(&self.rt().paths)
        {
            env.entry(name.to_owned()).or_insert(key);
        }
        let inner = kb_acp::AgentSpec {
            id: def.id.clone(),
            name: def.name.clone(),
            command: def.command.clone(),
            args: def.args.clone(),
            env,
        };
        let host_env: Vec<(String, String)> = std::env::vars().collect();
        if sandbox && kb_service::acp_registry::command_available("bwrap") {
            let spec = self.sandbox_spec(&inner, cwd, &host_env);
            if self.acp_restricted() {
                // 普通用户的代理再加一层资源上限:跑飞了(死循环、往磁盘灌文件)时内核直接杀掉
                let settings = kb_service::acp_registry::load(&self.acp_settings_path());
                return kb_acp::sandbox::with_limits(
                    spec,
                    settings.user_cpu_secs,
                    settings.user_fsize_mb.saturating_mul(1024 * 1024),
                );
            }
            return spec;
        }
        kb_acp::sandbox::cleared_agent(&inner, self.rt().paths.home(), &host_env)
    }

    /// 用 bwrap 把代理关进沙箱。不挂 `kb.sock`;只挂 `agent.sock`。
    pub(crate) fn sandbox_spec(
        &self,
        inner: &kb_acp::AgentSpec,
        cwd: &std::path::Path,
        host_env: &[(String, String)],
    ) -> kb_acp::AgentSpec {
        let home = std::env::var_os("HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("/root"));
        let kb_home = self.rt().paths.home().to_path_buf();
        // 每个知识库自己的工作目录:一个用户的代理看不到另一个用户的文件
        let workspace = self.rt().paths.agent_workspace().to_path_buf();
        let _ = std::fs::create_dir_all(&workspace);
        let agent_socket = self.rt().paths.agent_socket();
        let acp_tools = kb_home.join("acp-tools");
        let exe = std::env::current_exe().ok();
        let config_dirs: Vec<std::path::PathBuf> = kb_service::acp_registry::config_dirs(&inner.id)
            .iter()
            .map(|relative| home.join(relative))
            .collect();
        let mounts = kb_acp::sandbox::SandboxMounts {
            cwd,
            kb_home: &kb_home,
            host_home: &home,
            workspace: &workspace,
            exe: exe.as_deref(),
            agent_socket: agent_socket.exists().then_some(agent_socket.as_path()),
            acp_tools: acp_tools.exists().then_some(acp_tools.as_path()),
            config_dirs: &config_dirs,
            config_dirs_readonly: self.acp_restricted(),
        };
        kb_acp::sandbox::bwrap_agent(inner, &mounts, host_env)
    }

    /// 拉起代理。沙箱失败只在 bwrap 缺失或 namespace 不可用、且设置允许时才回退。
    /// 返回值的 bool 是这次是不是真的在沙箱里。
    pub(crate) async fn spawn_acp(
        &self,
        def: &kb_service::acp_registry::AcpAgentDef,
        cwd: &std::path::Path,
        policy: kb_acp::PermissionPolicy,
    ) -> Result<(kb_acp::AcpClient, bool)> {
        let mut settings = kb_service::acp_registry::load(&self.acp_settings_path());
        // 普通用户:沙箱不能关、起不来也不能降级成裸跑(管理员的这两项设置只对管理员自己生效)
        if self.acp_restricted() {
            settings.sandbox = true;
            settings.allow_unsandboxed = false;
        }
        let scope = Some(cwd.to_path_buf());
        if !settings.sandbox {
            let spec = self.acp_spec(def, cwd, false);
            let client = kb_acp::AcpClient::spawn(spec, policy, scope).await?;
            return Ok((client, false));
        }
        if !kb_service::acp_registry::command_available("bwrap") {
            if settings.allow_unsandboxed {
                tracing::warn!("bwrap 不存在,按设置回退为未隔离启动");
                let spec = self.acp_spec(def, cwd, false);
                let client = kb_acp::AcpClient::spawn(spec, policy, scope).await?;
                return Ok((client, false));
            }
            return Err(KbError::Unavailable(
                "bwrap 不可用,且 acp.toml 没有 allow_unsandboxed = true".to_owned(),
            ));
        }
        let spec = self.acp_spec(def, cwd, true);
        match kb_acp::AcpClient::spawn(spec, policy, scope.clone()).await {
            Ok(client) => Ok((client, true)),
            Err(err)
                if settings.allow_unsandboxed
                    && kb_acp::sandbox::sandbox_fallback_eligible(&err.to_string()) =>
            {
                tracing::warn!(error = %err, "ACP 沙箱启动失败,按设置回退为未隔离启动");
                let spec = self.acp_spec(def, cwd, false);
                let client = kb_acp::AcpClient::spawn(spec, policy, scope).await?;
                Ok((client, false))
            }
            Err(err) => Err(err),
        }
    }

    /// 拉起代理并放进缓存(原来 `acp_chat` 里的那一大段)。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn create_acp_entry(
        &self,
        def: &kb_service::acp_registry::AcpAgentDef,
        policy: kb_acp::PermissionPolicy,
        args: &AcpChatArgs,
        meta: &kb_core::model::AgentSessionMeta,
        project: Option<&str>,
        session: &str,
        settings: &kb_service::acp_registry::AcpSettings,
        owner: &str,
    ) -> Result<CachedAcp> {
        let at = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or_default()
        };
        let cwd = self.acp_cwd(args, meta).await?;
        let (mut client, sandboxed) = self.spawn_acp(def, &cwd, policy).await?;
        let events = client.take_events();
        let servers = vec![self.kb_mcp_spec(session, project)];
        let mut acp_session = String::new();
        let mut resumed = false;
        if !meta.acp_session.is_empty() && client.info.load_session {
            match client
                .load_session(&meta.acp_session, cwd.clone(), servers.clone())
                .await
            {
                Ok(()) => {
                    acp_session = meta.acp_session.clone();
                    resumed = true;
                }
                Err(err) => {
                    tracing::warn!(error = %err, "ACP session/load 失败,改为新会话");
                }
            }
        }
        if acp_session.is_empty() {
            acp_session = client.new_session(cwd, servers).await?;
        }
        let text = Arc::new(tokio::sync::Mutex::new(String::new()));
        let trace = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let turn_slot = Arc::new(tokio::sync::Mutex::new(None));
        spawn_acp_forwarder(
            events,
            session.to_owned(),
            self.hub.clone(),
            text.clone(),
            trace.clone(),
            self.acp_pending.clone(),
            turn_slot.clone(),
            owner.to_owned(),
        );
        AgentRepo::set_acp_session(
            self.rt().meta.as_ref(),
            session,
            &def.id,
            &acp_session,
            at(),
        )
        .await?;
        AgentRepo::set_sandboxed(self.rt().meta.as_ref(), session, sandboxed, at()).await?;
        let entry = CachedAcp {
            runtime: self.rt(),
            owner: owner.to_owned(),
            client: Arc::new(client),
            acp_session,
            resumed,
            text,
            trace,
            sandboxed,
            last_used: Arc::new(std::sync::Mutex::new(std::time::Instant::now())),
            turn_slot,
            prompt_lock: Arc::new(tokio::sync::Mutex::new(())),
        };
        let max = settings.max_agents.max(1) as usize;
        {
            let mut cache = self.acp.lock().await;
            if cache.len() >= max {
                drop(cache);
                entry.client.request_shutdown().await;
                return Err(KbError::Unavailable(format!(
                    "ACP 并发已达上限 {max},请关掉不用的会话后再试"
                )));
            }
            cache.insert(session.to_owned(), entry.clone());
        }
        if let Some(hub) = &self.hub {
            hub.publish(
                "acp.update",
                json!({ "session_id": session, "kind": "meta", "sandboxed": sandboxed }),
            );
        }
        Ok(entry)
    }

    /// 占一个代理名额:全站不超过 `max_agents`,每人不超过 `max_per_user`。
    ///
    /// - 自己已经有别的会话时:先让自己**空闲**的旧会话让位;没有空闲的就拒绝(排队也等不到自己释放);
    /// - 全站满了:先回收别人空闲最久的;大家都在跑,就排队,每秒看一次,期间推「前面还有几个」给本人,
    ///   等不到 `queue_wait_secs` 才报繁忙。
    pub(crate) async fn acquire_acp_slot(
        &self,
        owner: &str,
        session: &str,
        settings: &kb_service::acp_registry::AcpSettings,
    ) -> Result<()> {
        let global = settings.max_agents.max(1) as usize;
        let per_user = settings.max_per_user.max(1) as usize;
        let deadline =
            std::time::Instant::now() + std::time::Duration::from_secs(settings.queue_wait_secs);
        let local = owner == "local";
        loop {
            self.reap_idle_acp().await;
            let mut victim: Option<String> = None;
            let mut ahead = 0usize;
            {
                let mut slots = self.acp_slots.lock().await;
                let cache = self.acp.lock().await;
                let mine = cache.values().filter(|entry| entry.owner == owner).count()
                    + slots
                        .values()
                        .filter(|slot_owner| *slot_owner == owner)
                        .count();
                let total = cache.len() + slots.len();
                // 空闲的会话:没有轮次在跑
                let idle_oldest = |only_owner: Option<&str>| {
                    cache
                        .iter()
                        .filter(|(_, entry)| only_owner.is_none_or(|who| entry.owner == who))
                        .filter(|(_, entry)| entry.prompt_lock.try_lock().is_ok())
                        .min_by_key(|(_, entry)| {
                            entry
                                .last_used
                                .lock()
                                .map(|at| *at)
                                .unwrap_or_else(|_| std::time::Instant::now())
                        })
                        .map(|(id, _)| id.clone())
                };
                if !local && mine >= per_user {
                    match idle_oldest(Some(owner)) {
                        Some(id) => victim = Some(id),
                        None => {
                            return Err(KbError::Unavailable(
                                "你已经有一个代理会话在运行,请等它结束或先关掉再开新的".to_owned(),
                            ));
                        }
                    }
                } else if total < global {
                    slots.insert(session.to_owned(), owner.to_owned());
                    return Ok(());
                } else {
                    match idle_oldest(None) {
                        Some(id) => victim = Some(id),
                        None => ahead = total.saturating_sub(global) + 1,
                    }
                }
            }
            if let Some(id) = victim {
                tracing::info!(session = %id, "为新会话腾名额,回收空闲代理");
                self.shutdown_acp_session(&id).await;
                continue;
            }
            if std::time::Instant::now() >= deadline {
                return Err(KbError::Unavailable(format!(
                    "代理太忙了(全站最多同时 {global} 个),排队超时,请稍后再试"
                )));
            }
            if let Some(hub) = &self.hub
                && !local
            {
                hub.publish_to_user(
                    owner,
                    "acp.queued",
                    json!({ "session_id": session, "ahead": ahead }),
                );
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    }

    /// 工作目录超过上限就拒绝开始新的一轮。
    pub(crate) async fn ensure_workspace_room(
        &self,
        settings: &kb_service::acp_registry::AcpSettings,
    ) -> Result<()> {
        if settings.workspace_mb == 0 {
            return Ok(());
        }
        let paths = self.rt().paths.clone();
        let used = tokio::task::spawn_blocking(move || {
            kb_service::storage::measure_space(&paths).workspace_bytes
        })
        .await
        .map_err(|err| KbError::Internal(format!("统计工作目录失败: {err}")))?;
        let limit = settings.workspace_mb.saturating_mul(1024 * 1024);
        if used > limit {
            return Err(KbError::Unavailable(format!(
                "代理工作目录已用 {} MB,超过上限 {} MB,请先清理再继续",
                used / (1024 * 1024),
                settings.workspace_mb
            )));
        }
        Ok(())
    }

    pub(crate) async fn session_lock(&self, session: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.acp_locks.lock().await;
        locks
            .entry(session.to_owned())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// 关掉一个会话的代理并作废它的伴生令牌。
    pub async fn shutdown_acp_session(&self, session_id: &str) {
        self.history_allow.lock().await.remove(session_id);
        let entry = self.acp.lock().await.remove(session_id);
        self.agent_grants.revoke_session(session_id);
        if let Some(entry) = entry {
            let _ = entry.client.cancel(&entry.acp_session).await;
            let text = entry.text.lock().await.clone();
            if !text.trim().is_empty() {
                let at = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or_default();
                let _ = AgentRepo::append(
                    entry.runtime.meta.as_ref(),
                    AgentMessage {
                        session_id: session_id.to_owned(),
                        seq: 0,
                        role: "assistant".to_owned(),
                        content_json: json!({ "text": text, "interrupted": true }).to_string(),
                        at,
                    },
                )
                .await;
            }
            entry.client.request_shutdown().await;
        }
    }

    /// 每分钟看一次空闲代理。
    pub fn spawn_reaper(self: &Arc<Self>, mut shutdown: tokio::sync::watch::Receiver<bool>) {
        let this = Arc::clone(self);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                break;
                }
                }
                _ = tokio::time::sleep(std::time::Duration::from_secs(60)) => {
                this.reap_idle_acp().await;
                }
                }
            }
        });
    }

    /// 守护进程退出前把在途回复落库。
    pub async fn drain_acp(&self) {
        let ids: Vec<String> = self.acp.lock().await.keys().cloned().collect();
        for id in ids {
            self.shutdown_acp_session(&id).await;
        }
    }

    pub(crate) async fn reap_idle_acp(&self) {
        let settings = kb_service::acp_registry::load(&self.acp_settings_path());
        let idle = std::time::Duration::from_secs(settings.idle_minutes.saturating_mul(60).max(60));
        let stale: Vec<String> = {
            let cache = self.acp.lock().await;
            cache
                .iter()
                .filter(|(_, entry)| {
                    // 轮次进行中拿着 prompt_lock;超时比空闲时间还长时不能把正在跑的代理杀掉
                    let free = entry.prompt_lock.try_lock().is_ok();
                    free && entry
                        .last_used
                        .lock()
                        .ok()
                        .is_some_and(|at| at.elapsed() > idle)
                })
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in stale {
            tracing::info!(session = %id, "回收空闲 ACP 代理");
            self.shutdown_acp_session(&id).await;
        }
    }
}
