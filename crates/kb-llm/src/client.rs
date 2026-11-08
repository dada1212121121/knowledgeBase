//! OpenAI 兼容的 Chat Completions 客户端。
//!
//! 自己实现而不引 `genai` / `async-openai`(设计规范明确不引入):
//! - `POST {base_url}/chat/completions`,支持 messages / tools / `tool_choice` /
//!   `response_format: {"type":"json_object"}` / `stream` / DeepSeek 的 thinking 参数;
//! - 超时 120 秒;429 与 5xx 指数退避重试,最多 3 次;
//! - 流式响应走 [`crate::sse`] 的增量解析。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use kb_core::model::{ChatMessage, ChatRequest, ChatResponse, ToolCall};
use kb_core::ports::ChatModel;
use kb_core::{KbError, Result};
use serde_json::{Value, json};

use crate::sse::{StreamDelta, delta_of, parse_events};

/// 客户端配置。
#[derive(Clone, Debug)]
pub struct LlmClientConfig {
    /// `https://api.deepseek.com/v1` 这类前缀(不带尾斜杠)。
    pub base_url: String,
    /// API key。
    pub api_key: String,
    /// 服务商侧的模型名(例如 `deepseek-v4.1-flash`);空 = 由调用方在 `ChatRequest.model` 里给。
    pub model: String,
    /// 超时(默认 120 秒)。
    pub timeout: Duration,
    /// 最大重试次数(默认 3)。
    pub max_retries: u32,
}

impl LlmClientConfig {
    /// 指定模型名(会作为 `id` 与请求里的 `model` 字段)。
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = model.into();
        self
    }

    /// 构造(默认超时 120 秒、重试 3 次)。
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            api_key: api_key.into(),
            model: String::new(),
            timeout: Duration::from_secs(120),
            max_retries: 3,
        }
    }
}

/// OpenAI 兼容客户端。
pub struct OpenAiClient {
    config: LlmClientConfig,
    client: reqwest::Client,
}

impl OpenAiClient {
    /// 构造。
    pub fn new(config: LlmClientConfig) -> Result<Self> {
        let client = reqwest::Client::builder()
            .timeout(config.timeout)
            // 带一个明确的 UA:部分网关(Cloudflare 等)会直接 403 掉没有 UA 的客户端
            .user_agent(concat!("kb/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|err| KbError::Internal(format!("构造 HTTP 客户端失败: {err}")))?;
        Ok(Self { config, client })
    }

    /// 组装请求体(抽出来单独测试:字段名必须与 OpenAI 兼容服务一致)。
    pub fn body_of(&self, request: &ChatRequest, stream: bool) -> Value {
        let messages: Vec<Value> = request.messages.iter().map(message_json).collect();
        let mut body = json!({
            "model": request.model,
            "messages": messages,
            "stream": stream,
        });
        if !request.tools.is_empty() {
            body["tools"] = json!(
                request
                    .tools
                    .iter()
                    .map(|tool| json!({
                        "type": "function",
                        "function": {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                    }))
                    .collect::<Vec<_>>()
            );
            body["tool_choice"] = json!("auto");
        }
        if request.json_output {
            body["response_format"] = json!({ "type": "json_object" });
        }
        if request.thinking {
            // DeepSeek 的思考开关(其它兼容服务会忽略未知字段)
            body["thinking"] = json!({ "type": "enabled" });
        }
        if let Some(max_tokens) = request.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        if let Some(temperature) = request.temperature {
            body["temperature"] = json!(temperature);
        }
        body
    }

    /// 一次非流式调用(带重试)。
    async fn post_chat(&self, body: Value) -> Result<Value> {
        let url = format!("{}/chat/completions", self.config.base_url);
        let mut attempt = 0u32;
        loop {
            let response = self
                .client
                .post(&url)
                .bearer_auth(&self.config.api_key)
                .json(&body)
                .send()
                .await;
            let retryable = match &response {
                Ok(response) => {
                    response.status().as_u16() == 429 || response.status().is_server_error()
                }
                Err(err) => err.is_timeout() || err.is_connect(),
            };
            match response {
                Ok(response) if response.status().is_success() => {
                    return response
                        .json::<Value>()
                        .await
                        .map_err(|err| KbError::Upstream(format!("解析响应失败: {err}")));
                }
                Ok(response) => {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_default();
                    if retryable && attempt < self.config.max_retries {
                        attempt += 1;
                        sleep_backoff(attempt).await;
                        continue;
                    }
                    return Err(match status.as_u16() {
                        401 | 403 => KbError::Forbidden(format!("LLM 鉴权失败: {text}")),
                        429 => KbError::Unavailable(format!("LLM 限流:{text}")),
                        _ => KbError::Upstream(format!("LLM 返回 {status}:{text}")),
                    });
                }
                Err(err) => {
                    if retryable && attempt < self.config.max_retries {
                        attempt += 1;
                        sleep_backoff(attempt).await;
                        continue;
                    }
                    return Err(KbError::Upstream(format!("调用 LLM 失败: {err}")));
                }
            }
        }
    }

    /// 流式调用:把增量通过回调发出去,返回最终的完整响应。
    pub async fn chat_stream(
        &self,
        request: ChatRequest,
        mut on_delta: impl FnMut(StreamDelta) + Send,
    ) -> Result<ChatResponse> {
        let url = format!("{}/chat/completions", self.config.base_url);
        let body = self.body_of(&request, true);
        let mut response = self
            .client
            .post(&url)
            .bearer_auth(&self.config.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|err| KbError::Upstream(format!("调用 LLM 失败: {err}")))?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            return Err(KbError::Upstream(format!("LLM 返回 {status}:{text}")));
        }

        let mut content = String::new();
        let mut finish_reason = String::new();
        let mut input_tokens = 0u64;
        let mut output_tokens = 0u64;
        let mut buffer = String::new();
        // 工具调用的增量按 index 聚合(第一段才有 id / name,后面都是参数片段)
        let mut tool_calls: std::collections::BTreeMap<u32, (String, String, String)> =
            std::collections::BTreeMap::new();
        loop {
            let chunk = response
                .chunk()
                .await
                .map_err(|err| KbError::Upstream(format!("读取流失败: {err}")))?;
            let Some(chunk) = chunk else { break };
            buffer.push_str(&String::from_utf8_lossy(&chunk));
            let (events, rest) = parse_events(&buffer);
            buffer = rest;
            for event in events {
                match delta_of(&event.data) {
                    Some(StreamDelta::Eof) => {
                        return Ok(finish_stream(
                            content,
                            finish_reason,
                            input_tokens,
                            output_tokens,
                            tool_calls,
                        ));
                    }
                    Some(StreamDelta::Text(text)) => {
                        content.push_str(&text);
                        on_delta(StreamDelta::Text(text));
                    }
                    Some(StreamDelta::Reasoning(text)) => on_delta(StreamDelta::Reasoning(text)),
                    Some(StreamDelta::ToolCall {
                        index,
                        id,
                        name,
                        arguments,
                    }) => {
                        let entry = tool_calls.entry(index).or_default();
                        // 有的服务商在后续分片里把 id / name 发成空串(参数分片常见),
                        // 不能拿空串覆盖第一段拿到的真名。
                        if let Some(id) = id.clone().filter(|value| !value.is_empty()) {
                            entry.0 = id;
                        }
                        if let Some(name) = name.clone().filter(|value| !value.is_empty()) {
                            entry.1 = name;
                        }
                        entry.2.push_str(&arguments);
                        on_delta(StreamDelta::ToolCall {
                            index,
                            id,
                            name,
                            arguments,
                        });
                    }
                    Some(StreamDelta::Done {
                        finish_reason: reason,
                        input_tokens: input,
                        output_tokens: output,
                    }) => {
                        finish_reason = reason;
                        input_tokens = input;
                        output_tokens = output;
                    }
                    None => {}
                }
            }
        }
        // 流里什么有效内容都没有(有些网关只回 `: keep-alive` 或者干脆不支持 stream):
        // 退回一次非流式调用,别把空回复当成“模型没话说”。
        if content.is_empty() && tool_calls.is_empty() && finish_reason.is_empty() {
            let value = self.post_chat(self.body_of(&request, false)).await?;
            let response = parse_response(&value)?;
            if let Some(text) = &response.message.content
                && !text.is_empty()
            {
                on_delta(StreamDelta::Text(text.clone()));
            }
            return Ok(response);
        }
        Ok(finish_stream(
            content,
            finish_reason,
            input_tokens,
            output_tokens,
            tool_calls,
        ))
    }
}

#[async_trait]
impl ChatModel for OpenAiClient {
    fn id(&self) -> &str {
        // 配置了模型名就用它:请求体、用量统计与日志里都应该是真实模型名,
        // 而不是客户端类型 "openai-compatible"。
        if self.config.model.is_empty() {
            "openai-compatible"
        } else {
            &self.config.model
        }
    }

    /// 真流式:边读 SSE 边把正文增量回调出去(工具调用增量只影响最终结果)。
    async fn chat_stream(
        &self,
        request: ChatRequest,
        on_delta: &mut (dyn for<'a> FnMut(&'a str, bool) + Send),
    ) -> Result<ChatResponse> {
        let response = OpenAiClient::chat_stream(self, request, |delta| {
            if let StreamDelta::Text(text) = delta {
                on_delta(&text, false);
            }
        })
        .await?;
        on_delta("", true);
        Ok(response)
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        let body = self.body_of(&request, false);
        let value = self.post_chat(body).await?;
        parse_response(&value)
    }
}

/// 消息 → 请求 JSON。
fn message_json(message: &ChatMessage) -> Value {
    let mut value = json!({ "role": message.role });
    if let Some(content) = &message.content {
        value["content"] = json!(content);
    }
    if !message.tool_calls.is_empty() {
        value["tool_calls"] = json!(
            message
                .tool_calls
                .iter()
                .map(|call| json!({
                    "id": call.id,
                    "type": "function",
                    "function": {
                        "name": call.name,
                        "arguments": call.arguments.to_string(),
                    }
                }))
                .collect::<Vec<_>>()
        );
    }
    if let Some(id) = &message.tool_call_id {
        value["tool_call_id"] = json!(id);
    }
    value
}

/// 响应 JSON → [`ChatResponse`]。
pub fn parse_response(value: &Value) -> Result<ChatResponse> {
    let choice = value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .ok_or_else(|| KbError::Upstream("响应里没有 choices".to_owned()))?;
    let message = choice.get("message");
    let content = message
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut tool_calls = Vec::new();
    if let Some(calls) = message
        .and_then(|message| message.get("tool_calls"))
        .and_then(Value::as_array)
    {
        for call in calls {
            let function = call.get("function");
            let arguments = function
                .and_then(|function| function.get("arguments"))
                .and_then(Value::as_str)
                .unwrap_or("{}");
            tool_calls.push(ToolCall {
                id: call
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                name: function
                    .and_then(|function| function.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                // 参数是 JSON 字符串,解析失败时保留原文便于排查
                arguments: serde_json::from_str(arguments).unwrap_or_else(|_| json!(arguments)),
            });
        }
    }
    let usage = value.get("usage");
    Ok(ChatResponse {
        message: ChatMessage {
            role: "assistant".to_owned(),
            content,
            tool_calls,
            tool_call_id: None,
        },
        input_tokens: usage
            .and_then(|usage| usage.get("prompt_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: usage
            .and_then(|usage| usage.get("completion_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        finish_reason: choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .unwrap_or("stop")
            .to_owned(),
    })
}

fn finish_stream(
    content: String,
    finish_reason: String,
    input: u64,
    output: u64,
    tool_calls: std::collections::BTreeMap<u32, (String, String, String)>,
) -> ChatResponse {
    let calls = tool_calls
        .into_values()
        .map(|(id, name, arguments)| ToolCall {
            id,
            name,
            arguments: serde_json::from_str(&arguments)
                .unwrap_or_else(|_| serde_json::json!({ "raw": arguments })),
        })
        .collect();
    ChatResponse {
        message: ChatMessage {
            role: "assistant".to_owned(),
            content: if content.is_empty() {
                None
            } else {
                Some(content)
            },
            tool_calls: calls,
            tool_call_id: None,
        },
        input_tokens: input,
        output_tokens: output,
        finish_reason: if finish_reason.is_empty() {
            "stop".to_owned()
        } else {
            finish_reason
        },
    }
}

/// 指数退避:200ms、400ms、800ms(最多 3 次)。
async fn sleep_backoff(attempt: u32) {
    let millis = 200u64.saturating_mul(1u64 << attempt.min(4));
    tokio::time::sleep(Duration::from_millis(millis)).await;
}

/// 共享指针包装,便于服务层持有 `Arc<dyn ChatModel>`。
pub type SharedChatModel = Arc<dyn ChatModel>;

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::ToolSpec;

    fn request() -> ChatRequest {
        ChatRequest {
            model: "deepseek-chat".to_owned(),
            messages: vec![
                ChatMessage {
                    role: "system".to_owned(),
                    content: Some("你是知识库助手".to_owned()),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                },
                ChatMessage {
                    role: "user".to_owned(),
                    content: Some("查一下双哈希增量索引".to_owned()),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                },
            ],
            tools: vec![ToolSpec {
                name: "search".to_owned(),
                description: "检索知识库".to_owned(),
                parameters: json!({ "type": "object", "properties": { "query": { "type": "string" } } }),
            }],
            json_output: true,
            thinking: true,
            max_tokens: Some(512),
            temperature: Some(0.2),
        }
    }

    #[test]
    fn request_body_matches_openai_shape() {
        let client = OpenAiClient::new(LlmClientConfig::new("https://api.example.com/v1", "k"))
            .expect("客户端");
        let body = client.body_of(&request(), false);
        assert_eq!(body["model"], "deepseek-chat");
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(body["tools"][0]["type"], "function");
        assert_eq!(body["tools"][0]["function"]["name"], "search");
        assert_eq!(body["tool_choice"], "auto");
        assert_eq!(body["response_format"]["type"], "json_object");
        assert_eq!(body["thinking"]["type"], "enabled");
        assert_eq!(body["max_tokens"], 512);
    }

    #[test]
    fn parses_content_tool_calls_and_usage() {
        let value = json!({
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": null,
                    "tool_calls": [{
                        "id": "call_1",
                        "function": { "name": "search", "arguments": "{\"query\":\"索引\"}" }
                    }]
                },
                "finish_reason": "tool_calls"
            }],
            "usage": { "prompt_tokens": 120, "completion_tokens": 15 }
        });
        let response = parse_response(&value).expect("解析");
        assert_eq!(response.finish_reason, "tool_calls");
        assert_eq!(response.input_tokens, 120);
        assert_eq!(response.output_tokens, 15);
        assert_eq!(response.message.tool_calls.len(), 1);
        assert_eq!(response.message.tool_calls[0].name, "search");
        assert_eq!(response.message.tool_calls[0].arguments["query"], "索引");
    }

    #[test]
    fn tool_message_serialises_the_call_id() {
        let message = ChatMessage {
            role: "tool".to_owned(),
            content: Some("结果".to_owned()),
            tool_calls: Vec::new(),
            tool_call_id: Some("call_1".to_owned()),
        };
        let value = message_json(&message);
        assert_eq!(value["tool_call_id"], "call_1");
        assert_eq!(value["role"], "tool");
    }

    #[test]
    fn missing_choices_is_an_upstream_error() {
        let error = parse_response(&json!({})).expect_err("应报错");
        assert!(matches!(error, KbError::Upstream(_)), "{error}");
    }
}

#[cfg(test)]
mod model_name_tests {
    use super::*;

    #[test]
    fn client_id_is_the_configured_model_name() {
        let client = OpenAiClient::new(
            LlmClientConfig::new("https://api.example.com/v1", "k")
                .with_model("deepseek-v4.1-flash"),
        )
        .expect("客户端");
        assert_eq!(client.id(), "deepseek-v4.1-flash");
        let plain = OpenAiClient::new(LlmClientConfig::new("https://api.example.com/v1", "k"))
            .expect("客户端");
        assert_eq!(plain.id(), "openai-compatible");
    }
}
