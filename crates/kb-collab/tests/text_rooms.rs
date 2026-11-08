//! 文本文档(Y.Text)房间:同步、权限、持久化、落地、保存点。

mod common;

use common::*;
use kb_collab::Access;

async fn settle(clients: &mut [&mut Client]) {
    for _ in 0..3 {
        for client in clients.iter_mut() {
            client.pump().await;
        }
    }
}

#[tokio::test]
async fn two_writers_see_each_others_typing_and_start_from_the_stored_body() {
    let world = World::new(fast_limits());
    world.hooks.set_body("doc/a", "你好");
    let doc = text_doc("doc/a");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut alice, &mut bob]).await;
    assert_eq!(alice.text(), "你好");
    assert_eq!(bob.text(), "你好");
    // 含中文的位置按 UTF-16 码元算,和浏览器一致
    alice.insert(2, ",世界").await;
    settle(&mut [&mut alice, &mut bob]).await;
    assert_eq!(bob.text(), "你好,世界");
    bob.insert(0, "【").await;
    bob.insert(1, "🙂").await;
    settle(&mut [&mut alice, &mut bob]).await;
    assert_eq!(alice.text(), bob.text());
    assert_eq!(alice.text(), "【🙂你好,世界");
}

#[tokio::test]
async fn a_viewer_sees_live_changes_but_their_own_edits_are_dropped() {
    let world = World::new(fast_limits());
    world.hooks.set_body("doc/a", "原文");
    let doc = text_doc("doc/a");
    let mut writer = world.join(&doc, &person("alice"), true).await;
    let mut viewer = world.join(&doc, &person("vera"), false).await;
    settle(&mut [&mut writer, &mut viewer]).await;
    assert_eq!(viewer.last_ctrl("hello").unwrap()["writable"], false);
    writer.insert(2, "+1").await;
    settle(&mut [&mut writer, &mut viewer]).await;
    assert_eq!(viewer.text(), "原文+1", "查看者能实时看到");
    // 查看者本地乱改并硬发出去:服务端丢弃,别人不受影响
    viewer.insert(0, "篡改").await;
    viewer.remove(0, 1).await;
    settle(&mut [&mut writer, &mut viewer]).await;
    assert_eq!(writer.text(), "原文+1");
    // 服务端状态里也没有:新来一个人看到的是干净的
    let mut fresh = world.join(&doc, &person("carol"), false).await;
    settle(&mut [&mut fresh]).await;
    assert_eq!(fresh.text(), "原文+1");
}

#[tokio::test]
async fn demotion_takes_effect_at_once_and_revocation_disconnects() {
    let world = World::new(fast_limits());
    world.hooks.set_body("doc/a", "x");
    let doc = text_doc("doc/a");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut alice, &mut bob]).await;
    // 降级成只读
    world.auth.set("bob", Access::Read);
    world.hub.refresh_where(|key| key == "doc/a").await;
    settle(&mut [&mut alice, &mut bob]).await;
    assert_eq!(bob.last_ctrl("role").unwrap()["writable"], false);
    bob.insert(1, "被拒").await;
    settle(&mut [&mut alice, &mut bob]).await;
    assert_eq!(alice.text(), "x", "降级后的修改不再被接受");
    // 收回权限:连接被断开
    world.auth.set("bob", Access::Denied);
    world.hub.refresh_where(|key| key == "doc/a").await;
    bob.pump().await;
    assert_eq!(bob.closed.as_ref().map(|c| c.0), Some(4403));
    // 别人不受影响
    alice.insert(1, "!").await;
    settle(&mut [&mut alice]).await;
    assert_eq!(alice.text(), "x!");
    // 无关的文档键不会被核对
    world.hub.refresh_where(|key| key == "doc/other").await;
}

#[tokio::test]
async fn edits_are_saved_landed_versioned_and_survive_a_restart_of_the_room() {
    let world = World::new(fast_limits());
    world.hooks.set_body("doc/a", "起点");
    let doc = text_doc("doc/a");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut alice, &mut bob]).await;
    alice.insert(2, "-甲").await;
    bob.insert(0, "乙-").await;
    settle(&mut [&mut alice, &mut bob]).await;
    let expected = alice.text();
    assert_eq!(bob.text(), expected);
    // 停止变化一阵后,服务端自己把文本落地到正文
    assert!(
        eventually(1500, || world.hooks.body("doc/a") == expected).await,
        "落地:{}",
        world.hooks.body("doc/a")
    );
    // 所有人离开 → 最后一人离开时立刻生成保存点,参与者是两个人
    alice.leave().await;
    bob.leave().await;
    assert!(eventually(1500, || !world.hooks.savepoints.lock().unwrap().is_empty()).await);
    let savepoints = world.hooks.savepoints.lock().unwrap().clone();
    assert_eq!(savepoints.len(), 1);
    let ids: Vec<&str> = savepoints[0].1.iter().map(|p| p.id.as_str()).collect();
    assert_eq!(ids, vec!["alice", "bob"]);
    // 房间闲置后关闭;再打开时从库里恢复,内容一致
    assert!(eventually(2000, || world.hub_rooms_empty()).await);
    let mut carol = world.join(&doc, &person("carol"), true).await;
    settle(&mut [&mut carol]).await;
    assert_eq!(carol.text(), expected);
}

#[tokio::test]
async fn a_body_changed_through_the_api_while_the_room_was_closed_wins() {
    let world = World::new(fast_limits());
    world.hooks.set_body("doc/a", "旧");
    let doc = text_doc("doc/a");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    settle(&mut [&mut alice]).await;
    alice.insert(1, "协作").await;
    assert!(eventually(1500, || world.hooks.body("doc/a") == "旧协作").await);
    alice.leave().await;
    assert!(eventually(2000, || world.hub_rooms_empty()).await);
    // 房间关着的时候有人通过 API 改了正文
    world.hooks.set_body("doc/a", "API 改的");
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut bob]).await;
    assert_eq!(bob.text(), "API 改的", "以正文为准,过期的协作状态作废");
}

#[tokio::test]
async fn unlanded_content_left_by_a_crash_is_landed_by_the_next_room() {
    let world = World::new(fast_limits());
    world.hooks.set_body("doc/a", "原");
    let doc = text_doc("doc/a");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    settle(&mut [&mut alice]).await;
    // 让落地一直失败:内容写进了协作状态,但正文没更新
    *world.hooks.fail_land.lock().unwrap() = true;
    alice.insert(1, "改").await;
    assert!(
        eventually(500, || world
            .store
            .peek("doc/a")
            .is_some_and(|d| !d.updates.is_empty()))
        .await
    );
    alice.leave().await;
    assert!(eventually(2000, || world.hub_rooms_empty()).await);
    assert_eq!(world.hooks.body("doc/a"), "原");
    // 故障恢复后下一个打开的人触发补写
    *world.hooks.fail_land.lock().unwrap() = false;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut bob]).await;
    assert_eq!(bob.text(), "原改");
    assert!(
        eventually(1500, || world.hooks.body("doc/a") == "原改").await,
        "补写:{}",
        world.hooks.body("doc/a")
    );
}

#[tokio::test]
async fn is_busy_tells_the_api_when_a_direct_write_would_clobber_someone() {
    let world = World::new(fast_limits());
    world.hooks.set_body("doc/a", "x");
    let doc = text_doc("doc/a");
    assert!(!world.hub.is_busy("doc/a").await);
    let mut alice = world.join(&doc, &person("alice"), true).await;
    settle(&mut [&mut alice]).await;
    assert!(world.hub.is_busy("doc/a").await, "有人连着");
    alice.leave().await;
    assert!(eventually(2000, || world.hub_rooms_empty()).await);
    assert!(!world.hub.is_busy("doc/a").await, "关了以后不再占用");
    assert!(!world.hub.is_busy("doc/none").await);
}

#[tokio::test]
async fn abusive_connections_are_cut_off_without_hurting_the_room() {
    let mut limits = fast_limits();
    limits.message_burst = 20;
    limits.messages_per_second = 5;
    limits.max_message_bytes = 1024;
    let world = World::new(limits);
    world.hooks.set_body("doc/a", "x");
    let doc = text_doc("doc/a");
    let mut good = world.join(&doc, &person("alice"), true).await;
    let mut spammer = world.join(&doc, &person("spam"), true).await;
    settle(&mut [&mut good, &mut spammer]).await;
    // 太频繁
    for _ in 0..40 {
        spammer.insert(0, "z").await;
    }
    spammer.pump().await;
    assert_eq!(spammer.closed.as_ref().map(|c| c.0), Some(1008));
    // 太大
    let mut big = world.join(&doc, &person("big"), true).await;
    settle(&mut [&mut big]).await;
    big.session().send(&vec![0u8; 4096]).await;
    big.pump().await;
    assert_eq!(big.closed.as_ref().map(|c| c.0), Some(1009));
    // 乱码
    let mut junk = world.join(&doc, &person("junk"), true).await;
    settle(&mut [&mut junk]).await;
    junk.session().send(&[0xff, 0xff, 0xff, 0xff, 0x01]).await;
    junk.pump().await;
    assert_eq!(junk.closed.as_ref().map(|c| c.0), Some(1003));
    // 房间和好人都没事
    good.insert(1, "ok").await;
    settle(&mut [&mut good]).await;
    assert!(good.text().contains("ok"));
}

#[tokio::test]
async fn a_deleted_document_disconnects_everyone_and_leaves_no_trace() {
    let world = World::new(fast_limits());
    world.hooks.set_body("doc/a", "x");
    world.hooks.set_body("doc/b", "y");
    let doc = text_doc("doc/a");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut other = world.join(&text_doc("doc/b"), &person("bob"), true).await;
    settle(&mut [&mut alice, &mut other]).await;
    alice.insert(1, "未落地的").await;
    world
        .hub
        .discard_where(|key| key == "doc/a", "文档已被删除")
        .await;
    alice.pump().await;
    assert_eq!(alice.closed.as_ref().map(|c| c.0), Some(4404));
    // 别的文档不受影响
    other.insert(1, "!").await;
    settle(&mut [&mut other]).await;
    assert_eq!(other.text(), "y!");
    // 被丢弃的房间不会再落地 / 生成保存点
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    assert_eq!(world.hooks.body("doc/a"), "x");
    assert!(
        world
            .hooks
            .savepoints
            .lock()
            .unwrap()
            .iter()
            .all(|(key, _)| key != "doc/a")
    );
    assert_eq!(world.hub.open_rooms(), 1);
}

#[tokio::test]
async fn a_room_that_is_idle_but_not_yet_closed_notices_a_body_changed_behind_its_back() {
    let mut limits = fast_limits();
    // 闲置很久才关,保证重新加入时房间还开着
    limits.idle_close = std::time::Duration::from_secs(30);
    let world = World::new(limits);
    world.hooks.set_body("doc/a", "旧");
    let doc = text_doc("doc/a");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    settle(&mut [&mut alice]).await;
    alice.insert(1, "协作").await;
    assert!(eventually(1500, || world.hooks.body("doc/a") == "旧协作").await);
    alice.leave().await;
    assert_eq!(world.hub.open_rooms(), 1, "房间还开着");
    // 房间闲置期间,正文被别的途径(API、导入、批次撤销)改了
    world.hooks.set_body("doc/a", "外部改写后的正文");
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut bob]).await;
    assert_eq!(
        bob.text(),
        "外部改写后的正文",
        "房间闲置时也要核对正文,过期就作废重开"
    );
}

#[tokio::test]
async fn an_external_write_sends_everyone_out_and_the_next_open_starts_from_the_new_body() {
    let world = World::new(fast_limits());
    world.hooks.set_body("doc/a", "原");
    let doc = text_doc("doc/a");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut alice, &mut bob]).await;
    world.hooks.set_body("doc/a", "API 写的");
    world.hub.external_write("doc/a").await;
    alice.pump().await;
    bob.pump().await;
    assert_eq!(alice.closed.as_ref().map(|c| c.0), Some(4409));
    assert_eq!(bob.closed.as_ref().map(|c| c.0), Some(4409));
    // 没有这个房间:什么也不做
    world.hub.external_write("doc/none").await;
    let mut carol = world.join(&doc, &person("carol"), true).await;
    settle(&mut [&mut carol]).await;
    assert_eq!(carol.text(), "API 写的");
}

// ---------------------------------------------------------------- 安全审查 H-4:按人限额

fn join_request(doc: &str, who: &str) -> kb_collab::JoinRequest {
    kb_collab::JoinRequest {
        doc: text_doc(doc),
        who: person(who),
        ctx: String::new(),
        writable: true,
    }
}

#[tokio::test]
async fn one_person_cannot_fill_the_site_with_rooms_and_other_people_are_unaffected() {
    let limits = kb_collab::Limits {
        max_rooms_per_user: 2,
        max_rooms: 3,
        ..fast_limits()
    };
    let world = World::new(limits);
    for key in ["doc/1", "doc/2", "doc/3", "doc/4"] {
        world.hooks.set_body(key, "x");
    }
    for who in ["mallory", "alice"] {
        world.auth.set(who, Access::Write);
    }
    // mallory 打开两篇:到她的上限
    let first = world
        .hub
        .join(join_request("doc/1", "mallory"))
        .await
        .unwrap();
    let _second = world
        .hub
        .join(join_request("doc/2", "mallory"))
        .await
        .unwrap();
    let err = world
        .hub
        .join(join_request("doc/3", "mallory"))
        .await
        .err()
        .expect("第三篇必须被拒绝");
    assert!(err.to_string().contains("最多 2 篇"), "{err}");
    // 被拒绝的人不能顺手把房间开出来(占着全站名额)
    assert_eq!(world.hub.open_rooms(), 2);
    // 同一篇文档再开一个标签页不算新的一篇
    let _tab = world
        .hub
        .join(join_request("doc/1", "mallory"))
        .await
        .unwrap();
    // 别人不受她影响:还剩一个全站名额,alice 用得上
    let _alice = world
        .hub
        .join(join_request("doc/3", "alice"))
        .await
        .unwrap();
    // 关掉一篇(两个标签页都关),名额就还给她了——但全站此刻是满的(3 个房间都开着),
    // 她要等闲置的房间被回收;先确认她自己的名额确实释放了
    first.leave().await;
    drop(_tab);
    let freed = eventually(3000, || world.hub.open_rooms() < 3).await;
    assert!(freed, "闲置房间应当被回收");
    world
        .hub
        .join(join_request("doc/4", "mallory"))
        .await
        .expect("名额释放之后她又能开新的");
}

/// AI(经 MCP)改正在多人编辑的文档:修改作为服务端的一笔更新广播给所有人,不踢人、不覆盖他们刚写的内容;
/// 原文找不到或不止一处时整批拒绝,什么都不改;只读锁着的房间不让改。
#[tokio::test]
async fn edits_from_outside_land_in_the_live_room_without_kicking_anyone() {
    let world = World::new(fast_limits());
    world
        .hooks
        .set_body("doc/ai", "第一段:苹果\n第二段:香蕉\n第三段:苹果派\n");
    let doc = text_doc("doc/ai");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut alice, &mut bob]).await;
    // bob 正在第二段末尾打字
    bob.insert(13, "和橙子").await;
    settle(&mut [&mut alice, &mut bob]).await;
    // AI 改第一段的「苹果」:带上下文才唯一
    let result = world
        .hub
        .apply_edits(
            &doc.key,
            &[("第一段:苹果".to_owned(), "第一段:青苹果".to_owned())],
            person("ai"),
        )
        .await
        .expect("房间开着");
    assert_eq!(result.expect("改成功"), 1);
    settle(&mut [&mut alice, &mut bob]).await;
    for client in [&alice, &bob] {
        assert_eq!(
            client.text(),
            "第一段:青苹果\n第二段:香蕉和橙子\n第三段:苹果派\n",
            "两个人都实时看到,bob 刚打的字还在"
        );
    }
    assert_eq!(alice.ctrl_count("closing"), 0, "没有人被踢");
    // 「苹果」出现两处:拒绝,内容不变
    let ambiguous = world
        .hub
        .apply_edits(
            &doc.key,
            &[("苹果".to_owned(), "梨".to_owned())],
            person("ai"),
        )
        .await
        .unwrap();
    assert!(ambiguous.unwrap_err().to_string().contains("2 处"));
    // 一批里有一处找不到:整批不改
    let missing = world
        .hub
        .apply_edits(
            &doc.key,
            &[
                ("第二段".to_owned(), "第2段".to_owned()),
                ("不存在的话".to_owned(), "x".to_owned()),
            ],
            person("ai"),
        )
        .await
        .unwrap();
    assert!(missing.unwrap_err().to_string().contains("没找到"));
    settle(&mut [&mut alice, &mut bob]).await;
    assert!(alice.text().contains("第二段"), "整批拒绝,前一处也没改");
    // 中文 / emoji 的位置按 UTF-16 算,和浏览器一致
    world
        .hub
        .apply_edits(
            &doc.key,
            &[("派".to_owned(), "派🍎".to_owned())],
            person("ai"),
        )
        .await
        .unwrap()
        .unwrap();
    settle(&mut [&mut alice, &mut bob]).await;
    assert_eq!(
        bob.text(),
        "第一段:青苹果\n第二段:香蕉和橙子\n第三段:苹果派🍎\n"
    );
    assert_eq!(
        world.hub.read_live(&doc.key).await.as_deref(),
        Some(bob.text().as_str()),
        "读到的就是房间里现在的内容"
    );
    assert!(world.hub.read_live("doc/none").await.is_none());
    // 之后照常落地
    assert!(
        eventually(5000, || world.hooks.body("doc/ai").contains("派🍎")).await,
        "落地"
    );
    // 没有开着的房间:返回 None,调用方自己改正文
    assert!(
        world
            .hub
            .apply_edits(
                "doc/none",
                &[("a".to_owned(), "b".to_owned())],
                person("ai")
            )
            .await
            .is_none()
    );
}
