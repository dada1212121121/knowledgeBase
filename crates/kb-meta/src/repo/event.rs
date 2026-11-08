//! `events` 表:进化事件。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Event, Millis};
use kb_core::ports::repo::EventRepo;
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Event> {
    Ok(Event {
        id: row.get(0)?,
        kind: row.get(1)?,
        project_id: row.get(2)?,
        payload_json: row.get(3)?,
        received_at: row.get(4)?,
        processed_at: row.get(5)?,
        result: row.get(6)?,
    })
}

#[async_trait]
impl EventRepo for SqliteMetaStore {
    async fn append(&self, event: Event) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO events (id, kind, project_id, payload_json, received_at, processed_at, result) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    event.id,
                    event.kind,
                    event.project_id,
                    event.payload_json,
                    event.received_at,
                    event.processed_at,
                    event.result,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get(&self, id: &str) -> Result<Option<Event>> {
        let id = id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT id, kind, project_id, payload_json, received_at, processed_at, result \
                 FROM events WHERE id = ?1",
                params![id],
                raw_from_row,
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn list_unprocessed(&self, limit: u32) -> Result<Vec<Event>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, kind, project_id, payload_json, received_at, processed_at, result \
                     FROM events WHERE processed_at IS NULL ORDER BY received_at LIMIT ?1",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![i64::from(limit)], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn recent(&self, limit: u32) -> Result<Vec<Event>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, kind, project_id, payload_json, received_at, processed_at, result \
                     FROM events ORDER BY received_at DESC, id DESC LIMIT ?1",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![i64::from(limit)], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn recent_by_kind(&self, kind: &str, limit: u32) -> Result<Vec<Event>> {
        let kind = kind.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, kind, project_id, payload_json, received_at, processed_at, result \
                     FROM events WHERE kind = ?1 ORDER BY received_at DESC, id DESC LIMIT ?2",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![kind, i64::from(limit)], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn mark_processed(&self, id: &str, at: Millis, result: Option<&str>) -> Result<()> {
        let id = id.to_owned();
        let result = result.map(str::to_owned);
        self.write(move |conn| {
            conn.execute(
                "UPDATE events SET processed_at = ?2, result = ?3 WHERE id = ?1",
                params![id, at, result],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}
