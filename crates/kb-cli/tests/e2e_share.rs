//! 文档分享的守护进程级验收(多用户设计说明):授权、继承、批量分享、降级立即生效、隐私与拉黑。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_share`

#![cfg(feature = "testkit")]

mod support;

use serde_json::{Value, json};
use support::Harness;

fn dir(space: &str, path: &str) -> Value {
    json!({ "kind": "dir", "space_id": space, "collection": "_global", "path": path })
}

fn file(space: &str, path: &str) -> Value {
    json!({ "kind": "file", "space_id": space, "collection": "_global", "path": path })
}

fn note(space: &str, id: &str) -> Value {
    json!({ "kind": "insight", "space_id": space, "collection": "_global", "id": id })
}

fn titles(list: &Value) -> Vec<String> {
    list["items"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|i| i["title"].as_str().unwrap_or("").to_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn new_note(h: &Harness, who: &str, title: &str) -> String {
    let created = h.ok(
        who,
        "create_item",
        json!({ "collection": "_global", "title": title, "body": format!("{title} 的正文"), "kind": "note" }),
    );
    created["id"].as_str().expect("笔记 id").to_owned()
}

#[test]
fn sharing_a_note_gives_the_other_person_exactly_the_role_granted_and_tells_them() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "部署手册");
    let target = note(&space, &id);

    // 授权前:bob 对它一无所知(effective_role 是 null,不是 403)
    let before = h.ok("bob", "effective_role", json!({ "target": target }));
    assert!(before["role"].is_null(), "{before}");

    let granted = h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "commenter" }),
    );
    assert_eq!(granted["grant"]["role"], "commenter");
    assert!(granted["previous"].is_null());

    // bob 收到「收到分享」通知,「共享给我」里能看到带标题的它
    let notes = h.ok("bob", "notification_list", json!({}));
    let first = &notes["notifications"][0];
    assert_eq!(first["kind"], "share_received", "{notes}");
    assert_eq!(first["data"]["title"], "部署手册");
    assert_eq!(first["data"]["role"], "commenter");
    assert_eq!(first["data"]["from"]["username"], "alice");
    let shared = h.ok("bob", "shared_with_me", json!({}));
    assert_eq!(titles(&shared), ["部署手册"], "{shared}");
    assert_eq!(shared["items"][0]["owner"]["username"], "alice");
    assert_eq!(shared["items"][0]["role"], "commenter");

    // 有效角色和能做的动作
    let role = h.ok("bob", "effective_role", json!({ "target": target }));
    assert_eq!(role["role"], "commenter");
    assert_eq!(role["can"]["comment"], true);
    assert_eq!(role["can"]["edit"], false);
    assert_eq!(role["can"]["manage_grants"], false);
    // carol 仍然什么都没有
    assert!(h.ok("carol", "effective_role", json!({ "target": target }))["role"].is_null());
    // 所有者看自己的知识库
    let owner = h.ok("alice", "effective_role", json!({ "target": target }));
    assert_eq!(owner["role"], "owner");
    assert_eq!(owner["can"]["transfer_owner"], true);
}

#[test]
fn only_people_who_can_manage_may_share_and_strangers_cannot_even_tell_it_exists() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "机密");
    let target = note(&space, &id);
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "editor" }),
    );
    // 可编辑的 bob 不能再分享给 carol:403(他知道这个文档存在,只是权限不够)
    let (status, body) = h.call(
        "bob",
        "grant_set",
        json!({ "target": target, "user_id": h.id("carol"), "role": "viewer" }),
    );
    assert_eq!(status, 403, "{body}");
    assert!(body.to_string().contains("可编辑"), "{body}");
    // 陌生人 carol 看别人的协作者列表、自己给自己授权:404,不暴露存在
    for (name, args) in [
        ("grant_list", json!({ "target": target })),
        (
            "grant_set",
            json!({ "target": target, "user_id": h.id("carol"), "role": "manager" }),
        ),
        (
            "grant_remove",
            json!({ "target": target, "user_id": h.id("bob") }),
        ),
        ("set_inherit", json!({ "target": target, "inherit": false })),
    ] {
        let (status, body) = h.call("carol", name, args);
        assert_eq!(status, 404, "{name}: {body}");
    }
    assert!(
        h.ok("alice", "shared_by_me", json!({}))["items"]
            .as_array()
            .unwrap()
            .len()
            == 1
    );
    // 可编辑的 bob 对这个文档的其它「管理」操作同样不行:403
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("carol"), "role": "viewer" }),
    );
    for (name, args) in [
        ("grant_list", json!({ "target": target })),
        (
            "grant_remove",
            json!({ "target": target, "user_id": h.id("carol") }),
        ),
        ("set_inherit", json!({ "target": target, "inherit": false })),
        (
            "grant_batch",
            json!({ "targets": [target], "people": [{ "user_id": h.id("carol"), "role": "editor" }] }),
        ),
    ] {
        let (status, body) = h.call("bob", name, args);
        assert_eq!(status, 403, "可编辑的人不能 {name}:{body}");
    }
    assert_eq!(
        h.ok("carol", "effective_role", json!({ "target": target }))["role"],
        "viewer",
        "bob 的越权尝试没有改动任何东西"
    );
    h.ok(
        "alice",
        "grant_remove",
        json!({ "target": target, "user_id": h.id("carol") }),
    );
    // 升为可管理后,bob 才能分享
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "manager" }),
    );
    h.ok(
        "bob",
        "grant_set",
        json!({ "target": target, "user_id": h.id("carol"), "role": "viewer" }),
    );
    assert_eq!(
        h.ok("carol", "effective_role", json!({ "target": target }))["role"],
        "viewer"
    );
    // 所有权不能当协作者角色授予
    let (status, _) = h.call(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("carol"), "role": "owner" }),
    );
    assert_eq!(status, 400);
}

#[test]
fn downgrading_and_removing_take_effect_at_once_and_the_person_is_told() {
    let h = Harness::start();
    let space = h.space("alice");
    let target = file(&space, "docs/guide.md");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "editor" }),
    );
    assert_eq!(
        h.ok("bob", "effective_role", json!({ "target": target }))["can"]["edit"],
        true
    );
    // 降级:立即只读(没有缓存要等)
    let lowered = h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "viewer" }),
    );
    assert_eq!(lowered["previous"], "editor");
    let now = h.ok("bob", "effective_role", json!({ "target": target }));
    assert_eq!(
        (now["role"].as_str(), now["can"]["edit"].as_bool()),
        (Some("viewer"), Some(false))
    );
    // 再设一次同样的角色:不再重复通知
    let before = h.ok("bob", "notification_list", json!({}))["notifications"]
        .as_array()
        .unwrap()
        .len();
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "viewer" }),
    );
    assert_eq!(
        h.ok("bob", "notification_list", json!({}))["notifications"]
            .as_array()
            .unwrap()
            .len(),
        before
    );
    // 移除:立即失去,并收到「被移出」通知
    let removed = h.ok(
        "alice",
        "grant_remove",
        json!({ "target": target, "user_id": h.id("bob") }),
    );
    assert_eq!(removed["removed"], "viewer");
    assert!(h.ok("bob", "effective_role", json!({ "target": target }))["role"].is_null());
    let notes = h.ok("bob", "notification_list", json!({}));
    assert_eq!(
        notes["notifications"][0]["kind"], "collaborator_removed",
        "{notes}"
    );
    assert!(
        h.ok("bob", "shared_with_me", json!({}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn folders_inherit_downward_files_do_not_and_inheritance_can_be_stopped() {
    let h = Harness::start();
    let space = h.space("alice");
    // 分享文件夹:里面新建的文档自动可见;只分享文件:同级新文件不可见
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": dir(&space, "team"), "user_id": h.id("bob"), "role": "editor" }),
    );
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": file(&space, "solo/one.md"), "user_id": h.id("bob"), "role": "viewer" }),
    );
    let role = |path: &str| {
        h.ok(
            "bob",
            "effective_role",
            json!({ "target": file(&space, path) }),
        )["role"]
            .clone()
    };
    assert_eq!(role("team/new/deep.md"), "editor");
    assert_eq!(role("solo/one.md"), "viewer");
    assert!(role("solo/two.md").is_null());
    assert!(role("team2/x.md").is_null(), "名字相近的另一个文件夹不在内");
    // 分享面板:文件继承来的协作者标明来源
    let listing = h.ok(
        "alice",
        "grant_list",
        json!({ "target": file(&space, "team/new/deep.md") }),
    );
    let row = &listing["grants"][0];
    assert_eq!(row["inherited"], true, "{listing}");
    assert_eq!(row["user"]["username"], "bob");
    assert!(
        row["source"].as_str().unwrap().contains("team"),
        "{listing}"
    );
    // 停止继承:bob 在 team/private 下失去访问(他的授权在上一级)
    h.ok(
        "alice",
        "set_inherit",
        json!({ "target": dir(&space, "team/private"), "inherit": false }),
    );
    assert!(role("team/private/s.md").is_null());
    assert_eq!(role("team/open/o.md"), "editor", "别的子文件夹不受影响");
    assert_eq!(
        h.ok(
            "alice",
            "grant_list",
            json!({ "target": dir(&space, "team/private") })
        )["inherit_broken"],
        true
    );
    h.ok(
        "alice",
        "set_inherit",
        json!({ "target": dir(&space, "team/private"), "inherit": true }),
    );
    assert_eq!(role("team/private/s.md"), "editor");
}

#[test]
fn multi_select_sharing_three_folders_and_five_files_gives_bob_eight_items_in_one_atomic_step() {
    let h = Harness::start();
    let space = h.space("alice");
    let mut targets: Vec<Value> = (1..=3).map(|n| dir(&space, &format!("dir{n}"))).collect();
    targets.extend((1..=5).map(|n| file(&space, &format!("loose/f{n}.md"))));
    let done = h.ok(
        "alice",
        "grant_batch",
        json!({ "targets": targets, "people": [{ "user_id": h.id("bob"), "role": "editor" }] }),
    );
    assert_eq!(done["changed"], 8, "{done}");
    let shared = h.ok("bob", "shared_with_me", json!({}));
    assert_eq!(shared["items"].as_array().unwrap().len(), 8);
    // 通知合并成一条「共享了 8 项」,不是 8 条
    let notes = h.ok("bob", "notification_list", json!({}));
    assert_eq!(
        notes["notifications"].as_array().unwrap().len(),
        1,
        "{notes}"
    );
    assert_eq!(notes["notifications"][0]["data"]["count"], 8);
    // 目录里的新文档可见,散落文件的同级新文件不可见
    assert_eq!(
        h.ok(
            "bob",
            "effective_role",
            json!({ "target": file(&space, "dir2/new.md") })
        )["role"],
        "editor"
    );
    assert!(
        h.ok(
            "bob",
            "effective_role",
            json!({ "target": file(&space, "loose/new.md") })
        )["role"]
            .is_null()
    );
    // 整批原子:带一个不存在的人 → 全部不生效
    let (status, _) = h.call(
        "alice",
        "grant_batch",
        json!({ "targets": [dir(&space, "other")], "people": [
            { "user_id": h.id("carol"), "role": "viewer" },
            { "user_id": "usr_ghost", "role": "viewer" },
        ] }),
    );
    assert_eq!(status, 404);
    assert!(
        h.ok("carol", "shared_with_me", json!({}))["items"]
            .as_array()
            .unwrap()
            .is_empty(),
        "没有分享了一半"
    );
    // 里面混进一项自己没有「可管理」的 → 整批拒绝
    let bobs_space = h.space("bob");
    let (status, _) = h.call(
        "alice",
        "grant_batch",
        json!({ "targets": [dir(&space, "ok"), dir(&bobs_space, "not-mine")], "people": [{ "user_id": h.id("carol"), "role": "viewer" }] }),
    );
    assert_eq!(status, 404);
    assert!(
        h.ok("carol", "shared_with_me", json!({}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    // 批量改成只读,再批量移除
    h.ok(
        "alice",
        "grant_batch",
        json!({ "targets": targets, "people": [{ "user_id": h.id("bob"), "role": "viewer" }] }),
    );
    assert_eq!(
        h.ok(
            "bob",
            "effective_role",
            json!({ "target": file(&space, "dir1/x.md") })
        )["role"],
        "viewer"
    );
    h.ok(
        "alice",
        "grant_batch",
        json!({ "targets": targets, "people": [{ "user_id": h.id("bob") }] }),
    );
    assert!(
        h.ok("bob", "shared_with_me", json!({}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn blocking_and_friends_only_privacy_decide_who_can_be_shared_to() {
    let h = Harness::start();
    let space = h.space("alice");
    let target = file(&space, "docs/a.md");
    // carol 拉黑了 alice:分享给 carol 表现为「找不到这个人」
    h.ok("carol", "block", json!({ "user_id": h.id("alice") }));
    let (status, body) = h.call(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("carol"), "role": "viewer" }),
    );
    assert_eq!(status, 404, "{body}");
    // bob 设成只接受好友的分享:alice 不是好友 → 同样「找不到」;成为好友之后可以
    h.ok("bob", "set_privacy", json!({ "share_from": "friends" }));
    let (status, _) = h.call(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "viewer" }),
    );
    assert_eq!(status, 404);
    h.ok("alice", "friend_request", json!({ "user_id": h.id("bob") }));
    let request = h.ok("bob", "friend_requests", json!({}))["incoming"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    h.ok(
        "bob",
        "friend_decide",
        json!({ "id": request, "decision": "accept" }),
    );
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "viewer" }),
    );
    // 不能分享给自己
    let (status, _) = h.call(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("alice"), "role": "viewer" }),
    );
    assert_eq!(status, 400);
}

#[test]
fn hiding_a_share_only_changes_the_list_and_my_shares_lists_what_i_gave_out() {
    let h = Harness::start();
    let space = h.space("alice");
    let target = dir(&space, "docs");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "viewer" }),
    );
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("carol"), "role": "editor" }),
    );
    h.ok(
        "bob",
        "hide_share",
        json!({ "target": target, "hidden": true }),
    );
    assert!(
        h.ok("bob", "shared_with_me", json!({}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        h.ok("bob", "shared_with_me", json!({ "include_hidden": true }))["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        h.ok(
            "bob",
            "effective_role",
            json!({ "target": file(&space, "docs/a.md") })
        )["role"],
        "viewer",
        "只是不显示"
    );
    // 没有授予我的东西不能「隐藏」
    let (status, _) = h.call(
        "carol",
        "hide_share",
        json!({ "target": dir(&space, "elsewhere"), "hidden": true }),
    );
    assert_eq!(status, 404);
    // 我的分享:一个资源、两个协作者
    let mine = h.ok("alice", "shared_by_me", json!({}));
    assert_eq!(mine["items"].as_array().unwrap().len(), 1, "{mine}");
    assert_eq!(mine["items"][0]["grantees"].as_array().unwrap().len(), 2);
    // bob 的「我的分享」里没有 alice 的东西
    assert!(
        h.ok("bob", "shared_by_me", json!({}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn sharing_capabilities_need_the_share_feature_but_receiving_does_not() {
    let h = Harness::start();
    let space = h.space("alice");
    let target = file(&space, "docs/a.md");
    h.ok(
        "admin",
        "user_feature",
        json!({ "id": h.id("alice"), "feature": "collab.share", "effect": "deny" }),
    );
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
    loop {
        let (status, _) = h.call(
            "alice",
            "grant_set",
            json!({ "target": target, "user_id": h.id("bob"), "role": "viewer" }),
        );
        if status == 403 || status == 404 {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "功能例外没有生效");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    // 没有「分享」功能的人仍然能看别人分享给他的(接收不需要功能点)
    h.ok("bob", "grant_set", json!({ "target": file(&h.space("bob"), "x.md"), "user_id": h.id("alice"), "role": "viewer" }));
    assert_eq!(
        h.ok("alice", "shared_with_me", json!({}))["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        h.call(
            "alice",
            "effective_role",
            json!({ "target": file(&h.space("bob"), "x.md") })
        )
        .0,
        200
    );
}

// ---------------------------------------------------------------- 打开别人分享的内容(X-KB-Space)

fn col(space: &str) -> Value {
    json!({ "kind": "collection", "space_id": space, "collection": "_global" })
}

#[test]
fn a_collaborator_reads_exactly_what_was_shared_from_the_owners_space() {
    let h = Harness::start();
    let space = h.space("alice");
    let shared = new_note(&h, "alice", "分享出去的笔记");
    let private = new_note(&h, "alice", "不分享的笔记");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &shared), "user_id": h.id("bob"), "role": "viewer" }),
    );

    // bob 在 alice 的知识库里读被分享的那条
    let (status, body) = h.call_in("bob", &space, "get_item", json!({ "id": shared }));
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["item"]["title"], "分享出去的笔记");
    // 没分享的那条:和不存在一样
    let (status, body) = h.call_in("bob", &space, "get_item", json!({ "id": private }));
    assert_eq!(status, 404, "{body}");
    // 不带 X-KB-Space 就是 bob 自己的知识库,里面没有这条
    let (status, _) = h.call("bob", "get_item", json!({ "id": shared }));
    assert_eq!(status, 404);
    // 只有这一条笔记的授权,看不到整个集合的列表
    let (status, _) = h.call_in(
        "bob",
        &space,
        "list_items",
        json!({ "collection": "_global" }),
    );
    assert_eq!(status, 404);
    // 陌生人 carol 和编造的知识库 id 的反应完全一样:404
    let (status, a) = h.call_in("carol", &space, "get_item", json!({ "id": shared }));
    let (status2, b) = h.call_in(
        "carol",
        "sp_doesnotexist0000",
        "get_item",
        json!({ "id": shared }),
    );
    assert_eq!((status, status2), (404, 404));
    assert_eq!(
        a["error"]["code"], b["error"]["code"],
        "不能靠错误内容分辨对方知识库是否存在"
    );
    // 只读的人不能改、不能删
    let (status, body) = h.call_in(
        "bob",
        &space,
        "edit_item",
        json!({ "id": shared, "version": 1, "title": "被改了" }),
    );
    assert_eq!(status, 403, "{body}");
    let (status, _) = h.call_in("bob", &space, "delete_item", json!({ "id": shared }));
    assert_eq!(status, 403);
    assert_eq!(
        h.ok("alice", "get_item", json!({ "id": shared }))["item"]["title"],
        "分享出去的笔记",
        "越权尝试没有改动任何东西"
    );
}

#[test]
fn check_links_works_on_shared_files_and_refuses_note_targets() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "链接体检的笔记");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": file(&space, "docs/a.md"), "user_id": h.id("bob"), "role": "viewer" }),
    );
    // 有文件查看权:能力本身能进;夹具里没有这个文件,所以结果是 missing,不是闸门的 400 / 404。
    let (status, body) = h.call_in(
        "bob",
        &space,
        "check_links",
        json!({ "targets": [{ "collection": "_global", "path": "docs/a.md" }] }),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["items"][0]["state"], "missing", "{body}");
    // 没授权的文件:和不存在一样,不能借体检探测文件是否存在。
    let (status, body) = h.call_in(
        "bob",
        &space,
        "check_links",
        json!({ "targets": [{ "collection": "_global", "path": "docs/secret.md" }] }),
    );
    assert_eq!(status, 404, "{body}");
    // 笔记目标一律拒绝:否则能借体检探出分享范围外的笔记是否存在。
    let (status, body) = h.call_in(
        "bob",
        &space,
        "check_links",
        json!({ "targets": [{ "kind": "note", "note_id": id }] }),
    );
    assert_eq!(status, 403, "{body}");
    assert!(
        body.to_string().contains("不能检查笔记引用"),
        "拒绝原因:{body}"
    );
}

#[test]
fn an_editor_changes_the_owners_note_in_the_owners_space_and_the_owner_sees_it() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "共同的笔记");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &id), "user_id": h.id("bob"), "role": "editor" }),
    );
    let current = h.ok("alice", "get_item", json!({ "id": id }));
    let version = current["item"]["version"].as_i64().unwrap_or(1);
    let (status, body) = h.call_in(
        "bob",
        &space,
        "edit_item",
        json!({ "id": id, "version": version, "title": "bob 改过的标题", "body": "bob 写的新正文" }),
    );
    assert_eq!(status, 200, "{body}");
    // alice 在自己的知识库里立刻看到
    let after = h.ok("alice", "get_item", json!({ "id": id }));
    assert_eq!(after["item"]["title"], "bob 改过的标题");
    // bob 自己的知识库里没有多出任何东西(修改落在所有者的库里)
    let mine = h.ok("bob", "list_items", json!({ "collection": "_global" }));
    assert_eq!(mine["total"], 0, "{mine}");
    // 可编辑不能删(删除需要「可管理」)
    let (status, _) = h.call_in("bob", &space, "delete_item", json!({ "id": id }));
    assert_eq!(status, 403);
    // 版本历史:可编辑的人能看
    let (status, history) = h.call_in("bob", &space, "item_history", json!({ "id": id }));
    assert_eq!(status, 200, "{history}");
}

#[test]
fn creating_in_a_shared_collection_needs_editor_on_the_collection_and_lands_in_the_owners_space() {
    let h = Harness::start();
    let space = h.space("alice");
    let one = new_note(&h, "alice", "已有笔记");
    // 只有一条笔记的编辑权:不能在集合里新建
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &one), "user_id": h.id("bob"), "role": "editor" }),
    );
    let (status, _) = h.call_in(
        "bob",
        &space,
        "create_item",
        json!({ "collection": "_global", "title": "想新建", "body": "x" }),
    );
    assert_eq!(status, 404, "对集合没有任何权限:当作不存在");
    // 集合级的可编辑:可以新建,落在 alice 的知识库里
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": col(&space), "user_id": h.id("bob"), "role": "editor" }),
    );
    let (status, created) = h.call_in(
        "bob",
        &space,
        "create_item",
        json!({ "collection": "_global", "title": "bob 新建的", "body": "内容", "kind": "note" }),
    );
    assert_eq!(status, 200, "{created}");
    let new_id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        h.ok("alice", "get_item", json!({ "id": new_id }))["item"]["title"],
        "bob 新建的"
    );
    assert_eq!(
        h.ok("bob", "list_items", json!({ "collection": "_global" }))["total"],
        0,
        "不在 bob 自己的知识库里"
    );
    // 可查看的人不能新建
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": col(&space), "user_id": h.id("carol"), "role": "viewer" }),
    );
    let (status, _) = h.call_in(
        "carol",
        &space,
        "create_item",
        json!({ "collection": "_global", "title": "不行", "body": "x" }),
    );
    assert_eq!(status, 403);
}

#[test]
fn listing_a_shared_collection_hides_the_notes_that_stopped_inheriting() {
    let h = Harness::start();
    let space = h.space("alice");
    let open = new_note(&h, "alice", "公开的");
    let secret = new_note(&h, "alice", "不继承的");
    // 列表读的是检索索引:新建的笔记异步入库,等两条都能被列出来
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while h.ok("alice", "list_items", json!({ "collection": "_global" }))["total"] != 2 {
        assert!(std::time::Instant::now() < deadline, "笔记 60 秒还没入库");
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": col(&space), "user_id": h.id("bob"), "role": "viewer" }),
    );
    let (status, listed) = h.call_in(
        "bob",
        &space,
        "list_items",
        json!({ "collection": "_global" }),
    );
    assert_eq!(status, 200, "{listed}");
    assert_eq!(listed["total"], 2, "{listed}");
    // alice 对其中一条停止继承:bob 立刻看不到它(列表里没有,直接读也是 404)
    h.ok(
        "alice",
        "set_inherit",
        json!({ "target": note(&space, &secret), "inherit": false }),
    );
    let (status, listed) = h.call_in(
        "bob",
        &space,
        "list_items",
        json!({ "collection": "_global" }),
    );
    assert_eq!(status, 200, "{listed}");
    let ids: Vec<&str> = listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|i| i["id"].as_str())
        .collect();
    assert_eq!(ids, [open.as_str()], "{listed}");
    assert_eq!(listed["filtered"], true);
    let (status, _) = h.call_in("bob", &space, "get_item", json!({ "id": secret }));
    assert_eq!(status, 404);
    assert_eq!(
        h.call_in("bob", &space, "get_item", json!({ "id": open }))
            .0,
        200
    );
}

#[test]
fn most_capabilities_do_not_exist_in_someone_elses_space_and_tokens_cannot_point_at_it() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "笔记");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": col(&space), "user_id": h.id("bob"), "role": "manager" }),
    );
    // 即使是「可管理」,别人的知识库里也不能做这些
    for (name, args) in [
        (
            "add_source",
            json!({ "url": "https://example.com", "collection": "_global" }),
        ),
        ("update_config", json!({ "patch": {}, "confirm": true })),
        (
            "delete_collection",
            json!({ "name": "_global", "confirm": true }),
        ),
        ("agent_send", json!({ "message": "hi" })),
        // 编辑器的 AI 写作花的是 AI 额度:别人的知识库 / 游客都不能调
        ("ai_write", json!({ "action": "polish", "text": "x" })),
        ("stats_overview", json!({})),
        ("audit_list", json!({})),
        ("batch_list", json!({})),
        ("revert_batch", json!({ "batch_id": "x" })),
        ("job_list", json!({})),
    ] {
        let (status, body) = h.call_in("bob", &space, name, args);
        assert!(
            status == 403 || status == 404,
            "{name} 不该能在别人的知识库里执行:{status} {body}"
        );
        if status == 403 {
            assert!(
                body.to_string().contains("不能在别人分享的内容上进行")
                    || body.to_string().contains("没有开通"),
                "{name}: {body}"
            );
        }
    }
    // 连 alice 自己的审计都看不到:bob 是协作者,不是所有者
    assert!(h.call_in("bob", &space, "audit_list", json!({})).0 != 200);
    // 令牌(非浏览器会话)带 X-KB-Space 一律拒绝
    let (status, _, created) = support::http(
        h.port(),
        "POST",
        "/api/v1/auth/tokens",
        Some(h.cookie("bob")),
        Some(json!({ "name": "t", "scope": "api" })),
    );
    assert_eq!(status, 200, "{created}");
    let plaintext = created["data"]["token"]
        .as_str()
        .expect("明文令牌")
        .to_owned();
    let (status, _, body) = support::http_with(
        h.port(),
        "POST",
        "/api/v1/capabilities/get_item",
        None,
        Some(json!({ "id": id })),
        &[
            ("Authorization", &format!("Bearer {plaintext}")),
            ("X-KB-Space", &space),
        ],
    );
    assert_eq!(status, 403, "{body}");
    // 非法的 X-KB-Space:400
    let (status, _, _) = support::http_with(
        h.port(),
        "POST",
        "/api/v1/capabilities/get_item",
        Some(h.cookie("bob")),
        Some(json!({ "id": id })),
        &[("X-KB-Space", "../etc")],
    );
    assert_eq!(status, 400);
}

#[test]
fn losing_access_closes_the_door_at_once_even_for_a_note_the_person_has_open() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "会被收回的");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &id), "user_id": h.id("bob"), "role": "editor" }),
    );
    assert_eq!(
        h.call_in("bob", &space, "get_item", json!({ "id": id })).0,
        200
    );
    h.ok(
        "alice",
        "grant_remove",
        json!({ "target": note(&space, &id), "user_id": h.id("bob") }),
    );
    assert_eq!(
        h.call_in("bob", &space, "get_item", json!({ "id": id })).0,
        404
    );
    // 过期的授权同样失效
    h.ok("alice", "grant_set", json!({ "target": note(&space, &id), "user_id": h.id("carol"), "role": "viewer", "expires_days": 1 }));
    assert_eq!(
        h.call_in("carol", &space, "get_item", json!({ "id": id }))
            .0,
        200
    );
}

fn sparse_gb(h: &Harness, who: &str, gb: u64) {
    let sources = h
        .daemon
        .home
        .path()
        .join("spaces")
        .join(h.space(who))
        .join("sources");
    std::fs::create_dir_all(&sources).unwrap();
    std::fs::File::create(sources.join("big.bin"))
        .and_then(|file| file.set_len(gb * 1024 * 1024 * 1024))
        .unwrap();
}

#[test]
fn a_collaborators_writes_use_the_owners_space_and_the_owners_quota_not_their_own() {
    let h = Harness::start();
    let space = h.space("alice");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": col(&space), "user_id": h.id("bob"), "role": "editor" }),
    );
    // bob 自己的空间已经超额(配额 1 GB,里面有 2 GB):他对别人的知识库写东西不受影响
    h.ok(
        "admin",
        "user_update",
        json!({ "id": h.id("bob"), "quota": { "storage_gb": 1 } }),
    );
    sparse_gb(&h, "bob", 2);
    let (status, body) = h.call(
        "bob",
        "create_item",
        json!({ "collection": "_global", "title": "自己的", "body": "x" }),
    );
    assert_eq!(status, 400, "bob 自己的知识库确实满了:{body}");
    let (status, body) = h.call_in(
        "bob",
        &space,
        "create_item",
        json!({ "collection": "_global", "title": "写进 alice 的", "body": "x" }),
    );
    assert_eq!(status, 200, "写进别人的知识库不占 bob 的配额:{body}");
    // 反过来:alice 的空间满了,bob 往里写也被拦,提示的是「存储空间不足」。
    // 这次把 bob 自己的配额放得很大:拦住他的必须是 alice 的配额,而不是他自己的
    h.ok(
        "admin",
        "user_update",
        json!({ "id": h.id("bob"), "quota": { "storage_gb": 500 } }),
    );
    h.ok(
        "admin",
        "user_update",
        json!({ "id": h.id("alice"), "quota": { "storage_gb": 1 } }),
    );
    sparse_gb(&h, "alice", 2);
    // 删一条让缓存失效(用量有一分钟缓存)
    let temp = new_note(&h, "alice", "临时");
    h.ok("alice", "delete_item", json!({ "id": temp }));
    let (status, body) = h.call_in(
        "bob",
        &space,
        "create_item",
        json!({ "collection": "_global", "title": "再写", "body": "x" }),
    );
    assert_eq!(status, 400, "alice 的空间满了,协作者也写不进去:{body}");
    assert!(body.to_string().contains("存储空间不足"), "{body}");
}

#[test]
fn the_raw_file_endpoint_obeys_the_same_rules_for_someone_elses_space() {
    let h = Harness::start();
    let space = h.space("alice");
    let get = |who: Option<&str>, query: &str, extra: &[(&str, &str)]| {
        support::http_with(
            h.port(),
            "GET",
            &format!("/api/v1/raw?{query}"),
            who.map(|name| h.cookie(name)),
            None,
            extra,
        )
    };
    let query = format!("collection=_global&path=docs/a.png&space={space}");
    // 陌生人:404,和空间不存在一样
    let (status, _, stranger) = get(Some("bob"), &query, &[]);
    assert!(
        stranger.to_string().contains("没有找到这个内容"),
        "闸门的回答:{stranger}"
    );
    assert_eq!(status, 404);
    let (status, ..) = get(
        Some("bob"),
        "collection=_global&path=docs/a.png&space=sp_doesnotexist0000",
        &[],
    );
    assert_eq!(status, 404);
    // 没登录 401;格式不对 400
    assert_eq!(get(None, &query, &[]).0, 401);
    assert_eq!(
        get(Some("bob"), "collection=_global&path=a&space=..%2Fetc", &[]).0,
        400
    );
    // 有授权但文件不存在:过了权限这一关,落到「找不到原件」(也是 404,但说明权限检查已通过)
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": file(&space, "docs/a.png"), "user_id": h.id("bob"), "role": "viewer" }),
    );
    let (status, _, body) = get(Some("bob"), &query, &[]);
    assert_eq!(status, 404, "{body}");
    // 授权通过后才会走到「找不到这个文件」——它的回答和闸门的「没有找到这个内容」不一样
    assert!(
        !body.to_string().contains("没有找到这个内容"),
        "应该已经过了权限这一关:{body}"
    );
    // 令牌不能带 space
    let (status, _, created) = support::http(
        h.port(),
        "POST",
        "/api/v1/auth/tokens",
        Some(h.cookie("bob")),
        Some(json!({ "name": "raw", "scope": "api" })),
    );
    assert_eq!(status, 200, "{created}");
    let bearer = format!("Bearer {}", created["data"]["token"].as_str().unwrap());
    let (status, ..) = get(None, &query, &[("Authorization", &bearer)]);
    assert_eq!(status, 403);
}

// ---------------------------------------------------------------- 共享范围检索

fn titles_of_hits(result: &Value) -> Vec<String> {
    let mut out: Vec<String> = result["hits"]
        .as_array()
        .map(|hits| {
            hits.iter()
                .filter_map(|hit| hit["title"].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// 等到某人自己能搜到这个词(笔记异步入库)。
fn wait_searchable(h: &Harness, who: &str, word: &str, at_least: usize) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let found = h.ok(who, "search_knowledge", json!({ "query": word, "k": 20 }));
        if found["hits"]
            .as_array()
            .is_some_and(|hits| hits.len() >= at_least)
        {
            return;
        }
        assert!(std::time::Instant::now() < deadline, "{word} 60 秒还没入库");
        std::thread::sleep(std::time::Duration::from_millis(150));
    }
}

#[test]
fn shared_search_only_ever_returns_what_was_shared_and_labels_where_it_came_from() {
    let h = Harness::start();
    let space = h.space("alice");
    let shared = new_note(&h, "alice", "蓝莓种植指南");
    new_note(&h, "alice", "蓝莓酒酿造笔记"); // 同样含「蓝莓」,但没分享
    new_note(&h, "bob", "蓝莓果酱做法");
    wait_searchable(&h, "alice", "蓝莓", 2);
    wait_searchable(&h, "bob", "蓝莓", 1);
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &shared), "user_id": h.id("bob"), "role": "viewer" }),
    );

    let found = h.ok("bob", "search_shared", json!({ "query": "蓝莓" }));
    assert_eq!(
        titles_of_hits(&found),
        ["蓝莓种植指南"],
        "只有分享出来的那条:{found}"
    );
    let hit = &found["hits"][0];
    assert_eq!(hit["space_id"], space.as_str());
    assert_eq!(hit["owner"]["username"], "alice");
    assert_eq!(hit["role"], "viewer");
    assert_eq!(found["sources"][0]["hits"], 1);
    // 连同自己的一起搜:两个知识库的命中合并,各自标明来源
    let all = h.ok(
        "bob",
        "search_shared",
        json!({ "query": "蓝莓", "scope": "all" }),
    );
    assert_eq!(
        titles_of_hits(&all),
        ["蓝莓果酱做法", "蓝莓种植指南"],
        "{all}"
    );
    let mine = all["hits"]
        .as_array()
        .unwrap()
        .iter()
        .find(|hit| hit["title"] == "蓝莓果酱做法")
        .unwrap();
    assert_eq!(mine["role"], "owner");
    // carol 什么都没被分享:搜不到任何东西(也不会报错暴露什么)
    let none = h.ok("carol", "search_shared", json!({ "query": "蓝莓" }));
    assert!(none["hits"].as_array().unwrap().is_empty(), "{none}");
    // 取消分享后立刻搜不到
    h.ok(
        "alice",
        "grant_remove",
        json!({ "target": note(&space, &shared), "user_id": h.id("bob") }),
    );
    assert!(
        h.ok("bob", "search_shared", json!({ "query": "蓝莓" }))["hits"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn shared_search_respects_stopped_inheritance_inside_a_shared_collection() {
    let h = Harness::start();
    let space = h.space("alice");
    new_note(&h, "alice", "樱桃公开笔记");
    let hidden = new_note(&h, "alice", "樱桃不继承笔记");
    wait_searchable(&h, "alice", "樱桃", 2);
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": col(&space), "user_id": h.id("bob"), "role": "viewer" }),
    );
    let before = h.ok("bob", "search_shared", json!({ "query": "樱桃" }));
    assert_eq!(
        titles_of_hits(&before),
        ["樱桃不继承笔记", "樱桃公开笔记"],
        "{before}"
    );
    h.ok(
        "alice",
        "set_inherit",
        json!({ "target": note(&space, &hidden), "inherit": false }),
    );
    let after = h.ok("bob", "search_shared", json!({ "query": "樱桃" }));
    assert_eq!(
        titles_of_hits(&after),
        ["樱桃公开笔记"],
        "停止继承后那条搜不到:{after}"
    );
}

#[test]
fn shared_search_validates_its_arguments_and_can_be_limited_to_one_source() {
    let h = Harness::start();
    let alice_space = h.space("alice");
    let carol_space = h.space("carol");
    let a = new_note(&h, "alice", "桃子来自 alice");
    let c = new_note(&h, "carol", "桃子来自 carol");
    wait_searchable(&h, "alice", "桃子", 1);
    wait_searchable(&h, "carol", "桃子", 1);
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&alice_space, &a), "user_id": h.id("bob"), "role": "viewer" }),
    );
    h.ok(
        "carol",
        "grant_set",
        json!({ "target": note(&carol_space, &c), "user_id": h.id("bob"), "role": "viewer" }),
    );
    let both = h.ok("bob", "search_shared", json!({ "query": "桃子" }));
    assert_eq!(
        titles_of_hits(&both),
        ["桃子来自 alice", "桃子来自 carol"],
        "{both}"
    );
    assert_eq!(both["sources"].as_array().unwrap().len(), 2);
    let only = h.ok(
        "bob",
        "search_shared",
        json!({ "query": "桃子", "space_id": carol_space }),
    );
    assert_eq!(titles_of_hits(&only), ["桃子来自 carol"]);
    let (status, _) = h.call("bob", "search_shared", json!({ "query": "  " }));
    assert_eq!(status, 400);
    let (status, _) = h.call(
        "bob",
        "search_shared",
        json!({ "query": "桃子", "scope": "everything" }),
    );
    assert_eq!(status, 400);
    // k 限制条数
    let one = h.ok("bob", "search_shared", json!({ "query": "桃子", "k": 1 }));
    assert_eq!(one["hits"].as_array().unwrap().len(), 1);
}

// ---------------------------------------------------------------- 访问申请

fn unread_kinds(h: &Harness, who: &str) -> Vec<String> {
    h.ok(who, "notification_list", json!({}))["notifications"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["kind"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn asking_for_access_notifies_the_owner_who_can_approve_with_a_different_role() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "要申请才能看的笔记");
    let target = note(&space, &id);
    // 陌生人 bob 打不开它
    assert_eq!(
        h.call_in("bob", &space, "get_item", json!({ "id": id })).0,
        404
    );
    let asked = h.ok(
        "bob",
        "access_request",
        json!({ "target": target, "role": "editor", "message": "想参与修改" }),
    );
    assert_eq!(asked["status"], "requested");
    // alice 收到通知,并在「待处理」里看到
    let notes = h.ok("alice", "notification_list", json!({}));
    let first = &notes["notifications"][0];
    assert_eq!(first["kind"], "access_request", "{notes}");
    assert_eq!(first["data"]["requester"]["username"], "bob");
    assert_eq!(first["data"]["title"], "要申请才能看的笔记");
    assert_eq!(first["data"]["message"], "想参与修改");
    let pending = h.ok("alice", "access_requests", json!({}));
    assert_eq!(
        pending["to_decide"].as_array().unwrap().len(),
        1,
        "{pending}"
    );
    let request_id = pending["to_decide"][0]["id"].as_str().unwrap().to_owned();
    assert_eq!(
        h.ok("bob", "access_requests", json!({}))["mine"][0]["state"],
        "pending"
    );
    // 24 小时内不能重复申请
    let (status, _) = h.call(
        "bob",
        "access_request",
        json!({ "target": target, "role": "viewer" }),
    );
    assert_eq!(status, 403);
    // 无关的 carol:看不到这条申请,也处理不了(404)
    assert!(
        h.ok("carol", "access_requests", json!({}))["to_decide"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let (status, _) = h.call(
        "carol",
        "access_decide",
        json!({ "id": request_id, "approve": true }),
    );
    assert_eq!(status, 404);
    // alice 通过,但只给「可查看」
    h.ok(
        "alice",
        "access_decide",
        json!({ "id": request_id, "approve": true, "role": "viewer" }),
    );
    let role = h.ok("bob", "effective_role", json!({ "target": target }));
    assert_eq!(
        (role["role"].as_str(), role["can"]["edit"].as_bool()),
        (Some("viewer"), Some(false))
    );
    assert_eq!(
        h.call_in("bob", &space, "get_item", json!({ "id": id })).0,
        200,
        "通过后能打开了"
    );
    // bob 收到结果通知
    let result = &h.ok("bob", "notification_list", json!({}))["notifications"][0];
    assert_eq!(result["kind"], "access_result");
    assert_eq!(result["data"]["approved"], true);
    assert_eq!(result["data"]["role"], "viewer");
    // 处理过的不能再处理;待处理列表清空
    let (status, _) = h.call(
        "alice",
        "access_decide",
        json!({ "id": request_id, "approve": false }),
    );
    assert_eq!(status, 404);
    assert!(
        h.ok("alice", "access_requests", json!({}))["to_decide"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn a_rejection_changes_nothing_and_tells_the_asker() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "不给看");
    let target = note(&space, &id);
    h.ok(
        "bob",
        "access_request",
        json!({ "target": target, "role": "viewer" }),
    );
    let request_id = h.ok("alice", "access_requests", json!({}))["to_decide"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    h.ok(
        "alice",
        "access_decide",
        json!({ "id": request_id, "approve": false }),
    );
    assert!(h.ok("bob", "effective_role", json!({ "target": target }))["role"].is_null());
    assert_eq!(
        h.call_in("bob", &space, "get_item", json!({ "id": id })).0,
        404
    );
    let result = &h.ok("bob", "notification_list", json!({}))["notifications"][0];
    assert_eq!(
        (
            result["kind"].as_str(),
            result["data"]["approved"].as_bool()
        ),
        (Some("access_result"), Some(false))
    );
}

#[test]
fn managers_are_asked_too_and_can_decide_but_only_for_what_they_manage() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "团队笔记");
    let other = new_note(&h, "alice", "别的笔记");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &id), "user_id": h.id("carol"), "role": "manager" }),
    );
    h.ok(
        "bob",
        "access_request",
        json!({ "target": note(&space, &id), "role": "viewer" }),
    );
    h.ok(
        "bob",
        "access_request",
        json!({ "target": note(&space, &other), "role": "viewer" }),
    );
    // carol 是这条笔记的「可管理」:收到通知、能看到并处理这一条,看不到另一条
    assert!(unread_kinds(&h, "carol").contains(&"access_request".to_owned()));
    let pending = h.ok("carol", "access_requests", json!({}));
    assert_eq!(
        pending["to_decide"].as_array().unwrap().len(),
        1,
        "{pending}"
    );
    assert_eq!(pending["to_decide"][0]["title"], "团队笔记");
    let mine_id = pending["to_decide"][0]["id"].as_str().unwrap().to_owned();
    let alice_view = h.ok("alice", "access_requests", json!({}));
    let other_id = alice_view["to_decide"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["title"] == "别的笔记")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, _) = h.call(
        "carol",
        "access_decide",
        json!({ "id": other_id, "approve": true }),
    );
    assert_eq!(status, 404, "不是她管理的资源");
    // 对另一条笔记 carol 有「可编辑」(能看到、能改,但不能管理):同样处理不了别人的申请
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &other), "user_id": h.id("carol"), "role": "editor" }),
    );
    let (status, _) = h.call(
        "carol",
        "access_decide",
        json!({ "id": other_id, "approve": true }),
    );
    assert_eq!(status, 404, "可编辑不等于可管理");
    h.ok(
        "carol",
        "access_decide",
        json!({ "id": mine_id, "approve": true }),
    );
    assert_eq!(
        h.ok(
            "bob",
            "effective_role",
            json!({ "target": note(&space, &id) })
        )["role"],
        "viewer"
    );
}

#[test]
fn a_blocked_asker_gets_a_normal_looking_answer_and_the_owner_hears_nothing() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "x");
    h.ok("alice", "block", json!({ "user_id": h.id("bob") }));
    let asked = h.ok(
        "bob",
        "access_request",
        json!({ "target": note(&space, &id), "role": "viewer" }),
    );
    assert_eq!(asked["status"], "requested");
    assert!(
        h.ok("alice", "access_requests", json!({}))["to_decide"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert!(!unread_kinds(&h, "alice").contains(&"access_request".to_owned()));
}

#[test]
fn asking_for_what_you_already_have_or_for_a_nonexistent_space_is_refused() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "已有权限");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &id), "user_id": h.id("bob"), "role": "editor" }),
    );
    let (status, body) = h.call(
        "bob",
        "access_request",
        json!({ "target": note(&space, &id), "role": "viewer" }),
    );
    assert_eq!(status, 400, "{body}");
    let (status, _) = h.call(
        "bob",
        "access_request",
        json!({ "target": note("sp_doesnotexist0000", "x"), "role": "viewer" }),
    );
    assert_eq!(status, 404);
    let (status, _) = h.call(
        "carol",
        "access_request",
        json!({ "target": note(&space, &id), "role": "manager" }),
    );
    assert_eq!(status, 400, "只能申请查看 / 评论 / 编辑");
}

// ---------------------------------------------------------------- 越权矩阵(分享场景)

/// 表驱动:五种身份(无授权 / 可查看 / 可评论 / 可编辑 / 可管理)× 白名单里的每个能力,
/// 放行与否严格等于「角色 ≥ 该能力要求的最低角色」。
#[test]
fn the_role_matrix_over_the_whitelisted_capabilities_is_exactly_what_the_plan_says() {
    const NONE: &str = "none";
    // (能力, 最低角色;None 表示「对笔记级授权永远不行」——因为它指向集合或不存在的文件,而不是这条笔记)
    let roles = [NONE, "viewer", "commenter", "editor", "manager"];
    let rank = |role: &str| roles.iter().position(|r| *r == role).unwrap();
    let h = Harness::start();
    let space = h.space("alice");
    // 笔记级的探测:(能力, 构造参数的函数, 需要的最低角色)
    type Args = fn(&str) -> Value;
    let by_note: [(&str, Args, &str); 4] = [
        ("get_item", |id| json!({ "id": id }), "viewer"),
        ("item_history", |id| json!({ "id": id }), "editor"),
        (
            "edit_item",
            |id| json!({ "id": id, "version": 1, "title": "矩阵改过" }),
            "editor",
        ),
        ("delete_item", |id| json!({ "id": id }), "manager"),
    ];
    for role in roles {
        for (name, args, minimum) in by_note {
            // 每次探测用一条新笔记(删除、编辑不会影响下一个探测)
            let id = new_note(&h, "alice", &format!("矩阵 {role} {name}"));
            if role != NONE {
                h.ok(
                    "alice",
                    "grant_set",
                    json!({ "target": note(&space, &id), "user_id": h.id("bob"), "role": role }),
                );
            }
            let (status, body) = h.call_in("bob", &space, name, args(&id));
            let expected = if role == NONE {
                404
            } else if rank(role) >= rank(minimum) {
                200
            } else {
                403
            };
            assert_eq!(
                status, expected,
                "角色 {role} 调 {name}(最低 {minimum}):{body}"
            );
            if status != 200 {
                assert!(
                    !body.to_string().contains("矩阵"),
                    "被拒的响应不能带出笔记内容:{body}"
                );
            }
        }
    }
    // 笔记级授权永远碰不到集合级和文件级的能力(对集合 / 别的文件没有任何权限 → 404)
    let id = new_note(&h, "alice", "笔记级授权");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note(&space, &id), "user_id": h.id("bob"), "role": "manager" }),
    );
    for (name, args) in [
        ("list_items", json!({ "collection": "_global" })),
        (
            "create_item",
            json!({ "collection": "_global", "title": "t", "body": "b" }),
        ),
        (
            "file_preview",
            json!({ "collection": "_global", "path": "a.md" }),
        ),
        (
            "file_raw",
            json!({ "collection": "_global", "path": "a.md" }),
        ),
        (
            "file_versions",
            json!({ "collection": "_global", "path": "a.md" }),
        ),
        (
            "save_file",
            json!({ "collection": "_global", "path": "a.md", "content": "x" }),
        ),
    ] {
        let (status, body) = h.call_in("bob", &space, name, args);
        assert_eq!(status, 404, "{name} 不该被笔记级授权放行:{body}");
    }
}

/// 分享场景下,白名单之外的每一个「知识库内」能力都不可用,哪怕调用者是「可管理」。
#[test]
fn no_space_capability_outside_the_whitelist_works_in_someone_elses_space() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "矩阵机密 XJ-4471");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": col(&space), "user_id": h.id("bob"), "role": "manager" }),
    );
    // 必须和 shared_gate::SPECS 同名:漏掉一个已允许的能力,通用参数会先撞上参数校验(例如
    // check_links 缺 targets 返回 400),被误判成「越权可用」。
    let whitelist = [
        "get_item",
        "list_items",
        "list_files",
        "file_preview",
        "file_raw",
        "check_links",
        "item_history",
        "file_versions",
        "file_actions",
        "delete_file",
        "delete_folder",
        "edit_item",
        "save_file",
        "create_item",
        "delete_item",
        "list_annotations",
        "add_annotation",
        // 评论的已解决:在白名单里(评论权限即可),授权矩阵见 e2e_comments
        "resolve_annotation",
        // AI 读改文档:和在页面上看 / 改需要的角色一样,授权矩阵见 e2e_doc_agent
        "doc_read",
        "doc_links",
        "doc_edit",
        "doc_proposals",
        "doc_proposal_decide",
    ];
    let (_, _, listing) = support::http(
        h.port(),
        "GET",
        "/api/v1/capabilities?surface=web",
        Some(h.cookie("bob")),
        None,
    );
    let capabilities = listing["data"]["capabilities"].as_array().unwrap().clone();
    let mut probed = 0;
    for capability in capabilities {
        let name = capability["name"].as_str().unwrap();
        if capability["scope"] != "space" || whitelist.contains(&name) {
            continue;
        }
        let args = json!({
            "id": id, "item_id": id, "ids": [id], "draft_id": id, "session_id": id, "batch_id": id, "job_id": id,
            "collection": "_global", "name": "_global", "path": "a.md", "query": "XJ-4471", "question": "XJ-4471",
            "message": "XJ-4471", "title": "t", "body": "b", "confirm": true,
        });
        let (status, body) = h.call_in("bob", &space, name, args);
        assert!(
            status == 403 || status == 404,
            "{name} 不在白名单里,在别人的知识库里却返回了 {status}:{body}"
        );
        assert!(
            !body.to_string().contains("XJ-4471"),
            "{name} 泄露了内容:{body}"
        );
        probed += 1;
    }
    assert!(probed >= 50, "应该覆盖到大部分知识库内的能力,实际 {probed}");
    // 跑完矩阵,alice 的数据一点没变
    assert_eq!(
        h.ok("alice", "get_item", json!({ "id": id }))["item"]["title"],
        "矩阵机密 XJ-4471"
    );
}
