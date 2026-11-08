//! 文件与文档:预览 / 原文、CSV / 表格编辑、版本、批注、转 markdown。

use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    registry.register(Capability {
        name: "list_files",
        description: "分页列出某个 collection 里的文件和模板(引用选择器用;可按目录 / 关键词过滤)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<ListFilesArgs>(),
        handler: {
            let backend = backend.clone();
            typed(move |_ctx: crate::invoke::CallCtx, args: ListFilesArgs| {
                let backend = backend.clone();
                async move { backend.list_files(args).await }
            })
        },
    });
    registry.register(Capability {
        name: "doc_links",
        description: "查一篇文档 / 笔记的出链与入链(谁引用了我、我引用了谁)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<DocLinksArgs>(),
        handler: {
            let backend = backend.clone();
            typed(move |_ctx: crate::invoke::CallCtx, args: DocLinksArgs| {
                let backend = backend.clone();
                async move { backend.doc_links(args).await }
            })
        },
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: FilePreviewArgs| {
            let backend = backend.clone();
            async move { backend.file_preview(args).await }
        })
    };
    registry.register(Capability {
        name: "file_preview",
        description: "一个文件的结构化预览(块 + 位置锚点 + 块列表),浏览器页按格式渲染",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<FilePreviewArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: FileRawArgs| {
            let backend = backend.clone();
            async move { backend.file_raw(args).await }
        })
    };
    registry.register(Capability {
        name: "file_raw",
        description: "解析一个文件的原件位置(给预览页的图片 / 音频用;只返回路径与类型,不返回内容)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<FileRawArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: CheckLinksArgs| {
            let backend = backend.clone();
            async move { backend.check_links(args).await }
        })
    };
    registry.register(Capability {
        name: "check_links",
        description: "体检正文里的文件引用(在不在、大小、类型;一次最多 200 条,不返回内容)",
        permission: Permission::Read,
        surfaces: MCP_ALL,
        side_effect: false,
        input_schema: schema::<CheckLinksArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: SaveFileArgs| {
            let backend = backend.clone();
            async move { backend.save_file(args).await }
        })
    };
    registry.register(Capability {
        name: "save_file",
        description: "保存一次文本编辑(带乐观锁;只重嵌入变化的块,并生成一个版本)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<SaveFileArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: CsvReadArgs| {
            let backend = backend.clone();
            async move { backend.csv_read(args).await }
        })
    };
    registry.register(Capability {
 name: "csv_read",
 description: "读一页 CSV / TSV 表格,连同文件的编码、分隔符、行尾、内容哈希和版本号(表格编辑用)",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<CsvReadArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: FileInfoArgs| {
            let backend = backend.clone();
            async move { backend.file_info(args).await }
        })
    };
    registry.register(Capability {
 name: "file_info",
 description: "文件当前内容的 sha256 与大小;.xlsx 还返回每张工作表的公式格(编辑表格 / 上传新版本前取,用来做乐观锁)",
 permission: Permission::Read,
 surfaces: WEB_AGENT,
 side_effect: false,
 input_schema: schema::<FileInfoArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: CsvEditArgs| {
            let backend = backend.clone();
            async move { backend.csv_edit(args).await }
        })
    };
    registry.register(Capability {
 name: "csv_edit",
 description: "改 CSV / TSV 表格:改格子、插入或删除行。保持原来的编码、分隔符、引号和换行,没改的字节原样不动;带乐观锁,只重嵌入改动的块,并生成一个版本",
 permission: Permission::Write,
 surfaces: WEB_AGENT,
 side_effect: true,
 input_schema: schema::<CsvEditArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: EditSheetCellsArgs| {
                let backend = backend.clone();
                async move { backend.edit_sheet_cells(args).await }
            },
        )
    };
    registry.register(Capability {
 name: "edit_sheet_cells",
 description: "改 Excel(.xlsx)里若干单元格的值:公式、图片、图表、样式和其它格子原样保留,公式格不能改;保存成新的一版并重新索引",
 permission: Permission::Write,
 surfaces: WEB_AGENT,
 side_effect: true,
 input_schema: schema::<EditSheetCellsArgs>(),
 handler,
 });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: FileVersionsArgs| {
                let backend = backend.clone();
                async move { backend.file_versions(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "file_versions",
        description: "一个文件的版本历史(新 → 旧)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<FileVersionsArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: RestoreVersionArgs| {
                let backend = backend.clone();
                async move { backend.restore_file_version(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "restore_file_version",
        description: "恢复到某一版(恢复本身产生新版本,可再撤销)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<RestoreVersionArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: FileVersionArgs| {
            let backend = backend.clone();
            async move { backend.file_version(args).await }
        })
    };
    registry.register(Capability {
        name: "file_version",
        description: "某一版版本的完整正文(历史版本对比用)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<FileVersionArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: AddAnnotationArgs| {
                let backend = backend.clone();
                async move { backend.add_annotation(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "add_annotation",
        description: "给文件加一条批注(锚定到页 / 单元格 / 幻灯片 / 时间点,同时进入检索)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<AddAnnotationArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: ResolveAnnotationArgs| {
                let backend = backend.clone();
                async move { backend.resolve_annotation(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "resolve_annotation",
        description: "把一条评论标记为已解决(或取消);只有顶层评论可以标记,回复跟着它走",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ResolveAnnotationArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: ListAnnotationsArgs| {
                let backend = backend.clone();
                async move { backend.list_annotations(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "list_annotations",
        description: "某个文件的批注(新 → 旧)",
        permission: Permission::Read,
        surfaces: WEB_AGENT,
        side_effect: false,
        input_schema: schema::<ListAnnotationsArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: ItemIdArgs| {
            let backend = backend.clone();
            async move { backend.delete_annotation(args).await }
        })
    };
    registry.register(Capability {
        name: "delete_annotation",
        description: "删除一条批注(连同它的检索记录)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ItemIdArgs>(),
        handler,
    });
    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: ConvertMarkdownArgs| {
                let backend = backend.clone();
                async move { backend.convert_to_markdown(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "convert_to_markdown",
        description: "把 Office / PDF 转成 Markdown 副本并入库(副本与原件用 derived_from 关联)",
        permission: Permission::Write,
        surfaces: WEB_AGENT,
        side_effect: true,
        input_schema: schema::<ConvertMarkdownArgs>(),
        handler,
    });
}
