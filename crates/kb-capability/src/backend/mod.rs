//! 能力实现的后端接口(按域拆成八个子 trait)。
//!
//! `kb-capability` 只依赖 `kb-core`,真正的服务在 `kb-service`;由 `kb-cli` 实现这些 trait
//! 并注入,保持「`kb-cli` 是唯一组装根」的依赖规则（设计规范）。
//!
//! 按域拆的理由见架构设计说明:156 个方法挤在一个 trait 里,新增一个能力
//! 要在 456 行里找位置,`impl` 也跟着长成 666 行;拆开之后「加一个备份能力」只动
//! `OpsBackend` 与它那一处 `impl`。

use async_trait::async_trait;
use kb_core::{KbError, Result};
use serde_json::Value;

use crate::defs;
use crate::invoke::CallCtx;

mod agent;
mod docs;
mod files;
mod jobs;
mod ops;
mod search;
mod skills;
mod sources;

pub use agent::AgentBackend;
pub use docs::DocsBackend;
pub use files::FilesBackend;
pub use jobs::JobsBackend;
pub use ops::OpsBackend;
pub use search::SearchBackend;
pub use skills::SkillsBackend;
pub use sources::SourcesBackend;

/// 能力后端的全貌:八个领域 trait 的并集,本身不定义方法。
///
/// 注册表(`defs::register::*`)只认 `Arc<dyn CapabilityBackend>`;要按域取用某一面时
/// 用 trait upcasting(`&*backend as &dyn SearchBackend`)。空 trait 保证对象安全
/// (`impl CapabilityBackend for ServiceBackend` 一处实现仍然成立)。
pub trait CapabilityBackend:
    SearchBackend
    + DocsBackend
    + FilesBackend
    + JobsBackend
    + SourcesBackend
    + OpsBackend
    + AgentBackend
    + SkillsBackend
    + Send
    + Sync
{
}

/// 谁凑齐了八个领域 trait,就自动是 `CapabilityBackend`。
///
/// 没有这条 blanket impl 的话,每个实现方都要多写一行空 impl,而漏写那行的报错
/// (「`ServiceBackend` 不是 `CapabilityBackend`」)出现在 `Arc<dyn ...>` 的转换点上,
/// 离原因很远。`?Sized` 让 `dyn` 也能满足它,方便把某一面单独装箱传出去。
impl<T> CapabilityBackend for T where
    T: SearchBackend
        + DocsBackend
        + FilesBackend
        + JobsBackend
        + SourcesBackend
        + OpsBackend
        + AgentBackend
        + SkillsBackend
        + ?Sized
{
}
