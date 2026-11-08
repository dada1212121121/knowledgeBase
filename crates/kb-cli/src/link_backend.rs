//! 分享链接管理能力的实现(接口见 `kb-capability::links`)。
//!
//! - 创建链接需要对资源有「修改链接权限」(可管理 / 所有者);合集链接要求每一项都满足;
//! - 访问范围对应功能点:登录用户链接 `collab.link_users`,游客链接 `collab.link_guest`;
//! - 链接地址(含令牌)只在创建 / 重置时返回一次,之后接口里只有后四位提示;
//! - 管理员治理页看不到资源内容,只看创建人、所有者、类型、访问量（设计规范）。

use kb_capability::CallCtx;
use kb_capability::admin::{
    GuestPurgeArgs, LinkCreateArgs, LinkGetArgs, LinkIdArgs, LinkUpdateArgs, ShareAdminListArgs,
};
use kb_core::model::Millis;
use kb_core::share::link::{Audience, LinkState, ShareLink, check_password_shape, guest_ceiling};
use kb_core::share::{Action, ResourceKey, Role};
use kb_core::{KbError, Result};
use kb_meta::system::{LinkRecord, LinkUpdate, NewLink};
use serde_json::{Value, json};

use crate::admin_backend::SystemAdmin;

const DAY_MS: i64 = 86_400_000;

fn now_ms() -> Millis {
    kb_service::llm_gate::today_now_millis()
}

fn expiry(days: u32, now: Millis) -> Result<Millis> {
    if days == 0 || days > 3650 {
        return Err(KbError::InvalidInput(
            "有效天数需要在 1–3650 之间".to_owned(),
        ));
    }
    Ok(now + i64::from(days) * DAY_MS)
}

fn link_role(text: &str) -> Result<Role> {
    match Role::parse(text)? {
        role @ (Role::Viewer | Role::Commenter | Role::Editor) => Ok(role),
        _ => Err(KbError::InvalidInput(
            "链接的角色只能是查看、评论或编辑".to_owned(),
        )),
    }
}

impl SystemAdmin {
    /// 链接地址。
    fn link_url(&self, token: &str) -> String {
        format!(
            "{}/s/{token}",
            self.config.get().site.public_url.trim_end_matches('/')
        )
    }

    /// 创建 / 修改链接时对访问范围的功能点检查。
    fn check_audience_feature(ctx: &CallCtx, audience: Audience) -> Result<()> {
        let needed = match audience {
            Audience::Collaborators => return Ok(()),
            Audience::LoggedIn => "collab.link_users",
            Audience::Anyone => "collab.link_guest",
        };
        let allowed = ctx
            .principal
            .as_ref()
            .is_some_and(|principal| principal.features.allows(needed));
        if allowed {
            Ok(())
        } else {
            Err(KbError::Forbidden("你的账号没有开通这种链接".to_owned()))
        }
    }

    /// 链接对外展示的样子(不含地址、不含密码哈希)。
    async fn link_json(&self, record: &LinkRecord, now: Millis) -> Value {
        let link = &record.link;
        let roots: Vec<Value> = record
            .roots()
            .iter()
            .map(|key| json!(key.to_target()))
            .collect();
        let title = match record.roots().first() {
            Some(key) if record.items.is_empty() => self.title_of(key).await,
            _ => link.title.clone().unwrap_or_default(),
        };
        let ceiling = guest_ceiling(&self.config.get().share);
        json!({
            "id": link.id,
            "hint": link.token_hint,
            "title": title,
            "bundle": link.resource_key.is_none(),
            "roots": roots,
            "audience": link.audience,
            "role": link.role,
            "has_password": link.has_password,
            "expires_at": link.expires_at,
            "allow_download": link.allow_download,
            "watermark": link.watermark,
            "allow_reshare": link.allow_reshare,
            "enabled": link.enabled,
            "state": link.state(now),
            "views": link.views,
            "last_view_at": link.last_view_at,
            "created_at": link.created_at,
            // 游客现在实际能拿到的最高角色(管理员关掉游客评论 / 编辑后,已有链接降级生效)
            "guest_role": if link.audience == Audience::Anyone {
                ceiling.map(|c| link.role.min(c))
            } else {
                None
            },
        })
    }

    /// 要求操作者对链接覆盖的每一个资源都有「修改链接权限」。
    async fn require_link_manager(&self, me: &str, record: &LinkRecord, now: Millis) -> Result<()> {
        let roots = record.roots();
        if roots.is_empty() {
            // 合集里的东西都没了:只有知识库的主人能处理
            return if self
                .system
                .space_owner(&record.link.space_id)
                .await?
                .as_deref()
                == Some(me)
            {
                Ok(())
            } else {
                Err(KbError::NotFound("没有这个链接".to_owned()))
            };
        }
        for key in &roots {
            self.system
                .require_role(me, key, Action::ManageLinks, now)
                .await
                .map_err(|err| match err {
                    // 对没有权限的人,链接和资源一样"不存在"
                    KbError::Forbidden(_) | KbError::NotFound(_) => {
                        KbError::NotFound("没有这个链接".to_owned())
                    }
                    other => other,
                })?;
        }
        Ok(())
    }

    async fn find_link_for(&self, me: &str, id: &str, now: Millis) -> Result<LinkRecord> {
        let record = self
            .system
            .get_link(id)
            .await?
            .ok_or_else(|| KbError::NotFound("没有这个链接".to_owned()))?;
        self.require_link_manager(me, &record, now).await?;
        Ok(record)
    }

    pub(crate) async fn do_link_create(
        &self,
        ctx: &CallCtx,
        args: LinkCreateArgs,
    ) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let now = now_ms();
        let audience = Audience::parse(&args.audience)?;
        let role = link_role(&args.role)?;
        Self::check_audience_feature(ctx, audience)?;
        let (resource, items) = match (&args.target, args.targets.is_empty()) {
            (Some(target), true) => (Some(Self::key_of(target, own.as_deref())?), Vec::new()),
            (None, false) => {
                let items = args
                    .targets
                    .iter()
                    .map(|target| Self::key_of(target, own.as_deref()))
                    .collect::<Result<Vec<_>>>()?;
                (None, items)
            }
            _ => {
                return Err(KbError::InvalidInput(
                    "给一个 target(单个链接)或一组 targets(合集链接),不能都给或都不给".to_owned(),
                ));
            }
        };
        for key in resource.iter().chain(items.iter()) {
            self.system
                .require_role(&me, key, Action::ManageLinks, now)
                .await?;
        }
        let password_hash = match args.password.as_deref() {
            Some(password) => {
                check_password_shape(password)?;
                Some(kb_web::auth::password::hash_secret(password)?)
            }
            None => None,
        };
        let defaults = self.config.get().quota.clone();
        let max_links = self
            .system
            .effective_quota(&me, &defaults)
            .await?
            .links_per_user;
        let expires_at = args
            .expires_days
            .map(|days| expiry(days, now))
            .transpose()?;
        let (link, token) = self
            .system
            .create_link(
                NewLink {
                    resource,
                    items,
                    title: args.title.map(|t| t.trim().chars().take(60).collect()),
                    audience,
                    role,
                    password_hash,
                    expires_at,
                    allow_download: args.allow_download.unwrap_or(true),
                    watermark: args.watermark.unwrap_or(false),
                    allow_reshare: args.allow_reshare.unwrap_or(false),
                    created_by: me,
                },
                max_links,
                now,
            )
            .await?;
        let record = self
            .system
            .get_link(&link.id)
            .await?
            .ok_or_else(|| KbError::Internal("链接丢了".to_owned()))?;
        Ok(json!({ "link": self.link_json(&record, now).await, "url": self.link_url(&token) }))
    }

    pub(crate) async fn do_link_get(&self, ctx: &CallCtx, args: LinkGetArgs) -> Result<Value> {
        let (me, own) = Self::share_actor(ctx)?;
        let key = Self::key_of(&args.target, own.as_deref())?;
        let now = now_ms();
        self.system
            .require_role(&me, &key, Action::ManageLinks, now)
            .await?;
        let mut links = Vec::new();
        for record in self.system.links_for_resource(&key).await? {
            links.push(self.link_json(&record, now).await);
        }
        Ok(json!({ "target": key.to_target(), "links": links }))
    }

    pub(crate) async fn do_link_update(
        &self,
        ctx: &CallCtx,
        args: LinkUpdateArgs,
    ) -> Result<Value> {
        let (me, _) = Self::share_actor(ctx)?;
        let now = now_ms();
        let record = self.find_link_for(&me, &args.id, now).await?;
        let audience = args.audience.as_deref().map(Audience::parse).transpose()?;
        if let Some(audience) = audience {
            Self::check_audience_feature(ctx, audience)?;
        }
        let role = args.role.as_deref().map(link_role).transpose()?;
        if args.password.is_some() && args.clear_password {
            return Err(KbError::InvalidInput(
                "不能同时设置和去掉访问密码".to_owned(),
            ));
        }
        if args.expires_days.is_some() && args.clear_expiry {
            return Err(KbError::InvalidInput("不能同时设置和去掉有效期".to_owned()));
        }
        let password_hash = match (args.password.as_deref(), args.clear_password) {
            (Some(password), _) => {
                check_password_shape(password)?;
                Some(Some(kb_web::auth::password::hash_secret(password)?))
            }
            (None, true) => Some(None),
            (None, false) => None,
        };
        let expires_at = match (args.expires_days, args.clear_expiry) {
            (Some(days), _) => Some(Some(expiry(days, now)?)),
            (None, true) => Some(None),
            (None, false) => None,
        };
        let updated = self
            .system
            .update_link(
                &record.link.id,
                LinkUpdate {
                    audience,
                    role,
                    password_hash,
                    expires_at,
                    allow_download: args.allow_download,
                    watermark: args.watermark,
                    allow_reshare: args.allow_reshare,
                    enabled: args.enabled,
                    title: args
                        .title
                        .map(|t| Some(t.trim().chars().take(60).collect())),
                },
                now,
            )
            .await?;
        Ok(json!({ "link": self.link_json(&updated, now).await }))
    }

    pub(crate) async fn do_link_reset(&self, ctx: &CallCtx, args: LinkIdArgs) -> Result<Value> {
        let (me, _) = Self::share_actor(ctx)?;
        let now = now_ms();
        let record = self.find_link_for(&me, &args.id, now).await?;
        let token = self.system.reset_link_token(&record.link.id).await?;
        let record = self
            .system
            .get_link(&record.link.id)
            .await?
            .ok_or_else(|| KbError::Internal("链接丢了".to_owned()))?;
        Ok(json!({ "link": self.link_json(&record, now).await, "url": self.link_url(&token) }))
    }

    pub(crate) async fn do_link_revoke(&self, ctx: &CallCtx, args: LinkIdArgs) -> Result<Value> {
        let (me, _) = Self::share_actor(ctx)?;
        let now = now_ms();
        let record = self.find_link_for(&me, &args.id, now).await?;
        Ok(json!({ "revoked": self.system.revoke_link(&record.link.id, now).await? }))
    }

    pub(crate) async fn do_link_stats(&self, ctx: &CallCtx, args: LinkIdArgs) -> Result<Value> {
        let (me, _) = Self::share_actor(ctx)?;
        let now = now_ms();
        let record = self.find_link_for(&me, &args.id, now).await?;
        let mut visitors = Vec::new();
        for visitor in self.system.link_visitors(&record.link.id).await? {
            visitors.push(json!({
                "user": self.profile_of(&visitor.user_id).await,
                "first_at": visitor.first_at,
                "last_at": visitor.last_at,
                "visits": visitor.visits,
            }));
        }
        Ok(json!({
            "views": record.link.views,
            "last_view_at": record.link.last_view_at,
            "visitors": visitors,
            "anonymous_note": "匿名访客只统计次数",
        }))
    }

    pub(crate) async fn do_my_links(&self, ctx: &CallCtx) -> Result<Value> {
        let (me, _) = Self::share_actor(ctx)?;
        let now = now_ms();
        let mut links = Vec::new();
        for record in self.system.links_by_creator(&me).await? {
            links.push(self.link_json(&record, now).await);
        }
        Ok(json!({ "links": links }))
    }

    /// 治理页的一行:只有创建人、所有者、类型、访问量、状态,**不显示资源内容**。
    async fn admin_row(&self, link: &ShareLink, now: Millis) -> Value {
        let kind = link
            .resource_key
            .as_deref()
            .and_then(|text| ResourceKey::parse(text).ok())
            .map(|key| key.to_target().kind);
        json!({
            "id": link.id,
            "hint": link.token_hint,
            "kind": kind.unwrap_or_else(|| "bundle".to_owned()),
            "audience": link.audience,
            "role": link.role,
            "has_password": link.has_password,
            "state": link.state(now),
            "views": link.views,
            "last_view_at": link.last_view_at,
            "created_at": link.created_at,
            "creator": self.profile_of(&link.created_by).await,
            "owner": match self.system.space_owner(&link.space_id).await {
                Ok(Some(id)) => self.profile_of(&id).await,
                _ => None,
            },
        })
    }

    pub(crate) async fn do_share_admin_list(
        &self,
        _ctx: &CallCtx,
        args: ShareAdminListArgs,
    ) -> Result<Value> {
        let page_size = args.page_size.unwrap_or(50).clamp(1, 100);
        let page = args.page.unwrap_or(1).max(1);
        let (records, total) = self
            .system
            .all_links(page_size, (page - 1) * page_size)
            .await?;
        let now = now_ms();
        let mut rows = Vec::new();
        for record in &records {
            rows.push(self.admin_row(&record.link, now).await);
        }
        Ok(json!({ "links": rows, "total": total, "page": page, "page_size": page_size }))
    }

    pub(crate) async fn do_share_admin_revoke(
        &self,
        ctx: &CallCtx,
        args: LinkIdArgs,
    ) -> Result<Value> {
        let record = self
            .system
            .get_link(&args.id)
            .await?
            .ok_or_else(|| KbError::NotFound("没有这个链接".to_owned()))?;
        let revoked = self.system.revoke_link(&record.link.id, now_ms()).await?;
        self.audit(
            ctx,
            "share.admin_revoke",
            &record.link.id,
            json!({ "creator": record.link.created_by, "space": record.link.space_id, "was": record.link.state(now_ms()) == LinkState::Active }),
        )
        .await;
        Ok(json!({ "revoked": revoked }))
    }
}

impl SystemAdmin {
    /// 清除某个访客留下的所有评论。只在**自己的**知识库里做,而且只认 `guest:` 开头的作者,
    /// 不能借这个能力删别的登录用户的批注。逐条走批注服务的删除,检索里的副本一起清掉。
    pub(crate) async fn do_guest_purge(
        &self,
        ctx: &CallCtx,
        args: GuestPurgeArgs,
    ) -> Result<Value> {
        let (_, own) = Self::share_actor(ctx)?;
        let Some(space) = own else {
            return Err(KbError::Forbidden("你还没有知识库".to_owned()));
        };
        if !args.author.starts_with("guest:") || args.author.len() < "guest:#".len() + 1 {
            return Err(KbError::InvalidInput(
                "要清除的访客标识必须形如 guest:昵称#编号".to_owned(),
            ));
        }
        let runtime = self.share_deps()?.spaces.get(&space).await?;
        let annotations = kb_service::annotation::AnnotationService::new(
            runtime.meta.clone(),
            runtime.store.clone(),
            runtime.embedder.clone(),
        )
        .with_write_gate(runtime.write_gate());
        let found = kb_core::ports::repo::AnnotationRepo::list_by_author_prefix(
            runtime.meta.as_ref(),
            &args.author,
            1000,
        )
        .await?;
        let mut deleted = 0;
        for annotation in found {
            // 前缀匹配会把「guest:小王#ab12」也匹配到「guest:小王#ab12cd」:要求完全相等或后面紧跟「(」
            let exact = annotation.author.as_deref().is_some_and(|author| {
                author == args.author || author.starts_with(&format!("{}(", args.author))
            });
            if exact {
                annotations.delete(&annotation.id).await?;
                deleted += 1;
            }
        }
        Ok(json!({ "deleted": deleted }))
    }
}
