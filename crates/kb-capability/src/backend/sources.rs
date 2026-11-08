//! 数据源:source 的增删改与同步、导入与隔离区,以及重跑阶段。
//!
//! 见 [`super::CapabilityBackend`](CapabilityBackend)。

use super::*;

#[async_trait]
pub trait SourcesBackend: Send + Sync {
    /// 刷新到点的外部资料。
    async fn refresh_sources(&self, args: crate::defs::RefreshSourcesArgs) -> Result<Value>;

    /// 列出数据源。
    async fn list_sources(&self) -> Result<Value>;

    /// 添加数据源。
    async fn add_source(&self, args: crate::defs::AddSourceArgs) -> Result<Value>;

    /// 修改数据源。
    async fn update_source(&self, args: crate::defs::UpdateSourceArgs) -> Result<Value>;

    /// 移除数据源。
    async fn remove_source(&self, args: crate::defs::ItemIdArgs) -> Result<Value>;

    /// 同步数据源。
    async fn sync_source(&self, ctx: &CallCtx, args: crate::defs::ItemIdArgs) -> Result<Value>;

    /// 列出解析队列。
    async fn list_ingest(&self, args: crate::defs::ListIngestArgs) -> Result<Value>;

    /// 重试失败 / 隔离的文件。
    async fn retry_ingest(&self, args: crate::defs::IngestIdsArgs) -> Result<Value>;

    /// 释放隔离。
    async fn release_quarantine(&self, args: crate::defs::ItemIdArgs) -> Result<Value>;
    // --- :批次流水线进度与暂停 / 继续 / 取消 ---

    /// 把文件或目录导入 `_global`。
    async fn import_global(&self, args: crate::defs::ImportGlobalArgs) -> Result<Value>;
}
