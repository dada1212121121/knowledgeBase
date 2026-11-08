//! 发通知:写站内通知、实时推给本人、需要的话排进邮件队列(多用户设计说明)。
//!
//! 通知是**尽力而为**的旁路:好友申请已经落库了,通知发不出去不能让申请失败,
//! 所以 [`Notifier::send`] 不返回错误,只记日志。

use std::sync::Arc;

use crate::hub::EventHub;

use kb_core::config::ConfigStore;
use kb_core::model::Millis;
use kb_core::ports::system::IdentityStore;
use serde_json::{Value, json};

/// 通知发送器。
pub struct Notifier {
    system: Arc<dyn IdentityStore>,
    hub: Option<Arc<EventHub>>,
    config: Arc<ConfigStore>,
}

impl Notifier {
    /// 构造。`hub` 为 `None`(嵌入式、测试)时只写库,不推送。
    pub fn new(
        system: Arc<dyn IdentityStore>,
        hub: Option<Arc<EventHub>>,
        config: Arc<ConfigStore>,
    ) -> Arc<Self> {
        Arc::new(Self {
            system,
            hub,
            config,
        })
    }

    /// 给一个人发一条通知。失败只记日志。
    pub async fn send(&self, user_id: &str, kind: &str, data: Value, now: Millis) {
        let id = match self
            .system
            .add_notification(user_id, kind, &data, now)
            .await
        {
            Ok(id) => id,
            Err(err) => {
                // 收件人刚注销之类:不是发送方的错
                tracing::warn!(user = user_id, kind, error = %err, "写站内通知失败");
                return;
            }
        };
        // 实时推给本人(只有他自己的连接收得到,见 `Viewer::can_see`)
        if let Some(hub) = &self.hub {
            let unread = self
                .system
                .unread_notifications(user_id)
                .await
                .unwrap_or_default();
            hub.publish_to_user(
                user_id,
                "notify",
                json!({
                    "notification": { "id": id, "kind": kind, "data": data, "read_at": null, "created_at": now },
                    "unread": unread,
                }),
            );
        }
        self.maybe_queue_mail(user_id, kind, id, now).await;
    }

    /// 邮件:站点配了发信、对方有已验证的邮箱、这一类通知的邮件开关是开的,才排队。
    async fn maybe_queue_mail(&self, user_id: &str, kind: &str, notification_id: i64, now: Millis) {
        if !self.config.get().mail.enabled {
            return;
        }
        let user = match self.system.get_user(user_id).await {
            Ok(Some(user)) => user,
            _ => return,
        };
        if user.email.is_none() || user.email_verified_at.is_none() {
            return;
        }
        let wanted = self
            .system
            .notify_email_prefs(user_id)
            .await
            .map(|prefs| prefs.get(kind).copied().unwrap_or(false))
            .unwrap_or(false);
        if wanted
            && let Err(err) = self
                .system
                .queue_notification_mail(user_id, notification_id, now)
                .await
        {
            tracing::warn!(user = user_id, error = %err, "通知邮件排队失败");
        }
    }
}

/// 邮件里一次最多列几条,多的写「还有 N 条」。
pub const DIGEST_LINES: usize = 20;
/// 同一个人两封通知邮件之间至少隔多久。
pub const DIGEST_GAP_MS: i64 = 10 * 60_000;

fn name_of(profile: &Value) -> String {
    let name = profile["display_name"].as_str().unwrap_or("").trim();
    let user = profile["username"].as_str().unwrap_or("");
    match (name.is_empty(), user.is_empty()) {
        (false, false) => format!("{name}(@{user})"),
        (false, true) => name.to_owned(),
        (true, false) => format!("@{user}"),
        (true, true) => "有人".to_owned(),
    }
}

/// 把一条通知写成邮件里的一行人话。不认识的种类退回种类名,绝不把原始 JSON 贴进邮件。
pub fn describe(notification: &kb_core::social::Notification) -> String {
    let data = &notification.data;
    match notification.kind.as_str() {
        kb_core::social::kind::FRIEND_REQUEST => {
            let message = data["message"].as_str().filter(|m| !m.is_empty());
            match message {
                Some(text) => format!("{} 请求加你为好友:{text}", name_of(&data["from"])),
                None => format!("{} 请求加你为好友", name_of(&data["from"])),
            }
        }
        kb_core::social::kind::FRIEND_RESULT => {
            let who = name_of(&data["by"]);
            if data["via_invite"] == true {
                format!("{who} 通过你的邀请码加入,已自动成为你的好友")
            } else if data["accepted"] == true {
                format!("{who} 通过了你的好友申请")
            } else {
                format!("{who} 没有通过你的好友申请")
            }
        }
        other => kb_core::social::kind::label(other).to_owned(),
    }
}

/// 发出此刻该发的通知合并邮件。返回发了几封。
///
/// - 邮件没配好:什么都不动(队列留着,配好以后会补发;一天后过期清掉);
/// - 收件人没有已验证的邮箱 / 通知已经全在网页上读过了:清掉队列项,不发;
/// - 发送失败:记进发信记录,清掉队列项(不对一个坏邮箱每分钟重试)。
pub async fn send_due_digests(
    system: &dyn IdentityStore,
    mailer: &kb_mail::Mailer,
    passwords: &kb_mail::Passwords,
    config: &kb_core::Config,
    now: Millis,
) -> usize {
    if !crate::signup::mail_ready(config) {
        return 0;
    }
    let digests = match system
        .due_notification_digests(now, DIGEST_GAP_MS, 50)
        .await
    {
        Ok(digests) => digests,
        Err(err) => {
            tracing::warn!(error = %err, "读取待发的通知邮件失败");
            return 0;
        }
    };
    let mut sent = 0;
    for digest in digests {
        let email = system
            .get_user(&digest.user_id)
            .await
            .ok()
            .flatten()
            .filter(|user| user.email_verified_at.is_some())
            .and_then(|user| user.email);
        let (Some(email), false) = (email, digest.items.is_empty()) else {
            let _ = system
                .finish_notification_digest(&digest.user_id, &digest.queue_ids, false, now)
                .await;
            continue;
        };
        let lines: Vec<String> = digest
            .items
            .iter()
            .take(DIGEST_LINES)
            .map(describe)
            .collect();
        let more = digest.items.len().saturating_sub(lines.len());
        let mail = kb_mail::Mail::NotificationDigest { lines, more };
        let outgoing = mail.render(&email, &config.site.name, &config.site.public_url);
        let result = mailer
            .send(&config.mail, passwords, &config.site.name, &outgoing)
            .await;
        let (ok, via, error) = match &result {
            Ok(kb_mail::Via::Primary) => (true, Some("primary"), None),
            Ok(kb_mail::Via::Backup) => (true, Some("backup"), None),
            Err(err) => (false, None, Some(err.to_string())),
        };
        let _ = system
            .record_mail(&email, mail.kind(), ok, via, error.as_deref())
            .await;
        let _ = system
            .finish_notification_digest(&digest.user_id, &digest.queue_ids, ok, now)
            .await;
        if ok {
            sent += 1;
        }
    }
    sent
}
