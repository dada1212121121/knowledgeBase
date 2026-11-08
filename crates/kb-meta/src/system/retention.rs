//! 账号库的历史表保留:`system_audit` 与 `metric_samples`。
//!
//! 这两张表在 `system.db`(账号库)里,和知识库的 `jobs` / `audit` / `events` 分开,
//! 所以清理要两边各跑一次;判定口径与 `SqliteMetaStore::prune_history` 一致:
//! 表名走白名单、按时间列删、分批进行。

use kb_core::Result;
use kb_core::model::identity::SystemRetentionTable;
use rusqlite::params;

use super::SystemStore;
use crate::sql::map_sqlite_error;

/// 一批删多少行(控制单次写锁时长)。
const PRUNE_BATCH: u32 = 500;

/// 表名与时间列(白名单映射,不把调用方输入拼进 SQL)。
///
/// 这张映射原先挂在 `SystemRetentionTable` 上,类型搬到 `kb-core` 之后留在适配器这侧:
/// 列名是存储细节,端口那边只描述「哪张历史表」。
fn table_and_column(table: SystemRetentionTable) -> (&'static str, &'static str) {
    match table {
        SystemRetentionTable::SystemAudit => ("system_audit", "at"),
        SystemRetentionTable::MetricSamples => ("metric_samples", "at"),
    }
}

impl SystemStore {
    /// 删掉 `before` 之前的行,返回删了几行(或 `dry_run` 时会删几行)。
    pub async fn prune_history(
        &self,
        table: SystemRetentionTable,
        before: i64,
        dry_run: bool,
    ) -> Result<u64> {
        let (name, column) = table_and_column(table);
        self.write(move |conn| {
            if dry_run {
                let count: i64 = conn
                    .query_row(
                        &format!("SELECT COUNT(*) FROM {name} WHERE {column} < ?1"),
                        params![before],
                        |row| row.get(0),
                    )
                    .map_err(map_sqlite_error)?;
                return Ok(count as u64);
            }
            let mut removed = 0u64;
            loop {
                let deleted = conn
                    .execute(
                        &format!(
                            "DELETE FROM {name} WHERE rowid IN \
                             (SELECT rowid FROM {name} WHERE {column} < ?1 LIMIT {PRUNE_BATCH})"
                        ),
                        params![before],
                    )
                    .map_err(map_sqlite_error)?;
                removed += deleted as u64;
                if (deleted as u32) < PRUNE_BATCH {
                    break;
                }
            }
            Ok(removed)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::SystemRetentionTable;

    /// 只认白名单里的两张表。
    #[test]
    fn system_table_names_are_whitelisted() {
        assert_eq!(
            SystemRetentionTable::parse("system_audit").expect("system_audit"),
            SystemRetentionTable::SystemAudit
        );
        assert_eq!(
            SystemRetentionTable::parse("metric_samples").expect("metric_samples"),
            SystemRetentionTable::MetricSamples
        );
        for bad in ["users", "system_audit; DROP TABLE users", ""] {
            let error = SystemRetentionTable::parse(bad).expect_err("应拒绝");
            assert!(error.to_string().contains("不支持清理"), "{error}");
        }
    }
}
