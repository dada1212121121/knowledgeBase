//! 打包进度:落盘一份(`.progress.json`)再推给观察者。
//!
//! 守护进程与能力调用各自 new 一个服务实例,内存状态互相看不见,所以进度必须落盘;
//! 界面轮询到的那份进度是「另一个进程写下的」,靠这里的节流与过期判定(60s)收敛。

use super::*;

/// 进度落盘与推送的最小间隔(秒级备份里也不会把目录写爆)。
pub(crate) const PROGRESS_INTERVAL: Duration = Duration::from_millis(400);

/// 进度文件多久没更新就当那次备份已经中断(进程被杀 / 断电)。
///
/// 打包线程每写一块(256 KB)就会推进一次,所以正常运行时远小于这个阈值;
/// 不设这个阈值的话,一次异常退出会让页面永远显示“正在打包…”。
pub(crate) const PROGRESS_STALE_MS: i64 = 60_000;

/// 打包进度(WS 的 `backup.progress` 与 `backup_state.running` 都是它)。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct BackupProgress {
    /// 当前阶段。
    pub stage: BackupStage,
    /// 开始时间(unix 毫秒)。
    pub started_at: i64,
    /// 最近一次更新时间(unix 毫秒;超过 [`PROGRESS_STALE_MS`] 未更新就当已中断)。
    pub updated_at: i64,
    /// 一共要写几个文件。
    pub files_total: u64,
    /// 已经写完几个文件。
    pub files_done: u64,
    /// 一共要写多少字节(不含 `manifest.json`)。
    pub bytes_total: u64,
    /// 已经写了多少字节。
    pub bytes_done: u64,
    /// 正在写的文件(归档内路径)。
    pub current: Option<String>,
    /// 失败原因(只有 `Failed` 时有)。
    #[serde(default)]
    pub error: Option<String>,
}

impl BackupProgress {
    /// 完成百分比(0..=100):优先按字节,字节未知时退回按文件数。
    ///
    /// 前端也有一份同样的计算(`web-ui/src/utils/backup.ts`),这里给 CLI 与日志用。
    pub fn percent(&self) -> u8 {
        let ratio = if self.bytes_total > 0 {
            self.bytes_done as f64 / self.bytes_total as f64
        } else if self.files_total > 0 {
            self.files_done as f64 / self.files_total as f64
        } else {
            0.0
        };
        (ratio.clamp(0.0, 1.0) * 100.0).round() as u8
    }
}

/// 打包进度的收集与节流:落盘到 `backups/.progress.json` + 通知观察者。
///
/// 放在阻塞线程里用(`&mut self`),所以不需要锁;跨进程可见性靠文件
/// (能力调用与守护进程各自 new 一个服务实例)。
pub(crate) struct ProgressSink {
    pub(crate) dir: PathBuf,
    pub(crate) observer: Option<Arc<dyn BackupObserver>>,
    /// 两次落盘 / 推送之间的最小间隔。
    pub(crate) interval: Duration,
    pub(crate) last_emit: Option<std::time::Instant>,
    pub(crate) progress: BackupProgress,
}

impl ProgressSink {
    /// 用默认节流间隔构造。
    pub(crate) fn new(dir: PathBuf, observer: Option<Arc<dyn BackupObserver>>) -> Self {
        Self::with_interval(dir, observer, PROGRESS_INTERVAL)
    }

    /// 指定节流间隔(测试里用 0,能拿到每一步)。
    pub(crate) fn with_interval(
        dir: PathBuf,
        observer: Option<Arc<dyn BackupObserver>>,
        interval: Duration,
    ) -> Self {
        let now = now_millis();
        Self {
            dir,
            observer,
            interval,
            last_emit: None,
            progress: BackupProgress {
                stage: BackupStage::Preparing,
                started_at: now,
                updated_at: now,
                files_total: 0,
                files_done: 0,
                bytes_total: 0,
                bytes_done: 0,
                current: None,
                error: None,
            },
        }
    }

    /// 换阶段(立即落盘 + 推送)。
    pub(crate) fn stage(&mut self, stage: BackupStage) {
        self.progress.stage = stage;
        self.emit(true);
    }

    /// 文件清单收集完:写上总数。
    pub(crate) fn totals(&mut self, files: u64, bytes: u64) {
        self.progress.files_total = files;
        self.progress.bytes_total = bytes;
        self.emit(true);
    }

    /// 换到「异地副本」阶段:计数从头开始(打包那几个文件的数字已经用不上了)。
    pub(crate) fn mirror_totals(&mut self, files: u64, bytes: u64) {
        self.progress.files_done = 0;
        self.progress.bytes_done = 0;
        self.totals(files, bytes);
    }

    /// 开始写一个文件。
    pub(crate) fn begin_file(&mut self, name: &str) {
        self.progress.current = Some(name.to_owned());
        // 第一个文件强制推一次:文件都很小时(配置 + 评测数据),按 400ms 节流的话
        // 页面上永远看不到“正在写哪个文件”
        let first = self.progress.files_done == 0;
        self.emit(first);
    }

    /// 又写进去 `delta` 字节。
    pub(crate) fn add_bytes(&mut self, delta: u64) {
        self.progress.bytes_done = self.progress.bytes_done.saturating_add(delta);
        self.emit(false);
    }

    /// 一个文件写完。
    pub(crate) fn end_file(&mut self) {
        self.progress.files_done = self.progress.files_done.saturating_add(1);
        self.emit(false);
    }

    /// 收尾:落一次最终状态,然后删掉进度文件(页面靠 `backup.done` / `backup.failed` 收尾)。
    pub(crate) fn finish(&mut self, stage: BackupStage, error: Option<String>) {
        self.progress.stage = stage;
        self.progress.error = error;
        self.progress.current = None;
        self.emit(true);
        let path = self.dir.join(PROGRESS_FILE);
        if let Err(err) = std::fs::remove_file(&path)
            && err.kind() != std::io::ErrorKind::NotFound
        {
            tracing::debug!(error = %err, path = %path.display(), "删备份进度文件失败");
        }
    }

    /// 落盘 + 推送;`force` 为假时按 [`ProgressSink::interval`] 节流。
    pub(crate) fn emit(&mut self, force: bool) {
        if !force
            && self
                .last_emit
                .is_some_and(|last| last.elapsed() < self.interval)
        {
            return;
        }
        self.last_emit = Some(std::time::Instant::now());
        self.progress.updated_at = now_millis();
        self.write();
        if let Some(observer) = &self.observer {
            observer.progress(&self.progress);
        }
    }

    /// 写进度文件(失败只记日志:进度写不进去不该让备份失败)。
    pub(crate) fn write(&self) {
        let path = self.dir.join(PROGRESS_FILE);
        match serde_json::to_vec(&self.progress) {
            Ok(bytes) => {
                if let Err(err) = std::fs::write(&path, bytes) {
                    tracing::debug!(error = %err, path = %path.display(), "写备份进度失败");
                }
            }
            Err(err) => tracing::debug!(error = %err, "序列化备份进度失败"),
        }
    }
}
