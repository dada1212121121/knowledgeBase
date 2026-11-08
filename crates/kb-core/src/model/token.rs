//! 本机会话与 API 令牌。
//!
//! 由 `model.rs` 拆出:路径不变,入口仍是 `kb_core::model`。
use super::Millis;
use serde::{Deserialize, Serialize};

/// `sessions` 表:Web 会话。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Session {
    /// 令牌的 sha256。
    pub token_hash: String,
    /// 创建时间。
    pub created_at: Millis,
    /// 过期时间。
    pub expires_at: Millis,
    /// 最近访问时间。
    pub last_seen: Millis,
    /// User-Agent。
    pub user_agent: Option<String>,
}

/// `api_tokens` 表:Bearer 令牌。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ApiToken {
    /// 主键。
    pub id: String,
    /// 名字。
    pub name: String,
    /// 令牌的 sha256。
    pub token_hash: String,
    /// `mcp` 或 `api`。
    pub scopes: String,
    /// 创建时间。
    pub created_at: Millis,
    /// 最近使用时间。
    pub last_used: Option<Millis>,
    /// 撤销时间。
    pub revoked_at: Option<Millis>,
}
