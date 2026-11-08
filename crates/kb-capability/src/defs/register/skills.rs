//! skills 与官方插件:列表、草稿审阅、启停、安装 / 卸载。

use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: RefreshSourcesArgs| {
                let backend = backend.clone();
                async move { backend.refresh_sources(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "refresh_sources",
        description: "刷新到点的外部资料(按数据源的 refresh_minutes;只重嵌入变化的页面)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<RefreshSourcesArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.list_skills().await }
        })
    };
    registry.register(Capability {
        name: "list_skills",
        description: "声明式 skills 的登记信息:目录、脚本类开关、每个 skill 的类型与规则、加载告警",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: ListDraftsArgs| {
            let backend = backend.clone();
            async move { backend.list_drafts(&ctx, args).await }
        })
    };
    registry.register(Capability {
        name: "list_drafts",
        description: "审核收件箱:按状态列自动提炼出的草稿(含审核分数 / 理由 / 证据)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<ListDraftsArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: ReviewDraftArgs| {
            let backend = backend.clone();
            async move { backend.review_draft(&ctx, args).await }
        })
    };
    registry.register(Capability {
 name: "review_draft",
 description: "审核一条草稿:通过(可改标题 / 正文 / 标签,转正成 insight)或驳回(可「不再提炼」)",
 permission: Permission::Write,
 surfaces: WEB_AGENT,
 side_effect: true,
 input_schema: schema::<ReviewDraftArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.reload_skills().await }
        })
    };
    registry.register(Capability {
 name: "reload_skills",
 description: "重新扫描 ~/.kb/skills:加载声明式 skill(loader-rule / prompt / insight-template),返回规则与告警",
 permission: Permission::Admin,
 surfaces: WEB_ONLY,
 side_effect: true,
 input_schema: schema::<EmptyArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.list_official_plugins().await }
        })
    };
    registry.register(Capability {
        name: "list_official_plugins",
        description: "随宿主分发的官方索引插件(Vue / JSON / SQL / SVG / Dart),含是否已安装与版本",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: OfficialPluginArgs| {
                let backend = backend.clone();
                async move { backend.install_official_plugin(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "install_official_plugin",
        description: "安装一个官方索引插件到 <KB_HOME>/skills(可覆盖),装完立即重新加载",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<OfficialPluginArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: OfficialPluginArgs| {
                let backend = backend.clone();
                async move { backend.uninstall_official_plugin(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "uninstall_official_plugin",
        description: "卸载一个官方索引插件(只删确认过的官方目录),删完立即重新加载",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<OfficialPluginArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: SetSkillEnabledArgs| {
                let backend = backend.clone();
                async move { backend.set_skill_enabled(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "set_skill_enabled",
        description: "启用 / 停用一个 skill 或插件(只改 enabled,不重写其它内容),改完立即重新加载",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<SetSkillEnabledArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: SkillIdArgs| {
            let backend = backend.clone();
            async move { backend.get_plugin(args).await }
        })
    };
    registry.register(Capability {
        name: "get_plugin",
        description: "取一个插件的可编辑内容(索引规则、进程命令、脚本文件),设置页点「编辑」时用",
        permission: Permission::Read,
        surfaces: WEB_ONLY,
        side_effect: false,
        input_schema: schema::<SkillIdArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: SavePluginArgs| {
            let backend = backend.clone();
            async move { backend.save_plugin(args).await }
        })
    };
    registry.register(Capability {
 name: "save_plugin",
 description: "新增或修改一个插件:服务端按表单字段生成并校验 manifest.toml 与脚本,保存后立即重新加载",
 permission: Permission::Admin,
 surfaces: WEB_ONLY,
 side_effect: true,
 input_schema: schema::<SavePluginArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: SkillIdArgs| {
            let backend = backend.clone();
            async move { backend.get_skill(args).await }
        })
    };
    registry.register(Capability {
        name: "get_skill",
        description: "取一个 skill 可编辑的完整内容(提示词正文等);设置页点「编辑」时用",
        permission: Permission::Read,
        surfaces: WEB_ONLY,
        side_effect: false,
        input_schema: schema::<SkillIdArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: SaveSkillArgs| {
            let backend = backend.clone();
            async move { backend.save_skill(args).await }
        })
    };
    registry.register(Capability {
 name: "save_skill",
 description: "新增或修改一个声明式 skill(加载规则 / 提示词 / 笔记模板):服务端按表单字段生成并校验 manifest.toml,保存后立即重新加载",
 permission: Permission::Admin,
 surfaces: WEB_ONLY,
 side_effect: true,
 input_schema: schema::<SaveSkillArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: SkillIdArgs| {
            let backend = backend.clone();
            async move { backend.delete_skill(args).await }
        })
    };
    registry.register(Capability {
        name: "delete_skill",
        description: "删除一个 skill(整个目录),删完立即重新加载",
        permission: Permission::Admin,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<SkillIdArgs>(),
        handler,
    });
}
