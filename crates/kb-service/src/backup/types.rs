//! 备份用到的全部小类型:策略、触发方式、状态、失败记录、归档清单。
//!
//! 这些类型同时被三处用:守护进程(定时备份)、能力调用(设置页手动备份 / 状态轮询)、
//! CLI(`kb backup ...`)。放在一层里,是为了让「界面显示的字段」和「落盘的 JSON」
//! 始终是同一份定义,不会出现界面读 `last_check`、文件里写 `lastCheck` 这种错位。
//!
//! 字段一律 crate 可见:同目录几个模块都要读写它们。

use super::*;

/// 备份归档的扩展名。
pub(crate) const ARCHIVE_EXT: &str = ".tar.gz";

/// 一小时的毫秒数(到点判断用)。
pub(crate) const HOUR_MS: i64 = 3_600_000;

/// 一天的毫秒数(按天清理用)。
pub(crate) const DAY_MS: i64 = 86_400_000;

/// 最近一次自动备份的结果文件(放在归档目录里,以 `.` 开头,`entries` 会跳过)。
///
/// 守护进程与能力调用各自 new 一个 `BackupService`,内存里的状态互相看不见,
/// 所以失败原因要落盘才能被设置页读到。
pub(crate) const LAST_RUN_FILE: &str = ".last-run.json";

/// 打包进度的落盘文件(同上,`.` 开头,不进归档列表)。
pub(crate) const PROGRESS_FILE: &str = ".progress.json";

/// 失败记录文件(最近 [`MAX_FAILURES`] 条,新的在前)。
pub(crate) const FAILURES_FILE: &str = ".failures.json";

/// 异地目录的状态文件(每个目录最近一次复制成功 / 失败的时间与原因)。
pub(crate) const MIRRORS_FILE: &str = ".mirrors.json";

/// 最近一次**自动校验**的结果(备份写完后自己跑一次 `verify` 的结论)。
pub(crate) const VERIFY_FILE: &str = ".verify.json";

/// 失败记录保留多少条(只用于展示,不参与判断)。
pub(crate) const MAX_FAILURES: usize = 20;

/// 校验时读 `manifest.json` 的上限(它只是几十行 JSON,超了就是坏归档)。
pub(crate) const MAX_MANIFEST_BYTES: u64 = 8 * 1024 * 1024;

/// 元数据库快照端口。
///
/// 由组装根(kb-cli)用 `SqliteMetaStore::snapshot_to` 实现;kb-service 不直接依赖
/// kb-meta,测试里换成“拷一份文件”的假实现。
#[async_trait]
pub trait DbSnapshot: Send + Sync {
    /// 把当前数据库写成 `dest` 处的独立 SQLite 文件。
    async fn snapshot_to(&self, dest: &Path) -> Result<()>;
}

/// 给**别的** SQLite 文件(账号库 `system.db`、各用户知识库的 `meta.db`)做一致性快照。
///
/// 和 [`DbSnapshot`] 的区别:主知识库的库由进程里已经打开的存储对象拍;别的库数量不定
/// (每注册一个用户就多一个),备份时才去目录里找,拍的时候只需要文件路径。阻塞调用,在打包线程里用。
pub trait SqliteSnapshotter: Send + Sync {
    /// 把 `src` 写成 `dst` 处的独立 SQLite 文件。
    fn snapshot(&self, src: &Path, dst: &Path) -> Result<()>;
}

/// 备份范围。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BackupOptions {
    /// 是否把 `sources/`(上传与数据源的原件)也打进归档。
    pub include_sources: bool,
}

/// 一次备份是**定时**触发还是**手动**触发(失败记录里要区分:定时失败没人盯着)。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupTrigger {
    /// 守护进程按 `[backup]` 到点触发。
    Auto,
    /// 用户点「立即备份」或 `kb backup create`。
    Manual,
}

impl BackupTrigger {
    /// 存盘 / 输出用的短名(`auto` / `manual`)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
        }
    }
}

/// 一次失败属于哪一环。
///
/// 四处的失败都要进同一套告警(`.failures.json` + WS `backup.failed` + 页面横幅),
/// 但“解决了没有”各自算:一次成功的清理不该把打包失败的告警撤掉,反之亦然。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupFailureKind {
    /// 打包(`create`)失败。
    #[default]
    Pack,
    /// 保留策略清理(`prune` / 删除)失败。
    Prune,
    /// 复制到异地目录、或清理异地副本失败。
    Mirror,
    /// 归档写完之后**自动校验**没通过(归档解不开 / 内容与 manifest 对不上)。
    Verify,
}

impl BackupFailureKind {
    /// 给人看的环节名(设置页的告警行与失败历史用)。
    pub fn label(self) -> &'static str {
        match self {
            Self::Pack => "备份",
            Self::Prune => "清理",
            Self::Mirror => "异地副本",
            Self::Verify => "校验",
        }
    }
}

/// 一次失败的备份 / 清理 / 异地复制(落盘在 `backups/.failures.json`,设置页与外壳横幅都读它)。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BackupFailure {
    /// 失败时间(unix 毫秒)。
    pub at: i64,
    /// 定时还是手动。
    pub trigger: BackupTrigger,
    /// 失败发生在哪一环(旧版本写的文件里没有这个字段,按“打包”读)。
    #[serde(default)]
    pub kind: BackupFailureKind,
    /// 失败原因(给人看的)。
    pub error: String,
}

/// `backups/.failures.json` 的内容:失败历史 + 各环节最近一次成功的时间。
///
/// “告警是否已解决”用 `resolved_at` 判断(而不是比归档 mtime):
/// 同一毫秒里既失败又成功时,先记失败、后记成功,以成功为准。
/// 每个环节各有一条“最近一次成功”,所以一次成功的清理不会撤掉打包失败的告警。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct FailureLog {
    /// 最近一次**成功打包**的时间(unix 毫秒;从没成功过就是 0)。
    #[serde(default)]
    pub(crate) resolved_at: i64,
    /// 最近一次成功的清理(`prune`)时间。
    #[serde(default)]
    pub(crate) prune_resolved_at: i64,
    /// 最近一次成功的异地复制时间。
    #[serde(default)]
    pub(crate) mirror_resolved_at: i64,
    /// 最近一次**自动校验通过**的时间。
    #[serde(default)]
    pub(crate) verify_resolved_at: i64,
    /// 失败记录(新的在前,最多 [`MAX_FAILURES`] 条)。
    #[serde(default)]
    pub(crate) failures: Vec<BackupFailure>,
}

impl FailureLog {
    /// 某个环节“最近一次成功”的时间。
    pub(crate) fn resolved_at(&self, kind: BackupFailureKind) -> i64 {
        match kind {
            BackupFailureKind::Pack => self.resolved_at,
            BackupFailureKind::Prune => self.prune_resolved_at,
            BackupFailureKind::Mirror => self.mirror_resolved_at,
            BackupFailureKind::Verify => self.verify_resolved_at,
        }
    }

    /// 记下某个环节刚刚成功。
    pub(crate) fn resolve(&mut self, kind: BackupFailureKind, at: i64) {
        match kind {
            BackupFailureKind::Pack => self.resolved_at = at,
            BackupFailureKind::Prune => self.prune_resolved_at = at,
            BackupFailureKind::Mirror => self.mirror_resolved_at = at,
            BackupFailureKind::Verify => self.verify_resolved_at = at,
        }
    }

    /// 还没解决的最新一条失败(不分环节:横幅只显示一条,取时间最新的)。
    pub(crate) fn alert(&self) -> Option<&BackupFailure> {
        // failures 新的在前,所以第一条未解决的就是最新的那条
        self.failures
            .iter()
            .find(|failure| failure.at > self.resolved_at(failure.kind))
    }
}

/// 打包进行到哪一步。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupStage {
    /// 取元数据库快照、收集文件清单。
    Preparing,
    /// 正在写归档。
    Packing,
    /// 归档已落盘,正在复制到异地目录(没有配置异地目录就不会出现这个阶段)。
    Mirroring,
    /// 归档已落盘,正在回读校验(解压一遍、核对 manifest 与 meta.db)。
    Verifying,
    /// 已经写完(随后进度文件会被删掉)。
    Done,
    /// 失败(原因在 [`BackupProgress::error`])。
    Failed,
}

impl BackupStage {
    /// 是否还在进行中(判断进度文件是不是“残影”用)。
    pub fn is_running(self) -> bool {
        matches!(
            self,
            Self::Preparing | Self::Packing | Self::Mirroring | Self::Verifying
        )
    }

    /// 给人看的阶段名。
    pub fn label(self) -> &'static str {
        match self {
            Self::Preparing => "准备中",
            Self::Packing => "打包中",
            Self::Mirroring => "复制中",
            Self::Verifying => "校验中",
            Self::Done => "已完成",
            Self::Failed => "失败",
        }
    }
}

/// 备份事件的观察者(Web 侧把它接到 WS 上)。
///
/// 三个方法都有默认空实现:只关心进度的实现不必写另外两个。
pub trait BackupObserver: Send + Sync {
    /// 进度推进(已按 [`PROGRESS_INTERVAL`] 节流)。
    fn progress(&self, _progress: &BackupProgress) {}

    /// 一份备份写成功了。
    fn done(&self, _entry: &BackupEntry, _trigger: BackupTrigger) {}

    /// 一份备份失败了(定时 / 手动都会走这里)。
    fn failed(&self, _failure: &BackupFailure) {}
}

/// 定时备份与保留策略(来自 `[backup]`)。
///
/// 保留策略对手动备份同样生效:超过份数 / 天数的旧归档会被
/// [`BackupService::prune`] 删掉,**最新一份永远保留**(配错策略也不会把仅有的备份删掉)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BackupPolicy {
    /// 是否开启定时备份。
    pub enabled: bool,
    /// 备份间隔(小时)。
    pub interval_hours: u64,
    /// 最多保留几份归档(`0` = 不按份数清理)。
    pub keep_count: u64,
    /// 超过多少天的归档删掉(`0` = 不按时间清理)。
    pub keep_days: u64,
    /// 定时备份时是否包含原件。
    pub include_sources: bool,
    /// 异地 / 外部存储目录(原样来自配置;解析见 [`BackupService::mirror_dirs`])。
    pub mirror_dirs: Vec<String>,
}

impl Default for BackupPolicy {
    /// 与 `[backup]` 的默认值一致(开着、每天一次、留 7 份、不复制到异地)。
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 24,
            keep_count: 7,
            keep_days: 0,
            include_sources: false,
            mirror_dirs: Vec::new(),
        }
    }
}

impl BackupPolicy {
    /// 从配置构造。
    pub fn from_config(config: &kb_core::config::BackupConfig) -> Self {
        Self {
            enabled: config.enabled,
            interval_hours: config.interval_hours,
            keep_count: config.keep_count,
            keep_days: config.keep_days,
            include_sources: config.include_sources,
            mirror_dirs: config.mirror_dirs.clone(),
        }
    }

    /// 到点间隔的毫秒数。
    pub(crate) fn interval_millis(&self) -> i64 {
        self.interval_hours as i64 * HOUR_MS
    }
}

/// 一次保留策略清理的结果。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct PruneReport {
    /// 被删掉的归档名(`dry_run` 时是“会被删掉的”)。按时间从旧到新。
    pub removed: Vec<String>,
    /// 删除失败的归档(名字, 原因);失败不中断整轮清理。异地副本删不掉时,原因前面带目录。
    pub failed: Vec<(String, String)>,
    /// 清理后还剩几份。
    pub kept: usize,
    /// 是否只是预演。
    pub dry_run: bool,
}

/// 最近一次**自动校验**的结果(`backups/.verify.json`)。
///
/// 每份归档写完(以及复制到异地目录)之后都会自动跑一次 [`BackupService::verify`] 那套检查,
/// 结论落在这里 —— 设置页与 `kb backup list` 不必人手点「校验」就能看到“这份备份能不能用”。
/// 手工 `verify` 不写这个文件:它只回答“我手上这份归档怎么样”,不改变“最近一次自动校验”的记录。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LastCheck {
    /// 校验时间(unix 毫秒)。
    pub at: i64,
    /// 被校验的归档名。
    pub name: String,
    /// 有没有通过。
    pub ok: bool,
    /// 没通过的原因(通过时为 `None`)。
    #[serde(default)]
    pub error: Option<String>,
    /// 归档里的文件数(没通过时为 0)。
    #[serde(default)]
    pub files: usize,
    /// 解压后的总字节数。
    #[serde(default)]
    pub uncompressed_bytes: u64,
    /// 元数据库快照的字节数。
    #[serde(default)]
    pub meta_db_bytes: u64,
}

/// 最近一次**自动**备份的结果(设置页用它提示“上次定时备份失败了”)。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LastAutoRun {
    /// 尝试时间(unix 毫秒)。
    pub at: i64,
    /// 是否成功。
    pub ok: bool,
    /// 失败原因(成功时为 `None`)。
    #[serde(default)]
    pub error: Option<String>,
}

/// 一次自动备份的结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AutoBackup {
    /// 新建的归档。
    pub entry: BackupEntry,
    /// 顺带做的保留策略清理。
    pub pruned: PruneReport,
}

/// 一份备份。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BackupEntry {
    /// 文件名(带扩展名),也是 [`BackupService::delete`] 的入参。
    pub name: String,
    /// 归档字节数。
    pub size_bytes: u64,
    /// 生成时间(unix 毫秒)。列表里取自文件修改时间,可能与 `create` 返回的值差几毫秒。
    pub created_at: i64,
    /// 这次备份跳过了多少文件(名字非法 / 单个文件超过 8 GiB);列表里读不到,只有 `create` 有值。
    #[serde(default)]
    pub skipped: u64,
}

/// 设置页「备份」分区的状态。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BackupStatus {
    /// `KB_HOME`。
    pub home: String,
    /// 归档目录。
    pub dir: String,
    /// 已有归档(按时间倒序)。
    pub entries: Vec<BackupEntry>,
    /// 最近一次备份时间(没有就是 `None`)。
    pub last_backup_at: Option<i64>,
    /// 当前的定时备份与保留策略。
    pub policy: BackupPolicy,
    /// 下一次定时备份的时间(未启用就是 `None`)。
    pub next_backup_at: Option<i64>,
    /// 最近一次自动备份的结果(从没跑过就是 `None`)。
    pub last_auto: Option<LastAutoRun>,
    /// 正在进行的打包进度(没有在打包就是 `None`)。
    pub progress: Option<BackupProgress>,
    /// 还没被后续成功备份“冲掉”的最近一次失败(没有就是 `None`)。
    pub alert: Option<BackupFailure>,
    /// 最近的失败记录(新的在前,最多 [`MAX_FAILURES`] 条)。
    pub failures: Vec<BackupFailure>,
    /// 异地 / 外部存储目录的状态(没配置就是空数组)。
    pub mirrors: Vec<MirrorStatus>,
    /// 最近一次**自动校验**的结果(还没备份过就是 `None`)。
    pub last_check: Option<LastCheck>,
    /// 各部分占用。
    pub usage: DataUsage,
    /// 备份范围与恢复方式的说明(前端直接展示,不另写文案)。
    pub notes: Vec<String>,
}

/// 备份的**轻量**状态(外壳横幅与打包中的轮询用它)。
///
/// 与 [`BackupStatus`] 的区别:不统计各部分磁盘占用(那要递归走 `lance/` 与 `sources/`,
/// 每次导航都调会很慢),只读进度 / 失败记录两个小文件加一次归档目录列表。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BackupState {
    /// 正在进行的打包进度。
    pub running: Option<BackupProgress>,
    /// 未解决的最近一次失败。
    pub alert: Option<BackupFailure>,
    /// 最近的失败记录。
    pub failures: Vec<BackupFailure>,
    /// 最近一份归档的时间(= 最近一次成功备份)。
    pub last_success_at: Option<i64>,
}

/// 一份归档的校验结果(`verify` 的返回)。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ArchiveCheck {
    /// 归档名。
    pub name: String,
    /// 归档本身的字节数(压缩后)。
    pub size_bytes: u64,
    /// `manifest.json` 里记录的生成时间(unix 毫秒)。
    pub created_at: i64,
    /// 生成它的 kb 版本。
    pub version: String,
    /// 是否含原件。
    pub include_sources: bool,
    /// 实际写进归档的文件数(不含 `manifest.json`)。
    pub files: usize,
    /// 解压后的总字节数。
    pub uncompressed_bytes: u64,
    /// 元数据库快照的字节数。
    pub meta_db_bytes: u64,
    /// 归档里有没有 `config.toml`。
    pub config_present: bool,
    /// 备份时被跳过的文件说明。
    pub skipped: Vec<String>,
    /// 归档里的顶层条目(排序去重,给人看)。
    pub roots: Vec<String>,
    /// 归档里有没有账号库 `system.db`。
    pub system_db: bool,
    /// 归档里带了几个用户知识库的元数据库。
    pub spaces: usize,
}

/// 归档里的 `manifest.json`。
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct Manifest {
    /// 生成时间(unix 毫秒)。
    pub(crate) created_at: i64,
    /// 生成它的 kb 版本。
    pub(crate) version: String,
    /// 是否含原件。
    pub(crate) include_sources: bool,
    /// 进了归档的文件数。
    pub(crate) files: usize,
    /// 被跳过的文件(名字含 `..` 段 / 非 UTF-8 / 单个文件超过 8 GiB / 读不到),给人看的说明。
    #[serde(default)]
    pub(crate) skipped: Vec<String>,
    /// 归档里带了账号库 `system.db`(多用户部署)。老归档没有这项,按没有处理。
    #[serde(default)]
    pub(crate) system_db: bool,
    /// 归档里带了哪些用户知识库的 `spaces/<id>/meta.db`。
    #[serde(default)]
    pub(crate) spaces: Vec<String>,
}

/// SQLite 文件头(前 16 字节)。
pub(crate) const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
