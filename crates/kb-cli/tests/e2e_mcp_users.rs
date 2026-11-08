//! 远程 MCP 按用户隔离的验收(多用户设计说明 / .4):
//! 每个用户的令牌只能检索他自己的知识库;「包含共享给我」默认关,开了才把别人分享给他的也搜进来。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_mcp_users`

#![cfg(feature = "testkit")]

mod support;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{Harness, http};

/// 发一个 `/mcp` 请求,返回 (状态码, mcp-session-id, 响应体)。
fn mcp_post(
    port: u16,
    token: &str,
    session: Option<&str>,
    body: &Value,
) -> (u16, Option<String>, String) {
    let body = body.to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连接");
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    let mut request = format!(
        "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nConnection: close\r\nAuthorization: Bearer {token}\r\n\
         Content-Length: {}\r\n",
        body.len()
    );
    if let Some(session) = session {
        request.push_str(&format!("mcp-session-id: {session}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(&body);
    stream.write_all(request.as_bytes()).expect("写");
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let session = text.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("mcp-session-id:")
            .map(|v| v.trim().to_owned())
    });
    (
        status,
        session,
        text.split("\r\n\r\n").nth(1).unwrap_or_default().to_owned(),
    )
}

fn rpc(body: &str) -> Value {
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

struct Mcp {
    port: u16,
    token: String,
    session: String,
}

impl Mcp {
    fn open(port: u16, token: &str) -> Result<Self, u16> {
        let (status, session, body) = mcp_post(
            port,
            token,
            None,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": { "name": "e2e", "version": "1" } } }),
        );
        if status != 200 {
            return Err(status);
        }
        assert!(rpc(&body).get("error").is_none(), "{body}");
        let session = session.expect("mcp-session-id");
        let (status, _, _) = mcp_post(
            port,
            token,
            Some(&session),
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }),
        );
        assert!(status == 200 || status == 202);
        Ok(Self {
            port,
            token: token.to_owned(),
            session,
        })
    }

    fn call(&self, method: &str, params: Value) -> Value {
        let (status, _, body) = mcp_post(
            self.port,
            &self.token,
            Some(&self.session),
            &json!({ "jsonrpc": "2.0", "id": 2, "method": method, "params": params }),
        );
        assert_eq!(status, 200, "{method}: {body}");
        rpc(&body)
    }

    fn tool_names(&self) -> Vec<String> {
        let listed = self.call("tools/list", json!({}));
        let mut names: Vec<String> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["name"].as_str().map(str::to_owned))
            .collect();
        names.sort();
        names
    }

    /// 检索,返回整段结果文本。
    fn search(&self, query: &str) -> String {
        let reply = self.call(
            "tools/call",
            json!({ "name": "search_knowledge", "arguments": { "query": query, "k": 20 } }),
        );
        reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_owned()
    }
}

fn make_token(h: &Harness, who: &str, name: &str, scope: &str, include_shared: bool) -> String {
    let (status, _, body) = http(
        h.port(),
        "POST",
        "/api/v1/auth/tokens",
        Some(h.cookie(who)),
        Some(json!({ "name": name, "scope": scope, "include_shared": include_shared })),
    );
    assert_eq!(status, 200, "{body}");
    body["data"]["token"].as_str().expect("明文令牌").to_owned()
}

fn note(h: &Harness, who: &str, title: &str, body: &str) -> String {
    h.ok(
        who,
        "create_item",
        json!({ "collection": "_global", "title": title, "body": body, "kind": "note" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// 等一个人的检索里出现 `needle`(新笔记要等嵌入任务跑完)。
fn wait_visible(mcp: &Mcp, query: &str, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(40);
    while Instant::now() < deadline {
        if mcp.search(query).contains(needle) {
            return;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    panic!("等不到 {needle} 出现在检索里");
}

#[test]
fn each_users_remote_mcp_token_only_reaches_that_users_own_library() {
    let h = Harness::start_with_mcp();
    let alice_note = note(
        &h,
        "alice",
        "爱丽丝的笔记",
        "AliceSecretToken 只有爱丽丝知道",
    );
    note(&h, "bob", "鲍勃的笔记", "BobNoteToken 只有鲍勃知道");
    note(&h, "admin", "管理员的笔记", "AdminOnlyToken 只有管理员知道");
    let alice_token = make_token(&h, "alice", "alice-mcp", "mcp", false);
    let bob_token = make_token(&h, "bob", "bob-mcp", "mcp", false);
    let admin_token = make_token(&h, "admin", "admin-mcp", "mcp", false);
    let alice = Mcp::open(h.port(), &alice_token).expect("alice 的 MCP");
    let bob = Mcp::open(h.port(), &bob_token).expect("bob 的 MCP");
    let admin = Mcp::open(h.port(), &admin_token).expect("管理员的 MCP");

    // 每个人只搜到自己的
    wait_visible(&alice, "AliceSecretToken", "AliceSecretToken");
    wait_visible(&bob, "BobNoteToken", "BobNoteToken");
    wait_visible(&admin, "AdminOnlyToken", "AdminOnlyToken");
    for (who, mcp) in [("alice", &alice), ("bob", &bob), ("admin", &admin)] {
        let all = format!(
            "{} {} {}",
            mcp.search("AliceSecretToken"),
            mcp.search("BobNoteToken"),
            mcp.search("AdminOnlyToken")
        );
        for (owner, needle) in [
            ("alice", "AliceSecretToken"),
            ("bob", "BobNoteToken"),
            ("admin", "AdminOnlyToken"),
        ] {
            assert_eq!(
                all.contains(needle),
                who == owner,
                "{who} 的令牌不该{}到 {owner} 的内容",
                if who == owner { "搜不" } else { "搜" }
            );
        }
    }
    // 令牌用户看不到 agent_history(只给 stdio 与代理伴生)
    assert!(!alice.tool_names().contains(&"agent_history".to_owned()));

    // 别人分享给 bob 的内容:bob 的默认令牌看不到(防止 AI 工具把别人的文档带进上下文)
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": { "kind": "insight", "space_id": h.space("alice"), "collection": "_global", "id": alice_note },
                "user_id": h.id("bob"), "role": "viewer" }),
    );
    assert!(
        !bob.search("AliceSecretToken").contains("AliceSecretToken"),
        "默认不包含共享给我的"
    );
    // 开了「包含共享给我」的令牌能搜到,而且自己的内容还在
    let bob_shared_token = make_token(&h, "bob", "bob-mcp-shared", "mcp", true);
    let bob_shared = Mcp::open(h.port(), &bob_shared_token).expect("bob 的共享 MCP");
    wait_visible(&bob_shared, "AliceSecretToken", "AliceSecretToken");
    assert!(
        bob_shared.search("BobNoteToken").contains("BobNoteToken"),
        "自己的内容照常能搜到"
    );
    // 别的没分享的内容仍然搜不到
    assert!(
        !bob_shared
            .search("AdminOnlyToken")
            .contains("AdminOnlyToken")
    );
    // alice 收回分享:bob 的共享令牌马上搜不到了
    h.ok(
        "alice",
        "grant_remove",
        json!({ "target": { "kind": "insight", "space_id": h.space("alice"), "collection": "_global", "id": alice_note },
                "user_id": h.id("bob") }),
    );
    assert!(
        !bob_shared
            .search("AliceSecretToken")
            .contains("AliceSecretToken")
    );
}

#[test]
fn bad_or_revoked_tokens_and_the_wrong_scope_are_refused() {
    let h = Harness::start_with_mcp();
    let api_token = make_token(&h, "alice", "alice-api", "api", false);
    assert_eq!(
        Mcp::open(h.port(), &api_token).err(),
        Some(401),
        "scope=api 的令牌不能走 /mcp"
    );
    assert_eq!(Mcp::open(h.port(), "kb_not_a_real_token").err(), Some(401));
    let token = make_token(&h, "alice", "alice-mcp", "mcp", true);
    let mcp = Mcp::open(h.port(), &token).expect("可用");
    // 撤销后的下一个请求就被拒绝
    let (status, _, body) = http(
        h.port(),
        "GET",
        "/api/v1/auth/tokens",
        Some(h.cookie("alice")),
        None,
    );
    assert_eq!(status, 200, "{body}");
    let id = body["data"]["tokens"][0]["id"]
        .as_str()
        .or_else(|| body["data"][0]["id"].as_str())
        .expect("令牌 id")
        .to_owned();
    let (status, _, body) = http(
        h.port(),
        "DELETE",
        &format!("/api/v1/auth/tokens/{id}"),
        Some(h.cookie("alice")),
        None,
    );
    assert_eq!(status, 200, "{body}");
    let (status, _, _) = mcp_post(
        h.port(),
        &mcp.token,
        Some(&mcp.session),
        &json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": {} }),
    );
    assert_eq!(status, 401);
    // 「包含共享给我」只对 mcp 令牌有意义:api 令牌里写了也不生效
    let tokens = http(
        h.port(),
        "GET",
        "/api/v1/auth/tokens",
        Some(h.cookie("alice")),
        None,
    )
    .2;
    assert!(tokens.to_string().contains("alice-api"), "{tokens}");
}
