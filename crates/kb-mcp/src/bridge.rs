//! `kb mcp`:stdio 桥接(设计规范)。
//!
//! 严格照 `验证样例` 的写法:手写 `ServerHandler`,
//! `list_tools` 从守护进程取能力表并缓存 60 秒,`call_tool` 转发到
//! `POST /api/v1/capabilities/{name}`。**stdout 只能输出 MCP 协议数据**。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rmcp::model::{
    CallToolRequestParams, CallToolResult, ContentBlock, Implementation, InitializeRequestParams,
    InitializeResult, JsonObject, ListToolsResult, PaginatedRequestParams, ServerCapabilities,
    Tool,
};
use rmcp::service::{RequestContext, RoleServer};
use rmcp::{ErrorData as McpError, ServerHandler};
use serde_json::{Value, json};

use crate::uds::{CallOptions, UdsClient};

/// 工具列表缓存时长。
const TOOLS_TTL: Duration = Duration::from_secs(60);

/// 带时间戳的工具列表缓存。
type ToolsCache = Arc<Mutex<Option<(Instant, Vec<Tool>)>>>;

/// 桥接状态。
#[derive(Clone)]
pub struct Bridge {
    client: UdsClient,
    client_name: Arc<Mutex<Option<String>>>,
    tools: ToolsCache,
    max_chars: usize,
    /// 调用上下文(stdio:客户端 cwd / KB_PROJECT;`/mcp`:都不带,由请求参数决定)。
    context: BridgeContext,
    /// 只暴露这些工具组(`None` = 全部);照 codeg 的 `--features` 思路。
    features: Option<Vec<String>>,
    /// 从列表和调用里拿掉的工具(远程 `/mcp` 不暴露 `agent_history`)。
    hidden: Vec<String>,
}

/// 桥接的调用上下文。
#[derive(Clone, Debug, Default)]
pub struct BridgeContext {
    /// 工作目录(`X-KB-Cwd`)。
    pub cwd: Option<String>,
    /// 项目(`X-KB-Project`)。
    pub project: Option<String>,
}

impl Bridge {
    /// 构造;`client_name` 会作为 `X-KB-Client` 转发给守护进程。
    pub fn new(client: UdsClient) -> Self {
        Self::with_max_chars(client, 24_000)
    }

    /// 指定输出长度上限(来自 `search.mcp_max_output_chars`)。
    pub fn with_max_chars(client: UdsClient, max_chars: usize) -> Self {
        Self::with_context(client, max_chars, BridgeContext::default())
    }

    /// 指定输出上限与调用上下文。
    pub fn with_context(client: UdsClient, max_chars: usize, context: BridgeContext) -> Self {
        Self {
            client,
            client_name: Arc::new(Mutex::new(None)),
            tools: Arc::new(Mutex::new(None)),
            max_chars,
            context,
            features: None,
            hidden: Vec::new(),
        }
    }

    /// 这些工具不出现在 `tools/list`,也不能 `call_tool`。
    pub fn without_tools(mut self, names: impl IntoIterator<Item = impl Into<String>>) -> Self {
        self.hidden.extend(names.into_iter().map(Into::into));
        self
    }

    /// 只暴露这些工具组(逗号分隔的组名;`all` = 全部)。
    pub fn with_features(mut self, features: Vec<String>) -> Self {
        let features: Vec<String> = features
            .into_iter()
            .map(|item| item.trim().to_owned())
            .filter(|item| !item.is_empty())
            .collect();
        if !features.is_empty() {
            self.features = Some(features);
        }
        self
    }

    /// 这个工具在不在启用的组里。
    fn allows(&self, name: &str) -> bool {
        match &self.features {
            None => true,
            Some(list) => list.iter().any(|feature| {
                feature == "all" || feature == kb_capability::defs::mcp_tool_group(name)
            }),
        }
    }

    fn visible(&self, name: &str) -> bool {
        !self.hidden.iter().any(|hidden| hidden == name) && self.allows(name)
    }

    /// 协商出的客户端名(供日志与 `X-KB-Client` 使用)。
    pub fn client_name(&self) -> Option<String> {
        self.client_name.lock().ok().and_then(|guard| guard.clone())
    }

    /// 取工具列表(带 60 秒缓存)。
    async fn tools(&self) -> Result<Vec<Tool>, McpError> {
        if let Some((at, tools)) = self.tools.lock().ok().and_then(|guard| guard.clone())
            && at.elapsed() < TOOLS_TTL
        {
            return Ok(tools);
        }
        let response = self
            .client
            .capabilities("mcp")
            .await
            .map_err(|err| McpError::internal_error(format!("取能力列表失败: {err}"), None))?;
        let capabilities = response["data"]["capabilities"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut tools = Vec::with_capacity(capabilities.len());
        for capability in capabilities {
            let Some(name) = capability["name"].as_str() else {
                continue;
            };
            if !self.visible(name) {
                continue;
            }
            let description = capability["description"].as_str().map(str::to_owned);
            let schema: JsonObject =
                serde_json::from_value(capability["input_schema"].clone()).unwrap_or_default();
            tools.push(Tool::new_with_raw(
                name.to_owned(),
                description.map(std::borrow::Cow::Owned),
                schema,
            ));
        }
        if let Ok(mut guard) = self.tools.lock() {
            *guard = Some((Instant::now(), tools.clone()));
        }
        Ok(tools)
    }

    fn options(&self) -> CallOptions {
        // 只用在构造时注入的上下文;绝不读进程状态
        CallOptions {
            cwd: self.context.cwd.clone(),
            client: self.client_name(),
            project: self.context.project.clone(),
            surface: Some("mcp".to_owned()),
            dry_run: false,
        }
    }
}

impl ServerHandler for Bridge {
    fn get_info(&self) -> InitializeResult {
        InitializeResult::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("kb", env!("CARGO_PKG_VERSION")))
            .with_instructions(
                "本机开发知识库。处理不熟悉的代码前先调用 search_knowledge;解决了非平凡问题或做出\
                 设计决定后,调用 save_insight 记录(标题一句话,正文说明背景、结论和涉及的文件)。\
                 正文要引用已有文件、模板或笔记时,先用 list_files 找准确路径,再按 kb:// 或相对路径写;\
                 需要拦下写坏的引用时给 save_insight 加 strict_links,改完文档可看返回的 links 或调用 check_links。",
            )
    }

    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, McpError> {
        let client_name = request.client_info.name.clone();
        if let Ok(mut guard) = self.client_name.lock() {
            *guard = Some(client_name.clone());
        }
        context.peer.set_peer_info(request.clone());
        // 协议版本协商(计划变更 B)
        let result = self.negotiate_initialize(&request)?;
        tracing::info!(
            client = %client_name,
            protocol = %result.protocol_version,
            "MCP 客户端已连接"
        );
        Ok(result)
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult {
            tools: self.tools().await?,
            ..Default::default()
        })
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::CallToolResponse, McpError> {
        let tools = match self.tools().await {
            Ok(tools) => tools,
            Err(err) => {
                // 取不到工具列表(例如守护进程挂了)也算业务错误,返回 isError
                return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                    "unavailable: {err}"
                ))])
                .into());
            }
        };
        if !self.visible(&request.name) {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "tool disabled: {} 不在启用的工具组里(当前:{})",
                request.name,
                self.features
                    .as_ref()
                    .map(|list| list.join(","))
                    .unwrap_or_else(|| "all".to_owned())
            ))])
            .into());
        }
        if !tools.iter().any(|tool| tool.name == request.name) {
            return Err(McpError::invalid_params(
                format!("unknown tool {}", request.name),
                None,
            ));
        }
        let args = Value::Object(request.arguments.unwrap_or_default());
        match self.client.call(&request.name, args, &self.options()).await {
            Ok(data) => Ok(CallToolResult::success(vec![ContentBlock::text(render(
                &request.name,
                &data,
                self.max_chars,
            ))])
            .into()),
            Err(err) => {
                // 业务错误返回 isError 的结果,不要返回 JSON-RPC 错误
                let code = error_code(&err);
                let text = format!("{code}: {}", strip_prefix(&err.to_string(), code));
                Ok(CallToolResult::error(vec![ContentBlock::text(text)]).into())
            }
        }
    }
}

/// 把能力的 `data` 渲染成文本(search 类走设计规范的列表格式,其余用 JSON)。
fn render(name: &str, data: &Value, max_chars: usize) -> String {
    if matches!(name, "search_knowledge" | "search_code")
        && let Ok(hits) = serde_json::from_value::<Vec<kb_core::model::SearchHit>>(
            data.get("hits").cloned().unwrap_or(json!([])),
        )
    {
        let degraded = data.get("degraded").and_then(Value::as_str);
        let options = kb_core::render::RenderOptions {
            max_chars,
            ..Default::default()
        };
        return kb_core::render::render_hits(&hits, degraded, &options);
    }
    let text = serde_json::to_string_pretty(data).unwrap_or_default();
    kb_core::render::truncate(&text, max_chars)
}

/// 去掉 `Display` 自带的前缀(`invalid input: ` 之类),避免 `invalid_input: invalid input: …`。
fn strip_prefix<'a>(message: &'a str, code: &str) -> &'a str {
    let human = match code {
        "not_found" => "not found: ",
        "invalid_input" => "invalid input: ",
        "unauthorized" => "unauthorized",
        "unavailable" => "unavailable: ",
        "internal" => "internal: ",
        _ => return message,
    };
    message.strip_prefix(human).unwrap_or(message)
}

fn error_code(err: &kb_core::KbError) -> &'static str {
    match err {
        kb_core::KbError::NotFound(_) => "not_found",
        kb_core::KbError::InvalidInput(_) => "invalid_input",
        kb_core::KbError::Conflict { .. } => "conflict",
        kb_core::KbError::Exists(_) => "exists",
        kb_core::KbError::Unauthorized => "unauthorized",
        kb_core::KbError::Forbidden(_) => "forbidden",
        kb_core::KbError::Unavailable(_) => "unavailable",
        kb_core::KbError::Upstream(_) => "upstream",
        kb_core::KbError::Internal(_) => "internal",
    }
}

/// 在 stdio 上运行(供 `kb mcp` 调用)。
///
/// 返回的 future 在客户端断开时结束。
pub async fn serve_stdio(bridge: Bridge) -> kb_core::Result<()> {
    use rmcp::ServiceExt;
    let service = bridge
        .serve(rmcp::transport::stdio())
        .await
        .map_err(|err| kb_core::KbError::Internal(format!("MCP 服务启动失败: {err}")))?;
    service
        .waiting()
        .await
        .map_err(|err| kb_core::KbError::Internal(format!("MCP 服务退出: {err}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_text_drops_the_duplicated_prefix() {
        assert_eq!(
            strip_prefix("invalid input: 缺少 title", "invalid_input"),
            "缺少 title"
        );
        assert_eq!(
            strip_prefix("not found: project demo", "not_found"),
            "project demo"
        );
        assert_eq!(strip_prefix("原样", "forbidden"), "原样");
    }

    #[test]
    fn render_falls_back_to_json_for_non_search_tools() {
        let data = json!({"id": "x", "version": 1});
        let text = render("save_insight", &data, 1000);
        assert!(text.contains("\"id\""));
    }
}
