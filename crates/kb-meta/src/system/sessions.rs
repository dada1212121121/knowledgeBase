//! 登录会话与个人访问令牌。

use kb_core::account::{User, UserSession, UserToken};
use kb_core::model::Millis;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, Row, params};

use super::SystemStore;
use super::users::load_user;
use crate::sql::map_sqlite_error;

fn map_session(row: &Row<'_>) -> rusqlite::Result<UserSession> {
    Ok(UserSession {
        token_hash: row.get(0)?,
        user_id: row.get(1)?,
        created_at: row.get(2)?,
        expires_at: row.get(3)?,
        last_seen: row.get(4)?,
        ip: row.get(5)?,
        user_agent: row.get(6)?,
    })
}

fn map_token(row: &Row<'_>) -> rusqlite::Result<UserToken> {
    Ok(UserToken {
        id: row.get(0)?,
        user_id: row.get(1)?,
        name: row.get(2)?,
        token_hash: row.get(3)?,
        scopes: row.get(4)?,
        include_shared: row.get::<_, i64>(5)? != 0,
        created_at: row.get(6)?,
        last_used: row.get(7)?,
        revoked_at: row.get(8)?,
    })
}

const SESSION_COLUMNS: &str =
    "token_hash, user_id, created_at, expires_at, last_seen, ip, user_agent";
const TOKEN_COLUMNS: &str =
    "id, user_id, name, token_hash, scopes, include_shared, created_at, last_used, revoked_at";

impl SystemStore {
    /// 新建会话。
    pub async fn create_session(&self, session: UserSession) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen, ip, user_agent) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    session.token_hash,
                    session.user_id,
                    session.created_at,
                    session.expires_at,
                    session.last_seen,
                    session.ip,
                    session.user_agent,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 凭会话令牌哈希找到会话和用户。已过期、用户被停用的都返回 `None`。
    pub async fn session_user(
        &self,
        token_hash: &str,
        now: Millis,
    ) -> Result<Option<(UserSession, User)>> {
        let token_hash = token_hash.to_owned();
        self.read(move |conn| {
            let session = conn
                .query_row(
                    &format!("SELECT {SESSION_COLUMNS} FROM sessions WHERE token_hash = ?1 AND expires_at > ?2"),
                    params![token_hash, now],
                    map_session,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            let Some(session) = session else {
                return Ok(None);
            };
            let Some(user) = load_user(conn, &session.user_id)? else {
                return Ok(None);
            };
            if !user.status.can_sign_in() {
                return Ok(None);
            }
            Ok(Some((session, user)))
        })
        .await
    }

    /// 续期:更新最近访问和过期时间。
    pub async fn touch_session(
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

    /// 退出登录。
    pub async fn delete_session(&self, token_hash: &str) -> Result<()> {
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

    /// 让某个用户的全部会话失效(`except` 那一个保留,用于「退出其它设备」)。返回删了几个。
    pub async fn delete_user_sessions(&self, user_id: &str, except: Option<&str>) -> Result<usize> {
        let user_id = user_id.to_owned();
        let except = except.map(str::to_owned);
        self.write(move |conn| {
            conn.execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND (?2 IS NULL OR token_hash != ?2)",
                params![user_id, except],
            )
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 清掉已过期的会话。
    pub async fn purge_expired_sessions(&self, now: Millis) -> Result<usize> {
        self.write(move |conn| {
            conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", params![now])
                .map_err(map_sqlite_error)
        })
        .await
    }

    /// 某个用户当前有效的全部会话(设置页「登录设备」)。
    pub async fn list_user_sessions(&self, user_id: &str, now: Millis) -> Result<Vec<UserSession>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SESSION_COLUMNS} FROM sessions WHERE user_id = ?1 AND expires_at > ?2 ORDER BY last_seen DESC"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt.query_map(params![user_id, now], map_session).map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(map_sqlite_error)
        })
        .await
    }

    // ------------------------------------------------------------------ tokens

    /// 新建个人访问令牌(明文由调用方生成并只返回一次,这里只存哈希)。
    pub async fn create_token(&self, token: UserToken) -> Result<()> {
        if token.name.trim().is_empty() {
            return Err(KbError::InvalidInput("令牌名不能为空".to_owned()));
        }
        self.write(move |conn| {
            let taken: bool = conn
                .query_row(
                    "SELECT 1 FROM api_tokens WHERE user_id = ?1 AND name = ?2 AND revoked_at IS NULL",
                    params![token.user_id, token.name],
                    |_| Ok(true),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .unwrap_or(false);
            if taken {
                return Err(KbError::Exists(format!("已有同名令牌:{}", token.name)));
            }
            // 同名但已撤销的旧令牌改名让位,保持 (user_id, name) 唯一
            conn.execute(
                "UPDATE api_tokens SET name = name || '#' || id WHERE user_id = ?1 AND name = ?2 AND revoked_at IS NOT NULL",
                params![token.user_id, token.name],
            )
            .map_err(map_sqlite_error)?;
            conn.execute(
                "INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, include_shared, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    token.id,
                    token.user_id,
                    token.name,
                    token.token_hash,
                    token.scopes,
                    i64::from(token.include_shared),
                    token.created_at,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 凭令牌哈希找到令牌和主人。已撤销、主人被停用的都返回 `None`。
    pub async fn find_token(&self, token_hash: &str) -> Result<Option<(UserToken, User)>> {
        let token_hash = token_hash.to_owned();
        self.read(move |conn| {
            let token = conn
                .query_row(
                    &format!("SELECT {TOKEN_COLUMNS} FROM api_tokens WHERE token_hash = ?1 AND revoked_at IS NULL"),
                    params![token_hash],
                    map_token,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            let Some(token) = token else {
                return Ok(None);
            };
            let Some(user) = load_user(conn, &token.user_id)? else {
                return Ok(None);
            };
            if !user.status.can_sign_in() {
                return Ok(None);
            }
            Ok(Some((token, user)))
        })
        .await
    }

    /// 某个用户的令牌(含已撤销的,新的在前)。
    pub async fn list_tokens(&self, user_id: &str) -> Result<Vec<UserToken>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {TOKEN_COLUMNS} FROM api_tokens WHERE user_id = ?1 ORDER BY created_at DESC"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt.query_map(params![user_id], map_token).map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(map_sqlite_error)
        })
        .await
    }

    /// 撤销令牌。只能撤销**自己的**:`user_id` 不匹配时当作不存在。返回是否撤销了。
    pub async fn revoke_token(&self, user_id: &str, token_id: &str, at: Millis) -> Result<bool> {
        let user_id = user_id.to_owned();
        let token_id = token_id.to_owned();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE api_tokens SET revoked_at = ?3 WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL",
                    params![token_id, user_id, at],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed > 0)
        })
        .await
    }

    /// 记一次使用时间。
    pub async fn touch_token(&self, token_id: &str, at: Millis) -> Result<()> {
        let token_id = token_id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE api_tokens SET last_used = ?2 WHERE id = ?1",
                params![token_id, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 停用 / 删除用户时使用:撤销其全部令牌。
    pub async fn revoke_user_tokens(&self, user_id: &str, at: Millis) -> Result<usize> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE api_tokens SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL",
                params![user_id, at],
            )
            .map_err(map_sqlite_error)
        })
        .await
    }
}
