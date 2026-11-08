//! 账号与角色管理能力的实现(多用户设计说明):账号库上的增删改查,全部审计。
//!
//! 能力本身由 `sys.users` 功能点把关(`kb-capability::access`);这里再守一道「别越级」的规矩:
//! 只有拥有全部功能的管理员才能把人设为管理员、才能动管理员的账号,拥有 `sys.users` 的自定义角色不行。

use std::sync::Arc;

use async_trait::async_trait;
use kb_capability::CallCtx;
use kb_capability::admin::{
    AccessDecideArgs, AccessRequestArgs, AdminBackend, AdminViewArgs, FriendDecideArgs,
    FriendRequestArgs, FriendSearchArgs, FriendUpdateArgs, GrantBatchArgs, GrantRemoveArgs,
    GrantSetArgs, GuestPurgeArgs, HideShareArgs, IdArgs, InviteCreateArgs, LinkCreateArgs,
    LinkGetArgs, LinkIdArgs, LinkUpdateArgs, LlmUsageOverviewArgs, LlmUsageSeriesArgs, MailLogArgs,
    MailPasswordArgs, MailTestArgs, MetricsSeriesArgs, NotificationListArgs, NotificationPrefsArgs,
    NotificationReadArgs, PrivacyArgs, RoleCreateArgs, RoleUpdateArgs, SearchSharedArgs,
    SetInheritArgs, ShareAdminListArgs, SharedWithMeArgs, StorageOverviewArgs, TargetArgs,
    UserCreateArgs, UserFeatureArgs, UserIdArgs, UserListArgs, UserPasswordArgs, UserUpdateArgs,
};
use kb_core::account::{NewUser, User, UserStatus};
use kb_core::config::ConfigStore;
use kb_core::{KbError, Result, features};
use kb_meta::SystemStore;
use kb_meta::system::{RoleUpdate, UserFilter, UserUpdate};
use serde_json::{Value, json};

/// 账号管理后端。
pub struct SystemAdmin {
    pub(crate) system: Arc<SystemStore>,
    pub(crate) config: Arc<ConfigStore>,
    /// 发信相关依赖;没有时邮件类能力返回「不可用」。
    pub(crate) mail: Option<crate::admin_registration::MailDeps>,
    /// 磁盘用量相关依赖;没有时存储类能力返回「不可用」。
    pub(crate) storage: Option<StorageDeps>,
    /// 好友与通知的依赖;没有时这些能力返回「不可用」。
    pub(crate) social: Option<crate::social_backend::SocialDeps>,
    /// 文档分享的依赖。
    pub(crate) share: Option<crate::share_backend::ShareDeps>,
    /// 多人在线编辑的协作中心:授权 / 链接变化后让房间立刻重新核对权限。
    pub(crate) collab: Option<Arc<kb_collab::CollabHub>>,
    /// 资源采样器(守护进程);没有时 `metrics_series` 返回「不可用」。
    pub(crate) metrics: Option<kb_service::metrics::MetricsHub>,
}

/// 存储概览与「我的用量」要用的东西。
#[derive(Clone)]
pub struct StorageDeps {
    /// 和上传、新建笔记共用的用量表(缓存与预留)。
    pub meter: Arc<kb_service::storage::StorageMeter>,
    /// 数据根目录与各知识库的路径。
    pub paths: kb_core::paths::KbPaths,
}

impl SystemAdmin {
    /// 构造。
    pub fn new(system: Arc<SystemStore>, config: Arc<ConfigStore>) -> Self {
        Self {
            system,
            config,
            mail: None,
            storage: None,
            social: None,
            share: None,
            collab: None,
            metrics: None,
        }
    }

    /// 接上资源采样器(守护进程)。
    #[must_use]
    pub fn with_metrics(mut self, hub: kb_service::metrics::MetricsHub) -> Self {
        self.metrics = Some(hub);
        self
    }

    /// 接上多人在线编辑(守护进程)。
    #[must_use]
    pub fn with_collab(mut self, hub: Arc<kb_collab::CollabHub>) -> Self {
        self.collab = Some(hub);
        self
    }

    /// 授权 / 链接变了:让所有协作房间立刻重新核对每个连接的权限。
    /// 变更的人不用等 10 秒的定期核对,被降级的人马上只读,被收回的人马上断开。
    pub(crate) async fn collab_refresh(&self) {
        if let Some(hub) = &self.collab {
            hub.refresh_where(|_| true).await;
        }
    }

    /// 接上文档分享(守护进程)。
    #[must_use]
    pub fn with_share(mut self, spaces: Arc<crate::spaces::SpaceRegistry>) -> Self {
        self.share = Some(crate::share_backend::ShareDeps { spaces });
        self
    }

    /// 接上好友与通知(守护进程)。
    #[must_use]
    pub fn with_social(mut self, notifier: Arc<kb_web::notify::Notifier>) -> Self {
        self.social = Some(crate::social_backend::SocialDeps::new(notifier));
        self
    }

    /// 接上存储用量表(守护进程)。
    #[must_use]
    pub fn with_storage(mut self, storage: StorageDeps) -> Self {
        self.storage = Some(storage);
        self
    }

    /// 接上发信器与授权码路径(和注册接口共用同一个发信器)。
    #[must_use]
    pub fn with_mail(mut self, mail: crate::admin_registration::MailDeps) -> Self {
        self.mail = Some(mail);
        self
    }

    /// 调用者的用户 id(本机超级用户记为 `None`)。
    pub(crate) fn actor(ctx: &CallCtx) -> Option<String> {
        ctx.principal
            .as_ref()
            .filter(|principal| !principal.local)
            .map(|principal| principal.user_id.clone())
    }

    /// 调用者是不是拥有全部功能的管理员(本机超级用户也算)。
    pub(crate) fn is_full_admin(ctx: &CallCtx) -> bool {
        ctx.principal
            .as_ref()
            .is_some_and(|principal| principal.local || principal.features.is_all())
    }

    pub(crate) async fn audit(&self, ctx: &CallCtx, action: &str, target: &str, detail: Value) {
        let actor = Self::actor(ctx);
        if let Err(err) = self
            .system
            .record_audit(actor.as_deref(), action, Some(target), &detail, None)
            .await
        {
            tracing::warn!(error = %err, action, "写系统审计失败");
        }
    }

    /// 不能越级:非管理员不能把人设成管理级(含危险)角色,也不能动持有这类角色的人的账号。
    ///
    /// 「管理级」= 全功能管理员,或者危险角色(能持有系统级功能,包括和用户管理员自己同级的角色)。
    /// 危险功能只能放在危险角色里,所以拦住危险角色就拦住了所有系统级功能的转手。
    /// 以前只拦了全功能管理员,用户管理员照样能把人设成别的危险角色(含自己的同级角色)、
    /// 给自己加功能,或者去改持有危险角色的人的密码接管他的账号。
    async fn guard_target(
        &self,
        ctx: &CallCtx,
        target: &User,
        new_role: Option<&str>,
    ) -> Result<()> {
        if Self::is_full_admin(ctx) {
            return Ok(());
        }
        let is_privileged = |role: Option<kb_core::account::Role>| {
            role.is_some_and(|r| r.all_features || r.dangerous)
        };
        if is_privileged(self.system.get_role(&target.role_id).await?) {
            return Err(KbError::Forbidden(
                "这个账号是管理级角色,只有管理员能修改".to_owned(),
            ));
        }
        if let Some(role_id) = new_role
            && is_privileged(self.system.get_role(role_id).await?)
        {
            return Err(KbError::Forbidden(
                "只有管理员能把人设为管理级(含危险)角色".to_owned(),
            ));
        }
        Ok(())
    }

    async fn user_json(&self, user: &User) -> Result<Value> {
        let space = self.system.personal_space(&user.id).await?;
        Ok(json!({ "user": user, "space": space }))
    }

    async fn find(&self, id: &str) -> Result<User> {
        self.system
            .get_user(id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("用户 {id}")))
    }
}

fn parse_status(text: &str) -> Result<UserStatus> {
    match text {
        "active" => Ok(UserStatus::Active),
        "disabled" => Ok(UserStatus::Disabled),
        other => Err(KbError::InvalidInput(format!(
            "状态只能是 active 或 disabled,收到 {other}"
        ))),
    }
}

fn quota_text(quota: Option<Value>) -> Result<Option<String>> {
    match quota {
        None => Ok(None),
        Some(Value::Object(map)) => Ok(Some(Value::Object(map).to_string())),
        Some(_) => Err(KbError::InvalidInput("配额必须是 JSON 对象".to_owned())),
    }
}

#[async_trait]
impl AdminBackend for SystemAdmin {
    // 文档分享:实现在 `share_backend.rs`
    async fn grant_list(&self, ctx: &CallCtx, args: TargetArgs) -> Result<Value> {
        self.do_grant_list(ctx, args).await
    }
    async fn grant_set(&self, ctx: &CallCtx, args: GrantSetArgs) -> Result<Value> {
        let done = self.do_grant_set(ctx, args).await;
        self.collab_refresh().await;
        done
    }
    async fn grant_remove(&self, ctx: &CallCtx, args: GrantRemoveArgs) -> Result<Value> {
        let done = self.do_grant_remove(ctx, args).await;
        self.collab_refresh().await;
        done
    }
    async fn grant_batch(&self, ctx: &CallCtx, args: GrantBatchArgs) -> Result<Value> {
        let done = self.do_grant_batch(ctx, args).await;
        self.collab_refresh().await;
        done
    }
    async fn set_inherit(&self, ctx: &CallCtx, args: SetInheritArgs) -> Result<Value> {
        let done = self.do_set_inherit(ctx, args).await;
        self.collab_refresh().await;
        done
    }
    async fn effective_role(&self, ctx: &CallCtx, args: TargetArgs) -> Result<Value> {
        self.do_effective_role(ctx, args).await
    }
    async fn shared_with_me(&self, ctx: &CallCtx, args: SharedWithMeArgs) -> Result<Value> {
        self.do_shared_with_me(ctx, args).await
    }
    async fn shared_by_me(&self, ctx: &CallCtx) -> Result<Value> {
        self.do_shared_by_me(ctx).await
    }
    async fn hide_share(&self, ctx: &CallCtx, args: HideShareArgs) -> Result<Value> {
        self.do_hide_share(ctx, args).await
    }
    async fn access_request(&self, ctx: &CallCtx, args: AccessRequestArgs) -> Result<Value> {
        self.do_access_request(ctx, args).await
    }
    async fn access_requests(&self, ctx: &CallCtx) -> Result<Value> {
        self.do_access_requests(ctx).await
    }
    async fn access_decide(&self, ctx: &CallCtx, args: AccessDecideArgs) -> Result<Value> {
        self.do_access_decide(ctx, args).await
    }
    async fn link_create(&self, ctx: &CallCtx, args: LinkCreateArgs) -> Result<Value> {
        self.do_link_create(ctx, args).await
    }
    async fn link_get(&self, ctx: &CallCtx, args: LinkGetArgs) -> Result<Value> {
        self.do_link_get(ctx, args).await
    }
    async fn link_update(&self, ctx: &CallCtx, args: LinkUpdateArgs) -> Result<Value> {
        let done = self.do_link_update(ctx, args).await;
        self.collab_refresh().await;
        done
    }
    async fn link_reset(&self, ctx: &CallCtx, args: LinkIdArgs) -> Result<Value> {
        let done = self.do_link_reset(ctx, args).await;
        self.collab_refresh().await;
        done
    }
    async fn link_revoke(&self, ctx: &CallCtx, args: LinkIdArgs) -> Result<Value> {
        let done = self.do_link_revoke(ctx, args).await;
        self.collab_refresh().await;
        done
    }
    async fn link_stats(&self, ctx: &CallCtx, args: LinkIdArgs) -> Result<Value> {
        self.do_link_stats(ctx, args).await
    }
    async fn guest_purge(&self, ctx: &CallCtx, args: GuestPurgeArgs) -> Result<Value> {
        self.do_guest_purge(ctx, args).await
    }
    async fn my_links(&self, ctx: &CallCtx) -> Result<Value> {
        self.do_my_links(ctx).await
    }
    async fn share_admin_list(&self, ctx: &CallCtx, args: ShareAdminListArgs) -> Result<Value> {
        self.do_share_admin_list(ctx, args).await
    }
    async fn share_admin_revoke(&self, ctx: &CallCtx, args: LinkIdArgs) -> Result<Value> {
        let done = self.do_share_admin_revoke(ctx, args).await;
        self.collab_refresh().await;
        done
    }
    async fn search_shared(&self, ctx: &CallCtx, args: SearchSharedArgs) -> Result<Value> {
        self.do_search_shared(ctx, args).await
    }
    // 好友与通知:实现在 `social_backend.rs`(trait 实现不能拆文件,这里只转发)
    async fn friend_search(&self, ctx: &CallCtx, args: FriendSearchArgs) -> Result<Value> {
        self.do_friend_search(ctx, args).await
    }
    async fn friend_request(&self, ctx: &CallCtx, args: FriendRequestArgs) -> Result<Value> {
        self.do_friend_request(ctx, args).await
    }
    async fn friend_requests(&self, ctx: &CallCtx) -> Result<Value> {
        self.do_friend_requests(ctx).await
    }
    async fn friend_decide(&self, ctx: &CallCtx, args: FriendDecideArgs) -> Result<Value> {
        self.do_friend_decide(ctx, args).await
    }
    async fn friend_list(&self, ctx: &CallCtx) -> Result<Value> {
        self.do_friend_list(ctx).await
    }
    async fn friend_update(&self, ctx: &CallCtx, args: FriendUpdateArgs) -> Result<Value> {
        self.do_friend_update(ctx, args).await
    }
    async fn friend_remove(&self, ctx: &CallCtx, args: UserIdArgs) -> Result<Value> {
        self.do_friend_remove(ctx, args).await
    }
    async fn block(&self, ctx: &CallCtx, args: UserIdArgs) -> Result<Value> {
        self.do_block(ctx, args).await
    }
    async fn unblock(&self, ctx: &CallCtx, args: UserIdArgs) -> Result<Value> {
        self.do_unblock(ctx, args).await
    }
    async fn block_list(&self, ctx: &CallCtx) -> Result<Value> {
        self.do_block_list(ctx).await
    }
    async fn privacy_get(&self, ctx: &CallCtx) -> Result<Value> {
        self.do_privacy_get(ctx).await
    }
    async fn set_privacy(&self, ctx: &CallCtx, args: PrivacyArgs) -> Result<Value> {
        self.do_set_privacy(ctx, args).await
    }
    async fn notification_list(&self, ctx: &CallCtx, args: NotificationListArgs) -> Result<Value> {
        self.do_notification_list(ctx, args).await
    }
    async fn notification_read(&self, ctx: &CallCtx, args: NotificationReadArgs) -> Result<Value> {
        self.do_notification_read(ctx, args).await
    }
    async fn notification_prefs(
        &self,
        ctx: &CallCtx,
        args: NotificationPrefsArgs,
    ) -> Result<Value> {
        self.do_notification_prefs(ctx, args).await
    }

    async fn llm_usage_series(&self, args: LlmUsageSeriesArgs) -> Result<Value> {
        let days = args.days.unwrap_or(30).clamp(1, 90);
        // 用量按站点时区的日期记账(每天 0 点重置额度),这里的天也照同一口径数,和「今日用量」对得上
        let today = kb_core::timezone::today();
        let labels: Vec<String> = (0..days)
            .rev()
            .map(|back| kb_core::timezone::shift_day(&today, -i64::from(back)))
            .collect();
        let rows = self
            .system
            .llm_usage_series(&labels[0], &labels[labels.len() - 1])
            .await?;
        let mut purposes: Vec<String> = Vec::new();
        let mut lines: std::collections::BTreeMap<String, Vec<u64>> =
            std::collections::BTreeMap::new();
        for (day, purpose, _calls, input, output) in rows {
            let Some(at) = labels.iter().position(|label| *label == day) else {
                continue;
            };
            if !purposes.contains(&purpose) {
                purposes.push(purpose.clone());
            }
            lines
                .entry(purpose)
                .or_insert_with(|| vec![0; labels.len()])[at] += input.saturating_add(output);
        }
        let mut totals = vec![0u64; labels.len()];
        for line in lines.values() {
            for (total, value) in totals.iter_mut().zip(line) {
                *total += value;
            }
        }
        Ok(json!({ "days": labels, "purposes": purposes, "series": lines, "totals": totals }))
    }

    async fn metrics_series(&self, args: MetricsSeriesArgs) -> Result<Value> {
        let Some(hub) = &self.metrics else {
            return Err(KbError::Unavailable("资源采样没有启用".to_owned()));
        };
        let name = args.range.as_deref().unwrap_or("1h");
        let range = kb_service::metrics::range_of(name).ok_or_else(|| {
            KbError::InvalidInput(format!("未知的时间范围 {name},可选 1h / 24h / 7d / 30d"))
        })?;
        let now = crate::daemon::now_millis();
        let since = now - range.window_ms;
        // 1 小时直接用内存里 10 秒一个点的缓冲;更长的从库里按范围降采样取(最新那不满一分钟的部分还没落库,看 `now`)
        let rows: Vec<kb_core::model::MetricRow> = if name == "1h" {
            hub.since(since)
                .iter()
                .map(kb_service::metrics::Sample::as_row)
                .collect()
        } else {
            self.system.metric_series(since, now, range.step_ms).await?
        };
        Ok(json!({
            "range": name,
            "step_ms": range.step_ms,
            "since": since,
            "until": now,
            "cores": hub.cores(),
            "points": rows,
            "now": hub.latest().as_ref().map(kb_service::metrics::Sample::as_row),
        }))
    }

    async fn storage_overview(&self, args: StorageOverviewArgs) -> Result<Value> {
        let Some(storage) = &self.storage else {
            return Err(KbError::Unavailable("存储统计没有启用".to_owned()));
        };
        let quota = self.config.get().quota.clone();
        let limit = args.limit.unwrap_or(20).clamp(1, 100);
        let rows = self.system.storage_ranking(limit).await?;
        let totals = self.system.storage_totals().await?;
        let mut top = Vec::with_capacity(rows.len());
        for row in rows {
            // 每个人自己的上限(全站默认 → 角色 → 用户例外);账号已不存在时按全站默认显示
            let limit_bytes = match self.system.effective_quota(&row.owner_id, &quota).await {
                Ok(effective) => effective.storage_gb.saturating_mul(1 << 30),
                Err(_) => quota.storage_gb.saturating_mul(1 << 30),
            };
            top.push(json!({
                "space_id": row.space_id,
                "owner_id": row.owner_id,
                "username": row.username,
                "display_name": row.display_name,
                "sources_bytes": row.measured.usage.sources_bytes,
                "uploads_bytes": row.measured.usage.uploads_bytes,
                "vectors_bytes": row.measured.usage.vectors_bytes,
                "meta_bytes": row.measured.usage.meta_bytes,
                "workspace_bytes": row.measured.usage.workspace_bytes,
                "total_bytes": row.measured.total_bytes,
                "measured_at": row.measured.measured_at,
                "limit_bytes": limit_bytes,
            }));
        }
        let free_gb = kb_service::providers::disk_free_gb(storage.paths.home());
        let reserve_gb = quota.disk_reserve_gb;
        Ok(json!({
            "disk": {
                "free_gb": free_gb,
                "reserve_gb": reserve_gb,
                // 低于保留值:全站已停止上传;低于两倍:提前告警
                "paused": reserve_gb > 0 && free_gb < reserve_gb,
                "warn": reserve_gb > 0 && free_gb < reserve_gb.saturating_mul(2),
            },
            "totals": totals,
            "top": top,
        }))
    }

    async fn llm_usage_overview(&self, args: LlmUsageOverviewArgs) -> Result<Value> {
        let day = match args.day {
            Some(day) => {
                // 只接受 YYYY-MM-DD,不让奇怪的字符串进查询
                let ok = day.len() == 10
                    && day.char_indices().all(|(i, c)| {
                        if i == 4 || i == 7 {
                            c == '-'
                        } else {
                            c.is_ascii_digit()
                        }
                    });
                if !ok {
                    return Err(KbError::InvalidInput("day 必须是 YYYY-MM-DD".to_owned()));
                }
                day
            }
            None => kb_service::llm_gate::today(),
        };
        let limit = args.limit.unwrap_or(20).clamp(1, 100);
        let defaults = self.config.get().quota.clone();
        let rows = self.system.llm_usage_ranking(&day, limit).await?;
        let mut ranking = Vec::with_capacity(rows.len());
        let mut total_tokens = 0u64;
        for row in rows {
            let user = self.system.get_user(&row.user_id).await?;
            let quota = match self.system.effective_quota(&row.user_id, &defaults).await {
                Ok(effective) => effective.llm_tokens_per_day,
                Err(_) => defaults.llm_tokens_per_day,
            };
            let tokens = row.input_tokens.saturating_add(row.output_tokens);
            total_tokens = total_tokens.saturating_add(tokens);
            ranking.push(json!({
                "user_id": row.user_id,
                "username": user.as_ref().map(|u| u.username.clone()),
                "display_name": user.as_ref().map(|u| u.display_name.clone()),
                "calls": row.calls,
                "input_tokens": row.input_tokens,
                "output_tokens": row.output_tokens,
                "tokens": tokens,
                "limit": quota,
            }));
        }
        Ok(json!({ "day": day, "total_tokens": total_tokens, "ranking": ranking }))
    }

    async fn usage_mine(&self, ctx: &CallCtx) -> Result<Value> {
        let Some(storage) = &self.storage else {
            return Err(KbError::Unavailable("存储统计没有启用".to_owned()));
        };
        let principal = ctx
            .principal
            .as_ref()
            .ok_or_else(|| KbError::Forbidden("请先登录".to_owned()))?;
        // 只看自己的知识库:空间 id 来自调用者身份,不是参数
        let space_id = principal
            .space_id
            .clone()
            .unwrap_or_else(|| kb_core::account::PRIMARY_SPACE_ID.to_owned());
        let space_paths = storage.paths.for_space(&space_id)?;
        let usage = storage.meter.usage(&space_id, &space_paths).await;
        let defaults = self.config.get().quota.clone();
        let (limit_bytes, llm_limit) = if principal.local {
            (0, 0)
        } else {
            let effective = self
                .system
                .effective_quota(&principal.user_id, &defaults)
                .await?;
            (
                effective.storage_gb.saturating_mul(1 << 30),
                effective.llm_tokens_per_day,
            )
        };
        let day = kb_service::llm_gate::today();
        let tokens_today = if principal.local {
            0
        } else {
            self.system.llm_tokens_on(&principal.user_id, &day).await?
        };
        Ok(json!({
            "storage": {
                "sources_bytes": usage.sources_bytes,
                "uploads_bytes": usage.uploads_bytes,
                "vectors_bytes": usage.vectors_bytes,
                "meta_bytes": usage.meta_bytes,
                "workspace_bytes": usage.workspace_bytes,
                "total_bytes": usage.total(),
                "limit_bytes": limit_bytes,
            },
            "ai": { "day": day, "tokens_today": tokens_today, "limit": llm_limit },
        }))
    }

    async fn feature_catalog(&self) -> Result<Value> {
        let items: Vec<Value> = features::FEATURES
            .iter()
            .map(|def| {
                json!({
                    "id": def.id, "group": def.group, "label": def.label, "hint": def.hint,
                    "default_user": def.default_user, "dangerous": def.dangerous, "ai": def.ai,
                })
            })
            .collect();
        Ok(json!({ "features": items }))
    }

    async fn role_list(&self) -> Result<Value> {
        let counts = self.system.role_user_counts().await?;
        let roles: Vec<Value> = self
            .system
            .list_roles()
            .await?
            .into_iter()
            .map(|role| {
                let users = counts
                    .iter()
                    .find(|(id, _)| *id == role.id)
                    .map_or(0, |(_, n)| *n);
                let mut value = serde_json::to_value(&role).unwrap_or(Value::Null);
                if let Some(object) = value.as_object_mut() {
                    object.insert("user_count".to_owned(), json!(users));
                }
                value
            })
            .collect();
        Ok(json!({ "roles": roles }))
    }

    async fn role_create(&self, ctx: &CallCtx, args: RoleCreateArgs) -> Result<Value> {
        if args.dangerous && !Self::is_full_admin(ctx) {
            return Err(KbError::Forbidden(
                "只有管理员能创建「危险」角色".to_owned(),
            ));
        }
        let role = self
            .system
            .create_role(&args.name, &args.description, args.features, args.dangerous)
            .await?;
        self.audit(
            ctx,
            "role.create",
            &role.id,
            json!({ "name": role.name, "features": role.features }),
        )
        .await;
        Ok(json!({ "role": role }))
    }

    async fn role_update(&self, ctx: &CallCtx, args: RoleUpdateArgs) -> Result<Value> {
        let adds_dangerous = args.dangerous == Some(true)
            || args.features.as_ref().is_some_and(|list| {
                list.iter()
                    .any(|id| features::find(id).is_some_and(|def| def.dangerous))
            });
        if adds_dangerous && !Self::is_full_admin(ctx) {
            return Err(KbError::Forbidden(
                "只有管理员能给角色加危险功能".to_owned(),
            ));
        }
        let role = self
            .system
            .update_role(
                &args.id,
                RoleUpdate {
                    name: args.name,
                    description: args.description,
                    features: args.features,
                    dangerous: args.dangerous,
                    quota_json: quota_text(args.quota)?,
                },
            )
            .await?;
        self.audit(
            ctx,
            "role.update",
            &role.id,
            json!({ "features": role.features, "dangerous": role.dangerous }),
        )
        .await;
        Ok(json!({ "role": role }))
    }

    async fn role_delete(&self, ctx: &CallCtx, args: IdArgs) -> Result<Value> {
        self.system.delete_role(&args.id).await?;
        self.audit(ctx, "role.delete", &args.id, json!({})).await;
        Ok(json!({ "id": args.id, "deleted": true }))
    }

    async fn user_list(&self, args: UserListArgs) -> Result<Value> {
        let page_size = args.page_size.unwrap_or(50).clamp(1, 200);
        let page = args.page.unwrap_or(1).max(1);
        let status = args
            .status
            .as_deref()
            .map(UserStatus::parse)
            .transpose()
            .map_err(|_| KbError::InvalidInput("未知的用户状态".to_owned()))?;
        let (users, total) = self
            .system
            .list_users(
                UserFilter {
                    q: args.q,
                    role_id: args.role_id,
                    status,
                },
                page_size,
                (page - 1) * page_size,
            )
            .await?;
        Ok(json!({ "users": users, "total": total, "page": page, "page_size": page_size }))
    }

    async fn user_get(&self, args: IdArgs) -> Result<Value> {
        let user = self.find(&args.id).await?;
        let overrides: Vec<Value> = self
            .system
            .feature_overrides(&user.id)
            .await?
            .into_iter()
            .map(|(feature, effect)| json!({ "feature": feature, "effect": effect }))
            .collect();
        let effective = self
            .system
            .effective_features(&user.id, self.config.get().ai.state())
            .await?
            .effective();
        let mut value = self.user_json(&user).await?;
        if let Some(object) = value.as_object_mut() {
            object.insert("overrides".to_owned(), json!(overrides));
            object.insert("effective_features".to_owned(), json!(effective));
        }
        Ok(value)
    }

    async fn admin_space_open(&self, ctx: &CallCtx, args: AdminViewArgs) -> Result<Value> {
        if !self.config.get().admin.inspect_enabled {
            return Err(KbError::Forbidden("管理员查看功能已关闭".to_owned()));
        }
        let Some(spaces) = self.share.as_ref().map(|share| share.spaces.clone()) else {
            return Err(KbError::Unavailable("管理员查看需要多用户模式".to_owned()));
        };
        let target = self.find(&args.user_id).await?;
        let Some(space) = self.system.personal_space(&target.id).await? else {
            return Err(KbError::NotFound("这个用户还没有个人知识库".to_owned()));
        };
        // 预热运行时:第一次点开时就把库打开,后续列表 / 预览不再等打开
        spaces.get(&space.id).await?;
        let used_bytes = match &self.storage {
            Some(storage) => {
                let space_paths = storage.paths.for_space(&space.id)?;
                storage.meter.usage(&space.id, &space_paths).await.total()
            }
            None => u64::try_from(space.storage_bytes).unwrap_or(0),
        };
        self.audit(
            ctx,
            "admin_space_view.open",
            &target.id,
            json!({ "space_id": space.id }),
        )
        .await;
        Ok(json!({
            "user_id": target.id,
            "space_id": space.id,
            "username": target.username,
            "display_name": target.display_name,
            "used_bytes": used_bytes,
        }))
    }

    async fn user_create(&self, ctx: &CallCtx, args: UserCreateArgs) -> Result<Value> {
        let role_id = args
            .role_id
            .unwrap_or_else(|| self.config.get().accounts.default_role.clone());
        if !Self::is_full_admin(ctx)
            && self
                .system
                .get_role(&role_id)
                .await?
                .is_some_and(|role| role.all_features)
        {
            return Err(KbError::Forbidden("只有管理员能创建管理员账号".to_owned()));
        }
        let hash = kb_web::auth::password::hash_password(&args.password)?;
        let (user, space) = self
            .system
            .create_user(NewUser {
                username: args.username,
                email: args.email,
                display_name: args.display_name,
                password_hash: hash,
                role_id,
                status: UserStatus::Active,
                registered_via: "admin".to_owned(),
                must_change_password: args.must_change_password,
                email_verified: false,
            })
            .await?;
        self.audit(
            ctx,
            "user.create",
            &user.id,
            json!({ "username": user.username, "role": user.role_id }),
        )
        .await;
        Ok(json!({ "user": user, "space": space }))
    }

    async fn user_update(&self, ctx: &CallCtx, args: UserUpdateArgs) -> Result<Value> {
        let target = self.find(&args.id).await?;
        self.guard_target(ctx, &target, args.role_id.as_deref())
            .await?;
        let user = self
            .system
            .update_user(
                &args.id,
                UserUpdate {
                    display_name: args.display_name,
                    role_id: args.role_id.clone(),
                    status: args.status.as_deref().map(parse_status).transpose()?,
                    quota_json: quota_text(args.quota)?,
                    ..Default::default()
                },
            )
            .await?;
        self.audit(
            ctx,
            "user.update",
            &user.id,
            json!({ "role": args.role_id, "status": args.status, "display_name": user.display_name }),
        )
        .await;
        self.user_json(&user).await
    }

    async fn user_set_password(&self, ctx: &CallCtx, args: UserPasswordArgs) -> Result<Value> {
        let target = self.find(&args.id).await?;
        self.guard_target(ctx, &target, None).await?;
        let hash = kb_web::auth::password::hash_password(&args.password)?;
        self.system
            .set_password_hash(&target.id, &hash, args.must_change_password, None)
            .await?;
        self.audit(ctx, "user.password", &target.id, json!({}))
            .await;
        Ok(json!({ "id": target.id, "password_set": true }))
    }

    async fn user_totp_reset(&self, ctx: &CallCtx, args: UserIdArgs) -> Result<Value> {
        let target = self.find(&args.user_id).await?;
        self.guard_target(ctx, &target, None).await?;
        let was_on = self.system.disable_totp(&target.id).await?;
        // 他丢的可能是手机:已有的登录一并作废,下次只用密码登录,再自己重新设置
        let revoked = self.system.delete_user_sessions(&target.id, None).await?;
        self.audit(
            ctx,
            "user.totp_reset",
            &target.id,
            json!({ "was_enabled": was_on }),
        )
        .await;
        Ok(json!({ "id": target.id, "was_enabled": was_on, "sessions_revoked": revoked }))
    }

    async fn user_feature(&self, ctx: &CallCtx, args: UserFeatureArgs) -> Result<Value> {
        let target = self.find(&args.id).await?;
        self.guard_target(ctx, &target, None).await?;
        self.system
            .set_feature_override(&target.id, &args.feature, args.effect.as_deref())
            .await?;
        self.audit(
            ctx,
            "user.feature",
            &target.id,
            json!({ "feature": args.feature, "effect": args.effect }),
        )
        .await;
        self.user_get(IdArgs { id: target.id }).await
    }

    async fn invite_create(&self, ctx: &CallCtx, args: InviteCreateArgs) -> Result<Value> {
        self.do_invite_create(ctx, args).await
    }

    async fn invite_list(&self, _ctx: &CallCtx) -> Result<Value> {
        self.do_invite_list().await
    }

    async fn invite_revoke(&self, ctx: &CallCtx, args: IdArgs) -> Result<Value> {
        self.do_invite_revoke(ctx, &args.id).await
    }

    async fn invite_uses(&self, _ctx: &CallCtx, args: IdArgs) -> Result<Value> {
        self.do_invite_uses(&args.id).await
    }

    async fn mail_status(&self) -> Result<Value> {
        self.do_mail_status().await
    }

    async fn mail_password(&self, ctx: &CallCtx, args: MailPasswordArgs) -> Result<Value> {
        self.do_mail_password(ctx, args).await
    }

    async fn mail_test(&self, ctx: &CallCtx, args: MailTestArgs) -> Result<Value> {
        self.do_mail_test(ctx, args).await
    }

    async fn mail_log(&self, args: MailLogArgs) -> Result<Value> {
        self.do_mail_log(args).await
    }
}
