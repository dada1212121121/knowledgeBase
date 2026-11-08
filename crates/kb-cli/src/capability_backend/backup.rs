//! 备份:状态查询,以及把备份进度接进 Web 事件总线。

use crate::capability_backend::*;

#[allow(clippy::needless_question_mark)]
impl ServiceBackend {
    pub(super) async fn backup_status_impl(&self) -> Result<Value> {
        let status = self.backup_service().status()?;
        Ok(serde_json::to_value(status)
            .map_err(|err| KbError::Internal(format!("序列化备份状态失败: {err}")))?)
    }

    pub(super) async fn backup_state_impl(&self) -> Result<Value> {
        let state = self.backup_service().state()?;
        Ok(serde_json::to_value(state)
            .map_err(|err| KbError::Internal(format!("序列化备份状态失败: {err}")))?)
    }

    pub(super) async fn backup_verify_impl(&self, args: BackupVerifyArgs) -> Result<Value> {
        // 校验要把整份归档解压一遍,放到阻塞线程里,别占住请求线程
        let service = self.backup_service();
        let check = tokio::task::spawn_blocking(move || service.verify(&args.name))
            .await
            .map_err(|err| KbError::Internal(format!("校验线程异常: {err}")))??;
        Ok(serde_json::to_value(check)
            .map_err(|err| KbError::Internal(format!("序列化校验结果失败: {err}")))?)
    }

    pub(super) async fn backup_create_impl(&self, args: BackupCreateArgs) -> Result<Value> {
        let options = kb_service::backup::BackupOptions {
            include_sources: args.include_sources,
        };
        let entry = self.backup_service().create(&options).await?;
        Ok(serde_json::to_value(entry)
            .map_err(|err| KbError::Internal(format!("序列化备份结果失败: {err}")))?)
    }

    pub(super) async fn backup_delete_impl(&self, args: BackupDeleteArgs) -> Result<Value> {
        self.backup_service().delete(&args.name)?;
        Ok(json!({ "deleted": args.name }))
    }

    pub(super) async fn backup_prune_impl(&self, args: BackupPruneArgs) -> Result<Value> {
        let report = self.backup_service().prune(args.dry_run)?;
        Ok(serde_json::to_value(report)
            .map_err(|err| KbError::Internal(format!("序列化清理结果失败: {err}")))?)
    }

    pub(super) async fn revert_batch_impl(&self, args: BatchIdArgs) -> Result<Value> {
        let report = self.reverts().revert(&args.batch_id).await?;
        for op in &report.reverted {
            self.publish_item_changed("reverted", &op.target, "");
            // 撤销写回的是笔记正文:正在协作编辑它的人要被请出去重新打开,
            // 否则他们手里的旧内容稍后落地时会把这次撤销覆盖掉
            let key = self.insight_key(&op.target).await;
            self.tell_collab_of_external_write(key).await;
        }
        Ok(serde_json::to_value(report)
            .map_err(|err| KbError::Internal(format!("序列化撤销结果失败: {err}")))?)
    }
}

impl ServiceBackend {
    /// 备份服务:数据库快照走 kb-meta 的 `VACUUM INTO`,其余文件由 kb-service 打包。
    ///
    /// 定时备份与保留策略取当前配置的 `[backup]`(`backup.*` 是热更新项,每次调用重读)。
    /// 有事件中心时挂上观察者:手动备份的进度 / 结果同样推 `backup.progress` 等事件。
    fn backup_service(&self) -> kb_service::backup::BackupService {
        let service = kb_service::backup::BackupService::new(
            self.rt().paths.clone(),
            Arc::new(crate::runtime::MetaDbSnapshot::new(self.rt().meta.clone())),
        )
        // 多用户:账号库和各用户知识库也进备份
        .with_extra_snapshotter(Arc::new(crate::runtime::MetaFileSnapshotter))
        .with_policy(kb_service::backup::BackupPolicy::from_config(
            &self.rt().config().backup,
        ));
        match &self.hub {
            Some(hub) => service.with_observer(Arc::new(HubBackupObserver::new(hub.clone()))),
            None => service,
        }
    }
}
