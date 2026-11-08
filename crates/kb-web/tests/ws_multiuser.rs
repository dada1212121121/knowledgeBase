//! 推送事件的隔离(多用户设计说明):每个订阅者只收自己知识库的事件,
//! 没有知识库标签的系统事件只给有系统功能的管理员。走真实的 TCP 监听 + 会话 cookie + WebSocket 握手。

use std::sync::Arc;
use std::time::Duration;

use kb_capability::{CALL_SCOPE, CallScope};
use kb_core::account::{NewUser, PRIMARY_SPACE_ID, ROLE_ADMIN, ROLE_USER, UserStatus};
use kb_web::AppState;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

struct Fixture {
    hub: Arc<kb_web::EventHub>,
    port: u16,
    sessions: std::collections::BTreeMap<&'static str, String>,
    spaces: std::collections::BTreeMap<&'static str, String>,
    users: std::collections::BTreeMap<&'static str, String>,
    _shutdown: tokio::sync::watch::Sender<bool>,
}

async fn add_user(state: &AppState, name: &'static str, role: &str) -> (String, String, String) {
    let (user, space) = state
        .system
        .create_user(NewUser {
            username: name.to_owned(),
            email: None,
            display_name: None,
            password_hash: "$argon2id$x".to_owned(),
            role_id: role.to_owned(),
            status: UserStatus::Active,
            registered_via: "test".to_owned(),
            must_change_password: false,
            email_verified: false,
        })
        .await
        .expect("建用户");
    let token = kb_web::auth::session::create(
        state.system.as_ref(),
        &user.id,
        None,
        None,
        kb_web::auth::session::now_millis(),
    )
    .await
    .expect("会话");
    (token, space.id, user.id)
}

async fn fixture() -> Fixture {
    let hub = Arc::new(kb_web::EventHub::new());
    let dir = tempfile::tempdir().expect("目录").keep();
    let meta = Arc::new(kb_meta::SqliteMetaStore::open(dir.join("meta.db")).expect("meta"));
    let state = Arc::new(AppState {
        invoker: Arc::new(kb_capability::Invoker::new(
            Arc::new(kb_capability::Registry::new()),
            meta.clone(),
        )),
        started: std::time::Instant::now(),
        version: "test",
        mcp: None,
        events: None,
        meta,
        system: Arc::new(kb_meta::SystemStore::open(dir.join("system.db")).expect("账号库")),
        principals: kb_web::auth::PrincipalCache::default(),
        account: kb_web::signup::AccountDeps::unconfigured(),
        ai_enabled: Arc::new(kb_core::features::AiState::on),
        login_limiter: kb_web::auth::ratelimit::LoginLimiter::new(),
        hub: hub.clone(),
        uploads: None,
        agent_grants: Arc::new(kb_web::AgentGrants::new()),
        collab: None,
        office: None,
    });
    let mut sessions = std::collections::BTreeMap::new();
    let mut spaces = std::collections::BTreeMap::new();
    let mut users = std::collections::BTreeMap::new();
    for (name, role) in [
        ("boss", ROLE_ADMIN),
        ("alice", ROLE_USER),
        ("bob", ROLE_USER),
    ] {
        let (token, space, user) = add_user(&state, name, role).await;
        sessions.insert(name, token);
        spaces.insert(name, space);
        users.insert(name, user);
    }
    let listener = kb_web::bind_tcp("127.0.0.1:0".parse().expect("地址"))
        .await
        .expect("监听");
    let port = listener.local_addr().expect("端口").port();
    let (tx, rx) = tokio::sync::watch::channel(false);
    tokio::spawn(async move {
        let _ = kb_web::serve_tcp_listener(listener, state, rx).await;
    });
    Fixture {
        hub,
        port,
        sessions,
        spaces,
        users,
        _shutdown: tx,
    }
}

async fn connect(fixture: &Fixture, who: &str) -> TcpStream {
    let mut stream = TcpStream::connect(("127.0.0.1", fixture.port))
        .await
        .expect("连接");
    let request = format!(
        "GET /api/v1/ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nCookie: kb_session={}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        fixture.port, fixture.sessions[who]
    );
    stream.write_all(request.as_bytes()).await.expect("握手");
    let mut raw = Vec::new();
    let mut byte = [0u8; 1];
    while !raw.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.expect("读响应头");
        raw.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&raw).into_owned();
    assert!(head.starts_with("HTTP/1.1 101"), "{who} 应升级成功:{head}");
    let hello = read_text(&mut stream, Duration::from_secs(5))
        .await
        .expect("hello");
    assert_eq!(hello["type"], "hello");
    stream
}

/// 读一个文本帧;超时返回 `None`。
async fn read_text(stream: &mut TcpStream, wait: Duration) -> Option<Value> {
    tokio::time::timeout(wait, async {
        let mut head = [0u8; 2];
        stream.read_exact(&mut head).await.ok()?;
        let mut length = usize::from(head[1] & 0x7f);
        if length == 126 {
            let mut ext = [0u8; 2];
            stream.read_exact(&mut ext).await.ok()?;
            length = usize::from(u16::from_be_bytes(ext));
        }
        let mut payload = vec![0u8; length];
        stream.read_exact(&mut payload).await.ok()?;
        serde_json::from_slice(&payload).ok()
    })
    .await
    .ok()
    .flatten()
}

/// 以某个知识库的身份发事件(和后台任务 / 能力调用里一样,标签取自任务局部路由)。
async fn publish_in(fixture: &Fixture, space: &str, kind: &str, data: Value) {
    CALL_SCOPE
        .scope(
            CallScope::Space {
                space_id: space.to_owned(),
                handle: Arc::new(()),
                via_link: false,
            },
            async { fixture.hub.publish(kind, data) },
        )
        .await;
}

/// 读掉连接上目前能读到的所有业务事件(跳过 ping),给「不该收到」的断言用。
async fn drain_events(stream: &mut TcpStream) -> Vec<Value> {
    let mut events = Vec::new();
    while let Some(frame) = read_text(stream, Duration::from_millis(400)).await {
        if frame["type"] != "ping" {
            events.push(frame);
        }
    }
    events
}

#[tokio::test]
async fn events_reach_only_the_owner_of_the_space() {
    let f = fixture().await;
    let mut alice = connect(&f, "alice").await;
    let mut bob = connect(&f, "bob").await;
    publish_in(
        &f,
        &f.spaces["alice"],
        "item.changed",
        json!({ "id": "alice-note" }),
    )
    .await;
    publish_in(
        &f,
        &f.spaces["bob"],
        "item.changed",
        json!({ "id": "bob-note" }),
    )
    .await;

    let to_alice = drain_events(&mut alice).await;
    let to_bob = drain_events(&mut bob).await;
    assert_eq!(to_alice.len(), 1, "{to_alice:?}");
    assert_eq!(to_alice[0]["data"]["id"], "alice-note");
    assert_eq!(to_bob.len(), 1, "{to_bob:?}");
    assert_eq!(to_bob[0]["data"]["id"], "bob-note", "bob 只收到自己的事件");
}

#[tokio::test]
async fn untagged_system_events_only_go_to_admins() {
    let f = fixture().await;
    let mut boss = connect(&f, "boss").await;
    let mut alice = connect(&f, "alice").await;
    // 不在任何知识库里发出的事件(日志、配置、备份……)没有标签
    f.hub
        .publish("log", json!({ "message": "内部日志,可能含路径" }));
    f.hub.publish("config.changed", json!({}));
    assert_eq!(
        drain_events(&mut boss).await.len(),
        2,
        "管理员收得到系统事件"
    );
    assert!(
        drain_events(&mut alice).await.is_empty(),
        "普通用户收不到系统事件"
    );
}

#[tokio::test]
async fn the_primary_space_events_reach_its_owner_the_admin() {
    let f = fixture().await;
    let mut boss = connect(&f, "boss").await;
    let mut bob = connect(&f, "bob").await;
    assert_eq!(
        f.spaces["boss"], PRIMARY_SPACE_ID,
        "第一个管理员接管主知识库"
    );
    publish_in(
        &f,
        PRIMARY_SPACE_ID,
        "job.progress",
        json!({ "job_id": "j" }),
    )
    .await;
    assert_eq!(drain_events(&mut boss).await.len(), 1);
    assert!(
        drain_events(&mut bob).await.is_empty(),
        "别人收不到主知识库的任务进度"
    );
}

#[tokio::test]
async fn a_websocket_without_a_session_is_refused() {
    let f = fixture().await;
    let mut stream = TcpStream::connect(("127.0.0.1", f.port))
        .await
        .expect("连接");
    stream
        .write_all(
            format!(
                "GET /api/v1/ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
                 Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
                f.port
            )
            .as_bytes(),
        )
        .await
        .expect("握手");
    let mut raw = vec![0u8; 12];
    stream.read_exact(&mut raw).await.expect("读状态行");
    assert!(
        String::from_utf8_lossy(&raw).starts_with("HTTP/1.1 401"),
        "没有会话不能订阅事件"
    );
}

#[tokio::test]
async fn personal_events_reach_exactly_one_person_even_across_spaces_and_not_the_admin() {
    let f = fixture().await;
    let mut boss = connect(&f, "boss").await;
    let mut alice = connect(&f, "alice").await;
    let mut bob = connect(&f, "bob").await;
    let alice_id = f.users["alice"].clone();
    // 在 bob 的知识库路由里发(模拟「bob 的操作触发了发给 alice 的通知」):
    // 事件是发给 alice 的,不能因为是在 bob 的知识库里发的就推给 bob
    CALL_SCOPE
        .scope(
            CallScope::Space {
                space_id: f.spaces["bob"].clone(),
                handle: Arc::new(()),
                via_link: false,
            },
            async {
                f.hub
                    .publish_to_user(&alice_id, "notify", json!({ "unread": 1 }))
            },
        )
        .await;
    let to_alice = drain_events(&mut alice).await;
    assert_eq!(to_alice.len(), 1, "{to_alice:?}");
    assert_eq!(to_alice[0]["type"], "notify");
    assert_eq!(to_alice[0]["data"]["unread"], 1);
    assert!(
        drain_events(&mut bob).await.is_empty(),
        "bob 收不到发给 alice 的"
    );
    assert!(
        drain_events(&mut boss).await.is_empty(),
        "管理员也收不到别人的个人通知"
    );
}
