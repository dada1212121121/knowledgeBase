//! 全部能力定义（设计规范）:158 个能力,分注册与参数两半。
//!
//! - `args/` 参数结构体,按域分文件(search / files / docs / acp / admin / sources / skills)。
//!   它们带 `JsonSchema`,schema 由 schemars 生成。
//! - `register/` 能力注册,同样按域分文件;每个文件一个 `register(registry, backend)`。
//!
//! 本文件只留「装配」:注册表怎么建、MCP 工具白名单、以及各域注册函数的调用顺序。
//! 拆的理由见架构设计说明:这个文件曾经 4558 行,加一个能力要在 1700 行里
//! 翻找,归类错了也没人愿意动。

use std::sync::Arc;

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::backend::CapabilityBackend;
use crate::registry::{Registry, Surface};

pub use kb_core::model::Page;

mod args;
mod jobs;
mod register;

pub use args::*;
pub use jobs::{
    ActivitySeriesArgs, IngestStatsArgs, JobFilesArgs, JobGetArgs, JobStatsArgs, brief_job,
    job_series_window,
};

/// 把全部能力注册进 `registry`。
pub fn register_all(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    register::search::register(registry, backend.clone());
    register::catalog::register(registry, backend.clone());
    register::jobs::register(registry, backend.clone());
    register::insight::register(registry, backend.clone());
    register_web(registry, backend.clone());
    register::sources::register(registry, backend.clone());
    register::pipeline::register(registry, backend.clone());
    register::project_admin::register(registry, backend.clone());
    register::docs::register(registry, backend.clone());
    register::file_ops::register(registry, backend.clone());
    register::eval::register(registry, backend);
}

/// 「其余」能力的派发:`defs` 里较早的 `register_docs` / `register_file_ops` 之外,
/// 剩下 98 个能力从前都塞在这一个函数里(1727 行),现在按域进了 `register/`。
///
/// 它们多**只在 Web 面可见**:MCP 的工具是固定下来的对外契约,不因为 Web 端加页面而变。
fn register_web(registry: &mut Registry, backend: Arc<dyn CapabilityBackend>) {
    register::items::register(registry, backend.clone());
    register::files::register(registry, backend.clone());
    register::admin::register(registry, backend.clone());
    register::agent::register(registry, backend.clone());
    register::backup::register(registry, backend.clone());
    register::skills::register(registry, backend);
}

/// 构造一个注册好全部能力的表。
pub fn build_with_admin(
    backend: Arc<dyn CapabilityBackend>,
    admin: Arc<dyn crate::admin::AdminBackend>,
) -> Registry {
    let mut registry = build(backend);
    crate::admin::register_admin(&mut registry, admin);
    registry
}

/// 只含业务能力的注册表(不含账号管理);守护进程用 [`build_with_admin`]。
pub fn build(backend: Arc<dyn CapabilityBackend>) -> Registry {
    let mut registry = Registry::new();
    register_all(&mut registry, backend);
    registry
}

/// MCP 面工具。分组:`knowledge` / `jobs` / `insight` / `docs`。
/// `agent_history` 在面上,但远程 `/mcp` 与 Bearer 令牌看不到它(只给 stdio 与 ACP 伴生)。
pub const MCP_TOOLS: [&str; 16] = [
    "search_knowledge",
    "search_code",
    "get_item",
    "list_collections",
    "list_projects",
    "agent_history",
    "job_list",
    "list_ingest",
    "save_insight",
    "kb_feedback",
    "reindex_project",
    "doc_read",
    "doc_edit",
    "check_links",
    "list_files",
    "doc_links",
];

/// 工具属于哪个组。不在这四组里的能力是 `other`(伴生身份默认调不到)。
pub fn mcp_tool_group(name: &str) -> &'static str {
    match name {
        "search_knowledge" | "search_code" | "get_item" | "list_collections" | "list_projects"
        | "agent_history" => "knowledge",
        "job_list" | "list_ingest" | "reindex_project" => "jobs",
        "save_insight" | "kb_feedback" => "insight",
        "doc_read" | "doc_edit" | "check_links" | "doc_links" | "list_files" => "docs",
        _ => "other",
    }
}

/// `groups` 为空或含 `all` 时不限制;否则名字必须落在列出的组里。
pub fn tool_group_allows(groups: &[String], name: &str) -> bool {
    groups.is_empty()
        || groups
            .iter()
            .any(|group| group == "all" || group == mcp_tool_group(name))
}
