//! `settings` / `sessions` / `api_tokens` 表(早期实现)。

use async_trait::async_trait;
use kb_core::model::{ApiToken, Millis, Session};
use kb_core::ports::repo::AuthRepo;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

#[async_trait]
impl AuthRepo for SqliteMetaStore {
    async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        let key = key.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        let key = key.to_owned();
        let value = value.to_owned();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn create_session(&self, session: Session) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO sessions (token_hash, created_at, expires_at, last_seen, user_agent) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    session.token_hash,
                    session.created_at,
                    session.expires_at,
                    session.last_seen,
                    session.user_agent,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn get_session(&self, token_hash: &str) -> Result<Option<Session>> {
        let token_hash = token_hash.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT token_hash, created_at, expires_at, last_seen, user_agent \
                 FROM sessions WHERE token_hash = ?1",
                params![token_hash],
                |row| {
                    Ok(Session {
                        token_hash: row.get(0)?,
                        created_at: row.get(1)?,
                        expires_at: row.get(2)?,
                        last_seen: row.get(3)?,
                        user_agent: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn touch_session(
        &self,
        token_hash: &str,
        last_seen: Millis,
        expires_at: Millis,
    ) -> Result<()> {
        let token_hash = token_hash.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE sessions SET last_seen = ?2, expires_at = ?3 WHERE token_hash = ?1",
                params![token_hash, last_seen, expires_at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn delete_session(&self, token_hash: &str) -> Result<()> {
        let token_hash = token_hash.to_owned();
        self.write(move |conn| {
            conn.execute(
                "DELETE FROM sessions WHERE token_hash = ?1",
                params![token_hash],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn delete_expired_sessions(&self, now: Millis) -> Result<u64> {
        self.write(move |conn| {
            let changed = conn
                .execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now])
                .map_err(map_sqlite_error)?;
            Ok(changed as u64)
        })
        .await
    }

    async fn create_api_token(&self, token: ApiToken) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO api_tokens (id, name, token_hash, scopes, created_at, last_used, revoked_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    token.id,
                    token.name,
                    token.token_hash,
                    token.scopes,
                    token.created_at,
                    token.last_used,
                    token.revoked_at,
                ],
            )
            .map_err(|err| {
                // 令牌名有 UNIQUE 约束:给调用方一个能看懂的提示,而不是裸的 SQLite 文案
                if matches!(
                    &err,
                    rusqlite::Error::SqliteFailure(code, _)
                        if code.code == rusqlite::ErrorCode::ConstraintViolation
                ) {
                    KbError::InvalidInput(format!("令牌名 {} 已存在", token.name))
                } else {
                    map_sqlite_error(err)
                }
            })?;
            Ok(())
        })
        .await
    }

    async fn get_api_token(&self, token_hash: &str) -> Result<Option<ApiToken>> {
        let token_hash = token_hash.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT id, name, token_hash, scopes, created_at, last_used, revoked_at \
                 FROM api_tokens WHERE token_hash = ?1",
                params![token_hash],
                raw_from_row,
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn list_api_tokens(&self) -> Result<Vec<ApiToken>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, name, token_hash, scopes, created_at, last_used, revoked_at \
                     FROM api_tokens ORDER BY created_at, name",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map([], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }

    async fn revoke_api_token(&self, id: &str, at: Millis) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE api_tokens SET revoked_at = ?2 WHERE id = ?1",
                    params![id, at],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("令牌 {id}")));
            }
            Ok(())
        })
        .await
    }
}

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApiToken> {
    Ok(ApiToken {
        id: row.get(0)?,
        name: row.get(1)?,
        token_hash: row.get(2)?,
        scopes: row.get(3)?,
        created_at: row.get(4)?,
        last_used: row.get(5)?,
        revoked_at: row.get(6)?,
    })
}
