//! 密码哈希(argon2id）。
//!
//! 只通过 CLI 设置(`kb auth set-password` → UDS → 守护进程写 `settings.password_hash`),
//! 哈希里带随机盐,存的是 PHC 字符串,日志里绝不出现明文。

use argon2::Argon2;
use argon2::password_hash::PasswordHasher;
use argon2::password_hash::PasswordVerifier;
use argon2::password_hash::phc::PasswordHash;
use kb_core::{KbError, Result};

/// 密码最小长度。
pub const MIN_LEN: usize = 8;

/// 计算 argon2id 哈希(PHC 字符串)。
pub fn hash_password(password: &str) -> Result<String> {
    if password.chars().count() < MIN_LEN {
        return Err(KbError::InvalidInput(format!("密码至少 {MIN_LEN} 个字符")));
    }
    let hash = Argon2::default()
        .hash_password(password.as_bytes())
        .map_err(|err| KbError::Internal(format!("argon2 哈希失败: {err}")))?;
    Ok(hash.to_string())
}

/// 哈希一个**没有长度策略**的口令(分享链接的访问密码是 4–12 位,比账号密码短,
/// 长度规则由调用方自己检查)。盐和参数与账号密码完全一样。
pub fn hash_secret(secret: &str) -> Result<String> {
    let hash = Argon2::default()
        .hash_password(secret.as_bytes())
        .map_err(|err| KbError::Internal(format!("argon2 哈希失败: {err}")))?;
    Ok(hash.to_string())
}

/// 校验密码;哈希串损坏时返回 `false`(不泄露原因)。
pub fn verify_password(password: &str, stored: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(stored) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_secrets_can_be_hashed_without_the_account_password_policy() {
        assert!(hash_password("abcd").is_err(), "账号密码仍然要求 8 位");
        let stored = hash_secret("abcd").expect("链接密码 4 位也能哈希");
        assert!(verify_password("abcd", &stored));
        assert!(!verify_password("abce", &stored));
    }

    #[test]
    fn hashes_are_salted_and_verify() {
        let a = hash_password("correct horse battery").expect("哈希");
        let b = hash_password("correct horse battery").expect("哈希");
        assert_ne!(a, b, "同一密码两次哈希应不同(随机盐)");
        assert!(a.starts_with("$argon2id$"), "应是 argon2id:{a}");
        assert!(verify_password("correct horse battery", &a));
        assert!(!verify_password("wrong password", &a));
    }

    #[test]
    fn short_passwords_are_rejected() {
        let err = hash_password("short").expect_err("太短应被拒");
        assert!(matches!(err, KbError::InvalidInput(_)), "{err:?}");
    }

    #[test]
    fn broken_hash_never_verifies() {
        assert!(!verify_password("x", "not-a-phc-string"));
        assert!(!verify_password("x", ""));
    }
}
