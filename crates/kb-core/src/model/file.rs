//! 文件操作:上传、去重、移动/复制/删除、回收站。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Millis;
use serde::{Deserialize, Serialize};

/// 上传状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UploadState {
    /// 正在收分片。
    Pending,
    /// 已合并、已入解析队列。
    Completed,
    /// 被取消或超时清理。
    Aborted,
}

impl UploadState {
    /// 数据库 / API 里的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Completed => "completed",
            Self::Aborted => "aborted",
        }
    }

    /// 从字符串还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "pending" => Some(Self::Pending),
            "completed" => Some(Self::Completed),
            "aborted" => Some(Self::Aborted),
            _ => None,
        }
    }
}

/// 同名不同内容时的处理策略(去重)。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DedupStrategy {
    /// 跳过:不入库。
    #[default]
    Skip,
    /// 覆盖:新内容替换同名文件(旧内容留一份备份,撤销时可还原)。
    Overwrite,
    /// 保留两者:自动改名为 `名称 (2)`。
    KeepBoth,
}

impl DedupStrategy {
    /// 数据库 / API 里的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Skip => "skip",
            Self::Overwrite => "overwrite",
            Self::KeepBoth => "keep_both",
        }
    }

    /// 从字符串还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "skip" => Some(Self::Skip),
            "overwrite" => Some(Self::Overwrite),
            "keep_both" => Some(Self::KeepBoth),
            _ => None,
        }
    }
}

/// `uploads` 表:一次分片上传。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Upload {
    /// 主键(uuid v7)。
    pub id: String,
    /// 文件名。
    pub name: String,
    /// 集合内相对路径(`/` 分隔;文件夹上传时保留目录结构)。
    pub rel_path: String,
    /// 目标 collection。
    pub collection: String,
    /// 标签。
    pub tags: Vec<String>,
    /// 声明的总字节数。
    pub size: u64,
    /// 客户端声明的整体 sha256(可空;空则服务端算完写回)。
    pub sha256: Option<String>,
    /// 分片大小(字节)。
    pub chunk_size: u64,
    /// 分片总数。
    pub parts_total: u32,
    /// 已收分片数(冗余统计,续传时不用它做判断)。
    pub parts_received: u32,
    /// 状态。
    pub state: UploadState,
    /// 完成后创建的数据源。
    pub source_id: Option<String>,
    /// 归属批次(一次上传 = 一个 batch,可整批撤销)。
    pub batch_id: Option<String>,
    /// 同名不同内容的处理策略(`None` = 用默认的 skip)。
    pub strategy: Option<DedupStrategy>,
    /// 创建时间。
    pub created_at: Millis,
    /// 最近一次收到分片 / 状态变化的时间。
    pub updated_at: Millis,
    /// 完成时间。
    pub completed_at: Option<Millis>,
}

/// `upload_parts` 表:一个已收到的分片。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UploadPart {
    /// 所属上传。
    pub upload_id: String,
    /// 分片序号(0 起)。
    pub part_no: u32,
    /// 字节数。
    pub size: u64,
    /// 分片的 sha256(服务端算的)。
    pub sha256: String,
    /// 收到时间。
    pub received_at: Millis,
}

/// 文件在知识库里的来源。删除和移动的语义完全由它决定:
/// 上传 / 压缩包是托管副本,可以搬进回收站;本地目录 / 项目 / Web / Git 只移除索引,
/// 绝不碰磁盘上的原件或源站。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOrigin {
    /// 浏览器上传的托管副本(`KB_HOME/sources/<source>/…`)。
    Upload,
    /// 压缩包解出来的托管副本。
    Archive,
    /// 网页抓取的副本(源站在外部,本地只是缓存)。
    Web,
    /// Git 仓库克隆出来的副本(源在远端)。
    Git,
    /// 本地目录数据源(原件在用户指定的目录里)。
    LocalDir,
    /// 已注册项目的文件(原件在项目根目录里)。
    Project,
    /// 手写笔记(走 `delete_item`,不是文件操作)。
    Note,
    /// 邮件 / 压缩包的派生附件(随父条目删除,不能单独删)。
    Attachment,
    /// 对不上任何来源(旧数据或手工写进索引的行)。
    Unknown,
}

impl FileOrigin {
    /// 数据库 / API 里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Upload => "upload",
            Self::Archive => "archive",
            Self::Web => "web",
            Self::Git => "git",
            Self::LocalDir => "local_dir",
            Self::Project => "project",
            Self::Note => "note",
            Self::Attachment => "attachment",
            Self::Unknown => "unknown",
        }
    }

    /// 是不是宿主托管的副本:只有这类文件能进回收站。
    pub fn is_managed(self) -> bool {
        matches!(self, Self::Upload | Self::Archive)
    }
}

/// 一个可操作文件的定位结果(路径、来源、指纹)。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileTarget {
    /// 所属 collection。
    pub collection: String,
    /// 集合内相对路径。
    pub path: String,
    /// 来源。
    pub origin: FileOrigin,
    /// 是否托管副本。
    pub managed: bool,
    /// 数据源 id;项目文件是 `project:<项目 id>`。
    pub source_id: Option<String>,
    /// 原件绝对路径(只用于托管副本的物理移动;本地目录 / 项目不暴露给前端)。
    pub abs_path: Option<String>,
    /// 内容哈希(`files.file_hash`)。
    pub file_hash: String,
    /// 字节数。
    pub size: u64,
    /// 修改时间。
    pub mtime: Millis,
}

/// 文件操作类型。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOpKind {
    /// 删除单个文件。
    DeleteFile,
    /// 删除文件夹(按路径段边界匹配)。
    DeleteFolder,
    /// 移动单个文件。
    MoveFile,
    /// 批量移动文件。
    MoveFiles,
    /// 移动文件夹。
    MoveFolder,
    /// 从回收站恢复。
    Restore,
    /// 彻底删除。
    Purge,
}

impl FileOpKind {
    /// 数据库里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::DeleteFile => "delete_file",
            Self::DeleteFolder => "delete_folder",
            Self::MoveFile => "move_file",
            Self::MoveFiles => "move_files",
            Self::MoveFolder => "move_folder",
            Self::Restore => "restore",
            Self::Purge => "purge",
        }
    }

    /// 从字符串还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "delete_file" => Some(Self::DeleteFile),
            "delete_folder" => Some(Self::DeleteFolder),
            "move_file" => Some(Self::MoveFile),
            "move_files" => Some(Self::MoveFiles),
            "move_folder" => Some(Self::MoveFolder),
            "restore" => Some(Self::Restore),
            "purge" => Some(Self::Purge),
            _ => None,
        }
    }
}

/// 文件操作的状态。文件夹删除允许部分成功,所以除了 done / failed 还有 partial。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileOpState {
    /// 进行中。
    Running,
    /// 全部成功。
    Done,
    /// 部分成功。
    Partial,
    /// 失败。
    Failed,
    /// 已按流水回滚。
    RolledBack,
}

impl FileOpState {
    /// 数据库里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Done => "done",
            Self::Partial => "partial",
            Self::Failed => "failed",
            Self::RolledBack => "rolled_back",
        }
    }

    /// 从字符串还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "running" => Some(Self::Running),
            "done" => Some(Self::Done),
            "partial" => Some(Self::Partial),
            "failed" => Some(Self::Failed),
            "rolled_back" => Some(Self::RolledBack),
            _ => None,
        }
    }
}

/// `file_ops` 表的一行:一次文件操作的流水。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileOp {
    /// 主键。
    pub id: String,
    /// 所属 collection(移动操作是源集合)。
    pub collection: String,
    /// 移动的目标 collection;同库移动 / 删除 / 恢复 / 清理为 `None`。
    #[serde(default)]
    pub target_collection: Option<String>,
    /// 操作类型。
    pub kind: FileOpKind,
    /// 状态。
    pub state: FileOpState,
    /// 计划处理的总数。
    pub total: u64,
    /// 已成功处理的数量。
    pub done: u64,
    /// 失败的数量。
    pub failed: u64,
    /// 最后一处错误。
    pub error: Option<String>,
    /// 创建时间。
    pub created_at: Millis,
    /// 结束时间。
    pub finished_at: Option<Millis>,
}

/// 回收站条目的删除方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrashMode {
    /// 物理移进回收站(上传 / 压缩包)。
    Trash,
    /// 只移除索引,并记一条同步排除标记。
    Unindex,
}

impl TrashMode {
    /// 数据库里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trash => "trash",
            Self::Unindex => "unindex",
        }
    }

    /// 从字符串还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "trash" => Some(Self::Trash),
            "unindex" => Some(Self::Unindex),
            _ => None,
        }
    }
}

/// `trash_entries` 表的一行。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TrashEntry {
    /// 主键。
    pub id: String,
    /// 所属操作。
    pub op_id: String,
    /// 所属 collection。
    pub collection: String,
    /// 删除前的相对路径。
    pub original_path: String,
    /// 回收站里的绝对路径(`unindex` 为 `None`)。
    pub trash_path: Option<String>,
    /// 数据源 id(项目文件为 `project:<id>`)。
    pub source_id: Option<String>,
    /// 隐藏期间版本 / 批注使用的归属键(`trash:<id>`)。
    pub metadata_key: String,
    /// 删除方式。
    pub mode: TrashMode,
    /// 字节数。
    pub size: u64,
    /// 创建时间。
    pub created_at: Millis,
    /// 过期时间(30 天后清理)。
    pub expires_at: Option<Millis>,
    /// 恢复时间。
    pub restored_at: Option<Millis>,
    /// 彻底删除时间。
    pub purged_at: Option<Millis>,
}
