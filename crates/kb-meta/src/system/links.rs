//! 分享链接与游客的存储(多用户设计说明)。
//!
//! 令牌明文只在 [`SystemStore::create_link`] / [`SystemStore::reset_link_token`] 返回一次,库里只有 sha256。
//! 访问密码的哈希由调用方算好传进来(存储层不带 argon2)。

use std::collections::BTreeSet;

use kb_core::model::Millis;
use kb_core::model::identity::{Guest, LinkRecord, LinkUpdate, LinkVisitor, NewLink};
use kb_core::share::link::{Audience, ShareLink, looks_like_token, new_token};
use kb_core::share::{ResourceKey, Role};
use kb_core::token::sha256_hex;
use kb_core::{KbError, Result};
use rusqlite::{Connection, OptionalExtension, params};

use super::{SystemStore, new_id};
use crate::sql::map_sqlite_error;

/// 合集链接最多包含多少项。
pub const MAX_BUNDLE_ITEMS: usize = 500;
/// 昵称最长字符数。
pub const MAX_NICKNAME: usize = 20;

const LINK_COLUMNS: &str = "id, token_hint, space_id, resource_key, title, audience, role, password_hash, expires_at, \
     allow_download, watermark, allow_reshare, enabled, views, last_view_at, created_by, created_at, revoked_at";

fn row_to_record(
    conn: &Connection,
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(LinkRecord, String, String)> {
    let id: String = row.get(0)?;
    let password_hash: Option<String> = row.get(7)?;
    let link = ShareLink {
        id: id.clone(),
        token_hint: row.get(1)?,
        space_id: row.get(2)?,
        resource_key: row.get(3)?,
        title: row.get(4)?,
        audience: Audience::Collaborators,
        role: Role::Viewer,
        has_password: password_hash.is_some(),
        expires_at: row.get(8)?,
        allow_download: row.get::<_, i64>(9)? != 0,
        watermark: row.get::<_, i64>(10)? != 0,
        allow_reshare: row.get::<_, i64>(11)? != 0,
        enabled: row.get::<_, i64>(12)? != 0,
        views: row.get(13)?,
        last_view_at: row.get(14)?,
        created_by: row.get(15)?,
        created_at: row.get(16)?,
        revoked_at: row.get(17)?,
    };
    let mut statement = conn
        .prepare("SELECT resource_key FROM share_link_items WHERE link_id = ?1 ORDER BY ordinal")?;
    let items = statement
        .query_map(params![id], |item| item.get::<_, String>(0))?
        .filter_map(|text| text.ok().and_then(|text| ResourceKey::parse(&text).ok()))
        .collect();
    Ok((
        LinkRecord {
            link,
            password_hash,
            items,
        },
        row.get(5)?,
        row.get(6)?,
    ))
}

fn finish((mut record, audience, role): (LinkRecord, String, String)) -> Result<LinkRecord> {
    record.link.audience = Audience::parse(&audience)?;
    record.link.role = Role::parse(&role)?;
    Ok(record)
}

fn load_by(conn: &Connection, column: &str, value: &str) -> Result<Option<LinkRecord>> {
    conn.query_row(
        &format!("SELECT {LINK_COLUMNS} FROM share_links WHERE {column} = ?1"),
        params![value],
        |row| row_to_record(conn, row),
    )
    .optional()
    .map_err(map_sqlite_error)?
    .map(finish)
    .transpose()
}

fn check_nickname(raw: &str) -> Result<String> {
    let name = raw.trim();
    let length = name.chars().count();
    if length == 0 || length > MAX_NICKNAME {
        return Err(KbError::InvalidInput(format!("昵称 1–{MAX_NICKNAME} 个字")));
    }
    if name
        .chars()
        .any(|ch| ch.is_control() || ch == '<' || ch == '>')
    {
        return Err(KbError::InvalidInput(
            "昵称不能包含换行或 < > 符号".to_owned(),
        ));
    }
    Ok(name.to_owned())
}

impl SystemStore {
    /// 新建链接,返回 `(链接, 令牌明文)`。明文只此一次。
    ///
    /// `max_links` 是创建人可以同时拥有的(未撤销的)链接数上限,0 = 不限。
    /// 所有资源必须都在同一个知识库里;合集链接 1–500 项。
    pub async fn create_link(
        &self,
        new: NewLink,
        max_links: u32,
        now: Millis,
    ) -> Result<(ShareLink, String)> {
        let space_id = match (&new.resource, new.items.first()) {
            (Some(key), _) => key.space_id().to_owned(),
            (None, Some(key)) => key.space_id().to_owned(),
            (None, None) => return Err(KbError::InvalidInput("没有要分享的内容".to_owned())),
        };
        if new.resource.is_some() && !new.items.is_empty() {
            return Err(KbError::InvalidInput(
                "单个资源链接不能再带合集条目".to_owned(),
            ));
        }
        if new.items.len() > MAX_BUNDLE_ITEMS {
            return Err(KbError::InvalidInput(format!(
                "合集链接最多 {MAX_BUNDLE_ITEMS} 项"
            )));
        }
        if new
            .items
            .iter()
            .chain(new.resource.iter())
            .any(|key| key.space_id() != space_id)
        {
            return Err(KbError::InvalidInput(
                "一个链接里的内容必须来自同一个知识库".to_owned(),
            ));
        }
        if new.expires_at.is_some_and(|at| at <= now) {
            return Err(KbError::InvalidInput("过期时间必须在将来".to_owned()));
        }
        if new.audience == Audience::Anyone && new.role == Role::Owner {
            return Err(KbError::InvalidInput("链接不能给所有者角色".to_owned()));
        }
        let token = new_token();
        let token_hash = sha256_hex(&token);
        let hint: String = token
            .chars()
            .rev()
            .take(4)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let id = new_id("lnk_");
        let link_id = id.clone();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            if max_links > 0 {
                let have: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM share_links WHERE created_by = ?1 AND revoked_at IS NULL",
                        params![new.created_by],
                        |row| row.get(0),
                    )
                    .map_err(map_sqlite_error)?;
                if have >= i64::from(max_links) {
                    return Err(KbError::Forbidden(format!("你最多可以有 {max_links} 个分享链接")));
                }
            }
            tx.execute(
                "INSERT INTO share_links (id, token_hash, token_hint, space_id, resource_key, title, audience, role, \
                 password_hash, expires_at, allow_download, watermark, allow_reshare, created_by, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                params![
                    id,
                    token_hash,
                    hint,
                    space_id,
                    new.resource.as_ref().map(ToString::to_string),
                    new.title,
                    new.audience.as_str(),
                    new.role.as_str(),
                    new.password_hash,
                    new.expires_at,
                    i64::from(new.allow_download),
                    i64::from(new.watermark),
                    i64::from(new.allow_reshare),
                    new.created_by,
                    now
                ],
            )
            .map_err(map_sqlite_error)?;
            for (ordinal, item) in new.items.iter().enumerate() {
                tx.execute(
                    "INSERT OR IGNORE INTO share_link_items (link_id, resource_key, ordinal) VALUES (?1, ?2, ?3)",
                    params![id, item.to_string(), ordinal as i64],
                )
                .map_err(map_sqlite_error)?;
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await?;
        let record = self
            .get_link(&link_id)
            .await?
            .ok_or_else(|| KbError::Internal("刚创建的链接读不到".to_owned()))?;
        Ok((record.link, token))
    }

    /// 凭令牌找链接。令牌格式不对直接 `None`,不去查库。
    pub async fn find_link_by_token(&self, token: &str) -> Result<Option<LinkRecord>> {
        if !looks_like_token(token) {
            return Ok(None);
        }
        let hash = sha256_hex(token);
        self.read(move |conn| load_by(conn, "token_hash", &hash))
            .await
    }

    /// 按 id 取链接。
    pub async fn get_link(&self, id: &str) -> Result<Option<LinkRecord>> {
        let id = id.to_owned();
        self.read(move |conn| load_by(conn, "id", &id)).await
    }

    /// 一个资源上的链接(未撤销的)。
    pub async fn links_for_resource(&self, key: &ResourceKey) -> Result<Vec<LinkRecord>> {
        let text = key.to_string();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {LINK_COLUMNS} FROM share_links WHERE resource_key = ?1 AND revoked_at IS NULL ORDER BY created_at, id"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![text], |row| row_to_record(conn, row))
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(finish).collect()
        })
        .await
    }

    /// 某人创建的链接(含已撤销的,我的分享页要显示状态)。
    pub async fn links_by_creator(&self, user_id: &str) -> Result<Vec<LinkRecord>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {LINK_COLUMNS} FROM share_links WHERE created_by = ?1 ORDER BY created_at DESC, id"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![user_id], |row| row_to_record(conn, row))
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(finish).collect()
        })
        .await
    }

    /// 全站链接(管理员治理用),新的在前,分页。
    pub async fn all_links(&self, limit: u32, offset: u32) -> Result<(Vec<LinkRecord>, i64)> {
        self.read(move |conn| {
            let total: i64 = conn
                .query_row("SELECT COUNT(*) FROM share_links", [], |row| row.get(0))
                .map_err(map_sqlite_error)?;
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {LINK_COLUMNS} FROM share_links ORDER BY created_at DESC, id LIMIT ?1 OFFSET ?2"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![limit, offset], |row| row_to_record(conn, row))
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            Ok((rows.into_iter().map(finish).collect::<Result<Vec<_>>>()?, total))
        })
        .await
    }

    /// 修改链接设置。已撤销的不能改。
    pub async fn update_link(
        &self,
        id: &str,
        update: LinkUpdate,
        now: Millis,
    ) -> Result<LinkRecord> {
        let id = id.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let Some(current) = load_by(&tx, "id", &id)? else {
                return Err(KbError::NotFound("没有这个链接".to_owned()));
            };
            if current.link.revoked_at.is_some() {
                return Err(KbError::NotFound("这个链接已被撤销".to_owned()));
            }
            if let Some(Some(at)) = update.expires_at
                && at <= now
            {
                return Err(KbError::InvalidInput("过期时间必须在将来".to_owned()));
            }
            let link = &current.link;
            tx.execute(
                "UPDATE share_links SET audience = ?2, role = ?3, password_hash = ?4, expires_at = ?5, \
                 allow_download = ?6, watermark = ?7, allow_reshare = ?8, enabled = ?9, title = ?10 WHERE id = ?1",
                params![
                    id,
                    update.audience.unwrap_or(link.audience).as_str(),
                    update.role.unwrap_or(link.role).as_str(),
                    update.password_hash.unwrap_or(current.password_hash.clone()),
                    update.expires_at.unwrap_or(link.expires_at),
                    i64::from(update.allow_download.unwrap_or(link.allow_download)),
                    i64::from(update.watermark.unwrap_or(link.watermark)),
                    i64::from(update.allow_reshare.unwrap_or(link.allow_reshare)),
                    i64::from(update.enabled.unwrap_or(link.enabled)),
                    update.title.unwrap_or(link.title.clone()),
                ],
            )
            .map_err(map_sqlite_error)?;
            let updated = load_by(&tx, "id", &id)?.ok_or_else(|| KbError::Internal("链接丢了".to_owned()))?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(updated)
        })
        .await
    }

    /// 重置链接:换一个新令牌,旧地址立刻作废。返回新令牌明文(只此一次)。
    pub async fn reset_link_token(&self, id: &str) -> Result<String> {
        let token = new_token();
        let (hash, hint) = (
            sha256_hex(&token),
            token
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>(),
        );
        let id = id.to_owned();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE share_links SET token_hash = ?2, token_hint = ?3 WHERE id = ?1 AND revoked_at IS NULL",
                    params![id, hash, hint],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound("没有这个链接".to_owned()));
            }
            Ok(())
        })
        .await?;
        Ok(token)
    }

    /// 撤销链接(不可恢复)。返回之前是否有效。
    pub async fn revoke_link(&self, id: &str, now: Millis) -> Result<bool> {
        let id = id.to_owned();
        self.write(move |conn| {
            Ok(conn
                .execute(
                    "UPDATE share_links SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL",
                    params![id, now],
                )
                .map_err(map_sqlite_error)?
                > 0)
        })
        .await
    }

    /// 记一次打开。登录访问者进名单,匿名的只加次数。
    pub async fn record_link_view(
        &self,
        link_id: &str,
        user_id: Option<&str>,
        now: Millis,
    ) -> Result<()> {
        let (link_id, user_id) = (link_id.to_owned(), user_id.map(str::to_owned));
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            tx.execute(
                "UPDATE share_links SET views = views + 1, last_view_at = ?2 WHERE id = ?1",
                params![link_id, now],
            )
            .map_err(map_sqlite_error)?;
            if let Some(user) = user_id {
                tx.execute(
                    "INSERT INTO link_visitors (link_id, user_id, first_at, last_at) VALUES (?1, ?2, ?3, ?3) \
                     ON CONFLICT(link_id, user_id) DO UPDATE SET last_at = excluded.last_at, visits = visits + 1",
                    params![link_id, user, now],
                )
                .map_err(map_sqlite_error)?;
            }
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }

    /// 链接的登录访问者名单。
    pub async fn link_visitors(&self, link_id: &str) -> Result<Vec<LinkVisitor>> {
        let link_id = link_id.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare("SELECT user_id, first_at, last_at, visits FROM link_visitors WHERE link_id = ?1 ORDER BY last_at DESC")
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![link_id], |row| {
                    Ok(LinkVisitor {
                        user_id: row.get(0)?,
                        first_at: row.get(1)?,
                        last_at: row.get(2)?,
                        visits: row.get(3)?,
                    })
                })
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(map_sqlite_error)
        })
        .await
    }

    /// 当天这个链接已经发出去多少字节,并累加 `add`。返回累加**后**的总数。
    pub async fn add_link_bytes(&self, link_id: &str, day: &str, add: u64) -> Result<u64> {
        let (link_id, day) = (link_id.to_owned(), day.to_owned());
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO link_daily_bytes (link_id, day, bytes) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(link_id, day) DO UPDATE SET bytes = bytes + excluded.bytes",
                params![link_id, day, add as i64],
            )
            .map_err(map_sqlite_error)?;
            let total: i64 = conn
                .query_row(
                    "SELECT bytes FROM link_daily_bytes WHERE link_id = ?1 AND day = ?2",
                    params![link_id, day],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            Ok(total.max(0) as u64)
        })
        .await
    }

    /// 当天已发出的字节数。
    pub async fn link_bytes(&self, link_id: &str, day: &str) -> Result<u64> {
        let (link_id, day) = (link_id.to_owned(), day.to_owned());
        self.read(move |conn| {
            let total: Option<i64> = conn
                .query_row(
                    "SELECT bytes FROM link_daily_bytes WHERE link_id = ?1 AND day = ?2",
                    params![link_id, day],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            Ok(total.unwrap_or(0).max(0) as u64)
        })
        .await
    }

    /// 取或建一个游客。`secret_hash` 是 cookie 里随机串的 sha256。已有的更新「最近出现」。
    pub async fn touch_guest(
        &self,
        secret_hash: &str,
        link_id: &str,
        ip: Option<&str>,
        now: Millis,
    ) -> Result<Guest> {
        let (secret_hash, link_id, ip) = (
            secret_hash.to_owned(),
            link_id.to_owned(),
            ip.map(str::to_owned),
        );
        self.write(move |conn| {
            let nickname = format!("访客 {}", &secret_hash[..4]);
            conn.execute(
                "INSERT INTO guests (id, nickname, first_link_id, ip, created_at, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?5) \
                 ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen",
                params![secret_hash, nickname, link_id, ip, now],
            )
            .map_err(map_sqlite_error)?;
            conn.query_row(
                "SELECT id, nickname, first_link_id, created_at, last_seen FROM guests WHERE id = ?1",
                params![secret_hash],
                |row| {
                    Ok(Guest {
                        id: row.get(0)?,
                        nickname: row.get(1)?,
                        first_link_id: row.get(2)?,
                        created_at: row.get(3)?,
                        last_seen: row.get(4)?,
                    })
                },
            )
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 游客自己改昵称。
    pub async fn set_guest_nickname(&self, guest_id: &str, nickname: &str) -> Result<String> {
        let nickname = check_nickname(nickname)?;
        let (guest_id, saved) = (guest_id.to_owned(), nickname.clone());
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE guests SET nickname = ?2 WHERE id = ?1",
                    params![guest_id, saved],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound("没有这个访客".to_owned()));
            }
            Ok(())
        })
        .await?;
        Ok(nickname)
    }

    /// 清掉很久没出现的游客记录。
    pub async fn purge_stale_guests(&self, before: Millis) -> Result<usize> {
        self.write(move |conn| {
            conn.execute("DELETE FROM guests WHERE last_seen < ?1", params![before])
                .map_err(map_sqlite_error)
        })
        .await
    }

    /// 清理过期的流量记录(只留最近几天)。
    pub async fn purge_link_bytes_before(&self, day: &str) -> Result<usize> {
        let day = day.to_owned();
        self.write(move |conn| {
            conn.execute("DELETE FROM link_daily_bytes WHERE day < ?1", params![day])
                .map_err(map_sqlite_error)
        })
        .await
    }

    /// 删掉一个资源(及它底下)上的链接:撤销。资源被删除时调用,别让链接指向不存在的东西。
    pub async fn revoke_links_within(&self, key: &ResourceKey, now: Millis) -> Result<usize> {
        let (space_id, target) = (key.space_id().to_owned(), key.clone());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let mut ids = BTreeSet::new();
            {
                let mut statement = tx
                    .prepare("SELECT id, resource_key FROM share_links WHERE space_id = ?1 AND revoked_at IS NULL AND resource_key IS NOT NULL")
                    .map_err(map_sqlite_error)?;
                let rows = statement
                    .query_map(params![space_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                    .map_err(map_sqlite_error)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(map_sqlite_error)?;
                for (id, text) in rows {
                    if ResourceKey::parse(&text).is_ok_and(|candidate| candidate.is_within(&target)) {
                        ids.insert(id);
                    }
                }
            }
            {
                // 合集链接自己的 resource_key 可能是集合 / 空间,被删的文件只在 share_link_items 里。
                // 不查这张表就会留下一个「链接还在、点进去文件没了」的合集。
                let mut statement = tx
                    .prepare(
                        "SELECT DISTINCT i.link_id, i.resource_key FROM share_link_items i \
                         JOIN share_links l ON l.id = i.link_id \
                         WHERE l.space_id = ?1 AND l.revoked_at IS NULL",
                    )
                    .map_err(map_sqlite_error)?;
                let rows = statement
                    .query_map(params![space_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                    .map_err(map_sqlite_error)?
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(map_sqlite_error)?;
                for (id, text) in rows {
                    if ResourceKey::parse(&text).is_ok_and(|candidate| candidate.is_within(&target)) {
                        ids.insert(id);
                    }
                }
            }
            let mut revoked = 0;
            for id in ids {
                revoked += tx
                    .execute("UPDATE share_links SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL", params![id, now])
                    .map_err(map_sqlite_error)?;
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(revoked)
        })
        .await
    }
}
