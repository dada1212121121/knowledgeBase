/// :数据源与解析队列。
///
/// 与 `register_web` 一样只在 Web 面可见:MCP 的工具是固定的对外契约。
use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.list_sources().await }
        })
    };
    registry.register(Capability {
        name: "list_sources",
        description: "列出数据源(类型、目标集合、文件数、状态、上次同步)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AddSourceArgs| {
            let backend = backend.clone();
            async move { backend.add_source(args).await }
        })
    };
    registry.register(Capability {
        name: "add_source",
        description: "添加数据源(本地目录 / Git 仓库 / 网页 / 手写笔记)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<AddSourceArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: UpdateSourceArgs| {
                let backend = backend.clone();
                async move { backend.update_source(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "update_source",
        description: "修改数据源(名称、目标集合、标签、include/exclude、抓取规则)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<UpdateSourceArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ItemIdArgs| {
            let backend = backend.clone();
            async move { backend.remove_source(args).await }
        })
    };
    registry.register(Capability {
        name: "remove_source",
        description: "移除数据源,并清掉它索引出来的块、向量与文件",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ItemIdArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: ItemIdArgs| {
            let backend = backend.clone();
            async move { backend.sync_source(&ctx, args).await }
        })
    };
    registry.register(Capability {
        name: "sync_source",
        description: "同步数据源(扫描 / 克隆 / 重新入队),返回批次与解析任务",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ItemIdArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ListIngestArgs| {
            let backend = backend.clone();
            async move { backend.list_ingest(args).await }
        })
    };
    registry.register(Capability {
        name: "list_ingest",
        description: "分页列出解析队列(状态、块数、耗时、失败原因)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<ListIngestArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: IngestIdsArgs| {
            let backend = backend.clone();
            async move { backend.retry_ingest(args).await }
        })
    };
    registry.register(Capability {
        name: "retry_ingest",
        description: "把失败 / 隔离的文件重新入队(不重新上传)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<IngestIdsArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ItemIdArgs| {
            let backend = backend.clone();
            async move { backend.release_quarantine(args).await }
        })
    };
    registry.register(Capability {
        name: "release_quarantine",
        description: "把隔离的文件放回解析队列",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ItemIdArgs>(),
        handler,
    });
}
