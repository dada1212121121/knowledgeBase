//! `files` 表:文件级指纹。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::FileRecord;
use kb_core::ports::repo::FileRepo;
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileRecord> {
    Ok(FileRecord {
        collection: row.get(0)?,
        path: row.get(1)?,
        file_hash: row.get(2)?,
        size: row.get::<_, i64>(3)? as u64,
        mtime: row.get(4)?,
        indexed_at: row.get(5)?,
        status: row.get(6)?,
        error: row.get(7)?,
    })
}

#[async_trait]
impl FileRepo for SqliteMetaStore {
    async fn get(&self, collection: &str, path: &str) -> Result<Option<FileRecord>> {
        let collection = collection.to_owned();
        let path = path.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT collection, path, file_hash, size, mtime, indexed_at, status, error \
                 FROM files WHERE collection = ?1 AND path = ?2",
                params![collection, path],
                raw_from_row,
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn upsert(&self, record: FileRecord) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO files (collection, path, file_hash, size, mtime, indexed_at, status, error) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT(collection, path) DO UPDATE SET file_hash = excluded.file_hash, \
                 size = excluded.size, mtime = excluded.mtime, indexed_at = excluded.indexed_at, \
                 status = excluded.status, error = excluded.error",
                params![
                    record.collection,
                    record.path,
                    record.file_hash,
                    record.size as i64,
                    record.mtime,
                    record.indexed_at,
                    record.status,
                    record.error,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn list_paths(&self, collection: &str) -> Result<Vec<String>> {
        let collection = collection.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare("SELECT path FROM files WHERE collection = ?1 ORDER BY path")
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![collection], |row| row.get::<_, String>(0))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn delete(&self, collection: &str, path: &str) -> Result<()> {
        let collection = collection.to_owned();
        let path = path.to_owned();
        self.write(move |conn| {
            conn.execute(
                "DELETE FROM files WHERE collection = ?1 AND path = ?2",
                params![collection, path],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}
