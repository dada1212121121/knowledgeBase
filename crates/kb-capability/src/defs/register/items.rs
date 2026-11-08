//! 条目本身:增删改、批量打标签、标签与统计聚合。

use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ListItemsArgs| {
            let backend = backend.clone();
            async move { backend.list_items(args).await }
        })
    };
    registry.register(Capability {
 name: "list_items",
 description: "分页列出某个 collection 的条目(可按键种类 / 状态 / 标签 / 路径前缀 / 关键词过滤)",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<ListItemsArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: EditItemArgs| {
            let backend = backend.clone();
            async move { backend.edit_item(&ctx, args).await }
        })
    };
    registry.register(Capability {
 name: "edit_item",
 description: "编辑条目:insight 可改标题 / 正文 / 标签 / 种类(改完重新嵌入);代码 / 文档块只能改标签",
 permission: Permission::Write,
 surfaces: WEB_AGENT,
 side_effect: true,
 input_schema: schema::<EditItemArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: CreateItemArgs| {
            let backend = backend.clone();
            async move { backend.create_item(&ctx, args).await }
        })
    };
    registry.register(Capability {
        name: "create_item",
        description: "新建一条经验条目(嵌入是异步任务)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<CreateItemArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: ItemIdArgs| {
            let backend = backend.clone();
            async move { backend.delete_item(&ctx, args).await }
        })
    };
    registry.register(Capability {
        name: "delete_item",
        description: "删除一条经验条目(代码 / 文档块由源文件派生,拒绝单独删除)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ItemIdArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: BatchTagArgs| {
            let backend = backend.clone();
            async move { backend.batch_tag(&ctx, args).await }
        })
    };
    registry.register(Capability {
        name: "batch_tag",
        description: "一次给多条打 / 去标签(整批可撤销)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<BatchTagArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.stats_overview().await }
        })
    };
    registry.register(Capability {
        name: "stats_overview",
        description: "仪表盘概览:各 collection 行数、任务队列、待审草稿、模型状态、最近事件",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ItemFacetsArgs| {
            let backend = backend.clone();
            async move { backend.item_facets(args).await }
        })
    };
    registry.register(Capability {
        name: "item_facets",
        description: "按种类统计 collection 的条目数(浏览器页的树形导航用)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<ItemFacetsArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: CollectionArgs| {
            let backend = backend.clone();
            async move { backend.delete_collection(args).await }
        })
    };
    registry.register(Capability {
        name: "delete_collection",
        description: "删除一个 collection(记录与物理表一起删,不可恢复)",
        permission: Permission::Govern,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<CollectionArgs>(),
        handler,
    });
}
