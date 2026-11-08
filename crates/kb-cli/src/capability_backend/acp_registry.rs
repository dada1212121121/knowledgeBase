//! ACP 代理的登记表:安装/卸载/默认/权限/自检,以及 npm 与 MCP 描述。

use crate::capability_backend::*;

impl ServiceBackend {
    /// `acp.toml` 的位置。
    pub(crate) fn acp_settings_path(&self) -> std::path::PathBuf {
        self.rt().paths.home().join("acp.toml")
    }

    /// 跑一次 npm(安装 / 卸载),把尾部输出回给调用方,并推 WS 事件。
    async fn run_npm(&self, id: &str, action: &str, spec: &str) -> Result<Value> {
        if let Some(hub) = &self.hub {
            hub.publish(
                "acp.install",
                json!({ "id": id, "state": "start", "action": action, "spec": spec }),
            );
        }
        let prefix = self.rt().paths.home().join("acp-tools");
        let _ = std::fs::create_dir_all(&prefix);
        let mut command = tokio::process::Command::new("npm");
        command
            .arg(action)
            .arg("-g")
            .arg("--prefix")
            .arg(&prefix)
            .arg(spec)
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let child = command
            .spawn()
            .map_err(|err| KbError::Internal(format!("启动 npm 失败: {err}")))?;
        // 超时会丢掉这个 future;kill_on_drop 把孤儿 npm 一起杀掉
        let output = match tokio::time::timeout(
            std::time::Duration::from_secs(300),
            child.wait_with_output(),
        )
        .await
        {
            Ok(result) => {
                result.map_err(|err| KbError::Internal(format!("等待 npm 失败: {err}")))?
            }
            Err(_) => return Err(KbError::Unavailable("npm 超过 5 分钟没有结束".to_owned())),
        };
        let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&output.stderr));
        let tail: String = text
            .chars()
            .rev()
            .take(1500)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        let ok = output.status.success();
        if let Some(hub) = &self.hub {
            hub.publish(
                "acp.install",
                json!({ "id": id, "state": "done", "action": action, "ok": ok, "tail": tail }),
            );
        }
        if !ok {
            return Err(KbError::Unavailable(format!(
                "npm {action} {spec} 失败:\n{tail}"
            )));
        }
        Ok(json!({
            "ok": true,
            "id": id,
            "action": action,
            "spec": spec,
            "available": kb_service::acp_registry::command_available_in(
                &kb_service::acp_registry::find(
                    &kb_service::acp_registry::load(&self.acp_settings_path()),
                    id,
                )
                .map(|def| def.command)
                .unwrap_or_default(),
                &[self.rt().paths.home().join("acp-tools/bin")],
            ),
            "tail": tail,
        }))
    }

    /// 把 KB 自己的能力以 MCP server 的形式交给 ACP 代理。
    ///
    /// 伴生进程连 `agent.sock`,带一次性会话令牌。`--features` 只是客户端过滤,服务端按令牌里的工具组再拦一次。
    pub(crate) fn kb_mcp_spec(
        &self,
        session_id: &str,
        project: Option<&str>,
    ) -> kb_acp::McpServerSpec {
        let command = std::env::current_exe().unwrap_or_else(|_| std::path::PathBuf::from("kb"));
        let settings = kb_service::acp_registry::load(&self.acp_settings_path());
        let mut args = vec!["mcp".to_owned()];
        if !settings.tool_groups.is_empty() {
            args.push("--features".to_owned());
            args.push(settings.tool_groups.join(","));
        }
        let token = self.agent_grants.issue(kb_web::AgentGrant {
            tool_groups: settings.tool_groups.clone(),
            project: project.map(str::to_owned),
            session_id: session_id.to_owned(),
            // 伴生进程回调能力时用发起这次会话的人的身份,而不是本机超级用户
            principal: kb_capability::current_principal(),
            // 代理伴生进程只在自己的知识库里检索;「包含共享给我」是远程 MCP 令牌的设置
            include_shared: false,
        });
        let socket = self.rt().paths.agent_socket();
        kb_acp::McpServerSpec {
            name: "knowledgeBase".to_owned(),
            command,
            args,
            env: vec![
                (
                    "KB_HOME".to_owned(),
                    self.rt().paths.home().display().to_string(),
                ),
                ("KB_AGENT_SOCK".to_owned(), socket.display().to_string()),
                ("KB_AGENT_TOKEN".to_owned(), token),
            ],
        }
    }

    /// 谁在用代理:登录用户是他的 id,本机超级用户是 `local`。
    pub(crate) fn acp_owner(&self) -> String {
        match kb_capability::current_principal() {
            Some(principal) if !principal.local => principal.user_id,
            _ => "local".to_owned(),
        }
    }

    /// 是不是受限调用者:不在主知识库的人(普通用户)。他们的代理强制进沙箱、只能待在自己的
    /// 工作目录里、配置目录只读,不能指定项目目录,也受 CPU / 文件大小 / 工作目录大小上限约束。
    pub(crate) fn acp_restricted(&self) -> bool {
        self.call_space_id() != kb_core::account::PRIMARY_SPACE_ID
    }
}

/// npm 包名(去掉 `@version`;保留 scope 的 `@`)。
fn npm_package_name(spec: &str) -> String {
    match spec.rfind('@') {
        Some(index) if index > 0 => spec[..index].to_owned(),
        _ => spec.to_owned(),
    }
}

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn acp_agents_impl(&self) -> Result<Value> {
        let settings = kb_service::acp_registry::load(&self.acp_settings_path());
        let custom_ids: Vec<&str> = settings.agents.iter().map(|a| a.id.as_str()).collect();
        let agents: Vec<Value> = kb_service::acp_registry::all_agents(&settings)
            .into_iter()
            .map(|def| {
                let builtin = !custom_ids.contains(&def.id.as_str());
                // 密钥不回显:只告诉界面“这个变量有值”
                let env: std::collections::BTreeMap<String, String> = def
                    .env
                    .iter()
                    .map(|(key, value)| {
                        (
                            key.clone(),
                            if value.is_empty() {
                                String::new()
                            } else {
                                "••••".to_owned()
                            },
                        )
                    })
                    .collect();
                let hint = kb_service::acp_registry::env_keys(&def.id);
                json!({
                    "id": def.id,
                    "name": def.name,
                    "command": def.command,
                    "args": def.args,
                    "env": env,
                    "env_hint": hint.map(|keys| json!({
                        "base": keys.base,
                        "key": keys.key,
                        "model": keys.model,
                    })),
                    "npm": def.npm,
                    "docs": def.docs,
                    "builtin": builtin,
                    "available": kb_service::acp_registry::command_available_in(
                        &def.command,
                        &[self.rt().paths.home().join("acp-tools/bin")],
                    ),
                })
            })
            .collect();
        Ok(json!({
            "permission": settings.permission,
            "default": settings.default_agent,
            "sandbox": settings.sandbox,
            "tool_groups": settings.tool_groups,
            // 每人代理工作目录的上限(MB,0 = 不限):助手界面据此显示「工作目录已用 / 上限」,超了 acp_chat 会拒绝
            "workspace_mb": settings.workspace_mb,
            // 服务端只对受限账号(spaces/<id>/ 下的用户)拦「工作目录超限」,主知识库账号不拦:
            // 前端据此决定要不要把发送按钮置灰,免得界面比服务端更严,也免得服务端放行了界面却不让点
            "workspace_enforced": self.acp_restricted() && settings.workspace_mb > 0,
            "agents": agents,
        }))
    }

    pub(super) async fn acp_save_agent_impl(&self, args: AcpSaveAgentArgs) -> Result<Value> {
        let path = self.acp_settings_path();
        let mut settings = kb_service::acp_registry::load(&path);
        // 已有的(自定义覆盖或内置)定义:用来保留 npm / docs,以及“••••”占位的旧密钥
        let existing = settings
            .agents
            .iter()
            .find(|agent| agent.id == args.id.trim())
            .cloned()
            .or_else(|| {
                kb_service::acp_registry::builtin_agents()
                    .into_iter()
                    .find(|agent| agent.id == args.id.trim())
            });
        let mut env = std::collections::BTreeMap::new();
        for (key, value) in args.env {
            if value == "••••" {
                if let Some(old) = existing
                    .as_ref()
                    .and_then(|agent| agent.env.get(&key))
                    .filter(|value| !value.is_empty())
                {
                    env.insert(key, old.clone());
                }
            } else if !value.trim().is_empty() {
                env.insert(key, value);
            }
        }
        let def = kb_service::acp_registry::AcpAgentDef {
            id: args.id.trim().to_owned(),
            name: if args.name.trim().is_empty() {
                args.id.trim().to_owned()
            } else {
                args.name.trim().to_owned()
            },
            command: args.command.trim().to_owned(),
            args: args.args,
            env,
            npm: existing
                .as_ref()
                .map(|agent| agent.npm.clone())
                .unwrap_or_default(),
            docs: existing
                .as_ref()
                .map(|agent| agent.docs.clone())
                .unwrap_or_default(),
        };
        kb_service::acp_registry::validate(&def)?;
        kb_service::acp_registry::validate_command(&def.command, settings.allow_shell_commands)?;
        if let Some(existing) = settings.agents.iter_mut().find(|agent| agent.id == def.id) {
            *existing = def.clone();
        } else {
            settings.agents.push(def.clone());
        }
        kb_service::acp_registry::save(&path, &settings)?;
        Ok(json!({ "saved": def.id }))
    }

    pub(super) async fn acp_remove_agent_impl(&self, args: AcpAgentIdArgs) -> Result<Value> {
        let path = self.acp_settings_path();
        let mut settings = kb_service::acp_registry::load(&path);
        let before = settings.agents.len();
        settings.agents.retain(|agent| agent.id != args.id);
        if settings.agents.len() == before {
            return Err(KbError::NotFound(format!("自定义代理 {}", args.id)));
        }
        kb_service::acp_registry::save(&path, &settings)?;
        Ok(json!({ "removed": args.id }))
    }

    pub(super) async fn acp_set_permission_impl(&self, args: AcpPermissionArgs) -> Result<Value> {
        if !matches!(args.permission.as_str(), "none" | "read" | "all") {
            return Err(KbError::InvalidInput(
                "permission 只能是 none / read / all".to_owned(),
            ));
        }
        let path = self.acp_settings_path();
        let mut settings = kb_service::acp_registry::load(&path);
        settings.permission = args.permission.clone();
        kb_service::acp_registry::save(&path, &settings)?;
        Ok(json!({ "permission": args.permission }))
    }

    pub(super) async fn acp_install_impl(&self, args: AcpAgentIdArgs) -> Result<Value> {
        let settings = kb_service::acp_registry::load(&self.acp_settings_path());
        let def = kb_service::acp_registry::find(&settings, &args.id)
            .ok_or_else(|| KbError::NotFound(format!("ACP 代理 {}", args.id)))?;
        if def.npm.trim().is_empty() {
            return Err(KbError::InvalidInput(format!(
                "{} 没有 npm 包,请按官方说明安装{}",
                def.name,
                if def.docs.is_empty() {
                    String::new()
                } else {
                    format!(":{}", def.docs)
                }
            )));
        }
        self.run_npm(&args.id, "install", &def.npm).await
    }

    pub(super) async fn acp_uninstall_impl(&self, args: AcpAgentIdArgs) -> Result<Value> {
        let settings = kb_service::acp_registry::load(&self.acp_settings_path());
        let def = kb_service::acp_registry::find(&settings, &args.id)
            .ok_or_else(|| KbError::NotFound(format!("ACP 代理 {}", args.id)))?;
        if def.npm.trim().is_empty() {
            return Err(KbError::InvalidInput(format!(
                "{} 没有 npm 包,不能通过这里卸载",
                def.name
            )));
        }
        let package = npm_package_name(&def.npm);
        self.run_npm(&args.id, "uninstall", &package).await
    }

    pub(super) async fn acp_set_default_impl(&self, args: AcpDefaultArgs) -> Result<Value> {
        let path = self.acp_settings_path();
        let mut settings = kb_service::acp_registry::load(&path);
        if !args.id.trim().is_empty()
            && kb_service::acp_registry::find(&settings, args.id.trim()).is_none()
        {
            return Err(KbError::NotFound(format!("ACP 代理 {}", args.id)));
        }
        settings.default_agent = args.id.trim().to_owned();
        kb_service::acp_registry::save(&path, &settings)?;
        Ok(json!({ "default": settings.default_agent }))
    }

    pub(super) async fn acp_set_sandbox_impl(&self, args: AcpSandboxArgs) -> Result<Value> {
        let path = self.acp_settings_path();
        let mut settings = kb_service::acp_registry::load(&path);
        settings.sandbox = args.sandbox;
        kb_service::acp_registry::save(&path, &settings)?;
        Ok(json!({ "sandbox": settings.sandbox }))
    }

    pub(super) async fn acp_permission_impl(
        &self,
        args: AcpPermissionDecisionArgs,
    ) -> Result<Value> {
        let session = args.session_id.clone().filter(|id| !id.trim().is_empty());
        let entries: Vec<(String, CachedAcp)> = {
            let owner = self.acp_owner();
            let cache = self.acp.lock().await;
            // 只看自己的会话:不指定会话时也只在自己的里面找,否则能替别人批准 / 拒绝权限请求
            match session {
                Some(id) => cache
                    .get(&id)
                    .filter(|entry| entry.owner == owner)
                    .cloned()
                    .map(|entry| vec![(id, entry)])
                    .unwrap_or_default(),
                None => cache
                    .iter()
                    .filter(|(_, entry)| entry.owner == owner)
                    .map(|(id, entry)| (id.clone(), entry.clone()))
                    .collect(),
            }
        };
        if entries.is_empty() {
            return Err(KbError::NotFound("没有正在运行的 ACP 代理".to_owned()));
        }
        for (id, entry) in entries {
            let request_id = match args
                .request_id
                .clone()
                .filter(|value| !value.trim().is_empty())
            {
                Some(value) => value,
                None => match entry.client.pending_permissions().await.into_iter().next() {
                    Some(value) => value,
                    None => continue,
                },
            };
            let resolved = entry
                .client
                .resolve_permission(&request_id, args.allow)
                .await;
            if resolved {
                return Ok(json!({ "resolved": true, "session_id": id, "request_id": request_id }));
            }
        }
        Err(KbError::NotFound("没有等待答复的权限请求".to_owned()))
    }

    pub(super) async fn acp_test_impl(&self, args: AcpAgentIdArgs) -> Result<Value> {
        let settings = kb_service::acp_registry::load(&self.acp_settings_path());
        let def = kb_service::acp_registry::find(&settings, &args.id)
            .ok_or_else(|| KbError::NotFound(format!("ACP 代理 {}", args.id)))?;
        let policy = kb_acp::PermissionPolicy::parse(&settings.permission);
        let cwd = self.rt().paths.agent_workspace().to_path_buf();
        let _ = std::fs::create_dir_all(&cwd);
        let (client, _) = self.spawn_acp(&def, &cwd, policy).await?;
        let info = client.info.clone();
        client.shutdown().await;
        Ok(json!({
            "ok": true,
            "id": args.id,
            "name": info.name,
            "version": info.version,
            "protocol": info.protocol_version,
        }))
    }
}
