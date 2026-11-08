//! Go 的定义类节点。

use crate::chunk::lang::LangSpec;

/// Go 的分块配置。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "go",
        language: || tree_sitter_go::LANGUAGE.into(),
        definitions: &[
            ("function_declaration", "func"),
            ("method_declaration", "func"),
            ("type_declaration", "type"),
        ],
        transparent: &[],
        named_child: &[],
    }
}
