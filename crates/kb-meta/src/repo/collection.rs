//! `collections` 表。

use async_trait::async_trait;
use kb_core::model::{Collection, CollectionKind, ContextMode};
use kb_core::ports::repo::CollectionRepo;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::{
    json_to_vec, map_sqlite_error, parse_collection_kind, parse_context_mode, vec_to_json,
};

const SELECT_COLUMNS: &str = "name, kind, project_id, embedder_id, dim, active_table, table_version, \
     migrating_to, migration_started_at, retired_tables_json, context_mode, created_at";

struct RawCollection {
    name: String,
    kind: String,
    project_id: Option<String>,
    embedder_id: String,
    dim: i64,
    active_table: String,
    table_version: i64,
    migrating_to: Option<String>,
    migration_started_at: Option<i64>,
    retired_tables_json: String,
    context_mode: String,
    created_at: i64,
}

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawCollection> {
    Ok(RawCollection {
        name: row.get(0)?,
        kind: row.get(1)?,
        project_id: row.get(2)?,
        embedder_id: row.get(3)?,
        dim: row.get(4)?,
        active_table: row.get(5)?,
        table_version: row.get(6)?,
        migrating_to: row.get(7)?,
        migration_started_at: row.get(8)?,
        retired_tables_json: row.get(9)?,
        context_mode: row.get(10)?,
        created_at: row.get(11)?,
    })
}

impl RawCollection {
    fn into_collection(self) -> Result<Collection> {
        Ok(Collection {
            kind: parse_collection_kind(&self.kind)?,
            context_mode: parse_context_mode(&self.context_mode)?,
            retired_tables: json_to_vec(&self.retired_tables_json)?,
            dim: usize::try_from(self.dim)
                .map_err(|_| KbError::Internal(format!("collections.dim 非法: {}", self.dim)))?,
            table_version: u32::try_from(self.table_version).map_err(|_| {
                KbError::Internal(format!(
                    "collections.table_version 非法: {}",
                    self.table_version
                ))
            })?,
            name: self.name,
            project_id: self.project_id,
            embedder_id: self.embedder_id,
            active_table: self.active_table,
            migrating_to: self.migrating_to,
            migration_started_at: self.migration_started_at,
            created_at: self.created_at,
        })
    }
}

/// 从物理表名 `{coll}__{slug}__v{n}` 里取出 n;解析失败时退回 1。
fn table_version_of(table: &str) -> i64 {
    table
        .rsplit("__v")
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1)
}

#[async_trait]
impl CollectionRepo for SqliteMetaStore {
    async fn create(&self, collection: Collection) -> Result<()> {
        let kind = match collection.kind {
            CollectionKind::Global => "global",
            CollectionKind::Project => "project",
            CollectionKind::External => "external",
        };
        let context_mode = match collection.context_mode {
            ContextMode::Header => "header",
            ContextMode::Llm => "llm",
        };
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO collections (name, kind, project_id, embedder_id, dim, active_table, \
                 table_version, migrating_to, migration_started_at, retired_tables_json, context_mode, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    collection.name,
                    kind,
                    collection.project_id,
                    collection.embedder_id,
                    collection.dim as i64,
                    collection.active_table,
                    collection.table_version as i64,
                    collection.migrating_to,
                    collection.migration_started_at,
                    vec_to_json(&collection.retired_tables),
                    context_mode,
                    collection.created_at,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get(&self, name: &str) -> Result<Option<Collection>> {
        let name = name.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM collections WHERE name = ?1"),
                    params![name],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawCollection::into_collection).transpose()
        })
        .await
    }

    async fn list(&self) -> Result<Vec<Collection>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM collections ORDER BY created_at, name"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map([], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter()
                .map(RawCollection::into_collection)
                .collect()
        })
        .await
    }

    async fn update(&self, collection: Collection) -> Result<()> {
        let kind = match collection.kind {
            CollectionKind::Global => "global",
            CollectionKind::Project => "project",
            CollectionKind::External => "external",
        };
        let context_mode = match collection.context_mode {
            ContextMode::Header => "header",
            ContextMode::Llm => "llm",
        };
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE collections SET kind = ?2, project_id = ?3, embedder_id = ?4, dim = ?5, \
                     active_table = ?6, table_version = ?7, migrating_to = ?8, migration_started_at = ?9, \
                     retired_tables_json = ?10, context_mode = ?11 WHERE name = ?1",
                    params![
                        collection.name,
                        kind,
                        collection.project_id,
                        collection.embedder_id,
                        collection.dim as i64,
                        collection.active_table,
                        collection.table_version as i64,
                        collection.migrating_to,
                        collection.migration_started_at,
                        vec_to_json(&collection.retired_tables),
                        context_mode,
                    ],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("collection {}", collection.name)));
            }
            Ok(())
        })
        .await
    }

    async fn delete(&self, name: &str) -> Result<()> {
        let name = name.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            purge_collection_data(&tx, &name)?;
            let changed = tx
                .execute("DELETE FROM collections WHERE name = ?1", params![name])
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("collection {name}")));
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn purge_data(&self, name: &str) -> Result<()> {
        let name = name.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            purge_collection_data(&tx, &name)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn switch_active(
        &self,
        name: &str,
        new_table: &str,
        embedder_id: &str,
        dim: usize,
    ) -> Result<()> {
        let name = name.to_owned();
        let new_table = new_table.to_owned();
        let embedder_id = embedder_id.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let (active_table, retired_json): (String, String) = tx
                .query_row(
                    "SELECT active_table, retired_tables_json FROM collections WHERE name = ?1",
                    params![name],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .ok_or_else(|| KbError::NotFound(format!("collection {name}")))?;
            let mut retired = json_to_vec(&retired_json)?;
            if active_table != new_table && !retired.contains(&active_table) {
                retired.push(active_table);
            }
            tx.execute(
                "UPDATE collections SET active_table = ?2, embedder_id = ?3, dim = ?4, \
                 table_version = ?5, retired_tables_json = ?6, migrating_to = NULL, \
                 migration_started_at = NULL WHERE name = ?1",
                params![
                    name,
                    new_table,
                    embedder_id,
                    dim as i64,
                    table_version_of(&new_table),
                    vec_to_json(&retired),
                ],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}

/// 在一个事务里清掉某个 collection 的派生数据。
///
/// 只有 `files` 与 `sources` 带 `ON DELETE CASCADE`;`chunks` / `insights` / 草稿 / 版本 /
/// 批注 / 解析队列 / 上传会话都只存了 collection 名字。删集合时如果不显式清掉,
/// 同名重建集合后增量 diff 会把这些孤儿 `chunks` 当成“没变的块”跳过,新的向量表永远是空的。
fn purge_collection_data(tx: &rusqlite::Transaction<'_>, name: &str) -> Result<()> {
    // 关系边按 id 引用 chunks / insights,必须在它们被删之前清掉
    tx.execute(
        "DELETE FROM edges WHERE src_id IN (SELECT id FROM chunks WHERE collection = ?1) \
         OR src_id IN (SELECT id FROM insights WHERE collection = ?1)",
        params![name],
    )
    .map_err(map_sqlite_error)?;
    for sql in [
        // 文本优先索引的待嵌入队列也按 collection 名存,删集合时要一起清
        "DELETE FROM pending_embeds WHERE collection = ?1",
        "DELETE FROM chunks WHERE collection = ?1",
        // 链接图谱同样只存 collection 名字,删集合时必须一起清掉
        "DELETE FROM doc_links WHERE source_collection = ?1",
        "DELETE FROM doc_link_sources WHERE source_collection = ?1",
        "DELETE FROM insights WHERE collection = ?1",
        "DELETE FROM drafts WHERE collection = ?1",
        "DELETE FROM item_versions WHERE collection = ?1",
        "DELETE FROM annotations WHERE collection = ?1",
        "DELETE FROM evolution_exclusions WHERE collection = ?1",
        "DELETE FROM ingest_stage_events WHERE file_id IN \
         (SELECT id FROM ingest_files WHERE collection = ?1)",
        "DELETE FROM ingest_files WHERE collection = ?1",
        "DELETE FROM ingest_batches WHERE collection = ?1",
        "DELETE FROM upload_parts WHERE upload_id IN \
         (SELECT id FROM uploads WHERE collection = ?1)",
        "DELETE FROM uploads WHERE collection = ?1",
        // 这两张表本来就会随 collections 行级联;显式删一次,让 purge_data(没有 collection 行时)
        // 也能清掉历史遗留的孤儿行
        "DELETE FROM files WHERE collection = ?1",
        "DELETE FROM sources WHERE collection = ?1",
    ] {
        tx.execute(sql, params![name]).map_err(map_sqlite_error)?;
    }
    Ok(())
}
