//! 检索解释:这一条为什么被选中。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::{Anchor, RecordKind};
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 检索结果(设计规范的 Hit 契约)
// ---------------------------------------------------------------------------

/// 关联条目(关系一跳的结果)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RelatedHit {
    /// 记录 id。
    pub id: String,
    /// 标题。
    pub title: Option<String>,
}

/// 窗口扩展的说明。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowExplain {
    /// 扩展后的起始行。
    pub from: u32,
    /// 扩展后的结束行。
    pub to: u32,
    /// 是否因为源文件不可用而回退到存储的文本。
    pub fallback: bool,
}

/// 每个阶段的排名与分数(explain=true 时返回)。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SearchExplain {
    /// 来自哪个 collection。
    pub collection: String,
    /// 全文检索阶段的名次。
    pub fts_rank: Option<usize>,
    /// 全文检索阶段的原始分数(BM25;explain 打开时才额外跑一次纯全文检索)。
    #[serde(default)]
    pub fts_score: Option<f32>,
    /// 向量检索阶段的名次。
    pub vector_rank: Option<usize>,
    /// 向量检索阶段的原始分数(`1 - 距离`;explain 打开时才额外跑一次纯向量检索)。
    #[serde(default)]
    pub vector_score: Option<f32>,
    /// 表内混合检索的名次。
    pub store_rank: Option<usize>,
    /// 跨 collection 融合后的名次(1 起)。
    pub fused_rank: Option<usize>,
    /// 融合分数。
    pub fused_score: f64,
    /// 该 collection 在融合时的权重(`_global` 用 `global_weight`,其余默认 1.0)。
    #[serde(default)]
    pub fused_weight: Option<f32>,
    /// 重排后的名次。
    pub rerank_rank: Option<usize>,
    /// 重排分数。
    pub rerank_score: Option<f32>,
    /// 窗口扩展。
    pub window: Option<WindowExplain>,
    /// 这条命中来自「正文已写、向量待补」的补充检索。
    #[serde(default)]
    pub pending: bool,
}

/// 一条检索命中（设计规范）。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SearchHit {
    /// 记录 id。
    pub id: String,
    /// collection 名。
    pub collection: String,
    /// 记录种类。
    pub kind: RecordKind,
    /// 相对路径 / URL / `insight:<id>`。
    pub source: String,
    /// 起始行。
    pub start_line: Option<u32>,
    /// 结束行。
    pub end_line: Option<u32>,
    /// 符号路径。
    pub symbol: Option<String>,
    /// 标题路径。
    pub title: Option<String>,
    /// 窗口扩展后的片段。
    pub snippet: String,
    /// 融合分数。
    pub score: f32,
    /// 关联条目。
    pub related: Vec<RelatedHit>,
    /// 各阶段排名。
    pub explain: Option<SearchExplain>,
    /// 块在原始文档里的位置(当前阶段;没有时为 `None`)。
    #[serde(default)]
    pub anchor: Option<Anchor>,
}
