//! 标识符与名字生成（设计规范）。
//!
//! - 块 id = `hex(xxh3_128(collection ‖ "\0" ‖ path ‖ "\0" ‖ chunk_key))`;
//! - `embedder_slug(id)` = 小写后删除所有非 `[a-z0-9]` 字符,截取前 24 个字符;
//! - 物理表名 = `{collection}__{embedder_slug}__v{n}`,只允许 `[a-z0-9_]`;
//! - collection 名只允许 `_global` / `proj_<slug>` / `ext_<slug>`。

use crate::error::{KbError, Result};
use crate::hash::xxh3_128_hex;

/// 全局 collection 的名字。
pub const GLOBAL_COLLECTION: &str = "_global";

/// embedder slug 的最大长度。
pub const EMBEDDER_SLUG_MAX_LEN: usize = 24;

/// 名字的最大长度(collection 名与物理表名共用)。
pub const MAX_NAME_LEN: usize = 64;

/// 生成块 id:`hex(xxh3_128(collection ‖ "\0" ‖ path ‖ "\0" ‖ chunk_key))`。
///
/// `chunk_key` 是符号路径(例如 `impl Foo::fn bar`)或 `#<序号>`。
pub fn chunk_id(collection: &str, path: &str, chunk_key: &str) -> String {
    let mut input = String::with_capacity(collection.len() + path.len() + chunk_key.len() + 2);
    input.push_str(collection);
    input.push('\0');
    input.push_str(path);
    input.push('\0');
    input.push_str(chunk_key);
    xxh3_128_hex(input.as_bytes())
}

/// 把 `Embedder::id` 转成物理表名里使用的 slug。
///
/// 例:`fastembed:bge-m3-int8` → `fastembedbgem3int8`。
pub fn embedder_slug(id: &str) -> String {
    id.chars()
        .filter_map(|ch| {
            let lower = ch.to_ascii_lowercase();
            lower.is_ascii_alphanumeric().then_some(lower)
        })
        .take(EMBEDDER_SLUG_MAX_LEN)
        .collect()
}

/// 项目名转 slug:小写,非 `[a-z0-9]` 字符替换为 `_`。
pub fn project_slug(name: &str) -> String {
    name.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// 名字是否只由 `[a-z0-9_]` 组成且非空。
pub fn is_valid_ident(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

/// 校验 collection 名:`_global` / `proj_<slug>` / `ext_<slug>`,只含 `[a-z0-9_]`。
pub fn validate_collection_name(name: &str) -> Result<()> {
    if name == GLOBAL_COLLECTION {
        return Ok(());
    }
    let slug = name
        .strip_prefix("proj_")
        .or_else(|| name.strip_prefix("ext_"))
        .filter(|slug| !slug.is_empty());
    match slug {
        Some(slug) if is_valid_ident(name) && is_valid_ident(slug) => Ok(()),
        _ => Err(KbError::InvalidInput(format!(
            "非法 collection 名 {name:?}:只允许 _global / proj_<slug> / ext_<slug>,且只含 [a-z0-9_]"
        ))),
    }
}

/// 校验物理表名:`{collection}__{embedder_slug}__v{n}`,`n ≥ 1`。
pub fn validate_table_name(name: &str) -> Result<()> {
    let invalid = || {
        KbError::InvalidInput(format!(
            "非法表名 {name:?}:应为 {{collection}}__{{embedder_slug}}__v{{n}},且只含 [a-z0-9_]"
        ))
    };
    if !is_valid_ident(name) {
        return Err(invalid());
    }
    let parts: Vec<&str> = name.split("__").collect();
    if parts.len() != 3 {
        return Err(invalid());
    }
    validate_collection_name(parts[0])?;
    if parts[1].is_empty() || !is_valid_ident(parts[1]) {
        return Err(invalid());
    }
    match parts[2]
        .strip_prefix('v')
        .and_then(|v| v.parse::<u32>().ok())
    {
        Some(version) if version >= 1 => Ok(()),
        _ => Err(invalid()),
    }
}

/// 生成物理表名 `{collection}__{embedder_slug}__v{n}` 并校验。
pub fn table_name(collection: &str, embedder_slug: &str, version: u32) -> Result<String> {
    validate_collection_name(collection)?;
    if embedder_slug.is_empty() || !is_valid_ident(embedder_slug) {
        return Err(KbError::InvalidInput(format!(
            "非法 embedder slug {embedder_slug:?}:只允许 [a-z0-9_]"
        )));
    }
    if version == 0 {
        return Err(KbError::InvalidInput("表版本从 1 开始".to_owned()));
    }
    let name = format!("{collection}__{embedder_slug}__v{version}");
    validate_table_name(&name)?;
    Ok(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_id_is_deterministic_and_hex32() {
        let id = chunk_id("proj_x", "src/lib.rs", "fn main");
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(id, chunk_id("proj_x", "src/lib.rs", "fn main"));
    }

    #[test]
    fn chunk_id_changes_with_every_component() {
        let base = chunk_id("proj_x", "src/lib.rs", "fn main");
        assert_ne!(base, chunk_id("proj_y", "src/lib.rs", "fn main"));
        assert_ne!(base, chunk_id("proj_x", "src/other.rs", "fn main"));
        assert_ne!(base, chunk_id("proj_x", "src/lib.rs", "fn other"));
    }

    #[test]
    fn chunk_id_separator_prevents_collisions() {
        // ("ab","c") 与 ("a","bc") 不能生成同一个 id
        assert_ne!(chunk_id("c", "ab", "x"), chunk_id("c", "a", "bx"));
        assert_ne!(chunk_id("ab", "c", "x"), chunk_id("a", "bc", "x"));
    }

    #[test]
    fn embedder_slug_matches_documented_examples() {
        assert_eq!(embedder_slug("fastembed:bge-m3-int8"), "fastembedbgem3int8");
        assert_eq!(embedder_slug("fastembed:bge-m3"), "fastembedbgem3");
        assert_eq!(embedder_slug("http:bge-m3"), "httpbgem3");
        assert_eq!(embedder_slug("fake:8"), "fake8");
    }

    #[test]
    fn embedder_slug_lowercases_and_truncates() {
        assert_eq!(embedder_slug("Fake:MODEL-X"), "fakemodelx");
        assert_eq!(embedder_slug(&"A".repeat(40)), "a".repeat(24));
        // 非 ASCII 字符被删掉
        assert_eq!(embedder_slug("模型:bge"), "bge");
        assert_eq!(embedder_slug(""), "");
    }

    #[test]
    fn project_slug_lowercases_and_replaces() {
        assert_eq!(project_slug("SampleApp"), "sampleapp");
        assert_eq!(project_slug("local-trees"), "local_trees");
        assert_eq!(project_slug("a b.c"), "a_b_c");
        assert_eq!(project_slug("营养库"), "___");
    }

    #[test]
    fn collection_names_are_validated() {
        for name in ["_global", "proj_sampleapp", "ext_docs", "proj_a1_b2"] {
            validate_collection_name(name).unwrap_or_else(|err| panic!("{name} 应该合法: {err}"));
        }
        for name in [
            "",
            "global",
            "Proj_x",
            "proj-",
            "proj_x-y",
            "proj_",
            "ext_",
            "other_x",
            "proj_中文",
        ] {
            assert!(validate_collection_name(name).is_err(), "{name} 应该被拒绝");
        }
    }

    #[test]
    fn table_name_is_built_and_validated() {
        assert_eq!(
            table_name("proj_sampleproj", "fastembedbgem3int8", 1).expect("valid"),
            "proj_sampleproj__fastembedbgem3int8__v1"
        );
        assert_eq!(
            table_name(GLOBAL_COLLECTION, "fastembedbgem3", 2).expect("valid"),
            "_global__fastembedbgem3__v2"
        );
        assert!(table_name("proj_x", "slug", 0).is_err(), "版本从 1 开始");
        assert!(table_name("proj_x", "", 1).is_err());
        assert!(table_name("proj-x", "slug", 1).is_err());
        assert!(table_name("proj_x", "Slug", 1).is_err());
    }

    #[test]
    fn table_names_are_validated() {
        for name in [
            "_global__fastembedbgem3__v2",
            "proj_x__fake8__v1",
            "ext_docs__httpbgem3__v10",
        ] {
            validate_table_name(name).unwrap_or_else(|err| panic!("{name} 应该合法: {err}"));
        }
        for name in [
            "",
            "proj_x",
            "proj_x__slug",
            "proj_x__slug__v0",
            "proj_x__slug__v",
            "proj_x__slug__1",
            "Proj_x__slug__v1",
            "proj_x__slug__v1__extra",
            "proj-x__slug__v1",
        ] {
            assert!(validate_table_name(name).is_err(), "{name} 应该被拒绝");
        }
    }
}
