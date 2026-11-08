//! Bash 的定义类节点。

use crate::chunk::lang::LangSpec;

/// Bash 的分块配置。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "bash",
        language: || tree_sitter_bash::LANGUAGE.into(),
        definitions: &[("function_definition", "function")],
        transparent: &[],
        named_child: &[],
    }
}
