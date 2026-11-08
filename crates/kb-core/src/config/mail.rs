//! 邮件配置:SMTP 账号与预设。
//!
//! 由 `config.rs` 拆出:路径不变,入口仍是 `kb_core::config`。
use serde::{Deserialize, Serialize};

/// 一个发信账号(SMTP)。授权码**不在这里**:在 `secrets.toml` 的 `[mail]` 段,
/// 配置文件和接口都不会出现它。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MailAccount {
    /// 预设:`qq` / `163` / `126` / `exmail` / `aliyun` / `custom`。预设只是帮着填好服务器和端口。
    pub preset: String,
    /// SMTP 服务器。
    pub host: String,
    /// 端口:465 = 隐式 TLS,587 = STARTTLS。
    pub port: u16,
    /// `tls`(隐式 TLS)或 `starttls`。
    pub security: String,
    /// 登录名,同时是发件地址(QQ / 163 要求 From 必须等于登录账号)。
    pub username: String,
}

impl Default for MailAccount {
    fn default() -> Self {
        Self {
            preset: "custom".to_owned(),
            host: String::new(),
            port: 465,
            security: "tls".to_owned(),
            username: String::new(),
        }
    }
}

impl MailAccount {
    /// 这个账号填全了吗(没填全就当没配置)。
    pub fn is_configured(&self) -> bool {
        !self.host.trim().is_empty() && !self.username.trim().is_empty() && self.port != 0
    }
}

/// `[mail]`:发信设置(多用户设计说明)。主备两个账号:主账号连续失败或超出每日上限时自动改用备用。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct MailConfig {
    /// 总开关。关了(或没配好)注册页提示「邮箱注册暂未开放」。
    pub enabled: bool,
    /// 发件人显示名;空则用站点名称。
    pub from_name: String,
    /// 全站每分钟最多发多少封,防止被拿来刷邮件。
    pub per_minute: u32,
    /// 主账号。
    pub primary: MailAccount,
    /// 备用账号(可选)。
    pub backup: MailAccount,
}

impl Default for MailConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            from_name: String::new(),
            per_minute: 30,
            primary: MailAccount::default(),
            backup: MailAccount::default(),
        }
    }
}

/// 常见邮箱的 SMTP 预设:`(id, 名字, 服务器, 端口, 加密)`。
///
/// QQ / 163 / 126 / 腾讯企业邮都要在邮箱网页版里开启 SMTP 并生成**授权码**(不是登录密码)。
pub const MAIL_PRESETS: &[(&str, &str, &str, u16, &str)] = &[
    ("qq", "QQ 邮箱", "smtp.qq.com", 465, "tls"),
    ("163", "163 邮箱", "smtp.163.com", 465, "tls"),
    ("126", "126 邮箱", "smtp.126.com", 465, "tls"),
    ("exmail", "腾讯企业邮", "smtp.exmail.qq.com", 465, "tls"),
    ("aliyun", "阿里邮箱", "smtp.mxhichina.com", 465, "tls"),
];

impl MailAccount {
    /// 按预设填好服务器 / 端口 / 加密,保留已填的登录名。未知预设(含 `custom`)原样返回。
    pub fn with_preset(mut self, preset: &str) -> Self {
        if let Some((id, _, host, port, security)) =
            MAIL_PRESETS.iter().find(|(id, ..)| *id == preset)
        {
            self.preset = (*id).to_owned();
            self.host = (*host).to_owned();
            self.port = *port;
            self.security = (*security).to_owned();
        }
        self
    }
}
