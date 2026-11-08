//! 用户 admin key 的守护进程级验收:真实进程、真实 HTTP,只带 `Authorization: Bearer`(不带 cookie 和 CSRF 头)。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_admin_key`

#![cfg(feature = "testkit")]

mod support;

use serde_json::{Value, json};
use support::{Harness, http, http_raw};

/// 只带 Bearer 发请求:没有 cookie,没有 CSRF 头,像一个纯 API 客户端。
fn bearer(h: &Harness, method: &str, path: &str, key: &str, body: Option<Value>) -> (u16, Value) {
    let auth = format!("Bearer {key}");
    let (status, _, bytes) = http_raw(h.port(), method, path, &[("Authorization", &auth)], body);
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

/// 用 admin key 调一个能力;成功返回 `data`,失败返回整个错误体。
fn call(h: &Harness, key: &str, name: &str, args: Value) -> (u16, Value) {
    let (status, body) = bearer(
        h,
        "POST",
        &format!("/api/v1/capabilities/{name}"),
        key,
        Some(args),
    );
    match body.get("data") {
        Some(data) if body["ok"] == true => (status, data.clone()),
        _ => (status, body),
    }
}

/// 浏览器里(会话 cookie)读自己的 admin key。
fn key_of(h: &Harness, who: &str) -> String {
    let (status, _, body) = http(
        h.port(),
        "GET",
        "/api/v1/me/admin-key",
        Some(h.cookie(who)),
        None,
    );
    assert_eq!(status, 200, "{who} 读 admin key:{body}");
    body["data"]["admin_key"]
        .as_str()
        .expect("admin_key")
        .to_owned()
}

#[test]
fn every_user_has_a_distinct_key_that_works_with_nothing_but_the_header() {
    let h = Harness::start();
    let keys: Vec<String> = ["admin", "alice", "bob", "carol"]
        .iter()
        .map(|who| key_of(&h, who))
        .collect();
    for key in &keys {
        assert!(key.starts_with("kb_ak_"), "{key}");
    }
    let mut unique = keys.clone();
    unique.sort();
    unique.dedup();
    assert_eq!(unique.len(), 4, "一人一把:{keys:?}");
    // 只带请求头:认得出是谁,而且不需要 CSRF 头
    let (status, me) = bearer(&h, "GET", "/api/v1/auth/me", &keys[1], None);
    assert_eq!(status, 200, "{me}");
    assert_eq!(me["data"]["user"]["username"], "alice");
    // POST 也不需要 CSRF 头
    let (status, _) = call(&h, &keys[1], "list_collections", json!({}));
    assert_eq!(status, 200);
    // 瞎写的 key:401
    let (status, body) = bearer(
        &h,
        "GET",
        "/api/v1/auth/me",
        "kb_ak_00000000000000000000000000000000000000000000dead",
        None,
    );
    assert_eq!(status, 401, "{body}");
}

/// 发一个 `/mcp` 请求,返回 (状态码, mcp-session-id, 响应体文本)。
fn mcp_post(
    h: &Harness,
    token: &str,
    session: Option<&str>,
    body: &Value,
) -> (u16, Option<String>, String) {
    let auth = format!("Bearer {token}");
    let mut headers = vec![
        ("Authorization", auth.as_str()),
        ("Accept", "application/json, text/event-stream"),
    ];
    if let Some(session) = session {
        headers.push(("mcp-session-id", session));
    }
    let (status, head, bytes) = http_raw(h.port(), "POST", "/mcp", &headers, Some(body.clone()));
    let session = head.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("mcp-session-id:")
            .map(|value| value.trim().to_owned())
    });
    (
        status,
        session,
        String::from_utf8_lossy(&bytes).into_owned(),
    )
}

fn initialize(h: &Harness, token: &str) -> (u16, Option<String>, String) {
    mcp_post(
        h,
        token,
        None,
        &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "e2e", "version": "1" } } }),
    )
}

#[test]
fn the_key_does_what_the_owner_can_do_including_admin_class_calls_a_plain_token_cannot() {
    let h = Harness::start();
    let admin_key = key_of(&h, "admin");
    // 管理级能力(A):admin key 等同本人在浏览器里,可以调
    let (status, body) = call(&h, &admin_key, "reload_skills", json!({ "confirm": true }));
    assert_eq!(status, 200, "admin key 应能调管理级能力:{body}");
    // 同一个人的 api 令牌调不了(令牌自己的上限)
    let (status, body) = bearer(
        &h,
        "POST",
        "/api/v1/auth/tokens",
        &admin_key,
        Some(json!({ "name": "scripts", "scope": "api" })),
    );
    assert_eq!(status, 200, "{body}");
    let api_token = body["data"]["token"].as_str().expect("令牌明文").to_owned();
    let (status, body) = call(&h, &api_token, "reload_skills", json!({ "confirm": true }));
    assert_eq!(status, 403, "api 令牌不能调管理级能力:{body}");
    // 普通用户没有这个功能点:有 key 也不行(key 不放大权限)
    let alice_key = key_of(&h, "alice");
    let (status, body) = call(&h, &alice_key, "reload_skills", json!({ "confirm": true }));
    assert_eq!(status, 403, "alice 没有 sys.settings:{body}");
    assert!(body.to_string().contains("没有开通"), "{body}");
}

#[test]
fn the_key_creates_an_mcp_token_that_connects_but_the_key_itself_cannot_connect_to_mcp() {
    let h = Harness::start_with_mcp();
    let key = key_of(&h, "alice");
    let (status, body) = bearer(
        &h,
        "POST",
        "/api/v1/auth/tokens",
        &key,
        Some(json!({ "name": "claude", "scope": "mcp" })),
    );
    assert_eq!(status, 200, "{body}");
    let token = body["data"]["token"].as_str().expect("令牌明文").to_owned();
    let token_id = body["data"]["id"].as_str().expect("令牌 id").to_owned();
    assert!(
        token.starts_with("kb_") && !token.starts_with("kb_ak_"),
        "MCP 令牌和 admin key 是两种东西"
    );
    // 令牌能握手
    let (status, session, text) = initialize(&h, &token);
    assert_eq!(status, 200, "{text}");
    assert!(session.is_some());
    // admin key 直接接 MCP:401,并且提示该怎么做
    let (status, _, text) = initialize(&h, &key);
    assert_eq!(status, 401, "{text}");
    assert!(
        text.contains("scope=mcp"),
        "要告诉调用方先创建 mcp 令牌:{text}"
    );
    // 列表里能看到、能撤销;撤销后令牌失效
    let (status, listed) = bearer(&h, "GET", "/api/v1/auth/tokens", &key, None);
    assert_eq!(status, 200);
    assert!(listed.to_string().contains("claude"), "{listed}");
    let (status, _) = bearer(
        &h,
        "DELETE",
        &format!("/api/v1/auth/tokens/{token_id}"),
        &key,
        None,
    );
    assert_eq!(status, 200);
    let (status, _, _) = initialize(&h, &token);
    assert_eq!(status, 401, "撤销后令牌失效");
}

#[test]
fn a_key_only_reaches_its_owners_data() {
    let h = Harness::start();
    let alice = key_of(&h, "alice");
    let bob = key_of(&h, "bob");
    let (status, saved) = call(
        &h,
        &alice,
        "create_item",
        json!({ "collection": "_global", "title": "只有 alice 的笔记", "body": "秘密正文", "kind": "note" }),
    );
    assert_eq!(status, 200, "{saved}");
    let id = saved["id"].as_str().expect("id").to_owned();
    let (status, own) = call(&h, &alice, "get_item", json!({ "id": id }));
    assert_eq!(status, 200, "{own}");
    // bob 的 key 读不到 alice 的笔记
    let (status, other) = call(&h, &bob, "get_item", json!({ "id": id }));
    assert_ne!(status, 200, "bob 不该读到 alice 的笔记:{other}");
    assert!(!other.to_string().contains("秘密正文"), "{other}");
    // 也搜不到
    let (_, hits) = call(
        &h,
        &bob,
        "search_knowledge",
        json!({ "query": "秘密正文", "k": 10 }),
    );
    assert!(!hits.to_string().contains("只有 alice 的笔记"), "{hits}");
}

#[test]
fn rotating_kills_the_old_key_for_every_route_and_leaves_other_people_alone() {
    let h = Harness::start();
    let old = key_of(&h, "alice");
    let bobs = key_of(&h, "bob");
    // 用 key 自己轮换(AI 自己换 key 也行)
    let (status, body) = bearer(&h, "POST", "/api/v1/me/admin-key/rotate", &old, None);
    assert_eq!(status, 200, "{body}");
    let fresh = body["data"]["admin_key"]
        .as_str()
        .expect("新 key")
        .to_owned();
    assert_ne!(fresh, old);
    assert!(body["data"]["rotated_at"].is_number());
    let (status, _) = bearer(&h, "GET", "/api/v1/auth/me", &old, None);
    assert_eq!(status, 401, "旧 key 立刻失效");
    let (status, _) = call(&h, &old, "list_collections", json!({}));
    assert_eq!(status, 401);
    let (status, me) = bearer(&h, "GET", "/api/v1/auth/me", &fresh, None);
    assert_eq!(
        (status, me["data"]["user"]["username"].as_str()),
        (200, Some("alice"))
    );
    assert_eq!(key_of(&h, "alice"), fresh, "浏览器里读到的也是新的");
    let (status, _) = bearer(&h, "GET", "/api/v1/auth/me", &bobs, None);
    assert_eq!(status, 200, "别人的 key 不受影响");
}

#[test]
fn a_disabled_account_loses_its_key_and_ordinary_tokens_cannot_read_the_key() {
    let h = Harness::start();
    let admin = key_of(&h, "admin");
    let alice = key_of(&h, "alice");
    // 普通访问令牌读不到 admin key(否则限权的令牌就能换出全权凭据)
    let (_, body) = bearer(
        &h,
        "POST",
        "/api/v1/auth/tokens",
        &alice,
        Some(json!({ "name": "t", "scope": "api" })),
    );
    let token = body["data"]["token"].as_str().expect("令牌").to_owned();
    let (status, body) = bearer(&h, "GET", "/api/v1/me/admin-key", &token, None);
    assert_eq!(status, 403, "{body}");
    assert!(!body.to_string().contains("kb_ak_"));
    let (status, _) = bearer(&h, "POST", "/api/v1/me/admin-key/rotate", &token, None);
    assert_eq!(status, 403, "令牌也不能轮换");
    let (status, _) = bearer(&h, "GET", "/api/v1/me/ai-guide", &token, None);
    assert_eq!(status, 403, "令牌也拿不到指南(里面有 key)");
    // 停用账号:key 立刻不能用
    let (status, body) = call(
        &h,
        &admin,
        "user_update",
        json!({ "id": h.id("alice"), "status": "disabled" }),
    );
    assert_eq!(status, 200, "{body}");
    let (status, _) = bearer(&h, "GET", "/api/v1/auth/me", &alice, None);
    assert_eq!(status, 401, "停用后 key 失效");
    let (status, _) = call(
        &h,
        &admin,
        "user_update",
        json!({ "id": h.id("alice"), "status": "active" }),
    );
    assert_eq!(status, 200);
    let (status, _) = bearer(&h, "GET", "/api/v1/auth/me", &alice, None);
    assert_eq!(status, 200, "恢复账号后同一把 key 又能用");
}

#[test]
fn the_guide_is_personal_downloadable_and_lists_only_what_the_account_can_call() {
    let h = Harness::start();
    let alice = key_of(&h, "alice");
    let admin = key_of(&h, "admin");
    let auth = format!("Bearer {alice}");
    let (status, head, bytes) = http_raw(
        h.port(),
        "GET",
        "/api/v1/me/ai-guide?download=1",
        &[("Authorization", &auth)],
        None,
    );
    assert_eq!(status, 200);
    let text = String::from_utf8(bytes).expect("UTF-8");
    let head = head.to_ascii_lowercase();
    assert!(
        head.contains("content-disposition: attachment")
            && head.contains("knowledgebase-ai-guide.md"),
        "{head}"
    );
    assert!(
        head.contains("text/markdown") && head.contains("no-store"),
        "{head}"
    );
    assert!(text.contains(&alice), "指南里要带本人的 key");
    assert!(!text.contains(&admin), "不能带别人的 key");
    assert!(text.contains("alice"));
    // 清单:有基础能力、没有 alice 没开通的系统管理能力、没有旧令牌能力
    for name in ["search_knowledge", "save_insight", "get_item"] {
        assert!(text.contains(&format!("**{name}**")), "缺少 {name}");
    }
    assert!(
        !text.contains("**user_create**"),
        "普通用户的指南里不该列系统管理接口"
    );
    assert!(!text.contains("**create_token**"), "旧的令牌能力不该出现");
    // 管理员的指南里有系统管理接口,而且 key 是他自己的
    let (_, _, bytes) = http_raw(
        h.port(),
        "GET",
        "/api/v1/me/ai-guide",
        &[("Authorization", &format!("Bearer {admin}"))],
        None,
    );
    let admin_text = String::from_utf8(bytes).expect("UTF-8");
    assert!(
        admin_text.contains("**user_create**")
            && admin_text.contains(&admin)
            && !admin_text.contains(&alice)
    );
    // 不带 download 时是直接返回文本,不是附件
    let (_, head, _) = http_raw(
        h.port(),
        "GET",
        "/api/v1/me/ai-guide",
        &[("Authorization", &auth)],
        None,
    );
    assert!(
        !head.to_ascii_lowercase().contains("content-disposition"),
        "{head}"
    );
    // 没登录:401
    let (status, _, _) = http_raw(h.port(), "GET", "/api/v1/me/ai-guide", &[], None);
    assert_eq!(status, 401);
}

#[test]
fn the_guides_base_address_follows_the_proxy_headers_then_the_page_origin_and_ignores_junk() {
    let h = Harness::start();
    let key = key_of(&h, "alice");
    let auth = format!("Bearer {key}");
    let get = |path: &str, extra: &[(&str, &str)]| {
        let mut headers = vec![("Authorization", auth.as_str())];
        headers.extend_from_slice(extra);
        String::from_utf8(http_raw(h.port(), "GET", path, &headers, None).2).expect("UTF-8")
    };
    // 反向代理转发的 Host / 协议
    let text = get(
        "/api/v1/me/ai-guide",
        &[
            ("X-Forwarded-Host", "kb.proxy.test"),
            ("X-Forwarded-Proto", "https"),
        ],
    );
    assert!(
        text.contains("| 站点地址 | `https://kb.proxy.test` |"),
        "{}",
        &text[..text.len().min(900)]
    );
    // 页面自己报的 origin 优先
    let text = get(
        "/api/v1/me/ai-guide?base=https%3A%2F%2Fpage.example.com",
        &[("X-Forwarded-Host", "kb.proxy.test")],
    );
    assert!(text.contains("`https://page.example.com`"));
    // 带路径 / 查询的不是合法站点地址:忽略,退回转发头
    let text = get(
        "/api/v1/me/ai-guide?base=https%3A%2F%2Fevil.test%2Fx%3Fy%3D1",
        &[
            ("X-Forwarded-Host", "kb.proxy.test"),
            ("X-Forwarded-Proto", "https"),
        ],
    );
    assert!(!text.contains("evil.test") && text.contains("https://kb.proxy.test"));
}

/// 从指南里抠出自测脚本(```python 到下一个 ``` 之间)。
fn selftest_script(guide: &str) -> String {
    let start = guide.find("```python\n").expect("指南里有 python 代码块") + "```python\n".len();
    let end = start + guide[start..].find("\n```").expect("代码块有结尾");
    guide[start..end].to_owned()
}

#[test]
fn the_selftest_script_in_the_guide_really_connects_writes_reads_and_cleans_up() {
    let h = Harness::start_with_mcp();
    let key = key_of(&h, "alice");
    let auth = format!("Bearer {key}");
    let (status, _, bytes) = http_raw(
        h.port(),
        "GET",
        "/api/v1/me/ai-guide",
        &[("Authorization", &auth)],
        None,
    );
    assert_eq!(status, 200);
    let guide = String::from_utf8(bytes).expect("UTF-8");
    let dir = tempfile::tempdir().expect("临时目录");
    let path = dir.path().join("kb_selftest.py");
    std::fs::write(&path, selftest_script(&guide)).expect("写脚本");

    let output = std::process::Command::new("python3")
        .arg(&path)
        .output()
        .expect("需要 python3 才能跑指南里的自测脚本");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "自测脚本失败:\n{stdout}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(stdout.contains("全部通过"), "{stdout}");
    for step in [
        "admin key 有效",
        "创建临时 MCP 令牌",
        "MCP initialize",
        "MCP save_insight",
        "读回测试经验",
        "清理:删除测试经验",
        "清理:撤销临时令牌",
    ] {
        assert!(stdout.contains(step), "输出里缺少「{step}」:\n{stdout}");
    }
    assert!(!stdout.contains("[FAIL]"), "{stdout}");

    // 脚本说清理了就真的清理了:没有残留的测试经验、没有有效的临时令牌
    let (status, listed) = call(
        &h,
        &key,
        "list_items",
        json!({ "collection": "_global", "q": "kb-selftest" }),
    );
    assert_eq!(status, 200, "{listed}");
    assert!(
        !listed.to_string().contains("kb-selftest"),
        "测试经验没清干净:{listed}"
    );
    let (_, tokens) = bearer(&h, "GET", "/api/v1/auth/tokens", &key, None);
    let live: Vec<&Value> = tokens["data"]["tokens"]
        .as_array()
        .expect("令牌列表")
        .iter()
        .filter(|t| {
            t["name"]
                .as_str()
                .is_some_and(|n| n.starts_with("kb-selftest-"))
                && t["revoked_at"].is_null()
        })
        .collect();
    assert!(live.is_empty(), "临时令牌没撤销:{live:?}");
}

#[test]
fn two_selftest_runs_of_the_same_account_at_once_do_not_collide_or_clean_up_each_other() {
    let h = Harness::start_with_mcp();
    let key = key_of(&h, "alice");
    let auth = format!("Bearer {key}");
    let (_, _, bytes) = http_raw(
        h.port(),
        "GET",
        "/api/v1/me/ai-guide",
        &[("Authorization", &auth)],
        None,
    );
    let guide = String::from_utf8(bytes).expect("UTF-8");
    let dir = tempfile::tempdir().expect("临时目录");
    let path = dir.path().join("kb_selftest.py");
    std::fs::write(&path, selftest_script(&guide)).expect("写脚本");
    // 同一个账号同时跑 3 份:令牌名、测试经验标题都带各自的运行编号,不能撞名(409),也不能把对方的数据清掉
    let children: Vec<_> = (0..3)
        .map(|_| {
            std::process::Command::new("python3")
                .arg(&path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("需要 python3")
        })
        .collect();
    let mut run_ids = Vec::new();
    for child in children {
        let output = child.wait_with_output().expect("等待脚本");
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        assert!(
            output.status.success(),
            "并发自测失败:\n{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(
            stdout.contains("全部通过") && !stdout.contains("[FAIL]"),
            "{stdout}"
        );
        let id = stdout
            .lines()
            .find_map(|line| line.strip_prefix("本次运行编号 "))
            .and_then(|rest| rest.split('(').next())
            .expect("输出里有运行编号")
            .to_owned();
        run_ids.push(id);
    }
    run_ids.sort();
    run_ids.dedup();
    assert_eq!(run_ids.len(), 3, "每次运行的编号应不同");
    // 全部清理干净
    let (_, tokens) = bearer(&h, "GET", "/api/v1/auth/tokens", &key, None);
    let live = tokens["data"]["tokens"]
        .as_array()
        .expect("令牌列表")
        .iter()
        .filter(|t| {
            t["name"]
                .as_str()
                .is_some_and(|n| n.starts_with("kb-selftest-"))
                && t["revoked_at"].is_null()
        })
        .count();
    assert_eq!(live, 0, "临时令牌没撤销干净");
}
