use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: SearchArgs| {
            let backend = backend.clone();
            // 不要在这里补默认 kinds:它会被拼成 ` kind:code kind:doc kind:insight` 追加到查询串,
            // 把用户自己写的 `kind:` 前缀稀释掉。默认值交给 SearchService 在“没有任何 kind 过滤”时用。
            async move { backend.search(&ctx, args).await }
        })
    };
    registry.register(Capability {
        name: "search_knowledge",
        description: "检索知识与代码(混合检索:全文 + 向量,支持 kind:/path:/status: 等前缀)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<SearchArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, mut args: SearchArgs| {
            let backend = backend.clone();
            async move {
                args.kinds = vec!["code".to_owned()];
                backend.search(&ctx, args).await
            }
        })
    };
    registry.register(Capability {
        name: "search_code",
        description: "只在代码块里检索(等价于 search_knowledge 加 kind:code)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<SearchArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: GetItemArgs| {
            let backend = backend.clone();
            async move { backend.get_item(args).await }
        })
    };
    registry.register(Capability {
        name: "get_item",
        description: "按 id 取一条记录;可选带上源文件上下文行(edges / history 尚未接入)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<GetItemArgs>(),
        handler,
    });
}
