//! 好友与通知的守护进程级验收(多用户设计说明):真实进程、真实会话、真实 HTTP。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_social`

#![cfg(feature = "testkit")]

mod support;

use serde_json::{Value, json};
use support::{Daemon, create_user, http, uds};

struct World {
    daemon: Daemon,
    alice: String,
    bob: String,
    carol: String,
    ids: std::collections::BTreeMap<&'static str, String>,
}

impl World {
    fn start() -> Self {
        let home = tempfile::tempdir().expect("KB_HOME");
        std::fs::write(
            home.path().join("config.toml"),
            "[embed]\nbackend = \"fake\"\n[server]\nlisten = \"127.0.0.1:0\"\n[quota]\ndisk_reserve_gb = 0\n",
        )
        .expect("配置");
        let daemon = Daemon::start(home);
        let (status, body) = uds(
            &daemon,
            "POST",
            "/api/v1/auth/password",
            json!({ "password": "admin password 1" }),
        );
        assert_eq!(status, 200, "{body}");
        for name in ["alice", "bob", "carol"] {
            create_user(daemon.home.path(), name, &format!("{name} password 1"));
        }
        let mut world = Self {
            daemon,
            alice: String::new(),
            bob: String::new(),
            carol: String::new(),
            ids: Default::default(),
        };
        world.alice = world.login("alice");
        world.bob = world.login("bob");
        world.carol = world.login("carol");
        for (name, cookie) in [
            ("alice", world.alice.clone()),
            ("bob", world.bob.clone()),
            ("carol", world.carol.clone()),
        ] {
            let (_, _, me) = http(world.port(), "GET", "/api/v1/auth/me", Some(&cookie), None);
            world.ids.insert(
                name,
                me["data"]["user"]["id"].as_str().expect("id").to_owned(),
            );
        }
        world
    }

    fn port(&self) -> u16 {
        self.daemon.tcp_port()
    }

    fn login(&self, name: &str) -> String {
        self.login_as(name, &format!("{name} password 1"))
    }

    fn login_as(&self, name: &str, password: &str) -> String {
        let (status, headers, body) = http(
            self.port(),
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "login": name, "password": password })),
        );
        assert_eq!(status, 200, "{body}");
        headers
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
            .and_then(|line| line.split_once('='))
            .map(|(_, rest)| rest.split(';').next().unwrap_or("").to_owned())
            .expect("会话 cookie")
    }

    fn call(&self, cookie: &str, capability: &str, args: Value) -> (u16, Value) {
        let (status, _, body) = http(
            self.port(),
            "POST",
            &format!("/api/v1/capabilities/{capability}"),
            Some(cookie),
            Some(args),
        );
        match body.get("data") {
            Some(data) if body["ok"] == true => (status, data.clone()),
            _ => (status, body),
        }
    }

    fn ok(&self, cookie: &str, capability: &str, args: Value) -> Value {
        let (status, body) = self.call(cookie, capability, args);
        assert_eq!(status, 200, "{capability}: {body}");
        body
    }
}

fn kinds(list: &Value) -> Vec<String> {
    list["notifications"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|n| n["kind"].as_str().unwrap_or("").to_owned())
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn the_whole_friend_flow_works_with_notifications_on_both_sides() {
    let w = World::start();
    // 找人:完整用户名能找到,片段找不到
    let found = w.ok(&w.alice, "friend_search", json!({ "query": "bob" }));
    assert_eq!(found["user"]["id"], w.ids["bob"].as_str());
    assert_eq!(found["relation"], "none");
    assert!(
        found["user"].get("email").is_none(),
        "搜索结果不带邮箱等私密字段:{found}"
    );
    assert_eq!(
        w.ok(&w.alice, "friend_search", json!({ "query": "bo" }))["user"],
        Value::Null
    );
    // 申请 → bob 收到通知(站内),未读数 1
    let sent = w.ok(
        &w.alice,
        "friend_request",
        json!({ "user_id": w.ids["bob"], "message": "我是 alice" }),
    );
    assert_eq!(sent["status"], "requested");
    let list = w.ok(&w.bob, "notification_list", json!({}));
    assert_eq!(kinds(&list), ["friend_request"], "{list}");
    assert_eq!(list["unread"], 1);
    assert_eq!(
        list["notifications"][0]["data"]["from"]["username"],
        "alice"
    );
    assert_eq!(list["notifications"][0]["data"]["message"], "我是 alice");
    // 重复申请不会再通知一遍
    let again = w.ok(
        &w.alice,
        "friend_request",
        json!({ "user_id": w.ids["bob"] }),
    );
    assert_eq!(again["status"], "already_pending");
    assert_eq!(w.ok(&w.bob, "notification_list", json!({}))["unread"], 1);
    // bob 看到申请并通过
    let requests = w.ok(&w.bob, "friend_requests", json!({}));
    assert_eq!(
        requests["incoming"].as_array().unwrap().len(),
        1,
        "{requests}"
    );
    let request_id = requests["incoming"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        w.ok(&w.alice, "friend_requests", json!({}))["outgoing"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let done = w.ok(
        &w.bob,
        "friend_decide",
        json!({ "id": request_id, "decision": "accept" }),
    );
    assert_eq!(done["state"], "accepted");
    // alice 收到结果通知;双方好友列表互相出现
    let alice_notes = w.ok(&w.alice, "notification_list", json!({}));
    assert_eq!(kinds(&alice_notes), ["friend_result"]);
    assert_eq!(alice_notes["notifications"][0]["data"]["accepted"], true);
    let alice_friends = w.ok(&w.alice, "friend_list", json!({}));
    assert_eq!(alice_friends["friends"][0]["username"], "bob");
    assert_eq!(
        w.ok(&w.bob, "friend_list", json!({}))["friends"][0]["username"],
        "alice"
    );
    assert_eq!(
        w.ok(&w.alice, "friend_search", json!({ "query": "bob" }))["relation"],
        "friend"
    );
    // 备注只改自己这一边
    w.ok(
        &w.alice,
        "friend_update",
        json!({ "friend_id": w.ids["bob"], "remark": "老 b", "group_name": "同事" }),
    );
    assert_eq!(
        w.ok(&w.alice, "friend_list", json!({}))["friends"][0]["remark"],
        "老 b"
    );
    assert_eq!(
        w.ok(&w.bob, "friend_list", json!({}))["friends"][0]["remark"],
        Value::Null
    );
    // 标已读
    let read = w.ok(&w.bob, "notification_read", json!({ "all": true }));
    assert_eq!(read["unread"], 0);
    // 删除好友
    assert_eq!(
        w.ok(
            &w.alice,
            "friend_remove",
            json!({ "user_id": w.ids["bob"] })
        )["removed"],
        true
    );
    assert_eq!(
        w.ok(&w.bob, "friend_list", json!({}))["friends"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn a_rejection_is_told_to_the_requester_and_blocks_a_repeat_for_a_day() {
    let w = World::start();
    w.ok(
        &w.alice,
        "friend_request",
        json!({ "user_id": w.ids["carol"] }),
    );
    let id = w.ok(&w.carol, "friend_requests", json!({}))["incoming"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    w.ok(
        &w.carol,
        "friend_decide",
        json!({ "id": id, "decision": "reject" }),
    );
    let notes = w.ok(&w.alice, "notification_list", json!({}));
    assert_eq!(notes["notifications"][0]["data"]["accepted"], false);
    let (status, body) = w.call(
        &w.alice,
        "friend_request",
        json!({ "user_id": w.ids["carol"] }),
    );
    assert_eq!(status, 403, "{body}");
    assert!(body.to_string().contains("24 小时"), "{body}");
}

#[test]
fn blocking_is_silent_to_the_blocked_person() {
    let w = World::start();
    w.ok(&w.carol, "block", json!({ "user_id": w.ids["alice"] }));
    // alice 搜不到 carol,申请表面成功,但 carol 什么都收不到
    assert_eq!(
        w.ok(&w.alice, "friend_search", json!({ "query": "carol" }))["user"],
        Value::Null
    );
    let sent = w.ok(
        &w.alice,
        "friend_request",
        json!({ "user_id": w.ids["carol"] }),
    );
    assert_eq!(sent["status"], "requested", "不能让 alice 看出自己被拉黑了");
    assert_eq!(
        w.ok(&w.carol, "friend_requests", json!({}))["incoming"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(
        w.ok(&w.carol, "notification_list", json!({}))["notifications"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    // carol 的拉黑列表里有 alice,取消之后又能搜到
    assert_eq!(
        w.ok(&w.carol, "block_list", json!({}))["blocked"][0]["user"]["username"],
        "alice"
    );
    w.ok(&w.carol, "unblock", json!({ "user_id": w.ids["alice"] }));
    assert_eq!(
        w.ok(&w.alice, "friend_search", json!({ "query": "carol" }))["user"]["username"],
        "carol"
    );
}

#[test]
fn privacy_settings_change_who_can_find_me() {
    let w = World::start();
    // bob 默认:用户名可搜,邮箱不可搜
    assert!(
        w.ok(
            &w.alice,
            "friend_search",
            json!({ "query": "bob@example.com" })
        )["user"]
            .is_null()
    );
    let privacy = w.ok(&w.bob, "privacy_get", json!({}));
    assert_eq!(privacy["privacy"]["searchable_by_username"], true);
    assert_eq!(privacy["privacy"]["searchable_by_email"], false);
    w.ok(
        &w.bob,
        "set_privacy",
        json!({ "searchable_by_username": false }),
    );
    assert!(w.ok(&w.alice, "friend_search", json!({ "query": "bob" }))["user"].is_null());
    let (status, body) = w.call(&w.bob, "set_privacy", json!({ "share_from": "nobody" }));
    assert_eq!(status, 400, "{body}");
}

#[test]
fn searching_is_rate_limited_per_person_and_nobody_can_act_as_someone_else() {
    let w = World::start();
    let mut refused = 0;
    for n in 0..14 {
        let (status, _) = w.call(
            &w.alice,
            "friend_search",
            json!({ "query": format!("nobody{n}") }),
        );
        if status == 503 {
            refused += 1;
        }
    }
    assert_eq!(refused, 4, "每分钟 10 次,多出来的 4 次被拦");
    // 别人不受 alice 的限速影响
    assert_eq!(
        w.call(&w.bob, "friend_search", json!({ "query": "carol" }))
            .0,
        200
    );
    // 通知只属于自己:bob 拿 alice 的通知 id 标已读不会动 alice 的
    w.ok(
        &w.carol,
        "friend_request",
        json!({ "user_id": w.ids["alice"] }),
    );
    let notes = w.ok(&w.alice, "notification_list", json!({}));
    let id = notes["notifications"][0]["id"].as_i64().unwrap();
    let changed = w.ok(&w.bob, "notification_read", json!({ "ids": [id] }));
    assert_eq!(changed["changed"], 0);
    assert_eq!(w.ok(&w.alice, "notification_list", json!({}))["unread"], 1);
    // 处理别人的申请:当作没有这条申请
    let request_id = w.ok(&w.alice, "friend_requests", json!({}))["incoming"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, _) = w.call(
        &w.bob,
        "friend_decide",
        json!({ "id": request_id, "decision": "accept" }),
    );
    assert_eq!(status, 404);
}

#[test]
fn the_local_superuser_has_no_friends_and_everything_needs_a_login() {
    let w = World::start();
    // 本机 socket 不是某个具体的人
    let (status, body) = uds(
        &w.daemon,
        "POST",
        "/api/v1/capabilities/friend_list",
        json!({}),
    );
    assert!(status == 403 || status == 404, "{status} {body}");
    // 没登录
    let (status, ..) = http(
        w.port(),
        "POST",
        "/api/v1/capabilities/friend_list",
        None,
        Some(json!({})),
    );
    assert_eq!(status, 401);
    let (status, ..) = http(
        w.port(),
        "POST",
        "/api/v1/capabilities/notification_list",
        None,
        Some(json!({})),
    );
    assert_eq!(status, 401);
}

#[test]
fn notification_email_preferences_are_per_kind_and_validated() {
    let w = World::start();
    let prefs = w.ok(&w.alice, "notification_prefs", json!({}));
    assert_eq!(prefs["email"]["friend_request"], true);
    assert_eq!(prefs["email"]["comment_reply"], false);
    assert_eq!(
        prefs["mail_available"], false,
        "没配发信时界面据此提示邮件不可用"
    );
    let changed = w.ok(
        &w.alice,
        "notification_prefs",
        json!({ "email": { "friend_request": false } }),
    );
    assert_eq!(changed["email"]["friend_request"], false);
    assert_eq!(
        w.ok(&w.bob, "notification_prefs", json!({}))["email"]["friend_request"],
        true,
        "只改自己的"
    );
    let (status, _) = w.call(
        &w.alice,
        "notification_prefs",
        json!({ "email": { "bogus": true } }),
    );
    assert_eq!(status, 400);
}

#[test]
fn turning_off_the_friends_feature_for_one_person_closes_every_friend_capability_but_not_notifications()
 {
    let w = World::start();
    let admin = w.login_as("admin", "admin password 1");
    w.ok(
        &admin,
        "user_feature",
        json!({ "id": w.ids["alice"], "feature": "collab.friends", "effect": "deny" }),
    );
    // 权限缓存会在几秒内刷新:等 alice 的功能表里没有这一项
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let (_, _, me) = http(w.port(), "GET", "/api/v1/auth/me", Some(&w.alice), None);
        let has = me["data"]["user"]["features"]
            .as_array()
            .is_some_and(|items| items.iter().any(|f| f == "collab.friends"));
        if !has {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "例外没有生效");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    for (name, args) in [
        ("friend_search", json!({ "query": "bob" })),
        ("friend_request", json!({ "user_id": w.ids["bob"] })),
        ("friend_requests", json!({})),
        ("friend_list", json!({})),
        ("block", json!({ "user_id": w.ids["bob"] })),
        ("block_list", json!({})),
    ] {
        let (status, body) = w.call(&w.alice, name, args);
        assert!(
            status == 403 || status == 404,
            "{name} 应被拒:{status} {body}"
        );
    }
    // 通知不依赖好友功能(分享、@ 提及等都会发通知)
    assert_eq!(w.call(&w.alice, "notification_list", json!({})).0, 200);
    // 别人不受影响
    assert_eq!(w.call(&w.bob, "friend_list", json!({})).0, 200);
}
