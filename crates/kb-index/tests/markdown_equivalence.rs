//! Markdown 分块器新旧实现对拍。
//!
//! 背景:`chunk_markdown` 里有五处二次复杂度(逐小节数换行、重复标题循环加后缀、逐行扫全部代码块区间、
//! 逐行拼接整段再估 token、逐片数换行)。改成线性之后,**分块输出必须与改造前逐字节相同**:
//! chunk id 由 `key` 算出、行号进 `meta_hash`,输出只要变一点,上线后全库约 23 万块都会被判成「变了」重新嵌入。
//!
//! 做法:`legacy` 模块是改造前实现的原样副本(连同它依赖的 `truncate_to_tokens`、`split_text`、
//! `split_long_line`),只用来对拍,**不要优化、不要「顺手修」**。下面的用例把同一份文档分别交给
//! 旧实现和 `MarkdownChunker`,逐块比较 `Chunk` 的全部字段(key / text / header / start_line /
//! end_line / symbol / title / anchor)以及块的顺序和数量。
//!
//! 输入来源:
//! - 手写边界用例(空文档、只有标题、重复标题与字面撞上自动后缀、两种围栏、围栏未闭合、围栏里的假标题、
//!   嵌套列表、表格、CRLF、中日韩长句、超长单行、BOM、末尾无换行等),每个都跑遍全部参数预设;
//! - token 预算边界扫描:行长 × 行数 × 预算 × 版式(紧凑 / 空行分段 / 围栏内 / 中文)穷举;
//! - 窗口切分与 header 截断(`split_text` / `truncate_to_tokens`)的直接对拍,它们是 Markdown 兜底路径与
//!   纯文本、代码超长叶子共用的底层;
//! - 确定性伪随机文档(自己写的 xorshift,`kb-index` 没有 rand / proptest,不加依赖):
//!   小文档几千份、中等文档几百份、大文档若干份(最大约 300KB),种子固定,失败时报告里带种子可原样复现。

use std::collections::HashSet;

use kb_core::model::{Chunk, SourceDoc};
use kb_core::ports::Chunker;
use kb_core::text::estimate_tokens;
use kb_index::chunk::{ChunkOptions, MarkdownChunker};

// ---------------------------------------------------------------------------
// 改造前的实现,只用来对拍,不要优化
// ---------------------------------------------------------------------------
mod legacy {
    //! 改造前的实现(master 5b5f3539 的 `chunk/markdown.rs`、`chunk/mod.rs::truncate_to_tokens`、
    //! `chunk/window.rs::{split_text, split_long_line}`),原样复制,只用来对拍,不要优化。

    use std::collections::HashSet;

    use kb_core::model::{Chunk, SourceDoc};
    use kb_core::text::estimate_tokens;
    use kb_index::chunk::{ChunkOptions, HEADER_MAX_TOKENS};
    use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

    /// 标题路径的最大层级(只切分到 H3)。
    const MAX_HEADING_LEVEL: u8 = 3;

    /// 一个窗口片段。
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct WindowPiece {
        pub text: String,
        pub start_line: i32,
        pub end_line: i32,
    }

    /// 一个小节:[起始字节, 结束字节) 与它的标题路径。
    #[derive(Clone, Debug, PartialEq, Eq)]
    struct Section {
        start: usize,
        end: usize,
        headings: Vec<String>,
    }

    /// 把 Markdown 切成小节,再按 token 预算拆开超长小节。
    pub fn chunk_markdown(doc: &SourceDoc, options: &ChunkOptions) -> Vec<Chunk> {
        let sections = sections(&doc.text);
        let mut chunks = Vec::new();
        let mut ordinal = 0usize;
        let mut used_keys: HashSet<String> = HashSet::new();
        for section in sections {
            let text = doc.text.get(section.start..section.end).unwrap_or("");
            if text.trim().is_empty() {
                continue;
            }
            let start_line = line_of(&doc.text, section.start);
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
                let key = unique_key(
                    &mut used_keys,
                    title.clone().unwrap_or_else(|| format!("#{ordinal}")),
                );
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
            for (index, piece) in split_section(&doc.text, &section, budget, options)
                .into_iter()
                .enumerate()
            {
                ordinal += 1;
                let base = match (&title, index) {
                    (Some(title), 0) => title.clone(),
                    (Some(title), _) => format!("{title} #{}", index + 1),
                    (None, _) => format!("#{ordinal}"),
                };
                let key = unique_key(&mut used_keys, base);
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

    /// 同一份文档里 key 必须唯一(重复的标题路径很常见)。
    fn unique_key(used: &mut HashSet<String>, base: String) -> String {
        let mut key = base.clone();
        let mut counter = 1usize;
        while used.contains(&key) {
            counter += 1;
            key = format!("{base} #{counter}");
        }
        used.insert(key.clone());
        key
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
    fn split_section(
        text: &str,
        section: &Section,
        budget: usize,
        options: &ChunkOptions,
    ) -> Vec<WindowPiece> {
        let body = text.get(section.start..section.end).unwrap_or("");
        let base_line = line_of(text, section.start);
        let code_ranges = code_block_ranges(body);
        let mut pieces = Vec::new();
        let mut current_start = 0usize;
        let mut current = String::new();
        let mut offset = 0usize;
        for line in body.split_inclusive('\n') {
            let line_end = offset + line.len();
            let in_code = code_ranges
                .iter()
                .any(|(start, end)| offset >= *start && line_end <= *end);
            let candidate = if current.is_empty() {
                line.to_owned()
            } else {
                format!("{current}{line}")
            };
            let over_budget = estimate_tokens(&candidate) > budget;
            let is_paragraph_break = line.trim().is_empty() && !in_code;
            if over_budget && !current.is_empty() && !in_code {
                let start_line = line_at(body, current_start, base_line);
                pieces.push(make_piece(&current, start_line));
                current.clear();
                current_start = offset;
            }
            current.push_str(line);
            if is_paragraph_break {
                // 段落边界:如果已经接近预算就断开
                if estimate_tokens(&current) >= budget / 2 {
                    let start_line = line_at(body, current_start, base_line);
                    pieces.push(make_piece(&current, start_line));
                    current.clear();
                    current_start = line_end;
                }
            }
            offset = line_end;
        }
        if !current.trim().is_empty() {
            let start_line = line_at(body, current_start, base_line);
            pieces.push(make_piece(&current, start_line));
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

    /// 正文里某个字节偏移对应的行号。
    fn line_at(body: &str, offset: usize, base_line: i32) -> i32 {
        base_line + body.get(..offset).unwrap_or_default().matches('\n').count() as i32
    }

    fn make_piece(text: &str, start_line: i32) -> WindowPiece {
        let line_count = text.trim_end_matches('\n').lines().count().max(1) as i32;
        WindowPiece {
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

    /// 字节偏移对应的行号(1 起)。
    fn line_of(text: &str, offset: usize) -> i32 {
        text.get(..offset)
            .map(|prefix| prefix.matches('\n').count() as i32 + 1)
            .unwrap_or(1)
    }

    /// 文档类 header:`<项目名> › <相对路径> › <H1> › <H2> › <H3>`。
    pub fn doc_header(project: &str, source: &str, headings: &[String]) -> String {
        let mut parts: Vec<&str> = vec![project, source];
        parts.extend(headings.iter().map(String::as_str));
        let joined = parts.join(" › ");
        truncate_to_tokens(&joined, HEADER_MAX_TOKENS)
    }

    /// 按 token 上限截断字符串(`chunk/mod.rs` 的改造前版本)。
    pub fn truncate_to_tokens(text: &str, max_tokens: usize) -> String {
        let mut out = String::new();
        for ch in text.chars() {
            out.push(ch);
            if estimate_tokens(&out) > max_tokens {
                out.pop();
                break;
            }
        }
        out
    }

    /// 把一段文本按行切成窗口(`chunk/window.rs` 的改造前版本)。
    pub fn split_text(
        text: &str,
        first_line: i32,
        options: &ChunkOptions,
        max_tokens: usize,
    ) -> Vec<WindowPiece> {
        let lines: Vec<&str> = text.lines().collect();
        if lines.is_empty() {
            return Vec::new();
        }
        let mut pieces = Vec::new();
        let mut start = 0usize;
        while start < lines.len() {
            let mut end = start;
            let mut current = String::new();
            while end < lines.len() && (end - start) < options.window_lines {
                let line = lines[end];
                let candidate = if current.is_empty() {
                    line.to_owned()
                } else {
                    format!("{current}\n{line}")
                };
                if estimate_tokens(&candidate) > max_tokens {
                    if end == start {
                        // 单行本身就超长:按字符切开,行号保持不变
                        for piece in split_long_line(line, max_tokens) {
                            pieces.push(WindowPiece {
                                text: piece,
                                start_line: first_line + start as i32,
                                end_line: first_line + start as i32,
                            });
                        }
                        end += 1;
                        current.clear();
                    }
                    break;
                }
                current = candidate;
                end += 1;
            }
            if !current.is_empty() {
                pieces.push(WindowPiece {
                    text: current,
                    start_line: first_line + start as i32,
                    end_line: first_line + end as i32 - 1,
                });
            }
            if end >= lines.len() {
                break;
            }
            let next = end.saturating_sub(options.window_overlap).max(start + 1);
            start = next;
        }
        pieces
    }

    /// 把超长单行按 token 预算切成多段。
    fn split_long_line(line: &str, max_tokens: usize) -> Vec<String> {
        let mut pieces = Vec::new();
        let mut current = String::new();
        for ch in line.chars() {
            current.push(ch);
            if estimate_tokens(&current) > max_tokens {
                current.pop();
                if !current.is_empty() {
                    pieces.push(std::mem::take(&mut current));
                }
                current.push(ch);
            }
        }
        if !current.is_empty() {
            pieces.push(current);
        }
        pieces
    }
}

// ---------------------------------------------------------------------------
// 确定性伪随机:xorshift64,不引入 rand / proptest
// ---------------------------------------------------------------------------

/// xorshift64 伪随机数发生器;相同种子永远给出相同序列,失败用例可以原样复现。
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        // 先过一遍 splitmix64:相邻种子(0, 1, 2…)直接喂 xorshift 前几项高度相关
        let mut z = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        // xorshift 的状态不能为 0
        Self(if z == 0 { 0x2545_F491_4F6C_DD1D } else { z })
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// `[0, n)`;取高位,xorshift 的低位质量较差。
    fn below(&mut self, n: usize) -> usize {
        ((self.next() >> 16) % n as u64) as usize
    }

    /// `[lo, hi]` 闭区间。
    fn range(&mut self, lo: usize, hi: usize) -> usize {
        lo + self.below(hi - lo + 1)
    }

    fn chance(&mut self, percent: usize) -> bool {
        self.below(100) < percent
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len())]
    }

    /// 按权重挑下标。
    fn weighted(&mut self, weights: &[usize]) -> usize {
        let total: usize = weights.iter().sum();
        let mut roll = self.below(total);
        for (index, weight) in weights.iter().enumerate() {
            if roll < *weight {
                return index;
            }
            roll -= weight;
        }
        weights.len() - 1
    }
}

// ---------------------------------------------------------------------------
// 文档生成器
// ---------------------------------------------------------------------------

/// 标题池刻意很小,并含「字面上就带 #N 后缀」的标题,逼出重复标题与自动后缀互相撞的情况。
const TITLE_POOL: &[&str] = &[
    "示例",
    "示例 #2",
    "示例 #3",
    "Example",
    "Example #2",
    "Example #3",
    "概述",
    "API",
    "A",
    "B",
    "Intro",
    "Intro #2",
    "a › b",
    "x #2 #3",
    "#",
];

const ASCII_WORDS: &[&str] = &[
    "the",
    "index",
    "chunk",
    "embedding",
    "fn",
    "let",
    "value",
    "Config",
    "HTTPServer",
    "snake_case",
    "x",
    "a",
    "API",
    "token",
    "kb",
    "search",
    "tree-sitter",
    "println!",
    "vec![]",
    "0",
    "42",
    "3.14",
    "foo.bar()",
    "https://example.com/a?b=1",
    "`code`",
    "**bold**",
    "*em*",
    "[link](http://x.y)",
    "<br>",
    "&amp;",
    "a|b",
    "1.",
    ">",
    "\\#",
    "#hash",
    "~",
    "```",
    "~~~",
    "---",
    "|",
];

const CJK_SNIPPETS: &[&str] = &[
    "增量索引",
    "双哈希",
    "知识库",
    "向量检索与全文检索",
    "，",
    "。",
    "、",
    "「引号」",
    "日本語のテキスト",
    "ひらがなカタカナ",
    "한국어 텍스트",
    "全角\u{3000}空格",
    "示例",
];

/// 各种怪字符:emoji、ZWJ 序列、组合记号、各类空白(全角空格、NBSP、行分隔符、零宽空格、BOM)。
const ODD_SNIPPETS: &[&str] = &[
    "😀",
    "👨\u{200D}👩\u{200D}👧",
    "é",
    "e\u{0301}",
    "\u{00A0}",
    "\u{3000}",
    "\u{2028}",
    "\u{200B}",
    "\u{FEFF}",
    "ß",
    "İ",
    "Ａ",
];

/// 每种文档的「口味」:各类块的权重与代码块、行的长度。
struct Profile {
    /// 顺序:标题 / 段落 / 围栏 / 缩进代码 / 列表 / 表格 / 引用 / HTML / 分隔线 / 空行 / 长单行 / 列表内围栏
    weights: [usize; 12],
    /// 围栏代码块的行数范围。
    code_lines: (usize, usize),
    /// 段落每行的词数范围。
    line_words: (usize, usize),
}

const PROFILES: &[Profile] = &[
    // 混合
    Profile {
        weights: [14, 30, 10, 3, 10, 4, 5, 2, 2, 4, 2, 3],
        code_lines: (0, 12),
        line_words: (1, 14),
    },
    // 标题密集:小节很多、正文很短
    Profile {
        weights: [60, 15, 4, 1, 5, 2, 2, 1, 2, 4, 1, 1],
        code_lines: (0, 4),
        line_words: (1, 6),
    },
    // 代码密集:大块围栏
    Profile {
        weights: [5, 15, 45, 5, 3, 1, 2, 1, 1, 2, 1, 10],
        code_lines: (5, 120),
        line_words: (1, 10),
    },
    // 长文:段落多、标题少,小节很容易超预算
    Profile {
        weights: [3, 80, 3, 1, 8, 2, 2, 0, 1, 5, 1, 1],
        code_lines: (0, 8),
        line_words: (4, 30),
    },
    // 长行:单行超过预算,走窗口兜底里的 split_long_line
    Profile {
        weights: [5, 20, 10, 0, 3, 1, 1, 0, 1, 2, 50, 1],
        code_lines: (1, 6),
        line_words: (1, 10),
    },
];

fn word(rng: &mut Rng) -> String {
    match rng.weighted(&[55, 25, 8, 6, 6]) {
        0 => rng.pick(ASCII_WORDS).to_owned(),
        1 => rng.pick(CJK_SNIPPETS).to_owned(),
        2 => {
            // 一小串随机汉字 / 假名 / 谚文音节
            let base = rng.pick(&[0x4E00u32, 0x3040, 0xAC00, 0x3400]);
            (0..rng.range(1, 8))
                .filter_map(|_| char::from_u32(base + rng.below(0x200) as u32))
                .collect()
        }
        3 => rng.pick(ODD_SNIPPETS).to_owned(),
        _ => {
            // 随机字母数字词
            (0..rng.range(1, 12))
                .map(|_| rng.pick(&['a', 'b', 'c', 'x', 'Z', '0', '9', '_']))
                .collect()
        }
    }
}

fn sentence(rng: &mut Rng, words: (usize, usize)) -> String {
    let count = rng.range(words.0, words.1);
    let glue = if rng.chance(70) { " " } else { "" };
    (0..count).map(|_| word(rng)).collect::<Vec<_>>().join(glue)
}

fn title(rng: &mut Rng) -> String {
    match rng.weighted(&[50, 30, 20]) {
        0 => rng.pick(TITLE_POOL).to_owned(),
        1 => sentence(rng, (1, 4)),
        _ => format!(
            "{} `{}` *{}*",
            rng.pick(CJK_SNIPPETS),
            rng.pick(ASCII_WORDS),
            word(rng)
        ),
    }
}

fn heading(out: &mut String, rng: &mut Rng) {
    let level = [1, 2, 3, 4, 5, 6][rng.weighted(&[25, 35, 25, 8, 4, 3])];
    match rng.weighted(&[80, 10, 10]) {
        0 => {
            // ATX 标题:缩进 0~3 个空格、可带闭合 #、可为空
            let indent = if rng.chance(90) { 0 } else { rng.range(1, 3) };
            out.push_str(&" ".repeat(indent));
            out.push_str(&"#".repeat(level));
            if !rng.chance(5) {
                out.push(' ');
                out.push_str(&title(rng));
                if rng.chance(10) {
                    out.push_str(" ##");
                }
            }
            out.push('\n');
        }
        1 => {
            // Setext 标题
            out.push_str(&title(rng));
            out.push('\n');
            out.push_str(if rng.chance(50) { "=====\n" } else { "-----\n" });
        }
        _ => {
            // `#` 后面没有空格:CommonMark 里不是标题
            out.push('#');
            out.push_str(&title(rng));
            out.push('\n');
        }
    }
}

fn paragraph(out: &mut String, rng: &mut Rng, profile: &Profile) {
    for _ in 0..rng.range(1, 6) {
        out.push_str(&sentence(rng, profile.line_words));
        if rng.chance(5) {
            out.push_str("  "); // 行尾两个空格 = 硬换行
        }
        out.push('\n');
    }
}

fn code_line(rng: &mut Rng) -> String {
    match rng.weighted(&[60, 8, 5, 5, 5, 17]) {
        0 => format!(
            "{}let {} = {};",
            "    ".repeat(rng.below(3)),
            word(rng),
            rng.below(1000)
        ),
        1 => format!("{} 假标题 {}", "#".repeat(rng.range(1, 3)), word(rng)),
        2 => String::new(),
        3 => "```".to_owned(),
        4 => "~~~".to_owned(),
        _ => sentence(rng, (1, 8)),
    }
}

fn fenced_code(out: &mut String, rng: &mut Rng, profile: &Profile, indent: &str) {
    let fence_char = if rng.chance(70) { '`' } else { '~' };
    let fence_len = if rng.chance(85) { 3 } else { rng.range(4, 5) };
    let fence: String = std::iter::repeat_n(fence_char, fence_len).collect();
    let info = match rng.below(6) {
        0 => "",
        1 => "rust",
        2 => "text",
        3 => "python title=x",
        4 => "{.class}",
        // 反引号围栏的 info 里不能再有反引号:这种写法不是围栏
        _ => "a`b",
    };
    out.push_str(indent);
    out.push_str(&fence);
    out.push_str(info);
    out.push('\n');
    let lines = rng.range(profile.code_lines.0, profile.code_lines.1);
    for _ in 0..lines {
        out.push_str(indent);
        out.push_str(&code_line(rng));
        out.push('\n');
    }
    // 少量围栏不闭合:一直吞到文档(或容器)结束
    if !rng.chance(6) {
        out.push_str(indent);
        out.push_str(&fence);
        if rng.chance(20) {
            out.push(fence_char); // 闭合围栏可以比开启的更长
        }
        out.push('\n');
    }
}

fn indented_code(out: &mut String, rng: &mut Rng) {
    out.push('\n');
    let prefix = if rng.chance(80) { "    " } else { "\t" };
    for _ in 0..rng.range(1, 6) {
        out.push_str(prefix);
        out.push_str(&code_line(rng));
        out.push('\n');
    }
}

fn list(out: &mut String, rng: &mut Rng, profile: &Profile) {
    let ordered = rng.chance(40);
    for index in 0..rng.range(1, 8) {
        let depth = rng.below(3);
        out.push_str(&" ".repeat(depth * rng.range(2, 4)));
        if ordered {
            out.push_str(&format!("{}{} ", index + 1, rng.pick(&['.', ')'])));
        } else {
            out.push(rng.pick(&['-', '*', '+']));
            out.push(' ');
        }
        out.push_str(&sentence(rng, profile.line_words));
        out.push('\n');
        if rng.chance(15) {
            out.push('\n'); // 松散列表
        }
    }
}

fn table(out: &mut String, rng: &mut Rng) {
    let cols = rng.range(1, 4);
    let row = |rng: &mut Rng| {
        let cells: Vec<String> = (0..cols).map(|_| word(rng)).collect();
        format!("| {} |\n", cells.join(" | "))
    };
    out.push_str(&row(rng));
    out.push_str(&format!("|{}\n", "---|".repeat(cols)));
    for _ in 0..rng.range(1, 6) {
        out.push_str(&row(rng));
    }
}

fn quote(out: &mut String, rng: &mut Rng, profile: &Profile) {
    for _ in 0..rng.range(1, 4) {
        out.push_str("> ");
        out.push_str(&sentence(rng, profile.line_words));
        out.push('\n');
    }
    if rng.chance(25) {
        out.push_str("> ```\n> code\n> ```\n");
    }
}

fn html_block(out: &mut String, rng: &mut Rng, profile: &Profile) {
    if rng.chance(30) {
        out.push_str("<!-- ");
        out.push_str(&sentence(rng, (1, 5)));
        out.push_str(" -->\n");
    } else {
        out.push_str("<div>\n");
        out.push_str(&sentence(rng, profile.line_words));
        out.push_str("\n</div>\n");
    }
}

fn blank_lines(out: &mut String, rng: &mut Rng) {
    for _ in 0..rng.range(1, 3) {
        out.push_str(rng.pick(&["\n", "  \n", "\t\n", "\u{3000}\n", "\u{00A0}\n"]));
    }
}

fn long_line(out: &mut String, rng: &mut Rng) {
    // 单行远超预算:CJK 无空格 / ASCII 无空格 / 带空格的长句
    let len = rng.range(200, 6000);
    match rng.below(3) {
        0 => out.extend((0..len).filter_map(|_| char::from_u32(0x4E00 + rng.below(0x400) as u32))),
        1 => out.extend((0..len).map(|_| rng.pick(&['a', 'b', 'c', 'd', 'e', '_']))),
        _ => {
            while out.len() < len {
                out.push_str(&word(rng));
                out.push(' ');
            }
        }
    }
    out.push('\n');
}

fn list_with_fence(out: &mut String, rng: &mut Rng, profile: &Profile) {
    out.push_str("- 步骤\n\n");
    fenced_code(out, rng, profile, "  ");
}

/// 生成一份约 `target_len` 字节的 Markdown。
fn gen_doc(rng: &mut Rng, target_len: usize, profile: &Profile) -> String {
    let mut out = String::new();
    if rng.chance(4) {
        out.push_str("---\ntitle: x\ntags: [a, b]\n---\n\n"); // front matter
    }
    while out.len() < target_len {
        match rng.weighted(&profile.weights) {
            0 => heading(&mut out, rng),
            1 => paragraph(&mut out, rng, profile),
            2 => fenced_code(&mut out, rng, profile, ""),
            3 => indented_code(&mut out, rng),
            4 => list(&mut out, rng, profile),
            5 => table(&mut out, rng),
            6 => quote(&mut out, rng, profile),
            7 => html_block(&mut out, rng, profile),
            8 => out.push_str(rng.pick(&["---\n", "***\n", "___\n"])),
            9 => blank_lines(&mut out, rng),
            10 => long_line(&mut out, rng),
            _ => list_with_fence(&mut out, rng, profile),
        }
        // 块之间大多空一行,偶尔紧贴(标题紧跟段落、围栏紧跟标题等)
        if rng.chance(85) {
            out.push('\n');
        }
    }
    // 偶尔从中间截断(落在行中、围栏中、列表中),制造「未结束」的结构
    if rng.chance(8) && out.len() > 8 {
        let mut cut = out.len() - rng.below(out.len().min(400));
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
    }
    // 换行风格:LF 为主,CRLF / 单独 CR / 混用各占一点
    out = match rng.weighted(&[85, 7, 3, 5]) {
        1 => out.replace('\n', "\r\n"),
        2 => out.replace('\n', "\r"),
        3 => {
            let mut mixed = String::with_capacity(out.len() + out.len() / 8);
            for ch in out.chars() {
                if ch == '\n' && rng.chance(30) {
                    mixed.push('\r');
                }
                mixed.push(ch);
            }
            mixed
        }
        _ => out,
    };
    // 末尾换行:约 20% 的文档没有
    if rng.chance(20) {
        while out.ends_with('\n') || out.ends_with('\r') {
            out.pop();
        }
    }
    // BOM
    if rng.chance(3) {
        out.insert(0, '\u{FEFF}');
    }
    out
}

// ---------------------------------------------------------------------------
// 参数预设与对拍
// ---------------------------------------------------------------------------

/// (max_tokens, window_lines, window_overlap):默认值、小预算(逼出大量切分)、极小窗口、
/// 重叠 ≥ 窗口行数等边界。`max_tokens` 取 32 时有效预算会被钳到 32。
const OPTION_PRESETS: &[(usize, usize, usize)] = &[
    (512, 60, 10),
    (512, 60, 10),
    (512, 60, 10),
    (256, 60, 10),
    (128, 20, 5),
    (64, 10, 2),
    (32, 5, 1),
    (48, 3, 0),
    (100, 1, 0),
    (512, 8, 7),
    (200, 4, 3),
];

/// (项目名, 相对路径):含超长名字(header 被截断)与中文名字,header 的 token 数会影响预算。
fn identities() -> Vec<(String, String)> {
    vec![
        ("demo".to_owned(), "docs/guide.md".to_owned()),
        ("kb".to_owned(), "README.md".to_owned()),
        ("项目".to_owned(), "文档/说明.md".to_owned()),
        ("p".repeat(200), "d/".repeat(60) + "very-long-name.md"),
    ]
}

fn options_of(preset: (usize, usize, usize)) -> ChunkOptions {
    ChunkOptions {
        max_tokens: preset.0,
        window_lines: preset.1,
        window_overlap: preset.2,
        ..ChunkOptions::default()
    }
}

fn make_doc(text: &str, project: &str, source: &str) -> SourceDoc {
    SourceDoc {
        source: source.to_owned(),
        lang: "markdown".to_owned(),
        text: text.to_owned(),
        file_hash: "h".to_owned(),
        size: text.len() as u64,
        mtime: 0,
        project_name: project.to_owned(),
    }
}

/// 截断显示,避免失败信息里塞进几百 KB 文本。
fn clip(text: &str) -> String {
    let mut shown: String = text.chars().take(160).collect();
    if shown.len() < text.len() {
        shown.push('…');
    }
    format!("{shown:?}")
}

fn describe(chunk: &Chunk) -> String {
    format!(
        "key={:?} lines={}..{} title={:?} symbol={:?} anchor={:?} header={:?} text({}B)={}",
        chunk.key,
        chunk.start_line,
        chunk.end_line,
        chunk.title,
        chunk.symbol,
        chunk.anchor,
        chunk.header,
        chunk.text.len(),
        clip(&chunk.text)
    )
}

/// 同一份文档交给旧实现和 `MarkdownChunker`,任何字段、顺序、数量上的差异都 panic;
/// 返回新实现的输出,供调用方统计覆盖面。
fn check(label: &str, text: &str, options: ChunkOptions, who: &(String, String)) -> Vec<Chunk> {
    let doc = make_doc(text, &who.0, &who.1);
    let expected = legacy::chunk_markdown(&doc, &options);
    let actual = MarkdownChunker::new(options).chunk(&doc);
    if expected != actual {
        let first = expected
            .iter()
            .zip(actual.iter())
            .position(|(left, right)| left != right);
        let detail = match first {
            Some(index) => format!(
                "第 {index} 块不同\n  旧: {}\n  新: {}",
                describe(&expected[index]),
                describe(&actual[index])
            ),
            None => format!(
                "前 {} 块相同,但数量不同(旧 {},新 {})",
                expected.len().min(actual.len()),
                expected.len(),
                actual.len()
            ),
        };
        panic!(
            "新旧分块输出不一致:{label}\n  参数 {options:?},项目 {:?},路径 {:?},文档 {} 字节\n  {detail}",
            who.0,
            who.1,
            text.len()
        );
    }
    actual
}

/// 随机用例的覆盖统计:用来证明生成器真的走到了关键分支,而不是一堆平凡文档。
#[derive(Default)]
struct Coverage {
    docs: usize,
    chunks: usize,
    /// 出现了自动后缀 key(`… #N`,N ≥ 2)的文档。
    suffixed_key_docs: usize,
    /// 有小节被按预算拆成多块(同一标题路径连续多块)的文档。
    split_docs: usize,
    /// 拆分出的块里带围栏的文档(拆分经过 in_code 判断)。
    split_with_fence_docs: usize,
    /// 出现了「仍然超预算,退到窗口切分」的块(行数达到窗口行数或单行被切开)。
    window_fallback_docs: usize,
    /// 出现了无标题(`#N` key)块的文档。
    untitled_docs: usize,
}

impl Coverage {
    fn record(&mut self, options: &ChunkOptions, chunks: &[Chunk]) {
        self.docs += 1;
        self.chunks += chunks.len();
        let mut suffixed = false;
        let mut split = false;
        let mut split_fence = false;
        let mut fallback = false;
        let mut untitled = false;
        for pair in chunks.windows(2) {
            if pair[0].title.is_some()
                && pair[0].title == pair[1].title
                && pair[1].key != pair[0].key
            {
                split = true;
                if pair[0].text.contains("```") || pair[0].text.contains("~~~") {
                    split_fence = true;
                }
            }
        }
        for chunk in chunks {
            let tail = chunk.key.rsplit_once(" #").map(|(_, n)| n);
            if tail.is_some_and(|n| n.parse::<usize>().is_ok_and(|n| n >= 2)) {
                suffixed = true;
            }
            if chunk.key.starts_with('#') {
                untitled = true;
            }
            // 窗口兜底的特征:一块跨的行数恰好是窗口行数,或同一行号出现多块
            if chunk.end_line - chunk.start_line + 1 == options.window_lines as i32
                && options.window_lines > 1
                && estimate_tokens(&chunk.text) > 0
            {
                fallback = true;
            }
        }
        for pair in chunks.windows(2) {
            if pair[0].start_line == pair[1].start_line && pair[0].end_line == pair[1].end_line {
                fallback = true; // 单行被按字符切开,行号保持不变
            }
        }
        self.suffixed_key_docs += suffixed as usize;
        self.split_docs += split as usize;
        self.split_with_fence_docs += split_fence as usize;
        self.window_fallback_docs += fallback as usize;
        self.untitled_docs += untitled as usize;
    }

    fn report(&self, name: &str) {
        eprintln!(
            "[{name}] 对拍文档 {} 份,合计 {} 块;含自动后缀 key {} 份,小节被拆分 {} 份(其中拆分块带围栏 {} 份),\
             退到窗口切分 {} 份,含无标题块 {} 份",
            self.docs,
            self.chunks,
            self.suffixed_key_docs,
            self.split_docs,
            self.split_with_fence_docs,
            self.window_fallback_docs,
            self.untitled_docs
        );
    }
}

/// 跑一批随机文档:第 `i` 份用种子 `seed_base + i`,长度在 `[min_len, max_len]` 之间,
/// 口味与参数预设都由种子决定。
fn run_random(
    name: &str,
    seed_base: u64,
    count: usize,
    min_len: usize,
    max_len: usize,
) -> Coverage {
    let who = identities();
    let mut coverage = Coverage::default();
    for index in 0..count {
        let seed = seed_base + index as u64;
        let mut rng = Rng::new(seed);
        // 长度偏向小文档(0 字节的空文档也要覆盖到)
        let len = if rng.chance(3) {
            0
        } else {
            let span = max_len - min_len;
            min_len + (rng.below(span + 1) * rng.below(span + 1)) / (span + 1)
        };
        let profile = &PROFILES[rng.below(PROFILES.len())];
        let preset = rng.pick(OPTION_PRESETS);
        let identity = &who[rng.below(who.len())];
        let text = gen_doc(&mut rng, len, profile);
        let options = options_of(preset);
        let chunks = check(
            &format!("{name} 种子 {seed}(第 {index} 份)"),
            &text,
            options,
            identity,
        );
        coverage.record(&options, &chunks);
    }
    coverage.report(name);
    coverage
}

// ---------------------------------------------------------------------------
// 手写边界用例
// ---------------------------------------------------------------------------

fn crlf(text: &str) -> String {
    text.replace('\n', "\r\n")
}

/// 把若干段落拼成大于任何预设预算的长小节。
fn many_paragraphs(count: usize, ascii: bool) -> String {
    (0..count)
        .map(|index| {
            if ascii {
                format!("paragraph number {index} with some filler words to take up room\n\n")
            } else {
                format!("这是第 {index} 段,包含足够多的文字让整个小节超过预算。\n\n")
            }
        })
        .collect()
}

fn hand_written_cases() -> Vec<(&'static str, String)> {
    let long_fence_body: String = (0..300)
        .map(|i| format!("let value_{i} = {i};\n"))
        .collect();
    let mut cases: Vec<(&'static str, String)> = vec![
        // 空与近乎空
        ("空文档", String::new()),
        ("只有换行", "\n\n\n".to_owned()),
        ("只有空白", "  \n\t\n \n".to_owned()),
        ("只有全角空格", "\u{3000}\u{3000}\n\u{3000}".to_owned()),
        ("只有 BOM", "\u{FEFF}".to_owned()),
        // 只有标题
        ("单个标题无换行", "# 只有标题".to_owned()),
        ("单个标题", "# 只有标题\n".to_owned()),
        ("只有一个井号", "#".to_owned()),
        ("井号加空格", "# \n".to_owned()),
        ("连续空标题", "#\n##\n###\n".to_owned()),
        (
            "各级标题只有标题",
            "# A\n## B\n### C\n#### D\n##### E\n###### F\n".to_owned(),
        ),
        ("标题级别跳跃", "### 深\n# 浅\n## 中\n### 深二\n".to_owned()),
        (
            "H4 不切分",
            "# A\n\n正文\n\n#### 深\n\n更深的正文\n".to_owned(),
        ),
        ("连续标题无正文", "# A\n# B\n# C\n".to_owned()),
        ("前言加标题", "前言\n\n# 标题\n正文".to_owned()),
        ("前言只有空行", "\n\n# 标题\n".to_owned()),
        (
            "setext 标题",
            "标题\n=====\n\n小节\n-----\n\n正文\n".to_owned(),
        ),
        (
            "标题含行内标记",
            "# `code` and *em* **b** [l](u)\n\n正文\n".to_owned(),
        ),
        ("标题带闭合井号", "# A ##\n\n正文\n".to_owned()),
        ("井号后没有空格", "#not heading\n\n正文\n".to_owned()),
        (
            "缩进的 ATX 标题",
            "   # 缩进三格\n\n正文\n    # 缩进四格是代码\n".to_owned(),
        ),
        (
            "标题里有大量空白",
            format!("# a{}b\n\n正文\n", " ".repeat(5000)),
        ),
        (
            "超长标题",
            format!("# {}\n\n正文\n\n## 子\n\n正文\n", "标题".repeat(3000)),
        ),
        // 重复标题与字面撞上自动后缀
        ("重复标题 20 次", "# 示例\n\n正文\n\n".repeat(20)),
        (
            "重复的嵌套标题",
            "# P\n## X\na\n# P\n## X\nb\n## X\nc\n# P\n## X\nd\n".to_owned(),
        ),
        (
            "字面后缀在前",
            "# 示例 #2\n\na\n\n# 示例\n\nb\n\n# 示例\n\nc\n\n# 示例\n\nd\n".to_owned(),
        ),
        (
            "字面后缀在中间",
            "# 示例\n\na\n\n# 示例\n\nb\n\n# 示例 #3\n\nc\n\n# 示例\n\nd\n\n# 示例\n\ne\n"
                .to_owned(),
        ),
        (
            "字面后缀在后(撞上之后才出现)",
            "# A\n# A\n# A #2\n# A #3\n# A\n# A\n# A #4\n# A\n".to_owned(),
        ),
        (
            "字面后缀重复出现",
            "# A #2\n# A #2\n# A\n# A\n# A #2\n# A\n".to_owned(),
        ),
        (
            "字面后缀本身带后缀",
            "# A\n# A #2\n# A #2\n# A #2 #2\n# A #2\n# A\n".to_owned(),
        ),
        (
            "无标题块的序号 key 与标题撞",
            "前言\n\n# #1\n\n正文\n\n# #1\n\n又一段\n".to_owned(),
        ),
        (
            "拆分块的 key 撞上字面标题",
            format!(
                "# T\n\n{}# T #2\n\n短\n\n# T #3\n\n短\n\n# T\n\n短\n",
                many_paragraphs(40, true)
            ),
        ),
        (
            "两个同名长小节各自拆分",
            format!(
                "# T\n\n{}# T\n\n{}",
                many_paragraphs(30, true),
                many_paragraphs(30, false)
            ),
        ),
        // 围栏
        (
            "反引号围栏",
            "# A\n\n```rust\nfn main() {}\n```\n\n结尾\n".to_owned(),
        ),
        (
            "波浪线围栏",
            "# A\n\n~~~\nfn main() {}\n~~~\n\n结尾\n".to_owned(),
        ),
        (
            "四个反引号里嵌三个",
            "# A\n\n````md\n```\n# 里面的假标题\n```\n````\n\n结尾\n".to_owned(),
        ),
        (
            "围栏未闭合",
            "# A\n\n正文\n\n```rust\nfn main() {}\n\n# 还在围栏里\n".to_owned(),
        ),
        (
            "围栏未闭合后面还有标题",
            "# A\n\n```\ncode\n\n# B\n\n正文\n\n## C\n\n更多\n".to_owned(),
        ),
        ("围栏只有开头", "```".to_owned()),
        ("围栏无换行结尾", "```\nx\n```".to_owned()),
        ("空围栏", "# A\n\n```\n```\n\n结尾\n".to_owned()),
        (
            "围栏里有看起来像标题的行",
            "# A\n\n```\n# 假标题\n## 假小节\n### 假三级\n```\n\n# B\n\n正文\n".to_owned(),
        ),
        (
            "围栏紧跟标题",
            "# A\n```\ncode\n```\n# B\n```\ncode\n```\n".to_owned(),
        ),
        (
            "相邻围栏",
            "# A\n\n```\na\n```\n```\nb\n```\n~~~\nc\n~~~\n".to_owned(),
        ),
        (
            "围栏 info 含反引号",
            "# A\n\n```a`b\nx\n```\n\n正文\n".to_owned(),
        ),
        (
            "缩进三格的围栏",
            "# A\n\n   ```\n   code\n   ```\n\n正文\n".to_owned(),
        ),
        (
            "缩进代码块",
            "# A\n\n正文\n\n    # 不是标题\n    code\n\n结尾\n".to_owned(),
        ),
        (
            "制表符缩进代码块",
            "# A\n\n正文\n\n\t# 不是标题\n\tcode\n\n结尾\n".to_owned(),
        ),
        (
            "列表里的围栏",
            "# A\n\n- 步骤\n\n  ```sh\n  ls\n\n  # 注释\n  ```\n\n- 下一步\n".to_owned(),
        ),
        (
            "引用里的围栏",
            "# A\n\n> 说明\n>\n> ```\n> code\n> ```\n\n正文\n".to_owned(),
        ),
        (
            "超长围栏(拆分兜底)",
            format!("# A\n\n```text\n{long_fence_body}```\n\n结尾\n"),
        ),
        (
            "超长围栏未闭合",
            format!("# A\n\n```text\n{long_fence_body}"),
        ),
        (
            "围栏夹在长段落中间",
            format!(
                "# A\n\n{}```\ncode\n\nmore\n```\n\n{}",
                many_paragraphs(12, true),
                many_paragraphs(12, true)
            ),
        ),
        (
            "围栏内有空行和段落边界",
            format!(
                "# A\n\n```\n{}```\n\n{}",
                "line\n\n".repeat(80),
                many_paragraphs(5, false)
            ),
        ),
        // 其他块
        (
            "嵌套列表",
            "# A\n\n- 一\n  - 二\n    - 三\n      - 四\n- 一b\n\n1. x\n   1. y\n2) z\n".to_owned(),
        ),
        (
            "表格",
            "# A\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 中 | 文 |\n\n正文\n".to_owned(),
        ),
        (
            "引用与分隔线",
            "# A\n\n> 引用\n> 第二行\n\n---\n\n***\n\n___\n\n正文\n".to_owned(),
        ),
        (
            "HTML 块",
            "# A\n\n<div>\n# 不是标题\n</div>\n\n<!-- 注释 -->\n\n正文\n".to_owned(),
        ),
        (
            "front matter",
            "---\ntitle: x\n---\n\n# A\n\n正文\n".to_owned(),
        ),
        // 换行与编码边界
        (
            "CRLF 文档",
            crlf("# A\n\n正文一\r\n\n```\ncode\n```\n\n## B\n\n正文二\n"),
        ),
        (
            "CRLF 长小节",
            crlf(&format!("# A\n\n{}## B\n\n短\n", many_paragraphs(40, true))),
        ),
        ("单独的 CR 换行", "# A\r正文\r\r# B\r正文\r".to_owned()),
        ("混用换行", "# A\r\n正文\n\r\n# B\n正文\r\n\n".to_owned()),
        ("BOM 加标题", "\u{FEFF}# 标题\n\n正文\n".to_owned()),
        ("BOM 无标题", "\u{FEFF}只有正文\n".to_owned()),
        ("末尾无换行", "# A\n\n正文最后一行".to_owned()),
        (
            "长小节末尾无换行",
            format!("# A\n\n{}最后一行没有换行", many_paragraphs(40, true)),
        ),
        (
            "长小节末尾是只有空格的半行",
            format!("# A\n\n{}   ", many_paragraphs(40, true)),
        ),
        (
            "长小节末尾是只有全角空格的半行",
            format!("# A\n\n{}\u{3000}\u{3000}", many_paragraphs(40, false)),
        ),
        (
            "段落间是只有空格的行",
            format!(
                "# A\n\n{}",
                many_paragraphs(40, true).replace("\n\n", "\n  \n")
            ),
        ),
        (
            "段落间是制表符与 NBSP 的行",
            format!(
                "# A\n\n{}",
                many_paragraphs(40, false).replace("\n\n", "\n\t\u{00A0}\n")
            ),
        ),
        (
            "全角空白与行分隔符",
            "# A\n\n\u{3000}\n正文\u{2028}继续\n\u{00A0}\n结尾\n".to_owned(),
        ),
        (
            "emoji 与组合记号",
            format!(
                "# 😀 标题\n\n{}",
                "👨\u{200D}👩\u{200D}👧 e\u{0301} 文字\n\n".repeat(60)
            ),
        ),
        // 超长行
        ("CJK 长句无换行", "增量索引".repeat(3000)),
        (
            "CJK 长句在标题下",
            format!("# A\n\n{}\n\n结尾\n", "双哈希增量索引。".repeat(2500)),
        ),
        ("ASCII 超长单行", "x".repeat(20_000)),
        (
            "ASCII 超长单行夹在段落间",
            format!("# A\n\n前\n\n{}\n\n后\n", "abcdefgh".repeat(1500)),
        ),
        (
            "超长单行在围栏里",
            format!("# A\n\n```\n{}\n```\n\n后\n", "y".repeat(8000)),
        ),
        (
            "全是短行无标题",
            (0..2000).map(|i| format!("l{i}\n")).collect::<String>(),
        ),
        (
            "中日韩混排长小节",
            format!(
                "# 小节\n\n{}",
                "日本語のテキスト 한국어 텍스트 中文 text\n\n".repeat(80)
            ),
        ),
    ];
    // 每两行一个标题 / 重复标题 / 大量小围栏:性能卡里的病态形状,在小尺寸上对拍
    cases.push((
        "每两行一个标题",
        (0..400).map(|i| format!("# 标题{i}\n正文{i}\n")).collect(),
    ));
    cases.push((
        "每两行一个重复标题",
        (0..400).map(|_| "# 示例\n正文\n".to_owned()).collect(),
    ));
    cases.push((
        "大量小围栏无标题",
        (0..300).map(|i| format!("```\nc{i}\n```\n\n")).collect(),
    ));
    cases
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

#[test]
fn hand_written_edge_cases_match_legacy() {
    let cases = hand_written_cases();
    let who = identities();
    let mut compared = 0usize;
    for (case_index, (name, text)) in cases.iter().enumerate() {
        for (preset_index, preset) in OPTION_PRESETS.iter().enumerate() {
            // 项目标识按用例号与预设号轮换:每个用例都见过全部 11 组参数,
            // 每组标识也都轮到所有用例;旧实现是二次复杂度,不把两者做笛卡尔积以免白白拖慢测试
            let identity = &who[(case_index + preset_index) % who.len()];
            check(name, text, options_of(*preset), identity);
            compared += 1;
        }
    }
    eprintln!(
        "[手写边界] {} 个用例 × {} 组参数(项目标识轮换 {} 组)= {} 次对拍",
        cases.len(),
        OPTION_PRESETS.len(),
        who.len(),
        compared
    );
    assert!(cases.len() >= 70, "手写用例不应被意外删减:{}", cases.len());
}

/// 在 token 预算的边界上穷举:行长 × 行数 × 预算 × 版式,每一档都对拍。
/// 预算比较是 `> budget`,段落断开是 `>= budget / 2`,这两个边界差 1 就会改变切分位置和行号。
#[test]
fn token_budget_boundary_sweep_matches_legacy() {
    let who = [("demo".to_owned(), "docs/guide.md".to_owned())];
    let mut compared = 0usize;
    for max_tokens in [32usize, 33, 35, 40, 48, 64, 100] {
        for window in [(60usize, 10usize), (5, 2)] {
            let options = ChunkOptions {
                max_tokens,
                window_lines: window.0,
                window_overlap: window.1,
                ..ChunkOptions::default()
            };
            for line_len in 1..=48usize {
                for line_count in [1usize, 2, 3, 4, 6, 9, 16] {
                    for style in 0..4 {
                        let body: Vec<String> = (0..line_count)
                            .map(|index| match style {
                                3 => "字".repeat(line_len),
                                _ => format!("{}{}", "a".repeat(line_len), index % 10),
                            })
                            .collect();
                        let text = match style {
                            // 紧凑:没有空行,只能靠预算切
                            0 => format!("# T\n\n{}\n", body.join("\n")),
                            // 空行分段:触发「段落边界且已过半预算」
                            1 => format!("# T\n\n{}\n", body.join("\n\n")),
                            // 整段包在围栏里:in_code 阻止冲刷,走窗口兜底
                            2 => format!("# T\n\n```\n{}\n```\n\n尾\n", body.join("\n")),
                            // 中文:每字一个 token
                            _ => format!("# T\n\n{}\n", body.join("\n\n")),
                        };
                        check(
                            &format!(
                                "边界扫描 max_tokens={max_tokens} 行长={line_len} 行数={line_count} 版式={style}"
                            ),
                            &text,
                            options,
                            &who[0],
                        );
                        compared += 1;
                    }
                }
            }
        }
    }
    eprintln!("[预算边界扫描] {compared} 次对拍");
}

#[test]
fn random_small_docs_match_legacy() {
    let coverage = run_random("随机小文档 0~6KB", 1_000, 3_000, 0, 6 * 1024);
    assert!(coverage.docs >= 3_000);
    // 生成器必须真的走到关键分支,否则对拍是空转
    assert!(coverage.suffixed_key_docs >= 200, "自动后缀 key 覆盖不足");
    assert!(coverage.split_docs >= 200, "小节拆分覆盖不足");
    assert!(coverage.split_with_fence_docs >= 30, "带围栏的拆分覆盖不足");
    assert!(coverage.window_fallback_docs >= 30, "窗口兜底覆盖不足");
    assert!(coverage.untitled_docs >= 200, "无标题块覆盖不足");
}

#[test]
fn random_medium_docs_match_legacy() {
    let coverage = run_random("随机中等文档 6~64KB", 100_000, 250, 6 * 1024, 64 * 1024);
    assert!(coverage.docs >= 250);
    assert!(coverage.suffixed_key_docs >= 40, "自动后缀 key 覆盖不足");
    assert!(coverage.split_docs >= 100, "小节拆分覆盖不足");
    assert!(coverage.split_with_fence_docs >= 20, "带围栏的拆分覆盖不足");
}

#[test]
fn random_large_docs_match_legacy() {
    // 100~300KB:旧实现在这个量级是秒级到十秒级,所以只跑少量份;
    // 口味轮流取,保证标题密集 / 代码 / 长文各至少一份。
    let who = identities();
    let mut coverage = Coverage::default();
    for index in 0..8usize {
        let seed = 900_000 + index as u64;
        let mut rng = Rng::new(seed);
        let len = 100 * 1024 + rng.below(200 * 1024);
        let profile = &PROFILES[index % PROFILES.len()];
        let options = options_of(rng.pick(OPTION_PRESETS));
        let text = gen_doc(&mut rng, len, profile);
        let chunks = check(
            &format!("随机大文档 种子 {seed}(口味 {})", index % PROFILES.len()),
            &text,
            options,
            &who[index % who.len()],
        );
        coverage.record(&options, &chunks);
    }
    coverage.report("随机大文档 100~300KB");
    assert!(
        coverage.chunks > 1_000,
        "大文档应切出很多块:{}",
        coverage.chunks
    );
}

/// 性能卡里的几种病态形状,缩小到旧实现还能在几秒内跑完的尺寸后逐块对拍。
#[test]
fn pathological_shapes_match_legacy() {
    let who = identities();
    let options = options_of((512, 60, 10));
    let small = options_of((64, 10, 2));
    let shapes: Vec<(&str, String)> = vec![
        (
            "每两行一个互不相同的标题 48KB",
            (0..2000).map(|i| format!("# 标题{i}\n正文{i}\n")).collect(),
        ),
        (
            "重复同名标题 24KB",
            (0..1500).map(|_| "# 示例\n正文\n".to_owned()).collect(),
        ),
        (
            "重复同名标题夹字面后缀 12KB",
            (0..600)
                .map(|i| {
                    if i % 7 == 0 {
                        format!("# 示例 #{}\n正文\n", 2 + i % 50)
                    } else {
                        "# 示例\n正文\n".to_owned()
                    }
                })
                .collect(),
        ),
        (
            "单个大围栏 40KB",
            format!(
                "# 代码\n\n```text\n{}```\n",
                (0..2000)
                    .map(|i| format!("let v{i} = {i};\n"))
                    .collect::<String>()
            ),
        ),
        (
            "大量小围栏无标题 40KB",
            (0..3000).map(|i| format!("```\nc{i}\n```\n\n")).collect(),
        ),
        (
            "短行无标题 64KB",
            (0..8000).map(|i| format!("l{i}\n")).collect(),
        ),
        (
            "同一标题下的长小节 + 围栏交替 60KB",
            format!(
                "# T\n\n{}",
                (0..300)
                    .map(|i| format!("段落 {i} 的说明文字。\n\n```\ncode {i}\n\n# x\n```\n\n"))
                    .collect::<String>()
            ),
        ),
    ];
    for (name, text) in &shapes {
        for opts in [options, small] {
            check(name, text, opts, &who[0]);
        }
    }
    eprintln!("[病态形状] {} 种形状 × 2 组参数对拍通过", shapes.len());
}

/// 生成器与种子要是确定性的:同一个种子两次生成的文档必须逐字节相同,
/// 否则「失败时带种子可复现」不成立。
#[test]
fn generator_is_deterministic() {
    for seed in [0u64, 1, 2, 42, 1_000, 900_000] {
        let first = gen_doc(&mut Rng::new(seed), 20_000, &PROFILES[0]);
        let second = gen_doc(&mut Rng::new(seed), 20_000, &PROFILES[0]);
        assert_eq!(first, second, "种子 {seed} 两次生成结果不同");
    }
    let distinct: HashSet<String> = (0..50u64)
        .map(|seed| gen_doc(&mut Rng::new(seed), 2_000, &PROFILES[0]))
        .collect();
    assert!(
        distinct.len() > 45,
        "不同种子应给出不同文档:{}",
        distinct.len()
    );
}

// ---------------------------------------------------------------------------
// 窗口切分与 header 截断(选做项:split_long_line / truncate_to_tokens 的线性化)
// ---------------------------------------------------------------------------

/// 随机文本:空行、纯空白行、普通句子、超长 CJK / ASCII / 空白串混在一起。
fn random_plain_text(rng: &mut Rng) -> String {
    let mut out = String::new();
    for _ in 0..rng.range(0, 40) {
        match rng.weighted(&[10, 6, 60, 8, 8, 4, 4]) {
            0 => {}
            1 => out.push_str(rng.pick(&["  ", "\t", "\u{3000}", "\u{00A0} "])),
            2 => out.push_str(&sentence(rng, (1, 12))),
            3 => out.extend(
                (0..rng.range(50, 3000))
                    .filter_map(|_| char::from_u32(0x4E00 + rng.below(0x300) as u32)),
            ),
            4 => out.extend((0..rng.range(50, 3000)).map(|_| rng.pick(&['a', 'b', '_', '1']))),
            // 几乎全是空白的超长行:没有 token,计数永远不超预算
            5 => out.extend((0..rng.range(50, 3000)).map(|_| rng.pick(&[' ', '\t', '\u{3000}']))),
            _ => out.push_str(&word(rng).repeat(rng.range(1, 200))),
        }
        out.push_str(rng.pick(&["\n", "\n", "\n", "\r\n"]));
    }
    if rng.chance(30) {
        out.pop();
    }
    out
}

/// `truncate_to_tokens` 逐字节对拍:覆盖预算为 0、恰好卡在边界、纯空白、emoji 与组合记号。
#[test]
fn truncate_to_tokens_matches_legacy() {
    let mut cases = 0usize;
    for seed in 0..1500u64 {
        let mut rng = Rng::new(7_000_000 + seed);
        let text = random_plain_text(&mut rng);
        for max_tokens in [0usize, 1, 2, 3, 7, 16, 63, 64, 65, 200] {
            assert_eq!(
                kb_index::chunk::truncate_to_tokens(&text, max_tokens),
                legacy::truncate_to_tokens(&text, max_tokens),
                "truncate_to_tokens 不一致:种子 {seed},max_tokens {max_tokens},文本 {}",
                clip(&text)
            );
            cases += 1;
        }
    }
    // 逐字符扫描:每一个前缀、每一个预算都对一遍
    for text in [
        "",
        "a",
        "abcd",
        "abcde",
        "中文 abc",
        " \t\n",
        "a b c d e f",
        "😀😀😀",
        "e\u{0301}e\u{0301}",
    ] {
        for max_tokens in 0..12usize {
            assert_eq!(
                kb_index::chunk::truncate_to_tokens(text, max_tokens),
                legacy::truncate_to_tokens(text, max_tokens),
                "truncate_to_tokens 不一致:{text:?} / {max_tokens}"
            );
            cases += 1;
        }
    }
    eprintln!("[truncate_to_tokens] {cases} 次对拍");
}

/// `split_text`(含超长单行走的 `split_long_line`)逐片对拍:文本、起止行、片数与顺序都要相同。
/// `PlainChunker`、tree-sitter 的超长叶子和 Markdown 的窗口兜底都走它。
#[test]
fn split_text_matches_legacy() {
    let mut cases = 0usize;
    let mut with_long_line = 0usize;
    for seed in 0..500u64 {
        let mut rng = Rng::new(8_000_000 + seed);
        let text = random_plain_text(&mut rng);
        let has_long_line = text.lines().any(|line| line.chars().count() > 400);
        for max_tokens in [0usize, 1, 2, 5, 10, 32, 64, 200] {
            let preset = rng.pick(OPTION_PRESETS);
            let options = options_of(preset);
            let first_line = rng.range(1, 50) as i32;
            let expected: Vec<(String, i32, i32)> =
                legacy::split_text(&text, first_line, &options, max_tokens)
                    .into_iter()
                    .map(|piece| (piece.text, piece.start_line, piece.end_line))
                    .collect();
            let actual: Vec<(String, i32, i32)> =
                kb_index::chunk::window::split_text(&text, first_line, &options, max_tokens)
                    .into_iter()
                    .map(|piece| (piece.text, piece.start_line, piece.end_line))
                    .collect();
            assert_eq!(
                expected,
                actual,
                "split_text 不一致:种子 {seed},max_tokens {max_tokens},参数 {options:?},文本 {}",
                clip(&text)
            );
            cases += 1;
            with_long_line += usize::from(has_long_line);
        }
    }
    eprintln!("[split_text] {cases} 次对拍,其中含超长行(>400 字符)的 {with_long_line} 次");
    assert!(with_long_line >= 200, "超长行覆盖不足:{with_long_line}");
}

// ---------------------------------------------------------------------------
// 真实文档
// ---------------------------------------------------------------------------

/// 递归收集目录下的 `.md` 文件(跳过隐藏目录与依赖目录)。
fn collect_markdown(dir: &std::path::Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if depth > 0 && !name.starts_with('.') && name != "node_modules" && name != "target" {
                collect_markdown(&path, depth - 1, out);
            }
        } else if name.ends_with(".md") {
            out.push(path);
        }
    }
}

/// 仓库自己的设计文档(根目录与 `docs/` 下全部 `.md`,含 600KB 级的架构设计说明)
/// 是最真实的输入:中英混排、表格、代码块、重复的小节标题都有。默认参数与小预算各对拍一遍。
#[test]
fn repository_markdown_files_match_legacy() {
    let repo = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    collect_markdown(&repo.join("docs"), 4, &mut files);
    collect_markdown(&repo, 0, &mut files);
    let who = identities();
    let mut bytes = 0usize;
    let mut chunks = 0usize;
    let mut compared = 0usize;
    for path in &files {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let relative = path
            .strip_prefix(&repo)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let identity = (who[0].0.clone(), relative);
        for preset in [(512usize, 60usize, 10usize), (64, 10, 2)] {
            let got = check(&identity.1, &text, options_of(preset), &identity);
            chunks += got.len();
            compared += 1;
        }
        bytes += text.len();
    }
    eprintln!(
        "[真实文档] {} 个文件、{} KB,2 组参数共 {compared} 次对拍,合计 {chunks} 块",
        files.len(),
        bytes / 1024
    );
    // 公开仓只保留设计文档与使用指南(内部计划/评审已移出),语料下限按公开文档集校准。
    assert!(
        files.len() >= 20 && bytes >= 300 * 1024,
        "没有找到足够的仓库文档:{} 个、{bytes} 字节(路径 {})",
        files.len(),
        repo.display()
    );
}
