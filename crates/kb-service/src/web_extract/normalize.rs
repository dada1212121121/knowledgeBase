//! 规范化结果的结构、宽松解析与多段合并(设计规范)。
//!
//! 解析是**宽松**的:模型输出缺字段取默认、类型不对的字段丢掉、多余字段丢掉,只要整体是一个
//! JSON 对象就算成功——一个字段写错不该让整页白调一次模型。但输出里的每个字符串、每个数组都有上限,
//! 链接必须是页面里真实出现过的地址(挡住模型编造出来的链接)。

use std::collections::HashSet;

use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// 页面类型(模型给了枚举之外的值一律归为 `other`)。
pub const PAGE_TYPES: &[&str] = &[
    "article", "doc", "api_doc", "product", "list", "news", "forum", "profile", "other",
];

/// 实体类型。
pub const ENTITY_TYPES: &[&str] = &["person", "org", "product", "tech", "place", "other"];

// ---- 长度上限 ----
// 取值原则:比提示词里要求的宽一倍左右(模型常常写超一点,不该因此丢内容),
// 同时让单页结果渲染出来的 Markdown 不超过几十 KB(一页知识不该比原文还长很多)。

/// 标题。
pub const MAX_TITLE_CHARS: usize = 300;
/// 摘要(提示词要求 ≤300 字)。
pub const MAX_SUMMARY_CHARS: usize = 600;
/// 短字段:作者、日期、语言、名称、值、单位、链接文字、实体名。
pub const MAX_SHORT_CHARS: usize = 300;
/// 一条要点。
pub const MAX_POINT_CHARS: usize = 1_000;
/// 一个小节的正文。
pub const MAX_SECTION_CHARS: usize = 8_000;
/// 一个表格单元格。
pub const MAX_CELL_CHARS: usize = 500;
/// 一段代码。
pub const MAX_CODE_CHARS: usize = 20_000;
/// 一个标签。
pub const MAX_TAG_CHARS: usize = 40;
/// 一个 URL。
pub const MAX_URL_CHARS: usize = 2_000;
/// 要点 / 事实 / 实体 / 链接这类列表的条数。
pub const MAX_LIST_ITEMS: usize = 100;
/// 小节数。
pub const MAX_SECTIONS: usize = 100;
/// 表格数。
pub const MAX_TABLES: usize = 20;
/// 每个表格的行数。
pub const MAX_TABLE_ROWS: usize = 200;
/// 每个表格的列数。
pub const MAX_TABLE_COLS: usize = 30;
/// 代码块数。
pub const MAX_CODE_BLOCKS: usize = 30;
/// 标签数。
pub const MAX_TAGS: usize = 20;
/// `custom` 里的键数(提取要求一般只要几项)。
pub const MAX_CUSTOM_KEYS: usize = 50;
/// `custom` 里字符串值的长度。
pub const MAX_CUSTOM_TEXT_CHARS: usize = 4_000;
/// `custom` 的嵌套深度(更深的整段丢掉,避免畸形输出撑爆渲染)。
pub const MAX_CUSTOM_DEPTH: usize = 4;

/// 一个小节。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Section {
    /// 小节标题。
    pub heading: String,
    /// 标题层级(1..=6)。
    pub level: u8,
    /// 小节正文。
    pub content: String,
}

/// 一条可以单独查的事实。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fact {
    /// 名称(价格 / 版本 / 参数名 …)。
    pub name: String,
    /// 值。
    pub value: String,
    /// 单位(没有为 `None`)。
    pub unit: Option<String>,
}

/// 一个表格。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Table {
    /// 表题。
    pub caption: Option<String>,
    /// 表头。
    pub headers: Vec<String>,
    /// 数据行。
    pub rows: Vec<Vec<String>>,
}

/// 一段代码。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodeBlock {
    /// 语言。
    pub lang: String,
    /// 代码。
    pub code: String,
}

/// 涉及的对象。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entity {
    /// 名称。
    pub name: String,
    /// 类型(见 [`ENTITY_TYPES`])。
    #[serde(rename = "type")]
    pub kind: String,
}

/// 一个链接。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Link {
    /// 链接文字。
    pub text: String,
    /// 绝对地址(一定出现在页面的真实链接里)。
    pub url: String,
}

/// 一个页面(或一段)的规范化结果。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct NormalizedPage {
    /// 标题。
    pub title: String,
    /// 页面类型(见 [`PAGE_TYPES`])。
    pub page_type: String,
    /// 主要语言。
    pub language: String,
    /// 摘要。
    pub summary: String,
    /// 作者。
    pub author: Option<String>,
    /// 发布时间(原文写法)。
    pub published_at: Option<String>,
    /// 更新时间(原文写法)。
    pub updated_at: Option<String>,
    /// 要点。
    pub key_points: Vec<String>,
    /// 小节。
    pub sections: Vec<Section>,
    /// 事实。
    pub facts: Vec<Fact>,
    /// 表格。
    pub tables: Vec<Table>,
    /// 代码。
    pub code_blocks: Vec<CodeBlock>,
    /// 涉及的对象。
    pub entities: Vec<Entity>,
    /// 链接。
    pub links: Vec<Link>,
    /// 标签。
    pub tags: Vec<String>,
    /// 按提取要求整理的内容(没有提取要求时为空)。
    pub custom: Map<String, Value>,
    /// 页面太长、后面的部分没有送给模型。
    #[serde(default)]
    pub truncated: bool,
}

/// 解析一段模型输出。
///
/// `allowed_links`:页面里真实出现过的链接(绝对地址)。不在里面的链接一律丢掉。
pub fn parse_output(text: &str, allowed_links: &[String]) -> Result<NormalizedPage> {
    let cleaned = strip_fence(text);
    let value: Value = serde_json::from_str(&cleaned)
        .map_err(|err| KbError::Upstream(format!("规范化输出不是合法 JSON: {err}")))?;
    let Value::Object(object) = value else {
        return Err(KbError::Upstream("规范化输出不是 JSON 对象".to_owned()));
    };
    Ok(from_object(&object, allowed_links))
}

fn from_object(object: &Map<String, Value>, allowed_links: &[String]) -> NormalizedPage {
    let allowed = LinkSet::new(allowed_links);
    NormalizedPage {
        title: text_of(object.get("title"), MAX_TITLE_CHARS),
        page_type: one_of(object.get("page_type"), PAGE_TYPES),
        language: text_of(object.get("language"), MAX_SHORT_CHARS),
        summary: text_of(object.get("summary"), MAX_SUMMARY_CHARS),
        author: optional_text(object.get("author"), MAX_SHORT_CHARS),
        published_at: optional_text(object.get("published_at"), MAX_SHORT_CHARS),
        updated_at: optional_text(object.get("updated_at"), MAX_SHORT_CHARS),
        key_points: text_list(object.get("key_points"), MAX_LIST_ITEMS, MAX_POINT_CHARS),
        sections: objects(object.get("sections"), MAX_SECTIONS, |item| {
            let heading = text_of(item.get("heading"), MAX_TITLE_CHARS);
            let content = text_of(item.get("content"), MAX_SECTION_CHARS);
            if heading.is_empty() && content.is_empty() {
                return None;
            }
            let level = item
                .get("level")
                .and_then(Value::as_u64)
                .map_or(2, |level| level.clamp(1, 6) as u8);
            Some(Section {
                heading,
                level,
                content,
            })
        }),
        facts: objects(object.get("facts"), MAX_LIST_ITEMS, |item| {
            let name = text_of(item.get("name"), MAX_SHORT_CHARS);
            let value = scalar_text(item.get("value"), MAX_SHORT_CHARS);
            if name.is_empty() || value.is_empty() {
                return None;
            }
            Some(Fact {
                name,
                value,
                unit: optional_text(item.get("unit"), MAX_SHORT_CHARS),
            })
        }),
        tables: objects(object.get("tables"), MAX_TABLES, |item| {
            let headers = text_list(item.get("headers"), MAX_TABLE_COLS, MAX_CELL_CHARS);
            let rows: Vec<Vec<String>> = match item.get("rows") {
                Some(Value::Array(rows)) => rows
                    .iter()
                    .filter_map(|row| match row {
                        Value::Array(cells) => Some(
                            cells
                                .iter()
                                .take(MAX_TABLE_COLS)
                                .map(|cell| scalar_text(Some(cell), MAX_CELL_CHARS))
                                .collect::<Vec<_>>(),
                        ),
                        _ => None,
                    })
                    .filter(|row: &Vec<String>| row.iter().any(|cell| !cell.is_empty()))
                    .take(MAX_TABLE_ROWS)
                    .collect(),
                _ => Vec::new(),
            };
            if headers.is_empty() && rows.is_empty() {
                return None;
            }
            Some(Table {
                caption: optional_text(item.get("caption"), MAX_TITLE_CHARS),
                headers,
                rows,
            })
        }),
        code_blocks: objects(object.get("code_blocks"), MAX_CODE_BLOCKS, |item| {
            let code = text_of(item.get("code"), MAX_CODE_CHARS);
            if code.is_empty() {
                return None;
            }
            let lang = text_of(item.get("lang"), MAX_TAG_CHARS);
            Some(CodeBlock {
                lang: if lang.is_empty() {
                    "text".to_owned()
                } else {
                    lang
                },
                code,
            })
        }),
        entities: objects(object.get("entities"), MAX_LIST_ITEMS, |item| {
            let name = text_of(item.get("name"), MAX_SHORT_CHARS);
            if name.is_empty() {
                return None;
            }
            Some(Entity {
                name,
                kind: one_of(item.get("type"), ENTITY_TYPES),
            })
        }),
        links: objects(object.get("links"), MAX_LIST_ITEMS, |item| {
            let url = allowed.canonical(&text_of(item.get("url"), MAX_URL_CHARS))?;
            let text = text_of(item.get("text"), MAX_SHORT_CHARS);
            Some(Link {
                text: if text.is_empty() { url.clone() } else { text },
                url,
            })
        }),
        tags: text_list(object.get("tags"), MAX_TAGS, MAX_TAG_CHARS),
        custom: match object.get("custom") {
            Some(Value::Object(custom)) => sanitize_custom(custom),
            _ => Map::new(),
        },
        truncated: false,
    }
}

/// 页面真实链接的集合:比较时去掉 `#片段` 与末尾的 `/`,返回页面里的那个写法。
struct LinkSet {
    by_key: std::collections::HashMap<String, String>,
}

impl LinkSet {
    fn new(links: &[String]) -> Self {
        Self {
            by_key: links
                .iter()
                .map(|link| (link_key(link), link.clone()))
                .collect(),
        }
    }

    fn canonical(&self, url: &str) -> Option<String> {
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return None;
        }
        self.by_key.get(&link_key(url)).cloned()
    }
}

fn link_key(url: &str) -> String {
    let without_fragment = url.trim().split('#').next().unwrap_or_default();
    without_fragment.trim_end_matches('/').to_owned()
}

/// 把多段的结果合成一页（设计规范）。
///
/// 标题、类型、语言、作者、日期、摘要取第 1 段(第 1 段为空时取后面第一个非空的);
/// 列表按段顺序拼接并去重;`custom` 按键合并,同键的值追加成数组。
pub fn merge(parts: Vec<NormalizedPage>) -> NormalizedPage {
    let mut parts = parts.into_iter();
    let Some(mut merged) = parts.next() else {
        return NormalizedPage::default();
    };
    for part in parts {
        fill_if_empty(&mut merged.title, part.title);
        if merged.page_type.is_empty() || merged.page_type == "other" {
            merged.page_type = part.page_type;
        }
        fill_if_empty(&mut merged.language, part.language);
        fill_if_empty(&mut merged.summary, part.summary);
        merged.author = merged.author.or(part.author);
        merged.published_at = merged.published_at.or(part.published_at);
        merged.updated_at = merged.updated_at.or(part.updated_at);
        merged.key_points.extend(part.key_points);
        merged.sections.extend(part.sections);
        merged.facts.extend(part.facts);
        merged.tables.extend(part.tables);
        merged.code_blocks.extend(part.code_blocks);
        merged.entities.extend(part.entities);
        merged.links.extend(part.links);
        merged.tags.extend(part.tags);
        for (key, value) in part.custom {
            merge_custom_value(&mut merged.custom, key, value);
        }
        merged.truncated |= part.truncated;
    }
    dedup_by_text(&mut merged.key_points);
    dedup_by_text(&mut merged.sections);
    dedup_by_text(&mut merged.facts);
    dedup_by_text(&mut merged.tables);
    dedup_by_text(&mut merged.code_blocks);
    dedup_by_text(&mut merged.entities);
    dedup_links(&mut merged.links);
    dedup_by_text(&mut merged.tags);
    // 合并后再按单段的上限截一次:多段拼起来不能绕过上限
    merged.key_points.truncate(MAX_LIST_ITEMS);
    merged.sections.truncate(MAX_SECTIONS);
    merged.facts.truncate(MAX_LIST_ITEMS);
    merged.tables.truncate(MAX_TABLES);
    merged.code_blocks.truncate(MAX_CODE_BLOCKS);
    merged.entities.truncate(MAX_LIST_ITEMS);
    merged.links.truncate(MAX_LIST_ITEMS);
    merged.tags.truncate(MAX_TAGS);
    if merged.page_type.is_empty() {
        merged.page_type = "other".to_owned();
    }
    merged
}

fn fill_if_empty(target: &mut String, candidate: String) {
    if target.trim().is_empty() {
        *target = candidate;
    }
}

/// 同键的值追加成数组:两边都是数组就拼起来;已经相同就不重复。
fn merge_custom_value(custom: &mut Map<String, Value>, key: String, value: Value) {
    if !custom.contains_key(&key) && custom.len() >= MAX_CUSTOM_KEYS {
        return;
    }
    let merged = match custom.remove(&key) {
        None => value,
        Some(existing) if existing == value => existing,
        Some(Value::Array(mut items)) => {
            match value {
                Value::Array(more) => {
                    for item in more {
                        if !items.contains(&item) {
                            items.push(item);
                        }
                    }
                }
                other => {
                    if !items.contains(&other) {
                        items.push(other);
                    }
                }
            }
            Value::Array(items)
        }
        Some(existing) => Value::Array(vec![existing, value]),
    };
    custom.insert(key, merged);
}

/// 按“规范化后的文本”去重(忽略大小写与空白差异),保留第一次出现的。
fn dedup_by_text<T: Serialize>(items: &mut Vec<T>) {
    let mut seen = HashSet::new();
    items.retain(|item| {
        let key = serde_json::to_string(item)
            .unwrap_or_default()
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        seen.insert(key)
    });
}

/// 链接按地址去重(同一地址的不同链接文字只留第一个)。
fn dedup_links(links: &mut Vec<Link>) {
    let mut seen = HashSet::new();
    links.retain(|link| seen.insert(link_key(&link.url)));
}

// ---- 宽松取值 ----

/// 字符串字段:不是字符串就当空;去掉首尾空白并截断。
fn text_of(value: Option<&Value>, max_chars: usize) -> String {
    match value {
        Some(Value::String(text)) => clip(text.trim(), max_chars),
        _ => String::new(),
    }
}

/// 可空字符串:空串、`null`、类型不对都算没有。
fn optional_text(value: Option<&Value>, max_chars: usize) -> Option<String> {
    let text = scalar_text(value, max_chars);
    (!text.is_empty()).then_some(text)
}

/// 标量转文本:字符串原样,数字 / 布尔转成字面量(价格、版本号模型常常写成数字)。
fn scalar_text(value: Option<&Value>, max_chars: usize) -> String {
    match value {
        Some(Value::String(text)) => clip(text.trim(), max_chars),
        Some(Value::Number(number)) => clip(&number.to_string(), max_chars),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

/// 枚举字段:不在列表里就是 `other`。
fn one_of(value: Option<&Value>, allowed: &[&str]) -> String {
    let text = text_of(value, MAX_SHORT_CHARS).to_ascii_lowercase();
    if allowed.contains(&text.as_str()) {
        text
    } else {
        "other".to_owned()
    }
}

/// 字符串数组:非字符串元素、空串丢掉。
fn text_list(value: Option<&Value>, max_items: usize, max_chars: usize) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| scalar_text(Some(item), max_chars))
            .filter(|text| !text.is_empty())
            .take(max_items)
            .collect(),
        _ => Vec::new(),
    }
}

/// 对象数组:非对象元素丢掉;`build` 返回 `None` 的(必填字段缺失)也丢掉。
fn objects<T>(
    value: Option<&Value>,
    max_items: usize,
    build: impl Fn(&Map<String, Value>) -> Option<T>,
) -> Vec<T> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_object().and_then(&build))
            .take(max_items)
            .collect(),
        _ => Vec::new(),
    }
}

/// `custom` 是自由结构:限制键数、字符串长度、数组长度与嵌套深度。
fn sanitize_custom(custom: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in custom.iter().take(MAX_CUSTOM_KEYS) {
        let key = clip(key.trim(), MAX_SHORT_CHARS);
        if key.is_empty() {
            continue;
        }
        if let Some(value) = sanitize_value(value, 1) {
            out.insert(key, value);
        }
    }
    out
}

fn sanitize_value(value: &Value, depth: usize) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::String(text) => {
            let text = clip(text.trim(), MAX_CUSTOM_TEXT_CHARS);
            (!text.is_empty()).then_some(Value::String(text))
        }
        Value::Bool(_) | Value::Number(_) => Some(value.clone()),
        Value::Array(items) => {
            if depth >= MAX_CUSTOM_DEPTH {
                return None;
            }
            let items: Vec<Value> = items
                .iter()
                .filter_map(|item| sanitize_value(item, depth + 1))
                .take(MAX_LIST_ITEMS)
                .collect();
            (!items.is_empty()).then_some(Value::Array(items))
        }
        Value::Object(map) => {
            if depth >= MAX_CUSTOM_DEPTH {
                return None;
            }
            let mut out = Map::new();
            for (key, value) in map.iter().take(MAX_CUSTOM_KEYS) {
                let key = clip(key.trim(), MAX_SHORT_CHARS);
                if key.is_empty() {
                    continue;
                }
                if let Some(value) = sanitize_value(value, depth + 1) {
                    out.insert(key, value);
                }
            }
            (!out.is_empty()).then_some(Value::Object(out))
        }
    }
}

/// 按字符截断(超出时末尾加“…”)。
pub fn clip(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max_chars.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// 去掉 ```json 围栏(模型偶尔会加,即使要求了 JSON 输出)。
fn strip_fence(text: &str) -> String {
    let trimmed = text.trim();
    let without_open = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed);
    without_open
        .trim_end()
        .strip_suffix("```")
        .unwrap_or(without_open)
        .trim()
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn links() -> Vec<String> {
        vec![
            "https://docs.example.com/install".to_owned(),
            "https://docs.example.com/config/".to_owned(),
        ]
    }

    #[test]
    fn parses_a_complete_output() {
        let text = json!({
            "title": "安装指南",
            "page_type": "doc",
            "language": "zh",
            "summary": "介绍如何安装。",
            "author": "张三",
            "published_at": "2026-10-01",
            "updated_at": null,
            "key_points": ["先装工具链", "再装依赖"],
            "sections": [{"heading": "准备", "level": 2, "content": "需要 Rust 1.91"}],
            "facts": [{"name": "最低版本", "value": "1.91", "unit": null}],
            "tables": [{"caption": "平台", "headers": ["系统", "支持"], "rows": [["Linux", "是"]]}],
            "code_blocks": [{"lang": "bash", "code": "cargo build"}],
            "entities": [{"name": "Rust", "type": "tech"}],
            "links": [{"text": "配置", "url": "https://docs.example.com/config"}],
            "tags": ["安装", "rust"],
            "custom": {}
        })
        .to_string();
        let page = parse_output(&text, &links()).expect("解析");
        assert_eq!(page.title, "安装指南");
        assert_eq!(page.page_type, "doc");
        assert_eq!(page.author.as_deref(), Some("张三"));
        assert_eq!(page.updated_at, None);
        assert_eq!(page.sections[0].level, 2);
        assert_eq!(page.facts[0].value, "1.91");
        assert_eq!(
            page.tables[0].rows,
            vec![vec!["Linux".to_owned(), "是".to_owned()]]
        );
        // 链接比较时忽略末尾的 `/`,返回页面里的写法
        assert_eq!(page.links[0].url, "https://docs.example.com/config/");
        assert!(!page.truncated);
    }

    #[test]
    fn tolerates_wrong_types_missing_fields_and_fences() {
        let text = "```json\n{\"title\": 42, \"page_type\": \"博客\", \"key_points\": \"不是数组\", \
            \"facts\": [{\"name\": \"价格\", \"value\": 199}, {\"name\": \"\", \"value\": \"x\"}, \"坏元素\"], \
            \"entities\": [{\"name\": \"某公司\", \"type\": \"company\"}], \
            \"sections\": [{\"heading\": \"一\", \"level\": 99, \"content\": \"内容\"}, {}], \
            \"unknown_field\": true}\n```";
        let page = parse_output(text, &[]).expect("宽松解析");
        assert_eq!(page.title, "", "类型不对的字段当空");
        assert_eq!(page.page_type, "other", "枚举之外归 other");
        assert!(page.key_points.is_empty());
        assert_eq!(
            page.facts.len(),
            1,
            "缺必填字段与非对象元素丢掉:{:?}",
            page.facts
        );
        assert_eq!(page.facts[0].value, "199", "数字值转成文本");
        assert_eq!(page.entities[0].kind, "other");
        assert_eq!(page.sections.len(), 1);
        assert_eq!(page.sections[0].level, 6, "层级夹在 1..=6");
    }

    #[test]
    fn rejects_non_json_and_non_objects() {
        assert!(parse_output("这不是 JSON", &[]).is_err());
        assert!(parse_output("[1, 2]", &[]).is_err());
        assert!(parse_output("", &[]).is_err());
    }

    #[test]
    fn invented_links_are_dropped_and_long_fields_are_clipped() {
        let long = "长".repeat(MAX_SUMMARY_CHARS * 3);
        let many_points: Vec<String> = (0..MAX_LIST_ITEMS + 50)
            .map(|i| format!("要点 {i}"))
            .collect();
        let text = json!({
            "summary": long,
            "key_points": many_points,
            "links": [
                {"text": "真的", "url": "https://docs.example.com/install#step-2"},
                {"text": "编的", "url": "https://evil.example/phish"},
                {"text": "相对", "url": "/install"},
                {"text": "脚本", "url": "javascript:alert(1)"}
            ],
            "tags": ["一个非常非常非常非常非常非常非常非常非常非常非常非常长的标签名字超过四十个字符了吧应该是的"]
        })
        .to_string();
        let page = parse_output(&text, &links()).expect("解析");
        assert_eq!(page.summary.chars().count(), MAX_SUMMARY_CHARS);
        assert!(page.summary.ends_with('…'));
        assert_eq!(page.key_points.len(), MAX_LIST_ITEMS);
        assert_eq!(
            page.links.len(),
            1,
            "只留页面里真实出现过的链接:{:?}",
            page.links
        );
        assert_eq!(page.links[0].url, "https://docs.example.com/install");
        assert!(page.tags[0].chars().count() <= MAX_TAG_CHARS);
    }

    #[test]
    fn custom_is_bounded_in_depth_and_size() {
        let text = json!({
            "custom": {
                "价格": "¥199",
                "规格": ["8GB", "256GB"],
                "深": {"a": {"b": {"c": {"d": "太深了"}}}},
                "空": null,
                "": "没有键名"
            }
        })
        .to_string();
        let page = parse_output(&text, &[]).expect("解析");
        assert_eq!(page.custom.get("价格"), Some(&json!("¥199")));
        assert_eq!(page.custom.get("规格"), Some(&json!(["8GB", "256GB"])));
        // 第 4 层的对象被丢掉,上面几层随之变空,也一起丢掉
        assert!(!page.custom.contains_key("深"), "{:?}", page.custom);
        assert!(
            !serde_json::to_string(&page.custom)
                .expect("序列化")
                .contains("太深了"),
            "超过深度的整段丢掉:{:?}",
            page.custom
        );
        assert!(!page.custom.contains_key("空"));
        assert!(!page.custom.contains_key(""));
    }

    #[test]
    fn merge_takes_scalars_from_the_first_part_and_concatenates_lists() {
        let first = NormalizedPage {
            title: "长文".to_owned(),
            page_type: "article".to_owned(),
            summary: "第一段的摘要".to_owned(),
            key_points: vec!["甲".to_owned(), "乙".to_owned()],
            tags: vec!["Rust".to_owned()],
            custom: Map::from_iter([("价格".to_owned(), json!("¥1"))]),
            ..NormalizedPage::default()
        };
        let second = NormalizedPage {
            title: "第二段以为的标题".to_owned(),
            page_type: "doc".to_owned(),
            summary: "第二段的摘要".to_owned(),
            author: Some("李四".to_owned()),
            key_points: vec!["乙".to_owned(), "丙".to_owned()],
            tags: vec!["rust".to_owned(), "并发".to_owned()],
            custom: Map::from_iter([
                ("价格".to_owned(), json!("¥2")),
                ("型号".to_owned(), json!("X1")),
            ]),
            truncated: true,
            ..NormalizedPage::default()
        };
        let merged = merge(vec![first, second]);
        assert_eq!(merged.title, "长文");
        assert_eq!(merged.page_type, "article");
        assert_eq!(merged.summary, "第一段的摘要");
        assert_eq!(
            merged.author.as_deref(),
            Some("李四"),
            "第一段没有的取后面的"
        );
        assert_eq!(merged.key_points, vec!["甲", "乙", "丙"]);
        assert_eq!(merged.tags, vec!["Rust", "并发"], "去重忽略大小写");
        assert_eq!(merged.custom.get("价格"), Some(&json!(["¥1", "¥2"])));
        assert_eq!(merged.custom.get("型号"), Some(&json!("X1")));
        assert!(merged.truncated);
        assert_eq!(merge(Vec::new()), NormalizedPage::default());
    }
}
