//! 规范化结果渲染成 Markdown（设计规范）。
//!
//! 结构固定、空小节不输出:检索按块切分时每个小节自成一块,命中后读起来也有上下文。
//! 头部写明来源与“由 AI 规范化,以原文为准”,原文页面同时在库里,可以对照核实。

use serde_json::Value;

use super::normalize::NormalizedPage;

/// 渲染需要的页面信息。
#[derive(Clone, Debug)]
pub struct RenderMeta<'a> {
    /// 页面地址。
    pub url: &'a str,
    /// 抓取日期(`YYYY-MM-DD`)。
    pub fetched_on: &'a str,
    /// 模型名。
    pub model: &'a str,
    /// 原文 `<title>`(规范化结果没有标题时用)。
    pub fallback_title: Option<&'a str>,
    /// 一共切了几段(截断提示用)。
    pub parts: usize,
}

/// 页面类型的中文名。
pub fn page_type_label(kind: &str) -> &'static str {
    match kind {
        "article" => "文章",
        "doc" => "文档",
        "api_doc" => "接口文档",
        "product" => "商品",
        "list" => "列表",
        "news" => "新闻",
        "forum" => "论坛帖",
        "profile" => "个人 / 机构主页",
        _ => "其它",
    }
}

fn entity_label(kind: &str) -> &'static str {
    match kind {
        "person" => "人物",
        "org" => "组织",
        "product" => "产品",
        "tech" => "技术",
        "place" => "地点",
        _ => "其它",
    }
}

/// 渲染。
pub fn render_markdown(page: &NormalizedPage, meta: &RenderMeta<'_>) -> String {
    let mut out = String::new();
    let title = [
        Some(page.title.as_str()),
        meta.fallback_title,
        Some(meta.url),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|text| !text.is_empty())
    .unwrap_or("网页");
    out.push_str(&format!("# {}\n\n", one_line(title)));
    out.push_str(&format!(
        "> 来源:{} · 类型:{} · 抓取:{} · 由 AI 规范化({}),以原文为准\n",
        meta.url,
        page_type_label(&page.page_type),
        meta.fetched_on,
        one_line(meta.model)
    ));
    let byline: Vec<String> = [
        page.author
            .as_deref()
            .map(|value| format!("作者:{}", one_line(value))),
        page.published_at
            .as_deref()
            .map(|value| format!("发布:{}", one_line(value))),
        page.updated_at
            .as_deref()
            .map(|value| format!("更新:{}", one_line(value))),
    ]
    .into_iter()
    .flatten()
    .collect();
    if !byline.is_empty() {
        out.push_str(&format!("> {}\n", byline.join(" · ")));
    }
    if !page.tags.is_empty() {
        let tags: Vec<String> = page.tags.iter().map(|tag| one_line(tag)).collect();
        out.push_str(&format!("> 标签:{}\n", tags.join("、")));
    }
    if page.truncated {
        out.push_str(&format!(
            "> 页面较长,只整理了前 {} 段;完整内容见原文\n",
            meta.parts
        ));
    }
    out.push('\n');

    if !page.summary.trim().is_empty() {
        out.push_str("## 摘要\n\n");
        out.push_str(page.summary.trim());
        out.push_str("\n\n");
    }
    if !page.key_points.is_empty() {
        out.push_str("## 要点\n\n");
        for point in &page.key_points {
            out.push_str(&format!("- {}\n", one_line(point)));
        }
        out.push('\n');
    }
    if !page.facts.is_empty() {
        out.push_str("## 关键信息\n\n| 名称 | 值 |\n| --- | --- |\n");
        for fact in &page.facts {
            let value = match &fact.unit {
                Some(unit) => format!("{} {}", fact.value, unit),
                None => fact.value.clone(),
            };
            out.push_str(&format!("| {} | {} |\n", cell(&fact.name), cell(&value)));
        }
        out.push('\n');
    }
    if !page.sections.is_empty() {
        out.push_str("## 正文结构\n\n");
        for section in &page.sections {
            // 文档里 `#` 已经是标题、`##` 是固定小节,原文的 1–2 级落到 `###`,更深的落到 `####`
            let marks = if section.level <= 2 { "###" } else { "####" };
            if !section.heading.trim().is_empty() {
                out.push_str(&format!("{marks} {}\n\n", one_line(&section.heading)));
            }
            if !section.content.trim().is_empty() {
                out.push_str(section.content.trim());
                out.push_str("\n\n");
            }
        }
    }
    if !page.tables.is_empty() {
        out.push_str("## 表格\n\n");
        for table in &page.tables {
            if let Some(caption) = &table.caption {
                out.push_str(&format!("**{}**\n\n", one_line(caption)));
            }
            out.push_str(&markdown_table(&table.headers, &table.rows));
            out.push('\n');
        }
    }
    if !page.code_blocks.is_empty() {
        out.push_str("## 代码\n\n");
        for block in &page.code_blocks {
            let fence = fence_for(&block.code);
            out.push_str(&format!(
                "{fence}{}\n{}\n{fence}\n\n",
                one_line(&block.lang),
                block.code.trim_end()
            ));
        }
    }
    if !page.entities.is_empty() {
        out.push_str("## 涉及对象\n\n");
        for entity in &page.entities {
            out.push_str(&format!(
                "- {}({})\n",
                one_line(&entity.name),
                entity_label(&entity.kind)
            ));
        }
        out.push('\n');
    }
    if !page.links.is_empty() {
        out.push_str("## 相关链接\n\n");
        for link in &page.links {
            out.push_str(&format!(
                "- [{}]({})\n",
                link_text(&link.text),
                link.url.replace(' ', "%20").replace(')', "%29")
            ));
        }
        out.push('\n');
    }
    if !page.custom.is_empty() {
        out.push_str("## 按要求提取\n\n");
        for (key, value) in &page.custom {
            out.push_str(&format!("### {}\n\n", one_line(key)));
            render_custom_value(&mut out, value);
            out.push('\n');
        }
    }
    let trimmed = out.trim_end().len();
    out.truncate(trimmed);
    out.push('\n');
    out
}

/// `custom` 的值:字符串直接写;字符串数组写成列表;其它结构写成 JSON 代码块。
fn render_custom_value(out: &mut String, value: &Value) {
    match value {
        Value::String(text) => {
            out.push_str(text.trim());
            out.push('\n');
        }
        Value::Number(_) | Value::Bool(_) => {
            out.push_str(&value.to_string());
            out.push('\n');
        }
        Value::Array(items)
            if items
                .iter()
                .all(|item| !item.is_object() && !item.is_array()) =>
        {
            for item in items {
                let text = match item {
                    Value::String(text) => one_line(text),
                    other => other.to_string(),
                };
                out.push_str(&format!("- {text}\n"));
            }
        }
        other => {
            let json = serde_json::to_string_pretty(other).unwrap_or_default();
            let fence = fence_for(&json);
            out.push_str(&format!("{fence}json\n{json}\n{fence}\n"));
        }
    }
}

fn markdown_table(headers: &[String], rows: &[Vec<String>]) -> String {
    let width = rows
        .iter()
        .map(Vec::len)
        .chain(std::iter::once(headers.len()))
        .max()
        .unwrap_or(0)
        .max(1);
    let mut out = String::new();
    let header_cells: Vec<String> = (0..width)
        .map(|index| {
            headers
                .get(index)
                .map(|text| cell(text))
                .unwrap_or_default()
        })
        .collect();
    out.push_str(&format!("| {} |\n", header_cells.join(" | ")));
    out.push_str(&format!("|{}\n", " --- |".repeat(width)));
    for row in rows {
        let cells: Vec<String> = (0..width)
            .map(|index| row.get(index).map(|text| cell(text)).unwrap_or_default())
            .collect();
        out.push_str(&format!("| {} |\n", cells.join(" | ")));
    }
    out
}

/// 表格单元格:竖线转义、换行换成空格。
fn cell(text: &str) -> String {
    one_line(text).replace('|', "\\|")
}

/// 链接文字:方括号会打断链接语法。
fn link_text(text: &str) -> String {
    one_line(text).replace('[', "\\[").replace(']', "\\]")
}

/// 多行压成一行(标题、列表项、表格里换行会打乱结构)。
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 代码围栏:比内容里最长的一串反引号多一个,至少三个。
fn fence_for(code: &str) -> String {
    let mut longest = 0usize;
    let mut run = 0usize;
    for ch in code.chars() {
        if ch == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    "`".repeat((longest + 1).max(3))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web_extract::normalize::{CodeBlock, Entity, Fact, Link, Section, Table};
    use serde_json::{Map, json};

    fn meta() -> RenderMeta<'static> {
        RenderMeta {
            url: "https://shop.example/p/1",
            fetched_on: "2026-11-01",
            model: "deepseek-chat",
            fallback_title: Some("原文标题"),
            parts: 2,
        }
    }

    #[test]
    fn renders_the_fixed_structure() {
        let page = NormalizedPage {
            title: "X1 笔记本".to_owned(),
            page_type: "product".to_owned(),
            language: "zh".to_owned(),
            summary: "一台轻薄本。".to_owned(),
            author: None,
            published_at: Some("2026-10-01".to_owned()),
            updated_at: None,
            key_points: vec!["重 1.1kg".to_owned(), "续航\n12 小时".to_owned()],
            sections: vec![
                Section {
                    heading: "外观".to_owned(),
                    level: 2,
                    content: "铝合金机身。".to_owned(),
                },
                Section {
                    heading: "接口".to_owned(),
                    level: 3,
                    content: "两个 USB-C。".to_owned(),
                },
            ],
            facts: vec![Fact {
                name: "价格".to_owned(),
                value: "6999".to_owned(),
                unit: Some("元".to_owned()),
            }],
            tables: vec![Table {
                caption: Some("配置".to_owned()),
                headers: vec!["型号".to_owned(), "内存".to_owned()],
                rows: vec![vec!["X1|A".to_owned(), "16GB".to_owned()]],
            }],
            code_blocks: vec![CodeBlock {
                lang: "bash".to_owned(),
                code: "echo ```".to_owned(),
            }],
            entities: vec![Entity {
                name: "某公司".to_owned(),
                kind: "org".to_owned(),
            }],
            links: vec![Link {
                text: "说明书 [PDF]".to_owned(),
                url: "https://shop.example/manual.pdf".to_owned(),
            }],
            tags: vec!["笔记本".to_owned(), "轻薄".to_owned()],
            // 插入顺序与字典序一致:serde_json 开不开 preserve_order(取决于依赖图)渲染顺序都一样
            custom: Map::from_iter([
                ("价格".to_owned(), json!("6999 元")),
                ("参数".to_owned(), json!({"CPU": "8 核"})),
                ("颜色".to_owned(), json!(["银", "灰"])),
            ]),
            truncated: true,
        };
        let expected = "# X1 笔记本

> 来源:https://shop.example/p/1 · 类型:商品 · 抓取:2026-11-01 · 由 AI 规范化(deepseek-chat),以原文为准
> 发布:2026-10-01
> 标签:笔记本、轻薄
> 页面较长,只整理了前 2 段;完整内容见原文

## 摘要

一台轻薄本。

## 要点

- 重 1.1kg
- 续航 12 小时

## 关键信息

| 名称 | 值 |
| --- | --- |
| 价格 | 6999 元 |

## 正文结构

### 外观

铝合金机身。

#### 接口

两个 USB-C。

## 表格

**配置**

| 型号 | 内存 |
| --- | --- |
| X1\\|A | 16GB |

## 代码

````bash
echo ```
````

## 涉及对象

- 某公司(组织)

## 相关链接

- [说明书 \\[PDF\\]](https://shop.example/manual.pdf)

## 按要求提取

### 价格

6999 元

### 参数

```json
{
  \"CPU\": \"8 核\"
}
```

### 颜色

- 银
- 灰
";
        assert_eq!(render_markdown(&page, &meta()), expected);
    }

    #[test]
    fn empty_sections_are_omitted_and_title_falls_back() {
        let page = NormalizedPage {
            page_type: "other".to_owned(),
            ..NormalizedPage::default()
        };
        let text = render_markdown(&page, &meta());
        assert_eq!(
            text,
            "# 原文标题\n\n> 来源:https://shop.example/p/1 · 类型:其它 · 抓取:2026-11-01 · 由 AI 规范化(deepseek-chat),以原文为准\n"
        );
        let no_title = RenderMeta {
            fallback_title: None,
            ..meta()
        };
        assert!(render_markdown(&page, &no_title).starts_with("# https://shop.example/p/1\n"));
    }
}
