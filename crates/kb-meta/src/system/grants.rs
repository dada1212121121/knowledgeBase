//! 文档授权的存储与有效角色查询(多用户设计说明)。
//!
//! 这里只管「库里有什么授权」。**谁有资格授权**(不能授予比自己高的角色、不能给被拉黑的人……)是调用方的事,
//! 因为它取决于操作者自己的有效角色;存储层守的是数据本身的完整性:
//! 被授权人必须是可用账号、不能给知识库的所有者再加一条授权、角色不会是「所有者」、一次批量最多 500 个资源。

use std::collections::{BTreeSet, HashMap, HashSet};

use kb_core::model::Millis;
use kb_core::model::identity::{
    BatchOutcome, GrantChange, GrantView, SetGrant, SharedByMe, SharedRoot,
};
use kb_core::share::{
    AccessRequest, DocRef, Effective, Grant, RequestState, ResourceKey, Role, effective_role,
};
use kb_core::social::PublicProfile;
use kb_core::{KbError, Result};
use rusqlite::{Connection, OptionalExtension, params};

use super::users::load_user;
use super::{SystemStore, new_id};
use crate::sql::map_sqlite_error;

/// 一次批量授权最多涉及多少个资源。
pub const MAX_BATCH_KEYS: usize = 500;
/// 一次批量授权最多涉及多少个人。
pub const MAX_BATCH_PEOPLE: usize = 50;

fn row_to_grant(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Grant, String)> {
    Ok((
        Grant {
            id: row.get(0)?,
            space_id: row.get(1)?,
            resource_key: row.get(2)?,
            grantee_id: row.get(3)?,
            role: Role::Viewer,
            via: row.get(5)?,
            created_by: row.get(6)?,
            created_at: row.get(7)?,
            expires_at: row.get(8)?,
        },
        row.get::<_, String>(4)?,
    ))
}

fn finish_grant((mut grant, role): (Grant, String)) -> Result<Grant> {
    grant.role = Role::parse_grantable(&role)
        .map_err(|_| KbError::Internal(format!("库里有未知的授权角色 {role}")))?;
    Ok(grant)
}

const GRANT_COLUMNS: &str =
    "id, space_id, resource_key, grantee_id, role, via, created_by, created_at, expires_at";

fn alive(expires_at: Option<Millis>, now: Millis) -> bool {
    expires_at.is_none_or(|at| at > now)
}

fn space_owner(conn: &Connection, space_id: &str) -> Result<Option<String>> {
    conn.query_row(
        "SELECT owner_id FROM spaces WHERE id = ?1",
        params![space_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(map_sqlite_error)
}

fn profile(conn: &Connection, user_id: &str) -> Result<Option<PublicProfile>> {
    Ok(load_user(conn, user_id)?.map(|user| PublicProfile {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar: user.avatar,
    }))
}

/// 校验并写入(或更新)一条授权。
#[allow(clippy::too_many_arguments)]
fn upsert_grant(
    conn: &Connection,
    key: &ResourceKey,
    grantee_id: &str,
    role: Role,
    via: &str,
    created_by: &str,
    now: Millis,
    expires_at: Option<Millis>,
) -> Result<SetGrant> {
    if matches!(role, Role::Owner) {
        return Err(KbError::InvalidInput(
            "不能把所有者角色授予协作者".to_owned(),
        ));
    }
    let space_id = key.space_id();
    let owner = space_owner(conn, space_id)?
        .ok_or_else(|| KbError::NotFound(format!("知识库 {space_id}")))?;
    if owner == grantee_id {
        return Err(KbError::InvalidInput(
            "对方已经是这个知识库的所有者".to_owned(),
        ));
    }
    let Some(grantee) = load_user(conn, grantee_id)? else {
        return Err(KbError::NotFound("没有找到这个用户".to_owned()));
    };
    if grantee.status != kb_core::account::UserStatus::Active {
        return Err(KbError::NotFound("没有找到这个用户".to_owned()));
    }
    if expires_at.is_some_and(|at| at <= now) {
        return Err(KbError::InvalidInput("过期时间必须在将来".to_owned()));
    }
    let text = key.to_string();
    let previous: Option<String> = conn
        .query_row(
            "SELECT role FROM grants WHERE resource_key = ?1 AND grantee_id = ?2",
            params![text, grantee_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    let previous = previous.map(|role| Role::parse(&role)).transpose()?;
    conn.execute(
        "INSERT INTO grants (id, space_id, resource_key, grantee_id, role, via, created_by, created_at, expires_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) \
         ON CONFLICT(resource_key, grantee_id) DO UPDATE SET \
           role = excluded.role, via = excluded.via, created_by = excluded.created_by, \
           expires_at = excluded.expires_at",
        params![new_id("grt_"), space_id, text, grantee_id, role.as_str(), via, created_by, now, expires_at],
    )
    .map_err(map_sqlite_error)?;
    let grant = conn
        .query_row(
            &format!(
                "SELECT {GRANT_COLUMNS} FROM grants WHERE resource_key = ?1 AND grantee_id = ?2"
            ),
            params![text, grantee_id],
            row_to_grant,
        )
        .map_err(map_sqlite_error)
        .and_then(finish_grant)?;
    Ok(SetGrant { grant, previous })
}

/// 一个人在一条继承链上的授权(去掉过期的)和链上的停止继承点。
fn load_for_lineage(
    conn: &Connection,
    user_id: &str,
    lineage: &[ResourceKey],
    now: Millis,
) -> Result<(HashMap<String, Role>, HashSet<String>)> {
    let mut grants = HashMap::new();
    let mut breaks = HashSet::new();
    for node in lineage {
        let text = node.to_string();
        let found: Option<(String, Option<Millis>)> = conn
            .query_row(
                "SELECT role, expires_at FROM grants WHERE resource_key = ?1 AND grantee_id = ?2",
                params![text, user_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(map_sqlite_error)?;
        if let Some((role, expires_at)) = found
            && alive(expires_at, now)
        {
            grants.insert(text.clone(), Role::parse(&role)?);
        }
        let broken = conn
            .query_row(
                "SELECT 1 FROM inherit_breaks WHERE resource_key = ?1",
                params![text],
                |_| Ok(()),
            )
            .optional()
            .map_err(map_sqlite_error)?
            .is_some();
        if broken {
            breaks.insert(text);
        }
    }
    Ok((grants, breaks))
}

impl SystemStore {
    /// 授权(已有就更新角色)。见模块说明里存储层守的几条规矩。
    #[allow(clippy::too_many_arguments)]
    pub async fn set_grant(
        &self,
        key: &ResourceKey,
        grantee_id: &str,
        role: Role,
        via: &str,
        created_by: &str,
        now: Millis,
        expires_at: Option<Millis>,
    ) -> Result<SetGrant> {
        let (key, grantee_id, via, created_by) = (
            key.clone(),
            grantee_id.to_owned(),
            via.to_owned(),
            created_by.to_owned(),
        );
        self.write(move |conn| {
            upsert_grant(
                conn,
                &key,
                &grantee_id,
                role,
                &via,
                &created_by,
                now,
                expires_at,
            )
        })
        .await
    }

    /// 移除一个人在一个资源上的授权。返回之前的角色(没有授权返回 `None`)。
    pub async fn remove_grant(&self, key: &ResourceKey, grantee_id: &str) -> Result<Option<Role>> {
        let (text, grantee_id) = (key.to_string(), grantee_id.to_owned());
        self.write(move |conn| {
            let previous: Option<String> = conn
                .query_row(
                    "SELECT role FROM grants WHERE resource_key = ?1 AND grantee_id = ?2",
                    params![text, grantee_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            conn.execute(
                "DELETE FROM grants WHERE resource_key = ?1 AND grantee_id = ?2",
                params![text, grantee_id],
            )
            .map_err(map_sqlite_error)?;
            previous.map(|role| Role::parse(&role)).transpose()
        })
        .await
    }

    /// 批量授权 / 改角色 / 移除:对 `keys` 里的**每一个**资源应用 `changes`。整批在一个事务里,
    /// 任何一项不合法整批回滚——不会出现「分享了一半」。
    pub async fn apply_grants(
        &self,
        keys: &[ResourceKey],
        changes: &[GrantChange],
        created_by: &str,
        now: Millis,
        expires_at: Option<Millis>,
    ) -> Result<BatchOutcome> {
        if keys.is_empty() || changes.is_empty() {
            return Err(KbError::InvalidInput(
                "没有要分享的资源或没有选择人".to_owned(),
            ));
        }
        if keys.len() > MAX_BATCH_KEYS {
            return Err(KbError::InvalidInput(format!(
                "一次最多选 {MAX_BATCH_KEYS} 项"
            )));
        }
        if changes.len() > MAX_BATCH_PEOPLE {
            return Err(KbError::InvalidInput(format!(
                "一次最多选 {MAX_BATCH_PEOPLE} 个人"
            )));
        }
        let (keys, changes, created_by) = (keys.to_vec(), changes.to_vec(), created_by.to_owned());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let mut outcome = BatchOutcome::default();
            for key in &keys {
                for change in &changes {
                    match change.role {
                        Some(role) => {
                            let done = upsert_grant(
                                &tx,
                                key,
                                &change.grantee_id,
                                role,
                                "direct",
                                &created_by,
                                now,
                                expires_at,
                            )?;
                            if done.previous == Some(role) {
                                outcome.unchanged += 1;
                            } else {
                                outcome.changed += 1;
                            }
                        }
                        None => {
                            let removed = tx
                                .execute(
                                    "DELETE FROM grants WHERE resource_key = ?1 AND grantee_id = ?2",
                                    params![key.to_string(), change.grantee_id],
                                )
                                .map_err(map_sqlite_error)?;
                            outcome.removed += removed;
                        }
                    }
                }
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(outcome)
        })
        .await
    }

    /// 一个资源上**直接**授予的协作者(不含继承)。
    pub async fn direct_grants(&self, key: &ResourceKey, now: Millis) -> Result<Vec<GrantView>> {
        let text = key.to_string();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {GRANT_COLUMNS} FROM grants WHERE resource_key = ?1 ORDER BY created_at, id"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![text], row_to_grant)
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for row in rows {
                let grant = finish_grant(row)?;
                if !alive(grant.expires_at, now) {
                    continue;
                }
                if let Some(grantee) = profile(conn, &grant.grantee_id)? {
                    out.push(GrantView { grant, grantee, inherited: false });
                }
            }
            Ok(out)
        })
        .await
    }

    /// 分享面板要的完整列表:这个资源上直接授予的 + 从上级继承来的(尊重停止继承)。
    pub async fn lineage_grants(&self, key: &ResourceKey, now: Millis) -> Result<Vec<GrantView>> {
        let lineage = key.lineage();
        self.read(move |conn| {
            let mut out = Vec::new();
            for (depth, node) in lineage.iter().enumerate() {
                let mut statement = conn
                    .prepare(&format!(
                        "SELECT {GRANT_COLUMNS} FROM grants WHERE resource_key = ?1 ORDER BY created_at, id"
                    ))
                    .map_err(map_sqlite_error)?;
                let rows = statement
                    .query_map(params![node.to_string()], row_to_grant)
                    .map_err(map_sqlite_error)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(map_sqlite_error)?;
                for row in rows {
                    let grant = finish_grant(row)?;
                    if !alive(grant.expires_at, now) {
                        continue;
                    }
                    if let Some(grantee) = profile(conn, &grant.grantee_id)? {
                        out.push(GrantView { grant, grantee, inherited: depth > 0 });
                    }
                }
                let broken = conn
                    .query_row(
                        "SELECT 1 FROM inherit_breaks WHERE resource_key = ?1",
                        params![node.to_string()],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(map_sqlite_error)?
                    .is_some();
                if broken {
                    break;
                }
            }
            Ok(out)
        })
        .await
    }

    /// 一个人在一个资源上的有效授权角色(**不含**所有者身份——那来自「是不是知识库的主人」)。
    pub async fn granted_role(
        &self,
        user_id: &str,
        key: &ResourceKey,
        now: Millis,
    ) -> Result<Option<Effective>> {
        let (user_id, lineage) = (user_id.to_owned(), key.lineage());
        self.read(move |conn| {
            let (grants, breaks) = load_for_lineage(conn, &user_id, &lineage, now)?;
            Ok(effective_role(&lineage, &grants, &breaks))
        })
        .await
    }

    /// 能处理这个资源的访问申请的人:知识库的主人 + 沿继承链(尊重停止继承)授予了「可管理」的人。
    pub async fn managers_of(&self, key: &ResourceKey, now: Millis) -> Result<Vec<String>> {
        let mut out = Vec::new();
        if let Some(owner) = self.space_owner(key.space_id()).await? {
            out.push(owner);
        }
        for view in self.lineage_grants(key, now).await? {
            if view.grant.role == Role::Manager && !out.contains(&view.grantee.id) {
                out.push(view.grantee.id.clone());
            }
        }
        Ok(out)
    }

    /// 一个人对一个资源的**最终**角色:知识库的主人是所有者;否则是授权算出来的角色;都没有就是 `None`。
    ///
    /// 系统管理员**不**因为是管理员就拥有别人知识库的权限（设计规范）:这里不看账号角色。
    pub async fn role_of(
        &self,
        user_id: &str,
        key: &ResourceKey,
        now: Millis,
    ) -> Result<Option<Role>> {
        if self.space_owner(key.space_id()).await?.as_deref() == Some(user_id) {
            return Ok(Some(Role::Owner));
        }
        Ok(self.granted_role(user_id, key, now).await?.map(|e| e.role))
    }

    /// 要求某人对资源至少能做 `action`。没有任何权限 → `NotFound`(不暴露资源存在);
    /// 有权限但不够 → `Forbidden`。返回他的角色。
    pub async fn require_role(
        &self,
        user_id: &str,
        key: &ResourceKey,
        action: kb_core::share::Action,
        now: Millis,
    ) -> Result<Role> {
        let Some(role) = self.role_of(user_id, key, now).await? else {
            return Err(KbError::NotFound("没有找到这个内容".to_owned()));
        };
        if role.allows(action) {
            Ok(role)
        } else {
            Err(KbError::Forbidden(format!(
                "你的权限是「{}」,不能执行这个操作",
                role.label()
            )))
        }
    }

    /// 这个人在这个知识库里有没有任何(未过期的)授权。是给「点名别人的知识库」做的一道便宜的前置检查。
    pub async fn has_grant_in_space(
        &self,
        user_id: &str,
        space_id: &str,
        now: Millis,
    ) -> Result<bool> {
        let (user_id, space_id) = (user_id.to_owned(), space_id.to_owned());
        self.read(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT 1 FROM grants WHERE grantee_id = ?1 AND space_id = ?2 \
                     AND (expires_at IS NULL OR expires_at > ?3) LIMIT 1",
                    params![user_id, space_id, now],
                    |_| Ok(()),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .is_some())
        })
        .await
    }

    /// 这个集合里有没有设过「停止继承」的子级(决定列表要不要按行过滤)。
    /// 只是个快速判断:宁可误报(多过滤一次),不可漏报,所以按「同一知识库同一集合」前缀粗匹配。
    pub async fn has_inherit_breaks_in(&self, space_id: &str, collection: &str) -> Result<bool> {
        let (space_id, collection) = (space_id.to_owned(), collection.to_owned());
        self.read(move |conn| {
            let mut statement = conn
                .prepare("SELECT resource_key FROM inherit_breaks WHERE space_id = ?1")
                .map_err(map_sqlite_error)?;
            let keys = statement
                .query_map(params![space_id], |row| row.get::<_, String>(0))
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            Ok(keys.iter().any(|text| {
                ResourceKey::parse(text)
                    .ok()
                    .and_then(|key| key.collection_name().map(|name| name == collection))
                    .unwrap_or(true)
            }))
        })
        .await
    }

    /// 知识库的主人。
    pub async fn space_owner(&self, space_id: &str) -> Result<Option<String>> {
        let space_id = space_id.to_owned();
        self.read(move |conn| space_owner(conn, &space_id)).await
    }

    /// 设置 / 取消「不继承上级协作者」。
    pub async fn set_inherit_break(
        &self,
        key: &ResourceKey,
        broken: bool,
        by: &str,
        now: Millis,
    ) -> Result<()> {
        if matches!(key, ResourceKey::Space { .. }) {
            return Err(KbError::InvalidInput(
                "整个知识库没有上级,不需要停止继承".to_owned(),
            ));
        }
        let (text, space_id, by) = (key.to_string(), key.space_id().to_owned(), by.to_owned());
        self.write(move |conn| {
            if broken {
                conn.execute(
                    "INSERT OR IGNORE INTO inherit_breaks (resource_key, space_id, created_by, created_at) VALUES (?1, ?2, ?3, ?4)",
                    params![text, space_id, by, now],
                )
            } else {
                conn.execute("DELETE FROM inherit_breaks WHERE resource_key = ?1", params![text])
            }
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 这个资源是不是停止了继承。
    pub async fn is_inherit_broken(&self, key: &ResourceKey) -> Result<bool> {
        let text = key.to_string();
        self.read(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT 1 FROM inherit_breaks WHERE resource_key = ?1",
                    params![text],
                    |_| Ok(()),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .is_some())
        })
        .await
    }

    /// 共享给我的:直接授予我的资源,每条带所有者资料与「是否被我移出列表」。过期的不显示。
    pub async fn shared_with(
        &self,
        user_id: &str,
        include_hidden: bool,
        now: Millis,
    ) -> Result<Vec<SharedRoot>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {GRANT_COLUMNS} FROM grants WHERE grantee_id = ?1 ORDER BY created_at DESC, id"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![user_id], row_to_grant)
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for row in rows {
                let grant = finish_grant(row)?;
                if !alive(grant.expires_at, now) {
                    continue;
                }
                let hidden = conn
                    .query_row(
                        "SELECT 1 FROM hidden_shares WHERE user_id = ?1 AND resource_key = ?2",
                        params![user_id, grant.resource_key],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(map_sqlite_error)?
                    .is_some();
                if hidden && !include_hidden {
                    continue;
                }
                let Some(owner_id) = space_owner(conn, &grant.space_id)? else {
                    continue;
                };
                let Some(owner) = profile(conn, &owner_id)? else {
                    continue;
                };
                out.push(SharedRoot { grant, owner, hidden });
            }
            Ok(out)
        })
        .await
    }

    /// 把一条共享从我的「共享给我」里移出 / 放回(只影响显示,不影响授权)。
    /// 只能动**确实授予了我**的资源:否则别人可以往我的隐藏表里塞任意垃圾。
    pub async fn set_share_hidden(
        &self,
        user_id: &str,
        key: &ResourceKey,
        hidden: bool,
    ) -> Result<()> {
        let (user_id, text) = (user_id.to_owned(), key.to_string());
        self.write(move |conn| {
            let granted = conn
                .query_row(
                    "SELECT 1 FROM grants WHERE grantee_id = ?1 AND resource_key = ?2",
                    params![user_id, text],
                    |_| Ok(()),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .is_some();
            if !granted {
                return Err(KbError::NotFound("没有这条共享".to_owned()));
            }
            if hidden {
                conn.execute(
                    "INSERT OR IGNORE INTO hidden_shares (user_id, resource_key) VALUES (?1, ?2)",
                    params![user_id, text],
                )
            } else {
                conn.execute(
                    "DELETE FROM hidden_shares WHERE user_id = ?1 AND resource_key = ?2",
                    params![user_id, text],
                )
            }
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 我分享出去的:我的知识库里有协作者的资源,每个资源带协作者列表。
    pub async fn shared_by(&self, owner_id: &str, now: Millis) -> Result<Vec<SharedByMe>> {
        let owner_id = owner_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {GRANT_COLUMNS} FROM grants WHERE space_id IN (SELECT id FROM spaces WHERE owner_id = ?1) \
                     ORDER BY resource_key, created_at, id"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![owner_id], row_to_grant)
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            let mut grouped: Vec<SharedByMe> = Vec::new();
            for row in rows {
                let grant = finish_grant(row)?;
                if !alive(grant.expires_at, now) {
                    continue;
                }
                let Some(who) = profile(conn, &grant.grantee_id)? else {
                    continue;
                };
                match grouped.last_mut() {
                    Some(last) if last.resource_key == grant.resource_key => {
                        last.grantees.push((who, grant.role));
                    }
                    _ => {
                        let broken = conn
                            .query_row(
                                "SELECT 1 FROM inherit_breaks WHERE resource_key = ?1",
                                params![grant.resource_key],
                                |_| Ok(()),
                            )
                            .optional()
                            .map_err(map_sqlite_error)?
                            .is_some();
                        grouped.push(SharedByMe {
                            resource_key: grant.resource_key.clone(),
                            grantees: vec![(who, grant.role)],
                            inherit_broken: broken,
                        });
                    }
                }
            }
            Ok(grouped)
        })
        .await
    }

    /// 清掉过期的授权。返回清掉几条。
    pub async fn purge_expired_grants(&self, now: Millis) -> Result<usize> {
        self.write(move |conn| {
            conn.execute(
                "DELETE FROM grants WHERE expires_at IS NOT NULL AND expires_at <= ?1",
                params![now],
            )
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 文件 / 文件夹移动后把授权、停止继承、隐藏分享、分享链接里的资源键一起改名。
    ///
    /// 只映射 `from` 自己以及它底下、且属于同一集合的键:`docs` 不会匹配 `docs2`,
    /// 因为 `is_within` 走的是 `lineage` 的段边界。移动后旧的继承授权自然失效,
    /// 新位置从目标目录继承——这正是 要的语义。
    pub async fn rekey_resource(&self, from: &ResourceKey, to: &ResourceKey) -> Result<usize> {
        let (from, to) = (from.clone(), to.clone());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let mut changed = 0;
            // 先收集所有表里出现过的资源键。不能只看 grants:一个资源可能只有隐藏共享、
            // 停止继承或分享链接,没有授权行;只看 grants 会把这些记录留在旧路径上。
            let mut keys = BTreeSet::new();
            for (table, column) in [
                ("grants", "resource_key"),
                ("inherit_breaks", "resource_key"),
                ("hidden_shares", "resource_key"),
                ("share_links", "resource_key"),
                ("share_link_items", "resource_key"),
            ] {
                let mut statement = tx
                    .prepare(&format!("SELECT DISTINCT {column} FROM {table}"))
                    .map_err(map_sqlite_error)?;
                let rows = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(map_sqlite_error)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(map_sqlite_error)?;
                keys.extend(rows);
            }
            for text in keys {
                let Ok(candidate) = ResourceKey::parse(&text) else {
                    continue;
                };
                let Some(replacement) = rekeyed(&candidate, &from, &to) else {
                    continue;
                };
                let replacement = replacement.to_string();
                for table in ["grants", "inherit_breaks", "hidden_shares"] {
                    changed += tx
                        .execute(
                            &format!(
                                "UPDATE OR REPLACE {table} SET resource_key = ?1 WHERE resource_key = ?2"
                            ),
                            params![replacement, text],
                        )
                        .map_err(map_sqlite_error)?;
                }
                // 分享链接与合集链接也指向资源键,不跟着改的话移动后链接会 404
                for table in ["share_links", "share_link_items"] {
                    changed += tx
                        .execute(
                            &format!(
                                "UPDATE OR REPLACE {table} SET resource_key = ?1 WHERE resource_key = ?2"
                            ),
                            params![replacement, text],
                        )
                        .map_err(map_sqlite_error)?;
                }
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(changed)
        })
        .await
    }

    /// 删掉某个资源**及它底下所有东西**的授权与停止继承(删除目录 / 文档 / 集合时调用)。
    /// 返回删掉几条授权。
    pub async fn forget_resource(&self, key: &ResourceKey) -> Result<usize> {
        let (space_id, prefix) = (key.space_id().to_owned(), key.to_string());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let mut removed = 0;
            // 候选键不能只从 grants 里找:一个资源可能只有「停止继承」「隐藏共享」或「访问申请」,
            // 没有授权行;只查 grants 会让这些记录在删除后继续指向一个不存在的路径。
            let mut keys = BTreeSet::new();
            for table in ["grants", "inherit_breaks", "access_requests"] {
                let mut statement = tx
                    .prepare(&format!(
                        "SELECT DISTINCT resource_key FROM {table} WHERE space_id = ?1"
                    ))
                    .map_err(map_sqlite_error)?;
                let found = statement
                    .query_map(params![space_id], |row| row.get::<_, String>(0))
                    .map_err(map_sqlite_error)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(map_sqlite_error)?;
                keys.extend(found);
            }
            // hidden_shares 是全局表(没有 space_id),但资源键带 sid,逐条解析后仍然安全。
            {
                let mut statement = tx
                    .prepare("SELECT DISTINCT resource_key FROM hidden_shares")
                    .map_err(map_sqlite_error)?;
                let found = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .map_err(map_sqlite_error)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(map_sqlite_error)?;
                keys.extend(found);
            }
            let target = ResourceKey::parse(&prefix)?;
            for text in keys {
                let Ok(candidate) = ResourceKey::parse(&text) else {
                    continue;
                };
                if candidate.is_within(&target) {
                    for table in [
                        "grants",
                        "inherit_breaks",
                        "hidden_shares",
                        "access_requests",
                    ] {
                        let changed = tx
                            .execute(
                                &format!("DELETE FROM {table} WHERE resource_key = ?1"),
                                params![text],
                            )
                            .map_err(map_sqlite_error)?;
                        if table == "grants" {
                            removed += changed;
                        }
                    }
                }
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(removed)
        })
        .await
    }
}

/// 把一个落在 `from` 自己或底下的资源键映射到 `to` 的相应位置。
fn rekeyed(candidate: &ResourceKey, from: &ResourceKey, to: &ResourceKey) -> Option<ResourceKey> {
    if candidate == from {
        return Some(to.clone());
    }
    // 分享链接是全局表,里面可能有别的知识库 / 集合的同名路径。
    // 只按路径段剥前缀会把别人的 `docs/a.md` 也改掉,所以先要求 sid 与集合名一致。
    let (candidate_sid, candidate_name) = match candidate {
        ResourceKey::Space { sid } => (sid, None),
        ResourceKey::Collection { sid, name }
        | ResourceKey::Dir { sid, name, .. }
        | ResourceKey::Doc { sid, name, .. } => (sid, Some(name)),
    };
    let (from_sid, from_name) = match from {
        ResourceKey::Space { sid } => (sid, None),
        ResourceKey::Collection { sid, name }
        | ResourceKey::Dir { sid, name, .. }
        | ResourceKey::Doc { sid, name, .. } => (sid, Some(name)),
    };
    if candidate_sid != from_sid || candidate_name != from_name {
        return None;
    }
    match (candidate, from, to) {
        (
            ResourceKey::Doc {
                sid,
                name,
                doc: DocRef::File(path),
            },
            ResourceKey::Doc {
                doc: DocRef::File(old),
                ..
            },
            ResourceKey::Doc {
                doc: DocRef::File(new),
                ..
            },
        ) => {
            let tail = path.strip_prefix(old)?.strip_prefix('/')?;
            ResourceKey::file(sid, name, &format!("{new}/{tail}")).ok()
        }
        (
            ResourceKey::Dir { sid, name, path },
            ResourceKey::Dir { path: old, .. },
            ResourceKey::Dir { path: new, .. },
        ) => {
            let tail = path.strip_prefix(old)?.strip_prefix('/')?;
            ResourceKey::dir(sid, name, &format!("{new}/{tail}")).ok()
        }
        // 移动文件夹时,底下的文件键也要跟着走。`from` 是 Dir、候选是 Doc(File),
        // 只按段边界剥前缀——`docs` 不会匹配 `docs2`。
        (
            ResourceKey::Doc {
                sid,
                name,
                doc: DocRef::File(path),
            },
            ResourceKey::Dir { path: old, .. },
            ResourceKey::Dir { path: new, .. },
        ) => {
            let tail = path.strip_prefix(old)?.strip_prefix('/')?;
            ResourceKey::file(sid, name, &format!("{new}/{tail}")).ok()
        }
        _ => None,
    }
}

// ---------------------------------------------------------------- 访问申请

/// 申请附言最长字符数。
pub const MAX_ACCESS_MESSAGE: usize = 200;
/// 同一个人同一资源两次申请之间至少隔多久。
pub const ACCESS_REQUEST_COOLDOWN_MS: i64 = 24 * 3_600_000;
/// 一个人同时挂着的待处理申请上限(防止拿申请刷屏)。
pub const MAX_PENDING_ACCESS_REQUESTS: i64 = 30;

fn map_access_request(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(AccessRequest, String, String)> {
    Ok((
        AccessRequest {
            id: row.get(0)?,
            space_id: row.get(1)?,
            resource_key: row.get(2)?,
            requester_id: row.get(3)?,
            role: Role::Viewer,
            message: row.get(5)?,
            state: RequestState::Pending,
            decided_by: row.get(7)?,
            created_at: row.get(8)?,
            decided_at: row.get(9)?,
        },
        row.get(4)?,
        row.get(6)?,
    ))
}

fn finish_access_request(
    (mut request, role, state): (AccessRequest, String, String),
) -> Result<AccessRequest> {
    request.role = Role::parse(&role)
        .map_err(|_| KbError::Internal(format!("库里有未知的申请角色 {role}")))?;
    request.state = RequestState::parse(&state)
        .ok_or_else(|| KbError::Internal(format!("库里有未知的申请状态 {state}")))?;
    Ok(request)
}

const ACCESS_COLUMNS: &str = "id, space_id, resource_key, requester_id, role, message, state, decided_by, created_at, decided_at";

impl SystemStore {
    /// 申请访问。规则(都在事务里):
    /// - 知识库必须存在(不存在 → `NotFound`);
    /// - 申请的角色只能是查看 / 评论 / 编辑,而且必须比申请人现有的更高(已经够了 → `InvalidInput`);
    /// - 同一个人对同一资源 24 小时内只能申请一次;同时挂着的待处理申请最多 30 个;
    /// - 所有者拉黑了申请人 → 返回 `Ok(None)`:表面成功,什么都不创建(不暴露自己拉黑了对方)。
    pub async fn create_access_request(
        &self,
        key: &ResourceKey,
        requester_id: &str,
        role: Role,
        message: Option<&str>,
        now: Millis,
    ) -> Result<Option<AccessRequest>> {
        if !matches!(role, Role::Viewer | Role::Commenter | Role::Editor) {
            return Err(KbError::InvalidInput("只能申请查看、评论或编辑".to_owned()));
        }
        let message = match message.map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) if text.chars().count() > MAX_ACCESS_MESSAGE => {
                return Err(KbError::InvalidInput(format!(
                    "附言最多 {MAX_ACCESS_MESSAGE} 个字"
                )));
            }
            Some(text) if text.chars().any(char::is_control) => {
                return Err(KbError::InvalidInput(
                    "附言不能包含换行等控制字符".to_owned(),
                ));
            }
            other => other.map(str::to_owned),
        };
        let (key, requester_id) = (key.clone(), requester_id.to_owned());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let space_id = key.space_id().to_owned();
            let Some(owner) = space_owner(&tx, &space_id)? else {
                return Err(KbError::NotFound("没有找到这个内容".to_owned()));
            };
            let Some(me) = load_user(&tx, &requester_id)? else {
                return Err(KbError::Forbidden("账号不可用".to_owned()));
            };
            if me.status != kb_core::account::UserStatus::Active {
                return Err(KbError::Forbidden("账号不可用".to_owned()));
            }
            // 所有者拉黑了申请人:不创建,也不报错
            if tx
                .query_row(
                    "SELECT 1 FROM blocks WHERE user_id = ?1 AND blocked_id = ?2",
                    params![owner, requester_id],
                    |_| Ok(()),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .is_some()
            {
                return Ok(None);
            }
            // 现有角色已经够了就不用申请
            let lineage = key.lineage();
            let current = if owner == requester_id {
                Some(Role::Owner)
            } else {
                let (grants, breaks) = load_for_lineage(&tx, &requester_id, &lineage, now)?;
                effective_role(&lineage, &grants, &breaks).map(|e| e.role)
            };
            if current.is_some_and(|have| have >= role) {
                return Err(KbError::InvalidInput("你已经有这个权限了".to_owned()));
            }
            let last: Option<Millis> = tx
                .query_row(
                    "SELECT MAX(created_at) FROM access_requests WHERE resource_key = ?1 AND requester_id = ?2",
                    params![key.to_string(), requester_id],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            if last.is_some_and(|at| now - at < ACCESS_REQUEST_COOLDOWN_MS) {
                return Err(KbError::Forbidden("你刚刚申请过,24 小时内只能申请一次".to_owned()));
            }
            let pending: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM access_requests WHERE requester_id = ?1 AND state = 'pending'",
                    params![requester_id],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            if pending >= MAX_PENDING_ACCESS_REQUESTS {
                return Err(KbError::Forbidden(format!(
                    "你有 {MAX_PENDING_ACCESS_REQUESTS} 个申请还没人处理,等对方回应后再继续"
                )));
            }
            let id = new_id("acr_");
            tx.execute(
                "INSERT INTO access_requests (id, space_id, resource_key, requester_id, role, message, state, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)",
                params![id, space_id, key.to_string(), requester_id, role.as_str(), message, now],
            )
            .map_err(map_sqlite_error)?;
            let request = tx
                .query_row(
                    &format!("SELECT {ACCESS_COLUMNS} FROM access_requests WHERE id = ?1"),
                    params![id],
                    map_access_request,
                )
                .map_err(map_sqlite_error)
                .and_then(finish_access_request)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(Some(request))
        })
        .await
    }

    /// 某些知识库里待处理的申请(调用方再按「我对资源是不是可管理」过滤)。
    pub async fn pending_access_requests_in(
        &self,
        space_ids: &[String],
    ) -> Result<Vec<AccessRequest>> {
        if space_ids.is_empty() {
            return Ok(Vec::new());
        }
        let space_ids = space_ids.to_vec();
        self.read(move |conn| {
            let mut out = Vec::new();
            for space_id in space_ids {
                let mut statement = conn
                    .prepare(&format!(
                        "SELECT {ACCESS_COLUMNS} FROM access_requests WHERE space_id = ?1 AND state = 'pending' \
                         ORDER BY created_at DESC, id"
                    ))
                    .map_err(map_sqlite_error)?;
                let rows = statement
                    .query_map(params![space_id], map_access_request)
                    .map_err(map_sqlite_error)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(map_sqlite_error)?;
                for row in rows {
                    out.push(finish_access_request(row)?);
                }
            }
            Ok(out)
        })
        .await
    }

    /// 我自己发出的申请(最近 50 条)。
    pub async fn my_access_requests(&self, requester_id: &str) -> Result<Vec<AccessRequest>> {
        let requester_id = requester_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {ACCESS_COLUMNS} FROM access_requests WHERE requester_id = ?1 \
                     ORDER BY created_at DESC, id LIMIT 50"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![requester_id], map_access_request)
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(finish_access_request).collect()
        })
        .await
    }

    /// 按 id 取一条申请。
    pub async fn get_access_request(&self, id: &str) -> Result<Option<AccessRequest>> {
        let id = id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                &format!("SELECT {ACCESS_COLUMNS} FROM access_requests WHERE id = ?1"),
                params![id],
                map_access_request,
            )
            .optional()
            .map_err(map_sqlite_error)?
            .map(finish_access_request)
            .transpose()
        })
        .await
    }

    /// 处理申请:通过(写入授权,角色可以改成别的)或拒绝。只能处理待处理的;并发的两次处理只有一次生效。
    /// 调用方已经确认过处理人对这个资源有「可管理」。通过时申请人必须仍是可用账号。
    pub async fn decide_access_request(
        &self,
        id: &str,
        decided_by: &str,
        approve: bool,
        granted_role: Option<Role>,
        now: Millis,
    ) -> Result<AccessRequest> {
        let (id, decided_by) = (id.to_owned(), decided_by.to_owned());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let found = tx
                .query_row(
                    &format!("SELECT {ACCESS_COLUMNS} FROM access_requests WHERE id = ?1"),
                    params![id],
                    map_access_request,
                )
                .optional()
                .map_err(map_sqlite_error)?
                .map(finish_access_request)
                .transpose()?;
            let Some(mut request) = found.filter(|r| r.state == RequestState::Pending) else {
                return Err(KbError::NotFound("没有这条待处理的申请".to_owned()));
            };
            if approve {
                let key = ResourceKey::parse(&request.resource_key)?;
                let role = granted_role.unwrap_or(request.role);
                upsert_grant(
                    &tx,
                    &key,
                    &request.requester_id,
                    role,
                    &format!("request:{}", request.id),
                    &decided_by,
                    now,
                    None,
                )?;
                request.role = role;
            }
            let state = if approve { RequestState::Approved } else { RequestState::Rejected };
            tx.execute(
                "UPDATE access_requests SET state = ?2, decided_by = ?3, decided_at = ?4, role = ?5 WHERE id = ?1",
                params![request.id, state.as_str(), decided_by, now, request.role.as_str()],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            request.state = state;
            request.decided_by = Some(decided_by);
            request.decided_at = Some(now);
            Ok(request)
        })
        .await
    }
}
