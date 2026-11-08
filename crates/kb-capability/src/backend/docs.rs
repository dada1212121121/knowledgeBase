//! 文档与表格:长文档的读写、AI 修改建议与批注,以及表格(CSV / sheet)与文件内容的读取。
//!
//! 见 [`super::CapabilityBackend`](CapabilityBackend)。

use super::*;

#[async_trait]
pub trait DocsBackend: Send + Sync {
    /// 读一个文件 / 一篇笔记现在的内容。默认不可用:只有真实后端实现。
    async fn doc_read(&self, _args: crate::defs::DocReadArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文档读取没有启用".to_owned()))
    }

    /// AI 改一个文件 / 一篇笔记:建议或直接改。
    async fn doc_edit(&self, _ctx: &CallCtx, _args: crate::defs::DocEditArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文档修改没有启用".to_owned()))
    }

    /// 一个文档上的修改建议。
    async fn doc_proposals(&self, _args: crate::defs::DocProposalsArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("修改建议没有启用".to_owned()))
    }

    /// 接受 / 拒绝一条修改建议。
    async fn doc_proposal_decide(
        &self,
        _ctx: &CallCtx,
        _args: crate::defs::DocProposalDecideArgs,
    ) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("修改建议没有启用".to_owned()))
    }

    /// 查一篇文档 / 笔记的出链与入链。
    async fn doc_links(&self, _args: crate::defs::DocLinksArgs) -> Result<Value> {
        Err(KbError::Unavailable("这个后端没有链接图谱能力".to_owned()))
    }

    /// 一个文件的结构化预览(块 + anchor + 块列表), 的预览面板用。
    async fn file_preview(&self, args: crate::defs::FilePreviewArgs) -> Result<Value>;

    /// 版本历史。
    async fn csv_read(&self, args: crate::defs::CsvReadArgs) -> Result<Value>;

    async fn csv_edit(&self, args: crate::defs::CsvEditArgs) -> Result<Value>;

    async fn file_versions(&self, args: crate::defs::FileVersionsArgs) -> Result<Value>;

    /// 恢复到某一版。
    async fn restore_file_version(&self, args: crate::defs::RestoreVersionArgs) -> Result<Value>;

    /// 某一版版本的完整正文(`file_versions` 只给预览;对比要全文)。
    async fn file_version(&self, args: crate::defs::FileVersionArgs) -> Result<Value>;

    /// 新建批注。
    async fn add_annotation(&self, args: crate::defs::AddAnnotationArgs) -> Result<Value>;

    /// 标记 / 取消评论的已解决状态。
    async fn resolve_annotation(&self, args: crate::defs::ResolveAnnotationArgs) -> Result<Value>;

    /// 某个文件的批注。
    async fn list_annotations(&self, args: crate::defs::ListAnnotationsArgs) -> Result<Value>;

    /// 删除批注(连同它的检索记录)。
    async fn delete_annotation(&self, args: crate::defs::ItemIdArgs) -> Result<Value>;
    // --- :文件删除 / 移动 / 回收站 ---

    /// 转 Markdown 副本。
    async fn convert_to_markdown(&self, args: crate::defs::ConvertMarkdownArgs) -> Result<Value>;

    /// 文件当前内容的 sha256 / 大小(xlsx 还给公式格)。
    async fn file_info(&self, args: crate::defs::FileInfoArgs) -> Result<Value>;

    /// 改 Excel 单元格的值。
    async fn edit_sheet_cells(&self, args: crate::defs::EditSheetCellsArgs) -> Result<Value>;

    /// 解析文件原件的绝对路径与类型(预览页读图片 / 音频用)。
    async fn file_raw(&self, args: defs::FileRawArgs) -> Result<Value>;

    /// 体检正文里的文件引用(不返回内容;默认不可用,测试里的假后端不用跟着改)。
    async fn check_links(&self, _args: defs::CheckLinksArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("链接体检没有启用".to_owned()))
    }
}
