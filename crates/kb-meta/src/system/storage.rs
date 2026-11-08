//! 知识库占用明细(`space_usage`):定时统计写入,排行与用量页读取。

use kb_core::Result;
use kb_core::account::SpaceUsage;
use kb_core::model::Millis;
use kb_core::model::identity::{MeasuredUsage, StorageRankRow, StorageTotals};
use rusqlite::{OptionalExtension, params};

use super::SystemStore;
use crate::sql::map_sqlite_error;

fn to_u64(value: i64) -> u64 {
    value.max(0) as u64
}

fn row_to_measured(row: &rusqlite::Row<'_>, offset: usize) -> rusqlite::Result<MeasuredUsage> {
    Ok(MeasuredUsage {
        usage: SpaceUsage {
            sources_bytes: to_u64(row.get(offset)?),
            uploads_bytes: to_u64(row.get(offset + 1)?),
            vectors_bytes: to_u64(row.get(offset + 2)?),
            meta_bytes: to_u64(row.get(offset + 3)?),
            workspace_bytes: to_u64(row.get(offset + 4)?),
        },
        total_bytes: to_u64(row.get(offset + 5)?),
        measured_at: row.get(offset + 6)?,
    })
}

impl SystemStore {
    /// 记下一个知识库的统计结果,同时更新 `spaces.storage_bytes`(用户详情页读的合计)。
    pub async fn save_space_usage(
        &self,
        space_id: &str,
        usage: SpaceUsage,
        now: Millis,
    ) -> Result<()> {
        let space_id = space_id.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let total = usage.total();
            tx.execute(
                "INSERT INTO space_usage (space_id, sources_bytes, uploads_bytes, vectors_bytes, meta_bytes, workspace_bytes, total_bytes, measured_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                 ON CONFLICT(space_id) DO UPDATE SET \
                   sources_bytes = excluded.sources_bytes, uploads_bytes = excluded.uploads_bytes, \
                   vectors_bytes = excluded.vectors_bytes, meta_bytes = excluded.meta_bytes, \
                   workspace_bytes = excluded.workspace_bytes, total_bytes = excluded.total_bytes, measured_at = excluded.measured_at",
                params![
                    space_id,
                    usage.sources_bytes as i64,
                    usage.uploads_bytes as i64,
                    usage.vectors_bytes as i64,
                    usage.meta_bytes as i64,
                    usage.workspace_bytes as i64,
                    total as i64,
                    now
                ],
            )
            .map_err(map_sqlite_error)?;
            tx.execute(
                "UPDATE spaces SET storage_bytes = ?2 WHERE id = ?1",
                params![space_id, total as i64],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }

    /// 一个知识库最近一次统计的结果;从没统计过返回 `None`。
    pub async fn get_space_usage(&self, space_id: &str) -> Result<Option<MeasuredUsage>> {
        let space_id = space_id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT sources_bytes, uploads_bytes, vectors_bytes, meta_bytes, workspace_bytes, total_bytes, measured_at \
                 FROM space_usage WHERE space_id = ?1",
                params![space_id],
                |row| row_to_measured(row, 0),
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 占用最多的知识库,最多 `limit` 个。
    pub async fn storage_ranking(&self, limit: u32) -> Result<Vec<StorageRankRow>> {
        self.read(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT s.id, s.owner_id, u.username, u.display_name, \
                            m.sources_bytes, m.uploads_bytes, m.vectors_bytes, m.meta_bytes, m.workspace_bytes, m.total_bytes, m.measured_at \
                     FROM space_usage m \
                     JOIN spaces s ON s.id = m.space_id \
                     LEFT JOIN users u ON u.id = s.owner_id \
                     ORDER BY m.total_bytes DESC, s.id LIMIT ?1",
                )
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![limit], |row| {
                    Ok(StorageRankRow {
                        space_id: row.get(0)?,
                        owner_id: row.get(1)?,
                        username: row.get(2)?,
                        display_name: row.get(3)?,
                        measured: row_to_measured(row, 4)?,
                    })
                })
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)
        })
        .await
    }

    /// 最久没统计的知识库(从没统计过的排最前),最多 `limit` 个。定时任务按它挨个量,
    /// 每一轮只量一小批,上千个知识库也不会一次把磁盘读爆。
    pub async fn spaces_by_staleness(&self, limit: u32) -> Result<Vec<String>> {
        self.read(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT s.id FROM spaces s LEFT JOIN space_usage m ON m.space_id = s.id \
                     ORDER BY COALESCE(m.measured_at, 0), s.created_at, s.id LIMIT ?1",
                )
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![limit], |row| row.get::<_, String>(0))
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)
        })
        .await
    }

    /// 全站合计。
    pub async fn storage_totals(&self) -> Result<StorageTotals> {
        self.read(|conn| {
            let total_spaces: i64 = conn
                .query_row("SELECT COUNT(*) FROM spaces", [], |row| row.get(0))
                .map_err(map_sqlite_error)?;
            conn.query_row(
                "SELECT COUNT(*), COALESCE(SUM(total_bytes), 0), COALESCE(SUM(vectors_bytes), 0), MIN(measured_at) \
                 FROM space_usage m JOIN spaces s ON s.id = m.space_id",
                [],
                |row| {
                    Ok(StorageTotals {
                        measured_spaces: to_u64(row.get(0)?),
                        total_spaces: to_u64(total_spaces),
                        total_bytes: to_u64(row.get(1)?),
                        vectors_bytes: to_u64(row.get(2)?),
                        oldest_measured_at: row.get(3)?,
                    })
                },
            )
            .map_err(map_sqlite_error)
        })
        .await
    }
}
