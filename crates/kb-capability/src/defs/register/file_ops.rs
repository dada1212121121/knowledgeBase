/// 文件删除 / 移动 / 回收站。
///
/// 首版只给 Web 管理面:删除与移动是破坏性操作,不暴露给 MCP 和 AI。
/// 唯一例外是只读的 `file_actions`(Agent 需要它判断一个文件能不能动)。
use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: FileActionsArgs| {
            let backend = backend.clone();
            async move { backend.file_actions(args).await }
        })
    };
    registry.register(Capability {
 name: "file_actions",
 description: "问一个文件 / 文件夹能不能删除、能不能移动,并拿到操作指纹(菜单用它决定按钮状态)",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<FileActionsArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: DeleteFileArgs| {
            let backend = backend.clone();
            async move { backend.delete_file(args).await }
        })
    };
    registry.register(Capability {
 name: "delete_file",
 description: "删除一个文件。上传 / 压缩包副本进回收站 30 天;本地目录 / 项目 / Web / Git 只移除索引,不动磁盘与源站。分享链接与访客不可用",
 permission: Permission::Write,
 surfaces: WEB_ONLY,
 side_effect: true,
 input_schema: schema::<DeleteFileArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: DeleteFolderArgs| {
                let backend = backend.clone();
                async move { backend.delete_folder(args).await }
            },
        )
    };
    registry.register(Capability {
 name: "delete_folder",
 description: "删除一个文件夹及其全部后代文件(按路径段边界匹配),逐个文件按来源处理;部分失败会返回进度",
 permission: Permission::Write,
 surfaces: WEB_ONLY,
 side_effect: true,
 input_schema: schema::<DeleteFolderArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: MoveFileArgs| {
            let backend = backend.clone();
            async move { backend.move_file(args).await }
        })
    };
    registry.register(Capability {
 name: "move_file",
 description: "移动一个上传 / 压缩包里的文件到当前或另一个知识库的目标目录;跨库会迁移版本 / 批注 / 解析队列",
 permission: Permission::Write,
 surfaces: WEB_ONLY,
 side_effect: true,
 input_schema: schema::<MoveFileArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: MoveFilesArgs| {
            let backend = backend.clone();
            async move { backend.move_files(args).await }
        })
    };
    registry.register(Capability {
 name: "move_files",
 description: "把多个文件移动到当前或另一个知识库的同一个目录(最多 500 个);任一失败回滚已移动的部分",
 permission: Permission::Write,
 surfaces: WEB_ONLY,
 side_effect: true,
 input_schema: schema::<MoveFilesArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: MoveFolderArgs| {
            let backend = backend.clone();
            async move { backend.move_folder(args).await }
        })
    };
    registry.register(Capability {
        name: "move_folder",
        description: "移动一个文件夹到当前或另一个知识库(只支持上传 / 压缩包副本);失败回滚",
        permission: Permission::Write,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<MoveFolderArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: FileOpIdArgs| {
            let backend = backend.clone();
            async move { backend.file_op_status(args).await }
        })
    };
    registry.register(Capability {
        name: "file_op_status",
        description: "查一次删除 / 移动 / 恢复 / 彻底删除的进度与失败原因",
        permission: Permission::Read,
        surfaces: WEB_ONLY,
        side_effect: false,
        input_schema: schema::<FileOpIdArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ListTrashArgs| {
            let backend = backend.clone();
            async move { backend.list_trash(args).await }
        })
    };
    registry.register(Capability {
        name: "list_trash",
        description: "列回收站里还没恢复 / 没彻底删除的条目",
        permission: Permission::Read,
        surfaces: WEB_ONLY,
        side_effect: false,
        input_schema: schema::<ListTrashArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: TrashIdArgs| {
            let backend = backend.clone();
            async move { backend.restore_trash(args).await }
        })
    };
    registry.register(Capability {
        name: "restore_trash",
        description: "从回收站恢复一个条目;原路径已有同名文件时返回 409,不覆盖",
        permission: Permission::Write,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<TrashIdArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: TrashIdArgs| {
            let backend = backend.clone();
            async move { backend.purge_trash(args).await }
        })
    };
    registry.register(Capability {
        name: "purge_trash",
        description: "彻底删除一个回收站条目(不可恢复);分享链接与访客不可用",
        permission: Permission::Write,
        surfaces: WEB_ONLY,
        side_effect: true,
        input_schema: schema::<TrashIdArgs>(),
        handler,
    });
}
