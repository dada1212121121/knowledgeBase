//! 能力注册表与全部能力定义(schemars 生成 JSON Schema)。
//!
//! 依赖方向:本 crate 只依赖 `kb-core`;具体实现通过 [`backend::CapabilityBackend`]
//! trait 由 `kb-cli`(唯一组装根)注入,因此 `defs` 可以留在这里而不破坏设计规范的规则。

pub mod access;
pub mod admin;
pub mod backend;
pub mod defs;
pub mod invoke;
pub mod links;
pub mod registry;
pub mod sharing;
pub mod social;
pub mod typed;

pub use access::{Access, Scope};
pub use admin::AdminBackend;
pub use backend::{
    AgentBackend, CapabilityBackend, DocsBackend, FilesBackend, JobsBackend, OpsBackend,
    SearchBackend, SkillsBackend, SourcesBackend,
};
pub use invoke::{
    CALL_PRINCIPAL, CALL_SCOPE, CallCtx, CallScope, Invoker, Principal, ResolvedSpace, Response,
    ResponseMeta, SpaceResolver, current_call_scope, current_principal,
};
pub use registry::{Capability, Permission, Registry, Surface};
