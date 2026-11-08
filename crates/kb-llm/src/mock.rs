//! 假的 ChatModel:没有 API key 时用它跑通整条链路与测试。
//!
//! 两种用法:
//! - [`MockChatModel::reply`] 固定回一段文本(可断言请求内容);
//! - [`MockChatModel::script`] 按顺序回放一组响应(测工具调用循环、重试等)。

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{ChatRequest, ChatResponse};
use kb_core::ports::ChatModel;

/// 记录下来的请求(测试断言用)。
#[derive(Clone, Debug, PartialEq)]
pub struct RecordedRequest {
    /// 模型名。
    pub model: String,
    /// 最后一条 user 消息。
    pub last_user: Option<String>,
    /// 是否要求 JSON 输出。
    pub json_output: bool,
    /// 工具数。
    pub tools: usize,
}

/// 假模型。
pub struct MockChatModel {
    responses: Mutex<Vec<ChatResponse>>,
    requests: Mutex<Vec<RecordedRequest>>,
    calls: AtomicUsize,
    /// 每次回复前的延迟(测“在途”与取消用)。
    delay: std::time::Duration,
}

impl MockChatModel {
    /// 固定回一段文本。
    pub fn reply(text: impl Into<String>) -> Self {
        let text = text.into();
        Self {
            responses: Mutex::new(vec![ChatResponse {
                message: kb_core::model::ChatMessage {
                    role: "assistant".to_owned(),
                    content: Some(text),
                    tool_calls: Vec::new(),
                    tool_call_id: None,
                },
                input_tokens: 10,
                output_tokens: 5,
                finish_reason: "stop".to_owned(),
            }]),
            requests: Mutex::new(Vec::new()),
            calls: AtomicUsize::new(0),
            delay: std::time::Duration::ZERO,
        }
    }

    /// 每次回复前先等一会儿(测试“提炼进行中”这类在途状态)。
    pub fn with_delay(mut self, delay: std::time::Duration) -> Self {
        self.delay = delay;
        self
    }

    /// 按顺序回放多个响应(用完后重复最后一个)。
    pub fn script(responses: Vec<ChatResponse>) -> Self {
        Self {
            responses: Mutex::new(responses),
            requests: Mutex::new(Vec::new()),
            calls: AtomicUsize::new(0),
            delay: std::time::Duration::ZERO,
        }
    }

    /// 已经调用了几次。
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    /// 收到过的请求。
    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .map(|list| list.clone())
            .unwrap_or_default()
    }
}

#[async_trait]
impl ChatModel for MockChatModel {
    fn id(&self) -> &str {
        "mock"
    }

    /// 分块回调(每 8 个字符一段),便于测试流式行为。
    async fn chat_stream(
        &self,
        request: ChatRequest,
        on_delta: &mut (dyn for<'a> FnMut(&'a str, bool) + Send),
    ) -> Result<ChatResponse> {
        let response = self.chat(request).await?;
        if let Some(content) = response.message.content.clone() {
            let chars: Vec<char> = content.chars().collect();
            for chunk in chars.chunks(8) {
                let piece: String = chunk.iter().collect();
                on_delta(&piece, false);
            }
            on_delta("", true);
        }
        Ok(response)
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        let index = self.calls.fetch_add(1, Ordering::SeqCst);
        if !self.delay.is_zero() {
            tokio::time::sleep(self.delay).await;
        }
        if let Ok(mut requests) = self.requests.lock() {
            requests.push(RecordedRequest {
                model: request.model.clone(),
                last_user: request
                    .messages
                    .iter()
                    .rev()
                    .find(|message| message.role == "user")
                    .and_then(|message| message.content.clone()),
                json_output: request.json_output,
                tools: request.tools.len(),
            });
        }
        let responses = self
            .responses
            .lock()
            .map_err(|_| kb_core::KbError::Internal("mock 响应锁中毒".to_owned()))?;
        let response = responses
            .get(index.min(responses.len().saturating_sub(1)))
            .cloned()
            .ok_or_else(|| kb_core::KbError::Internal("mock 没有配置响应".to_owned()))?;
        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::{ChatMessage, ToolCall};

    fn request(text: &str) -> ChatRequest {
        ChatRequest {
            model: "deepseek-chat".to_owned(),
            messages: vec![ChatMessage {
                role: "user".to_owned(),
                content: Some(text.to_owned()),
                tool_calls: Vec::new(),
                tool_call_id: None,
            }],
            tools: Vec::new(),
            json_output: true,
            thinking: false,
            max_tokens: None,
            temperature: None,
        }
    }

    #[tokio::test]
    async fn reply_records_requests() {
        let model = MockChatModel::reply("好的");
        let response = model.chat(request("你好")).await.expect("调用");
        assert_eq!(response.message.content.as_deref(), Some("好的"));
        assert_eq!(model.calls(), 1);
        let requests = model.requests();
        assert_eq!(requests[0].last_user.as_deref(), Some("你好"));
        assert!(requests[0].json_output);
    }

    #[tokio::test]
    async fn script_replays_in_order() {
        let first = ChatResponse {
            message: ChatMessage {
                role: "assistant".to_owned(),
                content: None,
                tool_calls: vec![ToolCall {
                    id: "c1".to_owned(),
                    name: "search".to_owned(),
                    arguments: serde_json::json!({ "query": "索引" }),
                }],
                tool_call_id: None,
            },
            input_tokens: 1,
            output_tokens: 1,
            finish_reason: "tool_calls".to_owned(),
        };
        let model = MockChatModel::script(vec![
            first,
            MockChatModel::reply("最终答案").responses.lock().unwrap()[0].clone(),
        ]);
        let first_response = model.chat(request("一")).await.expect("第一次");
        assert_eq!(first_response.message.tool_calls.len(), 1);
        let second = model.chat(request("二")).await.expect("第二次");
        assert_eq!(second.message.content.as_deref(), Some("最终答案"));
    }
}
