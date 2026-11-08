//! `CapabilityBackend` 的转发层:签名照抄 trait,实现体按域放在同级文件里。
//!
//! 这一层不做任何判断 —— 每个 trait 方法一对一交给同名的 `<name>_impl`,
//! 于是「能力签名」与「实现落在哪个域」互不影响。

use crate::capability_backend::*;

#[async_trait]
impl SearchBackend for ServiceBackend {
    async fn search(&self, ctx: &CallCtx, args: SearchArgs) -> Result<Value> {
        self.search_impl(ctx, args).await
    }

    async fn get_item(&self, args: GetItemArgs) -> Result<Value> {
        self.get_item_impl(args).await
    }

    async fn list_collections(&self) -> Result<Value> {
        self.list_collections_impl().await
    }

    async fn list_projects(&self) -> Result<Value> {
        self.list_projects_impl().await
    }

    async fn add_project(&self, args: AddProjectArgs) -> Result<Value> {
        self.add_project_impl(args).await
    }

    async fn update_project(&self, args: UpdateProjectArgs) -> Result<Value> {
        self.update_project_impl(args).await
    }

    async fn remove_project(&self, args: ProjectNameArgs) -> Result<Value> {
        self.remove_project_impl(args).await
    }

    async fn item_facets(&self, args: ItemFacetsArgs) -> Result<Value> {
        self.item_facets_impl(args).await
    }

    async fn save_insight(&self, ctx: &CallCtx, args: SaveInsightArgs) -> Result<Value> {
        self.save_insight_impl(ctx, args).await
    }

    async fn kb_feedback(&self, args: FeedbackArgs) -> Result<Value> {
        self.kb_feedback_impl(args).await
    }

    async fn reindex_project(&self, args: ReindexArgs) -> Result<Value> {
        self.reindex_project_impl(args).await
    }

    async fn set_item_status(&self, args: SetStatusArgs) -> Result<Value> {
        self.set_item_status_impl(args).await
    }

    async fn supersede_insight(&self, args: SupersedeArgs) -> Result<Value> {
        self.supersede_insight_impl(args).await
    }

    async fn item_history(&self, args: ItemIdArgs) -> Result<Value> {
        self.item_history_impl(args).await
    }

    // --- :Web 管理端 ---

    async fn list_items(&self, args: ListItemsArgs) -> Result<Value> {
        self.list_items_impl(args).await
    }

    async fn edit_item(&self, ctx: &CallCtx, args: EditItemArgs) -> Result<Value> {
        self.edit_item_impl(ctx, args).await
    }

    async fn create_item(&self, ctx: &CallCtx, args: CreateItemArgs) -> Result<Value> {
        self.create_item_impl(ctx, args).await
    }

    async fn delete_item(&self, ctx: &CallCtx, args: ItemIdArgs) -> Result<Value> {
        self.delete_item_impl(ctx, args).await
    }

    async fn batch_tag(&self, ctx: &CallCtx, args: BatchTagArgs) -> Result<Value> {
        self.batch_tag_impl(ctx, args).await
    }

    async fn stats_overview(&self) -> Result<Value> {
        self.stats_overview_impl().await
    }

    async fn deep_search(&self, ctx: &CallCtx, args: DeepSearchArgs) -> Result<Value> {
        self.deep_search_impl(ctx, args).await
    }

    async fn delete_collection(&self, args: CollectionArgs) -> Result<Value> {
        self.delete_collection_impl(args).await
    }

    // --- :数据源与解析队列 ---
}

#[async_trait]
impl DocsBackend for ServiceBackend {
    async fn doc_links(&self, args: DocLinksArgs) -> Result<Value> {
        self.doc_links_impl(args).await
    }

    async fn file_preview(&self, args: FilePreviewArgs) -> Result<Value> {
        self.file_preview_impl(args).await
    }

    async fn file_raw(&self, args: FileRawArgs) -> Result<Value> {
        self.file_raw_impl(args).await
    }

    async fn check_links(&self, args: CheckLinksArgs) -> Result<Value> {
        self.check_links_impl(args).await
    }

    async fn doc_read(&self, args: kb_capability::defs::DocReadArgs) -> Result<Value> {
        self.doc_read_impl(args).await
    }

    async fn doc_edit(
        &self,
        ctx: &CallCtx,
        args: kb_capability::defs::DocEditArgs,
    ) -> Result<Value> {
        self.doc_edit_impl(ctx, args).await
    }

    async fn doc_proposals(&self, args: kb_capability::defs::DocProposalsArgs) -> Result<Value> {
        self.doc_proposals_impl(args).await
    }

    async fn doc_proposal_decide(
        &self,
        ctx: &CallCtx,
        args: kb_capability::defs::DocProposalDecideArgs,
    ) -> Result<Value> {
        self.doc_proposal_decide_impl(ctx, args).await
    }

    async fn csv_read(&self, args: CsvReadArgs) -> Result<Value> {
        self.csv_read_impl(args).await
    }

    async fn csv_edit(&self, args: CsvEditArgs) -> Result<Value> {
        self.csv_edit_impl(args).await
    }

    async fn file_versions(&self, args: FileVersionsArgs) -> Result<Value> {
        self.file_versions_impl(args).await
    }

    async fn file_info(&self, args: kb_capability::defs::FileInfoArgs) -> Result<Value> {
        self.file_info_impl(args).await
    }

    async fn edit_sheet_cells(
        &self,
        args: kb_capability::defs::EditSheetCellsArgs,
    ) -> Result<Value> {
        self.edit_sheet_cells_impl(args).await
    }

    /// 某一版版本的全文。二进制版本存的是备份标记、没有文字,`binary` 置 true、`body` 留空。
    async fn file_version(&self, args: FileVersionArgs) -> Result<Value> {
        self.file_version_impl(args).await
    }

    async fn restore_file_version(&self, args: RestoreVersionArgs) -> Result<Value> {
        self.restore_file_version_impl(args).await
    }

    async fn add_annotation(&self, args: AddAnnotationArgs) -> Result<Value> {
        self.add_annotation_impl(args).await
    }

    async fn resolve_annotation(
        &self,
        args: kb_capability::defs::ResolveAnnotationArgs,
    ) -> Result<Value> {
        self.resolve_annotation_impl(args).await
    }

    async fn list_annotations(&self, args: ListAnnotationsArgs) -> Result<Value> {
        self.list_annotations_impl(args).await
    }

    async fn delete_annotation(&self, args: ItemIdArgs) -> Result<Value> {
        self.delete_annotation_impl(args).await
    }

    async fn convert_to_markdown(&self, args: ConvertMarkdownArgs) -> Result<Value> {
        self.convert_to_markdown_impl(args).await
    }
}

#[async_trait]
impl FilesBackend for ServiceBackend {
    async fn list_files(&self, args: ListFilesArgs) -> Result<Value> {
        self.list_files_impl(args).await
    }

    async fn save_file(&self, args: SaveFileArgs) -> Result<Value> {
        self.save_file_impl(args).await
    }

    async fn file_actions(&self, args: FileActionsArgs) -> Result<Value> {
        self.file_actions_impl(args).await
    }

    async fn delete_file(&self, args: DeleteFileArgs) -> Result<Value> {
        self.delete_file_impl(args).await
    }

    async fn delete_folder(&self, args: DeleteFolderArgs) -> Result<Value> {
        self.delete_folder_impl(args).await
    }

    async fn move_file(&self, args: MoveFileArgs) -> Result<Value> {
        self.move_file_impl(args).await
    }

    async fn move_files(&self, args: MoveFilesArgs) -> Result<Value> {
        self.move_files_impl(args).await
    }

    async fn move_folder(&self, args: MoveFolderArgs) -> Result<Value> {
        self.move_folder_impl(args).await
    }

    async fn file_op_status(&self, args: FileOpIdArgs) -> Result<Value> {
        self.file_op_status_impl(args).await
    }

    async fn list_trash(&self, args: ListTrashArgs) -> Result<Value> {
        self.list_trash_impl(args).await
    }

    async fn restore_trash(&self, args: TrashIdArgs) -> Result<Value> {
        self.restore_trash_impl(args).await
    }

    async fn purge_trash(&self, args: TrashIdArgs) -> Result<Value> {
        self.purge_trash_impl(args).await
    }

    async fn get_file_timeline(&self, args: ItemIdArgs) -> Result<Value> {
        self.get_file_timeline_impl(args).await
    }
}

#[async_trait]
impl JobsBackend for ServiceBackend {
    async fn migrate_model(&self, args: MigrateArgs) -> Result<Value> {
        self.migrate_model_impl(args).await
    }

    async fn migrate_plan(&self, args: MigrateArgs) -> Result<Value> {
        self.migrate_plan_impl(args).await
    }

    async fn install_hooks(&self, args: HooksArgs) -> Result<Value> {
        self.install_hooks_impl(args).await
    }

    async fn uninstall_hooks(&self, args: HooksArgs) -> Result<Value> {
        self.uninstall_hooks_impl(args).await
    }

    async fn job_list(&self, args: JobListArgs) -> Result<Value> {
        self.job_list_impl(args).await
    }

    async fn job_stats(&self, args: kb_capability::defs::JobStatsArgs) -> Result<Value> {
        self.job_stats_impl(args).await
    }

    async fn ingest_stats(&self, args: kb_capability::defs::IngestStatsArgs) -> Result<Value> {
        self.ingest_stats_impl(args).await
    }

    async fn project_file_stats(&self) -> Result<Value> {
        self.project_file_stats_impl().await
    }

    async fn audit_stats(&self, args: kb_capability::defs::ActivitySeriesArgs) -> Result<Value> {
        self.audit_stats_impl(args).await
    }

    async fn activity_series(
        &self,
        args: kb_capability::defs::ActivitySeriesArgs,
    ) -> Result<Value> {
        self.activity_series_impl(args).await
    }

    async fn job_get(&self, args: JobIdArgs) -> Result<Value> {
        self.job_get_impl(args).await
    }

    async fn job_files(&self, args: JobFilesArgs) -> Result<Value> {
        self.job_files_impl(args).await
    }

    async fn job_cancel(&self, args: JobIdArgs) -> Result<Value> {
        self.job_cancel_impl(args).await
    }

    async fn eval_run(&self, args: EvalRunArgs) -> Result<Value> {
        self.eval_run_impl(args).await
    }

    async fn eval_history(&self, args: EvalHistoryArgs) -> Result<Value> {
        self.eval_history_impl(args).await
    }

    async fn audit_list(&self, args: AuditListArgs) -> Result<Value> {
        self.audit_list_impl(args).await
    }

    async fn batch_list(&self, args: PageArgs) -> Result<Value> {
        self.batch_list_impl(args).await
    }

    async fn revert_batch(&self, args: BatchIdArgs) -> Result<Value> {
        self.revert_batch_impl(args).await
    }

    async fn get_batch_progress(&self, args: BatchArgs) -> Result<Value> {
        self.get_batch_progress_impl(args).await
    }

    async fn pause_batch(&self, args: BatchArgs) -> Result<Value> {
        self.pause_batch_impl(args).await
    }

    async fn resume_batch(&self, args: BatchArgs) -> Result<Value> {
        self.resume_batch_impl(args).await
    }

    async fn cancel_batch(&self, args: BatchArgs) -> Result<Value> {
        self.cancel_batch_impl(args).await
    }

    async fn retry_file_stage(&self, args: RetryStageArgs) -> Result<Value> {
        self.retry_file_stage_impl(args).await
    }

    async fn skip_file(&self, args: ItemIdArgs) -> Result<Value> {
        self.skip_file_impl(args).await
    }

    async fn quarantine_file(&self, args: ItemIdArgs) -> Result<Value> {
        self.quarantine_file_impl(args).await
    }
}

#[async_trait]
impl SourcesBackend for ServiceBackend {
    async fn import_global(&self, args: ImportGlobalArgs) -> Result<Value> {
        self.import_global_impl(args).await
    }

    async fn refresh_sources(&self, args: RefreshSourcesArgs) -> Result<Value> {
        self.refresh_sources_impl(args).await
    }

    async fn list_sources(&self) -> Result<Value> {
        self.list_sources_impl().await
    }

    async fn add_source(&self, args: AddSourceArgs) -> Result<Value> {
        self.add_source_impl(args).await
    }

    async fn update_source(&self, args: UpdateSourceArgs) -> Result<Value> {
        self.update_source_impl(args).await
    }

    async fn remove_source(&self, args: ItemIdArgs) -> Result<Value> {
        self.remove_source_impl(args).await
    }

    async fn sync_source(&self, ctx: &CallCtx, args: ItemIdArgs) -> Result<Value> {
        self.sync_source_impl(ctx, args).await
    }

    async fn list_ingest(&self, args: ListIngestArgs) -> Result<Value> {
        self.list_ingest_impl(args).await
    }

    async fn retry_ingest(&self, args: IngestIdsArgs) -> Result<Value> {
        self.retry_ingest_impl(args).await
    }

    async fn release_quarantine(&self, args: ItemIdArgs) -> Result<Value> {
        self.release_quarantine_impl(args).await
    }

    // --- :批次流水线 ---
}

#[async_trait]
impl OpsBackend for ServiceBackend {
    async fn set_llm_key(&self, args: SetLlmKeyArgs) -> Result<Value> {
        self.set_llm_key_impl(args).await
    }

    async fn test_llm(&self, args: TestLlmArgs) -> Result<Value> {
        self.test_llm_impl(args).await
    }

    async fn dedup_insights(&self, args: DedupArgs) -> Result<Value> {
        self.dedup_insights_impl(args).await
    }

    async fn llm_providers(&self) -> Result<Value> {
        self.llm_providers_impl().await
    }

    async fn tune_retrieval(&self, args: TuneRetrievalArgs) -> Result<Value> {
        self.tune_retrieval_impl(args).await
    }

    async fn quality_report(&self, args: QualityReportArgs) -> Result<Value> {
        self.quality_report_impl(args).await
    }

    async fn consolidate_project(&self, args: ConsolidateArgs) -> Result<Value> {
        self.consolidate_project_impl(args).await
    }

    async fn ocr_status(&self) -> Result<Value> {
        self.ocr_status_impl().await
    }

    async fn set_ocr_backend(&self, args: SetOcrBackendArgs) -> Result<Value> {
        self.set_ocr_backend_impl(args).await
    }

    async fn ocr_install(&self) -> Result<Value> {
        self.ocr_install_impl().await
    }

    async fn provider_list(&self) -> Result<Value> {
        self.provider_list_impl().await
    }

    async fn provider_install(&self, args: ProviderArgs) -> Result<Value> {
        self.provider_install_impl(args).await
    }

    async fn provider_set_default(&self, args: ProviderArgs) -> Result<Value> {
        self.provider_set_default_impl(args).await
    }

    async fn provider_uninstall(&self, args: ProviderArgs) -> Result<Value> {
        self.provider_uninstall_impl(args).await
    }

    async fn env_profile(&self) -> Result<Value> {
        self.env_profile_impl().await
    }

    async fn recommend_providers(&self) -> Result<Value> {
        self.recommend_providers_impl().await
    }

    async fn index_stats(&self) -> Result<Value> {
        self.index_stats_impl().await
    }

    async fn maintain_indexes(&self, args: MaintainIndexesArgs) -> Result<Value> {
        self.maintain_indexes_impl(args).await
    }

    async fn system_status(&self) -> Result<Value> {
        self.system_status_impl().await
    }

    async fn backup_status(&self) -> Result<Value> {
        self.backup_status_impl().await
    }

    async fn backup_state(&self) -> Result<Value> {
        self.backup_state_impl().await
    }

    async fn backup_verify(&self, args: BackupVerifyArgs) -> Result<Value> {
        self.backup_verify_impl(args).await
    }

    async fn backup_create(&self, args: BackupCreateArgs) -> Result<Value> {
        self.backup_create_impl(args).await
    }

    async fn backup_delete(&self, args: BackupDeleteArgs) -> Result<Value> {
        self.backup_delete_impl(args).await
    }

    async fn backup_prune(&self, args: BackupPruneArgs) -> Result<Value> {
        self.backup_prune_impl(args).await
    }

    async fn get_config(&self) -> Result<Value> {
        self.get_config_impl().await
    }

    async fn update_config(&self, args: UpdateConfigArgs) -> Result<Value> {
        self.update_config_impl(args).await
    }

    async fn reload_config(&self) -> Result<Value> {
        self.reload_config_impl().await
    }

    async fn create_token(&self, args: CreateTokenArgs) -> Result<Value> {
        self.create_token_impl(args).await
    }

    async fn revoke_token(&self, args: TokenIdArgs) -> Result<Value> {
        self.revoke_token_impl(args).await
    }
}

#[async_trait]
impl AgentBackend for ServiceBackend {
    async fn agent_sessions(&self, args: AgentSessionsArgs) -> Result<Value> {
        self.agent_sessions_impl(args).await
    }

    async fn agent_compress(&self, args: AgentCompressArgs) -> Result<Value> {
        self.agent_compress_impl(args).await
    }

    async fn agent_rename_session(&self, args: AgentRenameSessionArgs) -> Result<Value> {
        self.agent_rename_session_impl(args).await
    }

    async fn acp_agents(&self) -> Result<Value> {
        self.acp_agents_impl().await
    }

    async fn acp_save_agent(&self, args: AcpSaveAgentArgs) -> Result<Value> {
        self.acp_save_agent_impl(args).await
    }

    async fn acp_remove_agent(&self, args: AcpAgentIdArgs) -> Result<Value> {
        self.acp_remove_agent_impl(args).await
    }

    async fn acp_set_permission(&self, args: AcpPermissionArgs) -> Result<Value> {
        self.acp_set_permission_impl(args).await
    }

    async fn acp_install(&self, args: AcpAgentIdArgs) -> Result<Value> {
        self.acp_install_impl(args).await
    }

    async fn acp_uninstall(&self, args: AcpAgentIdArgs) -> Result<Value> {
        self.acp_uninstall_impl(args).await
    }

    async fn acp_set_default(&self, args: AcpDefaultArgs) -> Result<Value> {
        self.acp_set_default_impl(args).await
    }

    async fn acp_set_sandbox(&self, args: AcpSandboxArgs) -> Result<Value> {
        self.acp_set_sandbox_impl(args).await
    }

    async fn acp_permission(&self, args: AcpPermissionDecisionArgs) -> Result<Value> {
        self.acp_permission_impl(args).await
    }

    async fn acp_test(&self, args: AcpAgentIdArgs) -> Result<Value> {
        self.acp_test_impl(args).await
    }

    async fn acp_chat(&self, args: AcpChatArgs) -> Result<Value> {
        self.acp_chat_impl(args).await
    }

    async fn acp_cancel(&self, args: AcpCancelArgs) -> Result<Value> {
        self.acp_cancel_impl(args).await
    }

    async fn context_estimate(&self, args: ContextEstimateArgs) -> Result<Value> {
        self.context_estimate_impl(args).await
    }

    async fn apply_context(&self, args: ApplyContextArgs) -> Result<Value> {
        self.apply_context_impl(args).await
    }

    async fn agent_pin_session(&self, args: AgentPinSessionArgs) -> Result<Value> {
        self.agent_pin_session_impl(args).await
    }

    async fn agent_delete_session(&self, args: AgentDeleteSessionArgs) -> Result<Value> {
        self.agent_delete_session_impl(args).await
    }

    async fn agent_send(&self, args: AgentSendArgs) -> Result<Value> {
        self.agent_send_impl(args).await
    }

    async fn ai_write(&self, args: AiWriteArgs) -> Result<Value> {
        self.ai_write_impl(args).await
    }

    async fn agent_confirm(&self, args: AgentConfirmArgs) -> Result<Value> {
        self.agent_confirm_impl(args).await
    }

    async fn agent_history(&self, ctx: &CallCtx, args: AgentHistoryArgs) -> Result<Value> {
        self.agent_history_impl(ctx, args).await
    }
}

#[async_trait]
impl SkillsBackend for ServiceBackend {
    async fn list_skills(&self) -> Result<Value> {
        self.list_skills_impl().await
    }

    async fn list_drafts(&self, _ctx: &CallCtx, args: ListDraftsArgs) -> Result<Value> {
        self.list_drafts_impl(_ctx, args).await
    }

    async fn review_draft(&self, ctx: &CallCtx, args: ReviewDraftArgs) -> Result<Value> {
        self.review_draft_impl(ctx, args).await
    }

    async fn reload_skills(&self) -> Result<Value> {
        self.reload_skills_impl().await
    }

    async fn get_skill(&self, args: kb_capability::defs::SkillIdArgs) -> Result<Value> {
        self.get_skill_impl(args).await
    }

    async fn save_skill(&self, args: kb_capability::defs::SaveSkillArgs) -> Result<Value> {
        self.save_skill_impl(args).await
    }

    async fn list_official_plugins(&self) -> Result<Value> {
        self.list_official_plugins_impl().await
    }

    async fn install_official_plugin(
        &self,
        args: kb_capability::defs::OfficialPluginArgs,
    ) -> Result<Value> {
        self.install_official_plugin_impl(args).await
    }

    async fn uninstall_official_plugin(
        &self,
        args: kb_capability::defs::OfficialPluginArgs,
    ) -> Result<Value> {
        self.uninstall_official_plugin_impl(args).await
    }

    async fn set_skill_enabled(
        &self,
        args: kb_capability::defs::SetSkillEnabledArgs,
    ) -> Result<Value> {
        self.set_skill_enabled_impl(args).await
    }

    async fn get_plugin(&self, args: kb_capability::defs::SkillIdArgs) -> Result<Value> {
        self.get_plugin_impl(args).await
    }

    async fn save_plugin(&self, args: kb_capability::defs::SavePluginArgs) -> Result<Value> {
        self.save_plugin_impl(args).await
    }

    async fn delete_skill(&self, args: kb_capability::defs::SkillIdArgs) -> Result<Value> {
        self.delete_skill_impl(args).await
    }
}
