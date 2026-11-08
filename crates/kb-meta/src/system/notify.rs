//! 站内通知与通知邮件的偏好、合并队列(多用户设计说明)。
//!
//! 通知只属于一个人:读、标已读都带上 `user_id` 条件,拿别人的通知 id 什么也改不了、什么也读不到。

use std::collections::HashMap;

use kb_core::model::Millis;
use kb_core::model::identity::Digest;
use kb_core::social::{NOTIFICATION_KEEP_MS, Notification, kind};
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use super::SystemStore;
use crate::sql::map_sqlite_error;

/// 一条通知的内容序列化后最大字节数。内容只放展示和跳转要的几个字段,不放正文。
pub const MAX_DATA_BYTES: usize = 4 * 1024;
/// 一次最多读多少条。
pub const MAX_PAGE: u32 = 100;

fn map_notification(row: &rusqlite::Row<'_>) -> rusqlite::Result<Notification> {
    let text: String = row.get(2)?;
    Ok(Notification {
        id: row.get(0)?,
        kind: row.get(1)?,
        data: serde_json::from_str(&text).unwrap_or(Value::Null),
        read_at: row.get(3)?,
        created_at: row.get(4)?,
    })
}

const NOTIFICATION_COLUMNS: &str = "id, kind, data_json, read_at, created_at";

impl SystemStore {
    /// 给一个人发一条站内通知,返回通知 id。种类必须是已知的;内容必须是对象且不超过 4 KB。
    /// 收件人不存在时返回 `NotFound`(调用方通常忽略:对方刚注销了不是发送方的错)。
    pub async fn add_notification(
        &self,
        user_id: &str,
        notification_kind: &str,
        data: &Value,
        now: Millis,
    ) -> Result<i64> {
        if !kind::ALL.contains(&notification_kind) {
            return Err(KbError::InvalidInput(format!(
                "未知的通知种类 {notification_kind}"
            )));
        }
        if !data.is_object() {
            return Err(KbError::InvalidInput("通知内容必须是 JSON 对象".to_owned()));
        }
        let text = serde_json::to_string(data)
            .map_err(|err| KbError::InvalidInput(format!("通知内容无法序列化:{err}")))?;
        if text.len() > MAX_DATA_BYTES {
            return Err(KbError::InvalidInput("通知内容太大".to_owned()));
        }
        let (user_id, notification_kind) = (user_id.to_owned(), notification_kind.to_owned());
        self.write(move |conn| {
            let exists = conn
                .query_row("SELECT 1 FROM users WHERE id = ?1", params![user_id], |_| Ok(()))
                .optional()
                .map_err(map_sqlite_error)?
                .is_some();
            if !exists {
                return Err(KbError::NotFound(format!("用户 {user_id}")));
            }
            conn.execute(
                "INSERT INTO notifications (user_id, kind, data_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![user_id, notification_kind, text, now],
            )
            .map_err(map_sqlite_error)?;
            Ok(conn.last_insert_rowid())
        })
        .await
    }

    /// 读通知,新的在前。`before_id` 是翻页游标(上一页最后一条的 id)。
    pub async fn list_notifications(
        &self,
        user_id: &str,
        unread_only: bool,
        before_id: Option<i64>,
        limit: u32,
    ) -> Result<Vec<Notification>> {
        let user_id = user_id.to_owned();
        let limit = limit.clamp(1, MAX_PAGE);
        self.read(move |conn| {
            let mut statement = conn
                .prepare(&format!(
                    "SELECT {NOTIFICATION_COLUMNS} FROM notifications \
                     WHERE user_id = ?1 AND (?2 = 0 OR read_at IS NULL) AND (?3 IS NULL OR id < ?3) \
                     ORDER BY id DESC LIMIT ?4"
                ))
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![user_id, i64::from(unread_only), before_id, limit], map_notification)
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(map_sqlite_error)
        })
        .await
    }

    /// 未读条数。
    pub async fn unread_notifications(&self, user_id: &str) -> Result<u64> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let count: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM notifications WHERE user_id = ?1 AND read_at IS NULL",
                    params![user_id],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            Ok(count.max(0) as u64)
        })
        .await
    }

    /// 把这几条标为已读(只动属于自己的)。返回实际改了几条。
    pub async fn mark_notifications_read(
        &self,
        user_id: &str,
        ids: &[i64],
        now: Millis,
    ) -> Result<usize> {
        if ids.is_empty() {
            return Ok(0);
        }
        let (user_id, ids) = (user_id.to_owned(), ids.to_vec());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let mut changed = 0;
            for id in ids {
                changed += tx
                    .execute(
                        "UPDATE notifications SET read_at = ?3 WHERE id = ?1 AND user_id = ?2 AND read_at IS NULL",
                        params![id, user_id, now],
                    )
                    .map_err(map_sqlite_error)?;
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(changed)
        })
        .await
    }

    /// 全部标为已读。
    pub async fn mark_all_notifications_read(&self, user_id: &str, now: Millis) -> Result<usize> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE notifications SET read_at = ?2 WHERE user_id = ?1 AND read_at IS NULL",
                params![user_id, now],
            )
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 清理超过保留期(90 天)的通知,顺带清掉没发出去的陈旧邮件队列项。返回清掉几条通知。
    pub async fn purge_old_notifications(&self, now: Millis) -> Result<usize> {
        self.write(move |conn| {
            let cutoff = now - NOTIFICATION_KEEP_MS;
            let removed = conn
                .execute(
                    "DELETE FROM notifications WHERE created_at < ?1",
                    params![cutoff],
                )
                .map_err(map_sqlite_error)?;
            // 队列项只在几分钟内有意义;超过一天还没发出去(邮件一直发不了)的,放弃
            conn.execute(
                "DELETE FROM notify_mail_queue WHERE created_at < ?1",
                params![now - 86_400_000],
            )
            .map_err(map_sqlite_error)?;
            Ok(removed)
        })
        .await
    }

    /// 一个人每种通知要不要同时发邮件(没设过的按种类默认)。
    pub async fn notify_email_prefs(&self, user_id: &str) -> Result<HashMap<String, bool>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let mut prefs: HashMap<String, bool> = kind::ALL
                .iter()
                .map(|name| ((*name).to_owned(), kind::email_by_default(name)))
                .collect();
            let mut statement = conn
                .prepare("SELECT kind, email FROM notify_prefs WHERE user_id = ?1")
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![user_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
                })
                .map_err(map_sqlite_error)?;
            for row in rows {
                let (name, on) = row.map_err(map_sqlite_error)?;
                if prefs.contains_key(&name) {
                    prefs.insert(name, on);
                }
            }
            Ok(prefs)
        })
        .await
    }

    /// 改某几种通知的邮件开关。未知的种类整个请求拒绝(不悄悄忽略一部分)。
    pub async fn set_notify_email_prefs(
        &self,
        user_id: &str,
        changes: &HashMap<String, bool>,
    ) -> Result<()> {
        if let Some(bad) = changes
            .keys()
            .find(|name| !kind::ALL.contains(&name.as_str()))
        {
            return Err(KbError::InvalidInput(format!("未知的通知种类 {bad}")));
        }
        let (user_id, changes) = (user_id.to_owned(), changes.clone());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            for (name, on) in changes {
                tx.execute(
                    "INSERT INTO notify_prefs (user_id, kind, email) VALUES (?1, ?2, ?3) \
                     ON CONFLICT(user_id, kind) DO UPDATE SET email = excluded.email",
                    params![user_id, name, i64::from(on)],
                )
                .map_err(map_sqlite_error)?;
            }
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }

    /// 把一条通知排进邮件队列(等着和同一个人的其它通知合并)。
    pub async fn queue_notification_mail(
        &self,
        user_id: &str,
        notification_id: i64,
        now: Millis,
    ) -> Result<()> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO notify_mail_queue (user_id, notification_id, created_at) VALUES (?1, ?2, ?3)",
                params![user_id, notification_id, now],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 现在该发的合并邮件:有排队项、且距上一封已经超过 `min_gap_ms` 的人,最多 `max_users` 个。
    /// 已经在网页上读过的通知不再发邮件(人都看到了,没必要再打扰)。
    pub async fn due_notification_digests(
        &self,
        now: Millis,
        min_gap_ms: i64,
        max_users: u32,
    ) -> Result<Vec<Digest>> {
        self.read(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT q.user_id FROM notify_mail_queue q \
                     LEFT JOIN notify_mail_state s ON s.user_id = q.user_id \
                     WHERE s.last_sent_at IS NULL OR s.last_sent_at <= ?1 \
                     GROUP BY q.user_id ORDER BY MIN(q.created_at) LIMIT ?2",
                )
                .map_err(map_sqlite_error)?;
            let users = statement
                .query_map(params![now - min_gap_ms, max_users], |row| row.get::<_, String>(0))
                .map_err(map_sqlite_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)?;
            let mut digests = Vec::new();
            for user_id in users {
                let mut rows = conn
                    .prepare(
                        "SELECT q.id, n.id, n.kind, n.data_json, n.read_at, n.created_at \
                         FROM notify_mail_queue q LEFT JOIN notifications n ON n.id = q.notification_id \
                         WHERE q.user_id = ?1 ORDER BY q.id",
                    )
                    .map_err(map_sqlite_error)?;
                let mut items = Vec::new();
                let mut queue_ids = Vec::new();
                let mapped = rows
                    .query_map(params![user_id], |row| {
                        let queue_id: i64 = row.get(0)?;
                        let notification_id: Option<i64> = row.get(1)?;
                        let text: Option<String> = row.get(3)?;
                        Ok((
                            queue_id,
                            notification_id.map(|id| -> rusqlite::Result<Notification> {
                                Ok(Notification {
                                    id,
                                    kind: row.get(2)?,
                                    data: serde_json::from_str(&text.unwrap_or_default())
                                        .unwrap_or(Value::Null),
                                    read_at: row.get(4)?,
                                    created_at: row.get(5)?,
                                })
                            }),
                        ))
                    })
                    .map_err(map_sqlite_error)?;
                for row in mapped {
                    let (queue_id, item) = row.map_err(map_sqlite_error)?;
                    queue_ids.push(queue_id);
                    if let Some(item) = item {
                        let item = item.map_err(map_sqlite_error)?;
                        if item.read_at.is_none() {
                            items.push(item);
                        }
                    }
                }
                digests.push(Digest { user_id, items, queue_ids });
            }
            Ok(digests)
        })
        .await
    }

    /// 一封合并邮件处理完了(发出去了,或者里面的通知都已读不用发):删掉队列项,记下发送时间。
    /// `sent = false` 时不更新发送时间(没发就不占 10 分钟的间隔)。
    pub async fn finish_notification_digest(
        &self,
        user_id: &str,
        queue_ids: &[i64],
        sent: bool,
        now: Millis,
    ) -> Result<()> {
        let (user_id, queue_ids) = (user_id.to_owned(), queue_ids.to_vec());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            for id in queue_ids {
                tx.execute(
                    "DELETE FROM notify_mail_queue WHERE id = ?1 AND user_id = ?2",
                    params![id, user_id],
                )
                .map_err(map_sqlite_error)?;
            }
            if sent {
                tx.execute(
                    "INSERT INTO notify_mail_state (user_id, last_sent_at) VALUES (?1, ?2) \
                     ON CONFLICT(user_id) DO UPDATE SET last_sent_at = excluded.last_sent_at",
                    params![user_id, now],
                )
                .map_err(map_sqlite_error)?;
            }
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }
}
