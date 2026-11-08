//! 分块（设计规范）。
//!
//! - `treesitter`:按语言配置表驱动的 AST 分块(定义各自成块,超长递归,超长叶子退回窗口);
//! - `window`:行窗口分块,也是解析失败时的兜底;
//! - `lang`:八种语言的节点类型表。

pub mod lang;
pub mod markdown;
pub mod plain;
pub mod treesitter;
pub mod window;

pub use markdown::MarkdownChunker;
pub use plain::PlainChunker;
pub use treesitter::TreeSitterChunker;
pub use window::window_chunks;

use kb_core::config::{EmbedConfig, IndexConfig};
use kb_core::model::{Chunk, SourceDoc};
use kb_core::ports::Chunker;
use kb_core::text::{estimate_tokens, is_cjk};

/// header 的 token 上限（设计规范）。
pub const HEADER_MAX_TOKENS: usize = 64;

/// 分块参数。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkOptions {
    /// 块的目标 token 数。
    pub target_tokens: usize,
    /// 单块上限(来自 `embed.max_tokens`)。
    pub max_tokens: usize,
    /// 行窗口的行数。
    pub window_lines: usize,
    /// 行窗口的重叠行数。
    pub window_overlap: usize,
}

impl Default for ChunkOptions {
    fn default() -> Self {
        Self {
            target_tokens: 400,
            max_tokens: 512,
            window_lines: 60,
            window_overlap: 10,
        }
    }
}

impl ChunkOptions {
    /// 从配置构造。
    pub fn from_config(index: &IndexConfig, embed: &EmbedConfig) -> Self {
        Self {
            target_tokens: index.target_tokens.max(1),
            max_tokens: embed.max_tokens.max(32),
            window_lines: index.window_lines.max(1),
            window_overlap: index
                .window_overlap
                .min(index.window_lines.saturating_sub(1)),
        }
    }
}

/// 默认分块器:Markdown → tree-sitter → 纯文本窗口,按语言分派。
pub struct DefaultChunker {
    markdown: MarkdownChunker,
    code: TreeSitterChunker,
    plain: PlainChunker,
}

impl DefaultChunker {
    /// 构造。
    pub fn new(options: ChunkOptions) -> Self {
        Self {
            markdown: MarkdownChunker::new(options),
            code: TreeSitterChunker::new(options),
            plain: PlainChunker::new(options),
        }
    }
}

impl Chunker for DefaultChunker {
    fn supports(&self, _lang: &str) -> bool {
        true
    }

    fn chunk(&self, doc: &SourceDoc) -> Vec<Chunk> {
        if self.markdown.supports(&doc.lang) {
            self.markdown.chunk(doc)
        } else if self.code.supports(&doc.lang) {
            self.code.chunk(doc)
        } else {
            self.plain.chunk(doc)
        }
    }
}

/// 拼结构化上下文头:`<项目名> › <相对路径> › <外层符号> › <本符号签名首行>`。
///
/// 总长不超过 [`HEADER_MAX_TOKENS`],**不含行号**(行号一变就会触发重新嵌入)。
pub fn make_header(
    project: &str,
    source: &str,
    outer: Option<&str>,
    signature: Option<&str>,
) -> String {
    let mut parts: Vec<&str> = vec![project, source];
    if let Some(outer) = outer.filter(|value| !value.is_empty()) {
        parts.push(outer);
    }
    if let Some(signature) = signature.filter(|value| !value.is_empty()) {
        parts.push(signature);
    }
    let mut header = String::new();
    for part in parts {
        let candidate = if header.is_empty() {
            part.to_owned()
        } else {
            format!("{header} › {part}")
        };
        if estimate_tokens(&candidate) > HEADER_MAX_TOKENS {
            if header.is_empty() {
                header = truncate_to_tokens(part, HEADER_MAX_TOKENS);
            }
            break;
        }
        header = candidate;
    }
    header
}

/// 一段文本的 token 计数:非空白字符里 CJK 与其他字符各有多少个。
///
/// `kb_core::text::estimate_tokens` 就是 `cjk + other.div_ceil(4)`(空白不计),
/// 计数对拼接可加,所以逐字符 / 逐行增长一段文本时维护计数,就能在不重扫整段的前提下得到与
/// 每次整段重估完全一致的结果(整段重估是 O(n²))。这里复刻了它的统计规则(用的是同一个 `is_cjk`),
/// kb-core 那边改了规则这里要同步;`tests/markdown_equivalence.rs` 会立刻报警。
#[derive(Clone, Copy, Default)]
pub(crate) struct TokenCount {
    cjk: usize,
    other: usize,
}

impl TokenCount {
    /// 整段文本的计数。
    pub(crate) fn of(text: &str) -> Self {
        text.chars()
            .fold(Self::default(), |count, ch| count.plus(Self::of_char(ch)))
    }

    /// 单个字符的计数:空白为 0,CJK 记入 `cjk`,其余记入 `other`。
    pub(crate) fn of_char(ch: char) -> Self {
        if ch.is_whitespace() {
            Self::default()
        } else if is_cjk(ch) {
            Self { cjk: 1, other: 0 }
        } else {
            Self { cjk: 0, other: 1 }
        }
    }

    pub(crate) fn plus(self, other: Self) -> Self {
        Self {
            cjk: self.cjk + other.cjk,
            other: self.other + other.other,
        }
    }

    /// 与 `estimate_tokens` 同一个公式。
    pub(crate) fn estimate(self) -> usize {
        self.cjk + self.other.div_ceil(4)
    }
}

/// 按 token 上限截断字符串。
///
/// 逐字符累计 [`TokenCount`],不再每加一个字符就对整段重估(全是空白的超长标题会因此变成 O(n²));
/// 截断位置与整段重估时完全一致。
pub fn truncate_to_tokens(text: &str, max_tokens: usize) -> String {
    let mut out = String::new();
    let mut tokens = TokenCount::default();
    for ch in text.chars() {
        out.push(ch);
        tokens = tokens.plus(TokenCount::of_char(ch));
        if tokens.estimate() > max_tokens {
            out.pop();
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_joins_parts_with_arrows() {
        assert_eq!(
            make_header("demo", "src/lib.rs", Some("impl Config"), Some("fn new")),
            "demo › src/lib.rs › impl Config › fn new"
        );
        assert_eq!(
            make_header("demo", "README.md", None, None),
            "demo › README.md"
        );
        assert_eq!(
            make_header("demo", "a.rs", Some(""), Some("fn f")),
            "demo › a.rs › fn f"
        );
    }

    #[test]
    fn header_never_exceeds_the_token_limit() {
        let long = "x".repeat(1000);
        let header = make_header("demo", &long, Some(&long), Some(&long));
        assert!(estimate_tokens(&header) <= HEADER_MAX_TOKENS);
        assert!(header.starts_with("demo"));
    }

    #[test]
    fn header_has_no_line_numbers() {
        let header = make_header("demo", "src/lib.rs", Some("fn run"), Some("pub fn run()"));
        assert!(!header.chars().any(|ch| ch.is_ascii_digit()));
    }

    #[test]
    fn truncate_respects_the_limit() {
        assert_eq!(truncate_to_tokens("abcdefgh", 1), "abcd");
        assert_eq!(truncate_to_tokens("中文", 1), "中");
        assert_eq!(truncate_to_tokens("abc", 10), "abc");
    }

    #[test]
    fn options_come_from_config() {
        let index = IndexConfig::default();
        let embed = EmbedConfig::default();
        let options = ChunkOptions::from_config(&index, &embed);
        assert_eq!(options.target_tokens, 400);
        assert_eq!(options.max_tokens, 512);
        assert_eq!(options.window_lines, 60);
        assert_eq!(options.window_overlap, 10);
    }
}
