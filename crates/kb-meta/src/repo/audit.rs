//! `audit` / `batches` / `changes` 表。

use async_trait::async_trait;
use kb_core::model::{AuditEntry, AuditFilter, Batch, Change, Millis, Page};
use kb_core::ports::repo::AuditRepo;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, ToSql, params, params_from_iter};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<AuditEntry> {
    Ok(AuditEntry {
        id: Some(row.get(0)?),
        at: row.get(1)?,
        actor: row.get(2)?,
        capability: row.get(3)?,
        args_json: row.get(4)?,
        ok: row.get::<_, i64>(5)? != 0,
        error: row.get(6)?,
        batch_id: row.get(7)?,
        dry_run: row.get::<_, i64>(8)? != 0,
        // 迁移 0020 之前的旧行没有这两列值(读出来是 NULL)
        took_ms: row
            .get::<_, Option<i64>>(9)?
            .map(|value| value.max(0) as u64),
        degraded: row.get(10)?,
    })
}

#[async_trait]
impl AuditRepo for SqliteMetaStore {
    async fn record(&self, entry: AuditEntry) -> Result<i64> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO audit (at, actor, capability, args_json, ok, error, batch_id, dry_run, \
                 took_ms, degraded) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    entry.at,
                    entry.actor,
                    entry.capability,
                    entry.args_json,
                    i64::from(entry.ok),
                    entry.error,
                    entry.batch_id,
                    i64::from(entry.dry_run),
                    entry.took_ms.map(|value| value as i64),
                    entry.degraded,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }

    async fn begin_batch(&self, actor: &str, description: &str) -> Result<String> {
        let id = uuid::Uuid::now_v7().to_string();
        let actor = actor.to_owned();
        let description = description.to_owned();
        let created_at = now_millis();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO batches (id, actor, description, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![id, actor, description, created_at],
            )
            .map_err(map_sqlite_error)?;
            Ok(id)
        })
        .await
    }

    async fn ensure_batch(&self, id: &str, actor: &str, description: &str) -> Result<()> {
        let id = id.to_owned();
        let actor = actor.to_owned();
        let description = description.to_owned();
        let created_at = now_millis();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO batches (id, actor, description, created_at) VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(id) DO NOTHING",
                params![id, actor, description, created_at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn record_change(&self, batch_id: &str, change: Change) -> Result<()> {
        let batch_id = batch_id.to_owned();
        self.write(move |conn| {
            let seq: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(seq), 0) + 1 FROM changes WHERE batch_id = ?1",
                    params![batch_id],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            conn.execute(
                "INSERT INTO changes (batch_id, seq, target, before_json, after_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    batch_id,
                    seq,
                    change.target,
                    change.before_json,
                    change.after_json
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn batch(&self, id: &str) -> Result<Option<Batch>> {
        let id = id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT id, actor, description, created_at, reverted_at FROM batches WHERE id = ?1",
                params![id],
                |row| {
                    Ok(Batch {
                        id: row.get(0)?,
                        actor: row.get(1)?,
                        description: row.get(2)?,
                        created_at: row.get(3)?,
                        reverted_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn list(&self, filter: Option<AuditFilter>, page: Page) -> Result<Vec<AuditEntry>> {
        self.read(move |conn| {
            let (where_sql, values) = audit_where(filter);
            let mut sql = String::from(
                "SELECT id, at, actor, capability, args_json, ok, error, batch_id, dry_run, \
                 took_ms, degraded FROM audit",
            );
            sql.push_str(&where_sql);
            sql.push_str(" ORDER BY at DESC, id DESC LIMIT ? OFFSET ?");
            let mut values = values;
            values.push(Box::new(i64::from(page.limit)));
            values.push(Box::new(i64::from(page.offset)));
            let mut stmt = conn.prepare(&sql).map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params_from_iter(values.iter()), raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn count(&self, filter: Option<AuditFilter>) -> Result<u64> {
        self.read(move |conn| {
            let (where_sql, values) = audit_where(filter);
            let sql = format!("SELECT COUNT(*) FROM audit{where_sql}");
            let total: i64 = conn
                .query_row(&sql, params_from_iter(values.iter()), |row| row.get(0))
                .map_err(map_sqlite_error)?;
            Ok(total.max(0) as u64)
        })
        .await
    }

    async fn changes(&self, batch_id: &str) -> Result<Vec<Change>> {
        let batch_id = batch_id.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT batch_id, seq, target, before_json, after_json FROM changes \
                     WHERE batch_id = ?1 ORDER BY seq ASC",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![batch_id], |row| {
                    Ok(Change {
                        batch_id: row.get(0)?,
                        seq: row.get(1)?,
                        target: row.get(2)?,
                        before_json: row.get(3)?,
                        after_json: row.get(4)?,
                    })
                })
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn list_batches(&self, page: Page) -> Result<Vec<Batch>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, actor, description, created_at, reverted_at FROM batches \
                     ORDER BY created_at DESC, id DESC LIMIT ?1 OFFSET ?2",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(
                    params![i64::from(page.limit), i64::from(page.offset)],
                    |row| {
                        Ok(Batch {
                            id: row.get(0)?,
                            actor: row.get(1)?,
                            description: row.get(2)?,
                            created_at: row.get(3)?,
                            reverted_at: row.get(4)?,
                        })
                    },
                )
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn count_batches(&self) -> Result<u64> {
        self.read(move |conn| {
            let total: i64 = conn
                .query_row("SELECT COUNT(*) FROM batches", [], |row| row.get(0))
                .map_err(map_sqlite_error)?;
            Ok(total.max(0) as u64)
        })
        .await
    }

    async fn mark_reverted(&self, batch_id: &str, at: Millis) -> Result<()> {
        let batch_id = batch_id.to_owned();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE batches SET reverted_at = ?2 WHERE id = ?1 AND reverted_at IS NULL",
                    params![batch_id, at],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("批次 {batch_id}")));
            }
            Ok(())
        })
        .await
    }
}

/// 审计查询的 `WHERE` 子句与参数(过滤条件只来自 [`AuditFilter`])。
fn audit_where(filter: Option<AuditFilter>) -> (String, Vec<Box<dyn ToSql>>) {
    let mut clauses: Vec<&str> = Vec::new();
    let mut values: Vec<Box<dyn ToSql>> = Vec::new();
    if let Some(filter) = filter {
        if let Some(actor) = filter.actor {
            clauses.push("actor = ?");
            values.push(Box::new(actor));
        }
        if let Some(capability) = filter.capability {
            clauses.push("capability = ?");
            values.push(Box::new(capability));
        }
        if let Some(since) = filter.since {
            clauses.push("at >= ?");
            values.push(Box::new(since));
        }
        if let Some(batch_id) = filter.batch_id {
            clauses.push("batch_id = ?");
            values.push(Box::new(batch_id));
        }
    }
    if clauses.is_empty() {
        (String::new(), values)
    } else {
        (format!(" WHERE {}", clauses.join(" AND ")), values)
    }
}

/// 当前时间的 Unix 毫秒。
fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
