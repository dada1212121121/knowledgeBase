//! 分享链接管理的能力(多用户设计说明):创建、查看、修改、重置、撤销、统计;管理员治理。
//!
//! 方法在 [`AdminBackend`](crate::AdminBackend) 上,这里放参数和注册。公开访问(`/s/:token`、游客)
//! 不走能力层,见 `kb-web` 的 `share_public`。

use std::sync::Arc;

use kb_core::share::ShareTarget;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::admin::AdminBackend;
use crate::invoke::CallCtx;
use crate::registry::{Capability, Permission, Registry, Surface};
use crate::typed::{schema, typed};

/// `link_create` 的参数。`target` 和 `targets` 二选一:前者是单个资源的链接,后者是合集链接。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct LinkCreateArgs {
    /// 单个资源。
    #[serde(default)]
    pub target: Option<ShareTarget>,
    /// 合集链接的内容(多选的目录和文件,最多 500 项)。
    #[serde(default)]
    pub targets: Vec<ShareTarget>,
    /// 合集链接的名字。
    #[serde(default)]
    pub title: Option<String>,
    /// `collaborators`(仅协作者)/ `logged_in`(登录用户)/ `anyone`(含游客)。
    pub audience: String,
    /// `viewer` / `commenter` / `editor`。
    pub role: String,
    /// 访问密码,4–12 位。
    #[serde(default)]
    pub password: Option<String>,
    /// 几天后失效;不写 = 永久。
    #[serde(default)]
    pub expires_days: Option<u32>,
    /// 允许下载 / 复制 / 打印,默认是。
    #[serde(default)]
    pub allow_download: Option<bool>,
    /// 显示水印。
    #[serde(default)]
    pub watermark: Option<bool>,
    /// 编辑者可再分享。
    #[serde(default)]
    pub allow_reshare: Option<bool>,
}

/// 只带一个链接 id 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct LinkIdArgs {
    /// 链接 id。
    pub id: String,
}

/// `link_update` 的参数;不写的项不动。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct LinkUpdateArgs {
    /// 链接 id。
    pub id: String,
    /// 访问范围。
    #[serde(default)]
    pub audience: Option<String>,
    /// 角色。
    #[serde(default)]
    pub role: Option<String>,
    /// 设置新的访问密码(4–12 位)。
    #[serde(default)]
    pub password: Option<String>,
    /// 去掉访问密码。
    #[serde(default)]
    pub clear_password: bool,
    /// 从现在起几天后失效。
    #[serde(default)]
    pub expires_days: Option<u32>,
    /// 改成永久有效。
    #[serde(default)]
    pub clear_expiry: bool,
    /// 允许下载。
    #[serde(default)]
    pub allow_download: Option<bool>,
    /// 水印。
    #[serde(default)]
    pub watermark: Option<bool>,
    /// 编辑者可再分享。
    #[serde(default)]
    pub allow_reshare: Option<bool>,
    /// 开 / 关(关了可以再打开)。
    #[serde(default)]
    pub enabled: Option<bool>,
    /// 合集链接的名字。
    #[serde(default)]
    pub title: Option<String>,
}

/// `link_get` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct LinkGetArgs {
    /// 哪个资源。
    pub target: ShareTarget,
}

/// `share_admin_list` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct ShareAdminListArgs {
    /// 页码,从 1 开始。
    #[serde(default)]
    pub page: Option<u32>,
    /// 每页条数(最多 100)。
    #[serde(default)]
    pub page_size: Option<u32>,
}

/// `guest_purge` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct GuestPurgeArgs {
    /// 要清除的访客标识:批注作者里的 `guest:昵称#编号`。必须以 `guest:` 开头。
    pub author: String,
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

/// 注册分享链接管理能力。
pub fn register_links(registry: &mut Registry, backend: Arc<dyn AdminBackend>) {
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
    with_args!(
        "link_create",
        "创建分享链接(单个资源或多选合集);链接地址只在这一次返回,之后只能重置换新地址",
        Permission::Write,
        LinkCreateArgs,
        link_create
    );
    with_args!(
        "link_get",
        "一个资源上的分享链接和设置(不含地址)",
        Permission::Read,
        LinkGetArgs,
        link_get
    );
    with_args!(
        "link_update",
        "修改链接的访问范围、角色、密码、有效期、下载 / 水印 / 再分享、开关",
        Permission::Write,
        LinkUpdateArgs,
        link_update
    );
    with_args!(
        "link_reset",
        "重置链接:换一个新地址,旧地址立刻作废(设置保留);新地址只在这一次返回",
        Permission::Write,
        LinkIdArgs,
        link_reset
    );
    with_args!(
        "link_revoke",
        "撤销链接(不可恢复);已通过链接加入的协作者不受影响",
        Permission::Write,
        LinkIdArgs,
        link_revoke
    );
    with_args!(
        "link_stats",
        "链接的打开次数、最近访问和登录访问者名单",
        Permission::Read,
        LinkIdArgs,
        link_stats
    );
    with_args!(
        "guest_purge",
        "清除某个访客留下的所有评论(从我的知识库里删掉,包括检索里的副本)",
        Permission::Write,
        GuestPurgeArgs,
        guest_purge
    );
    let b = backend.clone();
    add(
        registry,
        "my_links",
        "我创建的全部分享链接(含状态、访问量)",
        Permission::Read,
        schema::<serde_json::Map<String, Value>>(),
        typed(move |ctx: CallCtx, _args: serde_json::Map<String, Value>| {
            let b = b.clone();
            async move { b.my_links(&ctx).await }
        }),
    );
    with_args!(
        "share_admin_list",
        "全站分享链接(管理员治理):创建人、所有者、类型、访问量、状态;不显示资源内容",
        Permission::Read,
        ShareAdminListArgs,
        share_admin_list
    );
    with_args!(
        "share_admin_revoke",
        "管理员撤销任何一条分享链接(处理滥用投诉);写系统审计",
        Permission::Write,
        LinkIdArgs,
        share_admin_revoke
    );
}
