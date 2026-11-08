//! 条目视图:文件记录、版本、批注、文件动作。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::{Anchor, FileOrigin, Millis};
use serde::{Deserialize, Serialize};

/// `files` 表:文件级指纹。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileRecord {
    /// 所属 collection。
    pub collection: String,
    /// 项目内相对路径。
    pub path: String,
    /// 文件内容哈希。
    pub file_hash: String,
    /// 文件大小。
    pub size: u64,
    /// 修改时间。
    pub mtime: Millis,
    /// 索引时间。
    pub indexed_at: Millis,
    /// `ok` / `skipped` / `error`。
    pub status: String,
    /// 跳过或失败的原因。
    pub error: Option<String>,
}

/// 一次文本编辑的版本。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ItemVersion {
    /// 主键(uuid v7)。
    pub id: String,
    /// 条目 id(代码 / 文档块是块 id;文件级编辑用首块 id 或文件路径哈希)。
    pub item_id: String,
    /// collection 名。
    pub collection: String,
    /// 文件相对路径。
    pub source: String,
    /// 版本号(1 起,同一 item 内递增)。
    pub version: i64,
    /// 标题(insight 用;文件为 `None`)。
    pub title: Option<String>,
    /// 整份正文。
    pub body: String,
    /// 标签。
    pub tags: Vec<String>,
    /// 谁改的。
    pub author: Option<String>,
    /// 改动所属批次(可撤销)。
    pub batch_id: Option<String>,
    /// 时间。
    pub created_at: Millis,
}

/// 一条批注:锚定到页 / 单元格 / 幻灯片 / 时间点,同时作为可检索记录。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Annotation {
    /// 主键(uuid v7)。
    pub id: String,
    /// collection 名。
    pub collection: String,
    /// 所属文件(相对路径)。
    pub source: String,
    /// 位置锚点(为空表示整份文件)。
    pub anchor: Option<Anchor>,
    /// 批注正文。
    pub body: String,
    /// 谁写的。
    pub author: Option<String>,
    /// 对应的检索记录 id(建批注时写入)。
    pub record_id: Option<String>,
    /// 回复的是哪条评论。只有一层:回复不能再被回复;顶层评论为 `None`。
    #[serde(default)]
    pub parent_id: Option<String>,
    /// 标记为已解决的时间(只有顶层评论能被标记,回复跟着它走)。
    #[serde(default)]
    pub resolved_at: Option<Millis>,
    /// 谁标记的已解决。
    #[serde(default)]
    pub resolved_by: Option<String>,
    /// 评论里 @ 到并且已经通知的用户 id。
    #[serde(default)]
    pub mentions: Vec<String>,
    /// 创建时间。
    pub created_at: Millis,
    /// 更新时间。
    pub updated_at: Millis,
}

/// 文件操作前的指纹:执行时重算,不一致返回 409,避免两个人同时操作同一份文件。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileFingerprint {
    /// 单文件是 `file_hash+size+mtime`;文件夹是排序后的 `(path,file_hash)` 列表哈希。
    pub value: String,
    /// 指纹覆盖的文件数。
    pub files: u64,
}

/// `file_actions` 的返回:前端据此决定菜单里哪些项可点,以及带上哪个指纹。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileActions {
    /// 所属 collection。
    pub collection: String,
    /// 相对路径(文件或文件夹)。
    pub path: String,
    /// 来源(文件夹取混合来源时给 `unknown`)。
    pub origin: FileOrigin,
    /// 是否托管副本。
    pub managed: bool,
    /// 是否是一个文件夹(至少有一个后代文件)。
    pub folder: bool,
    /// 后代文件数。
    pub files: u64,
    /// 操作指纹。
    pub fingerprint: FileFingerprint,
    /// 能不能删除;不能时 `reason` 说明原因。
    pub delete: FileActionAvailability,
    /// 能不能移动。
    pub r#move: FileActionAvailability,
}

/// 一个动作能不能做。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileActionAvailability {
    /// 能不能做。
    pub allowed: bool,
    /// 不能做的原因(界面必须显示,不能只把按钮灰掉)。
    pub reason: Option<String>,
}

impl FileActionAvailability {
    /// 允许。
    pub fn yes() -> Self {
        Self {
            allowed: true,
            reason: None,
        }
    }

    /// 不允许,并说明原因。
    pub fn no(reason: impl Into<String>) -> Self {
        Self {
            allowed: false,
            reason: Some(reason.into()),
        }
    }
}
