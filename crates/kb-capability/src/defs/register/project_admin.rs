/// :项目编辑与评测历史。
use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: UpdateProjectArgs| {
                let backend = backend.clone();
                async move { backend.update_project(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "update_project",
        description: "修改项目的 include / exclude、云端 LLM 与自动提炼开关(可选改完立刻重索引)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<UpdateProjectArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ProjectNameArgs| {
            let backend = backend.clone();
            async move { backend.remove_project(args).await }
        })
    };
    registry.register(Capability {
        name: "remove_project",
        description: "移除项目(连同 collection、派生数据与物理表,不可恢复)",
        permission: Permission::Govern,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ProjectNameArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: ImportGlobalArgs| {
                let backend = backend.clone();
                async move { backend.import_global(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "import_global",
        description: "把一个文件或目录导入 `_global` collection(可带标签)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ImportGlobalArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: EvalHistoryArgs| {
            let backend = backend.clone();
            async move { backend.eval_history(args).await }
        })
    };
    registry.register(Capability {
        name: "eval_history",
        description: "历次评测结果(新的在前)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EvalHistoryArgs>(),
        handler,
    });
}
