//! 笔记(Y.XmlFragment)房间:初始化、落地者、落地检查、在线状态。

mod common;

use std::collections::HashMap;
use std::sync::Arc;

use common::*;
use kb_collab::core::base64_encode;
use yrs::StateVector;
use yrs::sync::awareness::{AwarenessUpdate, AwarenessUpdateEntry};
use yrs::sync::protocol::Message;
use yrs::updates::encoder::Encode;

async fn settle(clients: &mut [&mut Client]) {
    for _ in 0..3 {
        for client in clients.iter_mut() {
            client.pump().await;
        }
    }
}

/// 第一个可编辑者按服务端指令初始化:放一个段落,然后报告完成。
async fn initialize(client: &mut Client) {
    client.pump().await;
    let init = client
        .last_ctrl("hello")
        .and_then(|hello| hello["init"].as_str())
        .expect("被指定为初始化者")
        .to_owned();
    client.add_paragraph(&init).await;
    client
        .send_ctrl(serde_json::json!({ "type": "init_done" }))
        .await;
}

#[tokio::test]
async fn the_first_writer_initializes_and_everyone_else_waits_for_ready() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n1", "# 标题\n正文");
    let doc = rich_doc("note/n1");
    let mut viewer = world.join(&doc, &person("vera"), false).await;
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut viewer, &mut alice, &mut bob]).await;
    // 查看者不可能是初始化者;alice 是第一个可编辑者;bob 只等
    let hello = |c: &Client| c.last_ctrl("hello").unwrap().clone();
    assert!(hello(&viewer)["init"].is_null());
    assert_eq!(hello(&viewer)["ready"], false);
    assert_eq!(hello(&alice)["init"], "# 标题\n正文");
    assert_eq!(hello(&alice)["ready"], false);
    assert!(hello(&bob)["init"].is_null());
    // alice 初始化完成:所有人收到 ready,内容同步
    initialize(&mut alice).await;
    settle(&mut [&mut viewer, &mut alice, &mut bob]).await;
    for client in [&viewer, &alice, &bob] {
        assert_eq!(client.ctrl_count("ready"), 1, "{}", client.who.id);
        assert!(client.rich_text().contains("标题"));
    }
    assert_eq!(bob.rich_text(), alice.rich_text());
    // 落地者是最早加入的可编辑者(查看者排除)
    assert_eq!(alice.last_ctrl("lander").unwrap()["you"], true);
    assert!(bob.last_ctrl("lander").is_none());
    assert!(viewer.last_ctrl("lander").is_none());
    // 初始化的内容就是正文,不需要落地,也没有产生版本
    assert!(world.hooks.lands.lock().unwrap().is_empty());
    assert!(world.hooks.savepoints.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_second_writer_never_initializes_twice() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n1", "正文");
    let doc = rich_doc("note/n1");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    initialize(&mut alice).await;
    settle(&mut [&mut alice]).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut alice, &mut bob]).await;
    let hello = bob.last_ctrl("hello").unwrap();
    assert!(hello["init"].is_null());
    assert_eq!(hello["ready"], true, "已经就绪的房间,后来者直接可以输入");
    assert_eq!(bob.rich_text(), alice.rich_text());
    assert_eq!(alice.rich_text().matches("<paragraph>").count(), 1);
}

#[tokio::test]
async fn an_initializer_who_never_finishes_is_replaced() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n1", "正文");
    let doc = rich_doc("note/n1");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut alice, &mut bob]).await;
    assert_eq!(alice.last_ctrl("hello").unwrap()["init"], "正文");
    // alice 一直不报告完成:超时后被换掉,bob 接手
    assert!(
        eventually(2000, || {
            futures_pump(&mut alice);
            alice.closed.is_some()
        })
        .await
    );
    bob.pump().await;
    assert_eq!(alice.closed.as_ref().map(|c| c.0), Some(4408));
    assert_eq!(
        bob.ctrl_count("hello"),
        2,
        "bob 收到了第二条 hello,这次带初始化指令"
    );
    assert_eq!(bob.last_ctrl("hello").unwrap()["init"], "正文");
    initialize(&mut bob).await;
    settle(&mut [&mut bob]).await;
    assert!(bob.last_ctrl("ready").is_some());
}

/// `eventually` 的条件是同步闭包:排空 alice 的队列要在里面做同步等待。
fn futures_pump(client: &mut Client) {
    // 只看关闭帧:其余帧留给之后的 pump 处理(这里是同步闭包里用的轻量排空)
    let mut keep = Vec::new();
    while let Some(frame) = client.session_mut().try_recv() {
        match frame {
            kb_collab::Frame::Close { code, reason } => client.closed = Some((code, reason)),
            other => keep.push(other),
        }
    }
    drop(keep);
}

#[tokio::test]
async fn an_initializer_who_leaves_after_the_content_arrived_does_not_make_anyone_redo_it() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n1", "正文");
    let doc = rich_doc("note/n1");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut alice, &mut bob]).await;
    alice.pump().await;
    // alice 把模板送上来就掉线了(没来得及报告完成)
    alice.add_paragraph("正文").await;
    alice.leave().await;
    bob.pump().await;
    assert_eq!(bob.ctrl_count("ready"), 1, "内容已经进来,视为完成");
    assert_eq!(bob.rich_text().matches("<paragraph>").count(), 1);
    // 反过来:没有任何内容就掉线,下一个人接手
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n2", "x");
    let doc = rich_doc("note/n2");
    let alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut bob]).await;
    alice.leave().await;
    bob.pump().await;
    assert_eq!(bob.last_ctrl("hello").unwrap()["init"], "x");
}

#[tokio::test]
async fn only_the_lander_can_land_and_the_submitted_state_must_be_sane() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n1", "原文");
    let doc = rich_doc("note/n1");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    initialize(&mut alice).await;
    settle(&mut [&mut alice, &mut bob]).await;
    alice.add_paragraph("第二段").await;
    settle(&mut [&mut alice, &mut bob]).await;
    // bob 不是落地者
    bob.land("bob 想落地").await;
    settle(&mut [&mut alice, &mut bob]).await;
    assert!(
        bob.last_ctrl("rejected").unwrap()["reason"]
            .as_str()
            .unwrap()
            .contains("不是落地者")
    );
    assert_eq!(world.hooks.body("note/n1"), "原文");
    // alice 的正常提交
    let early_sv = alice.sv_b64();
    alice.land("# 原文\n\n第二段").await;
    settle(&mut [&mut alice]).await;
    assert!(alice.last_ctrl("saved").is_some());
    assert_eq!(world.hooks.body("note/n1"), "# 原文\n\n第二段");
    // 更新的内容之后,拿旧的状态向量提交:落后,拒绝
    alice.add_paragraph("第三段").await;
    settle(&mut [&mut alice, &mut bob]).await;
    alice.land("# 原文\n\n第二段\n\n第三段").await;
    settle(&mut [&mut alice]).await;
    assert_eq!(world.hooks.body("note/n1"), "# 原文\n\n第二段\n\n第三段");
    alice
        .send_ctrl(
            serde_json::json!({ "type": "land", "markdown": "回退的旧内容", "sv": early_sv }),
        )
        .await;
    settle(&mut [&mut alice]).await;
    assert!(
        alice.last_ctrl("rejected").unwrap()["reason"]
            .as_str()
            .unwrap()
            .contains("落后")
    );
    assert_eq!(world.hooks.body("note/n1"), "# 原文\n\n第二段\n\n第三段");
    // 伪造:声称自己比服务端还新
    let mut forged = StateVector::default();
    forged.set_max(alice.doc.client_id(), 1_000_000);
    alice
        .send_ctrl(serde_json::json!({ "type": "land", "markdown": "伪造", "sv": base64_encode(&forged.encode_v1()) }))
        .await;
    // 乱码 / 非法 base64
    alice
        .send_ctrl(serde_json::json!({ "type": "land", "markdown": "x", "sv": "###" }))
        .await;
    alice.send_ctrl(serde_json::json!({ "type": "land", "markdown": "x", "sv": base64_encode(b"\xff\xff") })).await;
    settle(&mut [&mut alice]).await;
    assert_eq!(alice.ctrl_count("rejected"), 4);
    assert_eq!(world.hooks.body("note/n1"), "# 原文\n\n第二段\n\n第三段");
    // 写入失败不能当成功:告诉提交者
    *world.hooks.fail_land.lock().unwrap() = true;
    alice.land("# 失败的").await;
    settle(&mut [&mut alice]).await;
    assert!(
        alice.last_ctrl("rejected").unwrap()["reason"]
            .as_str()
            .unwrap()
            .contains("保存失败")
    );
}

#[tokio::test]
async fn the_lander_role_moves_when_the_lander_leaves_and_never_goes_to_a_viewer() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n1", "x");
    let doc = rich_doc("note/n1");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    initialize(&mut alice).await;
    let mut vera = world.join(&doc, &person("vera"), false).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut alice, &mut vera, &mut bob]).await;
    assert_eq!(alice.last_ctrl("lander").unwrap()["you"], true);
    alice.leave().await;
    settle(&mut [&mut vera, &mut bob]).await;
    assert_eq!(
        bob.last_ctrl("lander").unwrap()["you"],
        true,
        "交给下一个可编辑者"
    );
    assert!(vera.last_ctrl("lander").is_none());
    // bob 被降级:没有可编辑者了,没人是落地者
    world.auth.set("bob", kb_collab::Access::Read);
    world.hub.refresh_where(|key| key == "note/n1").await;
    settle(&mut [&mut vera, &mut bob]).await;
    assert_eq!(bob.last_ctrl("lander").unwrap()["you"], false);
    // 查看者发的落地提交没用
    vera.land("查看者").await;
    settle(&mut [&mut vera]).await;
    assert!(vera.last_ctrl("rejected").is_some());
    assert_eq!(world.hooks.body("note/n1"), "x");
}

#[tokio::test]
async fn a_room_reopened_with_unlanded_content_asks_the_new_lander_to_land_at_once() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n1", "原文");
    let doc = rich_doc("note/n1");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    initialize(&mut alice).await;
    settle(&mut [&mut alice]).await;
    alice.add_paragraph("没来得及落地").await;
    settle(&mut [&mut alice]).await;
    // alice 直接掉线,没落地(崩溃 / 断网)
    assert!(
        eventually(1000, || world
            .store
            .peek("note/n1")
            .is_some_and(|d| !d.updates.is_empty() || !d.snapshot.is_empty()))
        .await
    );
    alice.leave().await;
    assert!(eventually(2000, || world.hub_rooms_empty()).await);
    assert_eq!(world.hooks.body("note/n1"), "原文");
    assert!(
        world.hooks.savepoints.lock().unwrap().is_empty(),
        "内容没落地,不能拿旧正文生成保存点"
    );
    // 下一个打开的人:内容还在,并且被要求立刻落地
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut bob]).await;
    assert!(bob.rich_text().contains("没来得及落地"));
    assert_eq!(bob.last_ctrl("hello").unwrap()["ready"], true);
    assert!(bob.last_ctrl("land_now").is_some());
    bob.land("原文\n\n没来得及落地").await;
    settle(&mut [&mut bob]).await;
    assert_eq!(world.hooks.body("note/n1"), "原文\n\n没来得及落地");
}

#[tokio::test]
async fn a_body_rewritten_by_the_api_makes_the_next_open_start_over() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n1", "旧正文");
    let doc = rich_doc("note/n1");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    initialize(&mut alice).await;
    settle(&mut [&mut alice]).await;
    alice.leave().await;
    assert!(eventually(2000, || world.hub_rooms_empty()).await);
    world.hooks.set_body("note/n1", "API 改写后的正文");
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut bob]).await;
    let hello = bob.last_ctrl("hello").unwrap();
    assert_eq!(
        hello["init"], "API 改写后的正文",
        "旧的协作状态作废,按新正文重新初始化"
    );
    assert_eq!(hello["ready"], false);
}

#[tokio::test]
async fn presence_is_stamped_with_the_server_side_identity_and_cannot_be_spoofed() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n1", "x");
    let doc = rich_doc("note/n1");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    settle(&mut [&mut alice, &mut bob]).await;
    let entry = |client: u64, clock: u32, json: &str| {
        let mut clients = HashMap::new();
        clients.insert(
            yrs::block::ClientID::new(client),
            AwarenessUpdateEntry {
                clock,
                json: Arc::from(json),
            },
        );
        Message::Awareness(AwarenessUpdate { clients })
    };
    // alice 自称别人,并带上光标
    alice
        .send_message(&entry(
            123,
            1,
            r##"{"user":{"id":"admin","name":"管理员","color":"#000"},"cursor":{"anchor":3}}"##,
        ))
        .await;
    // alice 还想替别人(456)设置状态,或发超大的状态
    alice
        .send_message(&entry(456, 1, r#"{"cursor":{"anchor":9}}"#))
        .await;
    let huge = format!(r#"{{"junk":"{}"}}"#, "x".repeat(5000));
    alice.send_message(&entry(123, 2, &huge)).await;
    // 非对象的状态
    alice.send_message(&entry(123, 3, "[1,2,3]")).await;
    settle(&mut [&mut alice, &mut bob]).await;
    let seen: Vec<(u64, String)> = bob
        .presence
        .iter()
        .flat_map(|update| {
            update
                .clients
                .iter()
                .map(|(id, e)| (id.get(), e.json.to_string()))
        })
        .collect();
    assert_eq!(seen.len(), 1, "只有 123 被接受一次:{seen:?}");
    let state: serde_json::Value = serde_json::from_str(&seen[0].1).unwrap();
    assert_eq!(state["user"]["id"], "alice", "身份以服务端为准");
    assert_eq!(state["user"]["name"], "alice 的名字");
    assert_ne!(state["user"]["color"], "#000");
    assert_eq!(state["cursor"]["anchor"], 3, "光标原样转发");
    // 后来者一进来就能看到已有的光标
    let mut carol = world.join(&doc, &person("carol"), true).await;
    settle(&mut [&mut carol]).await;
    assert_eq!(
        carol
            .presence
            .iter()
            .map(|u| u.clients.len())
            .sum::<usize>(),
        1
    );
    // alice 走了,别人看到她的光标消失
    alice.leave().await;
    settle(&mut [&mut bob, &mut carol]).await;
    let gone = bob
        .presence
        .last()
        .unwrap()
        .clients
        .values()
        .next()
        .unwrap();
    assert_eq!(gone.json.as_ref(), "null");
}

#[tokio::test]
async fn a_savepoint_can_be_requested_by_writers_only_and_records_who_took_part() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/n1", "x");
    let doc = rich_doc("note/n1");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    let mut vera = world.join(&doc, &person("vera"), false).await;
    initialize(&mut alice).await;
    settle(&mut [&mut alice, &mut vera]).await;
    alice.add_paragraph("改动").await;
    alice.land("x\n\n改动").await;
    settle(&mut [&mut alice, &mut vera]).await;
    vera.send_ctrl(serde_json::json!({ "type": "save_point" }))
        .await;
    settle(&mut [&mut alice, &mut vera]).await;
    assert!(
        world.hooks.savepoints.lock().unwrap().is_empty(),
        "查看者不能保存版本"
    );
    alice
        .send_ctrl(serde_json::json!({ "type": "save_point" }))
        .await;
    settle(&mut [&mut alice, &mut vera]).await;
    let saved = world.hooks.savepoints.lock().unwrap().clone();
    assert_eq!(saved.len(), 1);
    assert_eq!(
        saved[0].1.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
        vec!["alice"]
    );
    assert_eq!(
        vera.last_ctrl("saved").unwrap()["savepoint"],
        true,
        "所有人都收到保存通知"
    );
    // 保存点生成后清零:没有新改动就没有新的保存点
    alice.leave().await;
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_eq!(world.hooks.savepoints.lock().unwrap().len(), 1);
}

/// 富文本房间(笔记、Markdown 文件):AI 的替换落在段落里的文字节点上,沿用原位置的格式,
/// 实时出现在每个人那里;跨段落的原文找不到(不能把两段揉成一段)。
#[tokio::test]
async fn edits_from_outside_change_the_text_inside_a_paragraph_and_keep_its_formatting() {
    let world = World::new(fast_limits());
    world.hooks.set_body("note/ai", "原文");
    let doc = rich_doc("note/ai");
    let mut alice = world.join(&doc, &person("alice"), true).await;
    alice.pump().await;
    alice.add_paragraph("会议纪要:周一开会").await;
    alice.add_paragraph("负责人:张三").await;
    let mut bob = world.join(&doc, &person("bob"), true).await;
    for _ in 0..3 {
        alice.pump().await;
        bob.pump().await;
    }
    let result = world
        .hub
        .apply_edits(
            &doc.key,
            &[("周一".to_owned(), "周二".to_owned())],
            person("ai"),
        )
        .await
        .expect("房间开着");
    assert_eq!(result.unwrap(), 1);
    for _ in 0..3 {
        alice.pump().await;
        bob.pump().await;
    }
    assert!(
        bob.rich_text().contains("会议纪要:周二开会"),
        "{}",
        bob.rich_text()
    );
    assert!(alice.rich_text().contains("负责人:张三"));
    let live = world.hub.read_live(&doc.key).await.expect("房间开着");
    assert!(
        live.lines().any(|line| line == "会议纪要:周二开会"),
        "一段一行:{live}"
    );
    // 带格式的段落:「**重要**事项」里把「重要」换掉,新文字仍是加粗
    {
        use yrs::types::Attrs;
        use yrs::{Any, ReadTxn, Text, Transact, XmlElementPrelim, XmlFragment, XmlTextPrelim};
        let before = alice.doc.transact().state_vector();
        {
            let root = alice.doc.get_or_insert_xml_fragment("prosemirror");
            let mut txn = alice.doc.transact_mut();
            let paragraph = root.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            let text = paragraph.push_back(&mut txn, XmlTextPrelim::new(""));
            let bold: Attrs = [("strong".into(), Any::from(true))].into_iter().collect();
            text.insert_with_attributes(&mut txn, 0, "重要", bold);
            let plain: Attrs = [("strong".into(), Any::Null)].into_iter().collect();
            text.insert_with_attributes(&mut txn, 2, "事项", plain);
        }
        alice.push_since(&before).await;
    }
    for _ in 0..3 {
        alice.pump().await;
        bob.pump().await;
    }
    world
        .hub
        .apply_edits(
            &doc.key,
            &[("重要".to_owned(), "紧急".to_owned())],
            person("ai"),
        )
        .await
        .unwrap()
        .unwrap();
    for _ in 0..3 {
        alice.pump().await;
        bob.pump().await;
    }
    let bob_text = bob.rich_text();
    assert!(
        bob_text.contains("<strong>紧急</strong>事项"),
        "替换后的文字沿用原来的加粗:{bob_text}"
    );
    // 反过来:紧跟在加粗后面的普通文字被换掉,新文字不能继承前一个字的加粗
    world
        .hub
        .apply_edits(
            &doc.key,
            &[("事项".to_owned(), "问题".to_owned())],
            person("ai"),
        )
        .await
        .unwrap()
        .unwrap();
    for _ in 0..3 {
        alice.pump().await;
        bob.pump().await;
    }
    let bob_text = bob.rich_text();
    assert!(
        bob_text.contains("<strong>紧急</strong>问题"),
        "普通文字仍是普通文字:{bob_text}"
    );
    // 跨段落:找不到
    let across = world
        .hub
        .apply_edits(
            &doc.key,
            &[("开会负责人".to_owned(), "x".to_owned())],
            person("ai"),
        )
        .await
        .unwrap();
    assert!(across.unwrap_err().to_string().contains("没找到"));
}
