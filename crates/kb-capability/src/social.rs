//! 好友与通知的能力(多用户设计说明)。
//!
//! 方法在 [`AdminBackend`](crate::AdminBackend) 上(同一个后端实现,默认「不可用」),这里放参数和注册。
//! 全是账号级能力:只作用于**调用者自己**,身份取自会话,参数里没有「替谁操作」。

use std::collections::HashMap;
use std::sync::Arc;

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::admin::AdminBackend;
use crate::invoke::CallCtx;
use crate::registry::{Capability, Permission, Registry, Surface};
use crate::typed::{schema, typed};

/// `friend_search` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FriendSearchArgs {
    /// 对方**完整**的用户名或邮箱(不支持模糊搜索)。
    pub query: String,
}

/// `friend_request` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FriendRequestArgs {
    /// 对方的用户 id(来自 `friend_search`)。
    pub user_id: String,
    /// 附言,最多 100 个字。
    #[serde(default)]
    pub message: Option<String>,
}

/// `friend_decide` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FriendDecideArgs {
    /// 申请 id。
    pub id: String,
    /// `accept` 通过 / `reject` 拒绝 / `ignore` 忽略。
    pub decision: String,
}

/// `friend_update` 的参数。字段不写 = 不改;写 `null` 或空串 = 清除。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct FriendUpdateArgs {
    /// 好友的用户 id。
    pub friend_id: String,
    /// 备注名,最多 30 个字。
    #[serde(default, deserialize_with = "maybe_null")]
    pub remark: Option<Option<String>>,
    /// 分组名,最多 20 个字。
    #[serde(default, deserialize_with = "maybe_null")]
    pub group_name: Option<Option<String>>,
}

/// 区分「字段没写」(外层 `None`)和「写了 null」(`Some(None)`)。
fn maybe_null<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::<String>::deserialize(deserializer)?))
}

/// 只带一个用户 id 的参数(`friend_remove` / `block` / `unblock`)。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct UserIdArgs {
    /// 对方的用户 id。
    pub user_id: String,
}

/// `set_privacy` 的参数;不写的项不改。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct PrivacyArgs {
    /// 允许别人用完整邮箱搜到我。
    #[serde(default)]
    pub searchable_by_email: Option<bool>,
    /// 允许别人用完整用户名搜到我。
    #[serde(default)]
    pub searchable_by_username: Option<bool>,
    /// 谁可以把文档分享给我:`everyone` / `friends`。
    #[serde(default)]
    pub share_from: Option<String>,
}

/// `notification_list` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct NotificationListArgs {
    /// 只看未读。
    #[serde(default)]
    pub unread_only: bool,
    /// 翻页游标:上一页最后一条的 id。
    #[serde(default)]
    pub before_id: Option<i64>,
    /// 条数,默认 30,最多 100。
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `notification_read` 的参数。`ids` 和 `all` 二选一。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct NotificationReadArgs {
    /// 要标为已读的通知 id。
    #[serde(default)]
    pub ids: Vec<i64>,
    /// 全部标为已读。
    #[serde(default)]
    pub all: bool,
}

/// `notification_prefs` 的参数:不带 `email` 就是读取,带了就是修改后返回。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct NotificationPrefsArgs {
    /// 每种通知要不要同时发邮件:`{"friend_request": true, ...}`。
    #[serde(default)]
    pub email: Option<HashMap<String, bool>>,
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

/// 注册好友与通知能力。
pub fn register_social(registry: &mut Registry, backend: Arc<dyn AdminBackend>) {
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
        "friend_search",
        "按完整的用户名或邮箱找人(不做模糊搜索);找不到、对方不允许被搜到、对方拉黑了我,结果完全一样",
        Permission::Read,
        FriendSearchArgs,
        friend_search
    );
    with_args!(
        "friend_request",
        "向某人发好友申请(可带附言);对方已向我申请过则直接成为好友",
        Permission::Write,
        FriendRequestArgs,
        friend_request
    );
    no_args!(
        "friend_requests",
        "收到的和发出的好友申请",
        Permission::Read,
        friend_requests
    );
    with_args!(
        "friend_decide",
        "处理收到的好友申请:通过 / 拒绝 / 忽略",
        Permission::Write,
        FriendDecideArgs,
        friend_decide
    );
    no_args!("friend_list", "好友列表", Permission::Read, friend_list);
    with_args!(
        "friend_update",
        "修改好友的备注名和分组(只改我这一边)",
        Permission::Write,
        FriendUpdateArgs,
        friend_update
    );
    with_args!(
        "friend_remove",
        "删除好友(已有的分享不动)",
        Permission::Write,
        UserIdArgs,
        friend_remove
    );
    with_args!(
        "block",
        "拉黑某人:解除好友、作废待处理的申请;对方不会收到通知",
        Permission::Write,
        UserIdArgs,
        block
    );
    with_args!(
        "unblock",
        "取消拉黑",
        Permission::Write,
        UserIdArgs,
        unblock
    );
    no_args!("block_list", "我拉黑的人", Permission::Read, block_list);
    no_args!("privacy_get", "我的隐私设置", Permission::Read, privacy_get);
    with_args!(
        "set_privacy",
        "修改隐私设置:能否被邮箱 / 用户名搜到、谁可以把文档分享给我",
        Permission::Write,
        PrivacyArgs,
        set_privacy
    );
    with_args!(
        "notification_list",
        "站内通知列表(新的在前,可只看未读),附带未读数",
        Permission::Read,
        NotificationListArgs,
        notification_list
    );
    with_args!(
        "notification_read",
        "把通知标为已读(指定 id 或全部)",
        Permission::Write,
        NotificationReadArgs,
        notification_read
    );
    with_args!(
        "notification_prefs",
        "读取或修改每种通知的邮件开关",
        Permission::Write,
        NotificationPrefsArgs,
        notification_prefs
    );
}
