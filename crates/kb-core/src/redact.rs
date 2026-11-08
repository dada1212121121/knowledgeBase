//! 敏感信息脱敏(先写好并测试,AI 的 LLM 外发闸门使用)。
//!
//! 覆盖的密钥形态:AWS access key、`sk-` 开头的 API key、GitHub token、JWT、
//! PEM 私钥块,以及 `api_key = ...` / `password: ...` 这类赋值。命中的片段整体替换为
//! `[REDACTED:<类型>]`。
//!
//! 另外提供路径黑名单:命中黑名单的文件内容不允许外发。

use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;

/// PEM 私钥块(可能跨行,含 RSA / EC / OPENSSH 等)。
static PRIVATE_KEY: LazyLock<Regex> = LazyLock::new(|| {
    // 模式是字面量常量,编译不会失败
    Regex::new(r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----")
        .expect("内置私钥正则必须合法")
});

/// AWS access key id。
static AWS_ACCESS_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"AKIA[0-9A-Z]{16}").expect("内置 AWS 正则必须合法"));

/// GitHub token(`ghp_` / `gho_` / `ghu_` / `ghs_` / `ghr_` + 36 位)。
static GITHUB_TOKEN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"gh[pousr]_[A-Za-z0-9]{36}").expect("内置 GitHub 正则必须合法"));

/// JWT(`eyJ` 开头的三段 base64url)。
static JWT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"eyJ[\w-]+\.[\w-]+\.[\w-]+").expect("内置 JWT 正则必须合法"));

/// OpenAI 风格 API key。
static API_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"sk-[A-Za-z0-9]{20,}").expect("内置 API key 正则必须合法"));

/// `api_key = ...` / `password: ...` 这类赋值。
///
/// 在 给定的模式上做了三点调整,都不缩小覆盖面:
/// - 关键字两侧允许各有一个引号,这样 JSON / TOML 里的 `"apiKey": "..."` 也能命中;
/// - 值后面允许再跟一个引号,避免脱敏后留下孤立的引号;
/// - 值可以以 `[` 开头。已经生成的 `[REDACTED:...]` 占位符在替换时跳过,保证幂等。
static SECRET_ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)['"]?(api[_-]?key|secret|token|password|passwd|authorization)['"]?\s*[:=]\s*['"]?[^\s'"]{8,}['"]?"#,
    )
    .expect("内置赋值正则必须合法")
});

/// 路径黑名单:文件名以 `.env` 开头。
const BLACKLIST_NAME_PREFIXES: [&str; 2] = [".env", "id_rsa"];
/// 路径黑名单:扩展名。
const BLACKLIST_EXTENSIONS: [&str; 2] = ["pem", "key"];
/// 路径黑名单:路径中出现这些片段(不区分大小写)。
const BLACKLIST_FRAGMENTS: [&str; 2] = ["secret", "credential"];

/// 脱敏,返回替换后的文本。
pub fn redact(text: &str) -> String {
    redact_with_count(text).0
}

/// 脱敏,同时返回替换了多少处(写入 `llm_sends.redactions`）。
pub fn redact_with_count(text: &str) -> (String, usize) {
    let mut current = text.to_owned();
    let mut count = 0usize;
    let rules: [(&LazyLock<Regex>, &str); 5] = [
        (&PRIVATE_KEY, "private_key"),
        (&AWS_ACCESS_KEY, "aws_access_key"),
        (&GITHUB_TOKEN, "github_token"),
        (&JWT, "jwt"),
        (&API_KEY, "api_key"),
    ];
    for (pattern, kind) in rules {
        let replacement = format!("[REDACTED:{kind}]");
        let hits = pattern.find_iter(&current).count();
        if hits > 0 {
            current = pattern
                .replace_all(&current, replacement.as_str())
                .into_owned();
            count += hits;
        }
    }
    let secret_hits = SECRET_ASSIGNMENT
        .find_iter(&current)
        .filter(|hit| !hit.as_str().contains("[REDACTED:"))
        .count();
    if secret_hits > 0 {
        current = SECRET_ASSIGNMENT
            .replace_all(&current, |caps: &regex::Captures<'_>| {
                let whole = caps.get(0).map(|item| item.as_str()).unwrap_or("");
                if whole.contains("[REDACTED:") {
                    whole.to_owned()
                } else {
                    "[REDACTED:secret]".to_owned()
                }
            })
            .into_owned();
        count += secret_hits;
    }
    (current, count)
}

/// 路径是否在黑名单里(命中即不允许外发)。
///
/// 规则:文件名以 `.env` / `id_rsa` 开头,扩展名为 `pem` / `key`,或路径中出现
/// `secret` / `credential`(不区分大小写)。
pub fn is_blacklisted_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let file_name = Path::new(&lower)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(lower.as_str());
    if BLACKLIST_NAME_PREFIXES
        .iter()
        .any(|prefix| file_name.starts_with(prefix))
    {
        return true;
    }
    if let Some(extension) = Path::new(file_name)
        .extension()
        .and_then(|ext| ext.to_str())
        && BLACKLIST_EXTENSIONS.contains(&extension)
    {
        return true;
    }
    BLACKLIST_FRAGMENTS
        .iter()
        .any(|fragment| lower.contains(fragment))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_aws_access_key() {
        let out = redact("aws_key = AKIAIOSFODNN7EXAMPLE;");
        assert_eq!(out, "aws_key = [REDACTED:aws_access_key];");
    }

    #[test]
    fn redacts_openai_style_key() {
        let out = redact("export KEY=sk-abcdefghijklmnopqrstuvwxyz012345");
        assert_eq!(out, "export KEY=[REDACTED:api_key]");
    }

    #[test]
    fn redacts_github_token() {
        let token = format!("ghp_{}", "a".repeat(36));
        let out = redact(&format!("token {token} leaked"));
        assert_eq!(out, "token [REDACTED:github_token] leaked");
    }

    #[test]
    fn redacts_jwt() {
        let out = redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEF123");
        assert_eq!(out, "Authorization: Bearer [REDACTED:jwt]");
    }

    #[test]
    fn redacts_private_key_block() {
        let text = "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----\nafter";
        assert_eq!(redact(text), "before\n[REDACTED:private_key]\nafter");
    }

    #[test]
    fn redacts_secret_assignments() {
        assert_eq!(redact("api_key = \"abcdefgh12345\""), "[REDACTED:secret]");
        assert_eq!(redact("password: hunter2hunter2"), "[REDACTED:secret]");
        assert_eq!(
            redact("Authorization: abcdefgh12345678"),
            "[REDACTED:secret]"
        );
        // JSON 里的引号键同样命中,且不会留下孤立的引号
        assert_eq!(
            redact(r#"{"apiKey": "abcdefgh12345"}"#),
            r#"{[REDACTED:secret]}"#
        );
    }

    #[test]
    fn keeps_ordinary_code_untouched() {
        // 误杀用例:普通代码里的计数、变量名、函数名不能被替换
        assert_eq!(redact("token_count = 5"), "token_count = 5");
        assert_eq!(
            redact("let total = token_count + 1;"),
            "let total = token_count + 1;"
        );
        assert_eq!(redact("secretary: Alice"), "secretary: Alice");
        assert_eq!(
            redact("fn redact(text: &str) -> String { text.into() }"),
            "fn redact(text: &str) -> String { text.into() }"
        );
        assert_eq!(redact("password = 8"), "password = 8");
        assert_eq!(
            redact("password = [real-secret-value]"),
            "[REDACTED:secret]"
        );
        let once = redact("api_key = sk-abcdefghijklmnopqrstuvwxyz");
        assert_eq!(redact(&once), once);
        assert_eq!(redact(""), "");
    }

    #[test]
    fn counts_every_replacement() {
        let text = "AKIAIOSFODNN7EXAMPLE and sk-abcdefghijklmnopqrstuvwx";
        let (out, count) = redact_with_count(text);
        assert_eq!(count, 2);
        assert_eq!(out, "[REDACTED:aws_access_key] and [REDACTED:api_key]");
        assert_eq!(redact_with_count("nothing here").1, 0);
    }

    #[test]
    fn redaction_is_idempotent() {
        let text = "key=AKIAIOSFODNN7EXAMPLE token=ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        let once = redact(text);
        assert_eq!(redact(&once), once);
    }

    #[test]
    fn blacklisted_paths_are_rejected() {
        for path in [
            ".env",
            ".env.local",
            "config/.env.production",
            "certs/server.pem",
            "private.key",
            "~/.ssh/id_rsa",
            "id_rsa.pub",
            "src/secret_store.rs",
            "credentials.json",
            "docs/CREDENTIALS.md",
        ] {
            assert!(is_blacklisted_path(path), "{path} 应该被拒绝");
        }
        for path in [
            "src/main.rs",
            "docs/README.md",
            "tokenizer.rs",
            "keyboard.rs",
            "src/env.rs",
            ".gitignore",
        ] {
            assert!(!is_blacklisted_path(path), "{path} 不应该被拒绝");
        }
    }
}
