//! 文档与表格:读写、编辑、AI 修改建议、批注。

use super::*;

/// `csv_read` 的参数(第 5 步:CSV / TSV 表格编辑)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct CsvReadArgs {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径(`.csv` / `.tsv`)。
    pub path: String,
    /// 从第几行开始(从 0 数,不含全空白的行;默认 0)。
    #[serde(default)]
    pub offset: Option<u32>,
    /// 最多读多少行(默认 500,最多 2000)。
    #[serde(default)]
    pub limit: Option<u32>,
}

/// 表格编辑的一个操作。行号、列号都从 0 开始,指的是**修改之前**的表。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum CsvEditOp {
    /// 改一个格子;列号超出这一行现有的列时补空格子。
    SetCell {
        /// 行。
        row: u32,
        /// 列。
        col: u32,
        /// 新内容。
        value: String,
    },
    /// 在第 `at` 行之前插入一行;`at` 等于行数就是加在最后。
    InsertRow {
        /// 位置。
        at: u32,
        /// 各列的内容。
        values: Vec<String>,
    },
    /// 删除一行。
    DeleteRow {
        /// 行。
        row: u32,
    },
}

/// `doc_read` 的参数:读一个文件(`collection` + `path`)或一篇笔记(`note_id`)现在的内容。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DocReadArgs {
    /// 文件所在的 collection(读文件时必填;读笔记时不用)。
    #[serde(default)]
    pub collection: Option<String>,
    /// 文件相对路径。
    #[serde(default)]
    pub path: Option<String>,
    /// 笔记 id(和 `path` 二选一)。
    #[serde(default)]
    pub note_id: Option<String>,
    /// 从第几行开始(0 起)。
    #[serde(default)]
    pub offset: Option<u32>,
    /// 最多几行(默认 400,上限 2000)。
    #[serde(default)]
    pub limit: Option<u32>,
}

/// 一处文字替换:把 `old`(必须在文档里恰好出现一次)换成 `new`。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DocTextEdit {
    /// 原文(照 `doc_read` 读到的内容写,带上足够的上下文让它唯一)。
    pub old: String,
    /// 换成什么(空字符串 = 删掉)。
    pub new: String,
}

/// `doc_edit` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DocEditArgs {
    /// 文件所在的 collection(改文件时必填)。
    #[serde(default)]
    pub collection: Option<String>,
    /// 文件相对路径。
    #[serde(default)]
    pub path: Option<String>,
    /// 笔记 id(和 `path` 二选一)。
    #[serde(default)]
    pub note_id: Option<String>,
    /// 1–32 处替换,整批生效或整批不生效。
    pub edits: Vec<DocTextEdit>,
    /// 一句话说明为什么这样改(显示给审阅的人)。
    #[serde(default)]
    pub reason: Option<String>,
}

/// `doc_proposals` 的参数:一个文档上 AI 的修改建议。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DocProposalsArgs {
    /// 文件所在的 collection。
    #[serde(default)]
    pub collection: Option<String>,
    /// 文件相对路径。
    #[serde(default)]
    pub path: Option<String>,
    /// 笔记 id。
    #[serde(default)]
    pub note_id: Option<String>,
    /// 只看某个状态:pending / accepted / rejected / failed;不填看全部。
    #[serde(default)]
    pub status: Option<String>,
}

/// `doc_proposal_decide` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DocProposalDecideArgs {
    /// 建议 id。
    pub id: String,
    /// true 接受(按当时的内容应用;正在多人编辑时实时出现在每个人那里),false 拒绝。
    pub accept: bool,
}

/// `csv_edit` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct CsvEditArgs {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径(`.csv` / `.tsv`)。
    pub path: String,
    /// 操作列表(最多 5000 个)。
    pub ops: Vec<CsvEditOp>,
    /// 乐观锁:打开时看到的版本号(与最新版本不一致返回冲突)。
    #[serde(default)]
    pub expected_version: Option<i64>,
    /// 乐观锁:打开时拿到的内容哈希(文件在这之后被改过就拒绝)。
    #[serde(default)]
    pub expected_sha256: Option<String>,
}

/// `add_annotation` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AddAnnotationArgs {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub source: String,
    /// 批注正文。
    pub body: String,
    /// 位置锚点(JSON;为空表示整份文件)。
    #[serde(default)]
    pub anchor: Option<serde_json::Value>,
    /// 回复哪条评论(只能回复顶层评论,只有一层);回复沿用那条评论的位置锚点。
    #[serde(default)]
    pub parent_id: Option<String>,
    /// 正文里 @ 到的用户名(不带 @)。服务端只通知「存在、账号可用、并且能看到这篇文档」的人,
    /// 其余的静默忽略(不暴露谁存在);游客的 @ 一律忽略。
    #[serde(default)]
    pub mentions: Vec<String>,
}

/// `resolve_annotation` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ResolveAnnotationArgs {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径(`insight:<id>` 是笔记)。必须和评论所在的文档一致。
    pub source: String,
    /// 评论 id(必须是顶层评论)。
    pub id: String,
    /// `true` 标记已解决,`false` 取消。
    pub resolved: bool,
}

/// `list_annotations` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ListAnnotationsArgs {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub source: String,
    /// 最多返回多少条(默认 100)。
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `doc_links` 的参数:查一篇文档 / 笔记的引用图谱。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DocLinksArgs {
    /// 文件所在 collection(查笔记时可省)。
    #[serde(default)]
    pub collection: Option<String>,
    /// 文件在 collection 内的相对路径(查笔记时不填)。
    #[serde(default)]
    pub path: Option<String>,
    /// 目录前缀:查整个目录下的入链(删除 / 移动文件夹前的影响提示)。
    #[serde(default)]
    pub path_prefix: Option<String>,
    /// 笔记 id(填了它就不看 collection / path / path_prefix)。
    #[serde(default)]
    pub note_id: Option<String>,
    /// `from` 只查出链,`to` 只查入链,`both`(默认)两边都查。
    #[serde(default)]
    pub direction: Option<String>,
    /// 每边最多返回多少条(默认 100,上限 500)。
    #[serde(default)]
    pub limit: Option<u32>,
}
