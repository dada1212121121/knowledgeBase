use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.list_collections().await }
        })
    };
    registry.register(Capability {
        name: "list_collections",
        description: "列出全部 collection(名称、种类、embedder、行数)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.list_projects().await }
        })
    };
    registry.register(Capability {
        name: "list_projects",
        description: "列出已注册的项目(根目录、块数、上次索引时间)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: AddProjectArgs| {
            let backend = backend.clone();
            async move { backend.add_project(args).await }
        })
    };
    registry.register(Capability {
        name: "add_project",
        description: "注册一个项目目录(同时创建它的 collection)",
        permission: Permission::Govern,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<AddProjectArgs>(),
        handler,
    });
}
