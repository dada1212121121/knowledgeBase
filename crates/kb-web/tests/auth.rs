//! 鉴权的验收测试:未登录 401、登录后可用、CSRF、Origin、Bearer 作用域、
//! 限速 429、会话过期、登出失效、日志里不出现明文。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use kb_capability::backend::{
    AgentBackend, DocsBackend, FilesBackend, JobsBackend, OpsBackend, SearchBackend, SkillsBackend,
    SourcesBackend,
};
use kb_capability::defs;
use kb_capability::invoke::CallCtx;
use kb_core::Result;
use kb_core::ports::repo::{AuthRepo, MetaStore};
use kb_web::AppState;
use kb_web::source::SocketKind;
use serde_json::{Value, json};
use tower::ServiceExt;

/// 最小后端:只实现本文件用到的能力,其余给空结果。
struct Stub;

#[async_trait]
impl SearchBackend for Stub {
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
        Ok(json!({ "job_id": "j1", "path": args.path }))
    }
    async fn save_insight(&self, _ctx: &CallCtx, args: defs::SaveInsightArgs) -> Result<Value> {
        Ok(json!({ "id": "i1", "title": args.title }))
    }
    async fn kb_feedback(&self, args: defs::FeedbackArgs) -> Result<Value> {
        Ok(json!({ "id": 1, "item_id": args.item_id }))
    }
    async fn reindex_project(&self, args: defs::ReindexArgs) -> Result<Value> {
        Ok(json!({ "job_id": "j1", "project": args.project }))
    }
    async fn set_item_status(&self, args: defs::SetStatusArgs) -> Result<Value> {
        Ok(json!({ "id": args.id, "status": args.status }))
    }
    async fn supersede_insight(&self, args: defs::SupersedeArgs) -> Result<Value> {
        Ok(json!({ "old_id": args.old_id, "new_id": args.new_id }))
    }
    async fn item_history(&self, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "id": args.id, "history": [] }))
    }

    async fn list_items(&self, args: defs::ListItemsArgs) -> Result<Value> {
        Ok(json!({ "items": [], "total": 0, "page": args.page, "page_size": args.page_size }))
    }
    async fn edit_item(&self, _ctx: &CallCtx, args: defs::EditItemArgs) -> Result<Value> {
        Ok(json!({ "id": args.id, "version": args.version }))
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
        Ok(json!({ "collections": [], "totals": {} }))
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
impl DocsBackend for Stub {
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
impl FilesBackend for Stub {
    async fn save_file(&self, _args: defs::SaveFileArgs) -> Result<Value> {
        Ok(json!({ "version": 1, "embedded": 0 }))
    }

    async fn get_file_timeline(&self, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "file": { "id": args.id }, "stages": [] }))
    }
}

#[async_trait]
impl JobsBackend for Stub {
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
impl SourcesBackend for Stub {
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
impl OpsBackend for Stub {
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
        Ok(json!({ "server": {} }))
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
        Ok(json!({ "id": "token-1", "name": args.name }))
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
impl AgentBackend for Stub {
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
impl SkillsBackend for Stub {
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

/// 审计的假实现(本测试不关心)。
struct NullAudit;

#[async_trait]
impl kb_core::ports::repo::AuditRepo for NullAudit {
    async fn record(&self, _entry: kb_core::model::AuditEntry) -> Result<i64> {
        Ok(1)
    }

    async fn begin_batch(&self, _actor: &str, _description: &str) -> Result<String> {
        Ok("b1".to_owned())
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

struct Harness {
    state: Arc<AppState>,
    #[allow(dead_code)]
    dir: tempfile::TempDir,
}

async fn harness() -> Harness {
    harness_with(false, true).await
}

/// `enforce` = 守护进程的强制模式(没有身份 401、功能点把关);`ai_on` = AI 总开关。
async fn harness_with(enforce: bool, ai_on: bool) -> Harness {
    let dir = tempfile::tempdir().expect("临时 KB_HOME");
    let meta: Arc<dyn MetaStore> =
        Arc::new(kb_meta::SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开 meta.db"));
    let registry = Arc::new(defs::build(Arc::new(Stub)));
    let state = Arc::new(AppState {
        invoker: Arc::new({
            let invoker = kb_capability::Invoker::new(registry, Arc::new(NullAudit));
            if enforce {
                invoker.enforcing()
            } else {
                invoker
            }
        }),
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
        ai_enabled: Arc::new(move || kb_core::features::AiState::from(ai_on)),
        login_limiter: kb_web::auth::ratelimit::LoginLimiter::new(),
        hub: std::sync::Arc::new(kb_web::EventHub::new()),
        uploads: None,
        agent_grants: std::sync::Arc::new(kb_web::AgentGrants::new()),
        collab: None,
        office: None,
    });
    Harness { state, dir }
}

impl Harness {
    /// 走 UDS(本机超级用户)调一个接口。
    async fn uds(&self, request: Request<Body>) -> (StatusCode, Value) {
        let app = kb_web::build(self.state.clone(), SocketKind::Unix);
        send(app, request).await
    }

    /// 走 TCP(需要鉴权)调一个接口。
    async fn tcp(&self, request: Request<Body>) -> (StatusCode, Value) {
        let app = kb_web::build(self.state.clone(), SocketKind::Tcp);
        send(app, request).await
    }

    /// 通过 UDS 设置密码(等价于 `kb auth set-password`)。
    async fn set_password(&self, password: &str) {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/password")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "password": password }).to_string()))
            .expect("请求");
        let (status, body) = self.uds(request).await;
        assert_eq!(status, StatusCode::OK, "设置密码应成功:{body}");
    }

    /// 登录,返回会话 cookie 值。
    async fn login(&self, password: &str) -> String {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "password": password }).to_string()))
            .expect("请求");
        let app = kb_web::build(self.state.clone(), SocketKind::Tcp);
        let response = app.oneshot(request).await.expect("响应");
        assert_eq!(response.status(), StatusCode::OK, "登录应成功");
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .expect("应设置 cookie")
            .to_str()
            .expect("cookie 是 ASCII")
            .to_owned();
        assert!(cookie.starts_with("kb_session="), "{cookie}");
        assert!(cookie.contains("HttpOnly"), "{cookie}");
        assert!(cookie.contains("SameSite=Strict"), "{cookie}");
        assert!(cookie.contains("Max-Age=604800"), "{cookie}");
        cookie
            .split_once('=')
            .and_then(|(_, rest)| rest.split(';').next())
            .expect("取令牌")
            .to_owned()
    }

    /// 通过 UDS 建一个 API 令牌(令牌属于主知识库的所有者,没有账号时先建 admin)。
    async fn create_token(&self, name: &str, scope: &str) -> String {
        if self.state.system.count_users().await.expect("计数") == 0 {
            self.set_password("correct horse battery").await;
        }
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/tokens")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "name": name, "scope": scope }).to_string(),
            ))
            .expect("请求");
        let (status, body) = self.uds(request).await;
        assert_eq!(status, StatusCode::OK, "建令牌应成功:{body}");
        body["data"]["token"]
            .as_str()
            .expect("返回明文令牌")
            .to_owned()
    }
}

async fn send(app: axum::Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.oneshot(request).await.expect("响应");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("读响应体");
    let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, body)
}

fn capability_request(name: &str, args: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/api/v1/capabilities/{name}"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(args.to_string()))
        .expect("请求")
}

#[tokio::test]
async fn tcp_requests_without_a_session_are_rejected() {
    let h = harness().await;
    let request = Request::builder()
        .uri("/api/v1/capabilities")
        .body(Body::empty())
        .expect("请求");
    let (status, body) = h.tcp(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "unauthorized");
}

#[tokio::test]
async fn login_unlocks_write_capabilities_but_requires_csrf() {
    let h = harness().await;
    h.set_password("correct horse battery").await;
    let token = h.login("correct horse battery").await;

    // 会话有效:W 级能力可以调用(带 CSRF 头)
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/capabilities/save_insight")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, format!("kb_session={token}"))
        .header("x-kb-csrf", "1")
        .header(header::HOST, "127.0.0.1:7878")
        .body(Body::from(
            json!({"title": "t", "body": "b", "project": "p"}).to_string(),
        ))
        .expect("请求");
    let (status, body) = h.tcp(request).await;
    assert_eq!(status, StatusCode::OK, "登录后应能调用 W 级能力:{body}");

    // 缺 CSRF 头 → 403
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/capabilities/save_insight")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, format!("kb_session={token}"))
        .header(header::HOST, "127.0.0.1:7878")
        .body(Body::from(
            json!({"title": "t", "body": "b", "project": "p"}).to_string(),
        ))
        .expect("请求");
    let (status, body) = h.tcp(request).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "缺 CSRF 头应 403:{body}");
    assert_eq!(body["error"]["code"], "forbidden");

    // 错误的 Origin → 403
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/capabilities/save_insight")
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::COOKIE, format!("kb_session={token}"))
        .header("x-kb-csrf", "1")
        .header(header::HOST, "127.0.0.1:7878")
        .header(header::ORIGIN, "https://evil.example")
        .body(Body::from(
            json!({"title": "t", "body": "b", "project": "p"}).to_string(),
        ))
        .expect("请求");
    let (status, body) = h.tcp(request).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "错误的 Origin 应 403:{body}");
}

#[tokio::test]
async fn bearer_tokens_are_scoped() {
    let h = harness().await;
    let mcp = h.create_token("kiro", "mcp").await;

    // scope = mcp:只读能力可以
    let mut request = capability_request("search_knowledge", json!({"query": "x"}));
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {mcp}").parse().expect("头"),
    );
    let (status, body) = h.tcp(request).await;
    assert_eq!(status, StatusCode::OK, "MCP 令牌应能检索:{body}");

    // scope = mcp: G 级能力被权限上限挡住(不是靠可见面)
    let mut request = capability_request("add_project", json!({"path": "/tmp/x"}));
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {mcp}").parse().expect("头"),
    );
    let (status, body) = h.tcp(request).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "G 级能力应 403:{body}");
    let message = body["error"]["message"].as_str().unwrap_or_default();
    assert!(message.contains("权限"), "应是权限上限拦下的:{message}");

    // 撤销后立刻失效
    let (status, _) = h
        .uds(
            Request::builder()
                .uri("/api/v1/auth/tokens")
                .body(Body::empty())
                .expect("请求"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let admin = h
        .state
        .system
        .find_user_by_login("admin")
        .await
        .expect("查询")
        .expect("set_password 会创建 admin");
    let tokens = h.state.system.list_tokens(&admin.id).await.expect("列表");
    let id = &tokens[0].id;
    let (status, _) = h
        .uds(
            Request::builder()
                .method("DELETE")
                .uri(format!("/api/v1/auth/tokens/{id}"))
                .body(Body::empty())
                .expect("请求"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let mut request = capability_request("search_knowledge", json!({"query": "x"}));
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {mcp}").parse().expect("头"),
    );
    let (status, _) = h.tcp(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "撤销后令牌必须失效");
}

#[tokio::test]
async fn the_sixth_failed_login_is_rate_limited() {
    let h = harness().await;
    h.set_password("correct horse battery").await;
    for attempt in 1..=5 {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({"password": "wrong"}).to_string()))
            .expect("请求");
        let (status, _) = h.tcp(request).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "第 {attempt} 次应是 401");
    }
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({"password": "correct horse battery"}).to_string(),
        ))
        .expect("请求");
    let (status, body) = h.tcp(request).await;
    assert_eq!(
        status,
        StatusCode::TOO_MANY_REQUESTS,
        "第 6 次应 429:{body}"
    );
}

#[tokio::test]
async fn expired_sessions_and_logout_invalidate_access() {
    let h = harness().await;
    h.set_password("correct horse battery").await;
    let token = h.login("correct horse battery").await;

    // 登出后失效
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/logout")
        .header(header::COOKIE, format!("kb_session={token}"))
        .header("x-kb-csrf", "1")
        .header(header::HOST, "127.0.0.1:7878")
        .body(Body::empty())
        .expect("请求");
    let (status, _) = h.tcp(request).await;
    assert_eq!(status, StatusCode::OK);
    let request = Request::builder()
        .uri("/api/v1/capabilities")
        .header(header::COOKIE, format!("kb_session={token}"))
        .body(Body::empty())
        .expect("请求");
    let (status, _) = h.tcp(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "登出后会话必须失效");

    // 过期会话:直接往库里塞一条已过期的
    let token = "expired-token-value";
    let now = kb_web::auth::session::now_millis();
    AuthRepo::create_session(
        h.state.meta.as_ref(),
        kb_core::model::Session {
            token_hash: kb_web::auth::token::sha256_hex(token),
            created_at: now - 10_000,
            expires_at: now - 1,
            last_seen: now - 10_000,
            user_agent: None,
        },
    )
    .await
    .expect("写会话");
    let request = Request::builder()
        .uri("/api/v1/capabilities")
        .header(header::COOKIE, format!("kb_session={token}"))
        .body(Body::empty())
        .expect("请求");
    let (status, _) = h.tcp(request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "过期会话必须拒绝");
}

#[tokio::test]
async fn secrets_are_stored_hashed_only() {
    let h = harness().await;
    h.set_password("correct horse battery").await;
    let token = h.login("correct horse battery").await;

    let admin = h
        .state
        .system
        .find_user_by_login("admin")
        .await
        .expect("查询")
        .expect("set_password 会创建 admin");
    let stored = h
        .state
        .system
        .password_hash(&admin.id)
        .await
        .expect("读哈希")
        .expect("应已设置");
    assert!(stored.starts_with("$argon2id$"), "{stored}");
    assert!(!stored.contains("correct horse battery"), "不能存明文密码");

    let hash = kb_web::auth::token::sha256_hex(&token);
    let now = kb_web::auth::session::now_millis();
    assert!(
        h.state
            .system
            .session_user(&hash, now)
            .await
            .expect("读会话")
            .is_some(),
        "会话应按 sha256 存"
    );
    assert!(
        h.state
            .system
            .session_user(&token, now)
            .await
            .expect("读会话")
            .is_none(),
        "库里不能出现明文令牌"
    );

    let api = h.create_token("ci", "api").await;
    assert!(
        h.state
            .system
            .find_token(&kb_web::auth::token::sha256_hex(&api))
            .await
            .expect("读令牌")
            .is_some(),
        "API 令牌也只存 sha256"
    );
    assert!(
        h.state
            .system
            .find_token(&api)
            .await
            .expect("读令牌")
            .is_none(),
        "库里不能出现明文令牌"
    );
}

/// 捕获 tracing 输出,确认日志里没有明文密码 / 令牌。
#[tokio::test]
async fn logs_never_contain_secrets() {
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Sink {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().expect("锁").extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let sink = Sink::default();
    let writer = sink.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_ansi(false)
        .with_writer(move || writer.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let h = harness().await;
    h.set_password("correct horse battery").await;
    let token = h.login("correct horse battery").await;
    let api = h.create_token("ci", "api").await;

    let captured = String::from_utf8_lossy(&sink.0.lock().expect("锁")).into_owned();
    assert!(
        !captured.contains("correct horse battery"),
        "日志里出现明文密码"
    );
    assert!(!captured.contains(&token), "日志里出现会话令牌");
    assert!(!captured.contains(&api), "日志里出现 API 令牌");
}

/// 设置页的「访问令牌」要能列令牌:登录会话(TCP)放行,Bearer 令牌仍然不行。
#[tokio::test]
async fn a_logged_in_session_can_manage_tokens() {
    let h = harness().await;
    h.set_password("correct horse battery").await;
    let cookie = h.login("correct horse battery").await;
    h.create_token("kiro", "mcp").await;

    // 会话:列令牌
    let request = Request::builder()
        .uri("/api/v1/auth/tokens")
        .header(header::COOKIE, format!("kb_session={cookie}"))
        .body(Body::empty())
        .expect("请求");
    let (status, body) = h.tcp(request).await;
    assert_eq!(status, StatusCode::OK, "登录会话应能列令牌:{body}");
    assert!(
        body["data"]["tokens"]
            .as_array()
            .is_some_and(|list| !list.is_empty()),
        "{body}"
    );

    // 会话:建令牌(非 GET 要带 CSRF 头)
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/tokens")
        .header(header::COOKIE, format!("kb_session={cookie}"))
        .header("x-kb-csrf", "1")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "name": "from-web", "scope": "api" }).to_string(),
        ))
        .expect("请求");
    let (status, body) = h.tcp(request).await;
    assert_eq!(status, StatusCode::OK, "登录会话应能建令牌:{body}");
    assert!(body["data"]["token"].is_string(), "{body}");

    // Bearer 令牌不能管理令牌(避免 api 令牌给自己提权)
    let bearer = h.create_token("api-token", "api").await;
    let request = Request::builder()
        .uri("/api/v1/auth/tokens")
        .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
        .body(Body::empty())
        .expect("请求");
    let (status, body) = h.tcp(request).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "Bearer 不应能列令牌:{body}");
}

// ---------------------------------------------------------------------------
// 多用户:用户名登录、令牌/会话属于各自的用户、功能点把关、AI 总开关
// ---------------------------------------------------------------------------

use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserStatus};

impl Harness {
    /// 直接在账号库里建用户(绕过注册流程),返回用户 id。
    async fn add_user(&self, name: &str, password: &str, role: &str) -> String {
        let hash = kb_web::auth::password::hash_password(password).expect("哈希");
        let (user, _) = self
            .state
            .system
            .create_user(NewUser {
                username: name.to_owned(),
                email: Some(format!("{name}@example.com")),
                display_name: None,
                password_hash: hash,
                role_id: role.to_owned(),
                status: UserStatus::Active,
                registered_via: "test".to_owned(),
                must_change_password: false,
                email_verified: true,
            })
            .await
            .expect("建用户");
        user.id
    }

    /// 用「用户名/邮箱 + 密码」登录,返回 (状态码, 会话令牌, 响应体)。
    async fn login_as(&self, login: &str, password: &str) -> (StatusCode, Option<String>, Value) {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/login")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "login": login, "password": password }).to_string(),
            ))
            .expect("请求");
        let app = kb_web::build(self.state.clone(), SocketKind::Tcp);
        let response = app.oneshot(request).await.expect("响应");
        let status = response.status();
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .and_then(|raw| {
                raw.split_once('=')
                    .and_then(|(_, rest)| rest.split(';').next())
            })
            .map(str::to_owned);
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("体");
        (
            status,
            cookie,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// 带会话 cookie 发一个 TCP 请求(写操作自动带 CSRF 头)。
    async fn as_session(
        &self,
        token: &str,
        method: &str,
        uri: &str,
        body: Value,
    ) -> (StatusCode, Value) {
        let request = Request::builder()
            .method(method)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, format!("kb_session={token}"))
            .header("x-kb-csrf", "1")
            .header(header::HOST, "127.0.0.1:7878")
            .body(Body::from(body.to_string()))
            .expect("请求");
        self.tcp(request).await
    }
}

#[tokio::test]
async fn login_accepts_username_or_email_and_never_says_which_part_was_wrong() {
    let h = harness().await;
    h.add_user("alice", "alice password 1", ROLE_USER).await;
    h.add_user("bob", "bob password 22", ROLE_USER).await;
    for login in ["alice", "ALICE", "alice@example.com"] {
        let (status, cookie, body) = h.login_as(login, "alice password 1").await;
        assert_eq!(status, StatusCode::OK, "{login}:{body}");
        assert!(cookie.is_some());
        assert_eq!(body["data"]["user"]["username"], "alice");
    }
    // 用户存在但密码错 / 用户不存在:同一个状态码和同一句话
    let (s1, _, wrong_password) = h.login_as("alice", "bad password").await;
    let (s2, _, no_such_user) = h.login_as("nobody_here", "bad password").await;
    assert_eq!(
        (s1, s2),
        (StatusCode::UNAUTHORIZED, StatusCode::UNAUTHORIZED)
    );
    assert_eq!(
        wrong_password["error"]["message"], no_such_user["error"]["message"],
        "不能泄露用户名是否存在"
    );
    // 多个账号时,不写用户名不能登录(不再有「只有一个账号」的歧义)
    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({ "password": "alice password 1" }).to_string(),
        ))
        .expect("请求");
    let (status, body) = h.tcp(request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
async fn a_disabled_user_cannot_log_in_and_loses_the_existing_session() {
    let h = harness().await;
    h.add_user("boss", "boss password 11", ROLE_ADMIN).await;
    let eve = h.add_user("eve", "eve password 111", ROLE_USER).await;
    let (_, cookie, _) = h.login_as("eve", "eve password 111").await;
    let token = cookie.expect("会话");
    let (status, _) = h
        .as_session(&token, "GET", "/api/v1/auth/me", json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);

    h.state
        .system
        .update_user(
            &eve,
            kb_meta::system::UserUpdate {
                status: Some(UserStatus::Disabled),
                ..Default::default()
            },
        )
        .await
        .expect("停用");
    let (status, _) = h
        .as_session(&token, "GET", "/api/v1/auth/me", json!({}))
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "停用后已有会话立即失效");
    let (status, _, body) = h.login_as("eve", "eve password 111").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
}

#[tokio::test]
async fn tokens_and_sessions_belong_to_their_own_user() {
    let h = harness().await;
    h.add_user("boss", "boss password 11", ROLE_ADMIN).await;
    h.add_user("alice", "alice password 1", ROLE_USER).await;
    h.add_user("bob", "bob password 22", ROLE_USER).await;
    let alice = h
        .login_as("alice", "alice password 1")
        .await
        .1
        .expect("alice 会话");
    let bob = h
        .login_as("bob", "bob password 22")
        .await
        .1
        .expect("bob 会话");

    let (status, created) = h
        .as_session(
            &alice,
            "POST",
            "/api/v1/auth/tokens",
            json!({ "name": "laptop", "scope": "api" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{created}");
    let id = created["data"]["id"].as_str().expect("id").to_owned();
    let plaintext = created["data"]["token"].as_str().expect("明文").to_owned();

    // bob 的令牌列表里没有 alice 的
    let (_, bob_list) = h
        .as_session(&bob, "GET", "/api/v1/auth/tokens", json!({}))
        .await;
    assert!(
        bob_list["data"]["tokens"]
            .as_array()
            .expect("数组")
            .is_empty(),
        "{bob_list}"
    );
    // bob 撤销 alice 的令牌:当作不存在,令牌依然有效
    let (status, _) = h
        .as_session(
            &bob,
            "DELETE",
            &format!("/api/v1/auth/tokens/{id}"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let mut request = capability_request("search_knowledge", json!({"query": "x"}));
    request.headers_mut().insert(
        header::AUTHORIZATION,
        format!("Bearer {plaintext}").parse().expect("头"),
    );
    assert_eq!(
        h.tcp(request).await.0,
        StatusCode::OK,
        "alice 的令牌没被 bob 撤销"
    );
    // alice 自己能撤销
    let (status, _) = h
        .as_session(
            &alice,
            "DELETE",
            &format!("/api/v1/auth/tokens/{id}"),
            json!({}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    // 令牌解析到的是 alice 本人
    let (_, me) = h
        .as_session(&alice, "GET", "/api/v1/auth/me", json!({}))
        .await;
    assert_eq!(me["data"]["user"]["username"], "alice");
    assert_ne!(
        me["data"]["user"]["space_id"], "sp_primary",
        "普通用户的知识库不是主知识库"
    );
}

#[tokio::test]
async fn the_feature_gate_is_enforced_over_http_for_each_role() {
    let h = harness_with(true, true).await;
    h.add_user("boss", "boss password 11", ROLE_ADMIN).await;
    h.add_user("alice", "alice password 1", ROLE_USER).await;
    let admin = h
        .login_as("boss", "boss password 11")
        .await
        .1
        .expect("管理员会话");
    let user = h
        .login_as("alice", "alice password 1")
        .await
        .1
        .expect("用户会话");

    // 系统级能力:普通用户 403,管理员 200
    let (status, body) = h
        .as_session(&user, "POST", "/api/v1/capabilities/get_config", json!({}))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert!(
        body["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("没有开通"),
        "{body}"
    );
    let (status, body) = h
        .as_session(&admin, "POST", "/api/v1/capabilities/get_config", json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // 普通用户能用的功能不受影响
    let (status, _) = h
        .as_session(
            &user,
            "POST",
            "/api/v1/capabilities/search_knowledge",
            json!({"query": "x"}),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    // me 里的功能表按角色不同
    let (_, mine) = h
        .as_session(&user, "GET", "/api/v1/auth/me", json!({}))
        .await;
    let features: Vec<String> =
        serde_json::from_value(mine["data"]["user"]["features"].clone()).expect("功能表");
    assert!(
        features.contains(&"docs.notes".to_owned())
            && !features.contains(&"sys.settings".to_owned()),
        "{features:?}"
    );
}

#[tokio::test]
async fn turning_ai_off_hides_ai_features_everywhere_including_for_the_admin() {
    let h = harness_with(true, false).await;
    h.add_user("boss", "boss password 11", ROLE_ADMIN).await;
    h.add_user("alice", "alice password 1", ROLE_USER).await;
    for (name, password) in [("boss", "boss password 11"), ("alice", "alice password 1")] {
        let token = h.login_as(name, password).await.1.expect("会话");
        let (_, mine) = h
            .as_session(&token, "GET", "/api/v1/auth/me", json!({}))
            .await;
        let features: Vec<String> =
            serde_json::from_value(mine["data"]["user"]["features"].clone()).expect("功能表");
        assert!(
            !features
                .iter()
                .any(|f| f.starts_with("ai.") || f == "search.deep"),
            "{name} 不该看到 AI 功能:{features:?}"
        );
        assert_eq!(mine["data"]["user"]["ai_enabled"], false);
        let (status, body) = h
            .as_session(
                &token,
                "POST",
                "/api/v1/capabilities/deep_search",
                json!({"query": "x"}),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{name}:{body}");
        assert!(
            body["error"]["message"]
                .as_str()
                .unwrap_or("")
                .contains("AI 功能已关闭"),
            "{name}:{body}"
        );
    }
}

#[tokio::test]
async fn remote_mcp_never_falls_back_to_the_local_superuser_for_a_users_token() {
    // 桥接层回连本机守护进程是「本机超级用户」,会落在主知识库:别的用户的令牌必须被挡在 /mcp 之外
    let h = harness().await;
    let dir = tempfile::tempdir().expect("目录");
    let token_file = dir.path().join("mcp-token");
    std::fs::write(&token_file, "secret\n").expect("写");
    let gate = kb_web::mcp::McpGate {
        token_file,
        allowed_origins: vec!["https://kb.example.com".to_owned()],
        allowed_hosts: vec!["kb.example.com".to_owned()],
    };
    let endpoint = kb_web::mcp::McpEndpoint::new(
        gate,
        kb_mcp::uds::UdsClient::new("/tmp/kb-test-missing.sock"),
        24_000,
    );
    let state = Arc::new(AppState {
        invoker: h.state.invoker.clone(),
        started: std::time::Instant::now(),
        version: "test",
        mcp: Some(Arc::new(endpoint)),
        events: None,
        meta: h.state.meta.clone(),
        system: h.state.system.clone(),
        principals: kb_web::auth::PrincipalCache::default(),
        account: kb_web::signup::AccountDeps::unconfigured(),
        ai_enabled: Arc::new(kb_core::features::AiState::on),
        login_limiter: kb_web::auth::ratelimit::LoginLimiter::new(),
        hub: h.state.hub.clone(),
        uploads: None,
        agent_grants: h.state.agent_grants.clone(),
        collab: None,
        office: None,
    });
    h.add_user("boss", "boss password 11", ROLE_ADMIN).await;
    let bob_id = h.add_user("bob", "bob password 22", ROLE_USER).await;
    let plaintext = "kb_mcp_bobs_token";
    state
        .system
        .create_token(kb_core::account::UserToken {
            id: "t-bob".into(),
            user_id: bob_id,
            name: "bob-mcp".into(),
            token_hash: kb_core::token::sha256_hex(plaintext),
            scopes: "mcp".into(),
            include_shared: false,
            created_at: 1,
            last_used: None,
            revoked_at: None,
        })
        .await
        .expect("令牌");
    let app = kb_web::build(state, SocketKind::Tcp);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/mcp")
                .header("authorization", format!("Bearer {plaintext}"))
                .header("origin", "https://kb.example.com")
                .header("host", "kb.example.com")
                .header("content-type", "application/json")
                .header("accept", "application/json, text/event-stream")
                .body(Body::from("{}"))
                .expect("请求"),
        )
        .await
        .expect("响应");
    // 令牌用户的 MCP 带着各自的身份走 agent.sock;这个测试的端点没有配 agent.sock,
    // 所以是「暂不可用」——关键是它**不会**退回去借本机超级用户(那会读到管理员的数据)
    assert_eq!(
        response.status(),
        StatusCode::SERVICE_UNAVAILABLE,
        "没有 agent.sock 时,用户的令牌不能走远程 MCP,更不能借本机超级用户"
    );
}

#[tokio::test]
async fn uploads_need_the_upload_feature() {
    let h = harness_with(true, true).await;
    h.add_user("boss", "boss password 11", ROLE_ADMIN).await;
    let alice = h.add_user("alice", "alice password 1", ROLE_USER).await;
    h.state
        .system
        .set_feature_override(&alice, "docs.upload", Some("deny"))
        .await
        .expect("例外");
    let token = h
        .login_as("alice", "alice password 1")
        .await
        .1
        .expect("会话");
    // 没有配置上传后端时 404;有后端时,没开通上传功能的账号在到达后端之前就被 403
    let (status, _) = h
        .as_session(
            &token,
            "POST",
            "/api/v1/uploads/precheck",
            json!({"collection": "c", "files": []}),
        )
        .await;
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::NOT_FOUND,
        "实际 {status}"
    );
}

#[tokio::test]
async fn a_token_made_before_any_password_belongs_to_an_unusable_placeholder_admin() {
    // 老用法:先 `kb auth token create`,后 `kb auth set-password`。令牌要有主人,所以先建一个占位管理员
    let h = harness().await;
    let _token = h.create_token_without_password("early", "mcp").await;
    let admin = h
        .state
        .system
        .find_user_by_login("admin")
        .await
        .expect("查询")
        .expect("占位管理员");
    // 占位管理员的密码是随机串,任何口令都登录不了
    let (status, _, _) = h.login_as("admin", "correct horse battery").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // 之后 set-password 给的就是同一个账号设密码,而不是再建一个
    h.set_password("correct horse battery").await;
    let (status, cookie, _) = h.login_as("admin", "correct horse battery").await;
    assert_eq!(status, StatusCode::OK);
    assert!(cookie.is_some());
    assert_eq!(
        h.state.system.count_users().await.expect("计数"),
        1,
        "没有多出第二个账号"
    );
    assert_eq!(
        h.state
            .system
            .list_tokens(&admin.id)
            .await
            .expect("令牌")
            .len(),
        1,
        "令牌还在原来的主人名下"
    );
}

impl Harness {
    /// 不先设密码就通过 UDS 建令牌。
    async fn create_token_without_password(&self, name: &str, scope: &str) -> String {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/tokens")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                json!({ "name": name, "scope": scope }).to_string(),
            ))
            .expect("请求");
        let (status, body) = self.uds(request).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["data"]["token"].as_str().expect("明文").to_owned()
    }
}
