//! UDS HTTP 客户端:CLI 与 `kb mcp` 通过它调用守护进程（设计规范）。

use std::path::{Path, PathBuf};
use std::time::Duration;

use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper::{Method, Request, StatusCode};
use hyper_util::rt::TokioIo;
use kb_core::{KbError, Result};
use serde_json::Value;

/// 一次能力调用的来源信息。
#[derive(Clone, Debug, Default)]
pub struct CallOptions {
    /// `X-KB-Cwd`。
    pub cwd: Option<String>,
    /// `X-KB-Client`。
    pub client: Option<String>,
    /// `X-KB-Project`。
    pub project: Option<String>,
    /// `X-KB-Source`(mcp / web / agent)。
    pub surface: Option<String>,
    /// `?dry_run=true`(只演练,不落库)。
    pub dry_run: bool,
}

/// 守护进程的 UDS 客户端。
#[derive(Clone, Debug)]
pub struct UdsClient {
    socket: PathBuf,
    timeout: Duration,
    /// `Authorization: Bearer` 的值。`agent.sock` 的会话令牌走这里。
    authorization: Option<String>,
}

impl UdsClient {
    /// 指向 `<KB_HOME>/run/kb.sock`。
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Self {
            socket: socket.into(),
            timeout: Duration::from_secs(120),
            authorization: None,
        }
    }

    /// 带上 Bearer 令牌(ACP 伴生进程连 `agent.sock`)。
    pub fn with_bearer(mut self, token: impl Into<String>) -> Self {
        self.authorization = Some(token.into());
        self
    }

    /// socket 路径。
    pub fn socket(&self) -> &Path {
        &self.socket
    }

    /// 守护进程是否在运行(能连上 socket 就算)。
    pub async fn is_running(&self) -> bool {
        matches!(
            tokio::time::timeout(Duration::from_millis(300), self.connect()).await,
            Ok(Ok(_))
        )
    }

    async fn connect(&self) -> Result<TokioIo<tokio::net::UnixStream>> {
        let stream = tokio::net::UnixStream::connect(&self.socket)
            .await
            .map_err(|err| {
                KbError::Unavailable(format!("连不上守护进程 {}: {err}", self.socket.display()))
            })?;
        Ok(TokioIo::new(stream))
    }

    /// `GET /api/v1/health`。
    pub async fn health(&self) -> Result<Value> {
        self.request(Method::GET, "/api/v1/health", None, &CallOptions::default())
            .await
    }

    /// 列出一个可见面的能力。
    pub async fn capabilities(&self, surface: &str) -> Result<Value> {
        self.request(
            Method::GET,
            &format!("/api/v1/capabilities?surface={surface}"),
            None,
            &CallOptions::default(),
        )
        .await
    }

    /// 通用 `GET`(鉴权管理等非能力接口用),返回完整响应 JSON。
    pub async fn get_json(&self, path: &str) -> Result<Value> {
        self.request(Method::GET, path, None, &CallOptions::default())
            .await
    }

    /// 通用 `POST`,返回完整响应 JSON。
    pub async fn post_json(&self, path: &str, body: Value) -> Result<Value> {
        self.request(Method::POST, path, Some(body), &CallOptions::default())
            .await
    }

    /// 通用 `DELETE`,返回完整响应 JSON。
    pub async fn delete_json(&self, path: &str) -> Result<Value> {
        self.request(Method::DELETE, path, None, &CallOptions::default())
            .await
    }

    /// 调用一个能力,返回 `data` 段。
    pub async fn call(&self, name: &str, args: Value, options: &CallOptions) -> Result<Value> {
        let path = if options.dry_run {
            format!("/api/v1/capabilities/{name}?dry_run=true")
        } else {
            format!("/api/v1/capabilities/{name}")
        };
        let response = self
            .request(Method::POST, &path, Some(args), options)
            .await?;
        response
            .get("data")
            .cloned()
            .ok_or_else(|| KbError::Internal("守护进程的响应缺少 data".to_owned()))
    }

    async fn request(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
        options: &CallOptions,
    ) -> Result<Value> {
        let io = self.connect().await?;
        let (mut sender, connection) = hyper::client::conn::http1::handshake(io)
            .await
            .map_err(|err| KbError::Unavailable(format!("握手失败: {err}")))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });

        let mut builder = Request::builder()
            .method(method)
            .uri(format!("http://localhost{path}"))
            .header("host", "localhost");
        // 头里只能放可见 ASCII:中文路径要百分号编码
        if let Some(cwd) = &options.cwd {
            builder = builder.header("x-kb-cwd", kb_core::pct::encode(cwd));
        }
        if let Some(client) = &options.client {
            builder = builder.header("x-kb-client", kb_core::pct::encode(client));
        }
        if let Some(project) = &options.project {
            builder = builder.header("x-kb-project", kb_core::pct::encode(project));
        }
        if let Some(surface) = &options.surface {
            builder = builder.header("x-kb-source", surface);
        }
        if let Some(token) = &self.authorization {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let request = match body {
            Some(value) => builder
                .header("content-type", "application/json")
                .body(Full::new(Bytes::from(value.to_string())))
                .map_err(|err| KbError::Internal(format!("构造请求失败: {err}")))?,
            None => builder
                .body(Full::new(Bytes::new()))
                .map_err(|err| KbError::Internal(format!("构造请求失败: {err}")))?,
        };
        let response = tokio::time::timeout(self.timeout, sender.send_request(request))
            .await
            .map_err(|_| KbError::Unavailable("守护进程响应超时".to_owned()))?
            .map_err(|err| KbError::Unavailable(format!("请求失败: {err}")))?;
        let status = response.status();
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|err| KbError::Unavailable(format!("读响应失败: {err}")))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|err| KbError::Internal(format!("响应不是合法 JSON: {err}")))?;
        if status != StatusCode::OK {
            let code = value["error"]["code"].as_str().unwrap_or("internal");
            let message = value["error"]["message"]
                .as_str()
                .unwrap_or("守护进程返回错误");
            let message = strip_display_prefix(message, code);
            return Err(match code {
                "not_found" => KbError::NotFound(message.to_owned()),
                "invalid_input" => KbError::InvalidInput(message.to_owned()),
                "forbidden" => KbError::Forbidden(message.to_owned()),
                "unauthorized" => KbError::Unauthorized,
                "unavailable" => KbError::Unavailable(message.to_owned()),
                _ => KbError::Internal(message.to_owned()),
            });
        }
        Ok(value)
    }
}

/// 守护进程的 `message` 里带 `Display` 的前缀(`invalid input: `),这里去掉一层,
/// 避免客户端再包一次造成 `invalid input: invalid input: …`。
fn strip_display_prefix<'a>(message: &'a str, code: &str) -> &'a str {
    let human = match code {
        "not_found" => "not found: ",
        "invalid_input" => "invalid input: ",
        "unavailable" => "unavailable: ",
        "internal" => "internal: ",
        "forbidden" => "forbidden: ",
        _ => return message,
    };
    message.strip_prefix(human).unwrap_or(message)
}
