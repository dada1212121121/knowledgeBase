/// :批次流水线进度与暂停 / 继续 / 取消。
use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: BatchArgs| {
            let backend = backend.clone();
            async move { backend.get_batch_progress(args).await }
        })
    };
    registry.register(Capability {
        name: "get_batch_progress",
        description: "批次流水线进度:7 段阶段计数、块 / 向量数、吞吐与 ETA、正在处理的文件",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<BatchArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ItemIdArgs| {
            let backend = backend.clone();
            async move { backend.get_file_timeline(args).await }
        })
    };
    registry.register(Capability {
        name: "get_file_timeline",
        description: "单个文件的阶段时间线(每段耗时、块数、向量数、失败原因)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<ItemIdArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: BatchArgs| {
            let backend = backend.clone();
            async move { backend.pause_batch(args).await }
        })
    };
    registry.register(Capability {
        name: "pause_batch",
        description: "暂停批次:不再取新文件,在途文件跑完当前阶段后停下",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<BatchArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: BatchArgs| {
            let backend = backend.clone();
            async move { backend.resume_batch(args).await }
        })
    };
    registry.register(Capability {
        name: "resume_batch",
        description: "继续批次:从检查点续跑",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<BatchArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: BatchArgs| {
            let backend = backend.clone();
            async move { backend.cancel_batch(args).await }
        })
    };
    registry.register(Capability {
        name: "cancel_batch",
        description: "取消批次:在途文件回滚,已完成的保留;可选同时撤销整批",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<BatchArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: RetryStageArgs| {
            let backend = backend.clone();
            async move { backend.retry_file_stage(args).await }
        })
    };
    registry.register(Capability {
        name: "retry_file_stage",
        description: "从指定阶段重跑一个文件(不重新上传)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<RetryStageArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ItemIdArgs| {
            let backend = backend.clone();
            async move { backend.skip_file(args).await }
        })
    };
    registry.register(Capability {
        name: "skip_file",
        description: "跳过一个文件(记为 skipped,之后还能重试)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ItemIdArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ItemIdArgs| {
            let backend = backend.clone();
            async move { backend.quarantine_file(args).await }
        })
    };
    registry.register(Capability {
        name: "quarantine_file",
        description: "把一个文件移入隔离",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ItemIdArgs>(),
        handler,
    });
}
