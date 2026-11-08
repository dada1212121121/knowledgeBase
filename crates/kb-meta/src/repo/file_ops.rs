//! `file_ops` / `trash_entries` / `path_exclusions` 表。
//!
//! 所有写入都放在 `SqliteMetaStore::write` 里:文件操作可能中途失败,
//! 流水本身必须落盘,否则重启后既不知道搬走了什么,也无法回滚。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{FileOp, FileOpKind, FileOpState, Millis, Page, TrashEntry, TrashMode};
use kb_core::ports::repo::FileOpsRepo;
use rusqlite::{OptionalExtension, params, types::Type};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

const OP_COLUMNS: &str = "id, collection, target_collection, kind, state, total, done, failed, \
     error, created_at, finished_at";
const TRASH_COLUMNS: &str = "id, op_id, collection, original_path, trash_path, source_id, \
     metadata_key, mode, size, created_at, expires_at, restored_at, purged_at";

/// 数据库里的枚举值坏了要报错,不能静默降级成「删除文件 / 失败」:
/// 那会让一次移动被显示成删除,流水本身也就失去了可信度。
fn bad_enum(index: usize, value: &str, what: &str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{what} 未知: {value}"),
        )),
    )
}

fn op_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<FileOp> {
    let kind: String = row.get(3)?;
    let kind = FileOpKind::parse(&kind).ok_or_else(|| bad_enum(3, &kind, "file_ops.kind"))?;
    let state: String = row.get(4)?;
    let state = FileOpState::parse(&state).ok_or_else(|| bad_enum(4, &state, "file_ops.state"))?;
    Ok(FileOp {
        id: row.get(0)?,
        collection: row.get(1)?,
        target_collection: row.get(2)?,
        kind,
        state,
        total: row.get::<_, i64>(5)?.max(0) as u64,
        done: row.get::<_, i64>(6)?.max(0) as u64,
        failed: row.get::<_, i64>(7)?.max(0) as u64,
        error: row.get(8)?,
        created_at: row.get(9)?,
        finished_at: row.get(10)?,
    })
}

fn trash_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TrashEntry> {
    let mode: String = row.get(7)?;
    Ok(TrashEntry {
        id: row.get(0)?,
        op_id: row.get(1)?,
        collection: row.get(2)?,
        original_path: row.get(3)?,
        trash_path: row.get(4)?,
        source_id: row.get(5)?,
        metadata_key: row.get(6)?,
        mode: TrashMode::parse(&mode).ok_or_else(|| bad_enum(7, &mode, "trash_entries.mode"))?,
        size: row.get::<_, i64>(8)?.max(0) as u64,
        created_at: row.get(9)?,
        expires_at: row.get(10)?,
        restored_at: row.get(11)?,
        purged_at: row.get(12)?,
    })
}

#[async_trait]
impl FileOpsRepo for SqliteMetaStore {
    async fn create_file_op(&self, op: FileOp) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO file_ops (id, collection, target_collection, kind, state, total, done, failed, error, created_at, finished_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    op.id,
                    op.collection,
                    op.target_collection,
                    op.kind.as_str(),
                    op.state.as_str(),
                    op.total as i64,
                    op.done as i64,
                    op.failed as i64,
                    op.error,
                    op.created_at,
                    op.finished_at
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn update_file_op(&self, op: &FileOp) -> Result<()> {
        let op = op.clone();
        self.write(move |conn| {
            conn.execute(
                "UPDATE file_ops SET state = ?2, total = ?3, done = ?4, failed = ?5, error = ?6, finished_at = ?7 WHERE id = ?1",
                params![
                    op.id,
                    op.state.as_str(),
                    op.total as i64,
                    op.done as i64,
                    op.failed as i64,
                    op.error,
                    op.finished_at
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get_file_op(&self, id: &str) -> Result<Option<FileOp>> {
        let id = id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                &format!("SELECT {OP_COLUMNS} FROM file_ops WHERE id = ?1"),
                params![id],
                op_from_row,
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn add_trash(&self, entry: TrashEntry) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO trash_entries (id, op_id, collection, original_path, trash_path, source_id, \
                 metadata_key, mode, size, created_at, expires_at, restored_at, purged_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    entry.id,
                    entry.op_id,
                    entry.collection,
                    entry.original_path,
                    entry.trash_path,
                    entry.source_id,
                    entry.metadata_key,
                    entry.mode.as_str(),
                    entry.size as i64,
                    entry.created_at,
                    entry.expires_at,
                    entry.restored_at,
                    entry.purged_at
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get_trash(&self, id: &str) -> Result<Option<TrashEntry>> {
        let id = id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                &format!("SELECT {TRASH_COLUMNS} FROM trash_entries WHERE id = ?1"),
                params![id],
                trash_from_row,
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn list_trash(&self, collection: Option<&str>, page: Page) -> Result<Vec<TrashEntry>> {
        let collection = collection.map(str::to_owned);
        let limit = i64::from(page.limit.clamp(1, 500));
        let offset = i64::from(page.offset);
        self.read(move |conn| {
            let (sql, args): (String, Vec<rusqlite::types::Value>) = match collection {
                Some(name) => (
                    format!(
                        "SELECT {TRASH_COLUMNS} FROM trash_entries \
                         WHERE restored_at IS NULL AND purged_at IS NULL AND collection = ?1 \
                         ORDER BY created_at DESC LIMIT ?2 OFFSET ?3"
                    ),
                    vec![name.into(), limit.into(), offset.into()],
                ),
                None => (
                    format!(
                        "SELECT {TRASH_COLUMNS} FROM trash_entries \
                         WHERE restored_at IS NULL AND purged_at IS NULL \
                         ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
                    ),
                    vec![limit.into(), offset.into()],
                ),
            };
            let mut stmt = conn.prepare(&sql).map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(args), trash_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn count_trash(&self, collection: Option<&str>) -> Result<u64> {
        let collection = collection.map(str::to_owned);
        self.read(move |conn| {
            let count: i64 = match collection {
                Some(name) => conn.query_row(
                    "SELECT COUNT(*) FROM trash_entries \
                     WHERE restored_at IS NULL AND purged_at IS NULL AND collection = ?1",
                    params![name],
                    |row| row.get(0),
                ),
                None => conn.query_row(
                    "SELECT COUNT(*) FROM trash_entries \
                     WHERE restored_at IS NULL AND purged_at IS NULL",
                    [],
                    |row| row.get(0),
                ),
            }
            .map_err(map_sqlite_error)?;
            Ok(count.max(0) as u64)
        })
        .await
    }

    async fn list_expired_trash(&self, now: Millis, limit: u32) -> Result<Vec<TrashEntry>> {
        let limit = i64::from(limit.clamp(1, 500));
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {TRASH_COLUMNS} FROM trash_entries \
                     WHERE restored_at IS NULL AND purged_at IS NULL \
                       AND expires_at IS NOT NULL AND expires_at <= ?1 \
                     ORDER BY expires_at LIMIT ?2"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![now, limit], trash_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn mark_trash_restored(&self, id: &str, at: Millis) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE trash_entries SET restored_at = ?2 WHERE id = ?1 AND restored_at IS NULL",
                params![id, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn mark_trash_purged(&self, id: &str, at: Millis) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE trash_entries SET purged_at = ?2 WHERE id = ?1 AND purged_at IS NULL",
                params![id, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn add_path_exclusion(
        &self,
        collection: &str,
        source_id: &str,
        path: &str,
        at: Millis,
    ) -> Result<()> {
        let (collection, source_id, path) =
            (collection.to_owned(), source_id.to_owned(), path.to_owned());
        self.write(move |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO path_exclusions (collection, source_id, path, created_at) \
                 VALUES (?1, ?2, ?3, ?4)",
                params![collection, source_id, path, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn remove_path_exclusion(
        &self,
        collection: &str,
        source_id: &str,
        path: &str,
    ) -> Result<()> {
        let (collection, source_id, path) =
            (collection.to_owned(), source_id.to_owned(), path.to_owned());
        self.write(move |conn| {
            conn.execute(
                "DELETE FROM path_exclusions WHERE collection = ?1 AND source_id = ?2 AND path = ?3",
                params![collection, source_id, path],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn list_path_exclusions(&self, collection: &str, source_id: &str) -> Result<Vec<String>> {
        let (collection, source_id) = (collection.to_owned(), source_id.to_owned());
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT path FROM path_exclusions WHERE collection = ?1 AND source_id = ?2 ORDER BY path",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![collection, source_id], |row| row.get(0))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<String>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn path_excluded(&self, collection: &str, source_id: &str, path: &str) -> Result<bool> {
        let (collection, source_id, path) =
            (collection.to_owned(), source_id.to_owned(), path.to_owned());
        self.read(move |conn| {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM path_exclusions WHERE collection = ?1 AND source_id = ?2 AND path = ?3",
                    params![collection, source_id, path],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            Ok(found.is_some())
        })
        .await
    }
}
