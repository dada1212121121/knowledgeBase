//! tree-sitter 分块（设计规范）。
//!
//! 规则:
//! - 定义类节点各自成块;节点紧前面的注释并入该块;
//! - 超过 `max_tokens` 的定义向下递归(例如 impl 拆成各个方法),父符号写进子块 header;
//! - 相邻的小节点(use / import / const / 字段等)合并成 preamble 块,直到接近 `target_tokens`;
//! - 递归到叶子仍超长时,按行窗口切分;
//! - 解析失败或语言不支持时,整份文档退回窗口分块。
//!
//! 实现方式:把节点的字节区间按“定义后代 + 间隙”线性分区,保证每个非空行都落在某个块里。

use std::collections::HashSet;

use kb_core::model::{Chunk, SourceDoc};
use kb_core::ports::Chunker;
use kb_core::text::estimate_tokens;
use tree_sitter::{Node, Parser};

use crate::chunk::lang::{LangSpec, spec_for};
use crate::chunk::window::{split_text, window_chunks};
use crate::chunk::{ChunkOptions, make_header};

/// 用 tree-sitter 分块;不支持的语言自动退回窗口分块。
pub struct TreeSitterChunker {
    options: ChunkOptions,
}

impl TreeSitterChunker {
    /// 构造。
    pub fn new(options: ChunkOptions) -> Self {
        Self { options }
    }

    /// 当前参数。
    pub fn options(&self) -> ChunkOptions {
        self.options
    }

    fn fallback(&self, doc: &SourceDoc) -> Vec<Chunk> {
        window_chunks(doc, &self.options)
    }
}

impl Chunker for TreeSitterChunker {
    fn supports(&self, lang: &str) -> bool {
        spec_for(lang).is_some()
    }

    fn chunk(&self, doc: &SourceDoc) -> Vec<Chunk> {
        let Some(spec) = spec_for(&doc.lang) else {
            return self.fallback(doc);
        };
        let mut parser = Parser::new();
        if parser.set_language(&(spec.language)()).is_err() {
            return self.fallback(doc);
        }
        let Some(tree) = parser.parse(&doc.text, None) else {
            return self.fallback(doc);
        };
        let root = tree.root_node();
        if root.has_error() {
            // 解析失败(语法错误)时退回窗口分块,保证不漏内容
            return self.fallback(doc);
        }
        let mut builder = Builder::new(doc, self.options, spec);
        builder.walk(root, &[]);
        builder.chunks
    }
}

struct Builder<'a> {
    doc: &'a SourceDoc,
    options: ChunkOptions,
    spec: LangSpec,
    chunks: Vec<Chunk>,
    ordinal: usize,
    keys: HashSet<String>,
}

impl<'a> Builder<'a> {
    fn new(doc: &'a SourceDoc, options: ChunkOptions, spec: LangSpec) -> Self {
        Self {
            doc,
            options,
            spec,
            chunks: Vec::new(),
            ordinal: 0,
            keys: HashSet::new(),
        }
    }

    /// 把一个节点区间按“定义后代 + 间隙”切块。
    fn walk(&mut self, node: Node<'_>, parents: &[String]) {
        let definitions = self.collect_definitions(node);
        let mut position = node.start_byte();
        let mut position_line = node.start_position().row as i32 + 1;

        for definition in definitions {
            // 注释并入定义块:把定义的起点提前到紧邻的注释块
            let (gap_end, definition_start, definition_line) =
                self.split_trailing_comments(position, position_line, &definition);
            if gap_end > position {
                self.emit_gap(position, gap_end, position_line, parents);
            }
            self.emit_definition(definition, parents, definition_start, definition_line);
            position = definition.end_byte();
            position_line = definition.end_position().row as i32 + 1;
        }

        if position < node.end_byte() {
            self.emit_gap(position, node.end_byte(), position_line, parents);
        }
    }

    /// 收集“直接”的定义后代:穿过非定义容器(例如 impl 的 declaration_list)。
    fn collect_definitions<'tree>(&self, node: Node<'tree>) -> Vec<Node<'tree>> {
        let mut found = Vec::new();
        self.collect_into(node, &mut found);
        found
    }

    fn collect_into<'tree>(&self, node: Node<'tree>, found: &mut Vec<Node<'tree>>) {
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            if self.spec.is_definition(child.kind()) {
                found.push(child);
            } else if child.named_child_count() > 0 {
                self.collect_into(child, found);
            }
        }
    }

    fn emit_definition(
        &mut self,
        node: Node<'_>,
        parents: &[String],
        start_byte: usize,
        start_line: i32,
    ) {
        let label = self.spec.label(&node, &self.doc.text);
        let mut symbol_path: Vec<String> = parents.to_vec();
        symbol_path.push(label);
        let symbol = symbol_path.join(" › ");

        let end_line = node.end_position().row as i32 + 1;
        let text = self.slice(start_byte, node.end_byte());
        // 签名只取定义自身的首行,不要把并进来的注释或装饰器当成签名
        let signature = signature_of(&self.signature_source(&node));
        let outer = parents.last().map(String::as_str);
        let header = make_header(
            &self.doc.project_name,
            &self.doc.source,
            outer,
            Some(&signature),
        );
        let budget = self.budget(&header);
        let fits = estimate_tokens(&text) <= budget;
        let children = self.collect_definitions(node);

        if fits || children.is_empty() {
            if fits {
                self.push(start_line, end_line, text, Some(symbol), header);
            } else {
                self.push_split(&text, start_line, Some(symbol), header);
            }
            return;
        }

        // 递归:父节点自身的行(签名、括号)变成 gap 块,子定义各自成块
        let mut position = start_byte;
        let mut position_line = start_line;
        for child in children {
            let (gap_end, child_start, child_line) =
                self.split_trailing_comments(position, position_line, &child);
            if gap_end > position {
                self.emit_gap(position, gap_end, position_line, &symbol_path);
            }
            self.emit_definition(child, &symbol_path, child_start, child_line);
            position = child.end_byte();
            position_line = child.end_position().row as i32 + 1;
        }
        if position < node.end_byte() {
            self.emit_gap(position, node.end_byte(), position_line, &symbol_path);
        }
    }

    /// 输出一段间隙文本(非定义内容)。
    ///
    /// 前导空行会被丢掉,起始行取第一个非空行;如果与上一个块在同一行开始
    /// (例如结构体后面的 `;`),这一行的残留也丢掉,避免行范围重叠。
    fn emit_gap(&mut self, start: usize, end: usize, start_line: i32, parents: &[String]) {
        let raw = self.slice(start, end);
        let Some((text, start_line)) = trim_gap(&raw, start_line, self.last_end_line()) else {
            return;
        };
        let line_count = text.trim_end_matches('\n').lines().count().max(1);
        let end_line = start_line + line_count as i32 - 1;
        let outer = parents.last().map(String::as_str);
        let header = make_header(&self.doc.project_name, &self.doc.source, outer, None);
        // preamble / 间隙块合并到接近 target_tokens 就断开
        let budget = self.budget(&header).min(self.options.target_tokens.max(32));
        let symbol = outer.map(str::to_owned);
        if estimate_tokens(&text) <= budget {
            self.push(start_line, end_line, text, symbol, header);
        } else {
            self.push_split(&text, start_line, symbol, header);
        }
    }

    /// 上一个已输出块的结束行(没有则 0)。
    fn last_end_line(&self) -> i32 {
        self.chunks.last().map(|chunk| chunk.end_line).unwrap_or(0)
    }

    /// 超长文本按行窗口切开,每片都带同样的 header 与 symbol。
    fn push_split(&mut self, text: &str, start_line: i32, symbol: Option<String>, header: String) {
        let budget = self.budget(&header);
        for piece in split_text(text, start_line, &self.options, budget) {
            self.push(
                piece.start_line,
                piece.end_line,
                piece.text,
                symbol.clone(),
                header.clone(),
            );
        }
    }

    fn push(
        &mut self,
        start_line: i32,
        end_line: i32,
        text: String,
        symbol: Option<String>,
        header: String,
    ) {
        let key = match &symbol {
            Some(symbol) => self.unique_key(symbol.clone()),
            None => {
                self.ordinal += 1;
                self.unique_key(format!("#{}", self.ordinal))
            }
        };
        self.chunks.push(Chunk {
            key,
            text,
            start_line,
            end_line,
            symbol,
            title: None,
            header,
            anchor: None,
        });
    }

    fn unique_key(&mut self, base: String) -> String {
        let mut key = base.clone();
        let mut counter = 1usize;
        while self.keys.contains(&key) {
            counter += 1;
            key = format!("{base} #{counter}");
        }
        self.keys.insert(key.clone());
        key
    }

    /// 签名来源:装饰器包装节点取内部定义的首行。
    fn signature_source(&self, node: &Node<'_>) -> String {
        if self.spec.transparent.contains(&node.kind()) {
            let mut cursor = node.walk();
            for child in node.children(&mut cursor) {
                if self.spec.is_definition(child.kind()) {
                    return self.slice(child.start_byte(), child.end_byte());
                }
            }
        }
        self.slice(node.start_byte(), node.end_byte())
    }

    /// 把定义起点提前到紧邻的注释块;返回 (间隙终点, 定义起点, 定义起始行)。
    fn split_trailing_comments(
        &self,
        gap_start: usize,
        gap_start_line: i32,
        definition: &Node<'_>,
    ) -> (usize, usize, i32) {
        let gap = self
            .doc
            .text
            .get(gap_start..definition.start_byte())
            .unwrap_or("");
        if gap.is_empty() {
            return (
                definition.start_byte(),
                definition.start_byte(),
                definition.start_position().row as i32 + 1,
            );
        }
        let lines: Vec<&str> = gap.split('\n').collect();
        // 跳过末尾的空行(gap 通常以换行结尾)
        let mut end_index = lines.len();
        while end_index > 0 && lines[end_index - 1].trim().is_empty() {
            end_index -= 1;
        }
        let mut start_index: Option<usize> = None;
        for index in (0..end_index).rev() {
            let line = lines[index].trim();
            if line.is_empty() {
                break;
            }
            if is_comment_line(line) {
                start_index = Some(index);
                continue;
            }
            break;
        }
        let Some(start_index) = start_index else {
            return (
                definition.start_byte(),
                definition.start_byte(),
                definition.start_position().row as i32 + 1,
            );
        };
        let offset: usize = lines[..start_index].iter().map(|line| line.len() + 1).sum();
        let comment_start = gap_start + offset;
        let comment_line = gap_start_line + start_index as i32;
        (comment_start, comment_start, comment_line)
    }

    fn budget(&self, header: &str) -> usize {
        self.options
            .max_tokens
            .saturating_sub(estimate_tokens(header))
            .max(32)
    }

    fn slice(&self, start: usize, end: usize) -> String {
        self.doc.text.get(start..end).unwrap_or_default().to_owned()
    }
}

/// 裁掉间隙文本的前导空行,并在与上一个块同行时丢掉该行残留。
///
/// 返回 `(文本, 起始行)`;全是空白时返回 `None`。
fn trim_gap(raw: &str, raw_start_line: i32, previous_end_line: i32) -> Option<(String, i32)> {
    let mut line = raw_start_line;
    let mut text = raw;
    let trimmed = text.trim_start();
    line += text[..text.len() - trimmed.len()].matches('\n').count() as i32;
    text = trimmed;
    if text.trim().is_empty() {
        return None;
    }
    if line <= previous_end_line {
        let cut = text.find('\n')?;
        line += text[..=cut].matches('\n').count() as i32;
        let rest = &text[cut + 1..];
        let trimmed = rest.trim_start();
        line += rest[..rest.len() - trimmed.len()].matches('\n').count() as i32;
        text = trimmed;
        if text.trim().is_empty() {
            return None;
        }
    }
    Some((text.to_owned(), line))
}

/// 行首是否为注释。
fn is_comment_line(line: &str) -> bool {
    line.starts_with("//")
        || line.starts_with("/*")
        || line.starts_with('*')
        || line.starts_with('#')
        || line.starts_with("--")
}

/// 定义的首行签名(去掉行尾的 `{`)。
fn signature_of(text: &str) -> String {
    let first = text.lines().next().unwrap_or("").trim();
    let trimmed = first.trim_end_matches(['{', ' ', '\t']).trim();
    let mut signature: String = trimmed.chars().take(80).collect();
    if trimmed.chars().count() > 80 {
        signature.push('…');
    }
    signature
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(lang: &str, text: &str) -> SourceDoc {
        SourceDoc {
            source: format!("src/sample.{lang}"),
            lang: lang.to_owned(),
            text: text.to_owned(),
            file_hash: "h".to_owned(),
            size: text.len() as u64,
            mtime: 0,
            project_name: "demo".to_owned(),
        }
    }

    fn chunker(max_tokens: usize) -> TreeSitterChunker {
        TreeSitterChunker::new(ChunkOptions {
            max_tokens,
            ..ChunkOptions::default()
        })
    }

    #[test]
    fn supports_the_eight_languages_only() {
        let chunker = chunker(512);
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
            assert!(chunker.supports(lang), "{lang} 应被支持");
        }
        assert!(!chunker.supports("markdown"));
        assert!(!chunker.supports("text"));
    }

    #[test]
    fn rust_definitions_become_chunks_with_symbols() {
        let source = r#"use std::fmt;

/// 一个结构体。
pub struct Config {
    pub name: String,
}

impl Config {
    pub fn new(name: &str) -> Self {
        Self { name: name.to_owned() }
    }

    pub fn describe(&self) -> String {
        format!("config:{}", self.name)
    }
}

pub fn run(config: &Config) -> usize {
    config.describe().len()
}
"#;
        let chunks = chunker(512).chunk(&doc("rust", source));
        let keys: Vec<&str> = chunks.iter().map(|chunk| chunk.key.as_str()).collect();
        assert!(keys.contains(&"struct Config"), "keys = {keys:?}");
        assert!(keys.contains(&"impl Config"), "keys = {keys:?}");
        assert!(keys.contains(&"fn run"), "keys = {keys:?}");
        let config = chunks
            .iter()
            .find(|chunk| chunk.key == "struct Config")
            .expect("结构体块");
        assert!(config.text.contains("/// 一个结构体。"), "注释应并入定义块");
        assert!(config.header.starts_with("demo › src/sample.rust"));
    }

    #[test]
    fn oversized_impl_is_split_into_methods_with_parent_header() {
        let mut source = String::from("impl Config {\n");
        for index in 0..40 {
            source.push_str(&format!(
                "    pub fn method_{index}(&self) -> usize {{\n        let value = {index};\n        value + 1\n    }}\n\n"
            ));
        }
        source.push_str("}\n");
        let chunks = chunker(120).chunk(&doc("rust", &source));
        let method = chunks
            .iter()
            .find(|chunk| {
                chunk
                    .symbol
                    .as_deref()
                    .is_some_and(|symbol| symbol.contains("method_0"))
            })
            .expect("应拆出方法块");
        assert!(
            method.header.contains("impl Config"),
            "父符号应写进子块 header:{}",
            method.header
        );
        for chunk in &chunks {
            assert!(
                estimate_tokens(&format!("{}\n{}", chunk.header, chunk.text)) <= 120,
                "块超出 max_tokens:{}",
                chunk.key
            );
        }
    }

    #[test]
    fn preamble_is_merged_into_one_chunk() {
        let source = "use std::a;\nuse std::b;\nuse std::c;\n\nfn only() {}\n";
        let chunks = chunker(512).chunk(&doc("rust", source));
        let preamble = chunks
            .iter()
            .find(|chunk| chunk.key.starts_with('#'))
            .expect("应有 preamble 块");
        assert!(preamble.text.contains("use std::a;"));
        assert!(preamble.text.contains("use std::c;"));
        assert_eq!(preamble.start_line, 1);
        assert_eq!(preamble.end_line, 3);
    }

    #[test]
    fn parse_failure_falls_back_to_window_chunks() {
        let broken = "fn main( {\n    let x = ;\n";
        let chunks = chunker(512).chunk(&doc("rust", broken));
        assert!(!chunks.is_empty());
        assert_eq!(chunks[0].key, "#1", "解析失败应退回窗口分块");
        assert!(chunks[0].text.contains("fn main("));
    }

    #[test]
    fn unsupported_language_uses_window_chunks() {
        let chunks = chunker(512).chunk(&doc("text", "line 1\nline 2\nline 3\n"));
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].key, "#1");
        assert_eq!(chunks[0].symbol, None);
    }

    #[test]
    fn python_javascript_go_and_java_are_chunked() {
        let python = "def run(x):\n    return x\n\nclass Config:\n    def describe(self):\n        return 'x'\n";
        let keys: Vec<String> = chunker(512)
            .chunk(&doc("python", python))
            .into_iter()
            .map(|chunk| chunk.key)
            .collect();
        assert!(keys.iter().any(|key| key == "def run"), "keys = {keys:?}");
        assert!(
            keys.iter().any(|key| key == "class Config"),
            "keys = {keys:?}"
        );

        let go = "package main\n\nfunc run(x int) int {\n\treturn x\n}\n";
        let keys: Vec<String> = chunker(512)
            .chunk(&doc("go", go))
            .into_iter()
            .map(|chunk| chunk.key)
            .collect();
        assert!(keys.iter().any(|key| key == "func run"), "keys = {keys:?}");

        let java = "class Main {\n    int run(int x) {\n        return x;\n    }\n}\n";
        let keys: Vec<String> = chunker(512)
            .chunk(&doc("java", java))
            .into_iter()
            .map(|chunk| chunk.key)
            .collect();
        assert!(
            keys.iter().any(|key| key == "class Main"),
            "keys = {keys:?}"
        );
    }
}
