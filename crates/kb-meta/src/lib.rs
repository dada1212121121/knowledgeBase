//! MetaStore 的 SQLite 实现（设计规范）。
//!
//! 并发方式:**一个写连接**(`Mutex<Connection>`)+ **一个只读连接池**
//! (`ReadPool`,默认 4、上限 8）。所有调用都包在 `tokio::task::spawn_blocking`
//! 里执行;**持锁期间不 `.await`**。
//!
//! 为什么读连接要成池:守护进程里 Web / MCP / 调度器会同时读元数据,单读连接让它们
//! 在 `Mutex` 上排队,P95 被串行化拖长;写连接保持 1 个,配合 WAL 与
//! `busy_timeout`(见 [`configure`]),读写可以并行。
//!
//! 所有 SQL 都用参数绑定,不拼接外部输入。

mod migrate;
mod repo;
mod sql;
pub mod system;

pub use migrate::{MIGRATIONS, current_version, run as run_migrations};
pub use repo::CollabRow;
pub use repo::EditProposal;
pub use repo::RetentionTable;
pub use system::SystemRetentionTable;
pub use system::SystemStore;

use std::path::Path;
use std::sync::{Arc, Mutex};

use kb_core::{KbError, Result};
use rusqlite::Connection;

/// 默认读连接池大小(`[meta] read_pool` 的默认值)。
pub const DEFAULT_READ_POOL: usize = 4;

/// 基于 SQLite 的元数据存储,实现 `kb-core` 定义的全部 Repo trait。
#[derive(Clone)]
pub struct SqliteMetaStore {
    writer: Arc<Mutex<Connection>>,
    readers: ReadPool,
}

/// 自管的只读连接池。
///
/// `Semaphore` 限制同时在用的连接数(上限 = 池大小),`idle` 里是空闲连接。
/// 归还时如果池里已有上限个连接就直接丢弃(降峰后不长期占着句柄)。
#[derive(Clone)]
struct ReadPool {
    path: std::path::PathBuf,
    idle: Arc<Mutex<Vec<Connection>>>,
    permits: Arc<tokio::sync::Semaphore>,
    size: usize,
}

impl ReadPool {
    fn new(path: std::path::PathBuf, size: usize) -> Result<Self> {
        let size = size.clamp(1, 8);
        // 先建一个连接:尽早暴露“路径不可用 / 迁移未跑”这类问题,同时保证第一次读不用现开
        let first = open_readonly(&path)?;
        Ok(Self {
            path,
            idle: Arc::new(Mutex::new(vec![first])),
            permits: Arc::new(tokio::sync::Semaphore::new(size)),
            size,
        })
    }

    /// 池大小。
    fn size(&self) -> usize {
        self.size
    }

    /// 借一个连接执行一段阻塞代码,结束后归还。
    async fn with<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let permit = Arc::clone(&self.permits)
            .acquire_owned()
            .await
            .map_err(|_| KbError::Internal("读连接池已关闭".to_owned()))?;
        let idle = Arc::clone(&self.idle);
        let path = self.path.clone();
        let size = self.size;
        let result = tokio::task::spawn_blocking(move || {
            let cached = idle
                .lock()
                .map_err(|_| KbError::Internal("读连接池锁已中毒".to_owned()))?
                .pop();
            let conn = match cached {
                Some(conn) => conn,
                None => open_readonly(&path)?,
            };
            let outcome = f(&conn);
            // 归还:池里已满就直接丢掉(降峰后不长期占句柄)
            if let Ok(mut idle) = idle.lock()
                && idle.len() < size
            {
                idle.push(conn);
            }
            outcome
        })
        .await
        .map_err(|err| KbError::Internal(format!("读线程异常: {err}")))?;
        drop(permit);
        result
    }
}

impl std::fmt::Debug for SqliteMetaStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteMetaStore").finish_non_exhaustive()
    }
}

impl SqliteMetaStore {
    /// 打开(或创建)数据库,设置 PRAGMA 并执行迁移;读连接池取默认大小。
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_pool(path, DEFAULT_READ_POOL)
    }

    /// 同 [`Self::open`],但指定只读连接池大小(设计规范,默认 4、上限 8)。
    pub fn open_with_pool(path: impl AsRef<Path>, read_pool: usize) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|err| {
                KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
            })?;
        }
        let mut writer = Connection::open(path).map_err(sql::map_sqlite_error)?;
        configure(&writer)?;
        migrate::run(&mut writer)?;
        let readers = ReadPool::new(path.to_path_buf(), read_pool)?;
        Ok(Self {
            writer: Arc::new(Mutex::new(writer)),
            readers,
        })
    }

    /// 读连接池大小(测试与诊断用)。
    pub fn read_pool_size(&self) -> usize {
        self.readers.size()
    }

    /// 当前 schema 版本(`PRAGMA user_version`)。
    pub async fn schema_version(&self) -> Result<i64> {
        self.read(migrate::current_version).await
    }

    /// 把整份数据库写成一份独立的 SQLite 文件(备份用)。
    ///
    /// 用 `VACUUM INTO`,由 SQLite 自己给出**一致性快照**:守护进程正在写的时候也能拿到
    /// 一份完整、可直接打开的文件,不需要先停服、也不会抄到 WAL 里没合并的半页。
    /// 目标文件已存在时先删掉再写(`VACUUM INTO` 本身不接受覆盖)。
    pub async fn snapshot_to(&self, dest: impl AsRef<Path>) -> Result<()> {
        let dest = dest.as_ref().to_path_buf();
        if dest.exists() {
            std::fs::remove_file(&dest).map_err(|err| {
                KbError::Internal(format!("删除旧的快照文件 {} 失败: {err}", dest.display()))
            })?;
        }
        if let Some(parent) = dest.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|err| {
                KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
            })?;
        }
        let target = dest.to_string_lossy().to_string();
        self.write(move |conn| {
            // 文件名走参数绑定(`VACUUM INTO` 接受表达式),不拼 SQL 字面量
            conn.execute("VACUUM INTO ?1", rusqlite::params![target])
                .map_err(sql::map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 在写连接上执行一段阻塞代码(专用线程 + 写锁)。
    pub(crate) async fn write<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let conn = Arc::clone(&self.writer);
        tokio::task::spawn_blocking(move || {
            let mut guard = conn
                .lock()
                .map_err(|_| KbError::Internal("写连接锁已中毒".to_owned()))?;
            f(&mut guard)
        })
        .await
        .map_err(|err| KbError::Internal(format!("写线程异常: {err}")))?
    }

    /// 从读连接池借一个连接执行一段阻塞代码。
    pub(crate) async fn read<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        self.readers.with(f).await
    }
}

/// 打开一个只读用途的连接(池里每条连接都是独立句柄,PRAGMA 要各自设)。
fn open_readonly(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path).map_err(sql::map_sqlite_error)?;
    configure(&conn)?;
    Ok(conn)
}

/// 连接级 PRAGMA（设计规范）。
fn configure(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode=WAL;\n\
         PRAGMA synchronous=NORMAL;\n\
         PRAGMA foreign_keys=ON;\n\
         PRAGMA busy_timeout=5000;",
    )
    .map_err(sql::map_sqlite_error)
}

/// 给**另一个** SQLite 文件(账号库、别的知识库的 `meta.db`)做一致性快照,不需要持有它的存储对象。
///
/// 守护进程正在用它也没关系:另开一个连接做 `VACUUM INTO`,由 SQLite 保证拿到的是某一时刻完整的库
/// (WAL 里没合并的页也算进去),源库不会被改动。文件不存在直接报错,不会顺手建一个空库。
pub fn snapshot_file(src: &Path, dest: &Path) -> Result<()> {
    use rusqlite::OpenFlags;
    if !src.is_file() {
        return Err(KbError::NotFound(format!(
            "数据库文件 {} 不存在",
            src.display()
        )));
    }
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|err| {
            KbError::Internal(format!("删除旧的快照文件 {} 失败: {err}", dest.display()))
        })?;
    }
    if let Some(parent) = dest.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent).map_err(|err| {
            KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
        })?;
    }
    // 读写方式打开但不会写它:WAL 模式下只读连接需要能创建 -shm,读写打开省去这个麻烦
    let conn = Connection::open_with_flags(
        src,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(sql::map_sqlite_error)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(sql::map_sqlite_error)?;
    conn.execute(
        "VACUUM INTO ?1",
        rusqlite::params![dest.to_string_lossy().to_string()],
    )
    .map_err(sql::map_sqlite_error)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn temp_store(read_pool: usize) -> (tempfile::TempDir, SqliteMetaStore) {
        let dir = tempfile::tempdir().expect("临时目录");
        let store = SqliteMetaStore::open_with_pool(dir.path().join("meta.db"), read_pool)
            .expect("打开数据库");
        (dir, store)
    }

    #[test]
    fn read_pool_size_is_clamped_to_1_through_8() {
        let (_dir, store) = temp_store(0);
        assert_eq!(store.read_pool_size(), 1, "0 应被夹到 1");
        let (_dir, store) = temp_store(99);
        assert_eq!(store.read_pool_size(), 8, "超过上限应夹到 8");
        let (_dir, store) = temp_store(DEFAULT_READ_POOL);
        assert_eq!(store.read_pool_size(), DEFAULT_READ_POOL);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn read_pool_runs_queries_in_parallel() {
        // 每次“查询”睡 40ms:池里有 4 条连接时,8 个并发读应约 80ms 完成;
        // 单连接(改前的实现)要 320ms 左右。断言留足余量,只区分“并行 / 串行”。
        const SLEEP: Duration = Duration::from_millis(40);
        const READS: usize = 8;

        let (_dir, pool4) = temp_store(4);
        let started = Instant::now();
        let mut tasks = Vec::new();
        for _ in 0..READS {
            let store = pool4.clone();
            tasks.push(tokio::spawn(async move {
                store
                    .read(|_conn| {
                        std::thread::sleep(SLEEP);
                        Ok(())
                    })
                    .await
            }));
        }
        for task in tasks {
            task.await.expect("任务未 panic").expect("读成功");
        }
        let parallel = started.elapsed();

        let (_dir, pool1) = temp_store(1);
        let started = Instant::now();
        let mut tasks = Vec::new();
        for _ in 0..READS {
            let store = pool1.clone();
            tasks.push(tokio::spawn(async move {
                store
                    .read(|_conn| {
                        std::thread::sleep(SLEEP);
                        Ok(())
                    })
                    .await
            }));
        }
        for task in tasks {
            task.await.expect("任务未 panic").expect("读成功");
        }
        let serial = started.elapsed();

        assert!(
            parallel * 2 < serial,
            "4 条连接的 8 个并发读({parallel:?})应明显快于单连接({serial:?})"
        );
    }

    #[tokio::test]
    async fn a_failing_read_still_returns_the_connection() {
        let (_dir, store) = temp_store(1);
        let error = store
            .read(|_conn| Err::<(), _>(KbError::Internal("故意失败".to_owned())))
            .await
            .expect_err("应把错误传出去");
        assert!(matches!(error, KbError::Internal(_)));
        // 池里的连接没有被吞掉:还能继续读
        store
            .read(|_conn| Ok(()))
            .await
            .expect("失败之后仍应能借到连接");
    }

    #[test]
    fn snapshot_file_sees_unmerged_wal_pages_while_the_owner_still_holds_the_database() {
        let dir = tempfile::tempdir().expect("临时目录");
        let src = dir.path().join("other.db");
        // 模拟守护进程:WAL 模式、连接一直开着、最近的写入还在 WAL 里没合并进主文件
        let owner = Connection::open(&src).expect("打开");
        owner
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
                 CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('在 WAL 里的一行');",
            )
            .expect("建表写入");
        let dest = dir.path().join("sub").join("snap.db");
        crate::snapshot_file(&src, &dest).expect("快照");
        let snap = Connection::open(&dest).expect("打开快照");
        let got: String = snap
            .query_row("SELECT v FROM t", [], |row| row.get(0))
            .expect("快照里要有 WAL 里的那一行");
        assert_eq!(got, "在 WAL 里的一行");
        // 再拍一次(目标已存在)也行,并且拍的是新状态
        owner
            .execute("INSERT INTO t VALUES ('第二行')", [])
            .expect("再写");
        crate::snapshot_file(&src, &dest).expect("覆盖快照");
        let count: i64 = Connection::open(&dest)
            .unwrap()
            .query_row("SELECT count(*) FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn snapshot_file_refuses_a_missing_source_instead_of_creating_an_empty_database() {
        let dir = tempfile::tempdir().expect("临时目录");
        let src = dir.path().join("nope.db");
        let err = crate::snapshot_file(&src, &dir.path().join("snap.db")).expect_err("应报错");
        assert!(matches!(err, KbError::NotFound(_)), "{err}");
        assert!(!src.exists(), "不能顺手把源库建出来");
        assert!(!dir.path().join("snap.db").exists());
    }
}
