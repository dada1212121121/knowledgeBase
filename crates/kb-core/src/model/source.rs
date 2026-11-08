//! 外部来源:网页 / 本地目录的登记与状态。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Millis;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// 数据源与上传
// ---------------------------------------------------------------------------

/// 数据源种类（设计规范）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// 本地目录(监听 + git hook,复用目录监听与 git hook)。
    LocalDir,
    /// Git 仓库(克隆到 `KB_HOME/sources/<id>`,定时 fetch)。
    Git,
    /// 网页(URL 抓取,深度与域名白名单;抓取本体在 接入)。
    Web,
    /// 文件上传(浏览器逐个文件上传)。
    Upload,
    /// 压缩包(上传后在服务端安全解包,逐文件入库)。
    Archive,
    /// 手写笔记(正文直接写成一份 Markdown)。
    Note,
}

impl SourceKind {
    /// 数据库 / API 里的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::LocalDir => "local_dir",
            Self::Git => "git",
            Self::Web => "web",
            Self::Upload => "upload",
            Self::Archive => "archive",
            Self::Note => "note",
        }
    }

    /// 从字符串还原(未知取值返回 `None`,由调用方给中文报错)。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "local_dir" => Some(Self::LocalDir),
            "git" => Some(Self::Git),
            "web" => Some(Self::Web),
            "upload" => Some(Self::Upload),
            "archive" => Some(Self::Archive),
            "note" => Some(Self::Note),
            _ => None,
        }
    }

    /// 全部种类(6 选 1)。
    pub const ALL: [Self; 6] = [
        Self::LocalDir,
        Self::Git,
        Self::Web,
        Self::Upload,
        Self::Archive,
        Self::Note,
    ];
}

/// 数据源状态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceStatus {
    /// 空闲(可以同步)。
    Idle,
    /// 正在同步。
    Syncing,
    /// 上次同步失败。
    Error,
}

impl SourceStatus {
    /// 数据库 / API 里的字符串。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Syncing => "syncing",
            Self::Error => "error",
        }
    }

    /// 从字符串还原。
    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "idle" => Some(Self::Idle),
            "syncing" => Some(Self::Syncing),
            "error" => Some(Self::Error),
            _ => None,
        }
    }
}

/// `sources` 表:一个数据源。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Source {
    /// 主键(uuid v7)。
    pub id: String,
    /// 种类。
    pub kind: SourceKind,
    /// 显示名(唯一)。
    pub name: String,
    /// 地址:本地路径 / git URL / 网页 URL / 存储目录(上传与笔记由服务端生成)。
    pub uri: String,
    /// 目标 collection。
    pub collection: String,
    /// 给该源所有块打的标签。
    pub tags: Vec<String>,
    /// include glob(空 = 全部)。
    pub include: Vec<String>,
    /// exclude glob。
    pub exclude: Vec<String>,
    /// 网页抓取深度(1..=3,其它种类忽略)。
    pub depth: u32,
    /// 网页抓取的域名白名单(空 = 只允许 `uri` 的域名)。
    pub allow_hosts: Vec<String>,
    /// 定时刷新间隔(分钟;`None` = 不自动刷新)。
    pub refresh_minutes: Option<u64>,
    /// 状态。
    pub status: SourceStatus,
    /// 上次同步时间。
    pub last_synced_at: Option<Millis>,
    /// 上次同步的错误。
    pub last_error: Option<String>,
    /// 已入库的文件数(冗余统计,列表页用)。
    pub files: u64,
    /// 创建时间。
    pub created_at: Millis,
    /// 网页来源:抓到的页面是否再交给内置模型整理成规范化结果。
    ///
    /// 默认 `false`:迁移前就有的数据源升级后不会突然开始花 AI 额度。其它种类恒为 `false`。
    #[serde(default)]
    pub ai_extract: bool,
    /// 网页来源的「提取要求」(空 = 让模型自动判断页面类型、尽量全面地整理)。
    #[serde(default)]
    pub extract_prompt: String,
    /// 最近一次 AI 规范化的情况(没跑过就是 `None`)。由后台任务写,列表 / 详情页展示。
    #[serde(default)]
    pub ai_status: Option<SourceAiStatus>,
}

/// 网页来源最近一次 AI 规范化的情况。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceAiStatus {
    /// 当前抓到的页面里,已经有规范化结果(且与正文、提取要求一致)的页数。
    pub done: u64,
    /// 还没整理的页数(暂停、额度用完、超出单次上限时留到下次同步补)。
    pub pending: u64,
    /// 这一轮整理失败的页数(模型两次都没返回合法 JSON 等)。
    pub failed: u64,
    /// 给人看的说明:暂停原因、失败原因摘要;正常完成时为 `None`。
    pub note: Option<String>,
    /// 写入时间。
    pub updated_at: Millis,
}
