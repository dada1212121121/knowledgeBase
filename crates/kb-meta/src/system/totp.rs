//! 两步验证(TOTP)的存取。算法在 `kb_core::totp`;这里只管状态,并且把「防重放」做成原子操作。

use kb_core::model::Millis;
use kb_core::model::identity::TotpState;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};

use super::SystemStore;
use crate::sql::map_sqlite_error;

impl SystemStore {
    /// 开始设置:存下一个**待确认**的密钥(覆盖之前没确认完的)。已经开启的要先关掉。
    pub async fn begin_totp(&self, user_id: &str, secret_b32: &str, now: Millis) -> Result<()> {
        let (user_id, secret) = (user_id.to_owned(), secret_b32.to_owned());
        self.write(move |conn| {
            let confirmed: Option<bool> = conn
                .query_row(
                    "SELECT confirmed_at IS NOT NULL FROM user_totp WHERE user_id = ?1",
                    params![user_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            if confirmed == Some(true) {
                return Err(KbError::Exists(
                    "已经开启了两步验证,要重新设置请先关闭".to_owned(),
                ));
            }
            conn.execute(
                "INSERT INTO user_totp (user_id, secret_b32, confirmed_at, last_step, created_at) \
                 VALUES (?1, ?2, NULL, NULL, ?3) \
                 ON CONFLICT(user_id) DO UPDATE SET secret_b32 = excluded.secret_b32, \
                 confirmed_at = NULL, last_step = NULL, created_at = excluded.created_at",
                params![user_id, secret, now],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 读状态;从没设置过返回 `None`。
    pub async fn totp_state(&self, user_id: &str) -> Result<Option<TotpState>> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT secret_b32, confirmed_at IS NOT NULL, last_step FROM user_totp WHERE user_id = ?1",
                params![user_id],
                |row| {
                    Ok(TotpState {
                        secret_b32: row.get(0)?,
                        confirmed: row.get::<_, i64>(1)? != 0,
                        last_step: row.get::<_, Option<i64>>(2)?.map(|step| step.max(0) as u64),
                    })
                },
            )
            .optional()
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 是否已经正式开启(登录时每次都问,所以单独一个轻量查询)。
    pub async fn totp_enabled(&self, user_id: &str) -> Result<bool> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM user_totp WHERE user_id = ?1 AND confirmed_at IS NOT NULL",
                params![user_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count > 0)
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 第一个码验证通过:正式开启,记下这一步(防重放),并换上一批恢复码(只存哈希)。
    /// 已经开启的(重复确认)返回 `Exists`,待确认的才行。
    pub async fn confirm_totp(
        &self,
        user_id: &str,
        step: u64,
        recovery_hashes: &[String],
        now: Millis,
    ) -> Result<()> {
        let (user_id, hashes) = (user_id.to_owned(), recovery_hashes.to_vec());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let changed = tx
                .execute(
                    "UPDATE user_totp SET confirmed_at = ?2, last_step = ?3 \
                     WHERE user_id = ?1 AND confirmed_at IS NULL",
                    params![user_id, now, step as i64],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::Exists(
                    "没有待确认的两步验证设置(或者已经开启了)".to_owned(),
                ));
            }
            replace_recovery(&tx, &user_id, &hashes)?;
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }

    /// 占用一个时间步:成功返回 `true`;这一步(或更晚的)已经被用过则 `false`。
    /// 是一条带条件的 UPDATE,两个并发请求拿同一个码,只有一个能成功。
    pub async fn claim_totp_step(&self, user_id: &str, step: u64) -> Result<bool> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE user_totp SET last_step = ?2 \
                     WHERE user_id = ?1 AND confirmed_at IS NOT NULL \
                     AND (last_step IS NULL OR last_step < ?2)",
                    params![user_id, step as i64],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed == 1)
        })
        .await
    }

    /// 用掉一个恢复码:成功返回 `true`;不存在或已经用过 `false`。
    pub async fn use_recovery_code(
        &self,
        user_id: &str,
        code_hash: &str,
        now: Millis,
    ) -> Result<bool> {
        let (user_id, hash) = (user_id.to_owned(), code_hash.to_owned());
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE user_recovery_codes SET used_at = ?3 \
                     WHERE user_id = ?1 AND code_hash = ?2 AND used_at IS NULL",
                    params![user_id, hash, now],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed == 1)
        })
        .await
    }

    /// 还剩几个没用过的恢复码。
    pub async fn recovery_codes_left(&self, user_id: &str) -> Result<u32> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM user_recovery_codes WHERE user_id = ?1 AND used_at IS NULL",
                params![user_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|count| count.max(0) as u32)
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 重新生成恢复码(旧的全部作废)。
    pub async fn replace_recovery_codes(&self, user_id: &str, hashes: &[String]) -> Result<()> {
        let (user_id, hashes) = (user_id.to_owned(), hashes.to_vec());
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            replace_recovery(&tx, &user_id, &hashes)?;
            tx.commit().map_err(map_sqlite_error)
        })
        .await
    }

    /// 关闭两步验证(自己输对密码和验证码后关,或管理员替用户重置)。返回原来有没有开着。
    pub async fn disable_totp(&self, user_id: &str) -> Result<bool> {
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            tx.execute(
                "DELETE FROM user_recovery_codes WHERE user_id = ?1",
                params![user_id],
            )
            .map_err(map_sqlite_error)?;
            let removed = tx
                .execute("DELETE FROM user_totp WHERE user_id = ?1", params![user_id])
                .map_err(map_sqlite_error)?;
            tx.commit().map_err(map_sqlite_error)?;
            Ok(removed > 0)
        })
        .await
    }
}

fn replace_recovery(
    tx: &rusqlite::Transaction<'_>,
    user_id: &str,
    hashes: &[String],
) -> Result<()> {
    tx.execute(
        "DELETE FROM user_recovery_codes WHERE user_id = ?1",
        params![user_id],
    )
    .map_err(map_sqlite_error)?;
    for hash in hashes {
        tx.execute(
            "INSERT INTO user_recovery_codes (user_id, code_hash, used_at) VALUES (?1, ?2, NULL)",
            params![user_id, hash],
        )
        .map_err(map_sqlite_error)?;
    }
    Ok(())
}
