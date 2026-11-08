//! 经验沉淀:洞察、图谱边、草稿、事件、反馈。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::{ItemStatus, Millis};
use serde::{Deserialize, Serialize};

/// insight 的种类(设计规范的 `kind` 列)。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InsightKind {
    /// 设计决定。
    Decision,
    /// 踩坑记录。
    Pitfall,
    /// 操作步骤。
    Howto,
    /// 约定。
    Convention,
    /// 普通笔记。
    Note,
}

impl InsightKind {
    /// 数据库里存储的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Decision => "decision",
            Self::Pitfall => "pitfall",
            Self::Howto => "howto",
            Self::Convention => "convention",
            Self::Note => "note",
        }
    }
}

/// `insights` 表:经验条目的权威数据(正文与版本)。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Insight {
    /// 主键(uuid v7)。
    pub id: String,
    /// 所属 collection。
    pub collection: String,
    /// 标题。
    pub title: String,
    /// 正文(markdown)。
    pub body_md: String,
    /// 种类。
    pub kind: InsightKind,
    /// 对应 `tags_json` 列。
    pub tags: Vec<String>,
    /// 对应 `related_paths_json` 列。
    pub related_paths: Vec<String>,
    /// 状态。
    pub status: ItemStatus,
    /// 版本号(乐观锁)。
    pub version: i64,
    /// 生效时间。
    pub valid_from: Millis,
    /// 失效时间。
    pub valid_until: Option<Millis>,
    /// 被哪条取代。
    pub superseded_by: Option<String>,
    /// `user` / `mcp:<client>` / `agent` / `extractor:<id>`。
    pub created_by: String,
    /// 所属批次。
    pub batch_id: Option<String>,
    /// 创建时间。
    pub created_at: Millis,
    /// 更新时间。
    pub updated_at: Millis,
}

/// `edges` 表的关系类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeRel {
    /// 关于某个文件。
    AboutFile,
    /// 引用。
    References,
    /// 来自某个 commit。
    FromCommit,
    /// 取代。
    Supersedes,
    /// 派生自。
    DerivedFrom,
    /// 与某条重复。
    DuplicateOf,
}

impl EdgeRel {
    /// 数据库里存储的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AboutFile => "about_file",
            Self::References => "references",
            Self::FromCommit => "from_commit",
            Self::Supersedes => "supersedes",
            Self::DerivedFrom => "derived_from",
            Self::DuplicateOf => "duplicate_of",
        }
    }
}

/// `edges` 表:轻量关系。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Edge {
    /// 源记录 id。
    pub src_id: String,
    /// 目标:记录 id、`path:<相对路径>` 或 `commit:<sha>`。
    pub dst: String,
    /// 关系类型。
    pub rel: EdgeRel,
    /// 创建时间。
    pub created_at: Millis,
}

/// `drafts` 表的状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftState {
    /// 待审。
    Pending,
    /// 通过。
    Approved,
    /// 修订后通过。
    Revised,
    /// 拒绝。
    Rejected,
    /// 重复。
    Duplicate,
}

/// `drafts` 表:草稿永远不进 LanceDB。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Draft {
    /// 主键。
    pub id: String,
    /// 目标 collection。
    pub collection: String,
    /// 标题。
    pub title: String,
    /// 正文。
    pub body_md: String,
    /// 种类。
    pub kind: InsightKind,
    /// 对应 `tags_json` 列。
    pub tags: Vec<String>,
    /// 对应 `evidence_json` 列(证据片段)。
    pub evidence_json: String,
    /// 候选的关联文件(迁移 0008 前写入的旧草稿为空)。
    #[serde(default)]
    pub related_paths: Vec<String>,
    /// 产生它的提炼器。
    pub extractor_id: String,
    /// 触发它的事件。
    pub event_id: Option<String>,
    /// 状态。
    pub state: DraftState,
    /// 对应 `review_json` 列(审核结果)。
    pub review_json: Option<String>,
    /// 转正后对应的 insight。
    pub insight_id: Option<String>,
    /// 指纹。
    #[serde(default)]
    pub fingerprint: String,
    /// 候选向量(比较重复与检索相似 insight 用;不额外嵌入)。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding: Option<Vec<f32>>,
    /// 算向量用的嵌入器。
    #[serde(default)]
    pub embedder_id: Option<String>,
    /// 创建时间。
    pub created_at: Millis,
    /// 审核时间。
    pub decided_at: Option<Millis>,
}

/// `events` 表:进化事件。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// 主键。
    pub id: String,
    /// `git_commit` / `git_merge` / `git_checkout` / `session_end` / `file_change` / `manual`。
    pub kind: String,
    /// 所属项目。
    pub project_id: Option<String>,
    /// 对应 `payload_json` 列。
    pub payload_json: String,
    /// 收到时间。
    pub received_at: Millis,
    /// 处理完成时间。
    pub processed_at: Option<Millis>,
    /// 处理结果。
    pub result: Option<String>,
}

/// `feedback` 表:检索结果的显式反馈。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Feedback {
    /// 自增主键;写入时用 `None`。
    pub id: Option<i64>,
    /// 时间。
    pub at: Millis,
    /// 原始查询。
    pub query: String,
    /// 被评价的记录 id。
    pub item_id: String,
    /// 是否有用。
    pub useful: bool,
    /// 备注。
    pub note: Option<String>,
    /// 来源(`mcp` / `web` / `cli`)。
    pub source: String,
}
