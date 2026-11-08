//! 四套端到端测试共用的守护进程夹具。
//!
//! 启动完成的标准是 UDS 能连上,并且 `run/listen` 已经写成实际端口。
//! 只看到 socket 文件存在不算:绑定 TCP 失败时文件会留下来,下一次调用是 Connection refused。
//!
//! 每套测试只用到其中一部分方法,其余在那个测试包里看起来像没人调用。
#![allow(dead_code)]

use std::fs::File;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use kb_mcp::uds::UdsClient;
use serde_json::Value;

/// 拉起 `kb daemon` 的附加参数。
#[derive(Default)]
pub struct Spawn<'a> {
    /// 工作目录。空则夹具自己建一个,并留到进程退出。
    pub cwd: Option<&'a Path>,
    /// `KB_DAEMON_GRACE_SECS`。
    pub grace_secs: Option<u64>,
    /// 额外环境变量。
    pub env: &'a [(&'a str, &'a str)],
}

/// 一个已经开始监听的测试守护进程。
pub struct Daemon {
    pub child: Child,
    /// 让 KB_HOME 活到测试结束。
    pub home: tempfile::TempDir,
    /// 夹具自己建的工作目录。调用方传入的 cwd 由调用方持有。
    #[allow(dead_code)]
    own_cwd: Option<tempfile::TempDir>,
    pub socket: PathBuf,
    stderr_path: PathBuf,
}

impl Daemon {
    /// 在临时工作目录里启动。
    pub fn start(home: tempfile::TempDir) -> Self {
        Self::spawn(home, Spawn::default())
    }

    /// 指定工作目录和关闭宽限期(作用域 / 信号测试用)。
    pub fn start_in(home: tempfile::TempDir, cwd: &Path, grace_secs: Option<u64>) -> Self {
        Self::spawn(
            home,
            Spawn {
                cwd: Some(cwd),
                grace_secs,
                env: &[],
            },
        )
    }

    /// 按给定参数启动,等到 UDS 可连且 `run/listen` 已写出。
    pub fn spawn(home: tempfile::TempDir, opts: Spawn<'_>) -> Self {
        let own_cwd = opts
            .cwd
            .is_none()
            .then(|| tempfile::tempdir().expect("cwd"));
        let cwd = opts
            .cwd
            .unwrap_or_else(|| own_cwd.as_ref().expect("cwd").path());
        let stderr_path = home.path().join("daemon.stderr");
        let stderr = File::create(&stderr_path).expect("stderr");
        let mut command = kb();
        command
            .env("KB_HOME", home.path())
            .arg("daemon")
            .current_dir(cwd)
            .stdout(Stdio::null())
            .stderr(Stdio::from(stderr));
        if let Some(grace) = opts.grace_secs {
            command.env("KB_DAEMON_GRACE_SECS", grace.to_string());
        }
        for (key, value) in opts.env {
            command.env(key, value);
        }
        let mut child = command.spawn().expect("启动守护进程");
        let socket = home.path().join("run/kb.sock");
        let listen = home.path().join("run/listen");
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            if let Some(status) = child.try_wait().expect("查询守护进程状态") {
                panic!(
                    "守护进程启动失败 status={status}\n{}",
                    stderr_tail(&stderr_path)
                );
            }
            let listening = UnixStream::connect(&socket).is_ok();
            if listening && listen.is_file() {
                break;
            }
            if Instant::now() >= deadline {
                let status = child.try_wait().ok().flatten();
                let _ = child.kill();
                let _ = child.wait();
                panic!(
                    "守护进程没有开始监听 status={status:?}\n{}",
                    stderr_tail(&stderr_path)
                );
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Self {
            child,
            home,
            own_cwd,
            socket,
            stderr_path,
        }
    }

    /// `run/listen` 里的 `IP:端口`。
    pub fn listen_addr(&self) -> String {
        std::fs::read_to_string(self.home.path().join("run/listen"))
            .expect("listen")
            .trim()
            .to_owned()
    }

    /// 实际绑定的 TCP 端口。
    pub fn tcp_port(&self) -> u16 {
        self.listen_addr()
            .rsplit(':')
            .next()
            .and_then(|port| port.parse().ok())
            .unwrap_or_else(|| panic!("监听地址不是 IP:端口"))
    }

    /// UDS 上的能力客户端。
    pub fn client(&self) -> UdsClient {
        UdsClient::new(&self.socket)
    }

    /// 进程是否还在。
    pub fn alive(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }

    /// UDS 健康检查的 HTTP 状态码。连不上就是 `None`。
    pub fn health(&self) -> Option<u16> {
        let mut stream = UnixStream::connect(&self.socket).ok()?;
        stream
            .write_all(
                b"GET /api/v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
            )
            .ok()?;
        let mut raw = String::new();
        stream.read_to_string(&mut raw).ok()?;
        raw.split_whitespace().nth(1)?.parse().ok()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        match self.child.try_wait() {
            Ok(Some(status)) => {
                eprintln!(
                    "守护进程已退出 status={status}\n{}",
                    stderr_tail(&self.stderr_path)
                );
            }
            _ => {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }
}

pub fn kb() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kb"))
}

fn stderr_tail(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut lines: Vec<&str> = text.lines().collect();
    let skip = lines.len().saturating_sub(40);
    lines.drain(..skip);
    let tail = lines.join("\n");
    if tail.chars().count() > 4000 {
        tail.chars().skip(tail.chars().count() - 4000).collect()
    } else {
        tail
    }
}

// ---------------------------------------------------------------- 原始 HTTP / 建用户

pub fn create_user(home: &std::path::Path, name: &str, password: &str) {
    let mut child = kb()
        .env("KB_HOME", home)
        .args(["user", "create", name, "--role", "user"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("kb user create");
    child
        .stdin
        .take()
        .expect("stdin")
        .write_all(format!("{password}\n").as_bytes())
        .expect("写密码");
    let output = child.wait_with_output().expect("等待");
    assert!(
        output.status.success(),
        "建用户 {name} 失败:{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

/// 原始 HTTP(UDS)。
pub fn uds(daemon: &Daemon, method: &str, path: &str, body: Value) -> (u16, Value) {
    let mut stream = std::os::unix::net::UnixStream::connect(&daemon.socket).expect("连接 UDS");
    let payload = body.to_string();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes()).expect("写请求");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("读响应");
    parse(&raw).into_pair()
}

/// 原始 HTTP(TCP)。返回 (状态码, 响应头, 响应体 JSON)。
pub fn http(
    port: u16,
    method: &str,
    path: &str,
    session: Option<&str>,
    body: Option<Value>,
) -> (u16, String, Value) {
    http_with(port, method, path, session, body, &[])
}

/// 同 [`http`],可以带额外的请求头(例如 `X-KB-Space`)。
pub fn http_with(
    port: u16,
    method: &str,
    path: &str,
    session: Option<&str>,
    body: Option<Value>,
    extra: &[(&str, &str)],
) -> (u16, String, Value) {
    let extra: String = extra
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连接 TCP");
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    let payload = body.map(|value| value.to_string()).unwrap_or_default();
    let cookie = session
        .map(|token| format!("Cookie: kb_session={token}\r\n"))
        .unwrap_or_default();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-KB-CSRF: 1\r\n{cookie}{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes()).expect("写请求");
    let mut raw = String::new();
    stream.read_to_string(&mut raw).expect("读响应");
    let parsed = parse(&raw);
    (parsed.status, parsed.headers, parsed.body)
}

/// 原始 HTTP(TCP),请求体和响应体都是原始字节(头像上传 / 下载用)。
/// 返回 (状态码, 响应头文本, 响应体字节);头不带 `Content-Type: application/json`,由调用方指定。
pub fn http_bytes(
    port: u16,
    method: &str,
    path: &str,
    session: Option<&str>,
    content_type: &str,
    body: &[u8],
) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连接 TCP");
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    let cookie = session
        .map(|token| format!("Cookie: kb_session={token}\r\n"))
        .unwrap_or_default();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-KB-CSRF: 1\r\n{cookie}Content-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).expect("写请求头");
    stream.write_all(body).expect("写请求体");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("读响应");
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("响应里有头和体的分隔");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut payload = raw[split + 4..].to_vec();
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        payload = dechunk_bytes(&payload);
    }
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    (status, head, payload)
}

fn dechunk_bytes(body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = body;
    while let Some(line_end) = rest.windows(2).position(|w| w == b"\r\n") {
        let Ok(size) = usize::from_str_radix(String::from_utf8_lossy(&rest[..line_end]).trim(), 16)
        else {
            break;
        };
        let start = line_end + 2;
        if size == 0 || rest.len() < start + size {
            break;
        }
        out.extend_from_slice(&rest[start..start + size]);
        rest = rest[start + size..]
            .strip_prefix(b"\r\n")
            .unwrap_or(&rest[start + size..]);
    }
    out
}

struct Parsed {
    status: u16,
    headers: String,
    body: Value,
}

impl Parsed {
    fn into_pair(self) -> (u16, Value) {
        (self.status, self.body)
    }
}

fn parse(raw: &str) -> Parsed {
    let (head, body) = raw.split_once("\r\n\r\n").unwrap_or((raw, ""));
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    // 响应体可能是 chunked:拼出所有分块里的 JSON
    let body = if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        dechunk(body)
    } else {
        body.to_owned()
    };
    Parsed {
        status,
        headers: head.to_owned(),
        body: serde_json::from_str(body.trim()).unwrap_or(Value::Null),
    }
}

fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    while let Some((size_line, tail)) = rest.split_once("\r\n") {
        let Ok(size) = usize::from_str_radix(size_line.trim(), 16) else {
            break;
        };
        if size == 0 || tail.len() < size {
            break;
        }
        out.push_str(&tail[..size]);
        rest = tail[size..].trim_start_matches("\r\n");
    }
    out
}

/// 把 tar.gz 读成 `(成员名, 内容)`(够用的 ustar 读取器,含 GNU `@LongLink`;不为测试加依赖)。
pub fn read_tar_gz(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut raw = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(bytes), &mut raw)
        .expect("解压 tar.gz");
    let mut members = Vec::new();
    let mut offset = 0;
    let mut long_name: Option<String> = None;
    while offset + 512 <= raw.len() {
        let header = &raw[offset..offset + 512];
        if header.iter().all(|byte| *byte == 0) {
            break;
        }
        let text = |range: std::ops::Range<usize>| {
            String::from_utf8_lossy(&header[range])
                .trim_end_matches('\0')
                .trim()
                .to_owned()
        };
        let size = usize::from_str_radix(&text(124..136), 8).expect("成员大小");
        let kind = header[156];
        let name = {
            let prefix = text(345..500);
            let base = text(0..100);
            if prefix.is_empty() {
                base
            } else {
                format!("{prefix}/{base}")
            }
        };
        offset += 512;
        let body = raw[offset..offset + size].to_vec();
        offset += size.div_ceil(512) * 512;
        if kind == b'L' {
            long_name = Some(
                String::from_utf8_lossy(&body)
                    .trim_end_matches('\0')
                    .to_owned(),
            );
            continue;
        }
        members.push((long_name.take().unwrap_or(name), body));
    }
    members
}

// ---------------------------------------------------------------- 现场拼 PNG(不需要图片编码库)

pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for byte in data {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

pub fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for byte in data {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    (b << 16) | a
}

pub fn png_chunk(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
    let mut out = (data.len() as u32).to_be_bytes().to_vec();
    let mut body = kind.to_vec();
    body.extend_from_slice(data);
    out.extend_from_slice(&body);
    out.extend_from_slice(&crc32(&body).to_be_bytes());
    out
}

/// 现场拼一张 `w×h` 的纯灰 PNG(不压缩的 zlib 块),不需要图片编码库。
pub fn gray_png(w: u32, h: u32, level: u8) -> Vec<u8> {
    let mut raw = Vec::new();
    for _ in 0..h {
        raw.push(0); // 过滤方式:无
        raw.extend(std::iter::repeat_n(level, w as usize));
    }
    let mut zlib = vec![0x78, 0x01];
    let mut rest = &raw[..];
    while !rest.is_empty() {
        let take = rest.len().min(65_535);
        let last = take == rest.len();
        zlib.push(u8::from(last));
        zlib.extend_from_slice(&(take as u16).to_le_bytes());
        zlib.extend_from_slice(&(!(take as u16)).to_le_bytes());
        zlib.extend_from_slice(&rest[..take]);
        rest = &rest[take..];
    }
    zlib.extend_from_slice(&adler32(&raw).to_be_bytes());
    let mut ihdr = w.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 0, 0, 0, 0]); // 8 位灰度
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    png.extend(png_chunk(b"IHDR", &ihdr));
    png.extend(png_chunk(b"IDAT", &zlib));
    png.extend(png_chunk(b"IEND", &[]));
    png
}

// ---------------------------------------------------------------- 多用户夹具

/// 一个起好的守护进程 + 若干已登录的用户(管理员 `admin`、`alice`、`bob`、`carol`)。
pub struct Harness {
    /// 守护进程。
    pub daemon: Daemon,
    cookies: std::collections::BTreeMap<String, String>,
    ids: std::collections::BTreeMap<String, String>,
}

impl Harness {
    /// 起进程,设管理员密码,建 alice / bob / carol 并登录。
    pub fn start() -> Self {
        Self::start_with("", |_| {})
    }

    /// 同 [`Harness::start`],但开着远程 `/mcp`(配置里启用 http 传输,并预先放好文件令牌)。
    pub fn start_with_mcp() -> Self {
        Self::start_with("[mcp]\ntransports = [\"stdio\", \"http\"]\n", |home| {
            let run = home.join("run");
            std::fs::create_dir_all(&run).expect("run 目录");
            std::fs::write(run.join("mcp-token"), "file-token-for-tests\n").expect("文件令牌");
        })
    }

    /// 起进程前可以追加配置段、预先放文件。
    pub fn start_with(extra_config: &str, prepare: impl FnOnce(&std::path::Path)) -> Self {
        Self::start_with_env(extra_config, prepare, &[])
    }

    /// 同 [`Harness::start_with`],另给守护进程(和它拉起的子进程)加环境变量。
    pub fn start_with_env(
        extra_config: &str,
        prepare: impl FnOnce(&std::path::Path),
        env: &[(&str, &str)],
    ) -> Self {
        let home = tempfile::tempdir().expect("KB_HOME");
        std::fs::write(
            home.path().join("config.toml"),
            format!(
                "[embed]\nbackend = \"fake\"\n[server]\nlisten = \"127.0.0.1:0\"\n[quota]\ndisk_reserve_gb = 0\n{extra_config}"
            ),
        )
        .expect("配置");
        prepare(home.path());
        let daemon = Daemon::spawn(
            home,
            Spawn {
                cwd: None,
                grace_secs: None,
                env,
            },
        );
        let (status, body) = uds(
            &daemon,
            "POST",
            "/api/v1/auth/password",
            serde_json::json!({ "password": "admin password 1" }),
        );
        assert_eq!(status, 200, "{body}");
        for name in ["alice", "bob", "carol"] {
            create_user(daemon.home.path(), name, &format!("{name} password 1"));
        }
        let mut harness = Self {
            daemon,
            cookies: Default::default(),
            ids: Default::default(),
        };
        for (name, password) in [
            ("admin", "admin password 1".to_owned()),
            ("alice", "alice password 1".to_owned()),
            ("bob", "bob password 1".to_owned()),
            ("carol", "carol password 1".to_owned()),
        ] {
            let cookie = harness.login(name, &password);
            let (_, _, me) = http(
                harness.port(),
                "GET",
                "/api/v1/auth/me",
                Some(&cookie),
                None,
            );
            harness.ids.insert(
                name.to_owned(),
                me["data"]["user"]["id"].as_str().expect("id").to_owned(),
            );
            harness.cookies.insert(name.to_owned(), cookie);
        }
        harness
    }

    /// TCP 端口。
    pub fn port(&self) -> u16 {
        self.daemon.tcp_port()
    }

    /// 登录,返回会话 cookie 的值。
    pub fn login(&self, name: &str, password: &str) -> String {
        let (status, headers, body) = http(
            self.port(),
            "POST",
            "/api/v1/auth/login",
            None,
            Some(serde_json::json!({ "login": name, "password": password })),
        );
        assert_eq!(status, 200, "{name} 登录失败:{body}");
        headers
            .lines()
            .find(|line| line.to_ascii_lowercase().starts_with("set-cookie:"))
            .and_then(|line| line.split_once('='))
            .map(|(_, rest)| rest.split(';').next().unwrap_or("").to_owned())
            .expect("会话 cookie")
    }

    /// 某个用户的会话 cookie。
    pub fn cookie(&self, name: &str) -> &str {
        &self.cookies[name]
    }

    /// 某个用户的 id。
    pub fn id(&self, name: &str) -> &str {
        &self.ids[name]
    }

    /// 某个用户自己的知识库 id。
    pub fn space(&self, name: &str) -> String {
        let (_, _, me) = http(
            self.port(),
            "GET",
            "/api/v1/auth/me",
            Some(self.cookie(name)),
            None,
        );
        me["data"]["user"]["space_id"]
            .as_str()
            .expect("space_id")
            .to_owned()
    }

    /// 以某人身份调能力;成功返回 `data`,失败返回整个错误体。
    pub fn call(&self, who: &str, capability: &str, args: Value) -> (u16, Value) {
        let (status, _, body) = http(
            self.port(),
            "POST",
            &format!("/api/v1/capabilities/{capability}"),
            Some(self.cookie(who)),
            Some(args),
        );
        match body.get("data") {
            Some(data) if body["ok"] == true => (status, data.clone()),
            _ => (status, body),
        }
    }

    /// 以某人身份在**别人的知识库**里调能力(请求头 `X-KB-Space`)。
    pub fn call_in(&self, who: &str, space: &str, capability: &str, args: Value) -> (u16, Value) {
        let (status, _, body) = http_with(
            self.port(),
            "POST",
            &format!("/api/v1/capabilities/{capability}"),
            Some(self.cookie(who)),
            Some(args),
            &[("X-KB-Space", space)],
        );
        match body.get("data") {
            Some(data) if body["ok"] == true => (status, data.clone()),
            _ => (status, body),
        }
    }

    /// 同 [`Self::call`],要求成功。
    pub fn ok(&self, who: &str, capability: &str, args: Value) -> Value {
        let (status, body) = self.call(who, capability, args);
        assert_eq!(status, 200, "{who} 调 {capability}:{body}");
        body
    }
}

/// 原始 HTTP(TCP),请求头完全自己给(例如只带 `Authorization: Bearer`,不带 cookie 和 CSRF 头),
/// 响应体按字节原样返回(Markdown、二进制都能收)。返回 `(状态码, 响应头文本, 响应体字节)`。
pub fn http_raw(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> (u16, String, Vec<u8>) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连接 TCP");
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    let payload = body.map(|value| value.to_string()).unwrap_or_default();
    let extra: String = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes()).expect("写请求");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).expect("读响应");
    let split = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .expect("响应里有头和体的分隔");
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let mut body = raw[split + 4..].to_vec();
    if head
        .to_ascii_lowercase()
        .contains("transfer-encoding: chunked")
    {
        body = dechunk_bytes(&body);
    }
    let status = head
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse().ok())
        .unwrap_or(0);
    (status, head, body)
}

/// 原始 HTTP(TCP),完全自己控制请求头(游客 cookie、有没有 CSRF 头)。返回 `(状态码, 响应头文本, JSON 体)`。
pub fn http_headers(
    port: u16,
    method: &str,
    path: &str,
    headers: &[(&str, &str)],
    body: Option<Value>,
) -> (u16, String, Value) {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连接 TCP");
    stream.set_read_timeout(Some(Duration::from_secs(60))).ok();
    let payload = body.map(|value| value.to_string()).unwrap_or_default();
    let extra: String = headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();
    let request = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{extra}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        payload.len()
    );
    stream.write_all(request.as_bytes()).expect("写请求");
    // 原件接口返回的是二进制(图片等):按字节读,再宽松转成文本,只用来看状态和响应头
    let mut bytes = Vec::new();
    stream.read_to_end(&mut bytes).expect("读响应");
    let raw = String::from_utf8_lossy(&bytes);
    let parsed = parse(&raw);
    (parsed.status, parsed.headers, parsed.body)
}

/// 从响应头文本里取某个 cookie 的值(`Set-Cookie: name=value; …`)。
pub fn set_cookie_value(headers: &str, name: &str) -> Option<String> {
    headers.lines().find_map(|line| {
        let rest = line
            .strip_prefix("set-cookie:")
            .or_else(|| line.strip_prefix("Set-Cookie:"))?;
        let (key, value) = rest.trim().split_once('=')?;
        (key == name).then(|| value.split(';').next().unwrap_or("").to_owned())
    })
}

// ---------------------------------------------------------------- 协作:WebSocket + Yjs 客户端

pub mod collab {
    //! 模拟浏览器里的协作客户端:真实的 WebSocket 连接 + 真实的 Yjs 文档,走真实守护进程。

    use std::net::TcpStream;
    use std::time::{Duration, Instant};

    use kb_collab::core::{CTRL_CLIENT, CTRL_SERVER, base64_encode};
    use serde_json::Value;
    use tungstenite::client::IntoClientRequest;
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::{Message as WsMessage, WebSocket};
    use yrs::sync::protocol::{Message, MessageReader, SyncMessage};
    use yrs::updates::decoder::{Decode, DecoderV1};
    use yrs::updates::encoder::Encode;
    use yrs::{
        Doc, GetString, OffsetKind, Options, ReadTxn, StateVector, Transact, Update,
        XmlElementPrelim, XmlFragment, XmlTextPrelim,
    };

    /// 握手结果:连上了,或者被 HTTP 状态码拒绝。
    pub enum Connect {
        /// 连上了。
        Open(Box<CollabClient>),
        /// 握手被拒(升级前的 HTTP 响应)。
        Refused(u16),
    }

    /// 一个协作客户端。
    pub struct CollabClient {
        socket: WebSocket<MaybeTlsStream<TcpStream>>,
        /// 本地的 Yjs 文档。
        pub doc: Doc,
        /// 收到的控制消息(服务端 → 客户端)。
        pub ctrl: Vec<Value>,
        /// 服务端关闭连接时的 (码, 原因)。
        pub closed: Option<(u16, String)>,
    }

    /// 连接协作端点。`path` 含查询串;`headers` 是额外请求头(Cookie、Origin……)。
    pub fn connect(port: u16, path: &str, headers: &[(&str, &str)]) -> Connect {
        let url = format!("ws://127.0.0.1:{port}{path}");
        let mut request = url.into_client_request().expect("请求");
        for (name, value) in headers {
            request.headers_mut().insert(
                tungstenite::http::HeaderName::from_bytes(name.as_bytes()).unwrap(),
                tungstenite::http::HeaderValue::from_str(value).unwrap(),
            );
        }
        let stream = TcpStream::connect(("127.0.0.1", port)).expect("连接");
        // 握手阶段给足时间:压测时几百个连接同时握手,200 毫秒的读超时会让握手被打断(Interrupted)
        stream.set_read_timeout(Some(Duration::from_secs(20))).ok();
        match tungstenite::client(request, MaybeTlsStream::Plain(stream)) {
            Ok((socket, _response)) => {
                // 握手完成后恢复成短超时:之后的读取靠它轮询
                if let MaybeTlsStream::Plain(inner) = socket.get_ref() {
                    inner
                        .set_read_timeout(Some(Duration::from_millis(200)))
                        .ok();
                }
                let doc = Doc::with_options(Options {
                    offset_kind: OffsetKind::Utf16,
                    ..Options::default()
                });
                let mut client = CollabClient {
                    socket,
                    doc,
                    ctrl: Vec::new(),
                    closed: None,
                };
                // 和 y-websocket 一样:连上就发 SyncStep1
                let sv = client.doc.transact().state_vector();
                client.send(&Message::Sync(SyncMessage::SyncStep1(sv)));
                Connect::Open(Box::new(client))
            }
            Err(tungstenite::HandshakeError::Failure(tungstenite::Error::Http(response))) => {
                Connect::Refused(response.status().as_u16())
            }
            Err(other) => panic!("握手失败:{other:?}"),
        }
    }

    impl CollabClient {
        fn send(&mut self, message: &Message) {
            let _ = self
                .socket
                .send(WsMessage::Binary(message.encode_v1().into()));
        }

        /// 发控制消息(初始化完成、落地、保存点……)。
        pub fn send_ctrl(&mut self, body: Value) {
            let bytes = Message::Custom(CTRL_CLIENT, serde_json::to_vec(&body).unwrap());
            self.send(&bytes);
        }

        /// 读取并处理服务端发来的所有内容,直到安静 `quiet` 这么久或超过 `limit`。
        pub fn pump(&mut self, quiet: Duration, limit: Duration) {
            let started = Instant::now();
            let mut last_activity = Instant::now();
            while started.elapsed() < limit && last_activity.elapsed() < quiet {
                match self.socket.read() {
                    Ok(WsMessage::Binary(bytes)) => {
                        last_activity = Instant::now();
                        self.handle(&bytes);
                    }
                    Ok(WsMessage::Close(frame)) => {
                        self.closed = frame.map(|f| (u16::from(f.code), f.reason.to_string()));
                        if self.closed.is_none() {
                            self.closed = Some((1005, String::new()));
                        }
                        return;
                    }
                    Ok(_) => last_activity = Instant::now(),
                    Err(tungstenite::Error::Io(err))
                        if matches!(
                            err.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(
                        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed,
                    ) => {
                        self.closed.get_or_insert((1006, "连接已关闭".to_owned()));
                        return;
                    }
                    Err(_) => {
                        self.closed.get_or_insert((1006, "读取出错".to_owned()));
                        return;
                    }
                }
            }
        }

        /// 调整读超时(压测要毫秒级的响应粒度,默认的 200 毫秒会把延迟量化掉)。
        pub fn set_read_timeout(&mut self, timeout: Duration) {
            if let MaybeTlsStream::Plain(stream) = self.socket.get_mut() {
                stream.set_read_timeout(Some(timeout)).ok();
            }
        }

        /// 默认节奏:安静 300 毫秒或最多 3 秒。
        pub fn settle(&mut self) {
            self.pump(Duration::from_millis(300), Duration::from_secs(3));
        }

        fn handle(&mut self, bytes: &[u8]) {
            let mut decoder = DecoderV1::new(yrs::encoding::read::Cursor::new(bytes));
            let reader = MessageReader::new(&mut decoder);
            let mut replies = Vec::new();
            for message in reader {
                match message.expect("服务端消息可解码") {
                    Message::Sync(SyncMessage::SyncStep1(sv)) => {
                        let update = self.doc.transact().encode_state_as_update_v1(&sv);
                        replies.push(Message::Sync(SyncMessage::SyncStep2(update)));
                    }
                    Message::Sync(SyncMessage::SyncStep2(update) | SyncMessage::Update(update)) => {
                        let update = Update::decode_v1(&update).expect("更新可解码");
                        self.doc
                            .transact_mut()
                            .apply_update(update)
                            .expect("应用更新");
                    }
                    Message::Custom(CTRL_SERVER, body) => {
                        self.ctrl
                            .push(serde_json::from_slice(&body).expect("控制消息是 JSON"));
                    }
                    _ => {}
                }
            }
            for reply in replies {
                self.send(&reply);
            }
        }

        /// 最近一条某类型的控制消息。
        pub fn last_ctrl(&self, kind: &str) -> Option<&Value> {
            self.ctrl.iter().rev().find(|c| c["type"] == kind)
        }

        /// 往笔记根节点末尾加一个段落并发出去(像在 Milkdown 里敲了一段话)。
        pub fn add_paragraph(&mut self, text: &str) {
            let before = self.doc.transact().state_vector();
            {
                let root = self.doc.get_or_insert_xml_fragment("prosemirror");
                let mut txn = self.doc.transact_mut();
                let paragraph = root.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
                paragraph.push_back(&mut txn, XmlTextPrelim::new(text));
            }
            self.push_since(&before);
        }

        fn push_since(&mut self, before: &StateVector) {
            let update = self.doc.transact().encode_state_as_update_v1(before);
            self.send(&Message::Sync(SyncMessage::Update(update)));
        }

        /// 纯文本房间(代码 / 文本文件)现在的内容。
        pub fn text(&self) -> String {
            let root = self.doc.get_or_insert_text("text");
            let txn = self.doc.transact();
            root.get_string(&txn)
        }

        /// 在纯文本房间末尾敲一段字并发出去。
        pub fn type_at_end(&mut self, text: &str) {
            use yrs::Text;
            let before = self.doc.transact().state_vector();
            {
                let root = self.doc.get_or_insert_text("text");
                let mut txn = self.doc.transact_mut();
                let end = root.len(&txn);
                root.insert(&mut txn, end, text);
            }
            self.push_since(&before);
        }

        /// 笔记内容的字符串形式。
        pub fn rich_text(&self) -> String {
            let root = self.doc.get_or_insert_xml_fragment("prosemirror");
            let txn = self.doc.transact();
            root.get_string(&txn)
        }

        /// 作为初始化者:按服务端 hello 里给的 Markdown 放一个段落,并报告完成。
        pub fn initialize(&mut self) {
            let init = self
                .last_ctrl("hello")
                .and_then(|hello| hello["init"].as_str())
                .expect("被指定为初始化者")
                .to_owned();
            self.add_paragraph(&init);
            self.send_ctrl(serde_json::json!({ "type": "init_done" }));
        }

        /// 作为落地者提交 Markdown 和当前状态向量。
        pub fn land(&mut self, markdown: &str) {
            let sv = base64_encode(&self.doc.transact().state_vector().encode_v1());
            self.send_ctrl(serde_json::json!({ "type": "land", "markdown": markdown, "sv": sv }));
        }

        /// 主动关闭。
        pub fn close(mut self) {
            let _ = self.socket.close(None);
        }
    }
}
