//! 用户 admin key:一人一把,以本人身份调用本人权限内的全部接口。
//!
//! 新建用户时在同一个事务里发(见 `users::create_user`),老用户靠迁移补发;
//! 这里再兜一层 [`SystemStore::ensure_admin_key`],读不到就现发,所以调用方永远拿得到。
//! 明文存放(要随时显示、写进下载的文档),靠 system.db 文件权限保护。

use kb_core::account::{User, UserAdminKey};
use kb_core::model::Millis;
use kb_core::token::new_admin_key;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};

use super::users::load_user;
use super::{SystemStore, now_millis};
use crate::sql::map_sqlite_error;

fn row_to_key(row: &rusqlite::Row<'_>) -> rusqlite::Result<UserAdminKey> {
    Ok(UserAdminKey {
        user_id: row.get(0)?,
        admin_key: row.get(1)?,
        created_at: row.get(2)?,
        rotated_at: row.get(3)?,
    })
}

impl SystemStore {
    /// 取某个用户的 admin key;还没有就现发一把。用户不存在返回 `NotFound`。
    pub async fn ensure_admin_key(&self, user_id: &str) -> Result<UserAdminKey> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            if load_user(conn, &user_id)?.is_none() {
                return Err(KbError::NotFound(format!("用户 {user_id}")));
            }
            let found = conn
                .query_row(
                    "SELECT user_id, admin_key, created_at, rotated_at FROM user_admin_keys WHERE user_id = ?1",
                    params![user_id],
                    row_to_key,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            if let Some(found) = found {
                return Ok(found);
            }
            let key = UserAdminKey {
                user_id: user_id.clone(),
                admin_key: new_admin_key(),
                created_at: now_millis(),
                rotated_at: None,
            };
            conn.execute(
                "INSERT INTO user_admin_keys (user_id, admin_key, created_at) VALUES (?1, ?2, ?3)",
                params![key.user_id, key.admin_key, key.created_at],
            )
            .map_err(map_sqlite_error)?;
            Ok(key)
        })
        .await
    }

    /// 轮换:换一把新的,旧的立刻失效。用户不存在返回 `NotFound`。
    pub async fn rotate_admin_key(&self, user_id: &str, at: Millis) -> Result<UserAdminKey> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            if load_user(conn, &user_id)?.is_none() {
                return Err(KbError::NotFound(format!("用户 {user_id}")));
            }
            let fresh = new_admin_key();
            // 没有旧记录(理论上不会)就当第一次发
            let changed = conn
                .execute(
                    "UPDATE user_admin_keys SET admin_key = ?2, rotated_at = ?3 WHERE user_id = ?1",
                    params![user_id, fresh, at],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                conn.execute(
                    "INSERT INTO user_admin_keys (user_id, admin_key, created_at) VALUES (?1, ?2, ?3)",
                    params![user_id, fresh, at],
                )
                .map_err(map_sqlite_error)?;
            }
            conn.query_row(
                "SELECT user_id, admin_key, created_at, rotated_at FROM user_admin_keys WHERE user_id = ?1",
                params![user_id],
                row_to_key,
            )
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 凭 admin key 找到主人。key 不存在、主人被停用都返回 `None`。
    pub async fn find_user_by_admin_key(&self, admin_key: &str) -> Result<Option<User>> {
        let admin_key = admin_key.to_owned();
        self.read(move |conn| {
            let user_id: Option<String> = conn
                .query_row(
                    "SELECT user_id FROM user_admin_keys WHERE admin_key = ?1",
                    params![admin_key],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            let Some(user_id) = user_id else {
                return Ok(None);
            };
            let Some(user) = load_user(conn, &user_id)? else {
                return Ok(None);
            };
            Ok(user.status.can_sign_in().then_some(user))
        })
        .await
    }
}
