//! 多用户备份与恢复的端到端验收:真实守护进程里造出账号、笔记、授权、分享链接,
//! 用 `backup_create` 备份,再按 `docs/BACKUP_RESTORE.md` 的步骤解包到全新的目录起第二个守护进程,
//! 确认每个人的账号、数据、分享关系都回来了。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_backup_users`

#![cfg(feature = "testkit")]

mod support;

use std::process::Command;

use serde_json::json;
use support::{Daemon, Harness, http};

#[test]
fn a_backup_restores_every_account_every_library_and_the_sharing_between_them() {
    // 关掉定时备份:否则它可能在同一秒先写出一份,和手动备份撞名
    let h = Harness::start_with("[backup]\nenabled = false\n", |_| {});
    // 1. 造数据:alice 的笔记和分享、bob 的笔记、一个游客链接
    let space = h.space("alice");
    let note = h.ok(
        "alice",
        "create_item",
        json!({ "collection": "_global", "title": "备份测试笔记", "body": "这条笔记必须在恢复后还在", "kind": "note" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    h.ok("bob", "create_item", json!({ "collection": "_global", "title": "鲍勃的笔记", "body": "鲍勃自己的内容", "kind": "note" }));
    let target =
        json!({ "kind": "insight", "space_id": space, "collection": "_global", "id": note });
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "viewer" }),
    );
    let link = h.ok(
        "alice",
        "link_create",
        json!({ "target": target, "audience": "anyone", "role": "viewer" }),
    );
    let token = link["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();

    // 2. 备份并校验
    let created = h.ok("admin", "backup_create", json!({}));
    let name = created["name"].as_str().expect("归档名").to_owned();
    let verified = h.ok("admin", "backup_verify", json!({ "name": name }));
    assert_eq!(verified["system_db"], true, "{verified}");
    // 用户的库第一次用到才建:alice 和 bob 用过,carol 从没碰过,磁盘上还没有她的库
    assert_eq!(verified["spaces"], 2, "{verified}");

    // 3. 解包到全新目录(只解 tar,不碰原来的目录),再起第二个守护进程
    let restored = tempfile::tempdir().unwrap();
    let archive = h.daemon.home.path().join("backups").join(&name);
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(restored.path())
        .status()
        .unwrap();
    assert!(status.success());
    assert!(restored.path().join("system.db").is_file());
    assert!(restored.path().join("meta.db").is_file());
    let second = Daemon::start(restored);
    let port = second.tcp_port();
    // 手工建的备份里没有 secrets.toml(设计如此);登录密码在 system.db 里,不受影响

    // 4. 每个人用原来的密码登录,数据都在
    let login = |who: &str| -> String {
        let (status, headers, body) = http(
            port,
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "login": who, "password": format!("{who} password 1") })),
        );
        assert_eq!(status, 200, "{who} 应能用原来的密码登录:{body}");
        headers
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("set-cookie:"))
            .and_then(|l| l.split_once('='))
            .map(|(_, rest)| rest.split(';').next().unwrap_or("").to_owned())
            .expect("cookie")
    };
    let call = |cookie: &str, capability: &str, args: serde_json::Value| {
        let (status, _, body) = http(
            port,
            "POST",
            &format!("/api/v1/capabilities/{capability}"),
            Some(cookie),
            Some(args),
        );
        (status, body)
    };
    let alice = login("alice");
    let bob = login("bob");
    let (status, got) = call(&alice, "get_item", json!({ "id": note }));
    assert_eq!(status, 200, "{got}");
    assert_eq!(got["data"]["item"]["title"], "备份测试笔记");
    assert!(
        got["data"]["item"]["text"]
            .as_str()
            .unwrap()
            .contains("恢复后还在")
    );
    // 恢复后向量表是空的,经验条目由后台重新嵌入:等 bob 的列表里出现他的笔记(最多 30 秒)
    let mut titles: Vec<String> = Vec::new();
    for _ in 0..60 {
        let (_, theirs) = call(
            &bob,
            "list_items",
            json!({ "collection": "_global", "page_size": 50 }),
        );
        titles = theirs["data"]["items"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|i| i["title"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        if !titles.is_empty() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    assert!(titles.iter().any(|t| t == "鲍勃的笔记"), "{titles:?}");
    assert!(
        !titles.iter().any(|t| t == "备份测试笔记"),
        "bob 自己的库里不该有 alice 的笔记:{titles:?}"
    );
    // 授权关系还在:bob 的「共享给我」里有 alice 的笔记
    let (_, shared) = call(&bob, "shared_with_me", json!({}));
    assert!(
        shared.to_string().contains("备份测试笔记"),
        "分享关系恢复了:{shared}"
    );
    // 分享链接(只存了哈希的令牌)仍然有效
    let (status, _, info) = http(port, "GET", &format!("/api/v1/share/{token}"), None, None);
    assert_eq!(status, 200, "{info}");
    assert_eq!(info["data"]["state"], "active");
    drop(second);
}
