//! 文件操作:移动 / 删除 / 回收站 —— 破坏性操作只在 Web 面开放,单独一档也便于审权限。
//!
//! 见 [`super::CapabilityBackend`](CapabilityBackend)。

use super::*;

#[async_trait]
pub trait FilesBackend: Send + Sync {
    /// 分页列出某个 collection 里的文件 / 模板(写笔记时挑引用目标)。
    ///
    /// 默认实现给测试桩用:真正提供文件浏览的后端(kb-cli)覆盖它。
    async fn list_files(&self, _args: crate::defs::ListFilesArgs) -> Result<Value> {
        Err(KbError::Unavailable("这个后端没有文件浏览能力".to_owned()))
    }

    /// 保存一次文本编辑。
    async fn save_file(&self, args: crate::defs::SaveFileArgs) -> Result<Value>;

    /// 问一个文件 / 文件夹能不能删、能不能移动(默认不可用,只有真实后端实现)。
    async fn file_actions(&self, _args: crate::defs::FileActionsArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件操作没有启用".to_owned()))
    }

    /// 删除单个文件。
    async fn delete_file(&self, _args: crate::defs::DeleteFileArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件操作没有启用".to_owned()))
    }

    /// 删除文件夹。
    async fn delete_folder(&self, _args: crate::defs::DeleteFolderArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件操作没有启用".to_owned()))
    }

    /// 移动单个文件。
    async fn move_file(&self, _args: crate::defs::MoveFileArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件操作没有启用".to_owned()))
    }

    /// 批量移动文件。
    async fn move_files(&self, _args: crate::defs::MoveFilesArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件操作没有启用".to_owned()))
    }

    /// 移动文件夹。
    async fn move_folder(&self, _args: crate::defs::MoveFolderArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件操作没有启用".to_owned()))
    }

    /// 查一次文件操作的进度。
    async fn file_op_status(&self, _args: crate::defs::FileOpIdArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件操作没有启用".to_owned()))
    }

    /// 列回收站。
    async fn list_trash(&self, _args: crate::defs::ListTrashArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件操作没有启用".to_owned()))
    }

    /// 从回收站恢复。
    async fn restore_trash(&self, _args: crate::defs::TrashIdArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件操作没有启用".to_owned()))
    }

    /// 彻底删除回收站条目。
    async fn purge_trash(&self, _args: crate::defs::TrashIdArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件操作没有启用".to_owned()))
    }

    /// 单文件的阶段时间线。
    async fn get_file_timeline(&self, args: crate::defs::ItemIdArgs) -> Result<Value>;
}
