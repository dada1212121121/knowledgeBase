//! AI 经 MCP 读 / 改在线文档的守护进程级验收:真实进程、真实 WebSocket 协作房间、真实权限。
//!
//! AI 的身份:登录用户的 cookie + `X-KB-Client`(和 admin key 调接口的 AI 同一种判断);
//! MCP 工具列表里有 `doc_read` / `doc_edit` 由 `e2e_mcp` 的工具数量锁住。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_doc_agent`

#![cfg(feature = "testkit")]

mod support;

use std::time::{Duration, Instant};

use kb_core::share::ResourceKey;
use serde_json::{Value, json};
use support::Harness;
use support::collab::{CollabClient, Connect, connect};

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

/// 以 AI 的身份(带 `X-KB-Client`)调能力;`space` 不为空时在别人的知识库里调。
fn ai(h: &Harness, who: &str, space: Option<&str>, capability: &str, args: Value) -> (u16, Value) {
    let mut headers = vec![("X-KB-Client", "claude")];
    if let Some(space) = space {
        headers.push(("X-KB-Space", space));
    }
    let (status, _, body) = support::http_with(
        h.port(),
        "POST",
        &format!("/api/v1/capabilities/{capability}"),
        Some(h.cookie(who)),
        Some(args),
        &headers,
    );
    match body.get("data") {
        Some(data) if body["ok"] == true => (status, data.clone()),
        _ => (status, body),
    }
}

fn ai_ok(h: &Harness, who: &str, capability: &str, args: Value) -> Value {
    let (status, body) = ai(h, who, None, capability, args);
    assert_eq!(status, 200, "AI 调 {capability}:{body}");
    body
}

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

fn raw(h: &Harness, who: &str, path: &str) -> Vec<u8> {
    let (status, _, bytes) = support::http_raw(
        h.port(),
        "GET",
        &format!("/api/v1/raw?collection=_global&path={}", enc(path)),
        &[("Cookie", &format!("kb_session={}", h.cookie(who)))],
        None,
    );
    assert_eq!(status, 200);
    bytes
}

fn open_room(h: &Harness, who: &str, key: &str) -> Box<CollabClient> {
    let cookie = format!("kb_session={}", h.cookie(who));
    match connect(
        h.port(),
        &format!("/api/v1/collab/ws?doc={}", enc(key)),
        &[("Cookie", &cookie)],
    ) {
        Connect::Open(client) => client,
        Connect::Refused(status) => panic!("握手被拒:{status}"),
    }
}

fn wait_for(
    client: &mut CollabClient,
    secs: u64,
    mut check: impl FnMut(&CollabClient) -> bool,
) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        client.pump(Duration::from_millis(5), Duration::from_millis(20));
        if check(client) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
    }
}

/// 默认只提建议:文件不变,人在页面上接受才生效;接受时按当时的内容重新定位,定位不到标成失败;
/// AI 不能自己接受;原文不唯一时当场报错;人自己调 doc_edit 直接改。
#[test]
fn by_default_the_ai_only_proposes_and_a_person_accepts_it_into_a_new_version() {
    let h = Harness::start();
    let path = "计划/步骤.txt";
    let original = "第一步:准备\n第二步:执行\n第三步:收尾\n";
    upload_file(&h, "alice", path, original.as_bytes());
    let target = json!({ "collection": "_global", "path": path });

    let read = ai_ok(&h, "alice", "doc_read", target.clone());
    assert_eq!(read["text"], original, "{read}");
    assert_eq!(
        (read["kind"].as_str(), read["live"].as_bool()),
        (Some("text"), Some(false))
    );

    // 原文出现不止一处:当场告诉 AI,什么都不生成
    let (status, body) = ai(
        &h,
        "alice",
        None,
        "doc_edit",
        json!({ "collection": "_global", "path": path, "edits": [{ "old": "步:", "new": "步——" }] }),
    );
    assert_eq!(status, 400, "{body}");
    assert!(body.to_string().contains("3 处"), "{body}");

    let proposed = ai_ok(
        &h,
        "alice",
        "doc_edit",
        json!({ "collection": "_global", "path": path, "reason": "补上复盘",
                "edits": [{ "old": "第二步:执行", "new": "第二步:执行并复盘" }] }),
    );
    assert_eq!(proposed["applied"], false, "{proposed}");
    let id = proposed["proposal_id"].as_str().unwrap().to_owned();
    assert_eq!(raw(&h, "alice", path), original.as_bytes(), "建议不改文件");

    let listed = h.ok("alice", "doc_proposals", target.clone());
    let first = &listed["proposals"][0];
    assert_eq!(
        (first["id"].as_str(), first["status"].as_str()),
        (Some(id.as_str()), Some("pending"))
    );
    assert_eq!(first["author"], "mcp:claude");
    assert_eq!(first["note"], "补上复盘");

    // AI 自己接受:不行
    let (status, body) = ai(
        &h,
        "alice",
        None,
        "doc_proposal_decide",
        json!({ "id": id, "accept": true }),
    );
    assert_eq!(status, 403, "{body}");

    // 人接受:文件改了,版本历史里记的是 AI
    let decided = h.ok(
        "alice",
        "doc_proposal_decide",
        json!({ "id": id, "accept": true }),
    );
    assert_eq!(decided["status"], "accepted", "{decided}");
    assert_eq!(
        raw(&h, "alice", path),
        "第一步:准备\n第二步:执行并复盘\n第三步:收尾\n".as_bytes()
    );
    let versions = h.ok("alice", "file_versions", target.clone());
    assert_eq!(
        versions["versions"][0]["author"], "mcp:claude",
        "{versions}"
    );
    // 再点一次:已经处理过
    assert_eq!(
        h.call(
            "alice",
            "doc_proposal_decide",
            json!({ "id": id, "accept": true })
        )
        .0,
        409
    );

    // 提建议之后原文被人改掉了:接受时定位不到,标成失败,文件不动
    let stale = ai_ok(
        &h,
        "alice",
        "doc_edit",
        json!({ "collection": "_global", "path": path, "edits": [{ "old": "第三步:收尾", "new": "第三步:归档" }] }),
    );
    let stale_id = stale["proposal_id"].as_str().unwrap().to_owned();
    let latest = versions["versions"][0]["version"].as_i64().unwrap();
    h.ok(
        "alice",
        "save_file",
        json!({ "collection": "_global", "path": path, "content": "全部重写了\n", "expected_version": latest }),
    );
    let failed = h.ok(
        "alice",
        "doc_proposal_decide",
        json!({ "id": stale_id, "accept": true }),
    );
    assert_eq!(failed["status"], "failed", "{failed}");
    assert!(
        failed["error"].as_str().unwrap().starts_with("没找到"),
        "给人看的原因,不带英文前缀:{failed}"
    );
    assert_eq!(raw(&h, "alice", path), "全部重写了\n".as_bytes());

    // 人在页面上调 doc_edit:直接改
    let direct = h.ok(
        "alice",
        "doc_edit",
        json!({ "collection": "_global", "path": path, "edits": [{ "old": "重写", "new": "改写" }] }),
    );
    assert_eq!(direct["applied"], true, "{direct}");
    assert_eq!(raw(&h, "alice", path), "全部改写了\n".as_bytes());

    // 一个文档上等着处理的建议有上限(AI 出错反复提交时不撑爆)
    for _ in 0..50 {
        ai_ok(
            &h,
            "alice",
            "doc_edit",
            json!({ "collection": "_global", "path": path, "edits": [{ "old": "改写", "new": "重写" }] }),
        );
    }
    let (status, body) = ai(
        &h,
        "alice",
        None,
        "doc_edit",
        json!({ "collection": "_global", "path": path, "edits": [{ "old": "改写", "new": "重写" }] }),
    );
    assert_eq!(status, 409, "{body}");
}

/// 打开「AI 直接修改」:文档正在多人编辑时,AI 的修改实时出现在编辑器里,不踢人、不覆盖别人刚敲的字,
/// 读到的是房间里的内容;没人编辑的笔记直接改正文。
#[test]
fn with_direct_edit_on_the_ai_edits_live_rooms_without_kicking_anyone() {
    let h = Harness::start_with("[office]\nagent_direct_edit = true\n", |_| {});
    let space = h.space("alice");

    // 纯文本房间
    let path = "代码/main.rs";
    upload_file(
        &h,
        "alice",
        path,
        b"fn main() {\n    println!(\"hi\");\n}\n",
    );
    let key = ResourceKey::file(&space, "_global", path)
        .unwrap()
        .to_string();
    let mut editor = open_room(&h, "alice", &key);
    editor.settle();
    assert!(
        editor.text().contains("println!(\"hi\")"),
        "{}",
        editor.text()
    );
    editor.type_at_end("// 正在敲的字\n");
    editor.settle();

    let read = ai_ok(
        &h,
        "alice",
        "doc_read",
        json!({ "collection": "_global", "path": path }),
    );
    assert_eq!(read["live"], true, "{read}");
    assert!(
        read["text"].as_str().unwrap().contains("// 正在敲的字"),
        "读到的是房间里的内容:{read}"
    );

    // 默认 200 ms 的读超时会把延迟量化掉
    editor.set_read_timeout(Duration::from_millis(2));
    let started = Instant::now();
    let edited = ai_ok(
        &h,
        "alice",
        "doc_edit",
        json!({ "collection": "_global", "path": path, "edits": [{ "old": "println!(\"hi\")", "new": "println!(\"你好\")" }] }),
    );
    let call_ms = started.elapsed().as_millis();
    assert_eq!(
        (edited["applied"].as_bool(), edited["live"].as_bool()),
        (Some(true), Some(true)),
        "{edited}"
    );
    assert!(
        wait_for(&mut editor, 5, |c| c.text().contains("println!(\"你好\")")),
        "编辑器里实时出现:{}",
        editor.text()
    );
    eprintln!(
        "AI 改正在编辑的文本:调用 {call_ms} ms,到达编辑器 ≤ {} ms(测试客户端按 20 ms 一轮读取)",
        started.elapsed().as_millis()
    );
    assert!(editor.text().contains("// 正在敲的字"), "别人刚敲的字还在");
    assert!(editor.closed.is_none(), "没有被踢:{:?}", editor.closed);

    // 富文本房间(笔记)
    let note = h.ok(
        "alice",
        "create_item",
        json!({ "collection": "_global", "title": "周会", "body": "周一下午开会", "kind": "note" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let note_key = ResourceKey::insight(&space, "_global", &note)
        .unwrap()
        .to_string();
    let mut writer = open_room(&h, "alice", &note_key);
    writer.settle();
    writer.initialize();
    writer.settle();
    let read = ai_ok(&h, "alice", "doc_read", json!({ "note_id": note }));
    assert_eq!(
        (read["kind"].as_str(), read["live"].as_bool()),
        (Some("note"), Some(true)),
        "{read}"
    );
    assert_eq!(read["title"], "周会");
    let edited = ai_ok(
        &h,
        "alice",
        "doc_edit",
        json!({ "note_id": note, "edits": [{ "old": "周一", "new": "周二" }] }),
    );
    assert_eq!(edited["live"], true, "{edited}");
    assert!(
        wait_for(&mut writer, 5, |c| c.rich_text().contains("周二下午开会")),
        "{}",
        writer.rich_text()
    );
    assert!(writer.closed.is_none());

    // 没人编辑的笔记:直接改正文,生成新版本
    let quiet = h.ok(
        "alice",
        "create_item",
        json!({ "collection": "_global", "title": "备忘", "body": "买牛奶\n买面包\n", "kind": "note" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let edited = ai_ok(
        &h,
        "alice",
        "doc_edit",
        json!({ "note_id": quiet, "edits": [{ "old": "买面包", "new": "买鸡蛋" }] }),
    );
    assert_eq!(
        (edited["applied"].as_bool(), edited["live"].as_bool()),
        (Some(true), Some(false)),
        "{edited}"
    );
    let item = h.ok("alice", "get_item", json!({ "id": quiet }));
    assert!(
        item["item"]["text"].as_str().unwrap().contains("买鸡蛋"),
        "{item}"
    );
}

/// 别人分享给我的文档:AI 用我的身份读写,需要的角色和我在页面上一样(查看者只能读不能改)。
#[test]
fn on_shared_documents_the_ai_has_exactly_the_callers_role() {
    let h = Harness::start();
    let space = h.space("alice");
    let path = "共享/说明.txt";
    upload_file(&h, "alice", path, "共享的原文\n".as_bytes());
    let target = json!({ "collection": "_global", "path": path });
    // 没有授权:看不到
    assert_eq!(
        ai(&h, "bob", Some(&space), "doc_read", target.clone()).0,
        404
    );
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": { "kind": "file", "space_id": space, "collection": "_global", "path": path }, "user_id": h.id("bob"), "role": "viewer" }),
    );
    let (status, read) = ai(&h, "bob", Some(&space), "doc_read", target.clone());
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["text"], "共享的原文\n");
    let edit = json!({ "collection": "_global", "path": path, "edits": [{ "old": "原文", "new": "新文" }] });
    let (status, body) = ai(&h, "bob", Some(&space), "doc_edit", edit.clone());
    assert_eq!(status, 403, "查看者不能改:{body}");
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": { "kind": "file", "space_id": space, "collection": "_global", "path": path }, "user_id": h.id("bob"), "role": "editor" }),
    );
    let (status, body) = ai(&h, "bob", Some(&space), "doc_edit", edit);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["applied"], false, "默认只提建议:{body}");
    // 建议在 alice 的库里,alice 在页面上看得到
    let listed = h.ok("alice", "doc_proposals", target.clone());
    assert_eq!(listed["proposals"][0]["status"], "pending", "{listed}");
    // bob 是编辑者:在「共享」视图里也看得到、能接受(经 X-KB-Space)
    let (status, theirs) = h.call_in("bob", &space, "doc_proposals", target);
    assert_eq!(status, 200, "{theirs}");
    let id = theirs["proposals"][0]["id"].as_str().unwrap().to_owned();
    let (status, decided) = h.call_in(
        "bob",
        &space,
        "doc_proposal_decide",
        json!({ "id": id, "accept": true }),
    );
    assert_eq!(status, 200, "{decided}");
    assert_eq!(decided["status"], "accepted", "{decided}");
    assert_eq!(raw(&h, "alice", path), "共享的新文\n".as_bytes());
    // 不相干的 carol 拿着建议 id 也处理不了(和不存在一样)
    let (status, _) = h.call_in(
        "carol",
        &space,
        "doc_proposal_decide",
        json!({ "id": id, "accept": false }),
    );
    assert_eq!(status, 404);
}
