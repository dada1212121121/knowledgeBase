//! 运维面:检索调参、索引维护、OCR 与嵌入组件的状态与切换、配置、令牌、审计。

use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: TuneRetrievalArgs| {
                let backend = backend.clone();
                async move { backend.tune_retrieval(args).await }
            },
        )
    };
    registry.register(Capability {
 name: "tune_retrieval",
 description: "反馈调权:按 collection 的有用率给出 RRF 权重调整建议(默认 dry_run),确认后写配置并在前后跑一次评测,指标下降自动回滚",
 // 会写 config.toml:与 update_config 同级(Admin),不能借 Write 级令牌绕过配置写权限
 permission: Permission::Admin,
 surfaces: WEB_ONLY,
 side_effect: true,
 input_schema: schema::<TuneRetrievalArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: DedupArgs| {
            let backend = backend.clone();
            async move { backend.dedup_insights(args).await }
        })
    };
    registry.register(Capability {
        name: "dedup_insights",
        description: "条目去重(只用向量相似度,不调用 LLM;默认 dry_run 出计划)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<DedupArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ConsolidateArgs| {
            let backend = backend.clone();
            async move { backend.consolidate_project(args).await }
        })
    };
    registry.register(Capability {
 name: "consolidate_project",
 description: "主题归纳:按向量聚类找出同一主题的条目,交给 LLM 归纳成一条并走审核流程(默认 dry_run 只列主题)",
 permission: Permission::Write,
 surfaces: WEB_AGENT,
 side_effect: true,
 input_schema: schema::<ConsolidateArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: QualityReportArgs| {
                let backend = backend.clone();
                async move { backend.quality_report(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "quality_report",
        description: "质量报告:重复率、过期比例、无关联文件条目、低反馈条目、待审草稿",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<QualityReportArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.ocr_status().await }
        })
    };
    registry.register(Capability {
        name: "ocr_status",
        description: "OCR 后端状态:可用后端、当前选用、运行时与模型是否就绪、安装进度",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: SetOcrBackendArgs| {
                let backend = backend.clone();
                async move { backend.set_ocr_backend(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "set_ocr_backend",
        description: "切换 OCR 后端(rapidocr / tesseract),下一次抽取生效",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<SetOcrBackendArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.ocr_install().await }
        })
    };
    registry.register(Capability {
        name: "ocr_install",
        description: "下载 / 安装 OCR 运行时与模型(后台任务,进度看 ocr_status;失败可重试)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.provider_list().await }
        })
    };
    registry.register(Capability {
        name: "provider_list",
        description: "组件目录:OCR / 转写 / 嵌入 / 重排的安装状态、当前选用与模型信息",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ProviderArgs| {
            let backend = backend.clone();
            async move { backend.provider_install(args).await }
        })
    };
    registry.register(Capability {
        name: "provider_install",
        description: "安装 / 下载一个组件(后台任务,进度看 system_status 或 ocr_status)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ProviderArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ProviderArgs| {
            let backend = backend.clone();
            async move { backend.provider_set_default(args).await }
        })
    };
    registry.register(Capability {
        name: "provider_set_default",
        description: "把某个组件设为默认(下一次抽取生效)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ProviderArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ProviderArgs| {
            let backend = backend.clone();
            async move { backend.provider_uninstall(args).await }
        })
    };
    registry.register(Capability {
        name: "provider_uninstall",
        description: "卸载一个组件(只清模型文件,不动系统运行时)",
        permission: Permission::Govern,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ProviderArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.env_profile().await }
        })
    };
    registry.register(Capability {
        name: "env_profile",
        description: "环境检测:CPU 核数、内存、磁盘可用、GPU、已装的 OCR / 转写命令",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.recommend_providers().await }
        })
    };
    registry.register(Capability {
        name: "recommend_providers",
        description: "按环境给出组件推荐(只推荐,不改配置)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.system_status().await }
        })
    };
    registry.register(Capability {
        name: "system_status",
        description: "系统状态:总览 / 资源 / 组件 / 任务 / 网络 / 日志六块的真实指标",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.index_stats().await }
        })
    };
    registry.register(Capability {
        name: "index_stats",
        description: "每张物理表的实际状况:行数 / 碎片数 / 数据文件数 / 版本数 / 索引覆盖",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: MaintainIndexesArgs| {
                let backend = backend.clone();
                async move { backend.maintain_indexes(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "maintain_indexes",
        description: "现在就整理索引与碎片(全文 / 向量索引 + optimize);不开则在夜间任务里做",
        permission: Permission::Write,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<MaintainIndexesArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: DeepSearchArgs| {
            let backend = backend.clone();
            async move { backend.deep_search(&ctx, args).await }
        })
    };
    registry.register(Capability {
 name: "deep_search",
 description: "深度检索:LLM 最多 4 轮调用 search_knowledge / get_item,给出带 [id] 出处的总结",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: true,
 input_schema: schema::<DeepSearchArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AuditListArgs| {
            let backend = backend.clone();
            async move { backend.audit_list(args).await }
        })
    };
    registry.register(Capability {
        name: "audit_list",
        description: "分页查询审计日志(可按操作者 / 能力 / 时间 / 批次过滤)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<AuditListArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: PageArgs| {
            let backend = backend.clone();
            async move { backend.batch_list(args).await }
        })
    };
    registry.register(Capability {
        name: "batch_list",
        description: "分页列出可撤销的批次(含每条变更的类型与是否可撤销)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<PageArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: BatchIdArgs| {
            let backend = backend.clone();
            async move { backend.revert_batch(args).await }
        })
    };
    registry.register(Capability {
        name: "revert_batch",
        description: "撤销一个批次里的变更(标签改动、insight 编辑 / 新建 / 删除)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<BatchIdArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.get_config().await }
        })
    };
    registry.register(Capability {
        name: "get_config",
        description: "读取当前配置(Web 的设置页按它生成表单)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: UpdateConfigArgs| {
                let backend = backend.clone();
                async move { backend.update_config(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "update_config",
        description: "改配置:先校验再写回 config.toml;涉及 embedder 的改动只返回迁移计划。\
 值为 null 的键表示删除该项(不是写成 null)",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<UpdateConfigArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: SetLlmKeyArgs| {
            let backend = backend.clone();
            async move { backend.set_llm_key(args).await }
        })
    };
    registry.register(Capability {
        name: "set_llm_key",
        description: "保存或清除 LLM 的 API key(写入 secrets.toml,权限 0600;只回是否已设置)",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<SetLlmKeyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: TestLlmArgs| {
            let backend = backend.clone();
            async move { backend.test_llm(args).await }
        })
    };
    registry.register(Capability {
        name: "test_llm",
        description: "用当前配置（服务商 / 地址 / 模型 / 密钥）发一次最小请求，验证连通性",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<TestLlmArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.llm_providers().await }
        })
    };
    registry.register(Capability {
 name: "llm_providers",
 description: "列出 LLM 提供商(名称 / 环境变量 / 地址 / 是否已配置 / 当前模型),只读、不回显密钥",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<EmptyArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.reload_config().await }
        })
    };
    registry.register(Capability {
        name: "reload_config",
        description: "重新读一次 config.toml:可热更新的项立即生效,要重启 / 要先迁移的项如实返回",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: CreateTokenArgs| {
            let backend = backend.clone();
            async move { backend.create_token(args).await }
        })
    };
    registry.register(Capability {
        name: "create_token",
        description: "新建 API 令牌(明文只返回一次)",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<CreateTokenArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: TokenIdArgs| {
            let backend = backend.clone();
            async move { backend.revoke_token(args).await }
        })
    };
    registry.register(Capability {
        name: "revoke_token",
        description: "撤销 API 令牌",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<TokenIdArgs>(),
        handler,
    });
}
