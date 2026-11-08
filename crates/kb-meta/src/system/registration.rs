//! 邮箱验证码、邀请码、发信记录(多用户设计说明)。
//!
//! 限速和尝试次数都放在库里而不是内存里:重启守护进程不能把「每个邮箱一分钟一次、最多试 5 次」清零。
//! 验证码 / 邀请码只存哈希(见 `kb_core::account::hash_code`),这里不接触明文。

use kb_core::account::{EmailPurpose, InviteCode};
use kb_core::model::Millis;
use kb_core::model::identity::{CodeLimits, IssueOutcome, MailLogEntry, NewInvite, VerifyOutcome};
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, Row, params};

use super::{SystemStore, new_id, now_millis};
use crate::sql::map_sqlite_error;

const INVITE_COLUMNS: &str = "id, prefix, created_by, note, max_uses, used, expires_at, role_id, quota_json, revoked_at, created_at, auto_friend";

fn map_invite(row: &Row<'_>) -> rusqlite::Result<InviteCode> {
    Ok(InviteCode {
        id: row.get(0)?,
        prefix: row.get(1)?,
        created_by: row.get(2)?,
        note: row.get(3)?,
        max_uses: row.get(4)?,
        used: row.get(5)?,
        expires_at: row.get(6)?,
        role_id: row.get(7)?,
        quota_json: row.get(8)?,
        revoked_at: row.get(9)?,
        created_at: row.get(10)?,
        auto_friend: row.get::<_, i64>(11)? != 0,
    })
}

/// 错误次数上限:超过这个次数验证码作废。
pub const MAX_CODE_ATTEMPTS: i64 = 5;

impl SystemStore {
    /// 读一个服务器私有的值;没有就用 `make` 生成并保存(pepper 用)。并发时只有一个会落库。
    pub async fn get_or_create_secret(
        &self,
        key: &str,
        make: impl FnOnce() -> String + Send + 'static,
    ) -> Result<String> {
        if let Some(existing) = self.get_setting(key).await? {
            return Ok(existing);
        }
        let key = key.to_owned();
        let candidate = make();
        self.write(move |conn| {
            conn.execute(
                "INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)",
                params![key, candidate],
            )
            .map_err(map_sqlite_error)?;
            conn.query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .map_err(map_sqlite_error)
        })
        .await
    }

    // ------------------------------------------------------------ 邮箱验证码

    /// 登记一个新验证码(先过限速)。旧的未用验证码同时作废:一个邮箱同一时刻只有最新一个有效。
    #[allow(clippy::too_many_arguments)]
    pub async fn issue_email_code(
        &self,
        email: &str,
        purpose: EmailPurpose,
        code_hash: &str,
        ip: Option<&str>,
        ttl_ms: i64,
        limits: CodeLimits,
        now: Millis,
    ) -> Result<IssueOutcome> {
        let email = email.to_owned();
        let code_hash = code_hash.to_owned();
        let ip = ip.map(str::to_owned);
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let purpose = purpose.as_str();
            let last: Option<i64> = tx
                .query_row(
                    "SELECT MAX(created_at) FROM email_codes WHERE email = ?1 AND purpose = ?2",
                    params![email, purpose],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            if let Some(last) = last
                && now - last < limits.min_gap_ms
            {
                return Ok(IssueOutcome::TooSoon {
                    wait_secs: ((limits.min_gap_ms - (now - last)) + 999) / 1000,
                });
            }
            let today: i64 = tx
                .query_row(
                    "SELECT COUNT(*) FROM email_codes WHERE email = ?1 AND created_at > ?2",
                    params![email, now - 24 * 3_600_000],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            if today >= limits.per_email_per_day {
                return Ok(IssueOutcome::EmailDailyLimit);
            }
            if let Some(ip) = &ip {
                let hour: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM email_codes WHERE ip = ?1 AND created_at > ?2",
                        params![ip, now - 3_600_000],
                        |row| row.get(0),
                    )
                    .map_err(map_sqlite_error)?;
                if hour >= limits.per_ip_per_hour {
                    return Ok(IssueOutcome::IpHourlyLimit);
                }
            }
            tx.execute(
                "UPDATE email_codes SET used_at = ?3 WHERE email = ?1 AND purpose = ?2 AND used_at IS NULL",
                params![email, purpose, now],
            )
            .map_err(map_sqlite_error)?;
            let id = new_id("ec_");
            tx.execute(
                "INSERT INTO email_codes (id, email, purpose, code_hash, ip, expires_at, created_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![id, email, purpose, code_hash, ip, now + ttl_ms, now],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(IssueOutcome::Issued { id })
        })
        .await
    }

    /// 校验验证码。不对就记一次错误,到 [`MAX_CODE_ATTEMPTS`] 次作废。对了**不**消耗:
    /// 注册还要建账号、占用户名,失败时用户不该被迫重新收一封邮件;建成功后再 [`Self::consume_email_code`]。
    pub async fn verify_email_code(
        &self,
        email: &str,
        purpose: EmailPurpose,
        candidate_hash: &str,
        now: Millis,
    ) -> Result<VerifyOutcome> {
        let email = email.to_owned();
        let candidate = candidate_hash.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let row: Option<(String, String, i64)> = tx
                .query_row(
                    "SELECT id, code_hash, attempts FROM email_codes \
                     WHERE email = ?1 AND purpose = ?2 AND used_at IS NULL AND expires_at > ?3 \
                     ORDER BY created_at DESC LIMIT 1",
                    params![email, purpose.as_str(), now],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            let Some((id, stored, attempts)) = row else {
                return Ok(VerifyOutcome::NoneValid);
            };
            if attempts >= MAX_CODE_ATTEMPTS {
                return Ok(VerifyOutcome::Locked);
            }
            if constant_time_eq(stored.as_bytes(), candidate.as_bytes()) {
                tx.commit().map_err(map_sqlite_error)?;
                return Ok(VerifyOutcome::Verified { id });
            }
            tx.execute(
                "UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?1",
                params![id],
            )
            .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            let left = MAX_CODE_ATTEMPTS - attempts - 1;
            Ok(if left <= 0 {
                VerifyOutcome::Locked
            } else {
                VerifyOutcome::Wrong {
                    attempts_left: left,
                }
            })
        })
        .await
    }

    /// 消耗验证码(用过即失效)。返回是否真的消耗了——并发的第二次返回 `false`。
    pub async fn consume_email_code(&self, id: &str, now: Millis) -> Result<bool> {
        let id = id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE email_codes SET used_at = ?2 WHERE id = ?1 AND used_at IS NULL",
                params![id, now],
            )
            .map(|changed| changed > 0)
            .map_err(map_sqlite_error)
        })
        .await
    }

    // --------------------------------------------------------------- 邀请码

    /// 新建邀请码。
    pub async fn create_invite(&self, new: NewInvite) -> Result<InviteCode> {
        if new.max_uses < 1 || new.max_uses > 10_000 {
            return Err(KbError::InvalidInput(
                "可用次数需要在 1–10000 之间".to_owned(),
            ));
        }
        serde_json::from_str::<serde_json::Value>(&new.quota_json)
            .map_err(|err| KbError::InvalidInput(format!("配额不是合法 JSON:{err}")))?;
        let id = new_id("inv_");
        let now = now_millis();
        self.write(move |conn| {
            if let Some(role) = &new.role_id {
                let exists: bool = conn
                    .query_row("SELECT 1 FROM roles WHERE id = ?1", params![role], |_| Ok(true))
                    .optional()
                    .map_err(map_sqlite_error)?
                    .unwrap_or(false);
                if !exists {
                    return Err(KbError::InvalidInput(format!("角色不存在:{role}")));
                }
            }
            conn.execute(
                "INSERT INTO invite_codes (id, code_hash, prefix, created_by, note, max_uses, expires_at, role_id, quota_json, created_at, auto_friend) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![id, new.code_hash, new.prefix, new.created_by, new.note, new.max_uses, new.expires_at, new.role_id, new.quota_json, now, i64::from(new.auto_friend)],
            )
            .map_err(map_sqlite_error)?;
            conn.query_row(
                &format!("SELECT {INVITE_COLUMNS} FROM invite_codes WHERE id = ?1"),
                params![id],
                map_invite,
            )
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 列出邀请码,新的在前;`created_by` 给定时只看这个人创建的。
    pub async fn list_invites(&self, created_by: Option<&str>) -> Result<Vec<InviteCode>> {
        let created_by = created_by.map(str::to_owned);
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {INVITE_COLUMNS} FROM invite_codes WHERE (?1 IS NULL OR created_by = ?1) ORDER BY created_at DESC, id"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt.query_map(params![created_by], map_invite).map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(map_sqlite_error)
        })
        .await
    }

    /// 撤销邀请码。`owner` 给定时只能撤销自己创建的。返回是否撤销了。
    pub async fn revoke_invite(&self, id: &str, owner: Option<&str>, at: Millis) -> Result<bool> {
        let id = id.to_owned();
        let owner = owner.map(str::to_owned);
        self.write(move |conn| {
            conn.execute(
                "UPDATE invite_codes SET revoked_at = ?3 WHERE id = ?1 AND revoked_at IS NULL AND (?2 IS NULL OR created_by = ?2)",
                params![id, owner, at],
            )
            .map(|changed| changed > 0)
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 只读地看一眼邀请码(注册页输入后立刻提示「邀请码无效」用,不占用次数)。
    pub async fn peek_invite(&self, code_hash: &str, now: Millis) -> Result<Option<InviteCode>> {
        let code_hash = code_hash.to_owned();
        self.read(move |conn| {
            Ok(conn
                .query_row(
                    &format!("SELECT {INVITE_COLUMNS} FROM invite_codes WHERE code_hash = ?1"),
                    params![code_hash],
                    map_invite,
                )
                .optional()
                .map_err(map_sqlite_error)?
                .filter(|invite| invite.usable(now)))
        })
        .await
    }

    /// 原子占用一次邀请码:有效且还有次数才成功。两个人同时用同一个单次码,只有一个拿到。
    pub async fn claim_invite(&self, code_hash: &str, now: Millis) -> Result<Option<InviteCode>> {
        let code_hash = code_hash.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let changed = tx
                .execute(
                    "UPDATE invite_codes SET used = used + 1 \
                     WHERE code_hash = ?1 AND revoked_at IS NULL AND used < max_uses AND (expires_at IS NULL OR expires_at > ?2)",
                    params![code_hash, now],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Ok(None);
            }
            let invite = tx
                .query_row(
                    &format!("SELECT {INVITE_COLUMNS} FROM invite_codes WHERE code_hash = ?1"),
                    params![code_hash],
                    map_invite,
                )
                .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(Some(invite))
        })
        .await
    }

    /// 归还一次占用(占用后建账号失败时用)。
    pub async fn release_invite(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.write(move |conn| {
            conn.execute(
                "UPDATE invite_codes SET used = MAX(used - 1, 0) WHERE id = ?1",
                params![id],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 记下谁用了哪个邀请码。
    pub async fn record_invite_use(
        &self,
        invite_id: &str,
        user_id: &str,
        ip: Option<&str>,
        at: Millis,
    ) -> Result<()> {
        let (invite_id, user_id, ip) = (
            invite_id.to_owned(),
            user_id.to_owned(),
            ip.map(str::to_owned),
        );
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO invite_uses (invite_id, user_id, ip, at) VALUES (?1, ?2, ?3, ?4)",
                params![invite_id, user_id, ip, at],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 一个邀请码的使用记录:`(用户 id, IP, 时间)`。
    pub async fn invite_uses(
        &self,
        invite_id: &str,
    ) -> Result<Vec<(String, Option<String>, Millis)>> {
        let invite_id = invite_id.to_owned();
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT user_id, ip, at FROM invite_uses WHERE invite_id = ?1 ORDER BY at DESC",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![invite_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)
        })
        .await
    }

    // --------------------------------------------------------------- 发信记录

    /// 记一条发信结果。
    pub async fn record_mail(
        &self,
        to: &str,
        kind: &str,
        ok: bool,
        via: Option<&str>,
        error: Option<&str>,
    ) -> Result<()> {
        let (to, kind, via, error) = (
            to.to_owned(),
            kind.to_owned(),
            via.map(str::to_owned),
            error.map(str::to_owned),
        );
        let at = now_millis();
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO mail_log (at, to_addr, kind, ok, via, error) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![at, to, kind, i64::from(ok), via, error],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 最近的发信记录,新的在前。
    pub async fn list_mail_log(&self, limit: u32) -> Result<Vec<MailLogEntry>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare("SELECT id, at, to_addr, kind, ok, via, error FROM mail_log ORDER BY id DESC LIMIT ?1")
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![limit.min(500)], |row| {
                    Ok(MailLogEntry {
                        id: row.get(0)?,
                        at: row.get(1)?,
                        to_addr: row.get(2)?,
                        kind: row.get(3)?,
                        ok: row.get::<_, i64>(4)? != 0,
                        via: row.get(5)?,
                        error: row.get(6)?,
                    })
                })
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>().map_err(map_sqlite_error)
        })
        .await
    }

    /// 某个时间点之后发出的邮件数(全站每分钟上限用)。
    pub async fn mails_since(&self, since: Millis) -> Result<i64> {
        self.read(move |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM mail_log WHERE at > ?1",
                params![since],
                |row| row.get(0),
            )
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 清理过期数据:验证码留 7 天(排查用),发信记录留 30 天。返回清掉的行数。
    pub async fn purge_registration_data(&self, now: Millis) -> Result<usize> {
        self.write(move |conn| {
            let codes = conn
                .execute(
                    "DELETE FROM email_codes WHERE created_at < ?1",
                    params![now - 7 * 86_400_000],
                )
                .map_err(map_sqlite_error)?;
            let logs = conn
                .execute(
                    "DELETE FROM mail_log WHERE at < ?1",
                    params![now - 30 * 86_400_000],
                )
                .map_err(map_sqlite_error)?;
            Ok(codes + logs)
        })
        .await
    }
}

/// 常量时间比较:不让比较耗时泄露「前几位对了」。
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}
