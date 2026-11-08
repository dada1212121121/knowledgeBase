//! `llm_usage` / `llm_sends` 表(AI 使用, 外发审计)。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{LlmSend, LlmUsage};
use kb_core::ports::repo::LlmUsageRepo;
use rusqlite::params;

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

#[async_trait]
impl LlmUsageRepo for SqliteMetaStore {
    async fn add_usage(&self, usage: LlmUsage) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO llm_usage (day, model, purpose, calls, input_tokens, output_tokens) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(day, model, purpose) DO UPDATE SET \
                 calls = llm_usage.calls + excluded.calls, \
                 input_tokens = llm_usage.input_tokens + excluded.input_tokens, \
                 output_tokens = llm_usage.output_tokens + excluded.output_tokens",
                params![
                    usage.day,
                    usage.model,
                    usage.purpose,
                    usage.calls,
                    usage.input_tokens as i64,
                    usage.output_tokens as i64,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn usage_of_day(&self, day: &str) -> Result<Vec<LlmUsage>> {
        let day = day.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT day, model, purpose, calls, input_tokens, output_tokens FROM llm_usage \
                     WHERE day = ?1 ORDER BY model, purpose",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![day], |row| {
                    Ok(LlmUsage {
                        day: row.get(0)?,
                        model: row.get(1)?,
                        purpose: row.get(2)?,
                        calls: row.get::<_, i64>(3)? as u32,
                        input_tokens: row.get::<_, i64>(4)? as u64,
                        output_tokens: row.get::<_, i64>(5)? as u64,
                    })
                })
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn count_sends_since(&self, at: i64) -> Result<u64> {
        self.read(move |conn| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM llm_sends WHERE at >= ?1",
                    params![at],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            Ok(count as u64)
        })
        .await
    }

    async fn record_send(&self, send: LlmSend) -> Result<i64> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO llm_sends (at, project_id, purpose, chars, redactions) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    send.at,
                    send.project_id,
                    send.purpose,
                    send.chars as i64,
                    send.redactions as i64,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }
}
