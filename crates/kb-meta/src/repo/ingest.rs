//! `ingest_files` 表:解析队列。

use async_trait::async_trait;
use kb_core::model::{IngestFile, IngestFilter, IngestState, Millis, Page, SourceIngestStats};
use kb_core::ports::repo::IngestRepo;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

const SELECT_COLUMNS: &str = "id, batch_id, source_id, upload_id, collection, rel_path, abs_path, \
     size, sha256, state, error, chunks, vectors, extract_meta, elapsed_ms, created_at, updated_at, \
     derived_from";

struct RawIngest {
    id: String,
    batch_id: Option<String>,
    source_id: Option<String>,
    upload_id: Option<String>,
    collection: String,
    rel_path: String,
    abs_path: String,
    size: i64,
    sha256: Option<String>,
    state: String,
    error: Option<String>,
    chunks: i64,
    vectors: i64,
    extract_meta: Option<String>,
    elapsed_ms: Option<i64>,
    created_at: i64,
    updated_at: i64,
    derived_from: Option<String>,
}

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawIngest> {
    Ok(RawIngest {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        source_id: row.get(2)?,
        upload_id: row.get(3)?,
        collection: row.get(4)?,
        rel_path: row.get(5)?,
        abs_path: row.get(6)?,
        size: row.get(7)?,
        sha256: row.get(8)?,
        state: row.get(9)?,
        error: row.get(10)?,
        chunks: row.get(11)?,
        vectors: row.get(12)?,
        extract_meta: row.get(13)?,
        elapsed_ms: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        derived_from: row.get(17)?,
    })
}

impl RawIngest {
    fn into_file(self) -> Result<IngestFile> {
        let state = IngestState::parse(&self.state)
            .ok_or_else(|| KbError::Internal(format!("ingest_files.state 未知: {}", self.state)))?;
        Ok(IngestFile {
            id: self.id,
            batch_id: self.batch_id,
            source_id: self.source_id,
            upload_id: self.upload_id,
            collection: self.collection,
            rel_path: self.rel_path,
            abs_path: self.abs_path,
            size: self.size.max(0) as u64,
            sha256: self.sha256,
            state,
            error: self.error,
            chunks: self.chunks.max(0) as u64,
            vectors: self.vectors.max(0) as u64,
            extract_meta: self.extract_meta,
            derived_from: self.derived_from,
            elapsed_ms: self.elapsed_ms.map(|value| value.max(0) as u64),
            created_at: self.created_at,
            updated_at: self.updated_at,
        })
    }
}

/// 把过滤条件拼成 `WHERE` 子句与参数。
///
/// 只用固定列名 + 参数绑定,不拼接任何外部输入(设计规范 §四.5)。
fn where_clause(filter: &IngestFilter) -> (String, Vec<Box<dyn rusqlite::ToSql>>) {
    let mut clauses: Vec<&str> = Vec::new();
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(collection) = &filter.collection {
        clauses.push("collection = ?");
        args.push(Box::new(collection.clone()));
    }
    if let Some(batch_id) = &filter.batch_id {
        clauses.push("batch_id = ?");
        args.push(Box::new(batch_id.clone()));
    }
    if let Some(source_id) = &filter.source_id {
        clauses.push("source_id = ?");
        args.push(Box::new(source_id.clone()));
    }
    if let Some(state) = filter.state {
        clauses.push("state = ?");
        args.push(Box::new(state.as_str().to_owned()));
    }
    let sql = if clauses.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", clauses.join(" AND "))
    };
    (sql, args)
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[async_trait]
impl IngestRepo for SqliteMetaStore {
    async fn create(&self, file: IngestFile) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO ingest_files (id, batch_id, source_id, upload_id, collection, rel_path, \
                 abs_path, size, sha256, state, error, chunks, vectors, extract_meta, elapsed_ms, \
                 created_at, updated_at, derived_from) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
                params![
                    file.id,
                    file.batch_id,
                    file.source_id,
                    file.upload_id,
                    file.collection,
                    file.rel_path,
                    file.abs_path,
                    file.size as i64,
                    file.sha256,
                    file.state.as_str(),
                    file.error,
                    file.chunks as i64,
                    file.vectors as i64,
                    file.extract_meta,
                    file.elapsed_ms.map(|value| value as i64),
                    file.created_at,
                    file.updated_at,
                    file.derived_from,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get(&self, id: &str) -> Result<Option<IngestFile>> {
        let id = id.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM ingest_files WHERE id = ?1"),
                    params![id],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawIngest::into_file).transpose()
        })
        .await
    }

    async fn get_by_path(&self, collection: &str, rel_path: &str) -> Result<Option<IngestFile>> {
        let collection = collection.to_owned();
        let rel_path = rel_path.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!(
                        "SELECT {SELECT_COLUMNS} FROM ingest_files WHERE collection = ?1 AND rel_path = ?2"
                    ),
                    params![collection, rel_path],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawIngest::into_file).transpose()
        })
        .await
    }

    async fn list(&self, filter: IngestFilter, page: Page) -> Result<Vec<IngestFile>> {
        self.read(move |conn| {
            let (where_sql, args) = where_clause(&filter);
            let sql = format!(
                "SELECT {SELECT_COLUMNS} FROM ingest_files{where_sql} \
                 ORDER BY created_at DESC, id LIMIT ? OFFSET ?"
            );
            let mut stmt = conn.prepare(&sql).map_err(map_sqlite_error)?;
            let mut params: Vec<Box<dyn rusqlite::ToSql>> = args;
            params.push(Box::new(i64::from(page.limit)));
            params.push(Box::new(i64::from(page.offset)));
            let refs: Vec<&dyn rusqlite::ToSql> =
                params.iter().map(|value| value.as_ref()).collect();
            let rows = stmt
                .query_map(refs.as_slice(), raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(RawIngest::into_file).collect()
        })
        .await
    }

    async fn count(&self, filter: IngestFilter) -> Result<u64> {
        self.read(move |conn| {
            let (where_sql, args) = where_clause(&filter);
            let sql = format!("SELECT count(*) FROM ingest_files{where_sql}");
            let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|value| value.as_ref()).collect();
            let count: i64 = conn
                .query_row(&sql, refs.as_slice(), |row| row.get(0))
                .map_err(map_sqlite_error)?;
            Ok(count.max(0) as u64)
        })
        .await
    }

    async fn next_queued(&self, batch_id: Option<&str>) -> Result<Option<IngestFile>> {
        let batch_id = batch_id.map(str::to_owned);
        self.read(move |conn| {
            let raw = match batch_id {
                Some(batch_id) => conn.query_row(
                    &format!(
                        "SELECT {SELECT_COLUMNS} FROM ingest_files \
                         WHERE state = 'queued' AND batch_id = ?1 ORDER BY created_at, id LIMIT 1"
                    ),
                    params![batch_id],
                    raw_from_row,
                ),
                None => conn.query_row(
                    &format!(
                        "SELECT {SELECT_COLUMNS} FROM ingest_files \
                         WHERE state = 'queued' ORDER BY created_at, id LIMIT 1"
                    ),
                    [],
                    raw_from_row,
                ),
            };
            let raw = raw.optional().map_err(map_sqlite_error)?;
            raw.map(RawIngest::into_file).transpose()
        })
        .await
    }

    async fn derived_done(&self, batch_id: &str) -> Result<Vec<(String, String)>> {
        let batch_id = batch_id.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT rel_path, derived_from FROM ingest_files \
                     WHERE batch_id = ?1 AND state = 'done' AND derived_from IS NOT NULL \
                     ORDER BY created_at, id",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![batch_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn list_inflight(&self) -> Result<Vec<IngestFile>> {
        self.read(move |conn| {
            let sql = format!(
                "SELECT {SELECT_COLUMNS} FROM ingest_files \
                 WHERE state IN ('extracting', 'chunking', 'embedding') ORDER BY created_at, id"
            );
            let mut stmt = conn.prepare(&sql).map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map([], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(RawIngest::into_file).collect()
        })
        .await
    }

    async fn set_batch(&self, id: &str, batch_id: Option<&str>) -> Result<()> {
        let id = id.to_owned();
        let batch_id = batch_id.map(str::to_owned);
        let at = now_millis();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE ingest_files SET batch_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, batch_id, at],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("ingest file {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn set_state(&self, id: &str, state: IngestState, error: Option<&str>) -> Result<()> {
        let id = id.to_owned();
        let state = state.as_str().to_owned();
        let error = error.map(str::to_owned);
        let at = now_millis();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE ingest_files SET state = ?2, error = ?3, updated_at = ?4 WHERE id = ?1",
                    params![id, state, error, at],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("ingest file {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn stats_by_source(&self, since: Millis) -> Result<Vec<SourceIngestStats>> {
        self.read(move |conn| {
            // 一条 SQL 出全部计数:按 source_id 分组,今日用 created_at 比较
            let mut stmt = conn
                .prepare(
                    "SELECT source_id, \
                            count(*), \
                            sum(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END), \
                            sum(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), \
                            sum(CASE WHEN state = 'quarantined' THEN 1 ELSE 0 END), \
                            sum(CASE WHEN state IN ('queued','extracting','chunking','embedding') THEN 1 ELSE 0 END) \
                     FROM ingest_files GROUP BY source_id",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![since], |row| {
                    Ok(SourceIngestStats {
                        source_id: row.get(0)?,
                        total: row.get::<_, i64>(1)?.max(0) as u64,
                        today: row.get::<_, i64>(2)?.max(0) as u64,
                        failed: row.get::<_, i64>(3)?.max(0) as u64,
                        quarantined: row.get::<_, i64>(4)?.max(0) as u64,
                        pending: row.get::<_, i64>(5)?.max(0) as u64,
                    })
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

    async fn set_extract_meta(&self, id: &str, meta: Option<&str>) -> Result<()> {
        let id = id.to_owned();
        let meta = meta.map(str::to_owned);
        let at = now_millis();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE ingest_files SET extract_meta = ?2, updated_at = ?3 WHERE id = ?1",
                    params![id, meta, at],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("ingest file {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn finish(
        &self,
        id: &str,
        state: IngestState,
        chunks: u64,
        vectors: u64,
        elapsed_ms: u64,
        error: Option<&str>,
    ) -> Result<()> {
        let id = id.to_owned();
        let state = state.as_str().to_owned();
        let error = error.map(str::to_owned);
        let at = now_millis();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE ingest_files SET state = ?2, chunks = ?3, vectors = ?4, elapsed_ms = ?5, \
                     error = ?6, updated_at = ?7 WHERE id = ?1",
                    params![
                        id,
                        state,
                        chunks as i64,
                        vectors as i64,
                        elapsed_ms as i64,
                        error,
                        at
                    ],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("ingest file {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn find_done_by_sha(&self, collection: &str, sha256: &str) -> Result<Option<IngestFile>> {
        let collection = collection.to_owned();
        let sha256 = sha256.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!(
                        "SELECT {SELECT_COLUMNS} FROM ingest_files \
                         WHERE collection = ?1 AND sha256 = ?2 AND state = 'done' \
                         ORDER BY created_at LIMIT 1"
                    ),
                    params![collection, sha256],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawIngest::into_file).transpose()
        })
        .await
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            conn.execute("DELETE FROM ingest_files WHERE id = ?1", params![id])
                .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn repath_prefix(&self, collection: &str, from: &str, to: &str) -> Result<u64> {
        let (collection, from, to) = (collection.to_owned(), from.to_owned(), to.to_owned());
        self.write(move |conn| {
            // abs_path 只在它确实以旧相对路径结尾时才改;不同来源的绝对路径前缀由数据源决定,
            // 这里不做字符串硬拼,避免把 /a/docs 和 /a/docs2 串在一起。
            let changed = conn
                .execute(
                    "UPDATE ingest_files SET \
                       rel_path = ?3 || substr(rel_path, length(?2) + 1), \
                       abs_path = CASE \
                         WHEN substr(abs_path, -length(?2)) = ?2 \
                         THEN substr(abs_path, 1, length(abs_path) - length(?2)) || ?3 \
                         ELSE abs_path END, \
                       updated_at = ?4 \
                     WHERE collection = ?1 \
                       AND (rel_path = ?2 OR substr(rel_path, 1, length(?2) + 1) = ?2 || '/')",
                    params![collection, from, to, now_millis()],
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
        source_id: &str,
        source_root: &str,
        at: Millis,
    ) -> Result<u64> {
        let (from_collection, from, to_collection, to) = (
            from_collection.to_owned(),
            from.to_owned(),
            to_collection.to_owned(),
            to.to_owned(),
        );
        let (source_id, source_root) = (source_id.to_owned(), source_root.to_owned());
        self.write(move |conn| {
            // abs_path 按目标数据源根目录重算,不能用旧前缀硬拼:跨库后物理根已经换了。
            // batch_id / upload_id 必须清空,否则原上传批次的回滚会再次动到这个文件。
            let changed = conn
                .execute(
                    "UPDATE ingest_files SET \
                       collection = ?3, \
                       source_id = ?5, \
                       batch_id = NULL, \
                       upload_id = NULL, \
                       rel_path = ?4 || substr(rel_path, length(?2) + 1), \
                       abs_path = ?6 || '/' || ?4 || substr(rel_path, length(?2) + 1), \
                       updated_at = ?7 \
                     WHERE collection = ?1 \
                       AND (rel_path = ?2 OR substr(rel_path, 1, length(?2) + 1) = ?2 || '/')",
                    params![
                        from_collection,
                        from,
                        to_collection,
                        to,
                        source_id,
                        source_root,
                        at
                    ],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed as u64)
        })
        .await
    }
}
