//! 守护进程生命周期与作用域回归。
//!
//! 运行:`cargo test -p kb-cli --features testkit --test e2e_daemon`

#![cfg(feature = "testkit")]

mod support;

use std::path::Path;

use serde_json::json;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use support::{Daemon, Spawn};

fn kb() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kb"))
}

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

fn home_with(transports: &str) -> tempfile::TempDir {
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        &format!(
            "[embed]\nbackend = \"fake\"\n[mcp]\ntransports = {transports}\n\
             [server]\nlisten = \"127.0.0.1:0\"\n"
        ),
    );
    home
}

fn listen_addr(home: &Path) -> String {
    std::fs::read_to_string(home.join("run/listen"))
        .expect("listen")
        .trim()
        .to_owned()
}

fn project(name: &str, files: usize) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("项目目录");
    for index in 0..files {
        write(
            &dir.path().join(format!("src/f{index}.rs")),
            &format!("fn f{index}() -> u32 {{\n    {index}\n}}\n"),
        );
    }
    let _ = name;
    dir
}

#[test]
fn daemon_keeps_running_past_the_grace_window() {
    // 曾经在“宽限期”到点后自退。grace=1,睡到 2×grace 之后,并连续探测
    let home = home_with("[\"stdio\"]");
    let cwd = tempfile::tempdir().expect("cwd");
    let mut daemon = Daemon::start_in(home, cwd.path(), Some(1));
    std::thread::sleep(Duration::from_secs(3));
    for round in 0..3 {
        assert!(
            daemon.alive(),
            "第 {round} 次探测:守护进程不应在没有信号的情况下退出"
        );
        assert_eq!(
            daemon.health(),
            Some(200),
            "第 {round} 次探测:健康检查应 200"
        );
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[test]
fn daemon_exits_on_sigterm_within_the_grace() {
    let home = home_with("[\"stdio\"]");
    let cwd = tempfile::tempdir().expect("cwd");
    let mut daemon = Daemon::start_in(home, cwd.path(), Some(5));
    assert_eq!(daemon.health(), Some(200));
    let pid = daemon.child.id().to_string();
    let status = Command::new("kill")
        .args(["-TERM", &pid])
        .status()
        .expect("发 SIGTERM");
    assert!(status.success());
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !daemon.alive() {
            assert!(
                !daemon.home.path().join("run/listen").exists(),
                "退出后应删掉 run/listen"
            );
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("SIGTERM 后应在宽限期内退出");
}

#[test]
fn bind_failure_is_fatal() {
    // socket 路径被目录占住 → 绑定失败,进程必须非 0 退出
    let home = home_with("[\"stdio\"]");
    std::fs::create_dir_all(home.path().join("run/kb.sock")).expect("建目录占位");
    let mut child = kb()
        .env("KB_HOME", home.path())
        .args(["daemon"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("启动 kb daemon");
    // 绑定失败必须尽快退出;若回归成“继续活着”,这里用超时避免挂住测试
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        match child.try_wait().expect("等待子进程") {
            Some(status) => {
                assert!(!status.success(), "绑定失败时不应以 0 退出:{status:?}");
                return;
            }
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                panic!("绑定失败时进程应尽快退出,20 秒后仍活着");
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

#[test]
fn sigterm_leaves_the_job_queued_with_a_checkpoint() {
    // 正在跑索引时 SIGTERM → 任务回到 queued 且有检查点
    let home = home_with("[\"stdio\"]");
    let files = 400;
    let project = project("big", files);
    let path = project.path().to_string_lossy().into_owned();
    let add = kb()
        .env("KB_HOME", home.path())
        .args(["project", "add", &path, "--name", "big"])
        .output()
        .expect("project add");
    assert!(add.status.success());

    let cwd = tempfile::tempdir().expect("cwd");
    let mut daemon = Daemon::start_in(home, cwd.path(), Some(10));

    // 通过 UDS 投递全量索引
    let submit = kb()
        .env("KB_HOME", daemon.home.path())
        .args(["index", "big"])
        .output()
        .expect("index");
    assert!(
        submit.status.success(),
        "投递失败:{:?}",
        String::from_utf8_lossy(&submit.stderr)
    );

    // 等任务开始推进
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut started = false;
    while Instant::now() < deadline {
        let jobs = kb()
            .env("KB_HOME", daemon.home.path())
            .args(["jobs", "--json"])
            .output()
            .expect("jobs");
        let text = String::from_utf8_lossy(&jobs.stdout).into_owned();
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text)
            && let Some(list) = value.as_array()
        {
            if list.iter().any(|job| job["state"] == "running") {
                started = true;
                break;
            }
            if list.iter().any(|job| job["state"] == "done") {
                // 前提不成立(任务在发信号前就跑完):明确失败,而不是空过
                panic!("任务在 SIGTERM 前已完成,请调大 files(当前 {files})以留出余量");
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    assert!(started, "索引任务应已开始");

    let pid = daemon.child.id().to_string();
    let _ = Command::new("kill").args(["-TERM", &pid]).status();
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline && daemon.alive() {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!daemon.alive(), "SIGTERM 后应退出");

    // 读 jobs 表:被中断的任务必须是 queued 且带检查点(或者已经跑完)
    let jobs = kb()
        .env("KB_HOME", daemon.home.path())
        .args(["jobs", "--json"])
        .output()
        .expect("jobs");
    let text = String::from_utf8_lossy(&jobs.stdout).into_owned();
    let value: serde_json::Value = serde_json::from_str(&text).expect("JSON");
    let list = value.as_array().expect("数组");
    assert!(!list.is_empty(), "应有任务记录");
    let interrupted = list
        .iter()
        .find(|job| job["state"] == "queued")
        .unwrap_or_else(|| {
            // 失败时把实际状态带上:区分“时序不成立(done)”与“真失败(failed)”
            let states = list
                .iter()
                .map(|job| job["state"].as_str().unwrap_or("?"))
                .collect::<Vec<_>>()
                .join(",");
            panic!(
                "被中断的任务应回到 queued,实际状态:{states}(files={files};\
                 若含 done,是任务在 SIGTERM 前跑完的时序问题,调大 files)"
            )
        });
    assert!(
        interrupted["progress_done"].as_u64().unwrap_or(0) > 0,
        "应有进度:{interrupted}"
    );
}

/// 走 UDS 调一个能力(手写 HTTP/1.1)。
fn uds_call(home: &Path, path: &str, headers: &[(&str, String)], body: &str) -> (u16, String) {
    use std::io::{Read, Write};
    let socket = home.join("run/kb.sock");
    let mut stream = std::os::unix::net::UnixStream::connect(socket).expect("连 UDS");
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
         Connection: close\r\nContent-Length: {}\r\n",
        body.len()
    );
    for (key, value) in headers {
        request.push_str(&format!("{key}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).expect("写请求");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("读响应");
    let status = raw
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let body = raw.split("\r\n\r\n").nth(1).unwrap_or_default().to_owned();
    (status, body)
}

/// 从 `kb search` 的 stderr 里取出作用域。
fn scope_of(stderr: &str) -> String {
    let start = stderr.find("作用域:").expect("应有作用域行") + "作用域:".len();
    let rest = &stderr[start..];
    rest.trim_end_matches([')', '\n']).to_owned()
}

fn hits_of(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .filter(|line| line.starts_with('['))
        .filter_map(|line| {
            line.split("id=").nth(1).map(|rest| {
                rest.split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            })
        })
        .collect()
}

#[test]
fn cwd_with_unicode_and_spaces_matches_local_search() {
    // 两个项目,中文 + 空格目录下经 UDS 与 --local 的作用域必须**完全相同**
    let home = home_with("[\"stdio\"]");
    let base = tempfile::tempdir().expect("项目根");
    let unicode_dir = base.path().join("我的 项目");
    write(
        &unicode_dir.join("src/only_here.rs"),
        "pub fn zebra_authentication() -> u8 {\n    42\n}\n",
    );
    let other_dir = base.path().join("other");
    write(
        &other_dir.join("src/other.rs"),
        "pub fn unrelated_helper() -> u8 {\n    1\n}\n",
    );
    for (dir, name) in [(&unicode_dir, "uni"), (&other_dir, "other")] {
        let path = dir.to_string_lossy().into_owned();
        let add = kb()
            .env("KB_HOME", home.path())
            .args(["project", "add", &path, "--name", name])
            .output()
            .expect("project add");
        assert!(add.status.success(), "project add 失败");
        let index = kb()
            .env("KB_HOME", home.path())
            .args(["index", name])
            .output()
            .expect("index");
        assert!(index.status.success(), "index 失败");
    }

    let daemon = Daemon::start_in(home, &unicode_dir, None);
    let remote = kb()
        .env("KB_HOME", daemon.home.path())
        .current_dir(&unicode_dir)
        .args(["search", "zebra_authentication"])
        .output()
        .expect("远程搜索");
    let local = kb()
        .env("KB_HOME", daemon.home.path())
        .current_dir(&unicode_dir)
        .args(["search", "zebra_authentication", "--local"])
        .output()
        .expect("嵌入式搜索");
    let remote_err = String::from_utf8_lossy(&remote.stderr).into_owned();
    let local_err = String::from_utf8_lossy(&local.stderr).into_owned();
    let remote_scope = scope_of(&remote_err);
    let local_scope = scope_of(&local_err);
    assert_eq!(
        remote_scope, local_scope,
        "经 UDS 与 --local 的作用域必须一致(remote={remote_scope} local={local_scope})"
    );
    assert!(
        remote_scope.contains("proj_uni") && !remote_scope.contains("proj_other"),
        "作用域应只含 uni:{remote_scope}"
    );
    let remote_out = String::from_utf8_lossy(&remote.stdout).into_owned();
    let local_out = String::from_utf8_lossy(&local.stdout).into_owned();
    assert_eq!(
        hits_of(&remote_out),
        hits_of(&local_out),
        "命中 id 序列应一致"
    );
    assert!(!hits_of(&remote_out).is_empty(), "应有命中");

    // save_insight 走 UDS(只带编码后的 X-KB-Cwd,不传 project)
    let (status, body) = uds_call(
        daemon.home.path(),
        "/api/v1/capabilities/save_insight",
        &[(
            "x-kb-cwd",
            kb_core::pct::encode(&unicode_dir.to_string_lossy()),
        )],
        r#"{"title":"中文目录里的经验","body":"正文"}"#,
    );
    assert_eq!(status, 200, "save_insight 应成功:{body}");
    let value: serde_json::Value = serde_json::from_str(&body).expect("JSON");
    assert_eq!(
        value["data"]["collection"], "proj_uni",
        "应按 cwd 落到 proj_uni:{value}"
    );
}

#[test]
fn daemon_ignores_inherited_kb_project() {
    // 守护进程带 KB_PROJECT=projA 启动,但请求的作用域由请求本身决定
    let home = home_with("[\"stdio\"]");
    let base = tempfile::tempdir().expect("项目根");
    let dir_a = base.path().join("projA");
    let dir_b = base.path().join("projB");
    write(
        &dir_a.join("src/a.rs"),
        "pub fn alpha_marker() -> u8 {\n    1\n}\n",
    );
    write(
        &dir_b.join("src/b.rs"),
        "pub fn beta_marker() -> u8 {\n    2\n}\n",
    );
    for (dir, name) in [(&dir_a, "projA"), (&dir_b, "projB")] {
        let path = dir.to_string_lossy().into_owned();
        assert!(
            kb().env("KB_HOME", home.path())
                .args(["project", "add", &path, "--name", name])
                .output()
                .expect("add")
                .status
                .success()
        );
        assert!(
            kb().env("KB_HOME", home.path())
                .args(["index", name])
                .output()
                .expect("index")
                .status
                .success()
        );
    }

    // 守护进程:继承 KB_PROJECT=projA,工作目录是 projB
    let daemon = Daemon::spawn(
        home,
        Spawn {
            cwd: Some(&dir_b),
            grace_secs: None,
            env: &[("KB_PROJECT", "projA")],
        },
    );
    assert_eq!(daemon.health(), Some(200), "守护进程应就绪");

    let cwd_b = kb_core::pct::encode(&dir_b.to_string_lossy());
    // 无项目头、只带 X-KB-Cwd=projB → 只搜 projB
    let (status, body) = uds_call(
        daemon.home.path(),
        "/api/v1/capabilities/search_knowledge",
        &[("x-kb-cwd", cwd_b.clone())],
        r#"{"query":"beta_marker"}"#,
    );
    assert_eq!(status, 200, "{body}");
    let value: serde_json::Value = serde_json::from_str(&body).expect("JSON");
    let scope = value["data"]["scope"].to_string();
    assert!(scope.contains("proj_projb"), "应按 cwd 落到 projB:{scope}");
    assert!(
        !scope.contains("proj_proja"),
        "不应被 KB_PROJECT 污染:{scope}"
    );

    // 显式 X-KB-Project=projA → 只搜 projA
    let (status, body) = uds_call(
        daemon.home.path(),
        "/api/v1/capabilities/search_knowledge",
        &[("x-kb-project", "projA".to_owned())],
        r#"{"query":"alpha_marker"}"#,
    );
    assert_eq!(status, 200, "{body}");
    let value: serde_json::Value = serde_json::from_str(&body).expect("JSON");
    let scope = value["data"]["scope"].to_string();
    assert!(scope.contains("proj_proja"), "{scope}");
    assert!(!scope.contains("proj_projb"), "{scope}");

    // save_insight 按 cwd 落到 projB
    let (status, body) = uds_call(
        daemon.home.path(),
        "/api/v1/capabilities/save_insight",
        &[("x-kb-cwd", cwd_b)],
        r#"{"title":"B 项目经验","body":"正文"}"#,
    );
    assert_eq!(status, 200, "{body}");
    let value: serde_json::Value = serde_json::from_str(&body).expect("JSON");
    assert_eq!(value["data"]["collection"], "proj_projb", "{value}");
}

#[test]
fn mcp_http_uses_request_scope_and_rejects_missing_project() {
    // 守护进程在 projB 启动,`/mcp` 仍能搜到 projA 的内容;save_insight 无作用域报 invalid_input
    let home = home_with("[\"stdio\", \"http\"]");
    let token = kb()
        .env("KB_HOME", home.path())
        .args(["mcp", "token"])
        .output()
        .expect("mcp token");
    assert!(token.status.success());
    let token = std::fs::read_to_string(home.path().join("run/mcp-token"))
        .expect("token")
        .trim()
        .to_owned();

    let base = tempfile::tempdir().expect("项目根");
    let dir_a = base.path().join("projA");
    let dir_b = base.path().join("projB");
    write(
        &dir_a.join("src/a.rs"),
        "pub fn zebra_only_in_a() -> u8 {\n    7\n}\n",
    );
    write(
        &dir_b.join("src/b.rs"),
        "pub fn plain_b() -> u8 {\n    8\n}\n",
    );
    for (dir, name) in [(&dir_a, "projA"), (&dir_b, "projB")] {
        let path = dir.to_string_lossy().into_owned();
        assert!(
            kb().env("KB_HOME", home.path())
                .args(["project", "add", &path, "--name", name])
                .output()
                .expect("add")
                .status
                .success()
        );
        assert!(
            kb().env("KB_HOME", home.path())
                .args(["index", name])
                .output()
                .expect("index")
                .status
                .success()
        );
    }

    let daemon = Daemon::start_in(home, &dir_b, None);
    let addr = listen_addr(daemon.home.path());

    // initialize 拿到 session
    let (status, session, _) = http_call(
        &addr,
        "/mcp",
        Some(&token),
        None,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "remote", "version": "1"},
            }
        })
        .to_string(),
    );
    assert_eq!(status, 200);
    let session = session.expect("session");

    // 查询只存在于 projA 的内容:不能被守护进程的 cwd(projB)钉死
    let (status, _, body) = http_call(
        &addr,
        "/mcp",
        Some(&token),
        Some(&session),
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "search_knowledge", "arguments": {"query": "zebra_only_in_a", "k": 5}},
        })
        .to_string(),
    );
    assert_eq!(status, 200, "{body}");
    let rpc = parse_rpc(&body);
    let text = rpc["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    assert!(text.contains("src/a.rs"), "/mcp 应搜到 projA 的内容:{text}");

    // 无 project、无 global 的 save_insight → isError + invalid_input
    let (status, _, body) = http_call(
        &addr,
        "/mcp",
        Some(&token),
        Some(&session),
        &json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "save_insight", "arguments": {"title": "无作用域", "body": "正文"}},
        })
        .to_string(),
    );
    assert_eq!(status, 200, "{body}");
    let value = parse_rpc(&body);
    assert_eq!(value["result"]["isError"], true, "{value}");
    let text = value["result"]["content"][0]["text"].as_str().unwrap_or("");
    assert!(text.starts_with("invalid_input:"), "{text}");
    drop(daemon);
}

#[test]
fn mcp_host_header_is_checked() {
    // Host 不在白名单 → 403;配置后 → 200;无关域名始终 403
    let home = home_with("[\"stdio\", \"http\"]");
    let token = kb()
        .env("KB_HOME", home.path())
        .args(["mcp", "token"])
        .output()
        .expect("token");
    assert!(token.status.success());
    let token = std::fs::read_to_string(home.path().join("run/mcp-token"))
        .expect("token")
        .trim()
        .to_owned();
    let cwd = tempfile::tempdir().expect("cwd");
    let daemon = Daemon::start_in(home, cwd.path(), None);
    let addr = listen_addr(daemon.home.path());
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "host-test", "version": "1"},
        }
    })
    .to_string();

    let (status, _, _) = http_call_with_host(&addr, "/mcp", Some(&token), "kb.example.com", &body);
    assert_eq!(status, 403, "未配置的 Host 应 403");
    let (status, _, _) =
        http_call_with_host(&addr, "/mcp", Some(&token), "evil.example.com", &body);
    assert_eq!(status, 403, "无关 Host 应 403");
    let (status, _, _) = http_call_with_host(&addr, "/mcp", Some(&token), "localhost", &body);
    assert_eq!(status, 200, "本机 Host 应 200");
    drop(daemon);

    // 配置 allowed_hosts 后,kb.example.com 应放行
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n[mcp]\ntransports = [\"stdio\", \"http\"]\n\
         allowed_hosts = [\"kb.example.com\"]\n[server]\nlisten = \"127.0.0.1:0\"\n",
    );
    let token = kb()
        .env("KB_HOME", home.path())
        .args(["mcp", "token"])
        .output()
        .expect("token");
    assert!(token.status.success());
    let token = std::fs::read_to_string(home.path().join("run/mcp-token"))
        .expect("token")
        .trim()
        .to_owned();
    let cwd = tempfile::tempdir().expect("cwd");
    let daemon = Daemon::start_in(home, cwd.path(), None);
    let addr = listen_addr(daemon.home.path());
    let (status, _, _) = http_call_with_host(&addr, "/mcp", Some(&token), "kb.example.com", &body);
    assert_eq!(status, 200, "配置后 kb.example.com 应 200");
    let (status, _, _) =
        http_call_with_host(&addr, "/mcp", Some(&token), "evil.example.com", &body);
    assert_eq!(status, 403, "无关 Host 仍应 403");
    drop(daemon);
}

/// 从 SSE 或 JSON 响应里取出 JSON-RPC 消息。
fn parse_rpc(body: &str) -> serde_json::Value {
    for line in body.lines() {
        if let Some(rest) = line.strip_prefix("data: ")
            && let Ok(value) = serde_json::from_str::<serde_json::Value>(rest.trim())
            && value.get("jsonrpc").is_some()
        {
            return value;
        }
    }
    serde_json::from_str(body.trim()).unwrap_or(serde_json::Value::Null)
}

/// 普通 TCP 请求(默认 `Host: <addr>`)。
fn http_call(
    addr: &str,
    path: &str,
    token: Option<&str>,
    session: Option<&str>,
    body: &str,
) -> (u16, Option<String>, String) {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(addr).expect("连 TCP");
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nConnection: close\r\n\
         Content-Length: {}\r\n",
        body.len()
    );
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    if let Some(session) = session {
        request.push_str(&format!("mcp-session-id: {session}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).expect("写请求");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("读响应");
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let session = text.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("mcp-session-id:")
            .map(|value| value.trim().to_owned())
    });
    let body = text.split("\r\n\r\n").nth(1).unwrap_or_default().to_owned();
    (status, session, body)
}

/// 带自定义 `Host` 头的 TCP 请求。
fn http_call_with_host(
    addr: &str,
    path: &str,
    token: Option<&str>,
    host: &str,
    body: &str,
) -> (u16, Option<String>, String) {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(addr).expect("连 TCP");
    let mut request = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/json\r\n\
         Accept: application/json, text/event-stream\r\nConnection: close\r\n\
         Content-Length: {}\r\n",
        body.len()
    );
    if let Some(token) = token {
        request.push_str(&format!("Authorization: Bearer {token}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).expect("写请求");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("读响应");
    let text = String::from_utf8_lossy(&raw).into_owned();
    let status = text
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    let session = text.lines().find_map(|line| {
        line.to_ascii_lowercase()
            .strip_prefix("mcp-session-id:")
            .map(|value| value.trim().to_owned())
    });
    let body = text.split("\r\n\r\n").nth(1).unwrap_or_default().to_owned();
    (status, session, body)
}

#[test]
fn events_endpoint_enqueues_incremental_jobs() {
    // :守护进程的 POST /api/v1/events
    let home = home_with("[\"stdio\"]");
    let project = tempfile::tempdir().expect("项目");
    write(
        &project.path().join("src/a.rs"),
        "pub fn alpha() -> u8 {\n    1\n}\n",
    );
    let path = project.path().to_string_lossy().into_owned();
    assert!(
        kb().env("KB_HOME", home.path())
            .args(["project", "add", &path, "--name", "evt"])
            .output()
            .expect("add")
            .status
            .success()
    );
    assert!(
        kb().env("KB_HOME", home.path())
            .args(["index", "evt"])
            .output()
            .expect("index")
            .status
            .success()
    );

    let daemon = Daemon::start_in(home, project.path(), None);
    let body = json!({
        "kind": "session_end",
        "project_root": path,
        "payload": {"paths": ["src/a.rs"]},
    })
    .to_string();
    let (status, text) = uds_call(
        daemon.home.path(),
        "/api/v1/events",
        &[("content-type", "application/json".to_owned())],
        &body,
    );
    assert_eq!(status, 200, "{text}");
    let value: serde_json::Value = serde_json::from_str(&text).expect("JSON");
    assert_eq!(value["data"]["project"], "evt", "{value}");
    assert_eq!(value["data"]["mode"], "incremental", "{value}");
    assert_eq!(value["data"]["changed_files"], 1, "{value}");
    assert!(value["data"]["job_id"].is_string(), "{value}");

    // 未知种类 → 400
    let (status, _) = uds_call(
        daemon.home.path(),
        "/api/v1/events",
        &[("content-type", "application/json".to_owned())],
        &json!({"kind": "nope", "project_root": path}).to_string(),
    );
    assert_eq!(status, 400, "未知事件种类应 400");
}

#[test]
fn kb_project_env_matches_local_scope() {
    // 客户端的 KB_PROJECT 经守护进程也要生效,与 --local 一致
    let home = home_with("[\"stdio\"]");
    let base = tempfile::tempdir().expect("项目根");
    let dir_a = base.path().join("projA");
    let dir_b = base.path().join("projB");
    write(
        &dir_a.join("src/a.rs"),
        "pub fn alpha_only() -> u8 {\n    1\n}\n",
    );
    write(
        &dir_b.join("src/b.rs"),
        "pub fn beta_only() -> u8 {\n    2\n}\n",
    );
    for (dir, name) in [(&dir_a, "projA"), (&dir_b, "projB")] {
        let path = dir.to_string_lossy().into_owned();
        assert!(
            kb().env("KB_HOME", home.path())
                .args(["project", "add", &path, "--name", name])
                .output()
                .expect("add")
                .status
                .success()
        );
        assert!(
            kb().env("KB_HOME", home.path())
                .args(["index", name])
                .output()
                .expect("index")
                .status
                .success()
        );
    }

    // cwd 是无关目录,靠 KB_PROJECT 决定作用域
    let unrelated = tempfile::tempdir().expect("无关目录");
    let daemon = Daemon::start_in(home, unrelated.path(), None);

    let remote = kb()
        .env("KB_HOME", daemon.home.path())
        .env("KB_PROJECT", "projB")
        .current_dir(unrelated.path())
        .args(["search", "beta_only"])
        .output()
        .expect("远程搜索");
    let local = kb()
        .env("KB_HOME", daemon.home.path())
        .env("KB_PROJECT", "projB")
        .current_dir(unrelated.path())
        .args(["search", "beta_only", "--local"])
        .output()
        .expect("嵌入式搜索");
    let remote_scope = scope_of(&String::from_utf8_lossy(&remote.stderr));
    let local_scope = scope_of(&String::from_utf8_lossy(&local.stderr));
    assert_eq!(
        remote_scope, local_scope,
        "KB_PROJECT 经守护进程与 --local 应一致(remote={remote_scope} local={local_scope})"
    );
    assert!(remote_scope.contains("proj_projb"), "{remote_scope}");
    assert!(!remote_scope.contains("proj_proja"), "{remote_scope}");
    assert_eq!(
        hits_of(&String::from_utf8_lossy(&remote.stdout)),
        hits_of(&String::from_utf8_lossy(&local.stdout))
    );

    // --project 覆盖环境变量
    let override_scope = kb()
        .env("KB_HOME", daemon.home.path())
        .env("KB_PROJECT", "projB")
        .current_dir(unrelated.path())
        .args(["search", "alpha_only", "--project", "projA"])
        .output()
        .expect("覆盖搜索");
    let scope = scope_of(&String::from_utf8_lossy(&override_scope.stderr));
    assert!(
        scope.contains("proj_proja"),
        "--project 应覆盖 KB_PROJECT:{scope}"
    );
    assert!(!scope.contains("proj_projb"), "{scope}");
}

#[test]
fn sidecars_are_started_restarted_and_stopped() {
    // (d):假 llama-server 的完整生命周期(拉起 → kill 自动重启 → SIGTERM 无残留)
    let home = tempfile::tempdir().expect("KB_HOME");
    let bin_dir = home.path().join("bin");
    std::fs::create_dir_all(&bin_dir).expect("bin");
    let pid_file = home.path().join("sidecar.pids");
    let script = format!(
        "#!/bin/sh\necho $$ >> {}\nexec sleep 600\n",
        pid_file.display()
    );
    std::fs::write(bin_dir.join("llama-server"), script).expect("写假 llama-server");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        bin_dir.join("llama-server"),
        std::fs::Permissions::from_mode(0o755),
    )
    .expect("chmod");
    std::fs::create_dir_all(home.path().join("models/gguf")).expect("models");
    std::fs::write(home.path().join("models/gguf/e.gguf"), b"").expect("embed gguf");
    std::fs::write(home.path().join("models/gguf/r.gguf"), b"").expect("rerank gguf");
    write(
        &home.path().join("config.toml"),
        &format!(
            "[embed]\nbackend = \"fake\"\n[accel]\nenabled = true\nllama_dir = \"{}\"\n\
             embed_gguf = \"gguf/e.gguf\"\nrerank_gguf = \"gguf/r.gguf\"\n\
             [server]\nlisten = \"127.0.0.1:0\"\n",
            bin_dir.display()
        ),
    );

    let cwd = tempfile::tempdir().expect("cwd");
    let daemon = Daemon::start_in(home, cwd.path(), None);
    let read_pids = || -> Vec<i32> {
        std::fs::read_to_string(&pid_file)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect()
    };
    // 等到两个 sidecar 都起来
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && read_pids().len() < 2 {
        std::thread::sleep(Duration::from_millis(200));
    }
    let started = read_pids();
    assert_eq!(started.len(), 2, "应拉起两个 sidecar:{started:?}");

    // kill 掉第一个,应在 ~10 秒内被监督线程重启
    let _ = Command::new("kill")
        .args(["-9", &started[0].to_string()])
        .status();
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut restarted = false;
    while Instant::now() < deadline {
        if read_pids().len() > 2 {
            restarted = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    assert!(restarted, "崩溃的 sidecar 应被自动重启:{:?}", read_pids());

    // 守护进程退出后不留孤儿
    let pid = daemon.child.id().to_string();
    let _ = Command::new("kill").args(["-TERM", &pid]).status();
    let deadline = Instant::now() + Duration::from_secs(25);
    while Instant::now() < deadline {
        let alive: Vec<i32> = read_pids()
            .into_iter()
            .filter(|sidecar| {
                Command::new("kill")
                    .args(["-0", &sidecar.to_string()])
                    .status()
                    .map(|status| status.success())
                    .unwrap_or(false)
            })
            .collect();
        if alive.is_empty() {
            return;
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    panic!("SIGTERM 后仍有 sidecar 残留:{:?}", read_pids());
}

/// :`[accel] roles = ["rerank"]` 时只起重排那一路上,嵌入走进程内(不放嵌入 GGUF 也能开重排)。
///
/// 以前 `SidecarPair::start` 是任意一路失败就整组报错,于是只开重排这种配法一个 sidecar 都起不来。
#[test]
fn accel_roles_can_narrow_the_sidecars_to_rerank_only() {
    let home = tempfile::tempdir().expect("KB_HOME");
    let bin_dir = home.path().join("bin");
    std::fs::create_dir_all(&bin_dir).expect("bin");
    let pid_file = home.path().join("sidecar.pids");
    let script = format!(
        "#!/bin/sh\necho $$ >> {}\nexec sleep 600\n",
        pid_file.display()
    );
    std::fs::write(bin_dir.join("llama-server"), script).expect("写假 llama-server");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        bin_dir.join("llama-server"),
        std::fs::Permissions::from_mode(0o755),
    )
    .expect("chmod");
    // 只放重排模型:嵌入那一路缺料,按配置本来也不该起
    std::fs::create_dir_all(home.path().join("models/gguf")).expect("models");
    std::fs::write(home.path().join("models/gguf/r.gguf"), b"").expect("rerank gguf");
    write(
        &home.path().join("config.toml"),
        &format!(
            "[embed]\nbackend = \"fake\"\n[accel]\nenabled = true\nllama_dir = \"{}\"\n\
             embed_gguf = \"gguf/e.gguf\"\nrerank_gguf = \"gguf/r.gguf\"\n\
             ngl = 0\nroles = [\"rerank\"]\n\
             [server]\nlisten = \"127.0.0.1:0\"\n",
            bin_dir.display()
        ),
    );

    let cwd = tempfile::tempdir().expect("cwd");
    let daemon = Daemon::start_in(home, cwd.path(), None);
    let read_pids = || -> Vec<i32> {
        std::fs::read_to_string(&pid_file)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.trim().parse().ok())
            .collect()
    };
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline && read_pids().is_empty() {
        std::thread::sleep(Duration::from_millis(200));
    }
    // 多等一会:如果错起了嵌入那一路,这里才看得见第二个 pid
    std::thread::sleep(Duration::from_secs(2));
    let started = read_pids();
    assert_eq!(
        started.len(),
        1,
        "`roles = [\"rerank\"]` 只应起一个 sidecar:{started:?}"
    );

    let pid = daemon.child.id().to_string();
    let _ = Command::new("kill").args(["-TERM", &pid]).status();
}

#[test]
fn config_hot_reload_changes_search_k_without_restarting() {
    // :改 `config.toml` 的 `search.k` 后,下一个请求就按新值走(不重启守护进程);
    // 写坏配置时旧配置继续生效,进程不倒。
    let home = home_with("[\"stdio\"]");
    let dir = project("hot", 4);
    assert!(
        kb().env("KB_HOME", home.path())
            .args([
                "project",
                "add",
                &dir.path().to_string_lossy(),
                "--name",
                "hot"
            ])
            .output()
            .expect("project add")
            .status
            .success()
    );
    assert!(
        kb().env("KB_HOME", home.path())
            .args(["index", "hot"])
            .output()
            .expect("index")
            .status
            .success()
    );

    let cwd = tempfile::tempdir().expect("cwd");
    let mut daemon = Daemon::start_in(home, cwd.path(), None);

    let hits = |daemon: &Daemon| -> usize {
        let (status, body) = uds_call(
            daemon.home.path(),
            "/api/v1/capabilities/search_knowledge",
            &[("x-kb-project", "hot".to_owned())],
            r#"{"query":"fn"}"#,
        );
        assert_eq!(status, 200, "{body}");
        let value: serde_json::Value = serde_json::from_str(&body).expect("JSON");
        value["data"]["hits"]
            .as_array()
            .map(|hits| hits.len())
            .unwrap_or(0)
    };

    // 默认 k = 8:4 个文件至少 4 个块
    let before = hits(&daemon);
    assert!(before >= 4, "索引后应有足够命中,实际 {before}");

    // 把 k 改成 1(保留 embed / server / mcp 段,否则配置校验会失败)
    write(
        &daemon.home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n[mcp]\ntransports = [\"stdio\"]\n[search]\nk = 1\n",
    );

    // 去抖 500ms + 重载:轮询到条数变化为止(不重启)
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut after = before;
    while Instant::now() < deadline {
        after = hits(&daemon);
        if after == 1 {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    assert_eq!(after, 1, "改 search.k 后应只返回 1 条(实际 {after})");
    assert!(daemon.alive(), "热重载不该让守护进程退出");

    // 写坏配置:旧配置继续生效,检索仍然只返回 1 条
    write(&daemon.home.path().join("config.toml"), "[search\nk = 5\n");
    std::thread::sleep(Duration::from_secs(2));
    assert_eq!(hits(&daemon), 1, "非法配置必须保留旧配置");
    assert!(daemon.alive(), "非法配置不该让守护进程退出");

    // 修回来:再改成 2,应能继续热更新
    write(
        &daemon.home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n[mcp]\ntransports = [\"stdio\"]\n[search]\nk = 2\n",
    );
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut recovered = 0;
    while Instant::now() < deadline {
        recovered = hits(&daemon);
        if recovered == 2 {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    assert_eq!(recovered, 2, "改回合法配置后应恢复热更新(实际 {recovered})");
}

/// 跑一次 `kb hook`,把 hook JSON 从标准输入喂进去。
fn run_hook(home: &Path, action: &str, input: &str) -> std::process::Output {
    use std::io::Write;
    let mut child = kb()
        .env("KB_HOME", home)
        .args(["hook", action])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("启动 kb hook");
    child
        .stdin
        .as_mut()
        .expect("stdin")
        .write_all(input.as_bytes())
        .expect("写 hook 输入");
    child.wait_with_output().expect("等 kb hook")
}

/// :`--explain` 的各阶段耗时(含排队时间)以前算完就丢,现在两条路径都要带出来。
#[test]
fn explain_carries_stage_timings_over_uds_and_embedded() {
    let home = home_with("[\"stdio\"]");
    let dir = project("timings", 3);
    assert!(
        kb().env("KB_HOME", home.path())
            .args([
                "project",
                "add",
                &dir.path().to_string_lossy(),
                "--name",
                "timings"
            ])
            .output()
            .expect("project add")
            .status
            .success()
    );
    assert!(
        kb().env("KB_HOME", home.path())
            .args(["index", "timings"])
            .output()
            .expect("index")
            .status
            .success()
    );

    let cwd = tempfile::tempdir().expect("cwd");
    let daemon = Daemon::start_in(home, cwd.path(), None);

    // 经守护进程:能力的响应里要有 timings,且 queue_ms 是个数(没排队就是 0)
    let (status, body) = uds_call(
        daemon.home.path(),
        "/api/v1/capabilities/search_knowledge",
        &[("x-kb-project", "timings".to_owned())],
        r#"{"query":"fn","explain":true}"#,
    );
    assert_eq!(status, 200, "{body}");
    let value: serde_json::Value = serde_json::from_str(&body).expect("JSON");
    let queue = &value["data"]["timings"]["queue_ms"];
    assert!(
        queue.as_f64().is_some(),
        "经守护进程的响应要带各阶段耗时,实际 {body}"
    );
    assert!(
        value["data"]["timings"]["store_ms"].as_f64().is_some(),
        "各阶段耗时都要在"
    );

    // 嵌入式:CLI 的 JSON 里同样要有
    let output = kb()
        .env("KB_HOME", daemon.home.path())
        .current_dir(&dir.path())
        .args(["search", "fn", "--local", "--explain", "--json"])
        .output()
        .expect("嵌入式搜索");
    assert!(output.status.success(), "嵌入式搜索应成功");
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    let value: serde_json::Value = serde_json::from_str(&text).expect("JSON");
    assert!(
        value["data"]["timings"]["queue_ms"].as_f64().is_some(),
        "--local --explain --json 也要带 timings,实际 {text}"
    );
}

/// 收尾:会话 hook → `session_end` 事件 → 守护进程读会话记录并提炼
/// (项目没开自动提炼时如实记 `skipped_unauthorized`,一次 LLM 都不调)。
/// (bf0a5d57 把上一个用例插在了它的 `#[test]` 与函数之间,这个用例因此一直没跑过,这里归位。)
#[test]
fn session_hook_posts_a_session_end_event() {
    let home = home_with("[\"stdio\"]");
    let cwd = project("hooked", 2);
    // 守护进程起来之前先登记项目(project add 需要拿 run/daemon.lock)
    let added = kb()
        .env("KB_HOME", home.path())
        .args(["project", "add", "--name", "hooked"])
        .arg(cwd.path())
        .output()
        .expect("kb project add");
    assert!(
        added.status.success(),
        "登记项目失败:{}",
        String::from_utf8_lossy(&added.stderr)
    );

    let session = cwd.path().join("session.jsonl");
    write(
        &session,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"转写要不要走云端?\"}}\n\
         {\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"不要,必须本地跑。\"}]}}\n",
    );

    let mut daemon = Daemon::start_in(home, cwd.path(), None);
    let input = json!({
        "session_id": "s-1",
        "cwd": cwd.path().to_string_lossy(),
        "hook_event_name": "Stop",
        "transcript_path": session.to_string_lossy(),
    })
    .to_string();
    let output = run_hook(daemon.home.path(), "claude-stop", &input);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "hook 应以 0 退出:{stdout}{stderr}");
    assert!(
        stdout.contains("已投递会话事件"),
        "应回显投递结果:{stdout}{stderr}"
    );
    assert!(stdout.contains("项目 hooked"), "应回显项目名:{stdout}");
    // 项目默认不开自动提炼 → 同步给出结论(hook 当场就能说明原因)
    assert!(
        stdout.contains("没开自动提炼"),
        "应说明提炼被跳过:{stdout}{stderr}"
    );
    assert!(daemon.alive(), "会话事件不该让守护进程退出");

    // 打开提炼后再触发(会话内容也变了):这次进后台,结果写回同一行事件
    let (status, body) = uds_call(
        daemon.home.path(),
        "/api/v1/capabilities/update_project",
        &[],
        &json!({
            "project": "hooked",
            "allow_cloud_llm": true,
            "extract_enabled": true,
        })
        .to_string(),
    );
    assert_eq!(status, 200, "update_project 失败:{body}");
    write(
        &session,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"再问一次\"}}\n\
         {\"type\":\"assistant\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"还是本地跑。\"}]}}\n",
    );
    let output = run_hook(daemon.home.path(), "claude-stop", &input);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("后台"), "应说明提炼已排入后台:{stdout}");

    // 后台任务最终把结果写回事件表(无 key 时模型是 mock,成功失败都算写回)
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut settled = None;
    while Instant::now() < deadline {
        if let Some(result) = last_event_result(daemon.home.path())
            && !result.contains("\"pending\"")
        {
            settled = Some(result);
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let result = settled.expect("后台提炼应把结果写回事件表");
    // 无 key 时模型是 mock(固定回 `{"queries":[]…}`):解析成功但 0 条候选 —— 结局是确定的
    assert!(
        result.contains("\"candidates\":0"),
        "应记下提炼的确切结局:{result}"
    );
    assert!(!result.contains("evolution_error"), "{result}");
    assert!(!result.contains("\"pending\""), "{result}");
    assert!(result.contains("session_bytes"), "应记下会话大小:{result}");
}

/// 读事件表里最新一条 `session_end` 的 `result`(只读打开 meta.db)。
fn last_event_result(home: &Path) -> Option<String> {
    use kb_core::ports::repo::EventRepo;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("运行时");
    let meta = home.join("meta.db");
    runtime.block_on(async move {
        let store = kb_meta::SqliteMetaStore::open(&meta).ok()?;
        let events = store.recent(10).await.ok()?;
        events
            .into_iter()
            .find(|event| event.kind == "session_end")
            .and_then(|event| event.result)
    })
}

/// `[llm]` 的额度必须从配置接线(a:把 `llm_gate` 改回
/// `GateConfig::default` 会让这条变红)。无 key 时模型是 mock,不需要网络。
#[test]
fn session_hook_respects_the_hourly_call_quota() {
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n[mcp]\ntransports = [\"stdio\"]\n\
         [server]\nlisten = \"127.0.0.1:0\"\n\
         [llm]\nmax_calls_per_hour = 1\n",
    );
    let cwd = project("quota", 1);
    let added = kb()
        .env("KB_HOME", home.path())
        .args(["project", "add", "--name", "quota"])
        .arg(cwd.path())
        .output()
        .expect("kb project add");
    assert!(added.status.success(), "登记项目失败");

    let daemon = Daemon::start_in(home, cwd.path(), None);
    let (status, body) = uds_call(
        daemon.home.path(),
        "/api/v1/capabilities/update_project",
        &[],
        &json!({ "project": "quota", "allow_cloud_llm": true, "extract_enabled": true })
            .to_string(),
    );
    assert_eq!(status, 200, "update_project 失败:{body}");

    // 两份不同的会话:第一份会真的外发一次(mock 模型),第二份被每小时上限拒绝
    let mut results = Vec::new();
    for index in 0..2 {
        let session = cwd.path().join(format!("s{index}.jsonl"));
        write(
            &session,
            &format!(
                "{{\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"第 {index} 份会话\"}}}}\n"
            ),
        );
        let input = json!({
            "cwd": cwd.path().to_string_lossy(),
            "transcript_path": session.to_string_lossy(),
        })
        .to_string();
        let output = run_hook(daemon.home.path(), "claude-stop", &input);
        assert!(
            output.status.success(),
            "hook 应以 0 退出:{}",
            String::from_utf8_lossy(&output.stderr)
        );
        // 等这一份的结论落库
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut settled = None;
        while Instant::now() < deadline {
            if let Some(result) = last_event_result(daemon.home.path())
                && !result.contains("\"pending\"")
            {
                settled = Some(result);
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        results.push(settled.expect("事件应有终态"));
    }
    let second = &results[1];
    assert!(
        second.contains("最近一小时"),
        "第二份应被每小时上限拒绝,实际:{second}"
    );
    assert!(
        second.contains("上限 1"),
        "错误里应写明上限来自配置:{second}"
    );
}

/// `[evolution] session_roots` 的真实接线:会话在项目根之外、由配置显式允许(a)。
#[test]
fn session_roots_from_the_config_are_honoured() {
    let home = tempfile::tempdir().expect("KB_HOME");
    // 会话放在项目根之外的一个目录里
    let sessions = tempfile::tempdir().expect("会话目录");
    write(
        &home.path().join("config.toml"),
        &format!(
            "[embed]\nbackend = \"fake\"\n[mcp]\ntransports = [\"stdio\"]\n\
             [server]\nlisten = \"127.0.0.1:0\"\n\
             [evolution]\nsession_roots = [\"{}\"]\n",
            sessions.path().display()
        ),
    );
    let cwd = project("rooted", 1);
    let added = kb()
        .env("KB_HOME", home.path())
        .args(["project", "add", "--name", "rooted"])
        .arg(cwd.path())
        .output()
        .expect("kb project add");
    assert!(added.status.success(), "登记项目失败");

    let daemon = Daemon::start_in(home, cwd.path(), None);
    let (status, body) = uds_call(
        daemon.home.path(),
        "/api/v1/capabilities/update_project",
        &[],
        &json!({ "project": "rooted", "allow_cloud_llm": true, "extract_enabled": true })
            .to_string(),
    );
    assert_eq!(status, 200, "update_project 失败:{body}");

    let session = sessions.path().join("outside.jsonl");
    write(
        &session,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"项目根之外的会话\"}}\n",
    );
    let input = json!({
        "cwd": cwd.path().to_string_lossy(),
        "transcript_path": session.to_string_lossy(),
    })
    .to_string();
    let output = run_hook(daemon.home.path(), "claude-stop", &input);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "hook 应以 0 退出:{stdout}{stderr}");
    assert!(
        !stderr.contains("不在允许的目录里"),
        "配置里的目录应被接受:{stderr}"
    );
    assert!(
        stdout.contains("后台") || stderr.contains("提炼"),
        "应进入提炼路径:{stdout}{stderr}"
    );
}

/// 守护进程启动时把上一次留下的 `pending` 收尾(c)。
#[test]
fn daemon_recovers_interrupted_pending_on_start() {
    let home = home_with("[\"stdio\"]");
    let cwd = project("recover", 1);
    let added = kb()
        .env("KB_HOME", home.path())
        .args(["project", "add", "--name", "recover"])
        .arg(cwd.path())
        .output()
        .expect("kb project add");
    assert!(added.status.success(), "登记项目失败");
    let project_root = cwd.path().to_string_lossy().into_owned();

    // 守护进程起来之前先写一行“上一进程留下的 pending”
    {
        use kb_core::ports::repo::EventRepo;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("运行时");
        let meta = home.path().join("meta.db");
        let root = project_root.clone();
        runtime.block_on(async move {
            let store = kb_meta::SqliteMetaStore::open(&meta).expect("打开 meta.db");
            let project = kb_core::ports::repo::ProjectRepo::match_cwd(&store, &root)
                .await
                .expect("找项目")
                .expect("项目存在");
            store
                .append(kb_core::model::Event {
                    id: "stuck-pending".to_owned(),
                    kind: "session_end".to_owned(),
                    project_id: Some(project.id),
                    payload_json: json!({
                        "project_root": root,
                        "head": null,
                        "payload": { "session_path": "/tmp/whatever.jsonl" },
                    })
                    .to_string(),
                    received_at: kb_service::llm_gate::today_now_millis(),
                    processed_at: Some(kb_service::llm_gate::today_now_millis()),
                    result: Some(
                        json!({
                            "index": "noop",
                            "changed_files": 0,
                            "session_bytes": 1,
                            "session_mtime_ms": 1,
                            "evolution": { "pending": true },
                        })
                        .to_string(),
                    ),
                })
                .await
                .expect("写事件");
        });
    }

    let mut daemon = Daemon::start_in(home, cwd.path(), None);
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut recovered = None;
    while Instant::now() < deadline {
        if let Some(result) = last_event_result(daemon.home.path())
            && result.contains("守护进程重启")
        {
            recovered = Some(result);
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let result = recovered.expect("启动时应把 pending 收尾");
    assert!(
        !result.contains("\"pending\""),
        "不该再留着 pending:{result}"
    );
    assert!(daemon.alive(), "守护进程应正常运行");
}

/// 目录没登记成项目时:hook 只跳过,不让会话失败(用户级 hook 会覆盖所有目录)。
#[test]
fn session_hook_skips_when_the_project_is_not_registered() {
    let home = home_with("[\"stdio\"]");
    let registered = project("registered", 1);
    let added = kb()
        .env("KB_HOME", home.path())
        .args(["project", "add", "--name", "registered"])
        .arg(registered.path())
        .output()
        .expect("kb project add");
    assert!(added.status.success(), "登记项目失败");
    let mut daemon = Daemon::start_in(home, registered.path(), None);

    // 另一个没登记的目录
    let stray = project("stray", 1);
    let session = stray.path().join("session.jsonl");
    write(
        &session,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
    );
    let input = json!({
        "cwd": stray.path().to_string_lossy(),
        "transcript_path": session.to_string_lossy(),
    })
    .to_string();
    let output = run_hook(daemon.home.path(), "claude-stop", &input);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "没登记的目录应以 0 退出:{stdout}{stderr}"
    );
    assert!(stdout.contains("没登记成项目"), "{stdout}{stderr}");
    assert!(daemon.alive(), "跳过不该影响守护进程");
}

/// 守护进程没运行时,hook 只跳过,不让会话失败。
#[test]
fn session_hook_skips_when_the_daemon_is_absent() {
    let home = home_with("[\"stdio\"]");
    let cwd = project("unhooked", 1);
    let session = cwd.path().join("session.jsonl");
    write(
        &session,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
    );
    let input = json!({
        "cwd": cwd.path().to_string_lossy(),
        "transcript_path": session.to_string_lossy(),
    })
    .to_string();
    let output = run_hook(home.path(), "claude-stop", &input);
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success(),
        "没有守护进程时应以 0 退出:{stdout}"
    );
    assert!(stdout.contains("守护进程没有运行"), "{stdout}");
}

/// 守护进程在跑时,`kb hooks install` 与 `kb project remove` 都要能用。
///
/// 旧实现这两个命令只走嵌入式模式,拿不到 `run/daemon.lock` 就直接拒绝,
/// 逼用户停服才能装 hook / 删项目。
#[test]
fn hooks_and_project_remove_work_while_the_daemon_runs() {
    let home = home_with("[\"stdio\"]");
    let cwd = project("hooked", 1);
    // hooks 只装在 git 项目上
    for args in [
        vec!["init", "-q"],
        vec!["add", "-A"],
        vec!["commit", "-qm", "init"],
    ] {
        let status = Command::new("git")
            .env_remove("GIT_CONFIG_COUNT")
            .env_remove("GIT_CONFIG_KEY_0")
            .env_remove("GIT_CONFIG_VALUE_0")
            .args(["-c", "user.email=e2e@example.com", "-c", "user.name=e2e"])
            .args(&args)
            .current_dir(cwd.path())
            .status()
            .expect("跑 git");
        assert!(status.success(), "git {args:?} 失败");
    }

    // 守护进程起来之前先登记项目(project add 需要写锁)
    let added = kb()
        .env("KB_HOME", home.path())
        .args(["project", "add", "--name", "hooked"])
        .arg(cwd.path())
        .output()
        .expect("kb project add");
    assert!(
        added.status.success(),
        "登记项目失败:{}",
        String::from_utf8_lossy(&added.stderr)
    );

    let mut daemon = Daemon::start_in(home, cwd.path(), None);

    // 守护进程在跑:hooks install / uninstall 走 UDS,不再要求停服
    let installed = kb()
        .env("KB_HOME", daemon.home.path())
        .args(["hooks", "install", "hooked"])
        .output()
        .expect("kb hooks install");
    let stdout = String::from_utf8_lossy(&installed.stdout);
    let stderr = String::from_utf8_lossy(&installed.stderr);
    assert!(
        installed.status.success(),
        "守护进程在跑时 hooks install 应成功:{stdout}{stderr}"
    );
    assert!(stdout.contains("已安装"), "{stdout}{stderr}");
    assert!(
        cwd.path().join(".git/hooks/post-commit").exists(),
        "post-commit 应落盘"
    );

    // 守护进程在跑:project remove 也走 UDS
    let removed = kb()
        .env("KB_HOME", daemon.home.path())
        .args(["project", "remove", "hooked"])
        .output()
        .expect("kb project remove");
    assert!(
        removed.status.success(),
        "守护进程在跑时 project remove 应成功:{}",
        String::from_utf8_lossy(&removed.stderr)
    );
    assert!(daemon.alive(), "删项目不该让守护进程退出");

    let (status, body) = uds_call(
        daemon.home.path(),
        "/api/v1/capabilities/list_projects",
        &[],
        "{}",
    );
    assert_eq!(status, 200, "{body}");
    assert!(!body.contains("hooked"), "项目应已删除:{body}");
}

/// 守护进程启动时就把 `_global` 建好(优化项)。
///
/// 否则每次检索都会因为“目标 collection 不存在”打一条 WARN,全局经验也要等第一次保存才懒创建。
#[test]
fn daemon_creates_the_global_collection_on_start() {
    let home = home_with("[\"stdio\"]");
    let cwd = tempfile::tempdir().expect("cwd");
    let mut daemon = Daemon::start_in(home, cwd.path(), None);
    let (status, body) = uds_call(
        daemon.home.path(),
        "/api/v1/capabilities/list_collections",
        &[],
        "{}",
    );
    assert_eq!(status, 200, "{body}");
    assert!(body.contains("\"_global\""), "启动后应有 _global:{body}");
    assert!(daemon.alive());
}
