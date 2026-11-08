//! `doc_links` / `doc_link_sources`:文档链接图谱。
//!
//! 写入按「一篇来源文档」整体替换:先删旧行再插新行,同一个事务完成。
//! 查询只读索引,不碰文件内容;解析和权限判断在 `kb-service` / 能力层做。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{DocLink, DocLinkSource};
use kb_core::ports::repo::DocLinkRepo;
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

const LINK_COLUMNS: &str = "source_kind, source_collection, source_id, source_title, href, line, label, \
     target_kind, target_collection, target_id, reason, indexed_at";

fn link_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocLink> {
    Ok(DocLink {
        source_kind: row.get(0)?,
        source_collection: row.get(1)?,
        source_id: row.get(2)?,
        source_title: row.get(3)?,
        href: row.get(4)?,
        line: row.get::<_, i64>(5)? as u32,
        label: row.get::<_, Option<String>>(6)?.unwrap_or_default(),
        target_kind: row.get(7)?,
        target_collection: row.get(8)?,
        target_id: row.get(9)?,
        reason: row.get(10)?,
        indexed_at: row.get(11)?,
    })
}

fn source_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DocLinkSource> {
    Ok(DocLinkSource {
        source_kind: row.get(0)?,
        collection: row.get(1)?,
        id: row.get(2)?,
        title: row.get(3)?,
        mtime: row.get(4)?,
        indexed_at: row.get(5)?,
    })
}

#[async_trait]
impl DocLinkRepo for SqliteMetaStore {
    async fn replace_source(&self, source: DocLinkSource, links: &[DocLink]) -> Result<()> {
        let links = links.to_vec();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            // 先删旧链接,再写新链接:同一事务,读者看不到半份结果
            tx.execute(
                "DELETE FROM doc_links WHERE source_kind = ?1 AND source_collection = ?2 AND source_id = ?3",
                params![source.source_kind, source.collection, source.id],
            )
            .map_err(map_sqlite_error)?;
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO doc_links (source_kind, source_collection, source_id, source_title, href, line, label, \
                         target_kind, target_collection, target_id, reason, indexed_at) \
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                    )
                    .map_err(map_sqlite_error)?;
                for link in &links {
                    stmt.execute(params![
                        link.source_kind,
                        link.source_collection,
                        link.source_id,
                        link.source_title,
                        link.href,
                        i64::from(link.line),
                        link.label,
                        link.target_kind,
                        link.target_collection,
                        link.target_id,
                        link.reason,
                        link.indexed_at,
                    ])
                    .map_err(map_sqlite_error)?;
                }
            }
            tx.execute(
                "INSERT INTO doc_link_sources (source_kind, source_collection, source_id, source_title, mtime, indexed_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(source_kind, source_collection, source_id) DO UPDATE SET \
                 source_title = excluded.source_title, mtime = excluded.mtime, indexed_at = excluded.indexed_at",
                params![
                    source.source_kind,
                    source.collection,
                    source.id,
                    source.title,
                    source.mtime,
                    source.indexed_at,
                ],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get_source(
        &self,
        source_kind: &str,
        collection: &str,
        id: &str,
    ) -> Result<Option<DocLinkSource>> {
        let (source_kind, collection, id) =
            (source_kind.to_owned(), collection.to_owned(), id.to_owned());
        self.read(move |conn| {
            conn.query_row(
                "SELECT source_kind, source_collection, source_id, source_title, mtime, indexed_at \
                 FROM doc_link_sources WHERE source_kind = ?1 AND source_collection = ?2 AND source_id = ?3",
                params![source_kind, collection, id],
                source_from_row,
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn list_sources(&self, collection: &str) -> Result<Vec<DocLinkSource>> {
        let collection = collection.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT source_kind, source_collection, source_id, source_title, mtime, indexed_at \
                     FROM doc_link_sources WHERE source_collection = ?1 ORDER BY source_id",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![collection], source_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn links_from(
        &self,
        source_kind: &str,
        collection: &str,
        id: &str,
    ) -> Result<Vec<DocLink>> {
        let (source_kind, collection, id) =
            (source_kind.to_owned(), collection.to_owned(), id.to_owned());
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {LINK_COLUMNS} FROM doc_links \
                     WHERE source_kind = ?1 AND source_collection = ?2 AND source_id = ?3 \
                     ORDER BY line, href"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![source_kind, collection, id], link_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn links_to(
        &self,
        target_kind: &str,
        collection: &str,
        id: &str,
        limit: u32,
    ) -> Result<Vec<DocLink>> {
        let (target_kind, collection, id) =
            (target_kind.to_owned(), collection.to_owned(), id.to_owned());
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {LINK_COLUMNS} FROM doc_links \
                     WHERE target_kind = ?1 \
                       AND (target_collection = ?2 OR (target_kind = 'note' AND target_collection IS NULL)) \
                       AND target_id = ?3 \
                     ORDER BY indexed_at DESC, source_collection, source_id, line LIMIT ?4"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(
                    params![target_kind, collection, id, i64::from(limit.max(1))],
                    link_from_row,
                )
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn links_under(
        &self,
        collection: &str,
        path_prefix: &str,
        limit: u32,
    ) -> Result<Vec<DocLink>> {
        let (collection, path_prefix) = (collection.to_owned(), path_prefix.to_owned());
        self.read(move |conn| {
            // 按路径段边界匹配:docs 不会碰到 docs2
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {LINK_COLUMNS} FROM doc_links \
                     WHERE target_kind = 'file' AND target_collection = ?1 \
                       AND (target_id = ?2 OR target_id LIKE ?3) \
                     ORDER BY indexed_at DESC, source_collection, source_id, line LIMIT ?4"
                ))
                .map_err(map_sqlite_error)?;
            let prefix = format!("{}/%", path_prefix.trim_end_matches('/'));
            let rows = stmt
                .query_map(
                    params![collection, path_prefix, prefix, i64::from(limit.max(1))],
                    link_from_row,
                )
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn links_from_under(
        &self,
        collection: &str,
        path_prefix: &str,
        limit: u32,
    ) -> Result<Vec<DocLink>> {
        let (collection, path_prefix) = (collection.to_owned(), path_prefix.to_owned());
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {LINK_COLUMNS} FROM doc_links \
                     WHERE source_kind = 'file' AND source_collection = ?1 \
                       AND (source_id = ?2 OR source_id LIKE ?3) \
                     ORDER BY line, href LIMIT ?4"
                ))
                .map_err(map_sqlite_error)?;
            let prefix = format!("{}/%", path_prefix.trim_end_matches('/'));
            let rows = stmt
                .query_map(
                    params![collection, path_prefix, prefix, i64::from(limit.max(1))],
                    link_from_row,
                )
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn rename_source(
        &self,
        source_kind: &str,
        collection: &str,
        old_id: &str,
        new_id: &str,
    ) -> Result<()> {
        let (source_kind, collection, old_id, new_id) = (
            source_kind.to_owned(),
            collection.to_owned(),
            old_id.to_owned(),
            new_id.to_owned(),
        );
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            tx.execute(
                "UPDATE doc_links SET source_id = ?4 WHERE source_kind = ?1 AND source_collection = ?2 AND source_id = ?3",
                params![source_kind, collection, old_id, new_id],
            )
            .map_err(map_sqlite_error)?;
            tx.execute(
                "UPDATE doc_link_sources SET source_id = ?4 WHERE source_kind = ?1 AND source_collection = ?2 AND source_id = ?3",
                params![source_kind, collection, old_id, new_id],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn mark_target_missing(&self, collection: &str, path_prefix: &str) -> Result<()> {
        let (collection, path_prefix) = (collection.to_owned(), path_prefix.to_owned());
        self.write(move |conn| {
            conn.execute(
                "UPDATE doc_links SET reason = '文件已被移动或删除，链接需要重新指向' \
                 WHERE target_kind = 'file' AND target_collection = ?1 \
                   AND (target_id = ?2 OR target_id LIKE ?3)",
                params![
                    collection,
                    path_prefix,
                    format!("{}/%", path_prefix.trim_end_matches('/'))
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn delete_source(&self, source_kind: &str, collection: &str, id: &str) -> Result<()> {
        let (source_kind, collection, id) =
            (source_kind.to_owned(), collection.to_owned(), id.to_owned());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            tx.execute(
                "DELETE FROM doc_links WHERE source_kind = ?1 AND source_collection = ?2 AND source_id = ?3",
                params![source_kind, collection, id],
            )
            .map_err(map_sqlite_error)?;
            tx.execute(
                "DELETE FROM doc_link_sources WHERE source_kind = ?1 AND source_collection = ?2 AND source_id = ?3",
                params![source_kind, collection, id],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn purge_collection(&self, collection: &str) -> Result<()> {
        let collection = collection.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            tx.execute(
                "DELETE FROM doc_links WHERE source_collection = ?1",
                params![collection],
            )
            .map_err(map_sqlite_error)?;
            tx.execute(
                "DELETE FROM doc_link_sources WHERE source_collection = ?1",
                params![collection],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}
