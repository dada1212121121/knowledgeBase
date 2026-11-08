//! 身份域的 DTO:账号、角色、授权、访问链接、通知、注册与令牌的入参与出参。
//!
//! 这些类型原先定义在 `kb-meta`(`kb-meta/src/system/`)里,但端口 trait 在 `kb-core`,
//! 参数类型不能指向适配器 crate —— 所以类型搬到这里,`kb-meta` 用
//! `pub use kb_core::model::identity::*` 保住旧路径(`kb_meta::system::LinkRecord` 仍可用)。
//!
//! 只放**数据**:读写行为在 `kb-core/src/ports/system.rs` 的端口 trait 上,
//! SQL 与迁移在 `kb-meta`。

use serde::Serialize;

use crate::account::{SpaceUsage, UserStatus};
use crate::model::Millis;
use crate::share::link::{Audience, ShareLink};
use crate::share::{Grant, ResourceKey, Role};
use crate::social::{FriendRequest, Notification, PublicProfile};
use crate::{KbError, Result};

/// `check_purgeable` 的结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purgeable {
    /// 账号已经不存在(上一轮删完了)。
    AlreadyGone,
    /// 可以清理。
    Yes,
}

/// 列用户的筛选条件。
#[derive(Clone, Debug, Default)]
pub struct UserFilter {
    /// 在用户名、邮箱、显示名里模糊匹配。
    pub q: Option<String>,
    /// 只看某个角色。
    pub role_id: Option<String>,
    /// 只看某个状态。
    pub status: Option<UserStatus>,
}

/// 更新用户的参数,`None` 表示不改。
#[derive(Clone, Debug, Default)]
pub struct UserUpdate {
    /// 显示名。
    pub display_name: Option<String>,
    /// 角色。
    pub role_id: Option<String>,
    /// 状态。
    pub status: Option<UserStatus>,
    /// 配额覆盖(JSON)。
    pub quota_json: Option<String>,
    /// 邮箱(`Some(None)` = 清空)。换邮箱默认要重新验证;已经验证过新邮箱的调用方同时给 `email_verified_at`。
    pub email: Option<Option<String>>,
    /// 与 `email` 一起给:新邮箱已经验证过(刚用验证码证明了归本人),记这个时间,不清空。
    pub email_verified_at: Option<Millis>,
    /// 头像文件名(`Some(None)` = 清空)。
    pub avatar: Option<Option<String>>,
    /// 是否必须改密码。
    pub must_change_password: Option<bool>,
}

/// 一个知识库最近一次统计的结果。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct MeasuredUsage {
    /// 分项。
    #[serde(flatten)]
    pub usage: SpaceUsage,
    /// 合计。
    pub total_bytes: u64,
    /// 统计时间(毫秒)。
    pub measured_at: Millis,
}

/// 排行里的一行:占用 + 属于谁。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StorageRankRow {
    /// 知识库 id。
    pub space_id: String,
    /// 所有者 id。
    pub owner_id: String,
    /// 所有者登录名(账号已删除时为 `None`)。
    pub username: Option<String>,
    /// 所有者昵称。
    pub display_name: Option<String>,
    /// 占用。
    #[serde(flatten)]
    pub measured: MeasuredUsage,
}

/// 全站合计。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct StorageTotals {
    /// 有统计结果的知识库数。
    pub measured_spaces: u64,
    /// 知识库总数。
    pub total_spaces: u64,
    /// 所有知识库占用合计。
    pub total_bytes: u64,
    /// 其中向量索引合计。
    pub vectors_bytes: u64,
    /// 最久没更新的那条统计的时间(没有则为 `None`)。
    pub oldest_measured_at: Option<Millis>,
}

/// 更新角色的参数,`None` 表示不改。
#[derive(Clone, Debug, Default)]
pub struct RoleUpdate {
    /// 名字。
    pub name: Option<String>,
    /// 说明。
    pub description: Option<String>,
    /// 勾选的功能点(整体替换)。
    pub features: Option<Vec<String>>,
    /// 是否允许授予危险功能。
    pub dangerous: Option<bool>,
    /// 配额 JSON。
    pub quota_json: Option<String>,
}

/// 授权 + 被授权人的资料(分享面板用)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GrantView {
    /// 授权本身。
    #[serde(flatten)]
    pub grant: Grant,
    /// 被授权人。
    pub grantee: PublicProfile,
    /// 这条授权挂在哪个资源上(分享面板里「继承自 xx」)。
    pub inherited: bool,
}

/// `set_grant` 的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SetGrant {
    /// 写入后的授权。
    pub grant: Grant,
    /// 之前这个人在这个资源上的角色(新增时为 `None`)。
    pub previous: Option<Role>,
}

/// 批量变更里的一项:给某人这个角色;`role = None` 表示移除。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantChange {
    /// 被授权人。
    pub grantee_id: String,
    /// 新角色;`None` = 移除他在这些资源上的授权。
    pub role: Option<Role>,
}

/// 批量变更的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct BatchOutcome {
    /// 新增或改了角色的授权条数。
    pub changed: usize,
    /// 本来就一样、没动的条数。
    pub unchanged: usize,
    /// 移除的条数。
    pub removed: usize,
}

/// 「共享给我」里的一项:我被直接授权的一个资源。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SharedRoot {
    /// 授权。
    #[serde(flatten)]
    pub grant: Grant,
    /// 资源所在知识库的主人。
    pub owner: PublicProfile,
    /// 我把它移出了列表吗。
    pub hidden: bool,
}

/// 「我的分享」里的一项:我的知识库里一个有协作者的资源。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SharedByMe {
    /// 资源键。
    pub resource_key: String,
    /// 协作者(带角色)。
    pub grantees: Vec<(PublicProfile, Role)>,
    /// 是否停止了继承。
    pub inherit_broken: bool,
}

/// 新建链接的参数。
#[derive(Clone, Debug)]
pub struct NewLink {
    /// 单个资源;合集链接传 `None` 并在 `items` 里列出。
    pub resource: Option<ResourceKey>,
    /// 合集链接的内容。
    pub items: Vec<ResourceKey>,
    /// 合集链接的名字。
    pub title: Option<String>,
    /// 谁能访问。
    pub audience: Audience,
    /// 链接给的角色。
    pub role: Role,
    /// 访问密码的哈希(没有密码为 `None`)。
    pub password_hash: Option<String>,
    /// 过期时间。
    pub expires_at: Option<Millis>,
    /// 允许下载。
    pub allow_download: bool,
    /// 水印。
    pub watermark: bool,
    /// 编辑者可再分享。
    pub allow_reshare: bool,
    /// 创建人。
    pub created_by: String,
}

/// 修改链接的字段。`None` = 不动;可清空的用 `Some(None)`。
#[derive(Clone, Debug, Default)]
pub struct LinkUpdate {
    /// 访问范围。
    pub audience: Option<Audience>,
    /// 角色。
    pub role: Option<Role>,
    /// 密码哈希。
    pub password_hash: Option<Option<String>>,
    /// 过期时间。
    pub expires_at: Option<Option<Millis>>,
    /// 允许下载。
    pub allow_download: Option<bool>,
    /// 水印。
    pub watermark: Option<bool>,
    /// 编辑者可再分享。
    pub allow_reshare: Option<bool>,
    /// 开 / 关。
    pub enabled: Option<bool>,
    /// 合集名。
    pub title: Option<Option<String>>,
}

/// 链接 + 服务端内部要用的秘密(密码哈希)和内容。
#[derive(Clone, Debug)]
pub struct LinkRecord {
    /// 对外可见的部分。
    pub link: ShareLink,
    /// 访问密码哈希。
    pub password_hash: Option<String>,
    /// 合集链接的内容(单个资源链接为空)。
    pub items: Vec<ResourceKey>,
}

impl LinkRecord {
    /// 链接覆盖的资源:单个资源或合集里的各项。
    pub fn roots(&self) -> Vec<ResourceKey> {
        match &self.link.resource_key {
            Some(text) => ResourceKey::parse(text).into_iter().collect(),
            None => self.items.clone(),
        }
    }

    /// 某个资源是否在这个链接的范围里(是链接的根,或在某个根底下)。
    pub fn covers(&self, key: &ResourceKey) -> bool {
        self.roots().iter().any(|root| key.is_within(root))
    }
}

/// 一个游客。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Guest {
    /// 访客 id(cookie 随机串的哈希)。
    pub id: String,
    /// 昵称。
    pub nickname: String,
    /// 第一次通过哪个链接来的。
    pub first_link_id: Option<String>,
    /// 创建时间。
    pub created_at: Millis,
    /// 最近出现。
    pub last_seen: Millis,
}

/// 链接的一个登录访问者。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct LinkVisitor {
    /// 用户 id。
    pub user_id: String,
    /// 第一次访问。
    pub first_at: Millis,
    /// 最近访问。
    pub last_at: Millis,
    /// 次数。
    pub visits: i64,
}

/// 好友数上限。两个人的上限可以不同(角色 / 用户例外会覆盖全站默认),所以分开传。0 = 不限。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Caps {
    /// 发起这个操作的人的上限。
    pub me: u32,
    /// 对方的上限。
    pub other: u32,
}

impl Caps {
    /// 两边同一个上限(测试、批量场景)。
    pub fn same(limit: u32) -> Self {
        Self {
            me: limit,
            other: limit,
        }
    }
}

/// 处理申请的决定。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// 通过。
    Accept,
    /// 拒绝(发起人会收到结果通知,并且 24 小时内不能再申请)。
    Reject,
    /// 忽略(发起人看到的仍是「等待中」,不暴露;也不设冷却)。
    Ignore,
}

/// 发出申请的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RequestOutcome {
    /// 新建了一条申请,等对方处理。
    Created(FriendRequest),
    /// 对方之前已经向我发过申请,这次直接成为好友。
    AutoAccepted,
    /// 已经是好友。
    AlreadyFriends,
    /// 我之前给他发的申请还在等,没有重复创建。
    AlreadyPending(FriendRequest),
    /// 对方拉黑了我:**不创建任何东西,也不告诉我**(否则拉黑就等于告诉对方「我拉黑了你」)。
    Silent,
}

/// 一封合并邮件里的一个人和他的待发通知。
#[derive(Clone, Debug, PartialEq)]
pub struct Digest {
    /// 收件人。
    pub user_id: String,
    /// 待发的通知(新的在后)。
    pub items: Vec<Notification>,
    /// 队列行 id,发送成功后据此删除。
    pub queue_ids: Vec<i64>,
}

/// 账号库里能清的历史表。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SystemRetentionTable {
    /// 系统审计(登录、用户管理、分享等)。
    SystemAudit,
    /// 资源采样。
    MetricSamples,
}

impl SystemRetentionTable {
    /// 输出里用的名字。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::SystemAudit => "system_audit",
            Self::MetricSamples => "metric_samples",
        }
    }

    /// 从名字解析(白名单,不把调用方输入拼进 SQL)。
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "system_audit" => Ok(Self::SystemAudit),
            "metric_samples" => Ok(Self::MetricSamples),
            other => Err(KbError::InvalidInput(format!(
                "不支持清理的历史表 {other:?}(只能 system_audit / metric_samples)"
            ))),
        }
    }
}

/// 发验证码的限速规则。
#[derive(Clone, Copy, Debug)]
pub struct CodeLimits {
    /// 同一邮箱两次发送的最小间隔(毫秒)。
    pub min_gap_ms: i64,
    /// 同一邮箱每天最多几次。
    pub per_email_per_day: i64,
    /// 同一 IP 每小时最多几次。
    pub per_ip_per_hour: i64,
}

impl Default for CodeLimits {
    /// 全站默认:同一邮箱一分钟一次、每天 10 次;同一 IP 每小时 20 次。
    fn default() -> Self {
        Self {
            min_gap_ms: 60_000,
            per_email_per_day: 10,
            per_ip_per_hour: 20,
        }
    }
}

/// 发验证码的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum IssueOutcome {
    /// 已记录,可以发邮件了。
    Issued {
        /// 验证码记录 id。
        id: String,
    },
    /// 离上次发送太近,还要等几秒。
    TooSoon {
        /// 还要等的秒数。
        wait_secs: i64,
    },
    /// 这个邮箱今天发得太多了。
    EmailDailyLimit,
    /// 这个 IP 这小时发得太多了。
    IpHourlyLimit,
}

/// 校验验证码的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum VerifyOutcome {
    /// 对了(还没消耗,注册成功后再 `consume_email_code`)。
    Verified {
        /// 验证码记录 id。
        id: String,
    },
    /// 不对,还能再试几次。
    Wrong {
        /// 剩余次数。
        attempts_left: i64,
    },
    /// 试得太多,这个码作废了。
    Locked,
    /// 没有有效的验证码(没发过、过期了或已用过)。
    NoneValid,
}

/// 新建邀请码的参数。
#[derive(Clone, Debug)]
pub struct NewInvite {
    /// 明文码的哈希。
    pub code_hash: String,
    /// 前缀(展示用)。
    pub prefix: String,
    /// 创建人。
    pub created_by: Option<String>,
    /// 备注。
    pub note: String,
    /// 最多用几次。
    pub max_uses: i64,
    /// 过期时间。
    pub expires_at: Option<Millis>,
    /// 注册后的角色。
    pub role_id: Option<String>,
    /// 注册后的配额覆盖(JSON)。
    pub quota_json: String,
    /// 注册的人自动和邀请人互为好友。
    pub auto_friend: bool,
}

/// 发信记录的一条。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct MailLogEntry {
    /// 自增 id。
    pub id: i64,
    /// 时间。
    pub at: Millis,
    /// 收件人。
    pub to_addr: String,
    /// 邮件种类。
    pub kind: String,
    /// 是否发送成功。
    pub ok: bool,
    /// 用的账号:`primary` / `backup`。
    pub via: Option<String>,
    /// 失败原因。
    pub error: Option<String>,
}

/// 一个人的两步验证状态。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TotpState {
    /// 密钥(base32)。
    pub secret_b32: String,
    /// 验证过第一个码、正式开启了吗。
    pub confirmed: bool,
    /// 已经用掉的最大时间步。
    pub last_step: Option<u64>,
}

/// 某一天里一个用户的用量合计(管理员排行用)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UserLlmUsage {
    /// 用户 id。
    pub user_id: String,
    /// 调用次数。
    pub calls: u64,
    /// 输入 token。
    pub input_tokens: u64,
    /// 输出 token。
    pub output_tokens: u64,
}
