//! 安全审查(复查记录)发现的问题的回归测试:
//! 每个问题先在这里复现成红,修好之后变绿;改回去会再变红。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_security`

#![cfg(feature = "testkit")]

mod support;

use serde_json::json;
use support::Harness;

/// S-1:`save_file` / `convert_to_markdown` / `file_preview` 的 `path` 不能指到知识库外面。
#[test]
fn file_capabilities_refuse_paths_outside_the_users_library() {
    let h = Harness::start();
    let victim = h.daemon.home.path().join("VICTIM-secrets.toml");
    std::fs::write(&victim, "api_key = \"sk-VERY-SECRET\"\n").unwrap();
    let victim_abs = victim.to_string_lossy().into_owned();

    for attack in ["../../../VICTIM-secrets.toml", victim_abs.as_str()] {
        let (status, body) = h.call(
            "alice",
            "save_file",
            json!({ "collection": "_global", "path": attack, "content": "OVERWRITTEN" }),
        );
        assert_eq!(status, 400, "save_file {attack}: {body}");
        let (status, body) = h.call(
            "alice",
            "convert_to_markdown",
            json!({ "collection": "_global", "path": attack }),
        );
        assert_eq!(status, 400, "convert_to_markdown {attack}: {body}");
        let (status, body) = h.call(
            "alice",
            "file_preview",
            json!({ "collection": "_global", "path": attack }),
        );
        assert_eq!(status, 400, "file_preview {attack}: {body}");
        assert!(
            !body.to_string().contains("sk-VERY-SECRET"),
            "内容不能泄露:{body}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(&victim).unwrap(),
        "api_key = \"sk-VERY-SECRET\"\n",
        "受害文件不能被改动"
    );
    assert!(!h.daemon.home.path().join("VICTIM-secrets.md").exists());
}

/// S-2:把服务器上的目录扫进自己的知识库,等于读任意文件。只有 `sources.local` 才行,普通用户没有。
#[test]
fn ordinary_users_cannot_scan_server_directories_or_add_local_and_git_sources() {
    let h = Harness::start();
    let dir = h.daemon.home.path().join("other-users-data");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("secrets.md"), "sk-VERY-SECRET-FROM-ANOTHER-USER").unwrap();
    let dir_text = dir.to_string_lossy().into_owned();

    let (status, body) = h.call("alice", "import_global", json!({ "path": dir_text }));
    assert_eq!(status, 403, "import_global: {body}");
    for (kind, uri) in [
        ("local_dir", dir_text.as_str()),
        ("git", dir_text.as_str()),
        ("git", "https://internal.example/repo.git"),
    ] {
        let (status, body) = h.call(
            "alice",
            "add_source",
            json!({ "kind": kind, "uri": uri, "collection": "_global" }),
        );
        assert_eq!(status, 403, "add_source {kind} {uri}: {body}");
    }
    // 什么都没有被索引
    let (_, found) = h.call(
        "alice",
        "search_knowledge",
        json!({ "query": "sk-VERY-SECRET" }),
    );
    // (回显的查询文本里本来就有这串字,所以只看命中)
    assert_eq!(
        found["hits"].as_array().map(Vec::len),
        Some(0),
        "不能搜到别人的数据:{found}"
    );
    // 管理员(全部功能)照常可以
    let (status, body) = h.call(
        "admin",
        "add_source",
        json!({ "kind": "local_dir", "uri": dir_text, "collection": "_global" }),
    );
    assert_eq!(status, 200, "管理员可以添加本机目录来源:{body}");
}

/// S-2:网页来源是普通用户默认就有的功能,但不能被用来访问本机 / 内网 / 云元数据地址。
#[test]
fn web_sources_cannot_reach_loopback_or_metadata_addresses() {
    let h = Harness::start();
    // 本机上有一个"内部服务":抓取要是真的连了它,这里就能看到
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();

    for uri in [
        format!("http://127.0.0.1:{port}/"),
        format!("http://localhost:{port}/"),
        "http://169.254.169.254/latest/meta-data/".to_owned(),
    ] {
        let (status, body) = h.call(
            "alice",
            "add_source",
            json!({ "kind": "web", "uri": uri, "collection": "_global", "depth": 1 }),
        );
        assert_eq!(status, 200, "网页来源本身可以登记:{body}");
        let id = body["source"]["id"].as_str().expect("来源 id").to_owned();
        let (status, body) = h.call("alice", "sync_source", json!({ "id": id }));
        assert!(
            status >= 400,
            "同步指向内网的网页来源必须失败,而不是悄悄成功:{status} {body}"
        );
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(
        listener.accept().is_err(),
        "被拒绝的网页来源不能向本机服务发出任何连接"
    );
}

/// S-2:收回 `sources.local` 之后,用户以前建的本机目录来源也不能再同步或改地址。
#[test]
fn losing_sources_local_also_stops_existing_local_sources() {
    let h = Harness::start();
    let dir = h.daemon.home.path().join("some-dir");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("a.md"), "# 一份文档\n正文\n").unwrap();
    let dir_text = dir.to_string_lossy().into_owned();

    // 给 alice 一个带 sources.local 的危险角色
    let role = h.ok(
        "admin",
        "role_create",
        json!({ "name": "能读本机目录", "features": ["sources.web", "sources.local"], "dangerous": true }),
    );
    let role_id = role["role"]["id"].as_str().expect("角色 id").to_owned();
    let wait_for = |what: &str, mut check: Box<dyn FnMut() -> bool + '_>| {
        for _ in 0..40 {
            if check() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        panic!("等不到:{what}");
    };
    h.ok(
        "admin",
        "user_update",
        json!({ "id": h.id("alice"), "role_id": role_id }),
    );
    let mut source_id = String::new();
    wait_for(
        "alice 拿到 sources.local",
        Box::new(|| {
            let (status, body) = h.call(
                "alice",
                "add_source",
                json!({ "kind": "local_dir", "uri": dir_text, "collection": "_global" }),
            );
            if status == 200 {
                source_id = body["source"]["id"].as_str().unwrap_or_default().to_owned();
            }
            status == 200
        }),
    );
    let (status, body) = h.call("alice", "sync_source", json!({ "id": source_id }));
    assert_eq!(status, 200, "有权限时可以同步:{body}");

    // 收回:改回普通角色
    h.ok(
        "admin",
        "user_update",
        json!({ "id": h.id("alice"), "role_id": "role_user" }),
    );
    wait_for(
        "alice 的 sources.local 被收回",
        Box::new(|| h.call("alice", "sync_source", json!({ "id": source_id })).0 == 403),
    );
    let (status, body) = h.call(
        "alice",
        "update_source",
        json!({ "id": source_id, "uri": "/etc" }),
    );
    assert_eq!(status, 403, "也不能把地址改成别的目录:{body}");
    let (status, body) = h.call("alice", "remove_source", json!({ "id": source_id }));
    assert_eq!(
        status, 403,
        "收回 sources.local 后也不能移除本机来源:{body}"
    );
}

// ---------------------------------------------------------------- 安全审查 H-1 / H-2:登录护栏

/// 从指定来源 IP(经本机反向代理的转发头)登录一次,返回状态码。
fn login_from(h: &Harness, ip: &str, who: &str, password: &str) -> u16 {
    let (status, _, _) = support::http_with(
        h.port(),
        "POST",
        "/api/v1/auth/login",
        None,
        Some(json!({ "login": who, "password": password })),
        &[("X-Forwarded-For", ip)],
    );
    status
}

/// H-1:限速以前按来源 IP 计数,而且任何成功登录都会清零——攻击者每猜几次别人的密码,
/// 就用自己的账号登录一次,失败记录永远攒不满。
#[test]
fn a_successful_login_of_your_own_does_not_wipe_your_failed_guesses_at_someone_else() {
    let h = Harness::start();
    let attacker_ip = "198.51.100.7";
    for guess in 0..4 {
        assert_eq!(
            login_from(&h, attacker_ip, "alice", &format!("wrong guess {guess}")),
            401
        );
    }
    // 用自己的账号登录成功(攻击者当然有自己的账号)
    assert_eq!(login_from(&h, attacker_ip, "bob", "bob password 1"), 200);
    // 第 5 次猜错之后,这个来源就该被挡住了
    assert_eq!(login_from(&h, attacker_ip, "alice", "wrong guess 5"), 401);
    assert_eq!(
        login_from(&h, attacker_ip, "alice", "wrong guess 6"),
        429,
        "成功登录不能把失败次数清零"
    );
    // 别的来源不受影响
    assert_eq!(
        login_from(&h, "203.0.113.9", "alice", "alice password 1"),
        200
    );
}

/// H-1:换着 IP 猜同一个账号(代理池 / 僵尸网络)也要被锁住;不存在的账号表现一样,猜不出谁注册过。
#[test]
fn guessing_one_account_from_many_addresses_locks_that_account() {
    let h = Harness::start();
    let wrong_then_locked = |who: &str| {
        for n in 0..10 {
            let ip = format!("192.0.2.{}", n + 1);
            assert_eq!(
                login_from(&h, &ip, who, "not the password"),
                401,
                "{who} #{n}"
            );
        }
        // 第 11 次来自又一个全新的 IP:连正确的密码也被拒(账号被锁)
        login_from(&h, "192.0.2.200", who, "alice password 1")
    };
    assert_eq!(wrong_then_locked("alice"), 429, "已有账号被锁");
    assert_eq!(
        wrong_then_locked("nobody-here"),
        429,
        "不存在的账号表现完全一样"
    );
    // 同一个账号换种写法(大小写 / 邮箱)绕不开:计数按账号 id,不按输入的文字
    assert_eq!(
        login_from(&h, "192.0.2.201", "ALICE", "alice password 1"),
        429
    );
    // 别的账号照常
    assert_eq!(login_from(&h, "192.0.2.202", "bob", "bob password 1"), 200);
}

/// H-2:查两步验证状态时数据库出错,不能当成「没开两步验证」直接发会话。
#[test]
fn a_database_error_while_checking_two_factor_refuses_the_login_instead_of_skipping_it() {
    let h = Harness::start();
    assert_eq!(
        login_from(&h, "198.51.100.20", "alice", "alice password 1"),
        200
    );
    // 模拟数据库出问题:把两步验证的表弄没了,查询就会报错
    let db = rusqlite::Connection::open(h.daemon.home.path().join("system.db")).unwrap();
    db.execute_batch("ALTER TABLE user_totp RENAME TO user_totp_broken;")
        .unwrap();
    let (status, headers, body) = support::http_with(
        h.port(),
        "POST",
        "/api/v1/auth/login",
        None,
        Some(json!({ "login": "alice", "password": "alice password 1" })),
        &[("X-Forwarded-For", "198.51.100.21")],
    );
    assert!(
        status >= 500,
        "查询失败必须拒绝登录,而不是放行:{status} {body}"
    );
    assert!(
        !headers
            .to_ascii_lowercase()
            .contains("set-cookie: kb_session"),
        "不能发会话:{headers}"
    );
}

// ---------------------------------------------------------------- 安全审查 M-1:目录边界

/// 管理员主知识库里放两个名字有相同前缀的目录:`docs/a.md` 和 `docs2/b.md`。
fn two_similar_folders(h: &Harness) -> String {
    let dir = h.daemon.home.path().join("import-me");
    std::fs::create_dir_all(dir.join("docs")).unwrap();
    std::fs::create_dir_all(dir.join("docs2")).unwrap();
    std::fs::write(dir.join("docs/a.md"), "# A\n在 docs 里的文档\n").unwrap();
    std::fs::write(
        dir.join("docs2/b.md"),
        "# B\n在 docs2 里的文档,不该被看到\n",
    )
    .unwrap();
    let added = h.ok(
        "admin",
        "add_source",
        json!({ "kind": "local_dir", "uri": dir.to_string_lossy(), "collection": "_global" }),
    );
    let id = added["source"]["id"].as_str().unwrap().to_owned();
    h.ok("admin", "sync_source", json!({ "id": id }));
    for _ in 0..40 {
        let list = h.ok(
            "admin",
            "list_items",
            json!({ "collection": "_global", "page_size": 50 }),
        );
        if list["items"].as_array().map(Vec::len) == Some(2) {
            return h.space("admin");
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    panic!("两个文档没有索引完");
}

fn sources_of(list: &serde_json::Value) -> Vec<String> {
    let mut sources: Vec<String> = list["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["source"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    sources.sort();
    sources
}

/// M-1:分享 `docs` 目录,`path_prefix` 是纯字符串前缀,会把 `docs2/` 也列出来。
#[test]
fn a_shared_folder_does_not_leak_a_sibling_folder_that_shares_its_name_prefix() {
    let h = Harness::start();
    let space = two_similar_folders(&h);
    let target =
        json!({ "kind": "dir", "space_id": space, "collection": "_global", "path": "docs" });
    h.ok(
        "admin",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "viewer" }),
    );
    for prefix in ["docs", "docs/"] {
        let (status, list) = h.call_in(
            "bob",
            &space,
            "list_items",
            json!({ "collection": "_global", "path_prefix": prefix, "page_size": 50 }),
        );
        assert_eq!(status, 200, "{prefix}: {list}");
        assert_eq!(
            sources_of(&list),
            vec!["docs/a.md".to_owned()],
            "path_prefix={prefix:?} 只能看到被分享的目录:{list}"
        );
    }

    // 游客链接同理
    let created = h.ok(
        "admin",
        "link_create",
        json!({ "target": target, "audience": "anyone", "role": "viewer" }),
    );
    let token = created["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();
    let (status, _, body) = support::http_headers(
        h.port(),
        "POST",
        &format!("/api/v1/share/{token}/call/list_items"),
        &[("X-KB-CSRF", "1")],
        Some(json!({ "collection": "_global", "path_prefix": "docs", "page_size": 50 })),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        sources_of(&body["data"]),
        vec!["docs/a.md".to_owned()],
        "链接也不能越过目录边界:{body}"
    );
}

// ---------------------------------------------------------------- 安全审查 M-3:用户管理员不能越级

/// 管理员建好一个只有 `sys.users` 的「用户管理员」角色并交给 alice;返回 (用户管理员角色 id)。
fn make_user_admin(h: &Harness) -> String {
    let role = h.ok(
        "admin",
        "role_create",
        json!({ "name": "用户管理员", "features": ["sys.users"], "dangerous": true }),
    );
    let role_id = role["role"]["id"].as_str().unwrap().to_owned();
    h.ok(
        "admin",
        "user_update",
        json!({ "id": h.id("alice"), "role_id": role_id }),
    );
    // 身份有几秒缓存:等 alice 真的拿到 sys.users
    for _ in 0..40 {
        if h.call("alice", "role_list", json!({})).0 == 200 {
            return role_id;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    panic!("alice 没有拿到用户管理权限");
}

/// 管理员建一个角色,返回 id。
fn make_role(h: &Harness, name: &str, features: &[&str], dangerous: bool) -> String {
    let role = h.ok(
        "admin",
        "role_create",
        json!({ "name": name, "features": features, "dangerous": dangerous }),
    );
    role["role"]["id"].as_str().unwrap().to_owned()
}

/// M-3:用户管理员只检查了『目标角色是不是全功能管理员』,却可以把人设成别的危险角色(包括自己的同级角色),
/// 或者去改持有这类角色的人的密码——等于绕过『只有管理员能动管理员级账号』。
#[test]
fn a_user_admin_cannot_hand_out_or_take_over_roles_more_powerful_than_their_own() {
    let h = Harness::start();
    let helper_role = make_user_admin(&h);
    let local_dirs = make_role(&h, "能读本机目录", &["sources.web", "sources.local"], true);
    let assistant = make_role(&h, "能用助手", &["ai.assistant"], false);
    let bob = h.id("bob");

    // 把人设成危险角色:自己的同级角色、别的危险角色,都不行
    for role in [&helper_role, &local_dirs] {
        let (status, body) = h.call(
            "alice",
            "user_update",
            json!({ "id": bob, "role_id": role }),
        );
        assert_eq!(status, 403, "不能授予危险角色 {role}:{body}");
    }
    // 自己提升自己同理
    let (status, body) = h.call(
        "alice",
        "user_update",
        json!({ "id": h.id("alice"), "role_id": local_dirs }),
    );
    assert_eq!(status, 403, "{body}");

    // 对照组:普通角色照常能设,不然整个功能就废了
    let (status, body) = h.call(
        "alice",
        "user_update",
        json!({ "id": bob, "role_id": "role_user" }),
    );
    assert_eq!(status, 200, "{body}");

    // 持有危险角色的人,用户管理员不能改他的密码 / 状态(否则可以接管比自己权限大的账号)
    h.ok(
        "admin",
        "user_update",
        json!({ "id": h.id("carol"), "role_id": local_dirs }),
    );
    let (status, body) = h.call(
        "alice",
        "user_set_password",
        json!({ "id": h.id("carol"), "password": "hacked password 1" }),
    );
    assert_eq!(status, 403, "不能接管持有危险角色的账号:{body}");
    let (status, body) = h.call(
        "alice",
        "user_update",
        json!({ "id": h.id("carol"), "status": "disabled" }),
    );
    assert_eq!(status, 403, "{body}");
    // 管理员自己当然可以
    h.ok(
        "admin",
        "user_update",
        json!({ "id": h.id("carol"), "role_id": assistant }),
    );
}

// ---------------------------------------------------------------- 安全审查 M-4:eval_run 的黄金集路径

/// M-4:`eval_run` 的 `set` 原来能指到服务器上任意文件,解析失败的报错还会带回出错那一行的原文。
#[test]
fn eval_run_only_reads_golden_sets_from_the_users_own_eval_directory() {
    let h = Harness::start();
    let victim = h.daemon.home.path().join("VICTIM-secrets.toml");
    std::fs::write(
        &victim,
        "this line is a secret and not valid toml: sk-VERY-SECRET\n",
    )
    .unwrap();
    let victim_text = victim.to_string_lossy().into_owned();
    for attack in [
        victim_text.as_str(),
        "../../../VICTIM-secrets.toml",
        "/etc/passwd",
    ] {
        let (status, body) = h.call("alice", "eval_run", json!({ "set": attack }));
        assert_eq!(status, 400, "{attack}: {body}");
        assert!(
            !body.to_string().contains("sk-VERY-SECRET"),
            "报错里不能带出文件内容:{body}"
        );
    }
    // 不存在的文件:同样不暴露任何东西
    let (status, _) = h.call("alice", "eval_run", json!({ "set": "nope.toml" }));
    assert_eq!(status, 404);

    // 对照组:自己 eval 目录里的黄金集可以用
    let eval_dir = h
        .daemon
        .home
        .path()
        .join("spaces")
        .join(h.space("alice"))
        .join("eval");
    std::fs::create_dir_all(&eval_dir).unwrap();
    std::fs::write(eval_dir.join("mine.toml"), "case = []\n").unwrap();
    let (status, body) = h.call("alice", "eval_run", json!({ "set": "mine.toml" }));
    assert_eq!(status, 200, "{body}");
}

/// M-4 的前提:评测目录必须是每个人自己的。原来所有人共用 `<KB_HOME>/eval`,
/// alice 跑的评测结果 bob 查得到,『只能读 eval 目录里的文件』也就等于能读到别人的黄金集。
#[test]
fn eval_results_and_golden_sets_are_per_user() {
    let h = Harness::start();
    let alice_dir = h
        .daemon
        .home
        .path()
        .join("spaces")
        .join(h.space("alice"))
        .join("eval");
    std::fs::create_dir_all(&alice_dir).unwrap();
    std::fs::write(alice_dir.join("mine.toml"), "case = []\n").unwrap();
    let (status, body) = h.call("alice", "eval_run", json!({ "set": "mine.toml" }));
    assert_eq!(status, 200, "{body}");
    let alice = h.ok("alice", "eval_history", json!({}));
    assert_eq!(alice["runs"].as_array().map(Vec::len), Some(1), "{alice}");
    // bob 看不到 alice 的评测记录,也读不到她的黄金集
    let bob = h.ok("bob", "eval_history", json!({}));
    assert_eq!(bob["runs"].as_array().map(Vec::len), Some(0), "{bob}");
    let (status, body) = h.call("bob", "eval_run", json!({ "set": "mine.toml" }));
    assert_eq!(status, 404, "{body}");
}

// ---------------------------------------------------------------- 安全审查 M-5:事件推送的来源检查

/// M-5:协作和分享的 WebSocket 握手都检查 Origin,唯独 `/api/v1/ws`(进度 / 变更事件推送)没有。
#[test]
fn the_event_stream_refuses_handshakes_that_come_from_another_site() {
    use support::collab::{Connect, connect};
    let h = Harness::start();
    let cookie = format!("kb_session={}", h.cookie("alice"));
    let port = h.port();
    // 别的站点的页面发起的握手:拒绝
    match connect(
        port,
        "/api/v1/ws",
        &[("Cookie", &cookie), ("Origin", "https://evil.example")],
    ) {
        Connect::Refused(status) => assert_eq!(status, 403),
        Connect::Open(_) => panic!("跨站的事件推送握手必须被拒绝"),
    }
    // 对照组:同站的页面(Origin 和 Host 一致)和没有 Origin 的客户端照常能连
    let same_site = format!("http://127.0.0.1:{port}");
    for origin in [Some(same_site.as_str()), None] {
        let mut headers = vec![("Cookie", cookie.as_str())];
        if let Some(origin) = origin {
            headers.push(("Origin", origin));
        }
        match connect(port, "/api/v1/ws", &headers) {
            Connect::Open(_) => {}
            Connect::Refused(status) => panic!("Origin={origin:?} 不该被拒绝:{status}"),
        }
    }
}

// ---------------------------------------------------------------- 安全审查 M-6:分享密码的总锁

/// 从指定来源 IP 解锁一个有密码的分享链接,返回 (状态码, 错误码)。
fn unlock_from(h: &Harness, token: &str, ip: &str, password: &str) -> (u16, String) {
    let (status, _, body) = support::http_headers(
        h.port(),
        "POST",
        &format!("/api/v1/share/{token}/unlock"),
        &[("X-KB-CSRF", "1"), ("X-Forwarded-For", ip)],
        Some(json!({ "password": password })),
    );
    (
        status,
        body["error"]["code"].as_str().unwrap_or("").to_owned(),
    )
}

/// M-6:密码只按(链接, IP)限速,攻击者轮换 IP 就能对 4 位密码做在线暴力破解。
/// 现在每个链接还有一个不分 IP 的总锁。
#[test]
fn a_password_link_locks_for_everyone_when_guessed_at_from_many_addresses() {
    let h = Harness::start();
    let space = h.space("alice");
    let note = h.ok(
        "alice",
        "create_item",
        json!({ "collection": "_global", "title": "有密码的笔记", "body": "正文", "kind": "note" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let target =
        json!({ "kind": "insight", "space_id": space, "collection": "_global", "id": note });
    let created = h.ok(
        "alice",
        "link_create",
        json!({ "target": target, "audience": "anyone", "role": "viewer", "password": "1234" }),
    );
    let token = created["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();

    // 每个 IP 只猜一两次(远低于单 IP 的 5 次上限),但换了很多个 IP
    for n in 0..20 {
        let ip = format!("198.51.100.{}", n + 1);
        assert_eq!(
            unlock_from(&h, &token, &ip, "0000"),
            (401, "wrong_password".to_owned()),
            "第 {n} 次"
        );
    }
    // 再来一个全新的 IP,连正确的密码也被挡住:链接被总锁了
    assert_eq!(
        unlock_from(&h, &token, "203.0.113.50", "1234"),
        (429, "locked".to_owned())
    );
    // 总锁不影响别的链接
    let other = h.ok(
        "alice",
        "link_create",
        json!({ "target": target, "audience": "anyone", "role": "viewer", "password": "abcd" }),
    );
    let other_token = other["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(unlock_from(&h, &other_token, "203.0.113.50", "abcd").0, 200);
}

/// M-6:对照组——一个人输对了密码,不会因为链接上别人的失败记录被误伤,
/// 而且他的成功也不会抹掉别人留下的失败记录(否则攻击者拿到密码前的尝试就被洗掉了)。
#[test]
fn a_correct_password_still_works_below_the_limit_and_does_not_wipe_other_peoples_failures() {
    let h = Harness::start();
    let space = h.space("alice");
    let note = h.ok(
        "alice",
        "create_item",
        json!({ "collection": "_global", "title": "笔记", "body": "正文", "kind": "note" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let target =
        json!({ "kind": "insight", "space_id": space, "collection": "_global", "id": note });
    let created = h.ok(
        "alice",
        "link_create",
        json!({ "target": target, "audience": "anyone", "role": "viewer", "password": "1234" }),
    );
    let token = created["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();
    for n in 0..15 {
        let ip = format!("198.51.100.{}", n + 1);
        assert_eq!(unlock_from(&h, &token, &ip, "0000").0, 401);
    }
    // 总共才 15 次失败(上限 20):正确密码照常通过
    assert_eq!(unlock_from(&h, &token, "203.0.113.60", "1234").0, 200);
    // 他的成功没有把那 15 次失败洗掉:再来 5 次失败就满了
    for n in 0..5 {
        let ip = format!("198.51.100.{}", n + 100);
        assert_eq!(unlock_from(&h, &token, &ip, "0000").0, 401, "补第 {n} 次");
    }
    assert_eq!(unlock_from(&h, &token, "203.0.113.61", "1234").0, 429);
}

// ---------------------------------------------------------------- 安全审查 L-2 / I-2

/// L-2:`require_admin_totp` 只拦了浏览器会话,管理员的 API 令牌完全绕过它。
#[test]
fn the_admin_two_factor_requirement_also_applies_to_api_tokens() {
    let h = Harness::start();
    // 要求开启之前先签发一个管理员的 API 令牌
    let (status, _, created) = support::http(
        h.port(),
        "POST",
        "/api/v1/auth/tokens",
        Some(h.cookie("admin")),
        Some(json!({ "name": "automation", "scope": "api" })),
    );
    assert_eq!(status, 200, "{created}");
    let bearer = format!("Bearer {}", created["data"]["token"].as_str().unwrap());
    let call = |extra: &str| {
        support::http_headers(
            h.port(),
            "POST",
            "/api/v1/capabilities/user_list",
            &[("X-KB-CSRF", "1"), ("Authorization", extra)],
            Some(json!({})),
        )
    };
    assert_eq!(call(&bearer).0, 200, "要求开启之前令牌可用");

    let config = h.daemon.home.path().join("config.toml");
    let original = std::fs::read_to_string(&config).unwrap();
    std::fs::write(
        &config,
        format!("{original}\n[accounts]\nrequire_admin_totp = true\n"),
    )
    .unwrap();
    let mut blocked = None;
    for _ in 0..40 {
        let (status, _, body) = call(&bearer);
        if status == 403 {
            blocked = Some(body);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let body = blocked.expect("要求开启之后,没开两步验证的管理员的令牌也要被拦住");
    assert_eq!(body["error"]["code"], "totp_setup_required", "{body}");

    // 普通用户的令牌不受影响
    let (_, _, alice) = support::http(
        h.port(),
        "POST",
        "/api/v1/auth/tokens",
        Some(h.cookie("alice")),
        Some(json!({ "name": "mine", "scope": "api" })),
    );
    let alice_bearer = format!("Bearer {}", alice["data"]["token"].as_str().unwrap());
    let (status, ..) = support::http_headers(
        h.port(),
        "POST",
        "/api/v1/capabilities/list_collections",
        &[("X-KB-CSRF", "1"), ("Authorization", &alice_bearer)],
        Some(json!({})),
    );
    assert_eq!(status, 200);
}

/// I-2:站点在 HTTPS 反向代理后面时要带 HSTS;明文访问(本机开发)不能带,否则浏览器会把 localhost 锁死在 https 上。
#[test]
fn hsts_is_sent_only_for_requests_that_came_in_over_https() {
    let h = Harness::start();
    let (_, secure, _) = support::http_headers(
        h.port(),
        "GET",
        "/api/v1/health",
        &[("X-Forwarded-Proto", "https")],
        None,
    );
    assert!(
        secure
            .to_ascii_lowercase()
            .contains("strict-transport-security: max-age="),
        "{secure}"
    );
    let (_, plain, _) = support::http_headers(h.port(), "GET", "/api/v1/health", &[], None);
    assert!(
        !plain
            .to_ascii_lowercase()
            .contains("strict-transport-security"),
        "{plain}"
    );
}

// ---------------------------------------------------------------- 安全审查 L-4:游客表的增长

/// L-4:不带 cookie 的每次访问都是一个新游客并写进游客表。清 cookie 反复访问就能把表灌满。
#[test]
fn clearing_cookies_over_and_over_cannot_flood_the_guest_table() {
    let h = Harness::start();
    let space = h.space("alice");
    let note = h.ok(
        "alice",
        "create_item",
        json!({ "collection": "_global", "title": "公开笔记", "body": "正文", "kind": "note" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let target =
        json!({ "kind": "insight", "space_id": space, "collection": "_global", "id": note });
    let created = h.ok(
        "alice",
        "link_create",
        json!({ "target": target, "audience": "anyone", "role": "viewer" }),
    );
    let link_id = created["link"]["id"].as_str().unwrap().to_owned();
    let token = created["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();

    // 用很多不同的来源各访问一次(绕开单个来源的限速),每次都不带 cookie
    for n in 0..2100u32 {
        let ip = format!("10.{}.{}.{}", (n >> 16) & 255, (n >> 8) & 255, n & 255);
        let (status, _, _) = support::http_headers(
            h.port(),
            "GET",
            &format!("/api/v1/share/{token}"),
            &[("X-KB-CSRF", "1"), ("X-Forwarded-For", &ip)],
            None,
        );
        assert_eq!(status, 200, "第 {n} 次访问照常能看");
    }
    let db = rusqlite::Connection::open(h.daemon.home.path().join("system.db")).unwrap();
    let registered: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM guests WHERE first_link_id = ?1",
            [&link_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(registered, 2000, "一个链接一天最多登记 2000 个新游客");
}
