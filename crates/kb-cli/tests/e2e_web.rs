//! 守护进程验收:Web 侧能力 + `/api/v1/ws` 推送。
//!
//! 跑法:`cargo test -p kb-cli --features testkit --test e2e_web`
//!
//! 一个守护进程跑完一整条链路:注册项目 → 索引 → `list_items` → `create_item` →
//! `edit_item`(乐观锁 409)→ WS 收到 `item.changed` / `job.done` → `batch_tag` →
//! `revert_batch` → `stats_overview` / `audit_list` / `batch_list` → `update_config`
//! (含 embedder 只给迁移计划)→ 令牌 → `delete_collection`。

#![cfg(feature = "testkit")]

mod support;

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use kb_mcp::uds::{CallOptions, UdsClient};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use support::Daemon;

fn kb() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kb"))
}

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

/// 临时 KB_HOME(Fake 嵌入后端,不下载模型)。
///
/// TCP 用 `127.0.0.1:0`,由内核分配端口。先 bind 再丢掉端口号会和并行测试抢同一个端口,
/// 守护进程在套接字文件出现后因为 `Address already in use` 退出,下一次调用就是 Connection refused。
fn home() -> tempfile::TempDir {
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        // 测试不该依赖宿主机的剩余磁盘:全站保留空间默认 30 GB,小盘或临时目录紧张时会拒绝上传
        "[embed]\nbackend = \"fake\"\n[server]\nlisten = \"127.0.0.1:0\"\n[quota]\ndisk_reserve_gb = 0\n",
    );
    home
}

/// 等队列跑空(索引 / 嵌入任务)。
async fn wait_until_idle(client: &UdsClient) {
    let options = CallOptions::default();
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        let jobs = client
            .call("job_list", json!({}), &options)
            .await
            .expect("列任务");
        let pending = jobs["jobs"]
            .as_array()
            .expect("任务数组")
            .iter()
            .filter(|job| matches!(job["state"].as_str(), Some("queued" | "running")))
            .count();
        if pending == 0 {
            return;
        }
        assert!(Instant::now() < deadline, "任务一直没跑完:{jobs}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// 原始 HTTP POST(要断言状态码的用例用;`UdsClient::call` 只回 `data`)。
async fn post_raw(socket: &Path, capability: &str, body: Value) -> (u16, Value) {
    let mut stream = tokio::net::UnixStream::connect(socket)
        .await
        .expect("连接 UDS");
    let payload = body.to_string();
    let request = format!(
        "POST /api/v1/capabilities/{capability} HTTP/1.1\r\nHost: localhost\r\n\
         Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes()).await.expect("写请求");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).await.expect("读响应");
    let status = raw
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("状态码");
    let body = raw
        .split("\r\n\r\n")
        .nth(1)
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or(Value::Null);
    (status, body)
}

/// 原始 HTTP 请求(可带二进制请求体与自定义头),返回状态码与 JSON。
async fn raw_request(
    socket: &Path,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: &[u8],
) -> (u16, Value) {
    let mut stream = tokio::net::UnixStream::connect(socket)
        .await
        .expect("连接 UDS");
    let mut head = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (name, value) in headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.expect("写请求头");
    if !body.is_empty() {
        stream.write_all(body).await.expect("写请求体");
    }
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("读响应");
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("状态码");
    let body = text
        .split_once("\r\n\r\n")
        .and_then(|(_, body)| serde_json::from_str(body).ok())
        .unwrap_or(Value::Null);
    (status, body)
}

/// 走完一次分片上传(小文件 = 一片)。
async fn upload_bytes(
    socket: &Path,
    collection: &str,
    name: &str,
    rel_path: &str,
    content: &[u8],
) -> Value {
    let sha = kb_core::hash::sha256_hex_bytes(content);
    let create = serde_json::json!({
        "name": name,
        "rel_path": rel_path,
        "size": content.len(),
        "sha256": sha,
        "collection": collection,
    })
    .to_string();
    let (status, body) = raw_request(
        socket,
        "POST",
        "/api/v1/uploads",
        &[("content-type", "application/json")],
        create.as_bytes(),
    )
    .await;
    assert_eq!(status, 200, "新建上传失败:{body}");
    let upload_id = body["data"]["upload_id"]
        .as_str()
        .expect("upload_id")
        .to_owned();
    let chunk_size = body["data"]["chunk_size"].as_u64().expect("chunk_size") as usize;
    for (index, part) in content.chunks(chunk_size).enumerate() {
        let (status, body) = raw_request(
            socket,
            "PUT",
            &format!("/api/v1/uploads/{upload_id}/parts/{index}"),
            &[],
            part,
        )
        .await;
        assert_eq!(status, 200, "写分片失败:{body}");
    }
    let (status, body) = raw_request(
        socket,
        "POST",
        &format!("/api/v1/uploads/{upload_id}/complete"),
        &[],
        b"",
    )
    .await;
    assert_eq!(status, 200, "完成上传失败:{body}");
    body["data"].clone()
}

/// 手写的 WS 客户端(服务端帧不带掩码,只处理文本帧)。
struct WsClient {
    stream: tokio::net::UnixStream,
}

impl WsClient {
    async fn connect(socket: &Path) -> Self {
        let mut stream = tokio::net::UnixStream::connect(socket)
            .await
            .expect("连接 UDS");
        stream
            .write_all(
                b"GET /api/v1/ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n\
                  Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
                  Sec-WebSocket-Version: 13\r\n\r\n",
            )
            .await
            .expect("WS 握手");
        // 读掉响应头
        let mut raw = Vec::new();
        let mut byte = [0u8; 1];
        while !raw.ends_with(b"\r\n\r\n") {
            stream.read_exact(&mut byte).await.expect("读响应头");
            raw.push(byte[0]);
            assert!(raw.len() < 8192, "响应头过长");
        }
        let headers = String::from_utf8_lossy(&raw).into_owned();
        assert!(headers.starts_with("HTTP/1.1 101"), "{headers}");
        Self { stream }
    }

    async fn read_event(&mut self) -> Value {
        let mut head = [0u8; 2];
        self.stream.read_exact(&mut head).await.expect("读帧头");
        let mut length = usize::from(head[1] & 0x7f);
        if length == 126 {
            let mut ext = [0u8; 2];
            self.stream.read_exact(&mut ext).await.expect("读长度");
            length = usize::from(u16::from_be_bytes(ext));
        }
        let mut payload = vec![0u8; length];
        self.stream.read_exact(&mut payload).await.expect("读载荷");
        serde_json::from_slice(&payload).expect("帧里应是 JSON")
    }

    /// 读到第一条满足 `want` 的事件(超时就 panic 并带上已收到的事件)。
    async fn expect_event(&mut self, want: &str, timeout: Duration) -> Value {
        let mut seen = Vec::new();
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now());
            let event = tokio::time::timeout(remaining, self.read_event())
                .await
                .unwrap_or_else(|_| panic!("等 {want} 超时,已收到:{seen:?}"));
            let kind = event["type"].as_str().unwrap_or_default().to_owned();
            if kind == want {
                return event;
            }
            seen.push(kind);
        }
        panic!("等 {want} 超时,已收到:{seen:?}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn web_capabilities_and_ws_push_end_to_end() {
    let home = home();
    // 目录名会变成 collection 的 slug,必须是合法标识符(不能带 `.tmp` 之类的前缀)
    let root = tempfile::tempdir().expect("项目根");
    let project = root.path().join("demo");
    write(
        &project.join("src/auth.rs"),
        "fn login() -> bool {\n    true\n}\n",
    );
    write(
        &project.join("src/db.rs"),
        "fn connect() -> u32 {\n    1\n}\n",
    );
    // :声明式 skills —— 目录里的 loader-rule 启动时加载,`reload_skills` 能重扫
    write(
        &home.path().join("skills/window-rs/manifest.toml"),
        "type = \"loader-rule\"\n[loader-rule]\nglob = \"**/*.proto\"\nlang = \"text\"\ntags = [\"windowed\"]\n",
    );
    let daemon = Daemon::start(home);
    let client = daemon.client();
    let options = CallOptions::default();

    // 0a) tune_retrieval:还没有反馈时只回一句「还没有任何反馈」,不写配置
    let tuning = client
        .call(
            "tune_retrieval",
            json!({ "dry_run": true, "confirm": true }),
            &options,
        )
        .await
        .expect("反馈调权(演练)");
    assert_eq!(tuning["feedback"], 0, "{tuning}");
    assert_eq!(tuning["suggestions"].as_array().expect("数组").len(), 0);

    // 0b) reload_skills:重扫后能拿到刚写的 loader-rule
    let skills = client
        .call("reload_skills", json!({ "confirm": true }), &options)
        .await
        .expect("重扫 skills");
    assert!(
        skills["loader_rules"]
            .as_array()
            .expect("规则数组")
            .iter()
            .any(|rule| rule["name"] == "window-rs"),
        "{skills}"
    );

    // 0) 注册项目(能力层会同时投递全量索引任务)
    let added = client
        .call(
            "add_project",
            json!({ "path": project.to_string_lossy() }),
            &options,
        )
        .await
        .expect("注册项目");
    wait_until_idle(&client).await;

    let collections = client
        .call("list_collections", json!({}), &options)
        .await
        .expect("列 collection");
    let collection = collections["collections"]
        .as_array()
        .expect("collection 数组")
        .iter()
        .find(|item| {
            item["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("proj_"))
        })
        .expect("项目 collection")["name"]
        .as_str()
        .expect("名字")
        .to_owned();
    assert!(added["project"].is_string());

    // 0b) consolidate_project:默认只聚类(此时还没有经验条目 → 空计划),链路要通
    let consolidated = client
        .call(
            "consolidate_project",
            json!({ "project": "demo" }),
            &options,
        )
        .await
        .expect("主题归纳(演练)");
    assert_eq!(consolidated["dry_run"], true, "{consolidated}");
    assert_eq!(consolidated["project"], "demo", "{consolidated}");
    assert_eq!(consolidated["collection"], collection, "{consolidated}");
    assert_eq!(
        consolidated["clusters"].as_array().map(Vec::len),
        Some(0),
        "没有经验条目时不该有主题:{consolidated}"
    );

    // 1) list_items:代码块、无版本、可过滤可排序可分页
    let listed = client
        .call("list_items", json!({ "collection": collection }), &options)
        .await
        .expect("列条目");
    let items = listed["items"].as_array().expect("条目数组");
    assert_eq!(items.len(), 2, "两个文件各一块:{listed}");
    assert!(items.iter().all(|item| item["kind"] == "code"));
    assert!(
        items.iter().all(|item| item["version"].is_null()),
        "代码块没有版本:{listed}"
    );
    assert!(listed["total"].as_u64().unwrap_or_default() >= 2);

    let paged = client
        .call(
            "list_items",
            json!({ "collection": collection, "page": 1, "page_size": 1, "sort": "source", "order": "asc" }),
            &options,
        )
        .await
        .expect("分页");
    assert_eq!(paged["items"].as_array().expect("数组").len(), 1);
    assert_eq!(paged["items"][0]["source"], "src/auth.rs");

    let filtered = client
        .call(
            "list_items",
            json!({ "collection": collection, "q": "db" }),
            &options,
        )
        .await
        .expect("按关键词过滤");
    assert_eq!(
        filtered["items"].as_array().expect("数组").len(),
        1,
        "只有 db.rs 命中:{filtered}"
    );

    // 2) create_item:新建一条经验,嵌入跑完后能在列表里看到版本 1
    let created = client
        .call(
            "create_item",
            json!({
                "collection": collection,
                "title": "会话用 cookie",
                "body": "登录后下发 HttpOnly cookie。",
                "kind": "decision",
                "tags": ["auth"],
            }),
            &options,
        )
        .await
        .expect("新建条目");
    let insight_id = created["id"].as_str().expect("id").to_owned();
    assert_eq!(created["version"], 1);
    wait_until_idle(&client).await;

    let insights = client
        .call(
            "list_items",
            json!({ "collection": collection, "kind": "insight" }),
            &options,
        )
        .await
        .expect("列经验");
    let listed_insight = insights["items"]
        .as_array()
        .expect("数组")
        .iter()
        .find(|item| item["id"] == insight_id.as_str())
        .expect("新建的条目应在列表里");
    assert_eq!(listed_insight["version"], 1);

    // 3) edit_item:版本不符 409,版本对才写入
    let (status, body) = post_raw(
        &daemon.socket,
        "edit_item",
        json!({ "id": insight_id, "version": 99, "body": "错的版本" }),
    )
    .await;
    assert_eq!(status, 409, "版本不符应 409:{body}");
    assert_eq!(body["error"]["code"], "conflict");

    let (status, body) = post_raw(
        &daemon.socket,
        "edit_item",
        json!({ "id": insight_id, "version": 1, "body": "改过的正文" }),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["version"], 2, "版本应加一:{body}");
    assert!(
        body["data"]["job_id"].is_string(),
        "正文变了要重新嵌入:{body}"
    );

    // 4) WS:编辑条目推 item.changed,任务跑完推 job.done
    let mut ws = WsClient::connect(&daemon.socket).await;
    let hello = ws.read_event().await;
    assert_eq!(hello["type"], "hello", "{hello}");

    client
        .call(
            "edit_item",
            json!({ "id": insight_id, "version": 2, "tags": ["auth", "cookie"] }),
            &options,
        )
        .await
        .expect("再改一次标签");
    let changed = ws
        .expect_event("item.changed", Duration::from_secs(10))
        .await;
    assert_eq!(changed["data"]["action"], "edited", "{changed}");
    assert_eq!(changed["data"]["id"], insight_id.as_str());

    client
        .call("reindex_project", json!({ "project": "demo" }), &options)
        .await
        .expect("投递重新索引");
    let done = ws.expect_event("job.done", Duration::from_secs(60)).await;
    assert_eq!(done["data"]["state"], "done", "{done}");

    // 5) batch_tag + revert_batch:一次批量打标签,整批撤销
    let code_ids: Vec<String> = listed["items"]
        .as_array()
        .expect("数组")
        .iter()
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .collect();
    let tagged = client
        .call(
            "batch_tag",
            json!({ "ids": code_ids, "add": ["release-1"] }),
            &options,
        )
        .await
        .expect("批量打标签");
    assert_eq!(tagged["updated"].as_array().expect("数组").len(), 2);

    let by_tag = client
        .call(
            "list_items",
            json!({ "collection": collection, "tag": "release-1" }),
            &options,
        )
        .await
        .expect("按标签过滤");
    assert_eq!(by_tag["items"].as_array().expect("数组").len(), 2);

    let batches = client
        .call("batch_list", json!({ "page_size": 20 }), &options)
        .await
        .expect("列批次");
    let batch_id = batches["batches"]
        .as_array()
        .expect("批次数组")
        .iter()
        .find(|batch| {
            batch["changes"]
                .as_array()
                .is_some_and(|changes| changes.iter().any(|change| change["op"] == "item.tags"))
        })
        .expect("应有打标签的批次")["id"]
        .as_str()
        .expect("批次 id")
        .to_owned();

    let reverted = client
        .call("revert_batch", json!({ "batch_id": batch_id }), &options)
        .await
        .expect("撤销批次");
    assert_eq!(
        reverted["reverted"].as_array().expect("数组").len(),
        2,
        "{reverted}"
    );
    let after_revert = client
        .call(
            "list_items",
            json!({ "collection": collection, "tag": "release-1" }),
            &options,
        )
        .await
        .expect("撤销后按标签过滤");
    assert!(
        after_revert["items"].as_array().expect("数组").is_empty(),
        "标签应被撤销:{after_revert}"
    );

    // 重复撤销报错
    let (status, body) = post_raw(
        &daemon.socket,
        "revert_batch",
        json!({ "batch_id": batch_id }),
    )
    .await;
    assert_eq!(status, 400, "重复撤销应 400:{body}");

    // 6) stats_overview:数字对得上
    let stats = client
        .call("stats_overview", json!({}), &options)
        .await
        .expect("概览");
    assert!(
        !stats["collections"].as_array().expect("数组").is_empty(),
        "{stats}"
    );
    assert!(stats["totals"]["rows"].as_u64().unwrap_or_default() >= 2);
    assert_eq!(stats["embedder"]["state"], "ready", "{stats}");
    assert!(stats["recent_events"].is_array());
    assert!(stats["jobs"].is_object());

    // 7) audit_list:能按能力名过滤,分页字段齐全
    let audit = client
        .call(
            "audit_list",
            json!({ "capability": "edit_item", "page_size": 10 }),
            &options,
        )
        .await
        .expect("审计列表");
    let entries = audit["entries"].as_array().expect("审计数组");
    assert!(!entries.is_empty(), "应有 edit_item 的审计:{audit}");
    assert!(
        entries
            .iter()
            .all(|entry| entry["capability"] == "edit_item")
    );
    assert!(audit["total"].as_u64().unwrap_or_default() >= 1);

    // 8) get_config / update_config
    let config = client
        .call("get_config", json!({}), &options)
        .await
        .expect("读配置");
    assert_eq!(config["embed"]["backend"], "fake", "{config}");
    assert_eq!(config["search"]["k"], 8);

    // 管理级能力必须带 confirm
    let (status, body) = post_raw(
        &daemon.socket,
        "update_config",
        json!({ "patch": { "search": { "k": 9 } } }),
    )
    .await;
    assert_eq!(status, 400, "缺 confirm 应 400:{body}");
    assert_eq!(body["error"]["code"], "invalid_input");

    let updated = client
        .call(
            "update_config",
            json!({ "patch": { "search": { "k": 9 } }, "confirm": true }),
            &options,
        )
        .await
        .expect("改配置");
    assert_eq!(updated["applied"], true, "{updated}");
    // :search.k 是热项,update_config 现在如实返回「立即生效」,不再一律说要重启
    assert_eq!(updated["restart_required"], false, "{updated}");
    assert!(
        updated["hot"]
            .as_array()
            .expect("数组")
            .iter()
            .any(|key| key == "search.k"),
        "热项应列在 hot 里:{updated}"
    );
    assert!(
        updated["changed"]
            .as_array()
            .expect("数组")
            .iter()
            .any(|section| section == "search")
    );
    let config = client
        .call("get_config", json!({}), &options)
        .await
        .expect("再读配置");
    assert_eq!(config["search"]["k"], 9, "配置应已落盘:{config}");

    // 改 embedder:只给迁移计划,不写文件
    let plan = client
        .call(
            "update_config",
            json!({ "patch": { "embed": { "model": "bge-m3" } }, "confirm": true }),
            &options,
        )
        .await
        .expect("改 embedder");
    assert_eq!(plan["applied"], false, "{plan}");
    assert!(plan["migration_plan"]["to"].as_str().is_some());
    assert!(
        plan["migration_plan"]["collections"]
            .as_array()
            .expect("数组")
            .iter()
            .any(|item| item["name"] == collection.as_str()),
        "迁移计划应列出受影响的 collection:{plan}"
    );
    let config = client
        .call("get_config", json!({}), &options)
        .await
        .expect("三读配置");
    assert_eq!(
        config["embed"]["model"], "bge-m3-int8",
        "embedder 的改动不能直接落盘:{config}"
    );

    // 9) 迁移:先估算,再入队;`--to` 与当前嵌入器不一致时拒绝
    let plan = client
        .call(
            "migrate_plan",
            json!({ "collection": collection, "to": "fake:8" }),
            &options,
        )
        .await
        .expect("迁移估算");
    assert_eq!(plan["from_embedder"], "fake:8", "{plan}");
    assert!(
        plan["can_switch_without_reembed"].is_boolean(),
        "估算里要带兼容组判定:{plan}"
    );
    assert!(plan["rows"].as_u64().unwrap_or_default() >= 2, "{plan}");
    assert!(
        plan["insight_rows"].as_u64().unwrap_or_default() >= 1,
        "{plan}"
    );

    // 守护进程用的是 fake:8,迁到 fake:16 会被拒(需要先改配置再重启)
    let (status, body) = post_raw(
        &daemon.socket,
        "migrate_model",
        json!({ "collection": collection, "to": "fake:16" }),
    )
    .await;
    assert_eq!(status, 400, "嵌入器不一致应 400:{body}");
    assert_eq!(body["error"]["code"], "invalid_input");

    // 10) 令牌:创建后撤销
    let token = client
        .call(
            "create_token",
            json!({ "name": "ci", "scope": "api", "confirm": true }),
            &options,
        )
        .await
        .expect("建令牌");
    assert!(
        token["token"]
            .as_str()
            .is_some_and(|value| value.starts_with("kb_")),
        "{token}"
    );
    let revoked = client
        .call(
            "revoke_token",
            json!({ "id": token["id"], "confirm": true }),
            &options,
        )
        .await
        .expect("撤销令牌");
    assert!(revoked["revoked_at"].is_i64(), "{revoked}");

    // 9.5) update_project / eval_history(编辑项目与历次评测)
    let updated = client
        .call(
            "update_project",
            json!({ "project": "demo", "exclude": ["vendor/**"], "allow_cloud_llm": false, "reindex": false }),
            &options,
        )
        .await
        .expect("编辑项目");
    assert_eq!(updated["project"]["exclude"][0], "vendor/**", "{updated}");
    assert!(
        updated["job_id"].is_null(),
        "reindex=false 时不应入队:{updated}"
    );
    // 跑一次评测:结果里要带 run_id / mode / hit@3 / hit@10 / p95_ms(设计稿的历次结果表)。
    // 黄金集写到临时目录再传绝对路径(命令行的黄金集路径相对 cwd,见 的遗留说明)。
    // :先跑一份「一条有效 + 一条期望文件不存在」的黄金集。
    // 那条无效用例必须被预检挑出来,而不是以「未命中」的名义拉低命中率。
    let golden = tempfile::tempdir().expect("黄金集临时目录");
    let mixed_file = golden.path().join("mixed.toml");
    std::fs::write(
        &mixed_file,
        format!(
            "[[case]]\nquery = \"login\"\ncollection = \"{collection}\"\nexpect = [{{ source = \"src/auth.rs\" }}]\n\n\
             [[case]]\nquery = \"demo\"\ncollection = \"{collection}\"\nexpect = [{{ source = \"不存在的文件.md\" }}]\n"
        ),
    )
    .expect("写黄金集");
    let mixed = client
        .call(
            "eval_run",
            json!({ "set": mixed_file.to_string_lossy(), "k": 5 }),
            &options,
        )
        .await
        .expect("跑评测(含一条无效用例)");
    assert_eq!(mixed["status"], "partial", "{mixed}");
    assert_eq!(mixed["pool"], 2, "池子按黄金集总条数算:{mixed}");
    assert_eq!(mixed["valid_cases"], 1, "{mixed}");
    assert_eq!(mixed["set"], "mixed.toml", "要报出用的是哪份黄金集:{mixed}");
    let invalid = mixed["invalid_cases"].as_array().expect("无效用例数组");
    assert_eq!(invalid.len(), 1, "{mixed}");
    assert_eq!(invalid[0]["kind"], "期望的文件不在库里", "{mixed}");
    assert!(
        invalid[0]["detail"]
            .as_str()
            .is_some_and(|detail| detail.contains("不存在的文件.md")),
        "要说清楚是哪个文件对不上:{mixed}"
    );

    // 再把黄金集换成全部有效的:这一跑才是可以拿去比的基线
    let golden_file = golden.path().join("golden.toml");
    std::fs::write(
        &golden_file,
        format!(
            "[[case]]\nquery = \"login\"\ncollection = \"{collection}\"\nexpect = [{{ source = \"src/auth.rs\" }}]\n"
        ),
    )
    .expect("写黄金集");
    let run = client
        .call(
            "eval_run",
            json!({ "set": golden_file.to_string_lossy(), "k": 5, "seed": 7 }),
            &options,
        )
        .await
        .expect("跑评测");
    assert_eq!(run["status"], "ok", "{run}");
    assert!(
        run["run_id"]
            .as_str()
            .is_some_and(|id| id.starts_with("ev_")),
        "{run}"
    );
    assert_eq!(run["seed"], 7, "seed 要原样回传才能复现同一批:{run}");
    assert_eq!(run["valid_cases"], 1, "{run}");
    assert!(
        run["invalid_cases"].as_array().expect("数组").is_empty(),
        "{run}"
    );
    assert!(
        run["set_hash"]
            .as_str()
            .is_some_and(|hash| hash.len() == 32 && hash.chars().all(|ch| ch.is_ascii_hexdigit())),
        "用例集指纹用来判断两跑能不能比:{run}"
    );
    assert!(
        matches!(
            run["mode"].as_str(),
            Some("hybrid" | "hybrid+rerank" | "fts")
        ),
        "{run}"
    );
    assert!(run["hit_at_3"].as_f64().is_some(), "{run}");
    assert!(run["hit_at_10"].as_f64().is_some(), "{run}");
    assert!(
        run["p95_ms"].as_f64().is_some_and(|value| value >= 0.0),
        "{run}"
    );
    // 95% 区间必须包住命中率本身(只有 1 条用例时区间会特别宽,这正是它该说的话)
    let rate = run["hit_at_k"].as_f64().expect("命中率");
    let interval = run["hit_at_k_ci95"].as_array().expect("区间");
    assert!(
        interval[0].as_f64().is_some_and(|low| low <= rate + 1e-9)
            && interval[1].as_f64().is_some_and(|high| high >= rate - 1e-9),
        "{run}"
    );

    let history = client
        .call("eval_history", json!({ "limit": 5 }), &options)
        .await
        .expect("评测历史");
    assert!(history["runs"].is_array(), "{history}");
    let latest = &history["runs"][0];
    assert_eq!(latest["run_id"], run["run_id"], "{latest}");
    assert_eq!(latest["mode"], run["mode"], "{latest}");
    // 设计稿的左卡「按格式拆分」:历史里也要带这一跑的按格式统计(否则下次打开只能退回趋势图)
    assert_eq!(latest["by_format"], run["by_format"], "{latest}");
    // :能不能跟别的一跑比,历史里必须能看出来
    assert_eq!(latest["set_hash"], run["set_hash"], "{latest}");
    assert_eq!(latest["status"], "ok", "{latest}");

    // 9.6) 不传 set:用本知识库的黄金集(`KB_HOME/eval/golden.toml`),不是仓库示例集。
    // Web 评测页就是不传 set 的调用方——它以前落到相对 cwd 的 `eval/golden.example.toml`,
    // 在生产上量的是 7 条演示用例,集合都不存在,页面只会报「全都对不上库」。
    write(
        &daemon.home.path().join("eval/golden.toml"),
        &format!(
            "[[case]]\nquery = \"login\"\ncollection = \"{collection}\"\nexpect = [{{ source = \"src/auth.rs\" }}]\n"
        ),
    );
    let defaulted = client
        .call("eval_run", json!({ "k": 5 }), &options)
        .await
        .expect("不传 set 也能跑");
    assert_eq!(defaulted["status"], "ok", "{defaulted}");
    assert_eq!(
        defaulted["pool"], 1,
        "池子应是 KB_HOME 里那 1 条,不是示例集:{defaulted}"
    );
    assert_eq!(defaulted["valid_cases"], 1, "{defaulted}");
    // 结果里要能看出量的是哪份黄金集(只回文件名,不回服务器路径)
    assert_eq!(defaulted["set"], "golden.toml", "{defaulted}");

    // 10) delete_collection:记录与物理表一起删
    let deleted = client
        .call(
            "delete_collection",
            json!({ "collection": collection }),
            &options,
        )
        .await
        .expect("删 collection");
    assert_eq!(deleted["deleted"], collection.as_str());
    let collections = client
        .call("list_collections", json!({}), &options)
        .await
        .expect("再列 collection");
    assert!(
        !collections["collections"]
            .as_array()
            .expect("数组")
            .iter()
            .any(|item| item["name"] == collection.as_str()),
        "collection 应已删除:{collections}"
    );

    drop(ws);
}

/// 上传链路的端到端验收:真实守护进程 + 真实 HTTP 上传 + 解析 + 检索 + 秒传 + 压缩包 + 撤销。
#[tokio::test(flavor = "multi_thread")]
async fn uploads_are_indexed_searchable_and_revertible() {
    let home = home();
    let root = tempfile::tempdir().expect("项目根");
    let project = root.path().join("demo");
    write(
        &project.join("src/auth.rs"),
        "fn login() -> bool {\n    true\n}\n",
    );
    let daemon = Daemon::start(home);
    let socket = daemon.socket.clone();
    let client = daemon.client();
    let options = CallOptions::default();

    client
        .call(
            "add_project",
            json!({ "path": project.to_string_lossy() }),
            &options,
        )
        .await
        .expect("注册项目");
    wait_until_idle(&client).await;
    let collections = client
        .call("list_collections", json!({}), &options)
        .await
        .expect("列 collection");
    let collection = collections["collections"]
        .as_array()
        .expect("collection 数组")
        .iter()
        .find(|item| {
            item["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("proj_"))
        })
        .and_then(|item| item["name"].as_str())
        .expect("项目 collection")
        .to_owned();

    // 1) 上传一个 Markdown 文件
    let content = "# 上传验收\n\n分片续传与去重都走这条链路。\n".as_bytes();
    let completed =
        upload_bytes(&socket, &collection, "upload.md", "docs/upload.md", content).await;
    let batch = completed["batch_id"].as_str().expect("batch_id").to_owned();
    assert_eq!(
        completed["files"].as_array().expect("files").len(),
        1,
        "{completed}"
    );
    wait_until_idle(&client).await;

    // 1.5) 预览读原件(file_raw):路径校验 + 真实文件
    for bad in ["../secret.md", "/etc/passwd", "docs/../../x.md"] {
        let failed = client
            .call(
                "file_raw",
                json!({ "collection": collection, "path": bad }),
                &options,
            )
            .await;
        assert!(failed.is_err(), "越界路径应被拒绝:{bad}");
    }
    // 不存在的 collection 也不放行(不能靠它去读别的项目的文件)
    let wrong = client
        .call(
            "file_raw",
            json!({ "collection": "no_such_collection", "path": "docs/upload.md" }),
            &options,
        )
        .await;
    assert!(wrong.is_err(), "不存在的 collection 应被拒绝");
    let raw = client
        .call(
            "file_raw",
            json!({ "collection": collection, "path": "docs/upload.md" }),
            &options,
        )
        .await
        .expect("解析原件路径");
    assert_eq!(raw["mime"], "text/plain; charset=utf-8", "{raw}");
    assert!(raw["size"].as_u64().is_some_and(|size| size > 0), "{raw}");
    assert!(
        raw["path"]
            .as_str()
            .is_some_and(|path| path.ends_with("docs/upload.md")),
        "{raw}"
    );

    // 1.6) 预览:抽取器只在成功时报;把原件删掉之后要报 read_error,而不是当成空文件
    //
    let preview = client
        .call(
            "file_preview",
            json!({ "collection": collection, "path": "docs/upload.md" }),
            &options,
        )
        .await
        .expect("预览");
    assert_eq!(preview["read_error"], serde_json::Value::Null, "{preview}");
    assert!(
        preview["extractor"].as_str().is_some(),
        "抽取成功时应报抽取器:{preview}"
    );
    assert!(
        !preview["blocks"].as_array().expect("块数组").is_empty(),
        "{preview}"
    );
    // 原件被删掉之后:`locate_file` 会先按 `is_file` 过滤掉,于是没有块、也不报抽取器。
    // (真正的 `read_error` 分支只在“检查时还在、读的时候没了”这类竞态下才走到,
    //  root 下造不出不可读的文件,所以那条由 `preview_parts` 的单测守。)
    let original = std::path::PathBuf::from(raw["path"].as_str().expect("原件路径"));
    std::fs::remove_file(&original).expect("删掉原件");
    let broken = client
        .call(
            "file_preview",
            json!({ "collection": collection, "path": "docs/upload.md" }),
            &options,
        )
        .await
        .expect("原件缺失时也要能返回预览结构");
    assert_eq!(broken["extractor"], serde_json::Value::Null, "{broken}");
    assert!(
        broken["blocks"].as_array().expect("块数组").is_empty(),
        "{broken}"
    );
    std::fs::write(&original, content).expect("把原件放回去");

    // 2) 解析完成且可检索
    let ingest = client
        .call("list_ingest", json!({ "collection": collection }), &options)
        .await
        .expect("列解析队列");
    let file = ingest["files"]
        .as_array()
        .expect("文件数组")
        .iter()
        .find(|file| file["rel_path"] == "docs/upload.md")
        .cloned()
        .expect("上传的文件应在队列里");
    assert_eq!(file["state"], "done", "{file}");
    assert!(file["chunks"].as_u64().unwrap_or_default() > 0, "{file}");

    let hits = client
        .call(
            "search_knowledge",
            json!({ "query": "分片续传与去重", "scope": "all" }),
            &options,
        )
        .await
        .expect("检索");
    assert!(
        hits["hits"]
            .as_array()
            .expect("命中数组")
            .iter()
            .any(|hit| hit["source"] == "docs/upload.md"),
        "上传的文件应能检索到:{hits}"
    );

    // 3) 相同内容再来一次:秒传(不传字节)
    let create = json!({
        "name": "upload.md",
        "rel_path": "docs/upload.md",
        "size": content.len(),
        "sha256": kb_core::hash::sha256_hex_bytes(content),
        "collection": collection,
    })
    .to_string();
    let (status, body) = raw_request(
        &socket,
        "POST",
        "/api/v1/uploads",
        &[("content-type", "application/json")],
        create.as_bytes(),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(body["data"]["dedup"], "same_content", "{body}");
    let upload_id = body["data"]["upload_id"].as_str().expect("upload_id");
    let (status, body) = raw_request(
        &socket,
        "POST",
        &format!("/api/v1/uploads/{upload_id}/complete"),
        &[],
        b"",
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert_eq!(
        body["data"]["files"].as_array().expect("files").len(),
        0,
        "{body}"
    );
    assert_eq!(
        body["data"]["skipped"][0]["reason"], "same_content",
        "{body}"
    );

    // 4) 压缩包:解包后两个文件都进同一批次
    let zip_path = root.path().join("bundle.zip");
    kb_testkit::zip::write_zip(
        &zip_path,
        &[
            (
                "bundle/one.md",
                kb_testkit::zip::Entry::stored("# 一\n\n内容一\n".as_bytes()),
            ),
            (
                "bundle/two.md",
                kb_testkit::zip::Entry::stored("# 二\n\n内容二\n".as_bytes()),
            ),
        ],
    );
    let zip_bytes = std::fs::read(&zip_path).expect("读 zip");
    let completed =
        upload_bytes(&socket, &collection, "bundle.zip", "bundle.zip", &zip_bytes).await;
    let zip_batch = completed["batch_id"].as_str().expect("batch_id").to_owned();
    wait_until_idle(&client).await;
    let ingest = client
        .call(
            "list_ingest",
            json!({ "collection": collection, "batch_id": zip_batch }),
            &options,
        )
        .await
        .expect("列解析队列");
    let mut paths: Vec<&str> = ingest["files"]
        .as_array()
        .expect("文件数组")
        .iter()
        .filter_map(|file| file["rel_path"].as_str())
        .collect();
    paths.sort_unstable();
    assert_eq!(
        paths,
        vec!["bundle.zip", "bundle/bundle/one.md", "bundle/bundle/two.md"],
        "压缩包与解出来的文件都应在队列里:{ingest}"
    );

    // 5) 撤销批次:文件、块、向量一起清掉
    let reverted = client
        .call("revert_batch", json!({ "batch_id": zip_batch }), &options)
        .await
        .expect("撤销批次");
    assert!(
        reverted["reverted"]
            .as_array()
            .expect("撤销数组")
            .iter()
            .filter(|op| op["op"] == "ingest.file")
            .count()
            >= 2,
        "{reverted}"
    );
    let ingest = client
        .call(
            "list_ingest",
            json!({ "collection": collection, "batch_id": zip_batch }),
            &options,
        )
        .await
        .expect("列解析队列");
    assert_eq!(
        ingest["files"].as_array().expect("文件数组").len(),
        0,
        "撤销后队列里不应再有这些文件:{ingest}"
    );
    let hits = client
        .call(
            "search_knowledge",
            json!({ "query": "内容一", "scope": "all" }),
            &options,
        )
        .await
        .expect("检索");
    assert!(
        !hits["hits"]
            .as_array()
            .expect("命中数组")
            .iter()
            .any(|hit| hit["source"]
                .as_str()
                .is_some_and(|source| source.starts_with("bundle/"))),
        "撤销后不应再检索到解包出来的文件:{hits}"
    );

    // 6) 单文件批次的撤销
    let reverted = client
        .call("revert_batch", json!({ "batch_id": batch }), &options)
        .await
        .expect("撤销上传批次");
    assert!(
        reverted["reverted"]
            .as_array()
            .expect("撤销数组")
            .iter()
            .any(|op| op["op"] == "ingest.file"),
        "{reverted}"
    );
}

/// 端到端:批次进度、阶段时间线、暂停 / 继续 / 取消与 `ingest.stage` 推送。
#[tokio::test(flavor = "multi_thread")]
async fn pipeline_progress_pause_resume_and_cancel_end_to_end() {
    let home = home();
    let root = tempfile::tempdir().expect("项目根");
    let project = root.path().join("demo");
    write(
        &project.join("src/auth.rs"),
        "fn login() -> bool {\n    true\n}\n",
    );
    let daemon = Daemon::start(home);
    let socket = daemon.socket.clone();
    let client = daemon.client();
    let options = CallOptions::default();
    client
        .call(
            "add_project",
            json!({ "path": project.to_string_lossy() }),
            &options,
        )
        .await
        .expect("注册项目");
    wait_until_idle(&client).await;
    let collections = client
        .call("list_collections", json!({}), &options)
        .await
        .expect("列 collection");
    let collection = collections["collections"]
        .as_array()
        .expect("collection 数组")
        .iter()
        .find(|item| {
            item["name"]
                .as_str()
                .is_some_and(|name| name.starts_with("proj_"))
        })
        .and_then(|item| item["name"].as_str())
        .expect("项目 collection")
        .to_owned();

    // 先连上 WS,再上传:这样能收到解析阶段的推送
    let mut ws = WsClient::connect(&socket).await;

    // 一个压缩包 = 3 个文件,批次足够长,便于观察进度
    let zip_path = root.path().join("pipeline.zip");
    kb_testkit::zip::write_zip(
        &zip_path,
        &[
            (
                "a.md",
                kb_testkit::zip::Entry::stored("# 甲\n\n甲内容\n".as_bytes()),
            ),
            (
                "b.md",
                kb_testkit::zip::Entry::stored("# 乙\n\n乙内容\n".as_bytes()),
            ),
            (
                "c.md",
                kb_testkit::zip::Entry::stored("# 丙\n\n丙内容\n".as_bytes()),
            ),
        ],
    );
    let zip_bytes = std::fs::read(&zip_path).expect("读 zip");
    let completed = upload_bytes(
        &socket,
        &collection,
        "pipeline.zip",
        "pipeline.zip",
        &zip_bytes,
    )
    .await;
    let batch = completed["batch_id"].as_str().expect("batch_id").to_owned();

    // 1) WS 收到 ingest.stage(节流后仍有推送)
    let event = ws
        .expect_event("ingest.stage", Duration::from_secs(30))
        .await;
    assert_eq!(event["data"]["batch"], batch.as_str(), "{event}");
    for field in [
        "stage",
        "done",
        "total",
        "chunks",
        "vectors",
        "throughput_cps",
        "elapsed_s",
        "current_files",
        "backend",
        "stages",
    ] {
        assert!(
            event["data"].get(field).is_some(),
            "推送缺字段 {field}:{event}"
        );
    }
    assert_eq!(
        event["data"]["stages"].as_array().expect("阶段数组").len(),
        7
    );

    // 2) 批次进度:七个阶段都在
    let progress = client
        .call("get_batch_progress", json!({ "batch": batch }), &options)
        .await
        .expect("取批次进度");
    assert!(
        progress["total"].as_u64().unwrap_or_default() >= 1,
        "{progress}"
    );
    assert_eq!(progress["stages"].as_array().expect("阶段数组").len(), 7);

    // 3) 暂停 → 状态落库;继续 → 回到 running
    let paused = client
        .call("pause_batch", json!({ "batch": batch }), &options)
        .await
        .expect("暂停批次");
    assert_eq!(paused["state"], "paused", "{paused}");
    let resumed = client
        .call("resume_batch", json!({ "batch": batch }), &options)
        .await
        .expect("继续批次");
    assert_eq!(resumed["state"], "running", "{resumed}");
    wait_until_idle(&client).await;

    // 4) 阶段时间线:解出来的文件至少有 上传 / 识别 / 抽取 / 分块 / 向量化 / 可检索
    let ingest = client
        .call("list_ingest", json!({ "collection": collection }), &options)
        .await
        .expect("列队列");
    let file = ingest["files"]
        .as_array()
        .expect("文件数组")
        .iter()
        .find(|file| file["rel_path"] == "pipeline/a.md")
        .cloned()
        .expect("解出来的 a.md 应在队列里");
    assert_eq!(file["state"], "done", "{file}");
    let timeline = client
        .call("get_file_timeline", json!({ "id": file["id"] }), &options)
        .await
        .expect("取时间线");
    let stages: Vec<&str> = timeline["stages"]
        .as_array()
        .expect("阶段数组")
        .iter()
        .filter_map(|stage| stage["stage"].as_str())
        .collect();
    for stage in ["detect", "extract", "chunk", "embed", "write", "searchable"] {
        assert!(stages.contains(&stage), "时间线缺阶段 {stage}:{stages:?}");
    }
    assert!(timeline["total_ms"].as_u64().is_some(), "{timeline}");

    // 5) 取消:已完成的保留,批次状态记为 canceled
    let another = upload_bytes(
        &socket,
        &collection,
        "cancel.md",
        "cancel.md",
        "# 待取消\n\n内容\n".as_bytes(),
    )
    .await;
    let cancel_batch = another["batch_id"].as_str().expect("batch_id").to_owned();
    let report = client
        .call("cancel_batch", json!({ "batch": cancel_batch }), &options)
        .await
        .expect("取消批次");
    assert!(report["kept"].as_u64().is_some(), "{report}");
    let progress = client
        .call(
            "get_batch_progress",
            json!({ "batch": cancel_batch }),
            &options,
        )
        .await
        .expect("取批次进度");
    assert_eq!(progress["state"], "canceled", "{progress}");

    // 6) 单文件操作:跳过与隔离
    let skipped = client
        .call("skip_file", json!({ "id": file["id"] }), &options)
        .await
        .expect("跳过文件");
    assert_eq!(skipped["file"]["state"], "skipped", "{skipped}");
    let quarantined = client
        .call("quarantine_file", json!({ "id": file["id"] }), &options)
        .await
        .expect("隔离文件");
    assert_eq!(quarantined["file"]["state"], "quarantined", "{quarantined}");

    drop(ws);
}

/// 设置页「备份」分区:真实守护进程上备份一次,归档能被系统 `tar` 解开,删除后列表清空。
///
/// 这条覆盖的是“数据库快照走真实 SQLite”这条链路 —— kb-service 的用例里快照是假的。
#[tokio::test]
async fn backup_end_to_end_on_a_real_daemon() {
    // 自己的 KB_HOME:关掉定时备份(否则调度器第一拍会先建一份),保留策略收紧到 1 份,
    // 这样 `backup_prune` 能真的删掉东西,而不是只断言“可调用”
    let home = tempfile::tempdir().expect("KB_HOME");
    // 异地 / 外部存储:归档要再复制一份到这个目录(与 `kb backup create` 走同一条服务)
    let offsite = tempfile::tempdir().expect("异地目录");
    let mirror_dir = offsite.path().join("kb-backups");
    write(
        &home.path().join("config.toml"),
        &format!(
            "[embed]\nbackend = \"fake\"\n[backup]\nenabled = false\nkeep_count = 1\n\
             mirror_dirs = [\"{}\"]\n[server]\nlisten = \"127.0.0.1:0\"\n",
            mirror_dir.display()
        ),
    );
    let daemon = Daemon::start(home);
    let client = daemon.client();
    let options = CallOptions::default();

    // 1) 空状态下也有说明文案与占用统计
    let status = client
        .call("backup_status", json!({}), &options)
        .await
        .expect("取备份状态");
    assert_eq!(status["entries"].as_array().expect("entries").len(), 0);
    assert!(
        status["usage"]["meta_db_bytes"].as_u64().unwrap_or(0) > 0,
        "{status}"
    );
    assert!(status["notes"].as_array().expect("notes").len() >= 3);
    let dir = status["dir"].as_str().expect("dir").to_owned();

    // 2) 备份一次:文件名 / 大小 / 时间都在,归档目录里真的有文件
    let entry = client
        .call(
            "backup_create",
            json!({ "include_sources": false }),
            &options,
        )
        .await
        .expect("备份");
    let name = entry["name"].as_str().expect("name").to_owned();
    assert!(
        name.starts_with("kb-") && name.ends_with(".tar.gz"),
        "{entry}"
    );
    assert!(entry["size_bytes"].as_u64().expect("size") > 0);
    let archive = std::path::Path::new(&dir).join(&name);
    assert!(archive.is_file(), "归档应落盘:{}", archive.display());
    // 异地副本:配置里的 mirror_dirs 要真的被服务读到,副本大小与本机归档一致
    let mirror_copy = mirror_dir.join(&name);
    assert!(
        mirror_copy.is_file(),
        "异地副本应存在:{}",
        mirror_copy.display()
    );
    assert_eq!(
        std::fs::metadata(&mirror_copy).expect("副本元数据").len(),
        std::fs::metadata(&archive).expect("归档元数据").len()
    );
    let with_mirror = client
        .call("backup_status", json!({}), &options)
        .await
        .expect("取备份状态");
    assert_eq!(
        with_mirror["mirrors"][0]["dir"].as_str(),
        Some(mirror_dir.display().to_string().as_str()),
        "{with_mirror}"
    );
    assert_eq!(
        with_mirror["mirrors"][0]["has_latest"],
        json!(true),
        "{with_mirror}"
    );
    assert_eq!(
        with_mirror["mirrors"][0]["copies"],
        json!(1),
        "{with_mirror}"
    );
    assert_eq!(
        with_mirror["policy"]["mirror_dirs"][0],
        json!(mirror_dir.display().to_string())
    );

    // 3) 用系统 tar 校验:能解开,且含元数据库快照与备份说明
    let list = std::process::Command::new("tar")
        .arg("-tzf")
        .arg(&archive)
        .output()
        .expect("运行 tar");
    assert!(
        list.status.success(),
        "{}",
        String::from_utf8_lossy(&list.stderr)
    );
    let names = String::from_utf8_lossy(&list.stdout);
    assert!(names.lines().any(|line| line == "meta.db"), "{names}");
    assert!(names.lines().any(|line| line == "manifest.json"), "{names}");

    // 4) 列表里能看到它;删掉之后又空了
    let after = client
        .call("backup_status", json!({}), &options)
        .await
        .expect("再取状态");
    assert_eq!(after["entries"].as_array().expect("entries").len(), 1);
    assert_eq!(after["entries"][0]["name"], name);

    let removed = client
        .call("backup_delete", json!({ "name": name }), &options)
        .await
        .expect("删除备份");
    assert_eq!(removed["deleted"], name);
    assert!(!archive.exists(), "归档应被删除");
    assert!(!mirror_copy.exists(), "异地副本应随本机归档一起删掉");
    let final_state = client
        .call("backup_status", json!({}), &options)
        .await
        .expect("最终状态");
    assert_eq!(final_state["entries"].as_array().expect("entries").len(), 0);

    // 5) 非法名字被拒(不允许借备份名做路径穿越)
    let (code, body) = post_raw(
        &daemon.socket,
        "backup_delete",
        json!({ "name": "../evil.tar.gz" }),
    )
    .await;
    assert_eq!(code, 400, "{body}");
    assert_eq!(body["error"]["code"], "invalid_input", "{body}");

    // 6) 保留策略(keep_count = 1):两份归档 → 预演只列最旧的那份、不删;真删只留最新那份。
    // 归档名精确到秒,所以中间隔 1.1 秒再建第二份(否则会撞名)。
    let first = client
        .call(
            "backup_create",
            json!({ "include_sources": false }),
            &options,
        )
        .await
        .expect("第二份备份");
    let first_name = first["name"].as_str().expect("name").to_owned();
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let second = client
        .call(
            "backup_create",
            json!({ "include_sources": false }),
            &options,
        )
        .await
        .expect("第三份备份");
    let second_name = second["name"].as_str().expect("name").to_owned();
    assert_ne!(first_name, second_name, "已隔 1.1 秒,不该撞名");

    let dry = client
        .call("backup_prune", json!({ "dry_run": true }), &options)
        .await
        .expect("预演清理");
    assert_eq!(dry["dry_run"], true, "{dry}");
    assert_eq!(
        dry["removed"],
        json!([first_name]),
        "预演只列最旧那份:{dry}"
    );
    assert!(
        std::path::Path::new(&dir).join(&first_name).is_file(),
        "预演不删文件"
    );

    let pruned = client
        .call("backup_prune", json!({ "dry_run": false }), &options)
        .await
        .expect("清理");
    assert_eq!(pruned["dry_run"], false, "{pruned}");
    assert_eq!(pruned["removed"], json!([first_name]), "{pruned}");
    assert_eq!(pruned["kept"], 1, "{pruned}");
    assert!(!std::path::Path::new(&dir).join(&first_name).exists());
    // 保留策略对异地副本同样生效:清掉的那份副本也不该留
    assert!(!mirror_dir.join(&first_name).exists(), "异地副本也应被清理");
    assert!(
        mirror_dir.join(&second_name).is_file(),
        "保留的那份副本要在"
    );
    let after_prune = client
        .call("backup_status", json!({}), &options)
        .await
        .expect("清理后状态");
    assert_eq!(after_prune["entries"].as_array().expect("entries").len(), 1);
    assert_eq!(after_prune["entries"][0]["name"], second_name);
    assert_eq!(after_prune["policy"]["keep_count"], 1, "{after_prune}");
    assert_eq!(after_prune["policy"]["enabled"], false, "{after_prune}");
    assert_eq!(
        after_prune["next_backup_at"],
        json!(null),
        "关掉定时备份时没有下次时间"
    );

    // 7) 设置页改策略要真的落盘并生效(阻塞项回归:`changed_sections` 曾漏掉 backup 段,
    //    补丁写不进去、回执还说“没有变化”)。这里只改 backup 段,所以回执必须列出它。
    let updated = client
        .call(
            "update_config",
            json!({
                "patch": { "backup": { "enabled": true, "interval_hours": 12, "keep_count": 3 } },
                "confirm": true,
            }),
            &options,
        )
        .await
        .expect("改备份策略");
    assert_eq!(updated["applied"], true, "{updated}");
    assert!(
        updated["changed"]
            .as_array()
            .expect("数组")
            .iter()
            .any(|section| section == "backup"),
        "回执里应列出 backup 段:{updated}"
    );
    assert_eq!(
        updated["restart_required"], false,
        "backup.* 是热更新项:{updated}"
    );
    assert!(
        updated["hot"]
            .as_array()
            .expect("数组")
            .iter()
            .any(|key| key == "backup.keep_count"),
        "热项应列在 hot 里:{updated}"
    );
    let after_update = client
        .call("backup_status", json!({}), &options)
        .await
        .expect("改完再看状态");
    assert_eq!(after_update["policy"]["keep_count"], 3, "{after_update}");
    assert_eq!(
        after_update["policy"]["interval_hours"], 12,
        "{after_update}"
    );
    assert_eq!(after_update["policy"]["enabled"], true, "{after_update}");
    assert!(
        after_update["next_backup_at"].as_i64().is_some(),
        "重新开启后应有下次时间:{after_update}"
    );
}

/// 备份的体验补齐:进度推送、失败告警与归档校验(真实守护进程 + 真实 SQLite 快照)。
///
/// 失败用「同名归档已存在」来造:归档名只精确到秒,预占接下来几秒的名字就能稳定触发,
/// 不依赖权限 / 磁盘这类环境条件(root 下权限拦不住,磁盘也造不出来)。
#[tokio::test(flavor = "multi_thread")]
async fn backup_progress_failure_alert_and_verify_end_to_end() {
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n[backup]\nenabled = false\n[server]\nlisten = \"127.0.0.1:0\"\n",
    );
    // 8 MB 原件:打包要一会儿,进度事件才有东西可看(不是靠 sleep 抢时序)
    let source = home.path().join("sources/e2e/big.bin");
    std::fs::create_dir_all(source.parent().expect("父目录")).expect("建原件目录");
    std::fs::write(&source, vec![7u8; 8 * 1024 * 1024]).expect("写原件");

    let daemon = Daemon::start(home);
    let socket = daemon.socket.clone();
    let client = daemon.client();
    let options = CallOptions::default();

    // 0) 轻量状态:没在打包、也没有告警
    let state = client
        .call("backup_state", json!({}), &options)
        .await
        .expect("轻量备份状态");
    assert!(state["running"].is_null(), "{state}");
    assert!(state["alert"].is_null(), "{state}");
    assert_eq!(state["failures"].as_array().expect("failures").len(), 0);

    // 1) 先连 WS 再备份:能收到进度与完成事件
    let mut ws = WsClient::connect(&socket).await;
    let entry = client
        .call(
            "backup_create",
            json!({ "include_sources": true }),
            &options,
        )
        .await
        .expect("备份");
    let name = entry["name"].as_str().expect("name").to_owned();

    let progress = ws
        .expect_event("backup.progress", Duration::from_secs(30))
        .await;
    assert!(
        progress["data"]["stage"].is_string(),
        "进度事件要带阶段:{progress}"
    );
    assert!(
        progress["data"]["started_at"].as_i64().is_some(),
        "{progress}"
    );
    let done = ws
        .expect_event("backup.done", Duration::from_secs(30))
        .await;
    assert_eq!(done["data"]["archive"], name.as_str(), "{done}");
    assert_eq!(done["data"]["trigger"], "manual", "{done}");
    assert!(
        done["data"]["size_bytes"].as_u64().unwrap_or(0) > 0,
        "{done}"
    );

    // 2) 校验归档:真实 SQLite 快照 + 原件都在
    let check = client
        .call("backup_verify", json!({ "name": name }), &options)
        .await
        .expect("校验归档");
    assert_eq!(check["name"], name.as_str(), "{check}");
    assert!(
        check["meta_db_bytes"].as_u64().unwrap_or(0) > 0,
        "元数据库应有内容:{check}"
    );
    assert!(
        check["files"].as_u64().unwrap_or(0) >= 3,
        "至少 meta.db + config.toml + 原件:{check}"
    );
    assert_eq!(check["config_present"], true, "{check}");
    assert_eq!(check["include_sources"], true, "{check}");
    let roots: Vec<&str> = check["roots"]
        .as_array()
        .expect("roots")
        .iter()
        .filter_map(|root| root.as_str())
        .collect();
    assert!(roots.contains(&"meta.db"), "{roots:?}");
    assert!(roots.contains(&"sources"), "{roots:?}");

    // 3) 造一次确定性的失败:预占接下来几秒的归档名
    let dir = client
        .call("backup_status", json!({}), &options)
        .await
        .expect("备份状态")["dir"]
        .as_str()
        .expect("dir")
        .to_owned();
    let mut collisions = Vec::new();
    for offset in 0..5 {
        let at = kb_core::timezone::now() + chrono::Duration::seconds(offset);
        let path =
            std::path::Path::new(&dir).join(format!("kb-{}.tar.gz", at.format("%Y%m%d-%H%M%S")));
        std::fs::write(&path, b"").expect("预占归档名");
        collisions.push(path);
    }
    let failed = client
        .call(
            "backup_create",
            json!({ "include_sources": false }),
            &options,
        )
        .await;
    let error = failed.expect_err("同名归档应让备份失败");
    assert!(
        error.to_string().contains("同名备份已存在"),
        "错误原因:{error}"
    );
    for path in &collisions {
        std::fs::remove_file(path).expect("删掉预占的归档名");
    }

    // 失败要推事件、落记录,并在轻量状态里报成未解决的告警
    let failed_event = ws
        .expect_event("backup.failed", Duration::from_secs(30))
        .await;
    assert_eq!(failed_event["data"]["trigger"], "manual", "{failed_event}");
    assert!(
        failed_event["data"]["error"]
            .as_str()
            .is_some_and(|text| text.contains("同名备份已存在")),
        "{failed_event}"
    );
    let alerting = client
        .call("backup_state", json!({}), &options)
        .await
        .expect("失败后的轻量状态");
    assert_eq!(alerting["alert"]["trigger"], "manual", "{alerting}");
    assert!(
        alerting["alert"]["error"]
            .as_str()
            .is_some_and(|text| text.contains("同名备份已存在")),
        "{alerting}"
    );
    // 失败原因不带错误码前缀(告警里只说人话)
    assert!(
        !alerting["alert"]["error"]
            .as_str()
            .expect("error")
            .contains("invalid input:"),
        "{alerting}"
    );

    // 4) 再备份一次成功:告警消失,失败历史还在
    client
        .call(
            "backup_create",
            json!({ "include_sources": false }),
            &options,
        )
        .await
        .expect("这次应成功");
    let recovered = client
        .call("backup_state", json!({}), &options)
        .await
        .expect("成功后的轻量状态");
    assert!(recovered["alert"].is_null(), "{recovered}");
    assert_eq!(
        recovered["failures"].as_array().expect("failures").len(),
        1,
        "失败历史仍可查:{recovered}"
    );
    assert!(
        recovered["last_success_at"].as_i64().is_some(),
        "{recovered}"
    );

    // 5) 校验不存在的归档:报错而不是当成通过
    assert!(
        client
            .call(
                "backup_verify",
                json!({ "name": "kb-20200101-000000.tar.gz" }),
                &options
            )
            .await
            .is_err(),
        "不存在的归档不能校验通过"
    );

    drop(ws);
}

/// 定时备份:守护进程自己按 `[backup]` 打包(调度器的第一拍立刻执行)。
#[tokio::test]
async fn scheduler_creates_a_backup_on_its_own() {
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n[backup]\nenabled = true\ninterval_hours = 1\nkeep_count = 2\n[server]\nlisten = \"127.0.0.1:0\"\n",
    );
    let daemon = Daemon::start(home);
    let client = daemon.client();
    let options = CallOptions::default();

    // 等到调度器真的建出一份归档(第一拍是立刻执行的,这里只是留足余量)
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut entries: Vec<Value> = Vec::new();
    while Instant::now() < deadline {
        let status = client
            .call("backup_status", json!({}), &options)
            .await
            .expect("取备份状态");
        entries = status["entries"].as_array().cloned().unwrap_or_default();
        if !entries.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(entries.len(), 1, "定时备份应自动跑一次:{entries:?}");
    let name = entries[0]["name"].as_str().expect("name").to_owned();
    assert!(name.starts_with("kb-"), "{name}");

    // 状态里带策略与下次时间(`[backup]` 已生效)
    let status = client
        .call("backup_status", json!({}), &options)
        .await
        .expect("取备份状态");
    assert_eq!(status["policy"]["enabled"], true, "{status}");
    assert_eq!(status["policy"]["interval_hours"], 1, "{status}");
    assert_eq!(status["policy"]["keep_count"], 2, "{status}");
    assert!(status["next_backup_at"].as_i64().is_some(), "{status}");
}

/// 走 TCP 发一个 JSON 请求(带可选的 Bearer)。
async fn tcp_json(port: u16, path: &str, bearer: Option<&str>, body: &Value) -> (u16, Value) {
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .expect("连接 TCP");
    let body = body.to_string();
    let mut head = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    if let Some(token) = bearer {
        head.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.expect("写请求头");
    stream.write_all(body.as_bytes()).await.expect("写请求体");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("读响应");
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .expect("状态码");
    let body = text
        .split_once("\r\n\r\n")
        .and_then(|(_, body)| serde_json::from_str(body).ok())
        .unwrap_or(Value::Null);
    (status, body)
}

/// (阻塞):会话记录路径只接受本机 UDS 投递。
///
/// `session_end` 带 `session_path` 时守护进程会读那个文件(按项目设置还会外发给
/// LLM)。TCP 上任何身份 —— 包括只该有 8 个 MCP 工具的 `scope=mcp` 令牌 —— 都不许
/// 借这条通道读本机文件;UDS 上仍然放行,但路径本身还要过服务端的白名单校验。
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_path_is_only_accepted_over_the_local_socket() {
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n[server]\nlisten = \"127.0.0.1:0\"\n",
    );
    let project_dir = tempfile::tempdir().expect("项目目录");
    write(&project_dir.path().join("src/lib.rs"), "fn main() {}\n");
    let added = kb()
        .env("KB_HOME", home.path())
        .args(["project", "add", "--name", "hooks"])
        .arg(project_dir.path())
        .output()
        .expect("kb project add");
    assert!(added.status.success(), "登记项目失败");

    // 项目里的一个会话记录 + 一个黑名单文件
    let session = project_dir.path().join("session.jsonl");
    write(
        &session,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
    );
    let secret = project_dir.path().join(".env");
    write(&secret, "TOP-SECRET-CANARY=1\n");

    let daemon = Daemon::start(home);
    let port = daemon.tcp_port();
    let socket = daemon.socket.clone();

    // 签一个 scope=mcp 的令牌(只该有 MCP 工具的能力面)
    let created = kb()
        .env("KB_HOME", daemon.home.path())
        .args(["auth", "token", "create", "probe", "--scope", "mcp"])
        .output()
        .expect("kb auth token create");
    assert!(created.status.success(), "签发令牌失败");
    let stdout = String::from_utf8_lossy(&created.stdout);
    let token = stdout
        .split_whitespace()
        .find(|word| word.starts_with("kb_"))
        .expect("令牌")
        .to_owned();

    let body = |path: &std::path::Path| {
        serde_json::json!({
            "kind": "session_end",
            "project_root": project_dir.path().to_string_lossy(),
            "payload": { "session_path": path.to_string_lossy() },
        })
    };

    // TCP + mcp 令牌:带路径一律 403(不论路径合不合法)
    let (status, response) = tcp_json(port, "/api/v1/events", Some(&token), &body(&session)).await;
    assert_eq!(status, 403, "{response}");
    assert_eq!(response["error"]["code"], "forbidden", "{response}");
    let (status, _) = tcp_json(port, "/api/v1/events", Some(&token), &body(&secret)).await;
    assert_eq!(status, 403, "黑名单文件也不该被读到");

    // 另一个 scope(api)的令牌也一样拿不到这条通道
    let api_token = kb()
        .env("KB_HOME", daemon.home.path())
        .args(["auth", "token", "create", "probe-api", "--scope", "api"])
        .output()
        .expect("kb auth token create");
    assert!(api_token.status.success(), "签发 api 令牌失败");
    let stdout = String::from_utf8_lossy(&api_token.stdout);
    let api_token = stdout
        .split_whitespace()
        .find(|word| word.starts_with("kb_"))
        .expect("api 令牌")
        .to_owned();
    let (status, response) =
        tcp_json(port, "/api/v1/events", Some(&api_token), &body(&session)).await;
    assert_eq!(status, 403, "{response}");

    // 不带路径的 session_end 在 TCP 上照常受理(只是没有提炼输入)
    let (status, response) = tcp_json(
        port,
        "/api/v1/events",
        Some(&token),
        &serde_json::json!({
            "kind": "session_end",
            "project_root": project_dir.path().to_string_lossy(),
        }),
    )
    .await;
    assert_eq!(status, 200, "{response}");

    // UDS:放行,但服务端仍按白名单校验路径
    let (status, response) = raw_request(
        &socket,
        "POST",
        "/api/v1/events",
        &[("content-type", "application/json")],
        body(&secret).to_string().as_bytes(),
    )
    .await;
    assert_eq!(status, 200, "{response}");
    let result = response["data"]["result"].as_str().unwrap_or_default();
    assert!(
        result.contains("禁止读取的路径规则"),
        "UDS 上也该拦住黑名单文件:{response}"
    );
    assert!(
        !result.contains("TOP-SECRET-CANARY"),
        "不该把内容读出来:{response}"
    );
}

/// `save_insight` 是同步写库、异步嵌入:写完立刻 `get_item` 必须能读到。
///
/// 旧实现只读 LanceDB,刚保存的 insight 在嵌入任务跑完之前会 404;`edit_item` 之后
/// 也会读到旧标题。
#[tokio::test]
async fn a_saved_insight_is_readable_before_embedding_finishes() {
    let daemon = Daemon::start(home());
    let client = daemon.client();
    let options = CallOptions::default();

    let saved = client
        .call(
            "save_insight",
            json!({ "title": "立即可读", "body": "刚写入的正文", "global": true }),
            &options,
        )
        .await
        .expect("保存经验");
    let id = saved["id"].as_str().expect("insight id").to_owned();

    // 不等嵌入任务:get_item 应该用 SQLite 里的权威内容回答,并标明还没嵌入
    let item = client
        .call("get_item", json!({ "id": id }), &options)
        .await
        .expect("刚保存就能读到");
    assert_eq!(item["item"]["title"], "立即可读", "{item}");
    assert_eq!(item["item"]["text"], "刚写入的正文", "{item}");
    assert_eq!(item["pending_embedding"], true, "{item}");

    // 嵌入完成后 pending 变 false,内容仍是新的
    wait_until_idle(&client).await;
    let item = client
        .call("get_item", json!({ "id": id }), &options)
        .await
        .expect("嵌入后读取");
    assert_eq!(item["item"]["title"], "立即可读", "{item}");
    assert_eq!(item["pending_embedding"], false, "{item}");
}

/// 项目里被索引的文件也要能读原件(预览页的项目图片 / 音频),不能只认上传队列。
#[tokio::test]
async fn file_raw_reads_project_files_not_only_uploads() {
    let daemon = Daemon::start(home());
    let client = daemon.client();
    let options = CallOptions::default();
    let project_dir = tempfile::tempdir().expect("项目目录");
    write(&project_dir.path().join("docs/logo.png"), "not-a-real-png");
    write(
        &project_dir.path().join("src/lib.rs"),
        "pub fn hello() -> u32 {\n    1\n}\n",
    );

    client
        .call(
            "add_project",
            json!({
                "path": project_dir.path().to_string_lossy(),
                "name": "raw-demo",
            }),
            &options,
        )
        .await
        .expect("注册项目");
    wait_until_idle(&client).await;

    let raw = client
        .call(
            "file_raw",
            json!({ "collection": "proj_raw_demo", "path": "docs/logo.png" }),
            &options,
        )
        .await
        .expect("项目文件也应能读原件");
    assert_eq!(raw["mime"], "image/png", "{raw}");
    assert!(
        raw["path"]
            .as_str()
            .is_some_and(|path| path.ends_with("docs/logo.png")),
        "{raw}"
    );

    // 越界仍然拒绝
    let escaped = client
        .call(
            "file_raw",
            json!({ "collection": "proj_raw_demo", "path": "../secret.md" }),
            &options,
        )
        .await;
    assert!(escaped.is_err(), "路径穿越应被拒绝");
}

/// 删掉集合之后,重新 `add_project` 要能把 collection 补建并重新索引出数据。
#[tokio::test]
async fn adding_the_project_again_heals_a_deleted_collection() {
    let daemon = Daemon::start(home());
    let client = daemon.client();
    let options = CallOptions::default();
    let project_dir = tempfile::tempdir().expect("项目目录");
    write(
        &project_dir.path().join("src/lib.rs"),
        "pub fn heal() -> u32 {\n    42\n}\n",
    );
    let path = project_dir.path().to_string_lossy().into_owned();

    client
        .call(
            "add_project",
            json!({ "path": path, "name": "heal-demo" }),
            &options,
        )
        .await
        .expect("注册项目");
    wait_until_idle(&client).await;
    let rows_before = collection_rows(&client, "proj_heal_demo").await;
    assert!(rows_before > 0, "首次索引应有行");

    // Web 端的「删除集合」
    client
        .call(
            "delete_collection",
            json!({ "collection": "proj_heal_demo" }),
            &options,
        )
        .await
        .expect("删除集合");

    // 同一个项目再注册一次:集合缺失时应该补建,并重新索引
    client
        .call(
            "add_project",
            json!({ "path": path, "name": "heal-demo" }),
            &options,
        )
        .await
        .expect("再次注册项目");
    wait_until_idle(&client).await;
    let rows_after = collection_rows(&client, "proj_heal_demo").await;
    assert!(
        rows_after > 0,
        "重新注册后应补建集合并重新索引,实际 {rows_after} 行"
    );

    // 新增的 remove_project 能力:删项目后列表里不再有它
    client
        .call(
            "remove_project",
            json!({ "project": "heal-demo" }),
            &options,
        )
        .await
        .expect("移除项目");
    let projects = client
        .call("list_projects", json!({}), &options)
        .await
        .expect("列项目");
    assert!(
        !projects["projects"]
            .as_array()
            .expect("项目数组")
            .iter()
            .any(|project| project["project"]["name"] == "heal-demo"),
        "{projects}"
    );
}

/// 取某个 collection 的行数(不存在时返回 0)。
async fn collection_rows(client: &UdsClient, collection: &str) -> u64 {
    let listed = client
        .call("list_collections", json!({}), &CallOptions::default())
        .await
        .expect("列 collection");
    listed["collections"]
        .as_array()
        .expect("collection 数组")
        .iter()
        .find(|item| item["name"] == collection)
        .and_then(|item| item["rows"].as_u64())
        .unwrap_or(0)
}

/// 设置页保存 LLM API key:写 secrets.toml(0600),`llm_providers` 立刻报「已设置」。
#[tokio::test]
async fn llm_key_can_be_saved_and_cleared_from_the_web_surface() {
    let daemon = Daemon::start(home());
    let client = daemon.client();
    let options = CallOptions::default();

    let saved = client
        .call(
            "set_llm_key",
            json!({ "api_key": "sk-e2e-test-key", "confirm": true }),
            &options,
        )
        .await
        .expect("保存密钥");
    assert_eq!(saved["secret_present"], true, "{saved}");

    let file = daemon.home.path().join("secrets.toml");
    let text = std::fs::read_to_string(&file).expect("secrets.toml 应存在");
    assert!(text.contains("sk-e2e-test-key"), "{text}");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file)
            .expect("元数据")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "secrets.toml 必须是 0600");
    }

    let listed = client
        .call("llm_providers", json!({}), &options)
        .await
        .expect("提供商列表");
    assert_eq!(listed["secret_present"], true, "{listed}");

    let cleared = client
        .call(
            "set_llm_key",
            json!({ "api_key": "", "confirm": true }),
            &options,
        )
        .await
        .expect("清除密钥");
    assert_eq!(cleared["secret_present"], false, "{cleared}");
    let text = std::fs::read_to_string(&file).expect("secrets.toml");
    assert!(!text.contains("sk-e2e-test-key"), "{text}");
}

/// 浏览器页的树形导航:`item_facets` 按种类计数,`list_items` 的 `insight_kind`
/// 同时兼容记录种类与 insight 子类型。
#[tokio::test]
async fn item_facets_and_insight_kind_filters_work() {
    let daemon = Daemon::start(home());
    let client = daemon.client();
    let options = CallOptions::default();
    let project_dir = tempfile::tempdir().expect("项目目录");
    write(
        &project_dir.path().join("src/lib.rs"),
        "pub fn facets() -> u32 {\n    7\n}\n",
    );
    write(
        &project_dir.path().join("docs/guide.md"),
        "# 指南\n\n浏览器树形导航。\n",
    );
    write(
        &project_dir.path().join("docs/api/ref.md"),
        "# 接口\n\n多级目录。\n",
    );
    client
        .call(
            "add_project",
            json!({
                "path": project_dir.path().to_string_lossy(),
                "name": "facets-demo",
            }),
            &options,
        )
        .await
        .expect("注册项目");
    wait_until_idle(&client).await;

    let facets = client
        .call(
            "item_facets",
            json!({ "collection": "proj_facets_demo" }),
            &options,
        )
        .await
        .expect("facets");
    let kinds = facets["kinds"].as_array().expect("kinds 数组");
    assert!(
        kinds
            .iter()
            .any(|facet| facet["kind"] == "code" && facet["count"].as_u64().unwrap_or(0) > 0),
        "{facets}"
    );
    // 移动弹窗的下拉要能列出多级目录,不能只给树里的一级目录。
    let dirs = facets["dirs"].as_array().expect("dirs 数组");
    assert!(dirs.iter().any(|dir| dir == "docs"), "{facets}");
    assert!(dirs.iter().any(|dir| dir == "docs/api"), "{facets}");
    assert!(dirs.iter().any(|dir| dir == "src"), "{facets}");
    assert!(
        kinds
            .iter()
            .any(|facet| facet["kind"] == "doc" && facet["count"].as_u64().unwrap_or(0) > 0),
        "{facets}"
    );

    // 记录种类:insight_kind=doc 只回文档
    let docs = client
        .call(
            "list_items",
            json!({ "collection": "proj_facets_demo", "insight_kind": "doc" }),
            &options,
        )
        .await
        .expect("按 doc 过滤");
    assert!(
        docs["items"].as_array().is_some_and(
            |items| !items.is_empty() && items.iter().all(|item| item["kind"] == "doc")
        ),
        "{docs}"
    );

    // insight 子类型:先写一条 note,再按 note 过滤
    let saved = client
        .call(
            "save_insight",
            json!({ "title": "一条 note", "body": "子类型过滤", "project": "facets-demo" }),
            &options,
        )
        .await
        .expect("保存经验");
    let id = saved["id"].as_str().expect("id").to_owned();
    wait_until_idle(&client).await;
    let notes = client
        .call(
            "list_items",
            json!({ "collection": "proj_facets_demo", "insight_kind": "note" }),
            &options,
        )
        .await
        .expect("按 note 过滤");
    assert!(
        notes["items"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == id)),
        "{notes}"
    );
}

/// 没有 API key 时「测试连接」要直接说清楚怎么办,而不是悄悄用 mock 报成功。
#[tokio::test]
async fn test_llm_without_a_key_explains_what_to_do() {
    let daemon = Daemon::start(home());
    let client = daemon.client();
    let error = client
        .call(
            "test_llm",
            json!({ "confirm": true }),
            &CallOptions::default(),
        )
        .await
        .expect_err("没有 key 时应报错");
    let message = error.to_string();
    assert!(message.contains("API key"), "{message}");
}

/// 管家会话列表 / 切换 / 删除(设置页与悬浮窗的「历史会话」用)。
#[tokio::test]
async fn agent_sessions_can_be_listed_and_deleted() {
    let daemon = Daemon::start(home());
    let client = daemon.client();
    let options = CallOptions::default();
    let first = client
        .call("agent_send", json!({ "text": "第一句" }), &options)
        .await
        .expect("发送 1");
    let second = client
        .call("agent_send", json!({ "text": "第二句" }), &options)
        .await
        .expect("发送 2");
    let s1 = first["session_id"].as_str().expect("会话 1").to_owned();
    let s2 = second["session_id"].as_str().expect("会话 2").to_owned();
    assert_ne!(s1, s2);

    let listed = client
        .call("agent_sessions", json!({}), &options)
        .await
        .expect("会话列表");
    let sessions = listed["sessions"].as_array().expect("sessions");
    assert_eq!(sessions.len(), 2, "{listed}");
    assert_eq!(sessions[0]["session_id"], s2, "最近的在前");
    assert_eq!(sessions[0]["title"], "第二句");
    assert_eq!(sessions[0]["messages"], 2);

    // 切换:按 id 读历史
    let history = client
        .call("agent_history", json!({ "session_id": s1 }), &options)
        .await
        .expect("历史");
    assert!(
        history["messages"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["role"] == "user")),
        "{history}"
    );

    let deleted = client
        .call(
            "agent_delete_session",
            json!({ "session_id": s1 }),
            &options,
        )
        .await
        .expect("删除");
    assert_eq!(deleted["deleted"], 2);
    let listed = client
        .call("agent_sessions", json!({}), &options)
        .await
        .expect("会话列表");
    assert_eq!(listed["sessions"].as_array().map(Vec::len), Some(1));
    let error = client
        .call(
            "agent_delete_session",
            json!({ "session_id": s1 }),
            &options,
        )
        .await
        .expect_err("再删应 404");
    assert!(error.to_string().contains("会话"), "{error}");
}

/// ACP 接入:注册一个自定义代理 → 测试连接 → 对话;会话列表标记 backend=acp。
#[tokio::test]
async fn acp_agents_can_be_registered_tested_and_chatted() {
    let daemon = Daemon::start(home());
    let client = daemon.client();
    let options = CallOptions::default();
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../kb-acp/tests/fake_agent.py");
    client
        .call(
            "acp_save_agent",
            json!({
                "id": "fake",
                "name": "假代理",
                "command": "python3",
                "args": ["-u", script],
                "confirm": true,
            }),
            &options,
        )
        .await
        .expect("保存代理");
    let listed = client
        .call("acp_agents", json!({}), &options)
        .await
        .expect("代理列表");
    assert!(
        listed["agents"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == "fake")),
        "{listed}"
    );
    // 助手界面要显示「代理工作目录已用 / 上限」,上限来自这里(默认值见 acp_registry::default_workspace_mb)
    assert!(
        listed["workspace_mb"].as_u64().is_some(),
        "acp_agents 应返回 workspace_mb: {listed}"
    );
    // 这条会话是主知识库账号:服务端不对它拦工作目录超限,所以必须明确返回 false(而不是缺字段),前端才不会误置灰
    assert_eq!(
        listed["workspace_enforced"],
        json!(false),
        "主账号不受工作目录上限约束: {listed}"
    );

    let tested = client
        .call("acp_test", json!({ "id": "fake" }), &options)
        .await
        .expect("测试连接");
    assert_eq!(tested["name"], "fake-acp");

    // 代理会请求一次「写文件」权限:这里模拟界面点「拒绝」
    let socket = daemon.socket.clone();
    let chat_task = tokio::spawn(async move {
        let client = UdsClient::new(socket);
        client
            .call(
                "acp_chat",
                json!({ "agent": "fake", "text": "你好" }),
                &CallOptions::default(),
            )
            .await
    });
    let mut resolved = false;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if let Ok(value) = client
            .call("acp_permission", json!({ "allow": false }), &options)
            .await
            && value["resolved"].as_bool() == Some(true)
        {
            resolved = true;
            break;
        }
    }
    assert!(resolved, "应能答复权限请求");
    let chat = chat_task.await.expect("对话任务").expect("ACP 对话");
    assert_eq!(chat["backend"], "acp");
    assert!(
        chat["text"]
            .as_str()
            .is_some_and(|text| { text.contains("假代理") && text.contains("MCP调用:ok") }),
        "{chat}"
    );
    let session_id = chat["session_id"].as_str().expect("会话 id");

    let sessions = client
        .call("agent_sessions", json!({}), &options)
        .await
        .expect("会话列表");
    assert!(
        sessions["sessions"].as_array().is_some_and(|items| items
            .iter()
            .any(|item| item["session_id"] == session_id && item["backend"] == "acp")),
        "{sessions}"
    );

    let history = client
        .call(
            "agent_history",
            json!({ "session_id": session_id }),
            &options,
        )
        .await
        .expect("历史");
    assert!(history["summary"].is_string(), "{history}");
    assert_eq!(history["backend"], "acp");

    let quoted = format!("请看 @[上一轮](kb://session/{session_id})");
    let socket = daemon.socket.clone();
    let chat_task = tokio::spawn(async move {
        let client = UdsClient::new(socket);
        client
            .call(
                "acp_chat",
                json!({ "agent": "fake", "text": quoted }),
                &CallOptions::default(),
            )
            .await
    });
    let mut quoted_resolved = false;
    for _ in 0..50 {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if let Ok(value) = client
            .call("acp_permission", json!({ "allow": false }), &options)
            .await
            && value["resolved"].as_bool() == Some(true)
        {
            quoted_resolved = true;
            break;
        }
    }
    assert!(quoted_resolved, "引用会话的这一轮也应能答复权限");
    let quoted_chat = chat_task.await.expect("引用对话任务").expect("引用对话");
    assert!(
        quoted_chat["text"].as_str().is_some_and(|text| {
            text.contains("引用历史:ok") && text.contains("越权历史:403")
        }),
        "{quoted_chat}"
    );
}

/// 内置模型的上下文压缩:多轮之后能把较早的对话压成摘要。
#[tokio::test]
async fn agent_context_can_be_compressed() {
    let daemon = Daemon::start(home());
    let client = daemon.client();
    let options = CallOptions::default();
    let first = client
        .call("agent_send", json!({ "text": "第一轮" }), &options)
        .await
        .expect("发送 1");
    let session = first["session_id"].as_str().expect("会话").to_owned();
    for text in ["第二轮", "第三轮"] {
        client
            .call(
                "agent_send",
                json!({ "session_id": session, "text": text }),
                &options,
            )
            .await
            .expect("发送");
    }
    let compressed = client
        .call("agent_compress", json!({ "session_id": session }), &options)
        .await
        .expect("压缩");
    assert_eq!(compressed["compressed"], true, "{compressed}");
    let history = client
        .call("agent_history", json!({ "session_id": session }), &options)
        .await
        .expect("历史");
    assert!(
        history["summary"]
            .as_str()
            .is_some_and(|text| !text.trim().is_empty()),
        "{history}"
    );
}

/// 未授权项目不能经 apply_context 把块正文发给云端模型。
#[tokio::test]
async fn apply_context_refuses_a_project_that_disallows_cloud_llm() {
    let daemon = Daemon::start(home());
    let client = daemon.client();
    let options = CallOptions::default();
    let project_dir = tempfile::tempdir().expect("项目目录");
    write(
        &project_dir.path().join("src/lib.rs"),
        "pub fn gated() -> u32 { 1 }\n",
    );
    client
        .call(
            "add_project",
            json!({
                "path": project_dir.path().to_string_lossy(),
                "name": "gated",
                "allow_cloud_llm": false,
            }),
            &options,
        )
        .await
        .expect("注册项目");
    let error = client
        .call(
            "apply_context",
            json!({
                "collection": "proj_gated",
                "context_mode": "llm",
                "dry_run": false,
            }),
            &options,
        )
        .await
        .expect_err("未授权应拒绝");
    assert!(error.to_string().contains("allow_cloud_llm"), "{error}");
}
