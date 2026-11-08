//! TypeScript 的定义类节点(与 JavaScript 同一套,额外覆盖类型声明)。

use crate::chunk::lang::LangSpec;

/// `.tsx` 用 TSX 语法(带 JSX)。
pub fn tsx_spec() -> LangSpec {
    LangSpec {
        name: "tsx",
        language: || tree_sitter_typescript::LANGUAGE_TSX.into(),
        ..spec()
    }
}

/// TypeScript 的分块配置。
pub fn spec() -> LangSpec {
    LangSpec {
        name: "typescript",
        language: || tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        definitions: &[
            ("function_declaration", "function"),
            ("class_declaration", "class"),
            ("method_definition", ""),
            ("lexical_declaration", ""),
            ("interface_declaration", "interface"),
            ("type_alias_declaration", "type"),
            ("export_statement", ""),
        ],
        transparent: &["export_statement"],
        named_child: &["lexical_declaration"],
    }
}
