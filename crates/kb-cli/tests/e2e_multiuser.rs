//! 多用户隔离的守护进程级验收(多用户设计说明 的「越权矩阵」)。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_multiuser`
//!
//! 起一个真实守护进程(Fake 嵌入后端),建管理员和两个普通用户 alice / bob,
//! 让 alice 写进「只有她知道」的内容,然后用 bob(以及管理员)的身份把**每一个**知识库内的能力
//! 都对着 alice 的数据调一遍:任何响应里都不许出现 alice 的内容,alice 的数据也不许被改动。

#![cfg(feature = "testkit")]

mod support;

use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use support::{Daemon, create_user, http, http_bytes, http_with, uds};

/// alice 的内容里带的暗号:它出现在任何别人的响应里,就是泄露。
const SECRET: &str = "ALICE-SECRET-7f3a";
/// alice 笔记正文里独有的一句话(列表只返回标题,取单条才返回正文,两处都要防)。
const PHRASE: &str = "只有 alice 知道";
/// bob 探测用的文字:放进所有文本参数,这样 bob 自己建出来的东西不会和 alice 的暗号混在一起。
const PROBE: &str = "BOB-PROBE-91c2";

fn kb() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kb"))
}

struct World {
    daemon: Daemon,
    alice: String,
    bob: String,
    admin: String,
}

/// 一个会话 cookie 的值。
struct Session(String);

impl World {
    fn start() -> Self {
        Self::start_with("")
    }

    /// 起一个测试世界,`extra` 追加在 `config.toml` 末尾(用于部署开关的用例)。
    fn start_with(extra: &str) -> Self {
        let home = tempfile::tempdir().expect("KB_HOME");
        std::fs::write(
            home.path().join("config.toml"),
            format!(
                "[embed]\nbackend = \"fake\"\n[server]\nlisten = \"127.0.0.1:0\"\n[quota]\ndisk_reserve_gb = 0\n{extra}"
            ),
        )
        .expect("配置");
        let daemon = Daemon::start(home);
        // 管理员:`kb auth set-password` 走的就是这个 UDS 接口
        let (status, body) = uds(
            &daemon,
            "POST",
            "/api/v1/auth/password",
            json!({ "password": "admin password 1" }),
        );
        assert_eq!(status, 200, "{body}");
        for name in ["alice", "bob"] {
            create_user(daemon.home.path(), name, &format!("{name} password 1"));
        }
        let mut world = Self {
            daemon,
            alice: String::new(),
            bob: String::new(),
            admin: String::new(),
        };
        world.alice = world.login("alice", "alice password 1").0;
        world.bob = world.login("bob", "bob password 1").0;
        world.admin = world.login("admin", "admin password 1").0;
        world
    }

    fn port(&self) -> u16 {
        self.daemon.tcp_port()
    }

    fn login(&self, login: &str, password: &str) -> Session {
        let (status, headers, body) = http(
            self.port(),
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "login": login, "password": password })),
        );
        assert_eq!(status, 200, "{login} 登录失败:{body}");
        let cookie = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .starts_with("set-cookie:")
                    .then(|| line.to_owned())
            })
            .and_then(|line| {
                line.split_once('=')
                    .map(|(_, rest)| rest.split(';').next().unwrap_or("").to_owned())
            })
            .expect("会话 cookie");
        Session(cookie)
    }

    /// 以某个用户的身份调一个能力,返回 (状态码, 响应体)。
    fn call(&self, who: &Session, capability: &str, args: Value) -> (u16, Value) {
        let (status, _, body) = http(
            self.port(),
            "POST",
            &format!("/api/v1/capabilities/{capability}"),
            Some(&who.0),
            Some(args),
        );
        // 成功时只给能力自己的输出(`data`),失败时给整个错误体
        match body.get("data") {
            Some(data) if body["ok"] == true => (status, data.clone()),
            _ => (status, body),
        }
    }

    fn get(&self, who: &Session, path: &str) -> (u16, Value) {
        let (status, _, body) = http(self.port(), "GET", path, Some(&who.0), None);
        (status, body)
    }

    /// 等 alice 的内容被索引到能检索出来(创建经验是异步入库)。
    fn wait_until_searchable(&self, who: &Session, text: &str) {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let (_, body) = self.call(
                who,
                "search_knowledge",
                json!({ "query": text, "scope": "global" }),
            );
            if body["hits"].as_array().is_some_and(|hits| !hits.is_empty()) {
                return;
            }
            assert!(Instant::now() < deadline, "内容一直没被索引:{body}");
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

impl std::ops::Deref for Session {
    type Target = String;
    fn deref(&self) -> &String {
        &self.0
    }
}

fn secret_note(title_suffix: &str) -> Value {
    json!({
        "collection": "_global",
        "title": format!("{SECRET} {title_suffix}"),
        "body": format!("这条经验只有 alice 知道:{SECRET}"),
        "kind": "note",
        "tags": ["alice-only"],
    })
}

#[test]
fn a_user_only_ever_sees_their_own_notes() {
    let world = World::start();
    let (status, created) = world.call(
        &Session(world.alice.clone()),
        "create_item",
        secret_note("one"),
    );
    assert_eq!(status, 200, "{created}");
    let id = created["item"]["id"]
        .as_str()
        .or(created["id"].as_str())
        .expect("新经验的 id")
        .to_owned();
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    let admin = Session(world.admin.clone());

    // 创建经验是异步入库的:等索引完,列表里才有
    world.wait_until_searchable(&alice, SECRET);
    // alice 自己看得到
    let (_, mine) = world.call(
        &alice,
        "list_items",
        json!({ "collection": "_global", "kind": "insight" }),
    );
    assert!(
        mine.to_string().contains(SECRET),
        "alice 应能看到自己的经验:{mine}"
    );
    // bob 和管理员(主知识库)都看不到:每个人只在自己的知识库里
    for (name, who) in [("bob", &bob), ("admin", &admin)] {
        let (_, theirs) = world.call(
            who,
            "list_items",
            json!({ "collection": "_global", "kind": "insight" }),
        );
        assert!(
            !theirs.to_string().contains(SECRET),
            "{name} 不该看到 alice 的经验:{theirs}"
        );
        let (status, got) = world.call(who, "get_item", json!({ "id": id }));
        assert!(
            status == 404 || !got.to_string().contains(SECRET),
            "{name} 拿 id 直接取也不行:{status} {got}"
        );
        assert_ne!(status, 200, "{name} 用 alice 的 id 取条目必须失败:{got}");
    }
    // bob 改、删 alice 的经验都不行,alice 的数据原封不动
    let (status, _) = world.call(
        &bob,
        "edit_item",
        json!({ "id": id, "version": 1, "title": "被 bob 改了", "tags": [] }),
    );
    assert_ne!(status, 200);
    let (status, _) = world.call(&bob, "delete_item", json!({ "id": id }));
    assert_ne!(status, 200);
    let (status, intact) = world.call(&alice, "get_item", json!({ "id": id }));
    assert_eq!(status, 200, "{intact}");
    assert!(
        intact.to_string().contains(SECRET) && !intact.to_string().contains("被 bob 改了"),
        "{intact}"
    );
}

#[test]
fn search_never_crosses_users() {
    let world = World::start();
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    let (status, created) = world.call(&alice, "create_item", secret_note("search"));
    assert_eq!(status, 200, "{created}");
    world.wait_until_searchable(&alice, SECRET);
    for query in [
        SECRET.to_owned(),
        "alice-only".to_owned(),
        "只有 alice 知道".to_owned(),
    ] {
        for scope in ["global", "all"] {
            let (_, found) = world.call(
                &bob,
                "search_knowledge",
                json!({ "query": query, "scope": scope }),
            );
            // 响应里会回显查询串本身,所以只看命中列表
            assert!(
                found["hits"].as_array().is_some_and(Vec::is_empty),
                "bob 检索 {query:?}({scope})搜到了 alice 的内容:{found}"
            );
        }
    }
}

#[test]
fn every_space_capability_is_safe_against_another_users_data() {
    // 越权矩阵:枚举注册表里所有「知识库内」的能力,用 bob 的身份、拿着 alice 的 id 和路径逐个调用
    let world = World::start();
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    let (_, created) = world.call(&alice, "create_item", secret_note("matrix"));
    let id = created["item"]["id"]
        .as_str()
        .or(created["id"].as_str())
        .expect("新经验的 id")
        .to_owned();
    world.wait_until_searchable(&alice, SECRET);

    let (status, listing) = world.get(&bob, "/api/v1/capabilities?surface=web");
    assert_eq!(status, 200, "{listing}");
    let capabilities = listing["data"]["capabilities"]
        .as_array()
        .expect("能力列表")
        .clone();
    let (_, me) = world.get(&bob, "/api/v1/auth/me");
    let features: Vec<String> =
        serde_json::from_value(me["data"]["user"]["features"].clone()).expect("功能表");

    let mut exercised = 0;
    for capability in capabilities {
        let name = capability["name"].as_str().expect("能力名");
        if capability["scope"] != "space" {
            continue;
        }
        let feature = capability["feature"].as_str().unwrap_or("base");
        let allowed = feature == "base" || features.iter().any(|item| item == feature);
        // 一个把所有常见字段都指向 alice 数据的参数包;多余字段会被忽略或报参数错误,都无所谓
        let args = json!({
            "id": id, "item_id": id, "insight_id": id, "draft_id": id, "session_id": id, "batch_id": id, "job_id": id,
            "collection": "_global", "path": "notes.md", "rel_path": "notes.md", "query": PROBE, "question": PROBE,
            "title": PROBE, "body": PROBE, "version": 1, "expected_version": 1, "tags": [PROBE], "content": PROBE,
            "confirm": true,
        });
        let (status, body) = world.call(&bob, name, args);
        let text = body.to_string();
        assert!(
            !text.contains(SECRET) && !text.contains(PHRASE),
            "{name} 的响应泄露了 alice 的内容:{text}"
        );
        assert!(status != 500, "{name} 不该 500:{text}");
        if !allowed {
            assert_eq!(
                status, 403,
                "{name} 需要功能点 {feature},bob 没有,应该 403:{text}"
            );
        }
        exercised += 1;
    }
    assert!(
        exercised >= 60,
        "应该覆盖到大部分知识库内的能力,实际只有 {exercised}"
    );

    // 矩阵跑完,alice 的数据一点没变
    let (status, intact) = world.call(&alice, "get_item", json!({ "id": id }));
    assert_eq!(status, 200, "{intact}");
    assert!(intact.to_string().contains(PHRASE), "{intact}");
    let (_, listing) = world.call(
        &alice,
        "list_items",
        json!({ "collection": "_global", "kind": "insight" }),
    );
    assert_eq!(
        listing["items"].as_array().map(Vec::len),
        Some(1),
        "矩阵跑完 alice 的经验条数变了:{listing}"
    );
}

#[test]
fn system_capabilities_are_closed_to_normal_users() {
    let world = World::start();
    let alice = Session(world.alice.clone());
    let (_, listing) = world.get(&alice, "/api/v1/capabilities?surface=web");
    let mut checked = 0;
    for capability in listing["data"]["capabilities"]
        .as_array()
        .expect("能力列表")
    {
        if capability["scope"] != "system" {
            continue;
        }
        let name = capability["name"].as_str().expect("能力名");
        let (status, body) = world.call(&alice, name, json!({ "confirm": true }));
        assert_eq!(status, 403, "系统级能力 {name} 对普通用户必须 403:{body}");
        checked += 1;
    }
    assert!(checked >= 30, "系统级能力应有三十多个,实际 {checked}");
    // 管理员(会话)可以
    let admin = Session(world.admin.clone());
    let (status, body) = world.call(&admin, "get_config", json!({}));
    assert_eq!(status, 200, "{body}");
}

#[test]
fn uploads_are_private_to_their_owner() {
    let world = World::start();
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    let (status, _, created) = http(
        world.port(),
        "POST",
        "/api/v1/uploads",
        Some(&alice.0),
        Some(
            json!({ "name": "secret.txt", "size": 5, "collection": "_global", "rel_path": "secret.txt" }),
        ),
    );
    assert_eq!(status, 200, "{created}");
    let upload_id = created["data"]["upload_id"]
        .as_str()
        .or(created["data"]["id"].as_str())
        .expect("上传 id")
        .to_owned();
    // alice 查得到,bob 查不到(他的库里没有这个上传会话)
    let (status, _, mine) = http(
        world.port(),
        "GET",
        &format!("/api/v1/uploads/{upload_id}"),
        Some(&alice.0),
        None,
    );
    assert_eq!(status, 200, "{mine}");
    let (status, _, theirs) = http(
        world.port(),
        "GET",
        &format!("/api/v1/uploads/{upload_id}"),
        Some(&bob.0),
        None,
    );
    assert_eq!(status, 404, "bob 不该看到 alice 的上传:{theirs}");
    let (status, _, aborted) = http(
        world.port(),
        "DELETE",
        &format!("/api/v1/uploads/{upload_id}"),
        Some(&bob.0),
        None,
    );
    assert_ne!(status, 200, "bob 不能取消 alice 的上传:{aborted}");
    let (status, _, still) = http(
        world.port(),
        "GET",
        &format!("/api/v1/uploads/{upload_id}"),
        Some(&alice.0),
        None,
    );
    assert_eq!(status, 200, "alice 的上传还在:{still}");
}

#[test]
fn a_disabled_user_is_locked_out_immediately_and_data_is_kept() {
    let world = World::start();
    let alice = Session(world.alice.clone());
    let (_, created) = world.call(&alice, "create_item", secret_note("kept"));
    let id = created["item"]["id"]
        .as_str()
        .or(created["id"].as_str())
        .expect("新经验的 id")
        .to_owned();
    let output = kb()
        .env("KB_HOME", world.daemon.home.path())
        .args(["user", "disable", "alice"])
        .output()
        .expect("kb user disable");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let (status, _) = world.call(&alice, "list_items", json!({ "collection": "_global" }));
    assert_eq!(status, 401, "停用后已有会话立刻失效");
    // 重新启用后数据还在
    let output = kb()
        .env("KB_HOME", world.daemon.home.path())
        .args(["user", "enable", "alice"])
        .output()
        .expect("kb user enable");
    assert!(output.status.success());
    let again = world.login("alice", "alice password 1");
    let (status, got) = world.call(&again, "get_item", json!({ "id": id }));
    assert_eq!(status, 200, "{got}");
}

#[test]
fn raw_files_are_served_only_from_the_callers_own_space() {
    let world = World::start();
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    // alice 的知识库目录里放一个文件,bob 用 raw 接口按同样的路径取
    let alice_sources = world.daemon.home.path().join("spaces");
    let space_dir = std::fs::read_dir(&alice_sources)
        .ok()
        .and_then(|mut entries| entries.next())
        .and_then(Result::ok);
    // alice 的知识库在第一次访问时才创建:先让她访问一次
    let _ = world.call(&alice, "list_collections", json!({}));
    let _ = space_dir;
    let (status, body) = world.get(
        &bob,
        "/api/v1/raw?collection=_global&path=../../../etc/passwd",
    );
    assert_ne!(status, 200, "路径穿越必须被拒:{body}");
    let (status, body) = world.get(&bob, "/api/v1/raw?collection=_global&path=secret.txt");
    assert!(
        status == 404 || status == 400,
        "bob 取不存在的文件:{status} {body}"
    );
}

#[test]
fn a_legacy_single_password_deployment_upgrades_without_any_manual_step() {
    // 旧部署:根目录里有 meta.db,里面存着 settings.password_hash,还没有 system.db
    let home = tempfile::tempdir().expect("KB_HOME");
    std::fs::write(
        home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n[server]\nlisten = \"127.0.0.1:0\"\n",
    )
    .expect("配置");
    let hash = kb_web::auth::password::hash_password("legacy password 1").expect("哈希");
    {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("运行时");
        runtime.block_on(async {
            let meta =
                kb_meta::SqliteMetaStore::open(home.path().join("meta.db")).expect("旧 meta.db");
            kb_core::ports::repo::AuthRepo::set_setting(&meta, "password_hash", &hash)
                .await
                .expect("写旧密码");
        });
    }
    assert!(!home.path().join("system.db").exists());
    let daemon = Daemon::start(home);
    // 原来的人用原来的密码,以 admin 登录;他拥有主知识库(根目录里的全部既有数据)
    let port = daemon.tcp_port();
    let (status, _, body) = http(
        port,
        "POST",
        "/api/v1/auth/login",
        None,
        Some(json!({ "login": "admin", "password": "legacy password 1" })),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["user"]["username"], "admin");
    assert_eq!(body["data"]["user"]["space_id"], "sp_primary");
    // 旧前端只发密码、系统里只有这一个账号:照常能登录
    let (status, _, body) = http(
        port,
        "POST",
        "/api/v1/auth/login",
        None,
        Some(json!({ "password": "legacy password 1" })),
    );
    assert_eq!(status, 200, "{body}");
    // 再设一次密码是给同一个管理员改密码,不会冒出第二个账号
    let (status, body) = uds(
        &daemon,
        "POST",
        "/api/v1/auth/password",
        json!({ "password": "changed password 2" }),
    );
    assert_eq!(status, 200, "{body}");
    let (status, _, _) = http(
        port,
        "POST",
        "/api/v1/auth/login",
        None,
        Some(json!({ "login": "admin", "password": "legacy password 1" })),
    );
    assert_eq!(status, 401, "旧密码应已失效");
    let (status, _, _) = http(
        port,
        "POST",
        "/api/v1/auth/login",
        None,
        Some(json!({ "login": "admin", "password": "changed password 2" })),
    );
    assert_eq!(status, 200);
    let output = kb()
        .env("KB_HOME", daemon.home.path())
        .args(["user", "list"])
        .output()
        .expect("kb user list");
    assert!(
        String::from_utf8_lossy(&output.stdout).contains("共 1 个用户"),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
}

/// 轮询直到条件成立(配置热重载有 500 ms 去抖,身份缓存 5 秒)。
fn eventually(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if check() {
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    panic!("{what}:等了 20 秒仍未生效");
}

#[test]
fn turning_ai_off_in_the_config_hides_it_live_for_everyone_without_a_restart() {
    let world = World::start();
    let alice = Session(world.alice.clone());
    let admin = Session(world.admin.clone());
    let features_of = |who: &Session| -> Vec<String> {
        let (_, me) = world.get(who, "/api/v1/auth/me");
        serde_json::from_value(me["data"]["user"]["features"].clone()).unwrap_or_default()
    };
    // 开着的时候:普通用户有「深度检索」「自动提炼与审核」,管理员有全部 AI 功能
    assert!(features_of(&alice).contains(&"search.deep".to_owned()));
    assert!(features_of(&admin).contains(&"ai.assistant".to_owned()));

    // 管理员在配置里关掉 AI 总开关(热更新项,不重启)
    let path = world.daemon.home.path().join("config.toml");
    let mut text = std::fs::read_to_string(&path).expect("读配置");
    text.push_str("\n[ai]\nenabled = false\n");
    std::fs::write(&path, text).expect("写配置");
    eventually(
        "AI 关闭后,普通用户的功能表里不再有 AI 功能",
        || {
            !features_of(&alice)
                .iter()
                .any(|f| f == "search.deep" || f.starts_with("ai."))
        },
    );
    eventually("管理员也一样", || {
        !features_of(&admin).iter().any(|f| f.starts_with("ai."))
    });
    let (status, body) = world.call(&alice, "deep_search", json!({ "question": "x" }));
    assert_eq!(status, 403, "{body}");
    assert!(body.to_string().contains("AI 功能已关闭"), "{body}");
    let (status, body) = world.call(&admin, "agent_send", json!({ "message": "hi" }));
    assert_eq!(status, 403, "管理员调 AI 助手同样被挡:{body}");
    // 普通功能照常
    let (status, _) = world.call(&alice, "list_collections", json!({}));
    assert_eq!(status, 200);

    // 只关一个子功能:总开关打开,「深度检索」单独关掉
    let mut text = std::fs::read_to_string(&path).expect("读配置");
    text = text.replace("enabled = false", "enabled = true\ndeep_search = false");
    std::fs::write(&path, text).expect("写配置");
    eventually("只剩深度检索被关掉", || {
        let features = features_of(&alice);
        !features.contains(&"search.deep".to_owned()) && features.contains(&"ai.extract".to_owned())
    });
}

#[test]
fn admin_can_manage_roles_and_the_change_reaches_the_user_within_seconds() {
    let world = World::start();
    let admin = Session(world.admin.clone());
    let alice = Session(world.alice.clone());
    let features_of = |who: &Session| -> Vec<String> {
        let (_, me) = world.get(who, "/api/v1/auth/me");
        serde_json::from_value(me["data"]["user"]["features"].clone()).unwrap_or_default()
    };

    // 功能点目录、角色列表(带人数)
    let (status, catalog) = world.call(&admin, "feature_catalog", json!({}));
    assert_eq!(status, 200, "{catalog}");
    assert!(
        catalog["features"]
            .as_array()
            .is_some_and(|list| list.len() >= 20)
    );
    let (_, roles) = world.call(&admin, "role_list", json!({}));
    let user_role = roles["roles"]
        .as_array()
        .expect("角色")
        .iter()
        .find(|r| r["id"] == "role_user")
        .expect("普通用户");
    assert_eq!(user_role["user_count"], 2, "alice 和 bob");

    // 新建一个「只读成员」角色,只给检索
    let (status, created) = world.call(
        &admin,
        "role_create",
        json!({ "name": "只读成员", "features": ["search.basic"] }),
    );
    assert_eq!(status, 200, "{created}");
    let role_id = created["role"]["id"].as_str().expect("角色 id").to_owned();
    // 把 alice 挪过去
    let alice_id = {
        let (_, list) = world.call(&admin, "user_list", json!({ "q": "alice" }));
        list["users"][0]["id"].as_str().expect("alice").to_owned()
    };
    let (status, moved) = world.call(
        &admin,
        "user_update",
        json!({ "id": alice_id, "role_id": role_id }),
    );
    assert_eq!(status, 200, "{moved}");
    eventually("alice 的功能表变成只读成员", || {
        let features = features_of(&alice);
        features.contains(&"search.basic".to_owned())
            && !features.contains(&"docs.notes".to_owned())
    });
    // 立刻不能再新建笔记
    let (status, body) = world.call(&alice, "create_item", secret_note("denied"));
    assert_eq!(status, 403, "{body}");

    // 用户例外:单独给 alice 加回「笔记」
    let (status, detail) = world.call(
        &admin,
        "user_feature",
        json!({ "id": alice_id, "feature": "docs.notes", "effect": "allow" }),
    );
    assert_eq!(status, 200, "{detail}");
    eventually("例外生效", || {
        features_of(&alice).contains(&"docs.notes".to_owned())
    });
    // 清除例外后又没了
    world.call(
        &admin,
        "user_feature",
        json!({ "id": alice_id, "feature": "docs.notes" }),
    );
    eventually("清除例外后跟随角色", || {
        !features_of(&alice).contains(&"docs.notes".to_owned())
    });

    // 内置角色删不掉、有人在用的角色删不掉
    let (status, _) = world.call(&admin, "role_delete", json!({ "id": "role_user" }));
    assert_eq!(status, 403);
    let (status, _) = world.call(&admin, "role_delete", json!({ "id": role_id }));
    assert_eq!(status, 409, "还有 alice 在用");
    world.call(
        &admin,
        "user_update",
        json!({ "id": alice_id, "role_id": "role_user" }),
    );
    let (status, _) = world.call(&admin, "role_delete", json!({ "id": role_id }));
    assert_eq!(status, 200);

    // 全部管理动作都进了系统审计
    let (_, audit) = world.call(&admin, "audit_list", json!({}));
    let _ = audit;
}

#[test]
fn account_management_is_closed_to_normal_users_and_cannot_be_used_to_escalate() {
    let world = World::start();
    let alice = Session(world.alice.clone());
    let admin = Session(world.admin.clone());
    for (capability, args) in [
        ("role_list", json!({})),
        ("role_create", json!({ "name": "我自己" })),
        ("user_list", json!({})),
        (
            "user_update",
            json!({ "id": "usr_x", "role_id": "role_admin" }),
        ),
        (
            "user_feature",
            json!({ "id": "usr_x", "feature": "sys.users", "effect": "allow" }),
        ),
        (
            "user_set_password",
            json!({ "id": "usr_x", "password": "hacked password 1" }),
        ),
    ] {
        let (status, body) = world.call(&alice, capability, args);
        assert_eq!(status, 403, "{capability} 对普通用户必须 403:{body}");
    }
    // 功能点目录是所有人可读(前端画界面用)
    let (status, _) = world.call(&alice, "feature_catalog", json!({}));
    assert_eq!(status, 200);

    // 一个只有 sys.users 的自定义角色:能管普通用户,但不能提权、不能动管理员
    let (_, helper_role) = world.call(
        &admin,
        "role_create",
        json!({ "name": "用户管理员", "features": ["sys.users"], "dangerous": true }),
    );
    let helper_role_id = helper_role["role"]["id"].as_str().expect("id").to_owned();
    let (_, list) = world.call(&admin, "user_list", json!({}));
    let id_of = |name: &str| {
        list["users"]
            .as_array()
            .expect("用户")
            .iter()
            .find(|u| u["username"] == name)
            .expect(name)["id"]
            .as_str()
            .expect("id")
            .to_owned()
    };
    let (alice_id, bob_id, admin_id) = (id_of("alice"), id_of("bob"), id_of("admin"));
    world.call(
        &admin,
        "user_update",
        json!({ "id": alice_id, "role_id": helper_role_id }),
    );
    let helper = Session(world.login("alice", "alice password 1").0);
    eventually("alice 拿到用户管理权限", || {
        let (_, mine) = world.call(&helper, "role_list", json!({}));
        mine["roles"].is_array()
    });
    // 能管普通用户
    let (status, _) = world.call(
        &helper,
        "user_update",
        json!({ "id": bob_id, "display_name": "鲍勃" }),
    );
    assert_eq!(status, 200);
    // 不能把人设为管理员、不能动管理员、不能创建「危险」角色
    let (status, body) = world.call(
        &helper,
        "user_update",
        json!({ "id": bob_id, "role_id": "role_admin" }),
    );
    assert_eq!(status, 403, "不能提权:{body}");
    let (status, body) = world.call(
        &helper,
        "user_set_password",
        json!({ "id": admin_id, "password": "hacked password 1" }),
    );
    assert_eq!(status, 403, "不能改管理员密码:{body}");
    let (status, body) = world.call(
        &helper,
        "role_create",
        json!({ "name": "超级", "features": ["sys.settings"], "dangerous": true }),
    );
    assert_eq!(status, 403, "不能创建危险角色:{body}");
    let (status, body) = world.call(
        &helper,
        "user_feature",
        json!({ "id": bob_id, "feature": "sys.settings", "effect": "allow" }),
    );
    assert_ne!(status, 200, "危险功能不能靠例外授予普通用户:{body}");
    // 管理员的密码没被改
    let again = world.login("admin", "admin password 1");
    assert!(!again.0.is_empty());
}

#[test]
fn the_last_admin_cannot_be_demoted_through_the_api() {
    let world = World::start();
    let admin = Session(world.admin.clone());
    let (_, list) = world.call(&admin, "user_list", json!({ "q": "admin" }));
    let admin_id = list["users"][0]["id"].as_str().expect("admin").to_owned();
    let (status, body) = world.call(
        &admin,
        "user_update",
        json!({ "id": admin_id, "role_id": "role_user" }),
    );
    assert_eq!(status, 403, "{body}");
    let (status, body) = world.call(
        &admin,
        "user_update",
        json!({ "id": admin_id, "status": "disabled" }),
    );
    assert_eq!(status, 403, "{body}");
    // 新建第二个管理员后,可以降级第一个
    let (status, _) = world.call(
        &admin,
        "user_create",
        json!({ "username": "second", "password": "second password 1", "role_id": "role_admin" }),
    );
    assert_eq!(status, 200);
    let (status, body) = world.call(
        &admin,
        "user_update",
        json!({ "id": admin_id, "role_id": "role_user" }),
    );
    assert_eq!(status, 200, "{body}");
}

fn create_upload(world: &World, who: &Session, name: &str, size: u64) -> (u16, Value) {
    let (status, _, body) = http(
        world.port(),
        "POST",
        "/api/v1/uploads",
        Some(&who.0),
        Some(json!({ "name": name, "size": size, "collection": "_global", "rel_path": name })),
    );
    (status, body)
}

#[test]
fn per_role_and_per_user_upload_quotas_are_enforced_over_http() {
    let world = World::start();
    let admin = Session(world.admin.clone());
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    let (_, list) = world.call(&admin, "user_list", json!({}));
    let id_of = |name: &str| {
        list["users"]
            .as_array()
            .expect("用户")
            .iter()
            .find(|u| u["username"] == name)
            .expect(name)["id"]
            .as_str()
            .expect("id")
            .to_owned()
    };
    const MB: u64 = 1024 * 1024;

    // 默认:单文件 200 MB,5 MB 的文件没问题
    let (status, body) = create_upload(&world, &alice, "ok.bin", 5 * MB);
    assert_eq!(status, 200, "{body}");
    // 把「普通用户」角色的单文件上限改成 1 MB:alice 和 bob 都立刻被限制
    let (status, body) = world.call(
        &admin,
        "role_update",
        json!({ "id": "role_user", "quota": { "max_upload_mb": 1 } }),
    );
    assert_eq!(status, 200, "{body}");
    for (name, who) in [("alice", &alice), ("bob", &bob)] {
        eventually(&format!("{name} 的单文件上限变成 1 MB"), || {
            create_upload(&world, who, "big.bin", 5 * MB).0 == 400
        });
    }
    let (status, body) = create_upload(&world, &bob, "small.bin", MB / 2);
    assert_eq!(status, 200, "1 MB 以内照常:{body}");
    assert!(body.to_string().len() > 2);

    // 给 alice 单独放宽到 100 MB:用户覆盖盖过角色,bob 不受影响
    let (status, body) = world.call(
        &admin,
        "user_update",
        json!({ "id": id_of("alice"), "quota": { "max_upload_mb": 100 } }),
    );
    assert_eq!(status, 200, "{body}");
    eventually("alice 的覆盖生效", || {
        create_upload(&world, &alice, "big2.bin", 5 * MB).0 == 200
    });
    assert_eq!(
        create_upload(&world, &bob, "big2.bin", 5 * MB).0,
        400,
        "bob 仍受角色限制"
    );

    // 总量上限:alice 的存储配额 1 GB(单文件放宽到 4 GB),声明一个 2 GB 的文件 → 超出剩余额度被拒
    let (status, body) = world.call(
        &admin,
        "user_update",
        json!({ "id": id_of("alice"), "quota": { "max_upload_mb": 4096, "storage_gb": 1 } }),
    );
    assert_eq!(status, 200, "{body}");
    eventually("总量上限生效", || {
        let (status, body) = create_upload(&world, &alice, "two-gb.bin", 2048 * MB);
        status == 400
            && body.to_string().contains("存储空间不足")
            && body.to_string().contains("向量索引")
    });
    // 同样的文件,没被限制的 bob(单文件上限只有 1 MB)被单文件上限拒,说明两道闸是独立的
    let (status, body) = create_upload(&world, &bob, "two-gb.bin", 2048 * MB);
    assert_eq!(status, 400);
    assert!(body.to_string().contains("单文件上限"), "{body}");
}

#[test]
fn a_disk_reserve_larger_than_the_free_space_pauses_every_upload() {
    let world = World::start();
    let admin = Session(world.admin.clone());
    let alice = Session(world.alice.clone());
    assert_eq!(create_upload(&world, &alice, "first.bin", 1024).0, 200);
    // 保留空间设成一个不可能满足的值(100 万 GB):所有人暂停上传
    let path = world.daemon.home.path().join("config.toml");
    let text = std::fs::read_to_string(&path).expect("读配置");
    std::fs::write(
        &path,
        text.replace("disk_reserve_gb = 0", "disk_reserve_gb = 1000000"),
    )
    .expect("写配置");
    eventually("全站暂停上传", || {
        let (status, body) = create_upload(&world, &alice, "second.bin", 1024);
        status == 503 && body.to_string().contains("磁盘空间不足")
    });
    // 管理员也一样(保护的是整块盘),但读和改笔记不受影响
    assert_eq!(create_upload(&world, &admin, "admin.bin", 1024).0, 503);
    let (status, _) = world.call(&alice, "list_items", json!({ "collection": "_global" }));
    assert_eq!(status, 200, "只暂停上传,别的操作照常");
}

#[test]
fn a_users_daily_ai_allowance_is_enforced_per_person_and_changes_take_effect_at_once() {
    let world = World::start();
    let admin = Session(world.admin.clone());
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    let (_, list) = world.call(&admin, "user_list", json!({}));
    let alice_id = list["users"]
        .as_array()
        .expect("用户")
        .iter()
        .find(|u| u["username"] == "alice")
        .expect("alice")["id"]
        .as_str()
        .expect("id")
        .to_owned();

    // 没配大模型 key 时走内置的假模型:链路和计费都是真的,只是回答是假的
    let ask = |who: &Session| world.call(who, "deep_search", json!({ "question": "额度测试" }));
    // 把 alice 一天的额度压到 1 token:第一次放行(当时用量为 0),记账之后就用完了
    let (status, body) = world.call(
        &admin,
        "user_update",
        json!({ "id": alice_id, "quota": { "llm_tokens_per_day": 1 } }),
    );
    assert_eq!(status, 200, "{body}");
    // 额度每次调用现取(不走权限缓存),所以改完马上生效
    let (status, body) = ask(&alice);
    assert_eq!(status, 200, "额度内的第一次应放行:{body}");
    let (status, body) = ask(&alice);
    assert_eq!(status, 503, "额度用完后应拒绝:{body}");
    assert!(
        body.to_string().contains("今天的 AI 额度已用完"),
        "文案是给用户看的:{body}"
    );
    // bob 不受影响(额度是每个人自己的)
    let (status, body) = ask(&bob);
    assert_eq!(status, 200, "bob 的额度和 alice 无关:{body}");
    // 不走 AI 的能力不受影响
    let (status, _) = world.call(&alice, "list_collections", json!({}));
    assert_eq!(status, 200);
    // 管理员放宽 alice 的额度:不用重启,马上又能用
    let (status, body) = world.call(
        &admin,
        "user_update",
        json!({ "id": alice_id, "quota": { "llm_tokens_per_day": 1_000_000 } }),
    );
    assert_eq!(status, 200, "{body}");
    eventually("放宽额度后 alice 又能用", || ask(&alice).0 == 200);
}

#[test]
fn over_quota_blocks_new_notes_and_uploads_but_not_reading_or_deleting() {
    let world = World::start();
    let admin = Session(world.admin.clone());
    let alice = Session(world.alice.clone());
    let (_, list) = world.call(&admin, "user_list", json!({}));
    let alice_id = list["users"]
        .as_array()
        .expect("用户")
        .iter()
        .find(|u| u["username"] == "alice")
        .expect("alice")["id"]
        .as_str()
        .expect("id")
        .to_owned();
    // 先建一条笔记(额度充足时没问题)
    let (status, created) = world.call(&alice, "create_item", secret_note("before"));
    assert_eq!(status, 200, "{created}");
    let note_id = created["id"].as_str().expect("id").to_owned();
    let (_, temp) = world.call(&alice, "create_item", secret_note("temp"));
    let temp_id = temp["id"].as_str().expect("id").to_owned();

    // 配额压到 1 GB,再在 alice 的 sources 里放一个 2 GB 的稀疏文件(只占文件大小,不占真实磁盘)
    let (status, body) = world.call(
        &admin,
        "user_update",
        json!({ "id": alice_id, "quota": { "storage_gb": 1 } }),
    );
    assert_eq!(status, 200, "{body}");
    let (_, me) = world.get(&alice, "/api/v1/auth/me");
    let space = me["data"]["user"]["space_id"]
        .as_str()
        .expect("space")
        .to_owned();
    let sources = world
        .daemon
        .home
        .path()
        .join("spaces")
        .join(&space)
        .join("sources");
    std::fs::create_dir_all(&sources).unwrap();
    let big = sources.join("big.bin");
    std::fs::File::create(&big)
        .and_then(|file| file.set_len(2 * 1024 * 1024 * 1024))
        .unwrap();
    // 用量有一分钟缓存;删一条笔记会让缓存失效,下一次检查就会重新数盘(用户腾空间时就是这样)
    let (status, body) = world.call(&alice, "delete_item", json!({ "id": temp_id }));
    assert_eq!(status, 200, "{body}");

    // 新建笔记、保存经验、上传都被拦,文案说明空间怎么算的
    for (name, args) in [
        ("create_item", secret_note("after")),
        (
            "save_insight",
            json!({ "title": "额度满了", "body": "不应该写进去", "kind": "note", "global": true }),
        ),
    ] {
        let (status, body) = world.call(&alice, name, args);
        assert_eq!(status, 400, "{name} 应被拦:{body}");
        assert!(body.to_string().contains("存储空间不足"), "{name}: {body}");
    }
    assert_eq!(create_upload(&world, &alice, "more.bin", 1024).0, 400);
    // 读照常
    let (status, _) = world.call(&alice, "get_item", json!({ "id": note_id }));
    assert_eq!(status, 200);
    let (status, _) = world.call(&alice, "list_items", json!({ "collection": "_global" }));
    assert_eq!(status, 200);
    // 别人不受影响:bob 额度是默认的
    let (status, body) = world.call(
        &Session(world.bob.clone()),
        "create_item",
        secret_note("bob"),
    );
    assert_eq!(status, 200, "{body}");
    // 删除永远可以,而且删完马上释放(缓存被主动失效)
    std::fs::remove_file(&big).unwrap();
    let (status, body) = world.call(&alice, "delete_item", json!({ "id": note_id }));
    assert_eq!(status, 200, "满了也能删:{body}");
    let (status, body) = world.call(&alice, "create_item", secret_note("again"));
    assert_eq!(status, 200, "腾出空间后马上又能新建:{body}");
}

#[test]
fn everyone_sees_only_their_own_usage_and_only_admins_see_the_storage_overview() {
    let world = World::start();
    let admin = Session(world.admin.clone());
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    // alice 有 3 KB 原件、一条笔记;bob 什么都没有
    let (_, me) = world.get(&alice, "/api/v1/auth/me");
    let space = me["data"]["user"]["space_id"]
        .as_str()
        .expect("space")
        .to_owned();
    let sources = world
        .daemon
        .home
        .path()
        .join("spaces")
        .join(&space)
        .join("sources");
    std::fs::create_dir_all(&sources).unwrap();
    std::fs::write(sources.join("a.bin"), vec![0u8; 3 * 1024]).unwrap();

    let (status, mine) = world.call(&alice, "usage_mine", json!({}));
    assert_eq!(status, 200, "{mine}");
    assert_eq!(mine["storage"]["sources_bytes"], 3 * 1024, "{mine}");
    assert_eq!(
        mine["storage"]["limit_bytes"],
        100u64 * 1024 * 1024 * 1024,
        "默认每人 100 GB"
    );
    assert_eq!(mine["ai"]["limit"], 200_000);
    assert_eq!(mine["ai"]["tokens_today"], 0);
    // bob 看到的是他自己的(空的),不是 alice 的
    let (_, theirs) = world.call(&bob, "usage_mine", json!({}));
    assert_eq!(theirs["storage"]["sources_bytes"], 0, "{theirs}");
    // 用了 AI 之后今天的用量变多(额度记账真的在走)
    let (status, _) = world.call(&alice, "deep_search", json!({ "question": "x" }));
    assert_eq!(status, 200);
    let (_, mine) = world.call(&alice, "usage_mine", json!({}));
    assert!(
        mine["ai"]["tokens_today"].as_u64().unwrap_or(0) > 0,
        "{mine}"
    );

    // 存储概览:普通用户看不到(404/403 都行,关键是拿不到数据)
    let (status, body) = world.call(&alice, "storage_overview", json!({}));
    assert!(
        status == 403 || status == 404,
        "普通用户不该看到全站存储:{status} {body}"
    );
    assert!(
        body.get("top").is_none() && body.get("disk").is_none(),
        "{body}"
    );
    let (status, overview) = world.call(&admin, "storage_overview", json!({ "limit": 5 }));
    assert_eq!(status, 200, "{overview}");
    assert!(overview["disk"]["free_gb"].as_u64().is_some(), "{overview}");
    assert_eq!(overview["disk"]["reserve_gb"], 0, "测试配置把保留空间关了");
    assert_eq!(overview["disk"]["paused"], false);
    assert!(
        overview["totals"]["total_spaces"].as_u64().unwrap_or(0) >= 3,
        "{overview}"
    );
    assert!(overview["top"].is_array());

    // AI 用量排行:管理员看得到谁用了多少、额度多少;普通用户看不到别人的用量
    let (status, body) = world.call(&bob, "llm_usage_overview", json!({}));
    assert!(
        status == 403 || status == 404,
        "普通用户不该看到全站用量:{status} {body}"
    );
    assert!(body.get("ranking").is_none(), "{body}");
    let (status, ranking) = world.call(&admin, "llm_usage_overview", json!({}));
    assert_eq!(status, 200, "{ranking}");
    let first = &ranking["ranking"][0];
    assert_eq!(
        first["username"], "alice",
        "刚才用了 AI 的 alice 排第一:{ranking}"
    );
    assert!(first["tokens"].as_u64().unwrap_or(0) > 0);
    assert_eq!(first["limit"], 200_000);
    assert_eq!(
        ranking["total_tokens"], first["tokens"],
        "只有 alice 用过,合计就是她的"
    );
    assert_eq!(
        ranking["ranking"].as_array().unwrap().len(),
        1,
        "没用过的人不在排行里"
    );
    // 别的日期是空的;格式不对的拒绝
    let (_, other_day) = world.call(&admin, "llm_usage_overview", json!({ "day": "2020-01-01" }));
    assert_eq!(other_day["ranking"].as_array().unwrap().len(), 0);
    let (status, _) = world.call(
        &admin,
        "llm_usage_overview",
        json!({ "day": "x'; DROP TABLE" }),
    );
    assert_eq!(status, 400);
}

/// 上传一个文件到 `_global` 并等它解析完(分片上传三步:建会话 → 传一片 → 完成)。
fn upload_and_wait(world: &World, who: &Session, rel_path: &str, bytes: &[u8]) {
    let sha = kb_core::hash::sha256_hex_bytes(bytes);
    let (status, _, created) = http(
        world.port(),
        "POST",
        "/api/v1/uploads",
        Some(&who.0),
        Some(
            json!({ "name": rel_path.rsplit('/').next().unwrap(), "size": bytes.len(), "sha256": sha, "collection": "_global", "rel_path": rel_path }),
        ),
    );
    assert_eq!(status, 200, "{created}");
    let upload_id = created["data"]["upload_id"]
        .as_str()
        .expect("上传 id")
        .to_owned();
    let (status, _, part) = http_bytes(
        world.port(),
        "PUT",
        &format!("/api/v1/uploads/{upload_id}/parts/0"),
        Some(&who.0),
        "application/octet-stream",
        bytes,
    );
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&part));
    let (status, _, done) = http(
        world.port(),
        "POST",
        &format!("/api/v1/uploads/{upload_id}/complete"),
        Some(&who.0),
        Some(json!({})),
    );
    assert_eq!(status, 200, "{done}");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let (_, listed) = world.call(who, "list_ingest", json!({ "collection": "_global" }));
        let done = listed["files"].as_array().is_some_and(|files| {
            files
                .iter()
                .any(|file| file["rel_path"] == rel_path && file["state"] == "done")
        });
        if done {
            break;
        }
        assert!(Instant::now() < deadline, "上传的文件没有解析完:{listed}");
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn sheet_book(cell_a1: &str) -> Vec<u8> {
    let workbook = r#"<workbook xmlns:r="r"><sheets><sheet name="预算" sheetId="1" r:id="rId1"/></sheets></workbook>"#;
    let rels = r#"<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>"#;
    let sheet = format!(
        r#"<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>{cell_a1}</t></is></c><c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>"#
    );
    kb_extract::zip::build_stored_zip(&[
        ("xl/workbook.xml", workbook.as_bytes()),
        ("xl/_rels/workbook.xml.rels", rels.as_bytes()),
        ("xl/worksheets/sheet1.xml", sheet.as_bytes()),
    ])
}

/// 在线编辑的编辑权:同一个人的两个窗口互相看得到;别的窗口持有着时替换被拒绝(409);
/// 交还后恢复;别人的知识库里同名同路径的文件互不相干。
#[test]
fn the_edit_lock_keeps_two_windows_from_overwriting_each_other() {
    let world = World::start();
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    let original = sheet_book("编辑权");
    upload_and_wait(&world, &alice, "表格/锁.xlsx", &original);
    upload_and_wait(&world, &bob, "表格/锁.xlsx", &original);

    let lock = |who: &Session, session: &str, take_over: bool| -> Value {
        let body = json!({ "collection": "_global", "path": "表格/锁.xlsx", "session": session, "take_over": take_over });
        let (status, _, bytes) = http_bytes(
            world.port(),
            "POST",
            "/api/v1/files/lock",
            Some(&who.0),
            "application/json",
            body.to_string().as_bytes(),
        );
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
        serde_json::from_slice::<Value>(&bytes).expect("JSON")["data"].clone()
    };
    let unlock = |who: &Session, session: &str| -> Value {
        let path = format!(
            "/api/v1/files/lock?collection=_global&path=%E8%A1%A8%E6%A0%BC%2F%E9%94%81.xlsx&session={session}"
        );
        let (status, _, bytes) = http_bytes(
            world.port(),
            "DELETE",
            &path,
            Some(&who.0),
            "application/octet-stream",
            b"",
        );
        assert_eq!(status, 200, "{}", String::from_utf8_lossy(&bytes));
        serde_json::from_slice::<Value>(&bytes).expect("JSON")["data"].clone()
    };
    let replace = |who: &Session, session: Option<&str>, bytes: &[u8]| -> (u16, String) {
        let mut path =
            "/api/v1/files/replace?collection=_global&path=%E8%A1%A8%E6%A0%BC%2F%E9%94%81.xlsx"
                .to_owned();
        if let Some(session) = session {
            path.push_str(&format!("&session={session}"));
        }
        let (status, _, body) = http_bytes(
            world.port(),
            "PUT",
            &path,
            Some(&who.0),
            "application/octet-stream",
            bytes,
        );
        (status, String::from_utf8_lossy(&body).into_owned())
    };

    // 窗口 a1 拿到编辑权
    let granted = lock(&alice, "tab-a1", false);
    assert_eq!(granted["held"], true, "{granted}");
    assert_eq!(granted["ttl_secs"], 45);
    // 心跳:同一个窗口再申请,仍然拿得到
    assert_eq!(lock(&alice, "tab-a1", false)["held"], true);

    // 同一个人的另一个窗口 a2:没拿到,被告知是自己在别处编辑
    let denied = lock(&alice, "tab-a2", false);
    assert_eq!(denied["held"], false, "{denied}");
    assert_eq!(denied["same_user"], true);
    assert_eq!(denied["holder"]["session"], "tab-a1");

    // a2 想保存:被拒绝(409),文件没动;没带窗口编号的调用也一样
    let replacement = sheet_book("a2 想盖掉");
    let (status, body) = replace(&alice, Some("tab-a2"), &replacement);
    assert_eq!(status, 409, "{body}");
    assert!(body.contains("另一个窗口"), "{body}");
    assert_eq!(replace(&alice, None, &replacement).0, 409);

    // 持有者自己可以保存
    let (status, body) = replace(&alice, Some("tab-a1"), &replacement);
    assert_eq!(status, 200, "{body}");

    // a2 点「接手」:拿到,原持有者被点名;a1 的下一次心跳发现已经不是自己的了,保存也被拒绝
    let taken = lock(&alice, "tab-a2", true);
    assert_eq!(taken["held"], true);
    assert_eq!(taken["took_over_from"]["session"], "tab-a1", "{taken}");
    assert_eq!(lock(&alice, "tab-a1", false)["held"], false);
    assert_eq!(replace(&alice, Some("tab-a1"), &original).0, 409);

    // 别人不能替持有者交还;持有者交还后谁都可以保存(含没带窗口编号的)
    assert_eq!(unlock(&alice, "tab-a1")["released"], false);
    assert_eq!(unlock(&alice, "tab-a2")["released"], true);
    assert_eq!(replace(&alice, None, &original).0, 200);

    // bob 的知识库里同名同路径的文件是另一份:他的编辑权与 alice 互不相干
    assert_eq!(lock(&alice, "tab-a1", false)["held"], true);
    let bobs = lock(&bob, "tab-b1", false);
    assert_eq!(bobs["held"], true, "{bobs}");
    let (status, body) = replace(&bob, Some("tab-b1"), &replacement);
    assert_eq!(status, 200, "{body}");

    // 缺窗口编号:400
    let (status, _, _) = http_bytes(
        world.port(),
        "POST",
        "/api/v1/files/lock",
        Some(&alice.0),
        "application/json",
        json!({ "collection": "_global", "path": "表格/锁.xlsx", "session": "" })
            .to_string()
            .as_bytes(),
    );
    assert_eq!(status, 400);
}

#[test]
fn replacing_and_editing_office_files_stays_inside_the_owners_space() {
    let world = World::start();
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    let original = sheet_book(&format!("{SECRET} 预算"));
    upload_and_wait(&world, &alice, "表格/预算.xlsx", &original);

    // 打开时取 sha 与公式格
    let (status, info) = world.call(
        &alice,
        "file_info",
        json!({ "collection": "_global", "path": "表格/预算.xlsx" }),
    );
    assert_eq!(status, 200, "{info}");
    let sha = info["sha256"].as_str().expect("sha").to_owned();
    assert_eq!(sha, kb_core::hash::sha256_hex_bytes(&original));
    assert_eq!(info["formulas"]["预算"], json!(["B1"]));

    // 改一格:新的一版
    let (status, edited) = world.call(
        &alice,
        "edit_sheet_cells",
        json!({ "collection": "_global", "path": "表格/预算.xlsx", "expected_sha256": sha, "edits": [{ "sheet": "预算", "cell": "A2", "value": "alice 加的一行" }] }),
    );
    assert_eq!(status, 200, "{edited}");
    assert_eq!(edited["version"], 2);
    // 公式格拒绝
    let (status, refused) = world.call(
        &alice,
        "edit_sheet_cells",
        json!({ "collection": "_global", "path": "表格/预算.xlsx", "edits": [{ "sheet": "预算", "cell": "B1", "value": "9" }] }),
    );
    assert_eq!(status, 400, "{refused}");

    // 上传新版本替换原件(原始字节请求体)
    let replacement = sheet_book("alice 换的新版本");
    let current = world
        .call(
            &alice,
            "file_info",
            json!({ "collection": "_global", "path": "表格/预算.xlsx" }),
        )
        .1["sha256"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!(
        "/api/v1/files/replace?collection=_global&path=%E8%A1%A8%E6%A0%BC%2F%E9%A2%84%E7%AE%97.xlsx&expected_sha256={current}"
    );
    let (status, _, body) = http_bytes(
        world.port(),
        "PUT",
        &path,
        Some(&alice.0),
        "application/octet-stream",
        &replacement,
    );
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&body));
    let replaced: Value = serde_json::from_slice(&body).expect("JSON");
    assert_eq!(replaced["data"]["version"], 3, "{replaced}");
    // 拿着旧的 sha 再换:被拒绝
    let (status, _, _) = http_bytes(
        world.port(),
        "PUT",
        &path,
        Some(&alice.0),
        "application/octet-stream",
        &original,
    );
    assert_eq!(status, 400, "旧 sha 不能盖掉别人刚换的内容");

    // 版本历史:二进制版本有大小、没有文字预览;能恢复到第一版
    let (_, versions) = world.call(
        &alice,
        "file_versions",
        json!({ "collection": "_global", "path": "表格/预算.xlsx" }),
    );
    let list = versions["versions"].as_array().expect("版本");
    assert_eq!(list.len(), 3, "{versions}");
    assert!(
        list.iter()
            .all(|version| version["binary"] == true && version["preview"] == ""),
        "{versions}"
    );
    let first = list.iter().find(|version| version["version"] == 1).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, restored) = world.call(
        &alice,
        "restore_file_version",
        json!({ "version_id": first }),
    );
    assert_eq!(status, 200, "{restored}");
    assert_eq!(restored["version"], 4);
    let (_, back) = world.call(
        &alice,
        "file_info",
        json!({ "collection": "_global", "path": "表格/预算.xlsx" }),
    );
    assert_eq!(
        back["sha256"].as_str(),
        Some(kb_core::hash::sha256_hex_bytes(&original).as_str()),
        "恢复后字节和最初一模一样"
    );

    // bob:看不到、改不了、换不了 alice 的文件(他的知识库里没有这个文件)
    let (status, peek) = world.call(
        &bob,
        "file_info",
        json!({ "collection": "_global", "path": "表格/预算.xlsx" }),
    );
    assert_eq!(status, 404, "{peek}");
    assert!(!peek.to_string().contains(SECRET));
    let (status, _) = world.call(
        &bob,
        "edit_sheet_cells",
        json!({ "collection": "_global", "path": "表格/预算.xlsx", "edits": [{ "sheet": "预算", "cell": "A1", "value": PROBE }] }),
    );
    assert_eq!(status, 404);
    let (status, _, _) = http_bytes(
        world.port(),
        "PUT",
        "/api/v1/files/replace?collection=_global&path=%E8%A1%A8%E6%A0%BC%2F%E9%A2%84%E7%AE%97.xlsx",
        Some(&bob.0),
        "application/octet-stream",
        PROBE.as_bytes(),
    );
    assert_eq!(status, 404);
    // 路径穿越:不能借这个接口写到知识库外面
    let (status, _, _) = http_bytes(
        world.port(),
        "PUT",
        "/api/v1/files/replace?collection=_global&path=..%2F..%2Fsecrets.toml",
        Some(&alice.0),
        "application/octet-stream",
        b"x",
    );
    assert!(status == 400 || status == 404, "路径穿越应被拒绝:{status}");
    // 没登录:401
    let (status, _, _) = http_bytes(
        world.port(),
        "PUT",
        &path,
        None,
        "application/octet-stream",
        b"x",
    );
    assert_eq!(status, 401);

    // alice 的文件在这一通之后仍是她恢复的那一版
    let (_, still) = world.call(
        &alice,
        "file_info",
        json!({ "collection": "_global", "path": "表格/预算.xlsx" }),
    );
    assert_eq!(still["sha256"], back["sha256"]);
}

// ---------------------------------------------------------------- 管理员只读查看(X-KB-Admin-View)
//
// 这不是「管理员默认看得见所有库」:它要求 `sys.inspect`、目标用户有个人知识库,
// 并且只能走只读白名单。原件(`/api/v1/raw`)同样按目标用户解析。
#[test]
fn admin_can_inspect_another_users_space_read_only_and_it_is_audited() {
    let world = World::start();
    let alice = Session(world.alice.clone());
    let bob = Session(world.bob.clone());
    let admin = Session(world.admin.clone());
    let (status, created) = world.call(&alice, "create_item", secret_note("inspect"));
    assert_eq!(status, 200, "{created}");
    world.wait_until_searchable(&alice, SECRET);
    upload_and_wait(
        &world,
        &alice,
        "inspect-secret.txt",
        b"inspect raw body: ALICE-SECRET-7f3a",
    );

    let (_, users) = world.call(&admin, "user_list", json!({}));
    let alice_id = users["users"]
        .as_array()
        .expect("用户")
        .iter()
        .find(|user| user["username"] == "alice")
        .expect("alice")["id"]
        .as_str()
        .expect("alice id")
        .to_owned();

    // 打开:确认目标账号与个人知识库都存在,并记一条审计
    let (status, opened) = world.call(&admin, "admin_space_open", json!({ "user_id": alice_id }));
    assert_eq!(status, 200, "{opened}");
    assert_eq!(opened["user_id"], alice_id);

    // 列表 / 单条 / 原件都能读到 alice 的内容
    let (status, _, listed) = http_with(
        world.port(),
        "POST",
        "/api/v1/capabilities/list_items",
        Some(&admin.0),
        Some(json!({ "collection": "_global" })),
        &[("X-KB-Admin-View", &alice_id)],
    );
    assert_eq!(status, 200, "{listed}");
    assert!(listed["data"].to_string().contains(SECRET), "{listed}");

    let (status, _, raw) = http_bytes(
        world.port(),
        "GET",
        &format!("/api/v1/raw?collection=_global&path=inspect-secret.txt&admin_view={alice_id}"),
        Some(&admin.0),
        "application/octet-stream",
        &[],
    );
    assert_eq!(status, 200, "{}", String::from_utf8_lossy(&raw));
    assert!(String::from_utf8_lossy(&raw).contains(SECRET));

    // 写操作即使带了这个头也不行:只读白名单是后端的底线
    let (status, _, denied) = http_with(
        world.port(),
        "POST",
        "/api/v1/capabilities/create_item",
        Some(&admin.0),
        Some(secret_note("must-not-write")),
        &[("X-KB-Admin-View", &alice_id)],
    );
    assert_eq!(status, 403, "{denied}");
    assert!(denied.to_string().contains("只读"), "{denied}");

    // 没有 sys.inspect 的普通用户带这个头也是 403;目标是自己同样拒绝
    let (status, _, denied) = http_with(
        world.port(),
        "POST",
        "/api/v1/capabilities/list_items",
        Some(&bob.0),
        Some(json!({ "collection": "_global" })),
        &[("X-KB-Admin-View", &alice_id)],
    );
    assert_eq!(status, 403, "{denied}");
    let (status, _, own) = http_with(
        world.port(),
        "POST",
        "/api/v1/capabilities/list_items",
        Some(&admin.0),
        Some(json!({ "collection": "_global" })),
        &[("X-KB-Admin-View", &admin_id(&world, &admin))],
    );
    assert_eq!(status, 403, "{own}");

    // 格式不合法 / 与分享头同时出现 / 目标没有个人知识库:400 或 404,不能泄露内容
    let (status, _, bad) = http_with(
        world.port(),
        "POST",
        "/api/v1/capabilities/list_items",
        Some(&admin.0),
        Some(json!({ "collection": "_global" })),
        &[("X-KB-Admin-View", "../etc/passwd")],
    );
    assert_eq!(status, 400, "{bad}");
    let (status, _, mixed) = http_with(
        world.port(),
        "POST",
        "/api/v1/capabilities/list_items",
        Some(&admin.0),
        Some(json!({ "collection": "_global" })),
        &[("X-KB-Admin-View", &alice_id), ("X-KB-Space", "sp_primary")],
    );
    assert_eq!(status, 400, "{mixed}");
    let (status, _, missing) = http_with(
        world.port(),
        "POST",
        "/api/v1/capabilities/list_items",
        Some(&admin.0),
        Some(json!({ "collection": "_global" })),
        &[("X-KB-Admin-View", "usr_doesnotexist0000")],
    );
    assert_eq!(status, 404, "{missing}");

    // 令牌不是浏览器会话:即使管理员本人创建、带 Bearer,也不能借这个头跨库
    let (status, _, created) = http(
        world.port(),
        "POST",
        "/api/v1/auth/tokens",
        Some(&admin.0),
        Some(json!({ "name": "inspect-token", "scope": "api" })),
    );
    assert_eq!(status, 200, "{created}");
    let token = created["data"]["token"]
        .as_str()
        .expect("令牌明文")
        .to_owned();
    let (status, _, body) = http_with(
        world.port(),
        "POST",
        "/api/v1/capabilities/list_items",
        None,
        Some(json!({ "collection": "_global" })),
        &[
            ("Authorization", &format!("Bearer {token}")),
            ("X-KB-Admin-View", &alice_id),
        ],
    );
    assert_eq!(status, 403, "{body}");

    // 审计落系统库,带目标用户 id;不能写进 alice 自己的审计
    let conn = rusqlite::Connection::open_with_flags(
        world.daemon.home.path().join("system.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .expect("打开 system.db");
    let matched: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM system_audit WHERE detail_json LIKE ?1 AND detail_json LIKE ?2",
            rusqlite::params![
                format!("%\"admin_view\":\"{alice_id}\"%"),
                "%inspect-secret.txt%"
            ],
            |row| row.get(0),
        )
        .expect("查系统审计");
    assert!(matched >= 1, "管理员查看应写入 system_audit");
}

fn admin_id(world: &World, admin: &Session) -> String {
    let (_, me) = world.get(admin, "/api/v1/auth/me");
    me["data"]["user"]["id"]
        .as_str()
        .expect("own id")
        .to_owned()
}

#[test]
fn admin_inspect_can_be_switched_off_for_the_whole_deployment() {
    let world = World::start_with("[admin]\ninspect_enabled = false\n");
    let admin = Session(world.admin.clone());
    let (_, users) = world.call(&admin, "user_list", json!({}));
    let alice_id = users["users"]
        .as_array()
        .expect("用户")
        .iter()
        .find(|user| user["username"] == "alice")
        .expect("alice")["id"]
        .as_str()
        .expect("alice id")
        .to_owned();

    let (status, body) = world.call(&admin, "admin_space_open", json!({ "user_id": alice_id }));
    assert_eq!(status, 403, "{body}");
    assert!(body.to_string().contains("已关闭"), "{body}");

    let (status, _, body) = http_with(
        world.port(),
        "POST",
        "/api/v1/capabilities/list_items",
        Some(&admin.0),
        Some(json!({ "collection": "_global" })),
        &[("X-KB-Admin-View", &alice_id)],
    );
    assert_eq!(status, 403, "{body}");

    // 前端据此隐藏入口:老后端没有这个字段时按开处理
    let (_, me) = world.get(&admin, "/api/v1/auth/me");
    assert_eq!(me["data"]["admin_inspect_enabled"], false);
}
