//! `/mcp`(streamable HTTP,计划变更 )。
//!
//! 只挂在 TCP 监听上;必须带 `Authorization: Bearer <token>`,token 存在
//! `KB_HOME/run/mcp-token`(0600)。未开启时该路由根本不存在(axum 返回 404)。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use kb_mcp::bridge::Bridge;
use kb_mcp::uds::UdsClient;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::{StreamableHttpServerConfig, StreamableHttpService};
use serde_json::json;

use crate::api::AppState;

/// `/mcp` 的访问控制。
///
/// token 从文件读取(每次校验都读),这样 `kb mcp token --rotate` 之后旧 token **立即**失效。
#[derive(Clone, Debug)]
pub struct McpGate {
    /// token 文件路径。
    pub token_file: std::path::PathBuf,
    /// 允许的 `Origin`(为空 = 只允许无 Origin 的请求,例如 curl / 服务端客户端)。
    pub allowed_origins: Vec<String>,
    /// 允许的 `Host`(默认只含本机;经反向代理暴露时要加上外部域名）。
    pub allowed_hosts: Vec<String>,
}

impl McpGate {
    /// Origin 校验:防 DNS rebinding。没有 Origin 的服务端调用直接通过。
    pub fn check_origin(&self, headers: &HeaderMap) -> Result<(), Box<Response>> {
        if let Some(origin) = headers.get("origin").and_then(|value| value.to_str().ok())
            && !self.allowed_origins.iter().any(|allowed| allowed == origin)
        {
            return Err(Box::new(error(
                StatusCode::FORBIDDEN,
                "forbidden",
                "Origin 不被允许",
            )));
        }
        Ok(())
    }

    /// 是否等于 `run/mcp-token` 里的那一份。
    pub fn file_token_matches(&self, headers: &HeaderMap) -> bool {
        let Some(token) = bearer_token(headers) else {
            return false;
        };
        let Some(expected) = self.token() else {
            return false;
        };
        constant_time_eq(token, &expected)
    }

    /// 校验鉴权与 Origin。文件令牌不对时返回错误;API 令牌由调用方再查库。
    pub fn check(&self, headers: &HeaderMap) -> Result<(), Box<Response>> {
        self.check_origin(headers)?;
        if self.file_token_matches(headers) {
            return Ok(());
        }
        let Some(value) = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
        else {
            return Err(Box::new(error(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "缺少 Authorization: Bearer <token>",
            )));
        };
        if !value.starts_with("Bearer ") {
            return Err(Box::new(error(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "Authorization 头必须是 Bearer <token>",
            )));
        }
        Err(Box::new(error(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "token 不正确",
        )))
    }
}

impl McpGate {
    /// 读取当前 token(文件不存在或为空时返回 `None`)。
    pub fn token(&self) -> Option<String> {
        let value = std::fs::read_to_string(&self.token_file).ok()?;
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    }
}

/// `Authorization: Bearer` 的值。
fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get("authorization")?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then_some(token)
}

/// 把配置里的外部 Host 变成允许的 Origin(`https://域名` 与 `http://域名`)。
pub fn origins_from_hosts(hosts: &[String]) -> Vec<String> {
    let mut origins = Vec::new();
    for host in hosts {
        let name = host.split(':').next().unwrap_or(host);
        if name.is_empty() || name == "localhost" || name == "127.0.0.1" || name == "::1" {
            continue;
        }
        origins.push(format!("https://{name}"));
        origins.push(format!("http://{name}"));
    }
    origins.sort();
    origins.dedup();
    origins
}

/// 比较两个字符串(长度不同直接不等;逐字节异或累加,避免提前返回)。
fn constant_time_eq(left: &str, right: &str) -> bool {
    let (left, right) = (left.as_bytes(), right.as_bytes());
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// 输出长度上限的来源。
#[derive(Clone)]
enum MaxChars {
    /// 固定值(测试与嵌入式用法)。
    Fixed(usize),
    /// 每次建会话时从配置存储里读 `search.mcp_max_output_chars`。
    Live(Arc<kb_core::config::ConfigStore>),
}

impl MaxChars {
    /// 当前值。
    fn value(&self) -> usize {
        match self {
            Self::Fixed(value) => *value,
            Self::Live(store) => store.get().search.mcp_max_output_chars,
        }
    }
}

/// `/mcp` 端点:鉴权 + rmcp 的 streamable HTTP 服务。
pub struct McpEndpoint {
    /// 访问控制。
    pub gate: McpGate,
    /// 本机文件令牌用的服务:桥接层回连 `kb.sock`,是本机超级用户身份。
    service: StreamableHttpService<Bridge, LocalSessionManager>,
    /// 令牌用户各自的服务:桥接层回连 `agent.sock`,带着这个用户的身份和功能点,
    /// 所以一个用户的令牌只能碰到他自己的知识库(以及他明确打开的「共享给我」)。
    /// 按 (用户 id, 是否包含「共享给我」) 分开缓存:同一个人的两个令牌设置不同,各用各的服务和授权,
    /// 谁也不会把对方的会话弄失效。
    users: Mutex<HashMap<(String, bool), UserService>>,
    /// `run/agent.sock`;没有就不支持令牌用户(返回 503)。
    agent_socket: Option<std::path::PathBuf>,
    max_chars: MaxChars,
}

/// 一个用户的 MCP 服务。
struct UserService {
    /// 身份指纹:知识库、功能点、「包含共享给我」任何一项变了就重建(旧授权作废)。
    fingerprint: String,
    service: StreamableHttpService<Bridge, LocalSessionManager>,
    last_used: std::time::Instant,
}

/// 同时缓存多少份服务(一个用户最多占两份:含共享 / 不含共享);超过时回收最久没用的。
const MAX_USER_SERVICES: usize = 4000;

impl McpEndpoint {
    /// 用守护进程自己的 UDS 客户端构造(HTTP 模式的桥接再回连本机守护进程)。
    ///
    /// `max_chars` 来自 `search.mcp_max_output_chars`(固定值,不随配置变化)。
    pub fn new(gate: McpGate, client: UdsClient, max_chars: usize) -> Self {
        Self::build(gate, client, MaxChars::Fixed(max_chars))
    }

    /// 与 [`Self::new`] 相同,但输出上限**每个会话重新读一次配置**(热更新项)。
    pub fn with_config_store(
        gate: McpGate,
        client: UdsClient,
        store: Arc<kb_core::config::ConfigStore>,
    ) -> Self {
        Self::build(gate, client, MaxChars::Live(store))
    }

    fn build(gate: McpGate, client: UdsClient, max_chars: MaxChars) -> Self {
        let service = build_service(&gate, client, max_chars.clone());
        Self {
            gate,
            service,
            users: Mutex::new(HashMap::new()),
            agent_socket: None,
            max_chars,
        }
    }

    /// 打开令牌用户的 MCP:桥接层改走 `agent.sock`(守护进程给的路径)。
    #[must_use]
    pub fn with_agent_socket(mut self, socket: impl Into<std::path::PathBuf>) -> Self {
        self.agent_socket = Some(socket.into());
        self
    }

    /// 这个令牌用户的服务(没有就建一个)。身份指纹变了就换新的并作废旧授权。
    fn service_for(
        &self,
        state: &AppState,
        identity: &crate::auth::Identity,
    ) -> Option<StreamableHttpService<Bridge, LocalSessionManager>> {
        let socket = self.agent_socket.clone()?;
        let user = identity.user.as_ref()?;
        let fingerprint = format!(
            "{}|{}|{:?}",
            identity.principal.space_id.as_deref().unwrap_or(""),
            identity.include_shared,
            identity.principal.features.effective()
        );
        let key = (user.id.clone(), identity.include_shared);
        let session = session_name(&key);
        let mut users = self.users.lock().ok()?;
        if let Some(found) = users.get_mut(&key)
            && found.fingerprint == fingerprint
        {
            found.last_used = std::time::Instant::now();
            return Some(found.service.clone());
        }
        // 身份变了(换了角色 / 功能点 / 知识库):只作废这一份的授权,旧服务里的会话随之失效(客户端会重新初始化)
        state.agent_grants.revoke_session(&session);
        if users.len() >= MAX_USER_SERVICES
            && let Some(oldest) = users
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(key, _)| key.clone())
        {
            users.remove(&oldest);
            state.agent_grants.revoke_session(&session_name(&oldest));
        }
        let token = state.agent_grants.issue(crate::agent_grant::AgentGrant {
            // `docs`:AI 读 / 改在线文档。远程 MCP 背后是登录用户自己的权限;
            // 默认只能提建议,人接受才生效
            tool_groups: vec![
                "knowledge".to_owned(),
                "jobs".to_owned(),
                "insight".to_owned(),
                "docs".to_owned(),
            ],
            project: None,
            session_id: session,
            principal: Some(identity.principal.clone()),
            include_shared: identity.include_shared,
        });
        let client = UdsClient::new(socket).with_bearer(token);
        let service = build_service(&self.gate, client, self.max_chars.clone());
        users.insert(
            key,
            UserService {
                fingerprint,
                service: service.clone(),
                last_used: std::time::Instant::now(),
            },
        );
        Some(service)
    }
}

/// 这一份服务对应的授权会话名。含共享和不含共享是两个会话,撤销一个不影响另一个。
fn session_name(key: &(String, bool)) -> String {
    format!("mcp:{}:{}", key.0, if key.1 { "shared" } else { "own" })
}

/// 建一个 MCP 服务(本机用的和每个用户用的是同一套,只是桥接层的客户端不同)。
fn build_service(
    gate: &McpGate,
    client: UdsClient,
    max_chars: MaxChars,
) -> StreamableHttpService<Bridge, LocalSessionManager> {
    let mut config = StreamableHttpServerConfig::default();
    config.allowed_origins = gate.allowed_origins.clone();
    config.allowed_hosts = gate.allowed_hosts.clone();
    // 保持 rmcp 的 legacy session 模式(默认):每次 initialize 建会话、返回 `Mcp-Session-Id`,
    // 响应走 SSE。`json_response = true` 只在该模式关闭时生效,单独设它不会改变任何行为。
    // 所以这里不再写它;要改成无状态 JSON 响应需要同时关掉 legacy 模式。
    // `/mcp` 是远程入口:不带 cwd、不带 project(由请求里的显式参数决定)
    let factory = move || {
        Ok(Bridge::with_context(
            client.clone(),
            max_chars.value(),
            kb_mcp::bridge::BridgeContext::default(),
        )
        .without_tools(["agent_history"]))
    };
    StreamableHttpService::new(factory, Arc::new(LocalSessionManager::default()), config)
}

/// `/mcp` 的入口:先鉴权,再交给 MCP 服务。
pub async fn handler(
    State(state): State<Arc<AppState>>,
    request: axum::extract::Request,
) -> Response {
    let Some(endpoint) = state.mcp.clone() else {
        return error(StatusCode::NOT_FOUND, "not_found", "没有启用 /mcp");
    };
    if let Err(response) = endpoint.gate.check_origin(request.headers()) {
        return *response;
    }
    if !endpoint.gate.file_token_matches(request.headers()) {
        let Some(raw) = bearer_token(request.headers()) else {
            return error(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "缺少 Authorization: Bearer <token>",
            );
        };
        if !raw.starts_with(kb_core::token::TOKEN_PREFIX) {
            return error(StatusCode::UNAUTHORIZED, "unauthorized", "token 不正确");
        }
        if raw.starts_with(kb_core::token::ADMIN_KEY_PREFIX) {
            return error(
                StatusCode::UNAUTHORIZED,
                "unauthorized",
                "admin key 不能直接接 MCP:先用它调 POST /api/v1/auth/tokens 创建一个 scope=mcp 的访问令牌,MCP 客户端用那个令牌",
            );
        }
        match crate::auth::token_identity(
            &state,
            raw,
            crate::auth::session::now_millis(),
            &(state.ai_enabled)(),
        )
        .await
        {
            Ok(Some(identity))
                if identity.via == crate::auth::AuthVia::Token
                    && !identity.actor.is_empty()
                    && matches!(identity.surface, kb_capability::Surface::Mcp) =>
            {
                // 每个用户走自己的服务:桥接层带着他的身份回连 agent.sock,不再借本机超级用户
                let Some(service) = endpoint.service_for(&state, &identity) else {
                    return error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "unavailable",
                        "远程 MCP 暂时不可用",
                    );
                };
                let mut service = service;
                return match tower::ServiceExt::oneshot(&mut service, request).await {
                    Ok(response) => response.into_response(),
                    Err(_) => error(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "internal",
                        "MCP 服务出错",
                    ),
                };
            }
            Ok(Some(_)) => {
                return error(
                    StatusCode::UNAUTHORIZED,
                    "unauthorized",
                    "这个令牌的 scope 不是 mcp,/mcp 不接受",
                );
            }
            Ok(None) => return error(StatusCode::UNAUTHORIZED, "unauthorized", "token 不正确"),
            Err(err) => return crate::api::error_response(err),
        }
    }
    let mut service = endpoint.service.clone();
    match tower::ServiceExt::oneshot(&mut service, request).await {
        Ok(response) => response.into_response(),
        Err(_) => error(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "MCP 服务出错",
        ),
    }
}

/// 供守护进程判断是否需要挂载。
pub fn enabled(state: &AppState) -> bool {
    state.mcp.is_some()
}

fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        axum::Json(json!({
            "ok": false,
            "error": { "code": code, "message": message },
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn gate() -> (McpGate, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("临时目录");
        let file = dir.path().join("mcp-token");
        std::fs::write(&file, "secret\n").expect("写 token");
        (
            McpGate {
                token_file: file,
                allowed_origins: vec!["https://kb.example.com".to_owned()],
                allowed_hosts: vec!["localhost".to_owned()],
            },
            dir,
        )
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (key, value) in pairs {
            map.insert(*key, HeaderValue::from_str(value).expect("头"));
        }
        map
    }

    #[test]
    fn public_hosts_become_http_and_https_origins() {
        let origins = origins_from_hosts(&[
            "kb.example.com".to_owned(),
            "kb.example.com:443".to_owned(),
            "localhost".to_owned(),
            "127.0.0.1:17878".to_owned(),
        ]);
        assert_eq!(
            origins,
            vec![
                "http://kb.example.com".to_owned(),
                "https://kb.example.com".to_owned(),
            ]
        );
    }

    #[test]
    fn missing_or_wrong_token_is_rejected() {
        let (gate, _dir) = gate();
        assert!(gate.check(&headers(&[])).is_err());
        assert!(
            gate.check(&headers(&[("authorization", "Bearer nope")]))
                .is_err()
        );
        assert!(
            gate.check(&headers(&[("authorization", "Basic x")]))
                .is_err()
        );
        assert!(
            gate.check(&headers(&[("authorization", "Bearer secret")]))
                .is_ok()
        );
    }

    #[test]
    fn rotating_the_file_takes_effect_immediately() {
        let (gate, _dir) = gate();
        assert!(
            gate.check(&headers(&[("authorization", "Bearer secret")]))
                .is_ok()
        );
        std::fs::write(&gate.token_file, "rotated\n").expect("轮换");
        assert!(
            gate.check(&headers(&[("authorization", "Bearer secret")]))
                .is_err(),
            "轮换后旧 token 必须立即失效"
        );
        assert!(
            gate.check(&headers(&[("authorization", "Bearer rotated")]))
                .is_ok()
        );
    }

    #[test]
    fn origin_must_be_allowed() {
        let (gate, _dir) = gate();
        let bad = headers(&[
            ("authorization", "Bearer secret"),
            ("origin", "https://evil.example"),
        ]);
        assert!(gate.check(&bad).is_err());
        let good = headers(&[
            ("authorization", "Bearer secret"),
            ("origin", "https://kb.example.com"),
        ]);
        assert!(gate.check(&good).is_ok());
    }

    #[test]
    fn constant_time_compare_is_exact() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
    }
}
