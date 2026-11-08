//! 角色与功能勾选。

use kb_core::account::{ROLE_ADMIN, ROLE_USER, Role};
use kb_core::features::{self, AiState, FeatureSet};
use kb_core::model::identity::RoleUpdate;
use kb_core::{KbError, Result};
use rusqlite::{Connection, OptionalExtension, params};

use super::{SystemStore, new_id, now_millis};
use crate::sql::map_sqlite_error;

/// 写入内置角色(幂等)。`role_user` 的功能勾选只在**第一次创建**时写入,
/// 之后管理员改过就不再被覆盖。
pub(crate) fn seed_builtin(conn: &mut Connection) -> Result<()> {
    let now = now_millis();
    let tx = conn.transaction().map_err(map_sqlite_error)?;
    tx.execute(
        "INSERT OR IGNORE INTO roles (id, name, description, builtin, all_features, dangerous, created_at, updated_at) \
         VALUES (?1, '管理员', '拥有全部功能,包括系统级功能', 1, 1, 1, ?2, ?2)",
        params![ROLE_ADMIN, now],
    )
    .map_err(map_sqlite_error)?;
    let inserted = tx
        .execute(
            "INSERT OR IGNORE INTO roles (id, name, description, builtin, all_features, dangerous, created_at, updated_at) \
             VALUES (?1, '普通用户', '新注册用户的默认角色', 1, 0, 0, ?2, ?2)",
            params![ROLE_USER, now],
        )
        .map_err(map_sqlite_error)?;
    if inserted > 0 {
        for feature in features::default_user_features() {
            tx.execute(
                "INSERT OR IGNORE INTO role_features (role_id, feature) VALUES (?1, ?2)",
                params![ROLE_USER, feature],
            )
            .map_err(map_sqlite_error)?;
        }
    }
    tx.commit().map_err(map_sqlite_error)
}

fn load_role(conn: &Connection, id: &str) -> Result<Option<Role>> {
    let row = conn
        .query_row(
            "SELECT id, name, description, builtin, all_features, dangerous, quota_json, created_at, updated_at \
             FROM roles WHERE id = ?1",
            params![id],
            |row| {
                Ok(Role {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    builtin: row.get::<_, i64>(3)? != 0,
                    all_features: row.get::<_, i64>(4)? != 0,
                    dangerous: row.get::<_, i64>(5)? != 0,
                    quota_json: row.get(6)?,
                    features: Vec::new(),
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some(mut role) = row else {
        return Ok(None);
    };
    role.features = role_features(conn, id)?;
    Ok(Some(role))
}

pub(crate) fn role_features(conn: &Connection, role_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn
        .prepare("SELECT feature FROM role_features WHERE role_id = ?1 ORDER BY feature")
        .map_err(map_sqlite_error)?;
    let rows = stmt
        .query_map(params![role_id], |row| row.get::<_, String>(0))
        .map_err(map_sqlite_error)?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .map_err(map_sqlite_error)
}

fn check_features(list: &[String], dangerous_allowed: bool) -> Result<()> {
    for id in list {
        let Some(def) = features::find(id) else {
            return Err(KbError::InvalidInput(format!("未知功能点:{id}")));
        };
        if def.dangerous && !dangerous_allowed {
            return Err(KbError::InvalidInput(format!(
                "「{}」是危险功能,只能授予标为「危险」的角色",
                def.label
            )));
        }
    }
    Ok(())
}

impl SystemStore {
    /// 全部角色(带功能勾选),内置的在前。
    pub async fn list_roles(&self) -> Result<Vec<Role>> {
        self.read(|conn| {
            let ids: Vec<String> = {
                let mut stmt = conn
                    .prepare("SELECT id FROM roles ORDER BY builtin DESC, created_at, id")
                    .map_err(map_sqlite_error)?;
                let rows = stmt
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(map_sqlite_error)?;
                rows.collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(map_sqlite_error)?
            };
            let mut roles = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(role) = load_role(conn, &id)? {
                    roles.push(role);
                }
            }
            Ok(roles)
        })
        .await
    }

    /// 按 id 取角色。
    pub async fn get_role(&self, id: &str) -> Result<Option<Role>> {
        let id = id.to_owned();
        self.read(move |conn| load_role(conn, &id)).await
    }

    /// 新建自定义角色。
    pub async fn create_role(
        &self,
        name: &str,
        description: &str,
        features: Vec<String>,
        dangerous: bool,
    ) -> Result<Role> {
        let name = name.trim().to_owned();
        if name.is_empty() || name.chars().count() > 30 {
            return Err(KbError::InvalidInput("角色名需要 1–30 个字".to_owned()));
        }
        check_features(&features, dangerous)?;
        let description = description.trim().to_owned();
        let id = new_id("role_");
        let now = now_millis();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let taken: bool = tx
                .query_row("SELECT 1 FROM roles WHERE name = ?1", params![name], |_| Ok(true))
                .optional()
                .map_err(map_sqlite_error)?
                .unwrap_or(false);
            if taken {
                return Err(KbError::Exists(format!("已有同名角色:{name}")));
            }
            tx.execute(
                "INSERT INTO roles (id, name, description, builtin, all_features, dangerous, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 0, 0, ?4, ?5, ?5)",
                params![id, name, description, i64::from(dangerous), now],
            )
            .map_err(map_sqlite_error)?;
            for feature in &features {
                tx.execute(
                    "INSERT OR IGNORE INTO role_features (role_id, feature) VALUES (?1, ?2)",
                    params![id, feature],
                )
                .map_err(map_sqlite_error)?;
            }
            tx.commit().map_err(map_sqlite_error)?;
            load_role(conn, &id)?.ok_or_else(|| KbError::Internal("角色创建后读不到".to_owned()))
        })
        .await
    }

    /// 更新角色。管理员角色不可改(它永远是「全部功能」)。
    pub async fn update_role(&self, id: &str, update: RoleUpdate) -> Result<Role> {
        let id = id.to_owned();
        if id == ROLE_ADMIN {
            return Err(KbError::Forbidden("内置的管理员角色不能修改".to_owned()));
        }
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let Some(current) = load_role(&tx, &id)? else {
                return Err(KbError::NotFound(format!("角色 {id}")));
            };
            let dangerous = update.dangerous.unwrap_or(current.dangerous);
            if current.builtin && update.dangerous == Some(true) {
                return Err(KbError::Forbidden("内置角色不能改成危险角色".to_owned()));
            }
            if let Some(list) = &update.features {
                check_features(list, dangerous)?;
            } else if update.dangerous == Some(false) {
                // 收回「危险」资格时,已勾的危险功能也要拿掉,否则角色会带着不该有的权限
                let kept: Vec<String> = current
                    .features
                    .iter()
                    .filter(|feature| !features::find(feature).is_some_and(|def| def.dangerous))
                    .cloned()
                    .collect();
                tx.execute("DELETE FROM role_features WHERE role_id = ?1", params![id])
                    .map_err(map_sqlite_error)?;
                for feature in kept {
                    tx.execute(
                        "INSERT INTO role_features (role_id, feature) VALUES (?1, ?2)",
                        params![id, feature],
                    )
                    .map_err(map_sqlite_error)?;
                }
            }
            if let Some(name) = &update.name {
                let name = name.trim();
                if name.is_empty() || name.chars().count() > 30 {
                    return Err(KbError::InvalidInput("角色名需要 1–30 个字".to_owned()));
                }
                let clash: bool = tx
                    .query_row(
                        "SELECT 1 FROM roles WHERE name = ?1 AND id != ?2",
                        params![name, id],
                        |_| Ok(true),
                    )
                    .optional()
                    .map_err(map_sqlite_error)?
                    .unwrap_or(false);
                if clash {
                    return Err(KbError::Exists(format!("已有同名角色:{name}")));
                }
                tx.execute(
                    "UPDATE roles SET name = ?2 WHERE id = ?1",
                    params![id, name],
                )
                .map_err(map_sqlite_error)?;
            }
            if let Some(description) = &update.description {
                tx.execute(
                    "UPDATE roles SET description = ?2 WHERE id = ?1",
                    params![id, description.trim()],
                )
                .map_err(map_sqlite_error)?;
            }
            if let Some(quota) = &update.quota_json {
                serde_json::from_str::<serde_json::Value>(quota)
                    .map_err(|err| KbError::InvalidInput(format!("配额不是合法 JSON:{err}")))?;
                tx.execute(
                    "UPDATE roles SET quota_json = ?2 WHERE id = ?1",
                    params![id, quota],
                )
                .map_err(map_sqlite_error)?;
            }
            tx.execute(
                "UPDATE roles SET dangerous = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, i64::from(dangerous), now_millis()],
            )
            .map_err(map_sqlite_error)?;
            if let Some(list) = &update.features {
                tx.execute("DELETE FROM role_features WHERE role_id = ?1", params![id])
                    .map_err(map_sqlite_error)?;
                for feature in list {
                    tx.execute(
                        "INSERT OR IGNORE INTO role_features (role_id, feature) VALUES (?1, ?2)",
                        params![id, feature],
                    )
                    .map_err(map_sqlite_error)?;
                }
            }
            tx.commit().map_err(map_sqlite_error)?;
            load_role(conn, &id)?.ok_or_else(|| KbError::NotFound(format!("角色 {id}")))
        })
        .await
    }

    /// 删除自定义角色。内置角色不能删;还有用户在用时要先把他们移走。
    pub async fn delete_role(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            let Some(role) = load_role(conn, &id)? else {
                return Err(KbError::NotFound(format!("角色 {id}")));
            };
            if role.builtin {
                return Err(KbError::Forbidden("内置角色不能删除".to_owned()));
            }
            let users: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM users WHERE role_id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            if users > 0 {
                return Err(KbError::Exists(format!(
                    "还有 {users} 个用户在使用这个角色,请先改成别的角色"
                )));
            }
            conn.execute("DELETE FROM roles WHERE id = ?1", params![id])
                .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 每个角色下有几个用户:`(角色 id, 人数)`。
    pub async fn role_user_counts(&self) -> Result<Vec<(String, i64)>> {
        self.read(|conn| {
            let mut stmt = conn
                .prepare("SELECT role_id, COUNT(*) FROM users GROUP BY role_id")
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)
        })
        .await
    }

    /// 某个用户**最终生效**的功能集合(角色勾选 + 用户例外 + AI 总开关)。
    pub async fn effective_features(
        &self,
        user_id: &str,
        ai: impl Into<AiState>,
    ) -> Result<FeatureSet> {
        let user_id = user_id.to_owned();
        let ai = ai.into();
        self.read(move |conn| effective_features_in(conn, &user_id, ai))
            .await
    }
}

pub(crate) fn effective_features_in(
    conn: &Connection,
    user_id: &str,
    ai: AiState,
) -> Result<FeatureSet> {
    let role_id: Option<String> = conn
        .query_row(
            "SELECT role_id FROM users WHERE id = ?1",
            params![user_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let Some(role_id) = role_id else {
        return Err(KbError::NotFound(format!("用户 {user_id}")));
    };
    let all: bool = conn
        .query_row(
            "SELECT all_features FROM roles WHERE id = ?1",
            params![role_id],
            |row| Ok(row.get::<_, i64>(0)? != 0),
        )
        .map_err(map_sqlite_error)?;
    let (mut allow, mut deny) = (Vec::new(), Vec::new());
    {
        let mut stmt = conn
            .prepare("SELECT feature, effect FROM user_feature_overrides WHERE user_id = ?1")
            .map_err(map_sqlite_error)?;
        let rows = stmt
            .query_map(params![user_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(map_sqlite_error)?;
        for row in rows {
            let (feature, effect) = row.map_err(map_sqlite_error)?;
            if effect == "allow" {
                allow.push(feature);
            } else {
                deny.push(feature);
            }
        }
    }
    if all {
        // 管理员角色:全部功能;用户例外里的「禁止」仍然生效
        return Ok(FeatureSet::all_except(deny, ai));
    }
    Ok(FeatureSet::resolve(
        role_features(conn, &role_id)?,
        allow,
        deny,
        ai,
    ))
}
