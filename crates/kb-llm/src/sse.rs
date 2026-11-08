//! SSE 解析:OpenAI 兼容的 `stream: true` 响应。
//!
//! 服务端按行发 `data: {json}` 或 `data: [DONE]`,空行分隔事件;偶尔会有 `: ping` 注释行。
//! 这里只做“把字节流切成事件”的活,JSON 解析留给调用方。

/// 一个 SSE 事件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SseEvent {
    /// `event:` 字段(可空)。
    pub event: Option<String>,
    /// `data:` 字段拼接后的内容。
    pub data: String,
}

/// 流式增量。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StreamDelta {
    /// 一段正文增量。
    Text(String),
    /// 一段思考(reasoning)增量。
    Reasoning(String),
    /// 一个工具调用的增量(按 index 聚合,由调用方拼接)。
    ToolCall {
        /// 序号。
        index: u32,
        /// 调用 id(第一段才有)。
        id: Option<String>,
        /// 函数名(第一段才有)。
        name: Option<String>,
        /// 参数片段。
        arguments: String,
    },
    /// 结束(`finish_reason` 与用量)。
    Done {
        /// 结束原因。
        finish_reason: String,
        /// 输入 token。
        input_tokens: u64,
        /// 输出 token。
        output_tokens: u64,
    },
    /// `[DONE]`。
    Eof,
}

/// 按行解析 SSE 字节流;每次返回“完整事件”(以空行结尾)。
pub fn parse_events(buffer: &str) -> (Vec<SseEvent>, String) {
    let mut events = Vec::new();
    let mut rest = buffer;
    // 事件以空行结束(兼容 \n\n 与 \r\n\r\n)
    while let Some((block, tail)) = split_block(rest) {
        rest = tail;
        let mut event = None;
        let mut data = Vec::new();
        for line in block.lines() {
            let line = line.trim_end_matches('\r');
            if line.is_empty() || line.starts_with(':') {
                continue;
            }
            if let Some(value) = line.strip_prefix("event:") {
                event = Some(value.trim().to_owned());
            } else if let Some(value) = line.strip_prefix("data:") {
                data.push(value.trim_start().to_owned());
            }
        }
        if event.is_some() || !data.is_empty() {
            events.push(SseEvent {
                event,
                data: data.join("\n"),
            });
        }
    }
    (events, rest.to_owned())
}

/// 切出第一个事件块(不含结尾空行),返回(块, 剩余)。
fn split_block(input: &str) -> Option<(&str, &str)> {
    let mut index = 0usize;
    let bytes = input.as_bytes();
    while index + 1 < bytes.len() {
        if bytes[index] == b'\n' && bytes[index + 1] == b'\n' {
            return Some((&input[..index], &input[index + 2..]));
        }
        if index + 3 < bytes.len() && &bytes[index..index + 4] == b"\r\n\r\n" {
            return Some((&input[..index], &input[index + 4..]));
        }
        index += 1;
    }
    None
}

/// 把一个 `data:` 的 JSON 解析成增量。
pub fn delta_of(data: &str) -> Option<StreamDelta> {
    if data.trim() == "[DONE]" {
        return Some(StreamDelta::Eof);
    }
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let choice = value.get("choices")?.get(0)?;
    let delta = choice.get("delta");
    if let Some(reasoning) = delta
        .and_then(|delta| delta.get("reasoning_content"))
        .and_then(serde_json::Value::as_str)
        && !reasoning.is_empty()
    {
        return Some(StreamDelta::Reasoning(reasoning.to_owned()));
    }
    if let Some(text) = delta
        .and_then(|delta| delta.get("content"))
        .and_then(serde_json::Value::as_str)
        && !text.is_empty()
    {
        return Some(StreamDelta::Text(text.to_owned()));
    }
    if let Some(calls) = delta
        .and_then(|delta| delta.get("tool_calls"))
        .and_then(serde_json::Value::as_array)
        && let Some(call) = calls.first()
    {
        return Some(StreamDelta::ToolCall {
            index: call
                .get("index")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0) as u32,
            id: call
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            name: call
                .get("function")
                .and_then(|function| function.get("name"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned),
            arguments: call
                .get("function")
                .and_then(|function| function.get("arguments"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        });
    }
    if let Some(reason) = choice
        .get("finish_reason")
        .and_then(serde_json::Value::as_str)
    {
        let usage = value.get("usage");
        return Some(StreamDelta::Done {
            finish_reason: reason.to_owned(),
            input_tokens: usage
                .and_then(|usage| usage.get("prompt_tokens"))
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
            output_tokens: usage
                .and_then(|usage| usage.get("completion_tokens"))
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(0),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_events_on_blank_lines() {
        let raw = "data: {\"a\":1}\n\ndata: {\"b\":2}\n\n";
        let (events, rest) = parse_events(raw);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data, "{\"a\":1}");
        assert_eq!(rest, "");
    }

    #[test]
    fn keeps_partial_event_in_the_buffer() {
        let raw = "data: {\"a\":1}\n\ndata: {\"b\":";
        let (events, rest) = parse_events(raw);
        assert_eq!(events.len(), 1);
        assert_eq!(rest, "data: {\"b\":");
    }

    #[test]
    fn handles_crlf_and_comments() {
        let raw = ": ping\r\n\r\ndata: [DONE]\r\n\r\n";
        let (events, _) = parse_events(raw);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].data, "[DONE]");
        assert_eq!(delta_of(&events[0].data), Some(StreamDelta::Eof));
    }

    #[test]
    fn parses_text_reasoning_toolcall_and_done() {
        let text = r#"{"choices":[{"delta":{"content":"你好"}}]}"#;
        assert_eq!(delta_of(text), Some(StreamDelta::Text("你好".to_owned())));
        let reasoning = r#"{"choices":[{"delta":{"reasoning_content":"想一下"}}]}"#;
        assert_eq!(
            delta_of(reasoning),
            Some(StreamDelta::Reasoning("想一下".to_owned()))
        );
        let tool = r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search","arguments":"{\"q\":"}}]}}]}"#;
        match delta_of(tool) {
            Some(StreamDelta::ToolCall { id, name, .. }) => {
                assert_eq!(id.as_deref(), Some("c1"));
                assert_eq!(name.as_deref(), Some("search"));
            }
            other => panic!("应是工具调用:{other:?}"),
        }
        let done = r#"{"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}"#;
        assert_eq!(
            delta_of(done),
            Some(StreamDelta::Done {
                finish_reason: "stop".to_owned(),
                input_tokens: 10,
                output_tokens: 3
            })
        );
    }
}
