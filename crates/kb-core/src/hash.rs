//! 块级三哈希(块级内容哈希)。
//!
//! 三个哈希的分工决定了增量索引的精度:
//! - `content_hash = xxh3(text)` —— 只有正文变化才需要重新嵌入;
//! - `embed_input_hash = xxh3(embedder_id ‖ header ‖ "\n" ‖ text)` —— 换模型或
//!   结构化上下文头变化时也要重新嵌入;
//! - `meta_hash = xxh3(start_line ‖ end_line ‖ title ‖ tags ‖ status ‖ symbol)` ——
//!   行号等元数据变化时**只**更新元数据,不重新嵌入。
//!
//! 输出统一是 16 位小写十六进制。
//!
//! 起这里还有**内容**的 sha256(上传分片 / 整体校验、去重与秒传用):
//! 与块级 xxh3 不同,它要能跨进程、跨机器比对,所以用标准 sha256。

use std::io::Read;
use std::path::Path;

use sha2::{Digest, Sha256};
use xxhash_rust::xxh3::{xxh3_64, xxh3_128};

use crate::error::{KbError, Result};

/// 元数据字段之间的分隔符(正文里不会出现的控制字符)。
const FIELD_SEP: char = '\0';

/// 把 64 位 xxh3 格式化成 16 位小写十六进制。
pub fn xxh3_hex(bytes: &[u8]) -> String {
    format!("{:016x}", xxh3_64(bytes))
}

/// 把 128 位 xxh3 格式化成 32 位小写十六进制(块 id 用,设计规范)。
pub fn xxh3_128_hex(bytes: &[u8]) -> String {
    format!("{:032x}", xxh3_128(bytes))
}

/// `content_hash = xxh3(text)`
pub fn content_hash(text: &str) -> String {
    xxh3_hex(text.as_bytes())
}

/// `embed_input_hash = xxh3(embedder_id ‖ header ‖ "\n" ‖ text)`
///
/// 注意 `header` 里**不能**包含行号,否则行号一变就会触发重新嵌入(设计规范坑 14)。
pub fn embed_input_hash(embedder_id: &str, header: &str, text: &str) -> String {
    let mut input = String::with_capacity(embedder_id.len() + header.len() + text.len() + 2);
    input.push_str(embedder_id);
    input.push(FIELD_SEP);
    input.push_str(header);
    input.push('\n');
    input.push_str(text);
    xxh3_hex(input.as_bytes())
}

/// `meta_hash` 的输入。
#[derive(Clone, Copy, Debug)]
pub struct MetaHashInput<'a> {
    /// 块起始行(1 起)。
    pub start_line: Option<i32>,
    /// 块结束行(1 起)。
    pub end_line: Option<i32>,
    /// 文档标题路径或 insight 标题。
    pub title: Option<&'a str>,
    /// 标签。
    pub tags: &'a [String],
    /// `active` / `superseded` / `deprecated`。
    pub status: &'a str,
    /// 符号路径。
    pub symbol: Option<&'a str>,
}

/// `meta_hash = xxh3(start_line ‖ end_line ‖ title ‖ tags ‖ status ‖ symbol)`
pub fn meta_hash(input: &MetaHashInput<'_>) -> String {
    let mut buf = String::new();
    buf.push_str(&input.start_line.map(|v| v.to_string()).unwrap_or_default());
    buf.push(FIELD_SEP);
    buf.push_str(&input.end_line.map(|v| v.to_string()).unwrap_or_default());
    buf.push(FIELD_SEP);
    buf.push_str(input.title.unwrap_or_default());
    buf.push(FIELD_SEP);
    buf.push_str(&input.tags.join(","));
    buf.push(FIELD_SEP);
    buf.push_str(input.status);
    buf.push(FIELD_SEP);
    buf.push_str(input.symbol.unwrap_or_default());
    xxh3_hex(buf.as_bytes())
}

/// 字节内容的 sha256(64 位小写十六进制)。
pub fn sha256_hex_bytes(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 文件的 sha256:按 64 KB 流式读,不把大文件整个读进内存(整体校验)。
pub fn sha256_hex_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path)
        .map_err(|err| KbError::Internal(format!("打开 {} 失败: {err}", path.display())))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|err| KbError::Internal(format!("读取 {} 失败: {err}", path.display())))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let mut out = String::with_capacity(64);
    for byte in hasher.finalize() {
        out.push_str(&format!("{byte:02x}"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_of_bytes_and_file_agree() {
        // 标准测试向量:sha256("abc")
        assert_eq!(
            sha256_hex_bytes(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex_bytes(b"").len(), 64);
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("a.bin");
        std::fs::write(&path, b"abc").expect("写文件");
        assert_eq!(
            sha256_hex_file(&path).expect("算哈希"),
            sha256_hex_bytes(b"abc")
        );
        // 跨 64 KB 缓冲边界也要一致(这里写 200 KB)
        let big = vec![7u8; 200 * 1024];
        std::fs::write(&path, &big).expect("写大文件");
        assert_eq!(
            sha256_hex_file(&path).expect("算哈希"),
            sha256_hex_bytes(&big)
        );
        assert!(sha256_hex_file(&dir.path().join("missing")).is_err());
    }

    #[test]
    fn xxh3_hex_matches_known_value_and_format() {
        // XXH3_64bits("") 的标准值,用来钉住算法(换哈希函数会立刻失败)
        assert_eq!(xxh3_hex(b""), "2d06800538d394c2");
        assert_eq!(xxh3_hex(b"abc").len(), 16);
        assert!(xxh3_hex(b"abc").chars().all(|c| c.is_ascii_hexdigit()));
        assert!(xxh3_hex(b"abc").chars().all(|c| !c.is_ascii_uppercase()));
    }

    #[test]
    fn xxh3_hex_is_deterministic_and_sensitive() {
        assert_eq!(xxh3_hex(b"hello"), xxh3_hex(b"hello"));
        assert_ne!(xxh3_hex(b"hello"), xxh3_hex(b"hello "));
        assert_ne!(xxh3_hex(b""), xxh3_hex(b"\0"));
    }

    #[test]
    fn xxh3_128_hex_is_32_hex_chars() {
        assert_eq!(xxh3_128_hex(b"").len(), 32);
        assert_ne!(xxh3_128_hex(b"a"), xxh3_128_hex(b"b"));
        assert_eq!(xxh3_128_hex(b"a"), xxh3_128_hex(b"a"));
    }

    #[test]
    fn content_hash_ignores_nothing() {
        assert_eq!(content_hash("fn main() {}"), content_hash("fn main() {}"));
        assert_ne!(content_hash("fn main() {}"), content_hash("fn main() { }"));
        assert_eq!(content_hash("增量索引").len(), 16);
    }

    #[test]
    fn embed_input_hash_covers_embedder_header_and_text() {
        let base = embed_input_hash("fastembed:bge-m3-int8", "proj › a.rs › fn f", "body");
        assert_eq!(
            base,
            embed_input_hash("fastembed:bge-m3-int8", "proj › a.rs › fn f", "body")
        );
        // 换模型
        assert_ne!(
            base,
            embed_input_hash("fastembed:bge-m3", "proj › a.rs › fn f", "body")
        );
        // header 变化(例如路径改了)也要重嵌
        assert_ne!(
            base,
            embed_input_hash("fastembed:bge-m3-int8", "proj › b.rs › fn f", "body")
        );
        // 正文变化
        assert_ne!(
            base,
            embed_input_hash("fastembed:bge-m3-int8", "proj › a.rs › fn f", "body!")
        );
        // 分隔符避免歧义:("ab","c") 与 ("a","bc") 不能相同
        assert_ne!(
            embed_input_hash("id", "ab", "c"),
            embed_input_hash("id", "a", "bc")
        );
    }

    fn meta(
        start_line: Option<i32>,
        end_line: Option<i32>,
        title: Option<&str>,
        tags: &[String],
        status: &str,
        symbol: Option<&str>,
    ) -> String {
        meta_hash(&MetaHashInput {
            start_line,
            end_line,
            title,
            tags,
            status,
            symbol,
        })
    }

    #[test]
    fn meta_hash_changes_with_each_field() {
        let tags = vec!["a".to_owned()];
        let base = meta(Some(1), Some(10), Some("t"), &tags, "active", Some("fn f"));
        assert_eq!(
            base,
            meta(Some(1), Some(10), Some("t"), &tags, "active", Some("fn f"))
        );
        assert_ne!(
            base,
            meta(Some(2), Some(10), Some("t"), &tags, "active", Some("fn f"))
        );
        assert_ne!(
            base,
            meta(Some(1), Some(11), Some("t"), &tags, "active", Some("fn f"))
        );
        assert_ne!(
            base,
            meta(Some(1), Some(10), Some("u"), &tags, "active", Some("fn f"))
        );
        assert_ne!(
            base,
            meta(Some(1), Some(10), Some("t"), &[], "active", Some("fn f"))
        );
        assert_ne!(
            base,
            meta(
                Some(1),
                Some(10),
                Some("t"),
                &tags,
                "deprecated",
                Some("fn f")
            )
        );
        assert_ne!(
            base,
            meta(Some(1), Some(10), Some("t"), &tags, "active", Some("fn g"))
        );
    }

    #[test]
    fn meta_hash_handles_missing_fields() {
        let tags: Vec<String> = Vec::new();
        let empty = meta(None, None, None, &tags, "active", None);
        assert_eq!(empty.len(), 16);
        assert_ne!(empty, meta(Some(1), None, None, &tags, "active", None));
        // 标签顺序不同视为不同(存储顺序由调用方保证稳定)
        let ab = vec!["a".to_owned(), "b".to_owned()];
        let ba = vec!["b".to_owned(), "a".to_owned()];
        assert_ne!(
            meta(Some(1), Some(2), None, &ab, "active", None),
            meta(Some(1), Some(2), None, &ba, "active", None)
        );
    }
}

/// 提炼候选的指纹（设计规范）。
///
/// `xxh3_64_hex(kind ‖ "\n" ‖ normalize(title) ‖ "\n" ‖ related_paths 排序后逗号连接)`。
/// `normalize` = 转小写,去掉所有空白与标点(ASCII 与中文全角标点都算)。
pub fn candidate_fingerprint(kind: &str, title: &str, related_paths: &[String]) -> String {
    let mut paths: Vec<&str> = related_paths.iter().map(String::as_str).collect();
    paths.sort_unstable();
    let input = format!(
        "{}\n{}\n{}",
        kind.trim().to_ascii_lowercase(),
        normalize_title(title),
        paths.join(",")
    );
    xxh3_hex(input.as_bytes())
}

/// 标题归一化:转小写、去掉空白与标点。
pub fn normalize_title(title: &str) -> String {
    title
        .chars()
        .filter_map(|ch| {
            if ch.is_whitespace() || is_punctuation(ch) {
                None
            } else {
                Some(ch.to_lowercase().collect::<String>())
            }
        })
        .collect()
}

/// 标点(ASCII + 常见中文全角标点)。
fn is_punctuation(ch: char) -> bool {
    if ch.is_ascii_punctuation() {
        return true;
    }
    matches!(
        ch,
        '，' | '。'
            | '、'
            | '；'
            | '：'
            | '？'
            | '！'
            | '“'
            | '”'
            | '‘'
            | '’'
            | '（'
            | '）'
            | '【'
            | '】'
            | '《'
            | '》'
            | '—'
            | '…'
            | '·'
            | '「'
            | '」'
            | '～'
    )
}

#[cfg(test)]
mod fingerprint_tests {
    use super::*;

    #[test]
    fn fingerprint_ignores_case_space_and_punctuation() {
        let paths = vec!["src/a.rs".to_owned(), "src/b.rs".to_owned()];
        let a = candidate_fingerprint("decision", "  用 双哈希 增量索引!", &paths);
        let b = candidate_fingerprint("Decision", "用双哈希增量索引", &paths);
        assert_eq!(a, b, "大小写 / 空白 / 标点都不应影响指纹");
    }

    #[test]
    fn fingerprint_sorts_related_paths() {
        let a = candidate_fingerprint("decision", "标题", &["b.rs".to_owned(), "a.rs".to_owned()]);
        let b = candidate_fingerprint("decision", "标题", &["a.rs".to_owned(), "b.rs".to_owned()]);
        assert_eq!(a, b);
    }

    #[test]
    fn fingerprint_differs_by_kind_and_title() {
        let paths = vec!["a.rs".to_owned()];
        let base = candidate_fingerprint("decision", "标题", &paths);
        assert_ne!(base, candidate_fingerprint("pitfall", "标题", &paths));
        assert_ne!(
            base,
            candidate_fingerprint("decision", "另一个标题", &paths)
        );
        assert_eq!(base.len(), 16, "xxh3_64 是 16 位十六进制");
    }

    #[test]
    fn normalize_strips_fullwidth_punctuation() {
        assert_eq!(normalize_title("增量索引,要注意!"), "增量索引要注意");
        assert_eq!(normalize_title("「检索」:命中率"), "检索命中率");
    }
}
