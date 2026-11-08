//! C++ 的定义类节点。

use crate::chunk::lang::LangSpec;

/// C++ 的分块配置。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "cpp",
        language: || tree_sitter_cpp::LANGUAGE.into(),
        definitions: &[
            ("function_definition", ""),
            ("struct_specifier", "struct"),
            ("class_specifier", "class"),
            ("namespace_definition", "namespace"),
        ],
        transparent: &[],
        named_child: &[],
    }
}
