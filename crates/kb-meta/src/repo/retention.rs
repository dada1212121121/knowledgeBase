//! 历史表保留:按时间批量清 `jobs` / `audit` / `events`。
//!
//! 为什么单独一个模块:`prune_failed` 只管失败任务,而这几张表是**只增不减**的
//! (生产上分别到了万级),清理要一次覆盖三张、还要能和夜间调度复用。
//!
//! 三条纪律:
//! 1. 表名与时间列来自**白名单**(不拼调用方给的字符串),SQL 里的表名不能参数化;
//! 2. 分批删(`DELETE ... WHERE rowid IN (SELECT ... LIMIT n)`),一次大 DELETE 会把写锁
//!    抱太久,索引任务和 Web 请求都得等;
//! 3. `jobs` 只清已经结束的(`done` / `failed` / `canceled`):排队、运行、暂停的任务是在办的事。

use rusqlite::params;

use kb_core::{KbError, Result};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

/// 一批删多少行(控制单次写锁时长)。
const PRUNE_BATCH: u32 = 500;

/// 一批次清理的表(白名单)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetentionTable {
    /// 任务队列。
    Jobs,
    /// 能力调用审计。
    Audit,
    /// 进化事件。
    Events,
}

impl RetentionTable {
    /// 配置里 / 输出里用的名字。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jobs => "jobs",
            Self::Audit => "audit",
            Self::Events => "events",
        }
    }

    /// 从名字解析(不认识就拒绝,绝不把用户输入直接拼进 SQL)。
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "jobs" => Ok(Self::Jobs),
            "audit" => Ok(Self::Audit),
            "events" => Ok(Self::Events),
            other => Err(KbError::InvalidInput(format!(
                "不支持清理的历史表 {other:?}(只能 jobs / audit / events)"
            ))),
        }
    }

    /// 判定「这一行多老了」用的时间列,以及额外的过滤条件。
    ///
    /// `jobs` 用 `COALESCE(finished_at, created_at)`:被强杀的任务可能没有 `finished_at`,
    /// 这时按创建时间算年龄(与 `prune_failed` 同口径)。
    fn where_clause(self) -> &'static str {
        match self {
            Self::Jobs => {
                "state IN ('done', 'failed', 'canceled') AND COALESCE(finished_at, created_at) < ?1"
            }
            Self::Audit => "at < ?1",
            Self::Events => "received_at < ?1",
        }
    }
}

impl SqliteMetaStore {
    /// 删掉 `before` 之前的行,返回删了几行(或 `dry_run` 时会删几行)。
    ///
    /// 分批进行:每批 [`PRUNE_BATCH`] 行,删到某一批不足一批就收工。
    pub async fn prune_history(
        &self,
        table: RetentionTable,
        before: i64,
        dry_run: bool,
    ) -> Result<u64> {
        let name = table.as_str();
        let filter = table.where_clause();
        self.write(move |conn| {
            if dry_run {
                let count: i64 = conn
                    .query_row(
                        &format!("SELECT COUNT(*) FROM {name} WHERE {filter}"),
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
                             (SELECT rowid FROM {name} WHERE {filter} LIMIT {PRUNE_BATCH})"
                        ),
                        params![before],
                    )
                    .map_err(map_sqlite_error)?;
                removed += deleted as u64;
                // 这一批没删满,说明剩下的都还不到年纪
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
    use super::RetentionTable;

    /// 表名解析只认白名单:拼错的、带 SQL 的一律拒绝。
    #[test]
    fn table_names_are_whitelisted() {
        assert_eq!(
            RetentionTable::parse("jobs").expect("jobs"),
            RetentionTable::Jobs
        );
        assert_eq!(
            RetentionTable::parse("audit").expect("audit"),
            RetentionTable::Audit
        );
        assert_eq!(
            RetentionTable::parse("events").expect("events"),
            RetentionTable::Events
        );
        for bad in ["jobs; DROP TABLE events", "insights", ""] {
            let error = RetentionTable::parse(bad).expect_err("应拒绝");
            assert!(error.to_string().contains("不支持清理"), "{error}");
        }
    }
}
