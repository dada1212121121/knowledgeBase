//! 验收:真实 HTTP 往返(本地假服务),覆盖请求形状、429 重试、SSE 流式。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use kb_core::model::{ChatMessage, ChatRequest};
use kb_core::ports::ChatModel;
use kb_llm::client::{LlmClientConfig, OpenAiClient};
use kb_llm::sse::StreamDelta;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// 一个按脚本回应的假 OpenAI 服务。
async fn serve(
    responses: Vec<String>,
) -> (String, Arc<AtomicUsize>, Arc<std::sync::Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定");
    let port = listener.local_addr().expect("地址").port();
    let calls = Arc::new(AtomicUsize::new(0));
    let bodies = Arc::new(std::sync::Mutex::new(Vec::new()));
    let responses = Arc::new(responses);
    let calls_for_task = calls.clone();
    let bodies_for_task = bodies.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let responses = responses.clone();
            let calls = calls_for_task.clone();
            let bodies = bodies_for_task.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 65536];
                let read = socket.read(&mut buffer).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                // 记录请求体(头与体之间是空行)
                if let Some((_, body)) = request.split_once("\r\n\r\n")
                    && let Ok(mut bodies) = bodies.lock()
                {
                    bodies.push(body.to_owned());
                }
                let index = calls.fetch_add(1, Ordering::SeqCst);
                let response = responses
                    .get(index.min(responses.len().saturating_sub(1)))
                    .cloned()
                    .unwrap_or_default();
                let _ = socket.write_all(response.as_bytes()).await;
                let _ = socket.flush().await;
            });
        }
    });
    (format!("http://127.0.0.1:{port}"), calls, bodies)
}

fn ok_json(content: &str) -> String {
    let body = serde_json::json!({
        "choices": [{
            "message": { "role": "assistant", "content": content },
            "finish_reason": "stop"
        }],
        "usage": { "prompt_tokens": 11, "completion_tokens": 4 }
    })
    .to_string();
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn status(code: u16, text: &str) -> String {
    format!(
        "HTTP/1.1 {code} Error\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{text}",
        text.len()
    )
}

fn request() -> ChatRequest {
    ChatRequest {
        model: "deepseek-chat".to_owned(),
        messages: vec![ChatMessage {
            role: "user".to_owned(),
            content: Some("你好".to_owned()),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }],
        tools: Vec::new(),
        json_output: false,
        thinking: false,
        max_tokens: Some(64),
        temperature: None,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sends_an_openai_compatible_request_and_parses_the_reply() {
    let (base, calls, bodies) = serve(vec![ok_json("你好,我是知识库助手")]).await;
    let client = OpenAiClient::new(LlmClientConfig::new(base, "test-key")).expect("客户端");
    let response = client.chat(request()).await.expect("调用");
    assert_eq!(
        response.message.content.as_deref(),
        Some("你好,我是知识库助手")
    );
    assert_eq!(response.input_tokens, 11);
    assert_eq!(response.output_tokens, 4);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let body = bodies.lock().expect("读请求体")[0].clone();
    let value: serde_json::Value = serde_json::from_str(&body).expect("请求体是 JSON");
    assert_eq!(value["model"], "deepseek-chat");
    assert_eq!(value["stream"], false);
    assert_eq!(value["max_tokens"], 64);
    assert_eq!(value["messages"][0]["role"], "user");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn retries_on_429_then_succeeds() {
    let (base, calls, _bodies) =
        serve(vec![status(429, "rate limited"), ok_json("重试之后成功")]).await;
    let client = OpenAiClient::new(LlmClientConfig::new(base, "k")).expect("客户端");
    let response = client.chat(request()).await.expect("调用");
    assert_eq!(response.message.content.as_deref(), Some("重试之后成功"));
    assert_eq!(calls.load(Ordering::SeqCst), 2, "429 之后应重试一次");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn auth_failure_is_forbidden_not_retried() {
    let (base, calls, _bodies) = serve(vec![status(401, "bad key")]).await;
    let client = OpenAiClient::new(LlmClientConfig::new(base, "k")).expect("客户端");
    let error = client.chat(request()).await.expect_err("应报鉴权失败");
    assert!(matches!(error, kb_core::KbError::Forbidden(_)), "{error}");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "401 不应重试");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn streams_sse_deltas() {
    let sse = "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n\
               data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n\
               data: {\"choices\":[{\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":2}}\n\n\
               data: [DONE]\n\n";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}",
        sse.len()
    );
    let (base, _calls, _bodies) = serve(vec![response]).await;
    let client = OpenAiClient::new(LlmClientConfig::new(base, "k")).expect("客户端");
    let mut deltas = Vec::new();
    let result = client
        .chat_stream(request(), |delta| deltas.push(delta))
        .await
        .expect("流式调用");
    assert_eq!(result.message.content.as_deref(), Some("你好"));
    assert_eq!(result.finish_reason, "stop");
    assert_eq!(result.input_tokens, 5);
    assert!(deltas.contains(&StreamDelta::Text("你".to_owned())));
    assert!(deltas.contains(&StreamDelta::Text("好".to_owned())));
}

/// 流式返回的工具调用要聚合进最终响应(以前只推给 on_delta,agent 拿不到 tool_calls)。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn streaming_tool_calls_are_accumulated_into_the_response() {
    let sse = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"search_knowledge\",\"arguments\":\"{\\\"que\"}}]}}]}\n\n\
               data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"ry\\\":\\\"x\\\"}\"}}]}}]}\n\n\
               data: {\"choices\":[{\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\n\
               data: [DONE]\n\n";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}",
        sse.len()
    );
    let (base, _calls, _bodies) = serve(vec![response]).await;
    let client = OpenAiClient::new(LlmClientConfig::new(base, "k")).expect("客户端");
    let result = client
        .chat_stream(request(), |_| {})
        .await
        .expect("流式调用");
    assert_eq!(result.message.tool_calls.len(), 1, "{result:?}");
    let call = &result.message.tool_calls[0];
    assert_eq!(call.id, "call_1");
    assert_eq!(call.name, "search_knowledge");
    assert_eq!(call.arguments["query"], "x");
    assert_eq!(result.finish_reason, "tool_calls");
}

/// 网关只回 `: keep-alive`(不支持 stream)时要退回非流式,不能把空回复当成功。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_stream_falls_back_to_a_non_streaming_call() {
    let keep_alive = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 14\r\nConnection: close\r\n\r\n: keep-alive\n\n";
    let (base, calls, bodies) = serve(vec![keep_alive.to_owned(), ok_json("回退成功")]).await;
    let client = OpenAiClient::new(LlmClientConfig::new(base, "k")).expect("客户端");
    let result = client
        .chat_stream(request(), |_| {})
        .await
        .expect("流式调用");
    assert_eq!(result.message.content.as_deref(), Some("回退成功"));
    assert_eq!(calls.load(Ordering::SeqCst), 2, "应再发一次非流式请求");
    let second: serde_json::Value =
        serde_json::from_str(&bodies.lock().expect("读请求体")[1]).expect("请求体是 JSON");
    assert_eq!(second["stream"], false, "回退的请求必须是非流式");
}

/// 没有 User-Agent 的客户端会被部分网关(Cloudflare)直接 403。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sends_a_user_agent_header() {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("绑定");
    let port = listener.local_addr().expect("地址").port();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.expect("连接");
        let mut buffer = vec![0u8; 65536];
        let read = socket.read(&mut buffer).await.unwrap_or(0);
        let raw = String::from_utf8_lossy(&buffer[..read]).into_owned();
        let _ = socket.write_all(ok_json("ok").as_bytes()).await;
        let _ = tx.send(raw);
    });
    let client = OpenAiClient::new(LlmClientConfig::new(
        format!("http://127.0.0.1:{port}"),
        "k",
    ))
    .expect("客户端");
    client.chat(request()).await.expect("调用");
    let raw = rx.await.expect("请求");
    assert!(
        raw.to_ascii_lowercase().contains("user-agent: kb/"),
        "请求应带 User-Agent:{raw}"
    );
}

/// 工具调用的名字只在第一段出现,后续分片带 `name: ""` 时不能覆盖。
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn empty_name_fragments_do_not_overwrite_the_tool_name() {
    let sse = "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"list_projects\",\"arguments\":\"\"}}]}}]}\n\n\
               data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"\",\"arguments\":\"{}\"}}]}}]}\n\n\
               data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"finish_reason\":\"tool_calls\"}]}\n\n\
               data: [DONE]\n\n";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{sse}",
        sse.len()
    );
    let (base, _calls, _bodies) = serve(vec![response]).await;
    let client = OpenAiClient::new(LlmClientConfig::new(base, "k")).expect("客户端");
    let result = client
        .chat_stream(request(), |_| {})
        .await
        .expect("流式调用");
    assert_eq!(result.message.tool_calls.len(), 1, "{result:?}");
    assert_eq!(result.message.tool_calls[0].name, "list_projects");
    assert_eq!(
        result.message.tool_calls[0].arguments,
        serde_json::json!({})
    );
}
