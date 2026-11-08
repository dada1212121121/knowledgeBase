//! `kb mcp` 端到端:真实守护进程 + stdio 桥接,覆盖四个协议版本。
//!
//! 运行:`cargo test -p kb-cli --features testkit --test e2e_mcp`

#![cfg(feature = "testkit")]

mod support;

use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use support::Daemon;

fn kb() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kb"))
}

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

struct Env {
    project: tempfile::TempDir,
    /// `prepare` 之前放在这里,之后挪进 `daemon`。
    pending_home: Option<tempfile::TempDir>,
    daemon: Option<Daemon>,
    port: u16,
    token: String,
}

impl Env {
    fn new() -> Self {
        let home = tempfile::tempdir().expect("KB_HOME");
        let project = tempfile::tempdir().expect("项目");
        write(
            &project.path().join("src/auth.rs"),
            "pub fn login(user: &str) -> bool {\n    !user.is_empty()\n}\n",
        );
        write(
            &home.path().join("config.toml"),
            "[embed]\nbackend = \"fake\"\n[mcp]\ntransports = [\"stdio\", \"http\"]\n\
             [server]\nlisten = \"127.0.0.1:0\"\n",
        );
        Self {
            project,
            pending_home: Some(home),
            daemon: None,
            port: 0,
            token: String::new(),
        }
    }

    fn home(&self) -> &Path {
        if let Some(daemon) = &self.daemon {
            daemon.home.path()
        } else {
            self.pending_home.as_ref().expect("KB_HOME").path()
        }
    }

    fn base_url(&self) -> String {
        format!("127.0.0.1:{}", self.port)
    }

    fn run(&self, args: &[&str]) -> std::process::Output {
        kb().env("KB_HOME", self.home())
            .args(args)
            .output()
            .expect("运行 kb")
    }

    fn prepare(&mut self) {
        // 生成 /mcp 的 token
        let output = self.run(&["mcp", "token"]);
        assert!(output.status.success(), "mcp token 失败");
        self.token = std::fs::read_to_string(self.home().join("run/mcp-token"))
            .expect("读 token")
            .trim()
            .to_owned();
        let path = self.project.path().to_string_lossy().into_owned();
        let output = self.run(&["project", "add", &path, "--name", "demo"]);
        assert!(output.status.success(), "project add 失败");
        let output = self.run(&["index", "demo"]);
        assert!(output.status.success(), "index 失败");
        let home = self.pending_home.take().expect("KB_HOME");
        let daemon = Daemon::start(home);
        self.port = daemon.tcp_port();
        self.daemon = Some(daemon);
    }
}

impl Drop for Env {
    fn drop(&mut self) {
        // 先停守护进程,再让 KB_HOME 随 `daemon.home` 一起删掉。
        self.daemon.take();
    }
}

/// 与 `kb mcp` 的一次交互。
struct Mcp {
    child: Child,
    stdin: std::process::ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
    next_id: u64,
    /// `kb mcp` 的 stderr 落盘位置
    stderr_path: std::path::PathBuf,
}

impl Mcp {
    /// 读 stderr 的最后若干行,拼进 panic 信息。
    fn stderr_tail(&self) -> String {
        let text = std::fs::read_to_string(&self.stderr_path).unwrap_or_default();
        let lines: Vec<&str> = text.lines().rev().take(20).collect();
        lines.into_iter().rev().collect::<Vec<_>>().join("\n")
    }
}

impl Mcp {
    fn start(home: &Path) -> Self {
        Self::start_with_args(home, &[])
    }

    fn start_with_args(home: &Path, extra: &[&str]) -> Self {
        let stderr_path = home.join("mcp.stderr.log");
        let stderr_file = std::fs::File::create(&stderr_path).expect("建 stderr 文件");
        let mut child = kb()
            .env("KB_HOME", home)
            .arg("mcp")
            .args(extra)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(stderr_file))
            .spawn()
            .expect("启动 kb mcp");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = BufReader::new(child.stdout.take().expect("stdout"));
        Self {
            child,
            stdin,
            stdout,
            next_id: 1,
            stderr_path,
        }
    }

    fn send(&mut self, value: Value) {
        let line = format!("{value}\n");
        self.stdin.write_all(line.as_bytes()).expect("写 stdin");
        self.stdin.flush().expect("flush");
    }

    fn read(&mut self) -> Value {
        let mut line = String::new();
        let read = self.stdout.read_line(&mut line).expect("读 stdout");
        if read == 0 {
            // 子进程提前退出:把它的 stderr 带出来,否则无从定位
            panic!(
                "kb mcp 的 stdout 意外结束(EOF);stderr 末尾:\n{}",
                self.stderr_tail()
            );
        }
        serde_json::from_str(&line).unwrap_or_else(|err| {
            panic!(
                "不是 JSON:{line} ({err});stderr 末尾:\n{}",
                self.stderr_tail()
            )
        })
    }

    fn request(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        loop {
            let message = self.read();
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                return message;
            }
        }
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn initialize(mcp: &mut Mcp, version: &str) -> Value {
    mcp.request(
        "initialize",
        json!({
            "protocolVersion": version,
            "capabilities": {},
            "clientInfo": {"name": "kiro", "version": "1.0"},
        }),
    )
}

fn full_handshake(env: &Env, version: &str) -> (Mcp, Value) {
    let mut mcp = Mcp::start(env.home());
    let response = initialize(&mut mcp, version);
    mcp.notify("notifications/initialized", json!({}));
    (mcp, response)
}

#[test]
fn mcp_handshake_works_for_every_known_protocol_version() {
    let mut env = Env::new();
    env.prepare();

    for version in ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] {
        let (mut mcp, response) = full_handshake(&env, version);
        assert!(response.get("error").is_none(), "{version}: {response}");
        let result = &response["result"];
        assert_eq!(
            result["protocolVersion"], version,
            "协商出的版本应与请求一致"
        );
        assert!(
            result["capabilities"]["tools"].is_object(),
            "{version}: capabilities 应包含 tools"
        );

        let tools = mcp.request("tools/list", json!({}));
        let list = tools["result"]["tools"].as_array().expect("工具列表");
        assert_eq!(list.len(), 16, "{version}: MCP 应有 16 个工具");
        // 引用图谱一组(51d66eaf 加的)本机 stdio 也开着:工具数只是总数,这里点名确认它们真在
        let listed: Vec<&str> = list
            .iter()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert!(
            ["doc_links", "list_files", "check_links"]
                .iter()
                .all(|name| listed.contains(name)),
            "{version}: 缺引用图谱工具:{listed:?}"
        );

        // 一次 tools/call:save_insight 之后用 search_knowledge 搜到它
        let saved = mcp.request(
            "tools/call",
            json!({
                "name": "save_insight",
                "arguments": {"title": format!("版本 {version} 的测试经验"), "body": "端到端验证", "global": true},
            }),
        );
        assert!(saved.get("error").is_none(), "{version}: {saved}");
        let text = saved["result"]["content"][0]["text"]
            .as_str()
            .expect("文本内容");
        let data: Value = serde_json::from_str(text).expect("JSON 文本");
        let id = data["id"].as_str().expect("完整 id");
        assert_eq!(id.len(), 36, "id 必须完整输出");

        // 等嵌入任务跑完
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut found = false;
        while Instant::now() < deadline {
            let search = mcp.request(
                "tools/call",
                json!({
                    "name": "search_knowledge",
                    "arguments": {"query": format!("版本 {version} 的测试经验"), "k": 5},
                }),
            );
            let text = search["result"]["content"][0]["text"]
                .as_str()
                .unwrap_or("");
            if text.contains(id) {
                found = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
        assert!(found, "{version}: 保存的 insight 应能被检索到");
    }
}

#[test]
fn handshake_is_logged_with_client_and_protocol() {
    let mut env = Env::new();
    env.prepare();
    let (mut mcp, _) = full_handshake(&env, "2025-06-18");
    let _ = mcp.request("tools/list", json!({}));
    // 日志按天滚动:找 logs/ 下所有 kb.log*
    let logs_dir = env.home().join("logs");
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut found = false;
    while Instant::now() < deadline && !found {
        if let Ok(entries) = std::fs::read_dir(&logs_dir) {
            for entry in entries.flatten() {
                let text = std::fs::read_to_string(entry.path()).unwrap_or_default();
                if text.contains("MCP 客户端已连接")
                    && text.contains("client=kiro")
                    && text.contains("protocol=2025-06-18")
                {
                    found = true;
                    break;
                }
            }
        }
        if !found {
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    assert!(found, "日志里应记录 client=kiro protocol=2025-06-18");
}

#[test]
fn business_errors_are_is_error_results() {
    let mut env = Env::new();
    env.prepare();
    let (mut mcp, _) = full_handshake(&env, "2025-06-18");
    // 缺必填参数 → 业务错误,应是 isError 而不是 JSON-RPC error
    let response = mcp.request(
        "tools/call",
        json!({"name": "save_insight", "arguments": {"body": "只有正文"}}),
    );
    assert!(
        response.get("error").is_none(),
        "不应是 JSON-RPC 错误:{response}"
    );
    assert_eq!(response["result"]["isError"], true, "{response}");
    let text = response["result"]["content"][0]["text"]
        .as_str()
        .expect("文本");
    assert!(text.starts_with("invalid_input: "), "错误文本:{text}");
    assert!(
        !text.contains("invalid_input: invalid input"),
        "不应有重复前缀:{text}"
    );
}

#[test]
fn unknown_protocol_version_negotiates_down() {
    let mut env = Env::new();
    env.prepare();
    let (mut mcp, response) = full_handshake(&env, "2025-07-01");
    assert!(
        response.get("error").is_none(),
        "未知版本不应报错:{response}"
    );
    let negotiated = response["result"]["protocolVersion"]
        .as_str()
        .expect("版本");
    let known = [
        "2024-11-05",
        "2025-03-26",
        "2025-06-18",
        "2025-11-25",
        "2026-07-28",
    ];
    assert!(known.contains(&negotiated), "应协商到已知版本:{negotiated}");
    let tools = mcp.request("tools/list", json!({}));
    assert_eq!(tools["result"]["tools"].as_array().map(Vec::len), Some(16));
    println!("未知版本 2025-07-01 协商为 {negotiated}");
}

// ---------------------------------------------------------------------------
// 批次③:`/mcp`(streamable HTTP)与 stdio 的一致性
// ---------------------------------------------------------------------------

use std::io::Read;
use std::net::TcpStream;

/// 发一个 HTTP/1.1 请求,返回 (状态码, 响应头里的 mcp-session-id, 响应体)。
fn http_call(
    addr: &str,
    path: &str,
    token: Option<&str>,
    session: Option<&str>,
    body: &str,
) -> (u16, Option<String>, String) {
    let mut stream = TcpStream::connect(addr).expect("连 TCP");
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nConnection: close\r\n\
         Content-Length: {}\r\n",
        body.len()
    );
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if let Some(session) = session {
        request.push_str(&format!("mcp-session-id: {session}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).expect("写请求");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("读响应");
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let session_id = text.lines().find_map(|line| {
        let lower = line.to_ascii_lowercase();
        lower
            .strip_prefix("mcp-session-id:")
            .map(|value| value.trim().to_owned())
    });
    let body = text.split("\r\n\r\n").nth(1).unwrap_or_default().to_owned();
    (status, session_id, body)
}

/// 从 SSE 或 JSON 响应里取出 JSON-RPC 消息。
fn parse_rpc(body: &str) -> Value {
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("data: ")
            && let Ok(value) = serde_json::from_str::<Value>(rest.trim())
            && value.get("jsonrpc").is_some()
        {
            return value;
        }
    }
    serde_json::from_str(body.trim()).unwrap_or(Value::Null)
}

/// 走一遍 `/mcp` 的 initialize → initialized → tools/list → tools/call。
fn http_handshake(env: &Env, version: &str) -> (String, Value) {
    let addr = env.base_url();
    let (status, session, body) = http_call(
        &addr,
        "/mcp",
        Some(&env.token),
        None,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": version,
                "capabilities": {},
                "clientInfo": {"name": "remote", "version": "1.0"},
            }
        })
        .to_string(),
    );
    assert_eq!(status, 200, "initialize 应成功:{status} {body}");
    let session = session.expect("应返回 mcp-session-id");
    let response = parse_rpc(&body);
    assert!(response.get("error").is_none(), "{version}: {response}");

    // notifications/initialized(通知没有响应体)
    let (status, _, _) = http_call(
        &addr,
        "/mcp",
        Some(&env.token),
        Some(&session),
        &json!({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}).to_string(),
    );
    assert!(status == 200 || status == 202, "initialized 状态 {status}");
    (session, response)
}

#[test]
fn http_mcp_handshake_works_for_every_known_protocol_version() {
    let mut env = Env::new();
    env.prepare();

    for version in ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"] {
        let (session, response) = http_handshake(&env, version);
        assert_eq!(
            response["result"]["protocolVersion"], version,
            "{version}: 协商版本应与请求一致"
        );
        assert!(response["result"]["capabilities"]["tools"].is_object());

        let (status, _, body) = http_call(
            &env.base_url(),
            "/mcp",
            Some(&env.token),
            Some(&session),
            &json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}).to_string(),
        );
        assert_eq!(status, 200, "{version}: {body}");
        let tools = parse_rpc(&body);
        let names: Vec<&str> = tools["result"]["tools"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|tool| tool["name"].as_str())
            .collect();
        assert_eq!(
            names.len(),
            15,
            "{version}: 远程 /mcp 应有 15 个工具(不含 agent_history): {names:?}"
        );
        // 引用图谱一组(51d66eaf)远程也开着
        assert!(
            ["doc_links", "list_files", "check_links"]
                .iter()
                .all(|name| names.contains(name)),
            "{version}: 缺引用图谱工具:{names:?}"
        );
        // 读改在线文档的一组远程也开着
        assert!(
            names.contains(&"doc_read") && names.contains(&"doc_edit"),
            "{names:?}"
        );
        assert!(
            !names.contains(&"agent_history"),
            "{version}: 远程 /mcp 不能列出 agent_history"
        );
    }
}

#[test]
fn http_mcp_unknown_version_negotiates_down() {
    let mut env = Env::new();
    env.prepare();
    let (_session, response) = http_handshake(&env, "2025-07-01");
    let negotiated = response["result"]["protocolVersion"]
        .as_str()
        .expect("版本");
    let known = [
        "2024-11-05",
        "2025-03-26",
        "2025-06-18",
        "2025-11-25",
        "2026-07-28",
    ];
    assert!(known.contains(&negotiated), "应协商到已知版本:{negotiated}");
    println!("[/mcp] 未知版本 2025-07-01 协商为 {negotiated}");
}

#[test]
fn http_mcp_requires_a_token() {
    let mut env = Env::new();
    env.prepare();
    let body = json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}).to_string();

    let (status, _, _) = http_call(&env.base_url(), "/mcp", None, None, &body);
    assert_eq!(status, 401, "无 token 应 401");
    let (status, _, _) = http_call(&env.base_url(), "/mcp", Some("wrong"), None, &body);
    assert_eq!(status, 401, "错 token 应 401");
    let (status, _, _) = http_call(&env.base_url(), "/mcp", Some(&env.token), None, &body);
    assert_ne!(status, 401, "对 token 不应被鉴权拦下");
}

#[test]
fn stdio_and_http_return_the_same_results() {
    let mut env = Env::new();
    env.prepare();

    // 通过 stdio 保存一条 insight 并等它入库
    let (mut mcp, _) = full_handshake(&env, "2025-06-18");
    let saved = mcp.request(
        "tools/call",
        json!({
            "name": "save_insight",
            "arguments": {"title": "双模式一致性探针", "body": "stdio 与 /mcp 应返回同一组结果", "global": true},
        }),
    );
    assert!(saved.get("error").is_none(), "{saved}");
    std::thread::sleep(Duration::from_secs(2));

    let query = json!({
        "name": "search_knowledge",
        "arguments": {"query": "双模式一致性探针", "k": 5},
    });
    let stdio = mcp.request("tools/call", query.clone());
    let stdio_text = stdio["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let stdio_ids: Vec<String> = stdio_text
        .lines()
        .filter(|line| line.starts_with('['))
        .filter_map(|line| {
            line.split("id=").nth(1).map(|rest| {
                rest.split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            })
        })
        .collect();
    assert!(!stdio_ids.is_empty(), "stdio 应有结果:{stdio_text}");

    // 同样的查询走 /mcp
    let (session, _) = http_handshake(&env, "2025-06-18");
    let (status, _, body) = http_call(
        &env.base_url(),
        "/mcp",
        Some(&env.token),
        Some(&session),
        &json!({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": query}).to_string(),
    );
    assert_eq!(status, 200, "{body}");
    let http_text = parse_rpc(&body)["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let http_ids: Vec<String> = http_text
        .lines()
        .filter(|line| line.starts_with('['))
        .filter_map(|line| {
            line.split("id=").nth(1).map(|rest| {
                rest.split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            })
        })
        .collect();
    assert_eq!(stdio_ids, http_ids, "两种模式应返回同一组命中");
}

#[test]
fn stdio_features_gate_the_tool_list() {
    let mut env = Env::new();
    env.prepare();

    let mut mcp = Mcp::start_with_args(env.home(), &["--features", "knowledge"]);
    let response = initialize(&mut mcp, "2025-06-18");
    assert!(response.get("error").is_none(), "{response}");
    mcp.notify("notifications/initialized", json!({}));

    let tools = mcp.request("tools/list", json!({}));
    let names: Vec<&str> = tools["result"]["tools"]
        .as_array()
        .expect("工具列表")
        .iter()
        .filter_map(|tool| tool["name"].as_str())
        .collect();
    assert_eq!(names.len(), 6, "knowledge 组应有 6 个工具:{names:?}");
    assert!(names.contains(&"search_knowledge"));
    assert!(
        !names.contains(&"save_insight"),
        "没启用的组不应出现:{names:?}"
    );

    // 调未启用的工具:返回 isError,而不是真的写进去
    let saved = mcp.request(
        "tools/call",
        json!({"name": "save_insight", "arguments": {"title": "x", "body": "y", "global": true}}),
    );
    let text = serde_json::to_string(&saved).expect("序列化");
    assert!(text.contains("tool disabled"), "{text}");
}
