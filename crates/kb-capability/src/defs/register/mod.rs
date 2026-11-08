//! 能力清单按域拆成的文件（设计规范）。
//!
//! 拆的是**注册**这一半:参数结构体还留在 `defs/mod.rs`,因为它们被 158 个能力共用,
//! 按域切会把同一份 args 拆到两个文件里。这里每个文件对应一个域,导出一个
//! `register(registry, backend)`,由 `defs::register_all` 依次调用。
//!
//! 面(`Surface`)常量在 `defs/mod.rs`,子文件通过 `use super::*` 拿。

use super::*;

const WEB_AGENT: &[Surface] = &[Surface::Web, Surface::Agent];
const MCP_WEB: &[Surface] = &[Surface::Mcp, Surface::Web];
const MCP_ALL: &[Surface] = &[Surface::Mcp, Surface::Web, Surface::Agent];
/// 只在 Web 面可见(hook 安装、配置类操作)。
const WEB_ONLY: &[Surface] = &[Surface::Web];
/// AI 管家面(同时给 Web 用:管家页面走 Web 会话)。
const AGENT_ONLY: &[Surface] = &[Surface::Agent, Surface::Web];

pub(crate) use crate::backend::CapabilityBackend;
pub(crate) use crate::registry::{Capability, Permission, Registry};
pub(crate) use crate::typed::{schema, typed};

pub(super) mod admin;
pub(super) mod agent;
pub(super) mod backup;
pub(super) mod catalog;
pub(super) mod docs;
pub(super) mod eval;
pub(super) mod file_ops;
pub(super) mod files;
pub(super) mod insight;
pub(super) mod items;
pub(super) mod jobs;
pub(super) mod pipeline;
pub(super) mod project_admin;
pub(super) mod search;
pub(super) mod skills;
pub(super) mod sources;
