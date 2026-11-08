//! 记录行、列表查询、分页:元数据库的存储口径。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Anchor;
use serde::{Deserialize, Serialize};

/// Unix 毫秒时间戳。
pub type Millis = i64;

// ---------------------------------------------------------------------------
// 检索链路
// ---------------------------------------------------------------------------

/// 一条记录,与设计规范的 Arrow schema 一一对应。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct RecordRow {
    /// 记录 id:代码 / 文档块是 `hex(xxh3_128(collection ‖ "\0" ‖ path ‖ "\0" ‖ chunk_key))`,
    /// insight 是 uuid v7。
    pub id: String,
    /// collection 名。
    pub collection: String,
    /// 记录种类。
    pub kind: RecordKind,
    /// 语言,未知时为 `None`。
    pub lang: Option<String>,
    /// 项目内相对路径、URL 或 `insight:<id>`。
    pub source: String,
    /// 起始行(1 起)。
    pub start_line: Option<i32>,
    /// 结束行(1 起)。
    pub end_line: Option<i32>,
    /// 符号路径,如 `impl SearchService › fn hybrid`。
    pub symbol: Option<String>,
    /// 文档标题路径或 insight 标题。
    pub title: Option<String>,
    /// 原始块文本。
    pub text: String,
    /// 结构化上下文头,不含行号。
    pub header: String,
    /// 全文检索列 = header + text + 拆分后的标识符。
    pub lex: String,
    /// 标签(存储时编码为 `,a,b,`)。
    pub tags: Vec<String>,
    /// 记录状态。
    pub status: ItemStatus,
    /// `xxh3(text)`
    pub content_hash: String,
    /// `xxh3(start_line ‖ end_line ‖ title ‖ tags ‖ status ‖ symbol)`
    pub meta_hash: String,
    /// `xxh3(embedder_id ‖ header ‖ "\n" ‖ text)`
    pub embed_input_hash: String,
    /// 更新时间(Unix 毫秒)。
    pub updated_at: Millis,
    /// 块在原始文档里的位置(当前阶段:PDF 页码 / 表格单元格 / 幻灯片 / 时间戳)。
    #[serde(default)]
    pub anchor: Option<Anchor>,
    /// 向量;`get` 默认不取向量(为 `None`)。
    pub vector: Option<Vec<f32>>,
}

/// 记录种类(设计规范的 `kind` 列)。
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    /// 代码块。
    Code,
    /// 文档块。
    Doc,
    /// 经验条目。
    Insight,
    /// 外部资料。
    External,
    /// 摘要块。
    Summary,
}

impl RecordKind {
    /// 数据库里存储的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Code => "code",
            Self::Doc => "doc",
            Self::Insight => "insight",
            Self::External => "external",
            Self::Summary => "summary",
        }
    }
}

/// 记录状态(设计规范的 `status` 列)。
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    /// 有效。
    Active,
    /// 已被取代。
    Superseded,
    /// 已废弃。
    Deprecated,
}

impl ItemStatus {
    /// 数据库里存储的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Superseded => "superseded",
            Self::Deprecated => "deprecated",
        }
    }

    /// 全部状态。
    pub const ALL: [Self; 3] = [Self::Active, Self::Superseded, Self::Deprecated];
}

/// 只更新元数据(不重新嵌入)时的补丁。
#[derive(Clone, Debug, Default)]
pub struct MetaPatch {
    /// 起始行。
    pub start_line: Option<i32>,
    /// 结束行。
    pub end_line: Option<i32>,
    /// 标题。
    pub title: Option<String>,
    /// 符号路径。
    pub symbol: Option<String>,
    /// 标签。
    pub tags: Option<Vec<String>>,
    /// 状态。
    pub status: Option<ItemStatus>,
    /// 新的 `meta_hash`。
    pub meta_hash: Option<String>,
    /// 新的来源路径(文件 / 文件夹移动时同步改,避免搜索结果还指向旧路径)。
    pub source: Option<String>,
    /// 新的上下文头(批注检索记录跟着文件移动)。
    pub header: Option<String>,
    /// 新的全文检索列(header + text + 标识符)。
    pub lex: Option<String>,
    /// 新的嵌入输入哈希(只改 header 时同步更新)。
    pub embed_input_hash: Option<String>,
    /// 更新时间。
    pub updated_at: Option<Millis>,
}

/// 检索模式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchMode {
    /// 纯向量。
    Vector,
    /// 纯全文。
    Fts,
    /// 向量 + 全文(LanceDB 内部做 RRF)。
    Hybrid,
}

/// 存储层查询请求。
#[derive(Clone, Debug)]
pub struct StoreQuery {
    /// 检索模式。
    pub mode: SearchMode,
    /// 全文检索的查询串。
    pub text: Option<String>,
    /// 查询向量。
    pub vector: Option<Vec<f32>>,
    /// 结构化过滤条件。
    pub filter: crate::filter::Filter,
    /// 返回条数。
    pub limit: usize,
    /// 跳过条数。
    pub offset: usize,
    /// 结果是否带向量。
    pub with_vector: bool,
}

/// 列表查询(`list_items`):不算分,只按白名单列排序后分页。
///
/// 与 [`StoreQuery`] 的区别:这里不做全文 / 向量检索,过滤表达式同样**只能**来自
/// [`crate::filter::Filter::to_sql`],排序列只接受 [`ListQuery::COLUMNS`]。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ListQuery {
    /// 已校验过的过滤表达式;`None` = 不过滤。
    pub filter: Option<String>,
    /// 排序列,必须是 [`ListQuery::COLUMNS`] 之一。
    pub order_by: String,
    /// 是否升序。
    pub ascending: bool,
    /// 返回条数。
    pub limit: usize,
    /// 跳过条数。
    pub offset: usize,
}

impl ListQuery {
    /// 允许排序的列。调用方给的列名必须命中这里,避免把外部字符串拼进查询。
    pub const COLUMNS: [&'static str; 4] = ["updated_at", "source", "kind", "start_line"];

    /// 默认排序:更新时间倒序。
    pub fn new(limit: usize, offset: usize) -> Self {
        Self {
            filter: None,
            order_by: "updated_at".to_owned(),
            ascending: false,
            limit,
            offset,
        }
    }

    /// 设置过滤表达式(调用方应传 `Filter::to_sql` 的结果)。
    pub fn with_filter(mut self, filter: Option<String>) -> Self {
        self.filter = filter;
        self
    }

    /// 设置排序列;不在白名单里返回 [`crate::KbError::InvalidInput`]。
    pub fn with_order(mut self, column: Option<&str>, ascending: bool) -> crate::Result<Self> {
        if let Some(column) = column {
            if !Self::COLUMNS.contains(&column) {
                return Err(crate::KbError::InvalidInput(format!(
                    "sort 只能是 {},收到 {column}",
                    Self::COLUMNS.join(" / ")
                )));
            }
            self.order_by = column.to_owned();
            self.ascending = ascending;
        }
        Ok(self)
    }
}

/// 文件级列表用的“瘦行”:只留归并和展示需要的列,没有正文、上下文头、全文列、哈希和向量。
///
/// 一个大集合有十几万个块,列表只需要“有哪些文件”;把每个块的正文都读出来再丢掉,是白白浪费内存和时间。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSlice {
    /// 块 id。
    pub id: String,
    /// collection 名。
    pub collection: String,
    /// 记录种类。
    pub kind: RecordKind,
    /// 语言。
    pub lang: Option<String>,
    /// 项目内相对路径、URL 或 `insight:<id>`。
    pub source: String,
    /// 起始行。
    pub start_line: Option<i32>,
    /// 结束行。
    pub end_line: Option<i32>,
    /// 符号路径。
    pub symbol: Option<String>,
    /// 文档标题路径或 insight 标题。
    pub title: Option<String>,
    /// 标签。
    pub tags: Vec<String>,
    /// 状态。
    pub status: ItemStatus,
    /// 更新时间(毫秒)。
    pub updated_at: Millis,
}

impl From<&RecordRow> for FileSlice {
    fn from(row: &RecordRow) -> Self {
        Self {
            id: row.id.clone(),
            collection: row.collection.clone(),
            kind: row.kind,
            lang: row.lang.clone(),
            source: row.source.clone(),
            start_line: row.start_line,
            end_line: row.end_line,
            symbol: row.symbol.clone(),
            title: row.title.clone(),
            tags: row.tags.clone(),
            status: row.status,
            updated_at: row.updated_at,
        }
    }
}

/// 向量库一侧的块指纹:只有 id、来源和两个内容哈希,用来和 SQLite `chunks` 表逐块对账。
///
/// 和 [`FileSlice`] 的区别是带了哈希列:元数据与向量库「id 对得上、内容对不上」(过期块)
/// 只有比哈希才看得出来。同样不读正文和向量,十几万块的集合也只占几十 MB。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChunkFingerprint {
    /// 块 id。
    pub id: String,
    /// 项目内相对路径、URL 或 `insight:<id>`。
    pub source: String,
    /// `xxh3(text)`。
    pub content_hash: String,
    /// 嵌入输入哈希。
    pub embed_input_hash: String,
    /// 更新时间(毫秒)。
    pub updated_at: Millis,
    /// 嵌入状态(`pending` / `ready`;旧表没有这一列时是 `None`)。
    ///
    /// 只给一致性检查用:正常检索走 `READY_FILTER`,不读这一列。
    pub embed_state: Option<String>,
}

/// 一个文件:同一个 `source` 下的所有块归并成一条。
///
/// 向量库里一份文档会被切成很多块(检索的单位),但人在知识库里浏览、预览、编辑的单位是文件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileEntry {
    /// 代表块:起始行最小的那一块(打开它就是打开整份文件)。
    pub first: FileSlice,
    /// 这个文件有多少个块。
    pub chunks: u32,
    /// 各块标签的并集(去重、排序)。
    pub tags: Vec<String>,
    /// 各块更新时间的最大值。
    pub updated_at: Millis,
}

fn earlier(a: &FileSlice, b: &FileSlice) -> bool {
    (a.start_line.unwrap_or(i32::MIN), &a.id) < (b.start_line.unwrap_or(i32::MIN), &b.id)
}

/// 把块归并成文件。结果按 `source` 升序,顺序是确定的(和输入顺序无关)。
pub fn group_by_file(slices: Vec<FileSlice>) -> Vec<FileEntry> {
    let mut files: std::collections::HashMap<String, FileEntry> = std::collections::HashMap::new();
    for slice in slices {
        match files.get_mut(&slice.source) {
            None => {
                let mut tags = slice.tags.clone();
                tags.sort();
                tags.dedup();
                files.insert(
                    slice.source.clone(),
                    FileEntry {
                        updated_at: slice.updated_at,
                        chunks: 1,
                        tags,
                        first: slice,
                    },
                );
            }
            Some(entry) => {
                entry.chunks += 1;
                entry.updated_at = entry.updated_at.max(slice.updated_at);
                for tag in &slice.tags {
                    if let Err(at) = entry.tags.binary_search(tag) {
                        entry.tags.insert(at, tag.clone());
                    }
                }
                if earlier(&slice, &entry.first) {
                    entry.first = slice;
                }
            }
        }
    }
    let mut out: Vec<FileEntry> = files.into_values().collect();
    out.sort_by(|a, b| a.first.source.cmp(&b.first.source));
    out
}

/// 一条检索命中。`score` 只在同一张表内可比(设计规范坑 16)。
#[derive(Clone, Debug)]
pub struct StoreHit {
    /// 命中的记录。
    pub row: RecordRow,
    /// 分数:混合模式为 `_relevance_score`,向量模式为 `1 - distance`,全文模式为 `_score`。
    pub score: f32,
    /// 排名(从 1 开始)。
    pub rank: usize,
}

// ---------------------------------------------------------------------------
// 设计规范实体
// ---------------------------------------------------------------------------

/// 分页参数。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Page {
    /// 每页条数。
    pub limit: u32,
    /// 跳过条数。
    pub offset: u32,
}

impl Page {
    /// 默认每页 50 条。
    pub const DEFAULT_LIMIT: u32 = 50;

    /// 构造分页参数。
    pub fn new(limit: u32, offset: u32) -> Self {
        Self { limit, offset }
    }
}

impl Default for Page {
    fn default() -> Self {
        Self {
            limit: Self::DEFAULT_LIMIT,
            offset: 0,
        }
    }
}
