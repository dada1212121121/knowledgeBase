//! 文档分享的能力(多用户设计说明):协作者、批量分享、停止继承、共享给我 / 我的分享。
//!
//! 方法在 [`AdminBackend`](crate::AdminBackend) 上,这里放参数和注册。全是账号级能力:
//! 「谁在操作」取自会话,资源用结构化的 [`ShareTarget`] 指定,权限检查在后端逐项做。

use std::sync::Arc;

use kb_core::share::ShareTarget;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::admin::AdminBackend;
use crate::invoke::CallCtx;
use crate::registry::{Capability, Permission, Registry, Surface};
use crate::typed::{schema, typed};

/// 只带一个资源的参数(`grant_list` / `effective_role`)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct TargetArgs {
    /// 哪个资源。
    pub target: ShareTarget,
}

/// `grant_set` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct GrantSetArgs {
    /// 哪个资源。
    pub target: ShareTarget,
    /// 给谁。
    pub user_id: String,
    /// `viewer` / `commenter` / `editor` / `manager`。最多授予与自己相同的角色。
    pub role: String,
    /// 几天后失效;不写 = 长期。
    #[serde(default)]
    pub expires_days: Option<u32>,
}

/// `grant_remove` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct GrantRemoveArgs {
    /// 哪个资源。
    pub target: ShareTarget,
    /// 移除谁。
    pub user_id: String,
}

/// 批量变更里的一个人。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct GrantPerson {
    /// 用户 id。
    pub user_id: String,
    /// 角色;不写或 `null` = 移除这个人在这些资源上的授权。
    #[serde(default)]
    pub role: Option<String>,
}

/// `grant_batch` 的参数:对多个资源一次加 / 改 / 删协作者。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct GrantBatchArgs {
    /// 选中的资源(目录和文件可以混选,最多 500 项)。
    pub targets: Vec<ShareTarget>,
    /// 要变更的人(最多 50 个)。
    pub people: Vec<GrantPerson>,
    /// 几天后失效;不写 = 长期(只对新增 / 改角色的人起作用)。
    #[serde(default)]
    pub expires_days: Option<u32>,
}

/// `set_inherit` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SetInheritArgs {
    /// 哪个文件夹 / 文档。
    pub target: ShareTarget,
    /// `true` = 继承上级协作者(默认);`false` = 不继承,只认这一层自己的授权。
    pub inherit: bool,
}

/// `shared_with_me` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct SharedWithMeArgs {
    /// 连同被我移出列表的一起返回。
    #[serde(default)]
    pub include_hidden: bool,
}

/// `hide_share` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct HideShareArgs {
    /// 要移出 / 放回的共享。
    pub target: ShareTarget,
    /// `true` = 从「共享给我」里移出(只是不显示,权限不变);`false` = 放回。
    pub hidden: bool,
}

/// `search_shared` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct SearchSharedArgs {
    /// 检索词(支持和普通检索一样的 `kind:` 等前缀)。
    pub query: String,
    /// `shared`(默认)只搜共享给我的;`all` 连同我自己的知识库一起搜。
    #[serde(default)]
    pub scope: Option<String>,
    /// 只搜某一个人分享给我的(知识库 id)。
    #[serde(default)]
    pub space_id: Option<String>,
    /// 返回条数,默认 8,最多 50。
    #[serde(default)]
    pub k: Option<u32>,
}

/// `access_request` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AccessRequestArgs {
    /// 想要访问的资源。
    pub target: ShareTarget,
    /// 申请的角色:`viewer` / `commenter` / `editor`。
    pub role: String,
    /// 附言,最多 200 个字。
    #[serde(default)]
    pub message: Option<String>,
}

/// `access_decide` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AccessDecideArgs {
    /// 申请 id。
    pub id: String,
    /// `true` 通过,`false` 拒绝。
    pub approve: bool,
    /// 通过时改成别的角色(不写 = 按申请的)。
    #[serde(default)]
    pub role: Option<String>,
}

const WEB_ONLY: &[Surface] = &[Surface::Web];

fn add(
    registry: &mut Registry,
    name: &'static str,
    description: &'static str,
    permission: Permission,
    input_schema: Value,
    handler: crate::registry::Handler,
) {
    registry.register(Capability {
        name,
        description,
        permission,
        surfaces: WEB_ONLY,
        side_effect: permission.is_mutating(),
        input_schema,
        handler,
    });
}

/// 注册分享相关能力。
pub fn register_sharing(registry: &mut Registry, backend: Arc<dyn AdminBackend>) {
    macro_rules! with_args {
        ($name:literal, $desc:literal, $perm:expr, $args:ty, $method:ident) => {{
            let b = backend.clone();
            add(
                registry,
                $name,
                $desc,
                $perm,
                schema::<$args>(),
                typed(move |ctx: CallCtx, args: $args| {
                    let b = b.clone();
                    async move { b.$method(&ctx, args).await }
                }),
            );
        }};
    }
    macro_rules! no_args {
        ($name:literal, $desc:literal, $perm:expr, $method:ident) => {{
            let b = backend.clone();
            add(
                registry,
                $name,
                $desc,
                $perm,
                schema::<serde_json::Map<String, Value>>(),
                typed(move |ctx: CallCtx, _args: serde_json::Map<String, Value>| {
                    let b = b.clone();
                    async move { b.$method(&ctx).await }
                }),
            );
        }};
    }
    with_args!(
        "grant_list",
        "一个资源的协作者(含从上级继承来的、来自哪一层)和我的角色;需要「可管理」",
        Permission::Read,
        TargetArgs,
        grant_list
    );
    with_args!(
        "grant_set",
        "给某人授权(或改角色);最多授予与自己相同的角色,对方会收到通知",
        Permission::Write,
        GrantSetArgs,
        grant_set
    );
    with_args!(
        "grant_remove",
        "移除某人在这个资源上的授权;对方立即失去通过它得到的权限",
        Permission::Write,
        GrantRemoveArgs,
        grant_remove
    );
    with_args!(
        "grant_batch",
        "多选分享:对选中的多个目录 / 文件一次加、改、删协作者(整批原子)",
        Permission::Write,
        GrantBatchArgs,
        grant_batch
    );
    with_args!(
        "set_inherit",
        "设置文件夹 / 文档是否继承上级的协作者",
        Permission::Write,
        SetInheritArgs,
        set_inherit
    );
    with_args!(
        "effective_role",
        "我对一个资源的有效角色和能做的动作(前端据此决定显示哪些按钮)",
        Permission::Read,
        TargetArgs,
        effective_role
    );
    with_args!(
        "shared_with_me",
        "共享给我的目录和文件(按所有者列出)",
        Permission::Read,
        SharedWithMeArgs,
        shared_with_me
    );
    no_args!(
        "shared_by_me",
        "我分享出去的资源和协作者",
        Permission::Read,
        shared_by_me
    );
    with_args!(
        "search_shared",
        "在共享给我的内容里检索(可连同我自己的一起),按知识库分别检索再用 RRF 合并;只会命中我有权看的",
        Permission::Read,
        SearchSharedArgs,
        search_shared
    );
    with_args!(
        "access_request",
        "向所有者 / 可管理的人申请某个内容的访问权限(同一资源 24 小时内只能申请一次)",
        Permission::Write,
        AccessRequestArgs,
        access_request
    );
    no_args!(
        "access_requests",
        "等我处理的访问申请(我是所有者或可管理的资源)和我自己发出的申请",
        Permission::Read,
        access_requests
    );
    with_args!(
        "access_decide",
        "通过或拒绝一条访问申请(通过时可以改成别的角色);申请人会收到通知",
        Permission::Write,
        AccessDecideArgs,
        access_decide
    );
    with_args!(
        "hide_share",
        "把一条共享从「共享给我」里移出或放回(只影响显示)",
        Permission::Write,
        HideShareArgs,
        hide_share
    );
}
