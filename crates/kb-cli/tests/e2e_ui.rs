//! 前端和真实守护进程接起来的浏览器冒烟:起一个带账号的守护进程,用 Playwright 驱动真实页面
//! (`web-ui/e2e/real-daemon.mjs`):登录、加好友、分享、公开链接。
//!
//! 需要 node、Playwright 浏览器和已构建的 `web-ui/dist`(调试构建的守护进程从那里现读页面),
//! 所以默认忽略,不进 `scripts/verify.sh`。`KB_UI_ENGINE=webkit` 换引擎。跑法:
//! `cd web-ui && npm run build && cd .. && cargo test -p kb-cli --features testkit --test e2e_ui -- --ignored --nocapture`

#![cfg(feature = "testkit")]

mod support;

use std::process::Command;

use serde_json::json;
use support::Harness;

fn run_browser_smoke(h: &Harness, engine: &str, note_id: &str) {
    let dist =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web-ui/dist/index.html");
    assert!(
        dist.is_file(),
        "先在 web-ui 里 npm run build:{}",
        dist.display()
    );
    let web_ui = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web-ui");
    let output = Command::new("node")
        .arg("e2e/real-daemon.mjs")
        .current_dir(web_ui)
        .env("KB_BASE", format!("http://127.0.0.1:{}", h.port()))
        .env("KB_NOTE_ID", note_id)
        .env("KB_ENGINE", engine)
        .output()
        .expect("运行 node");
    let text = String::from_utf8_lossy(&output.stdout);
    println!("{text}{}", String::from_utf8_lossy(&output.stderr));
    assert!(output.status.success(), "浏览器冒烟有失败项({engine})");
}

#[test]
#[ignore = "需要 node、Playwright 浏览器和 web-ui/dist;手动跑"]
fn the_real_pages_work_against_the_real_daemon() {
    let h = Harness::start();
    // alice 的一篇笔记:分享演示用
    let note = h.ok(
        "alice",
        "create_item",
        json!({ "collection": "_global", "title": "冒烟笔记", "body": "冒烟笔记的正文", "kind": "note" }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // 笔记异步入库:等它出现在列表里,页面才点得到
    for _ in 0..40 {
        let items = h.ok(
            "alice",
            "list_items",
            json!({ "collection": "_global", "page_size": 50 }),
        );
        if items["items"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    let engine = std::env::var("KB_UI_ENGINE").unwrap_or_else(|_| "chromium".to_owned());
    run_browser_smoke(&h, &engine, &note);
}
