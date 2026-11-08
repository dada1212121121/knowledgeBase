//! `chunks` 表:块级三哈希。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{ChunkMeta, Millis, PendingChunk, PendingStats};
use kb_core::ports::repo::ChunkRepo;
use rusqlite::params;

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ChunkMeta> {
    Ok(ChunkMeta {
        id: row.get(0)?,
        collection: row.get(1)?,
        path: row.get(2)?,
        ordinal: row.get::<_, i64>(3)? as u32,
        content_hash: row.get(4)?,
        meta_hash: row.get(5)?,
        embed_input_hash: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

const SELECT_COLUMNS: &str =
    "id, collection, path, ordinal, content_hash, meta_hash, embed_input_hash, updated_at";

#[async_trait]
impl ChunkRepo for SqliteMetaStore {
    async fn by_path(&self, collection: &str, path: &str) -> Result<Vec<ChunkMeta>> {
        let collection = collection.to_owned();
        let path = path.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM chunks WHERE collection = ?1 AND path = ?2 \
                     ORDER BY ordinal"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![collection, path], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn replace_for_path(
        &self,
        collection: &str,
        path: &str,
        chunks: Vec<ChunkMeta>,
    ) -> Result<()> {
        self.replace_for_path_with_pending(collection, path, chunks, &[], 0)
            .await
    }

    async fn replace_for_path_with_pending(
        &self,
        collection: &str,
        path: &str,
        chunks: Vec<ChunkMeta>,
        pending: &[(String, String)],
        enqueued_at: Millis,
    ) -> Result<()> {
        let collection = collection.to_owned();
        let pending = pending.to_vec();
        let path = path.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            // 队列与块表必须一起换:文件被改动后,旧块的 pending 项不能留着,
            // 否则补向量阶段会按已不存在的 id 反复取不到正文。
            tx.execute(
                "DELETE FROM pending_embeds WHERE collection = ?1 AND path = ?2",
                params![collection, path],
            )
            .map_err(map_sqlite_error)?;
            tx.execute(
                "DELETE FROM chunks WHERE collection = ?1 AND path = ?2",
                params![collection, path],
            )
            .map_err(map_sqlite_error)?;
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO chunks (id, collection, path, ordinal, content_hash, meta_hash, \
                         embed_input_hash, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    )
                    .map_err(map_sqlite_error)?;
                for chunk in &chunks {
                    stmt.execute(params![
                        chunk.id,
                        chunk.collection,
                        chunk.path,
                        chunk.ordinal as i64,
                        chunk.content_hash,
                        chunk.meta_hash,
                        chunk.embed_input_hash,
                        chunk.updated_at,
                    ])
                    .map_err(map_sqlite_error)?;
                }
            }
            // 队列和块在同一个事务里重置:文本阶段写完元数据,队列必然已经在。
            if !pending.is_empty() {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO pending_embeds (collection, chunk_id, path, enqueued_at) \
                         VALUES (?1, ?2, ?3, ?4) ON CONFLICT(collection, chunk_id) DO NOTHING",
                    )
                    .map_err(map_sqlite_error)?;
                for (chunk_id, path) in &pending {
                    stmt.execute(params![collection, chunk_id, path, enqueued_at])
                        .map_err(map_sqlite_error)?;
                }
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn ids_after(
        &self,
        collection: &str,
        after_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ChunkMeta>> {
        let collection = collection.to_owned();
        let after_id = after_id.map(str::to_owned);
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM chunks WHERE collection = ?1 AND id > ?2 \
                     ORDER BY id LIMIT ?3"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(
                    params![collection, after_id.unwrap_or_default(), limit as i64],
                    raw_from_row,
                )
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn updated_since_after(
        &self,
        collection: &str,
        ts: Millis,
        after: Option<(Millis, &str)>,
        limit: u32,
    ) -> Result<Vec<ChunkMeta>> {
        let collection = collection.to_owned();
        let (after_ts, after_id) = match after {
            Some((ts, id)) => (ts, id.to_owned()),
            None => (ts, String::new()),
        };
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM chunks \
                     WHERE collection = ?1 AND updated_at > ?2 \
                       AND (updated_at > ?3 OR (updated_at = ?3 AND id > ?4)) \
                     ORDER BY updated_at, id LIMIT ?5"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(
                    params![collection, ts, after_ts, after_id, limit as i64],
                    raw_from_row,
                )
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn updated_since(
        &self,
        collection: &str,
        ts: Millis,
        limit: u32,
    ) -> Result<Vec<ChunkMeta>> {
        let collection = collection.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM chunks WHERE collection = ?1 AND updated_at > ?2 \
                     ORDER BY updated_at, id LIMIT ?3"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![collection, ts, limit as i64], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn count(&self, collection: &str) -> Result<u64> {
        let collection = collection.to_owned();
        self.read(move |conn| {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM chunks WHERE collection = ?1",
                    params![collection],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            Ok(count as u64)
        })
        .await
    }

    async fn enqueue_pending(
        &self,
        collection: &str,
        chunks: &[(String, String)],
        enqueued_at: Millis,
    ) -> Result<()> {
        if chunks.is_empty() {
            return Ok(());
        }
        let collection = collection.to_owned();
        let chunks = chunks.to_vec();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO pending_embeds (collection, chunk_id, path, enqueued_at) \
                         VALUES (?1, ?2, ?3, ?4) ON CONFLICT(collection, chunk_id) DO NOTHING",
                    )
                    .map_err(map_sqlite_error)?;
                for (chunk_id, path) in &chunks {
                    stmt.execute(params![collection, chunk_id, path, enqueued_at])
                        .map_err(map_sqlite_error)?;
                }
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn pending_count(&self, collection: &str) -> Result<u64> {
        let collection = collection.to_owned();
        self.read(move |conn| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM pending_embeds WHERE collection = ?1",
                    params![collection],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            Ok(count as u64)
        })
        .await
    }

    async fn pending_stats(&self, collection: &str) -> Result<PendingStats> {
        let collection = collection.to_owned();
        self.read(move |conn| {
            let (chunks, files, oldest): (i64, i64, Option<Millis>) = conn
                .query_row(
                    "SELECT COUNT(*), COUNT(DISTINCT path), MIN(enqueued_at) \
                     FROM pending_embeds WHERE collection = ?1",
                    params![collection],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(map_sqlite_error)?;
            Ok(PendingStats {
                chunks: chunks as u64,
                files: files as u64,
                oldest_enqueued_at: oldest,
            })
        })
        .await
    }

    async fn has_pending(&self, collection: &str) -> Result<bool> {
        let collection = collection.to_owned();
        self.read(move |conn| {
            let exists: i64 = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM pending_embeds WHERE collection = ?1)",
                    params![collection],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            Ok(exists != 0)
        })
        .await
    }

    async fn clear_pending(&self, collection: &str, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let collection = collection.to_owned();
        let ids = ids.to_vec();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            // 一批最多 500 个 id(与 Lance 删除批次同量级),避免 SQLite 变量数上限。
            for batch in ids.chunks(500) {
                let placeholders = std::iter::repeat_n("?", batch.len())
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = format!(
                    "DELETE FROM pending_embeds WHERE collection = ?1 AND chunk_id IN ({placeholders})"
                );
                let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(batch.len() + 1);
                values.push(&collection);
                for id in batch {
                    values.push(id);
                }
                tx.execute(&sql, rusqlite::params_from_iter(values))
                    .map_err(map_sqlite_error)?;
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn existing_ids(&self, collection: &str, ids: &[String]) -> Result<Vec<String>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let collection = collection.to_owned();
        let ids = ids.to_vec();
        self.read(move |conn| {
            let mut out = Vec::with_capacity(ids.len());
            // 一批最多 500 个 id,避免 SQLite 变量数上限。
            for batch in ids.chunks(500) {
                let placeholders = std::iter::repeat_n("?", batch.len())
                    .collect::<Vec<_>>()
                    .join(", ");
                let sql = format!(
                    "SELECT id FROM chunks WHERE collection = ?1 AND id IN ({placeholders})"
                );
                let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(batch.len() + 1);
                values.push(&collection);
                for id in batch {
                    values.push(id);
                }
                let mut stmt = conn.prepare(&sql).map_err(map_sqlite_error)?;
                let rows = stmt
                    .query_map(rusqlite::params_from_iter(values), |row| row.get(0))
                    .map_err(map_sqlite_error)?
                    .collect::<rusqlite::Result<Vec<String>>>()
                    .map_err(map_sqlite_error)?;
                out.extend(rows);
            }
            Ok(out)
        })
        .await
    }

    async fn clear_all_pending(&self, collection: &str) -> Result<()> {
        let collection = collection.to_owned();
        self.write(move |conn| {
            conn.execute(
                "DELETE FROM pending_embeds WHERE collection = ?1",
                params![collection],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn pending_for_path(&self, collection: &str, path: &str) -> Result<Vec<String>> {
        let collection = collection.to_owned();
        let path = path.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT chunk_id FROM pending_embeds WHERE collection = ?1 AND path = ?2 \
                     ORDER BY chunk_id",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![collection, path], |row| row.get::<_, String>(0))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn pending_after(
        &self,
        collection: &str,
        after: Option<&str>,
        limit: u32,
    ) -> Result<Vec<PendingChunk>> {
        let collection = collection.to_owned();
        let after = after.map(str::to_owned);
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT chunk_id, path, enqueued_at FROM pending_embeds \
                     WHERE collection = ?1 AND chunk_id > ?2 ORDER BY chunk_id LIMIT ?3",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(
                    params![collection, after.unwrap_or_default(), limit as i64],
                    |row| {
                        Ok(PendingChunk {
                            chunk_id: row.get(0)?,
                            path: row.get(1)?,
                            enqueued_at: row.get(2)?,
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

    async fn set_embed_input_hashes(
        &self,
        collection: &str,
        updates: &[(String, String)],
    ) -> Result<u64> {
        if updates.is_empty() {
            return Ok(0);
        }
        let collection = collection.to_owned();
        let updates = updates.to_vec();
        self.write(move |conn| {
            // 整批放进一个事务:要么全改,要么全不改,调用方失败后可以放心重试同一批
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let mut changed = 0u64;
            {
                // 只写 embed_input_hash 这一列。updated_at 是迁移追平的水位线,
                // 这里改了它,追平就会把没有变化的块再复制一遍。
                let mut stmt = tx
                    .prepare(
                        "UPDATE chunks SET embed_input_hash = ?1 \
                         WHERE collection = ?2 AND id = ?3",
                    )
                    .map_err(map_sqlite_error)?;
                for (id, hash) in &updates {
                    changed += stmt
                        .execute(params![hash, collection, id])
                        .map_err(map_sqlite_error)? as u64;
                }
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(changed)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(collection: &str, id: &str, updated_at: Millis) -> ChunkMeta {
        ChunkMeta {
            id: id.to_owned(),
            collection: collection.to_owned(),
            path: "src/lib.rs".to_owned(),
            ordinal: 3,
            content_hash: format!("content-{id}"),
            meta_hash: format!("meta-{id}"),
            embed_input_hash: format!("old-{id}"),
            updated_at,
        }
    }

    #[tokio::test]
    async fn set_embed_input_hashes_only_changes_that_column() {
        let dir = tempfile::tempdir().expect("临时目录");
        let store = SqliteMetaStore::open(dir.path().join("meta.db")).expect("打开数据库");
        ChunkRepo::replace_for_path(
            &store,
            "proj_a",
            "src/lib.rs",
            vec![chunk("proj_a", "a1", 1_000), chunk("proj_a", "a2", 2_000)],
        )
        .await
        .expect("写 proj_a");
        ChunkRepo::replace_for_path(
            &store,
            "proj_b",
            "src/lib.rs",
            vec![chunk("proj_b", "b1", 3_000)],
        )
        .await
        .expect("写 proj_b");

        // a2 不在更新列表里;"insight-1" 在 chunks 里没有行(迁移写进新表的 id 里有 insight);
        // b1 属于别的 collection,即使 id 对上也不能被改
        let changed = ChunkRepo::set_embed_input_hashes(
            &store,
            "proj_a",
            &[
                ("a1".to_owned(), "new-a1".to_owned()),
                ("insight-1".to_owned(), "new-insight".to_owned()),
                ("b1".to_owned(), "new-b1".to_owned()),
            ],
        )
        .await
        .expect("批量改哈希");
        assert_eq!(changed, 1, "只有 proj_a 里存在的 a1 被改");

        let a = ChunkRepo::by_path(&store, "proj_a", "src/lib.rs")
            .await
            .expect("读 proj_a");
        let mut expected_a1 = chunk("proj_a", "a1", 1_000);
        expected_a1.embed_input_hash = "new-a1".to_owned();
        assert_eq!(
            a[0], expected_a1,
            "除 embed_input_hash 外(含 updated_at)一列都不能变"
        );
        assert_eq!(a[1], chunk("proj_a", "a2", 2_000), "没点名的块原样不动");
        let b = ChunkRepo::by_path(&store, "proj_b", "src/lib.rs")
            .await
            .expect("读 proj_b");
        assert_eq!(
            b,
            vec![chunk("proj_b", "b1", 3_000)],
            "别的 collection 不受影响"
        );

        // 空列表是 no-op
        assert_eq!(
            ChunkRepo::set_embed_input_hashes(&store, "proj_a", &[])
                .await
                .expect("空更新"),
            0
        );
    }
}
