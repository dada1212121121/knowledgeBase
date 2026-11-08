//! Java 的定义类节点。

use crate::chunk::lang::LangSpec;

/// Java 的分块配置。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "java",
        language: || tree_sitter_java::LANGUAGE.into(),
        definitions: &[
            ("class_declaration", "class"),
            ("interface_declaration", "interface"),
            ("enum_declaration", "enum"),
            ("method_declaration", ""),
        ],
        transparent: &[],
        named_child: &[],
    }
}
