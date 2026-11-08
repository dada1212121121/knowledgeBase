//! 账号与配额类配置:注册、管理员、配额、分享、站点。
//!
//! 由 `config.rs` 拆出:路径不变,入口仍是 `kb_core::config`。
use serde::{Deserialize, Serialize};

/// `[accounts]`:注册与账号(多用户设计说明)。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AccountsConfig {
    /// 开放邮箱注册;关了只能由管理员建账号。
    pub registration_open: bool,
    /// 注册需要邀请码。
    pub require_invite: bool,
    /// 新用户的默认角色 id。
    pub default_role: String,
    /// 注册时必须设用户名。
    pub username_required: bool,
    /// 普通用户能生成几个邀请码(0 = 只有管理员能生成)。
    pub invites_per_user: u32,
    /// 拦截一次性邮箱。
    pub block_disposable_email: bool,
    /// 只允许这些邮箱域名注册(空 = 不限制)。
    pub email_domain_allowlist: Vec<String>,
    /// 用户申请注销后的冷静期天数,期间可以撤销。使用时钳制在 1–365:0 天等于没有反悔的机会。
    pub deletion_cooling_off_days: u32,
    /// 管理级账号(能管用户的)必须开启两步验证:没开的只能访问设置两步验证的接口,不能关闭。默认关。
    pub require_admin_totp: bool,
}

impl AccountsConfig {
    /// 冷静期(毫秒),钳制在 1–365 天。
    pub fn deletion_cooling_off_ms(&self) -> i64 {
        i64::from(self.deletion_cooling_off_days.clamp(1, 365)) * 86_400_000
    }
}

impl Default for AccountsConfig {
    fn default() -> Self {
        Self {
            registration_open: true,
            require_invite: false,
            default_role: crate::account::ROLE_USER.to_owned(),
            username_required: true,
            invites_per_user: 0,
            block_disposable_email: true,
            email_domain_allowlist: Vec::new(),
            deletion_cooling_off_days: 7,
            require_admin_totp: false,
        }
    }
}

/// `[admin]`:管理员在后台查看他人数据。
///
/// 默认开:功能点 `sys.inspect` 本身是危险功能,只授予明确勾选的管理员;
/// 关闭后接口直接 403、前端也不显示「查看」。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AdminConfig {
    /// 允许拥有 `sys.inspect` 的管理员**只读**查看其他用户的知识库。
    pub inspect_enabled: bool,
}

impl Default for AdminConfig {
    fn default() -> Self {
        Self {
            inspect_enabled: true,
        }
    }
}

/// `[quota]`:全站默认配额与限制。角色的 `quota_json` 和用户的 `quota_json` 依次覆盖它。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct QuotaConfig {
    /// 每人存储上限(GB)。只是上限,不预先占用空间。
    pub storage_gb: u64,
    /// 单个上传文件上限(MB)。
    pub max_upload_mb: u64,
    /// 每人每天 LLM token。
    pub llm_tokens_per_day: u64,
    /// ACP 全站同时会话数。
    pub acp_concurrency_total: u32,
    /// ACP 每人同时会话数。
    pub acp_concurrency_per_user: u32,
    /// ACP 单次最长(分钟)。
    pub acp_minutes: u32,
    /// 全站保留空间(GB):磁盘剩余低于它时停止所有人的上传。
    pub disk_reserve_gb: u64,
    /// 每人分享链接数上限。
    pub links_per_user: u32,
    /// 每人好友数上限。
    pub friends_per_user: u32,
}

impl Default for QuotaConfig {
    fn default() -> Self {
        Self {
            storage_gb: 100,
            max_upload_mb: 200,
            llm_tokens_per_day: 200_000,
            acp_concurrency_total: 8,
            acp_concurrency_per_user: 1,
            acp_minutes: 30,
            disk_reserve_gb: 30,
            links_per_user: 1000,
            friends_per_user: 1000,
        }
    }
}

impl QuotaConfig {
    /// 在全站默认值之上叠加一层覆盖(角色或用户的 `quota_json`)。
    ///
    /// 只认本结构里已有的键、且值必须是非负整数;未知键和类型不对的值直接忽略(管理员手写的
    /// JSON 里多一个键不应该让整个配额失效)。覆盖里没写的键保持原值。
    pub fn with_overrides(&self, json: &str) -> QuotaConfig {
        let Ok(serde_json::Value::Object(overrides)) =
            serde_json::from_str::<serde_json::Value>(json)
        else {
            return self.clone();
        };
        let Ok(serde_json::Value::Object(mut base)) = serde_json::to_value(self) else {
            return self.clone();
        };
        for (key, value) in overrides {
            if base.contains_key(&key) && value.is_u64() {
                base.insert(key, value);
            }
        }
        serde_json::from_value(serde_json::Value::Object(base)).unwrap_or_else(|_| self.clone())
    }
}

/// `[share]`:分享与游客。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ShareConfig {
    /// 允许游客(不登录)查看分享链接。
    pub allow_guest_view: bool,
    /// 允许游客评论。
    pub allow_guest_comment: bool,
    /// 允许游客编辑。
    pub allow_guest_edit: bool,
    /// 每个游客链接每天的下载流量上限(GB)。
    pub guest_link_gb_per_day: u32,
    /// 单个协作房间人数上限。
    pub room_max_users: u32,
}

impl Default for ShareConfig {
    fn default() -> Self {
        Self {
            allow_guest_view: true,
            allow_guest_comment: false,
            allow_guest_edit: false,
            guest_link_gb_per_day: 10,
            room_max_users: 30,
        }
    }
}

/// `[site]`:站点名称、对外地址与全站时区。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SiteConfig {
    /// 站点名称。
    pub name: String,
    /// 登录页标语(默认不含 AI 字样)。
    pub tagline: String,
    /// 对外地址:分享链接和邮件里的链接都用它。
    pub public_url: String,
    /// 全站时区(IANA 名称)。每日额度、统计分桶、调度、界面时间都按它算。
    pub timezone: String,
}

impl Default for SiteConfig {
    fn default() -> Self {
        Self {
            name: "knowledgeBase".to_owned(),
            tagline: "个人与团队的知识库".to_owned(),
            public_url: "https://kb.example.com".to_owned(),
            timezone: crate::timezone::DEFAULT_TIMEZONE.to_owned(),
        }
    }
}
