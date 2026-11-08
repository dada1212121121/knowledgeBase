//! PHP 的定义类节点。

use crate::chunk::lang::LangSpec;

/// PHP 的分块配置(`tree_sitter_php::LANGUAGE_PHP`)。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "php",
        language: || tree_sitter_php::LANGUAGE_PHP.into(),
        definitions: &[
            ("function_definition", "function"),
            ("method_declaration", "function"),
            ("class_declaration", "class"),
            ("interface_declaration", "interface"),
            ("trait_declaration", "trait"),
            ("enum_declaration", "enum"),
        ],
        transparent: &[],
        named_child: &[],
    }
}
