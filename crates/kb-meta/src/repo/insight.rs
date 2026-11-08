//! `insights` 表:经验条目(权威数据在 SQLite,LanceDB 只存检索副本)。

use std::collections::HashSet;

use async_trait::async_trait;
use kb_core::model::{Insight, ItemStatus, Millis, Page};
use kb_core::ports::repo::InsightRepo;
use kb_core::{KbError, Result};
use rusqlite::{Connection, OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::{
    json_to_vec, map_sqlite_error, parse_insight_kind, parse_item_status, vec_to_json,
};

const SELECT_COLUMNS: &str = "id, collection, title, body_md, kind, tags_json, related_paths_json, \
     status, version, valid_from, valid_until, superseded_by, created_by, batch_id, created_at, updated_at";

struct RawInsight {
    id: String,
    collection: String,
    title: String,
    body_md: String,
    kind: String,
    tags_json: String,
    related_paths_json: String,
    status: String,
    version: i64,
    valid_from: i64,
    valid_until: Option<i64>,
    superseded_by: Option<String>,
    created_by: String,
    batch_id: Option<String>,
    created_at: i64,
    updated_at: i64,
}

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawInsight> {
    Ok(RawInsight {
        id: row.get(0)?,
        collection: row.get(1)?,
        title: row.get(2)?,
        body_md: row.get(3)?,
        kind: row.get(4)?,
        tags_json: row.get(5)?,
        related_paths_json: row.get(6)?,
        status: row.get(7)?,
        version: row.get(8)?,
        valid_from: row.get(9)?,
        valid_until: row.get(10)?,
        superseded_by: row.get(11)?,
        created_by: row.get(12)?,
        batch_id: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
    })
}

impl RawInsight {
    fn into_insight(self) -> Result<Insight> {
        Ok(Insight {
            kind: parse_insight_kind(&self.kind)?,
            status: parse_item_status(&self.status)?,
            tags: json_to_vec(&self.tags_json)?,
            related_paths: json_to_vec(&self.related_paths_json)?,
            id: self.id,
            collection: self.collection,
            title: self.title,
            body_md: self.body_md,
            version: self.version,
            valid_from: self.valid_from,
            valid_until: self.valid_until,
            superseded_by: self.superseded_by,
            created_by: self.created_by,
            batch_id: self.batch_id,
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

fn get_by_id(conn: &Connection, id: &str) -> Result<Option<Insight>> {
    let raw = conn
        .query_row(
            &format!("SELECT {SELECT_COLUMNS} FROM insights WHERE id = ?1"),
            params![id],
            raw_from_row,
        )
        .optional()
        .map_err(map_sqlite_error)?;
    raw.map(RawInsight::into_insight).transpose()
}

/// 找出把 `id` 取代掉的那条(即 `superseded_by = id` 的条目)。
fn predecessor(conn: &Connection, id: &str) -> Result<Option<Insight>> {
    let raw = conn
        .query_row(
            &format!(
                "SELECT {SELECT_COLUMNS} FROM insights WHERE superseded_by = ?1 \
                 ORDER BY created_at DESC LIMIT 1"
            ),
            params![id],
            raw_from_row,
        )
        .optional()
        .map_err(map_sqlite_error)?;
    raw.map(RawInsight::into_insight).transpose()
}

#[async_trait]
impl InsightRepo for SqliteMetaStore {
    async fn create(&self, insight: Insight) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO insights (id, collection, title, body_md, kind, tags_json, \
                 related_paths_json, status, version, valid_from, valid_until, superseded_by, \
                 created_by, batch_id, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                params![
                    insight.id,
                    insight.collection,
                    insight.title,
                    insight.body_md,
                    insight.kind.as_str(),
                    vec_to_json(&insight.tags),
                    vec_to_json(&insight.related_paths),
                    insight.status.as_str(),
                    insight.version,
                    insight.valid_from,
                    insight.valid_until,
                    insight.superseded_by,
                    insight.created_by,
                    insight.batch_id,
                    insight.created_at,
                    insight.updated_at,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get(&self, id: &str) -> Result<Option<Insight>> {
        let id = id.to_owned();
        self.read(move |conn| get_by_id(conn, &id)).await
    }

    async fn update(&self, insight: Insight, expected_version: i64) -> Result<Insight> {
        let id = insight.id.clone();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE insights SET title = ?3, body_md = ?4, kind = ?5, tags_json = ?6, \
                     related_paths_json = ?7, status = ?8, valid_until = ?9, superseded_by = ?10, \
                     version = version + 1, updated_at = ?11 WHERE id = ?1 AND version = ?2",
                    params![
                        insight.id,
                        expected_version,
                        insight.title,
                        insight.body_md,
                        insight.kind.as_str(),
                        vec_to_json(&insight.tags),
                        vec_to_json(&insight.related_paths),
                        insight.status.as_str(),
                        insight.valid_until,
                        insight.superseded_by,
                        insight.updated_at,
                    ],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return match get_by_id(conn, &id)? {
                    Some(current) => Err(KbError::Conflict {
                        expected: expected_version,
                        actual: current.version,
                    }),
                    None => Err(KbError::NotFound(format!("insight {id}"))),
                };
            }
            get_by_id(conn, &id)?.ok_or_else(|| KbError::NotFound(format!("insight {id}")))
        })
        .await
    }

    async fn created_since(&self, since: Millis) -> Result<Vec<(String, Millis)>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare("SELECT collection, created_at FROM insights WHERE created_at >= ?1")
                .map_err(map_sqlite_error)?;
            stmt.query_map(params![since], |row| Ok((row.get(0)?, row.get(1)?)))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)
        })
        .await
    }

    async fn list(
        &self,
        collection: &str,
        status: Option<ItemStatus>,
        page: Page,
    ) -> Result<Vec<Insight>> {
        let collection = collection.to_owned();
        self.read(move |conn| {
            let mut sql = format!("SELECT {SELECT_COLUMNS} FROM insights WHERE collection = ?1");
            // 占位符编号必须与下面传的参数个数一致
            match status {
                Some(_) => {
                    sql.push_str(" AND status = ?2 ORDER BY updated_at DESC, id LIMIT ?3 OFFSET ?4")
                }
                None => sql.push_str(" ORDER BY updated_at DESC, id LIMIT ?2 OFFSET ?3"),
            }
            let mut stmt = conn.prepare(&sql).map_err(map_sqlite_error)?;
            let status_text = status.map(|value| value.as_str().to_owned());
            let rows = if let Some(status_text) = status_text {
                stmt.query_map(
                    params![
                        collection,
                        status_text,
                        page.limit as i64,
                        page.offset as i64
                    ],
                    raw_from_row,
                )
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?
            } else {
                stmt.query_map(
                    params![collection, page.limit as i64, page.offset as i64],
                    raw_from_row,
                )
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?
            };
            rows.into_iter().map(RawInsight::into_insight).collect()
        })
        .await
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            let changed = conn
                .execute("DELETE FROM insights WHERE id = ?1", params![id])
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("insight {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn history(&self, id: &str) -> Result<Vec<Insight>> {
        let id = id.to_owned();
        self.read(move |conn| {
            if get_by_id(conn, &id)?.is_none() {
                return Err(KbError::NotFound(format!("insight {id}")));
            }
            // 先沿 superseded_by 反向找到最早的条目
            let mut root = id.clone();
            let mut seen: HashSet<String> = HashSet::new();
            seen.insert(root.clone());
            while let Some(previous) = predecessor(conn, &root)? {
                if !seen.insert(previous.id.clone()) {
                    break;
                }
                root = previous.id;
            }
            // 再从最早的一条正向串起来(单独的 visited 防环,不能复用上面的 seen)
            let mut chain = Vec::new();
            let mut visited: HashSet<String> = HashSet::new();
            let mut current = Some(root);
            while let Some(current_id) = current {
                if !visited.insert(current_id.clone()) {
                    break;
                }
                let Some(insight) = get_by_id(conn, &current_id)? else {
                    break;
                };
                current = insight.superseded_by.clone();
                chain.push(insight);
            }
            Ok(chain)
        })
        .await
    }
}
