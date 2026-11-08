//! 文档引用与分块元数据:文件之间、切片之间的边。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Millis;
use serde::{Deserialize, Serialize};

/// 文档链接图谱里的一条引用。
///
/// `source_kind` / `source_id` 指向引用方(file 是路径,note 是笔记 id);
/// `target_kind` 是 file / note / external / anchor / invalid,只有前两种带目标。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DocLink {
    /// 引用方类型:file / note。
    pub source_kind: String,
    /// 引用方所属 collection。
    pub source_collection: String,
    /// 引用方 id(file 路径 / note id)。
    pub source_id: String,
    /// 引用方标题(文件取文件名,笔记取标题)。
    pub source_title: String,
    /// 正文里写的原始 href(不改写)。
    pub href: String,
    /// 第一次出现的行号(1 起)。
    pub line: u32,
    /// 链接文字 / 图片 alt。
    pub label: String,
    /// 目标类型:file / note / external / anchor / invalid。
    pub target_kind: String,
    /// 目标 collection(file / note)。
    pub target_collection: Option<String>,
    /// 目标 id(file 路径 / note id)。
    pub target_id: Option<String>,
    /// 不能解析时的原因(给页面提示)。
    pub reason: Option<String>,
    /// 最后解析时间。
    pub indexed_at: Millis,
}

/// 链接索引里一篇来源文档的登记(判断 mtime 变没变)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocLinkSource {
    /// 来源类型:file / note。
    pub source_kind: String,
    /// 所属 collection。
    pub collection: String,
    /// 来源 id(file 路径 / note id)。
    pub id: String,
    /// 标题(文件取文件名,笔记取标题)。
    pub title: String,
    /// 文件 mtime;笔记为 0。
    pub mtime: Millis,
    /// 最近一次解析时间。
    pub indexed_at: Millis,
}

/// `chunks` 表:块级三哈希。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChunkMeta {
    /// 块 id。
    pub id: String,
    /// 所属 collection。
    pub collection: String,
    /// 项目内相对路径。
    pub path: String,
    /// 文件内序号。
    pub ordinal: u32,
    /// `xxh3(text)`
    pub content_hash: String,
    /// 元数据哈希。
    pub meta_hash: String,
    /// 嵌入输入哈希。
    pub embed_input_hash: String,
    /// 更新时间。
    pub updated_at: Millis,
}

/// 等待补向量的块(文本优先索引的 SQLite 队列项)。
///
/// 只放定位信息,正文仍在 LanceDB 的 pending 行里;队列的作用是让检索路径用一次
/// 本地主键查询就能判断「要不要走 pending 补充检索」,不用扫向量表。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingChunk {
    /// 块 id。
    pub chunk_id: String,
    /// 项目内相对路径。
    pub path: String,
    /// 入队时间(毫秒)。
    pub enqueued_at: Millis,
}

/// 一个 collection 的待补向量队列概览(观测用)。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingStats {
    /// 队列里的块数。
    pub chunks: u64,
    /// 涉及的文件数(按 `path` 去重)。
    pub files: u64,
    /// 最早入队时间(毫秒);队列为空时是 `None`。
    pub oldest_enqueued_at: Option<Millis>,
}
