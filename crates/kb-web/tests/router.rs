//! 双监听与来源策略。

use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use kb_capability::backend::{
    AgentBackend, DocsBackend, FilesBackend, JobsBackend, OpsBackend, SearchBackend, SkillsBackend,
    SourcesBackend,
};
use kb_capability::defs;
use kb_capability::invoke::CallCtx;
use kb_core::Result;
use kb_web::api::AppState;
use kb_web::source::SocketKind;
use serde_json::{Value, json};
use tower::ServiceExt;

/// 只回固定 JSON 的假后端。
struct StubBackend;

#[async_trait]
impl SearchBackend for StubBackend {
    async fn search(&self, ctx: &CallCtx, _args: defs::SearchArgs) -> Result<Value> {
        // 回显作用域来源,便于测试断言“没有串改”
        Ok(json!({
            "hits": [],
            "scope": [ctx.project.clone().unwrap_or_else(|| "none".to_owned())],
            "query_parsed": {"cwd": ctx.cwd},
        }))
    }
    async fn get_item(&self, args: defs::GetItemArgs) -> Result<Value> {
        Ok(json!({"id": args.id}))
    }
    async fn list_collections(&self) -> Result<Value> {
        Ok(json!({"collections": []}))
    }
    async fn list_projects(&self) -> Result<Value> {
        Ok(json!({"projects": []}))
    }
    async fn add_project(&self, args: defs::AddProjectArgs) -> Result<Value> {
        Ok(json!({"job_id": "j", "path": args.path}))
    }
    async fn save_insight(&self, _ctx: &CallCtx, args: defs::SaveInsightArgs) -> Result<Value> {
        Ok(json!({"id": "i", "title": args.title}))
    }
    async fn kb_feedback(&self, args: defs::FeedbackArgs) -> Result<Value> {
        Ok(json!({"id": 1, "item_id": args.item_id}))
    }
    async fn reindex_project(&self, args: defs::ReindexArgs) -> Result<Value> {
        Ok(json!({"job_id": "j", "project": args.project}))
    }
    async fn set_item_status(&self, args: defs::SetStatusArgs) -> Result<Value> {
        Ok(json!({"id": args.id, "status": args.status}))
    }
    async fn supersede_insight(&self, args: defs::SupersedeArgs) -> Result<Value> {
        Ok(json!({"old_id": args.old_id, "new_id": args.new_id}))
    }
    async fn item_history(&self, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({"items": [], "id": args.id}))
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
    async fn file_raw(&self, args: defs::FileRawArgs) -> Result<Value> {
        // `path` 里带 big 时假装是个超大文件,用来验证 413(不真读盘)
        let size = if args.path.contains("big") {
            200 * 1024 * 1024
        } else {
            1
        };
        Ok(json!({ "path": "/tmp/a.png", "name": "a.png", "size": size, "mime": "image/png" }))
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
        Ok(json!({"jobs": []}))
    }
    async fn job_get(&self, args: defs::JobIdArgs) -> Result<Value> {
        Ok(json!({"job": {"id": args.id}}))
    }
    async fn job_cancel(&self, args: defs::JobIdArgs) -> Result<Value> {
        Ok(json!({"job_id": args.id}))
    }
    async fn eval_run(&self, _args: defs::EvalRunArgs) -> Result<Value> {
        Ok(json!({"hit_at_1": 1.0}))
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

/// 记录审计的空仓储。
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

fn state() -> Arc<AppState> {
    make_state(None, None)
}

fn make_state(
    mcp: Option<Arc<kb_web::mcp::McpEndpoint>>,
    events: Option<Arc<dyn kb_web::events::EventSink>>,
) -> Arc<AppState> {
    let registry = Arc::new(defs::build(Arc::new(StubBackend)));
    let dir = tempfile::tempdir().expect("临时 KB_HOME");
    let meta: Arc<dyn kb_core::ports::repo::MetaStore> =
        Arc::new(kb_meta::SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开 meta.db"));
    // 让临时目录活到进程结束(测试进程内足够)
    std::mem::forget(dir);
    Arc::new(AppState {
        invoker: Arc::new(kb_capability::Invoker::new(registry, Arc::new(NullAudit))),
        started: std::time::Instant::now(),
        version: "test",
        mcp,
        events,
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
        hub: std::sync::Arc::new(kb_web::EventHub::new()),
        uploads: None,
        agent_grants: std::sync::Arc::new(kb_web::AgentGrants::new()),
        collab: None,
        office: None,
    })
}

fn state_with_events(events: Option<Arc<dyn kb_web::events::EventSink>>) -> Arc<AppState> {
    make_state(None, events)
}

fn state_with_mcp(mcp: Option<Arc<kb_web::mcp::McpEndpoint>>) -> Arc<AppState> {
    make_state(mcp, None)
}

async fn get(kind: SocketKind, uri: &str) -> (StatusCode, Value) {
    let app = kb_web::build(state(), kind);
    let response = app
        .oneshot(
            Request::builder()
                .uri(uri)
                .body(Body::empty())
                .expect("请求"),
        )
        .await
        .expect("响应");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body");
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

#[tokio::test]
async fn uds_source_sees_capabilities() {
    let (status, body) = get(SocketKind::Unix, "/api/v1/capabilities?surface=mcp").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let tools = body["data"]["capabilities"].as_array().expect("列表");
    assert_eq!(tools.len(), 16, "MCP 面应有 16 个工具");
    assert!(tools.iter().any(|tool| tool["name"] == "search_knowledge"));
}

#[tokio::test]
async fn raw_route_reports_missing_files_and_requires_auth() {
    // 预览页读原件:桩后端给的是不存在的路径 → 404;TCP 未登录 → 401(不能绕过鉴权)
    let (status, body) = get(
        SocketKind::Unix,
        "/api/v1/raw?collection=proj_demo&path=a.png",
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"]["code"], "not_found", "{body}");

    let (status, body) = get(
        SocketKind::Tcp,
        "/api/v1/raw?collection=proj_demo&path=a.png",
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "unauthorized", "{body}");
}

#[tokio::test]
async fn tcp_source_only_reaches_health() {
    let (status, body) = get(SocketKind::Tcp, "/api/v1/health").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["status"], "ok");

    let (status, body) = get(SocketKind::Tcp, "/api/v1/capabilities").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(body["error"]["code"], "unauthorized");
}

#[tokio::test]
async fn public_skill_is_served_without_auth_from_both_paths() {
    // 公开 Skill 是给还没拿到令牌的 Agent 读的:TCP 未登录也必须 200,且内容与内核常量逐字节一致。
    let app = kb_web::build(state(), SocketKind::Tcp);
    for path in ["/skill.md", "/api/v1/skill"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(path)
                    .body(Body::empty())
                    .expect("请求"),
            )
            .await
            .expect("响应");
        assert_eq!(response.status(), StatusCode::OK, "{path}");
        assert_eq!(
            response.headers().get("content-type").unwrap(),
            "text/markdown; charset=utf-8",
            "{path}"
        );
        assert_eq!(
            response.headers().get("cache-control").unwrap(),
            "public, max-age=300",
            "{path}"
        );
        let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
            .await
            .expect("body");
        assert_eq!(bytes.as_ref(), kb_core::SKILL_MD.as_bytes(), "{path}");
        let text = String::from_utf8(bytes.to_vec()).expect("utf8");
        for forbidden in ["kb_ak_", "Bearer kb_", "{{"] {
            assert!(!text.contains(forbidden), "{path} 含 {forbidden:?}");
        }
    }
}

#[tokio::test]
async fn project_header_does_not_leak_between_requests() {
    let app = kb_web::build(state(), SocketKind::Unix);
    let call = |project: Option<&'static str>| {
        let app = app.clone();
        async move {
            let mut builder = Request::builder()
                .method("POST")
                .uri("/api/v1/capabilities/search_knowledge")
                .header("content-type", "application/json");
            if let Some(project) = project {
                builder = builder.header("x-kb-project", project);
            }
            let response = app
                .oneshot(builder.body(Body::from(r#"{"query":"x"}"#)).expect("请求"))
                .await
                .expect("响应");
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .expect("body");
            serde_json::from_slice::<Value>(&bytes).expect("JSON")
        }
    };

    let first = call(Some("proj_a")).await;
    assert_eq!(first["data"]["scope"][0], "proj_a");
    // 同一个 Router 上的下一个无头请求不能被上一次污染
    let second = call(None).await;
    assert_eq!(
        second["data"]["scope"][0], "none",
        "不应继承上一次的 X-KB-Project"
    );

    // 并发 6 个请求,各自的作用域互不影响
    let mut handles = Vec::new();
    for index in 0..6 {
        let project: &'static str = if index % 2 == 0 { "proj_a" } else { "proj_b" };
        handles.push(call(Some(project)));
    }
    for (index, handle) in handles.into_iter().enumerate() {
        let value = handle.await;
        let expected = if index % 2 == 0 { "proj_a" } else { "proj_b" };
        assert_eq!(value["data"]["scope"][0], expected);
    }
}

#[tokio::test]
async fn dry_run_is_honoured_over_rest() {
    let app = kb_web::build(state(), SocketKind::Unix);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/capabilities/save_insight?dry_run=true")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"title":"t","body":"b","global":true}"#))
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("JSON");
    assert_eq!(value["meta"]["dry_run"], true);
    assert_eq!(value["data"]["affected"], 0);
    assert!(value["data"]["plan"]["actions"].is_array());
    // 后端若被执行会返回 id=i
    assert!(value["data"].get("id").is_none());

    // 非法取值
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/capabilities/save_insight?dry_run=maybe")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"title":"t","body":"b","global":true}"#))
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn bad_header_encoding_is_rejected() {
    let app = kb_web::build(state(), SocketKind::Unix);
    for header in ["x-kb-cwd", "x-kb-client", "x-kb-project"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/v1/capabilities/search_knowledge")
                    .header("content-type", "application/json")
                    .header(header, "%zz")
                    .body(Body::from(r#"{"query":"x"}"#))
                    .expect("请求"),
            )
            .await
            .expect("响应");
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "{header} 应 400"
        );
    }

    // 原始非 ASCII 头(未编码)→ 400,而不是静默忽略
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/capabilities/search_knowledge")
                .header("content-type", "application/json")
                .header("x-kb-cwd", "/tmp/proj中文".as_bytes())
                .body(Body::from(r#"{"query":"x"}"#))
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert_eq!(
        response.status(),
        StatusCode::BAD_REQUEST,
        "未编码的非 ASCII 头应 400"
    );

    // 合法编码(中文 + 空格)应被解码后传给后端
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/capabilities/search_knowledge")
                .header("content-type", "application/json")
                .header("x-kb-cwd", kb_core::pct::encode("/tmp/我的 项目"))
                .body(Body::from(r#"{"query":"x"}"#))
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("JSON");
    assert_eq!(
        value["data"]["query_parsed"]["cwd"], "/tmp/我的 项目",
        "服务端应解码 X-KB-Cwd:{value}"
    );
}

#[tokio::test]
async fn events_endpoint_forwards_to_the_sink() {
    struct Stub;
    #[async_trait::async_trait]
    impl kb_web::events::EventSink for Stub {
        async fn handle_event(
            &self,
            _caller: &kb_web::auth::Caller,
            request: Value,
        ) -> kb_core::Result<Value> {
            if request.get("kind").is_none() {
                return Err(kb_core::KbError::InvalidInput("缺 kind".to_owned()));
            }
            Ok(json!({ "mode": "incremental", "kind": request["kind"] }))
        }
    }

    // 未注入 sink → 404
    let app = kb_web::build(state(), SocketKind::Unix);
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/events")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"kind":"git_commit"}"#))
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // 注入 sink → 200,原样转发
    let app = kb_web::build(state_with_events(Some(Arc::new(Stub))), SocketKind::Unix);
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/events")
                .header("content-type", "application/json")
                .body(Body::from(
                    r#"{"kind":"git_commit","project_root":"/tmp/x"}"#,
                ))
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
        .await
        .expect("body");
    let value: Value = serde_json::from_slice(&bytes).expect("JSON");
    assert_eq!(value["data"]["kind"], "git_commit");

    // 业务错误 → 400
    let response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/events")
                .header("content-type", "application/json")
                .body(Body::from(r#"{"project_root":"/tmp/x"}"#))
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn mcp_route_is_404_when_not_enabled() {
    let (status, _) = get(SocketKind::Tcp, "/mcp").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "未启用时应是 404");
}

#[tokio::test]
async fn mcp_route_requires_a_bearer_token() {
    let token_dir = tempfile::tempdir().expect("临时目录");
    let token_file = token_dir.path().join("mcp-token");
    std::fs::write(&token_file, "secret\n").expect("写 token");
    let gate = kb_web::mcp::McpGate {
        token_file,
        allowed_origins: vec!["https://kb.example.com".to_owned()],
        allowed_hosts: vec!["localhost".to_owned()],
    };
    let client = kb_mcp::uds::UdsClient::new("/tmp/kb-test-missing.sock");
    let app = kb_web::build(
        state_with_mcp(Some(Arc::new(kb_web::mcp::McpEndpoint::new(
            gate, client, 24_000,
        )))),
        SocketKind::Tcp,
    );

    // 无 token
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/mcp")
                .body(Body::empty())
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // 错 token
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/mcp")
                .header("authorization", "Bearer wrong")
                .body(Body::empty())
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    // 对 token:鉴权通过,请求会交给 MCP 服务(裸 GET 被它判为 400,但绝不能再是 401/403)
    let response = app
        .oneshot(
            Request::builder()
                .uri("/mcp")
                .header("authorization", "Bearer secret")
                .body(Body::empty())
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert!(
        !matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ),
        "带了正确 token 不应被鉴权拦下:{}",
        response.status()
    );
}

#[tokio::test]
async fn mcp_route_accepts_a_scope_mcp_api_token() {
    let token_dir = tempfile::tempdir().expect("临时目录");
    let token_file = token_dir.path().join("mcp-token");
    std::fs::write(&token_file, "secret\n").expect("写 token");
    let gate = kb_web::mcp::McpGate {
        token_file,
        allowed_origins: vec!["https://kb.example.com".to_owned()],
        allowed_hosts: vec!["kb.example.com".to_owned(), "localhost".to_owned()],
    };
    let client = kb_mcp::uds::UdsClient::new("/tmp/kb-test-missing.sock");
    let state = state_with_mcp(Some(Arc::new(kb_web::mcp::McpEndpoint::new(
        gate, client, 24_000,
    ))));
    let plaintext = "kb_mcp_page_token";
    // 令牌属于主知识库的所有者:第一个管理员接管主知识库
    let (admin, _) = state
        .system
        .create_user(kb_core::account::NewUser {
            username: "mcp_admin".to_owned(),
            email: None,
            display_name: None,
            password_hash: "$argon2id$x".to_owned(),
            role_id: kb_core::account::ROLE_ADMIN.to_owned(),
            status: kb_core::account::UserStatus::Active,
            registered_via: "test".to_owned(),
            must_change_password: false,
            email_verified: false,
        })
        .await
        .expect("建管理员");
    state
        .system
        .create_token(kb_core::account::UserToken {
            id: "tok-mcp".to_owned(),
            user_id: admin.id,
            name: "page".to_owned(),
            token_hash: kb_core::token::sha256_hex(plaintext),
            scopes: "mcp".to_owned(),
            include_shared: false,
            created_at: 1,
            last_used: None,
            revoked_at: None,
        })
        .await
        .expect("写入令牌");
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
                .body(Body::from(
                    r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}"#,
                ))
                .expect("请求"),
        )
        .await
        .expect("响应");
    assert!(
        !matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
        ),
        "scope=mcp 的页面令牌应能通过 /mcp,实际 {}",
        response.status()
    );
}

#[tokio::test]
async fn unknown_surface_is_rejected() {
    let (status, body) = get(SocketKind::Unix, "/api/v1/capabilities?surface=bogus").await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["error"]["code"], "invalid_input");
}

#[tokio::test]
async fn uds_listener_answers_and_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().expect("临时目录");
    let socket = dir.path().join("kb.sock");
    let (_tx, rx) = tokio::sync::watch::channel(false);
    let listener = kb_web::bind_uds(&socket).expect("绑定 UDS");
    let handle = tokio::spawn({
        let socket = socket.clone();
        async move {
            kb_web::serve_uds_listener(listener, state(), socket, kb_web::SocketKind::Unix, rx)
                .await
        }
    });
    // 等 socket 出现
    for _ in 0..100 {
        if socket.exists() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(socket.exists(), "UDS 文件应被创建");
    let mode = std::fs::metadata(&socket)
        .expect("stat")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "UDS 应是 0600,实际 {mode:o}");

    // 手写一个 HTTP/1.1 请求
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::UnixStream::connect(&socket)
        .await
        .expect("连接");
    stream
        .write_all(b"GET /api/v1/health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .await
        .expect("写请求");
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.expect("读响应");
    let text = String::from_utf8_lossy(&response);
    assert!(text.starts_with("HTTP/1.1 200"), "{text}");
    assert!(text.contains("\"status\":\"ok\""), "{text}");

    handle.abort();
}

async fn post_json(
    state: Arc<AppState>,
    kind: SocketKind,
    uri: &str,
    bearer: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder()
        .method("POST")
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = bearer {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    let app = kb_web::build(state, kind);
    let response = app
        .oneshot(builder.body(Body::from(body.to_string())).expect("请求"))
        .await
        .expect("响应");
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("body");
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

#[tokio::test]
async fn agent_socket_is_write_scoped_and_cannot_reconfigure() {
    let state = state();
    state.agent_grants.insert_known(
        "sess-token".to_owned(),
        kb_web::AgentGrant {
            tool_groups: vec!["knowledge".to_owned()],
            project: None,
            session_id: "s1".to_owned(),
            principal: None,
            include_shared: false,
        },
    );
    let (status, _) = post_json(
        state.clone(),
        SocketKind::Agent,
        "/api/v1/capabilities/search_knowledge",
        None,
        json!({ "query": "x" }),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "没有令牌不能用 agent.sock"
    );

    let (status, body) = post_json(
        state.clone(),
        SocketKind::Agent,
        "/api/v1/capabilities/search_knowledge",
        Some("sess-token"),
        json!({ "query": "x" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    for name in [
        "acp_set_sandbox",
        "acp_save_agent",
        "update_config",
        "reindex_project",
    ] {
        let (status, body) = post_json(
            state.clone(),
            SocketKind::Agent,
            &format!("/api/v1/capabilities/{name}"),
            Some("sess-token"),
            json!({ "confirm": true, "sandbox": false, "id": "x", "name": "x", "command": "/bin/true" }),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{name} 应被拒绝: {body}");
    }
    let (status, body) = post_json(
        state,
        SocketKind::Agent,
        "/api/v1/uploads",
        Some("sess-token"),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "上传不在能力面: {body}");
}

/// 整条链路(内嵌静态资源 + 外层 gzip 压缩层):接受 br 拿构建期 `.br` 原样发出、不被压缩层二次编码;
/// 只接受 gzip 的客户端由压缩层现场 gzip(wasm 的 MIME 必须是 application/wasm 才会压);都不接受发原文。
/// 只在 `npm run build` 之后有 `.wasm.br` 时才有意义,否则跳过。
#[tokio::test]
async fn embedded_engine_wasm_negotiates_encoding_end_to_end() {
    let assets = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web-ui/dist/assets");
    let Some(wasm) = std::fs::read_dir(&assets).ok().and_then(|entries| {
        entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .find(|name| name.ends_with(".wasm") && assets.join(format!("{name}.br")).exists())
    }) else {
        return;
    };
    let raw_len = std::fs::metadata(assets.join(&wasm)).expect("原文件").len() as usize;
    let fetch = |encoding: Option<&'static str>| {
        let uri = format!("/assets/{wasm}");
        async move {
            let mut request = Request::builder().uri(uri);
            if let Some(encoding) = encoding {
                request = request.header("accept-encoding", encoding);
            }
            let response = kb_web::build(state(), SocketKind::Tcp)
                .oneshot(request.body(Body::empty()).expect("请求"))
                .await
                .expect("响应");
            let headers = response.headers().clone();
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("body");
            (headers, body.len())
        }
    };
    let (br, br_len) = fetch(Some("gzip, deflate, br")).await;
    assert_eq!(br["content-encoding"], "br");
    assert_eq!(br["content-type"], "application/wasm");
    assert!(br_len * 3 < raw_len, "br 应远小于原文:{br_len} / {raw_len}");
    let (gz, gz_len) = fetch(Some("gzip")).await;
    assert_eq!(
        gz["content-encoding"], "gzip",
        "只认 gzip 的客户端由压缩层现场压"
    );
    assert!(gz_len < raw_len);
    let (plain, plain_len) = fetch(None).await;
    assert!(plain.get("content-encoding").is_none());
    assert_eq!(plain_len, raw_len);
}
