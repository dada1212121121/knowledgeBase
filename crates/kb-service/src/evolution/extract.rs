//! 提炼:把一次开发事件交给 `extract_model`,拿回候选经验。
//!
//! 输入是**截断后的** diff(≤ 8k token)或会话摘要 + 项目名;输出是 JSON。
//! 提示词模板在 `kb-llm/prompts/extract.md`(用 `include_str!` 编进来,部署时不依赖外部文件)。

use kb_core::model::{ChatMessage, ChatRequest, InsightKind};
use kb_core::{KbError, Result};
use serde::Deserialize;

/// 提示词模板。
pub const EXTRACT_PROMPT: &str = include_str!("../../../kb-llm/prompts/extract.md");

/// 每个事件最多提炼几条。
pub const MAX_ITEMS: usize = 3;

/// 置信度低于这个值的候选直接丢弃。
pub const MIN_CONFIDENCE: f64 = 0.5;

/// 送进提示词的 diff 上限(字符数;约 8k token 的量级)。
pub const MAX_INPUT_CHARS: usize = 24_000;

/// 一条候选经验。
#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    /// 标题。
    pub title: String,
    /// 正文。
    pub body_md: String,
    /// 种类。
    pub kind: InsightKind,
    /// 标签。
    pub tags: Vec<String>,
    /// 关联文件。
    pub related_paths: Vec<String>,
    /// 证据(引用原文)。
    pub evidence: String,
    /// 置信度。
    pub confidence: f64,
}

/// 提炼请求。
#[derive(Clone, Debug)]
pub struct ExtractInput {
    /// 项目名(进提示词,也用于日志)。
    pub project: String,
    /// 事件类型(`git_commit` / `session_end` …)。
    pub event_kind: String,
    /// 正文(diff 或会话摘要)。
    pub content: String,
    /// 用哪个模型。
    pub model: String,
}

/// 拼提示词(单独抽出来便于断言)。
///
/// `template` 来自声明式 skill,
/// 为空时用编进二进制的默认模板;占位符替换规则两者一致。
pub fn build_prompt(input: &ExtractInput, template: Option<&str>) -> String {
    template
        .unwrap_or(EXTRACT_PROMPT)
        .replace("{{max_items}}", &MAX_ITEMS.to_string())
        .replace("{{project}}", &input.project)
        .replace("{{event_kind}}", &input.event_kind)
}

/// 拼请求。
pub fn build_request(input: &ExtractInput, template: Option<&str>) -> ChatRequest {
    let content = truncate(&input.content, MAX_INPUT_CHARS);
    ChatRequest {
        model: input.model.clone(),
        messages: vec![
            ChatMessage {
                role: "system".to_owned(),
                content: Some(build_prompt(input, template)),
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
            ChatMessage {
                role: "user".to_owned(),
                content: Some(content),
                tool_calls: Vec::new(),
                tool_call_id: None,
            },
        ],
        tools: Vec::new(),
        json_output: true,
        thinking: false,
        max_tokens: Some(2048),
        temperature: Some(0.2),
    }
}

/// 解析模型的 JSON 输出。
pub fn parse_candidates(text: &str) -> Result<Vec<Candidate>> {
    #[derive(Deserialize)]
    struct RawItem {
        #[serde(default)]
        title: String,
        #[serde(default)]
        body_md: String,
        #[serde(default)]
        kind: String,
        #[serde(default)]
        tags: Vec<String>,
        #[serde(default)]
        related_paths: Vec<String>,
        #[serde(default)]
        evidence: String,
        #[serde(default)]
        confidence: f64,
    }
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        items: Vec<RawItem>,
    }
    let cleaned = strip_fence(text);
    let raw: Raw = serde_json::from_str(&cleaned)
        .map_err(|err| KbError::Upstream(format!("提炼输出不是合法 JSON: {err}")))?;
    let mut out = Vec::new();
    for item in raw.items {
        if item.title.trim().is_empty() || item.body_md.trim().is_empty() {
            continue;
        }
        if item.confidence < MIN_CONFIDENCE {
            continue;
        }
        let kind = match item.kind.trim().to_ascii_lowercase().as_str() {
            "pitfall" => InsightKind::Pitfall,
            "howto" => InsightKind::Howto,
            "convention" => InsightKind::Convention,
            _ => InsightKind::Decision,
        };
        out.push(Candidate {
            title: item.title.trim().to_owned(),
            body_md: item.body_md.trim().to_owned(),
            kind,
            tags: item.tags,
            related_paths: item.related_paths,
            evidence: item.evidence,
            confidence: item.confidence.clamp(0.0, 1.0),
        });
        if out.len() >= MAX_ITEMS {
            break;
        }
    }
    Ok(out)
}

/// 去掉 ```json 围栏(模型偶尔会加)。
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

/// 按字符截断(保留开头;diff 的关键信息通常在前面的 hunk)。
fn truncate(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push_str("\n…(已截断)");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> ExtractInput {
        ExtractInput {
            project: "demo".to_owned(),
            event_kind: "git_commit".to_owned(),
            content: "diff --git a/src/lib.rs b/src/lib.rs\n+fn f() {}".to_owned(),
            model: "deepseek-chat".to_owned(),
        }
    }

    #[test]
    fn prompt_fills_the_placeholders() {
        let prompt = build_prompt(&input(), None);
        assert!(prompt.contains("最多 3 条"), "{prompt}");
        assert!(prompt.contains("项目:demo"));
        assert!(!prompt.contains("{{"), "占位符都应被替换:{prompt}");
    }

    #[test]
    fn prompt_template_override_replaces_the_default() {
        // :`type = "prompt"` 的 skill 覆盖提炼提示词(质量检查 指出这个分支没有用例)
        let prompt = build_prompt(
            &input(),
            Some("自定义 {{project}} / {{event_kind}} / {{max_items}}"),
        );
        assert!(prompt.starts_with("自定义 "), "{prompt}");
        assert!(prompt.contains("demo"), "{prompt}");
        assert!(!prompt.contains("{{"), "占位符仍要替换:{prompt}");
        let request = build_request(&input(), Some("只有这一句"));
        assert_eq!(request.messages[0].content.as_deref(), Some("只有这一句"));
    }

    #[test]
    fn request_asks_for_json_output() {
        let request = build_request(&input(), None);
        assert!(request.json_output);
        assert_eq!(request.messages.len(), 2);
        assert_eq!(request.messages[1].role, "user");
        assert!(
            request.messages[1]
                .content
                .as_deref()
                .unwrap()
                .contains("src/lib.rs")
        );
    }

    #[test]
    fn long_input_is_truncated() {
        let mut input = input();
        input.content = "x".repeat(MAX_INPUT_CHARS + 100);
        let request = build_request(&input, None);
        let content = request.messages[1].content.clone().unwrap();
        assert!(
            content.chars().count() <= MAX_INPUT_CHARS + 10,
            "{}",
            content.len()
        );
        assert!(content.ends_with("(已截断)"));
    }

    #[test]
    fn parses_items_and_drops_low_confidence() {
        let text = r#"{"items":[
            {"title":"用双哈希判断重嵌入","body_md":"正文","kind":"decision","tags":["索引"],"related_paths":["src/index.rs"],"evidence":"e","confidence":0.9},
            {"title":"低置信","body_md":"正文","kind":"pitfall","confidence":0.3},
            {"title":"","body_md":"空标题","confidence":0.9}
        ]}"#;
        let items = parse_candidates(text).expect("解析");
        assert_eq!(items.len(), 1, "{items:?}");
        assert_eq!(items[0].kind, InsightKind::Decision);
        assert_eq!(items[0].related_paths, vec!["src/index.rs"]);
    }

    #[test]
    fn parses_fenced_json_and_caps_at_three() {
        let text = format!(
            "```json\n{{\"items\":[{}]}}\n```",
            (0..5)
                .map(|index| format!(
                    "{{\"title\":\"t{index}\",\"body_md\":\"b\",\"kind\":\"howto\",\"confidence\":0.8}}"
                ))
                .collect::<Vec<_>>()
                .join(",")
        );
        let items = parse_candidates(&text).expect("解析");
        assert_eq!(items.len(), MAX_ITEMS);
    }

    #[test]
    fn broken_json_is_an_upstream_error() {
        let error = parse_candidates("不是 JSON").expect_err("应报错");
        assert!(matches!(error, KbError::Upstream(_)), "{error}");
    }
}
