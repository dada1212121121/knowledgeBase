//! 令牌生成与哈希。
//!
//! 实现在 `kb_core::token`(会话令牌与 API 令牌共用),这里只做本 crate 的别名与常量。

pub use kb_core::token::{ADMIN_KEY_PREFIX, TOKEN_PREFIX, random_secret, sha256_hex};

/// 会话 cookie 名。
pub const SESSION_COOKIE: &str = "kb_session";

/// 会话有效期:7 天。
pub const SESSION_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_helpers_come_from_kb_core() {
        assert_eq!(TOKEN_PREFIX, "kb_");
        assert_eq!(sha256_hex("abc").len(), 64);
        assert_ne!(random_secret(), random_secret());
    }
}
