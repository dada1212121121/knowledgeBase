/// AI 读 / 改在线文档:所有能在线编辑的格式一个入口,正在多人编辑时修改实时并进房间。
use super::*;

pub(crate) fn register(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    let handler = {
        let backend = backend.clone();
        typed(move |_ctx: crate::invoke::CallCtx, args: DocReadArgs| {
            let backend = backend.clone();
            async move { backend.doc_read(args).await }
        })
    };
    registry.register(Capability {
 name: "doc_read",
 description: "读一个文件或一篇笔记现在的内容(正在多人编辑时读到的是大家正在改的版本),按行分页。\
 支持笔记、Markdown、代码与文本、CSV / TSV、Word / Excel / PowerPoint;\
 Word 每段一行,PowerPoint 按幻灯片分组,Excel 按工作表、每格写成 `A1=值`。改之前先读,doc_edit 的原文照这里写",
 permission: Permission::Read,
 surfaces: MCP_ALL,
 side_effect: false,
 input_schema: schema::<DocReadArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(move |ctx: crate::invoke::CallCtx, args: DocEditArgs| {
            let backend = backend.clone();
            async move { backend.doc_edit(&ctx, args).await }
        })
    };
    registry.register(Capability {
 name: "doc_edit",
 description: "改一个文件或一篇笔记:1–32 处「把原文换成新文字」,每处原文必须在 doc_read 读到的内容里恰好出现一次,\
 整批生效或整批不生效。默认生成一条修改建议,等人在页面上接受;系统参数开了「AI 直接修改」时直接改。\
 文档正在多人编辑时修改实时出现在每个人的编辑器里,不会覆盖他们刚写的内容;改动进版本历史,可以恢复",
 permission: Permission::Write,
 surfaces: MCP_ALL,
 side_effect: true,
 input_schema: schema::<DocEditArgs>(),
 handler,
 });

    let handler = {
        let backend = backend.clone();
        typed(
            move |_ctx: crate::invoke::CallCtx, args: DocProposalsArgs| {
                let backend = backend.clone();
                async move { backend.doc_proposals(args).await }
            },
        )
    };
    registry.register(Capability {
        name: "doc_proposals",
        description: "一个文件或一篇笔记上 AI 的修改建议(新的在前)",
        permission: Permission::Read,
        surfaces: WEB_ONLY,
        side_effect: false,
        input_schema: schema::<DocProposalsArgs>(),
        handler,
    });

    let handler = {
        let backend = backend.clone();
        typed(
            move |ctx: crate::invoke::CallCtx, args: DocProposalDecideArgs| {
                let backend = backend.clone();
                async move { backend.doc_proposal_decide(&ctx, args).await }
            },
        )
    };
    registry.register(Capability {
 name: "doc_proposal_decide",
 description: "接受或拒绝一条 AI 的修改建议。接受时按文档当时的内容重新定位,定位不到就标成失败、什么都不改",
 permission: Permission::Write,
 // 只给人用:AI 不能自己批准自己的建议
 surfaces: WEB_ONLY,
 side_effect: true,
 input_schema: schema::<DocProposalDecideArgs>(),
 handler,
 });
}
