//! 能力的访问分类(多用户设计说明)。
//!
//! 每个能力在这里登记两件事:
//! - 范围([`Scope`]):它作用在哪里——某个知识库里、整个系统上、还是只涉及调用者自己的账号;
//!
//! - 功能点:哪个功能点没开通就不能调(`kb_core::features`,`base` 表示所有启用的账号都有)。
//!
//! 分类放在一张表里而不是散在 117 个注册处,是为了**一眼审计**:谁能碰系统级能力、谁绕过了功能点,
//! 看这一个文件就够。注册表在 `register` 时强制查表,**没登记的能力直接 panic**(启动即失败),
//! 测试再检查表和注册表一一对应——新增能力忘了分类,过不了 CI,也起不来。

use kb_core::features::BASE;

/// 能力作用的范围。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// 不需要登录(目前没有能力用它,预留给公开分享页的只读接口)。
    Public,
    /// 只涉及调用者自己的账号(个人令牌、能力目录……),不碰任何知识库的数据。
    Account,
    /// 在调用者自己的知识库里操作。调用被路由到这个用户的 `spaces/<id>/`,
    /// 别人的数据在结构上就看不到——这是隔离的第一道防线。
    Space,
    /// 作用在整个系统上(配置、模型、备份、组件安装……),必须由对应的 `sys.*` 功能点把关。
    System,
}

impl Scope {
    /// 稳定的小写名字(审计、文档用)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Public => "public",
            Self::Account => "account",
            Self::Space => "space",
            Self::System => "system",
        }
    }
}

/// 一个能力的访问分类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Access {
    /// 作用范围。
    pub scope: Scope,
    /// 需要的功能点;`base` 表示不额外要求。
    pub feature: &'static str,
}

use Scope::{Account, Space, System};

/// (能力名, 范围, 功能点)。**按能力名排序**,方便对照审计。
///
/// 备注:
/// - `tune_retrieval` 现在会改全局的 `search.collection_weights`,所以暂按系统级处理;
///   权重挪到每个知识库自己的设置（设计规范）之后改成 `Space + search.tune`。
/// - `add_source` / `update_source` / `sync_source` 碰到本机目录和 Git 类型的来源时,还要额外检查
///   `sources.local`(这两类读的是服务器上的路径或任意仓库),在处理函数里做。
/// - `import_global` 直接把服务器上的一个目录扫进来,和本机目录来源一样危险,所以整体归 `sources.local`。
/// - 备份、系统状态现在只覆盖主知识库,后续再改成全站汇总。
pub const ACCESS_TABLE: &[(&str, Scope, &str)] = &[
    ("access_decide", Account, BASE),
    ("access_request", Account, BASE),
    ("access_requests", Account, BASE),
    ("acp_agents", Space, "ai.acp"),
    ("acp_cancel", Space, "ai.acp"),
    ("acp_chat", Space, "ai.acp"),
    ("acp_install", System, "sys.settings"),
    ("acp_permission", Space, "ai.acp"),
    ("acp_remove_agent", System, "sys.settings"),
    ("acp_save_agent", System, "sys.settings"),
    ("acp_set_default", System, "sys.settings"),
    ("acp_set_permission", System, "sys.settings"),
    ("acp_set_sandbox", System, "sys.settings"),
    ("acp_test", System, "sys.settings"),
    ("acp_uninstall", System, "sys.settings"),
    ("activity_series", Space, BASE),
    ("add_annotation", Space, "docs.annotate"),
    ("add_project", Space, "sources.local"),
    ("add_source", Space, "sources.web"),
    ("admin_space_open", System, "sys.inspect"),
    ("agent_compress", Space, "ai.assistant"),
    ("agent_confirm", Space, "ai.assistant"),
    ("agent_delete_session", Space, "ai.assistant"),
    ("agent_history", Space, "ai.assistant"),
    ("agent_pin_session", Space, "ai.assistant"),
    ("agent_rename_session", Space, "ai.assistant"),
    ("agent_send", Space, "ai.assistant"),
    ("agent_sessions", Space, "ai.assistant"),
    ("ai_write", Space, "ai.assistant"),
    ("apply_context", Space, "ai.assistant"),
    ("audit_list", Space, BASE),
    ("audit_stats", Space, BASE),
    ("backup_create", System, "sys.ops"),
    ("backup_delete", System, "sys.ops"),
    ("backup_prune", System, "sys.ops"),
    ("backup_state", System, "sys.ops"),
    ("backup_status", System, "sys.ops"),
    ("backup_verify", System, "sys.ops"),
    ("batch_list", Space, BASE),
    ("batch_tag", Space, "docs.notes"),
    ("block", Account, "collab.friends"),
    ("block_list", Account, "collab.friends"),
    ("cancel_batch", Space, "docs.upload"),
    ("chat_commands", Space, "ai.assistant"),
    ("check_links", Space, BASE),
    ("consolidate_project", Space, "ai.organize"),
    ("context_estimate", Space, "ai.assistant"),
    ("convert_to_markdown", Space, "docs.annotate"),
    ("create_item", Space, "docs.notes"),
    ("create_token", Account, "api.tokens"),
    ("csv_edit", Space, "docs.edit_text"),
    ("csv_read", Space, "docs.edit_text"),
    ("dedup_insights", Space, "ai.organize"),
    ("deep_search", Space, "search.deep"),
    ("delete_annotation", Space, "docs.annotate"),
    ("delete_collection", Space, "docs.notes"),
    ("delete_file", Space, "docs.notes"),
    ("delete_folder", Space, "docs.notes"),
    ("delete_item", Space, "docs.notes"),
    ("delete_skill", System, "sys.settings"),
    // 改笔记还要 docs.notes,由后端按目标再查一次
    ("doc_edit", Space, "docs.edit_text"),
    ("doc_links", Space, BASE),
    ("doc_proposal_decide", Space, "docs.edit_text"),
    ("doc_proposals", Space, BASE),
    ("doc_read", Space, BASE),
    ("edit_item", Space, "docs.notes"),
    ("edit_sheet_cells", Space, "docs.edit_text"),
    ("effective_role", Account, BASE),
    ("env_profile", System, "sys.ops"),
    ("eval_history", Space, "search.tune"),
    ("eval_run", Space, "search.tune"),
    ("feature_catalog", Account, BASE),
    ("file_actions", Space, BASE),
    ("file_info", Space, BASE),
    ("file_op_status", Space, BASE),
    ("file_preview", Space, BASE),
    ("file_raw", Space, BASE),
    ("file_version", Space, "docs.edit_text"),
    ("file_versions", Space, "docs.edit_text"),
    ("friend_decide", Account, "collab.friends"),
    ("friend_list", Account, "collab.friends"),
    ("friend_remove", Account, "collab.friends"),
    ("friend_request", Account, "collab.friends"),
    ("friend_requests", Account, "collab.friends"),
    ("friend_search", Account, "collab.friends"),
    ("friend_update", Account, "collab.friends"),
    ("get_batch_progress", Space, BASE),
    ("get_config", System, "sys.settings"),
    ("get_file_timeline", Space, BASE),
    ("get_item", Space, BASE),
    ("get_plugin", System, "sys.settings"),
    ("get_skill", System, "sys.settings"),
    ("grant_batch", Account, "collab.share"),
    ("grant_list", Account, "collab.share"),
    ("grant_remove", Account, "collab.share"),
    ("grant_set", Account, "collab.share"),
    ("guest_purge", Account, "collab.share"),
    ("hide_share", Account, BASE),
    ("import_global", Space, "sources.local"),
    ("index_stats", System, "sys.ops"),
    ("ingest_stats", Space, BASE),
    ("install_hooks", Space, "sources.local"),
    ("install_official_plugin", System, "sys.settings"),
    ("invite_create", System, "sys.users"),
    ("invite_list", System, "sys.users"),
    ("invite_revoke", System, "sys.users"),
    ("invite_uses", System, "sys.users"),
    ("item_facets", Space, BASE),
    ("item_history", Space, BASE),
    ("job_cancel", Space, BASE),
    ("job_files", Space, BASE),
    ("job_get", Space, BASE),
    ("job_list", Space, BASE),
    ("job_stats", Space, BASE),
    ("kb_feedback", Space, "search.basic"),
    ("link_create", Account, "collab.share"),
    ("link_get", Account, "collab.share"),
    ("link_reset", Account, "collab.share"),
    ("link_revoke", Account, "collab.share"),
    ("link_stats", Account, "collab.share"),
    ("link_update", Account, "collab.share"),
    ("list_annotations", Space, BASE),
    ("list_collections", Space, BASE),
    ("list_drafts", Space, "ai.extract"),
    ("list_files", Space, BASE),
    ("list_ingest", Space, BASE),
    ("list_items", Space, BASE),
    ("list_official_plugins", Account, BASE),
    ("list_projects", Space, BASE),
    ("list_skills", Account, BASE),
    ("list_sources", Space, BASE),
    ("list_trash", Space, BASE),
    ("llm_providers", System, "sys.settings"),
    ("llm_usage_overview", System, "sys.ops"),
    ("llm_usage_series", System, "sys.ops"),
    ("mail_log", System, "sys.settings"),
    ("mail_password", System, "sys.settings"),
    ("mail_status", System, "sys.settings"),
    ("mail_test", System, "sys.settings"),
    ("maintain_indexes", System, "sys.ops"),
    ("metrics_series", System, "sys.ops"),
    ("migrate_model", System, "sys.settings"),
    ("migrate_plan", System, "sys.settings"),
    ("move_file", Space, "docs.notes"),
    ("move_files", Space, "docs.notes"),
    ("move_folder", Space, "docs.notes"),
    ("my_links", Account, "collab.share"),
    ("notification_list", Account, BASE),
    ("notification_prefs", Account, BASE),
    ("notification_read", Account, BASE),
    ("ocr_install", System, "sys.settings"),
    ("ocr_status", Account, BASE),
    ("pause_batch", Space, "docs.upload"),
    ("privacy_get", Account, BASE),
    ("project_file_stats", Space, BASE),
    ("provider_install", System, "sys.settings"),
    ("provider_list", System, "sys.settings"),
    ("provider_set_default", System, "sys.settings"),
    ("provider_uninstall", System, "sys.settings"),
    ("purge_trash", Space, "docs.notes"),
    ("quality_report", Space, "ai.organize"),
    ("quarantine_file", Space, "docs.upload"),
    ("recommend_providers", System, "sys.settings"),
    ("refresh_sources", Space, "sources.web"),
    ("reindex_project", Space, "sources.local"),
    ("release_quarantine", Space, "docs.upload"),
    ("reload_config", System, "sys.settings"),
    ("reload_skills", System, "sys.settings"),
    ("remove_project", Space, "sources.local"),
    ("remove_source", Space, "sources.web"),
    ("resolve_annotation", Space, "docs.annotate"),
    ("restore_file_version", Space, "docs.edit_text"),
    ("restore_trash", Space, "docs.notes"),
    ("resume_batch", Space, "docs.upload"),
    ("retry_file_stage", Space, "docs.upload"),
    ("retry_ingest", Space, "docs.upload"),
    ("revert_batch", Space, "docs.notes"),
    ("review_draft", Space, "ai.extract"),
    ("revoke_token", Account, "api.tokens"),
    ("role_create", System, "sys.users"),
    ("role_delete", System, "sys.users"),
    ("role_list", System, "sys.users"),
    ("role_update", System, "sys.users"),
    ("save_file", Space, "docs.edit_text"),
    ("save_insight", Space, "docs.notes"),
    ("save_plugin", System, "sys.settings"),
    ("save_skill", System, "sys.settings"),
    ("search_code", Space, "search.basic"),
    ("search_knowledge", Space, "search.basic"),
    ("search_shared", Account, "search.basic"),
    ("set_inherit", Account, "collab.share"),
    ("set_item_status", Space, "docs.notes"),
    ("set_llm_key", System, "sys.settings"),
    ("set_ocr_backend", System, "sys.settings"),
    ("set_privacy", Account, BASE),
    ("set_skill_enabled", System, "sys.settings"),
    ("share_admin_list", System, "sys.ops"),
    ("share_admin_revoke", System, "sys.ops"),
    ("shared_by_me", Account, "collab.share"),
    ("shared_with_me", Account, BASE),
    ("skip_file", Space, "docs.upload"),
    ("stats_overview", Space, BASE),
    ("storage_overview", System, "sys.ops"),
    ("supersede_insight", Space, "docs.notes"),
    ("sync_source", Space, "sources.web"),
    ("system_status", System, "sys.ops"),
    ("test_llm", System, "sys.settings"),
    ("tune_retrieval", System, "sys.settings"),
    ("unblock", Account, "collab.friends"),
    ("uninstall_hooks", Space, "sources.local"),
    ("uninstall_official_plugin", System, "sys.settings"),
    ("update_config", System, "sys.settings"),
    ("update_project", Space, "sources.local"),
    ("update_source", Space, "sources.web"),
    ("usage_mine", Account, BASE),
    ("user_create", System, "sys.users"),
    ("user_feature", System, "sys.users"),
    ("user_get", System, "sys.users"),
    ("user_list", System, "sys.users"),
    ("user_set_password", System, "sys.users"),
    ("user_totp_reset", System, "sys.users"),
    ("user_update", System, "sys.users"),
];

/// 按能力名查访问分类。
pub fn lookup(name: &str) -> Option<Access> {
    ACCESS_TABLE
        .iter()
        .find(|(entry, _, _)| *entry == name)
        .map(|(_, scope, feature)| Access {
            scope: *scope,
            feature,
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn table_is_sorted_and_has_no_duplicates() {
        let names: Vec<&str> = ACCESS_TABLE.iter().map(|(name, _, _)| *name).collect();
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted, "表要按能力名排序,方便审计");
        let unique: BTreeSet<&str> = names.iter().copied().collect();
        assert_eq!(unique.len(), names.len(), "能力名重复");
    }

    #[test]
    fn every_feature_in_the_table_exists_in_the_catalog() {
        for (name, _, feature) in ACCESS_TABLE {
            assert!(
                kb_core::features::is_known(feature),
                "能力 {name} 引用了不存在的功能点 {feature}"
            );
        }
    }

    #[test]
    fn system_scope_always_needs_a_system_feature() {
        // 系统级能力不能挂在 base 或普通功能点上:否则任何普通用户都能改配置
        for (name, scope, feature) in ACCESS_TABLE {
            if *scope == System {
                assert!(
                    feature.starts_with("sys."),
                    "系统级能力 {name} 必须由 sys.* 功能点把关,现在是 {feature}"
                );
            }
        }
    }

    #[test]
    fn dangerous_features_are_never_default_on() {
        for (name, _, feature) in ACCESS_TABLE {
            if let Some(def) = kb_core::features::find(feature)
                && def.dangerous
            {
                assert!(
                    !def.default_user,
                    "{name} 用了默认开启的危险功能点 {feature}"
                );
            }
        }
    }

    #[test]
    fn space_data_capabilities_never_use_a_sys_feature() {
        // 反过来:作用在知识库里的能力不该由 sys.* 把关(sys.* 只管系统),否则分类多半写错了
        for (name, scope, feature) in ACCESS_TABLE {
            if *scope == Space {
                assert!(
                    !feature.starts_with("sys."),
                    "知识库内的能力 {name} 用了系统功能点 {feature}"
                );
            }
        }
    }

    #[test]
    fn lookup_finds_known_and_rejects_unknown() {
        let access = lookup("create_item").expect("create_item 应已登记");
        assert_eq!(access.scope, Space);
        assert_eq!(access.feature, "docs.notes");
        assert!(lookup("no_such_capability").is_none());
    }
}
