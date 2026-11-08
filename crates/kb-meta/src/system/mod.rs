//! `system.db`:账号、角色、会话、令牌、系统审计(多用户设计说明)。
//!
//! 和每个知识库的 `meta.db`(`SqliteMetaStore`)分开,但并发方式一样:一个写连接 + 一个小的只读连接池,
//! 所有调用包在 `spawn_blocking` 里,持锁期间不 `.await`。这里是**热路径**(每个请求都要查会话),
//! 所以读走连接池,会话续期只在过了续期间隔后才写。

mod admin_keys;
mod deletion;
mod grants;
#[cfg(test)]
mod grants_tests;
mod links;
#[cfg(test)]
mod links_tests;
mod llm_usage;
mod metrics;
mod migrate;
mod notify;
#[cfg(test)]
mod notify_tests;
mod ports;
mod prefs;
mod registration;
mod retention;
mod roles;
mod sessions;
mod social;
#[cfg(test)]
mod social_tests;
mod storage;
mod totp;
mod users;

// DTO 搬到了 `kb-core`(`ports::system` 的签名要用),这里重新导出,
// `kb_meta::system::LinkRecord` 这类旧路径与各子模块的 `use super::*` 都不受影响。
pub use kb_core::model::identity::*;

pub use grants::{MAX_BATCH_KEYS, MAX_BATCH_PEOPLE};
pub use links::{MAX_BUNDLE_ITEMS, MAX_NICKNAME};
pub use llm_usage::SystemLlmLedger;
pub use metrics::MetricRow;
pub use notify::{MAX_DATA_BYTES, MAX_PAGE};
pub use prefs::MAX_PREFS_BYTES;
pub use registration::MAX_CODE_ATTEMPTS;

use std::path::Path;
use std::sync::{Arc, Mutex};

use kb_core::account::SystemAuditEntry;
use kb_core::model::Millis;
use kb_core::{KbError, Result};
use rusqlite::{Connection, OptionalExtension, params};

use crate::sql::map_sqlite_error;
use crate::{DEFAULT_READ_POOL, ReadPool, configure};

/// `system.db` 的存储。
#[derive(Clone)]
pub struct SystemStore {
    writer: Arc<Mutex<Connection>>,
    readers: ReadPool,
}

impl std::fmt::Debug for SystemStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SystemStore").finish_non_exhaustive()
    }
}

impl SystemStore {
    /// 打开(或创建)`system.db`,执行迁移并写入内置角色(幂等)。
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent).map_err(|err| {
                KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
            })?;
        }
        let mut writer = Connection::open(path).map_err(map_sqlite_error)?;
        configure(&writer)?;
        migrate::run(&mut writer)?;
        roles::seed_builtin(&mut writer)?;
        // 账号库含密码哈希:只有当前用户可读写
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        let readers = ReadPool::new(path.to_path_buf(), DEFAULT_READ_POOL)?;
        Ok(Self {
            writer: Arc::new(Mutex::new(writer)),
            readers,
        })
    }

    /// 当前 schema 版本。
    pub async fn schema_version(&self) -> Result<i64> {
        self.read(migrate::current_version).await
    }

    pub(crate) async fn write<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let conn = Arc::clone(&self.writer);
        tokio::task::spawn_blocking(move || {
            let mut guard = conn
                .lock()
                .map_err(|_| KbError::Internal("system.db 写连接锁已中毒".to_owned()))?;
            f(&mut guard)
        })
        .await
        .map_err(|err| KbError::Internal(format!("写线程异常: {err}")))?
    }

    pub(crate) async fn read<T, F>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        self.readers.with(f).await
    }

    // ---------------------------------------------------------------- settings

    /// 读一个系统设置。
    pub async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let key = key.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 写一个系统设置。
    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let key = key.to_owned();
        let value = value.to_owned();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    // ------------------------------------------------------------------- audit

    /// 记一条系统审计。审计失败不应该拖垮主流程,调用方通常只 `warn` 一下。
    pub async fn record_audit(
        &self,
        user_id: Option<&str>,
        action: &str,
        target: Option<&str>,
        detail: &serde_json::Value,
        ip: Option<&str>,
    ) -> Result<()> {
        let user_id = user_id.map(str::to_owned);
        let action = action.to_owned();
        let target = target.map(str::to_owned);
        let detail = detail.to_string();
        let ip = ip.map(str::to_owned);
        let at = now_millis();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO system_audit (at, user_id, action, target, detail_json, ip) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![at, user_id, action, target, detail, ip],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 查系统审计,新的在前。`user_id` 给定时只看这个用户的。
    pub async fn list_audit(
        &self,
        user_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<SystemAuditEntry>> {
        let user_id = user_id.map(str::to_owned);
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, at, user_id, action, target, detail_json, ip FROM system_audit \
                     WHERE (?1 IS NULL OR user_id = ?1) ORDER BY id DESC LIMIT ?2 OFFSET ?3",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![user_id, limit.min(500), offset], |row| {
                    Ok(SystemAuditEntry {
                        id: row.get(0)?,
                        at: row.get(1)?,
                        user_id: row.get(2)?,
                        action: row.get(3)?,
                        target: row.get(4)?,
                        detail_json: row.get(5)?,
                        ip: row.get(6)?,
                    })
                })
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)
        })
        .await
    }
}

/// 当前时间(Unix 毫秒)。
pub(crate) fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 新 id:`<prefix><uuid v7 无连字符>`。
pub(crate) fn new_id(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::now_v7().simple())
}

#[cfg(test)]
mod tests;
