//! `item_versions` 表:文本编辑的版本历史。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::ItemVersion;
use kb_core::ports::repo::VersionRepo;
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

const SELECT_COLUMNS: &str =
    "id, item_id, collection, source, version, title, body, tags, author, batch_id, created_at";

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ItemVersion> {
    let tags: String = row.get(7)?;
    Ok(ItemVersion {
        id: row.get(0)?,
        item_id: row.get(1)?,
        collection: row.get(2)?,
        source: row.get(3)?,
        version: row.get(4)?,
        title: row.get(5)?,
        body: row.get(6)?,
        tags: tags
            .trim_matches(',')
            .split(',')
            .filter(|tag| !tag.is_empty())
            .map(str::to_owned)
            .collect(),
        author: row.get(8)?,
        batch_id: row.get(9)?,
        created_at: row.get(10)?,
    })
}

fn encode_tags(tags: &[String]) -> String {
    if tags.is_empty() {
        String::new()
    } else {
        format!(",{},", tags.join(","))
    }
}

#[async_trait]
impl VersionRepo for SqliteMetaStore {
    async fn create(&self, version: ItemVersion) -> Result<()> {
        let tags = encode_tags(&version.tags);
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO item_versions (id, item_id, collection, source, version, title, body, \
                 tags, author, batch_id, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    version.id,
                    version.item_id,
                    version.collection,
                    version.source,
                    version.version,
                    version.title,
                    version.body,
                    tags,
                    version.author,
                    version.batch_id,
                    version.created_at,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn list(&self, item_id: &str, limit: u32) -> Result<Vec<ItemVersion>> {
        let item_id = item_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM item_versions WHERE item_id = ?1 \
                     ORDER BY version DESC LIMIT ?2"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![item_id, limit.max(1) as i64], |row| {
                    raw_from_row(row)
                })
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(map_sqlite_error)?);
            }
            Ok(out)
        })
        .await
    }

    async fn list_by_source(
        &self,
        collection: &str,
        source: &str,
        limit: u32,
    ) -> Result<Vec<ItemVersion>> {
        let collection = collection.to_owned();
        let source = source.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM item_versions \
                     WHERE collection = ?1 AND source = ?2 ORDER BY version DESC LIMIT ?3"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(
                    params![collection, source, limit.max(1) as i64],
                    raw_from_row,
                )
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(map_sqlite_error)?);
            }
            Ok(out)
        })
        .await
    }

    async fn get(&self, id: &str) -> Result<Option<ItemVersion>> {
        let id = id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                &format!("SELECT {SELECT_COLUMNS} FROM item_versions WHERE id = ?1"),
                params![id],
                raw_from_row,
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn delete_many(&self, ids: &[String]) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let ids = ids.to_vec();
        self.write(move |conn| {
            let mut removed = 0u64;
            for id in &ids {
                removed += conn
                    .execute("DELETE FROM item_versions WHERE id = ?1", params![id])
                    .map_err(map_sqlite_error)? as u64;
            }
            Ok(removed)
        })
        .await
    }

    async fn amend(
        &self,
        id: &str,
        body: &str,
        author: &str,
        at: kb_core::model::Millis,
    ) -> Result<()> {
        let (id, body, author) = (id.to_owned(), body.to_owned(), author.to_owned());
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE item_versions SET body = ?2, author = ?3, created_at = ?4 WHERE id = ?1",
                    params![id, body, author, at],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(kb_core::KbError::NotFound(format!("版本 {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn count_body_containing(&self, needle: &str) -> Result<u64> {
        let needle = needle.to_owned();
        self.read(move |conn| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM item_versions WHERE instr(body, ?1) > 0",
                    params![needle],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            Ok(count as u64)
        })
        .await
    }

    async fn latest_version(&self, item_id: &str) -> Result<i64> {
        let item_id = item_id.to_owned();
        self.read(move |conn| {
            let value: Option<i64> = conn
                .query_row(
                    "SELECT MAX(version) FROM item_versions WHERE item_id = ?1",
                    params![item_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .flatten();
            Ok(value.unwrap_or(0))
        })
        .await
    }

    async fn rekey_source_prefix(&self, collection: &str, from: &str, to: &str) -> Result<u64> {
        let (collection, from, to) = (collection.to_owned(), from.to_owned(), to.to_owned());
        self.write(move |conn| {
            // source 与 item_id 必须一起改:版本历史按 item_id 查,只改 source 会变成空历史。
            let changed = conn
                .execute(
                    "UPDATE OR IGNORE item_versions SET \
                       source = ?3 || substr(source, length(?2) + 1), \
                       item_id = 'file:' || ?1 || ':' || ?3 || substr(source, length(?2) + 1) \
                     WHERE collection = ?1 \
                       AND (source = ?2 OR substr(source, 1, length(?2) + 1) = ?2 || '/')",
                    params![collection, from, to],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed as u64)
        })
        .await
    }

    async fn move_across_collections(
        &self,
        from_collection: &str,
        from: &str,
        to_collection: &str,
        to: &str,
    ) -> Result<u64> {
        let (from_collection, from, to_collection, to) = (
            from_collection.to_owned(),
            from.to_owned(),
            to_collection.to_owned(),
            to.to_owned(),
        );
        self.write(move |conn| {
            // 版本历史的主键 item_id 里带 collection,换库时三个字段必须一起改;
            // 先按段边界匹配旧路径,避免 docs 把 docs2 的版本也搬走。
            let changed = conn
                .execute(
                    "UPDATE item_versions SET \
                       collection = ?3, \
                       source = ?4 || substr(source, length(?2) + 1), \
                       item_id = 'file:' || ?3 || ':' || ?4 || substr(source, length(?2) + 1) \
                     WHERE collection = ?1 \
                       AND (source = ?2 OR substr(source, 1, length(?2) + 1) = ?2 || '/')",
                    params![from_collection, from, to_collection, to],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed as u64)
        })
        .await
    }
}
