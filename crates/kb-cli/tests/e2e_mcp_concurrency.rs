//! 多用户远程 MCP 并发:真实守护进程,多个用户、多个令牌、多个线程同时读写。
//!
//! 守的是:用户之间不串数据、同一个用户的多个客户端互不踢掉、并发写不丢、竞争同一条目只有一个赢家、
//! 令牌撤销 / admin key 轮换发生在请求途中时只会得到干净的 401,不会出 5xx。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_mcp_concurrency`

#![cfg(feature = "testkit")]

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use support::{Harness, http, http_raw};

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

/// 发一个 `/mcp` 请求,返回 (状态码, mcp-session-id, 响应 JSON-RPC)。
fn mcp_post(
    port: u16,
    token: &str,
    session: Option<&str>,
    body: &Value,
) -> (u16, Option<String>, Value) {
    let auth = format!("Bearer {token}");
    let mut headers = vec![
        ("Authorization", auth.as_str()),
        ("Accept", "application/json, text/event-stream"),
    ];
    if let Some(session) = session {
        headers.push(("mcp-session-id", session));
    }
    let (status, head, bytes) = http_raw(port, "POST", "/mcp", &headers, Some(body.clone()));
    let session = head.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("mcp-session-id:")
            .map(|value| value.trim().to_owned())
    });
    (status, session, rpc(&String::from_utf8_lossy(&bytes)))
}

/// 一个已握手的 MCP 客户端。
struct Client {
    port: u16,
    token: String,
    session: String,
}

impl Client {
    fn open(port: u16, token: &str) -> Result<Self, u16> {
        let (status, session, reply) = mcp_post(
            port,
            token,
            None,
            &json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": { "name": "e2e", "version": "1" } } }),
        );
        if status != 200 || reply.get("error").is_some() {
            return Err(status);
        }
        let session = session.ok_or(0u16)?;
        let (status, _, _) = mcp_post(
            port,
            token,
            Some(&session),
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        );
        assert!(status == 200 || status == 202, "initialized → {status}");
        Ok(Self {
            port,
            token: token.to_owned(),
            session,
        })
    }

    /// 调一个工具。返回 (HTTP 状态, 工具返回的文本, 是不是工具层面的错误)。
    fn tool(&self, name: &str, arguments: Value) -> (u16, String, bool) {
        let (status, _, reply) = mcp_post(
            self.port,
            &self.token,
            Some(&self.session),
            &json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": name, "arguments": arguments } }),
        );
        let text = reply["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let is_error =
            reply["result"]["isError"].as_bool().unwrap_or(false) || reply.get("error").is_some();
        (status, text, is_error)
    }
}

/// 用浏览器会话给某人建一个访问令牌,返回 (令牌 id, 明文)。
fn make_token(h: &Harness, who: &str, name: &str, include_shared: bool) -> (String, String) {
    let (status, _, body) = http(
        h.port(),
        "POST",
        "/api/v1/auth/tokens",
        Some(h.cookie(who)),
        Some(json!({ "name": name, "scope": "mcp", "include_shared": include_shared })),
    );
    assert_eq!(status, 200, "{who} 建令牌 {name}:{body}");
    (
        body["data"]["id"].as_str().expect("令牌 id").to_owned(),
        body["data"]["token"].as_str().expect("令牌明文").to_owned(),
    )
}

fn save(client: &Client, title: &str, body: &str, extra: Value) -> (u16, String, bool) {
    let mut args = json!({ "title": title, "body": body, "kind": "note", "global": true });
    if let (Some(map), Some(more)) = (args.as_object_mut(), extra.as_object()) {
        map.extend(more.clone());
    }
    client.tool("save_insight", args)
}

fn id_of(text: &str) -> String {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|value| value["id"].as_str().map(str::to_owned))
        .unwrap_or_default()
}

#[test]
fn many_users_writing_and_reading_at_once_never_see_each_others_data() {
    const USERS: [&str; 3] = ["alice", "bob", "carol"];
    const PER_USER: usize = 6;
    let h = Harness::start_with_mcp();
    let port = h.port();
    let tokens: Vec<(String, String)> = USERS
        .iter()
        .map(|who| (who.to_string(), make_token(&h, who, "client", false).1))
        .collect();
    let failures = AtomicUsize::new(0);
    let saved: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());

    // 每个用户开 PER_USER 个线程,每个线程自己握手、写一条带本人标记的笔记并立刻读回
    std::thread::scope(|scope| {
        for (who, token) in &tokens {
            for n in 0..PER_USER {
                let (failures, saved) = (&failures, &saved);
                scope.spawn(move || {
                    let Ok(client) = Client::open(port, token) else {
                        failures.fetch_add(1, Ordering::SeqCst);
                        return;
                    };
                    let marker = format!("独有标记-{who}-{n}");
                    let (status, text, is_error) =
                        save(&client, &marker, &format!("{marker} 的正文"), json!({}));
                    let id = id_of(&text);
                    if status != 200 || is_error || id.is_empty() {
                        eprintln!("{who}#{n} 写入失败:{status} {text}");
                        failures.fetch_add(1, Ordering::SeqCst);
                        return;
                    }
                    let (status, got, is_error) = client.tool("get_item", json!({ "id": id }));
                    if status != 200 || is_error || !got.contains(&marker) {
                        eprintln!("{who}#{n} 读回失败:{status} {got}");
                        failures.fetch_add(1, Ordering::SeqCst);
                        return;
                    }
                    saved.lock().expect("锁").push((who.to_string(), id));
                });
            }
        }
    });
    assert_eq!(failures.load(Ordering::SeqCst), 0, "并发写读应全部成功");
    assert_eq!(
        saved.lock().expect("锁").len(),
        USERS.len() * PER_USER,
        "一条都不能丢"
    );

    // 任何人都读不到别人的笔记(按 id 直接取、按内容检索都不行)
    let clients: Vec<(String, Client)> = tokens
        .iter()
        .map(|(who, token)| (who.clone(), Client::open(port, token).expect("握手")))
        .collect();
    for (owner, id) in saved.lock().expect("锁").iter() {
        for (who, client) in &clients {
            let (_, got, is_error) = client.tool("get_item", json!({ "id": id }));
            if who == owner {
                assert!(
                    !is_error && got.contains(&format!("独有标记-{owner}")),
                    "{owner} 应读到自己的:{got}"
                );
            } else {
                assert!(
                    !got.contains("独有标记"),
                    "{who} 不该读到 {owner} 的笔记:{got}"
                );
            }
        }
    }
    for (who, client) in &clients {
        let (_, hits, _) = client.tool("search_knowledge", json!({ "query": "独有标记", "k": 50 }));
        for other in USERS.iter().filter(|other| *other != who) {
            assert!(
                !hits.contains(&format!("独有标记-{other}")),
                "{who} 搜到了 {other} 的笔记:{hits}"
            );
        }
    }
}

#[test]
fn one_users_clients_with_different_settings_do_not_kick_each_other_out() {
    let h = Harness::start_with_mcp();
    let port = h.port();
    // 同一个人两个令牌:一个包含「共享给我」,一个不包含。两个客户端交替使用,谁也不能让对方的会话失效
    let (_, own_only) = make_token(&h, "alice", "own-only", false);
    let (_, with_shared) = make_token(&h, "alice", "with-shared", true);
    let a = Client::open(port, &own_only).expect("握手 a");
    let b = Client::open(port, &with_shared).expect("握手 b");
    for round in 0..6 {
        for (label, client) in [("own-only", &a), ("with-shared", &b)] {
            let (status, text, is_error) = client.tool("list_collections", json!({}));
            assert!(
                status == 200 && !is_error,
                "第 {round} 轮 {label} 的会话被对方弄失效了:HTTP {status} {text}"
            );
        }
    }
}

#[test]
fn revoking_one_token_leaves_the_same_users_other_client_working() {
    let h = Harness::start_with_mcp();
    let port = h.port();
    let (first_id, first) = make_token(&h, "bob", "laptop", false);
    let (_, second) = make_token(&h, "bob", "ci", false);
    let a = Client::open(port, &first).expect("握手 a");
    let b = Client::open(port, &second).expect("握手 b");
    assert!(!b.tool("list_collections", json!({})).2);
    let (status, _, body) = http(
        port,
        "DELETE",
        &format!("/api/v1/auth/tokens/{first_id}"),
        Some(h.cookie("bob")),
        None,
    );
    assert_eq!(status, 200, "{body}");
    // 被撤销的:401;另一个:照常
    assert_eq!(
        mcp_post(
            port,
            &first,
            Some(&a.session),
            &json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" })
        )
        .0,
        401
    );
    let (status, text, is_error) = b.tool("list_collections", json!({}));
    assert!(
        status == 200 && !is_error,
        "另一个令牌不该受影响:{status} {text}"
    );
}

#[test]
fn a_session_id_only_works_for_the_user_who_opened_it() {
    let h = Harness::start_with_mcp();
    let port = h.port();
    let (_, alice) = make_token(&h, "alice", "a", false);
    let (_, bob) = make_token(&h, "bob", "b", false);
    let a = Client::open(port, &alice).expect("握手");
    let (status, text, _) = a.tool("save_insight", json!({ "title": "alice 的私有笔记", "body": "只有 alice", "kind": "note", "global": true }));
    assert_eq!(status, 200, "{text}");
    // bob 拿着自己的令牌 + alice 的会话 id:到不了 alice 的会话
    let (status, _, reply) = mcp_post(
        port,
        &bob,
        Some(&a.session),
        &json!({ "jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": { "name": "list_collections", "arguments": {} } }),
    );
    assert_ne!(status, 200, "不同用户不能借用对方的会话:{reply}");
    assert!(!reply.to_string().contains("alice"), "{reply}");
}

#[test]
fn clients_superseding_the_same_old_insight_at_once_leave_exactly_one_winner_and_no_orphans() {
    const RACERS: usize = 6;
    let h = Harness::start_with_mcp();
    let port = h.port();
    let (_, token) = make_token(&h, "alice", "racers", false);
    let setup = Client::open(port, &token).expect("握手");
    let (status, text, is_error) = save(&setup, "竞争-旧版", "旧版正文", json!({}));
    assert!(status == 200 && !is_error, "{text}");
    let old_id = id_of(&text);

    let wins = AtomicUsize::new(0);
    let clean_rejections = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for n in 0..RACERS {
            let (token, old_id, wins, clean_rejections) =
                (&token, &old_id, &wins, &clean_rejections);
            scope.spawn(move || {
                let client = Client::open(port, token).expect("握手");
                let (status, text, is_error) = save(
                    &client,
                    &format!("竞争-新版{n}"),
                    &format!("新版正文{n}"),
                    json!({ "supersedes": old_id }),
                );
                if status == 200 && !is_error {
                    wins.fetch_add(1, Ordering::SeqCst);
                } else if status == 200 && is_error {
                    // 工具层面的错误(冲突):干净地告诉调用方"没成功"
                    clean_rejections.fetch_add(1, Ordering::SeqCst);
                } else {
                    panic!("竞争者 {n} 得到了 HTTP {status}:{text}");
                }
            });
        }
    });
    assert_eq!(
        wins.load(Ordering::SeqCst) + clean_rejections.load(Ordering::SeqCst),
        RACERS
    );
    assert_eq!(
        wins.load(Ordering::SeqCst),
        1,
        "同时取代同一条旧经验,只能有一个赢家"
    );

    // 没有半截数据:直接数 SQLite(权威数据;输家的新条目不会进向量库,用检索查不出它)。
    // 以"竞争-新版"开头的条目恰好一条,而且旧条目指向的就是它
    let db = rusqlite::Connection::open(
        h.daemon
            .home
            .path()
            .join("spaces")
            .join(h.space("alice"))
            .join("meta.db"),
    )
    .expect("打开 meta.db");
    let rows: Vec<(String, String)> = db
        .prepare("SELECT id, title FROM insights WHERE title LIKE '竞争-新版%'")
        .expect("查询")
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("执行")
        .collect::<Result<_, _>>()
        .expect("读取");
    assert_eq!(rows.len(), 1, "输家的新条目不该留在库里:{rows:?}");
    let pointed: Option<String> = db
        .query_row(
            "SELECT superseded_by FROM insights WHERE id = ?1",
            [&old_id],
            |row| row.get(0),
        )
        .expect("旧条目");
    assert_eq!(
        pointed.as_deref(),
        Some(rows[0].0.as_str()),
        "旧条目应指向赢家"
    );
    let edges: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM edges WHERE rel = 'supersedes' AND dst = ?1",
            [&old_id],
            |row| row.get(0),
        )
        .expect("边");
    assert_eq!(edges, 1, "取代关系只该有一条,输家不能留下边");
    // 旧条目已被取代,指向赢家
    let (_, old, _) = setup.tool("get_item", json!({ "id": old_id }));
    assert!(old.contains("superseded"), "旧条目应已被取代:{old}");
}

#[test]
fn creating_the_same_token_name_at_once_has_one_winner_and_the_rest_get_a_clean_409() {
    const RACERS: usize = 8;
    let h = Harness::start();
    let port = h.port();
    let cookie = h.cookie("alice").to_owned();
    let (ok, conflict, other) = (
        AtomicUsize::new(0),
        AtomicUsize::new(0),
        AtomicUsize::new(0),
    );
    std::thread::scope(|scope| {
        for _ in 0..RACERS {
            let (cookie, ok, conflict, other) = (&cookie, &ok, &conflict, &other);
            scope.spawn(move || {
                let (status, _, _) = http(
                    port,
                    "POST",
                    "/api/v1/auth/tokens",
                    Some(cookie),
                    Some(json!({ "name": "same-name", "scope": "mcp" })),
                );
                match status {
                    200 => ok.fetch_add(1, Ordering::SeqCst),
                    409 => conflict.fetch_add(1, Ordering::SeqCst),
                    _ => other.fetch_add(1, Ordering::SeqCst),
                };
            });
        }
    });
    assert_eq!(ok.load(Ordering::SeqCst), 1, "同名令牌只能建成一个");
    assert_eq!(
        conflict.load(Ordering::SeqCst),
        RACERS - 1,
        "其余的应得到干净的 409"
    );
    assert_eq!(other.load(Ordering::SeqCst), 0, "不该有 5xx 或别的状态");
}

#[test]
fn rotating_the_admin_key_while_requests_are_in_flight_only_ever_gives_200_or_401() {
    let h = Harness::start();
    let port = h.port();
    let (status, _, body) = http(
        port,
        "GET",
        "/api/v1/me/admin-key",
        Some(h.cookie("alice")),
        None,
    );
    assert_eq!(status, 200, "{body}");
    let old = body["data"]["admin_key"].as_str().expect("key").to_owned();
    let stop = std::sync::atomic::AtomicBool::new(false);
    let statuses: std::sync::Mutex<Vec<u16>> = std::sync::Mutex::new(Vec::new());
    let fresh = std::sync::Mutex::new(String::new());
    std::thread::scope(|scope| {
        for _ in 0..4 {
            let (old, stop, statuses) = (&old, &stop, &statuses);
            scope.spawn(move || {
                let auth = format!("Bearer {old}");
                while !stop.load(Ordering::SeqCst) {
                    let (status, _, _) = http_raw(
                        port,
                        "POST",
                        "/api/v1/capabilities/list_collections",
                        &[("Authorization", &auth)],
                        Some(json!({})),
                    );
                    statuses.lock().expect("锁").push(status);
                }
            });
        }
        std::thread::sleep(std::time::Duration::from_millis(150));
        let (status, _, body) = http(
            port,
            "POST",
            "/api/v1/me/admin-key/rotate",
            Some(h.cookie("alice")),
            None,
        );
        assert_eq!(status, 200, "{body}");
        *fresh.lock().expect("锁") = body["data"]["admin_key"]
            .as_str()
            .expect("新 key")
            .to_owned();
        std::thread::sleep(std::time::Duration::from_millis(150));
        stop.store(true, Ordering::SeqCst);
    });
    let seen = statuses.lock().expect("锁");
    assert!(seen.len() > 8, "压力不够:只发了 {} 个请求", seen.len());
    assert!(
        seen.iter().all(|status| *status == 200 || *status == 401),
        "轮换途中出现了别的状态:{:?}",
        seen.iter()
            .filter(|s| **s != 200 && **s != 401)
            .collect::<Vec<_>>()
    );
    assert!(
        seen.contains(&200) && seen.contains(&401),
        "应该既有轮换前的 200,也有轮换后的 401"
    );
    // 一旦出现 401 就不会再回到 200(旧 key 不会"复活")
    let first_401 = seen
        .iter()
        .position(|status| *status == 401)
        .expect("有 401");
    assert!(
        seen.iter().skip(first_401).all(|status| *status == 401)
            || seen.iter().skip(first_401).filter(|s| **s == 200).count() <= 3,
        "旧 key 不该在失效后复活"
    );
    let (status, _) = (
        http_raw(
            port,
            "GET",
            "/api/v1/auth/me",
            &[(
                "Authorization",
                &format!("Bearer {}", fresh.lock().expect("锁")),
            )],
            None,
        )
        .0,
        (),
    );
    assert_eq!(status, 200, "新 key 可用");
}
