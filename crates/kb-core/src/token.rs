//! 令牌生成与哈希(会话令牌、API 令牌共用)。
//!
//! 明文只在创建时返回一次,库里只存 sha256 十六进制。

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use sha2::{Digest, Sha256};

/// API 令牌前缀(便于在日志 / 配置里识别)。
pub const TOKEN_PREFIX: &str = "kb_";

/// 用户 admin key 的前缀。以 `kb_` 开头,所以任何只看前缀的地方(日志脱敏、Bearer 识别)都当它是令牌;
/// 鉴权时靠 `kb_ak_` 区分它和普通 API 令牌。
pub const ADMIN_KEY_PREFIX: &str = "kb_ak_";

/// 生成一个 admin key:`kb_ak_` + 48 位十六进制(24 字节随机)。
///
/// 用十六进制而不是 base64:迁移里给老用户补发时只能用 SQLite 的 `randomblob` + `hex`,两处格式要一致。
pub fn new_admin_key() -> String {
    let mut bytes = [0u8; 24];
    rand::rng().fill_bytes(&mut bytes);
    let mut out = String::with_capacity(ADMIN_KEY_PREFIX.len() + 48);
    out.push_str(ADMIN_KEY_PREFIX);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 32 字节随机令牌(base64url,无填充)。
pub fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// sha256 十六进制(令牌只存这个)。
pub fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_unique_and_url_safe() {
        let a = random_secret();
        let b = random_secret();
        assert_ne!(a, b);
        assert_eq!(a.len(), 43, "32 字节 base64url 无填充是 43 字符");
        assert!(
            a.chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'),
            "只应含 URL 安全字符:{a}"
        );
    }

    #[test]
    fn admin_keys_have_the_prefix_and_are_unique() {
        let a = new_admin_key();
        assert!(a.starts_with(ADMIN_KEY_PREFIX));
        assert!(a.starts_with(TOKEN_PREFIX), "要被当作 Bearer 令牌识别");
        assert_eq!(a.len(), ADMIN_KEY_PREFIX.len() + 48);
        assert!(
            a[ADMIN_KEY_PREFIX.len()..]
                .chars()
                .all(|ch| ch.is_ascii_hexdigit())
        );
        assert_ne!(a, new_admin_key());
    }

    #[test]
    fn hashes_are_stable_hex() {
        assert_eq!(sha256_hex("abc").len(), 64);
        assert_eq!(
            sha256_hex("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
