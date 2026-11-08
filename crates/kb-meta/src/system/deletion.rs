//! 账号注销:申请 → 冷静期 → 可撤销 → 到期由后台任务真正删除(多用户设计说明)。
//!
//! 冷静期内账号仍可登录(这样才能撤销),状态是 `deleting`。
//! 删除分两步,**先文件后行**:调用方先删磁盘上的知识库目录和头像,最后才调 [`SystemStore::purge_user`] 删库里的行。
//! 反过来(先删行)失败时磁盘目录会变成没人再去清理的孤儿;先删文件失败只是下一轮重试。

use kb_core::account::{PRIMARY_SPACE_ID, UserStatus};
use kb_core::model::Millis;
use kb_core::model::identity::Purgeable;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};

use super::SystemStore;
use super::users::{active_admins, load_user};
use crate::sql::map_sqlite_error;

impl SystemStore {
    /// 申请注销。返回冷静期结束的时间。
    ///
    /// - 已经在冷静期:返回**原来的**结束时间,不重置(不能靠重复申请把期限往后拖或往前挪)。
    /// - 最后一个管理员不能注销:冷静期结束后他就不在了,系统里必须至少留一个。
    /// - 被停用的账号不能自助注销(需要管理员处理)。
    pub async fn request_deletion(
        &self,
        user_id: &str,
        now: Millis,
        cooling_off_ms: i64,
    ) -> Result<Millis> {
        Ok(self
            .request_deletion_detailed(user_id, now, cooling_off_ms)
            .await?
            .0)
    }

    /// 同 [`SystemStore::request_deletion`],另外告诉调用方这次是不是**新申请**(账号刚从正常变成注销中)。
    /// 通知邮件只在新申请时发:重复点击或网络重试不该把原主人的邮箱刷屏。
    pub async fn request_deletion_detailed(
        &self,
        user_id: &str,
        now: Millis,
        cooling_off_ms: i64,
    ) -> Result<(Millis, bool)> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let Some(user) = load_user(&tx, &user_id)? else {
                return Err(KbError::NotFound(format!("用户 {user_id}")));
            };
            match user.status {
                UserStatus::Deleting => {
                    return Ok((user.delete_after.unwrap_or(now + cooling_off_ms), false));
                }
                UserStatus::Disabled => {
                    return Err(KbError::Forbidden("账号已被停用,请联系管理员".to_owned()));
                }
                UserStatus::Active | UserStatus::PendingEmail => {}
            }
            // 先说更根本的障碍:主知识库这条对这个人永久成立,「最后一个管理员」只是暂时的。
            // 反过来排的话,用户照着「把管理员角色交给别人」做完,再申请又被主知识库拦住,白绕一圈
            // 主知识库就是数据根目录本身(`KB_HOME`):清理它等于删掉整个数据目录,所以拥有它的人不能注销
            let owns_primary: bool = tx
                .query_row(
                    "SELECT COUNT(*) FROM spaces WHERE owner_id = ?1 AND id = ?2",
                    params![user_id, PRIMARY_SPACE_ID],
                    |row| Ok(row.get::<_, i64>(0)? > 0),
                )
                .map_err(map_sqlite_error)?;
            if owns_primary {
                return Err(KbError::Forbidden(
                    "你的知识库是系统的主知识库(数据根目录),不能直接注销。请联系系统维护者转移后再操作"
                        .to_owned(),
                ));
            }
            let is_admin: bool = tx
                .query_row(
                    "SELECT all_features FROM roles WHERE id = ?1",
                    params![user.role_id],
                    |row| Ok(row.get::<_, i64>(0)? != 0),
                )
                .map_err(map_sqlite_error)?;
            if is_admin && active_admins(&tx, Some(&user_id))? == 0 {
                return Err(KbError::Forbidden(
                    "你是系统里最后一个管理员,不能注销。请先把管理员角色交给别人".to_owned(),
                ));
            }
            let delete_after = now + cooling_off_ms;
            tx.execute(
                "UPDATE users SET status = 'deleting', delete_after = ?2 WHERE id = ?1",
                params![user_id, delete_after],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok((delete_after, true))
        })
        .await
    }

    /// 撤销注销:回到正常状态。
    ///
    /// **冷静期一结束就不能再撤销**(`delete_after <= now`)。这是故意的:清理任务只处理已到期的账号,
    /// 到期的那一刻撤销权同时消失,中间不留缝——否则「任务列出他之后、删文件之前他刚好撤销」
    /// 会让账号恢复正常而数据已经被删。边界和 [`SystemStore::due_for_deletion`] 严格互补。
    pub async fn cancel_deletion(&self, user_id: &str, now: Millis) -> Result<()> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE users SET status = 'active', delete_after = NULL WHERE id = ?1 AND status = 'deleting' AND delete_after > ?2",
                    params![user_id, now],
                )
                .map_err(map_sqlite_error)?;
            if changed > 0 {
                return Ok(());
            }
            let status: Option<(String, Option<Millis>)> = conn
                .query_row(
                    "SELECT status, delete_after FROM users WHERE id = ?1",
                    params![user_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            Err(match status {
                Some((status, Some(at))) if status == "deleting" && at <= now => {
                    KbError::Exists("冷静期已经结束,账号即将被删除,不能再撤销".to_owned())
                }
                Some(_) => KbError::InvalidInput("这个账号没有在注销中".to_owned()),
                None => KbError::NotFound(format!("用户 {user_id}")),
            })
        })
        .await
    }

    /// 冷静期已经结束、该真正删除的用户 id。
    pub async fn due_for_deletion(&self, now: Millis) -> Result<Vec<String>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM users WHERE status = 'deleting' AND delete_after IS NOT NULL AND delete_after <= ?1 ORDER BY delete_after",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![now], |row| row.get::<_, String>(0))
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)
        })
        .await
    }

    /// 只读地检查:现在能不能清理这个用户。清理任务**在删任何文件之前**先调它,
    /// 否则会出现「目录已经删了,库里却因为团队知识库等原因拒绝删账号」的半截状态。
    /// 规则与 [`SystemStore::purge_user`] 完全一致(共用同一个函数)。
    pub async fn check_purgeable(&self, user_id: &str, now: Millis) -> Result<Purgeable> {
        let user_id = user_id.to_owned();
        self.read(move |conn| purgeable(conn, &user_id, now)).await
    }

    /// 删除库里这个用户的所有行(账号、个人知识库记录、会话、令牌、功能例外)。
    ///
    /// 只肯删**已经到期的注销中账号**:误传一个活人的 id 不会删掉他。
    /// 主知识库的拥有者、仍拥有团队知识库的用户拒绝删除。
    /// 审计记录与邀请码使用记录**保留**(它们没有外键,里面的用户 id 之后显示为「账号已删除」)。
    /// 磁盘上的知识库目录与头像由调用方**先**清理,见模块说明。
    pub async fn purge_user(&self, user_id: &str, now: Millis) -> Result<()> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            if purgeable(&tx, &user_id, now)? == Purgeable::AlreadyGone {
                return Ok(()); // 已经删过了:重试时安静通过
            }
            // 不依赖外键级联:每张表都显式删,顺序是先子后父
            for sql in [
                "DELETE FROM sessions WHERE user_id = ?1",
                "DELETE FROM api_tokens WHERE user_id = ?1",
                "DELETE FROM user_admin_keys WHERE user_id = ?1",
                "DELETE FROM user_feature_overrides WHERE user_id = ?1",
                "DELETE FROM user_prefs WHERE user_id = ?1",
                "DELETE FROM llm_user_usage WHERE user_id = ?1",
                "DELETE FROM friend_requests WHERE from_id = ?1 OR to_id = ?1",
                "DELETE FROM friendships WHERE user_id = ?1 OR friend_id = ?1",
                "DELETE FROM blocks WHERE user_id = ?1 OR blocked_id = ?1",
                "DELETE FROM user_recovery_codes WHERE user_id = ?1",
                "DELETE FROM user_totp WHERE user_id = ?1",
                "DELETE FROM notifications WHERE user_id = ?1",
                "DELETE FROM notify_prefs WHERE user_id = ?1",
                // 授权:我是被授权人的、以及我的知识库里的全部授权 / 停止继承 / 访问申请
                "DELETE FROM grants WHERE grantee_id = ?1 OR space_id IN (SELECT id FROM spaces WHERE owner_id = ?1)",
                "DELETE FROM inherit_breaks WHERE space_id IN (SELECT id FROM spaces WHERE owner_id = ?1)",
                "DELETE FROM hidden_shares WHERE user_id = ?1",
                // 分享链接:我创建的、以及指向我的知识库的,连同合集条目 / 访问者 / 流量
                "DELETE FROM share_link_items WHERE link_id IN (SELECT id FROM share_links WHERE created_by = ?1 OR space_id IN (SELECT id FROM spaces WHERE owner_id = ?1))",
                "DELETE FROM link_visitors WHERE user_id = ?1 OR link_id IN (SELECT id FROM share_links WHERE created_by = ?1 OR space_id IN (SELECT id FROM spaces WHERE owner_id = ?1))",
                "DELETE FROM link_daily_bytes WHERE link_id IN (SELECT id FROM share_links WHERE created_by = ?1 OR space_id IN (SELECT id FROM spaces WHERE owner_id = ?1))",
                "DELETE FROM share_links WHERE created_by = ?1 OR space_id IN (SELECT id FROM spaces WHERE owner_id = ?1)",
                "DELETE FROM access_requests WHERE requester_id = ?1 OR space_id IN (SELECT id FROM spaces WHERE owner_id = ?1)",
                "DELETE FROM notify_mail_queue WHERE user_id = ?1",
                "DELETE FROM notify_mail_state WHERE user_id = ?1",
                "DELETE FROM space_usage WHERE space_id IN (SELECT id FROM spaces WHERE owner_id = ?1)",
                "DELETE FROM spaces WHERE owner_id = ?1",
                "DELETE FROM users WHERE id = ?1",
            ] {
                tx.execute(sql, params![user_id])
                    .map_err(map_sqlite_error)?;
            }
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }
}

/// 能不能清理的唯一判断(检查和真正删除共用,规则不会漂移)。
fn purgeable(conn: &rusqlite::Connection, user_id: &str, now: Millis) -> Result<Purgeable> {
    let due: Option<bool> = conn
        .query_row(
            "SELECT status = 'deleting' AND delete_after IS NOT NULL AND delete_after <= ?2 FROM users WHERE id = ?1",
            params![user_id, now],
            |row| Ok(row.get::<_, i64>(0)? != 0),
        )
        .optional()
        .map_err(map_sqlite_error)?;
    match due {
        None => return Ok(Purgeable::AlreadyGone),
        Some(false) => {
            return Err(KbError::Forbidden(
                "这个账号没有到期的注销申请,不能删除".to_owned(),
            ));
        }
        Some(true) => {}
    }
    // 纵深防御:申请阶段已经拒绝了主知识库的拥有者,这里再挡一次(状态被人直接改成 deleting 也不行)
    let owns_primary: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM spaces WHERE owner_id = ?1 AND id = ?2",
            params![user_id, PRIMARY_SPACE_ID],
            |row| row.get(0),
        )
        .map_err(map_sqlite_error)?;
    if owns_primary > 0 {
        return Err(KbError::Forbidden("主知识库的拥有者不能被清理".to_owned()));
    }
    let teams: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM spaces WHERE owner_id = ?1 AND kind = 'team'",
            params![user_id],
            |row| row.get(0),
        )
        .map_err(map_sqlite_error)?;
    if teams > 0 {
        return Err(KbError::Exists(
            "这个账号仍拥有团队知识库,请先转让或解散".to_owned(),
        ));
    }
    Ok(Purgeable::Yes)
}
