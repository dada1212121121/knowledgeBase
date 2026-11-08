//! `feedback` 表:检索结果的显式反馈。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Feedback, Page};
use kb_core::ports::repo::FeedbackRepo;
use rusqlite::params;

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Feedback> {
    Ok(Feedback {
        id: Some(row.get(0)?),
        at: row.get(1)?,
        query: row.get(2)?,
        item_id: row.get(3)?,
        useful: row.get::<_, i64>(4)? != 0,
        note: row.get(5)?,
        source: row.get(6)?,
    })
}

#[async_trait]
impl FeedbackRepo for SqliteMetaStore {
    async fn record(&self, feedback: Feedback) -> Result<i64> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO feedback (at, query, item_id, useful, note, source) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    feedback.at,
                    feedback.query,
                    feedback.item_id,
                    i64::from(feedback.useful),
                    feedback.note,
                    feedback.source,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }

    async fn list(&self, page: Page) -> Result<Vec<Feedback>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, at, query, item_id, useful, note, source FROM feedback \
                     ORDER BY at DESC, id DESC LIMIT ?1 OFFSET ?2",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(
                    params![i64::from(page.limit), i64::from(page.offset)],
                    raw_from_row,
                )
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }
}
