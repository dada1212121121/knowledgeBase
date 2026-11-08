//! 极简百分号编码(HTTP 头只能放可见 ASCII,中文路径必须编码)。
//!
//! 只用于 `X-KB-Cwd` / `X-KB-Project` / `X-KB-Client` 这类自定义头,
//! 不是通用的 URL 编解码。

/// 把字符串编码成只含可见 ASCII 的形式(非 ASCII 与 `%` 转成 `%XX`)。
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_graphic() && *byte != b'%' {
            out.push(*byte as char);
        } else if *byte == b' ' {
            out.push_str("%20");
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 严格解码:遇到非法的 `%XX` 或非 UTF-8 时返回错误(HTTP 入口用)。
pub fn decode_strict(value: &str) -> std::result::Result<String, String> {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            // 用 get 而不是切片:`%` 后面紧跟多字节字符时不能按字节切
            let hex = value
                .get(index + 1..index + 3)
                .ok_or_else(|| format!("截断的百分号编码:{value}"))?;
            if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(format!("非法的百分号编码 %{hex}"));
            }
            let byte =
                u8::from_str_radix(hex, 16).map_err(|_| format!("非法的百分号编码 %{hex}"))?;
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).map_err(|_| format!("解码结果不是合法 UTF-8:{value}"))
}

/// 解码;格式不对时原样返回(宽容,不报错)。
pub fn decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(hex) = value.get(index + 1..index + 3)
            && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chinese_paths_round_trip() {
        let path = "/srv/workspace/项目 中文";
        let encoded = encode(path);
        assert!(encoded.is_ascii(), "{encoded}");
        assert!(!encoded.contains(' '));
        assert_eq!(decode(&encoded), path);
    }

    #[test]
    fn ascii_paths_stay_readable() {
        assert_eq!(encode("/srv/workspace/demo"), "/srv/workspace/demo");
        assert_eq!(decode("/srv/workspace/demo"), "/srv/workspace/demo");
    }

    #[test]
    fn percent_followed_by_non_ascii_does_not_panic() {
        assert!(decode_strict("%中x").is_err());
        let _ = decode("%中x");
    }

    #[test]
    fn strict_decode_rejects_bad_sequences() {
        assert_eq!(decode_strict("/a%20b").as_deref(), Ok("/a b"));
        assert!(decode_strict("%zz").is_err());
        assert!(decode_strict("100%").is_err());
        // `%+1` 不是合法转义(`from_str_radix` 会接受前导 `+`,必须自己挡掉)
        assert!(decode_strict("/tmp/x%+1").is_err());
        // 十六进制合法但解码后不是 UTF-8
        assert!(decode_strict("%FF").is_err());
    }

    #[test]
    fn bad_sequences_are_passed_through() {
        assert_eq!(decode("100%"), "100%");
        assert_eq!(decode("%zz"), "%zz");
    }
}
