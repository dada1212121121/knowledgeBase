//! 多人共用外部编码代理(ACP)的隔离验收(多用户设计说明):
//! 真实守护进程、真实 bwrap 沙箱、真实的探针代理。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_acp_users`

#![cfg(feature = "testkit")]

mod support;

use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{Harness, http};

const AGENT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/probe_agent.py");

/// 这组用例就是要验证沙箱,本机 bwrap 不可用时必须明确失败,不能悄悄跳过后显示全绿。
fn require_bwrap() {
    let ok = std::process::Command::new("bwrap")
        .args(["--ro-bind", "/", "/", "--unshare-pid", "--", "true"])
        .status()
        .is_ok_and(|status| status.success());
    assert!(ok, "需要可用的 bwrap(用户命名空间)才能跑多用户代理隔离验收");
}

/// 管理员注册探针代理,并给 alice、bob 开 ACP 功能。
fn setup(h: &Harness) {
    h.ok(
        "admin",
        "acp_save_agent",
        json!({ "id": "probe", "name": "探针", "command": "/usr/bin/python3", "args": ["-u", AGENT], "confirm": true }),
    );
    for who in ["alice", "bob"] {
        for feature in ["ai.acp", "ai.assistant"] {
            h.ok(
                "admin",
                "user_feature",
                json!({ "id": h.id(who), "feature": feature, "effect": "allow" }),
            );
        }
    }
    // 功能例外有几秒缓存
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        let (status, _) = h.call("bob", "acp_agents", json!({}));
        if status == 200 {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("功能点没有生效");
}

/// 在另一个线程里发起一轮对话(会话期间的调用会阻塞到这一轮结束)。
fn chat(
    h: &Harness,
    who: &str,
    text: &str,
    session: Option<&str>,
) -> std::thread::JoinHandle<(u16, Value)> {
    let (port, cookie) = (h.port(), h.cookie(who).to_owned());
    let mut args = json!({ "agent": "probe", "text": text });
    if let Some(session) = session {
        args["session_id"] = json!(session);
    }
    std::thread::spawn(move || {
        let (status, _, body) = http(
            port,
            "POST",
            "/api/v1/capabilities/acp_chat",
            Some(&cookie),
            Some(args),
        );
        (status, body)
    })
}

/// 改 acp.toml 里的全站名额和排队时长(先去掉旧的同名行,TOML 不允许重复键)。
fn set_acp_limits(path: &std::path::Path, max_agents: u32, queue_wait_secs: u32) {
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut kept: Vec<&str> = existing
        .lines()
        .filter(|line| {
            let key = line.split('=').next().unwrap_or("").trim();
            key != "max_agents" && key != "queue_wait_secs"
        })
        .collect();
    let extra = format!("max_agents = {max_agents}\nqueue_wait_secs = {queue_wait_secs}");
    // 键值对必须在第一个 [表] 之前,否则会被当成那个表里的键
    let at = kept
        .iter()
        .position(|line| line.trim_start().starts_with('['))
        .unwrap_or(kept.len());
    kept.insert(at, &extra);
    std::fs::write(path, kept.join("\n") + "\n").unwrap();
}

fn facts(reply: &Value) -> Value {
    let text = reply["data"]["text"]
        .as_str()
        .unwrap_or_else(|| panic!("没有回复正文:{reply}"));
    serde_json::from_str(text).unwrap_or_else(|err| panic!("探针回复不是 JSON({err}):{text}"))
}

#[test]
fn each_users_agent_runs_in_its_own_workspace_and_cannot_see_anyone_elses_files() {
    require_bwrap();
    let h = Harness::start();
    setup(&h);
    let alice_space = h.space("alice");
    let bob_space = h.space("bob");
    let home = h.daemon.home.path().to_path_buf();
    let alice_ws = home
        .join("spaces")
        .join(&alice_space)
        .join("agent-workspace");
    let bob_ws = home.join("spaces").join(&bob_space).join("agent-workspace");
    std::fs::create_dir_all(&alice_ws).unwrap();
    std::fs::write(alice_ws.join("alice-secret.txt"), "alice 的东西").unwrap();
    let probes = format!(
        "{};{};{}",
        alice_ws.join("alice-secret.txt").display(),
        home.join("system.db").display(),
        home.join("meta.db").display()
    );
    // bob 的代理:工作目录是他自己的,写得进去;读不到 alice 的文件、账号库、主知识库
    let (status, reply) = chat(&h, "bob", &format!("看看 probe:{probes}"), None)
        .join()
        .unwrap();
    assert_eq!(status, 200, "{reply}");
    let found = facts(&reply);
    assert_eq!(found["cwd"], bob_ws.display().to_string(), "{found}");
    assert_eq!(found["wrote"], true);
    assert!(
        bob_ws.join("marker.txt").exists(),
        "文件落在 bob 自己的工作目录"
    );
    for (path, readable) in found["read"].as_object().unwrap() {
        assert_eq!(readable, false, "沙箱里不该读到 {path}");
    }
    assert_eq!(reply["data"]["sandboxed"], true);
    // alice 的目录里没有 bob 的东西
    assert!(!alice_ws.join("marker.txt").exists());
}

#[test]
fn a_normal_user_cannot_turn_the_sandbox_off_or_pick_a_directory() {
    require_bwrap();
    let h = Harness::start();
    setup(&h);
    // 管理员把沙箱关了、允许裸跑:对管理员自己生效,对普通用户不生效
    h.ok(
        "admin",
        "acp_set_sandbox",
        json!({ "sandbox": false, "confirm": true }),
    );
    let (status, reply) = chat(&h, "bob", "你好", None).join().unwrap();
    assert_eq!(status, 200, "{reply}");
    assert_eq!(
        reply["data"]["sandboxed"], true,
        "普通用户的代理始终在沙箱里"
    );
    // 不能指定目录
    let (status, _, body) = http(
        h.port(),
        "POST",
        "/api/v1/capabilities/acp_chat",
        Some(h.cookie("alice")),
        Some(json!({ "agent": "probe", "text": "x", "cwd": "/etc" })),
    );
    assert_eq!(status, 400, "{body}");
    // 管理员自己关了沙箱就是没沙箱(这是管理员的设置,保持原有行为)
    let (status, reply) = chat(&h, "admin", "你好", None).join().unwrap();
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["data"]["sandboxed"], false);
}

#[test]
fn other_peoples_sessions_cannot_be_attached_to_cancelled_answered_or_deleted() {
    require_bwrap();
    let h = Harness::start();
    setup(&h);
    let (status, reply) = chat(&h, "alice", "你好", None).join().unwrap();
    assert_eq!(status, 200, "{reply}");
    let alice_session = reply["data"]["session_id"].as_str().unwrap().to_owned();
    // bob 拿着 alice 的会话 id:接不上、取消不了、删不掉
    let (status, body) = chat(&h, "bob", "我也来", Some(&alice_session))
        .join()
        .unwrap();
    assert_eq!(status, 404, "{body}");
    let (status, body) = h.call("bob", "acp_cancel", json!({ "session_id": alice_session }));
    assert_eq!(status, 404, "{body}");
    let (status, body) = h.call(
        "bob",
        "agent_delete_session",
        json!({ "session_id": alice_session }),
    );
    assert_eq!(status, 404, "{body}");
    // 不带会话 id 的「答复权限请求」也只在自己的会话里找:bob 没有会话,就是没有
    let (status, body) = h.call("bob", "acp_permission", json!({ "allow": true }));
    assert_eq!(status, 404, "{body}");
    // alice 的代理进程没有被 bob 关掉:她自己还能对它发取消(代理还在缓存里才会成功)
    let (status, body) = h.call(
        "alice",
        "acp_cancel",
        json!({ "session_id": alice_session }),
    );
    assert_eq!(status, 200, "bob 的删除尝试不能把 alice 的代理关掉:{body}");
    // alice 的会话还好好的,自己能继续对话
    let (status, body) = chat(&h, "alice", "继续", Some(&alice_session))
        .join()
        .unwrap();
    assert_eq!(status, 200, "{body}");
}

#[test]
fn one_person_gets_one_running_agent_and_a_new_session_replaces_an_idle_old_one() {
    require_bwrap();
    let h = Harness::start();
    setup(&h);
    // alice 开了第一个会话,空闲着;再开第二个:第一个让位
    let (_, first) = chat(&h, "alice", "第一个", None).join().unwrap();
    let first_id = first["data"]["session_id"].as_str().unwrap().to_owned();
    let (status, second) = chat(&h, "alice", "第二个", None).join().unwrap();
    assert_eq!(status, 200, "{second}");
    assert_ne!(second["data"]["session_id"].as_str().unwrap(), first_id);
    // 第一个会话的代理已经被回收;再接着聊会重新拉起(历史还在),仍然成功
    // 但如果第二个正在跑一轮很长的对话,第三个会话必须被拒绝,而不是悄悄多开
    let running = chat(
        &h,
        "alice",
        "占着 sleep:4",
        Some(second["data"]["session_id"].as_str().unwrap()),
    );
    std::thread::sleep(Duration::from_millis(1200));
    let (status, body) = chat(&h, "alice", "第三个", None).join().unwrap();
    assert_eq!(status, 503, "{body}");
    assert!(body.to_string().contains("已经有一个代理会话"), "{body}");
    let (status, _) = running.join().unwrap();
    assert_eq!(status, 200);
}

#[test]
fn when_the_site_is_full_new_sessions_queue_and_then_get_in() {
    require_bwrap();
    let h = Harness::start();
    setup(&h);
    // 全站只允许 1 个代理,排队最多等 20 秒
    let config_path = h.daemon.home.path().join("acp.toml");
    set_acp_limits(&config_path, 1, 20);
    let busy = chat(&h, "alice", "占着 sleep:3", None);
    std::thread::sleep(Duration::from_millis(1200));
    let started = Instant::now();
    let (status, body) = chat(&h, "bob", "我排队", None).join().unwrap();
    assert_eq!(status, 200, "{body}");
    assert!(
        started.elapsed() >= Duration::from_secs(1),
        "bob 应该等过一阵(排队),实际 {:?}",
        started.elapsed()
    );
    let (status, _) = busy.join().unwrap();
    assert_eq!(status, 200);
    // 排队超时就报繁忙
    set_acp_limits(&config_path, 1, 2);
    let busy = chat(&h, "alice", "占着 sleep:6", None);
    std::thread::sleep(Duration::from_millis(1500));
    let (status, body) = chat(&h, "bob", "排不上", None).join().unwrap();
    assert_eq!(status, 503, "{body}");
    assert!(body.to_string().contains("排队超时"), "{body}");
    let _ = busy.join();
}

const PERMISSION_AGENT: &str =
    concat!(env!("CARGO_MANIFEST_DIR"), "/../kb-acp/tests/fake_agent.py");

#[test]
fn nobody_can_answer_someone_elses_pending_permission_request() {
    require_bwrap();
    let h = Harness::start();
    setup(&h);
    // 这个代理每一轮都会问一次「写工作目录里的文件」,会一直停在那里等界面答复
    h.ok(
        "admin",
        "acp_save_agent",
        json!({ "id": "asks", "name": "会提问", "command": "/usr/bin/python3", "args": ["-u", PERMISSION_AGENT], "confirm": true }),
    );
    let (port, cookie) = (h.port(), h.cookie("alice").to_owned());
    let alice_chat = std::thread::spawn(move || {
        http(
            port,
            "POST",
            "/api/v1/capabilities/acp_chat",
            Some(&cookie),
            Some(json!({ "agent": "asks", "text": "你好" })),
        )
    });
    std::thread::sleep(Duration::from_millis(2500));
    // bob 不带会话 id 去答复:只会在他自己的会话里找,找不到
    let (status, body) = h.call("bob", "acp_permission", json!({ "allow": true }));
    assert_eq!(status, 404, "bob 不能批准 alice 的权限请求:{body}");
    // alice 的请求还在:她自己能答复,这一轮才结束
    let mut resolved = false;
    for _ in 0..50 {
        let (status, body) = h.call("alice", "acp_permission", json!({ "allow": false }));
        if status == 200 && body["resolved"] == true {
            resolved = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    assert!(resolved, "alice 自己应能答复");
    let (status, _, _) = alice_chat.join().unwrap();
    assert_eq!(status, 200);
}

/// 读一个事件 WebSocket 一阵,返回收到的所有文本帧。
fn collect_events(port: u16, cookie: &str, secs: u64) -> std::thread::JoinHandle<Vec<String>> {
    let cookie = format!("kb_session={cookie}");
    std::thread::spawn(move || {
        use std::net::TcpStream;
        use tungstenite::client::IntoClientRequest;
        use tungstenite::stream::MaybeTlsStream;
        let mut request = format!("ws://127.0.0.1:{port}/api/v1/ws")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("Cookie", cookie.parse().unwrap());
        let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(200)))
            .ok();
        let (mut socket, _) =
            tungstenite::client(request, MaybeTlsStream::Plain(stream)).expect("握手");
        let mut seen = Vec::new();
        let until = Instant::now() + Duration::from_secs(secs);
        while Instant::now() < until {
            if let Ok(tungstenite::Message::Text(text)) = socket.read() {
                seen.push(text.to_string());
            }
        }
        seen
    })
}

#[test]
fn a_users_agent_replies_stream_to_that_user_only_not_even_to_the_admin() {
    require_bwrap();
    let h = Harness::start();
    setup(&h);
    let alice = collect_events(h.port(), h.cookie("alice"), 8);
    let bob = collect_events(h.port(), h.cookie("bob"), 8);
    let admin = collect_events(h.port(), h.cookie("admin"), 8);
    std::thread::sleep(Duration::from_millis(800));
    let (status, reply) = chat(&h, "bob", "给 bob 的回复", None).join().unwrap();
    assert_eq!(status, 200, "{reply}");
    let session = reply["data"]["session_id"].as_str().unwrap().to_owned();
    let (bob, alice, admin) = (
        bob.join().unwrap(),
        alice.join().unwrap(),
        admin.join().unwrap(),
    );
    let about = |events: &[String]| events.iter().filter(|e| e.contains(&session)).count();
    assert!(about(&bob) >= 1, "bob 应收到自己代理的流式回复:{bob:?}");
    assert!(
        bob.iter()
            .any(|e| e.contains("acp.update") && e.contains("\"kind\":\"text\"")),
        "{bob:?}"
    );
    assert_eq!(about(&alice), 0, "别的用户收不到:{alice:?}");
    assert_eq!(
        about(&admin),
        0,
        "管理员也收不到普通用户的代理回复:{admin:?}"
    );
}

#[test]
fn a_reply_cut_off_mid_turn_is_saved_in_its_owners_library_never_in_the_admins() {
    require_bwrap();
    let h = Harness::start();
    setup(&h);
    // bob 的一轮对话进行到一半(已经有部分正文),他把这个会话删了:代理被关掉,被打断的半句话要落库
    // —— 落在 bob 自己的库里(随会话一起被删掉),绝不能留在管理员(主知识库)的库里
    let running = chat(&h, "bob", "early: 然后 sleep:6", None);
    std::thread::sleep(Duration::from_millis(2500));
    let sessions = h.ok("bob", "agent_sessions", json!({}));
    let session = sessions["sessions"][0]["session_id"]
        .as_str()
        .expect("bob 的会话")
        .to_owned();
    let _ = h.call(
        "bob",
        "agent_delete_session",
        json!({ "session_id": session }),
    );
    let _ = running.join();
    let admin_sessions = h.ok("admin", "agent_sessions", json!({}));
    assert!(
        !admin_sessions.to_string().contains(&session),
        "bob 的会话不该出现在管理员的库里:{admin_sessions}"
    );
}

// ---------------------------------------------------------------- 安全审查 S-3:沙箱加固

#[test]
fn an_agent_in_the_sandbox_has_no_capabilities_and_cannot_make_device_nodes() {
    require_bwrap();
    let h = Harness::start();
    setup(&h);
    let (status, reply) = chat(&h, "bob", "看看自己的权限", None).join().unwrap();
    assert_eq!(status, 200, "{reply}");
    let found = facts(&reply);
    assert_eq!(reply["data"]["sandboxed"], true);
    // 守护进程以 root 跑时,不丢能力的沙箱里代理握着全部 capability(0x1ffffffffff),
    // 能 mknod 出宿主的块设备直接读写磁盘
    assert_eq!(found["cap_eff"], "0000000000000000", "{found}");
    assert_eq!(found["mknod"], false, "{found}");
}

#[test]
fn the_site_llm_key_goes_to_the_admins_agent_only_not_to_ordinary_users() {
    require_bwrap();
    // 站点配了官方端点的 key;探针代理冒充 anthropic 内置代理,这样才会触发 key 的注入
    let h = Harness::start_with(
        "[llm]\nbase_url = \"https://api.anthropic.com\"\n",
        |home| {
            std::fs::write(
                home.join("secrets.toml"),
                "[llm]\napi_key = \"sk-site-key-for-tests\"\n",
            )
            .unwrap();
        },
    );
    h.ok(
        "admin",
        "acp_save_agent",
        json!({ "id": "anthropic", "name": "探针", "command": "/usr/bin/python3", "args": ["-u", AGENT], "confirm": true }),
    );
    h.ok(
        "admin",
        "user_feature",
        json!({ "id": h.id("alice"), "feature": "ai.acp", "effect": "allow" }),
    );
    h.ok(
        "admin",
        "user_feature",
        json!({ "id": h.id("alice"), "feature": "ai.assistant", "effect": "allow" }),
    );
    let deadline = Instant::now() + Duration::from_secs(15);
    while h.call("alice", "acp_agents", json!({})).0 != 200 {
        assert!(Instant::now() < deadline, "功能点没有生效");
        std::thread::sleep(Duration::from_millis(200));
    }
    let ask = |who: &str| {
        let (port, cookie) = (h.port(), h.cookie(who).to_owned());
        let (status, _, body) = http(
            port,
            "POST",
            "/api/v1/capabilities/acp_chat",
            Some(&cookie),
            Some(json!({ "agent": "anthropic", "text": "看看环境变量" })),
        );
        assert_eq!(status, 200, "{who}: {body}");
        facts(&body)
    };
    // 对照组:管理员的代理拿得到(没有这一条,下面「普通用户拿不到」可能只是因为根本没注入过)
    let admin = ask("admin");
    assert!(
        admin["api_key_vars"]
            .as_array()
            .unwrap()
            .iter()
            .any(|name| name == "ANTHROPIC_API_KEY"),
        "管理员的代理应当拿到站点 key:{admin}"
    );
    let alice = ask("alice");
    assert_eq!(
        alice["api_key_vars"],
        json!([]),
        "普通用户的代理不能拿到站点 key(它能绕过按人记账的额度,也能把 key 带走):{alice}"
    );
}
