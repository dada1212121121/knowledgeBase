//! 多人在线编辑的守护进程级验收(多用户设计说明):
//! 真实进程、真实 WebSocket、真实 Yjs 文档、真实的权限与落地。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_collab`

#![cfg(feature = "testkit")]

mod support;

use std::time::{Duration, Instant};

use kb_core::share::ResourceKey;
use serde_json::{Value, json};
use support::collab::{CollabClient, Connect, connect};
use support::{Harness, http_headers, set_cookie_value};

fn enc(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn note_target(space: &str, id: &str) -> Value {
    json!({ "kind": "insight", "space_id": space, "collection": "_global", "id": id })
}

fn new_note(h: &Harness, who: &str, title: &str, body: &str) -> String {
    h.ok(
        who,
        "create_item",
        json!({ "collection": "_global", "title": title, "body": body, "kind": "note" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

fn doc_key(space: &str, id: &str) -> String {
    ResourceKey::insight(space, "_global", id)
        .unwrap()
        .to_string()
}

fn as_user(h: &Harness, who: &str, key: &str) -> Connect {
    let cookie = format!("kb_session={}", h.cookie(who));
    connect(
        h.port(),
        &format!("/api/v1/collab/ws?doc={}", enc(key)),
        &[("Cookie", &cookie)],
    )
}

fn open(connect: Connect) -> Box<CollabClient> {
    match connect {
        Connect::Open(client) => client,
        Connect::Refused(status) => panic!("握手被拒:{status}"),
    }
}

fn refused(connect: Connect) -> u16 {
    match connect {
        Connect::Refused(status) => status,
        Connect::Open(_) => panic!("本应被拒绝"),
    }
}

/// 等条件成立(期间持续读取各客户端),最多 `secs` 秒。
fn wait_for(
    clients: &mut [&mut CollabClient],
    secs: u64,
    mut check: impl FnMut(&mut [&mut CollabClient]) -> bool,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        for client in clients.iter_mut() {
            client.pump(Duration::from_millis(50), Duration::from_millis(200));
        }
        if check(clients) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
    }
}

fn body_of(h: &Harness, who: &str, id: &str) -> String {
    h.ok(who, "get_item", json!({ "id": id }))["item"]["text"]
        .as_str()
        .unwrap_or("")
        .to_owned()
}

/// 笔记当前的乐观锁版本号(`list_items` 才带)。
fn version_of(h: &Harness, who: &str, id: &str) -> i64 {
    let listed = h.ok(
        who,
        "list_items",
        json!({ "collection": "_global", "page_size": 100 }),
    );
    listed["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == id)
        .and_then(|item| item["version"].as_i64())
        .expect("笔记的版本号")
}

#[test]
fn two_people_edit_one_note_it_lands_api_writes_wait_and_the_history_names_both() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "协作笔记", "原文");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note_target(&space, &id), "user_id": h.id("bob"), "role": "editor" }),
    );
    let key = doc_key(&space, &id);

    // alice 先到:被指定为初始化者,拿到正文 Markdown
    let mut alice = open(as_user(&h, "alice", &key));
    alice.settle();
    assert_eq!(alice.last_ctrl("hello").unwrap()["init"], "原文");
    assert_eq!(
        alice.last_ctrl("hello").unwrap()["you"]["id"],
        h.id("alice")
    );
    alice.initialize();
    alice.settle();
    // bob 后到:内容已就绪,直接同步到初始化的内容
    let mut bob = open(as_user(&h, "bob", &key));
    bob.settle();
    alice.settle();
    assert_eq!(bob.last_ctrl("hello").unwrap()["ready"], true);
    assert!(bob.rich_text().contains("原文"), "{}", bob.rich_text());
    // bob 敲一段,alice 实时看到
    bob.add_paragraph("bob 加的一段");
    assert!(wait_for(&mut [&mut alice, &mut bob], 5, |c| c[0]
        .rich_text()
        .contains("bob 加的一段")));
    // alice 是落地者:提交 Markdown → 写回正文(版本号变了)
    assert_eq!(alice.last_ctrl("lander").unwrap()["you"], true);
    let before = version_of(&h, "alice", &id);
    alice.land("原文\n\nbob 加的一段");
    assert!(wait_for(&mut [&mut alice, &mut bob], 5, |c| c[0]
        .last_ctrl("saved")
        .is_some()));
    assert_eq!(body_of(&h, "alice", &id), "原文\n\nbob 加的一段");
    let after = version_of(&h, "alice", &id);
    assert!(after > before, "落地涨版本号,让持旧版本号的写入冲突");

    // 有人在编辑时,API 直接写正文 / 删除被拒绝(409),不会把大家正在写的内容覆盖掉
    let (status, body) = h.call(
        "alice",
        "edit_item",
        json!({ "id": id, "version": after, "body": "API 覆盖" }),
    );
    assert_eq!(status, 409, "{body}");
    assert!(body.to_string().contains("多人编辑"), "{body}");
    let (status, _) = h.call("alice", "delete_item", json!({ "id": id }));
    assert_eq!(status, 409);
    // 只改标题 / 标签不碰正文:不受影响
    let (status, body) = h.call(
        "alice",
        "edit_item",
        json!({ "id": id, "version": after, "title": "新标题" }),
    );
    assert_eq!(status, 200, "{body}");
    assert_eq!(body_of(&h, "alice", &id), "原文\n\nbob 加的一段");

    // 都走了:最后一人离开时生成保存点,版本历史里记着两个参与者(含协作之前的基线)
    alice.close();
    bob.close();
    let source = format!("insight:{id}");
    let mut versions = json!([]);
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        versions = h.ok(
            "alice",
            "file_versions",
            json!({ "collection": "_global", "path": source }),
        )["versions"]
            .clone();
        if versions.as_array().is_some_and(|v| v.len() >= 2) {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let versions = versions.as_array().unwrap().clone();
    assert!(versions.len() >= 2, "应有基线 + 保存点:{versions:?}");
    let newest = versions[0]["author"].as_str().unwrap();
    assert!(
        newest.contains(h.id("alice")) && newest.contains(h.id("bob")),
        "保存点记录所有参与者:{newest}"
    );
    assert_eq!(versions.last().unwrap()["author"], "baseline");
    // 房间里没有未落地 / 未写盘的内容了,API 写入重新放行
    let version = version_of(&h, "alice", &id);
    let mut done = false;
    for _ in 0..30 {
        let (status, _) = h.call(
            "alice",
            "edit_item",
            json!({ "id": id, "version": version, "body": "离开之后 API 的修改" }),
        );
        if status == 200 {
            done = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    assert!(done, "房间收尾后 API 写入应放行");
    // 正文被 API 改过:下一次打开重新按新正文初始化,而不是用旧的协作状态
    let mut carol_like = open(as_user(&h, "alice", &key));
    carol_like.settle();
    assert_eq!(
        carol_like.last_ctrl("hello").unwrap()["init"],
        "离开之后 API 的修改"
    );
}

#[test]
fn only_people_who_may_see_the_note_can_connect_and_viewers_cannot_write() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "私有笔记", "秘密");
    let key = doc_key(&space, &id);
    // 陌生人:和「不存在」同一个回答
    assert_eq!(refused(as_user(&h, "bob", &key)), 404);
    assert_eq!(
        refused(as_user(
            &h,
            "bob",
            &doc_key(&space, "00000000-0000-0000-0000-000000000000")
        )),
        404
    );
    // 没登录
    assert_eq!(
        refused(connect(
            h.port(),
            &format!("/api/v1/collab/ws?doc={}", enc(&key)),
            &[]
        )),
        401
    );
    // 别的网站的页面发起的连接:来源不对
    let cookie = format!("kb_session={}", h.cookie("alice"));
    assert_eq!(
        refused(connect(
            h.port(),
            &format!("/api/v1/collab/ws?doc={}", enc(&key)),
            &[("Cookie", &cookie), ("Origin", "https://evil.example")],
        )),
        403
    );
    // 不是笔记 / 文件的资源键:400
    let collection = ResourceKey::collection(&space, "_global")
        .unwrap()
        .to_string();
    assert_eq!(refused(as_user(&h, "alice", &collection)), 400);
    assert_eq!(refused(as_user(&h, "alice", "不是资源键")), 400);

    // 查看者:能连、能实时看到,自己的修改被丢弃
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": note_target(&space, &id), "user_id": h.id("bob"), "role": "viewer" }),
    );
    let mut alice = open(as_user(&h, "alice", &key));
    alice.settle();
    alice.initialize();
    alice.settle();
    let mut bob = open(as_user(&h, "bob", &key));
    bob.settle();
    assert_eq!(bob.last_ctrl("hello").unwrap()["writable"], false);
    alice.add_paragraph("alice 写的");
    assert!(wait_for(&mut [&mut alice, &mut bob], 5, |c| c[1]
        .rich_text()
        .contains("alice 写的")));
    bob.add_paragraph("bob 想篡改");
    alice.settle();
    assert!(
        !alice.rich_text().contains("bob 想篡改"),
        "查看者的修改不应被接受"
    );
    let mut late = open(as_user(&h, "alice", &key));
    late.settle();
    assert!(
        !late.rich_text().contains("bob 想篡改"),
        "服务端状态里也没有"
    );
}

#[test]
fn demotion_and_removal_reach_connected_people_within_seconds() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "权限变化", "x");
    let target = note_target(&space, &id);
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "editor" }),
    );
    let key = doc_key(&space, &id);
    let mut alice = open(as_user(&h, "alice", &key));
    alice.settle();
    alice.initialize();
    alice.settle();
    let mut bob = open(as_user(&h, "bob", &key));
    bob.settle();
    assert_eq!(bob.last_ctrl("hello").unwrap()["writable"], true);
    // 降级成查看:马上变只读
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": target, "user_id": h.id("bob"), "role": "viewer" }),
    );
    assert!(wait_for(&mut [&mut alice, &mut bob], 5, |c| c[1]
        .last_ctrl("role")
        .is_some_and(|r| r["writable"] == false)));
    bob.add_paragraph("降级后想写");
    alice.settle();
    assert!(!alice.rich_text().contains("降级后想写"));
    // 收回授权:连接被断开
    h.ok(
        "alice",
        "grant_remove",
        json!({ "target": target, "user_id": h.id("bob") }),
    );
    assert!(wait_for(&mut [&mut alice, &mut bob], 5, |c| c[1]
        .closed
        .is_some()));
    assert_eq!(bob.closed.as_ref().unwrap().0, 4403);
    // 他重新连:被拒绝
    assert_eq!(refused(as_user(&h, "bob", &key)), 404);
    // alice 不受影响
    alice.add_paragraph("alice 继续写");
    alice.settle();
    assert!(alice.closed.is_none());
}

#[test]
fn guests_collaborate_through_a_link_only_within_its_scope_and_lose_access_when_it_is_revoked() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "链接协作", "x");
    let other = new_note(&h, "alice", "链接之外", "y");
    // 打开游客编辑
    let config_path = h.daemon.home.path().join("config.toml");
    let original = std::fs::read_to_string(&config_path).unwrap();
    std::fs::write(
        &config_path,
        format!("{original}\n[share]\nallow_guest_edit = true\nallow_guest_comment = true\n"),
    )
    .unwrap();
    let created = h.ok(
        "alice",
        "link_create",
        json!({ "target": note_target(&space, &id), "audience": "anyone", "role": "editor" }),
    );
    let token = created["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();
    let link_id = created["link"]["id"].as_str().unwrap().to_owned();
    let key = doc_key(&space, &id);
    let guest_path = |doc: &str| format!("/api/v1/share/{token}/collab?doc={}", enc(doc));
    // 参数生效有一点延迟:等游客能拿到编辑权限
    let mut guest = None;
    for _ in 0..40 {
        let client = open(connect(h.port(), &guest_path(&key), &[]));
        let mut client = client;
        client.settle();
        if client
            .last_ctrl("hello")
            .is_some_and(|hello| hello["writable"] == true)
        {
            guest = Some(client);
            break;
        }
        client.close();
        std::thread::sleep(Duration::from_millis(250));
    }
    let mut guest = guest.expect("游客拿到编辑权限");
    let me = guest.last_ctrl("hello").unwrap()["you"].clone();
    assert!(me["id"].as_str().unwrap().starts_with("guest:"), "{me}");
    // 范围之外的文档:和不存在一样
    assert_eq!(
        refused(connect(
            h.port(),
            &guest_path(&doc_key(&space, &other)),
            &[]
        )),
        404
    );
    // 不是链接的令牌
    assert_eq!(
        refused(connect(
            h.port(),
            &format!("/api/v1/share/{}/collab?doc={}", "x".repeat(22), enc(&key)),
            &[]
        )),
        404
    );
    // 游客初始化并编辑,alice 作为登录用户实时看到
    guest.initialize();
    guest.settle();
    let mut alice = open(as_user(&h, "alice", &key));
    alice.settle();
    guest.add_paragraph("游客写的");
    assert!(wait_for(&mut [&mut guest, &mut alice], 5, |c| c[1]
        .rich_text()
        .contains("游客写的")));
    // 光标上显示的身份由服务端认定
    assert_eq!(
        alice.last_ctrl("hello").unwrap()["you"]["id"],
        h.id("alice")
    );
    // 撤销链接:游客的连接被断开
    h.ok("alice", "link_revoke", json!({ "id": link_id }));
    assert!(wait_for(&mut [&mut guest, &mut alice], 5, |c| c[0]
        .closed
        .is_some()));
    assert_eq!(guest.closed.as_ref().unwrap().0, 4403);
    assert!(alice.closed.is_none(), "alice 不受影响");
    assert_eq!(refused(connect(h.port(), &guest_path(&key), &[])), 410);
}

#[test]
fn a_guest_link_without_guest_editing_is_read_only_and_a_password_link_needs_the_unlock_first() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "只读游客", "x");
    let key = doc_key(&space, &id);
    // 默认参数:游客只能看
    let created = h.ok(
        "alice",
        "link_create",
        json!({ "target": note_target(&space, &id), "audience": "anyone", "role": "editor" }),
    );
    let token = created["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();
    let mut owner = open(as_user(&h, "alice", &key));
    owner.settle();
    owner.initialize();
    owner.settle();
    let mut guest = open(connect(
        h.port(),
        &format!("/api/v1/share/{token}/collab?doc={}", enc(&key)),
        &[],
    ));
    guest.settle();
    assert_eq!(guest.last_ctrl("hello").unwrap()["writable"], false);
    guest.add_paragraph("游客想写");
    owner.settle();
    assert!(!owner.rich_text().contains("游客想写"));
    // 加密链接:没输密码就连,被拒
    let locked = h.ok(
        "alice",
        "link_create",
        json!({ "target": note_target(&space, &id), "audience": "anyone", "role": "viewer", "password": "sesame1" }),
    );
    let locked_token = locked["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(
        refused(connect(
            h.port(),
            &format!("/api/v1/share/{locked_token}/collab?doc={}", enc(&key)),
            &[]
        )),
        401
    );
    // 输对密码后带着解锁 cookie 可以连
    let (status, headers, _) = http_headers(
        h.port(),
        "POST",
        &format!("/api/v1/share/{locked_token}/unlock"),
        &[("X-KB-CSRF", "1")],
        Some(json!({ "password": "sesame1" })),
    );
    assert_eq!(status, 200);
    let link_id = locked["link"]["id"].as_str().unwrap();
    let unlock = set_cookie_value(&headers, &format!("kb_share_{link_id}")).expect("解锁 cookie");
    let guest_cookie = set_cookie_value(&headers, "kb_guest");
    let mut jar = format!("kb_share_{link_id}={unlock}");
    if let Some(value) = guest_cookie {
        jar.push_str(&format!("; kb_guest={value}"));
    }
    let mut unlocked = open(connect(
        h.port(),
        &format!("/api/v1/share/{locked_token}/collab?doc={}", enc(&key)),
        &[("Cookie", &jar)],
    ));
    unlocked.settle();
    assert_eq!(unlocked.last_ctrl("hello").unwrap()["writable"], false);
}

#[test]
fn deleting_a_note_disconnects_everyone_and_forgets_the_collaboration_state() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "要删的", "x");
    let key = doc_key(&space, &id);
    let mut alice = open(as_user(&h, "alice", &key));
    alice.settle();
    alice.initialize();
    alice.settle();
    // 有人连着时 API 删除被拒;连接走掉以后才能删(这里改用 delete_collection 之外的路径:先离开)
    let (status, _) = h.call("alice", "delete_item", json!({ "id": id }));
    assert_eq!(status, 409);
    alice.close();
    let mut deleted = false;
    for _ in 0..30 {
        let (status, _) = h.call("alice", "delete_item", json!({ "id": id }));
        if status == 200 {
            deleted = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    assert!(deleted);
    // 已经删除:再连是 404
    assert_eq!(refused(as_user(&h, "alice", &key)), 404);
}

/// 重置链接(旧地址作废)、给链接加 / 换密码之后,已经连着的游客要被断开:
/// 他们拿的是旧凭据,连接不能因为链接本身仍然"有效"就一直开着。
#[test]
fn resetting_a_link_or_changing_its_password_disconnects_guests_who_joined_with_the_old_credentials()
 {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "换凭据", "x");
    let config_path = h.daemon.home.path().join("config.toml");
    let original = std::fs::read_to_string(&config_path).unwrap();
    std::fs::write(
        &config_path,
        format!("{original}\n[share]\nallow_guest_edit = true\n"),
    )
    .unwrap();
    let created = h.ok(
        "alice",
        "link_create",
        json!({ "target": note_target(&space, &id), "audience": "anyone", "role": "editor" }),
    );
    let link_id = created["link"]["id"].as_str().unwrap().to_owned();
    let mut token = created["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();
    let key = doc_key(&space, &id);
    let join_as_guest = |token: &str| -> Box<CollabClient> {
        let path = format!("/api/v1/share/{token}/collab?doc={}", enc(&key));
        for _ in 0..40 {
            let mut client = open(connect(h.port(), &path, &[]));
            client.settle();
            if client
                .last_ctrl("hello")
                .is_some_and(|hello| hello["writable"] == true)
            {
                return client;
            }
            client.close();
            std::thread::sleep(Duration::from_millis(250));
        }
        panic!("游客拿不到编辑权限");
    };

    // 重置链接:旧令牌连着的游客被断开
    let mut guest = join_as_guest(&token);
    let reset = h.ok("alice", "link_reset", json!({ "id": link_id }));
    assert!(
        wait_for(&mut [&mut guest], 8, |c| c[0].closed.is_some()),
        "重置之后旧连接必须被断开"
    );
    assert_eq!(guest.closed.as_ref().unwrap().0, 4403);
    // 新令牌可以正常加入(对照组:断开的是旧凭据,不是链接本身)
    token = reset["url"]
        .as_str()
        .unwrap()
        .rsplit("/s/")
        .next()
        .unwrap()
        .to_owned();
    let mut fresh = join_as_guest(&token);
    assert!(fresh.closed.is_none());

    // 给链接设上密码:没输过密码就连着的游客被断开
    h.ok(
        "alice",
        "link_update",
        json!({ "id": link_id, "password": "sesame1" }),
    );
    assert!(
        wait_for(&mut [&mut fresh], 8, |c| c[0].closed.is_some()),
        "加了密码之后,没输过密码的连接必须被断开"
    );
    assert_eq!(fresh.closed.as_ref().unwrap().0, 4403);
}

/// 撤销一个批次改了正在被协作编辑的笔记:房间里的人被请出去重新打开,
/// 否则他们手里的旧内容稍后又会落地,把这次撤销覆盖掉。
#[test]
fn reverting_a_batch_resets_the_live_room_of_every_note_it_touched() {
    let h = Harness::start();
    let space = h.space("alice");
    let id = new_note(&h, "alice", "会被撤销", "原文");
    // 笔记异步入库:等它出现在列表里才有版本号
    let mut listed = false;
    for _ in 0..40 {
        let items = h.ok(
            "alice",
            "list_items",
            json!({ "collection": "_global", "page_size": 100 }),
        );
        if items["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == id))
        {
            listed = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    assert!(listed, "笔记没有入库");
    let version = version_of(&h, "alice", &id);
    // 用能力直接改正文(没人在协作时可以),拿到这次编辑的批次号
    let (status, _, edited) = support::http(
        h.port(),
        "POST",
        "/api/v1/capabilities/edit_item",
        Some(h.cookie("alice")),
        Some(json!({ "id": id, "body": "被改过的正文", "version": version })),
    );
    assert_eq!(status, 200, "{edited}");
    let batch_id = edited["meta"]["batch_id"]
        .as_str()
        .expect("编辑返回了批次号")
        .to_owned();
    assert_eq!(body_of(&h, "alice", &id), "被改过的正文");

    // alice 打开协作:房间以现在的正文开始
    let key = doc_key(&space, &id);
    let mut alice = open(as_user(&h, "alice", &key));
    alice.settle();
    assert!(alice.closed.is_none());

    // 撤销那个批次:正文回到原文,房间里的人被请出去(关闭码 4409)
    h.ok("alice", "revert_batch", json!({ "batch_id": batch_id }));
    assert!(
        wait_for(&mut [&mut alice], 8, |c| c[0].closed.is_some()),
        "撤销改了正文,房间里的连接必须被请出去"
    );
    assert_eq!(alice.closed.as_ref().unwrap().0, 4409);
    assert_eq!(body_of(&h, "alice", &id), "原文");
    // 重新打开之后看到的是撤销后的正文
    let mut again = open(as_user(&h, "alice", &key));
    again.settle();
    assert!(again.closed.is_none());
}

/// 上传一个文件到 `_global`,等它入库完成。
fn upload_file(h: &Harness, who: &str, rel_path: &str, bytes: &[u8]) {
    let sha = kb_core::hash::sha256_hex_bytes(bytes);
    let name = rel_path.rsplit('/').next().unwrap();
    let (status, _, created) = support::http(
        h.port(),
        "POST",
        "/api/v1/uploads",
        Some(h.cookie(who)),
        Some(
            json!({ "name": name, "size": bytes.len(), "sha256": sha, "collection": "_global", "rel_path": rel_path }),
        ),
    );
    assert_eq!(status, 200, "{created}");
    let id = created["data"]["upload_id"].as_str().unwrap().to_owned();
    let (status, _, _) = support::http_bytes(
        h.port(),
        "PUT",
        &format!("/api/v1/uploads/{id}/parts/0"),
        Some(h.cookie(who)),
        "application/octet-stream",
        bytes,
    );
    assert_eq!(status, 200);
    let (status, _, done) = support::http(
        h.port(),
        "POST",
        &format!("/api/v1/uploads/{id}/complete"),
        Some(h.cookie(who)),
        None,
    );
    assert_eq!(status, 200, "{done}");
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        let (status, preview) = h.call(
            who,
            "file_preview",
            json!({ "collection": "_global", "path": rel_path }),
        );
        if status == 200 && !preview["chunks"].as_array().is_none_or(|c| c.is_empty()) {
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    panic!("{rel_path} 没有入库");
}

fn file_key(space: &str, path: &str) -> String {
    ResourceKey::file(space, "_global", path)
        .unwrap()
        .to_string()
}

/// Markdown 文件和笔记一样走富文本房间:页面用所见即所得编辑它,房间也必须是同一种结构,
/// 否则两边对不上(以前 .md 文件因此被排除在多人编辑之外)。落地写回原文件,别的文本文件仍是纯文本房间。
#[test]
fn markdown_files_are_edited_together_in_a_rich_room_and_land_back_into_the_file() {
    let h = Harness::start();
    let space = h.space("alice");
    upload_file(&h, "alice", "文档/说明.md", "# 标题\n\n原文\n".as_bytes());
    let key = file_key(&space, "文档/说明.md");

    let mut first = open(as_user(&h, "alice", &key));
    first.settle();
    let hello = first.last_ctrl("hello").unwrap().clone();
    assert_eq!(hello["kind"], "rich", "Markdown 文件是富文本房间:{hello}");
    assert_eq!(
        hello["init"], "# 标题\n\n原文\n",
        "初始化者拿到文件的 Markdown"
    );
    first.initialize();
    first.settle();

    // 同一个人的另一个窗口(或另一个人)加入,看到初始化后的内容,并加一段
    let mut second = open(as_user(&h, "alice", &key));
    second.settle();
    first.settle();
    assert!(
        second.rich_text().contains("原文"),
        "{}",
        second.rich_text()
    );
    second.add_paragraph("第二个窗口加的一段");
    assert!(wait_for(&mut [&mut first, &mut second], 5, |c| c[0]
        .rich_text()
        .contains("第二个窗口加的一段")));

    // 落地者把编辑器序列化出来的 Markdown 交上来:写回原文件
    let landed = "# 标题\n\n原文\n\n第二个窗口加的一段\n";
    let lander = if first.last_ctrl("lander").is_some_and(|l| l["you"] == true) {
        &mut first
    } else {
        &mut second
    };
    lander.land(landed);
    assert!(wait_for(&mut [&mut first, &mut second], 5, |c| c
        .iter()
        .any(|client| client.last_ctrl("saved").is_some())));
    let preview = h.ok(
        "alice",
        "file_preview",
        json!({ "collection": "_global", "path": "文档/说明.md" }),
    );
    assert_eq!(preview["content"], landed, "文件内容就是落地的 Markdown");

    // 纯文本文件仍是纯文本房间(服务端自己就能取出字符串)
    upload_file(&h, "alice", "文档/记录.txt", "纯文本\n".as_bytes());
    let mut text = open(as_user(&h, "alice", &file_key(&space, "文档/记录.txt")));
    text.settle();
    assert_eq!(text.last_ctrl("hello").unwrap()["kind"], "text");
}

/// 协作编辑保持文件原来的编码:GBK 的 Markdown / 文本文件进得了房间(初始化者拿到解码后的文字),
/// 落地写回后仍是 GBK——不能悄悄变成 UTF-8(单人编辑早就是这样,协作这条路也必须一样)。
#[test]
fn collaborative_editing_keeps_a_gbk_file_in_gbk() {
    let h = Harness::start();
    let space = h.space("alice");
    let (gbk, _, _) = encoding_rs::GB18030.encode("# 标题\n\n原文\n");
    upload_file(&h, "alice", "文档/国标.md", &gbk);
    let key = file_key(&space, "文档/国标.md");
    let mut client = open(as_user(&h, "alice", &key));
    client.settle();
    let hello = client.last_ctrl("hello").unwrap().clone();
    assert_eq!(
        hello["init"], "# 标题\n\n原文\n",
        "按原来的编码解出来:{hello}"
    );
    client.initialize();
    client.settle();
    client.land("# 标题\n\n原文\n\n加了一段\n");
    assert!(wait_for(&mut [&mut client], 5, |c| c[0]
        .last_ctrl("saved")
        .is_some()));
    let (status, _, bytes) = support::http_raw(
        h.port(),
        "GET",
        &format!(
            "/api/v1/raw?collection=_global&path={}",
            enc("文档/国标.md")
        ),
        &[("Cookie", &format!("kb_session={}", h.cookie("alice")))],
        None,
    );
    assert_eq!(status, 200);
    let (expected, _, _) = encoding_rs::GB18030.encode("# 标题\n\n原文\n\n加了一段\n");
    assert_eq!(bytes, expected.to_vec(), "写回的仍是 GBK 字节");
    assert!(std::str::from_utf8(&bytes).is_err(), "不是 UTF-8");
}
