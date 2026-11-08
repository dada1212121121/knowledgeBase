//! 两步验证(TOTP,RFC 6238):和 Google Authenticator、微软验证器、1Password 等通用。
//!
//! 参数取各验证器 App 的通用默认值:HMAC-SHA1、6 位数字、30 秒一步。
//! 这里只有纯计算,不碰存储和网络;防重放(同一个码只能用一次)靠调用方记下已用过的最大步数。

use data_encoding::BASE32_NOPAD;
use rand::RngCore;
use sha1::{Digest, Sha1};

/// 每一步的秒数。
pub const STEP_SECS: u64 = 30;
/// 验证码位数。
pub const DIGITS: u32 = 6;
/// 允许的时钟误差(前后各几步)。±1 步 = 手机和服务器差 30 秒内都能通过。
pub const WINDOW: i64 = 1;
/// 密钥字节数(160 位,RFC 4226 建议值)。
pub const SECRET_BYTES: usize = 20;
/// 一次生成多少个恢复码。
pub const RECOVERY_CODES: usize = 8;

/// 随机密钥。
pub fn generate_secret() -> Vec<u8> {
    let mut bytes = vec![0u8; SECRET_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    bytes
}

/// 密钥的 base32 文本(无填充、大写),验证器 App 手动输入用这个。
pub fn secret_to_base32(secret: &[u8]) -> String {
    BASE32_NOPAD.encode(secret)
}

/// base32 文本 → 密钥。容忍空格和小写(用户从界面抄下来常带空格)。
pub fn secret_from_base32(text: &str) -> Option<Vec<u8>> {
    let cleaned: String = text
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    BASE32_NOPAD.decode(cleaned.as_bytes()).ok()
}

/// HMAC-SHA1(RFC 2104)。
fn hmac_sha1(key: &[u8], message: &[u8]) -> [u8; 20] {
    const BLOCK: usize = 64;
    let mut block = [0u8; BLOCK];
    if key.len() > BLOCK {
        block[..20].copy_from_slice(&Sha1::digest(key));
    } else {
        block[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha1::new();
    inner.update(block.map(|b| b ^ 0x36));
    inner.update(message);
    let inner = inner.finalize();
    let mut outer = Sha1::new();
    outer.update(block.map(|b| b ^ 0x5c));
    outer.update(inner);
    outer.finalize().into()
}

/// 第 `step` 步的验证码(补零到 6 位)。
pub fn code_at(secret: &[u8], step: u64) -> String {
    let mac = hmac_sha1(secret, &step.to_be_bytes());
    // RFC 4226 动态截断
    let offset = (mac[19] & 0x0f) as usize;
    let binary = (u32::from(mac[offset] & 0x7f) << 24)
        | (u32::from(mac[offset + 1]) << 16)
        | (u32::from(mac[offset + 2]) << 8)
        | u32::from(mac[offset + 3]);
    format!(
        "{:0width$}",
        binary % 10u32.pow(DIGITS),
        width = DIGITS as usize
    )
}

/// 某一时刻(Unix 秒)所在的步。
pub fn step_of(unix_secs: u64) -> u64 {
    unix_secs / STEP_SECS
}

/// 常量时间比较两段文本(验证码长度固定,但仍不提前返回)。
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// 校验用户输入的验证码。
///
/// - 只接受 6 位数字(用户可能带空格,会去掉);
/// - 在当前步前后各 [`WINDOW`] 步内找匹配;
/// - **防重放**:匹配到的步必须大于 `last_used_step`(上一次成功用掉的步),否则同一个码在 30~90 秒内
///   可以被反复使用(肩窥、抓包);
/// - 成功返回匹配的步,调用方把它记下来作为新的 `last_used_step`。
pub fn verify(
    secret: &[u8],
    input: &str,
    now_unix_secs: u64,
    last_used_step: Option<u64>,
) -> Option<u64> {
    let digits: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    if digits.len() != DIGITS as usize || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let current = step_of(now_unix_secs) as i64;
    let mut matched = None;
    // 不提前返回:每次都把窗口里的几个步全算一遍,耗时与是否命中无关
    for delta in -WINDOW..=WINDOW {
        let step = current + delta;
        if step < 0 {
            continue;
        }
        let step = step as u64;
        if constant_time_eq(&code_at(secret, step), &digits) && matched.is_none() {
            matched = Some(step);
        }
    }
    matched.filter(|step| last_used_step.is_none_or(|used| *step > used))
}

/// 给验证器 App 扫的 `otpauth://` 地址(二维码内容)。
pub fn otpauth_uri(issuer: &str, account: &str, secret: &[u8]) -> String {
    let encode = |text: &str| -> String {
        text.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                    (b as char).to_string()
                }
                other => format!("%{other:02X}"),
            })
            .collect()
    };
    format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm=SHA1&digits={DIGITS}&period={STEP_SECS}",
        encode(issuer),
        encode(account),
        secret_to_base32(secret),
        encode(issuer)
    )
}

/// 恢复码字母表:去掉容易看错的 0/O、1/I/L。
const RECOVERY_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/// 生成一批恢复码,形如 `ABCD-EFGH-JKMN`(12 个字符,约 59 位熵)。明文只给用户看一次。
pub fn generate_recovery_codes() -> Vec<String> {
    let mut rng = rand::rng();
    (0..RECOVERY_CODES)
        .map(|_| {
            let mut raw = [0u8; 12];
            rng.fill_bytes(&mut raw);
            let chars: Vec<char> = raw
                .iter()
                .map(|b| RECOVERY_ALPHABET[(*b as usize) % RECOVERY_ALPHABET.len()] as char)
                .collect();
            format!(
                "{}-{}-{}",
                chars[0..4].iter().collect::<String>(),
                chars[4..8].iter().collect::<String>(),
                chars[8..12].iter().collect::<String>()
            )
        })
        .collect()
}

/// 把用户输入的恢复码规整成存储形式(去空格 / 连字符、转大写);形状不对返回 `None`。
pub fn normalize_recovery_code(input: &str) -> Option<String> {
    let cleaned: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (cleaned.len() == 12 && cleaned.bytes().all(|b| RECOVERY_ALPHABET.contains(&b)))
        .then_some(cleaned)
}

/// 是不是像恢复码(用来区分用户在验证码输入框里填的是 6 位码还是恢复码)。
pub fn looks_like_recovery_code(input: &str) -> bool {
    normalize_recovery_code(input).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 附录 B 的测试向量(SHA1,密钥 "12345678901234567890";取末 6 位)。
    #[test]
    fn matches_the_rfc_6238_test_vectors() {
        let secret = b"12345678901234567890";
        for (time, expected) in [
            (59u64, "287082"),
            (1_111_111_109, "081804"),
            (1_111_111_111, "050471"),
            (1_234_567_890, "005924"),
            (2_000_000_000, "279037"),
            (20_000_000_000, "353130"),
        ] {
            assert_eq!(code_at(secret, step_of(time)), expected, "t={time}");
        }
    }

    /// RFC 4226 附录 D 的 HOTP 测试向量(计数 0~9)。
    #[test]
    fn matches_the_rfc_4226_test_vectors() {
        let secret = b"12345678901234567890";
        let expected = [
            "755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583",
            "399871", "520489",
        ];
        for (counter, code) in expected.iter().enumerate() {
            assert_eq!(code_at(secret, counter as u64), *code);
        }
    }

    #[test]
    fn verification_accepts_one_step_of_clock_drift_and_nothing_more() {
        let secret = generate_secret();
        let now = 1_700_000_000u64;
        let step = step_of(now);
        for (delta, ok) in [(-2i64, false), (-1, true), (0, true), (1, true), (2, false)] {
            let code = code_at(&secret, (step as i64 + delta) as u64);
            assert_eq!(
                verify(&secret, &code, now, None).is_some(),
                ok,
                "delta={delta}"
            );
        }
        // 输入里的空格不碍事;不是 6 位数字的一律不过
        let code = code_at(&secret, step);
        assert!(
            verify(
                &secret,
                &format!("{} {}", &code[..3], &code[3..]),
                now,
                None
            )
            .is_some()
        );
        for bad in ["", "12345", "1234567", "abcdef", "12 34 5x"] {
            assert!(verify(&secret, bad, now, None).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn a_code_cannot_be_used_twice_and_older_codes_stay_dead() {
        let secret = generate_secret();
        let now = 1_700_000_000u64;
        let step = step_of(now);
        let code = code_at(&secret, step);
        let used = verify(&secret, &code, now, None).expect("第一次通过");
        assert_eq!(used, step);
        assert!(
            verify(&secret, &code, now, Some(used)).is_none(),
            "同一个码不能再用"
        );
        // 前一步的码在记下 `step` 之后也不能用(回退到更旧的码)
        let older = code_at(&secret, step - 1);
        assert!(verify(&secret, &older, now, Some(used)).is_none());
        // 下一步的码可以
        let later = code_at(&secret, step + 1);
        assert_eq!(verify(&secret, &later, now, Some(used)), Some(step + 1));
    }

    #[test]
    fn secrets_round_trip_through_base32_and_tolerate_how_people_copy_them() {
        let secret = generate_secret();
        let text = secret_to_base32(&secret);
        assert_eq!(text.len(), 32, "20 字节 = 32 个 base32 字符");
        assert_eq!(secret_from_base32(&text), Some(secret.clone()));
        let spaced = text
            .as_bytes()
            .chunks(4)
            .map(|chunk| std::str::from_utf8(chunk).unwrap().to_ascii_lowercase())
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(secret_from_base32(&spaced), Some(secret));
        assert_eq!(secret_from_base32("not base32 !!"), None);
        assert_ne!(generate_secret(), generate_secret());
    }

    #[test]
    fn the_otpauth_uri_has_everything_an_authenticator_needs() {
        let uri = otpauth_uri("知识库 Demo", "alice@example.com", b"12345678901234567890");
        assert!(uri.starts_with("otpauth://totp/"), "{uri}");
        assert!(
            uri.contains("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"),
            "{uri}"
        );
        assert!(
            uri.contains("digits=6") && uri.contains("period=30") && uri.contains("algorithm=SHA1")
        );
        assert!(
            uri.contains("alice%40example.com"),
            "账号里的 @ 要转义:{uri}"
        );
        assert!(!uri.contains(' ') && !uri.contains('知'), "{uri}");
    }

    #[test]
    fn recovery_codes_are_distinct_readable_and_normalize_from_sloppy_input() {
        let codes = generate_recovery_codes();
        assert_eq!(codes.len(), RECOVERY_CODES);
        let mut sorted = codes.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), RECOVERY_CODES, "不重复");
        for code in &codes {
            assert_eq!(code.len(), 14, "{code}");
            assert!(
                !code.contains(['0', 'O', '1', 'I', 'L']),
                "容易看错的字符不出现:{code}"
            );
            assert_eq!(normalize_recovery_code(code).unwrap().len(), 12);
            assert_eq!(
                normalize_recovery_code(&code.to_ascii_lowercase().replace('-', " ")),
                normalize_recovery_code(code)
            );
        }
        assert!(normalize_recovery_code("ABCD").is_none());
        assert!(normalize_recovery_code("0000-1111-OOOO").is_none());
        assert!(looks_like_recovery_code(&codes[0]));
        assert!(!looks_like_recovery_code("123456"));
    }
}
