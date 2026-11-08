//! `sources` 表:数据源。

use async_trait::async_trait;
use kb_core::model::{Millis, Source, SourceAiStatus, SourceKind, SourceStatus};
use kb_core::ports::repo::SourceRepo;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::{json_to_vec, map_sqlite_error, vec_to_json};

const SELECT_COLUMNS: &str = "id, kind, name, uri, collection, tags_json, include_json, exclude_json, \
     depth, allow_hosts_json, refresh_minutes, status, last_synced_at, last_error, files, created_at, \
     ai_extract, extract_prompt, ai_status_json";

struct RawSource {
    id: String,
    kind: String,
    name: String,
    uri: String,
    collection: String,
    tags_json: String,
    include_json: String,
    exclude_json: String,
    depth: i64,
    allow_hosts_json: String,
    refresh_minutes: Option<i64>,
    status: String,
    last_synced_at: Option<i64>,
    last_error: Option<String>,
    files: i64,
    created_at: i64,
    ai_extract: i64,
    extract_prompt: String,
    ai_status_json: Option<String>,
}

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawSource> {
    Ok(RawSource {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        uri: row.get(3)?,
        collection: row.get(4)?,
        tags_json: row.get(5)?,
        include_json: row.get(6)?,
        exclude_json: row.get(7)?,
        depth: row.get(8)?,
        allow_hosts_json: row.get(9)?,
        refresh_minutes: row.get(10)?,
        status: row.get(11)?,
        last_synced_at: row.get(12)?,
        last_error: row.get(13)?,
        files: row.get(14)?,
        created_at: row.get(15)?,
        ai_extract: row.get(16)?,
        extract_prompt: row.get(17)?,
        ai_status_json: row.get(18)?,
    })
}

impl RawSource {
    fn into_source(self) -> Result<Source> {
        let kind = SourceKind::parse(&self.kind)
            .ok_or_else(|| KbError::Internal(format!("sources.kind 未知: {}", self.kind)))?;
        let status = SourceStatus::parse(&self.status)
            .ok_or_else(|| KbError::Internal(format!("sources.status 未知: {}", self.status)))?;
        // 整理情况只是展示用:读坏了(手工改库 / 旧版本写的)就当没跑过,不让整个列表读不出来
        let ai_status = self
            .ai_status_json
            .as_deref()
            .and_then(|text| serde_json::from_str::<SourceAiStatus>(text).ok());
        Ok(Source {
            id: self.id,
            kind,
            name: self.name,
            uri: self.uri,
            collection: self.collection,
            tags: json_to_vec(&self.tags_json)?,
            include: json_to_vec(&self.include_json)?,
            exclude: json_to_vec(&self.exclude_json)?,
            depth: u32::try_from(self.depth)
                .map_err(|_| KbError::Internal(format!("sources.depth 非法: {}", self.depth)))?,
            allow_hosts: json_to_vec(&self.allow_hosts_json)?,
            refresh_minutes: self.refresh_minutes.map(|value| value.max(0) as u64),
            status,
            last_synced_at: self.last_synced_at,
            last_error: self.last_error,
            files: self.files.max(0) as u64,
            created_at: self.created_at,
            ai_extract: self.ai_extract != 0,
            extract_prompt: self.extract_prompt,
            ai_status,
        })
    }
}

/// 整理情况序列化成 JSON 列(`None` 写 NULL)。
fn ai_status_to_json(status: Option<&SourceAiStatus>) -> Result<Option<String>> {
    status
        .map(|status| {
            serde_json::to_string(status)
                .map_err(|err| KbError::Internal(format!("序列化 ai_status 失败: {err}")))
        })
        .transpose()
}

#[async_trait]
impl SourceRepo for SqliteMetaStore {
    async fn create(&self, source: Source) -> Result<()> {
        let ai_status = ai_status_to_json(source.ai_status.as_ref())?;
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO sources (id, kind, name, uri, collection, tags_json, include_json, \
                 exclude_json, depth, allow_hosts_json, refresh_minutes, status, last_synced_at, \
                 last_error, files, created_at, ai_extract, extract_prompt, ai_status_json) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, \
                 ?17, ?18, ?19)",
                params![
                    source.id,
                    source.kind.as_str(),
                    source.name,
                    source.uri,
                    source.collection,
                    vec_to_json(&source.tags),
                    vec_to_json(&source.include),
                    vec_to_json(&source.exclude),
                    i64::from(source.depth),
                    vec_to_json(&source.allow_hosts),
                    source.refresh_minutes.map(|value| value as i64),
                    source.status.as_str(),
                    source.last_synced_at,
                    source.last_error,
                    source.files as i64,
                    source.created_at,
                    i64::from(source.ai_extract),
                    source.extract_prompt,
                    ai_status,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get(&self, id: &str) -> Result<Option<Source>> {
        let id = id.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM sources WHERE id = ?1"),
                    params![id],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawSource::into_source).transpose()
        })
        .await
    }

    async fn get_by_name(&self, name: &str) -> Result<Option<Source>> {
        let name = name.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM sources WHERE name = ?1"),
                    params![name],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawSource::into_source).transpose()
        })
        .await
    }

    async fn list(&self) -> Result<Vec<Source>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SELECT_COLUMNS} FROM sources ORDER BY created_at DESC, id"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map([], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(RawSource::into_source).collect()
        })
        .await
    }

    async fn update(&self, source: Source) -> Result<()> {
        let id = source.id.clone();
        // `ai_status_json` 不在这里写:它由后台的 AI 规范化任务用 `set_ai_status` 单独回写,
        // 同步 / 编辑拿的是开始时读到的旧行,整行覆盖会把任务刚写的整理情况冲掉
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE sources SET kind = ?2, name = ?3, uri = ?4, collection = ?5, \
                     tags_json = ?6, include_json = ?7, exclude_json = ?8, depth = ?9, \
                     allow_hosts_json = ?10, refresh_minutes = ?11, status = ?12, \
                     last_synced_at = ?13, last_error = ?14, files = ?15, ai_extract = ?16, \
                     extract_prompt = ?17 WHERE id = ?1",
                    params![
                        source.id,
                        source.kind.as_str(),
                        source.name,
                        source.uri,
                        source.collection,
                        vec_to_json(&source.tags),
                        vec_to_json(&source.include),
                        vec_to_json(&source.exclude),
                        i64::from(source.depth),
                        vec_to_json(&source.allow_hosts),
                        source.refresh_minutes.map(|value| value as i64),
                        source.status.as_str(),
                        source.last_synced_at,
                        source.last_error,
                        source.files as i64,
                        i64::from(source.ai_extract),
                        source.extract_prompt,
                    ],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("source {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn delete(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            let changed = conn
                .execute("DELETE FROM sources WHERE id = ?1", params![id])
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("source {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn set_status(
        &self,
        id: &str,
        status: &str,
        error: Option<&str>,
        synced_at: Option<Millis>,
    ) -> Result<()> {
        let id = id.to_owned();
        let status = status.to_owned();
        let error = error.map(str::to_owned);
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE sources SET status = ?2, last_error = ?3, \
                     last_synced_at = COALESCE(?4, last_synced_at) WHERE id = ?1",
                    params![id, status, error, synced_at],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("source {id}")));
            }
            Ok(())
        })
        .await
    }

    async fn set_file_count(&self, id: &str, files: u64) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE sources SET files = ?2 WHERE id = ?1",
                params![id, files as i64],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn set_ai_status(&self, id: &str, status: Option<SourceAiStatus>) -> Result<()> {
        let id = id.to_owned();
        let json = ai_status_to_json(status.as_ref())?;
        self.write(move |conn| {
            // 数据源可能在任务跑的时候被删掉了:没有这一行就什么都不做,不算错
            conn.execute(
                "UPDATE sources SET ai_status_json = ?2 WHERE id = ?1",
                params![id, json],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}
