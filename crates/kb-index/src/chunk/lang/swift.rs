//! Swift 的定义类节点。

use crate::chunk::lang::LangSpec;

/// Swift 的分块配置。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "swift",
        language: || tree_sitter_swift::LANGUAGE.into(),
        definitions: &[
            ("function_declaration", "func"),
            ("class_declaration", "class"),
            ("struct_declaration", "struct"),
            ("protocol_declaration", "protocol"),
            ("enum_declaration", "enum"),
            ("extension_declaration", "extension"),
        ],
        transparent: &[],
        named_child: &[],
    }
}
