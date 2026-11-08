//! 正文引用解析:把 Markdown 链接 / 图片和 Obsidian 双链解析成链接图谱。
//!
//! 这里只做**纯解析**:输入正文 + 当前 collection / 文件路径,输出目标类型与规整后的路径。
//! 文件是否存在、有没有权限由能力层判断;解析器不读盘,方便两边(索引器 / `doc_links`)复用,
//! 也方便用同一组用例和前端 `links.ts` 对齐。

use std::ops::Range;

use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};

/// 一条正文引用(解析结果)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedLink {
    /// 正文里写的原始地址(不改写)。
    pub href: String,
    /// 第一次出现的行号(1 起)。
    pub line: u32,
    /// 链接文字 / 图片 alt。
    pub label: String,
    /// `file` / `note` / `external` / `anchor` / `invalid`。
    pub target_kind: String,
    /// `kb://` 的集合;相对文件用当前集合。
    pub target_collection: Option<String>,
    /// 文件路径 / 笔记 id。
    pub target_id: Option<String>,
    /// 不能解析时的原因。
    pub reason: Option<String>,
}

impl ParsedLink {
    fn invalid(href: &str, line: u32, label: String, reason: &str) -> Self {
        Self {
            href: href.to_owned(),
            line,
            label,
            target_kind: "invalid".to_owned(),
            target_collection: None,
            target_id: None,
            reason: Some(reason.to_owned()),
        }
    }
}

/// 解析正文里的全部引用(同一 href 只留第一次出现的那行)。
///
/// `source_path` 是当前文件在 collection 内的相对路径;笔记传 `None`(按 collection 根解析)。
pub fn parse_doc_links(text: &str, collection: &str, source_path: Option<&str>) -> Vec<ParsedLink> {
    let base = source_path.map(base_dir).unwrap_or_default();
    let mut links: Vec<ParsedLink> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut pending: Option<(String, usize, String)> = None;
    let mut code_blocks: Vec<Range<usize>> = Vec::new();
    let mut block_start = 0usize;
    let mut code_spans: Vec<Range<usize>> = Vec::new();

    let options =
        Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
    for (event, range) in Parser::new_ext(text, options).into_offset_iter() {
        match event {
            Event::Start(Tag::Link { dest_url, .. } | Tag::Image { dest_url, .. }) => {
                pending = Some((dest_url.into_string(), range.start, String::new()));
            }
            Event::Text(value) => {
                if let Some((_, _, label)) = pending.as_mut() {
                    label.push_str(&value);
                }
            }
            Event::End(TagEnd::Link | TagEnd::Image) => {
                if let Some((href, offset, label)) = pending.take() {
                    push_link(
                        &mut links, &mut seen, text, collection, &base, &href, offset, label,
                    );
                }
            }
            Event::Start(Tag::CodeBlock(_)) => block_start = range.start,
            Event::End(TagEnd::CodeBlock) => code_blocks.push(block_start..range.end),
            Event::Code(value) => {
                if let Some((_, _, label)) = pending.as_mut() {
                    label.push_str(&value);
                }
                code_spans.push(range);
            }
            _ => {}
        }
    }

    // 双链不是 CommonMark,单独扫;代码块 / 行内代码里的 `[[...]]` 不算引用。
    let mut skip: Vec<Range<usize>> = code_blocks.into_iter().chain(code_spans).collect();
    skip.sort_by_key(|range| range.start);
    scan_wikilinks(text, collection, &base, &skip, &mut links, &mut seen);
    links.sort_by(|a, b| a.line.cmp(&b.line).then_with(|| a.href.cmp(&b.href)));
    links
}

/// 扫描正文里的双链;`skip` 是代码块 / 行内代码区间。
fn scan_wikilinks(
    text: &str,
    collection: &str,
    base: &[String],
    skip: &[Range<usize>],
    links: &mut Vec<ParsedLink>,
    seen: &mut std::collections::HashSet<String>,
) {
    let mut at = 0usize;
    while let Some(open) = text[at..].find("[[") {
        let open = at + open;
        let Some(close_rel) = text[open + 2..].find("]]") else {
            break;
        };
        let close = open + 2 + close_rel;
        let raw = &text[open + 2..close];
        // 双链不能跨行;`[[[` 也不是双链
        if !raw.contains('\n')
            && !raw.starts_with('[')
            && !raw.contains('[')
            && !skip
                .iter()
                .any(|range| open >= range.start && open < range.end)
        {
            let (target, label) = raw.split_once('|').unwrap_or((raw, ""));
            let target = target.trim();
            let label = label.trim();
            if !target.is_empty() {
                let href = format!("[[{raw}]]");
                if seen.insert(href.clone()) {
                    let line = line_of(text, open);
                    let display = if label.is_empty() {
                        target.to_owned()
                    } else {
                        label.to_owned()
                    };
                    links.push(resolve_wiki(&href, target, line, display, collection, base));
                }
            }
        }
        at = close + 2;
    }
}

/// 双链目标:没有 `/` 也没有扩展名按笔记 id;其余按文件路径;`#` 开头是锚点。
fn resolve_wiki(
    href: &str,
    target: &str,
    line: u32,
    label: String,
    collection: &str,
    base: &[String],
) -> ParsedLink {
    if target.starts_with('#') {
        return ParsedLink {
            href: href.to_owned(),
            line,
            label,
            target_kind: "anchor".to_owned(),
            target_collection: None,
            target_id: None,
            reason: None,
        };
    }
    if target.starts_with("kb://") {
        return resolve_link(href, line, label, collection, base);
    }
    if !target.contains('/') && !target.contains('\\') && !has_extension(target) {
        let reason = (!valid_note_id(target)).then(|| "笔记 id 不合法".to_owned());
        return ParsedLink {
            href: href.to_owned(),
            line,
            label,
            target_kind: "note".to_owned(),
            target_collection: None,
            target_id: Some(target.to_owned()),
            reason,
        };
    }
    let (path_raw, _fragment) = split_once(target, '#');
    let Some(decoded) = decode_percent(path_raw) else {
        return ParsedLink::invalid(href, line, label, "链接编码不合法");
    };
    let Some(path) = normalize_path(&decoded, base) else {
        return ParsedLink::invalid(href, line, label, "链接指向了 collection 外面");
    };
    ParsedLink {
        href: href.to_owned(),
        line,
        label,
        target_kind: "file".to_owned(),
        target_collection: Some(collection.to_owned()),
        target_id: Some(path),
        reason: None,
    }
}

// 参数都是解析现场已有的东西,打成一个结构体反而要多写一层搬来搬去。
#[allow(clippy::too_many_arguments)]
fn push_link(
    links: &mut Vec<ParsedLink>,
    seen: &mut std::collections::HashSet<String>,
    text: &str,
    collection: &str,
    base: &[String],
    href: &str,
    offset: usize,
    label: String,
) {
    let href = href.trim().to_owned();
    if href.is_empty() || !seen.insert(href.clone()) {
        return;
    }
    let line = line_of(text, offset);
    links.push(resolve_link(&href, line, label, collection, base));
}

fn resolve_link(
    href: &str,
    line: u32,
    label: String,
    collection: &str,
    base: &[String],
) -> ParsedLink {
    if href.starts_with('#') {
        return ParsedLink {
            href: href.to_owned(),
            line,
            label,
            target_kind: "anchor".to_owned(),
            target_collection: None,
            target_id: None,
            reason: None,
        };
    }
    if let Some(kb) = parse_kb_href(href) {
        return match kb {
            KbTarget::Note(id) => ParsedLink {
                href: href.to_owned(),
                line,
                label,
                target_kind: "note".to_owned(),
                target_collection: None,
                target_id: Some(id),
                reason: None,
            },
            KbTarget::File { collection, path } => ParsedLink {
                href: href.to_owned(),
                line,
                label,
                target_kind: "file".to_owned(),
                target_collection: Some(collection),
                target_id: Some(path),
                reason: None,
            },
            KbTarget::Invalid(reason) => ParsedLink::invalid(href, line, label, reason),
        };
    }
    // 原电脑路径(盘符 / UNC)不当作知识库文件
    if is_windows_path(href) || href.to_ascii_lowercase().starts_with("file:") {
        return ParsedLink::invalid(href, line, label, "这是原电脑上的路径");
    }
    // 外部协议 / 站点根路径 / 协议相对地址:原样当外链
    if has_scheme(href) || href.starts_with("//") || href.starts_with('/') || href.starts_with('?')
    {
        return ParsedLink {
            href: href.to_owned(),
            line,
            label,
            target_kind: "external".to_owned(),
            target_collection: None,
            target_id: None,
            reason: None,
        };
    }

    let (before_hash, _fragment) = split_once(href, '#');
    let (path_raw, _query) = split_once(before_hash, '?');
    if path_raw.is_empty() {
        return ParsedLink {
            href: href.to_owned(),
            line,
            label,
            target_kind: "anchor".to_owned(),
            target_collection: None,
            target_id: None,
            reason: None,
        };
    }
    let Some(decoded) = decode_percent(path_raw) else {
        return ParsedLink::invalid(href, line, label, "链接编码不合法");
    };
    let Some(path) = normalize_path(&decoded, base) else {
        return ParsedLink::invalid(href, line, label, "链接指向了 collection 外面");
    };
    ParsedLink {
        href: href.to_owned(),
        line,
        label,
        target_kind: "file".to_owned(),
        target_collection: Some(collection.to_owned()),
        target_id: Some(path),
        reason: None,
    }
}

enum KbTarget {
    Note(String),
    File { collection: String, path: String },
    Invalid(&'static str),
}

fn parse_kb_href(raw: &str) -> Option<KbTarget> {
    let rest = raw
        .strip_prefix("kb://")
        .or_else(|| raw.strip_prefix("KB://"))?;
    let rest = rest.split('#').next().unwrap_or_default();
    let rest = rest.split('?').next().unwrap_or_default();
    let (host_raw, path_raw) = rest.split_once('/').unwrap_or((rest, ""));
    let Some(host) = decode_percent(host_raw) else {
        return Some(KbTarget::Invalid("链接编码不合法"));
    };
    if host == "note" {
        if path_raw.is_empty() {
            return Some(KbTarget::Invalid("笔记链接缺少 id"));
        }
        let Some(id) = decode_percent(path_raw) else {
            return Some(KbTarget::Invalid("链接编码不合法"));
        };
        if !valid_note_id(&id) {
            return Some(KbTarget::Invalid("笔记 id 不合法"));
        }
        return Some(KbTarget::Note(id));
    }
    if kb_core::ids::validate_collection_name(&host).is_err() {
        return Some(KbTarget::Invalid("集合名不合法"));
    }
    if path_raw.is_empty() {
        return Some(KbTarget::Invalid("链接缺少文件路径"));
    }
    let mut segments = Vec::new();
    for part in path_raw.split('/') {
        if part.is_empty() {
            return Some(KbTarget::Invalid("路径不合法"));
        }
        let Some(segment) = decode_percent(part) else {
            return Some(KbTarget::Invalid("链接编码不合法"));
        };
        // 解码后仍挡 `..` / `.` / 分隔符,防止 `%2F..%2F` 拆段绕过
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.contains('/')
            || segment.contains('\\')
            || segment.chars().any(char::is_control)
        {
            return Some(KbTarget::Invalid("路径不合法"));
        }
        segments.push(segment);
    }
    Some(KbTarget::File {
        collection: host,
        path: segments.join("/"),
    })
}

fn valid_note_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn base_dir(path: &str) -> Vec<String> {
    let mut parts: Vec<String> = path
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect();
    parts.pop();
    parts
}

fn normalize_path(path: &str, base: &[String]) -> Option<String> {
    if path.starts_with('/') || path.starts_with('\\') {
        return None;
    }
    let mut out: Vec<String> = base.to_vec();
    for part in path.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            out.pop()?;
        } else {
            if part.chars().any(char::is_control) {
                return None;
            }
            out.push(part.to_owned());
        }
    }
    (!out.is_empty()).then(|| out.join("/"))
}

fn decode_percent(value: &str) -> Option<String> {
    // 手写 `%` 合法性检查:`percent_decode_str` 遇到坏编码会原样保留,和前端 decodeURIComponent 不一致
    let bytes = value.as_bytes();
    let mut at = 0usize;
    while at < bytes.len() {
        if bytes[at] == b'%' {
            if at + 2 >= bytes.len()
                || !bytes[at + 1].is_ascii_hexdigit()
                || !bytes[at + 2].is_ascii_hexdigit()
            {
                return None;
            }
            at += 3;
        } else {
            at += 1;
        }
    }
    percent_decode_str(value)
        .decode_utf8()
        .ok()
        .map(|s| s.into_owned())
}

fn split_once(value: &str, needle: char) -> (&str, &str) {
    match value.find(needle) {
        Some(at) => (&value[..at], &value[at + needle.len_utf8()..]),
        None => (value, ""),
    }
}

fn line_of(text: &str, offset: usize) -> u32 {
    u32::try_from(text[..offset.min(text.len())].matches('\n').count() + 1).unwrap_or(u32::MAX)
}

fn has_extension(value: &str) -> bool {
    let name = value.rsplit('/').next().unwrap_or(value);
    name.rsplit_once('.')
        .is_some_and(|(_, ext)| !ext.is_empty())
}

fn is_windows_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || value.starts_with("\\\\")
}

fn has_scheme(value: &str) -> bool {
    let Some(colon) = value.find(':') else {
        return false;
    };
    let head = &value[..colon];
    !head.is_empty()
        && head
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic())
        && head
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

#[cfg(test)]
mod tests {
    use super::parse_doc_links;

    #[test]
    fn relative_links_resolve_against_the_file_directory() {
        let links = parse_doc_links(
            "正文\n\n[表](../资料/成本.xlsx?x=1#top)\n![图](./图%20一.png)\n",
            "proj_demo",
            Some("销售/笔记.md"),
        );
        assert_eq!(links.len(), 2);
        assert_eq!(links[0].href, "../资料/成本.xlsx?x=1#top");
        assert_eq!(links[0].target_kind, "file");
        assert_eq!(links[0].target_collection.as_deref(), Some("proj_demo"));
        assert_eq!(links[0].target_id.as_deref(), Some("资料/成本.xlsx"));
        assert_eq!(links[0].line, 3);
        assert_eq!(links[1].target_id.as_deref(), Some("销售/图 一.png"));
    }

    #[test]
    fn cross_collection_and_note_links_use_kb_scheme() {
        let links = parse_doc_links(
            "[模板](kb://_global/模板/报价单.dotx?download=1)\n[笔记](kb://note/01a19f63-f0ea-72fe-aa19-9998f6e2e5ad)\n[[docs/规范.md|规范]]\n[[01a19f63-f0ea-72fe-aa19-9998f6e2e5ad|另一篇]]\n",
            "proj_demo",
            Some("笔记.md"),
        );
        assert_eq!(links.len(), 4);
        assert_eq!(links[0].target_collection.as_deref(), Some("_global"));
        assert_eq!(links[0].target_id.as_deref(), Some("模板/报价单.dotx"));
        assert_eq!(links[1].target_kind, "note");
        assert_eq!(
            links[1].target_id.as_deref(),
            Some("01a19f63-f0ea-72fe-aa19-9998f6e2e5ad")
        );
        assert_eq!(links[2].target_kind, "file");
        assert_eq!(links[2].target_id.as_deref(), Some("docs/规范.md"));
        assert_eq!(links[3].target_kind, "note");
    }

    #[test]
    fn unsafe_and_external_links_are_classified_not_guessed() {
        let links = parse_doc_links(
            "[外链](https://example.com/a)\n[原电脑](D:\\资料\\a.xlsx)\n[越界](../../secret.md)\n[坏编码](./a%2.md)\n[锚点](#标题)\n",
            "proj_demo",
            Some("docs/a.md"),
        );
        assert_eq!(links.len(), 5);
        assert_eq!(links[0].target_kind, "external");
        assert_eq!(links[1].target_kind, "invalid");
        assert_eq!(links[2].target_kind, "invalid");
        assert_eq!(links[3].target_kind, "invalid");
        assert_eq!(links[4].target_kind, "anchor");
    }

    #[test]
    fn code_blocks_and_inline_code_do_not_create_links() {
        let links = parse_doc_links(
            "`[内联](a.md)`\n\n```md\n[代码](b.md)\n[[c]]\n```\n\n[真链接](c.md)\n",
            "proj_demo",
            Some("notes.md"),
        );
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].href, "c.md");
        assert_eq!(links[0].line, 8);
    }

    #[test]
    fn duplicate_hrefs_keep_only_the_first_line() {
        let links = parse_doc_links("[a](x.md)\n\n[b](x.md)\n", "proj_demo", Some("n.md"));
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].line, 1);
    }

    #[test]
    fn note_links_are_not_mistaken_for_files() {
        let links = parse_doc_links("[[目录]]\n[[备注.txt]]\n", "proj_demo", None);
        assert_eq!(links[0].target_kind, "note");
        assert_eq!(links[1].target_kind, "file");
        assert_eq!(links[1].target_id.as_deref(), Some("备注.txt"));
    }
}
