//! 八种语言的节点类型表（设计规范）。

pub mod bash;
pub mod c;
pub mod cpp;
pub mod go;
pub mod java;
pub mod javascript;
pub mod php;
pub mod python;
pub mod ruby;
pub mod rust;
pub mod swift;
pub mod typescript;

use tree_sitter::{Language, Node};

/// 一种语言的分块配置。
#[derive(Clone, Copy)]
pub struct LangSpec {
    /// 语言名(与 `SourceDoc.lang` 一致)。
    pub name: &'static str,
    /// 构造 tree-sitter 语言。
    pub language: fn() -> Language,
    /// 定义类节点:(节点类型, 符号标签前缀)。
    pub definitions: &'static [(&'static str, &'static str)],
    /// 包装节点:标签取里面那个定义(例如 `export class Foo`、`@decorator def foo`)。
    pub transparent: &'static [&'static str],
    /// 名字藏在子节点里的定义(例如 JS 的 `lexical_declaration`)。
    pub named_child: &'static [&'static str],
}

impl LangSpec {
    /// 该节点是否是“定义”(各自成块)。
    pub fn is_definition(&self, kind: &str) -> bool {
        self.definitions.iter().any(|(node, _)| *node == kind)
    }

    /// 生成符号标签,例如 `fn run`、`impl Config`、`def handler`。
    pub fn label(&self, node: &Node<'_>, source: &str) -> String {
        let kind = node.kind();
        if self.transparent.contains(&kind) {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if self.is_definition(child.kind()) {
                    return self.label(&child, source);
                }
            }
        }
        let prefix = self
            .definitions
            .iter()
            .find(|(node_kind, _)| *node_kind == kind)
            .map(|(_, prefix)| *prefix)
            .unwrap_or("");
        let name = if self.named_child.contains(&kind) {
            child_name(node, source).unwrap_or_else(|| first_line_label(node, source))
        } else {
            node_name(node, source)
        };
        // 名字里已经带关键字(例如 impl 的首行)时不重复加前缀
        if prefix.is_empty() || name.starts_with(prefix) {
            name
        } else {
            format!("{prefix} {name}")
        }
    }
}

/// 按语言名取配置;不支持的语言返回 `None`(调用方退回窗口分块)。
pub fn spec_for(lang: &str) -> Option<LangSpec> {
    match lang {
        "rust" => Some(rust::spec()),
        "python" => Some(python::spec()),
        "javascript" => Some(javascript::spec()),
        "typescript" => Some(typescript::spec()),
        "tsx" => Some(typescript::tsx_spec()),
        "go" => Some(go::spec()),
        "java" => Some(java::spec()),
        "c" => Some(c::spec()),
        "cpp" => Some(cpp::spec()),
        "bash" => Some(bash::spec()),
        "ruby" => Some(ruby::spec()),
        "php" => Some(php::spec()),
        "swift" => Some(swift::spec()),
        _ => None,
    }
}

/// 取节点名字:优先 `name` 字段,否则退回首行。
pub fn node_name(node: &Node<'_>, source: &str) -> String {
    if let Some(name) = node.child_by_field_name("name") {
        return slice(source, &name).to_owned();
    }
    first_line_label(node, source)
}

/// 从子节点里找 `name` 字段(例如 `lexical_declaration` 里的变量名)。
pub fn child_name(node: &Node<'_>, source: &str) -> Option<String> {
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(name) = child.child_by_field_name("name") {
            return Some(slice(source, &name).to_owned());
        }
    }
    None
}

/// 首行标签:去掉行尾的 `{`,过长时截断。
pub fn first_line_label(node: &Node<'_>, source: &str) -> String {
    let text = slice(source, node);
    let first = text.lines().next().unwrap_or("").trim();
    let trimmed = first.trim_end_matches(['{', ' ', '\t']).trim();
    let mut label: String = trimmed.chars().take(80).collect();
    if trimmed.chars().count() > 80 {
        label.push('…');
    }
    label
}

/// 节点对应的源码片段(按字节范围切片,非法边界返回空串)。
pub fn slice<'a>(source: &'a str, node: &Node<'_>) -> &'a str {
    source.get(node.byte_range()).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_language_has_a_spec() {
        for lang in [
            "rust",
            "python",
            "javascript",
            "typescript",
            "go",
            "java",
            "c",
            "cpp",
        ] {
            let spec = spec_for(lang).unwrap_or_else(|| panic!("{lang} 应有配置"));
            assert_eq!(spec.name, lang);
            assert!(!spec.definitions.is_empty());
        }
        assert!(spec_for("markdown").is_none());
        assert!(spec_for("text").is_none());
    }

    #[test]
    fn definition_kinds_match_the_plan() {
        let rust = spec_for("rust").expect("rust");
        for kind in [
            "function_item",
            "impl_item",
            "struct_item",
            "enum_item",
            "trait_item",
            "mod_item",
            "macro_definition",
        ] {
            assert!(rust.is_definition(kind), "rust 应包含 {kind}");
        }
        let python = spec_for("python").expect("python");
        for kind in [
            "function_definition",
            "class_definition",
            "decorated_definition",
        ] {
            assert!(python.is_definition(kind));
        }
        let go = spec_for("go").expect("go");
        for kind in [
            "function_declaration",
            "method_declaration",
            "type_declaration",
        ] {
            assert!(go.is_definition(kind));
        }
        let java = spec_for("java").expect("java");
        for kind in [
            "class_declaration",
            "interface_declaration",
            "enum_declaration",
            "method_declaration",
        ] {
            assert!(java.is_definition(kind));
        }
        let cpp = spec_for("cpp").expect("cpp");
        for kind in [
            "function_definition",
            "struct_specifier",
            "class_specifier",
            "namespace_definition",
        ] {
            assert!(cpp.is_definition(kind));
        }
    }
}
