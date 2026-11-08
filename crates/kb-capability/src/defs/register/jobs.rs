use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: JobListArgs| {
            let backend = backend.clone();
            async move { backend.job_list(args).await }
        })
    };
    registry.register(Capability {
        name: "job_list",
        description: "列出任务(分页,运行中和排队的在前;可按状态 / 类型 / collection 筛选)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<JobListArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: JobStatsArgs| {
            let backend = backend.clone();
            async move { backend.job_stats(args).await }
        })
    };
    registry.register(Capability {
 name: "job_stats",
 description: "任务统计:各状态数量、近 24 小时完成 / 失败、排队最久的、完成任务的用时分布;带 range 时还有随时间变化的序列",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<JobStatsArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: IngestStatsArgs| {
            let backend = backend.clone();
            async move { backend.ingest_stats(args).await }
        })
    };
    registry.register(Capability {
 name: "ingest_stats",
 description: "导入概况:各状态的文件数、最近每小时进来 / 成功 / 失败的文件数、失败原因 Top 5",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<IngestStatsArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: ActivitySeriesArgs| {
                let backend = backend.clone();
                async move { backend.audit_stats(args).await }
            },
        )
    };
    registry.register(Capability {
 name: "audit_stats",
 description: "审计概况:最近几天按「周几 × 几点」数的调用次数,和最常用的能力(不含页面自动刷新用的读取)",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<ActivitySeriesArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.project_file_stats().await }
        })
    };
    registry.register(Capability {
        name: "project_file_stats",
        description: "每个项目里文件的状态分布:进了库的、二进制、被排除、太大、生成文件各多少",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: ActivitySeriesArgs| {
                let backend = backend.clone();
                async move { backend.activity_series(args).await }
            },
        )
    };
    registry.register(Capability {
 name: "activity_series",
 description: "最近若干天每天的活动:新建笔记、编辑、导入文件、检索次数、完成的任务、云端模型 token",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<ActivitySeriesArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: JobGetArgs| {
            let backend = backend.clone();
            async move {
                let brief = args.brief;
                let found = backend.job_get(JobIdArgs { id: args.id }).await?;
                Ok(if brief { brief_job(found) } else { found })
            }
        })
    };
    registry.register(Capability {
        name: "job_get",
        description: "按 id 取一个任务(brief=true 时任务参数和检查点只给摘要)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<JobGetArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: JobFilesArgs| {
            let backend = backend.clone();
            async move { backend.job_files(args).await }
        })
    };
    registry.register(Capability {
 name: "job_files",
 description: "一个任务处理过的文件清单:每个文件的变化(新增/更新/只改元数据/删除/失败)、写入块数、失败原因",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<JobFilesArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: JobIdArgs| {
            let backend = backend.clone();
            async move { backend.job_cancel(args).await }
        })
    };
    registry.register(Capability {
        name: "job_cancel",
        description: "取消一个还在排队的任务",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<JobIdArgs>(),
        handler,
    });
}
