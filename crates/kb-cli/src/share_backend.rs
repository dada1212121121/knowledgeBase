//! 文档分享能力的实现(接口见 `kb-capability::sharing`)。
//!
//! 规矩集中在这里:
//! - 没有权限的资源一律当作不存在(404),有权限但不够才说「权限不够」(403);
//! - 分享需要「可管理」,而且**最多授予与自己相同的角色**(所有者最多授予「可管理」);
//! - 不能分享给把我拉黑 / 被我拉黑的人,对方设了「只接受好友的分享」时必须是好友——
//!   这两种情况对分享人说的话和「找不到这个人」一样;
//! - 批量分享整批原子,通知按人合并(选了 8 项只发一条「共享了 8 项」,而不是 8 条)。

use std::sync::Arc;

use kb_capability::CallCtx;
use kb_capability::admin::{
    GrantBatchArgs, GrantRemoveArgs, GrantSetArgs, HideShareArgs, SetInheritArgs, SharedWithMeArgs,
    TargetArgs,
};
use kb_core::model::Millis;
use kb_core::share::{Action, ResourceKey, Role, ShareTarget};
use kb_core::social::{PublicProfile, ShareFrom, kind};
use kb_core::{KbError, Result};
use kb_meta::system::GrantChange;
use serde_json::{Value, json};

use crate::admin_backend::SystemAdmin;
use crate::spaces::SpaceRegistry;

/// 分享相关依赖。
pub struct ShareDeps {
    /// 知识库注册表:查笔记标题、确认集合存在。
    pub spaces: Arc<SpaceRegistry>,
}

fn now_ms() -> Millis {
    kb_service::llm_gate::today_now_millis()
}

const DAY_MS: i64 = 86_400_000;

fn expiry(days: Option<u32>, now: Millis) -> Result<Option<Millis>> {
    match days {
        None => Ok(None),
        Some(0) => Err(KbError::InvalidInput("有效天数至少 1 天".to_owned())),
        Some(days) if days > 3650 => Err(KbError::InvalidInput("有效期最长 10 年".to_owned())),
        Some(days) => Ok(Some(now + i64::from(days) * DAY_MS)),
    }
}

/// 角色能做的动作,给前端决定显示哪些按钮。
fn can_json(role: Role) -> Value {
    json!({
        "view": role.allows(Action::View),
        "download": role.allows(Action::Download),
        "comment": role.allows(Action::Comment),
        "edit": role.allows(Action::Edit),
        "create": role.allows(Action::Create),
        "history": role.allows(Action::History),
        "restore": role.allows(Action::Restore),
        "manage_grants": role.allows(Action::ManageGrants),
        "manage_links": role.allows(Action::ManageLinks),
        "delete": role.allows(Action::Delete),
        "transfer_owner": role.allows(Action::TransferOwner),
    })
}

impl SystemAdmin {
    pub(crate) fn share_deps(&self) -> Result<&ShareDeps> {
        self.share
            .as_ref()
            .ok_or_else(|| KbError::Unavailable("文档分享没有启用".to_owned()))
    }

    /// 调用者的用户 id 和他自己的知识库 id。本机超级用户不是具体的人,拒绝。
    pub(crate) fn share_actor(ctx: &CallCtx) -> Result<(String, Option<String>)> {
        match &ctx.principal {
            Some(principal) if !principal.local => {
                Ok((principal.user_id.clone(), principal.space_id.clone()))
            }
            _ => Err(KbError::Forbidden("文档分享需要用账号登录".to_owned())),
        }
    }

    pub(crate) fn key_of(target: &ShareTarget, own_space: Option<&str>) -> Result<ResourceKey> {
        target.to_key(own_space)
    }

    /// 资源的名字:笔记用标题,其余用最后一段(集合名 / 文件夹名 / 文件名)。查不到就退回键里的名字。
    pub(crate) async fn title_of(&self, key: &ResourceKey) -> String {
        let fallback = || match key {
            ResourceKey::Space { .. } => "整个知识库".to_owned(),
            ResourceKey::Collection { name, .. } => name.clone(),
            ResourceKey::Dir { path, .. }
            | ResourceKey::Doc {
                doc: kb_core::share::DocRef::File(path),
                ..
            } => path.rsplit('/').next().unwrap_or(path).to_owned(),
            ResourceKey::Doc {
                doc: kb_core::share::DocRef::Insight(id),
                ..
            } => id.clone(),
        };
        if let ResourceKey::Doc {
            sid,
            doc: kb_core::share::DocRef::Insight(id),
            ..
        } = key
            && let Ok(deps) = self.share_deps()
            && let Ok(runtime) = deps.spaces.get(sid).await
            && let Ok(Some(insight)) =
                kb_core::ports::repo::InsightRepo::get(runtime.meta.as_ref(), id).await
        {
            return insight.title;
        }
        fallback()
    }

    /// 分享给这个人行不行。拉黑、对方只接受好友分享这两种情况,对分享人都表现为「找不到」。
    async fn check_can_share_to(&self, actor: &str, target: &str) -> Result<()> {
        if actor == target {
            return Err(KbError::InvalidInput("不能分享给自己".to_owned()));
        }
        let not_found = || KbError::NotFound("没有找到这个用户".to_owned());
        if self.system.is_blocked_between(actor, target).await? {
            return Err(not_found());
        }
        let privacy = self
            .system
            .privacy_of(target)
            .await
            .map_err(|_| not_found())?;
        if privacy.share_from == ShareFrom::Friends
            && !self.system.are_friends(actor, target).await?
        {
            return Err(not_found());
        }
        Ok(())
    }

    /// 授予的角色不能高过自己的;所有者最多授予「可管理」(所有权只能转移)。
    fn check_role_ceiling(actor_role: Role, wanted: Role) -> Result<()> {
        let ceiling = actor_role.min(Role::Manager);
        if wanted > ceiling {
            return Err(KbError::Forbidden(format!(
                "你最多只能授予「{}」",
                ceiling.label()
            )));
        }
        Ok(())
    }

    /// 集合必须真的存在(防止笔误的路径在库里留下永远用不上的授权)。
    async fn ensure_collection_exists(&self, key: &ResourceKey) -> Result<()> {
        let Some(name) = key.collection_name() else {
            return Ok(());
        };
        let runtime = self.share_deps()?.spaces.get(key.space_id()).await?;
        if kb_core::ports::repo::CollectionRepo::get(runtime.meta.as_ref(), name)
            .await?
            .is_none()
        {
            return Err(KbError::NotFound("没有找到这个内容".to_owned()));
        }
        Ok(())
    }

    async fn notify_share(
        &self,
        to: &str,
        from: &PublicProfile,
        key: &ResourceKey,
        role: Role,
        title: String,
        count: usize,
    ) {
        let Ok(social) = self.social() else { return };
        social
            .notifier
            .send(
                to,
                kind::SHARE_RECEIVED,
                json!({
                    "key": key.to_string(),
                    "target": key.to_target(),
                    "title": title,
                    "count": count,
                    "role": role,
                    "role_label": role.label(),
                    "from": from,
                }),
                now_ms(),
            )
            .await;
    }

    pub(crate) async fn do_grant_list(&self, ctx: &CallCtx, args: TargetArgs) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let key = Self::key_of(&args.target, own.as_deref())?;
        let now = now_ms();
        let role = self
            .system
            .require_role(&me, &key, Action::ManageGrants, now)
            .await?;
        let grants = self.system.lineage_grants(&key, now).await?;
        let owner = match self.system.space_owner(key.space_id()).await? {
            Some(id) => self.profile_of(&id).await,
            None => None,
        };
        Ok(json!({
            "target": key.to_target(),
            "key": key.to_string(),
            "my_role": role,
            "owner": owner,
            "inherit_broken": self.system.is_inherit_broken(&key).await?,
            "grants": grants.iter().map(|view| json!({
                "user": view.grantee,
                "role": view.grant.role,
                "inherited": view.inherited,
                "source": view.grant.resource_key,
                "via": view.grant.via,
                "expires_at": view.grant.expires_at,
            })).collect::<Vec<_>>(),
        }))
    }

    pub(crate) async fn do_grant_set(&self, ctx: &CallCtx, args: GrantSetArgs) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let key = Self::key_of(&args.target, own.as_deref())?;
        let now = now_ms();
        let actor_role = self
            .system
            .require_role(&me, &key, Action::ManageGrants, now)
            .await?;
        let role = Role::parse_grantable(&args.role)?;
        Self::check_role_ceiling(actor_role, role)?;
        self.check_can_share_to(&me, &args.user_id).await?;
        self.ensure_collection_exists(&key).await?;
        let done = self
            .system
            .set_grant(
                &key,
                &args.user_id,
                role,
                "direct",
                &me,
                now,
                expiry(args.expires_days, now)?,
            )
            .await?;
        if done.previous != Some(role)
            && let Some(from) = self.profile_of(&me).await
        {
            let title = self.title_of(&key).await;
            self.notify_share(&args.user_id, &from, &key, role, title, 1)
                .await;
        }
        Ok(json!({ "grant": done.grant, "previous": done.previous }))
    }

    pub(crate) async fn do_grant_remove(
        &self,
        ctx: &CallCtx,
        args: GrantRemoveArgs,
    ) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let key = Self::key_of(&args.target, own.as_deref())?;
        let now = now_ms();
        self.system
            .require_role(&me, &key, Action::ManageGrants, now)
            .await?;
        let removed = self.system.remove_grant(&key, &args.user_id).await?;
        if removed.is_some()
            && let (Ok(social), Some(from)) = (self.social(), self.profile_of(&me).await)
        {
            let title = self.title_of(&key).await;
            social
                .notifier
                .send(
                    &args.user_id,
                    kind::COLLABORATOR_REMOVED,
                    json!({ "key": key.to_string(), "target": key.to_target(), "title": title, "from": from }),
                    now,
                )
                .await;
        }
        Ok(json!({ "removed": removed }))
    }

    pub(crate) async fn do_grant_batch(
        &self,
        ctx: &CallCtx,
        args: GrantBatchArgs,
    ) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let now = now_ms();
        let mut keys = Vec::with_capacity(args.targets.len());
        let mut ceiling = Role::Owner;
        for target in &args.targets {
            let key = Self::key_of(target, own.as_deref())?;
            // 每一项都要有「可管理」:选中的东西里有一项没权限,整批拒绝
            let role = self
                .system
                .require_role(&me, &key, Action::ManageGrants, now)
                .await?;
            ceiling = ceiling.min(role);
            keys.push(key);
        }
        let mut changes = Vec::with_capacity(args.people.len());
        for person in &args.people {
            let role = match person.role.as_deref() {
                Some(text) => {
                    let role = Role::parse_grantable(text)?;
                    Self::check_role_ceiling(ceiling, role)?;
                    self.check_can_share_to(&me, &person.user_id).await?;
                    Some(role)
                }
                None => None,
            };
            changes.push(GrantChange {
                grantee_id: person.user_id.clone(),
                role,
            });
        }
        for key in &keys {
            self.ensure_collection_exists(key).await?;
        }
        let outcome = self
            .system
            .apply_grants(&keys, &changes, &me, now, expiry(args.expires_days, now)?)
            .await?;
        // 通知按人合并:一条「共享了 N 项」
        if let Some(from) = self.profile_of(&me).await {
            let title = self.title_of(&keys[0]).await;
            for change in &changes {
                if let Some(role) = change.role {
                    self.notify_share(
                        &change.grantee_id,
                        &from,
                        &keys[0],
                        role,
                        title.clone(),
                        keys.len(),
                    )
                    .await;
                }
            }
        }
        Ok(
            json!({ "changed": outcome.changed, "unchanged": outcome.unchanged, "removed": outcome.removed }),
        )
    }

    pub(crate) async fn do_set_inherit(
        &self,
        ctx: &CallCtx,
        args: SetInheritArgs,
    ) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let key = Self::key_of(&args.target, own.as_deref())?;
        let now = now_ms();
        self.system
            .require_role(&me, &key, Action::ManageGrants, now)
            .await?;
        self.system
            .set_inherit_break(&key, !args.inherit, &me, now)
            .await?;
        Ok(json!({ "inherit": args.inherit }))
    }

    pub(crate) async fn do_effective_role(&self, ctx: &CallCtx, args: TargetArgs) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let key = Self::key_of(&args.target, own.as_deref())?;
        let now = now_ms();
        let Some(role) = self.system.role_of(&me, &key, now).await? else {
            return Ok(json!({ "role": null, "can": null }));
        };
        let source = if role == Role::Owner {
            None
        } else {
            self.system
                .granted_role(&me, &key, now)
                .await?
                .map(|e| e.source)
        };
        Ok(json!({ "role": role, "label": role.label(), "can": can_json(role), "source": source }))
    }

    pub(crate) async fn do_shared_with_me(
        &self,
        ctx: &CallCtx,
        args: SharedWithMeArgs,
    ) -> Result<Value> {
        let (me, _) = Self::share_actor(ctx)?;
        let roots = self
            .system
            .shared_with(&me, args.include_hidden, now_ms())
            .await?;
        let mut items = Vec::with_capacity(roots.len());
        for root in roots {
            let Ok(key) = ResourceKey::parse(&root.grant.resource_key) else {
                continue;
            };
            items.push(json!({
                "target": key.to_target(),
                "key": root.grant.resource_key,
                "title": self.title_of(&key).await,
                "role": root.grant.role,
                "owner": root.owner,
                "shared_at": root.grant.created_at,
                "expires_at": root.grant.expires_at,
                "hidden": root.hidden,
            }));
        }
        Ok(json!({ "items": items }))
    }

    pub(crate) async fn do_shared_by_me(&self, ctx: &CallCtx) -> Result<Value> {
        let (me, _) = Self::share_actor(ctx)?;
        let rows = self.system.shared_by(&me, now_ms()).await?;
        let mut items = Vec::with_capacity(rows.len());
        for row in rows {
            let Ok(key) = ResourceKey::parse(&row.resource_key) else {
                continue;
            };
            items.push(json!({
                "target": key.to_target(),
                "key": row.resource_key,
                "title": self.title_of(&key).await,
                "grantees": row.grantees.iter().map(|(user, role)| json!({ "user": user, "role": role })).collect::<Vec<_>>(),
                "inherit_broken": row.inherit_broken,
            }));
        }
        Ok(json!({ "items": items }))
    }

    pub(crate) async fn do_hide_share(&self, ctx: &CallCtx, args: HideShareArgs) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let key = Self::key_of(&args.target, own.as_deref())?;
        self.system.set_share_hidden(&me, &key, args.hidden).await?;
        Ok(json!({ "hidden": args.hidden }))
    }
}

// ---------------------------------------------------------------- 访问申请

use kb_capability::admin::{AccessDecideArgs, AccessRequestArgs};
use kb_core::share::AccessRequest;

impl SystemAdmin {
    async fn request_json(&self, request: &AccessRequest) -> Value {
        let key = ResourceKey::parse(&request.resource_key).ok();
        json!({
            "id": request.id,
            "key": request.resource_key,
            "target": key.as_ref().map(ResourceKey::to_target),
            "title": match &key { Some(key) => self.title_of(key).await, None => String::new() },
            "requester": self.profile_of(&request.requester_id).await,
            "role": request.role,
            "message": request.message,
            "state": request.state,
            "created_at": request.created_at,
            "decided_at": request.decided_at,
        })
    }

    pub(crate) async fn do_access_request(
        &self,
        ctx: &CallCtx,
        args: AccessRequestArgs,
    ) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let key = Self::key_of(&args.target, own.as_deref())?;
        let role = Role::parse_grantable(&args.role)?;
        let now = now_ms();
        let Some(request) = self
            .system
            .create_access_request(&key, &me, role, args.message.as_deref(), now)
            .await?
        else {
            // 所有者拉黑了申请人:表面成功
            return Ok(json!({ "status": "requested" }));
        };
        // 通知所有者和有「可管理」的人(不通知申请人自己)
        if let (Ok(social), Some(from)) = (self.social(), self.profile_of(&me).await) {
            let title = self.title_of(&key).await;
            for manager in self.system.managers_of(&key, now).await? {
                if manager == me {
                    continue;
                }
                social
                    .notifier
                    .send(
                        &manager,
                        kind::ACCESS_REQUEST,
                        json!({
                            "request_id": request.id,
                            "key": key.to_string(),
                            "target": key.to_target(),
                            "title": title,
                            "requester": from,
                            "role": role,
                            "role_label": role.label(),
                            "message": request.message,
                        }),
                        now,
                    )
                    .await;
            }
        }
        Ok(json!({ "status": "requested", "id": request.id }))
    }

    pub(crate) async fn do_access_requests(&self, ctx: &CallCtx) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let now = now_ms();
        // 候选知识库:我自己的 + 我在里面有「可管理」授权的
        let mut spaces: Vec<String> = own.into_iter().collect();
        for root in self.system.shared_with(&me, true, now).await? {
            if root.grant.role == Role::Manager && !spaces.contains(&root.grant.space_id) {
                spaces.push(root.grant.space_id.clone());
            }
        }
        let mut to_decide = Vec::new();
        for request in self.system.pending_access_requests_in(&spaces).await? {
            let Ok(key) = ResourceKey::parse(&request.resource_key) else {
                continue;
            };
            // 精确判断:对这个具体资源有没有「可管理」(授权可能只在别处)
            let allowed = self
                .system
                .role_of(&me, &key, now)
                .await?
                .is_some_and(|role| role.allows(Action::ManageGrants));
            if allowed {
                to_decide.push(self.request_json(&request).await);
            }
        }
        let mut mine = Vec::new();
        for request in self.system.my_access_requests(&me).await? {
            mine.push(self.request_json(&request).await);
        }
        Ok(json!({ "to_decide": to_decide, "mine": mine }))
    }

    pub(crate) async fn do_access_decide(
        &self,
        ctx: &CallCtx,
        args: AccessDecideArgs,
    ) -> Result<Value> {
        let (me, _) = Self::share_actor(ctx)?;
        let now = now_ms();
        // 不存在 / 处理过 / 没权限处理:一律「没有这条待处理的申请」,不泄露别人的申请
        let not_found = || KbError::NotFound("没有这条待处理的申请".to_owned());
        let request = self
            .system
            .get_access_request(&args.id)
            .await?
            .filter(|r| r.state == kb_core::share::RequestState::Pending)
            .ok_or_else(not_found)?;
        let key = ResourceKey::parse(&request.resource_key)?;
        let actor_role = self
            .system
            .role_of(&me, &key, now)
            .await?
            .filter(|role| role.allows(Action::ManageGrants))
            .ok_or_else(not_found)?;
        let granted = match args.role.as_deref() {
            Some(text) if args.approve => {
                let role = Role::parse_grantable(text)?;
                Self::check_role_ceiling(actor_role, role)?;
                Some(role)
            }
            _ => None,
        };
        let done = self
            .system
            .decide_access_request(&request.id, &me, args.approve, granted, now)
            .await?;
        // 告诉申请人结果
        if let (Ok(social), Some(by)) = (self.social(), self.profile_of(&me).await) {
            let title = self.title_of(&key).await;
            social
                .notifier
                .send(
                    &done.requester_id,
                    kind::ACCESS_RESULT,
                    json!({
                        "request_id": done.id,
                        "key": done.resource_key,
                        "target": key.to_target(),
                        "title": title,
                        "approved": args.approve,
                        "role": done.role,
                        "role_label": done.role.label(),
                        "by": by,
                    }),
                    now,
                )
                .await;
        }
        Ok(json!({ "state": done.state, "role": done.role }))
    }
}
