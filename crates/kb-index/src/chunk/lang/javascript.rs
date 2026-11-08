//! JavaScript 的定义类节点。

use crate::chunk::lang::LangSpec;

/// JavaScript 的分块配置。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "javascript",
        language: || tree_sitter_javascript::LANGUAGE.into(),
        definitions: &[
            ("function_declaration", "function"),
            ("class_declaration", "class"),
            ("method_definition", ""),
            // const handler =  => {...}
            ("lexical_declaration", ""),
            ("interface_declaration", "interface"),
            ("type_alias_declaration", "type"),
            ("export_statement", ""),
        ],
        transparent: &["export_statement"],
        named_child: &["lexical_declaration"],
    }
}
