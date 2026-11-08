//! 邀请码与邮件设置的管理实现(多用户设计说明)。
//!
//! 作为 [`SystemAdmin`] 的内部方法,`AdminBackend` 的实现只做转发。
//!
//! 几条规矩:
//! - 邀请码明文只在创建那一次出现,库里只有哈希和前缀,列表接口拿不到明文;
//! - 邮件授权码**只写不读**:任何接口都不返回它,状态里只有「是否已设置」;
//! - 测试发信只用管理员选的那一个账号,不自动切到另一个,否则主账号坏了会被备用账号掩盖;
//! - 邀请码不能授予管理员角色(注册那边也会拦,这里在创建时就告诉管理员,不留到用户注册时才发现)。

use std::sync::Arc;

use kb_capability::CallCtx;
use kb_capability::admin::{InviteCreateArgs, MailLogArgs, MailPasswordArgs, MailTestArgs};
use kb_core::account::{generate_invite_code, invite_prefix};
use kb_core::config::{MAIL_PRESETS, MailAccount, QuotaConfig};
use kb_core::{KbError, Result};
use kb_mail::{Mail, Mailer, Via};
use kb_meta::system::NewInvite;
use serde_json::{Value, json};

use crate::admin_backend::SystemAdmin;

/// 发信相关的依赖:和注册接口共用同一个发信器(主备冷却状态才是同一份)。
#[derive(Clone)]
pub struct MailDeps {
    /// 发信器。
    pub mailer: Arc<Mailer>,
    /// 路径(读写 `secrets.toml`)。
    pub paths: kb_core::paths::KbPaths,
}

const DAY_MS: i64 = 86_400_000;

fn slot_of(text: &str) -> Result<Via> {
    match text {
        "primary" => Ok(Via::Primary),
        "backup" => Ok(Via::Backup),
        other => Err(KbError::InvalidInput(format!(
            "发件账号只能是 primary 或 backup,收到 {other}"
        ))),
    }
}

/// 严格校验邀请码带的配额覆盖:只许已有的配额键,值必须是非负整数。
///
/// `QuotaConfig::with_overrides` 对未知键是静默忽略(宽容读取旧数据),
/// 但管理员手滑把 `storage_gb` 写成 `storage_gp` 时必须当场报错,不能悄悄变成「没限制」。
fn strict_quota(quota: Option<Value>) -> Result<String> {
    let Some(value) = quota else {
        return Ok("{}".to_owned());
    };
    let Value::Object(map) = value else {
        return Err(KbError::InvalidInput("配额必须是 JSON 对象".to_owned()));
    };
    let known = serde_json::to_value(QuotaConfig::default())
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    for (key, value) in &map {
        if !known.contains_key(key) {
            return Err(KbError::InvalidInput(format!("没有这个配额项:{key}")));
        }
        if !value.is_u64() {
            return Err(KbError::InvalidInput(format!("配额 {key} 必须是非负整数")));
        }
    }
    Ok(Value::Object(map).to_string())
}

fn account_json(account: &MailAccount, password_set: bool) -> Value {
    json!({
        "preset": account.preset,
        "host": account.host,
        "port": account.port,
        "security": account.security,
        "username": account.username,
        "configured": account.is_configured(),
        // 只告诉有没有设置,从不返回授权码本身
        "password_set": password_set,
    })
}

impl SystemAdmin {
    fn mail_deps(&self) -> Result<&MailDeps> {
        self.mail
            .as_ref()
            .ok_or_else(|| KbError::Unavailable("邮件功能没有启用".to_owned()))
    }

    pub(crate) async fn do_invite_create(
        &self,
        ctx: &CallCtx,
        args: InviteCreateArgs,
    ) -> Result<Value> {
        let count = args.count.unwrap_or(1);
        if !(1..=100).contains(&count) {
            return Err(KbError::InvalidInput("一次生成 1–100 个".to_owned()));
        }
        let max_uses = args.max_uses.unwrap_or(1);
        if !(1..=10_000).contains(&max_uses) {
            return Err(KbError::InvalidInput(
                "可用次数需要在 1–10000 之间".to_owned(),
            ));
        }
        let now = kb_web::auth::session::now_millis();
        let expires_at = match args.expires_days {
            None => None,
            Some(days) if (1..=3650).contains(&days) => Some(now + i64::from(days) * DAY_MS),
            Some(_) => {
                return Err(KbError::InvalidInput(
                    "有效期需要在 1–3650 天之间".to_owned(),
                ));
            }
        };
        let role_id = args.role_id.filter(|id| !id.trim().is_empty());
        if let Some(id) = &role_id {
            let role = self
                .system
                .get_role(id)
                .await?
                .ok_or_else(|| KbError::InvalidInput(format!("没有这个角色:{id}")))?;
            if role.all_features {
                return Err(KbError::Forbidden(
                    "邀请码不能授予管理员角色,请先注册再由管理员提升".to_owned(),
                ));
            }
            if role.dangerous && !Self::is_full_admin(ctx) {
                return Err(KbError::Forbidden(
                    "只有管理员能创建授予系统级功能的邀请码".to_owned(),
                ));
            }
        }
        let quota_json = strict_quota(args.quota)?;
        let actor = Self::actor(ctx);
        let mut created = Vec::new();
        for _ in 0..count {
            let code = generate_invite_code();
            let invite = self
                .system
                .create_invite(NewInvite {
                    code_hash: kb_web::signup::invite_hash(self.system.as_ref(), &code).await?,
                    prefix: invite_prefix(&code),
                    created_by: actor.clone(),
                    note: args.note.trim().chars().take(100).collect(),
                    max_uses,
                    expires_at,
                    role_id: role_id.clone(),
                    quota_json: quota_json.clone(),
                    auto_friend: args.auto_friend.unwrap_or(true),
                })
                .await?;
            created.push(json!({ "invite": invite, "code": code }));
        }
        self.audit(
            ctx,
            "invite.create",
            "invite",
            json!({ "count": count, "max_uses": max_uses, "role": role_id, "note": args.note }),
        )
        .await;
        Ok(json!({ "invites": created }))
    }

    pub(crate) async fn do_invite_list(&self) -> Result<Value> {
        let now = kb_web::auth::session::now_millis();
        let invites = self.system.list_invites(None).await?;
        let rows: Vec<Value> = invites
            .iter()
            .map(|invite| {
                let state = if invite.revoked_at.is_some() {
                    "revoked"
                } else if invite.expires_at.is_some_and(|at| at <= now) {
                    "expired"
                } else if invite.used >= invite.max_uses {
                    "used_up"
                } else {
                    "active"
                };
                json!({ "invite": invite, "state": state })
            })
            .collect();
        Ok(json!({ "invites": rows, "now": now }))
    }

    pub(crate) async fn do_invite_revoke(&self, ctx: &CallCtx, id: &str) -> Result<Value> {
        let revoked = self
            .system
            .revoke_invite(id, None, kb_web::auth::session::now_millis())
            .await?;
        if !revoked {
            return Err(KbError::NotFound(format!("邀请码 {id}(或它已被撤销)")));
        }
        self.audit(ctx, "invite.revoke", id, json!({})).await;
        Ok(json!({ "id": id, "revoked": true }))
    }

    pub(crate) async fn do_invite_uses(&self, id: &str) -> Result<Value> {
        let uses = self.system.invite_uses(id).await?;
        let mut rows = Vec::new();
        for (user_id, ip, at) in uses {
            let user = self.system.get_user(&user_id).await?;
            rows.push(json!({
                "user_id": user_id,
                "username": user.as_ref().map(|user| user.username.clone()),
                "ip": ip,
                "at": at,
            }));
        }
        Ok(json!({ "uses": rows }))
    }

    pub(crate) async fn do_mail_status(&self) -> Result<Value> {
        let deps = self.mail_deps()?;
        let config = self.config.get();
        let passwords = crate::runtime::mail_passwords(&deps.paths);
        let since = kb_web::auth::session::now_millis() - 3_600_000;
        Ok(json!({
            "enabled": config.mail.enabled,
            "ready": kb_web::signup::mail_ready(&config),
            "from_name": config.mail.from_name,
            "per_minute": config.mail.per_minute,
            "primary": account_json(&config.mail.primary, !passwords.primary.is_empty()),
            "backup": account_json(&config.mail.backup, !passwords.backup.is_empty()),
            "presets": MAIL_PRESETS
                .iter()
                .map(|(id, name, host, port, security)| json!({
                    "id": id, "name": name, "host": host, "port": port, "security": security,
                }))
                .collect::<Vec<_>>(),
            "sent_last_hour": self.system.mails_since(since).await?,
        }))
    }

    pub(crate) async fn do_mail_password(
        &self,
        ctx: &CallCtx,
        args: MailPasswordArgs,
    ) -> Result<Value> {
        let deps = self.mail_deps()?;
        let slot = slot_of(&args.slot)?;
        let password = args.password.trim();
        if password.chars().count() > 200 || password.chars().any(char::is_control) {
            return Err(KbError::InvalidInput(
                "授权码不能超过 200 个字符,也不能含换行等控制字符".to_owned(),
            ));
        }
        let key = match slot {
            Via::Primary => "primary_password",
            Via::Backup => "backup_password",
        };
        crate::runtime::write_secret(
            deps.paths.secrets_file(),
            "mail",
            key,
            (!password.is_empty()).then_some(password),
        )?;
        // 审计里只记「改了哪个槽位、是设置还是清除」,不记授权码
        self.audit(
            ctx,
            "mail.password",
            &args.slot,
            json!({ "cleared": password.is_empty() }),
        )
        .await;
        Ok(json!({ "slot": args.slot, "password_set": !password.is_empty() }))
    }

    pub(crate) async fn do_mail_test(&self, ctx: &CallCtx, args: MailTestArgs) -> Result<Value> {
        let deps = self.mail_deps()?;
        let slot = slot_of(&args.slot)?;
        let typed = args
            .to
            .map(|text| text.trim().to_owned())
            .filter(|text| !text.is_empty());
        let to = match typed {
            Some(to) => kb_core::account::normalize_email(&to)?,
            None => {
                let user_id = Self::actor(ctx)
                    .ok_or_else(|| KbError::InvalidInput("请填写收件邮箱".to_owned()))?;
                self.system
                    .get_user(&user_id)
                    .await?
                    .and_then(|user| user.email)
                    .ok_or_else(|| {
                        KbError::InvalidInput(
                            "你的账号还没有邮箱,请填写要接收测试邮件的邮箱".to_owned(),
                        )
                    })?
            }
        };
        let config = self.config.get();
        let mail = Mail::Test.render(&to, &config.site.name, &config.site.public_url);
        let passwords = crate::runtime::mail_passwords(&deps.paths);
        let result = deps
            .mailer
            .send_via(&config.mail, &passwords, &config.site.name, slot, &mail)
            .await;
        let via = match slot {
            Via::Primary => "primary",
            Via::Backup => "backup",
        };
        let error_text = result.as_ref().err().map(ToString::to_string);
        self.system
            .record_mail(
                &to,
                "test",
                result.is_ok(),
                Some(via),
                error_text.as_deref(),
            )
            .await?;
        self.audit(
            ctx,
            "mail.test",
            via,
            json!({ "ok": result.is_ok(), "to": to }),
        )
        .await;
        // 测试失败不是接口错误:把原因原样告诉管理员,页面直接显示
        Ok(json!({ "ok": result.is_ok(), "slot": via, "to": to, "error": error_text }))
    }

    pub(crate) async fn do_mail_log(&self, args: MailLogArgs) -> Result<Value> {
        let rows = self.system.list_mail_log(args.limit.unwrap_or(50)).await?;
        Ok(json!({ "log": rows }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quota_overrides_are_checked_strictly() {
        assert_eq!(strict_quota(None).unwrap(), "{}");
        let ok = strict_quota(Some(json!({ "storage_gb": 7 }))).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&ok).unwrap()["storage_gb"], 7);
        // 拼错的键、字符串、负数、小数、非对象都要当场报错,不能悄悄变成「没限制」
        for bad in [
            json!({ "storage_gp": 7 }),
            json!({ "storage_gb": "7" }),
            json!({ "storage_gb": -1 }),
            json!({ "storage_gb": 1.5 }),
            json!([1]),
            json!("x"),
        ] {
            assert!(strict_quota(Some(bad.clone())).is_err(), "{bad}");
        }
    }

    #[test]
    fn slots_are_only_primary_or_backup() {
        assert_eq!(slot_of("primary").unwrap(), Via::Primary);
        assert_eq!(slot_of("backup").unwrap(), Via::Backup);
        assert!(slot_of("Primary").is_err() && slot_of("").is_err() && slot_of("third").is_err());
    }

    #[test]
    fn the_account_view_never_contains_a_password() {
        let account = MailAccount {
            username: "a@qq.com".into(),
            host: "smtp.qq.com".into(),
            ..MailAccount::default()
        };
        let text = account_json(&account, true).to_string();
        assert!(text.contains("\"password_set\":true"));
        assert!(!text.contains("\"password\""), "{text}");
    }
}
