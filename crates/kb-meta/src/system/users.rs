//! 用户、个人知识库、功能例外。

use kb_core::account::{
    NewUser, Space, SpaceKind, User, UserStatus, normalize_email, normalize_username,
};
use kb_core::model::Millis;
use kb_core::model::identity::{UserFilter, UserUpdate};
use kb_core::{KbError, Result};
use rusqlite::{Connection, OptionalExtension, Row, params};

use super::{SystemStore, new_id, now_millis};
use crate::sql::map_sqlite_error;

const USER_COLUMNS: &str = "id, username, email, email_verified_at, display_name, avatar, role_id, status, \
     privacy_json, quota_json, must_change_password, registered_via, created_at, last_login_at, delete_after";

fn map_user(row: &Row<'_>) -> rusqlite::Result<(User, String)> {
    let status: String = row.get(7)?;
    Ok((
        User {
            id: row.get(0)?,
            username: row.get(1)?,
            email: row.get(2)?,
            email_verified_at: row.get(3)?,
            display_name: row.get(4)?,
            avatar: row.get(5)?,
            role_id: row.get(6)?,
            status: UserStatus::Active,
            privacy_json: row.get(8)?,
            quota_json: row.get(9)?,
            must_change_password: row.get::<_, i64>(10)? != 0,
            registered_via: row.get(11)?,
            created_at: row.get(12)?,
            last_login_at: row.get(13)?,
            delete_after: row.get(14)?,
        },
        status,
    ))
}

pub(crate) fn finish_user((mut user, status): (User, String)) -> Result<User> {
    user.status = UserStatus::parse(&status)?;
    Ok(user)
}

pub(crate) fn load_user(conn: &Connection, id: &str) -> Result<Option<User>> {
    conn.query_row(
        &format!("SELECT {USER_COLUMNS} FROM users WHERE id = ?1"),
        params![id],
        map_user,
    )
    .optional()
    .map_err(map_sqlite_error)?
    .map(finish_user)
    .transpose()
}

fn row_to_space(row: &Row<'_>) -> rusqlite::Result<(Space, String)> {
    Ok((
        Space {
            id: row.get(0)?,
            owner_id: row.get(1)?,
            name: row.get(2)?,
            kind: SpaceKind::Personal,
            storage_bytes: row.get(4)?,
            created_at: row.get(5)?,
        },
        row.get::<_, String>(3)?,
    ))
}

fn finish_space((mut space, kind): (Space, String)) -> Result<Space> {
    space.kind = SpaceKind::parse(&kind)?;
    Ok(space)
}

/// 还剩几个**能用的管理员**(角色是「全部功能」且状态可登录)。
pub(super) fn active_admins(conn: &Connection, excluding: Option<&str>) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM users u JOIN roles r ON r.id = u.role_id \
         WHERE r.all_features = 1 AND u.status IN ('active','pending_email') AND (?1 IS NULL OR u.id != ?1)",
        params![excluding],
        |row| row.get(0),
    )
    .map_err(map_sqlite_error)
}

impl SystemStore {
    /// 建用户,同时建他的个人知识库(同一个事务)。返回用户和知识库。
    pub async fn create_user(&self, new: NewUser) -> Result<(User, Space)> {
        let username = normalize_username(&new.username)?;
        let email = new.email.as_deref().map(normalize_email).transpose()?;
        let display_name = new
            .display_name
            .as_deref()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(&username)
            .to_owned();
        if display_name.chars().count() > 40 {
            return Err(KbError::InvalidInput("昵称不能超过 40 个字".to_owned()));
        }
        if new.password_hash.trim().is_empty() {
            return Err(KbError::InvalidInput("缺少密码哈希".to_owned()));
        }
        let user_id = new_id("usr_");
        let mut space_id = new_id("sp_");
        let now = now_millis();
        let verified = (new.email_verified && email.is_some()).then_some(now);
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let role_exists: bool = tx
                .query_row("SELECT 1 FROM roles WHERE id = ?1", params![new.role_id], |_| Ok(true))
                .optional()
                .map_err(map_sqlite_error)?
                .unwrap_or(false);
            if !role_exists {
                return Err(KbError::InvalidInput(format!("角色不存在:{}", new.role_id)));
            }
            let taken: bool = tx
                .query_row("SELECT 1 FROM users WHERE username = ?1", params![username], |_| Ok(true))
                .optional()
                .map_err(map_sqlite_error)?
                .unwrap_or(false);
            if taken {
                return Err(KbError::Exists("用户名已被占用".to_owned()));
            }
            if let Some(email) = &email {
                let used: bool = tx
                    .query_row("SELECT 1 FROM users WHERE email = ?1", params![email], |_| Ok(true))
                    .optional()
                    .map_err(map_sqlite_error)?
                    .unwrap_or(false);
                if used {
                    return Err(KbError::Exists("邮箱已被注册".to_owned()));
                }
            }
            // 第一个管理员接管主知识库(KB_HOME 根目录里已有的数据):之后的用户拿新建的 spaces/<id>/
            let primary_taken: bool = tx
                .query_row(
                    "SELECT 1 FROM spaces WHERE id = ?1",
                    params![kb_core::account::PRIMARY_SPACE_ID],
                    |_| Ok(true),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .unwrap_or(false);
            let is_admin_role: bool = tx
                .query_row("SELECT all_features FROM roles WHERE id = ?1", params![new.role_id], |row| {
                    Ok(row.get::<_, i64>(0)? != 0)
                })
                .map_err(map_sqlite_error)?;
            if !primary_taken && is_admin_role {
                space_id = kb_core::account::PRIMARY_SPACE_ID.to_owned();
            }
            tx.execute(
                "INSERT INTO users (id, username, email, email_verified_at, display_name, password_hash, role_id, \
                 status, must_change_password, registered_via, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    user_id,
                    username,
                    email,
                    verified,
                    display_name,
                    new.password_hash,
                    new.role_id,
                    new.status.as_str(),
                    i64::from(new.must_change_password),
                    new.registered_via,
                    now,
                ],
            )
            .map_err(map_sqlite_error)?;
            tx.execute(
                "INSERT INTO spaces (id, owner_id, name, kind, created_at) VALUES (?1, ?2, ?3, 'personal', ?4)",
                params![space_id, user_id, format!("{display_name} 的知识库"), now],
            )
            .map_err(map_sqlite_error)?;
            // 注册(以及管理员代建、邀请码注册)都走这里:每个新用户同事务拿到自己的 admin key
            tx.execute(
                "INSERT INTO user_admin_keys (user_id, admin_key, created_at) VALUES (?1, ?2, ?3)",
                params![user_id, kb_core::token::new_admin_key(), now],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            let user = load_user(conn, &user_id)?
                .ok_or_else(|| KbError::Internal("用户创建后读不到".to_owned()))?;
            let space = conn
                .query_row(
                    "SELECT id, owner_id, name, kind, storage_bytes, created_at FROM spaces WHERE id = ?1",
                    params![space_id],
                    row_to_space,
                )
                .map_err(map_sqlite_error)
                .and_then(finish_space)?;
            Ok((user, space))
        })
        .await
    }

    /// 按 id 取用户。
    pub async fn get_user(&self, id: &str) -> Result<Option<User>> {
        let id = id.to_owned();
        self.read(move |conn| load_user(conn, &id)).await
    }

    /// 用「用户名或邮箱」找用户(登录用,不区分大小写)。
    pub async fn find_user_by_login(&self, login: &str) -> Result<Option<User>> {
        let login = login.trim().to_owned();
        if login.is_empty() {
            return Ok(None);
        }
        self.read(move |conn| {
            conn.query_row(
                &format!(
                    "SELECT {USER_COLUMNS} FROM users WHERE username = ?1 OR email = ?1 LIMIT 1"
                ),
                params![login],
                map_user,
            )
            .optional()
            .map_err(map_sqlite_error)?
            .map(finish_user)
            .transpose()
        })
        .await
    }

    /// 读密码哈希(只给登录校验用)。
    pub async fn password_hash(&self, user_id: &str) -> Result<Option<String>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT password_hash FROM users WHERE id = ?1",
                params![user_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 改密码哈希;改完让这个用户的全部会话失效(`keep_session` 除外)。
    pub async fn set_password_hash(
        &self,
        user_id: &str,
        hash: &str,
        must_change: bool,
        keep_session: Option<&str>,
    ) -> Result<()> {
        let user_id = user_id.to_owned();
        let hash = hash.to_owned();
        let keep = keep_session.map(str::to_owned);
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let changed = tx
                .execute(
                    "UPDATE users SET password_hash = ?2, must_change_password = ?3 WHERE id = ?1",
                    params![user_id, hash, i64::from(must_change)],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("用户 {user_id}")));
            }
            tx.execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND (?2 IS NULL OR token_hash != ?2)",
                params![user_id, keep],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }

    /// 分页列用户,返回(本页, 总数)。
    pub async fn list_users(
        &self,
        filter: UserFilter,
        limit: u32,
        offset: u32,
    ) -> Result<(Vec<User>, i64)> {
        self.read(move |conn| {
            let like = filter
                .q
                .as_deref()
                .map(str::trim)
                .filter(|q| !q.is_empty())
                .map(|q| format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
            let status = filter.status.map(UserStatus::as_str);
            let condition = "(?1 IS NULL OR username LIKE ?1 ESCAPE '\\' OR email LIKE ?1 ESCAPE '\\' OR display_name LIKE ?1 ESCAPE '\\') \
                 AND (?2 IS NULL OR role_id = ?2) AND (?3 IS NULL OR status = ?3)";
            let total: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM users WHERE {condition}"),
                    params![like, filter.role_id, status],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {USER_COLUMNS} FROM users WHERE {condition} ORDER BY created_at DESC, id LIMIT ?4 OFFSET ?5"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![like, filter.role_id, status, limit.min(200), offset], map_user)
                .map_err(map_sqlite_error)?;
            let mut users = Vec::new();
            for row in rows {
                users.push(finish_user(row.map_err(map_sqlite_error)?)?);
            }
            Ok((users, total))
        })
        .await
    }

    /// 更新用户。降级或停用**最后一个管理员**会被拒绝(系统里必须至少留一个)。
    pub async fn update_user(&self, id: &str, update: UserUpdate) -> Result<User> {
        let id = id.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let Some(current) = load_user(&tx, &id)? else {
                return Err(KbError::NotFound(format!("用户 {id}")));
            };
            let new_role = update
                .role_id
                .clone()
                .unwrap_or_else(|| current.role_id.clone());
            let new_status = update.status.unwrap_or(current.status);
            if update.role_id.is_some() {
                let exists: bool = tx
                    .query_row(
                        "SELECT 1 FROM roles WHERE id = ?1",
                        params![new_role],
                        |_| Ok(true),
                    )
                    .optional()
                    .map_err(map_sqlite_error)?
                    .unwrap_or(false);
                if !exists {
                    return Err(KbError::InvalidInput(format!("角色不存在:{new_role}")));
                }
            }
            // 最后一个管理员保护:改完之后,除了他以外必须还有至少一个能用的管理员
            let was_admin: bool = tx
                .query_row(
                    "SELECT all_features FROM roles WHERE id = ?1",
                    params![current.role_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .map_err(map_sqlite_error)?
                && matches!(
                    current.status,
                    UserStatus::Active | UserStatus::PendingEmail
                );
            let will_be_admin: bool = tx
                .query_row(
                    "SELECT all_features FROM roles WHERE id = ?1",
                    params![new_role],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .map_err(map_sqlite_error)?
                && matches!(new_status, UserStatus::Active | UserStatus::PendingEmail);
            if was_admin && !will_be_admin && active_admins(&tx, Some(&id))? == 0 {
                return Err(KbError::Forbidden(
                    "系统里必须至少保留一个管理员,不能降级或停用最后一个".to_owned(),
                ));
            }
            if let Some(name) = &update.display_name {
                let name = name.trim();
                if name.is_empty() || name.chars().count() > 40 {
                    return Err(KbError::InvalidInput("昵称需要 1–40 个字".to_owned()));
                }
                tx.execute(
                    "UPDATE users SET display_name = ?2 WHERE id = ?1",
                    params![id, name],
                )
                .map_err(map_sqlite_error)?;
            }
            if let Some(quota) = &update.quota_json {
                serde_json::from_str::<serde_json::Value>(quota)
                    .map_err(|err| KbError::InvalidInput(format!("配额不是合法 JSON:{err}")))?;
                tx.execute(
                    "UPDATE users SET quota_json = ?2 WHERE id = ?1",
                    params![id, quota],
                )
                .map_err(map_sqlite_error)?;
            }
            if let Some(email) = &update.email {
                let email = email.as_deref().map(normalize_email).transpose()?;
                if let Some(email) = &email {
                    let used: bool = tx
                        .query_row(
                            "SELECT 1 FROM users WHERE email = ?1 AND id != ?2",
                            params![email, id],
                            |_| Ok(true),
                        )
                        .optional()
                        .map_err(map_sqlite_error)?
                        .unwrap_or(false);
                    if used {
                        return Err(KbError::Exists("邮箱已被注册".to_owned()));
                    }
                }
                // 换邮箱后要重新验证;调用方刚验证过新邮箱的(`email_verified_at`),就直接记已验证
                let verified = if email.is_some() {
                    update.email_verified_at
                } else {
                    None
                };
                tx.execute(
                    "UPDATE users SET email = ?2, email_verified_at = ?3 WHERE id = ?1",
                    params![id, email, verified],
                )
                .map_err(map_sqlite_error)?;
            }
            if let Some(avatar) = &update.avatar {
                tx.execute(
                    "UPDATE users SET avatar = ?2 WHERE id = ?1",
                    params![id, avatar],
                )
                .map_err(map_sqlite_error)?;
            }
            if let Some(flag) = update.must_change_password {
                tx.execute(
                    "UPDATE users SET must_change_password = ?2 WHERE id = ?1",
                    params![id, i64::from(flag)],
                )
                .map_err(map_sqlite_error)?;
            }
            if update.role_id.is_some() {
                tx.execute(
                    "UPDATE users SET role_id = ?2 WHERE id = ?1",
                    params![id, new_role],
                )
                .map_err(map_sqlite_error)?;
            }
            if update.status.is_some() {
                tx.execute(
                    "UPDATE users SET status = ?2 WHERE id = ?1",
                    params![id, new_status.as_str()],
                )
                .map_err(map_sqlite_error)?;
                // 停用立即踢下线
                if !new_status.can_sign_in() {
                    tx.execute("DELETE FROM sessions WHERE user_id = ?1", params![id])
                        .map_err(map_sqlite_error)?;
                }
            }
            tx.commit().map_err(map_sqlite_error)?;
            load_user(conn, &id)?.ok_or_else(|| KbError::NotFound(format!("用户 {id}")))
        })
        .await
    }

    /// 记一次登录。
    pub async fn touch_login(&self, user_id: &str, at: Millis) -> Result<()> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE users SET last_login_at = ?2 WHERE id = ?1",
                params![user_id, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 某个用户**最终生效**的配额:全站默认 → 角色覆盖 → 用户覆盖,后者盖前者。
    pub async fn effective_quota(
        &self,
        user_id: &str,
        defaults: &kb_core::config::QuotaConfig,
    ) -> Result<kb_core::config::QuotaConfig> {
        let user_id = user_id.to_owned();
        let defaults = defaults.clone();
        self.read(move |conn| {
            let (role_quota, user_quota): (String, String) = conn
                .query_row(
                    "SELECT r.quota_json, u.quota_json FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?1",
                    params![user_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .ok_or_else(|| KbError::NotFound(format!("用户 {user_id}")))?;
            Ok(defaults.with_overrides(&role_quota).with_overrides(&user_quota))
        })
        .await
    }

    /// 总用户数(判断「系统里还没有任何用户」用)。
    pub async fn count_users(&self) -> Result<i64> {
        self.read(|conn| {
            conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
                .map_err(map_sqlite_error)
        })
        .await
    }

    /// 能用的管理员数量。
    pub async fn count_admins(&self) -> Result<i64> {
        self.read(|conn| active_admins(conn, None)).await
    }

    /// 设置 / 清除某个用户的功能例外。`effect` 为 `None` 表示清除(跟随角色)。
    pub async fn set_feature_override(
        &self,
        user_id: &str,
        feature: &str,
        effect: Option<&str>,
    ) -> Result<()> {
        if !kb_core::features::is_known(feature) || feature == kb_core::features::BASE {
            return Err(KbError::InvalidInput(format!("未知功能点:{feature}")));
        }
        if let Some(effect) = effect
            && effect != "allow"
            && effect != "deny"
        {
            return Err(KbError::InvalidInput("例外只能是 allow 或 deny".to_owned()));
        }
        let user_id = user_id.to_owned();
        let feature = feature.to_owned();
        let effect = effect.map(str::to_owned);
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            if load_user(&tx, &user_id)?.is_none() {
                return Err(KbError::NotFound(format!("用户 {user_id}")));
            }
            // 危险功能只能「允许」给角色本身就带「危险」资格的用户,避免绕过角色上的把关
            if effect.as_deref() == Some("allow")
                && kb_core::features::find(&feature).is_some_and(|def| def.dangerous)
            {
                let dangerous: bool = tx
                    .query_row(
                        "SELECT r.dangerous FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?1",
                        params![user_id],
                        |row| Ok(row.get::<_, i64>(0)? != 0),
                    )
                    .map_err(map_sqlite_error)?;
                if !dangerous {
                    return Err(KbError::InvalidInput("危险功能只能授予「危险」角色的用户".to_owned()));
                }
            }
            match effect {
                Some(effect) => tx
                    .execute(
                        "INSERT INTO user_feature_overrides (user_id, feature, effect) VALUES (?1, ?2, ?3) \
                         ON CONFLICT(user_id, feature) DO UPDATE SET effect = excluded.effect",
                        params![user_id, feature, effect],
                    )
                    .map_err(map_sqlite_error)?,
                None => tx
                    .execute(
                        "DELETE FROM user_feature_overrides WHERE user_id = ?1 AND feature = ?2",
                        params![user_id, feature],
                    )
                    .map_err(map_sqlite_error)?,
            };
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }

    /// 某个用户的全部功能例外:`(feature, effect)`。
    pub async fn feature_overrides(&self, user_id: &str) -> Result<Vec<(String, String)>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare("SELECT feature, effect FROM user_feature_overrides WHERE user_id = ?1 ORDER BY feature")
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![user_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(map_sqlite_error)
        })
        .await
    }

    // ------------------------------------------------------------------ spaces

    /// 某用户的个人知识库。
    pub async fn personal_space(&self, user_id: &str) -> Result<Option<Space>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT id, owner_id, name, kind, storage_bytes, created_at FROM spaces \
                 WHERE owner_id = ?1 AND kind = 'personal'",
                params![user_id],
                row_to_space,
            )
            .optional()
            .map_err(map_sqlite_error)?
            .map(finish_space)
            .transpose()
        })
        .await
    }

    /// 按 id 取知识库。
    pub async fn get_space(&self, id: &str) -> Result<Option<Space>> {
        let id = id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT id, owner_id, name, kind, storage_bytes, created_at FROM spaces WHERE id = ?1",
                params![id],
                row_to_space,
            )
            .optional()
            .map_err(map_sqlite_error)?
            .map(finish_space)
            .transpose()
        })
        .await
    }

    /// 全部知识库(调度器、备份、用量统计用)。
    pub async fn list_spaces(&self) -> Result<Vec<Space>> {
        self.read(|conn| {
            let mut stmt = conn
                .prepare("SELECT id, owner_id, name, kind, storage_bytes, created_at FROM spaces ORDER BY created_at, id")
                .map_err(map_sqlite_error)?;
            let rows = stmt.query_map([], row_to_space).map_err(map_sqlite_error)?;
            let mut spaces = Vec::new();
            for row in rows {
                spaces.push(finish_space(row.map_err(map_sqlite_error)?)?);
            }
            Ok(spaces)
        })
        .await
    }

    /// 更新知识库已用存储(定时统计写入)。
    pub async fn set_space_storage(&self, id: &str, bytes: i64) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE spaces SET storage_bytes = ?2 WHERE id = ?1",
                params![id, bytes.max(0)],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}
