//! 文件操作:预览 / 原文、移动删除与回收站、CSV 与表格写回之外的版本与链接检查。

use super::*;

/// `file_actions` 的参数(右键菜单先问能不能删 / 能不能移动)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FileActionsArgs {
    /// collection 名。
    pub collection: String,
    /// 集合内相对路径(文件或文件夹)。
    pub path: String,
}

/// 删除单个文件。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DeleteFileArgs {
    /// collection 名。
    pub collection: String,
    /// 文件路径。
    pub path: String,
    /// `file_actions` 返回的指纹,执行前重算,不一致返回 409。
    pub fingerprint: String,
}

/// 删除文件夹(按路径段边界,列出全部后代)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct DeleteFolderArgs {
    /// collection 名。
    pub collection: String,
    /// 文件夹路径。
    pub path: String,
    /// `file_actions` 返回的指纹。
    pub fingerprint: String,
}

/// 移动单个文件。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct MoveFileArgs {
    /// collection 名(源知识库)。
    pub collection: String,
    /// 文件路径。
    pub path: String,
    /// 目标知识库;空 / 不传表示当前知识库。
    #[serde(default)]
    pub target_collection: Option<String>,
    /// 目标文件夹(空字符串表示集合根)。
    #[serde(default)]
    pub target_dir: String,
    /// 新文件名(默认沿用原名)。
    #[serde(default)]
    pub new_name: Option<String>,
    /// `file_actions` 返回的指纹。
    pub fingerprint: String,
}

/// 批量移动里的一个文件。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct MoveFileItem {
    /// 文件路径。
    pub path: String,
    /// `file_actions` 返回的指纹。
    pub fingerprint: String,
}

/// 批量移动文件到同一个目录。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct MoveFilesArgs {
    /// collection 名(源知识库)。
    pub collection: String,
    /// 要移动的文件。
    pub items: Vec<MoveFileItem>,
    /// 目标知识库;空 / 不传表示当前知识库。
    #[serde(default)]
    pub target_collection: Option<String>,
    /// 目标文件夹(空字符串表示集合根)。
    #[serde(default)]
    pub target_dir: String,
}

/// 移动文件夹。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct MoveFolderArgs {
    /// collection 名(源知识库)。
    pub collection: String,
    /// 文件夹路径。
    pub path: String,
    /// 目标知识库;空 / 不传表示当前知识库。
    #[serde(default)]
    pub target_collection: Option<String>,
    /// 目标文件夹(空字符串表示集合根)。
    #[serde(default)]
    pub target_dir: String,
    /// 新文件夹名(默认沿用原名)。
    #[serde(default)]
    pub new_name: Option<String>,
    /// `file_actions` 返回的指纹。
    pub fingerprint: String,
}

/// 按操作 id 查进度。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FileOpIdArgs {
    /// 操作 id(`fop_…`)。
    pub op_id: String,
}

/// 列回收站。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ListTrashArgs {
    /// 只看这个 collection(None = 全部)。
    #[serde(default)]
    pub collection: Option<String>,
    /// 每页条数(默认 50,最多 500)。
    #[serde(default)]
    pub limit: Option<u32>,
    /// 跳过条数。
    #[serde(default)]
    pub offset: Option<u32>,
}

/// 恢复 / 彻底删除一个回收站条目。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct TrashIdArgs {
    /// 回收站条目 id(`tr_…`)。
    pub trash_id: String,
}

/// `import_global` 的参数(把文件 / 目录导入 `_global`)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ImportGlobalArgs {
    /// 文件或目录路径。
    pub path: String,
    /// 附加标签。
    #[serde(default)]
    pub tags: Vec<String>,
}

/// `file_preview` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FilePreviewArgs {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径(与检索结果里的 `source` 一致)。
    pub path: String,
}

/// `file_raw` 的参数(预览页读原件:图片 / 音频等)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FileRawArgs {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径(与检索结果里的 `source` 一致)。
    pub path: String,
}

/// `check_links` 里的一条目标。
///
/// 文件目标用 `collection` + `path`;笔记目标用 `kind = "note"` + `note_id`,
/// 此时 `collection` / `path` 可以不传。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct LinkTarget {
    /// 目标类型:`file`(默认)/ `note`。
    #[serde(default)]
    pub kind: Option<String>,
    /// collection 名(文件目标必填)。
    #[serde(default)]
    pub collection: String,
    /// 目标文件相对路径(文件目标必填)。
    #[serde(default)]
    pub path: String,
    /// 笔记 id(笔记目标必填)。
    #[serde(default)]
    pub note_id: Option<String>,
}

/// `check_links` 的参数:导入 / 编辑后体检正文里的文件引用。
///
/// 只返回「在不在、大小、类型」,不返回内容;一次最多 200 条,避免被当成目录扫描接口。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct CheckLinksArgs {
    /// 要检查的目标。
    pub targets: Vec<LinkTarget>,
}

/// `save_file` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SaveFileArgs {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub path: String,
    /// 新的整份内容。
    pub content: String,
    /// 乐观锁:期望的当前版本(与最新版本不一致返回冲突)。
    #[serde(default)]
    pub expected_version: Option<i64>,
    /// 标签。
    #[serde(default)]
    pub tags: Vec<String>,
}

/// `file_versions` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FileVersionsArgs {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub path: String,
    /// 最多返回多少条(默认 50)。
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `file_info` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FileInfoArgs {
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub path: String,
}

/// `edit_sheet_cells` 里的一格。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SheetCellArg {
    /// 工作表名(和 Excel 底部页签一样)。
    pub sheet: String,
    /// 单元格地址,如 `B12`。
    pub cell: String,
    /// 新的值;空串 = 清空。数字按数字存,其余按文本。
    pub value: String,
}

/// `edit_sheet_cells` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct EditSheetCellsArgs {
    /// collection 名。
    pub collection: String,
    /// .xlsx 文件的相对路径。
    pub path: String,
    /// 要改的格子(最多 2000 格)。公式格不能改。
    pub edits: Vec<SheetCellArg>,
    /// 打开时那份内容的 sha256(`file_info` 返回的);给了就做乐观锁,这期间文件被别人改过会被拒绝。
    #[serde(default)]
    pub expected_sha256: Option<String>,
}

/// `restore_file_version` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct RestoreVersionArgs {
    /// 版本 id。
    pub version_id: String,
}

/// `file_version` 的参数:取某一版的完整正文(历史面板里对比两个版本用)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FileVersionArgs {
    /// 版本 id(`file_versions` 返回的 `id`)。
    pub version_id: String,
}

/// `convert_to_markdown` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ConvertMarkdownArgs {
    /// collection 名。
    pub collection: String,
    /// 原文件相对路径。
    pub path: String,
}

/// `list_files` 的参数:写笔记时挑一个已有文件 / 模板来引用。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct ListFilesArgs {
    /// collection 名(例如 `_global` / `proj_demo`)。只列这一个集合里的文件。
    pub collection: String,
    /// 只列这个目录下的文件(集合内相对路径,不带首尾斜杠)。
    #[serde(default)]
    pub path_prefix: Option<String>,
    /// 关键词:空格分隔,全部命中文件名 / 路径才返回。
    #[serde(default)]
    pub q: Option<String>,
    /// 页码,从 1 起。
    #[serde(default)]
    pub page: Option<u32>,
    /// 每页条数(上限 500)。
    #[serde(default)]
    pub page_size: Option<u32>,
}
