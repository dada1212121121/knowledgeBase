//! 检索与条目:查询、取单条、项目增删改、分页与统计。

use super::*;

/// `search_knowledge` / `search_code` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SearchArgs {
    /// 查询串;支持 `kind:` / `lang:` / `path:` / `tag:` / `status:` / `since:` 前缀。
    pub query: String,
    /// 作用域:`project` / `global` / `all`。
    #[serde(default)]
    pub scope: Option<String>,
    /// 项目名或 slug。
    #[serde(default)]
    pub project: Option<String>,
    /// 只返回这些种类(code / doc / insight / external / summary)。
    #[serde(default)]
    pub kinds: Vec<String>,
    /// 返回条数。
    #[serde(default)]
    pub k: Option<usize>,
    /// 是否重排。
    #[serde(default)]
    pub rerank: Option<bool>,
    /// 是否返回各阶段排名。
    #[serde(default)]
    pub explain: bool,
    /// 查询增强(HyDE / 多查询;默认关闭,需要云端 LLM)。
    #[serde(default)]
    pub enhance: bool,
    /// 语言过滤(等价于 `lang:` 前缀)。
    #[serde(default)]
    pub lang: Option<String>,
    /// 路径前缀(等价于 `path:` 前缀)。
    #[serde(default)]
    pub path_prefix: Option<String>,
}

/// `get_item` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct GetItemArgs {
    /// 记录 id。
    pub id: String,
    /// 额外带上的上下文行数。
    #[serde(default)]
    pub context_lines: Option<usize>,
}

/// `add_project` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AddProjectArgs {
    /// 项目根目录。
    pub path: String,
    /// 项目名(默认取目录名)。
    #[serde(default)]
    pub name: Option<String>,
}

/// 只带项目名的参数(`remove_project` 用)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ProjectNameArgs {
    /// 项目名或 slug。
    pub project: String,
}

/// `item_facets` 的参数(浏览器页的树形导航用)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ItemFacetsArgs {
    /// collection 名。
    pub collection: String,
    /// 状态:`active`(默认)/ `superseded` / `deprecated` / `all`。
    #[serde(default)]
    pub status: Option<String>,
}

/// `item_history` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ItemIdArgs {
    /// 记录 id。
    pub id: String,
}

/// `save_insight` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SaveInsightArgs {
    /// 标题(一句话)。
    pub title: String,
    /// 正文(markdown)。
    pub body: String,
    /// 种类:decision / pitfall / howto / convention / note。
    #[serde(default)]
    pub kind: Option<String>,
    /// 目标项目。
    #[serde(default)]
    pub project: Option<String>,
    /// 直接指定 collection(优先于 project / global);MCP 写项目笔记时用。
    #[serde(default)]
    pub collection: Option<String>,
    /// 写进 `_global`。
    #[serde(default)]
    pub global: bool,
    /// 标签。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 相关文件(项目内相对路径)。
    #[serde(default)]
    pub related_paths: Vec<String>,
    /// 被取代的旧 insight id。
    #[serde(default)]
    pub supersedes: Option<String>,
    /// 正文里的引用语法不合法时直接报错(默认只提示,不拦保存)。
    #[serde(default)]
    pub strict_links: bool,
}

/// `kb_feedback` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FeedbackArgs {
    /// 原始查询。
    pub query: String,
    /// 被评价的记录 id。
    pub item_id: String,
    /// 是否有用。
    pub useful: bool,
    /// 备注。
    #[serde(default)]
    pub note: Option<String>,
}

/// `reindex_project` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ReindexArgs {
    /// 项目名或 slug。
    pub project: String,
    /// `incremental`(默认)或 `full`。
    #[serde(default)]
    pub mode: Option<String>,
    /// 增量模式下的路径。
    #[serde(default)]
    pub paths: Vec<String>,
    /// 两阶段索引的阶段(`text` / `embed` / `full`);不传按配置决定。
    #[serde(default)]
    pub phase: Option<String>,
    /// 只做文本阶段,不自动补向量。
    #[serde(default)]
    pub stop_after_text: bool,
}

/// 一个空参数对象。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct EmptyArgs {}

/// `list_items` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ListItemsArgs {
    /// collection 名(例如 `proj_demo` / `_global`)。
    pub collection: String,
    /// 只返回这个种类:`code` / `doc` / `insight` / `external` / `summary`。
    #[serde(default)]
    pub kind: Option<String>,
    /// 只返回这个 insight 子类型(decision / pitfall / howto / convention / note)。
    #[serde(default)]
    pub insight_kind: Option<String>,
    /// 状态:`active`(默认)/ `superseded` / `deprecated` / `all`。
    #[serde(default)]
    pub status: Option<String>,
    /// 标签。
    #[serde(default)]
    pub tag: Option<String>,
    /// 路径前缀。
    #[serde(default)]
    pub path_prefix: Option<String>,
    /// 关键词(标题 / 符号 / 路径的包含匹配)。
    #[serde(default)]
    pub q: Option<String>,
    /// 页码,从 1 起。
    #[serde(default)]
    pub page: Option<u32>,
    /// 每页条数(上限 200)。
    #[serde(default)]
    pub page_size: Option<u32>,
    /// 排序列:`updated_at`(默认)/ `source` / `kind` / `start_line`。
    #[serde(default)]
    pub sort: Option<String>,
    /// 排序方向:`desc`(默认)/ `asc`。
    #[serde(default)]
    pub order: Option<String>,
    /// 按文件列:同一个文件的所有块归并成一条(`id` 是代表块,打开它就是打开整份文件;条目带 `chunks` 块数)。
    /// 默认 false,仍是一块一行。
    #[serde(default)]
    pub group_by_file: bool,
}

/// `edit_item` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct EditItemArgs {
    /// 记录 id。
    pub id: String,
    /// 乐观锁版本:insight 必填(与 `insights.version` 不一致返回 409);
    /// 代码 / 文档块没有版本,忽略。
    #[serde(default)]
    pub version: Option<i64>,
    /// 新标题(代码 / 文档块的标题只读)。
    #[serde(default)]
    pub title: Option<String>,
    /// 新正文(markdown;代码 / 文档块的正文只读)。
    #[serde(default)]
    pub body: Option<String>,
    /// 新标签(整体替换)。
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    /// 新的 insight 种类:`decision` / `pitfall` / `howto` / `convention` / `note`。
    #[serde(default)]
    pub kind: Option<String>,
}

/// `create_item` 的参数(新建一条经验)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct CreateItemArgs {
    /// 直接指定 collection;不填时按 `project` / `global` 解析。
    #[serde(default)]
    pub collection: Option<String>,
    /// 目标项目。
    #[serde(default)]
    pub project: Option<String>,
    /// 写进 `_global`。
    #[serde(default)]
    pub global: bool,
    /// 标题(一句话)。
    pub title: String,
    /// 正文(markdown)。
    pub body: String,
    /// 种类,默认 `note`。
    #[serde(default)]
    pub kind: Option<String>,
    /// 标签。
    #[serde(default)]
    pub tags: Vec<String>,
    /// 相关文件(项目内相对路径)。
    #[serde(default)]
    pub related_paths: Vec<String>,
}

/// `batch_tag` 的参数(一次给多条打 / 去标签,整批可撤销)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct BatchTagArgs {
    /// 记录 id 列表(最多 200 条)。
    pub ids: Vec<String>,
    /// 要加的标签。
    #[serde(default)]
    pub add: Vec<String>,
    /// 要去掉的标签。
    #[serde(default)]
    pub remove: Vec<String>,
}

/// 分页参数(`audit_list` / `batch_list` 用)。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct PageArgs {
    /// 页码,从 1 起。
    #[serde(default)]
    pub page: Option<u32>,
    /// 每页条数(上限 200)。
    #[serde(default)]
    pub page_size: Option<u32>,
}

/// `delete_collection` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct CollectionArgs {
    /// collection 名。
    pub collection: String,
}

/// `update_project` 的参数(编辑项目)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct UpdateProjectArgs {
    /// 项目名或 slug。
    pub project: String,
    /// include glob(给空数组表示“全部”)。
    #[serde(default)]
    pub include: Option<Vec<String>>,
    /// exclude glob。
    #[serde(default)]
    pub exclude: Option<Vec<String>>,
    /// 是否允许把内容发给云端 LLM。
    #[serde(default)]
    pub allow_cloud_llm: Option<bool>,
    /// 是否开启自动提炼。
    #[serde(default)]
    pub extract_enabled: Option<bool>,
    /// 改完后是否立刻投递一次全量索引(默认 false)。
    #[serde(default)]
    pub reindex: bool,
}

/// `search_knowledge` / `search_code` 的输出。
#[derive(Clone, Debug, Serialize)]
pub struct SearchOutput {
    /// 命中。
    pub hits: Vec<kb_core::model::SearchHit>,
    /// 实际作用域。
    pub scope: Vec<String>,
    /// 解析后的查询。
    pub query_parsed: serde_json::Value,
}
