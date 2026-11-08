//! `chunk_context` 表:LLM 上下文缓存。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::Millis;
use kb_core::ports::repo::ContextRepo;
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

#[async_trait]
impl ContextRepo for SqliteMetaStore {
    async fn get_context(&self, content_hash: &str) -> Result<Option<String>> {
        let content_hash = content_hash.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT context FROM chunk_context WHERE content_hash = ?1",
                params![content_hash],
                |row| row.get(0),
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn put_context(
        &self,
        content_hash: &str,
        context: &str,
        model: &str,
        at: Millis,
    ) -> Result<()> {
        let content_hash = content_hash.to_owned();
        let context = context.to_owned();
        let model = model.to_owned();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO chunk_context (content_hash, context, model, created_at) \
                 VALUES (?1, ?2, ?3, ?4) \
                 ON CONFLICT(content_hash) DO UPDATE SET context = excluded.context, \
                 model = excluded.model, created_at = excluded.created_at",
                params![content_hash, context, model, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}
