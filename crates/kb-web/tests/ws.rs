//! `/api/v1/ws` 的端到端测试:握手 → `hello` → 事件转发 → `ping`/`pong`。
//!
//! 没有引入 WebSocket 客户端库:这里手写一个最小的客户端(HTTP/1.1 升级 + 读文本帧),
//! 服务端发往客户端的帧不带掩码,解析起来只有几种长度前缀。

use std::sync::Arc;

use async_trait::async_trait;
use kb_capability::backend::{
    AgentBackend, DocsBackend, FilesBackend, JobsBackend, OpsBackend, SearchBackend, SkillsBackend,
    SourcesBackend,
};
use kb_capability::defs;
use kb_capability::invoke::CallCtx;
use kb_core::Result;
use kb_web::AppState;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 只回固定 JSON 的假后端(WS 测试不关心能力本身)。
struct StubBackend;

#[async_trait]
impl SearchBackend for StubBackend {
    async fn search(&self, _ctx: &CallCtx, _args: defs::SearchArgs) -> Result<Value> {
        Ok(json!({ "hits": [], "scope": [], "query_parsed": {} }))
    }
    async fn get_item(&self, args: defs::GetItemArgs) -> Result<Value> {
        Ok(json!({ "id": args.id }))
    }
    async fn list_collections(&self) -> Result<Value> {
        Ok(json!({ "collections": [] }))
    }
    async fn list_projects(&self) -> Result<Value> {
        Ok(json!({ "projects": [] }))
    }
    async fn add_project(&self, args: defs::AddProjectArgs) -> Result<Value> {
        Ok(json!({ "job_id": "j", "path": args.path }))
    }
    async fn save_insight(&self, _ctx: &CallCtx, args: defs::SaveInsightArgs) -> Result<Value> {
        Ok(json!({ "id": "i", "title": args.title }))
    }
    async fn kb_feedback(&self, args: defs::FeedbackArgs) -> Result<Value> {
        Ok(json!({ "id": 1, "item_id": args.item_id }))
    }
    async fn reindex_project(&self, args: defs::ReindexArgs) -> Result<Value> {
        Ok(json!({ "job_id": "j", "project": args.project }))
    }
    async fn set_item_status(&self, args: defs::SetStatusArgs) -> Result<Value> {
        Ok(json!({ "id": args.id, "status": args.status }))
    }
    async fn supersede_insight(&self, args: defs::SupersedeArgs) -> Result<Value> {
        Ok(json!({ "old_id": args.old_id, "new_id": args.new_id }))
    }
    async fn item_history(&self, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "items": [], "id": args.id }))
    }
    async fn list_items(&self, _args: defs::ListItemsArgs) -> Result<Value> {
        Ok(json!({ "items": [], "total": 0 }))
    }
    async fn edit_item(&self, _ctx: &CallCtx, args: defs::EditItemArgs) -> Result<Value> {
        Ok(json!({ "id": args.id }))
    }
    async fn create_item(&self, _ctx: &CallCtx, args: defs::CreateItemArgs) -> Result<Value> {
        Ok(json!({ "id": "new", "title": args.title }))
    }
    async fn delete_item(&self, _ctx: &CallCtx, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "id": args.id }))
    }
    async fn batch_tag(&self, _ctx: &CallCtx, args: defs::BatchTagArgs) -> Result<Value> {
        Ok(json!({ "updated": args.ids }))
    }
    async fn deep_search(
        &self,
        _ctx: &kb_capability::invoke::CallCtx,
        args: defs::DeepSearchArgs,
    ) -> Result<Value> {
        Ok(json!({ "answer": "", "citations": [], "rounds": 0, "question": args.question }))
    }

    async fn stats_overview(&self) -> Result<Value> {
        Ok(json!({ "collections": [] }))
    }
    async fn delete_collection(&self, args: defs::CollectionArgs) -> Result<Value> {
        Ok(json!({ "deleted": args.collection }))
    }

    // --- :数据源与解析队列(测试桩只回固定形状) ---
    async fn update_project(&self, args: defs::UpdateProjectArgs) -> Result<Value> {
        Ok(json!({ "project": { "name": args.project }, "job_id": null }))
    }
    async fn remove_project(&self, args: defs::ProjectNameArgs) -> Result<Value> {
        Ok(json!({ "removed": args.project }))
    }
    async fn item_facets(&self, _args: defs::ItemFacetsArgs) -> Result<Value> {
        Ok(json!({ "kinds": [] }))
    }
}

#[async_trait]
impl DocsBackend for StubBackend {
    async fn file_preview(&self, args: defs::FilePreviewArgs) -> Result<Value> {
        Ok(
            serde_json::json!({ "collection": args.collection, "path": args.path, "blocks": [], "chunks": [] }),
        )
    }

    async fn csv_read(&self, _args: defs::CsvReadArgs) -> Result<Value> {
        Ok(json!({ "rows": [] }))
    }

    async fn csv_edit(&self, _args: defs::CsvEditArgs) -> Result<Value> {
        Ok(json!({ "changed": false }))
    }

    async fn file_versions(&self, _args: defs::FileVersionsArgs) -> Result<Value> {
        Ok(json!({ "versions": [] }))
    }

    async fn restore_file_version(&self, _args: defs::RestoreVersionArgs) -> Result<Value> {
        Ok(json!({ "version": 2, "embedded": 0 }))
    }

    async fn file_version(&self, _args: defs::FileVersionArgs) -> Result<Value> {
        Ok(json!({ "version": 1, "body": "" }))
    }

    async fn add_annotation(&self, _args: defs::AddAnnotationArgs) -> Result<Value> {
        Ok(json!({ "id": "ann-1", "body": "" }))
    }

    async fn resolve_annotation(&self, _args: defs::ResolveAnnotationArgs) -> Result<Value> {
        Ok(json!({ "annotation": { "id": "ann-1", "resolved_at": 1 } }))
    }

    async fn list_annotations(&self, _args: defs::ListAnnotationsArgs) -> Result<Value> {
        Ok(json!({ "annotations": [] }))
    }

    async fn delete_annotation(&self, _args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "deleted": "" }))
    }

    async fn convert_to_markdown(&self, _args: defs::ConvertMarkdownArgs) -> Result<Value> {
        Ok(json!({ "path": "a.md", "chunks": 1, "images": 0 }))
    }

    async fn file_info(&self, _args: defs::FileInfoArgs) -> Result<Value> {
        Ok(json!({ "sha256": "", "size": 0 }))
    }
    async fn edit_sheet_cells(&self, _args: defs::EditSheetCellsArgs) -> Result<Value> {
        Ok(json!({ "version": 2 }))
    }
    async fn file_raw(&self, _args: defs::FileRawArgs) -> Result<Value> {
        Ok(json!({ "path": "/tmp/a.png", "name": "a.png", "size": 1, "mime": "image/png" }))
    }
}

#[async_trait]
impl FilesBackend for StubBackend {
    async fn save_file(&self, _args: defs::SaveFileArgs) -> Result<Value> {
        Ok(json!({ "version": 1, "embedded": 0 }))
    }

    async fn get_file_timeline(&self, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "file": { "id": args.id }, "stages": [] }))
    }
}

#[async_trait]
impl JobsBackend for StubBackend {
    async fn migrate_model(&self, args: defs::MigrateArgs) -> Result<Value> {
        Ok(json!({ "collection": args.collection, "to": args.to }))
    }
    async fn migrate_plan(&self, args: defs::MigrateArgs) -> Result<Value> {
        Ok(json!({ "collection": args.collection, "to": args.to }))
    }
    async fn install_hooks(&self, _args: defs::HooksArgs) -> Result<Value> {
        Ok(json!({}))
    }
    async fn uninstall_hooks(&self, _args: defs::HooksArgs) -> Result<Value> {
        Ok(json!({}))
    }
    async fn job_list(&self, _args: defs::JobListArgs) -> Result<Value> {
        Ok(json!({ "jobs": [] }))
    }
    async fn job_get(&self, args: defs::JobIdArgs) -> Result<Value> {
        Ok(json!({ "job": { "id": args.id } }))
    }
    async fn job_cancel(&self, args: defs::JobIdArgs) -> Result<Value> {
        Ok(json!({ "job_id": args.id }))
    }
    async fn eval_run(&self, _args: defs::EvalRunArgs) -> Result<Value> {
        Ok(json!({ "hit_at_1": 1.0 }))
    }
    async fn audit_list(&self, _args: defs::AuditListArgs) -> Result<Value> {
        Ok(json!({ "entries": [], "total": 0 }))
    }
    async fn batch_list(&self, _args: defs::PageArgs) -> Result<Value> {
        Ok(json!({ "batches": [], "total": 0 }))
    }
    async fn revert_batch(&self, args: defs::BatchIdArgs) -> Result<Value> {
        Ok(json!({ "batch_id": args.batch_id }))
    }
    async fn get_batch_progress(&self, args: defs::BatchArgs) -> Result<Value> {
        Ok(json!({ "batch": args.batch, "stage": "chunk", "done": 0, "total": 0 }))
    }
    async fn pause_batch(&self, args: defs::BatchArgs) -> Result<Value> {
        Ok(json!({ "batch": args.batch, "state": "paused" }))
    }
    async fn resume_batch(&self, args: defs::BatchArgs) -> Result<Value> {
        Ok(json!({ "batch": args.batch, "state": "running" }))
    }
    async fn cancel_batch(&self, args: defs::BatchArgs) -> Result<Value> {
        Ok(json!({ "batch": args.batch, "revert": args.revert }))
    }
    async fn retry_file_stage(&self, args: defs::RetryStageArgs) -> Result<Value> {
        Ok(json!({ "file": { "id": args.id }, "from_stage": args.stage }))
    }
    async fn skip_file(&self, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "file": { "id": args.id } }))
    }
    async fn quarantine_file(&self, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "file": { "id": args.id } }))
    }

    // --- :项目编辑与评测历史 ---
    async fn eval_history(&self, _args: defs::EvalHistoryArgs) -> Result<Value> {
        Ok(json!({ "runs": [] }))
    }
}

#[async_trait]
impl SourcesBackend for StubBackend {
    async fn refresh_sources(&self, args: defs::RefreshSourcesArgs) -> Result<Value> {
        Ok(json!({ "attempted": 0, "dry_run": args.dry_run }))
    }

    async fn list_sources(&self) -> Result<Value> {
        Ok(json!({ "sources": [] }))
    }
    async fn add_source(&self, args: defs::AddSourceArgs) -> Result<Value> {
        Ok(json!({ "source": { "kind": args.kind, "collection": args.collection } }))
    }
    async fn update_source(&self, args: defs::UpdateSourceArgs) -> Result<Value> {
        Ok(json!({ "source": { "id": args.id } }))
    }
    async fn remove_source(&self, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "id": args.id }))
    }
    async fn sync_source(&self, _ctx: &CallCtx, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "source": { "id": args.id }, "queued": 0 }))
    }
    async fn list_ingest(&self, _args: defs::ListIngestArgs) -> Result<Value> {
        Ok(json!({ "files": [], "total": 0 }))
    }
    async fn retry_ingest(&self, _args: defs::IngestIdsArgs) -> Result<Value> {
        Ok(json!({ "requeued": [] }))
    }
    async fn release_quarantine(&self, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "file": { "id": args.id } }))
    }

    // --- :批次流水线(测试桩只回固定形状) ---
    async fn import_global(&self, args: defs::ImportGlobalArgs) -> Result<Value> {
        Ok(json!({ "scanned": 0, "chunks": 0, "embedded": 0, "errors": [], "path": args.path }))
    }
}

#[async_trait]
impl OpsBackend for StubBackend {
    async fn dedup_insights(&self, _args: defs::DedupArgs) -> Result<Value> {
        Ok(json!({ "pairs": [], "dry_run": true }))
    }

    async fn quality_report(&self, _args: defs::QualityReportArgs) -> Result<Value> {
        Ok(json!({ "active": 0, "duplicates": 0 }))
    }

    async fn consolidate_project(&self, args: defs::ConsolidateArgs) -> Result<Value> {
        Ok(json!({ "project": args.project, "clusters": [], "dry_run": args.dry_run }))
    }

    async fn ocr_status(&self) -> Result<Value> {
        Ok(json!({ "backend": "rapidocr", "backends": [] }))
    }

    async fn set_ocr_backend(&self, args: defs::SetOcrBackendArgs) -> Result<Value> {
        Ok(json!({ "backend": args.backend }))
    }

    async fn ocr_install(&self) -> Result<Value> {
        Ok(json!({ "started": true }))
    }

    async fn provider_list(&self) -> Result<Value> {
        Ok(json!({ "providers": [], "env": {} }))
    }

    async fn provider_install(&self, args: defs::ProviderArgs) -> Result<Value> {
        Ok(json!({ "started": true, "id": args.id }))
    }

    async fn provider_set_default(&self, args: defs::ProviderArgs) -> Result<Value> {
        Ok(json!({ "applied": true, "id": args.id }))
    }

    async fn provider_uninstall(&self, args: defs::ProviderArgs) -> Result<Value> {
        Ok(json!({ "removed": 0, "id": args.id }))
    }

    async fn env_profile(&self) -> Result<Value> {
        Ok(json!({ "cpu_cores": 4 }))
    }

    async fn recommend_providers(&self) -> Result<Value> {
        Ok(json!({ "recommendations": [] }))
    }

    async fn system_status(&self) -> Result<Value> {
        Ok(json!({ "overview": {}, "components": [] }))
    }

    async fn backup_status(&self) -> Result<Value> {
        Ok(json!({ "entries": [], "usage": {}, "notes": [] }))
    }
    async fn backup_state(&self) -> Result<Value> {
        Ok(json!({ "running": null, "alert": null, "failures": [] }))
    }
    async fn backup_verify(&self, args: defs::BackupVerifyArgs) -> Result<Value> {
        Ok(json!({ "name": args.name, "files": 3 }))
    }
    async fn backup_create(&self, args: defs::BackupCreateArgs) -> Result<Value> {
        Ok(json!({ "name": "kb-stub.tar.gz", "includes_sources": args.include_sources }))
    }
    async fn backup_delete(&self, args: defs::BackupDeleteArgs) -> Result<Value> {
        Ok(json!({ "deleted": args.name }))
    }

    async fn backup_prune(&self, args: defs::BackupPruneArgs) -> Result<Value> {
        Ok(json!({ "removed": [], "dry_run": args.dry_run }))
    }

    async fn get_config(&self) -> Result<Value> {
        Ok(json!({}))
    }
    async fn update_config(&self, args: defs::UpdateConfigArgs) -> Result<Value> {
        Ok(json!({ "applied": true, "patch": args.patch }))
    }
    async fn reload_config(&self) -> Result<Value> {
        Ok(json!({ "applied": true, "hot": [], "restart_required": [] }))
    }
    async fn tune_retrieval(&self, _args: defs::TuneRetrievalArgs) -> Result<Value> {
        Ok(json!({ "suggestions": [], "skipped": ["没有反馈"] }))
    }
    async fn llm_providers(&self) -> Result<Value> {
        Ok(json!({ "providers": [], "current": "deepseek", "secret_present": false }))
    }
    async fn create_token(&self, args: defs::CreateTokenArgs) -> Result<Value> {
        Ok(json!({ "id": "t", "name": args.name }))
    }
    async fn revoke_token(&self, args: defs::TokenIdArgs) -> Result<Value> {
        Ok(json!({ "id": args.id }))
    }
    async fn set_llm_key(&self, args: defs::SetLlmKeyArgs) -> Result<Value> {
        Ok(json!({ "secret_present": !args.api_key.trim().is_empty(), "provider": "deepseek" }))
    }
    async fn test_llm(&self, _args: defs::TestLlmArgs) -> Result<Value> {
        Ok(json!({ "provider": "deepseek", "reply": "ok" }))
    }
}

#[async_trait]
impl AgentBackend for StubBackend {
    async fn agent_send(&self, args: defs::AgentSendArgs) -> Result<Value> {
        Ok(json!({ "session_id": args.session_id.unwrap_or_default(), "text": "", "cards": [] }))
    }

    async fn ai_write(&self, args: defs::AiWriteArgs) -> Result<Value> {
        Ok(json!({ "text": args.text }))
    }

    async fn agent_confirm(&self, _args: defs::AgentConfirmArgs) -> Result<Value> {
        Ok(json!({ "result": {}, "batch_id": null }))
    }

    async fn agent_history(
        &self,
        _ctx: &kb_capability::invoke::CallCtx,
        _args: defs::AgentHistoryArgs,
    ) -> Result<Value> {
        Ok(json!({ "messages": [] }))
    }

    async fn agent_sessions(&self, _args: defs::AgentSessionsArgs) -> Result<Value> {
        Ok(json!({ "sessions": [] }))
    }
    async fn agent_delete_session(&self, _args: defs::AgentDeleteSessionArgs) -> Result<Value> {
        Ok(json!({ "deleted": 0 }))
    }
    async fn agent_rename_session(&self, _args: defs::AgentRenameSessionArgs) -> Result<Value> {
        Ok(json!({ "renamed": true }))
    }
    async fn agent_pin_session(&self, _args: defs::AgentPinSessionArgs) -> Result<Value> {
        Ok(json!({ "pinned": true }))
    }
    async fn agent_compress(&self, _args: defs::AgentCompressArgs) -> Result<Value> {
        Ok(json!({ "compressed": false, "summary": "" }))
    }
    async fn acp_agents(&self) -> Result<Value> {
        Ok(json!({ "permission": "read", "agents": [] }))
    }
    async fn acp_save_agent(&self, args: defs::AcpSaveAgentArgs) -> Result<Value> {
        Ok(json!({ "saved": args.id }))
    }
    async fn acp_remove_agent(&self, args: defs::AcpAgentIdArgs) -> Result<Value> {
        Ok(json!({ "removed": args.id }))
    }
    async fn acp_set_permission(&self, args: defs::AcpPermissionArgs) -> Result<Value> {
        Ok(json!({ "permission": args.permission }))
    }
    async fn acp_test(&self, args: defs::AcpAgentIdArgs) -> Result<Value> {
        Ok(json!({ "ok": true, "id": args.id }))
    }
    async fn acp_install(&self, args: defs::AcpAgentIdArgs) -> Result<Value> {
        Ok(json!({ "ok": true, "id": args.id }))
    }
    async fn acp_permission(&self, args: defs::AcpPermissionDecisionArgs) -> Result<Value> {
        Ok(json!({ "resolved": true, "session_id": args.session_id }))
    }
    async fn acp_set_sandbox(&self, args: defs::AcpSandboxArgs) -> Result<Value> {
        Ok(json!({ "sandbox": args.sandbox }))
    }
    async fn acp_uninstall(&self, args: defs::AcpAgentIdArgs) -> Result<Value> {
        Ok(json!({ "ok": true, "id": args.id }))
    }
    async fn acp_set_default(&self, args: defs::AcpDefaultArgs) -> Result<Value> {
        Ok(json!({ "default": args.id }))
    }
    async fn acp_chat(&self, _args: defs::AcpChatArgs) -> Result<Value> {
        Ok(json!({ "session_id": "s", "text": "" }))
    }
    async fn acp_cancel(&self, args: defs::AcpCancelArgs) -> Result<Value> {
        Ok(json!({ "cancelled": true, "session_id": args.session_id }))
    }
    async fn context_estimate(&self, args: defs::ContextEstimateArgs) -> Result<Value> {
        Ok(json!({ "collection": args.collection, "estimated_tokens": 0 }))
    }
    async fn apply_context(&self, args: defs::ApplyContextArgs) -> Result<Value> {
        Ok(json!({ "collection": args.collection, "dry_run": args.dry_run }))
    }
}

#[async_trait]
impl SkillsBackend for StubBackend {
    async fn list_skills(&self) -> Result<Value> {
        Ok(json!({ "dir": null, "allow_exec": false, "skills": [], "warnings": [] }))
    }

    async fn list_drafts(
        &self,
        _ctx: &kb_capability::invoke::CallCtx,
        _args: defs::ListDraftsArgs,
    ) -> Result<Value> {
        Ok(json!({ "drafts": [], "total": 0, "counts": {} }))
    }
    async fn review_draft(
        &self,
        _ctx: &kb_capability::invoke::CallCtx,
        args: defs::ReviewDraftArgs,
    ) -> Result<Value> {
        Ok(json!({ "draft_id": args.id, "decision": args.decision }))
    }

    async fn reload_skills(&self) -> Result<Value> {
        Ok(json!({ "loader_rules": [], "templates": [], "warnings": [] }))
    }
    async fn get_skill(&self, _args: defs::SkillIdArgs) -> Result<Value> {
        Ok(json!({ "draft": {} }))
    }
    async fn save_skill(&self, _args: defs::SaveSkillArgs) -> Result<Value> {
        Ok(json!({ "id": "skill" }))
    }
    async fn delete_skill(&self, _args: defs::SkillIdArgs) -> Result<Value> {
        Ok(json!({ "deleted": true }))
    }
}

/// 审计仓储的空实现。
#[derive(Default)]
struct NullAudit;

#[async_trait]
impl kb_core::ports::repo::AuditRepo for NullAudit {
    async fn record(&self, _entry: kb_core::model::AuditEntry) -> Result<i64> {
        Ok(1)
    }
    async fn begin_batch(&self, _actor: &str, _description: &str) -> Result<String> {
        Ok("b".to_owned())
    }

    async fn ensure_batch(&self, _id: &str, _actor: &str, _description: &str) -> Result<()> {
        Ok(())
    }

    async fn record_change(&self, _batch_id: &str, _change: kb_core::model::Change) -> Result<()> {
        Ok(())
    }
    async fn batch(&self, _id: &str) -> Result<Option<kb_core::model::Batch>> {
        Ok(None)
    }
    async fn list(
        &self,
        _filter: Option<kb_core::model::AuditFilter>,
        _page: kb_core::model::Page,
    ) -> Result<Vec<kb_core::model::AuditEntry>> {
        Ok(Vec::new())
    }
    async fn count(&self, _filter: Option<kb_core::model::AuditFilter>) -> Result<u64> {
        Ok(0)
    }
    async fn changes(&self, _batch_id: &str) -> Result<Vec<kb_core::model::Change>> {
        Ok(Vec::new())
    }
    async fn list_batches(
        &self,
        _page: kb_core::model::Page,
    ) -> Result<Vec<kb_core::model::Batch>> {
        Ok(Vec::new())
    }
    async fn count_batches(&self) -> Result<u64> {
        Ok(0)
    }
    async fn mark_reverted(&self, _batch_id: &str, _at: i64) -> Result<()> {
        Ok(())
    }
}

fn state(hub: Arc<kb_web::EventHub>) -> Arc<AppState> {
    let registry = Arc::new(defs::build(Arc::new(StubBackend)));
    let dir = tempfile::tempdir().expect("临时 KB_HOME");
    let meta: Arc<dyn kb_core::ports::repo::MetaStore> =
        Arc::new(kb_meta::SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开 meta.db"));
    std::mem::forget(dir);
    Arc::new(AppState {
        invoker: Arc::new(kb_capability::Invoker::new(registry, Arc::new(NullAudit))),
        started: std::time::Instant::now(),
        version: "test",
        mcp: None,
        events: None,
        meta,
        system: Arc::new(
            kb_meta::SystemStore::open(
                tempfile::tempdir()
                    .expect("账号库目录")
                    .keep()
                    .join("system.db"),
            )
            .expect("打开账号库"),
        ),
        principals: kb_web::auth::PrincipalCache::default(),
        account: kb_web::signup::AccountDeps::unconfigured(),
        ai_enabled: Arc::new(kb_core::features::AiState::on),
        login_limiter: kb_web::auth::ratelimit::LoginLimiter::new(),
        hub,
        uploads: None,
        agent_grants: std::sync::Arc::new(kb_web::AgentGrants::new()),
        collab: None,
        office: None,
    })
}

/// 读一个服务端发来的文本帧。
///
/// 服务端帧不带掩码:`[fin|opcode][len][扩展长度][payload]`。这里只处理文本帧
/// 与长度 < 64 KiB 的情况(测试里的事件都很短)。
async fn read_text(stream: &mut tokio::net::UnixStream) -> Value {
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await.expect("读帧头");
    let opcode = head[0] & 0x0f;
    let masked = head[1] & 0x80 != 0;
    assert!(!masked, "服务端帧不应带掩码");
    let mut length = usize::from(head[1] & 0x7f);
    if length == 126 {
        let mut ext = [0u8; 2];
        stream.read_exact(&mut ext).await.expect("读扩展长度");
        length = usize::from(u16::from_be_bytes(ext));
    } else if length == 127 {
        let mut ext = [0u8; 8];
        stream.read_exact(&mut ext).await.expect("读扩展长度");
        length = u64::from_be_bytes(ext) as usize;
    }
    let mut payload = vec![0u8; length];
    stream.read_exact(&mut payload).await.expect("读载荷");
    assert_eq!(opcode, 0x1, "测试只处理文本帧");
    serde_json::from_slice(&payload).expect("帧里应是 JSON")
}

/// 发一个带掩码的文本帧(客户端必须掩码)。
async fn write_text(stream: &mut tokio::net::UnixStream, text: &str) {
    let payload = text.as_bytes();
    assert!(payload.len() < 126, "测试只发短帧");
    let mask = [0x11u8, 0x22, 0x33, 0x44];
    let mut frame = vec![0x81, 0x80 | payload.len() as u8];
    frame.extend_from_slice(&mask);
    frame.extend(
        payload
            .iter()
            .enumerate()
            .map(|(index, byte)| byte ^ mask[index % 4]),
    );
    stream.write_all(&frame).await.expect("写帧");
}

/// 读 HTTP 响应头(逐字节,避免把后面的帧数据一起吃掉)。
async fn read_headers(stream: &mut tokio::net::UnixStream) -> String {
    let mut raw = Vec::new();
    let mut byte = [0u8; 1];
    while !raw.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.expect("读响应头");
        raw.push(byte[0]);
        assert!(raw.len() < 8192, "响应头过长");
    }
    String::from_utf8_lossy(&raw).into_owned()
}

#[tokio::test]
async fn ws_pushes_events_and_answers_ping() {
    let hub = Arc::new(kb_web::EventHub::new());
    let dir = tempfile::tempdir().expect("临时目录");
    let socket = dir.path().join("kb.sock");
    let (_tx, rx) = tokio::sync::watch::channel(false);
    let listener = kb_web::bind_uds(&socket).expect("绑定 UDS");
    let handle = tokio::spawn({
        let socket = socket.clone();
        let hub = hub.clone();
        async move {
            kb_web::serve_uds_listener(listener, state(hub), socket, kb_web::SocketKind::Unix, rx)
                .await
        }
    });
    for _ in 0..100 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(socket.exists(), "UDS 文件应被创建");

    let mut stream = tokio::net::UnixStream::connect(&socket)
        .await
        .expect("连接 UDS");
    stream
        .write_all(
            b"GET /api/v1/ws HTTP/1.1\r\n\
              Host: localhost\r\n\
              Upgrade: websocket\r\n\
              Connection: Upgrade\r\n\
              Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
              Sec-WebSocket-Version: 13\r\n\r\n",
        )
        .await
        .expect("握手");
    let headers = read_headers(&mut stream).await;
    assert!(headers.starts_with("HTTP/1.1 101"), "应升级成功:{headers}");

    // 1) 握手后第一条是 hello
    let hello = read_text(&mut stream).await;
    assert_eq!(hello["type"], "hello", "{hello}");
    assert_eq!(hello["version"], "test");

    // 2) 事件中心发的事件原样推给客户端
    hub.publish(
        "job.progress",
        json!({ "job_id": "j1", "done": 3, "total": 10 }),
    );
    let progress = read_text(&mut stream).await;
    assert_eq!(progress["type"], "job.progress", "{progress}");
    assert_eq!(progress["data"]["done"], 3);

    hub.publish("item.changed", json!({ "action": "edited", "id": "i1" }));
    let changed = read_text(&mut stream).await;
    assert_eq!(changed["type"], "item.changed", "{changed}");
    assert_eq!(changed["data"]["id"], "i1");

    // 3) 客户端发 `ping` 换 `pong`
    write_text(&mut stream, "ping").await;
    let pong = read_text(&mut stream).await;
    assert_eq!(pong["type"], "pong", "{pong}");

    drop(stream);
    handle.abort();
}
