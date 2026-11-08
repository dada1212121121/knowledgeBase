//! 好友:搜索、申请、处理、列表、备注分组、删除、拉黑、隐私设置(多用户设计说明)。
//!
//! 规则全部在这里、在**事务**里执行,不留给调用方去「先查后写」——
//! 两个人同时点「通过」「互相申请」「一边拉黑一边申请」这类并发场景才不会写出矛盾的状态。
//!
//! 防枚举:搜索只认**完整**用户名 / 邮箱;找不到、对方不允许被搜到、对方把我拉黑,三种情况返回一模一样的「没有」。

use kb_core::account::{User, UserStatus, normalize_email, normalize_username};
use kb_core::model::Millis;
use kb_core::model::identity::{Caps, Decision, RequestOutcome};
use kb_core::social::{
    Friend, FriendRequest, MAX_GROUP, MAX_OUTGOING_PENDING, MAX_REMARK, MAX_REQUEST_MESSAGE,
    Privacy, PublicProfile, REJECT_COOLDOWN_MS, REQUEST_TTL_MS, Relation, RequestState,
};
use kb_core::{KbError, Result};
use rusqlite::{Connection, OptionalExtension, params};

use super::users::load_user;
use super::{SystemStore, new_id};
use crate::sql::map_sqlite_error;

fn profile_of(user: &User) -> PublicProfile {
    PublicProfile {
        id: user.id.clone(),
        username: user.username.clone(),
        display_name: user.display_name.clone(),
        avatar: user.avatar.clone(),
    }
}

fn map_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<(FriendRequest, String)> {
    Ok((
        FriendRequest {
            id: row.get(0)?,
            from_id: row.get(1)?,
            to_id: row.get(2)?,
            message: row.get(3)?,
            state: RequestState::Pending,
            created_at: row.get(5)?,
            expires_at: row.get(6)?,
            decided_at: row.get(7)?,
        },
        row.get::<_, String>(4)?,
    ))
}

fn finish_request((mut request, state): (FriendRequest, String)) -> Result<FriendRequest> {
    request.state = RequestState::parse(&state)
        .ok_or_else(|| KbError::Internal(format!("库里有未知的申请状态 {state}")))?;
    Ok(request)
}

const REQUEST_COLUMNS: &str =
    "id, from_id, to_id, message, state, created_at, expires_at, decided_at";

fn are_friends(conn: &Connection, a: &str, b: &str) -> Result<bool> {
    conn.query_row(
        "SELECT 1 FROM friendships WHERE user_id = ?1 AND friend_id = ?2",
        params![a, b],
        |_| Ok(()),
    )
    .optional()
    .map_err(map_sqlite_error)
    .map(|found| found.is_some())
}

/// `by` 是否拉黑了 `target`。
fn has_blocked(conn: &Connection, by: &str, target: &str) -> Result<bool> {
    conn.query_row(
        "SELECT 1 FROM blocks WHERE user_id = ?1 AND blocked_id = ?2",
        params![by, target],
        |_| Ok(()),
    )
    .optional()
    .map_err(map_sqlite_error)
    .map(|found| found.is_some())
}

fn friend_count(conn: &Connection, user: &str) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM friendships WHERE user_id = ?1",
        params![user],
        |row| row.get(0),
    )
    .map_err(map_sqlite_error)
}

fn insert_friendship(conn: &Connection, a: &str, b: &str, now: Millis) -> Result<()> {
    for (user, friend) in [(a, b), (b, a)] {
        conn.execute(
            "INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at) VALUES (?1, ?2, ?3)",
            params![user, friend, now],
        )
        .map_err(map_sqlite_error)?;
    }
    Ok(())
}

/// 把已经过期的待处理申请标成过期(每次读写前顺手做,不依赖定时任务)。
fn expire_stale(conn: &Connection, now: Millis) -> Result<()> {
    conn.execute(
        "UPDATE friend_requests SET state = 'expired', decided_at = ?1 \
         WHERE state IN ('pending','ignored') AND expires_at <= ?1",
        params![now],
    )
    .map_err(map_sqlite_error)?;
    Ok(())
}

/// 一个人此刻能不能被当作好友对象:账号存在且可用。
fn live_user(conn: &Connection, id: &str) -> Result<Option<User>> {
    Ok(load_user(conn, id)?.filter(|user| user.status == UserStatus::Active))
}

impl SystemStore {
    /// 按**完整**用户名或邮箱找人。找不到 / 不允许被搜到 / 把我拉黑了 / 是我自己,都返回 `None`,
    /// 外界分辨不出是哪一种。返回的 `Relation` 告诉界面该显示「加好友」「已是好友」还是「等待中」。
    pub async fn find_for_friending(
        &self,
        searcher_id: &str,
        query: &str,
        now: Millis,
    ) -> Result<Option<(PublicProfile, Relation)>> {
        let (searcher, raw) = (searcher_id.to_owned(), query.trim().to_owned());
        self.write(move |conn| {
            expire_stale(conn, now)?;
            let by_email = raw.contains('@');
            // 格式不合法的查询当作没找到,不报「格式错误」(那同样能被拿来探测)
            let Ok(normalized) = (if by_email {
                normalize_email(&raw)
            } else {
                normalize_username(&raw)
            }) else {
                return Ok(None);
            };
            let found: Option<String> = if by_email {
                conn.query_row(
                    "SELECT id FROM users WHERE email = ?1 AND email_verified_at IS NOT NULL",
                    params![normalized],
                    |row| row.get(0),
                )
            } else {
                conn.query_row(
                    "SELECT id FROM users WHERE username = ?1",
                    params![normalized],
                    |row| row.get(0),
                )
            }
            .optional()
            .map_err(map_sqlite_error)?;
            let Some(target_id) = found else {
                return Ok(None);
            };
            if target_id == searcher {
                return Ok(None);
            }
            let Some(target) = live_user(conn, &target_id)? else {
                return Ok(None);
            };
            let privacy = Privacy::parse(&target.privacy_json);
            let allowed = if by_email {
                privacy.searchable_by_email
            } else {
                privacy.searchable_by_username
            };
            // 好友之间不受搜索隐私限制(已经认识了);否则必须对方允许
            let friends = are_friends(conn, &searcher, &target_id)?;
            if !allowed && !friends {
                return Ok(None);
            }
            if has_blocked(conn, &target_id, &searcher)?
                || has_blocked(conn, &searcher, &target_id)?
            {
                return Ok(None);
            }
            let relation = if friends {
                Relation::Friend
            } else {
                let pending = |from: &str, to: &str| -> Result<bool> {
                    conn.query_row(
                        "SELECT 1 FROM friend_requests WHERE from_id = ?1 AND to_id = ?2 \
                         AND state IN ('pending','ignored')",
                        params![from, to],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(map_sqlite_error)
                    .map(|found| found.is_some())
                };
                if pending(&searcher, &target_id)? {
                    Relation::PendingOut
                } else if pending(&target_id, &searcher)? {
                    Relation::PendingIn
                } else {
                    Relation::None
                }
            };
            Ok(Some((profile_of(&target), relation)))
        })
        .await
    }

    /// 发好友申请。所有规则都在一个事务里:
    /// 不能加自己;对方不存在 / 不可用 → 找不到;对方拉黑了我 → [`RequestOutcome::Silent`];
    /// 已是好友 → 不重复;对方已经向我发过申请 → 直接互为好友;我发的还在等 → 不重复;
    /// 被拒后 24 小时内不能再申请;自己同时挂着的申请有上限;自己的好友数不能已满。
    pub async fn send_friend_request(
        &self,
        from_id: &str,
        to_id: &str,
        message: Option<&str>,
        caps: Caps,
        now: Millis,
    ) -> Result<RequestOutcome> {
        let message = match message.map(str::trim).filter(|text| !text.is_empty()) {
            Some(text) if text.chars().count() > MAX_REQUEST_MESSAGE => {
                return Err(KbError::InvalidInput(format!(
                    "附言最多 {MAX_REQUEST_MESSAGE} 个字"
                )));
            }
            Some(text) if text.chars().any(char::is_control) => {
                return Err(KbError::InvalidInput(
                    "附言不能包含换行等控制字符".to_owned(),
                ));
            }
            other => other.map(str::to_owned),
        };
        let (from, to) = (from_id.to_owned(), to_id.to_owned());
        if from == to {
            return Err(KbError::InvalidInput("不能加自己为好友".to_owned()));
        }
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            expire_stale(&tx, now)?;
            let Some(_sender) = live_user(&tx, &from)? else {
                return Err(KbError::Forbidden("账号不可用".to_owned()));
            };
            if live_user(&tx, &to)?.is_none() {
                return Err(KbError::NotFound("没有找到这个用户".to_owned()));
            }
            if has_blocked(&tx, &to, &from)? {
                return Ok(RequestOutcome::Silent);
            }
            if has_blocked(&tx, &from, &to)? {
                return Err(KbError::InvalidInput(
                    "你已经拉黑了这个用户,先取消拉黑再申请".to_owned(),
                ));
            }
            if are_friends(&tx, &from, &to)? {
                return Ok(RequestOutcome::AlreadyFriends);
            }
            let incoming: Option<String> = tx
                .query_row(
                    "SELECT id FROM friend_requests WHERE from_id = ?1 AND to_id = ?2 \
                     AND state IN ('pending','ignored')",
                    params![to, from],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            if let Some(request_id) = incoming {
                // 双方都想加:不用再等谁点通过
                ensure_room(&tx, &from, &to, caps)?;
                tx.execute(
                    "UPDATE friend_requests SET state = 'accepted', decided_at = ?2 WHERE id = ?1",
                    params![request_id, now],
                )
                .map_err(map_sqlite_error)?;
                insert_friendship(&tx, &from, &to, now)?;
                tx.commit().map_err(map_sqlite_error)?;
                return Ok(RequestOutcome::AutoAccepted);
            }
            let existing: Option<(FriendRequest, String)> = tx
                .query_row(
                    &format!(
                        "SELECT {REQUEST_COLUMNS} FROM friend_requests \
                         WHERE from_id = ?1 AND to_id = ?2 AND state IN ('pending','ignored')"
                    ),
                    params![from, to],
                    map_request,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            if let Some(found) = existing {
                let mut request = finish_request(found)?;
                // 被对方「忽略」的申请,发起人看到的仍是等待中
                request.state = RequestState::Pending;
                return Ok(RequestOutcome::AlreadyPending(request));
            }
            let rejected_at: Option<Millis> = tx
                .query_row(
                    "SELECT MAX(decided_at) FROM friend_requests \
                     WHERE from_id = ?1 AND to_id = ?2 AND state = 'rejected'",
                    params![from, to],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            if let Some(at) = rejected_at
                && now - at < REJECT_COOLDOWN_MS
            {
                return Err(KbError::Forbidden(
                    "你刚刚向这位用户申请过,请 24 小时后再试".to_owned(),
                ));
            }
            let outgoing: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM friend_requests WHERE from_id = ?1 AND state IN ('pending','ignored')",
                    params![from],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            if outgoing >= MAX_OUTGOING_PENDING {
                return Err(KbError::Forbidden(format!(
                    "你有 {MAX_OUTGOING_PENDING} 个申请还没人处理,等对方回应后再继续申请"
                )));
            }
            if caps.me > 0 && friend_count(&tx, &from)? >= i64::from(caps.me) {
                return Err(KbError::InvalidInput("你的好友数已达上限".to_owned()));
            }
            let request = FriendRequest {
                id: new_id("frq_"),
                from_id: from.clone(),
                to_id: to.clone(),
                message: message.clone(),
                state: RequestState::Pending,
                created_at: now,
                expires_at: now + REQUEST_TTL_MS,
                decided_at: None,
            };
            tx.execute(
                "INSERT INTO friend_requests (id, from_id, to_id, message, state, created_at, expires_at) \
                 VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)",
                params![request.id, from, to, message, now, request.expires_at],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(RequestOutcome::Created(request))
        })
        .await
    }

    /// 处理一条发给我的申请。只有接收人能处理;已处理 / 已过期 / 已被取消的都当作不存在。
    /// 返回处理后的申请(接口据此给发起人发通知)。
    pub async fn decide_friend_request(
        &self,
        request_id: &str,
        decider_id: &str,
        decision: Decision,
        caps: Caps,
        now: Millis,
    ) -> Result<FriendRequest> {
        let (request_id, decider) = (request_id.to_owned(), decider_id.to_owned());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            expire_stale(&tx, now)?;
            let found: Option<(FriendRequest, String)> = tx
                .query_row(
                    &format!("SELECT {REQUEST_COLUMNS} FROM friend_requests WHERE id = ?1"),
                    params![request_id],
                    map_request,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            // 不是发给我的、或者早就处理过了:一律「没有这条申请」
            let not_found = || KbError::NotFound("没有这条好友申请".to_owned());
            let mut request = finish_request(found.ok_or_else(not_found)?)?;
            if request.to_id != decider
                || !matches!(request.state, RequestState::Pending | RequestState::Ignored)
            {
                return Err(not_found());
            }
            // 申请之后任何一方拉黑了对方:申请作废
            if has_blocked(&tx, &decider, &request.from_id)?
                || has_blocked(&tx, &request.from_id, &decider)?
                || live_user(&tx, &request.from_id)?.is_none()
            {
                return Err(not_found());
            }
            let next = match decision {
                Decision::Accept => {
                    ensure_room(&tx, &decider, &request.from_id, caps)?;
                    insert_friendship(&tx, &decider, &request.from_id, now)?;
                    RequestState::Accepted
                }
                Decision::Reject => RequestState::Rejected,
                Decision::Ignore => RequestState::Ignored,
            };
            tx.execute(
                "UPDATE friend_requests SET state = ?2, decided_at = ?3 WHERE id = ?1",
                params![request.id, next.as_str(), now],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            request.state = next;
            request.decided_at = Some(now);
            Ok(request)
        })
        .await
    }

    /// 发给我的、等我处理的申请(带发起人资料),新的在前。已忽略的不再显示。
    pub async fn incoming_friend_requests(
        &self,
        user_id: &str,
        now: Millis,
    ) -> Result<Vec<(FriendRequest, PublicProfile)>> {
        self.requests_of(user_id, now, true).await
    }

    /// 我发出的、还在等的申请(带对方资料)。被对方忽略的仍显示为「等待中」。
    pub async fn outgoing_friend_requests(
        &self,
        user_id: &str,
        now: Millis,
    ) -> Result<Vec<(FriendRequest, PublicProfile)>> {
        self.requests_of(user_id, now, false).await
    }

    async fn requests_of(
        &self,
        user_id: &str,
        now: Millis,
        incoming: bool,
    ) -> Result<Vec<(FriendRequest, PublicProfile)>> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            expire_stale(conn, now)?;
            let (mine, states) = if incoming {
                ("to_id", "('pending')")
            } else {
                ("from_id", "('pending','ignored')")
            };
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {REQUEST_COLUMNS} FROM friend_requests \
                     WHERE {mine} = ?1 AND state IN {states} ORDER BY created_at DESC, id"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![user_id], map_request)
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for row in rows {
                let mut request = finish_request(row)?;
                let other = if incoming {
                    &request.from_id
                } else {
                    &request.to_id
                };
                // 对方账号没了 / 不可用:这条申请没有意义,不显示
                let Some(profile) = live_user(conn, other)? else {
                    continue;
                };
                request.state = RequestState::Pending;
                out.push((request, profile_of(&profile)));
            }
            Ok(out)
        })
        .await
    }

    /// 好友列表(带备注与分组),按备注名 / 昵称排序。账号已不可用的好友不显示。
    pub async fn list_friends(&self, user_id: &str) -> Result<Vec<Friend>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT f.friend_id, f.remark, f.group_name, f.created_at FROM friendships f \
                     WHERE f.user_id = ?1",
                )
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![user_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Millis>(3)?,
                    ))
                })
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            let mut friends = Vec::new();
            for (friend_id, remark, group_name, since) in rows {
                if let Some(user) = live_user(conn, &friend_id)? {
                    friends.push(Friend {
                        profile: profile_of(&user),
                        remark,
                        group_name,
                        since,
                    });
                }
            }
            friends.sort_by(|a, b| {
                let key = |friend: &Friend| {
                    friend
                        .remark
                        .clone()
                        .unwrap_or_else(|| friend.profile.display_name.clone())
                        .to_lowercase()
                };
                key(a)
                    .cmp(&key(b))
                    .then_with(|| a.profile.id.cmp(&b.profile.id))
            });
            Ok(friends)
        })
        .await
    }

    /// 改好友的备注名和分组(只改我这一行,对方看到的不变)。`None` = 不动,`Some(None)` = 清空。
    pub async fn update_friend(
        &self,
        user_id: &str,
        friend_id: &str,
        remark: Option<Option<String>>,
        group_name: Option<Option<String>>,
    ) -> Result<()> {
        let clean = |value: Option<Option<String>>,
                     max: usize,
                     what: &str|
         -> Result<Option<Option<String>>> {
            match value {
                None => Ok(None),
                Some(None) => Ok(Some(None)),
                Some(Some(text)) => {
                    let text = text.trim().to_owned();
                    if text.is_empty() {
                        return Ok(Some(None));
                    }
                    if text.chars().count() > max {
                        return Err(KbError::InvalidInput(format!("{what}最多 {max} 个字")));
                    }
                    if text.chars().any(char::is_control) {
                        return Err(KbError::InvalidInput(format!(
                            "{what}不能包含换行等控制字符"
                        )));
                    }
                    Ok(Some(Some(text)))
                }
            }
        };
        let remark = clean(remark, MAX_REMARK, "备注名")?;
        let group_name = clean(group_name, MAX_GROUP, "分组名")?;
        let (user_id, friend_id) = (user_id.to_owned(), friend_id.to_owned());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            if !are_friends(&tx, &user_id, &friend_id)? {
                return Err(KbError::NotFound("他不是你的好友".to_owned()));
            }
            if let Some(value) = remark {
                tx.execute(
                    "UPDATE friendships SET remark = ?3 WHERE user_id = ?1 AND friend_id = ?2",
                    params![user_id, friend_id, value],
                )
                .map_err(map_sqlite_error)?;
            }
            if let Some(value) = group_name {
                tx.execute(
                    "UPDATE friendships SET group_name = ?3 WHERE user_id = ?1 AND friend_id = ?2",
                    params![user_id, friend_id, value],
                )
                .map_err(map_sqlite_error)?;
            }
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }

    /// 删除好友(双向)。已有的分享不动——分享和好友是两回事,由调用方提示是否一并移除。
    /// 返回之前是不是好友。
    pub async fn remove_friend(&self, user_id: &str, friend_id: &str) -> Result<bool> {
        let (user_id, friend_id) = (user_id.to_owned(), friend_id.to_owned());
        self.write(move |conn| {
            let removed = conn
                .execute(
                    "DELETE FROM friendships WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)",
                    params![user_id, friend_id],
                )
                .map_err(map_sqlite_error)?;
            Ok(removed > 0)
        })
        .await
    }

    /// 拉黑:同时解除好友关系、作废两人之间所有没处理完的申请。对方不会收到任何通知。
    pub async fn block_user(&self, user_id: &str, target_id: &str, now: Millis) -> Result<()> {
        if user_id == target_id {
            return Err(KbError::InvalidInput("不能拉黑自己".to_owned()));
        }
        let (user_id, target_id) = (user_id.to_owned(), target_id.to_owned());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            if load_user(&tx, &target_id)?.is_none() {
                return Err(KbError::NotFound("没有找到这个用户".to_owned()));
            }
            tx.execute(
                "INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?1, ?2, ?3)",
                params![user_id, target_id, now],
            )
            .map_err(map_sqlite_error)?;
            tx.execute(
                "DELETE FROM friendships WHERE (user_id = ?1 AND friend_id = ?2) OR (user_id = ?2 AND friend_id = ?1)",
                params![user_id, target_id],
            )
            .map_err(map_sqlite_error)?;
            tx.execute(
                "DELETE FROM friend_requests WHERE state IN ('pending','ignored') \
                 AND ((from_id = ?1 AND to_id = ?2) OR (from_id = ?2 AND to_id = ?1))",
                params![user_id, target_id],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }

    /// 取消拉黑。
    pub async fn unblock_user(&self, user_id: &str, target_id: &str) -> Result<bool> {
        let (user_id, target_id) = (user_id.to_owned(), target_id.to_owned());
        self.write(move |conn| {
            let removed = conn
                .execute(
                    "DELETE FROM blocks WHERE user_id = ?1 AND blocked_id = ?2",
                    params![user_id, target_id],
                )
                .map_err(map_sqlite_error)?;
            Ok(removed > 0)
        })
        .await
    }

    /// 我拉黑的人。
    pub async fn list_blocks(&self, user_id: &str) -> Result<Vec<(PublicProfile, Millis)>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare("SELECT blocked_id, created_at FROM blocks WHERE user_id = ?1 ORDER BY created_at DESC")
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![user_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Millis>(1)?))
                })
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            let mut out = Vec::new();
            for (id, at) in rows {
                if let Some(user) = load_user(conn, &id)? {
                    out.push((profile_of(&user), at));
                }
            }
            Ok(out)
        })
        .await
    }

    /// 两人是不是好友(分享、@ 提及判断用)。
    pub async fn are_friends(&self, a: &str, b: &str) -> Result<bool> {
        let (a, b) = (a.to_owned(), b.to_owned());
        self.read(move |conn| are_friends(conn, &a, &b)).await
    }

    /// 两人之间有没有任何一方拉黑了另一方。
    pub async fn is_blocked_between(&self, a: &str, b: &str) -> Result<bool> {
        let (a, b) = (a.to_owned(), b.to_owned());
        self.read(move |conn| Ok(has_blocked(conn, &a, &b)? || has_blocked(conn, &b, &a)?))
            .await
    }

    /// 我现在有几个好友。
    pub async fn friend_count(&self, user_id: &str) -> Result<i64> {
        let user_id = user_id.to_owned();
        self.read(move |conn| friend_count(conn, &user_id)).await
    }

    /// 读隐私设置(缺的键按默认)。
    pub async fn privacy_of(&self, user_id: &str) -> Result<Privacy> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let user = load_user(conn, &user_id)?
                .ok_or_else(|| KbError::NotFound(format!("用户 {user_id}")))?;
            Ok(Privacy::parse(&user.privacy_json))
        })
        .await
    }

    /// 写隐私设置。
    pub async fn set_privacy(&self, user_id: &str, privacy: Privacy) -> Result<()> {
        let user_id = user_id.to_owned();
        let text = serde_json::to_string(&privacy)
            .map_err(|err| KbError::Internal(format!("序列化隐私设置失败:{err}")))?;
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE users SET privacy_json = ?2 WHERE id = ?1",
                    params![user_id, text],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("用户 {user_id}")));
            }
            Ok(())
        })
        .await
    }

    /// 自动成为好友(邀请码带「自动加好友」时,新用户和邀请人)。已是好友或被拉黑都安静地跳过。
    /// 返回是否新建了好友关系。
    pub async fn make_friends(&self, a: &str, b: &str, caps: Caps, now: Millis) -> Result<bool> {
        if a == b {
            return Ok(false);
        }
        let (a, b) = (a.to_owned(), b.to_owned());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            if live_user(&tx, &a)?.is_none()
                || live_user(&tx, &b)?.is_none()
                || are_friends(&tx, &a, &b)?
                || has_blocked(&tx, &a, &b)?
                || has_blocked(&tx, &b, &a)?
            {
                return Ok(false);
            }
            if ensure_room(&tx, &a, &b, caps).is_err() {
                return Ok(false);
            }
            insert_friendship(&tx, &a, &b, now)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(true)
        })
        .await
    }
}

/// 两个人加一个好友之后,各自的好友数都不能超过各自的上限(0 = 不限)。
fn ensure_room(conn: &Connection, me: &str, other: &str, caps: Caps) -> Result<()> {
    if caps.me > 0 && friend_count(conn, me)? >= i64::from(caps.me) {
        return Err(KbError::InvalidInput("你的好友数已达上限".to_owned()));
    }
    if caps.other > 0 && friend_count(conn, other)? >= i64::from(caps.other) {
        return Err(KbError::InvalidInput(
            "对方的好友数已达上限,暂时不能成为好友".to_owned(),
        ));
    }
    Ok(())
}
