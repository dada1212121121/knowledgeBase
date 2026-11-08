//! 好友与通知能力的实现(接口见 `kb-capability::social`)。
//!
//! 全是账号级:谁在操作取自会话里的 `Principal`,参数里没有「替谁操作」。
//! 本机超级用户(`kb.sock`)不是具体的某个人,没有好友和通知,直接拒绝。

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use kb_capability::CallCtx;
use kb_capability::admin::{
    FriendDecideArgs, FriendRequestArgs, FriendSearchArgs, FriendUpdateArgs, NotificationListArgs,
    NotificationPrefsArgs, NotificationReadArgs, PrivacyArgs, UserIdArgs,
};
use kb_core::model::Millis;
use kb_core::social::{PublicProfile, ShareFrom, kind};
use kb_core::{KbError, Result};
use kb_meta::system::{Caps, Decision, RequestOutcome};
use serde_json::{Value, json};

use crate::admin_backend::SystemAdmin;
use kb_web::notify::Notifier;

/// 找人每分钟最多几次(按人):不做模糊搜索之外,再限速,免得拿用户名字典一个个试。
const SEARCHES_PER_MINUTE: usize = 10;

/// 好友与通知需要的依赖。
pub struct SocialDeps {
    /// 发通知。
    pub notifier: std::sync::Arc<Notifier>,
    searches: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl SocialDeps {
    /// 构造。
    pub fn new(notifier: std::sync::Arc<Notifier>) -> Self {
        Self {
            notifier,
            searches: Mutex::new(HashMap::new()),
        }
    }

    /// 记一次搜索;超过每分钟的额度返回 `Err`。失败的搜索也算——攻击者试的就是失败的。
    fn allow_search(&self, user_id: &str) -> bool {
        let mut map = self
            .searches
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let now = Instant::now();
        // 顺手清掉所有已经空了的人,表不会随用户数一直长
        map.retain(|_, window| {
            window.retain(|at| now.duration_since(*at) < Duration::from_secs(60));
            !window.is_empty()
        });
        let window = map.entry(user_id.to_owned()).or_default();
        if window.len() >= SEARCHES_PER_MINUTE {
            return false;
        }
        window.push_back(now);
        true
    }
}

fn now_ms() -> Millis {
    kb_service::llm_gate::today_now_millis()
}

fn profile_json(profile: &PublicProfile) -> Value {
    json!(profile)
}

impl SystemAdmin {
    pub(crate) fn social(&self) -> Result<&SocialDeps> {
        self.social
            .as_ref()
            .ok_or_else(|| KbError::Unavailable("好友与通知没有启用".to_owned()))
    }

    /// 调用者的用户 id。本机超级用户拒绝。
    fn me(ctx: &CallCtx) -> Result<String> {
        match &ctx.principal {
            Some(principal) if !principal.local => Ok(principal.user_id.clone()),
            _ => Err(KbError::Forbidden("好友与通知需要用账号登录".to_owned())),
        }
    }

    /// 某个人的好友数上限(全站默认 → 角色 → 用户例外)。
    async fn friend_cap(&self, user_id: &str) -> Result<u32> {
        let defaults = self.config.get().quota.clone();
        Ok(self
            .system
            .effective_quota(user_id, &defaults)
            .await?
            .friends_per_user)
    }

    pub(crate) async fn do_friend_search(
        &self,
        ctx: &CallCtx,
        args: FriendSearchArgs,
    ) -> Result<Value> {
        let me = Self::me(ctx)?;
        if !self.social()?.allow_search(&me) {
            return Err(KbError::Unavailable(
                "搜索太频繁了,请一分钟后再试".to_owned(),
            ));
        }
        Ok(
            match self
                .system
                .find_for_friending(&me, &args.query, now_ms())
                .await?
            {
                Some((profile, relation)) => {
                    json!({ "user": profile_json(&profile), "relation": relation })
                }
                None => json!({ "user": null, "relation": "none" }),
            },
        )
    }

    pub(crate) async fn do_friend_request(
        &self,
        ctx: &CallCtx,
        args: FriendRequestArgs,
    ) -> Result<Value> {
        let me = Self::me(ctx)?;
        let now = now_ms();
        let caps = Caps {
            me: self.friend_cap(&me).await?,
            other: self.friend_cap(&args.user_id).await.unwrap_or(0),
        };
        let outcome = self
            .system
            .send_friend_request(&me, &args.user_id, args.message.as_deref(), caps, now)
            .await?;
        let notifier = &self.social()?.notifier;
        let status = match outcome {
            RequestOutcome::Created(request) => {
                if let Some(profile) = self.profile_of(&me).await {
                    notifier
                        .send(
                            &args.user_id,
                            kind::FRIEND_REQUEST,
                            json!({ "request_id": request.id, "from": profile_json(&profile), "message": request.message }),
                            now,
                        )
                        .await;
                }
                "requested"
            }
            RequestOutcome::AutoAccepted => {
                // 先申请的那一方收到「已通过」
                if let Some(profile) = self.profile_of(&me).await {
                    notifier
                        .send(
                            &args.user_id,
                            kind::FRIEND_RESULT,
                            json!({ "accepted": true, "by": profile_json(&profile) }),
                            now,
                        )
                        .await;
                }
                "friends"
            }
            RequestOutcome::AlreadyFriends => "already_friends",
            RequestOutcome::AlreadyPending(_) => "already_pending",
            // 对方拉黑了我:表面和成功一样,什么都不发生
            RequestOutcome::Silent => "requested",
        };
        Ok(json!({ "status": status }))
    }

    pub(crate) async fn profile_of(&self, user_id: &str) -> Option<PublicProfile> {
        let user = self.system.get_user(user_id).await.ok().flatten()?;
        Some(PublicProfile {
            id: user.id,
            username: user.username,
            display_name: user.display_name,
            avatar: user.avatar,
        })
    }

    pub(crate) async fn do_friend_requests(&self, ctx: &CallCtx) -> Result<Value> {
        let me = Self::me(ctx)?;
        let now = now_ms();
        let incoming = self.system.incoming_friend_requests(&me, now).await?;
        let outgoing = self.system.outgoing_friend_requests(&me, now).await?;
        let row = |request: &kb_core::social::FriendRequest, other: &PublicProfile, key: &str| {
            json!({
                "id": request.id,
                key: profile_json(other),
                "message": request.message,
                "created_at": request.created_at,
                "expires_at": request.expires_at,
            })
        };
        Ok(json!({
            "incoming": incoming.iter().map(|(r, p)| row(r, p, "from")).collect::<Vec<_>>(),
            "outgoing": outgoing.iter().map(|(r, p)| row(r, p, "to")).collect::<Vec<_>>(),
        }))
    }

    pub(crate) async fn do_friend_decide(
        &self,
        ctx: &CallCtx,
        args: FriendDecideArgs,
    ) -> Result<Value> {
        let me = Self::me(ctx)?;
        let decision = match args.decision.as_str() {
            "accept" => Decision::Accept,
            "reject" => Decision::Reject,
            "ignore" => Decision::Ignore,
            other => {
                return Err(KbError::InvalidInput(format!(
                    "decision 只能是 accept / reject / ignore,收到 {other:?}"
                )));
            }
        };
        let now = now_ms();
        // 要先知道发起人是谁才能算他的上限:这里只读不改,真正的校验在事务里
        let requester = self
            .system
            .incoming_friend_requests(&me, now)
            .await?
            .into_iter()
            .find(|(request, _)| request.id == args.id)
            .map(|(request, _)| request.from_id);
        let caps = Caps {
            me: self.friend_cap(&me).await?,
            other: match &requester {
                Some(id) => self.friend_cap(id).await.unwrap_or(0),
                None => 0,
            },
        };
        let request = self
            .system
            .decide_friend_request(&args.id, &me, decision, caps, now)
            .await?;
        if decision != Decision::Ignore
            && let Some(profile) = self.profile_of(&me).await
        {
            self.social()?
                .notifier
                .send(
                    &request.from_id,
                    kind::FRIEND_RESULT,
                    json!({
                        "request_id": request.id,
                        "accepted": decision == Decision::Accept,
                        "by": profile_json(&profile),
                    }),
                    now,
                )
                .await;
        }
        // 忽略不告诉界面「已忽略」以外的任何东西
        Ok(json!({ "state": request.state }))
    }

    pub(crate) async fn do_friend_list(&self, ctx: &CallCtx) -> Result<Value> {
        let me = Self::me(ctx)?;
        Ok(json!({ "friends": self.system.list_friends(&me).await? }))
    }

    pub(crate) async fn do_friend_update(
        &self,
        ctx: &CallCtx,
        args: FriendUpdateArgs,
    ) -> Result<Value> {
        let me = Self::me(ctx)?;
        self.system
            .update_friend(&me, &args.friend_id, args.remark, args.group_name)
            .await?;
        Ok(json!({ "updated": true }))
    }

    pub(crate) async fn do_friend_remove(&self, ctx: &CallCtx, args: UserIdArgs) -> Result<Value> {
        let me = Self::me(ctx)?;
        Ok(json!({ "removed": self.system.remove_friend(&me, &args.user_id).await? }))
    }

    pub(crate) async fn do_block(&self, ctx: &CallCtx, args: UserIdArgs) -> Result<Value> {
        let me = Self::me(ctx)?;
        self.system.block_user(&me, &args.user_id, now_ms()).await?;
        Ok(json!({ "blocked": true }))
    }

    pub(crate) async fn do_unblock(&self, ctx: &CallCtx, args: UserIdArgs) -> Result<Value> {
        let me = Self::me(ctx)?;
        Ok(json!({ "unblocked": self.system.unblock_user(&me, &args.user_id).await? }))
    }

    pub(crate) async fn do_block_list(&self, ctx: &CallCtx) -> Result<Value> {
        let me = Self::me(ctx)?;
        let list = self.system.list_blocks(&me).await?;
        Ok(json!({
            "blocked": list.iter().map(|(profile, at)| json!({ "user": profile_json(profile), "since": at })).collect::<Vec<_>>()
        }))
    }

    pub(crate) async fn do_privacy_get(&self, ctx: &CallCtx) -> Result<Value> {
        let me = Self::me(ctx)?;
        Ok(json!({ "privacy": self.system.privacy_of(&me).await? }))
    }

    pub(crate) async fn do_set_privacy(&self, ctx: &CallCtx, args: PrivacyArgs) -> Result<Value> {
        let me = Self::me(ctx)?;
        let mut privacy = self.system.privacy_of(&me).await?;
        if let Some(value) = args.searchable_by_email {
            privacy.searchable_by_email = value;
        }
        if let Some(value) = args.searchable_by_username {
            privacy.searchable_by_username = value;
        }
        if let Some(value) = args.share_from.as_deref() {
            privacy.share_from = match value {
                "everyone" => ShareFrom::Everyone,
                "friends" => ShareFrom::Friends,
                other => {
                    return Err(KbError::InvalidInput(format!(
                        "share_from 只能是 everyone / friends,收到 {other:?}"
                    )));
                }
            };
        }
        self.system.set_privacy(&me, privacy).await?;
        Ok(json!({ "privacy": privacy }))
    }

    pub(crate) async fn do_notification_list(
        &self,
        ctx: &CallCtx,
        args: NotificationListArgs,
    ) -> Result<Value> {
        let me = Self::me(ctx)?;
        let limit = args.limit.unwrap_or(30).clamp(1, 100);
        let list = self
            .system
            .list_notifications(&me, args.unread_only, args.before_id, limit)
            .await?;
        let next = (list.len() as u32 == limit)
            .then(|| list.last().map(|n| n.id))
            .flatten();
        Ok(json!({
            "notifications": list,
            "unread": self.system.unread_notifications(&me).await?,
            "next_before_id": next,
        }))
    }

    pub(crate) async fn do_notification_read(
        &self,
        ctx: &CallCtx,
        args: NotificationReadArgs,
    ) -> Result<Value> {
        let me = Self::me(ctx)?;
        if !args.all && args.ids.is_empty() {
            return Err(KbError::InvalidInput(
                "要标记哪些通知?给 ids 或 all".to_owned(),
            ));
        }
        if args.ids.len() > 500 {
            return Err(KbError::InvalidInput("一次最多标记 500 条".to_owned()));
        }
        let changed = if args.all {
            self.system
                .mark_all_notifications_read(&me, now_ms())
                .await?
        } else {
            self.system
                .mark_notifications_read(&me, &args.ids, now_ms())
                .await?
        };
        Ok(json!({ "changed": changed, "unread": self.system.unread_notifications(&me).await? }))
    }

    pub(crate) async fn do_notification_prefs(
        &self,
        ctx: &CallCtx,
        args: NotificationPrefsArgs,
    ) -> Result<Value> {
        let me = Self::me(ctx)?;
        if let Some(changes) = &args.email {
            self.system.set_notify_email_prefs(&me, changes).await?;
        }
        Ok(json!({
            "email": self.system.notify_email_prefs(&me).await?,
            "kinds": kind::ALL,
            "mail_available": self.config.get().mail.enabled,
        }))
    }
}
