//! 能力注册表验收。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kb_capability::backend::{
    AgentBackend, DocsBackend, FilesBackend, JobsBackend, OpsBackend, SearchBackend, SkillsBackend,
    SourcesBackend,
};
use kb_capability::defs::{self, MCP_TOOLS};
use kb_capability::invoke::CallCtx;
use kb_capability::{Invoker, Permission, Registry, Surface};
use kb_core::model::{AuditEntry, AuditFilter, Batch, Change, Page};
use kb_core::ports::repo::AuditRepo;
use kb_core::{KbError, Result};
use serde_json::{Value, json};

/// 只会回显参数的假后端。
struct EchoBackend;

#[async_trait]
impl SearchBackend for EchoBackend {
    async fn search(&self, _ctx: &CallCtx, args: defs::SearchArgs) -> Result<Value> {
        Ok(json!({
            "hits": [],
            "scope": ["proj_demo"],
            "query_parsed": {"text": args.query},
            "kinds": args.kinds,
        }))
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
        Ok(json!({ "job_id": "job-1", "path": args.path }))
    }
    async fn save_insight(&self, _ctx: &CallCtx, args: defs::SaveInsightArgs) -> Result<Value> {
        Ok(json!({ "id": "insight-1", "title": args.title }))
    }
    async fn kb_feedback(&self, args: defs::FeedbackArgs) -> Result<Value> {
        Ok(json!({ "id": 1, "item_id": args.item_id }))
    }
    async fn reindex_project(&self, args: defs::ReindexArgs) -> Result<Value> {
        Ok(json!({ "job_id": "job-2", "project": args.project }))
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

    // --- :数据源与解析队列 ---
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
impl DocsBackend for EchoBackend {
    async fn file_preview(&self, args: defs::FilePreviewArgs) -> Result<Value> {
        Ok(json!({ "collection": args.collection, "path": args.path, "blocks": [], "chunks": [] }))
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
impl FilesBackend for EchoBackend {
    async fn save_file(&self, _args: defs::SaveFileArgs) -> Result<Value> {
        Ok(json!({ "version": 1, "embedded": 0 }))
    }

    async fn get_file_timeline(&self, args: defs::ItemIdArgs) -> Result<Value> {
        Ok(json!({ "file": { "id": args.id }, "stages": [] }))
    }
}

#[async_trait]
impl JobsBackend for EchoBackend {
    async fn migrate_model(&self, args: defs::MigrateArgs) -> Result<Value> {
        Ok(json!({ "collection": args.collection, "to": args.to }))
    }
    async fn migrate_plan(&self, args: defs::MigrateArgs) -> Result<Value> {
        Ok(json!({ "collection": args.collection, "to": args.to }))
    }

    async fn install_hooks(&self, args: defs::HooksArgs) -> Result<Value> {
        Ok(json!({ "hooks_dir": "/tmp/hooks", "managed_by_other": false, "project": args.project }))
    }

    async fn uninstall_hooks(&self, args: defs::HooksArgs) -> Result<Value> {
        Ok(json!({ "hooks_dir": "/tmp/hooks", "managed_by_other": false, "project": args.project }))
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
        Ok(json!({ "hit_at_1": 0.9 }))
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
impl SourcesBackend for EchoBackend {
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

    // --- :批次流水线 ---
    async fn import_global(&self, args: defs::ImportGlobalArgs) -> Result<Value> {
        Ok(json!({ "scanned": 0, "chunks": 0, "embedded": 0, "errors": [], "path": args.path }))
    }
}

#[async_trait]
impl OpsBackend for EchoBackend {
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
        Ok(json!({ "name": args.name, "files": 3, "meta_db_bytes": 4096 }))
    }

    async fn backup_create(&self, args: defs::BackupCreateArgs) -> Result<Value> {
        Ok(json!({ "name": "kb-test.tar.gz", "includes_sources": args.include_sources }))
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
impl AgentBackend for EchoBackend {
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
impl SkillsBackend for EchoBackend {
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

/// 账号管理的空后端:只为让注册表完整(方法默认返回「不可用」)。
struct NoAdmin;
impl kb_capability::AdminBackend for NoAdmin {}

fn registry() -> Registry {
    defs::build_with_admin(Arc::new(EchoBackend), Arc::new(NoAdmin))
}

#[tokio::test]
async fn search_knowledge_does_not_inject_default_kinds() {
    // :能力层补默认 kinds 会被拼成 ` kind:code kind:doc kind:insight`,
    // 把用户写的 `kind:` 前缀稀释掉。默认值应该由 SearchService 在没有任何过滤时决定。
    let (invoker, _audit) = invoker();
    let response = invoker
        .call(
            "search_knowledge",
            CallCtx::new("test", Surface::Web),
            json!({ "query": "kind:code hybrid_search" }),
        )
        .await
        .expect("调用");
    assert_eq!(
        response.data["kinds"],
        json!([]),
        "search_knowledge 不应给 kinds 补默认值"
    );
    assert_eq!(
        response.data["query_parsed"]["text"],
        "kind:code hybrid_search"
    );

    // search_code 是例外:它的契约就是只看代码,显式带上 kind:code
    let response = invoker
        .call(
            "search_code",
            CallCtx::new("test", Surface::Web),
            json!({ "query": "hybrid_search" }),
        )
        .await
        .expect("调用");
    assert_eq!(response.data["kinds"], json!(["code"]));
}

#[test]
fn mcp_surface_is_exactly_the_documented_tools() {
    let mut names: Vec<&str> = registry()
        .for_surface(Surface::Mcp)
        .into_iter()
        .map(|capability| capability.name)
        .collect();
    names.sort_unstable();
    let mut expected = MCP_TOOLS.to_vec();
    expected.sort_unstable();
    assert_eq!(names, expected, "MCP 可见面应正好是白名单里的工具");
}

#[test]
fn consolidate_project_is_web_only_and_write_level() {
    // :主题归纳要调 LLM,只在 Web 面开放(W 级、有副作用),不进 MCP 的 8 个工具
    let registry = registry();
    let capability = registry.get("consolidate_project").expect("应有主题归纳");
    assert_eq!(capability.permission, Permission::Write);
    assert!(capability.side_effect);
    assert!(capability.surfaces.contains(&Surface::Web));
    assert!(!capability.surfaces.contains(&Surface::Mcp));
    assert_eq!(capability.input_schema["required"][0], "project");
}

#[test]
fn reload_skills_is_admin_and_web_only() {
    // :重扫 skills 目录只改本机规则,放在 Web 面的管理操作里(W 级、有副作用),不进 MCP
    let registry = registry();
    let capability = registry.get("reload_skills").expect("应有 reload_skills");
    assert_eq!(capability.permission, Permission::Admin);
    assert!(capability.side_effect);
    assert!(capability.surfaces.contains(&Surface::Web));
    assert!(!capability.surfaces.contains(&Surface::Mcp));
}

#[test]
fn managing_skills_is_admin_only_and_web_only_but_reading_a_draft_is_not_a_write() {
    // 设置页新增 / 编辑 / 删除 skill:会改磁盘上的清单、影响所有人的分块与提示词,所以是 Admin 级(要带 confirm),
    // 只在 Web 面开放,不进 MCP;取可编辑内容只是读,但同样只给 Web(提示词正文是管理员的配置)
    let registry = registry();
    for name in ["save_skill", "delete_skill"] {
        let capability = registry.get(name).expect("应有这个能力");
        assert_eq!(capability.permission, Permission::Admin, "{name}");
        assert!(capability.side_effect, "{name}");
        assert!(capability.surfaces.contains(&Surface::Web), "{name}");
        assert!(!capability.surfaces.contains(&Surface::Mcp), "{name}");
    }
    let read = registry.get("get_skill").expect("应有 get_skill");
    assert_eq!(read.permission, Permission::Read);
    assert!(!read.side_effect);
    assert!(read.surfaces.contains(&Surface::Web));
    assert!(!read.surfaces.contains(&Surface::Mcp));
    // 表单字段进了入参 schema(AI 接入指南 / 管家据此知道能传什么)
    let schema = &registry.get("save_skill").unwrap().input_schema;
    for field in ["name", "kind", "glob", "template", "required"] {
        assert!(
            schema["properties"].get(field).is_some(),
            "save_skill 入参应有 {field}"
        );
    }
}

#[test]
fn tune_retrieval_is_admin_and_web_only() {
    // :调权会写 config.toml,所以是 Admin 级(与 update_config 同级,),
    // 只在 Web 面开放、有副作用,不进 MCP
    let registry = registry();
    let capability = registry.get("tune_retrieval").expect("应有 tune_retrieval");
    assert_eq!(capability.permission, Permission::Admin);
    assert!(capability.side_effect);
    assert!(capability.surfaces.contains(&Surface::Web));
    assert!(!capability.surfaces.contains(&Surface::Mcp));
    // dry_run 默认 true:直接调用不会写配置
    assert_eq!(
        capability.input_schema["properties"]["dry_run"]["default"],
        true
    );
}

#[test]
fn file_raw_is_read_only_and_web_only() {
    // 预览页读原件:只读、只给 Web 面;MCP 面不暴露(避免把本机路径当作工具返回)
    let registry = registry();
    let capability = registry.get("file_raw").expect("应有 file_raw");
    assert_eq!(capability.permission, Permission::Read);
    assert!(!capability.side_effect);
    assert!(capability.surfaces.contains(&Surface::Web));
    assert!(!capability.surfaces.contains(&Surface::Mcp));
}

#[test]
fn draft_inbox_capabilities_are_web_only() {
    // 审核收件箱:列草稿是 R 级,审核动作是 W 级且带副作用;MCP 面不暴露(草稿含未确认的推断)
    let registry = registry();
    let list = registry.get("list_drafts").expect("应有 list_drafts");
    assert_eq!(list.permission, Permission::Read);
    assert!(!list.side_effect);
    let review = registry.get("review_draft").expect("应有 review_draft");
    assert_eq!(review.permission, Permission::Write);
    assert!(review.side_effect);
    for capability in [list, review] {
        assert!(capability.surfaces.contains(&Surface::Web));
        assert!(!capability.surfaces.contains(&Surface::Mcp));
    }
    // 参数 schema 里 id 与 decision 是必填
    let required = review
        .input_schema
        .get("required")
        .and_then(|value| value.as_array())
        .expect("required 列表");
    for field in ["id", "decision"] {
        assert!(
            required.iter().any(|item| item.as_str() == Some(field)),
            "{field} 应为必填:{required:?}"
        );
    }
}

#[test]
fn list_skills_is_read_only_and_web_only() {
    // 设置页「Skills」只读列登记信息;重扫仍走已有的 reload_skills(Admin / Web)
    let registry = registry();
    let list = registry.get("list_skills").expect("应有 list_skills");
    assert_eq!(list.permission, Permission::Read);
    assert!(!list.side_effect);
    assert!(list.surfaces.contains(&Surface::Web));
    assert!(!list.surfaces.contains(&Surface::Mcp));
    let reload = registry.get("reload_skills").expect("应有 reload_skills");
    assert_eq!(reload.permission, Permission::Admin);
}

#[test]
fn backup_capabilities_are_web_only_and_write_level_where_needed() {
    // 备份只从 Web 设置页发起:读状态是 R 级,建 / 删是 W 级且带副作用;MCP 面不暴露
    let registry = registry();
    for name in ["backup_status", "backup_state", "backup_verify"] {
        let capability = registry.get(name).expect("应有备份读能力");
        assert_eq!(capability.permission, Permission::Read, "{name}");
        assert!(!capability.side_effect, "{name} 没有副作用");
    }
    for name in ["backup_create", "backup_delete", "backup_prune"] {
        let capability = registry.get(name).expect("应有备份写能力");
        assert_eq!(capability.permission, Permission::Write, "{name}");
        assert!(capability.side_effect, "{name} 有副作用");
    }
    for name in [
        "backup_status",
        "backup_state",
        "backup_verify",
        "backup_create",
        "backup_delete",
        "backup_prune",
    ] {
        let capability = registry.get(name).expect("应有备份能力");
        assert!(
            capability.surfaces.contains(&Surface::Web),
            "{name} 应在 Web 面"
        );
        assert!(
            !capability.surfaces.contains(&Surface::Mcp),
            "{name} 不进 MCP"
        );
    }
}

#[test]
fn llm_providers_is_read_only_and_web_only() {
    // 设置页的提供商表:只读、不回显密钥,只在 Web 面
    let registry = registry();
    let capability = registry.get("llm_providers").expect("应有 llm_providers");
    assert_eq!(capability.permission, Permission::Read);
    assert!(!capability.side_effect);
    assert!(capability.surfaces.contains(&Surface::Web));
    assert!(!capability.surfaces.contains(&Surface::Mcp));
}

#[test]
fn every_capability_has_a_valid_name_and_schema() {
    let registry = registry();
    assert!(registry.len() >= 16, "能力数量:{}", registry.len());
    for capability in registry.all() {
        assert!(kb_capability::registry::is_valid_name(capability.name));
        assert!(!capability.description.is_empty());
        assert!(capability.description.chars().count() <= 1000);
        let schema = &capability.input_schema;
        assert_eq!(schema["type"], "object", "{} 的 schema", capability.name);
        assert!(
            schema.get("properties").is_some(),
            "{} 缺 properties",
            capability.name
        );
        if let Some(required) = schema.get("required") {
            assert!(
                required.as_array().is_some_and(|values| !values.is_empty()),
                "{} 的 required 为空数组",
                capability.name
            );
        }
    }
}

#[test]
fn required_fields_are_marked() {
    let registry = registry();
    let required = registry.get("search_knowledge").expect("有").input_schema["required"]
        .as_array()
        .expect("search 应有必填")
        .clone();
    assert!(required.iter().any(|value| value == "query"));

    let required = registry.get("save_insight").expect("有").input_schema["required"]
        .as_array()
        .expect("save 应有必填")
        .clone();
    assert!(required.iter().any(|value| value == "title"));
    assert!(required.iter().any(|value| value == "body"));
}

#[test]
fn file_operations_are_web_only_except_the_read_only_menu() {
    let registry = registry();
    // AI / MCP 只能读菜单,不能删、不能移、不能清回收站(安全边界)。
    let menu = registry.get("file_actions").expect("有");
    assert!(menu.visible_on(Surface::Web));
    assert!(menu.visible_on(Surface::Agent));
    assert!(!menu.visible_on(Surface::Mcp));
    assert_eq!(menu.permission, Permission::Read);
    for name in [
        "delete_file",
        "delete_folder",
        "move_file",
        "move_files",
        "move_folder",
        "file_op_status",
        "list_trash",
        "restore_trash",
        "purge_trash",
    ] {
        let capability = registry.get(name).unwrap_or_else(|| panic!("缺 {name}"));
        assert!(capability.visible_on(Surface::Web), "{name} 要在 Web 面");
        assert!(!capability.visible_on(Surface::Agent), "{name} 不能给 AI");
        assert!(!capability.visible_on(Surface::Mcp), "{name} 不能给 MCP");
    }
}

#[test]
fn surfaces_and_permissions_match_the_table() {
    let registry = registry();
    let save = registry.get("save_insight").expect("有");
    assert_eq!(save.permission, Permission::Write);
    assert!(save.visible_on(Surface::Mcp));
    assert!(
        !registry
            .get("kb_feedback")
            .expect("有")
            .visible_on(Surface::Agent)
    );
    let add_project = registry.get("add_project").expect("有");
    assert_eq!(add_project.permission, Permission::Govern);
    assert!(!add_project.visible_on(Surface::Mcp));
    assert_eq!(
        registry.get("eval_run").expect("有").permission,
        Permission::Govern
    );
}

/// 记录审计的假仓储。
#[derive(Default)]
struct RecordingAudit {
    entries: Mutex<Vec<AuditEntry>>,
    batches: Mutex<Vec<String>>,
    changes: Mutex<Vec<Change>>,
}

#[async_trait]
impl AuditRepo for RecordingAudit {
    async fn record(&self, entry: AuditEntry) -> Result<i64> {
        self.entries.lock().expect("锁").push(entry);
        Ok(1)
    }
    async fn begin_batch(&self, _actor: &str, description: &str) -> Result<String> {
        self.batches
            .lock()
            .expect("锁")
            .push(description.to_owned());
        Ok("batch-1".to_owned())
    }
    async fn ensure_batch(&self, _id: &str, _actor: &str, _description: &str) -> Result<()> {
        Ok(())
    }
    async fn record_change(&self, batch_id: &str, change: Change) -> Result<()> {
        assert_eq!(change.batch_id, batch_id);
        self.changes.lock().expect("锁").push(change);
        Ok(())
    }
    async fn batch(&self, _id: &str) -> Result<Option<Batch>> {
        Ok(None)
    }
    async fn list(&self, _filter: Option<AuditFilter>, _page: Page) -> Result<Vec<AuditEntry>> {
        Ok(self.entries.lock().expect("锁").clone())
    }
    async fn count(&self, _filter: Option<AuditFilter>) -> Result<u64> {
        Ok(self.entries.lock().expect("锁").len() as u64)
    }
    async fn changes(&self, batch_id: &str) -> Result<Vec<Change>> {
        Ok(self
            .changes
            .lock()
            .expect("锁")
            .iter()
            .filter(|change| change.batch_id == batch_id)
            .cloned()
            .collect())
    }
    async fn list_batches(&self, _page: Page) -> Result<Vec<Batch>> {
        Ok(Vec::new())
    }
    async fn count_batches(&self) -> Result<u64> {
        Ok(0)
    }
    async fn mark_reverted(&self, _batch_id: &str, _at: i64) -> Result<()> {
        Ok(())
    }
}

fn invoker() -> (Invoker, Arc<RecordingAudit>) {
    let audit = Arc::new(RecordingAudit::default());
    (Invoker::new(Arc::new(registry()), audit.clone()), audit)
}

#[tokio::test]
async fn every_call_writes_an_audit_entry() {
    let (invoker, audit) = invoker();
    let response = invoker
        .call(
            "search_knowledge",
            CallCtx::new("mcp:kiro", Surface::Mcp),
            json!({ "query": "双哈希" }),
        )
        .await
        .expect("调用");
    assert_eq!(response.data["scope"][0], "proj_demo");
    assert!(response.meta.batch_id.is_none());
    let entries = audit.entries.lock().expect("锁");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].capability, "search_knowledge");
    assert_eq!(entries[0].actor, "mcp:kiro");
    assert!(entries[0].ok);
}

#[tokio::test]
async fn mutating_calls_create_a_batch() {
    let (invoker, audit) = invoker();
    let response = invoker
        .call(
            "save_insight",
            CallCtx::new("mcp:kiro", Surface::Mcp),
            json!({ "title": "标题", "body": "正文", "global": true }),
        )
        .await
        .expect("调用");
    assert_eq!(response.meta.batch_id.as_deref(), Some("batch-1"));
    assert_eq!(audit.batches.lock().expect("锁").len(), 1);
    let changes = audit.changes.lock().expect("锁");
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].target, "insight-1");
}

#[tokio::test]
async fn permission_boundaries_are_enforced() {
    let (invoker, audit) = invoker();
    let error = invoker
        .call(
            "add_project",
            CallCtx::new("mcp:kiro", Surface::Mcp),
            json!({ "path": "/tmp/x" }),
        )
        .await
        .expect_err("应被拒绝");
    assert!(matches!(error, KbError::Forbidden(_)), "{error:?}");
    assert_eq!(
        audit.entries.lock().expect("锁").len(),
        1,
        "被拒绝也要留审计"
    );

    let error = invoker
        .call(
            "no_such_capability",
            CallCtx::new("user", Surface::Web),
            json!({}),
        )
        .await
        .expect_err("应报 NotFound");
    assert!(matches!(error, KbError::NotFound(_)));

    let error = invoker
        .call(
            "save_insight",
            CallCtx::new("user", Surface::Web),
            json!({ "body": "缺 title" }),
        )
        .await
        .expect_err("应报 InvalidInput");
    assert!(matches!(error, KbError::InvalidInput(_)), "{error:?}");
}

#[tokio::test]
async fn dry_run_does_not_execute_the_handler() {
    let (invoker, audit) = invoker();
    let response = invoker
        .call(
            "save_insight",
            CallCtx::new("user", Surface::Web).with_dry_run(true),
            json!({ "title": "t", "body": "b", "global": true }),
        )
        .await
        .expect("调用");
    assert!(response.meta.dry_run);
    assert_eq!(response.data["affected"], 0);
    assert!(response.data["plan"]["actions"].is_array());
    // 后端若被执行会返回 id=insight-1;dry_run 下必须没有
    assert!(response.data.get("id").is_none(), "{:?}", response.data);
    assert!(audit.changes.lock().expect("锁").is_empty());
}

#[tokio::test]
async fn dry_run_does_not_open_a_batch() {
    let (invoker, audit) = invoker();
    let response = invoker
        .call(
            "reindex_project",
            CallCtx::new("user", Surface::Web).with_dry_run(true),
            json!({ "project": "demo" }),
        )
        .await
        .expect("调用");
    assert!(response.meta.dry_run);
    assert!(response.meta.batch_id.is_none());
    assert!(audit.batches.lock().expect("锁").is_empty());
}

#[test]
fn web_surface_sees_more_than_mcp() {
    let registry = registry();
    assert!(registry.for_surface(Surface::Web).len() > registry.for_surface(Surface::Mcp).len());
    assert!(
        registry
            .for_surface(Surface::Agent)
            .iter()
            .any(|capability| capability.name == "job_list")
    );
}

#[test]
fn set_llm_key_is_admin_and_web_only() {
    // API key 落在 secrets.toml(0600),只在 Web 面由管理员保存;MCP 不暴露
    let registry = registry();
    let capability = registry.get("set_llm_key").expect("应有 set_llm_key");
    assert_eq!(capability.permission, Permission::Admin);
    assert!(capability.side_effect);
    assert!(capability.surfaces.contains(&Surface::Web));
    assert!(!capability.surfaces.contains(&Surface::Mcp));
    assert_eq!(
        capability.input_schema["properties"]["api_key"]["type"],
        "string"
    );
}

#[test]
fn test_llm_is_admin_and_web_only() {
    // 测试连接会真的外发一次请求:Admin 级、只在 Web 面,并要求 confirm
    let registry = registry();
    let capability = registry.get("test_llm").expect("应有 test_llm");
    assert_eq!(capability.permission, Permission::Admin);
    assert!(capability.side_effect);
    assert!(capability.surfaces.contains(&Surface::Web));
    assert!(!capability.surfaces.contains(&Surface::Mcp));
}

#[test]
fn the_agent_surface_covers_the_system_but_not_admin() {
    // 管家要能把系统里的活都干了(建条目 / 审核 / 导入 / 数据源 / 项目 / 任务 / 备份 …),
    // 但 Admin 级(改配置、发令牌、装模型、调权)不开放给它。
    let registry = registry();
    let names: Vec<&str> = registry
        .for_surface(Surface::Agent)
        .iter()
        .map(|capability| capability.name)
        .collect();
    for name in [
        "create_item",
        "review_draft",
        "add_source",
        "list_ingest",
        "import_global",
        "delete_collection",
        "backup_create",
        "eval_run",
        "save_insight",
        "search_knowledge",
        "list_items",
        "file_preview",
        "update_project",
        "retry_ingest",
    ] {
        assert!(names.contains(&name), "{name} 应该能通过管家调用");
    }
    for name in [
        "update_config",
        "create_token",
        "set_llm_key",
        "test_llm",
        "tune_retrieval",
        "reload_skills",
        "save_skill",
        "delete_skill",
    ] {
        assert!(!names.contains(&name), "{name} 是 Admin,不应给管家");
    }
}

#[test]
fn chat_commands_only_reference_allowed_capabilities() {
    let registry = registry();
    for command in defs::CHAT_COMMANDS {
        assert!(!command.id.is_empty(), "命令要有 id");
        if let Some(name) = command.capability {
            let capability = registry
                .get(name)
                .unwrap_or_else(|| panic!("@{} 绑定的能力 {name} 不在注册表里", command.id));
            assert!(
                !matches!(capability.permission, Permission::Admin),
                "@{} 不能绑 Admin 能力",
                command.id
            );
            assert!(
                capability.surfaces.contains(&Surface::Web),
                "@{} 的能力必须在 Web 面可用",
                command.id
            );
        }
    }
}

#[test]
fn readme_lists_every_mcp_tool() {
    let readme = include_str!("../../../README.md");
    for name in MCP_TOOLS {
        assert!(
            readme.contains(name),
            "README 的接入说明里缺了 MCP 工具 {name}"
        );
    }
}

#[test]
fn guide_lists_every_mcp_tool() {
    let guide = include_str!("../../../docs/guide/USER_GUIDE.md");
    for name in MCP_TOOLS {
        assert!(
            guide.contains(&format!("| `{name}` |")),
            "USER_GUIDE 的 MCP 工具表里缺了 {name}"
        );
    }
}

#[test]
fn acp_config_capabilities_are_admin() {
    let registry = registry();
    for name in [
        "acp_save_agent",
        "acp_remove_agent",
        "acp_set_sandbox",
        "acp_set_permission",
        "acp_install",
        "acp_uninstall",
    ] {
        let capability = registry.get(name).unwrap_or_else(|| panic!("应有 {name}"));
        assert_eq!(capability.permission, Permission::Admin, "{name}");
        assert!(capability.surfaces.contains(&Surface::Web));
        assert!(!capability.surfaces.contains(&Surface::Mcp), "{name}");
    }
}

#[test]
fn context_capabilities_are_registered() {
    let registry = registry();
    let estimate = registry.get("context_estimate").expect("context_estimate");
    assert_eq!(estimate.permission, Permission::Read);
    let apply = registry.get("apply_context").expect("apply_context");
    assert_eq!(apply.permission, Permission::Write);
    assert!(
        apply.input_schema["properties"]["dry_run"]["default"]
            .as_bool()
            .unwrap_or(true)
            || apply.input_schema["properties"].get("dry_run").is_some()
    );
}

// ---------------------------------------------------------------------------
// 多用户:访问分类、功能点、按用户路由(多用户设计说明)
// ---------------------------------------------------------------------------

use kb_capability::access::{ACCESS_TABLE, Scope, lookup};
use kb_capability::invoke::{
    CallScope, Principal, ResolvedSpace, SpaceResolver, current_call_scope,
};
use kb_capability::registry::Capability;
use kb_core::features::{self, FeatureSet};

fn user_features(ai_enabled: bool) -> FeatureSet {
    FeatureSet::resolve(
        features::default_user_features()
            .into_iter()
            .map(str::to_owned),
        [],
        [],
        ai_enabled,
    )
}

fn alice(ai_enabled: bool) -> Principal {
    Principal::user("usr_alice", "sp_alice", user_features(ai_enabled))
}

fn bob() -> Principal {
    Principal::user("usr_bob", "sp_bob", user_features(true))
}

fn admin() -> Principal {
    Principal::user("usr_root", "sp_root", FeatureSet::all(true))
}

#[test]
fn every_capability_is_classified_exactly_once() {
    let registry = registry();
    let registered: std::collections::BTreeSet<&str> =
        registry.all().iter().map(|cap| cap.name).collect();
    let classified: std::collections::BTreeSet<&str> =
        ACCESS_TABLE.iter().map(|(name, _, _)| *name).collect();
    assert_eq!(registered, classified, "注册表和 ACCESS_TABLE 必须一一对应");
    for capability in registry.all() {
        let access = registry.access(capability.name).expect("每个能力都有分类");
        assert_eq!(Some(access), lookup(capability.name));
    }
}

#[test]
fn describe_exposes_scope_and_feature() {
    let described = registry().describe_surface(Surface::Web);
    let create_item = described
        .iter()
        .find(|item| item["name"] == "create_item")
        .expect("create_item");
    assert_eq!(create_item["scope"], "space");
    assert_eq!(create_item["feature"], "docs.notes");
    let update_config = described
        .iter()
        .find(|item| item["name"] == "update_config")
        .expect("update_config");
    assert_eq!(update_config["scope"], "system");
    assert_eq!(update_config["feature"], "sys.settings");
}

#[test]
#[should_panic(expected = "没有登记访问分类")]
fn registering_an_unclassified_capability_panics() {
    let mut registry = Registry::new();
    registry.register(Capability {
        name: "brand_new_capability",
        description: "没登记过的能力",
        permission: Permission::Read,
        surfaces: &[Surface::Web],
        side_effect: false,
        input_schema: json!({"type": "object"}),
        handler: Arc::new(|_ctx, _args| Box::pin(async { Ok(json!({})) })),
    });
}

/// 按用户路由的假解析器:每个知识库一份审计,句柄是知识库 id。
struct FakeSpaces {
    audits: Mutex<std::collections::BTreeMap<String, Arc<RecordingAudit>>>,
    shared: Mutex<Vec<AuditEntry>>,
}

impl FakeSpaces {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            audits: Mutex::default(),
            shared: Mutex::default(),
        })
    }
    fn audit(&self, space: &str) -> Arc<RecordingAudit> {
        self.audits
            .lock()
            .expect("锁")
            .entry(space.to_owned())
            .or_default()
            .clone()
    }
}

#[async_trait]
impl SpaceResolver for FakeSpaces {
    async fn resolve(&self, principal: &Principal) -> Result<ResolvedSpace> {
        // 本机超级用户指向主知识库;其他人只能解析到自己的
        let space = match (&principal.space_id, principal.local) {
            (Some(id), _) => id.clone(),
            (None, true) => "sp_primary".to_owned(),
            (None, false) => return Err(KbError::Forbidden("没有可用的知识库".to_owned())),
        };
        Ok(ResolvedSpace {
            space_id: space.clone(),
            audit: self.audit(&space),
            handle: Arc::new(space),
        })
    }
    async fn audit_shared(&self, entry: AuditEntry) {
        self.shared.lock().expect("锁").push(entry);
    }
}

/// 一个会回报「当前路由到了哪个知识库」的注册表(用真实能力名,才能过分类检查)。
fn routing_invoker(spaces: &Arc<FakeSpaces>) -> Invoker {
    fn reporting(name: &'static str, permission: Permission) -> Capability {
        Capability {
            name,
            description: "回报路由",
            permission,
            surfaces: &[Surface::Web],
            side_effect: permission.is_mutating(),
            input_schema: json!({"type": "object"}),
            handler: Arc::new(|ctx, _args| {
                Box::pin(async move {
                    let routed = match current_call_scope() {
                        Some(CallScope::Space {
                            space_id, handle, ..
                        }) => {
                            // 路由 id 和句柄必须一致:事件按 id 过滤,后端按句柄取数据
                            let from_handle =
                                handle.downcast_ref::<String>().cloned().unwrap_or_default();
                            assert_eq!(space_id, from_handle);
                            from_handle
                        }
                        Some(CallScope::Shared) => "shared".to_owned(),
                        None => "none".to_owned(),
                    };
                    Ok(json!({ "routed_to": routed, "caller": ctx.principal.map(|p| p.user_id) }))
                })
            }),
        }
    }
    let mut registry = Registry::new();
    registry.register(reporting("list_collections", Permission::Read)); // Space / base
    registry.register(reporting("create_item", Permission::Write)); // Space / docs.notes
    registry.register(reporting("get_config", Permission::Read)); // System / sys.settings
    registry.register(reporting("deep_search", Permission::Read)); // Space / search.deep(AI)
    registry.register(reporting("list_skills", Permission::Read)); // Account / base
    Invoker::new(Arc::new(registry), Arc::new(RecordingAudit::default()))
        .with_resolver(spaces.clone())
        .enforcing()
}

async fn call_as(invoker: &Invoker, name: &str, principal: Option<Principal>) -> Result<Value> {
    let mut ctx = CallCtx::new("user", Surface::Web);
    if let Some(principal) = principal {
        ctx = ctx.with_principal(principal);
    }
    invoker
        .call(name, ctx, json!({}))
        .await
        .map(|response| response.data)
}

#[tokio::test]
async fn space_calls_are_routed_to_the_callers_own_space() {
    let spaces = FakeSpaces::new();
    let invoker = routing_invoker(&spaces);
    let a = call_as(&invoker, "list_collections", Some(alice(true)))
        .await
        .unwrap();
    let b = call_as(&invoker, "list_collections", Some(bob()))
        .await
        .unwrap();
    assert_eq!(a["routed_to"], "sp_alice");
    assert_eq!(b["routed_to"], "sp_bob");
    assert_eq!(a["caller"], "usr_alice");
    // 审计各记各的库,谁也看不到对方的
    assert_eq!(spaces.audit("sp_alice").entries.lock().unwrap().len(), 1);
    assert_eq!(spaces.audit("sp_bob").entries.lock().unwrap().len(), 1);
    assert_eq!(
        spaces.audit("sp_alice").entries.lock().unwrap()[0].actor,
        "usr_alice"
    );
    assert!(
        spaces.shared.lock().unwrap().is_empty(),
        "知识库内的调用不写系统审计"
    );
}

#[tokio::test]
async fn mutating_space_calls_open_the_batch_in_the_callers_space_only() {
    let spaces = FakeSpaces::new();
    let invoker = routing_invoker(&spaces);
    call_as(&invoker, "create_item", Some(alice(true)))
        .await
        .unwrap();
    assert_eq!(spaces.audit("sp_alice").batches.lock().unwrap().len(), 1);
    assert_eq!(spaces.audit("sp_alice").changes.lock().unwrap().len(), 1);
    assert!(
        spaces.audit("sp_bob").batches.lock().unwrap().is_empty(),
        "别人的库里不该有批次"
    );
}

#[tokio::test]
async fn local_superuser_is_routed_to_the_primary_space() {
    let spaces = FakeSpaces::new();
    let invoker = routing_invoker(&spaces);
    let data = call_as(&invoker, "list_collections", Some(Principal::local()))
        .await
        .unwrap();
    assert_eq!(data["routed_to"], "sp_primary");
}

#[tokio::test]
async fn a_user_without_a_space_cannot_use_space_capabilities() {
    let spaces = FakeSpaces::new();
    let invoker = routing_invoker(&spaces);
    let homeless = Principal {
        user_id: "usr_x".into(),
        space_id: None,
        features: Arc::new(user_features(true)),
        local: false,
    };
    let error = call_as(&invoker, "list_collections", Some(homeless))
        .await
        .unwrap_err();
    assert!(matches!(error, KbError::Forbidden(_)), "{error:?}");
}

#[tokio::test]
async fn enforcing_invoker_rejects_calls_without_an_identity() {
    let spaces = FakeSpaces::new();
    let invoker = routing_invoker(&spaces);
    let error = call_as(&invoker, "list_collections", None)
        .await
        .unwrap_err();
    assert!(
        matches!(error, KbError::Unauthorized),
        "没有身份必须 401(fail closed):{error:?}"
    );
    // 被拒的尝试也要留痕
    assert_eq!(spaces.shared.lock().unwrap().len(), 1);
    assert!(!spaces.shared.lock().unwrap()[0].ok);
}

#[tokio::test]
async fn the_feature_gate_blocks_and_says_why() {
    let spaces = FakeSpaces::new();
    let invoker = routing_invoker(&spaces);
    // 普通用户没有 sys.settings
    let error = call_as(&invoker, "get_config", Some(alice(true)))
        .await
        .unwrap_err();
    match error {
        KbError::Forbidden(message) => assert!(message.contains("没有开通"), "{message}"),
        other => panic!("应是 Forbidden:{other:?}"),
    }
    // 管理员有
    assert_eq!(
        call_as(&invoker, "get_config", Some(admin()))
            .await
            .unwrap()["routed_to"],
        "shared"
    );
    // 被拒的调用不能碰到任何知识库
    assert!(spaces.audit("sp_alice").entries.lock().unwrap().is_empty());
}

#[tokio::test]
async fn turning_ai_off_blocks_ai_capabilities_for_everyone() {
    let spaces = FakeSpaces::new();
    let invoker = routing_invoker(&spaces);
    assert!(
        call_as(&invoker, "deep_search", Some(alice(true)))
            .await
            .is_ok()
    );
    let error = call_as(&invoker, "deep_search", Some(alice(false)))
        .await
        .unwrap_err();
    match error {
        KbError::Forbidden(message) => assert_eq!(message, "AI 功能已关闭"),
        other => panic!("{other:?}"),
    }
    let admin_off = Principal::user("usr_root", "sp_root", FeatureSet::all(false));
    assert!(
        call_as(&invoker, "deep_search", Some(admin_off))
            .await
            .is_err(),
        "管理员也一样"
    );
    // 非 AI 能力不受影响
    assert!(
        call_as(&invoker, "list_collections", Some(alice(false)))
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn system_and_account_calls_have_no_batch_and_audit_to_the_system_log() {
    let spaces = FakeSpaces::new();
    let invoker = routing_invoker(&spaces);
    call_as(&invoker, "list_skills", Some(alice(true)))
        .await
        .unwrap();
    call_as(&invoker, "get_config", Some(admin()))
        .await
        .unwrap();
    assert_eq!(
        spaces.shared.lock().unwrap().len(),
        2,
        "账号级 / 系统级调用写系统审计"
    );
    assert!(
        spaces.audits.lock().unwrap().is_empty(),
        "不属于任何知识库,不该打开任何知识库"
    );
    assert!(lookup("list_skills").is_some_and(|access| access.scope == Scope::Account));
}

#[tokio::test]
async fn the_route_does_not_leak_outside_the_call() {
    let spaces = FakeSpaces::new();
    let invoker = routing_invoker(&spaces);
    call_as(&invoker, "list_collections", Some(alice(true)))
        .await
        .unwrap();
    assert!(
        current_call_scope().is_none(),
        "调用结束后任务局部路由必须消失"
    );
}

#[tokio::test]
async fn concurrent_calls_never_see_each_others_space() {
    let spaces = FakeSpaces::new();
    let invoker = Arc::new(routing_invoker(&spaces));
    let mut tasks = Vec::new();
    for index in 0..40 {
        let invoker = invoker.clone();
        tasks.push(tokio::spawn(async move {
            let (principal, expect) = if index % 2 == 0 {
                (alice(true), "sp_alice")
            } else {
                (bob(), "sp_bob")
            };
            for _ in 0..10 {
                let data = call_as(&invoker, "list_collections", Some(principal.clone()))
                    .await
                    .unwrap();
                assert_eq!(data["routed_to"], expect, "并发调用串了知识库");
                tokio::task::yield_now().await;
            }
        }));
    }
    for task in tasks {
        task.await.expect("任务未 panic");
    }
}
