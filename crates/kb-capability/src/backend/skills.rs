//! skills 与插件:skills 目录里的声明、官方插件安装、草稿审阅。
//!
//! 见 [`super::CapabilityBackend`](CapabilityBackend)。

use super::*;

#[async_trait]
pub trait SkillsBackend: Send + Sync {
    /// 声明式 skills 的登记信息(设置页「Skills」)。
    async fn list_skills(&self) -> Result<Value>;

    /// 列出随宿主分发的官方索引插件,以及它们是否已经装进 skills 目录。
    async fn list_official_plugins(&self) -> Result<Value> {
        Err(kb_core::KbError::Unavailable(
            "当前后端不支持官方插件".to_owned(),
        ))
    }

    /// 安装官方索引插件。
    async fn install_official_plugin(
        &self,
        _args: crate::defs::OfficialPluginArgs,
    ) -> Result<Value> {
        Err(kb_core::KbError::Unavailable(
            "当前后端不支持安装官方插件".to_owned(),
        ))
    }

    /// 卸载官方索引插件。
    async fn uninstall_official_plugin(
        &self,
        _args: crate::defs::OfficialPluginArgs,
    ) -> Result<Value> {
        Err(kb_core::KbError::Unavailable(
            "当前后端不支持卸载官方插件".to_owned(),
        ))
    }

    /// 审核收件箱:列草稿(含审核结论与证据)。
    async fn list_drafts(&self, ctx: &CallCtx, args: crate::defs::ListDraftsArgs) -> Result<Value>;

    /// 审核一条草稿:通过(转正)或驳回(可「不再提炼」)。
    async fn review_draft(
        &self,
        ctx: &CallCtx,
        args: crate::defs::ReviewDraftArgs,
    ) -> Result<Value>;

    /// 重新扫描 `~/.kb/skills`:返回加载到的规则 / 模板与告警。
    async fn reload_skills(&self) -> Result<Value>;

    /// 取一个 skill 可编辑的完整内容(设置页「编辑」)。
    async fn get_skill(&self, args: crate::defs::SkillIdArgs) -> Result<Value>;

    /// 新增 / 修改一个声明式 skill,保存后立即重新加载。
    async fn save_skill(&self, args: crate::defs::SaveSkillArgs) -> Result<Value>;

    /// 删除一个 skill,删完立即重新加载。
    async fn delete_skill(&self, args: crate::defs::SkillIdArgs) -> Result<Value>;

    /// 只切换 skill / 插件的启用状态。
    async fn set_skill_enabled(&self, _args: crate::defs::SetSkillEnabledArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable(
            "当前后端不支持切换 skill 状态".to_owned(),
        ))
    }

    /// 取插件的可编辑内容。
    async fn get_plugin(&self, _args: crate::defs::SkillIdArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable(
            "当前后端不支持插件编辑".to_owned(),
        ))
    }

    /// 新增 / 修改插件。
    async fn save_plugin(&self, _args: crate::defs::SavePluginArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable(
            "当前后端不支持保存插件".to_owned(),
        ))
    }
}
