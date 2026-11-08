//! 能力调用的统一包装层（设计规范）。

use std::any::Any;
use std::sync::Arc;

use async_trait::async_trait;
use kb_core::features::{self, FeatureSet};
use kb_core::model::{AuditEntry, Change, Millis};
use kb_core::ports::repo::AuditRepo;
use kb_core::redact::redact;
use kb_core::{KbError, Result};
use serde_json::Value;

use crate::access::{Access, Scope};
use crate::registry::{Permission, Registry, Surface};

/// 调用者的身份(多用户):谁、用哪个知识库、最终能用哪些功能。
///
/// 由鉴权层(`kb-web`)在请求进来时算好放进 [`CallCtx`];能力层只**读**它,不自己判断「这个人是谁」。
#[derive(Clone, Debug)]
pub struct Principal {
    /// 用户 id(`usr_…`);本机超级用户是 `local`。
    pub user_id: String,
    /// 调用者个人知识库的 id。本机超级用户为 `None`,由解析器指到主知识库。
    pub space_id: Option<String>,
    /// 最终生效的功能集合。
    pub features: Arc<FeatureSet>,
    /// 是否本机超级用户(`kb.sock`)。
    pub local: bool,
}

impl Principal {
    /// 本机超级用户:全部功能,知识库由解析器指到主知识库。
    pub fn local() -> Self {
        Self {
            user_id: "local".to_owned(),
            space_id: None,
            features: Arc::new(FeatureSet::local()),
            local: true,
        }
    }

    /// 普通登录用户。
    pub fn user(
        user_id: impl Into<String>,
        space_id: impl Into<String>,
        features: FeatureSet,
    ) -> Self {
        Self {
            user_id: user_id.into(),
            space_id: Some(space_id.into()),
            features: Arc::new(features),
            local: false,
        }
    }
}

/// 解析器给这次「知识库内」调用选好的存储。
pub struct ResolvedSpace {
    /// 知识库 id(`sp_…`),事件推送按它过滤订阅者。
    pub space_id: String,
    /// 这个知识库自己的审计 / 批次库(`meta.db`)。
    pub audit: Arc<dyn AuditRepo>,
    /// 运行时句柄。能力层不认识它的类型(`kb-cli` 的 `Embedded`),原样放进任务局部变量,
    /// 由后端取出来用。
    pub handle: Arc<dyn Any + Send + Sync>,
}

/// 把调用者映射到他自己的知识库(`kb-cli` 的 `SpaceRegistry` 实现)。
#[async_trait]
pub trait SpaceResolver: Send + Sync {
    /// 为一个调用者选定知识库。找不到 / 没有 / 被停用时返回 `Forbidden`。
    async fn resolve(&self, principal: &Principal) -> Result<ResolvedSpace>;
    /// 系统级、账号级调用的审计(不属于任何知识库,进 `system.db`)。
    async fn audit_shared(&self, entry: AuditEntry);
}

/// 通过**分享链接**访问时,链接给的权限(游客和登录访问者共用)。
/// 由公开分享接口在校验过链接(有效期、密码、访问范围、系统参数降级)之后填写,
/// 分享闸门只信它,不会再去查调用者自己的授权以外的东西。
#[derive(Clone, Debug)]
pub struct LinkGrant {
    /// 链接 id(审计、限速用)。
    pub link_id: String,
    /// 资源所在知识库。
    pub space_id: String,
    /// 链接给这个访问者的角色(游客已按系统参数降级)。
    pub role: kb_core::share::Role,
    /// 链接覆盖的资源;访问者只能碰这些资源和它们底下的东西。
    pub roots: Vec<kb_core::share::ResourceKey>,
    /// 访问者是游客。游客在白名单里还要再受限(不能建文档、不能删、不能看版本历史)。
    pub guest: bool,
}

/// 对「别人分享给我的内容」的调用,放行后的结果:改走所有者的知识库,
/// 并且(列表类能力)结果还要按行过滤掉调用者看不到的部分。
pub struct SharedAccess {
    /// 所有者的知识库(审计、批次也记在那里,操作者仍是调用者本人)。
    pub resolved: ResolvedSpace,
    /// 对结果的后处理。`None` = 不需要。
    pub filter: Option<ResponseFilter>,
}

/// 结果过滤器:拿到能力的原始输出,返回调用者有权看到的部分。
pub type ResponseFilter = Arc<
    dyn Fn(Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>>
        + Send
        + Sync,
>;

/// 分享闸门(`kb-cli` 实现):判断调用者能不能在**别人的**知识库里调这个能力。
///
/// 调用者在请求里点名别人的知识库(`X-KB-Space`)时,Invoker 不走 [`SpaceResolver`],
/// 而是问它:这个能力在分享场景下允不允许?参数指向的资源上,调用者的角色够不够?
/// 不允许 / 没权限一律返回错误(没权限是 `NotFound`,不暴露对方有没有这个东西)。
#[async_trait]
pub trait ShareGate: Send + Sync {
    /// 授权并选好知识库。
    async fn authorize(
        &self,
        principal: &Principal,
        capability: &str,
        args: &Value,
        space_id: &str,
        link: Option<&LinkGrant>,
    ) -> Result<SharedAccess>;
}

/// 管理员只读查看闸门(`kb-cli` 实现):把 `X-KB-Admin-View` 指向的用户换成一个知识库句柄。
///
/// 与 [`ShareGate`] 不同:这里**不逐项判断资源授权**(管理员能看整库),但只开放只读白名单,
/// 且调用者必须另有 `sys.inspect`、目标用户必须存在并已建库。
#[async_trait]
pub trait AdminViewGate: Send + Sync {
    /// 授权并选好目标用户的知识库。
    async fn authorize(
        &self,
        principal: &Principal,
        capability: &str,
        target_user: &str,
    ) -> Result<ResolvedSpace>;
}

/// 一次调用被路由到哪里。
#[derive(Clone)]
pub enum CallScope {
    /// 在某个知识库里;句柄是 [`ResolvedSpace::handle`]。
    Space {
        /// 知识库 id。
        space_id: String,
        /// 运行时句柄(后端自己 downcast)。
        handle: Arc<dyn Any + Send + Sync>,
        /// 这次调用是不是通过分享链接进来的。链接访问者只能看到只读菜单,
        /// 后端要靠它把删除 / 移动标成不可用。
        via_link: bool,
    },
    /// 系统级 / 账号级 / 旧的单库模式:用共享的(主)运行时。
    Shared,
}

tokio::task_local! {
    /// 当前这次能力调用的路由。只在 [`Invoker::call`] 里设置,调用结束自动消失。
    pub static CALL_SCOPE: CallScope;
}

tokio::task_local! {
    /// 当前这次能力调用的调用者。让处理函数里派生出的子系统(AI 管家回调能力、ACP 伴生令牌)
    /// 能以**同一个用户**的身份继续,而不是退回本机超级用户。
    pub static CALL_PRINCIPAL: Principal;
}

/// 取当前调用的路由。不在任何能力调用里(守护进程自己的后台任务)返回 `None`。
pub fn current_call_scope() -> Option<CallScope> {
    CALL_SCOPE.try_with(Clone::clone).ok()
}

/// 取当前能力调用的调用者。不在能力调用里,或调用本身没有身份,返回 `None`。
pub fn current_principal() -> Option<Principal> {
    CALL_PRINCIPAL.try_with(Clone::clone).ok()
}

/// 一次调用的上下文。
#[derive(Clone, Debug)]
pub struct CallCtx {
    /// 操作者(`user` / `mcp:<client>` / `agent` / `system`)。
    pub actor: String,
    /// 来自哪个可见面。
    pub surface: Surface,
    /// 调用方的工作目录(UDS / MCP 会带 `X-KB-Cwd`)。
    pub cwd: Option<String>,
    /// 客户端名(如 `kiro`)。
    pub client: Option<String>,
    /// 请求头 `X-KB-Project` 指定的项目(设计规范的作用域解析用,不写进程环境变量)。
    pub project: Option<String>,
    /// 是否只演练。
    pub dry_run: bool,
    /// 本次调用所属批次(包装层填写)。
    pub batch_id: Option<String>,
    /// 调用者身份。`None` 只出现在不做访问控制的旧调用方 / 测试里;
    /// 守护进程的 Invoker 是 `enforcing` 的,没有身份一律 401。
    pub principal: Option<Principal>,
    /// 请求头 `X-KB-Space`:点名**别人的**知识库(浏览别人分享给我的内容)。
    /// 不写 = 自己的知识库。是否允许由 [`ShareGate`] 判断,这里只是转交。
    pub space_override: Option<String>,
    /// 请求头 `X-KB-Admin-View`:管理员只读查看**别人**的知识库时点名目标用户(`usr_…`)。
    /// 与 `space_override` 互斥;是否允许由 [`AdminViewGate`] 判断(白名单 + 永远只读)。
    pub admin_view: Option<String>,
    /// 通过分享链接访问时的链接权限。只有公开分享接口会设置它;设置了就走分享闸门的「链接」分支。
    pub link: Option<LinkGrant>,
}

impl CallCtx {
    /// 最简上下文。
    pub fn new(actor: impl Into<String>, surface: Surface) -> Self {
        Self {
            actor: actor.into(),
            surface,
            cwd: None,
            client: None,
            project: None,
            dry_run: false,
            batch_id: None,
            principal: None,
            space_override: None,
            admin_view: None,
            link: None,
        }
    }

    /// 带上链接权限(同时点名链接所在的知识库)。
    pub fn with_link(mut self, grant: LinkGrant) -> Self {
        self.space_override = Some(grant.space_id.clone());
        self.link = Some(grant);
        self
    }

    /// 点名别人的知识库。
    pub fn with_space_override(mut self, space_id: impl Into<String>) -> Self {
        self.space_override = Some(space_id.into());
        self
    }

    /// 管理员只读查看别人的知识库:点名目标用户 id。
    pub fn with_admin_view(mut self, user_id: impl Into<String>) -> Self {
        self.admin_view = Some(user_id.into());
        self
    }

    /// 带上调用者身份。
    pub fn with_principal(mut self, principal: Principal) -> Self {
        self.principal = Some(principal);
        self
    }

    /// 设置工作目录。
    pub fn with_cwd(mut self, cwd: impl Into<String>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    /// 设置项目。
    pub fn with_project(mut self, project: impl Into<String>) -> Self {
        self.project = Some(project.into());
        self
    }

    /// 设置 dry_run。
    pub fn with_dry_run(mut self, dry_run: bool) -> Self {
        self.dry_run = dry_run;
        self
    }
}

/// 响应的 meta 段（设计规范）。
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct ResponseMeta {
    /// 耗时(毫秒)。
    pub took_ms: u64,
    /// 是否 dry_run。
    pub dry_run: bool,
    /// W/G 级调用的批次 id。
    pub batch_id: Option<String>,
    /// 降级原因。
    pub degraded: Option<String>,
    /// 警告。
    pub warnings: Vec<String>,
}

/// 一次成功调用的结果。
#[derive(Clone, Debug)]
pub struct Response {
    /// 能力自己的输出。
    pub data: Value,
    /// 元信息。
    pub meta: ResponseMeta,
}

/// 一次调用的路由结果:用哪个审计库、任务局部路由是什么。
struct Route {
    /// 审计 / 批次库;`None` = 不属于任何知识库(系统级 / 账号级),审计走 `SpaceResolver::audit_shared`。
    audit: Option<Arc<dyn AuditRepo>>,
    scope: CallScope,
    /// 对结果的过滤(只有分享场景的列表类能力会有)。
    filter: Option<ResponseFilter>,
}

/// 能力调用器:注册表 + 访问控制 + 审计。
pub struct Invoker {
    registry: Arc<Registry>,
    audit: Arc<dyn AuditRepo>,
    resolver: Option<Arc<dyn SpaceResolver>>,
    share_gate: Option<Arc<dyn ShareGate>>,
    admin_view_gate: Option<Arc<dyn AdminViewGate>>,
    enforce: bool,
}

impl Invoker {
    /// 构造。默认不做访问控制(单库、测试用);守护进程要再调 [`Self::enforcing`] 和 [`Self::with_resolver`]。
    pub fn new(registry: Arc<Registry>, audit: Arc<dyn AuditRepo>) -> Self {
        Self {
            registry,
            audit,
            resolver: None,
            share_gate: None,
            admin_view_gate: None,
            enforce: false,
        }
    }

    /// 接上管理员只读查看闸门:带 `X-KB-Admin-View` 的调用交给它判断。没接就一律拒绝(fail closed)。
    pub fn with_admin_view_gate(mut self, gate: Arc<dyn AdminViewGate>) -> Self {
        self.admin_view_gate = Some(gate);
        self
    }

    /// 接上分享闸门:调用者点名别人的知识库时交给它判断。没接就一律拒绝(fail closed)。
    pub fn with_share_gate(mut self, gate: Arc<dyn ShareGate>) -> Self {
        self.share_gate = Some(gate);
        self
    }

    /// 接上知识库解析器:「知识库内」的调用会被路由到调用者自己的知识库。
    pub fn with_resolver(mut self, resolver: Arc<dyn SpaceResolver>) -> Self {
        self.resolver = Some(resolver);
        self
    }

    /// 打开强制模式:没有身份的调用一律 `Unauthorized`(fail closed)。
    pub fn enforcing(mut self) -> Self {
        self.enforce = true;
        self
    }

    /// 访问控制:身份 → 功能点 → 范围,并算出这次调用的路由。
    async fn authorize(
        &self,
        access: Access,
        ctx: &CallCtx,
        name: &str,
        args: &Value,
    ) -> Result<Route> {
        let legacy = || Route {
            audit: Some(self.audit.clone()),
            scope: CallScope::Shared,
            filter: None,
        };
        let Some(principal) = &ctx.principal else {
            if self.enforce {
                return Err(KbError::Unauthorized);
            }
            return Ok(legacy());
        };
        if !principal.features.allows(access.feature) {
            // 区分「AI 总开关关了」和「你没有这个功能」,界面提示不同
            let message = if features::is_ai(access.feature)
                && principal.features.blocked_by_ai_switch(access.feature)
            {
                "AI 功能已关闭"
            } else {
                "你的账号没有开通这个功能"
            };
            return Err(KbError::Forbidden(message.to_owned()));
        }
        // 管理员只读查看:先于普通功能点检查(管理角色不一定带着每一项读权限),
        // 由闸门自己确认 `sys.inspect` 和白名单;永远路由到目标用户的知识库。
        if let Some(target) = ctx.admin_view.as_deref() {
            let Some(gate) = &self.admin_view_gate else {
                return Err(KbError::Forbidden("没有开启管理员查看".to_owned()));
            };
            if ctx.space_override.is_some() {
                return Err(KbError::InvalidInput(
                    "X-KB-Admin-View 和 X-KB-Space 不能同时使用".to_owned(),
                ));
            }
            let resolved = gate.authorize(principal, name, target).await?;
            return Ok(Route {
                audit: Some(resolved.audit),
                scope: CallScope::Space {
                    space_id: resolved.space_id,
                    handle: resolved.handle,
                    via_link: false,
                },
                filter: None,
            });
        }
        match access.scope {
            Scope::Public | Scope::Account | Scope::System => Ok(Route {
                audit: None,
                scope: CallScope::Shared,
                filter: None,
            }),
            Scope::Space => {
                let Some(resolver) = &self.resolver else {
                    return Ok(legacy());
                };
                // 点名了别人的知识库:不走自己的解析器,交给分享闸门逐项判断
                if let Some(wanted) = ctx.space_override.as_deref()
                    && principal.space_id.as_deref() != Some(wanted)
                {
                    if principal.local {
                        return Err(KbError::Forbidden(
                            "本机超级用户没有「别人分享给我」的内容".to_owned(),
                        ));
                    }
                    let Some(gate) = &self.share_gate else {
                        return Err(KbError::Forbidden("没有开启文档分享".to_owned()));
                    };
                    let shared = gate
                        .authorize(principal, name, args, wanted, ctx.link.as_ref())
                        .await?;
                    return Ok(Route {
                        audit: Some(shared.resolved.audit),
                        scope: CallScope::Space {
                            space_id: shared.resolved.space_id,
                            handle: shared.resolved.handle,
                            via_link: ctx.link.is_some(),
                        },
                        filter: shared.filter,
                    });
                }
                let resolved = resolver.resolve(principal).await?;
                Ok(Route {
                    audit: Some(resolved.audit),
                    scope: CallScope::Space {
                        space_id: resolved.space_id,
                        handle: resolved.handle,
                        via_link: false,
                    },
                    filter: None,
                })
            }
        }
    }

    /// 注册表。
    pub fn registry(&self) -> &Registry {
        &self.registry
    }

    /// 调用一个能力。
    pub async fn call(&self, name: &str, ctx: CallCtx, args: Value) -> Result<Response> {
        let started = std::time::Instant::now();
        let capability = self
            .registry
            .get(name)
            .ok_or_else(|| KbError::NotFound(format!("capability {name}")))?;
        if !capability.visible_on(ctx.surface) {
            self.record(
                name,
                &ctx,
                &args,
                None,
                Outcome::fail(&started, "能力不在该可见面内"),
            )
            .await;
            return Err(KbError::Forbidden(format!(
                "能力 {name} 不在 {} 可见面内",
                ctx.surface.as_str()
            )));
        }

        let access = self.registry.access(name).ok_or_else(|| {
            KbError::Internal(format!("能力 {name} 没有访问分类(注册表应已拒绝)"))
        })?;
        let route = match self.authorize(access, &ctx, name, &args).await {
            Ok(route) => route,
            Err(error) => {
                self.record(
                    name,
                    &ctx,
                    &args,
                    None,
                    Outcome::fail(&started, error.to_string()),
                )
                .await;
                return Err(error);
            }
        };

        // dry_run:变更能力不执行 handler,只返回计划（设计规范）
        if ctx.dry_run && capability.permission.is_mutating() {
            let plan = serde_json::json!({
                "plan": {
                    "actions": [{
                        "op": capability.name,
                        "target": target_of(&args),
                    }]
                },
                "affected": 0,
                "estimate": { "seconds": 0, "llm_tokens": 0 },
            });
            self.record(
                name,
                &ctx,
                &args,
                route.audit.as_ref(),
                Outcome::dry_run(&started),
            )
            .await;
            return Ok(Response {
                data: plan,
                meta: ResponseMeta {
                    took_ms: started.elapsed().as_millis() as u64,
                    dry_run: true,
                    batch_id: None,
                    degraded: None,
                    warnings: Vec::new(),
                },
            });
        }

        // W/G/A 级调用开一个 batch,便于整体撤销
        let mut ctx = ctx;
        // 管理级能力(改配置、令牌)必须显式确认:请求体带 `confirm: true`（设计规范）
        if capability.permission == Permission::Admin && !is_confirmed(&args) {
            self.record(
                name,
                &ctx,
                &args,
                route.audit.as_ref(),
                Outcome::fail(&started, "缺少 confirm"),
            )
            .await;
            return Err(KbError::InvalidInput(format!(
                "{name} 是管理级能力,请求体必须带 confirm: true"
            )));
        }
        let mut batch_id = None;
        // 批次(可撤销)属于知识库;系统级 / 账号级调用没有批次,只留系统审计
        let batch_repo = route.audit.clone();
        if capability.permission.is_mutating()
            && !ctx.dry_run
            && let Some(repo) = &batch_repo
        {
            let id = repo
                .begin_batch(&actor_of(&ctx), &format!("{name} 调用"))
                .await?;
            batch_id = Some(id.clone());
            ctx.batch_id = Some(id);
        }

        // 处理函数在任务局部路由里跑:后端据此取到「这个用户的」知识库,而不是某个全局单例
        let routed = CALL_SCOPE.scope(
            route.scope.clone(),
            (capability.handler)(ctx.clone(), args.clone()),
        );
        let result = match &ctx.principal {
            Some(principal) => CALL_PRINCIPAL.scope(principal.clone(), routed).await,
            None => routed.await,
        };
        let failure = result.as_ref().err().map(|err| err.to_string());
        self.record(
            name,
            &ctx,
            &args,
            route.audit.as_ref(),
            Outcome::done(&started, result.as_ref()),
        )
        .await;
        if let (Some(id), Some(error), Some(repo)) = (&batch_id, failure.as_deref(), &batch_repo) {
            // 失败也要在批次里留痕,避免出现“空批次”。
            // 约定:`target == "failed"` 的 change 是审计占位,**不可回滚**,
            // AI 的 `revert_batch` 必须跳过它(见下文)。
            let change = Change {
                batch_id: id.clone(),
                seq: 1,
                target: "failed".to_owned(),
                before_json: None,
                after_json: serde_json::json!({ "error": error }).to_string(),
            };
            if let Err(err) = repo.record_change(id, change).await {
                tracing::warn!(error = %err, batch = %id, "记录失败批次变更失败");
            }
        }

        let data = result?;
        // 分享场景的列表类结果:只留下调用者有权看到的行
        let data = match &route.filter {
            Some(filter) => filter(data).await?,
            None => data,
        };
        // W/G 级调用把这次变更记进批次(供 revert_batch)
        if let (Some(id), Some(repo)) = (&batch_id, &batch_repo) {
            let change = Change {
                batch_id: id.clone(),
                seq: 1,
                target: target_of(&data),
                before_json: None,
                after_json: data.to_string(),
            };
            if let Err(err) = repo.record_change(id, change).await {
                tracing::warn!(error = %err, capability = name, "记录批次变更失败");
            }
        }
        // 后端把降级原因放在 data.degraded;设计规范要求它在 meta 里
        let degraded = data
            .get("degraded")
            .and_then(Value::as_str)
            .map(str::to_owned);
        Ok(Response {
            data,
            meta: ResponseMeta {
                took_ms: started.elapsed().as_millis() as u64,
                dry_run: ctx.dry_run,
                batch_id,
                degraded,
                warnings: Vec::new(),
            },
        })
    }

    /// 写一条审计(参数脱敏)。`repo` 为 `None` 时写系统审计(没有解析器就退回默认库)。
    async fn record(
        &self,
        name: &str,
        ctx: &CallCtx,
        args: &Value,
        repo: Option<&Arc<dyn AuditRepo>>,
        outcome: Outcome,
    ) {
        let entry = AuditEntry {
            id: None,
            at: now_millis(),
            actor: actor_of(ctx),
            capability: name.to_owned(),
            args_json: audit_args(ctx, args),
            ok: outcome.ok,
            error: outcome.error,
            batch_id: ctx.batch_id.clone(),
            dry_run: ctx.dry_run,
            took_ms: Some(outcome.took_ms),
            degraded: outcome.degraded,
        };
        if ctx.admin_view.is_some() {
            // 管理员查看别人的知识库:审计一律落 system.db(带 admin_view),不写进目标用户的库
            if let Some(resolver) = &self.resolver {
                resolver.audit_shared(entry).await;
                return;
            }
        }
        if let Some(repo) = repo {
            if let Err(err) = repo.record(entry).await {
                tracing::warn!(error = %err, capability = name, "写审计失败");
            }
        } else if let Some(resolver) = &self.resolver {
            resolver.audit_shared(entry).await;
        } else if let Err(err) = self.audit.record(entry).await {
            tracing::warn!(error = %err, capability = name, "写审计失败");
        }
    }
}

/// 一次调用的结局:成没成、为什么、花了多久、有没有降级。
///
/// 这四列总是一起落库,分开传的结果是早退路径漏写耗时(或者干脆漏写整条审计)。
struct Outcome {
    ok: bool,
    error: Option<String>,
    took_ms: u64,
    degraded: Option<String>,
}

impl Outcome {
    /// 早退:还没进 handler 就被挡住(不可见 / 无权限 / 缺 confirm)。
    fn fail(started: &std::time::Instant, reason: impl Into<String>) -> Self {
        Self {
            ok: false,
            error: Some(reason.into()),
            took_ms: elapsed_ms(started),
            degraded: None,
        }
    }

    /// dry_run:变更能力只回计划,没有降级可言。
    fn dry_run(started: &std::time::Instant) -> Self {
        Self {
            ok: true,
            error: None,
            took_ms: elapsed_ms(started),
            degraded: None,
        }
    }

    /// 正常返回(成功或 handler 报错)。降级原因在 `data.degraded`,
    /// 审计留一份,线上才能统计「降级率」而不是只能猜(迁移 0020)。
    fn done(started: &std::time::Instant, result: std::result::Result<&Value, &KbError>) -> Self {
        Self {
            ok: result.is_ok(),
            error: result.err().map(|err| err.to_string()),
            took_ms: elapsed_ms(started),
            degraded: result
                .ok()
                .and_then(|data| data.get("degraded"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }
}

/// 经过了多少毫秒(审计里的 `took_ms`)。
fn elapsed_ms(started: &std::time::Instant) -> u64 {
    started.elapsed().as_millis() as u64
}

/// 请求体里的 `confirm` 是否为真(管理级能力的显式确认)。
fn is_confirmed(args: &Value) -> bool {
    match args.get("confirm") {
        Some(Value::Bool(value)) => *value,
        Some(Value::String(value)) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes"
        ),
        _ => false,
    }
}

/// 审计里的参数:先做敏感信息脱敏,管理员查看再补一个目标用户 id。
/// 这样即使能力自己的参数里没有用户,审计里也能一眼看出「这次看的是谁」。
fn audit_args(ctx: &CallCtx, args: &Value) -> String {
    let redacted = redact(&args.to_string());
    let Some(target) = ctx.admin_view.as_deref() else {
        return redacted;
    };
    match serde_json::from_str::<Value>(&redacted) {
        Ok(Value::Object(mut map)) => {
            map.insert("admin_view".to_owned(), Value::String(target.to_owned()));
            Value::Object(map).to_string()
        }
        _ => serde_json::json!({ "args": redacted, "admin_view": target }).to_string(),
    }
}

/// 审计里的操作者:`mcp:<client>` / 原样的 actor。
fn actor_of(ctx: &CallCtx) -> String {
    // 多用户:审计里的操作者是用户 id,而不是笼统的 "user"
    if let Some(principal) = &ctx.principal
        && !principal.local
    {
        // 通过分享链接的操作写明经过哪个链接,所有者在审计 / 版本历史里一眼看得出、也能回退
        return match &ctx.link {
            Some(link) => format!("{}(经链接 {})", principal.user_id, link.link_id),
            None => principal.user_id.clone(),
        };
    }
    match (&ctx.client, ctx.actor.as_str()) {
        (Some(client), "local") | (Some(client), "user") => format!("mcp:{client}"),
        (_, actor) => actor.to_owned(),
    }
}

fn target_of(data: &Value) -> String {
    for key in ["id", "job_id", "project", "path", "collection"] {
        if let Some(value) = data.get(key).and_then(Value::as_str) {
            return value.to_owned();
        }
    }
    "*".to_owned()
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 权限与可见面的组合校验(给 的 HTTP 中间件复用)。
pub fn check_permission(permission: Permission, max: Permission) -> Result<()> {
    if permission > max {
        return Err(KbError::Forbidden(format!(
            "需要 {} 级权限,当前最多允许 {}",
            permission.as_str(),
            max.as_str()
        )));
    }
    Ok(())
}
