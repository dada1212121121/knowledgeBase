//! `ingest_stage_events` / `ingest_batches` 表:流水线进度。

use async_trait::async_trait;
use kb_core::model::{
    IngestBatch, IngestBatchState, IngestStage, IngestStageEvent, IngestStageStatus, Millis,
};
use kb_core::ports::repo::IngestProgressRepo;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

const SELECT_COLUMNS: &str = "id, file_id, batch_id, stage, started_at, ended_at, status, error, \
     chunks, vectors";

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawStage> {
    Ok(RawStage {
        id: row.get(0)?,
        file_id: row.get(1)?,
        batch_id: row.get(2)?,
        stage: row.get(3)?,
        started_at: row.get(4)?,
        ended_at: row.get(5)?,
        status: row.get(6)?,
        error: row.get(7)?,
        chunks: row.get(8)?,
        vectors: row.get(9)?,
    })
}

struct RawStage {
    id: i64,
    file_id: String,
    batch_id: Option<String>,
    stage: String,
    started_at: Millis,
    ended_at: Option<Millis>,
    status: String,
    error: Option<String>,
    chunks: i64,
    vectors: i64,
}

impl RawStage {
    fn into_event(self) -> Result<IngestStageEvent> {
        let stage = IngestStage::parse(&self.stage).ok_or_else(|| {
            KbError::Internal(format!("ingest_stage_events.stage 未知: {}", self.stage))
        })?;
        let status = IngestStageStatus::parse(&self.status).ok_or_else(|| {
            KbError::Internal(format!("ingest_stage_events.status 未知: {}", self.status))
        })?;
        Ok(IngestStageEvent {
            id: Some(self.id),
            file_id: self.file_id,
            batch_id: self.batch_id,
            stage,
            started_at: self.started_at,
            ended_at: self.ended_at,
            status,
            error: self.error,
            chunks: self.chunks.max(0) as u64,
            vectors: self.vectors.max(0) as u64,
        })
    }
}

#[async_trait]
impl IngestProgressRepo for SqliteMetaStore {
    async fn begin_stage(
        &self,
        file_id: &str,
        batch_id: Option<&str>,
        stage: IngestStage,
        at: Millis,
    ) -> Result<i64> {
        let file_id = file_id.to_owned();
        let batch_id = batch_id.map(str::to_owned);
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO ingest_stage_events (file_id, batch_id, stage, started_at, status) \
                 VALUES (?1, ?2, ?3, ?4, 'running')",
                params![file_id, batch_id, stage.as_str(), at],
            )
            .map_err(map_sqlite_error)?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }

    async fn end_stage(
        &self,
        id: i64,
        status: IngestStageStatus,
        error: Option<&str>,
        chunks: u64,
        vectors: u64,
        at: Millis,
    ) -> Result<()> {
        let error = error.map(str::to_owned);
        self.write(move |conn| {
            conn.execute(
                "UPDATE ingest_stage_events SET ended_at = ?2, status = ?3, error = ?4, \
                 chunks = ?5, vectors = ?6 WHERE id = ?1",
                params![
                    id,
                    at,
                    status.as_str(),
                    error,
                    chunks as i64,
                    vectors as i64
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn stages_of_file(&self, file_id: &str) -> Result<Vec<IngestStageEvent>> {
        let file_id = file_id.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM ingest_stage_events \
                     WHERE file_id = ?1 ORDER BY started_at, id"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![file_id], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(RawStage::into_event).collect()
        })
        .await
    }

    async fn stages_of_batch(&self, batch_id: &str) -> Result<Vec<IngestStageEvent>> {
        let batch_id = batch_id.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM ingest_stage_events \
                     WHERE batch_id = ?1 ORDER BY started_at, id"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![batch_id], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(RawStage::into_event).collect()
        })
        .await
    }

    async fn completed_since(&self, batch_id: &str, since: Millis) -> Result<(u64, u64)> {
        let batch_id = batch_id.to_owned();
        self.read(move |conn| {
            let row: (i64, i64) = conn
                .query_row(
                    "SELECT COALESCE(SUM(chunks), 0), COUNT(*) FROM ingest_stage_events \
                     WHERE batch_id = ?1 AND stage = 'searchable' AND status = 'ok' \
                     AND ended_at >= ?2",
                    params![batch_id, since],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(map_sqlite_error)?;
            Ok((row.0.max(0) as u64, row.1.max(0) as u64))
        })
        .await
    }

    async fn ensure_ingest_batch(
        &self,
        batch_id: &str,
        collection: &str,
        at: Millis,
    ) -> Result<()> {
        let batch_id = batch_id.to_owned();
        let collection = collection.to_owned();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO ingest_batches (batch_id, collection, state, created_at, updated_at) \
                 VALUES (?1, ?2, 'running', ?3, ?3) ON CONFLICT(batch_id) DO NOTHING",
                params![batch_id, collection, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn ingest_batch(&self, batch_id: &str) -> Result<Option<IngestBatch>> {
        let batch_id = batch_id.to_owned();
        self.read(move |conn| {
            let raw: Option<(String, String, String, Millis, Millis)> = conn
                .query_row(
                    "SELECT batch_id, collection, state, created_at, updated_at \
                     FROM ingest_batches WHERE batch_id = ?1",
                    params![batch_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(map_sqlite_error)?;
            match raw {
                None => Ok(None),
                Some((batch_id, collection, state, created_at, updated_at)) => {
                    let state = IngestBatchState::parse(&state).ok_or_else(|| {
                        KbError::Internal(format!("ingest_batches.state 未知: {state}"))
                    })?;
                    Ok(Some(IngestBatch {
                        batch_id,
                        collection,
                        state,
                        created_at,
                        updated_at,
                    }))
                }
            }
        })
        .await
    }

    async fn reset_stages_from(&self, file_id: &str, stage: IngestStage) -> Result<u64> {
        // 阶段顺序是固定的,用 IN 列出“这个阶段及其之后”
        let later: Vec<&str> = IngestStage::ALL
            .iter()
            .filter(|item| **item >= stage)
            .map(|item| item.as_str())
            .collect();
        let file_id = file_id.to_owned();
        self.write(move |conn| {
            let placeholders = vec!["?"; later.len()].join(", ");
            let sql = format!(
                "DELETE FROM ingest_stage_events WHERE file_id = ? AND stage IN ({placeholders})"
            );
            let mut params: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(file_id)];
            for item in later {
                params.push(Box::new(item.to_owned()));
            }
            let refs: Vec<&dyn rusqlite::ToSql> =
                params.iter().map(|value| value.as_ref()).collect();
            let removed = conn
                .execute(&sql, refs.as_slice())
                .map_err(map_sqlite_error)?;
            Ok(removed as u64)
        })
        .await
    }

    async fn set_ingest_batch_state(
        &self,
        batch_id: &str,
        state: IngestBatchState,
        at: Millis,
    ) -> Result<()> {
        let batch_id = batch_id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE ingest_batches SET state = ?2, updated_at = ?3 WHERE batch_id = ?1",
                params![batch_id, state.as_str(), at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn finish_ingest_batch_if_running(&self, batch_id: &str, at: Millis) -> Result<bool> {
        let batch_id = batch_id.to_owned();
        self.write(move |conn| {
            // 只从 running 收尾:期间被取消 / 暂停的批次不能被改回 done
            let changed = conn
                .execute(
                    "UPDATE ingest_batches SET state = 'done', updated_at = ?2 \
                     WHERE batch_id = ?1 AND state = 'running'",
                    params![batch_id, at],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed > 0)
        })
        .await
    }
}
