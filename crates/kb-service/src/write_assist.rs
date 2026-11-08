//! 编辑器里的 AI 写作(UI-3):润色 / 总结 / 翻译 / 续写 / 按要求改写正在写的笔记。
//!
//! 和 AI 管家(`agent`)的区别:**无状态**——不建会话、不调工具、不读知识库,一次请求一次回答;
//! 结果只交还编辑器,由用户在页面上确认后才写进文档(这里不改任何数据)。
//! 外发一律经 [`LlmGate`]:AI 总开关、脱敏、全站预算、按人额度、留痕与其它 AI 功能完全一致,
//! 用途记为 `write`(用量页按用途分开统计)。

use std::sync::Arc;

use kb_core::model::{ChatMessage, ChatRequest};
use kb_core::ports::ChatModel;
use kb_core::{KbError, Result};

use crate::llm_gate::{LlmGate, Purpose};

/// 选中文字的上限(字符)。一次改写的是一段、几段;整篇长文改写既慢又贵,结果也很难逐处核对。
pub const MAX_TEXT_CHARS: usize = 12_000;
/// 上下文(光标前的正文)最多带多少字符:续写只需要贴近光标的那一截,带全文浪费额度。
pub const MAX_CONTEXT_CHARS: usize = 4_000;
/// 「按要求改写」的要求最长多少字符。
pub const MAX_INSTRUCTION_CHARS: usize = 500;

/// 写作动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteAction {
    /// 润色:改通顺、改准确,保持原意和长度。
    Polish,
    /// 总结:几句话或要点。
    Summarize,
    /// 翻译:中文 ↔ 英文(或指定语言)。
    Translate,
    /// 续写:接着光标前的内容往下写。
    Continue,
    /// 按用户写的要求处理(没选中文字时就是「按要求写一段」)。
    Custom,
}

impl WriteAction {
    /// 从请求里的字符串解析;认不出返回 `InvalidInput`。
    pub fn parse(name: &str) -> Result<Self> {
        match name {
            "polish" => Ok(Self::Polish),
            "summarize" | "summary" => Ok(Self::Summarize),
            "translate" => Ok(Self::Translate),
            "continue" => Ok(Self::Continue),
            "custom" => Ok(Self::Custom),
            other => Err(KbError::InvalidInput(format!(
                "不认识的写作动作「{other}」,可用 polish / summarize / translate / continue / custom"
            ))),
        }
    }
}

/// 一次写作请求(已校验)。
#[derive(Clone, Debug)]
pub struct WriteRequest {
    /// 动作。
    pub action: WriteAction,
    /// 选中的文字(续写 / 按要求写一段时可以为空)。
    pub text: String,
    /// 光标前的正文(只取最后 [`MAX_CONTEXT_CHARS`] 个字符)。
    pub context: String,
    /// 「按要求改写」的要求。
    pub instruction: String,
    /// 翻译的目标语言(空 = 中文译英文、其它译中文)。
    pub target_lang: String,
}

impl WriteRequest {
    /// 校验并整理请求:动作要认得、该有的输入要有、长度不超限。
    pub fn new(
        action: &str,
        text: &str,
        context: Option<&str>,
        instruction: Option<&str>,
        target_lang: Option<&str>,
    ) -> Result<Self> {
        let action = WriteAction::parse(action)?;
        let text = text.trim().to_owned();
        let instruction = instruction.unwrap_or_default().trim().to_owned();
        let context = tail_chars(context.unwrap_or_default().trim(), MAX_CONTEXT_CHARS);
        if text.chars().count() > MAX_TEXT_CHARS {
            return Err(KbError::InvalidInput(format!(
                "选中的内容太长了(超过 {MAX_TEXT_CHARS} 字),请分几段处理"
            )));
        }
        if instruction.chars().count() > MAX_INSTRUCTION_CHARS {
            return Err(KbError::InvalidInput(format!(
                "要求写得太长了(超过 {MAX_INSTRUCTION_CHARS} 字),请精简一下"
            )));
        }
        match action {
            WriteAction::Polish | WriteAction::Summarize | WriteAction::Translate
                if text.is_empty() =>
            {
                return Err(KbError::InvalidInput("先选中要处理的文字".to_owned()));
            }
            WriteAction::Continue if text.is_empty() && context.is_empty() => {
                return Err(KbError::InvalidInput(
                    "上面还没有内容可以接着写,先写几句再续写".to_owned(),
                ));
            }
            WriteAction::Custom if instruction.is_empty() => {
                return Err(KbError::InvalidInput("写一下要 AI 做什么".to_owned()));
            }
            _ => {}
        }
        Ok(Self {
            action,
            text,
            context,
            instruction,
            target_lang: target_lang.unwrap_or_default().trim().to_owned(),
        })
    }
}

/// 只留最后 `max` 个字符(按字符,不按字节,不会切坏汉字)。
fn tail_chars(text: &str, max: usize) -> String {
    let count = text.chars().count();
    if count <= max {
        return text.to_owned();
    }
    text.chars().skip(count - max).collect()
}

const SYSTEM_PROMPT: &str = "你是写作助手,帮用户修改他正在写的笔记(Markdown)。\
只输出结果本身:不要解释、不要写「好的」「以下是」之类的开场白,不要用代码块把结果包起来;\
保留原文里的 Markdown 格式(标题、列表、链接、[[双链]]、行内代码);\
不要编造原文和上下文里没有的事实、数字、链接。";

/// 拼给模型的消息(系统提示 + 一条用户消息)。原文放在标签里,模型不会把原文里的话当成指令。
pub fn build_messages(request: &WriteRequest) -> Vec<ChatMessage> {
    let original = format!("<原文>\n{}\n</原文>", request.text);
    let user = match request.action {
        WriteAction::Polish => format!(
            "润色下面这段文字:改通顺、改准确、去掉重复,保持原意、语气和语言(中文还是中文,英文还是英文),篇幅大致不变。\n\n{original}"
        ),
        WriteAction::Summarize => format!(
            "用原文的语言总结下面这段内容:内容少就写两三句话,要点多就写成要点列表。只写原文里有的信息。\n\n{original}"
        ),
        WriteAction::Translate => {
            let target = if request.target_lang.is_empty() {
                "英文(如果原文主要是英文或其它外文,就翻译成简体中文)".to_owned()
            } else {
                request.target_lang.clone()
            };
            format!(
                "把下面这段内容翻译成{target}。专有名词、代码、链接保持原样,只输出译文。\n\n{original}"
            )
        }
        WriteAction::Continue => {
            let before = if request.text.is_empty() {
                request.context.clone()
            } else if request.context.is_empty() {
                request.text.clone()
            } else {
                format!("{}\n\n{}", request.context, request.text)
            };
            format!(
                "下面是用户写到一半的笔记。接着最后一句往下写一到两段:语言、语气、格式和上文一致,不要重复上文,不要写总结性的套话。\n\n<上文>\n{before}\n</上文>"
            )
        }
        WriteAction::Custom => {
            let context = if request.context.is_empty() {
                String::new()
            } else {
                format!("\n\n<上下文>\n{}\n</上下文>", request.context)
            };
            if request.text.is_empty() {
                format!(
                    "按这个要求写一段内容,放在用户光标处:{}{context}",
                    request.instruction
                )
            } else {
                format!(
                    "按这个要求处理下面的内容:{}\n\n{original}{context}",
                    request.instruction
                )
            }
        }
    };
    vec![message("system", SYSTEM_PROMPT), message("user", &user)]
}

fn message(role: &str, content: &str) -> ChatMessage {
    ChatMessage {
        role: role.to_owned(),
        content: Some(content.to_owned()),
        tool_calls: Vec::new(),
        tool_call_id: None,
    }
}

/// 整理模型的回答:去掉首尾空白,以及模型不听话时整段包上的 ``` 代码围栏
/// (原文本来就是一个代码块时,改写结果里的围栏是内容,不去掉)。
pub fn clean_output(raw: &str, original: &str) -> String {
    let text = raw.trim();
    let original_fenced = original.trim_start().starts_with("```");
    if !original_fenced
        && let Some(rest) = text.strip_prefix("```")
        && let Some(body) = rest.strip_suffix("```")
    {
        // 第一行是语言标记(```markdown),去掉
        let body = body.split_once('\n').map_or(body, |(first, tail)| {
            if first.trim().chars().all(|c| c.is_ascii_alphanumeric()) {
                tail
            } else {
                body
            }
        });
        return body.trim().to_owned();
    }
    text.to_owned()
}

/// 调一次模型。结果为空(模型什么都没写)时报错,不把空串交给编辑器去「替换选中」。
pub async fn run(
    gate: &LlmGate,
    model: &Arc<dyn ChatModel>,
    request: &WriteRequest,
) -> Result<String> {
    let max_tokens = match request.action {
        WriteAction::Summarize => 800,
        WriteAction::Continue => 1_200,
        // 改写 / 翻译的结果和原文差不多长:按原文长度给,至少 600
        _ => (request.text.chars().count() as u32 * 2).clamp(600, 6_000),
    };
    let chat = ChatRequest {
        model: model.id().to_owned(),
        messages: build_messages(request),
        tools: Vec::new(),
        json_output: false,
        thinking: false,
        max_tokens: Some(max_tokens),
        temperature: Some(match request.action {
            WriteAction::Continue | WriteAction::Custom => 0.7,
            _ => 0.3,
        }),
    };
    let response = gate.send(None, Purpose::Write, model, chat).await?;
    let text = clean_output(
        response.message.content.as_deref().unwrap_or_default(),
        &request.text,
    );
    if text.is_empty() {
        return Err(KbError::Upstream(
            "模型这次没有给出内容,请再试一次".to_owned(),
        ));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(action: &str, text: &str) -> Result<WriteRequest> {
        WriteRequest::new(action, text, None, None, None)
    }

    #[test]
    fn unknown_action_and_missing_inputs_are_rejected_with_readable_reasons() {
        assert!(
            matches!(request("shout", "x"), Err(KbError::InvalidInput(msg)) if msg.contains("shout"))
        );
        assert!(
            matches!(request("polish", "  "), Err(KbError::InvalidInput(msg)) if msg.contains("选中"))
        );
        assert!(
            matches!(request("continue", ""), Err(KbError::InvalidInput(msg)) if msg.contains("续写"))
        );
        assert!(matches!(
            WriteRequest::new("custom", "x", None, Some(" "), None),
            Err(KbError::InvalidInput(msg)) if msg.contains("要 AI 做什么")
        ));
        assert!(WriteRequest::new("continue", "", Some("上文"), None, None).is_ok());
        assert!(WriteRequest::new("custom", "", None, Some("写个开头"), None).is_ok());
    }

    #[test]
    fn overlong_text_is_rejected_and_context_keeps_only_the_tail() {
        let long = "字".repeat(MAX_TEXT_CHARS + 1);
        assert!(matches!(
            request("polish", &long),
            Err(KbError::InvalidInput(_))
        ));
        let context = format!("{}结尾", "前".repeat(MAX_CONTEXT_CHARS));
        let parsed = WriteRequest::new("continue", "", Some(&context), None, None).expect("续写");
        assert_eq!(parsed.context.chars().count(), MAX_CONTEXT_CHARS);
        assert!(parsed.context.ends_with("结尾"));
    }

    #[test]
    fn prompts_wrap_the_original_in_tags_and_follow_the_action() {
        let polish = build_messages(&request("polish", "这个功能很好用很好用").expect("润色"));
        assert_eq!(polish[0].role, "system");
        let user = polish[1].content.as_deref().expect("用户消息");
        assert!(user.contains("润色"));
        assert!(user.contains("<原文>\n这个功能很好用很好用\n</原文>"));

        let translate = build_messages(
            &WriteRequest::new("translate", "你好", None, None, Some("日文")).expect("翻译"),
        );
        assert!(
            translate[1]
                .content
                .as_deref()
                .expect("消息")
                .contains("翻译成日文")
        );

        let cont = build_messages(
            &WriteRequest::new("continue", "", Some("第一段。"), None, None).expect("续写"),
        );
        assert!(
            cont[1]
                .content
                .as_deref()
                .expect("消息")
                .contains("<上文>\n第一段。\n</上文>")
        );

        let custom = build_messages(
            &WriteRequest::new("custom", "", Some("上文"), Some("写一个结尾"), None)
                .expect("按要求"),
        );
        let text = custom[1].content.as_deref().expect("消息");
        assert!(text.contains("写一个结尾") && text.contains("<上下文>\n上文\n</上下文>"));
    }

    #[test]
    fn output_fences_added_by_the_model_are_removed_but_real_code_blocks_are_kept() {
        assert_eq!(
            clean_output("```markdown\n改好的段落\n```", "原段落"),
            "改好的段落"
        );
        assert_eq!(clean_output("  改好的段落  \n", "原段落"), "改好的段落");
        let code = "```rust\nfn main() {}\n```";
        assert_eq!(clean_output(code, "```rust\nfn main(){}\n```"), code);
    }

    #[test]
    fn purpose_is_recorded_as_write() {
        assert_eq!(Purpose::Write.as_str(), "write");
    }
}
