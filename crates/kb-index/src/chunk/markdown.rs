//! Markdown 分块（设计规范）。
//!
//! 用 pulldown-cmark 的带偏移解析:
//! - 按 H1–H3 切分小节,标题路径写进 header 与 title;
//! - 代码块保持完整,永远不会被切开;
//! - 超长小节按段落再切(段落边界落在代码块里时跳过)。

use std::collections::{HashMap, HashSet};

use kb_core::model::{Chunk, SourceDoc};
use kb_core::ports::Chunker;
use kb_core::text::estimate_tokens;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

use crate::chunk::window::split_text;
use crate::chunk::{ChunkOptions, TokenCount, truncate_to_tokens};

/// 标题路径的最大层级(只切分到 H3)。
pub const MAX_HEADING_LEVEL: u8 = 3;

/// Markdown 分块器。
pub struct MarkdownChunker {
    options: ChunkOptions,
}

impl MarkdownChunker {
    /// 构造。
    pub fn new(options: ChunkOptions) -> Self {
        Self { options }
    }

    /// 当前参数。
    pub fn options(&self) -> ChunkOptions {
        self.options
    }
}

impl Chunker for MarkdownChunker {
    fn supports(&self, lang: &str) -> bool {
        lang == "markdown"
    }

    fn chunk(&self, doc: &SourceDoc) -> Vec<Chunk> {
        chunk_markdown(doc, &self.options)
    }
}

/// 一个小节:[起始字节, 结束字节) 与它的标题路径。
#[derive(Clone, Debug, PartialEq, Eq)]
struct Section {
    start: usize,
    end: usize,
    headings: Vec<String>,
}

/// 把 Markdown 切成小节,再按 token 预算拆开超长小节。
///
/// 复杂度:小节起点的行号用游标只数增量,key 去重用「已知占到第几号」的记录,拆分小节时代码块区间与
/// token 累计都按游标 / 计数推进,整体是输入长度的线性。**输出(每块的 key / text / header / 行号 /
/// 标题,以及块的顺序与数量)必须与改造前逐字节一致**:chunk id 由 key 算出、行号进 meta_hash,
/// 输出变一点上线后全库的块都会被判成「变了」重新嵌入。`tests/markdown_equivalence.rs` 保留了
/// 改造前的实现,逐块对拍。
pub fn chunk_markdown(doc: &SourceDoc, options: &ChunkOptions) -> Vec<Chunk> {
    let sections = sections(&doc.text);
    let mut chunks = Vec::new();
    let mut ordinal = 0usize;
    let mut used_keys = UsedKeys::default();
    // 小节起点单调递增,游标只需要数相邻两个起点之间的换行
    let mut lines = LineCursor::new(&doc.text);
    for section in sections {
        let text = doc.text.get(section.start..section.end).unwrap_or("");
        if text.trim().is_empty() {
            continue;
        }
        let start_line = lines.line_of(section.start);
        let title = if section.headings.is_empty() {
            None
        } else {
            Some(section.headings.join(" › "))
        };
        let header = doc_header(&doc.project_name, &doc.source, &section.headings);
        let budget = options
            .max_tokens
            .saturating_sub(estimate_tokens(&header))
            .max(32);
        if estimate_tokens(text) <= budget {
            ordinal += 1;
            let key = used_keys.unique_key(title.clone().unwrap_or_else(|| format!("#{ordinal}")));
            chunks.push(Chunk {
                key,
                text: text.to_owned(),
                start_line,
                end_line: start_line + text.lines().count() as i32 - 1,
                symbol: None,
                title,
                header,
                anchor: None,
            });
            continue;
        }
        for (index, piece) in split_section(&doc.text, &section, start_line, budget, options)
            .into_iter()
            .enumerate()
        {
            ordinal += 1;
            let base = match (&title, index) {
                (Some(title), 0) => title.clone(),
                (Some(title), _) => format!("{title} #{}", index + 1),
                (None, _) => format!("#{ordinal}"),
            };
            let key = used_keys.unique_key(base);
            chunks.push(Chunk {
                key,
                text: piece.text,
                start_line: piece.start_line,
                end_line: piece.end_line,
                symbol: None,
                title: title.clone(),
                header: header.clone(),
                anchor: None,
            });
        }
    }
    chunks
}

/// 一份文档里已经分配过的 key。
///
/// key 必须唯一(重复的标题路径很常见),撞了就加 ` #2`、` #3`… 后缀。
#[derive(Default)]
struct UsedKeys {
    used: HashSet<String>,
    /// `base` → 已确认 `base`、`base #2` … `base #N` 全部被占用的最大 N(1 表示只有 `base` 本身,不记录)。
    ///
    /// 旧实现每次都从 `base` 起逐个试到第一个空位,第 k 个重复要试 k 次,合计 O(k²);
    /// 一万个同名标题就是上亿次 `format!` + 查表。`used` 只增不减,所以「`base` 到 `base #N` 都已被占」
    /// 这件事一旦成立就永远成立,下次可以直接从 N 接着往后试。结果与逐个试完全一致,
    /// 包括字面标题恰好叫 `示例 #2` 这类撞上自动后缀的情形(循环里照样查 `used`,撞上就继续加)。
    resume_at: HashMap<String, usize>,
}

impl UsedKeys {
    fn unique_key(&mut self, base: String) -> String {
        let mut counter = self.resume_at.get(&base).copied().unwrap_or(1);
        let mut key = if counter == 1 {
            base.clone()
        } else {
            format!("{base} #{counter}")
        };
        while self.used.contains(&key) {
            counter += 1;
            key = format!("{base} #{counter}");
        }
        if counter > 1 {
            self.resume_at.insert(base, counter);
        }
        self.used.insert(key.clone());
        key
    }
}

/// 扫描标题,切出 H1–H3 小节(第一个标题之前的内容单独成节)。
fn sections(text: &str) -> Vec<Section> {
    let mut headings: Vec<(usize, u8, String)> = Vec::new();
    let mut current: Option<(u8, String)> = None;
    let mut in_heading = false;
    for (event, range) in Parser::new_ext(text, Options::ENABLE_TABLES).into_offset_iter() {
        match event {
            Event::Start(Tag::Heading { level, .. }) => {
                current = Some((level as u8, String::new()));
                in_heading = true;
                let _ = range;
            }
            Event::Text(value) | Event::Code(value) if in_heading => {
                if let Some((_, title)) = current.as_mut() {
                    title.push_str(&value);
                }
            }
            Event::End(TagEnd::Heading(_)) => {
                if let Some((level, title)) = current.take()
                    && level <= MAX_HEADING_LEVEL
                {
                    headings.push((range.start, level, title.trim().to_owned()));
                }
                in_heading = false;
            }
            _ => {}
        }
    }

    let mut sections: Vec<Section> = Vec::new();
    let mut stack: Vec<String> = Vec::new();
    let mut section_start = 0usize;
    for (offset, level, title) in headings {
        if offset > section_start {
            sections.push(Section {
                start: section_start,
                end: offset,
                headings: stack.clone(),
            });
        }
        stack.truncate(level.saturating_sub(1) as usize);
        stack.push(title);
        section_start = offset;
    }
    if section_start < text.len() {
        sections.push(Section {
            start: section_start,
            end: text.len(),
            headings: stack,
        });
    }
    sections
}

/// 超长小节按段落切开,代码块保持完整。
///
/// `base_line` 是小节起点的行号(1 起),由调用方算好传进来,这里不再数一遍前缀的换行。
///
/// 这个循环是输入长度的线性,靠三件事:
/// - `in_code` 用 [`CodeCursor`] 随行偏移单调推进,不再每行扫全部代码块区间;
/// - 「加上这一行是否超预算」用 [`TokenCount`] 累计 `current` 的 token 计数,不再每行把整段拼起来重估
///   (代码块里 `current` 不会被冲刷,会长成整个代码块,旧写法对 N 行的块是 O(N²));
/// - 每片的起始行号随行推进累计,不再对小节前缀数换行。
fn split_section(
    text: &str,
    section: &Section,
    base_line: i32,
    budget: usize,
    options: &ChunkOptions,
) -> Vec<crate::chunk::window::WindowPiece> {
    let body = text.get(section.start..section.end).unwrap_or("");
    let mut code = CodeCursor::new(code_block_ranges(body));
    let mut pieces = Vec::new();
    // current 的起点相对小节起点已经过了几个换行:片的起始行号 = base_line + 这个数。
    // 起点永远落在某一行的行首(或正文末尾),所以它就是「起点之前已消费的整行数」
    let mut current_start_newlines = 0i32;
    let mut current = String::new();
    let mut current_tokens = TokenCount::default();
    let mut offset = 0usize;
    // body[..offset] 里的换行数
    let mut newlines_before = 0i32;
    for line in body.split_inclusive('\n') {
        let line_end = offset + line.len();
        let in_code = code.contains_line(offset, line_end);
        let line_tokens = TokenCount::of(line);
        // 旧写法:candidate = current + line,再整段 estimate_tokens。
        // token 估算只看非空白字符的 (CJK 数, 其他数),拼接前后计数可加,所以结果相同
        let over_budget = current_tokens.plus(line_tokens).estimate() > budget;
        let line_newline = i32::from(line.ends_with('\n'));
        let is_paragraph_break = line.trim().is_empty() && !in_code;
        if over_budget && !current.is_empty() && !in_code {
            pieces.push(make_piece(&current, base_line + current_start_newlines));
            current.clear();
            current_tokens = TokenCount::default();
            current_start_newlines = newlines_before;
        }
        current.push_str(line);
        current_tokens = current_tokens.plus(line_tokens);
        if is_paragraph_break {
            // 段落边界:如果已经接近预算就断开
            if current_tokens.estimate() >= budget / 2 {
                pieces.push(make_piece(&current, base_line + current_start_newlines));
                current.clear();
                current_tokens = TokenCount::default();
                current_start_newlines = newlines_before + line_newline;
            }
        }
        offset = line_end;
        newlines_before += line_newline;
    }
    if !current.trim().is_empty() {
        pieces.push(make_piece(&current, base_line + current_start_newlines));
    }
    // 兜底:仍然超长的片段(例如一个超长代码块)按行窗口切
    let mut result = Vec::new();
    for piece in pieces {
        if estimate_tokens(&piece.text) <= budget {
            result.push(piece);
        } else {
            result.extend(split_text(&piece.text, piece.start_line, options, budget));
        }
    }
    result
}

/// 判断某一行是否完整落在某个代码块区间里的游标。
///
/// 旧写法每行对全部区间做 `.any(|(s, e)| offset >= s && line_end <= e)`,O(行数 × 区间数)。
/// 行偏移单调递增,所以把区间按起点排序后用游标前移,累计「起点 ≤ 当前行首」的所有区间里最大的终点:
/// 存在区间同时满足 `s <= offset` 与 `line_end <= e`,当且仅当这个最大终点 ≥ `line_end`。
/// 这不依赖区间互不重叠或本来就有序(解析器给的区间恰好是有序不重叠的,但这里不赌这一点),
/// 对任意区间集合都与 `.any` 等价。
struct CodeCursor {
    ranges: Vec<(usize, usize)>,
    next: usize,
    /// 已前移过的区间里最大的终点;还没有区间的起点 ≤ 行首时为 `None`。
    furthest_end: Option<usize>,
}

impl CodeCursor {
    fn new(mut ranges: Vec<(usize, usize)>) -> Self {
        ranges.sort_by_key(|&(start, _)| start);
        Self {
            ranges,
            next: 0,
            furthest_end: None,
        }
    }

    /// `offset` 必须随调用单调不减(逐行消费正文时天然满足)。
    fn contains_line(&mut self, offset: usize, line_end: usize) -> bool {
        while let Some(&(start, end)) = self.ranges.get(self.next)
            && start <= offset
        {
            self.furthest_end = Some(self.furthest_end.map_or(end, |furthest| furthest.max(end)));
            self.next += 1;
        }
        self.furthest_end
            .is_some_and(|furthest| line_end <= furthest)
    }
}

fn make_piece(text: &str, start_line: i32) -> crate::chunk::window::WindowPiece {
    let line_count = text.trim_end_matches('\n').lines().count().max(1) as i32;
    crate::chunk::window::WindowPiece {
        text: text.to_owned(),
        start_line,
        end_line: start_line + line_count - 1,
    }
}

/// 代码块(含围栏)在正文里的字节区间。
fn code_block_ranges(body: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start: Option<usize> = None;
    for (event, range) in Parser::new_ext(body, Options::ENABLE_TABLES).into_offset_iter() {
        match event {
            Event::Start(Tag::CodeBlock(_)) => start = Some(range.start),
            Event::End(TagEnd::CodeBlock) => {
                if let Some(start) = start.take() {
                    ranges.push((start, range.end));
                }
            }
            _ => {}
        }
    }
    ranges
}

/// 字节偏移 → 行号(1 起)的游标。
///
/// 旧写法每次都对 `text[..offset]` 整段数换行,小节有 N 个就是 O(N × 文件大小)。
/// 小节起点单调递增,游标记住上次的 (偏移, 换行数),只数两次之间的增量;
/// 万一偏移往回退(正常调用不会),从头重数,结果依旧正确。
struct LineCursor<'a> {
    text: &'a str,
    /// 上次查询的偏移,总是字符边界。
    offset: usize,
    /// `text[..offset]` 里的换行数。
    newlines: usize,
}

impl<'a> LineCursor<'a> {
    fn new(text: &'a str) -> Self {
        Self {
            text,
            offset: 0,
            newlines: 0,
        }
    }

    fn line_of(&mut self, offset: usize) -> i32 {
        // 旧写法 `text.get(..offset)` 在偏移越界或不在字符边界时是 None,行号按 1 算;
        // 解析器给的偏移不会这样,但保持同样的兜底,输出才对任何输入都一致
        if !self.text.is_char_boundary(offset) {
            return 1;
        }
        if offset < self.offset {
            self.offset = 0;
            self.newlines = 0;
        }
        self.newlines += self
            .text
            .get(self.offset..offset)
            .unwrap_or_default()
            .matches('\n')
            .count();
        self.offset = offset;
        self.newlines as i32 + 1
    }
}

/// 文档类 header:`<项目名> › <相对路径> › <H1> › <H2> › <H3>`。
pub fn doc_header(project: &str, source: &str, headings: &[String]) -> String {
    let mut parts: Vec<&str> = vec![project, source];
    parts.extend(headings.iter().map(String::as_str));
    let joined = parts.join(" › ");
    truncate_to_tokens(&joined, crate::chunk::HEADER_MAX_TOKENS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(text: &str) -> SourceDoc {
        SourceDoc {
            source: "docs/guide.md".to_owned(),
            lang: "markdown".to_owned(),
            text: text.to_owned(),
            file_hash: "h".to_owned(),
            size: text.len() as u64,
            mtime: 0,
            project_name: "demo".to_owned(),
        }
    }

    fn chunker() -> MarkdownChunker {
        MarkdownChunker::new(ChunkOptions::default())
    }

    #[test]
    fn supports_only_markdown() {
        assert!(chunker().supports("markdown"));
        assert!(!chunker().supports("text"));
    }

    #[test]
    fn splits_by_h1_to_h3_and_keeps_heading_path() {
        let text = "# 标题一\n\n正文 A\n\n## 小节 1.1\n\n正文 B\n\n### 更深\n\n正文 C\n\n#### 不切分\n\n正文 D\n";
        let chunks = chunker().chunk(&doc(text));
        let titles: Vec<Option<&str>> = chunks.iter().map(|chunk| chunk.title.as_deref()).collect();
        assert_eq!(
            titles,
            vec![
                Some("标题一"),
                Some("标题一 › 小节 1.1"),
                Some("标题一 › 小节 1.1 › 更深"),
            ]
        );
        // H4 不单独成节,留在 H3 小节里
        assert!(chunks[2].text.contains("#### 不切分"));
        assert_eq!(
            chunks[2].header,
            "demo › docs/guide.md › 标题一 › 小节 1.1 › 更深"
        );
    }

    #[test]
    fn content_before_the_first_heading_becomes_its_own_chunk() {
        let text = "引言段落\n\n# 标题\n\n正文\n";
        let chunks = chunker().chunk(&doc(text));
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].key, "#1");
        assert!(chunks[0].title.is_none());
        assert!(chunks[0].text.contains("引言段落"));
        assert_eq!(chunks[1].title.as_deref(), Some("标题"));
    }

    #[test]
    fn code_blocks_are_never_cut() {
        let code = "```rust\nfn main() {\n    println!(\"hi\");\n}\n```\n";
        let mut text = String::from("# 示例\n\n");
        for index in 0..30 {
            text.push_str(&format!("段落 {index}: 一些说明文字,用来把小节撑大。\n\n"));
        }
        text.push_str(code);
        let options = ChunkOptions {
            max_tokens: 60,
            ..ChunkOptions::default()
        };
        let chunks = MarkdownChunker::new(options).chunk(&doc(&text));
        let with_code: Vec<&Chunk> = chunks
            .iter()
            .filter(|chunk| chunk.text.contains("```rust"))
            .collect();
        assert_eq!(with_code.len(), 1, "代码块应完整落在同一个块里");
        assert!(with_code[0].text.contains("println!(\"hi\")"));
        assert!(with_code[0].text.trim_end().ends_with("```"));
    }

    #[test]
    fn oversized_section_is_split_by_paragraphs() {
        let mut text = String::from("# 长小节\n\n");
        for index in 0..40 {
            text.push_str(&format!(
                "这是第 {index} 段,包含足够多的文字让整个小节超过预算。\n\n"
            ));
        }
        let options = ChunkOptions {
            max_tokens: 80,
            ..ChunkOptions::default()
        };
        let chunks = MarkdownChunker::new(options).chunk(&doc(&text));
        assert!(chunks.len() > 1);
        assert_eq!(chunks[0].key, "长小节");
        assert_eq!(chunks[1].key, "长小节 #2");
        for chunk in &chunks {
            assert!(
                estimate_tokens(&chunk.text) <= 80,
                "块 {} 超预算",
                chunk.key
            );
            assert_eq!(chunk.title.as_deref(), Some("长小节"));
        }
    }

    #[test]
    fn empty_text_yields_no_chunks() {
        assert!(chunker().chunk(&doc("")).is_empty());
        assert!(chunker().chunk(&doc("\n\n\n")).is_empty());
    }

    #[test]
    fn duplicate_heading_paths_get_unique_keys() {
        let text = "# Doc\n\n## Example\n\n第一段\n\n## Example\n\n第二段\n";
        let chunks = chunker().chunk(&doc(text));
        let keys: Vec<&str> = chunks.iter().map(|chunk| chunk.key.as_str()).collect();
        assert_eq!(keys.len(), 3);
        assert_ne!(keys[1], keys[2], "同名标题的 key 必须不同:{keys:?}");
        assert_eq!(keys[1], "Doc › Example");
        assert_eq!(keys[2], "Doc › Example #2");
    }

    #[test]
    fn doc_header_includes_the_heading_path() {
        assert_eq!(
            doc_header("demo", "docs/a.md", &["一".to_owned(), "二".to_owned()]),
            "demo › docs/a.md › 一 › 二"
        );
    }
}
