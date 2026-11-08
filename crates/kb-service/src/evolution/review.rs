//! 审核:草稿 + 相似已有条目 → `review_model` 给出结论。
//!
//! 审核模型与提炼模型**必须是不同的模型**(配置里 `review_model`),避免自评自过。

use kb_core::model::{ChatMessage, ChatRequest};
use kb_core::{KbError, Result};
use serde::Deserialize;

/// 提示词模板。
pub const REVIEW_PROMPT: &str = include_str!("../../../kb-llm/prompts/review.md");

/// 审核结论。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    /// 通过。
    Approve,
    /// 修订后通过。
    Revise,
    /// 驳回。
    Reject,
}

impl Decision {
    /// 字符串形式(写进 `review_json`)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Approve => "approve",
            Self::Revise => "revise",
            Self::Reject => "reject",
        }
    }
}

/// 审核结果。
#[derive(Clone, Debug, PartialEq)]
pub struct Review {
    /// 结论。
    pub decision: Decision,
    /// 分数(0..=1)。
    pub score: f64,
    /// 修订后的标题 / 正文。
    pub revised: Option<(String, String)>,
    /// 理由。
    pub reasons: Vec<String>,
    /// 与哪条已有条目重复。
    pub duplicate_of: Option<String>,
}

/// 一条“相似已有条目”(给审核模型参考)。
#[derive(Clone, Debug, PartialEq)]
pub struct SimilarItem {
    /// 条目 id。
    pub id: String,
    /// 标题。
    pub title: String,
    /// 正文片段。
    pub snippet: String,
}

/// 待审草稿。
#[derive(Clone, Debug)]
pub struct DraftView {
    /// 标题。
    pub title: String,
    /// 正文。
    pub body_md: String,
    /// 种类。
    pub kind: String,
    /// 证据。
    pub evidence: String,
}

/// 拼审核请求。
/// 拼审核请求;`template` 为空时用编进二进制的默认模板(`stage = "review"`)。
pub fn build_request(
    model: &str,
    draft: &DraftView,
    similar: &[SimilarItem],
    template: Option<&str>,
) -> ChatRequest {
    let similar_text = if similar.is_empty() {
        "(没有相似条目)".to_owned()
    } else {
        similar
            .iter()
            .map(|item| format!("- {} · {}\n  {}", item.id, item.title, item.snippet))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let draft_text = format!(
        "标题:{}\n种类:{}\n证据:{}\n正文:\n{}",
        draft.title, draft.kind, draft.evidence, draft.body_md
    );
    let prompt = template
        .unwrap_or(REVIEW_PROMPT)
        .replace("{{similar}}", &similar_text)
        .replace("{{draft}}", &draft_text);
    ChatRequest {
        model: model.to_owned(),
        messages: vec![ChatMessage {
            role: "user".to_owned(),
            content: Some(prompt),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }],
        tools: Vec::new(),
        json_output: true,
        thinking: false,
        max_tokens: Some(1024),
        temperature: Some(0.0),
    }
}

/// 解析审核输出。
pub fn parse_review(text: &str) -> Result<Review> {
    #[derive(Deserialize)]
    struct RawRevised {
        #[serde(default)]
        title: String,
        #[serde(default)]
        body_md: String,
    }
    #[derive(Deserialize)]
    struct Raw {
        #[serde(default)]
        decision: String,
        #[serde(default)]
        score: f64,
        #[serde(default)]
        revised: Option<RawRevised>,
        #[serde(default)]
        reasons: Vec<String>,
        #[serde(default)]
        duplicate_of: Option<String>,
    }
    let cleaned = strip_fence(text);
    let raw: Raw = serde_json::from_str(&cleaned)
        .map_err(|err| KbError::Upstream(format!("审核输出不是合法 JSON: {err}")))?;
    let decision = match raw.decision.trim().to_ascii_lowercase().as_str() {
        "approve" => Decision::Approve,
        "revise" => Decision::Revise,
        "reject" => Decision::Reject,
        other => {
            return Err(KbError::Upstream(format!(
                "审核结论只能是 approve / revise / reject,收到 {other}"
            )));
        }
    };
    let revised = raw
        .revised
        .filter(|revised| !revised.title.trim().is_empty() || !revised.body_md.trim().is_empty())
        .map(|revised| {
            (
                revised.title.trim().to_owned(),
                revised.body_md.trim().to_owned(),
            )
        });
    Ok(Review {
        decision,
        score: raw.score.clamp(0.0, 1.0),
        revised,
        reasons: raw.reasons,
        duplicate_of: raw.duplicate_of.filter(|id| !id.trim().is_empty()),
    })
}

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

    fn draft() -> DraftView {
        DraftView {
            title: "用双哈希判断重嵌入".to_owned(),
            body_md: "正文".to_owned(),
            kind: "decision".to_owned(),
            evidence: "diff 片段".to_owned(),
        }
    }

    #[test]
    fn prompt_contains_draft_and_similar_items() {
        let request = build_request(
            "deepseek-reasoner",
            &draft(),
            &[SimilarItem {
                id: "i1".to_owned(),
                title: "已有条目".to_owned(),
                snippet: "片段".to_owned(),
            }],
            None,
        );
        let content = request.messages[0].content.clone().unwrap();
        assert!(content.contains("用双哈希判断重嵌入"), "{content}");
        assert!(content.contains("i1 · 已有条目"), "{content}");
        assert!(!content.contains("{{"), "占位符都应被替换");
        assert_eq!(request.model, "deepseek-reasoner");
    }

    #[test]
    fn prompt_template_override_replaces_the_default() {
        // :`type = "prompt"` + `stage = "review"` 的覆盖分支
        let request = build_request("m", &draft(), &[], Some("自定义审核:{{draft}}"));
        let content = request.messages[0].content.clone().unwrap();
        assert!(content.starts_with("自定义审核:"), "{content}");
        assert!(
            content.contains("用双哈希判断重嵌入"),
            "占位符仍要替换:{content}"
        );
    }

    #[test]
    fn empty_similar_list_is_stated() {
        let request = build_request("m", &draft(), &[], None);
        assert!(
            request.messages[0]
                .content
                .as_deref()
                .unwrap()
                .contains("没有相似条目")
        );
    }

    #[test]
    fn parses_each_decision() {
        let approve = parse_review(r#"{"decision":"approve","score":0.9,"reasons":["具体"]}"#)
            .expect("approve");
        assert_eq!(approve.decision, Decision::Approve);
        assert_eq!(approve.score, 0.9);
        let revise = parse_review(
            r#"{"decision":"revise","score":0.6,"revised":{"title":"新标题","body_md":"新正文"}}"#,
        )
        .expect("revise");
        assert_eq!(revise.decision, Decision::Revise);
        assert_eq!(revise.revised.unwrap().0, "新标题");
        let reject = parse_review(r#"{"decision":"reject","score":0.1,"reasons":["太泛"]}"#)
            .expect("reject");
        assert_eq!(reject.decision, Decision::Reject);
    }

    #[test]
    fn unknown_decision_is_an_error() {
        let error = parse_review(r#"{"decision":"maybe","score":0.5}"#).expect_err("应报错");
        assert!(matches!(error, KbError::Upstream(_)), "{error}");
    }
}
