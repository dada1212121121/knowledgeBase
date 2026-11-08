//! `uploads` / `upload_parts` 表:分片上传与断点续传。

use async_trait::async_trait;
use kb_core::model::{DedupStrategy, Upload, UploadPart, UploadState};
use kb_core::ports::repo::UploadRepo;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::{json_to_vec, map_sqlite_error, vec_to_json};

const SELECT_COLUMNS: &str = "id, name, rel_path, collection, tags_json, size, sha256, chunk_size, \
     parts_total, parts_received, state, source_id, batch_id, strategy, created_at, updated_at, \
     completed_at";

struct RawUpload {
    id: String,
    name: String,
    rel_path: String,
    collection: String,
    tags_json: String,
    size: i64,
    sha256: Option<String>,
    chunk_size: i64,
    parts_total: i64,
    parts_received: i64,
    state: String,
    source_id: Option<String>,
    batch_id: Option<String>,
    strategy: Option<String>,
    created_at: i64,
    updated_at: i64,
    completed_at: Option<i64>,
}

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawUpload> {
    Ok(RawUpload {
        id: row.get(0)?,
        name: row.get(1)?,
        rel_path: row.get(2)?,
        collection: row.get(3)?,
        tags_json: row.get(4)?,
        size: row.get(5)?,
        sha256: row.get(6)?,
        chunk_size: row.get(7)?,
        parts_total: row.get(8)?,
        parts_received: row.get(9)?,
        state: row.get(10)?,
        source_id: row.get(11)?,
        batch_id: row.get(12)?,
        strategy: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        completed_at: row.get(16)?,
    })
}

impl RawUpload {
    fn into_upload(self) -> Result<Upload> {
        let state = UploadState::parse(&self.state)
            .ok_or_else(|| KbError::Internal(format!("uploads.state 未知: {}", self.state)))?;
        let strategy = match self.strategy.as_deref() {
            None => None,
            Some(text) => Some(
                DedupStrategy::parse(text)
                    .ok_or_else(|| KbError::Internal(format!("uploads.strategy 未知: {text}")))?,
            ),
        };
        Ok(Upload {
            id: self.id,
            name: self.name,
            rel_path: self.rel_path,
            collection: self.collection,
            tags: json_to_vec(&self.tags_json)?,
            size: self.size.max(0) as u64,
            sha256: self.sha256,
            chunk_size: self.chunk_size.max(0) as u64,
            parts_total: self.parts_total.max(0) as u32,
            parts_received: self.parts_received.max(0) as u32,
            state,
            source_id: self.source_id,
            batch_id: self.batch_id,
            strategy,
            created_at: self.created_at,
            updated_at: self.updated_at,
            completed_at: self.completed_at,
        })
    }
}

fn raw_part_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<UploadPart> {
    Ok(UploadPart {
        upload_id: row.get(0)?,
        part_no: row.get(1)?,
        size: row.get::<_, i64>(2)? as u64,
        sha256: row.get(3)?,
        received_at: row.get(4)?,
    })
}

#[async_trait]
impl UploadRepo for SqliteMetaStore {
    async fn create(&self, upload: Upload) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO uploads (id, name, rel_path, collection, tags_json, size, sha256, \
                 chunk_size, parts_total, parts_received, state, source_id, batch_id, strategy, \
                 created_at, updated_at, completed_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    upload.id,
                    upload.name,
                    upload.rel_path,
                    upload.collection,
                    vec_to_json(&upload.tags),
                    upload.size as i64,
                    upload.sha256,
                    upload.chunk_size as i64,
                    i64::from(upload.parts_total),
                    i64::from(upload.parts_received),
                    upload.state.as_str(),
                    upload.source_id,
                    upload.batch_id,
                    upload.strategy.map(|value| value.as_str()),
                    upload.created_at,
                    upload.updated_at,
                    upload.completed_at,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get(&self, id: &str) -> Result<Option<Upload>> {
        let id = id.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM uploads WHERE id = ?1"),
                    params![id],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawUpload::into_upload).transpose()
        })
        .await
    }

    async fn update(&self, upload: Upload) -> Result<()> {
        let id = upload.id.clone();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE uploads SET name = ?2, rel_path = ?3, collection = ?4, tags_json = ?5, \
                     size = ?6, sha256 = ?7, chunk_size = ?8, parts_total = ?9, parts_received = ?10, \
                     state = ?11, source_id = ?12, batch_id = ?13, strategy = ?14, updated_at = ?15, \
                     completed_at = ?16 WHERE id = ?1",
                    params![
                        upload.id,
                        upload.name,
                        upload.rel_path,
                        upload.collection,
                        vec_to_json(&upload.tags),
                        upload.size as i64,
                        upload.sha256,
                        upload.chunk_size as i64,
                        i64::from(upload.parts_total),
                        i64::from(upload.parts_received),
                        upload.state.as_str(),
                        upload.source_id,
                        upload.batch_id,
                        upload.strategy.map(|value| value.as_str()),
                        upload.updated_at,
                        upload.completed_at,
                    ],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("upload {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            conn.execute("DELETE FROM uploads WHERE id = ?1", params![id])
                .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn list_pending(&self) -> Result<Vec<Upload>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM uploads WHERE state = 'pending' \
                     ORDER BY updated_at"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map([], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(RawUpload::into_upload).collect()
        })
        .await
    }

    async fn put_part(&self, part: UploadPart) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO upload_parts (upload_id, part_no, size, sha256, received_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5) \
                 ON CONFLICT(upload_id, part_no) DO UPDATE SET size = excluded.size, \
                 sha256 = excluded.sha256, received_at = excluded.received_at",
                params![
                    part.upload_id,
                    i64::from(part.part_no),
                    part.size as i64,
                    part.sha256,
                    part.received_at,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn parts(&self, upload_id: &str) -> Result<Vec<UploadPart>> {
        let upload_id = upload_id.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT upload_id, part_no, size, sha256, received_at FROM upload_parts \
                     WHERE upload_id = ?1 ORDER BY part_no",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![upload_id], raw_part_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn part(&self, upload_id: &str, part_no: u32) -> Result<Option<UploadPart>> {
        let upload_id = upload_id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT upload_id, part_no, size, sha256, received_at FROM upload_parts \
                 WHERE upload_id = ?1 AND part_no = ?2",
                params![upload_id, i64::from(part_no)],
                raw_part_from_row,
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn delete_parts(&self, upload_id: &str) -> Result<()> {
        let upload_id = upload_id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "DELETE FROM upload_parts WHERE upload_id = ?1",
                params![upload_id],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}
