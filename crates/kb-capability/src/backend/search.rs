//! 检索与条目:「用户问一句、拿到一条」这件事的入口:查、取单条、项目清单、条目增删改、洞察与反馈。
//!
//! 见 [`super::CapabilityBackend`](CapabilityBackend)。

use super::*;

#[async_trait]
pub trait SearchBackend: Send + Sync {
    /// 检索知识 / 代码。
    async fn search(&self, ctx: &CallCtx, args: crate::defs::SearchArgs) -> Result<Value>;

    /// 按 id 取一条记录(可带上下文行)。
    async fn get_item(&self, args: crate::defs::GetItemArgs) -> Result<Value>;

    /// 列出 collection。
    async fn list_collections(&self) -> Result<Value>;

    /// 列出项目。
    async fn list_projects(&self) -> Result<Value>;

    /// 注册项目。
    async fn add_project(&self, args: crate::defs::AddProjectArgs) -> Result<Value>;

    /// 保存一条 insight。
    async fn save_insight(
        &self,
        ctx: &CallCtx,
        args: crate::defs::SaveInsightArgs,
    ) -> Result<Value>;

    /// 记录反馈。
    async fn kb_feedback(&self, args: crate::defs::FeedbackArgs) -> Result<Value>;

    /// 重新索引项目。
    async fn reindex_project(&self, args: crate::defs::ReindexArgs) -> Result<Value>;

    /// 改条目状态。
    async fn set_item_status(&self, args: crate::defs::SetStatusArgs) -> Result<Value>;

    /// 用一条 insight 取代另一条。
    async fn supersede_insight(&self, args: crate::defs::SupersedeArgs) -> Result<Value>;

    /// 条目的演进链。
    async fn item_history(&self, args: crate::defs::ItemIdArgs) -> Result<Value>;
    // --- :Web 管理端 ---

    /// 分页列出条目。
    async fn list_items(&self, args: crate::defs::ListItemsArgs) -> Result<Value>;

    /// 编辑条目(insight 走乐观锁;代码 / 文档块只能改标签)。
    async fn edit_item(&self, ctx: &CallCtx, args: crate::defs::EditItemArgs) -> Result<Value>;

    /// 新建一条经验。
    async fn create_item(&self, ctx: &CallCtx, args: crate::defs::CreateItemArgs) -> Result<Value>;

    /// 删除一条经验。
    async fn delete_item(&self, ctx: &CallCtx, args: crate::defs::ItemIdArgs) -> Result<Value>;

    /// 批量打 / 去标签。
    async fn batch_tag(&self, ctx: &CallCtx, args: crate::defs::BatchTagArgs) -> Result<Value>;

    /// 仪表盘概览。
    async fn stats_overview(&self) -> Result<Value>;

    /// 深度检索。
    async fn deep_search(&self, ctx: &CallCtx, args: crate::defs::DeepSearchArgs) -> Result<Value>;

    /// 删除 collection。
    async fn delete_collection(&self, args: crate::defs::CollectionArgs) -> Result<Value>;
    // --- :数据源与解析队列 ---

    /// 修改项目配置。
    async fn update_project(&self, args: crate::defs::UpdateProjectArgs) -> Result<Value>;

    /// 移除项目(连同 collection、派生数据与物理表)。
    async fn remove_project(&self, args: crate::defs::ProjectNameArgs) -> Result<Value>;

    /// 按种类统计 collection 的条目数。
    async fn item_facets(&self, args: crate::defs::ItemFacetsArgs) -> Result<Value>;
}
