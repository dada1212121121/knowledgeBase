use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: SaveInsightArgs| {
            let backend = backend.clone();
            async move { backend.save_insight(&ctx, args).await }
        })
    };
    registry.register(Capability {
        name: "save_insight",
        description: "保存一条经验(背景、结论、涉及的文件);嵌入是异步任务",
        permission: Permission::Write,
        surfaces: MCP_ALL,
        side_effect: true,
        input_schema: schema::<SaveInsightArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: FeedbackArgs| {
            let backend = backend.clone();
            async move { backend.kb_feedback(args).await }
        })
    };
    registry.register(Capability {
        name: "kb_feedback",
        description: "记录一条检索结果反馈(有用 / 无用)",
        permission: Permission::Write,
        surfaces: MCP_WEB,
        side_effect: true,
        input_schema: schema::<FeedbackArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ReindexArgs| {
            let backend = backend.clone();
            async move { backend.reindex_project(args).await }
        })
    };
    registry.register(Capability {
        name: "reindex_project",
        description: "重新索引一个项目(增量或全量)",
        permission: Permission::Write,
        surfaces: MCP_ALL,
        side_effect: true,
        input_schema: schema::<ReindexArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: HooksArgs| {
            let backend = backend.clone();
            async move { backend.install_hooks(args).await }
        })
    };
    registry.register(Capability {
        name: "install_hooks",
        description: "给项目安装链式 git hook(保留原有 hook 的退出码,不阻塞 git)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<HooksArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: MigrateArgs| {
            let backend = backend.clone();
            async move { backend.migrate_plan(args).await }
        })
    };
    registry.register(Capability {
        name: "migrate_plan",
        description: "估算换模型迁移:目标表、需重嵌入的行数、耗时(不改数据)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<MigrateArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: MigrateArgs| {
            let backend = backend.clone();
            async move { backend.migrate_model(args).await }
        })
    };
    registry.register(Capability {
        name: "migrate_model",
        description: "把 collection 迁到新的嵌入模型(入队执行,返回 job_id;进度走 WS 推送)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<MigrateArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: HooksArgs| {
            let backend = backend.clone();
            async move { backend.uninstall_hooks(args).await }
        })
    };
    registry.register(Capability {
        name: "uninstall_hooks",
        description: "卸载项目的 git hook 并恢复原文件",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<HooksArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: SetStatusArgs| {
            let backend = backend.clone();
            async move { backend.set_item_status(args).await }
        })
    };
    registry.register(Capability {
        name: "set_item_status",
        description: "修改条目状态(active / superseded / deprecated)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<SetStatusArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: SupersedeArgs| {
            let backend = backend.clone();
            async move { backend.supersede_insight(args).await }
        })
    };
    registry.register(Capability {
        name: "supersede_insight",
        description: "用一条 insight 取代另一条(旧条目置为 superseded)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<SupersedeArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ItemIdArgs| {
            let backend = backend.clone();
            async move { backend.item_history(args).await }
        })
    };
    registry.register(Capability {
        name: "item_history",
        description: "取一条记录的演进链",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<ItemIdArgs>(),
        handler,
    });
}
