//! `annotations` 表:批注。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Anchor, Annotation};
use kb_core::ports::repo::AnnotationRepo;
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

const SELECT_COLUMNS: &str = "id, collection, source, anchor_json, body, author, record_id, \
     created_at, updated_at, parent_id, resolved_at, resolved_by, mentions_json";

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Annotation> {
    let anchor_json: Option<String> = row.get(3)?;
    Ok(Annotation {
        id: row.get(0)?,
        collection: row.get(1)?,
        source: row.get(2)?,
        anchor: anchor_json.and_then(|json| serde_json::from_str::<Anchor>(&json).ok()),
        body: row.get(4)?,
        author: row.get(5)?,
        record_id: row.get(6)?,
        parent_id: row.get(9)?,
        resolved_at: row.get(10)?,
        resolved_by: row.get(11)?,
        mentions: serde_json::from_str(&row.get::<_, String>(12)?).unwrap_or_default(),
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

#[async_trait]
impl AnnotationRepo for SqliteMetaStore {
    async fn create(&self, annotation: Annotation) -> Result<()> {
        let anchor_json = annotation
            .anchor
            .as_ref()
            .and_then(|anchor| serde_json::to_string(anchor).ok());
        let mentions_json =
            serde_json::to_string(&annotation.mentions).unwrap_or_else(|_| "[]".to_owned());
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO annotations (id, collection, source, anchor_json, body, author, \
                 record_id, created_at, updated_at, parent_id, resolved_at, resolved_by, mentions_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
                params![
                    annotation.id,
                    annotation.collection,
                    annotation.source,
                    anchor_json,
                    annotation.body,
                    annotation.author,
                    annotation.record_id,
                    annotation.created_at,
                    annotation.updated_at,
                    annotation.parent_id,
                    annotation.resolved_at,
                    annotation.resolved_by,
                    mentions_json,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn list_by_author_prefix(&self, prefix: &str, limit: u32) -> Result<Vec<Annotation>> {
        // LIKE 里的 % 和 _ 都要转义:前缀里带 `_` 的昵称不能匹配到别人
        let pattern = format!(
            "{}%",
            prefix
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM annotations WHERE author LIKE ?1 ESCAPE '\\' \
                     ORDER BY created_at DESC LIMIT ?2"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![pattern, limit.max(1) as i64], raw_from_row)
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
    ) -> Result<Vec<Annotation>> {
        let collection = collection.to_owned();
        let source = source.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM annotations WHERE collection = ?1 AND source = ?2 \
                     ORDER BY created_at DESC LIMIT ?3"
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

    async fn get(&self, id: &str) -> Result<Option<Annotation>> {
        let id = id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                &format!("SELECT {SELECT_COLUMNS} FROM annotations WHERE id = ?1"),
                params![id],
                raw_from_row,
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            conn.execute("DELETE FROM annotations WHERE id = ?1", params![id])
                .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn list_replies(&self, parent_id: &str) -> Result<Vec<Annotation>> {
        let parent_id = parent_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM annotations WHERE parent_id = ?1 \
                     ORDER BY created_at ASC"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![parent_id], raw_from_row)
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(map_sqlite_error)?);
            }
            Ok(out)
        })
        .await
    }

    async fn set_resolved(
        &self,
        id: &str,
        resolved_at: Option<kb_core::model::Millis>,
        resolved_by: Option<&str>,
    ) -> Result<()> {
        let (id, resolved_by) = (id.to_owned(), resolved_by.map(str::to_owned));
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE annotations SET resolved_at = ?2, resolved_by = ?3 WHERE id = ?1",
                    params![id, resolved_at, resolved_by],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(kb_core::KbError::NotFound(format!("批注 {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn rekey_source_prefix(&self, collection: &str, from: &str, to: &str) -> Result<u64> {
        let (collection, from, to) = (collection.to_owned(), from.to_owned(), to.to_owned());
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE annotations SET source = ?3 || substr(source, length(?2) + 1) \
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
            // 批注 id 不变(评论的回复关系、@ 都靠它),只换归属集合和文件路径。
            let changed = conn
                .execute(
                    "UPDATE annotations SET \
                       collection = ?3, \
                       source = ?4 || substr(source, length(?2) + 1) \
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
