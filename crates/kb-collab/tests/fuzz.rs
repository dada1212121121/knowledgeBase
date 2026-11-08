//! 协作模糊测试(多用户设计说明):多个模拟客户端随机编辑、随机断线(离线继续写),
//! 最终各端与服务端内容必须一致,并且从库里重新打开后也一致。

mod common;

use common::*;
use kb_collab::DocRef;
use yrs::{
    GetString, ReadTxn, Text, Transact, XmlElementPrelim, XmlFragment, XmlOut, XmlTextPrelim,
};

/// 可复现的随机数(xorshift64*)。
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }

    fn word(&mut self) -> String {
        const PIECES: [&str; 10] = [
            "a",
            "bc",
            "你好",
            "世",
            "🙂",
            "x y",
            "\n",
            "é",
            "日本語",
            "-",
        ];
        let n = 1 + self.below(3);
        (0..n)
            .map(|_| PIECES[self.below(PIECES.len() as u64) as usize])
            .collect()
    }
}

/// 比较两段文本;不一致时只报第一处差异的位置和附近的内容,不把整篇文档打出来。
fn assert_same(left: &str, right: &str, what: &str) {
    if left == right {
        return;
    }
    let position = left
        .char_indices()
        .zip(right.char_indices())
        .find(|((_, a), (_, b))| a != b)
        .map(|((i, _), _)| i)
        .unwrap_or_else(|| left.len().min(right.len()));
    let around = |text: &str| {
        let start = text
            .char_indices()
            .map(|(i, _)| i)
            .find(|i| *i + 30 >= position)
            .unwrap_or(0);
        text[start..].chars().take(60).collect::<String>()
    };
    panic!(
        "{what}:长度 {} / {},第一处差异在字节 {position}\n  左:…{:?}\n  右:…{:?}",
        left.len(),
        right.len(),
        around(left),
        around(right)
    );
}

/// 真实编辑器的光标只会落在字符边界上(不会插进代理对中间)。随机位置也要这样选:
/// 返回「第 `chars` 个字符之前」的 UTF-16 偏移。
fn utf16_offset(text: &str, chars: usize) -> u32 {
    text.chars().take(chars).map(|c| c.len_utf16() as u32).sum()
}

/// 统计随机过程里真的发生了什么,避免测试悄悄什么都没测。
#[derive(Default)]
struct Stats {
    reconnects: usize,
    kicks: usize,
    offline_edits: usize,
}

struct Slot {
    client: Client,
    online: bool,
}

/// 被服务端踢掉的连接(队列满、限速……)在浏览器里表现为断线重连:标记离线,稍后带着本地内容重连。
fn note_kicks(slots: &mut [Slot], stats: &mut Stats) {
    for slot in slots.iter_mut() {
        if slot.online && slot.client.closed.is_some() {
            slot.online = false;
            stats.kicks += 1;
        }
    }
}

async fn settle_all(slots: &mut [Slot], stats: &mut Stats) {
    // 一直排空到所有队列都安静(同步消息会引出回复消息,要多轮)
    for _ in 0..40 {
        let mut moved = false;
        for slot in slots.iter_mut() {
            if slot.online {
                let before = slot.client.doc.transact().state_vector();
                slot.client.pump().await;
                let after = slot.client.doc.transact().state_vector();
                moved |= before != after;
            }
        }
        note_kicks(slots, stats);
        if !moved {
            // 再多排两轮,确保回复也送达
            for slot in slots.iter_mut().filter(|s| s.online) {
                slot.client.pump().await;
            }
            note_kicks(slots, stats);
            break;
        }
    }
}

async fn run_text(seed: u64, steps: usize, clients: usize) {
    let mut limits = fast_limits();
    // 这个测试关注的是一致性,不是限速:放开令牌桶
    limits.messages_per_second = 100_000;
    limits.message_burst = 100_000;
    // 发送队列开得很小:不常拉取的客户端会被服务端踢掉,逼出「断线 → 重连 → 补齐」的路径
    limits.send_queue = 6;
    let world = World::new(limits);
    world.hooks.set_body("fuzz/doc", "起点 start");
    let doc: DocRef = text_doc("fuzz/doc");
    let mut rng = Rng(seed);
    let mut stats = Stats::default();
    let mut slots = Vec::new();
    for i in 0..clients {
        let client = world.join(&doc, &person(&format!("user{i}")), true).await;
        slots.push(Slot {
            client,
            online: true,
        });
    }
    settle_all(&mut slots, &mut stats).await;
    for step in 0..steps {
        let i = rng.below(clients as u64) as usize;
        let roll = rng.below(100);
        let slot = &mut slots[i];
        match roll {
            0..=49 => {
                let current = slot.client.text();
                let pos = utf16_offset(
                    &current,
                    rng.below(current.chars().count() as u64 + 1) as usize,
                );
                let word = rng.word();
                if slot.online {
                    slot.client.insert(pos, &word).await;
                } else {
                    slot.client.insert_offline(pos, &word);
                    stats.offline_edits += 1;
                }
            }
            50..=69 => {
                let current = slot.client.text();
                let total = current.chars().count();
                if total > 0 {
                    let start = rng.below(total as u64) as usize;
                    let count = 1 + rng.below(((total - start).min(4)) as u64) as usize;
                    let pos = utf16_offset(&current, start);
                    let n = utf16_offset(&current, start + count) - pos;
                    if slot.online {
                        slot.client.remove(pos, n).await;
                    } else {
                        let root = slot.client.doc.get_or_insert_text("text");
                        let mut txn = slot.client.doc.transact_mut();
                        root.remove_range(&mut txn, pos, n);
                    }
                }
            }
            70..=79 => {
                // 断线 / 重连
                if slot.online {
                    // 不能消费 session 的所有权去 leave 再保留 client:先换成一个新的再丢旧的
                    slot.client.disconnect().await;
                    slot.online = false;
                } else {
                    slot.client.rejoin(&world, &doc, true).await;
                    slot.online = true;
                    stats.reconnects += 1;
                }
            }
            _ => {
                if slot.online {
                    slot.client.pump().await;
                }
            }
        }
        note_kicks(&mut slots, &mut stats);
        if step % 500 == 499 {
            settle_all(&mut slots, &mut stats).await;
        }
    }
    // 全部重连并排空
    for _ in 0..5 {
        for slot in slots.iter_mut() {
            if !slot.online {
                slot.client.rejoin(&world, &doc, true).await;
                slot.online = true;
                stats.reconnects += 1;
            }
        }
        settle_all(&mut slots, &mut stats).await;
        if slots.iter().all(|s| s.online) {
            break;
        }
    }
    assert!(
        stats.reconnects >= steps / 100 && stats.offline_edits > 0 && stats.kicks > 0,
        "种子 {seed}:随机过程里重连 {} 次、离线编辑 {} 次、被服务端踢 {} 次,太少,测试没有覆盖到断线路径",
        stats.reconnects,
        stats.offline_edits,
        stats.kicks
    );
    eprintln!(
        "文本 种子 {seed}:重连 {}、离线编辑 {}、被踢 {}",
        stats.reconnects, stats.offline_edits, stats.kicks
    );
    let expected = slots[0].client.text();
    for (i, slot) in slots.iter().enumerate() {
        assert_same(
            &slot.client.text(),
            &expected,
            &format!("种子 {seed}:客户端 {i} 与客户端 0 不一致"),
        );
    }
    // 一个全新的客户端从服务端同步下来,也是同样的内容
    let mut fresh = world.join(&doc, &person("fresh"), false).await;
    fresh.pump().await;
    fresh.pump().await;
    assert_same(
        &fresh.text(),
        &expected,
        &format!("种子 {seed}:服务端状态与各客户端不一致"),
    );
    // 落地的文本就是最终内容
    assert!(
        eventually(3000, || world.hooks.body("fuzz/doc") == expected).await,
        "种子 {seed}:落地内容不一致"
    );
    // 所有人走了,房间关闭;从库里(快照 + 增量)重新打开后仍然一致
    drop(fresh);
    for slot in slots {
        slot.client.leave().await;
    }
    assert!(eventually(4000, || world.hub_rooms_empty()).await);
    let mut again = world.join(&doc, &person("again"), false).await;
    again.pump().await;
    again.pump().await;
    assert_same(
        &again.text(),
        &expected,
        &format!("种子 {seed}:持久化后重开不一致"),
    );
}

#[tokio::test]
async fn text_rooms_converge_under_random_edits_and_disconnects() {
    for seed in [1u64, 7, 20260428] {
        run_text(seed, 10_000, 5).await;
    }
}

async fn run_rich(seed: u64, steps: usize, clients: usize) {
    let mut limits = fast_limits();
    limits.messages_per_second = 100_000;
    limits.message_burst = 100_000;
    // 发送队列开得很小:不常拉取的客户端会被服务端踢掉,逼出「断线 → 重连 → 补齐」的路径
    limits.send_queue = 6;
    let world = World::new(limits);
    world.hooks.set_body("fuzz/note", "初始");
    let doc: DocRef = rich_doc("fuzz/note");
    let mut rng = Rng(seed);
    let mut stats = Stats::default();
    let mut slots = Vec::new();
    for i in 0..clients {
        let client = world.join(&doc, &person(&format!("user{i}")), true).await;
        slots.push(Slot {
            client,
            online: true,
        });
    }
    // 第一个人初始化
    slots[0].client.pump().await;
    slots[0].client.add_paragraph("初始").await;
    slots[0]
        .client
        .send_ctrl(serde_json::json!({ "type": "init_done" }))
        .await;
    settle_all(&mut slots, &mut stats).await;
    for step in 0..steps {
        let i = rng.below(clients as u64) as usize;
        let roll = rng.below(100);
        let slot = &mut slots[i];
        match roll {
            0..=29 => {
                let word = rng.word();
                if slot.online {
                    slot.client.add_paragraph(&word).await;
                } else {
                    offline_paragraph(&slot.client, &word);
                    stats.offline_edits += 1;
                }
            }
            30..=64 => {
                let word = rng.word();
                edit_random_paragraph(&mut slot.client, &mut rng, &word, slot.online).await;
            }
            65..=74 => remove_random_paragraph(&mut slot.client, &mut rng, slot.online).await,
            75..=84 => {
                if slot.online {
                    slot.client.disconnect().await;
                    slot.online = false;
                } else {
                    slot.client.rejoin(&world, &doc, true).await;
                    slot.online = true;
                    stats.reconnects += 1;
                }
            }
            _ => {
                if slot.online {
                    slot.client.pump().await;
                }
            }
        }
        note_kicks(&mut slots, &mut stats);
        if step % 500 == 499 {
            settle_all(&mut slots, &mut stats).await;
        }
    }
    for _ in 0..5 {
        for slot in slots.iter_mut() {
            if !slot.online {
                slot.client.rejoin(&world, &doc, true).await;
                slot.online = true;
                stats.reconnects += 1;
            }
        }
        settle_all(&mut slots, &mut stats).await;
        if slots.iter().all(|s| s.online) {
            break;
        }
    }
    assert!(
        stats.reconnects >= steps / 100 && stats.offline_edits > 0 && stats.kicks > 0,
        "种子 {seed}:随机过程里重连 {} 次、离线编辑 {} 次、被服务端踢 {} 次,太少,测试没有覆盖到断线路径",
        stats.reconnects,
        stats.offline_edits,
        stats.kicks
    );
    eprintln!(
        "笔记 种子 {seed}:重连 {}、离线编辑 {}、被踢 {}",
        stats.reconnects, stats.offline_edits, stats.kicks
    );
    let expected = slots[0].client.rich_text();
    for (i, slot) in slots.iter().enumerate() {
        assert_same(
            &slot.client.rich_text(),
            &expected,
            &format!("种子 {seed}:客户端 {i} 与客户端 0 不一致"),
        );
    }
    let mut fresh = world.join(&doc, &person("fresh"), false).await;
    fresh.pump().await;
    fresh.pump().await;
    assert_same(
        &fresh.rich_text(),
        &expected,
        &format!("种子 {seed}:服务端状态与各客户端不一致"),
    );
    drop(fresh);
    // 落地者提交最终内容后离开 → 保存点 → 房间关闭 → 从库里重开仍然一致
    let lander = slots
        .iter()
        .position(|s| {
            s.client
                .last_ctrl("lander")
                .is_some_and(|l| l["you"] == true)
        })
        .expect("有落地者");
    slots[lander].client.land("最终内容").await;
    settle_all(&mut slots, &mut stats).await;
    for slot in slots {
        slot.client.leave().await;
    }
    assert!(eventually(4000, || world.hub_rooms_empty()).await);
    let mut again = world.join(&doc, &person("again"), false).await;
    again.pump().await;
    again.pump().await;
    assert_same(
        &again.rich_text(),
        &expected,
        &format!("种子 {seed}:持久化后重开不一致"),
    );
}

fn offline_paragraph(client: &Client, text: &str) {
    let root = client.doc.get_or_insert_xml_fragment("prosemirror");
    let mut txn = client.doc.transact_mut();
    let paragraph = root.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
    paragraph.push_back(&mut txn, XmlTextPrelim::new(text));
}

async fn edit_random_paragraph(client: &mut Client, rng: &mut Rng, word: &str, online: bool) {
    let before = client.doc.transact().state_vector();
    {
        let root = client.doc.get_or_insert_xml_fragment("prosemirror");
        let mut txn = client.doc.transact_mut();
        let count = root.len(&txn);
        if count == 0 {
            return;
        }
        let index = rng.below(u64::from(count)) as u32;
        if let Some(XmlOut::Element(paragraph)) = root.get(&txn, index)
            && let Some(XmlOut::Text(text)) = paragraph.get(&txn, 0)
        {
            let current = text.get_string(&txn);
            let pos = utf16_offset(
                &current,
                rng.below(current.chars().count() as u64 + 1) as usize,
            );
            text.insert(&mut txn, pos, word);
        }
    }
    if online {
        client.push_since(&before).await;
    }
}

async fn remove_random_paragraph(client: &mut Client, rng: &mut Rng, online: bool) {
    let before = client.doc.transact().state_vector();
    {
        let root = client.doc.get_or_insert_xml_fragment("prosemirror");
        let mut txn = client.doc.transact_mut();
        let count = root.len(&txn);
        if count <= 1 {
            return;
        }
        let index = rng.below(u64::from(count)) as u32;
        root.remove_range(&mut txn, index, 1);
    }
    if online {
        client.push_since(&before).await;
    }
}

#[tokio::test]
async fn rich_rooms_converge_under_random_edits_and_disconnects() {
    for seed in [3u64, 11] {
        run_rich(seed, 5_000, 4).await;
    }
}
