//! 按用户记账的 LLM 用量(`llm_user_usage`),以及给外发闸门用的 [`UserLlmLedger`] 实现。

use std::sync::Arc;

use async_trait::async_trait;
use kb_core::config::ConfigStore;
use kb_core::model::identity::UserLlmUsage;
use kb_core::ports::UserLlmLedger;
use kb_core::{KbError, Result};
use rusqlite::params;

use super::SystemStore;
use crate::sql::map_sqlite_error;

impl SystemStore {
    /// 累加一次调用。同一个人同一天同一用途合并成一行。
    pub async fn add_llm_usage(
        &self,
        user_id: &str,
        day: &str,
        purpose: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<()> {
        let (user_id, day, purpose) = (user_id.to_owned(), day.to_owned(), purpose.to_owned());
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO llm_user_usage (user_id, day, purpose, calls, input_tokens, output_tokens) \
                 VALUES (?1, ?2, ?3, 1, ?4, ?5) \
                 ON CONFLICT(user_id, day, purpose) DO UPDATE SET \
                   calls = calls + 1, \
                   input_tokens = input_tokens + excluded.input_tokens, \
                   output_tokens = output_tokens + excluded.output_tokens",
                params![user_id, day, purpose, input_tokens as i64, output_tokens as i64],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// `[first_day, last_day]`(含,`YYYY-MM-DD`)里每天每个用途全站合计的 token:`(day, purpose, calls, 输入, 输出)`。
    /// 日期是字符串比较,所以必须是规整的 `YYYY-MM-DD`(调用方校验)。管理员的 AI 用量趋势图用。
    pub async fn llm_usage_series(
        &self,
        first_day: &str,
        last_day: &str,
    ) -> Result<Vec<(String, String, u64, u64, u64)>> {
        let (first, last) = (first_day.to_owned(), last_day.to_owned());
        self.read(move |conn| {
            conn.prepare(
                "SELECT day, purpose, SUM(calls), SUM(input_tokens), SUM(output_tokens) FROM llm_user_usage \
                 WHERE day >= ?1 AND day <= ?2 GROUP BY day, purpose ORDER BY day, purpose",
            )
            .map_err(map_sqlite_error)?
            .query_map(params![first, last], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)? as u64, row.get::<_, i64>(3)? as u64, row.get::<_, i64>(4)? as u64))
            })
            .map_err(map_sqlite_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(map_sqlite_error)
        })
        .await
    }

    /// 一个人某天用掉的 token(输入 + 输出,所有用途合计)。
    pub async fn llm_tokens_on(&self, user_id: &str, day: &str) -> Result<u64> {
        let (user_id, day) = (user_id.to_owned(), day.to_owned());
        self.read(move |conn| {
            let total: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM llm_user_usage \
                     WHERE user_id = ?1 AND day = ?2",
                    params![user_id, day],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            Ok(total.max(0) as u64)
        })
        .await
    }

    /// 某天按用户合计的用量,用得多的在前,最多 `limit` 个。
    pub async fn llm_usage_ranking(&self, day: &str, limit: u32) -> Result<Vec<UserLlmUsage>> {
        let day = day.to_owned();
        self.read(move |conn| {
            let mut statement = conn
                .prepare(
                    "SELECT user_id, SUM(calls), SUM(input_tokens), SUM(output_tokens) \
                     FROM llm_user_usage WHERE day = ?1 GROUP BY user_id \
                     ORDER BY SUM(input_tokens + output_tokens) DESC, user_id LIMIT ?2",
                )
                .map_err(map_sqlite_error)?;
            let rows = statement
                .query_map(params![day, limit], |row| {
                    Ok(UserLlmUsage {
                        user_id: row.get(0)?,
                        calls: row.get::<_, i64>(1)?.max(0) as u64,
                        input_tokens: row.get::<_, i64>(2)?.max(0) as u64,
                        output_tokens: row.get::<_, i64>(3)?.max(0) as u64,
                    })
                })
                .map_err(map_sqlite_error)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()
                .map_err(map_sqlite_error)
        })
        .await
    }

    /// 删掉 `before_day`(不含)之前的用量行,账本不无限增长。
    pub async fn purge_llm_usage_before(&self, before_day: &str) -> Result<usize> {
        let before_day = before_day.to_owned();
        self.write(move |conn| {
            conn.execute(
                "DELETE FROM llm_user_usage WHERE day < ?1",
                params![before_day],
            )
            .map_err(map_sqlite_error)
        })
        .await
    }
}

/// 把账号库 + 全站配置接成外发闸门用的账本:额度 = 全站默认 → 角色 → 用户例外,每次现取。
pub struct SystemLlmLedger {
    system: Arc<SystemStore>,
    config: Arc<ConfigStore>,
}

impl SystemLlmLedger {
    /// 构造。
    pub fn new(system: Arc<SystemStore>, config: Arc<ConfigStore>) -> Arc<Self> {
        Arc::new(Self { system, config })
    }
}

#[async_trait]
impl UserLlmLedger for SystemLlmLedger {
    async fn daily_limit(&self, user_id: &str) -> Result<u64> {
        let defaults = self.config.get().quota.clone();
        match self.system.effective_quota(user_id, &defaults).await {
            Ok(quota) => Ok(quota.llm_tokens_per_day),
            // 账号已不存在(比如刚被清理):不要放行一个查不到额度的人
            Err(KbError::NotFound(_)) => Err(KbError::Forbidden("账号不可用".to_owned())),
            Err(err) => Err(err),
        }
    }

    async fn used_on(&self, user_id: &str, day: &str) -> Result<u64> {
        self.system.llm_tokens_on(user_id, day).await
    }

    async fn record(
        &self,
        user_id: &str,
        day: &str,
        purpose: &str,
        input_tokens: u64,
        output_tokens: u64,
    ) -> Result<()> {
        self.system
            .add_llm_usage(user_id, day, purpose, input_tokens, output_tokens)
            .await
    }
}
