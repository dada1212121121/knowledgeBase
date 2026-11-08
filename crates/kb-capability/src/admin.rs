//! 账号与角色管理能力(多用户设计说明):用户列表、角色与功能勾选、用户功能例外。
//!
//! 和 [`CapabilityBackend`](crate::CapabilityBackend) 分开:后者是 117 个业务能力的后端接口,
//! 加方法会让所有测试里的假后端一起改;账号管理只依赖账号库,单独一个小 trait,
//! 方法都有默认实现(返回「不可用」),不关心它的测试用一个空结构体就够。
//!
//! 能力本身全部归 `sys.users` 功能点把关(见 `access.rs`);只有 `feature_catalog` 是账号级、所有人可读,
//! 前端画权限页和判断入口要用。

use std::sync::Arc;

use async_trait::async_trait;
use kb_core::{KbError, Result};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

use crate::invoke::CallCtx;
pub use crate::links::{
    GuestPurgeArgs, LinkCreateArgs, LinkGetArgs, LinkIdArgs, LinkUpdateArgs, ShareAdminListArgs,
};
use crate::registry::{Capability, Permission, Registry, Surface};
pub use crate::sharing::{
    AccessDecideArgs, AccessRequestArgs, GrantBatchArgs, GrantPerson, GrantRemoveArgs,
    GrantSetArgs, HideShareArgs, SearchSharedArgs, SetInheritArgs, SharedWithMeArgs, TargetArgs,
};
pub use crate::social::{
    FriendDecideArgs, FriendRequestArgs, FriendSearchArgs, FriendUpdateArgs, NotificationListArgs,
    NotificationPrefsArgs, NotificationReadArgs, PrivacyArgs, UserIdArgs,
};
use crate::typed::{schema, typed};

fn unavailable() -> KbError {
    KbError::Unavailable("账号管理没有启用".to_owned())
}

/// 账号管理后端(由 `kb-cli` 在账号库上实现)。
#[async_trait]
pub trait AdminBackend: Send + Sync {
    /// 功能点目录。
    async fn feature_catalog(&self) -> Result<Value> {
        Err(unavailable())
    }
    // ---- 好友与通知(见 `social.rs`);都是账号级,身份取自 `ctx` ----
    /// 按完整用户名 / 邮箱找人。
    async fn friend_search(&self, _ctx: &CallCtx, _args: FriendSearchArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 发好友申请。
    async fn friend_request(&self, _ctx: &CallCtx, _args: FriendRequestArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 收到的和发出的申请。
    async fn friend_requests(&self, _ctx: &CallCtx) -> Result<Value> {
        Err(unavailable())
    }
    /// 处理申请。
    async fn friend_decide(&self, _ctx: &CallCtx, _args: FriendDecideArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 好友列表。
    async fn friend_list(&self, _ctx: &CallCtx) -> Result<Value> {
        Err(unavailable())
    }
    /// 改备注 / 分组。
    async fn friend_update(&self, _ctx: &CallCtx, _args: FriendUpdateArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 删除好友。
    async fn friend_remove(&self, _ctx: &CallCtx, _args: UserIdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 拉黑。
    async fn block(&self, _ctx: &CallCtx, _args: UserIdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 取消拉黑。
    async fn unblock(&self, _ctx: &CallCtx, _args: UserIdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 我拉黑的人。
    async fn block_list(&self, _ctx: &CallCtx) -> Result<Value> {
        Err(unavailable())
    }
    /// 读隐私设置。
    async fn privacy_get(&self, _ctx: &CallCtx) -> Result<Value> {
        Err(unavailable())
    }
    /// 改隐私设置。
    async fn set_privacy(&self, _ctx: &CallCtx, _args: PrivacyArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 站内通知列表。
    async fn notification_list(
        &self,
        _ctx: &CallCtx,
        _args: NotificationListArgs,
    ) -> Result<Value> {
        Err(unavailable())
    }
    /// 标已读。
    async fn notification_read(
        &self,
        _ctx: &CallCtx,
        _args: NotificationReadArgs,
    ) -> Result<Value> {
        Err(unavailable())
    }
    /// 通知邮件开关。
    async fn notification_prefs(
        &self,
        _ctx: &CallCtx,
        _args: NotificationPrefsArgs,
    ) -> Result<Value> {
        Err(unavailable())
    }
    // ---- 文档分享(见 `sharing.rs`) ----
    /// 一个资源的协作者。
    async fn grant_list(&self, _ctx: &CallCtx, _args: TargetArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 授权 / 改角色。
    async fn grant_set(&self, _ctx: &CallCtx, _args: GrantSetArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 移除授权。
    async fn grant_remove(&self, _ctx: &CallCtx, _args: GrantRemoveArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 多选批量分享。
    async fn grant_batch(&self, _ctx: &CallCtx, _args: GrantBatchArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 停止 / 恢复继承。
    async fn set_inherit(&self, _ctx: &CallCtx, _args: SetInheritArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 我对资源的有效角色。
    async fn effective_role(&self, _ctx: &CallCtx, _args: TargetArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 共享给我的。
    async fn shared_with_me(&self, _ctx: &CallCtx, _args: SharedWithMeArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 我分享出去的。
    async fn shared_by_me(&self, _ctx: &CallCtx) -> Result<Value> {
        Err(unavailable())
    }
    /// 申请访问。
    async fn access_request(&self, _ctx: &CallCtx, _args: AccessRequestArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 等我处理的申请 + 我发出的申请。
    async fn access_requests(&self, _ctx: &CallCtx) -> Result<Value> {
        Err(unavailable())
    }
    /// 处理申请。
    async fn access_decide(&self, _ctx: &CallCtx, _args: AccessDecideArgs) -> Result<Value> {
        Err(unavailable())
    }
    // ---- 分享链接(见 `links.rs`) ----
    /// 创建链接。
    async fn link_create(&self, _ctx: &CallCtx, _args: LinkCreateArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 一个资源上的链接。
    async fn link_get(&self, _ctx: &CallCtx, _args: LinkGetArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 改链接设置。
    async fn link_update(&self, _ctx: &CallCtx, _args: LinkUpdateArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 重置链接地址。
    async fn link_reset(&self, _ctx: &CallCtx, _args: LinkIdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 撤销链接。
    async fn link_revoke(&self, _ctx: &CallCtx, _args: LinkIdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 链接统计。
    async fn link_stats(&self, _ctx: &CallCtx, _args: LinkIdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 清除某个访客的所有评论。
    async fn guest_purge(&self, _ctx: &CallCtx, _args: GuestPurgeArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 我创建的链接。
    async fn my_links(&self, _ctx: &CallCtx) -> Result<Value> {
        Err(unavailable())
    }
    /// 全站链接(管理员)。
    async fn share_admin_list(&self, _ctx: &CallCtx, _args: ShareAdminListArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 管理员撤销链接。
    async fn share_admin_revoke(&self, _ctx: &CallCtx, _args: LinkIdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 在共享给我的内容里检索。
    async fn search_shared(&self, _ctx: &CallCtx, _args: SearchSharedArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 把一条共享移出 / 放回我的列表。
    async fn hide_share(&self, _ctx: &CallCtx, _args: HideShareArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 全站存储概览:磁盘剩余、各知识库占用排行(管理员)。
    async fn storage_overview(&self, _args: StorageOverviewArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 资源曲线:本机 CPU / 内存 / 负载 / 磁盘和本服务进程的占用随时间的变化(管理员,系统状态页的资源图)。
    async fn metrics_series(&self, _args: MetricsSeriesArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 最近若干天全站每天的 AI 用量(按用途分)(管理员,存储与用量页的趋势图)。
    async fn llm_usage_series(&self, _args: LlmUsageSeriesArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 某天的 AI 用量排行:每人用了多少 token、额度多少(管理员)。
    async fn llm_usage_overview(&self, _args: LlmUsageOverviewArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 我自己的用量:存储分项与配额、今天的 AI 额度(任何登录用户,只看得到自己)。
    async fn usage_mine(&self, _ctx: &CallCtx) -> Result<Value> {
        Err(unavailable())
    }
    /// 角色列表(含功能勾选与人数)。
    async fn role_list(&self) -> Result<Value> {
        Err(unavailable())
    }
    /// 新建角色。
    async fn role_create(&self, _ctx: &CallCtx, _args: RoleCreateArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 更新角色。
    async fn role_update(&self, _ctx: &CallCtx, _args: RoleUpdateArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 删除角色。
    async fn role_delete(&self, _ctx: &CallCtx, _args: IdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 用户列表。
    async fn user_list(&self, _args: UserListArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 一个用户的详情(含功能例外与最终生效的功能)。
    async fn user_get(&self, _args: IdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 管理员只读查看:校验目标用户与个人知识库并预热运行时,返回头部摘要(不含任何文件内容)。
    async fn admin_space_open(&self, _ctx: &CallCtx, _args: AdminViewArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 管理员代建账号。
    async fn user_create(&self, _ctx: &CallCtx, _args: UserCreateArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 改角色 / 状态 / 昵称 / 配额。
    async fn user_update(&self, _ctx: &CallCtx, _args: UserUpdateArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 重设密码。
    async fn user_set_password(&self, _ctx: &CallCtx, _args: UserPasswordArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 管理员替用户关掉两步验证(他丢了手机、恢复码也没了)。让他的所有登录失效,下次用密码登录。
    async fn user_totp_reset(&self, _ctx: &CallCtx, _args: UserIdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 设置 / 清除一个功能例外。
    async fn user_feature(&self, _ctx: &CallCtx, _args: UserFeatureArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 新建邀请码。明文只在这一次返回,库里只有哈希。
    async fn invite_create(&self, _ctx: &CallCtx, _args: InviteCreateArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 邀请码列表(只有前缀,没有明文)。
    async fn invite_list(&self, _ctx: &CallCtx) -> Result<Value> {
        Err(unavailable())
    }
    /// 撤销邀请码。
    async fn invite_revoke(&self, _ctx: &CallCtx, _args: IdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 一个邀请码的使用记录(谁在什么时候用它注册)。
    async fn invite_uses(&self, _ctx: &CallCtx, _args: IdArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 邮件设置的现状:开关、两个账号、授权码是否已设置(从不返回授权码本身)。
    async fn mail_status(&self) -> Result<Value> {
        Err(unavailable())
    }
    /// 写入 / 清除发件邮箱的授权码(只写不读)。
    async fn mail_password(&self, _ctx: &CallCtx, _args: MailPasswordArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 用指定的发件账号发一封测试邮件。
    async fn mail_test(&self, _ctx: &CallCtx, _args: MailTestArgs) -> Result<Value> {
        Err(unavailable())
    }
    /// 最近的发信记录。
    async fn mail_log(&self, _args: MailLogArgs) -> Result<Value> {
        Err(unavailable())
    }
}

/// 只带一个 id 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct IdArgs {
    /// 对象 id。
    pub id: String,
}

/// `admin_space_open` 的参数:要查看哪个用户。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct AdminViewArgs {
    /// 目标用户 id(`usr_…`)。
    pub user_id: String,
}

/// `role_create` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct RoleCreateArgs {
    /// 角色名(1–30 字,唯一)。
    pub name: String,
    /// 说明。
    #[serde(default)]
    pub description: String,
    /// 勾选的功能点 id。
    #[serde(default)]
    pub features: Vec<String>,
    /// 是否允许授予危险(系统级)功能。
    #[serde(default)]
    pub dangerous: bool,
}

/// `role_update` 的参数,没写的键不改。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct RoleUpdateArgs {
    /// 角色 id。
    pub id: String,
    /// 新名字。
    #[serde(default)]
    pub name: Option<String>,
    /// 新说明。
    #[serde(default)]
    pub description: Option<String>,
    /// 新的功能勾选(整体替换)。
    #[serde(default)]
    pub features: Option<Vec<String>>,
    /// 是否允许授予危险功能。
    #[serde(default)]
    pub dangerous: Option<bool>,
    /// 配额覆盖(JSON 对象,只写要覆盖的键)。
    #[serde(default)]
    pub quota: Option<Value>,
}

/// `storage_overview` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct StorageOverviewArgs {
    /// 排行最多列几个知识库(默认 20,最多 100)。
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `metrics_series` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct MetricsSeriesArgs {
    /// 时间范围:`1h`(每 10 秒一个点)/ `24h` / `7d` / `30d`,默认 `1h`。
    #[serde(default)]
    pub range: Option<String>,
}

/// `llm_usage_series` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct LlmUsageSeriesArgs {
    /// 最近多少天(默认 30,最多 90)。
    #[serde(default)]
    pub days: Option<u32>,
}

/// `llm_usage_overview` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct LlmUsageOverviewArgs {
    /// 哪一天(`YYYY-MM-DD`,站点时区);默认今天。
    #[serde(default)]
    pub day: Option<String>,
    /// 最多列几个人(默认 20,最多 100)。
    #[serde(default)]
    pub limit: Option<u32>,
}

/// `user_list` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct UserListArgs {
    /// 在用户名、邮箱、昵称里模糊匹配。
    #[serde(default)]
    pub q: Option<String>,
    /// 只看某个角色。
    #[serde(default)]
    pub role_id: Option<String>,
    /// 只看某个状态:active / pending_email / disabled / deleting。
    #[serde(default)]
    pub status: Option<String>,
    /// 页码,从 1 开始。
    #[serde(default)]
    pub page: Option<u32>,
    /// 每页条数(最多 200)。
    #[serde(default)]
    pub page_size: Option<u32>,
}

/// `user_create` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct UserCreateArgs {
    /// 登录名。
    pub username: String,
    /// 初始密码(至少 8 位)。
    pub password: String,
    /// 邮箱。
    #[serde(default)]
    pub email: Option<String>,
    /// 昵称。
    #[serde(default)]
    pub display_name: Option<String>,
    /// 角色 id,默认普通用户。
    #[serde(default)]
    pub role_id: Option<String>,
    /// 首次登录必须改密码。
    #[serde(default)]
    pub must_change_password: bool,
}

/// `user_update` 的参数,没写的键不改。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct UserUpdateArgs {
    /// 用户 id。
    pub id: String,
    /// 角色 id。
    #[serde(default)]
    pub role_id: Option<String>,
    /// 状态:active / disabled。
    #[serde(default)]
    pub status: Option<String>,
    /// 昵称。
    #[serde(default)]
    pub display_name: Option<String>,
    /// 配额覆盖(JSON 对象)。
    #[serde(default)]
    pub quota: Option<Value>,
}

/// `user_set_password` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct UserPasswordArgs {
    /// 用户 id。
    pub id: String,
    /// 新密码(至少 8 位)。
    pub password: String,
    /// 是否要求他下次登录时改掉。
    #[serde(default)]
    pub must_change_password: bool,
}

/// `user_feature` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct UserFeatureArgs {
    /// 用户 id。
    pub id: String,
    /// 功能点 id。
    pub feature: String,
    /// `allow` / `deny`;不写或 `null` = 清除例外,跟随角色。
    #[serde(default)]
    pub effect: Option<String>,
}

/// `invite_create` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct InviteCreateArgs {
    /// 备注(给谁的、哪次活动)。
    #[serde(default)]
    pub note: String,
    /// 最多用几次(1–10000),默认 1。
    #[serde(default)]
    pub max_uses: Option<i64>,
    /// 几天后过期;不写 = 不过期。
    #[serde(default)]
    pub expires_days: Option<u32>,
    /// 用它注册后的角色;不写 = 系统默认角色。
    #[serde(default)]
    pub role_id: Option<String>,
    /// 用它注册后的配额覆盖(JSON 对象,只写要覆盖的键)。
    #[serde(default)]
    pub quota: Option<Value>,
    /// 一次生成几个(1–100,默认 1)。多个码共用上面的设置,各自独立计数。
    #[serde(default)]
    pub count: Option<u32>,
    /// 用它注册的人是否自动和邀请人互为好友,默认是。管理员 / 本机创建的码没有邀请人,此项不起作用。
    #[serde(default)]
    pub auto_friend: Option<bool>,
}

/// `mail_password` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct MailPasswordArgs {
    /// `primary` 或 `backup`。
    pub slot: String,
    /// 授权码;空字符串 = 清除。
    pub password: String,
}

/// `mail_test` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct MailTestArgs {
    /// `primary` 或 `backup`。
    pub slot: String,
    /// 收件人;不写 = 当前管理员自己的邮箱。
    #[serde(default)]
    pub to: Option<String>,
}

/// `mail_log` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct MailLogArgs {
    /// 条数,默认 50,最多 500。
    #[serde(default)]
    pub limit: Option<u32>,
}

const WEB_ONLY: &[Surface] = &[Surface::Web];

fn register_one(
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

/// 注册账号管理能力。
pub fn register_admin(registry: &mut Registry, backend: Arc<dyn AdminBackend>) {
    crate::social::register_social(registry, backend.clone());
    crate::sharing::register_sharing(registry, backend.clone());
    crate::links::register_links(registry, backend.clone());
    let b = backend.clone();
    register_one(
        registry,
        "feature_catalog",
        "功能点目录:每个功能点的分组、名字、说明、是否危险、是否属于 AI",
        Permission::Read,
        schema::<serde_json::Map<String, Value>>(),
        typed(
            move |_ctx: CallCtx, _args: serde_json::Map<String, Value>| {
                let b = b.clone();
                async move { b.feature_catalog().await }
            },
        ),
    );
    let b = backend.clone();
    register_one(
        registry,
        "role_list",
        "角色列表(含功能勾选、配额覆盖、人数)",
        Permission::Read,
        schema::<serde_json::Map<String, Value>>(),
        typed(
            move |_ctx: CallCtx, _args: serde_json::Map<String, Value>| {
                let b = b.clone();
                async move { b.role_list().await }
            },
        ),
    );
    let b = backend.clone();
    register_one(
        registry,
        "role_create",
        "新建自定义角色并勾选功能",
        Permission::Write,
        schema::<RoleCreateArgs>(),
        typed(move |ctx: CallCtx, args: RoleCreateArgs| {
            let b = b.clone();
            async move { b.role_create(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "role_update",
        "修改角色的名字、说明、功能勾选、配额覆盖(管理员角色不可改)",
        Permission::Write,
        schema::<RoleUpdateArgs>(),
        typed(move |ctx: CallCtx, args: RoleUpdateArgs| {
            let b = b.clone();
            async move { b.role_update(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "role_delete",
        "删除自定义角色(还有用户在用、或是内置角色都会被拒)",
        Permission::Write,
        schema::<IdArgs>(),
        typed(move |ctx: CallCtx, args: IdArgs| {
            let b = b.clone();
            async move { b.role_delete(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "storage_overview",
        "全站存储概览:数据盘剩余与保留空间、各知识库占用排行(含向量索引等看不见的部分)",
        Permission::Read,
        schema::<StorageOverviewArgs>(),
        typed(move |_ctx: CallCtx, args: StorageOverviewArgs| {
            let b = b.clone();
            async move { b.storage_overview(args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "metrics_series",
        "资源曲线:本机处理器 / 内存 / 负载 / 磁盘和本服务进程的占用随时间的变化(1 小时 / 24 小时 / 7 天 / 30 天)",
        Permission::Read,
        schema::<MetricsSeriesArgs>(),
        typed(move |_ctx: CallCtx, args: MetricsSeriesArgs| {
            let b = b.clone();
            async move { b.metrics_series(args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "llm_usage_series",
        "全站 AI 用量趋势:最近若干天每天用了多少 token,按用途分(提炼、审核、助手……)",
        Permission::Read,
        schema::<LlmUsageSeriesArgs>(),
        typed(move |_ctx: CallCtx, args: LlmUsageSeriesArgs| {
            let b = b.clone();
            async move { b.llm_usage_series(args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "llm_usage_overview",
        "AI 用量排行:某一天每个人用了多少 token(输入 / 输出 / 调用次数)、他的每日额度",
        Permission::Read,
        schema::<LlmUsageOverviewArgs>(),
        typed(move |_ctx: CallCtx, args: LlmUsageOverviewArgs| {
            let b = b.clone();
            async move { b.llm_usage_overview(args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "usage_mine",
        "我自己的用量:存储占用分项与配额、今天已用的 AI 额度",
        Permission::Read,
        schema::<serde_json::Map<String, Value>>(),
        typed(move |ctx: CallCtx, _args: serde_json::Map<String, Value>| {
            let b = b.clone();
            async move { b.usage_mine(&ctx).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "user_list",
        "分页列出用户,可按关键字 / 角色 / 状态筛选",
        Permission::Read,
        schema::<UserListArgs>(),
        typed(move |_ctx: CallCtx, args: UserListArgs| {
            let b = b.clone();
            async move { b.user_list(args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "admin_space_open",
        "管理员只读查看:确认目标用户与个人知识库可用(不读取任何文档内容;每次都记审计)",
        Permission::Read,
        schema::<AdminViewArgs>(),
        typed(move |ctx: CallCtx, args: AdminViewArgs| {
            let b = b.clone();
            async move { b.admin_space_open(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "user_get",
        "一个用户的详情:角色、功能例外、最终生效的功能",
        Permission::Read,
        schema::<IdArgs>(),
        typed(move |_ctx: CallCtx, args: IdArgs| {
            let b = b.clone();
            async move { b.user_get(args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "user_create",
        "管理员代建账号",
        Permission::Write,
        schema::<UserCreateArgs>(),
        typed(move |ctx: CallCtx, args: UserCreateArgs| {
            let b = b.clone();
            async move { b.user_create(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "user_update",
        "改用户的角色、状态(停用会立即踢下线)、昵称、配额覆盖;最后一个管理员不能降级或停用",
        Permission::Write,
        schema::<UserUpdateArgs>(),
        typed(move |ctx: CallCtx, args: UserUpdateArgs| {
            let b = b.clone();
            async move { b.user_update(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "user_set_password",
        "重设用户密码,并让他其它设备上的登录失效",
        Permission::Write,
        schema::<UserPasswordArgs>(),
        typed(move |ctx: CallCtx, args: UserPasswordArgs| {
            let b = b.clone();
            async move { b.user_set_password(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "user_totp_reset",
        "替用户关掉两步验证(他丢了手机和恢复码),并让他所有设备上的登录失效",
        Permission::Write,
        schema::<UserIdArgs>(),
        typed(move |ctx: CallCtx, args: UserIdArgs| {
            let b = b.clone();
            async move { b.user_totp_reset(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "invite_create",
        "生成邀请码(明文只显示这一次);可指定可用次数、有效期、注册后的角色与配额",
        Permission::Write,
        schema::<InviteCreateArgs>(),
        typed(move |ctx: CallCtx, args: InviteCreateArgs| {
            let b = b.clone();
            async move { b.invite_create(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "invite_list",
        "邀请码列表:前缀、备注、已用 / 可用次数、有效期、角色(没有明文)",
        Permission::Read,
        schema::<serde_json::Map<String, Value>>(),
        typed(move |ctx: CallCtx, _args: serde_json::Map<String, Value>| {
            let b = b.clone();
            async move { b.invite_list(&ctx).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "invite_revoke",
        "撤销邀请码,已经注册的账号不受影响",
        Permission::Write,
        schema::<IdArgs>(),
        typed(move |ctx: CallCtx, args: IdArgs| {
            let b = b.clone();
            async move { b.invite_revoke(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "invite_uses",
        "一个邀请码的使用记录:谁、什么时候用它注册的",
        Permission::Read,
        schema::<IdArgs>(),
        typed(move |ctx: CallCtx, args: IdArgs| {
            let b = b.clone();
            async move { b.invite_uses(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "mail_status",
        "邮件设置现状:开关、主备账号、授权码是否已设置(不返回授权码)",
        Permission::Read,
        schema::<serde_json::Map<String, Value>>(),
        typed(
            move |_ctx: CallCtx, _args: serde_json::Map<String, Value>| {
                let b = b.clone();
                async move { b.mail_status().await }
            },
        ),
    );
    let b = backend.clone();
    register_one(
        registry,
        "mail_password",
        "写入或清除发件邮箱的授权码(只写不读)",
        Permission::Admin,
        schema::<MailPasswordArgs>(),
        typed(move |ctx: CallCtx, args: MailPasswordArgs| {
            let b = b.clone();
            async move { b.mail_password(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "mail_test",
        "用指定的发件账号(主 / 备)发一封测试邮件,不会自动切换到另一个账号",
        Permission::Write,
        schema::<MailTestArgs>(),
        typed(move |ctx: CallCtx, args: MailTestArgs| {
            let b = b.clone();
            async move { b.mail_test(&ctx, args).await }
        }),
    );
    let b = backend.clone();
    register_one(
        registry,
        "mail_log",
        "最近的发信记录:时间、收件人、种类、是否成功、用的哪个账号、失败原因",
        Permission::Read,
        schema::<MailLogArgs>(),
        typed(move |_ctx: CallCtx, args: MailLogArgs| {
            let b = b.clone();
            async move { b.mail_log(args).await }
        }),
    );
    register_one(
        registry,
        "user_feature",
        "给单个用户加 / 减一个功能(例外),或清除例外跟随角色",
        Permission::Write,
        schema::<UserFeatureArgs>(),
        typed(move |ctx: CallCtx, args: UserFeatureArgs| {
            let b = backend.clone();
            async move { b.user_feature(&ctx, args).await }
        }),
    );
}
