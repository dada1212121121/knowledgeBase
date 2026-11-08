//! Rust 的定义类节点。

use crate::chunk::lang::LangSpec;

/// Rust 的分块配置。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "rust",
        language: || tree_sitter_rust::LANGUAGE.into(),
        definitions: &[
            ("function_item", "fn"),
            ("impl_item", "impl"),
            ("struct_item", "struct"),
            ("enum_item", "enum"),
            ("trait_item", "trait"),
            ("mod_item", "mod"),
            ("macro_definition", "macro"),
        ],
        transparent: &[],
        named_child: &[],
    }
}
