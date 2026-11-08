//! Ruby 的定义类节点。

use crate::chunk::lang::LangSpec;

/// Ruby 的分块配置。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "ruby",
        language: || tree_sitter_ruby::LANGUAGE.into(),
        definitions: &[
            ("method", "def"),
            ("singleton_method", "def"),
            ("class", "class"),
            ("module", "module"),
        ],
        transparent: &[],
        named_child: &[],
    }
}
