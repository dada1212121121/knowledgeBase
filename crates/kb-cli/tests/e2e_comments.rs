//! 评论的回复、@ 提及、已解决(.7):真实守护进程,多个账号。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_comments`

#![cfg(feature = "testkit")]

mod support;

use serde_json::{Value, json};
use support::Harness;

fn note_target(space: &str, id: &str) -> Value {
    json!({ "kind": "insight", "space_id": space, "collection": "_global", "id": id })
}

/// 笔记评论挂的 source:`insight:<id>`。
fn source_of(id: &str) -> String {
    format!("insight:{id}")
}

fn new_note(h: &Harness, who: &str, title: &str) -> String {
    h.ok(
        who,
        "create_item",
        json!({ "collection": "_global", "title": title, "body": format!("{title} 的正文"), "kind": "note" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// 通知的种类(新 → 旧)。布置场景时 bob 收到的"收到分享"与评论无关,不算。
fn kinds_of(list: &Value) -> Vec<String> {
    list["notifications"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|n| n["kind"].as_str().map(str::to_owned))
                .filter(|kind| kind != "share_received")
                .collect()
        })
        .unwrap_or_default()
}

/// alice 的一篇笔记,bob 是评论者,carol 和这篇笔记没有任何关系。返回 (空间 id, 笔记 id)。
fn world(h: &Harness) -> (String, String) {
    let space = h.space("alice");
    let id = new_note(h, "alice", "评论测试");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note_target(&space, &id), "user_id": h.id("bob"), "role": "commenter" }),
    );
    (space, id)
}

fn comment(
    h: &Harness,
    who: &str,
    space: &str,
    id: &str,
    body: &str,
    extra: Value,
) -> (u16, Value) {
    let mut args = json!({ "collection": "_global", "source": source_of(id), "body": body });
    if let (Some(args), Some(extra)) = (args.as_object_mut(), extra.as_object()) {
        for (key, value) in extra {
            args.insert(key.clone(), value.clone());
        }
    }
    if who == "alice" {
        h.call(who, "add_annotation", args)
    } else {
        h.call_in(who, space, "add_annotation", args)
    }
}

#[test]
fn mentions_notify_only_people_who_exist_and_can_see_the_document() {
    let h = Harness::start();
    let (space, id) = world(&h);
    // bob 评论,@ 了 alice(所有者)、carol(和这篇笔记没关系)、一个不存在的人、他自己
    let (status, added) = comment(
        &h,
        "bob",
        &space,
        &id,
        "这里请 @alice 看一下,@carol @nobody @bob",
        json!({ "mentions": ["alice", "carol", "nobody-here", "bob"] }),
    );
    assert_eq!(status, 200, "{added}");
    assert_eq!(
        added["mentions"],
        json!([h.id("alice")]),
        "只有存在、能看到这篇文档、并且不是自己的人才算被 @ 到:{added}"
    );
    let alice = h.ok("alice", "notification_list", json!({}));
    assert_eq!(kinds_of(&alice), ["mention"], "{alice}");
    assert_eq!(
        alice["notifications"][0]["data"]["annotation_id"],
        added["id"]
    );
    assert_eq!(alice["notifications"][0]["data"]["from"]["id"], h.id("bob"));
    assert_eq!(alice["notifications"][0]["data"]["from"]["username"], "bob");
    assert_eq!(
        alice["notifications"][0]["data"]["title"], "评论测试",
        "通知里要有文档标题"
    );
    assert!(
        alice["notifications"][0]["data"]["excerpt"]
            .as_str()
            .unwrap()
            .contains("请 @alice")
    );
    // 没有关系的 carol 一条通知也没有——不能靠 @ 往陌生人那里塞东西,也不能靠它探出哪些用户名存在
    assert!(kinds_of(&h.ok("carol", "notification_list", json!({}))).is_empty());
    assert!(kinds_of(&h.ok("bob", "notification_list", json!({}))).is_empty());
}

#[test]
fn a_reply_notifies_the_author_of_the_comment_once_and_a_mention_wins_over_a_reply_notice() {
    let h = Harness::start();
    let (space, id) = world(&h);
    let (_, top) = comment(&h, "bob", &space, &id, "顶层评论", json!({}));
    let top_id = top["id"].as_str().unwrap().to_owned();
    // alice 回复 bob:bob 收到"评论有回复"
    let (status, reply) = comment(
        &h,
        "alice",
        &space,
        &id,
        "收到",
        json!({ "parent_id": top_id }),
    );
    assert_eq!(status, 200, "{reply}");
    assert_eq!(reply["parent_id"], top_id.as_str());
    assert_eq!(
        kinds_of(&h.ok("bob", "notification_list", json!({}))),
        ["comment_reply"]
    );
    // 回复自己的评论不通知自己
    let (_, mine) = comment(&h, "alice", &space, &id, "我自己的顶层", json!({}));
    let (status, _) = comment(
        &h,
        "alice",
        &space,
        &id,
        "补充",
        json!({ "parent_id": mine["id"] }),
    );
    assert_eq!(status, 200);
    assert!(kinds_of(&h.ok("alice", "notification_list", json!({}))).is_empty());
    // 回复里同时 @ 了被回复的人:只发一条(提及),不重复
    let before = kinds_of(&h.ok("bob", "notification_list", json!({}))).len();
    comment(
        &h,
        "alice",
        &space,
        &id,
        "再回一条 @bob",
        json!({ "parent_id": top_id, "mentions": ["bob"] }),
    );
    let after = h.ok("bob", "notification_list", json!({}));
    assert_eq!(kinds_of(&after).len(), before + 1, "{after}");
    assert_eq!(kinds_of(&after)[0], "mention");
    // 回复只有一层
    let (status, body) = comment(
        &h,
        "bob",
        &space,
        &id,
        "回复的回复",
        json!({ "parent_id": reply["id"] }),
    );
    assert_eq!(status, 400, "{body}");
}

#[test]
fn resolving_is_for_collaborators_names_come_with_the_list_and_other_documents_are_off_limits() {
    let h = Harness::start();
    let (space, id) = world(&h);
    let other = new_note(&h, "alice", "另一篇");
    let (_, top) = comment(&h, "bob", &space, &id, "待解决", json!({}));
    let top_id = top["id"].as_str().unwrap().to_owned();

    // 评论者 bob 可以标记 / 取消;结果里有谁标记的
    let (status, done) = h.call_in(
        "bob",
        &space,
        "resolve_annotation",
        json!({ "collection": "_global", "source": source_of(&id), "id": top_id, "resolved": true }),
    );
    assert_eq!(status, 200, "{done}");
    assert_eq!(done["annotation"]["resolved_by"], h.id("bob"));
    assert!(done["annotation"]["resolved_at"].is_i64());
    // 列表带着作者和标记人的资料(评论者没有权限单独去查别人的资料)
    let (_, listed) = h.call_in(
        "bob",
        &space,
        "list_annotations",
        json!({ "collection": "_global", "source": source_of(&id) }),
    );
    assert_eq!(listed["annotations"][0]["id"], top_id.as_str());
    assert_eq!(
        listed["authors"][h.id("bob")]["username"],
        "bob",
        "{listed}"
    );
    // alice(所有者)取消
    let reopened = h.ok(
        "alice",
        "resolve_annotation",
        json!({ "collection": "_global", "source": source_of(&id), "id": top_id, "resolved": false }),
    );
    assert!(
        reopened["annotation"]["resolved_at"].is_null(),
        "{reopened}"
    );

    // 拿别的文档当幌子:评论不属于请求里点名的文档,一律当作不存在
    let (status, body) = h.call(
        "alice",
        "resolve_annotation",
        json!({ "collection": "_global", "source": source_of(&other), "id": top_id, "resolved": true }),
    );
    assert_eq!(status, 404, "{body}");
    // 和这篇笔记没有关系的 carol:同样当作不存在
    let (status, _) = h.call_in(
        "carol",
        &space,
        "resolve_annotation",
        json!({ "collection": "_global", "source": source_of(&id), "id": top_id, "resolved": true }),
    );
    assert_eq!(status, 404);
    // 只有查看权限的人不能标记
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note_target(&space, &id), "user_id": h.id("carol"), "role": "viewer" }),
    );
    let (status, _) = h.call_in(
        "carol",
        &space,
        "resolve_annotation",
        json!({ "collection": "_global", "source": source_of(&id), "id": top_id, "resolved": true }),
    );
    assert_eq!(status, 403);
}

#[test]
fn guests_can_comment_but_cannot_mention_anyone_or_resolve_comments() {
    let h = Harness::start();
    let (space, id) = world(&h);
    let config_path = h.daemon.home.path().join("config.toml");
    let original = std::fs::read_to_string(&config_path).unwrap();
    std::fs::write(
        &config_path,
        format!("{original}\n[share]\nallow_guest_comment = true\n"),
    )
    .unwrap();
    let created = h.ok(
        "alice",
        "link_create",
        json!({ "target": note_target(&space, &id), "audience": "anyone", "role": "commenter" }),
    );
    let token = created["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();
    let (_, top) = comment(&h, "bob", &space, &id, "bob 的评论", json!({}));
    let call = |capability: &str, args: Value| {
        support::http_headers(
            h.port(),
            "POST",
            &format!("/api/v1/share/{token}/call/{capability}"),
            &[("X-KB-CSRF", "1")],
            Some(args),
        )
    };
    // 游客评论(参数生效有几秒延迟,等到成功),@ 被忽略,回复 bob 也不会给 bob 发通知
    let mut added = None;
    for _ in 0..40 {
        let (status, _, body) = call(
            "add_annotation",
            json!({ "collection": "_global", "source": source_of(&id), "body": "游客的话 @alice",
                    "mentions": ["alice"], "parent_id": top["id"] }),
        );
        if status == 200 {
            added = Some(body);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let added = added.expect("游客能评论");
    assert_eq!(added["data"]["mentions"], json!([]), "{added}");
    assert!(kinds_of(&h.ok("alice", "notification_list", json!({}))).is_empty());
    assert!(kinds_of(&h.ok("bob", "notification_list", json!({}))).is_empty());
    // 游客看评论区:能看到作者的显示名,但拿不到登录用的用户名
    let (status, _, listed) = call(
        "list_annotations",
        json!({ "collection": "_global", "source": source_of(&id) }),
    );
    assert_eq!(status, 200, "{listed}");
    let bob_profile = &listed["data"]["authors"][h.id("bob")];
    assert!(bob_profile["display_name"].is_string(), "{listed}");
    assert!(
        bob_profile.get("username").is_none(),
        "游客不该拿到用户名:{listed}"
    );
    // 游客不能标记已解决
    let (status, _, body) = call(
        "resolve_annotation",
        json!({ "collection": "_global", "source": source_of(&id), "id": top["id"], "resolved": true }),
    );
    assert!(status == 403 || status == 404, "{status} {body}");
    let (_, listed) = h.call(
        "alice",
        "list_annotations",
        json!({ "collection": "_global", "source": source_of(&id) }),
    );
    let top_after = listed["annotations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["id"] == top["id"])
        .unwrap();
    assert!(
        top_after["resolved_at"].is_null(),
        "游客不该能关掉评论:{top_after}"
    );
}
