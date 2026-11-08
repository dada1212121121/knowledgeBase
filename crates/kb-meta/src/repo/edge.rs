//! `edges` 表:轻量关系。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Edge, EdgeRel};
use kb_core::ports::repo::EdgeRepo;
use rusqlite::params;

use crate::SqliteMetaStore;
use crate::sql::{map_sqlite_error, parse_edge_rel};

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, String, i64)> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
}

fn into_edge((src_id, dst, rel, created_at): (String, String, String, i64)) -> Result<Edge> {
    Ok(Edge {
        src_id,
        dst,
        rel: parse_edge_rel(&rel)?,
        created_at,
    })
}

#[async_trait]
impl EdgeRepo for SqliteMetaStore {
    async fn add(&self, edge: Edge) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO edges (src_id, dst, rel, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![edge.src_id, edge.dst, edge.rel.as_str(), edge.created_at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn by_src(&self, src_id: &str) -> Result<Vec<Edge>> {
        let src_id = src_id.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT src_id, dst, rel, created_at FROM edges WHERE src_id = ?1 ORDER BY dst",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![src_id], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(into_edge).collect()
        })
        .await
    }

    async fn by_dst(&self, dst: &str) -> Result<Vec<Edge>> {
        let dst = dst.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT src_id, dst, rel, created_at FROM edges WHERE dst = ?1 ORDER BY src_id",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![dst], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(into_edge).collect()
        })
        .await
    }

    async fn remove(&self, src_id: &str, dst: &str, rel: EdgeRel) -> Result<()> {
        let src_id = src_id.to_owned();
        let dst = dst.to_owned();
        self.write(move |conn| {
            conn.execute(
                "DELETE FROM edges WHERE src_id = ?1 AND dst = ?2 AND rel = ?3",
                params![src_id, dst, rel.as_str()],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn remove_by_dst(&self, dst: &str) -> Result<u64> {
        let dst = dst.to_owned();
        self.write(move |conn| {
            let removed = conn
                .execute("DELETE FROM edges WHERE dst = ?1", params![dst])
                .map_err(map_sqlite_error)?;
            Ok(removed as u64)
        })
        .await
    }

    async fn rekey_dst(&self, from: &str, to: &str) -> Result<u64> {
        let (from, to) = (from.to_owned(), to.to_owned());
        self.write(move |conn| {
            // 只改精确路径。边表没有 collection 列,跨集合同路径本来就分不开;
            // 调用方只在移动的文件确实属于该边时传 from(见 FileOpsService)。
            let changed = conn
                .execute(
                    "UPDATE OR IGNORE edges SET dst = ?2 WHERE dst = ?1",
                    params![from, to],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed as u64)
        })
        .await
    }
}
