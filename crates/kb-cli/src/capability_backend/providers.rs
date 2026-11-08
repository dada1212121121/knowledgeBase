//! 模型接入:Provider 目录、密钥、OCR、旧配置迁移。

use crate::capability_backend::*;

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn migrate_model_impl(&self, args: MigrateArgs) -> Result<Value> {
        let service = kb_service::migration::MigrationService::new(
            self.rt().meta.clone(),
            self.rt().store.clone(),
            self.rt().embedder.clone(),
        )
        .with_write_gate(self.rt().write_gate());
        // 先做一次估算:同时完成 `--to` 与当前 embedder 的一致性校验、collection 存在性校验。
        // 真正的迁移由 `migrate` 任务执行,进度走 `job.progress` 推送。
        let plan = service.plan(&args.collection, &args.to).await?;
        let job = self
            .rt()
            .queue()
            .enqueue(kb_service::jobs::NewJob {
                kind: "migrate".to_owned(),
                collection: Some(args.collection.clone()),
                priority: kb_service::jobs::priority::MIGRATE,
                payload: serde_json::json!({
                    "collection": args.collection,
                    "to": args.to,
                }),
            })
            .await?;
        Ok(json!({
            "job_id": job.id,
            "collection": args.collection,
            "to": args.to,
            "rows": plan.rows,
            "insight_rows": plan.insight_rows,
            "estimated_seconds": plan.estimated_seconds,
        }))
    }

    pub(super) async fn migrate_plan_impl(&self, args: MigrateArgs) -> Result<Value> {
        let service = kb_service::migration::MigrationService::new(
            self.rt().meta.clone(),
            self.rt().store.clone(),
            self.rt().embedder.clone(),
        )
        .with_write_gate(self.rt().write_gate());
        let plan = service.plan(&args.collection, &args.to).await?;
        Ok(json!({
            "collection": plan.collection,
            "from_table": plan.from_table,
            "to_table": plan.to_table,
            "from_embedder": plan.from_embedder,
            "to_embedder": plan.to_embedder,
            "rows": plan.rows,
            "insight_rows": plan.insight_rows,
            "estimated_seconds": plan.estimated_seconds,
            "can_switch_without_reembed": plan.can_switch_without_reembed,
        }))
    }

    pub(super) async fn set_llm_key_impl(&self, args: SetLlmKeyArgs) -> Result<Value> {
        let path = self.rt().paths.secrets_file().to_path_buf();
        let key = args.api_key.trim().to_owned();
        // 保留文件里的其它段,只改 `[llm] api_key`
        crate::runtime::write_secret(
            &path,
            "llm",
            "api_key",
            (!key.is_empty()).then_some(key.as_str()),
        )?;
        tracing::info!(
            provider = %self.rt().config().llm.provider,
            cleared = key.is_empty(),
            "LLM API key 已更新"
        );
        Ok(json!({
            "secret_present": !key.is_empty(),
            "provider": self.rt().config().llm.provider,
        }))
    }

    pub(super) async fn test_llm_impl(&self, args: TestLlmArgs) -> Result<Value> {
        let config = self.rt().config().llm.clone();
        // 没有 key 时 `chat_model` 会返回 mock,测试就失去意义:直接说清楚
        let key_present = crate::runtime::llm_api_key(&self.rt().paths).is_some()
            || kb_service::llm_providers::env_var_of(&config.provider)
                .and_then(|key| std::env::var(key).ok())
                .is_some_and(|value| !value.trim().is_empty())
            || config.provider == "ollama";
        if !key_present {
            return Err(KbError::InvalidInput(
                "当前服务商没有 API key:先保存密钥,或设置对应的环境变量".to_owned(),
            ));
        }
        let model_name = config.agent_model.clone();
        let model = self.chat_model_for(&model_name).await?;
        let request = kb_core::model::ChatRequest {
            model: model.id().to_owned(),
            messages: vec![kb_core::model::ChatMessage {
                role: "user".to_owned(),
                content: Some(
                    args.prompt
                        .filter(|value| !value.trim().is_empty())
                        .unwrap_or_else(|| "用一句话回答:你好".to_owned()),
                ),
                tool_calls: Vec::new(),
                tool_call_id: None,
            }],
            tools: Vec::new(),
            json_output: false,
            thinking: false,
            max_tokens: Some(64),
            temperature: Some(0.2),
        };
        let response =
            tokio::time::timeout(std::time::Duration::from_secs(60), model.chat(request))
                .await
                .map_err(|_| KbError::Unavailable("测试连接超时(60 秒)".to_owned()))??;
        Ok(json!({
            "provider": config.provider,
            "base_url": config.base_url,
            "model": config.extract_model,
            "reply": response.message.content.unwrap_or_default(),
            "input_tokens": response.input_tokens,
            "output_tokens": response.output_tokens,
        }))
    }

    pub(super) async fn llm_providers_impl(&self) -> Result<Value> {
        let config = self.rt().config();
        let secret_present = crate::runtime::llm_api_key(&self.rt().paths).is_some();
        let providers = kb_service::llm_provider_catalog(&config.llm, secret_present, |key| {
            std::env::var(key).ok()
        });
        Ok(json!({
            "providers": providers,
            "current": config.llm.provider,
            "secret_present": secret_present,
            "models": {
                "extract": config.llm.extract_model,
                "review": config.llm.review_model,
                "agent": config.llm.agent_model,
            },
        }))
    }

    pub(super) async fn ocr_status_impl(&self) -> Result<Value> {
        let config = &self.rt().config().extract;
        let backends: Vec<Value> = kb_extract::ocr::backends(config)
            .iter()
            .map(|backend| {
                let availability = backend.detect();
                json!({
                    "id": backend.id(),
                    "ready": availability.is_ready(),
                    "reason": availability.reason(),
                    "current": backend.id() == config.ocr_backend,
                })
            })
            .collect();
        let install = kb_extract::ocr::install_snapshot();
        Ok(json!({
            "enabled": config.ocr_enabled,
            "backend": config.ocr_backend,
            "model_size": config.ocr_model_size,
            "model_dir": config.ocr_model_dir,
            "install_command": config.ocr_install_command,
            "backends": backends,
            "install": install,
        }))
    }

    pub(super) async fn set_ocr_backend_impl(&self, args: SetOcrBackendArgs) -> Result<Value> {
        if !matches!(args.backend.as_str(), "rapidocr" | "tesseract") {
            return Err(KbError::InvalidInput(
                "backend 只能是 rapidocr 或 tesseract".to_owned(),
            ));
        }
        // 走既有的配置更新链路(先校验再原子落盘)
        let mut extract = json!({ "ocr_backend": args.backend });
        if let Some(enabled) = args.enabled {
            extract["ocr_enabled"] = json!(enabled);
        }
        let update = self
            .web()
            .update_config(json!({ "extract": extract }))
            .await?;
        if let Some(hub) = &self.hub {
            hub.publish(
                "item.changed",
                json!({ "action": "config.updated", "changed": update.changed }),
            );
        }
        Ok(json!({
            "backend": args.backend,
            "enabled": args.enabled,
            "applied": update.applied,
            "changed": update.changed,
            "notes": update.notes,
        }))
    }

    pub(super) async fn ocr_install_impl(&self) -> Result<Value> {
        kb_extract::ocr::start_install(&self.rt().config().extract)
            .map_err(KbError::InvalidInput)?;
        Ok(json!({ "started": true, "command": self.rt().config().extract.ocr_install_command }))
    }

    pub(super) async fn provider_list_impl(&self) -> Result<Value> {
        let catalog = self.catalog();
        let (providers, env, warnings) = tokio::task::spawn_blocking(move || {
            let providers = catalog.list();
            let env = catalog.env_profile();
            // 坏掉的后端声明不静默:组件页照常列条目,另外把问题带回去
            let warnings = catalog.backend_warnings();
            (providers, env, warnings)
        })
        .await
        .map_err(|err| KbError::Internal(format!("读取组件列表失败: {err}")))?;
        Ok(json!({
            "providers": providers,
            "env": env,
            "backend_warnings": warnings,
        }))
    }

    pub(super) async fn provider_install_impl(&self, args: ProviderArgs) -> Result<Value> {
        let catalog = self.catalog();
        let provider = catalog
            .list()
            .into_iter()
            .find(|provider| provider.id == args.id && provider.kind.as_str() == args.kind)
            .ok_or_else(|| KbError::NotFound(format!("组件 {}/{}", args.kind, args.id)))?;
        let Some(command) = provider.install_command.clone() else {
            return Err(KbError::InvalidInput(format!(
                "{} 不支持自动安装(改配置即可)",
                provider.id
            )));
        };
        match args.kind.as_str() {
            "ocr" => {
                kb_extract::ocr::start_install(&catalog.config().extract)
                    .map_err(KbError::InvalidInput)?;
            }
            "transcribe" => {
                let mut extract = catalog.config().extract.clone();
                extract.ocr_install_command = command.clone();
                kb_extract::ocr::start_install(&extract).map_err(KbError::InvalidInput)?;
            }
            other => {
                return Err(KbError::InvalidInput(format!("{other} 组件没有安装流程")));
            }
        }
        Ok(json!({ "started": true, "command": command }))
    }

    pub(super) async fn provider_set_default_impl(&self, args: ProviderArgs) -> Result<Value> {
        match args.kind.as_str() {
            "ocr" => {
                let update = self
                    .web()
                    .update_config(json!({ "extract": { "ocr_backend": args.id } }))
                    .await?;
                Ok(json!({ "applied": update.applied, "changed": update.changed }))
            }
            other => Err(KbError::InvalidInput(format!(
                "{other} 组件的默认值只能改配置(暂不支持一键切换)"
            ))),
        }
    }

    pub(super) async fn provider_uninstall_impl(&self, args: ProviderArgs) -> Result<Value> {
        let catalog = self.catalog();
        let provider = catalog
            .list()
            .into_iter()
            .find(|provider| provider.id == args.id && provider.kind.as_str() == args.kind)
            .ok_or_else(|| KbError::NotFound(format!("组件 {}/{}", args.kind, args.id)))?;
        if !provider.removable {
            return Err(KbError::InvalidInput(format!(
                "{} 不支持卸载(嵌入 / 重排走配置)",
                provider.id
            )));
        }
        // 只删模型目录里的 ppocrv6 onnx,不动系统运行时
        let Some(dir) = catalog.model_dir() else {
            return Err(KbError::NotFound("没有配置模型目录".to_owned()));
        };
        let mut removed = 0usize;
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_some_and(|ext| ext == "onnx")
                    && std::fs::remove_file(&path).is_ok()
                {
                    removed += 1;
                }
            }
        }
        Ok(json!({ "removed": removed, "dir": dir.display().to_string() }))
    }

    pub(super) async fn env_profile_impl(&self) -> Result<Value> {
        let catalog = self.catalog();
        let profile = tokio::task::spawn_blocking(move || catalog.env_profile())
            .await
            .map_err(|err| KbError::Internal(format!("读取环境画像失败: {err}")))?;
        Ok(serde_json::to_value(profile)
            .map_err(|err| KbError::Internal(format!("序列化环境画像失败: {err}")))?)
    }

    pub(super) async fn recommend_providers_impl(&self) -> Result<Value> {
        let catalog = self.catalog();
        let recommendations = tokio::task::spawn_blocking(move || catalog.recommend())
            .await
            .map_err(|err| KbError::Internal(format!("生成组件推荐失败: {err}")))?;
        Ok(json!({ "recommendations": recommendations }))
    }
}

impl ServiceBackend {
    /// 组件目录(每次构造都很轻)。
    fn catalog(&self) -> kb_service::providers::ProviderCatalog {
        kb_service::providers::ProviderCatalog::new(
            self.rt().config().as_ref().clone(),
            self.rt().paths.clone(),
        )
    }
}
