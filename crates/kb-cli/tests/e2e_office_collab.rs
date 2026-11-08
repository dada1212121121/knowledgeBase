//! 办公文档多人实时协同的守护进程级验收:真实进程、真实 office-worker、真实 WebSocket、
//! 和浏览器同一个 npm 包的引擎(由 `office-worker/test/e2e-peers.mjs` 扮演三个浏览器)。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_office_collab`(要 Node 22,并在 office-worker 里 `npm ci`)

#![cfg(feature = "testkit")]

mod support;

use std::time::{Duration, Instant};

use kb_core::share::ResourceKey;
use serde_json::{Value, json};
use support::Harness;

const SHEET: &[u8] = include_bytes!("../../../office-worker/test/fixtures/sheet.xlsx");

fn upload(h: &Harness, who: &str, rel_path: &str, bytes: &[u8]) {
    let sha = kb_core::hash::sha256_hex_bytes(bytes);
    let (status, _, created) = support::http(
        h.port(),
        "POST",
        "/api/v1/uploads",
        Some(h.cookie(who)),
        Some(
            json!({ "name": rel_path, "size": bytes.len(), "sha256": sha, "collection": "_global", "rel_path": rel_path }),
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

fn session(h: &Harness, who: &str, doc: &str) -> (u16, Value) {
    let (status, _, body) = support::http(
        h.port(),
        "POST",
        "/api/v1/office/session",
        Some(h.cookie(who)),
        Some(json!({ "doc": doc })),
    );
    (status, body)
}

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

fn worker_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../office-worker")
}

#[test]
fn two_windows_and_a_viewer_edit_one_workbook_live_and_it_lands_as_one_version() {
    let dir = worker_dir();
    if !dir
        .join("node_modules/@betteroffice/xlsx/package.json")
        .is_file()
    {
        panic!("先在 office-worker 里 npm ci(这条测试要真实的引擎)");
    }
    let h = Harness::start();
    let space = h.space("alice");
    upload(&h, "alice", "sheet.xlsx", SHEET);
    let doc = ResourceKey::file(&space, "_global", "sheet.xlsx")
        .unwrap()
        .to_string();

    // 准备:能协同、无损、可写;底稿就是现在的文件
    let (status, body) = session(&h, "alice", &doc);
    assert_eq!(status, 200, "{body}");
    let info = body["data"].clone();
    assert_eq!(info["mode"], "collab", "{info}");
    assert_eq!(info["format"], "xlsx");
    assert_eq!(info["lossless"], true, "{info}");
    assert_eq!(info["writable"], true);
    let sha = info["base_sha"].as_str().unwrap().to_owned();
    assert_eq!(sha, kb_core::hash::sha256_hex_bytes(SHEET));

    // 底稿:按内容寻址、可以永久缓存;别的哈希拿不到
    let (status, headers, bytes) = support::http_raw(
        h.port(),
        "GET",
        &format!("/api/v1/office/base?doc={}&sha={sha}", enc(&doc)),
        &[("Cookie", &format!("kb_session={}", h.cookie("alice")))],
        None,
    );
    assert_eq!(status, 200);
    assert_eq!(bytes, SHEET);
    assert!(
        headers.to_ascii_lowercase().contains("immutable"),
        "{headers}"
    );
    let (status, _, _) = support::http_raw(
        h.port(),
        "GET",
        &format!(
            "/api/v1/office/base?doc={}&sha={}",
            enc(&doc),
            "0".repeat(64)
        ),
        &[("Cookie", &format!("kb_session={}", h.cookie("alice")))],
        None,
    );
    assert_eq!(status, 404);

    // bob 没有授权:和不存在一样;给了查看权限后能进来但只读
    assert_eq!(session(&h, "bob", &doc).0, 404);
    h.ok(
        "alice",
        "grant_set",
        json!({ "target": { "kind": "file", "space_id": space, "collection": "_global", "path": "sheet.xlsx" }, "user_id": h.id("bob"), "role": "viewer" }),
    );
    let (status, body) = session(&h, "bob", &doc);
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["writable"], false);

    // 三个浏览器协同
    let output = std::process::Command::new("node")
        .arg(dir.join("test/e2e-peers.mjs"))
        .current_dir(&dir)
        .env("PORT", h.port().to_string())
        .env("DOC", &doc)
        .env("SHA", &sha)
        .env("ALICE", h.cookie("alice"))
        .env("BOB", h.cookie("bob"))
        .output()
        .expect("跑 node");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.starts_with('{'))
        .unwrap_or_else(|| panic!("没有结果:{stdout}\n{stderr}"));
    let result: Value = serde_json::from_str(line).unwrap();
    assert_eq!(
        result["a2Sees"], true,
        "alice 的第二个窗口实时看到:{result}"
    );
    assert_eq!(result["bobSees"], true, "只读的 bob 也实时看到:{result}");
    assert_eq!(
        result["bobEditReachedAlice"], false,
        "只读连接的修改不传给别人:{result}"
    );
    assert_eq!(result["a1Sees"], true, "{result}");
    assert_eq!(result["landed"], true, "停手后落地写回:{result}");
    assert_eq!(
        result["replaceStatus"], 409,
        "房间开着时整文件替换被拒绝:{result}"
    );
    eprintln!(
        "协同:加入 {} ms,一次修改到达另一个窗口 {} ms",
        result["joinMs"], result["relayMs"]
    );

    // 落地的文件:alice 的两处修改都在,bob 的不在;版本历史里只有「原件 + 这一次协同」两版
    let (status, preview) = h.call(
        "alice",
        "file_preview",
        json!({ "collection": "_global", "path": "sheet.xlsx" }),
    );
    assert_eq!(status, 200);
    let _ = preview;
    let (status, info) = h.call(
        "alice",
        "file_info",
        json!({ "collection": "_global", "path": "sheet.xlsx" }),
    );
    assert_eq!(status, 200);
    assert_eq!(info["sha256"], result["landedSha"]);
    let versions = h.ok(
        "alice",
        "file_versions",
        json!({ "collection": "_global", "path": "sheet.xlsx" }),
    );
    let list = versions["versions"].as_array().unwrap();
    assert_eq!(list.len(), 2, "原件 + 一次协同会话:{versions}");
    assert_eq!(list.last().unwrap()["author"], "baseline");
    assert!(
        list[0]["author"].as_str().unwrap().contains("alice"),
        "{versions}"
    );
}

const DECK: &[u8] = include_bytes!("../../../office-worker/test/fixtures/deck.pptx");
const DOCX: &[u8] = include_bytes!("../../../office-worker/test/fixtures/small.docx");

/// 落地后的文件包里有没有这段文字(解开 zip 看每个部件)。
fn package_contains(bytes: &[u8], needle: &str) -> bool {
    kb_extract::zip::read_all(bytes, kb_extract::zip::ZipLimits::default())
        .expect("是 zip")
        .iter()
        .any(|entry| String::from_utf8_lossy(&entry.data).contains(needle))
}

fn raw_file(h: &Harness, who: &str, path: &str) -> Vec<u8> {
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

fn wait_landed(h: &Harness, path: &str, before: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let info = h.ok(
            "alice",
            "file_info",
            json!({ "collection": "_global", "path": path }),
        );
        if let Some(sha) = info["sha256"].as_str()
            && sha != before
        {
            return sha.to_owned();
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    panic!("{path} 没有落地");
}

fn ai_call(h: &Harness, capability: &str, args: Value) -> (u16, Value) {
    let (status, _, body) = support::http_with(
        h.port(),
        "POST",
        &format!("/api/v1/capabilities/{capability}"),
        Some(h.cookie("alice")),
        Some(args),
        &[("X-KB-Client", "claude")],
    );
    match body.get("data") {
        Some(data) if body["ok"] == true => (status, data.clone()),
        _ => (status, body),
    }
}

/// AI 直接改正在协同的表格(`[office] agent_direct_edit = true`):修改作为服务端的一笔更新出现在
/// 打开着的浏览器副本里,连接不断;随后落地写回文件,版本作者里有 AI。
#[test]
fn the_ai_edits_a_workbook_that_is_open_in_a_browser_and_the_change_lands() {
    let dir = worker_dir();
    if !dir
        .join("node_modules/@betteroffice/xlsx/package.json")
        .is_file()
    {
        panic!("先在 office-worker 里 npm ci(这条测试要真实的引擎)");
    }
    let h = Harness::start_with("[office]\nagent_direct_edit = true\n", |_| {});
    let space = h.space("alice");
    upload(&h, "alice", "ai.xlsx", SHEET);
    let doc = ResourceKey::file(&space, "_global", "ai.xlsx")
        .unwrap()
        .to_string();
    let (status, body) = session(&h, "alice", &doc);
    assert_eq!(status, 200, "{body}");
    let sha = body["data"]["base_sha"].as_str().unwrap().to_owned();

    let output = std::process::Command::new("node")
        .arg(dir.join("test/e2e-ai.mjs"))
        .current_dir(&dir)
        .env("PORT", h.port().to_string())
        .env("DOC", &doc)
        .env("SHA", &sha)
        .env("ALICE", h.cookie("alice"))
        .env("PATH_IN_KB", "ai.xlsx")
        .output()
        .expect("跑 node");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let line = stdout
        .lines()
        .rev()
        .find(|line| line.starts_with('{'))
        .unwrap_or_else(|| panic!("没有结果:{stdout}\n{stderr}"));
    let result: Value = serde_json::from_str(line).unwrap();
    assert_eq!(result["readLive"], true, "{result}");
    assert_eq!(result["readHasCell"], true, "读到每格的值:{result}");
    assert_eq!(result["applied"], true, "{result}");
    assert_eq!(result["browserSees"], true, "浏览器里实时出现:{result}");
    assert!(result["closed"].is_null(), "连接没断:{result}");
    eprintln!(
        "AI 改表格:调用 {} ms,到达浏览器 {} ms",
        result["callMs"], result["relayMs"]
    );

    wait_landed(&h, "ai.xlsx", &sha);
    assert!(package_contains(
        &raw_file(&h, "alice", "ai.xlsx"),
        "PRJ-AI-44"
    ));
    let versions = h.ok(
        "alice",
        "file_versions",
        json!({ "collection": "_global", "path": "ai.xlsx" }),
    );
    assert!(
        versions["versions"][0]["author"]
            .as_str()
            .unwrap()
            .contains("mcp:claude"),
        "{versions}"
    );

    // Word:没人打开时直接改,临时开房间改完落地
    upload(&h, "alice", "small.docx", DOCX);
    let target = json!({ "collection": "_global", "path": "small.docx" });
    let (status, read) = ai_call(&h, "doc_read", target);
    assert_eq!(status, 200, "{read}");
    assert_eq!(
        (read["kind"].as_str(), read["live"].as_bool()),
        (Some("docx"), Some(false)),
        "{read}"
    );
    assert!(
        read["text"].as_str().unwrap().contains("六、维护命令"),
        "{read}"
    );
    let (status, edited) = ai_call(
        &h,
        "doc_edit",
        json!({ "collection": "_global", "path": "small.docx", "edits": [{ "old": "六、维护命令", "new": "六、日常维护命令" }] }),
    );
    assert_eq!(status, 200, "{edited}");
    assert_eq!(edited["applied"], true, "{edited}");
    wait_landed(&h, "small.docx", &kb_core::hash::sha256_hex_bytes(DOCX));
    assert!(package_contains(
        &raw_file(&h, "alice", "small.docx"),
        "日常维护命令"
    ));
}

/// 默认只提建议:没人打开的幻灯片,AI 的建议不改文件;人接受后临时开房间改完落地;
/// 原文不唯一当场报错。
#[test]
fn the_ai_proposes_a_slide_change_and_it_lands_only_after_a_person_accepts_it() {
    let dir = worker_dir();
    if !dir
        .join("node_modules/@betteroffice/pptx/package.json")
        .is_file()
    {
        panic!("先在 office-worker 里 npm ci(这条测试要真实的引擎)");
    }
    let h = Harness::start();
    upload(&h, "alice", "deck.pptx", DECK);
    let target = json!({ "collection": "_global", "path": "deck.pptx" });
    let (status, read) = ai_call(&h, "doc_read", target.clone());
    assert_eq!(status, 200, "{read}");
    assert_eq!(read["kind"], "pptx");
    assert!(
        read["text"]
            .as_str()
            .unwrap()
            .contains("## 第 1 张幻灯片\n产品路线图 Q4"),
        "{read}"
    );

    let (status, body) = ai_call(
        &h,
        "doc_edit",
        json!({ "collection": "_global", "path": "deck.pptx", "edits": [{ "old": "批次", "new": "阶段" }] }),
    );
    assert_eq!(status, 400, "不唯一:{body}");

    let (status, proposed) = ai_call(
        &h,
        "doc_edit",
        json!({ "collection": "_global", "path": "deck.pptx", "edits": [{ "old": "产品路线图 Q4", "new": "产品路线图 2027 Q1" }] }),
    );
    assert_eq!(status, 200, "{proposed}");
    assert_eq!(proposed["applied"], false);
    let original_sha = kb_core::hash::sha256_hex_bytes(DECK);
    assert_eq!(raw_file(&h, "alice", "deck.pptx"), DECK, "建议不改文件");

    let decided = h.ok(
        "alice",
        "doc_proposal_decide",
        json!({ "id": proposed["proposal_id"], "accept": true }),
    );
    assert_eq!(decided["status"], "accepted", "{decided}");
    wait_landed(&h, "deck.pptx", &original_sha);
    assert!(package_contains(
        &raw_file(&h, "alice", "deck.pptx"),
        "产品路线图 2027 Q1"
    ));
}

/// office-worker 进程(是这个守护进程拉起的那个)的 pid。
fn worker_pid_of(daemon_pid: u32) -> Option<u32> {
    std::fs::read_dir("/proc")
        .ok()?
        .flatten()
        .find_map(|entry| {
            let pid: u32 = entry.file_name().to_str()?.parse().ok()?;
            let cmdline = std::fs::read(entry.path().join("cmdline")).ok()?;
            if !String::from_utf8_lossy(&cmdline).contains("office-worker/src/index.mjs") {
                return None;
            }
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            // 第 4 个字段是父进程(进程名在括号里,可能带空格,从右括号之后数)
            let parent: u32 = stat
                .rsplit_once(')')?
                .1
                .split_whitespace()
                .nth(1)?
                .parse()
                .ok()?;
            (parent == daemon_pid).then_some(pid)
        })
}

/// 长会话的增量合并 + 崩溃恢复:合并后的快照和之后的增量都在,office-worker 被杀掉后
/// 下一次访问重新拉起进程、从「底稿 + 合并状态 + 之后的增量」恢复,修改一条不少,随后落地。
#[test]
fn after_a_worker_crash_the_room_is_rebuilt_from_the_compacted_state_and_later_updates() {
    let dir = worker_dir();
    if !dir
        .join("node_modules/@betteroffice/xlsx/package.json")
        .is_file()
    {
        panic!("先在 office-worker 里 npm ci(这条测试要真实的引擎)");
    }
    let h = Harness::start_with_env(
        "[office]\nagent_direct_edit = true\n",
        |_| {},
        &[("KB_OFFICE_COMPACT_EVERY", "3")],
    );
    upload(&h, "alice", "long.xlsx", SHEET);
    for n in 42..=45 {
        let (status, body) = ai_call(
            &h,
            "doc_edit",
            json!({ "collection": "_global", "path": "long.xlsx",
                    "edits": [{ "old": format!("DEMO20260100{n}"), "new": format!("长会话-{n}") }] }),
        );
        assert_eq!(status, 200, "{body}");
    }
    // 增量写库是异步的:等它们(和第 3 条之后的合并)写进去,但不等到落地(停手 2 秒)
    std::thread::sleep(Duration::from_millis(400));
    let pid = worker_pid_of(h.daemon.child.id()).expect("office-worker 在跑");
    std::process::Command::new("kill")
        .args(["-9", &pid.to_string()])
        .status()
        .expect("kill");
    std::thread::sleep(Duration::from_millis(300));
    let (status, read) = ai_call(
        &h,
        "doc_read",
        json!({ "collection": "_global", "path": "long.xlsx" }),
    );
    assert_eq!(status, 200, "{read}");
    let text = read["text"].as_str().unwrap();
    for n in 42..=45 {
        assert!(
            text.contains(&format!("长会话-{n}")),
            "恢复出第 {n} 行的修改:{text}"
        );
    }
    assert_ne!(
        worker_pid_of(h.daemon.child.id()),
        Some(pid),
        "是新拉起的进程"
    );
    wait_landed(&h, "long.xlsx", &kb_core::hash::sha256_hex_bytes(SHEET));
    let landed = raw_file(&h, "alice", "long.xlsx");
    for n in 42..=45 {
        assert!(
            package_contains(&landed, &format!("长会话-{n}")),
            "落地的文件里有第 {n} 行"
        );
    }
}
