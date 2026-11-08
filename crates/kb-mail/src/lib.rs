//! 发信(多用户设计说明)。
//!
//! 分三层,上层不依赖下层的具体实现,所以注册、找回密码的逻辑可以不连网测试:
//!
//! - [`MailTransport`]:把一封邮件交出去(真实实现 [`SmtpTransport`],测试用 [`MemoryTransport`]);
//! - [`Mailer`]:主备切换——主账号失败(或超出上限)就改用备用,并记住 1 小时内别再试主账号;
//! - `templates`:中文邮件模板。

pub mod templates;

use std::sync::Mutex;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use kb_core::config::{MailAccount, MailConfig};
use kb_core::{KbError, Result};
use lettre::message::{Mailbox, header::ContentType};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

pub use templates::Mail;

/// 主账号失败后,多久之内直接用备用(1 小时)。
const PRIMARY_COOLDOWN: Duration = Duration::from_secs(3600);
/// 单次发送的总超时:SMTP 服务器卡住不能拖住注册请求。
const SEND_TIMEOUT: Duration = Duration::from_secs(20);

/// 一封待发送的邮件(已渲染)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Outgoing {
    /// 收件人。
    pub to: String,
    /// 主题。
    pub subject: String,
    /// 纯文本正文。
    pub body: String,
}

/// 用哪个账号发。
#[derive(Clone, Debug)]
pub struct Sender {
    /// 账号设置。
    pub account: MailAccount,
    /// 授权码(来自 `secrets.toml`,只在内存里)。
    pub password: String,
    /// 发件人显示名。
    pub from_name: String,
}

/// 把一封邮件交出去。
#[async_trait]
pub trait MailTransport: Send + Sync {
    /// 用 `sender` 发 `mail`。
    async fn send(&self, sender: &Sender, mail: &Outgoing) -> Result<()>;
}

/// 邮箱格式校验放在发送前:收件人来自用户输入,不合法的直接拒绝,不交给 SMTP 库去猜。
fn mailbox(address: &str, name: Option<&str>) -> Result<Mailbox> {
    let parsed: lettre::Address = address
        .trim()
        .parse()
        .map_err(|_| KbError::InvalidInput(format!("邮箱地址不合法:{address}")))?;
    Ok(Mailbox::new(name.map(str::to_owned), parsed))
}

/// 真实的 SMTP 发送。
#[derive(Debug, Default)]
pub struct SmtpTransport;

#[async_trait]
impl MailTransport for SmtpTransport {
    async fn send(&self, sender: &Sender, mail: &Outgoing) -> Result<()> {
        let account = &sender.account;
        if sender.password.is_empty() && !is_loopback(&account.host) {
            return Err(KbError::InvalidInput(format!(
                "{} 还没有设置授权码(在邮箱网页版里开启 SMTP 并生成授权码)",
                account.username
            )));
        }
        // 收件人、主题都不能含换行:防止邮件头注入(lettre 的类型化接口也会拒,这里先给个清楚的错误)
        if mail.to.contains(['\r', '\n']) || mail.subject.contains(['\r', '\n']) {
            return Err(KbError::InvalidInput("邮件头里不能有换行".to_owned()));
        }
        let from = mailbox(
            &account.username,
            Some(&sender.from_name)
                .filter(|n| !n.is_empty())
                .map(String::as_str),
        )?;
        let to = mailbox(&mail.to, None)?;
        let message = Message::builder()
            .from(from)
            .to(to)
            .subject(mail.subject.clone())
            .header(ContentType::TEXT_PLAIN)
            .body(mail.body.clone())
            .map_err(|err| KbError::InvalidInput(format!("邮件构造失败:{err}")))?;

        // `none`:不加密。只允许连本机(开发用的本地收信箱 Mailpit 就是明文 SMTP);
        // 连外网的服务器必须加密,否则授权码会明文走在网上。
        let builder = match account.security.as_str() {
            "none" => {
                if !is_loopback(&account.host) {
                    return Err(KbError::InvalidInput("不加密的 SMTP 只能连本机".to_owned()));
                }
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&account.host)
                    .tls(Tls::None)
            }
            other => {
                let tls = TlsParameters::new(account.host.clone())
                    .map_err(|err| KbError::Internal(format!("TLS 参数不合法:{err}")))?;
                let tls = if other == "starttls" {
                    Tls::Required(tls)
                } else {
                    Tls::Wrapper(tls)
                };
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&account.host).tls(tls)
            }
        };
        let mut builder = builder.port(account.port).timeout(Some(SEND_TIMEOUT));
        // 没有授权码就不登录:本机的无认证收信箱(Mailpit)不提供 AUTH,硬发凭据会被拒。
        // 连外网时没有授权码是配置错误,在上面就已经报了,走不到这里。
        if !sender.password.is_empty() {
            builder = builder.credentials(Credentials::new(
                account.username.clone(),
                sender.password.clone(),
            ));
        }
        let transport = builder.build();
        transport.send(message).await.map(|_| ()).map_err(|err| {
            KbError::Upstream(format!(
                "SMTP 发送失败:{}",
                scrub(&err.to_string(), &sender.password)
            ))
        })
    }
}

/// 是不是本机地址(`none` 加密方式只允许连这些)。
fn is_loopback(host: &str) -> bool {
    matches!(host.trim(), "localhost" | "127.0.0.1" | "::1")
}

/// 错误信息里不能带出授权码。
fn scrub(text: &str, secret: &str) -> String {
    if secret.is_empty() {
        text.to_owned()
    } else {
        text.replace(secret, "***")
    }
}

/// 主备切换的发信器。
pub struct Mailer {
    transport: Box<dyn MailTransport>,
    /// 主账号上次失败的时间。
    primary_failed_at: Mutex<Option<Instant>>,
}

/// 一次发送的结果:用的是哪个账号。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Via {
    /// 主账号。
    Primary,
    /// 备用账号。
    Backup,
}

impl Mailer {
    /// 构造。
    pub fn new(transport: Box<dyn MailTransport>) -> Self {
        Self {
            transport,
            primary_failed_at: Mutex::new(None),
        }
    }

    /// 真实 SMTP 的发信器。
    pub fn smtp() -> Self {
        Self::new(Box::new(SmtpTransport))
    }

    fn primary_cooling(&self) -> bool {
        self.primary_failed_at
            .lock()
            .ok()
            .and_then(|guard| *guard)
            .is_some_and(|at| at.elapsed() < PRIMARY_COOLDOWN)
    }

    /// 发一封邮件:先主账号,失败(连不上、认证错、超出每日上限……)且配了备用就改用备用。
    /// 主账号失败后 1 小时内直接走备用,别每封都先等主账号超时。
    pub async fn send(
        &self,
        config: &MailConfig,
        passwords: &Passwords,
        site_name: &str,
        mail: &Outgoing,
    ) -> Result<Via> {
        if !config.enabled {
            return Err(KbError::Unavailable("邮件功能没有开启".to_owned()));
        }
        let from_name = if config.from_name.trim().is_empty() {
            site_name
        } else {
            config.from_name.trim()
        };
        let primary = config.primary.is_configured().then(|| Sender {
            account: config.primary.clone(),
            password: passwords.primary.clone(),
            from_name: from_name.to_owned(),
        });
        let backup = config.backup.is_configured().then(|| Sender {
            account: config.backup.clone(),
            password: passwords.backup.clone(),
            from_name: from_name.to_owned(),
        });
        if primary.is_none() && backup.is_none() {
            return Err(KbError::Unavailable("还没有配置发件邮箱".to_owned()));
        }
        let mut last_error = None;
        if let Some(sender) = primary
            .as_ref()
            .filter(|_| !(self.primary_cooling() && backup.is_some()))
        {
            match self.transport.send(sender, mail).await {
                Ok(()) => {
                    if let Ok(mut guard) = self.primary_failed_at.lock() {
                        *guard = None;
                    }
                    return Ok(Via::Primary);
                }
                Err(err) => {
                    tracing::warn!(error = %err, "主发件邮箱失败");
                    if backup.is_some()
                        && let Ok(mut guard) = self.primary_failed_at.lock()
                    {
                        *guard = Some(Instant::now());
                    }
                    last_error = Some(err);
                }
            }
        }
        if let Some(sender) = &backup {
            match self.transport.send(sender, mail).await {
                Ok(()) => return Ok(Via::Backup),
                Err(err) => {
                    tracing::warn!(error = %err, "备用发件邮箱也失败");
                    last_error = Some(err);
                }
            }
        }
        Err(last_error.unwrap_or_else(|| KbError::Unavailable("没有可用的发件邮箱".to_owned())))
    }
}

impl Mailer {
    /// 只用指定的一个账号发,不切换、不动主账号的冷却状态。
    ///
    /// 给管理员「测试发信」用:点「测试主账号」时,主账号坏了就必须报错,
    /// 不能被备用账号悄悄顶上、让管理员以为主账号没问题。
    pub async fn send_via(
        &self,
        config: &MailConfig,
        passwords: &Passwords,
        site_name: &str,
        slot: Via,
        mail: &Outgoing,
    ) -> Result<()> {
        let (account, password) = match slot {
            Via::Primary => (&config.primary, &passwords.primary),
            Via::Backup => (&config.backup, &passwords.backup),
        };
        if !account.is_configured() {
            return Err(KbError::Unavailable(
                match slot {
                    Via::Primary => "主发件邮箱还没有配置",
                    Via::Backup => "备用发件邮箱还没有配置",
                }
                .to_owned(),
            ));
        }
        let from_name = if config.from_name.trim().is_empty() {
            site_name
        } else {
            config.from_name.trim()
        };
        let sender = Sender {
            account: account.clone(),
            password: password.clone(),
            from_name: from_name.to_owned(),
        };
        self.transport.send(&sender, mail).await
    }
}

/// 两个账号的授权码(从 `secrets.toml` 读出来,只在内存里)。
#[derive(Clone, Debug, Default)]
pub struct Passwords {
    /// 主账号。
    pub primary: String,
    /// 备用账号。
    pub backup: String,
}

/// 内存发信记录:`(账号登录名, 邮件)`。
pub type SentLog = std::sync::Arc<Mutex<Vec<(String, Outgoing)>>>;

/// 测试用:不发网络,把邮件收进内存;可以指定哪个账号失败。
#[derive(Default)]
pub struct MemoryTransport {
    /// 已"发出"的邮件:`(用的账号登录名, 邮件)`。
    pub sent: SentLog,
    /// 这些登录名发信时报错。
    pub failing: std::sync::Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl MailTransport for MemoryTransport {
    async fn send(&self, sender: &Sender, mail: &Outgoing) -> Result<()> {
        let username = sender.account.username.clone();
        if self
            .failing
            .lock()
            .map(|list| list.contains(&username))
            .unwrap_or(false)
        {
            return Err(KbError::Upstream(format!("{username} 发送失败(测试注入)")));
        }
        if let Ok(mut sent) = self.sent.lock() {
            sent.push((username, mail.clone()));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
