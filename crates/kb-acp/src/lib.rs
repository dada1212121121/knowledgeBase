//! ACP(Agent Client Protocol)客户端。
//!
//! 把外部编码代理(claude-agent-acp / codex-acp / deepseek-acp / gemini --acp …)当子进程拉起,
//! 走 stdio 的 JSON-RPC 说话:initialize → session/new → session/prompt,过程中的
//! `session/update` 增量(正文、思考、工具调用、计划、**上下文压缩**)逐条回调出来。
//!
//! 权限策略:代理要执行工具时会发 `session/request_permission`。这里按
//! [`PermissionPolicy`] 自动答复。`acp.toml` 的默认是 `none`(一律拒绝,交给界面确认);
//! 设成 `read` 才只放行读 / 搜 / 取,设成 `all` 才一律放行。

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::time::Duration;

use agent_client_protocol::schema::ProtocolVersion;
use agent_client_protocol::schema::v1::{
    CancelNotification, ContentBlock, EnvVariable, InitializeRequest, LoadSessionRequest,
    McpServer, McpServerStdio, NewSessionRequest, PermissionOptionKind, PromptRequest,
    RequestPermissionOutcome, RequestPermissionRequest, RequestPermissionResponse,
    SelectedPermissionOutcome, SessionId, SessionNotification, SessionUpdate, TextContent,
    ToolKind,
};
use agent_client_protocol::{
    AcpAgent, Agent, Client, ConnectionTo, Responder, on_receive_notification, on_receive_request,
};
use std::sync::Arc;

use kb_core::{KbError, Result};
use tokio::sync::{mpsc, oneshot};

pub mod sandbox;

/// 一个 ACP 代理的启动方式。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentSpec {
    /// 稳定 id(例如 `claude` / `codex` / 自定义 id)。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// 可执行文件(或 PATH 上的命令名)。
    pub command: String,
    /// 命令行参数。
    pub args: Vec<String>,
    /// 额外环境变量。
    pub env: BTreeMap<String, String>,
}

impl AgentSpec {
    /// 最简构造。
    pub fn new(id: impl Into<String>, name: impl Into<String>, command: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            command: command.into(),
            args: Vec::new(),
            env: BTreeMap::new(),
        }
    }

    /// 拼成 `AcpAgent::from_args` 需要的参数列表(先环境变量,再命令与参数)。
    fn launch_args(&self) -> Vec<String> {
        let mut out: Vec<String> = self
            .env
            .iter()
            .map(|(key, value)| format!("{key}={value}"))
            .collect();
        out.push(self.command.clone());
        out.extend(self.args.iter().cloned());
        out
    }
}

/// 代理请求执行工具时,客户端的自动答复策略。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PermissionPolicy {
    /// 一律拒绝(最安全)。
    Deny,
    /// 只放行读 / 搜 / 取,写与执行拒绝(默认)。
    ReadOnly,
    /// 一律放行(信任这个代理)。
    AllowAll,
}

impl PermissionPolicy {
    /// 从设置里的字符串解析。
    pub fn parse(value: &str) -> Self {
        match value {
            "all" | "allow_all" => Self::AllowAll,
            "none" | "deny" => Self::Deny,
            _ => Self::ReadOnly,
        }
    }
}

/// 一个 MCP server(ACP 会把它的工具交给代理用)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerSpec {
    /// 展示名。
    pub name: String,
    /// 可执行文件(绝对路径)。
    pub command: PathBuf,
    /// 参数。
    pub args: Vec<String>,
    /// 环境变量。
    pub env: Vec<(String, String)>,
}

impl McpServerSpec {
    fn into_schema(self) -> McpServer {
        McpServer::Stdio(
            McpServerStdio::new(self.name, self.command)
                .args(self.args)
                .env(
                    self.env
                        .into_iter()
                        .map(|(name, value)| EnvVariable::new(name, value))
                        .collect(),
                ),
        )
    }
}

/// 权限请求里的一个可选项。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionChoice {
    /// 选项 id。
    pub id: String,
    /// 展示名。
    pub name: String,
    /// `allow_once` / `allow_always` / `reject_once` / `reject_always`。
    pub kind: String,
}

/// 初始化成功后拿到的代理信息。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AgentInfo {
    /// 代理名(例如 `claude-code-acp`)。
    pub name: String,
    /// 代理版本。
    pub version: String,
    /// 协商出来的协议版本。
    pub protocol_version: String,
    /// 代理是否支持 `session/load`(断点续聊)。
    pub load_session: bool,
}

/// 一条来自代理的增量事件。
#[derive(Clone, Debug)]
pub enum AcpEvent {
    /// `session/update`(正文 / 思考 / 工具调用 / 计划 / 压缩 / 用量 …)。
    Update {
        /// 会话 id。
        session_id: String,
        /// 具体更新。
        update: Box<SessionUpdate>,
    },
    /// 一次权限请求的自动答复(给审计 / UI 展示)。
    Permission {
        /// 会话 id。
        session_id: String,
        /// 工具标题。
        tool: String,
        /// 是否放行。
        allowed: bool,
        /// 被自动拒绝时的原因(超出工作目录 / 不允许执行命令 …)。
        reason: Option<String>,
    },
    /// 代理请求执行工具,等界面决定(超时后按策略自动答复)。
    PermissionRequest {
        /// 会话 id。
        session_id: String,
        /// 请求 id(答复时用)。
        request_id: String,
        /// 工具标题。
        tool: String,
        /// 可选项。
        options: Vec<PermissionChoice>,
    },
    /// 这一轮 `session/prompt` 的响应已经到了。增量通道在它之前的更新都已入队。
    TurnFinished {
        /// 会话 id。
        session_id: String,
    },
}

/// 一轮 prompt 的结束方式。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptOutcome {
    /// `end_turn` / `max_tokens` / `refusal` / `cancelled` …
    pub stop_reason: String,
}

enum Command {
    NewSession {
        cwd: PathBuf,
        mcp_servers: Vec<McpServerSpec>,
        respond: oneshot::Sender<Result<String>>,
    },
    LoadSession {
        session_id: String,
        cwd: PathBuf,
        mcp_servers: Vec<McpServerSpec>,
        respond: oneshot::Sender<Result<()>>,
    },
    Prompt {
        session_id: String,
        text: String,
        respond: oneshot::Sender<Result<PromptOutcome>>,
    },
    Cancel {
        session_id: String,
    },
    Shutdown,
}

/// 一个活着的 ACP 代理连接。
pub struct AcpClient {
    tx: mpsc::Sender<Command>,
    /// 代理推过来的增量(可以 `take_events` 拿走,交给推送任务消费)。
    events: Option<mpsc::Receiver<AcpEvent>>,
    /// 代理信息。
    pub info: AgentInfo,
    /// 待界面答复的权限请求。
    pending: Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<bool>>>>,
    task: tokio::task::JoinHandle<()>,
}

impl AcpClient {
    /// 拉起代理并完成 `initialize`。
    ///
    /// `scope`:允许代理读写的根目录(项目根目录 / 专用工作目录)。给了 scope 之后:
    /// 工具调用报告的文件路径只要不在它下面,就直接拒绝;命令执行默认也拒绝(策略为 all 时除外)。
    pub async fn spawn(
        spec: AgentSpec,
        policy: PermissionPolicy,
        scope: Option<PathBuf>,
    ) -> Result<Self> {
        let agent = AcpAgent::from_args(spec.launch_args())
            .map_err(|err| KbError::InvalidInput(format!("启动 ACP 代理失败: {err}")))?;
        let (cmd_tx, mut cmd_rx) = mpsc::channel::<Command>(8);
        let (event_tx, event_rx) = mpsc::channel::<AcpEvent>(512);
        let (info_tx, info_rx) = oneshot::channel::<AgentInfo>();

        let pending: Arc<tokio::sync::Mutex<HashMap<String, oneshot::Sender<bool>>>> =
            Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let event_tx_notify = event_tx.clone();
        let event_tx_turn = event_tx.clone();
        let event_tx_perm = event_tx;
        let pending_for_task = pending.clone();
        let task = tokio::spawn(async move {
            let builder = Client
                .builder()
                .name("knowledgeBase")
                .on_receive_notification(
                    move |notification: SessionNotification, _cx| {
                        let tx = event_tx_notify.clone();
                        async move {
                            let _ = tx
                                .send(AcpEvent::Update {
                                    session_id: notification.session_id.0.to_string(),
                                    update: Box::new(notification.update),
                                })
                                .await;
                            Ok(())
                        }
                    },
                    on_receive_notification!(),
                )
                .on_receive_request(
                    {
                        let pending = pending_for_task.clone();
                        move |request: RequestPermissionRequest,
                              responder: Responder<RequestPermissionResponse>,
                              _cx| {
                            let tx = event_tx_perm.clone();
                            let pending = pending.clone();
                            let scope = scope.clone();
                            async move {
                                let kind = request.tool_call.fields.kind.unwrap_or(ToolKind::Other);
                                let title = request
                                    .tool_call
                                    .fields
                                    .title
                                    .clone()
                                    .unwrap_or_else(|| format!("{kind:?}"));
                                let fallback = match policy {
                                    PermissionPolicy::AllowAll => true,
                                    PermissionPolicy::Deny => false,
                                    PermissionPolicy::ReadOnly => {
                                        matches!(
                                            kind,
                                            ToolKind::Read | ToolKind::Search | ToolKind::Fetch
                                        )
                                    }
                                };
                                // 越界 / 执行命令:不问界面,直接拒绝
                                let outside =
                                    request.tool_call.fields.locations.as_ref().is_some_and(
                                        |locations| {
                                            locations.iter().any(|location| {
                                                !scope.as_ref().is_some_and(|root| {
                                                    sandbox::path_within(&location.path, root)
                                                })
                                            })
                                        },
                                    );
                                let blocked = outside
                                    || (kind == ToolKind::Execute
                                        && !matches!(policy, PermissionPolicy::AllowAll));
                                if blocked {
                                    let reason = if outside {
                                        "文件不在项目/工作目录内"
                                    } else {
                                        "默认不允许执行命令"
                                    };
                                    let _ = tx
                                        .send(AcpEvent::Permission {
                                            session_id: request.session_id.0.to_string(),
                                            tool: title,
                                            allowed: false,
                                            reason: Some(reason.to_owned()),
                                        })
                                        .await;
                                    let _ = responder.respond(RequestPermissionResponse::new(
                                        RequestPermissionOutcome::Cancelled,
                                    ));
                                    return Ok(());
                                }
                                let request_id = uuid_like();
                                let (decide_tx, decide_rx) = oneshot::channel::<bool>();
                                pending.lock().await.insert(request_id.clone(), decide_tx);
                                let options: Vec<PermissionChoice> = request
                                    .options
                                    .iter()
                                    .map(|option| PermissionChoice {
                                        id: option.option_id.0.to_string(),
                                        name: option.name.clone(),
                                        kind: match option.kind {
                                            PermissionOptionKind::AllowOnce => "allow_once",
                                            PermissionOptionKind::AllowAlways => "allow_always",
                                            PermissionOptionKind::RejectOnce => "reject_once",
                                            PermissionOptionKind::RejectAlways => "reject_always",
                                            _ => "other",
                                        }
                                        .to_owned(),
                                    })
                                    .collect();
                                let _ = tx
                                    .send(AcpEvent::PermissionRequest {
                                        session_id: request.session_id.0.to_string(),
                                        request_id: request_id.clone(),
                                        tool: title.clone(),
                                        options,
                                    })
                                    .await;
                                // 等界面答复(120 秒);没人答就按策略兜底
                                let allowed =
                                    tokio::time::timeout(Duration::from_secs(120), decide_rx)
                                        .await
                                        .ok()
                                        .and_then(|result| result.ok())
                                        .unwrap_or(fallback);
                                pending.lock().await.remove(&request_id);
                                let _ = tx
                                    .send(AcpEvent::Permission {
                                        session_id: request.session_id.0.to_string(),
                                        tool: title,
                                        allowed,
                                        reason: None,
                                    })
                                    .await;
                                let choice = request.options.iter().find(|option| {
                                    if allowed {
                                        matches!(
                                            option.kind,
                                            PermissionOptionKind::AllowOnce
                                                | PermissionOptionKind::AllowAlways
                                        )
                                    } else {
                                        matches!(
                                            option.kind,
                                            PermissionOptionKind::RejectOnce
                                                | PermissionOptionKind::RejectAlways
                                        )
                                    }
                                });
                                let response = match choice {
                                    Some(option) => RequestPermissionResponse::new(
                                        RequestPermissionOutcome::Selected(
                                            SelectedPermissionOutcome::new(
                                                option.option_id.clone(),
                                            ),
                                        ),
                                    ),
                                    None => RequestPermissionResponse::new(
                                        RequestPermissionOutcome::Cancelled,
                                    ),
                                };
                                responder.respond(response)
                            }
                        }
                    },
                    on_receive_request!(),
                );
            let result = builder
                .connect_with(agent, move |cx: ConnectionTo<Agent>| async move {
                    let init = cx
                        .send_request(InitializeRequest::new(ProtocolVersion::V1))
                        .block_task()
                        .await?;
                    let info = AgentInfo {
                        name: init
                            .agent_info
                            .as_ref()
                            .map(|info| info.name.clone())
                            .unwrap_or_default(),
                        version: init
                            .agent_info
                            .as_ref()
                            .map(|info| info.version.clone())
                            .unwrap_or_default(),
                        protocol_version: format!("{:?}", init.protocol_version),
                        load_session: init.agent_capabilities.load_session,
                    };
                    let _ = info_tx.send(info);
                    while let Some(command) = cmd_rx.recv().await {
                        match command {
                            Command::NewSession {
                                cwd,
                                mcp_servers,
                                respond,
                            } => {
                                let request = NewSessionRequest::new(cwd).mcp_servers(
                                    mcp_servers
                                        .into_iter()
                                        .map(McpServerSpec::into_schema)
                                        .collect(),
                                );
                                let result = cx
                                    .send_request(request)
                                    .block_task()
                                    .await
                                    .map(|response| response.session_id.0.to_string())
                                    .map_err(to_kb);
                                let _ = respond.send(result);
                            }
                            Command::LoadSession {
                                session_id,
                                cwd,
                                mcp_servers,
                                respond,
                            } => {
                                let request =
                                    LoadSessionRequest::new(SessionId::new(session_id), cwd)
                                        .mcp_servers(
                                            mcp_servers
                                                .into_iter()
                                                .map(McpServerSpec::into_schema)
                                                .collect(),
                                        );
                                let result = cx
                                    .send_request(request)
                                    .block_task()
                                    .await
                                    .map(|_| ())
                                    .map_err(to_kb);
                                let _ = respond.send(result);
                            }
                            Command::Prompt {
                                session_id,
                                text,
                                respond,
                            } => {
                                let request = PromptRequest::new(
                                    SessionId::new(session_id.clone()),
                                    vec![ContentBlock::Text(TextContent::new(text))],
                                );
                                let result = cx
                                    .send_request(request)
                                    .block_task()
                                    .await
                                    .map(|response| PromptOutcome {
                                        // 用 wire 形式(end_turn / max_tokens …),别用 Debug
                                        stop_reason: serde_json::to_value(response.stop_reason)
                                            .ok()
                                            .and_then(|value| value.as_str().map(str::to_owned))
                                            .unwrap_or_default(),
                                    })
                                    .map_err(to_kb);
                                let _ = event_tx_turn
                                    .send(AcpEvent::TurnFinished {
                                        session_id: session_id.clone(),
                                    })
                                    .await;
                                let _ = respond.send(result);
                            }
                            Command::Cancel { session_id } => {
                                let _ = cx.send_notification(CancelNotification::new(
                                    SessionId::new(session_id),
                                ));
                            }
                            Command::Shutdown => break,
                        }
                    }
                    Ok(())
                })
                .await;
            if let Err(err) = result {
                tracing::warn!(error = %err, "ACP 连接结束");
            }
        });

        // initialize 完成(或代理提前退出)才返回
        let info = tokio::time::timeout(Duration::from_secs(30), info_rx)
            .await
            .map_err(|_| KbError::Unavailable("ACP 代理 30 秒内没有完成 initialize".to_owned()))?
            .map_err(|_| KbError::Upstream("ACP 代理在 initialize 前退出了".to_owned()))?;
        Ok(Self {
            tx: cmd_tx,
            events: Some(event_rx),
            info,
            pending,
            task,
        })
    }

    /// 把增量通道拿走(一个连接只能拿一次)。
    pub fn take_events(&mut self) -> mpsc::Receiver<AcpEvent> {
        self.events.take().expect("events 只能 take 一次")
    }

    /// 新建一个会话(返回代理侧的 session id);`mcp_servers` 会交给代理连接。
    pub async fn new_session(
        &self,
        cwd: PathBuf,
        mcp_servers: Vec<McpServerSpec>,
    ) -> Result<String> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::NewSession {
                cwd,
                mcp_servers,
                respond: tx,
            })
            .await
            .map_err(|_| KbError::Unavailable("ACP 代理已退出".to_owned()))?;
        rx.await
            .map_err(|_| KbError::Upstream("ACP 会话没有返回".to_owned()))?
    }

    /// 续上一个已有的会话(代理不支持 `session/load` 时返回错误)。
    pub async fn load_session(
        &self,
        session_id: &str,
        cwd: PathBuf,
        mcp_servers: Vec<McpServerSpec>,
    ) -> Result<()> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::LoadSession {
                session_id: session_id.to_owned(),
                cwd,
                mcp_servers,
                respond: tx,
            })
            .await
            .map_err(|_| KbError::Unavailable("ACP 代理已退出".to_owned()))?;
        rx.await
            .map_err(|_| KbError::Upstream("ACP 会话没有返回".to_owned()))?
    }

    /// 发一条 prompt;增量从 [`Self::events`] 读。
    pub async fn prompt(&self, session_id: &str, text: &str) -> Result<PromptOutcome> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .send(Command::Prompt {
                session_id: session_id.to_owned(),
                text: text.to_owned(),
                respond: tx,
            })
            .await
            .map_err(|_| KbError::Unavailable("ACP 代理已退出".to_owned()))?;
        rx.await
            .map_err(|_| KbError::Upstream("ACP prompt 没有返回".to_owned()))?
    }

    /// 发一条 prompt,到点还没结束就取消并返回超时。
    pub async fn prompt_timeout(
        &self,
        session_id: &str,
        text: &str,
        timeout: Duration,
    ) -> Result<PromptOutcome> {
        match tokio::time::timeout(timeout, self.prompt(session_id, text)).await {
            Ok(result) => result,
            Err(_) => {
                let _ = self.cancel(session_id).await;
                Err(KbError::Unavailable(format!(
                    "ACP 轮次超过 {} 秒",
                    timeout.as_secs()
                )))
            }
        }
    }

    /// 取消当前会话正在跑的轮次。
    pub async fn cancel(&self, session_id: &str) -> Result<()> {
        self.tx
            .send(Command::Cancel {
                session_id: session_id.to_owned(),
            })
            .await
            .map_err(|_| KbError::Unavailable("ACP 代理已退出".to_owned()))
    }

    /// 界面答复一次权限请求(`allow` = 允许);返回是否找到该请求。
    pub async fn resolve_permission(&self, request_id: &str, allow: bool) -> bool {
        let sender = self.pending.lock().await.remove(request_id);
        match sender {
            Some(sender) => sender.send(allow).is_ok(),
            None => false,
        }
    }

    /// 当前挂起的权限请求 id(测试 / 兜底用)。
    pub async fn pending_permissions(&self) -> Vec<String> {
        self.pending.lock().await.keys().cloned().collect()
    }

    /// 请求连接任务退出。`AcpClient` 被 `Arc` 共享时用这个,不消费自己。
    pub async fn request_shutdown(&self) {
        let _ = self.tx.send(Command::Shutdown).await;
    }

    /// 关掉连接(子进程随连接结束退出)。
    pub async fn shutdown(mut self) {
        self.request_shutdown().await;
        let _ = tokio::time::timeout(Duration::from_secs(3), &mut self.task).await;
    }
}

/// 权限请求 id。
fn uuid_like() -> String {
    format!("perm-{}", uuid::Uuid::now_v7().simple())
}

fn to_kb(err: agent_client_protocol::Error) -> KbError {
    KbError::Upstream(format!("ACP 调用失败: {err}"))
}

/// 从一条 `session/update` 里取正文增量(正文 / 思考)。
pub fn text_of(update: &SessionUpdate) -> Option<(&'static str, String)> {
    match update {
        SessionUpdate::AgentMessageChunk(chunk) => match &chunk.content {
            ContentBlock::Text(text) => Some(("text", text.text.clone())),
            _ => None,
        },
        SessionUpdate::AgentThoughtChunk(chunk) => match &chunk.content {
            ContentBlock::Text(text) => Some(("thought", text.text.clone())),
            _ => None,
        },
        _ => None,
    }
}
