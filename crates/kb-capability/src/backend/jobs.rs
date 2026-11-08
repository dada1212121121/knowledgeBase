//! 任务与批次:任务队列、批次进度、迁移与 hook 安装:运维视角的「后台在干什么」。
//!
//! 见 [`super::CapabilityBackend`](CapabilityBackend)。

use super::*;

#[async_trait]
pub trait JobsBackend: Send + Sync {
    /// 换模型迁移(入队,返回 `job_id`)。
    async fn migrate_model(&self, args: crate::defs::MigrateArgs) -> Result<Value>;

    /// 换模型迁移的估算(只读)。
    async fn migrate_plan(&self, args: crate::defs::MigrateArgs) -> Result<Value>;

    /// 安装 git hook。
    async fn install_hooks(&self, args: crate::defs::HooksArgs) -> Result<Value>;

    /// 卸载 git hook。
    async fn uninstall_hooks(&self, args: crate::defs::HooksArgs) -> Result<Value>;

    /// 列出任务。
    async fn job_list(&self, args: crate::defs::JobListArgs) -> Result<Value>;

    /// 取一个任务。
    async fn job_get(&self, args: crate::defs::JobIdArgs) -> Result<Value>;

    /// 一个任务处理过的文件(任务详情「改动的文件」)。默认不可用:只有真实后端实现。
    async fn job_files(&self, _args: crate::defs::JobFilesArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable(
            "任务文件明细没有启用".to_owned(),
        ))
    }

    /// 任务统计(任务页的指标卡与图表)。默认不可用:只有真实后端实现,测试里的假后端不用跟着改。
    async fn job_stats(&self, _args: crate::defs::JobStatsArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("任务统计没有启用".to_owned()))
    }

    /// 按天的活动计数(笔记、编辑、导入、检索、完成的任务、模型 token),首页 / 系统概览的趋势图用。默认不可用,同上。
    async fn activity_series(&self, _args: crate::defs::ActivitySeriesArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("活动统计没有启用".to_owned()))
    }

    /// 导入概况(导入页的状态分布、每小时导入量、失败原因)。默认不可用,同上。
    async fn ingest_stats(&self, _args: crate::defs::IngestStatsArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("导入统计没有启用".to_owned()))
    }

    /// 每个项目里文件的状态分布(项目页)。默认不可用,同上。
    async fn project_file_stats(&self) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("文件统计没有启用".to_owned()))
    }

    /// 审计概况(审计页的调用时段热力、最常用的能力)。默认不可用,同上。
    async fn audit_stats(&self, _args: crate::defs::ActivitySeriesArgs) -> Result<Value> {
        Err(kb_core::KbError::Unavailable("审计统计没有启用".to_owned()))
    }

    /// 取消一个任务。
    async fn job_cancel(&self, args: crate::defs::JobIdArgs) -> Result<Value>;

    /// 跑一次黄金集评测。
    async fn eval_run(&self, args: crate::defs::EvalRunArgs) -> Result<Value>;

    /// 审计列表。
    async fn audit_list(&self, args: crate::defs::AuditListArgs) -> Result<Value>;

    /// 批次列表。
    async fn batch_list(&self, args: crate::defs::PageArgs) -> Result<Value>;

    /// 撤销一个批次。
    async fn revert_batch(&self, args: crate::defs::BatchIdArgs) -> Result<Value>;

    /// 批次进度。
    async fn get_batch_progress(&self, args: crate::defs::BatchArgs) -> Result<Value>;

    /// 暂停批次。
    async fn pause_batch(&self, args: crate::defs::BatchArgs) -> Result<Value>;

    /// 继续批次。
    async fn resume_batch(&self, args: crate::defs::BatchArgs) -> Result<Value>;

    /// 取消批次。
    async fn cancel_batch(&self, args: crate::defs::BatchArgs) -> Result<Value>;

    /// 从某个阶段重跑一个文件。
    async fn retry_file_stage(&self, args: crate::defs::RetryStageArgs) -> Result<Value>;

    /// 跳过一个文件。
    async fn skip_file(&self, args: crate::defs::ItemIdArgs) -> Result<Value>;

    /// 把文件移入隔离。
    async fn quarantine_file(&self, args: crate::defs::ItemIdArgs) -> Result<Value>;
    // --- :项目编辑与评测历史 ---

    /// 历次评测结果。
    async fn eval_history(&self, args: crate::defs::EvalHistoryArgs) -> Result<Value>;
}
