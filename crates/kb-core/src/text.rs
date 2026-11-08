//! 文本纯逻辑:token 估算与标识符拆分（设计规范）。
//!
//! - token 估算:`cjk 字符数 + ceil(其余非空白字符数 / 4)`。用于控制分块大小与
//!   `embed.max_tokens` 截断,不追求与真实分词器完全一致。
//! - 标识符拆分:`embedQuery` → `embed query`,`HTTPServerConfig` → `http server config`。
//!   结果进入 LanceDB 的 `lex` 列,让驼峰式标识符也能被全文检索命中。

use std::collections::HashSet;
use std::sync::LazyLock;

use regex::Regex;

/// 候选标识符:首字符是字母或下划线,后续是字母数字下划线,总长至少 3。
static IDENT_RE: LazyLock<Regex> = LazyLock::new(|| {
    // 模式是字面量常量,编译不会失败
    Regex::new(r"[A-Za-z_][A-Za-z0-9_]{2,}").expect("内置标识符正则必须合法")
});

/// 估算 token 数:`cjk 字符数 + ceil(其余非空白字符数 / 4)`。
pub fn estimate_tokens(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for ch in text.chars() {
        if ch.is_whitespace() {
            continue;
        }
        if is_cjk(ch) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + other.div_ceil(4)
}

/// 是否为 CJK 字符(汉字、假名、谚文,以及中日韩标点)。
///
/// 这些字符按“一个字符一个 token”估算;其余字符按 4 个字符一个 token。
pub fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x11FF |     // 谚文字母
        0x3000..=0x303F |     // 中日韩符号与标点
        0x3040..=0x30FF |     // 平假名 / 片假名
        0x3400..=0x4DBF |     // 中日韩扩展 A
        0x4E00..=0x9FFF |     // 中日韩统一表意文字
        0xAC00..=0xD7AF |     // 谚文音节
        0xF900..=0xFAFF |     // 中日韩兼容表意文字
        0xFF00..=0xFFEF       // 半角 / 全角形式
    )
}

/// 拆分文本中的标识符,返回去重后的小写词元(长度 ≥ 2,按首次出现顺序)。
///
/// 拆分规则:先按 `_` 与非字母数字切段,再在 camelCase / PascalCase 边界
/// (小写→大写、连续大写后跟小写)与字母数字边界处切开。
pub fn split_identifiers(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for mat in IDENT_RE.find_iter(text) {
        for segment in mat.as_str().split('_') {
            if segment.is_empty() {
                continue;
            }
            for token in split_camel_segment(segment) {
                let token = token.to_ascii_lowercase();
                if token.chars().count() >= 2 && seen.insert(token.clone()) {
                    out.push(token);
                }
            }
        }
    }
    out
}

/// 把文本里所有标识符拆分结果拼成一段用空格分隔的字符串(供 `lex` 列使用)。
pub fn identifier_words(text: &str) -> String {
    split_identifiers(text).join(" ")
}

fn split_camel_segment(segment: &str) -> Vec<String> {
    let chars: Vec<char> = segment.chars().collect();
    let mut out = Vec::new();
    let mut start = 0usize;
    for i in 1..=chars.len() {
        let boundary = i == chars.len() || is_boundary(&chars, i);
        if boundary {
            if i > start {
                out.push(chars[start..i].iter().collect());
            }
            start = i;
        }
    }
    out
}

fn is_boundary(chars: &[char], i: usize) -> bool {
    let prev = chars[i - 1];
    let cur = chars[i];
    if prev.is_ascii_digit() != cur.is_ascii_digit() {
        return true;
    }
    if prev.is_ascii_lowercase() && cur.is_ascii_uppercase() {
        return true;
    }
    // 连续大写后接小写:"HTTPServer" 在 'S' 前切开
    if prev.is_ascii_uppercase()
        && cur.is_ascii_uppercase()
        && i + 1 < chars.len()
        && chars[i + 1].is_ascii_lowercase()
    {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_tokens_counts_cjk_one_per_char() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("增量索引"), 4);
        assert_eq!(estimate_tokens("双哈希增量索引"), 7);
    }

    #[test]
    fn estimate_tokens_rounds_other_chars_up() {
        assert_eq!(estimate_tokens("a"), 1);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        assert_eq!(estimate_tokens("abcdefgh"), 2);
    }

    #[test]
    fn estimate_tokens_ignores_whitespace_and_mixes() {
        assert_eq!(estimate_tokens("   \n\t"), 0);
        assert_eq!(estimate_tokens("a b c"), 1);
        // 2 个汉字 + ceil(3/4) = 3
        assert_eq!(estimate_tokens("中文 abc"), 3);
        // 标点算非空白字符
        assert_eq!(estimate_tokens("fn f() {}"), 2);
    }

    #[test]
    fn split_camel_and_pascal_case() {
        assert_eq!(split_identifiers("embedQuery"), ["embed", "query"]);
        assert_eq!(
            split_identifiers("HTTPServerConfig"),
            ["http", "server", "config"]
        );
        assert_eq!(
            split_identifiers("snake_case_name"),
            ["snake", "case", "name"]
        );
        assert_eq!(split_identifiers("utf8_decode"), ["utf", "decode"]);
    }

    #[test]
    fn split_identifiers_dedupes_and_drops_short_tokens() {
        assert_eq!(split_identifiers("embed embedQuery"), ["embed", "query"]);
        // 单字符与两字符的词元被丢掉
        assert!(split_identifiers("a b c x1").is_empty());
        // 没有 ASCII 标识符
        assert!(split_identifiers("增量索引").is_empty());
        assert_eq!(
            split_identifiers("let value = compute_token(&ctx);"),
            ["let", "value", "compute", "token", "ctx"]
        );
    }

    #[test]
    fn identifier_words_joins_results() {
        assert_eq!(identifier_words("fn embedQuery(&self)"), "embed query self");
        assert_eq!(identifier_words("增量索引"), "");
    }

    #[test]
    fn is_cjk_covers_common_scripts() {
        assert!(is_cjk('中'));
        assert!(is_cjk('、'));
        assert!(is_cjk('あ'));
        assert!(is_cjk('한'));
        assert!(!is_cjk('a'));
        assert!(!is_cjk('1'));
        assert!(!is_cjk(' '));
    }
}
