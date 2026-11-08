//! 个人数据导出的任务管理(多用户设计说明)。
//!
//! 打包本身见 `kb_service::export`(规矩都在那里);这里管的是「别把服务器拖垮」:
//! - 每个人同一时间最多一个导出在跑;
//! - 每人每天最多 [`DAILY_LIMIT`] 次(按站点时区的自然日);
//! - 开始前看磁盘:剩余空间要装得下这份导出,并且不能吃掉 `quota.disk_reserve_gb` 的保留空间;
//! - 打包在阻塞线程里做,不占异步线程;进度用原子计数,页面轮询就能看到;
//! - 生成好的文件 [`KEEP_MS`] 后过期删除,进程重启丢了内存状态也没关系——`sweep` 按文件修改时间清理孤儿;
//! - 导出目录里的文件名只由我们生成(`<用户id>-<随机>.tar.gz`),读回时校验格式。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kb_core::config::ConfigStore;
use kb_core::model::{Insight, Millis, Page};
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{CollectionRepo, InsightRepo};
use kb_core::{KbError, Result};
use kb_web::export_api::{ExportStatus, PersonalExport};

use crate::spaces::SpaceRegistry;

/// 每人每天最多几次。
pub const DAILY_LIMIT: u32 = 3;
/// 导出文件保留多久(24 小时)。
pub const KEEP_MS: i64 = 24 * 3_600_000;

/// 笔记从哪里来。笔记存在知识库的 `meta.db` 里(不是磁盘文件),所以导出要问「知识库注册表」;
/// 抽成 trait 是为了测试时不用起一整套运行时。
#[async_trait]
pub trait NotesSource: Send + Sync {
    /// 某个知识库里的全部笔记(所有状态;哪些该导出由 `kb_service::export` 决定)。
    async fn insights(&self, space_id: &str) -> Result<Vec<Insight>>;
}

/// 每页读多少条。
const NOTES_PAGE: u32 = 500;

/// 从真实的知识库里读笔记。
pub struct SpaceNotes {
    spaces: Arc<SpaceRegistry>,
}

impl SpaceNotes {
    /// 包一层注册表。
    pub fn new(spaces: Arc<SpaceRegistry>) -> Arc<Self> {
        Arc::new(Self { spaces })
    }
}

#[async_trait]
impl NotesSource for SpaceNotes {
    async fn insights(&self, space_id: &str) -> Result<Vec<Insight>> {
        // 只会取到调用者**自己**的知识库:`space_id` 来自他的会话身份,不是请求参数
        let runtime = self.spaces.get(space_id).await?;
        let meta = runtime.meta.as_ref();
        let mut all = Vec::new();
        for collection in CollectionRepo::list(meta).await? {
            let mut offset = 0;
            loop {
                let batch = InsightRepo::list(
                    meta,
                    &collection.name,
                    None,
                    Page {
                        limit: NOTES_PAGE,
                        offset,
                    },
                )
                .await?;
                let got = batch.len() as u32;
                all.extend(batch);
                if got < NOTES_PAGE {
                    break;
                }
                offset += got;
            }
        }
        Ok(all)
    }
}

enum Job {
    Running {
        done: Arc<AtomicU64>,
        total: u64,
        files: u64,
        notes: u64,
    },
    Ready {
        path: PathBuf,
        size: u64,
        files: u64,
        notes: u64,
        skipped: Vec<String>,
        expires_at: Millis,
    },
    Failed(String),
}

#[derive(Default)]
struct State {
    jobs: HashMap<String, Job>,
    /// 每人今天开始过几次:`(站点时区日期, 次数)`。
    runs: HashMap<String, (String, u32)>,
}

/// 取当前时间(毫秒)。生产用真实时钟;测试换成固定时钟,这样「完成时刻」和传进来的 `now` 是同一个时间线。
pub type Clock = Arc<dyn Fn() -> Millis + Send + Sync>;

/// 导出任务管理器。
pub struct ExportManager {
    paths: KbPaths,
    exports_dir: PathBuf,
    config: Arc<ConfigStore>,
    state: Arc<Mutex<State>>,
    clock: Clock,
    notes: Arc<dyn NotesSource>,
}

impl ExportManager {
    /// 构造。`exports_dir` 不存在会在第一次导出时建。
    pub fn new(
        paths: KbPaths,
        exports_dir: PathBuf,
        config: Arc<ConfigStore>,
        notes: Arc<dyn NotesSource>,
    ) -> Arc<Self> {
        Self::with_clock(
            paths,
            exports_dir,
            config,
            notes,
            Arc::new(crate::daemon::now_millis),
        )
    }

    /// 同 [`Self::new`],时钟可替换(测试用)。
    pub fn with_clock(
        paths: KbPaths,
        exports_dir: PathBuf,
        config: Arc<ConfigStore>,
        notes: Arc<dyn NotesSource>,
        clock: Clock,
    ) -> Arc<Self> {
        Arc::new(Self {
            paths,
            exports_dir,
            config,
            state: Arc::new(Mutex::new(State::default())),
            clock,
            notes,
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn today_left(state: &State, user_id: &str, now: Millis) -> u32 {
        let today = kb_core::timezone::day_key(now);
        match state.runs.get(user_id) {
            Some((day, used)) if *day == today => DAILY_LIMIT.saturating_sub(*used),
            _ => DAILY_LIMIT,
        }
    }

    /// 清掉过期的导出:内存里的、以及导出目录里按修改时间判断的孤儿(进程重启后内存状态没了)。
    pub fn sweep(&self, now: Millis) {
        {
            let mut state = self.lock();
            let expired: Vec<String> = state
                .jobs
                .iter()
                .filter_map(|(user, job)| match job {
                    Job::Ready { expires_at, .. } if *expires_at <= now => Some(user.clone()),
                    _ => None,
                })
                .collect();
            for user in expired {
                if let Some(Job::Ready { path, .. }) = state.jobs.remove(&user) {
                    let _ = std::fs::remove_file(path);
                }
            }
            let today = kb_core::timezone::day_key(now);
            state.runs.retain(|_, (day, _)| *day == today);
        }
        // 孤儿文件按**文件系统**的修改时间判断,所以和同样来自系统的真实时钟比;
        // 不能用传进来的 `now`(那是任务时间线,测试里会是假的,混用会把刚生成的文件当成过期的)
        sweep_orphans(&self.exports_dir, crate::daemon::now_millis());
    }

    fn export_name(user_id: &str) -> String {
        // 不可预测的 16 位十六进制:对一个随机令牌取哈希再截断(不为一个文件名多引一个依赖)
        let token = kb_core::token::sha256_hex(&kb_core::token::random_secret());
        format!("{user_id}-{}.tar.gz", &token[..16])
    }
}

/// 导出目录里超过保留期的文件(含没写完的 `.part`)一律删掉。
fn sweep_orphans(dir: &Path, now: Millis) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for item in read.flatten() {
        let Ok(meta) = item.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(now, |age| age.as_millis() as i64);
        if now - modified > KEEP_MS {
            let _ = std::fs::remove_file(item.path());
        }
    }
}

/// 导出文件名是否是我们生成的样子(读回、下载前校验,不信状态之外的任何字符串)。
pub fn is_export_name(name: &str) -> bool {
    let Some(stem) = name.strip_suffix(".tar.gz") else {
        return false;
    };
    let Some((user, token)) = stem.rsplit_once('-') else {
        return false;
    };
    user.starts_with("usr_")
        && user.len() <= 64
        && user
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        && token.len() == 16
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[async_trait]
impl PersonalExport for ExportManager {
    async fn start(
        &self,
        user_id: &str,
        space_id: Option<&str>,
        now: Millis,
    ) -> Result<ExportStatus> {
        let Some(space_id) = space_id else {
            return Err(KbError::NotFound(
                "你还没有知识库,没有可导出的数据".to_owned(),
            ));
        };
        // 要打包的就是这个用户自己知识库的 sources/(主知识库的 sources 也只是 KB_HOME/sources,不含配置与账号库)
        let sources = self.paths.for_space(space_id)?.sources_dir().to_path_buf();
        let mut plan = tokio::task::spawn_blocking({
            let sources = sources.clone();
            move || kb_service::export::plan_export(&sources)
        })
        .await
        .map_err(|err| KbError::Internal(format!("统计导出内容失败:{err}")))??;
        // 笔记:读不出来就整个导出失败(用户以为带走了全部数据,实际少了笔记,比失败更糟)
        let insights = self.notes.insights(space_id).await.map_err(|err| {
            tracing::warn!(space = space_id, error = %err, "读取笔记失败,导出中止");
            KbError::Unavailable("读取笔记失败,请稍后再试".to_owned())
        })?;
        let (notes, note_skipped) = kb_service::export::notes_to_entries(&insights);
        plan.add_notes(notes, note_skipped);

        // 磁盘:装得下,并且不吃掉保留空间(保留 0 = 不设保护)
        let reserve_gb = self.config.get().quota.disk_reserve_gb;
        if reserve_gb > 0 {
            let free_gb = kb_service::providers::disk_free_gb(self.paths.home());
            let need_gb = plan.total_bytes.div_ceil(1024 * 1024 * 1024);
            if free_gb < reserve_gb.saturating_add(need_gb) {
                return Err(KbError::Unavailable(
                    "服务器磁盘空间不足,暂时不能导出,请稍后再试或联系管理员".to_owned(),
                ));
            }
        }

        let (done, name) = {
            let mut state = self.lock();
            if matches!(state.jobs.get(user_id), Some(Job::Running { .. })) {
                return Err(KbError::Exists("已经有一个导出在进行中".to_owned()));
            }
            if Self::today_left(&state, user_id, now) == 0 {
                return Err(KbError::Forbidden(format!(
                    "今天已经导出 {DAILY_LIMIT} 次了,请明天再试"
                )));
            }
            let today = kb_core::timezone::day_key(now);
            let entry = state
                .runs
                .entry(user_id.to_owned())
                .or_insert((today.clone(), 0));
            if entry.0 != today {
                *entry = (today, 0);
            }
            entry.1 += 1;
            // 重新导出会替换上一份:先删旧文件
            if let Some(Job::Ready { path, .. }) = state.jobs.remove(user_id) {
                let _ = std::fs::remove_file(path);
            }
            let done = Arc::new(AtomicU64::new(0));
            state.jobs.insert(
                user_id.to_owned(),
                Job::Running {
                    done: done.clone(),
                    total: plan.total_bytes,
                    files: plan.files.len() as u64,
                    notes: plan.notes.len() as u64,
                },
            );
            (done, Self::export_name(user_id))
        };

        std::fs::create_dir_all(&self.exports_dir)
            .map_err(|err| KbError::Internal(format!("创建导出目录失败:{err}")))?;
        let out = self.exports_dir.join(&name);
        let (files, notes, skipped) = (
            plan.files.len() as u64,
            plan.notes.len() as u64,
            plan.skipped.clone(),
        );
        let user = user_id.to_owned();
        let state = self.state.clone();
        let (total, started, clock) = (plan.total_bytes, now, self.clock.clone());
        tokio::task::spawn_blocking(move || {
            let counter = done.clone();
            let result = kb_service::export::write_export(
                &plan,
                &sources,
                &out,
                &user,
                started,
                &mut |delta| {
                    counter.fetch_add(delta, Ordering::Relaxed);
                },
            );
            let mut state = state.lock().unwrap_or_else(|poison| poison.into_inner());
            let job = match result {
                Ok(size) => Job::Ready {
                    path: out,
                    size,
                    files,
                    notes,
                    skipped,
                    // 从**完成**时刻算保留期:大导出可能打包好几个小时,从开始算的话刚生成就快过期了
                    expires_at: clock() + KEEP_MS,
                },
                Err(err) => {
                    tracing::warn!(user = %user, error = %err, "个人数据导出失败");
                    Job::Failed("导出没有成功,请稍后再试".to_owned())
                }
            };
            state.jobs.insert(user, job);
        });
        Ok(ExportStatus::Running {
            bytes_done: 0,
            bytes_total: total,
            files,
            notes,
        })
    }

    async fn status(&self, user_id: &str, now: Millis) -> Result<ExportStatus> {
        self.sweep(now);
        let state = self.lock();
        Ok(match state.jobs.get(user_id) {
            Some(Job::Running {
                done,
                total,
                files,
                notes,
            }) => ExportStatus::Running {
                bytes_done: done.load(Ordering::Relaxed),
                bytes_total: *total,
                files: *files,
                notes: *notes,
            },
            Some(Job::Ready {
                size,
                files,
                notes,
                skipped,
                expires_at,
                ..
            }) => ExportStatus::Ready {
                size: *size,
                files: *files,
                notes: *notes,
                skipped: skipped.clone(),
                expires_at: *expires_at,
            },
            Some(Job::Failed(reason)) => ExportStatus::Failed {
                reason: reason.clone(),
            },
            None => ExportStatus::Idle {
                today_left: Self::today_left(&state, user_id, now),
            },
        })
    }

    async fn file(&self, user_id: &str, now: Millis) -> Result<Option<(PathBuf, String)>> {
        self.sweep(now);
        let state = self.lock();
        let Some(Job::Ready { path, .. }) = state.jobs.get(user_id) else {
            return Ok(None);
        };
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| is_export_name(name))
            // 只下载自己的:文件名里的用户 id 必须就是请求者
            .filter(|name| name.starts_with(&format!("{user_id}-")));
        Ok(name.map(|name| (path.clone(), name.to_owned())))
    }

    async fn discard(&self, user_id: &str) -> Result<()> {
        let mut state = self.lock();
        match state.jobs.get(user_id) {
            Some(Job::Running { .. }) => {
                return Err(KbError::Exists("导出正在进行,完成后才能删除".to_owned()));
            }
            Some(Job::Ready { .. }) => {
                if let Some(Job::Ready { path, .. }) = state.jobs.remove(user_id) {
                    let _ = std::fs::remove_file(path);
                }
            }
            Some(Job::Failed(_)) => {
                state.jobs.remove(user_id);
            }
            None => {}
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
