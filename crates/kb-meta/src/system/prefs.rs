//! 用户界面偏好(侧栏状态、密度等)。
//!
//! 服务端只存一个 JSON 对象,**不解释里面的键**:界面怎么演进都不用动后端。
//! 能管的只有形状与大小:必须是对象、序列化后不超过 [`MAX_PREFS_BYTES`],
//! 否则一个人可以把账号库当网盘用。

use kb_core::model::Millis;
use kb_core::{KbError, Result};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use super::SystemStore;
use crate::sql::map_sqlite_error;

/// 偏好序列化后的字节上限。
pub const MAX_PREFS_BYTES: usize = 8 * 1024;

impl SystemStore {
    /// 读一个人的偏好;从没存过返回空对象。
    pub async fn get_prefs(&self, user_id: &str) -> Result<Value> {
        let user_id = user_id.to_owned();
        self.read(move |conn| {
            let text: Option<String> = conn
                .query_row(
                    "SELECT json FROM user_prefs WHERE user_id = ?1",
                    params![user_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite_error)?;
            // 库里的内容只会来自 set_prefs;万一被手工改坏,给空对象也比让整个页面起不来强
            Ok(text
                .and_then(|text| serde_json::from_str::<Value>(&text).ok())
                .filter(Value::is_object)
                .unwrap_or_else(|| Value::Object(Default::default())))
        })
        .await
    }

    /// 整体替换一个人的偏好。不是对象或超过大小上限返回 `InvalidInput`。
    pub async fn set_prefs(&self, user_id: &str, prefs: &Value, now: Millis) -> Result<()> {
        if !prefs.is_object() {
            return Err(KbError::InvalidInput("偏好必须是一个 JSON 对象".to_owned()));
        }
        let text = serde_json::to_string(prefs)
            .map_err(|err| KbError::InvalidInput(format!("偏好无法序列化:{err}")))?;
        if text.len() > MAX_PREFS_BYTES {
            return Err(KbError::InvalidInput(format!(
                "偏好太大了(最多 {} KB)",
                MAX_PREFS_BYTES / 1024
            )));
        }
        let user_id = user_id.to_owned();
        self.write(move |conn| {
            // 用户不存在时外键会拒绝;换成一句人话
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM users WHERE id = ?1",
                    params![user_id],
                    |_| Ok(true),
                )
                .optional()
                .map_err(map_sqlite_error)?
                .unwrap_or(false);
            if !exists {
                return Err(KbError::NotFound(format!("用户 {user_id}")));
            }
            conn.execute(
                "INSERT INTO user_prefs (user_id, json, updated_at) VALUES (?1, ?2, ?3) \
                 ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at",
                params![user_id, text, now],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }
}
