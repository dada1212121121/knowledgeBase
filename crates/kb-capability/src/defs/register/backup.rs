//! 备份:建、验、删、按策略清理,以及状态查询。

use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.backup_status().await }
        })
    };
    registry.register(Capability {
 name: "backup_status",
 description: "备份状态:已有归档、各部分磁盘占用、打包进度、失败告警、异地副本、最近一次自动校验、备份范围与恢复方式说明",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<EmptyArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, _args: EmptyArgs| {
            let backend = backend.clone();
            async move { backend.backup_state().await }
        })
    };
    registry.register(Capability {
        name: "backup_state",
        description: "备份的轻量状态:正在打包的进度与未解决的失败告警(不统计磁盘占用)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<EmptyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: BackupVerifyArgs| {
                let backend = backend.clone();
                async move { backend.backup_verify(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "backup_verify",
        description: "校验一份备份归档(gzip / tar 结构、manifest 与 meta.db;只读,恢复前先跑)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<BackupVerifyArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: BackupCreateArgs| {
                let backend = backend.clone();
                async move { backend.backup_create(args).await }
            },
        )
    };
    registry.register(Capability {
 name: "backup_create",
 description: "新建一份备份(元数据库 + 配置 + skills + 评测数据;原件可选),按 [backup] mirror_dirs 复制到异地目录(回读比对 sha256),写完自动校验一次",
 permission: Permission::Write,
 surfaces: WEB_AGENT,
 side_effect: true,
 input_schema: schema::<BackupCreateArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: BackupDeleteArgs| {
                let backend = backend.clone();
                async move { backend.backup_delete(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "backup_delete",
        description: "删除一份备份归档",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<BackupDeleteArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: BackupPruneArgs| {
            let backend = backend.clone();
            async move { backend.backup_prune(args).await }
        })
    };
    registry.register(Capability {
 name: "backup_prune",
 description: "按 [backup] 的保留策略清理旧备份(最新一份永远保留,异地副本一并删;删不掉的会进备份告警)",
 permission: Permission::Write,
 surfaces: WEB_AGENT,
 side_effect: true,
 input_schema: schema::<BackupPruneArgs>(),
 handler,
 });
}
