//! 邮件模板(中文纯文本)。
//!
//! 每封邮件都写明:这是什么、验证码多久有效、不是你本人操作该怎么办。
//! 模板只拼文字,不发送;站点名称和对外地址由调用方传入。

use crate::Outgoing;

/// 邮件种类。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Mail {
    /// 注册验证码。
    RegisterCode {
        /// 6 位验证码。
        code: String,
        /// 有效分钟数。
        minutes: u32,
    },
    /// 找回密码验证码。
    ResetCode {
        /// 6 位验证码。
        code: String,
        /// 有效分钟数。
        minutes: u32,
    },
    /// 有人用这个邮箱尝试注册,但它已经注册过(防枚举:不在页面上告诉对方,只在邮件里提醒本人)。
    AlreadyRegistered,
    /// 更换邮箱:发给**新**邮箱的验证码。
    ChangeEmailCode {
        /// 6 位验证码。
        code: String,
        /// 有效分钟数。
        minutes: u32,
    },
    /// 邮箱已更换:发给**旧**邮箱的通知。账号被盗时,这封信是原主人唯一能收到的信号。
    EmailChanged {
        /// 新邮箱(会被脱敏后写进正文)。
        new_email: String,
    },
    /// 申请了注销账号:发给本人邮箱。
    DeletionRequested {
        /// 删除时间(调用方已格式化好的文字,模板不管时区)。
        when: String,
    },
    /// 站内通知的合并邮件:一段时间内的几条通知合成一封(最多每 10 分钟一封)。
    NotificationDigest {
        /// 每条通知一行描述(调用方已经写成人话)。
        lines: Vec<String>,
        /// 超出展示条数、没列出来的还有几条。
        more: usize,
    },
    /// 发件邮箱的测试邮件。
    Test,
}

/// 把邮箱遮一半:`alice@example.com` → `a***@example.com`。
/// 本地部分只留第一个字符;只有一个字符时一个都不露。域名保留,原主人要靠它认出是哪个邮箱。
pub fn mask_email(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return "***".to_owned();
    };
    let mut chars = local.chars();
    let first = chars.next();
    let rest = chars.count();
    match (first, rest) {
        (Some(first), 1..) => format!("{first}***@{domain}"),
        _ => format!("***@{domain}"),
    }
}

impl Mail {
    /// 渲染成邮件。`site` 是站点名称,`url` 是对外地址。
    pub fn render(&self, to: &str, site: &str, url: &str) -> Outgoing {
        let (subject, body) = match self {
            Mail::RegisterCode { code, minutes } => (
                format!("【{site}】注册验证码 {code}"),
                format!(
                    "你好,\n\n你正在注册「{site}」。验证码:\n\n    {code}\n\n验证码 {minutes} 分钟内有效,最多可尝试 5 次。\n如果这不是你本人的操作,请忽略这封邮件,你的邮箱不会被注册。\n\n{site}\n{url}\n"
                ),
            ),
            Mail::ResetCode { code, minutes } => (
                format!("【{site}】找回密码验证码 {code}"),
                format!(
                    "你好,\n\n你正在重设「{site}」的登录密码。验证码:\n\n    {code}\n\n验证码 {minutes} 分钟内有效,最多可尝试 5 次。\n如果这不是你本人的操作,请忽略这封邮件,你的密码不会改变;如果经常收到,建议改一下邮箱密码。\n\n{site}\n{url}\n"
                ),
            ),
            Mail::AlreadyRegistered => (
                format!("【{site}】有人尝试用你的邮箱注册"),
                format!(
                    "你好,\n\n刚才有人用这个邮箱尝试注册「{site}」,但它已经注册过了。\n如果是你本人,直接登录即可;忘记密码可以在登录页点「忘记密码」找回。\n如果不是你本人,请忽略这封邮件,你的账号没有任何变化。\n\n{site}\n{url}\n"
                ),
            ),
            Mail::ChangeEmailCode { code, minutes } => (
                format!("【{site}】更换邮箱验证码 {code}"),
                format!(
                    "你好,\n\n有人要把「{site}」账号的邮箱换成这个地址。验证码:\n\n    {code}\n\n验证码 {minutes} 分钟内有效,最多可尝试 5 次。\n如果这不是你本人的操作,请忽略这封邮件,不会有任何变化。\n\n{site}\n{url}\n"
                ),
            ),
            Mail::EmailChanged { new_email } => (
                format!("【{site}】你的账号邮箱已更换"),
                format!(
                    "你好,\n\n你的「{site}」账号邮箱刚刚更换为 {masked}。\n如果是你本人操作的,不用做任何事。\n如果不是你本人,你的账号可能已被他人使用:请马上联系管理员,并尽快修改密码。\n\n{site}\n{url}\n",
                    masked = mask_email(new_email)
                ),
            ),
            Mail::DeletionRequested { when } => (
                format!("【{site}】你的账号将被注销"),
                format!(
                    "你好,\n\n你的「{site}」账号已申请注销,将在 {when} 被永久删除,笔记和文件都无法恢复。\n在这之前你可以随时登录,到「个人设置 → 注销账号」撤销。\n如果这不是你本人的操作,请马上登录撤销,并修改密码。\n\n{site}\n{url}\n"
                ),
            ),
            Mail::NotificationDigest { lines, more } => {
                let list = lines
                    .iter()
                    .map(|line| format!("  · {line}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                let tail = if *more > 0 {
                    format!("\n  …… 还有 {more} 条,登录后在通知里查看。\n")
                } else {
                    String::new()
                };
                (
                    format!("【{site}】你有 {} 条新通知", lines.len() + more),
                    format!(
                        "你好,\n\n你在「{site}」有新的通知:\n\n{list}\n{tail}\n登录查看并处理:{url}\n\n不想收到这类邮件?登录后在「个人设置 → 通知」里按类关闭。\n\n{site}\n"
                    ),
                )
            }
            Mail::Test => (
                format!("【{site}】测试邮件"),
                format!(
                    "你好,\n\n收到这封邮件说明「{site}」的发件邮箱配置正确。\n\n{site}\n{url}\n"
                ),
            ),
        };
        Outgoing {
            to: to.to_owned(),
            subject,
            body,
        }
    }

    /// 邮件种类名(发送记录里显示)。
    pub fn kind(&self) -> &'static str {
        match self {
            Mail::RegisterCode { .. } => "register_code",
            Mail::ResetCode { .. } => "reset_code",
            Mail::AlreadyRegistered => "already_registered",
            Mail::ChangeEmailCode { .. } => "change_email_code",
            Mail::EmailChanged { .. } => "email_changed",
            Mail::DeletionRequested { .. } => "deletion_requested",
            Mail::NotificationDigest { .. } => "notification_digest",
            Mail::Test => "test",
        }
    }
}
