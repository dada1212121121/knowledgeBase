//! Python 的定义类节点。

use crate::chunk::lang::LangSpec;

/// Python 的分块配置。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "python",
        language: || tree_sitter_python::LANGUAGE.into(),
        definitions: &[
            ("function_definition", "def"),
            ("class_definition", "class"),
            // 装饰器定义整体成块,标签取里面那个定义的 name
            ("decorated_definition", ""),
        ],
        transparent: &["decorated_definition"],
        named_child: &[],
    }
}
