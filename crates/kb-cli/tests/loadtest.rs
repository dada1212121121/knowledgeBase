//! 压测(多用户设计说明):真实守护进程,一批账号同时检索 / 写笔记 / 协作编辑 / 上传,
//! 统计各类操作的延迟分位数、错误数和守护进程内存增量。
//!
//! 平时跑不动(耗时),所以默认 `#[ignore]`。按下面的规模跑:
//!
//! ```text
//! KB_LOAD_USERS=1000 KB_LOAD_ONLINE=200 KB_LOAD_ROOMS=50 KB_LOAD_ROOM_SIZE=5 KB_LOAD_UPLOADERS=20 \
//! KB_LOAD_SECS=120 cargo test -p kb-cli --features testkit --test loadtest -- --ignored --nocapture
//! ```
//!
//! 默认规模很小(几十个账号、十几秒),用来确认脚本本身能跑通、没有错误。

#![cfg(feature = "testkit")]

mod support;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kb_core::share::ResourceKey;
use serde_json::{Value, json};
use support::collab::{CollabClient, Connect, connect};
use support::{Harness, http};

fn env_num(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

/// 一类操作的统计。
#[derive(Default)]
struct Stat {
    latencies: Mutex<Vec<Duration>>,
    errors: AtomicUsize,
}

impl Stat {
    fn ok(&self, took: Duration) {
        self.latencies.lock().unwrap().push(took);
    }
    fn fail(&self) {
        self.errors.fetch_add(1, Ordering::Relaxed);
    }
    fn percentile(&self, p: f64) -> Duration {
        let mut all = self.latencies.lock().unwrap().clone();
        if all.is_empty() {
            return Duration::ZERO;
        }
        all.sort();
        all[((all.len() as f64 - 1.0) * p).round() as usize]
    }
    fn count(&self) -> usize {
        self.latencies.lock().unwrap().len()
    }
}

/// 进程内存分项(MB):匿名内存(堆)/ 文件映射 / 共享。文件映射算在 RSS 里,但是可回收的页缓存,不是泄漏。
fn rss_parts(pid: u32) -> String {
    let text = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap_or_default();
    let field = |name: &str| -> u64 {
        text.lines()
            .find(|l| l.starts_with(name))
            .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
            .unwrap_or(0)
            / 1024
    };
    format!(
        "匿名 {} MB / 文件映射 {} MB / 共享 {} MB",
        field("RssAnon:"),
        field("RssFile:"),
        field("RssShmem:")
    )
}

fn rss_kb(pid: u32) -> u64 {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|l| l.starts_with("VmRSS:"))
                .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        })
        .unwrap_or(0)
}

/// 带二进制请求体的请求(上传分片用)。
fn raw_http(
    port: u16,
    method: &str,
    path: &str,
    cookie: &str,
    content_type: &str,
    body: &[u8],
) -> (u16, Value) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连接");
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nCookie: kb_session={cookie}\r\nX-KB-CSRF: 1\r\n\
         Content-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).unwrap();
    stream.write_all(body).unwrap();
    let mut raw = Vec::new();
    let _ = stream.read_to_end(&mut raw);
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse().ok())
        .unwrap_or(0);
    let body = text
        .split_once("\r\n\r\n")
        .and_then(|(_, b)| serde_json::from_str(b).ok())
        .unwrap_or(Value::Null);
    (status, body)
}

fn upload_once(port: u16, cookie: &str, name: &str, content: &[u8]) -> bool {
    let sha = kb_core::hash::sha256_hex_bytes(content);
    let create = json!({ "name": name, "rel_path": name, "size": content.len(), "sha256": sha, "collection": "_global" });
    let (status, body) = raw_http(
        port,
        "POST",
        "/api/v1/uploads",
        cookie,
        "application/json",
        create.to_string().as_bytes(),
    );
    if status != 200 {
        return false;
    }
    let (Some(id), Some(chunk)) = (
        body["data"]["upload_id"].as_str(),
        body["data"]["chunk_size"].as_u64(),
    ) else {
        return false;
    };
    for (index, part) in content.chunks(chunk as usize).enumerate() {
        let (status, _) = raw_http(
            port,
            "PUT",
            &format!("/api/v1/uploads/{id}/parts/{index}"),
            cookie,
            "application/octet-stream",
            part,
        );
        if status != 200 {
            return false;
        }
    }
    raw_http(
        port,
        "POST",
        &format!("/api/v1/uploads/{id}/complete"),
        cookie,
        "application/json",
        b"",
    )
    .0 == 200
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

#[test]
#[ignore = "压测:耗时,手动跑;规模由 KB_LOAD_* 环境变量决定"]
fn mixed_workload_keeps_latency_low_and_memory_bounded() {
    let users = env_num("KB_LOAD_USERS", 60);
    let online = env_num("KB_LOAD_ONLINE", 30).min(users);
    let rooms = env_num("KB_LOAD_ROOMS", 6);
    let room_size = env_num("KB_LOAD_ROOM_SIZE", 3).max(2);
    let uploaders = env_num("KB_LOAD_UPLOADERS", 4);
    let secs = env_num("KB_LOAD_SECS", 20) as u64;
    // 每次请求之后额外等多久(毫秒)。默认 0 = 原来的闭环口径(检索约每秒 3 次、写笔记每秒 1 次,比真人重得多);
    // 设成几千才更像真人在用。只加间隔,不改请求本身,所以和 0 的结果可以放在一起对比
    let think = Duration::from_millis(env_num("KB_LOAD_THINK_MS", 0) as u64);
    // 只给协作线程多等的时间(毫秒)。用来做单变量对照:检索保持闭环、只让协作像真人那样稀疏,
    // 看检索的尾部延迟是不是被协作更新的流量挤占的;默认 0,与 KB_LOAD_THINK_MS 相加
    let collab_think = think + Duration::from_millis(env_num("KB_LOAD_COLLAB_THINK_MS", 0) as u64);
    assert!(
        online >= rooms * room_size,
        "在线人数要够给每个房间配人:{online} < {rooms}×{room_size}"
    );

    let h = Arc::new(Harness::start());
    let port = h.port();
    let pid = h.daemon.child.id();

    // 1. 批量建账号(管理员),登录在线的那些
    let started = Instant::now();
    for i in 0..users {
        h.ok(
            "admin",
            "user_create",
            json!({ "username": format!("load{i:04}"), "password": "load password 1", "email": format!("load{i:04}@example.com") }),
        );
    }
    eprintln!("建 {users} 个账号:{:?}", started.elapsed());
    let started = Instant::now();
    let mut sessions: Vec<(String, String)> = Vec::new(); // (用户名, cookie)
    for i in 0..online {
        let name = format!("load{i:04}");
        let cookie = h.login(&name, "load password 1");
        sessions.push((name, cookie));
    }
    eprintln!("登录 {online} 个账号:{:?}", started.elapsed());
    // 用户 id 和个人知识库(协作房间要点名)
    let ids: Vec<(String, String)> = sessions
        .iter()
        .map(|(_, cookie)| {
            let (_, _, me) = http(port, "GET", "/api/v1/auth/me", Some(cookie), None);
            (
                me["data"]["user"]["id"].as_str().unwrap().to_owned(),
                me["data"]["user"]["space_id"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    let _ = &sessions;

    // 2. 每个在线用户先写几条带关键词的笔记,检索才有东西可搜
    let call = |cookie: &str, capability: &str, args: Value| -> (u16, Value) {
        let (status, _, body) = http(
            port,
            "POST",
            &format!("/api/v1/capabilities/{capability}"),
            Some(cookie),
            Some(args),
        );
        (status, body)
    };
    for (name, cookie) in &sessions {
        for n in 0..3 {
            let (status, body) = call(
                cookie,
                "create_item",
                json!({ "collection": "_global", "title": format!("{name} 的压测笔记 {n}"), "body": format!("压测 关键词 {name} {n} 正文内容"), "kind": "note" }),
            );
            assert_eq!(status, 200, "{body}");
        }
    }

    // 3. 协作房间:房间 r 的主人是第 r*room_size 个用户,其余成员获得编辑权
    let mut room_plans: Vec<(String, Vec<usize>)> = Vec::new();
    for r in 0..rooms {
        let owner = r * room_size;
        let (status, created) = call(
            &sessions[owner].1,
            "create_item",
            json!({ "collection": "_global", "title": format!("房间 {r}"), "body": "房间初始内容", "kind": "note" }),
        );
        assert_eq!(status, 200, "{created}");
        let id = created["data"]["id"].as_str().unwrap().to_owned();
        let target = json!({ "kind": "insight", "space_id": ids[owner].1, "collection": "_global", "id": id });
        let mut members = vec![owner];
        for m in 1..room_size {
            let member = owner + m;
            let (status, body) = call(
                &sessions[owner].1,
                "grant_set",
                json!({ "target": target, "user_id": ids[member].0, "role": "editor" }),
            );
            assert_eq!(status, 200, "{body}");
            members.push(member);
        }
        let key = ResourceKey::insight(&ids[owner].1, "_global", &id)
            .unwrap()
            .to_string();
        room_plans.push((key, members));
    }

    // 4. 并发负载
    let stop = Arc::new(AtomicBool::new(false));
    let search = Arc::new(Stat::default());
    let write = Arc::new(Stat::default());
    let upload = Arc::new(Stat::default());
    let collab_rtt = Arc::new(Stat::default());
    let rss_before = rss_kb(pid);
    let mut threads = Vec::new();

    for (index, (_, cookie)) in sessions.iter().enumerate() {
        // 检索
        {
            let (stop, stat, cookie) = (stop.clone(), search.clone(), cookie.clone());
            threads.push(std::thread::spawn(move || {
                while !stop.load(Ordering::Relaxed) {
                    let t = Instant::now();
                    let (status, _, _) = http(
                        port,
                        "POST",
                        "/api/v1/capabilities/search_knowledge",
                        Some(&cookie),
                        Some(json!({ "query": "压测 关键词", "k": 8 })),
                    );
                    if status == 200 {
                        stat.ok(t.elapsed())
                    } else {
                        stat.fail()
                    }
                    std::thread::sleep(
                        Duration::from_millis(250 + (index as u64 % 5) * 50) + think,
                    );
                }
            }));
        }
        // 写笔记(五分之一的人)
        if index % 5 == 0 {
            let (stop, stat, cookie) = (stop.clone(), write.clone(), cookie.clone());
            threads.push(std::thread::spawn(move || {
                let mut n = 0;
                while !stop.load(Ordering::Relaxed) {
                    n += 1;
                    let t = Instant::now();
                    let (status, _, _) = http(port, "POST", "/api/v1/capabilities/create_item", Some(&cookie), Some(json!({ "collection": "_global", "title": format!("压测写入 {index}-{n}"), "body": "压测 关键词 写入内容", "kind": "note" })));
                    if status == 200 { stat.ok(t.elapsed()) } else { stat.fail() }
                    std::thread::sleep(Duration::from_millis(1000) + think);
                }
            }));
        }
    }
    // 上传
    for u in 0..uploaders {
        let (stop, stat) = (stop.clone(), upload.clone());
        let cookie = sessions[online - 1 - u].1.clone();
        threads.push(std::thread::spawn(move || {
            let mut n = 0;
            while !stop.load(Ordering::Relaxed) {
                n += 1;
                let content: Vec<u8> = format!("压测上传 {u}-{n}\n").repeat(8_000).into_bytes();
                let t = Instant::now();
                if upload_once(port, &cookie, &format!("load-{u}-{n}.txt"), &content) {
                    stat.ok(t.elapsed())
                } else {
                    stat.fail()
                }
                std::thread::sleep(think);
            }
        }));
    }
    // 协作:每个成员一个线程,互相测往返
    for (key, members) in &room_plans {
        let sent: Arc<Mutex<Vec<(String, Instant)>>> = Arc::default();
        for (slot, &member) in members.iter().enumerate() {
            let (stop, stat, sent, key) =
                (stop.clone(), collab_rtt.clone(), sent.clone(), key.clone());
            let cookie = format!("kb_session={}", sessions[member].1);
            threads.push(std::thread::spawn(move || {
                let Connect::Open(mut client): Connect = connect(
                    port,
                    &format!("/api/v1/collab/ws?doc={}", enc(&key)),
                    &[("Cookie", &cookie)],
                ) else {
                    stat.fail();
                    return;
                };
                client.settle();
                if client
                    .last_ctrl("hello")
                    .is_some_and(|hello| hello["init"].is_string())
                {
                    client.initialize();
                }
                // 之后读超时调成毫秒级:往返延迟要量到毫秒,不能被读超时量化
                client.set_read_timeout(Duration::from_millis(3));
                let mut seen: std::collections::HashSet<String> = Default::default();
                let mut n = 0;
                let mut next_send = Instant::now();
                let deadline = Instant::now() + Duration::from_secs(secs + 30);
                while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
                    if Instant::now() >= next_send {
                        n += 1;
                        let marker = format!("m{slot}x{n}");
                        sent.lock().unwrap().push((marker.clone(), Instant::now()));
                        client.add_paragraph(&marker);
                        next_send = Instant::now() + Duration::from_millis(250) + collab_think;
                    }
                    client.pump(Duration::from_millis(4), Duration::from_millis(20));
                    observe(&client, &sent, &mut seen, &stat);
                }
                client.pump(Duration::from_millis(100), Duration::from_millis(600));
                observe(&client, &sent, &mut seen, &stat);
                client.close();
            }));
        }
    }

    std::thread::sleep(Duration::from_secs(secs));
    stop.store(true, Ordering::Relaxed);
    for thread in threads {
        let _ = thread.join();
    }
    let rss_after = rss_kb(pid);
    // 负载停了以后让后台队列(嵌入、索引)排空一阵,再量一次:涨上去的内存如果跟着落回来,
    // 是排队积压;一直不落,才是泄漏或碎片
    let drain_started = Instant::now();
    let rss_settled = loop {
        std::thread::sleep(Duration::from_secs(2));
        let (_, _, jobs) = http(
            port,
            "POST",
            "/api/v1/capabilities/job_list",
            Some(h.cookie("admin")),
            Some(json!({})),
        );
        let pending = jobs["data"]["jobs"]
            .as_array()
            .map(|all| {
                all.iter()
                    .filter(|j| matches!(j["state"].as_str(), Some("queued" | "running")))
                    .count()
            })
            .unwrap_or(0);
        if pending == 0
            || drain_started.elapsed()
                > Duration::from_secs(env_num("KB_LOAD_DRAIN_SECS", 20) as u64)
        {
            break rss_kb(pid);
        }
    };

    eprintln!("排空后内存分项:{}", rss_parts(pid));

    // 5. 报告
    let line = |name: &str, stat: &Stat| {
        eprintln!(
            "{name:<10} 成功 {:>6}  失败 {:>4}  P50 {:>7.1}ms  P95 {:>7.1}ms  P99 {:>7.1}ms",
            stat.count(),
            stat.errors.load(Ordering::Relaxed),
            stat.percentile(0.50).as_secs_f64() * 1000.0,
            stat.percentile(0.95).as_secs_f64() * 1000.0,
            stat.percentile(0.99).as_secs_f64() * 1000.0,
        );
    };
    eprintln!(
        "\n== 压测结果:{users} 账号 / {online} 在线 / {rooms} 房间×{room_size} / {uploaders} 上传 / {secs}s / 额外思考时间 {} ms(协作 {} ms) ==",
        think.as_millis(),
        collab_think.as_millis()
    );
    line("检索", &search);
    line("写笔记", &write);
    line("上传", &upload);
    line("协作往返", &collab_rtt);
    eprintln!(
        "守护进程内存:{} MB → {} MB(增量 {} MB),排空后 {} MB",
        rss_before / 1024,
        rss_after / 1024,
        rss_after.saturating_sub(rss_before) / 1024,
        rss_settled / 1024
    );

    // 6. 门槛(设计规范的指标;小规模下同样应该满足)
    let enabled = [
        ("检索", &search, true),
        ("写笔记", &write, true),
        ("上传", &upload, uploaders > 0),
        ("协作往返", &collab_rtt, rooms > 0),
    ];
    for (name, stat, on) in enabled {
        assert_eq!(stat.errors.load(Ordering::Relaxed), 0, "{name} 有失败");
        if on {
            assert!(stat.count() > 0, "{name} 一次都没成功过,压测没有真的跑起来");
        }
    }
    assert!(
        search.percentile(0.95) < Duration::from_millis(800),
        "检索 P95 应 < 800ms"
    );
    assert!(
        collab_rtt.percentile(0.95) < Duration::from_millis(200),
        "协作消息往返 P95 应 < 200ms"
    );
    assert!(
        rss_after.saturating_sub(rss_before) < 8 * 1024 * 1024,
        "内存增量应 < 8GB"
    );
}

/// 把别人发的、我这边已经看到的标记算作一次往返。
fn observe(
    client: &CollabClient,
    sent: &Mutex<Vec<(String, Instant)>>,
    seen: &mut std::collections::HashSet<String>,
    stat: &Stat,
) {
    let text = client.rich_text();
    let now = Instant::now();
    for (marker, at) in sent.lock().unwrap().iter() {
        if !seen.contains(marker) && text.contains(marker.as_str()) {
            seen.insert(marker.clone());
            stat.ok(now.duration_since(*at));
        }
    }
}
