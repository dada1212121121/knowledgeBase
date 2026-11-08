//! 知识库(collection)与项目:检索的隔离边界。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Millis;
use serde::{Deserialize, Serialize};

/// `projects` 表。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Project {
    /// 主键(uuid v7)。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// collection 名里使用的 slug。
    pub slug: String,
    /// 项目根目录(绝对路径)。
    pub root_path: String,
    /// 对应 `include_json` 列。
    pub include: Vec<String>,
    /// 对应 `exclude_json` 列。
    pub exclude: Vec<String>,
    /// 是否 git 仓库。
    pub is_git: bool,
    /// 上次索引到的 commit。
    pub last_commit: Option<String>,
    /// 上次索引完成时间。
    pub last_indexed_at: Option<Millis>,
    /// 是否允许把内容发给云端 LLM。
    pub allow_cloud_llm: bool,
    /// 是否开启自动提炼。
    pub extract_enabled: bool,
    /// 是否已安装 git hook。
    pub hooks_installed: bool,
    /// 创建时间。
    pub created_at: Millis,
}

/// collection 的种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollectionKind {
    /// `_global`
    Global,
    /// `proj_<slug>`
    Project,
    /// `ext_<slug>`
    External,
}

/// 块的上下文头生成方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ContextMode {
    /// 结构化上下文头(默认)。
    Header,
    /// LLM 生成的上下文说明(AI)。
    Llm,
}

impl ContextMode {
    /// 字符串形式(与 `collections.context_mode` 列一致)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Header => "header",
            Self::Llm => "llm",
        }
    }

    /// 从列值解析。
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "header" => Some(Self::Header),
            "llm" => Some(Self::Llm),
            _ => None,
        }
    }
}

/// `collections` 表。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Collection {
    /// 主键:`_global` / `proj_<slug>` / `ext_<slug>`。
    pub name: String,
    /// 种类。
    pub kind: CollectionKind,
    /// 所属项目。
    pub project_id: Option<String>,
    /// 当前 embedder 的 id。
    pub embedder_id: String,
    /// 向量维度。
    pub dim: usize,
    /// 物理表指针。
    pub active_table: String,
    /// 物理表版本号。
    pub table_version: u32,
    /// 迁移目标表(迁移中才有)。
    pub migrating_to: Option<String>,
    /// 迁移开始时间。
    pub migration_started_at: Option<Millis>,
    /// 待延迟删除的旧表(对应 `retired_tables_json` 列)。
    pub retired_tables: Vec<String>,
    /// 上下文头模式。
    pub context_mode: ContextMode,
    /// 创建时间。
    pub created_at: Millis,
}
