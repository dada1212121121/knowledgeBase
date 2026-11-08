use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = typed(move |_ctx: crate::invoke::CallCtx, args: EvalRunArgs| {
        let backend = backend.clone();
        async move { backend.eval_run(args).await }
    });
    registry.register(Capability {
        name: "eval_run",
        description: "用黄金查询集评测检索质量(hit@1 / hit@k / MRR)",
        permission: Permission::Govern,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<EvalRunArgs>(),
        handler,
    });
}
