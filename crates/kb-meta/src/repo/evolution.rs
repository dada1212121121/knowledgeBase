//! `evolution_exclusions` 表与草稿侧的指纹 / 向量查询。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{DraftState, Millis};
use kb_core::ports::repo::EvolutionRepo;
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::repo::draft::draft_state_text;
use crate::sql::map_sqlite_error;

fn encode_vector(vector: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vector.len() * 4);
    for value in vector {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

fn decode_vector(bytes: &[u8]) -> Vec<f32> {
    bytes
        .as_chunks::<4>()
        .0
        .iter()
        .map(|chunk| f32::from_le_bytes(*chunk))
        .collect()
}

#[async_trait]
impl EvolutionRepo for SqliteMetaStore {
    async fn exclude(
        &self,
        collection: &str,
        fingerprint: &str,
        embedding: Option<Vec<f32>>,
        embedder_id: Option<&str>,
        reason: &str,
        at: Millis,
    ) -> Result<()> {
        let collection = collection.to_owned();
        let fingerprint = fingerprint.to_owned();
        let reason = reason.to_owned();
        let embedder_id = embedder_id.map(str::to_owned);
        let blob = embedding.as_deref().map(encode_vector);
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO evolution_exclusions \
                 (collection, fingerprint, embedding, embedder_id, reason, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6) \
                 ON CONFLICT(collection, fingerprint) DO UPDATE SET \
                 embedding = excluded.embedding, embedder_id = excluded.embedder_id, \
                 reason = excluded.reason, created_at = excluded.created_at",
                params![collection, fingerprint, blob, embedder_id, reason, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn is_excluded(&self, collection: &str, fingerprint: &str) -> Result<bool> {
        let collection = collection.to_owned();
        let fingerprint = fingerprint.to_owned();
        self.read(move |conn| {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM evolution_exclusions WHERE collection = ?1 AND fingerprint = ?2",
                    params![collection, fingerprint],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            Ok(found.is_some())
        })
        .await
    }

    async fn excluded_vectors(
        &self,
        collection: &str,
        embedder_id: &str,
        limit: u32,
    ) -> Result<Vec<(String, Vec<f32>)>> {
        let collection = collection.to_owned();
        let embedder_id = embedder_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT fingerprint, embedding FROM evolution_exclusions \
                     WHERE collection = ?1 AND embedder_id = ?2 AND embedding IS NOT NULL \
                     ORDER BY created_at DESC LIMIT ?3",
                )
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(
                    params![collection, embedder_id, limit.max(1) as i64],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?)),
                )
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for row in rows {
                let (fingerprint, blob) = row.map_err(map_sqlite_error)?;
                out.push((fingerprint, decode_vector(&blob)));
            }
            Ok(out)
        })
        .await
    }

    async fn draft_exists(&self, collection: &str, fingerprint: &str) -> Result<bool> {
        let collection = collection.to_owned();
        let fingerprint = fingerprint.to_owned();
        self.read(move |conn| {
            let found: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM drafts WHERE collection = ?1 AND fingerprint = ?2 LIMIT 1",
                    params![collection, fingerprint],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            Ok(found.is_some())
        })
        .await
    }

    async fn draft_vectors(
        &self,
        collection: &str,
        embedder_id: &str,
        states: &[DraftState],
        limit: u32,
    ) -> Result<Vec<(String, Vec<f32>)>> {
        let collection = collection.to_owned();
        let embedder_id = embedder_id.to_owned();
        let state_count = states.len();
        let placeholders: Vec<String> = (0..state_count)
            .map(|index| format!("?{}", index + 3))
            .collect();
        let states_sql = placeholders.join(", ");
        let state_values: Vec<String> = states
            .iter()
            .map(|state| draft_state_text(*state).to_owned())
            .collect();
        self.read(move |conn| {
            let sql = format!(
                "SELECT id, embedding FROM drafts \
                 WHERE collection = ?1 AND embedder_id = ?2 AND embedding IS NOT NULL \
                 AND state IN ({states_sql}) ORDER BY created_at DESC LIMIT ?{}",
                state_count + 3
            );
            let mut statement = conn.prepare(&sql).map_err(map_sqlite_error)?;
            let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            values.push(Box::new(collection.clone()));
            values.push(Box::new(embedder_id.clone()));
            for state in state_values {
                values.push(Box::new(state));
            }
            values.push(Box::new(limit.max(1) as i64));
            let refs: Vec<&dyn rusqlite::ToSql> =
                values.iter().map(|value| value.as_ref()).collect();
            let rows = statement
                .query_map(refs.as_slice(), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for row in rows {
                let (id, blob) = row.map_err(map_sqlite_error)?;
                out.push((id, decode_vector(&blob)));
            }
            Ok(out)
        })
        .await
    }
}
