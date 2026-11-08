//! 存储用量:量一个知识库占了多少盘,并在上传 / 新建时按配额拦住(多用户设计说明)。
//!
//! - `measure_space`:数磁盘。原件、分片、向量索引、元数据库四项分开列;符号链接不跟随、不计入。
//! - `StorageMeter`:带缓存的用量 + 「预留」。数一遍磁盘不便宜(向量目录文件多),所以结果缓存一小段时间;
//!   但只靠缓存挡不住并发——20 个人同时在 99 GB 上各传 1 GB,每个人看到的都是「还有 1 GB」。
//!   所以通过检查的那一刻就把这次要写的字节**预留**下来,后面的检查把预留也算上,并发上传加起来不会超出配额。
//!   重新统计一次磁盘后,**统计开始之前**的预留清掉(那些字节这时已经落盘,被统计进去了);统计期间新来的预留保留。
//!   同一个知识库同一时刻只允许一次统计在跑(其余的等它,醒来后直接用它的结果),否则一群并发请求会各自重数、
//!   各自清预留,等于把别人刚占的位置擦掉。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kb_core::account::SpaceUsage;
use kb_core::paths::KbPaths;
use kb_core::{KbError, Result};

use crate::upload::dir_usage;

/// 缓存多久重新数一遍磁盘。
pub const DEFAULT_TTL: Duration = Duration::from_secs(60);

fn file_size(path: &Path) -> u64 {
    std::fs::symlink_metadata(path)
        .ok()
        .filter(|meta| meta.is_file())
        .map_or(0, |meta| meta.len())
}

/// 数一个知识库现在占多少盘(阻塞,放到阻塞线程里调用)。
pub fn measure_space(paths: &KbPaths) -> SpaceUsage {
    let meta_db = paths.meta_db();
    // SQLite 的 WAL / SHM 文件也是它的一部分,写多了 WAL 可以很大
    let side = |suffix: &str| {
        let mut name = meta_db.as_os_str().to_owned();
        name.push(suffix);
        file_size(Path::new(&name))
    };
    SpaceUsage {
        sources_bytes: dir_usage(paths.sources_dir()),
        uploads_bytes: dir_usage(paths.uploads_dir()),
        vectors_bytes: dir_usage(paths.lance_dir()),
        meta_bytes: file_size(meta_db) + side("-wal") + side("-shm"),
        workspace_bytes: dir_usage(paths.agent_workspace()),
    }
}

type Measurer = Arc<dyn Fn(&KbPaths) -> SpaceUsage + Send + Sync>;

#[derive(Default)]
struct Entry {
    usage: SpaceUsage,
    measured: Option<Instant>,
    /// 通过检查但还没落盘的字节。
    reserved: u64,
}

/// 带缓存与预留的用量表(进程内一份,按知识库 id 分条)。
pub struct StorageMeter {
    ttl: Duration,
    /// 怎么数磁盘。生产用 [`measure_space`];测试换成会计数、会等待的假实现,才能验证并发行为。
    measurer: Measurer,
    entries: Mutex<HashMap<String, Entry>>,
    /// 每个知识库一把:同一时刻只有一次统计在跑。
    measuring: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl StorageMeter {
    /// 构造。`ttl` 是缓存有效期。
    pub fn new(ttl: Duration) -> Arc<Self> {
        Self::with_measurer(ttl, Arc::new(measure_space))
    }

    /// 同 [`Self::new`],自定义怎么数磁盘(测试用)。
    pub fn with_measurer(ttl: Duration, measurer: Measurer) -> Arc<Self> {
        Arc::new(Self {
            ttl,
            measurer,
            entries: Mutex::new(HashMap::new()),
            measuring: Mutex::new(HashMap::new()),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    fn fresh(&self, space_id: &str) -> Option<SpaceUsage> {
        let entries = self.lock();
        let entry = entries.get(space_id)?;
        (entry.measured?.elapsed() < self.ttl).then_some(entry.usage)
    }

    /// 放进缓存,并清掉统计**开始前**就已存在的预留(`reserved_before`);之后新来的预留保留。
    fn store_after(&self, space_id: &str, usage: SpaceUsage, reserved_before: u64) {
        let mut entries = self.lock();
        let entry = entries.entry(space_id.to_owned()).or_default();
        entry.usage = usage;
        entry.measured = Some(Instant::now());
        entry.reserved = entry.reserved.saturating_sub(reserved_before);
    }

    fn reserved_now(&self, space_id: &str) -> u64 {
        self.lock().get(space_id).map_or(0, |entry| entry.reserved)
    }

    /// 现在的用量:缓存还新就直接给,否则数一遍磁盘。
    pub async fn usage(&self, space_id: &str, paths: &KbPaths) -> SpaceUsage {
        if let Some(usage) = self.fresh(space_id) {
            return usage;
        }
        let gate = {
            let mut measuring = self
                .measuring
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            measuring.entry(space_id.to_owned()).or_default().clone()
        };
        let _turn = gate.lock().await;
        // 排队期间别人可能已经数完了
        if let Some(usage) = self.fresh(space_id) {
            return usage;
        }
        let reserved_before = self.reserved_now(space_id);
        let paths = paths.clone();
        let measurer = self.measurer.clone();
        let measured = tokio::task::spawn_blocking(move || measurer(&paths))
            .await
            .unwrap_or_default();
        self.store_after(space_id, measured, reserved_before);
        measured
    }

    /// 让缓存失效(删了东西以后调,释放出来的空间马上能被看到)。
    pub fn invalidate(&self, space_id: &str) {
        if let Some(entry) = self.lock().get_mut(space_id) {
            entry.measured = None;
        }
    }

    /// 检查「再写 `extra` 字节」会不会超出 `limit_bytes`,没超就把它预留下来。`limit_bytes == 0` 表示不限。
    pub async fn reserve(
        &self,
        space_id: &str,
        paths: &KbPaths,
        extra: u64,
        limit_bytes: u64,
    ) -> Result<()> {
        if limit_bytes == 0 {
            return Ok(());
        }
        // 先保证缓存是新的;检查与预留在同一把锁里做,并发的几个请求不会同时看到「还有空位」
        self.usage(space_id, paths).await;
        let mut entries = self.lock();
        let entry = entries.entry(space_id.to_owned()).or_default();
        let used = entry.usage.total().saturating_add(entry.reserved);
        if used.saturating_add(extra) > limit_bytes {
            return Err(KbError::InvalidInput(format!(
                "存储空间不足:已用 {} MB(含向量索引等看不见的部分),上限 {} GB。可以删掉一些内容后再试,或联系管理员调整配额",
                used / (1024 * 1024),
                limit_bytes / (1024 * 1024 * 1024)
            )));
        }
        entry.reserved = entry.reserved.saturating_add(extra);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
