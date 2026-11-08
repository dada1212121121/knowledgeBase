//! 办公文档多人实时协同在守护进程里的部分。
//!
//! 守护进程只做三件事:鉴权之后把浏览器的 y-sync 帧转给 office-worker、把 office-worker 要发的帧转给浏览器、
//! 替 office-worker 落地(写回文件、版本、重新索引)和持久化增量。CRDT 只在 office-worker 里应用一次。
//!
//! office-worker 是按需启动的 Node 子进程(`office-worker/src/index.mjs`),标准输入输出上走长度前缀帧:
//! u32 总长、u32 JSON 长度、JSON、二进制载荷。它没有房间 5 分钟就自己退出;进程意外退出时所有连接收到 1012,
//! 浏览器自动重连,房间按「底稿 + 持久化的增量」重新打开,谁的修改都不丢。
//!
//! 性能:
//! - 新人加入只下载房间底稿的原字节(按内容寻址,浏览器可以永久缓存),不下载几十 MB 的完整状态(xlsx 的状态是文件的约 25 倍);
//! - 持久化只存增量,按到达顺序一个后台任务写;关房间(内容已落地)时清掉;
//! - 一次协同会话的多次落地合并成一个版本(`land_session`);重新索引(嵌入)停手 30 秒后才做;
//! - 同一份底稿的无损检查只做一次(按内容哈希记住结论)。

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use async_trait::async_trait;
use kb_collab::Access;
use kb_core::config::ConfigStore;
use kb_core::share::{DocRef as ShareDoc, ResourceKey};
use kb_core::{KbError, Result};
use kb_web::office_ws::{OfficeCollabApi, OfficeConn, OfficeConnHandle, OfficeOut, OfficeUser};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::spaces::SpaceRegistry;

/// 每条浏览器连接的发送队列:满了说明这条连接太慢,断开让它重连补齐,不能让它拖住别人。
const CONN_QUEUE: usize = 512;
/// 等 office-worker 启动 / 打开房间 / 回答的最长时间。
const WORKER_TIMEOUT: Duration = Duration::from_secs(60);
/// 落地之后多久没有新的落地才重新索引(嵌入很贵,别边打字边算)。
const REINDEX_DEBOUNCE: Duration = Duration::from_secs(30);
/// xlsx 超过这个大小不开协同:引擎的协同状态约是文件的 25 倍,2.3 MB 的表格已经超出它 64 MiB 的上限(实测)。
pub const XLSX_COLLAB_MAX_BYTES: u64 = 1536 * 1024;

/// 支持协同的格式。
fn format_of(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    match extension.as_str() {
        "xlsx" => Some("xlsx"),
        "pptx" => Some("pptx"),
        "docx" => Some("docx"),
        _ => None,
    }
}

fn file_of(key: &ResourceKey) -> Result<(&str, &str)> {
    match key {
        ResourceKey::Doc {
            name,
            doc: ShareDoc::File(path),
            ..
        } => Ok((name.as_str(), path.as_str())),
        _ => Err(KbError::InvalidInput("只有文件能协同编辑".to_owned())),
    }
}

/// 持久化表里的文档 id:和笔记 / 文本文件的协作状态分开,不会被它们的清理逻辑当成认识的键。
fn store_id(key: &ResourceKey) -> String {
    format!("office|{key}")
}

/// 帧:u32 总长(大端)、u32 JSON 长度、JSON、二进制载荷。
fn encode_frame(meta: &Value, body: &[u8]) -> Vec<u8> {
    let json = serde_json::to_vec(meta).unwrap_or_default();
    let total = 4 + json.len() + body.len();
    let mut out = Vec::with_capacity(4 + total);
    out.extend_from_slice(&(total as u32).to_be_bytes());
    out.extend_from_slice(&(json.len() as u32).to_be_bytes());
    out.extend_from_slice(&json);
    out.extend_from_slice(body);
    out
}

/// 无损检查的结论(按底稿的内容哈希记住)。
#[derive(Clone, Debug)]
struct Verdict {
    lossless: bool,
    /// 不无损但包是完整的、没有丢部件:用户确认后可以编辑(和单人编辑的「仍然编辑」一样)。
    forceable: bool,
    report: Value,
}

struct Room {
    key: ResourceKey,
    format: &'static str,
    base_sha: String,
    base_size: u64,
    session: String,
    /// office-worker 里的房间开着(进程重启后为假,下一次加入时重开)。
    open: bool,
    generation: u64,
    writable: bool,
    verdict: Verdict,
    landed_sha: String,
    authors: BTreeSet<String>,
    conns: HashSet<u64>,
    dirty: bool,
}

struct Conn {
    room: String,
    user: OfficeUser,
    tx: mpsc::Sender<OfficeOut>,
}

struct Worker {
    generation: u64,
    stdin: mpsc::UnboundedSender<Vec<u8>>,
}

impl Worker {
    fn send(&self, meta: Value, body: &[u8]) {
        let _ = self.stdin.send(encode_frame(&meta, body));
    }
}

/// 等房间打开的人:打开成功拿到「不改直接保存」的字节(要做无损检查时),失败拿到原因。
type OpenWaiter = oneshot::Sender<std::result::Result<Vec<u8>, String>>;

#[derive(Default)]
struct State {
    rooms: HashMap<String, Room>,
    conns: HashMap<u64, Conn>,
    opening: HashMap<String, Vec<OpenWaiter>>,
    rpc: HashMap<u64, oneshot::Sender<(Value, Vec<u8>)>>,
    verdicts: HashMap<String, Verdict>,
    reindex: HashMap<String, tokio::task::JoinHandle<()>>,
}

enum Persist {
    Append {
        space: String,
        doc: String,
        kind: String,
        update: Vec<u8>,
        user: String,
    },
    Reset {
        space: String,
        doc: String,
    },
    /// office-worker 把已存的增量合并成了一份(相对底稿):替换快照、清掉已并入的增量。
    /// 和 `Append` 走同一条队列,顺序在它之前的增量之后,不会删掉还没并入的。
    Compact {
        space: String,
        doc: String,
        kind: String,
        snapshot: Vec<u8>,
    },
}

/// 守护进程这一侧的协同管理。
pub struct OfficeCollab {
    spaces: Arc<SpaceRegistry>,
    config: Arc<ConfigStore>,
    worker: kb_service::supervise::Slot<Arc<Worker>>,
    state: StdMutex<State>,
    next_id: AtomicU64,
    persist: mpsc::UnboundedSender<Persist>,
}

impl OfficeCollab {
    /// 构造;持久化的后台任务随之启动。
    pub fn new(spaces: Arc<SpaceRegistry>, config: Arc<ConfigStore>) -> Arc<Self> {
        let (persist, mut jobs) = mpsc::unbounded_channel::<Persist>();
        let this = Arc::new(Self {
            spaces: spaces.clone(),
            config,
            worker: kb_service::supervise::Slot::new(),
            state: StdMutex::new(State::default()),
            next_id: AtomicU64::new(1),
            persist,
        });
        // 增量按到达顺序写:恢复房间时按这个顺序补回去
        tokio::spawn(async move {
            while let Some(job) = jobs.recv().await {
                let (space, result) = match &job {
                    Persist::Append {
                        space,
                        doc,
                        kind,
                        update,
                        user,
                    } => {
                        let at = chrono::Utc::now().timestamp_millis();
                        let result = match spaces.get(space).await {
                            Ok(runtime) => {
                                runtime
                                    .meta
                                    .collab_append(doc, kind, update, user, at)
                                    .await
                            }
                            Err(err) => Err(err),
                        };
                        (space.clone(), result)
                    }
                    Persist::Reset { space, doc } => {
                        let result = match spaces.get(space).await {
                            Ok(runtime) => runtime.meta.collab_reset(doc).await.map(|_| ()),
                            Err(err) => Err(err),
                        };
                        (space.clone(), result)
                    }
                    Persist::Compact {
                        space,
                        doc,
                        kind,
                        snapshot,
                    } => {
                        let at = chrono::Utc::now().timestamp_millis();
                        let result = match spaces.get(space).await {
                            Ok(runtime) => {
                                runtime.meta.collab_compact(doc, kind, snapshot, at).await
                            }
                            Err(err) => Err(err),
                        };
                        (space.clone(), result)
                    }
                };
                if let Err(err) = result {
                    tracing::warn!(space = %space, error = %err, "办公文档协同的增量没能写进库");
                }
            }
        });
        this
    }

    fn id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// office-worker 在哪:`KB_OFFICE_WORKER_DIR` → `[office] worker_dir` → 可执行文件旁边的 `../src/office-worker`
    /// (生产布局)→ 源码树里的 `office-worker`(开发、测试)。要有入口脚本和装好的引擎依赖。
    fn locate(&self) -> Option<(String, PathBuf)> {
        let config = self.config.get();
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(dir) = std::env::var("KB_OFFICE_WORKER_DIR") {
            candidates.push(dir.into());
        }
        if let Some(dir) = &config.office.worker_dir {
            candidates.push(dir.into());
        }
        if let Ok(exe) = std::env::current_exe()
            && let Some(bin) = exe.parent()
        {
            candidates.push(bin.join("../src/office-worker"));
        }
        candidates.push(PathBuf::from(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../office-worker"
        )));
        let dir = candidates.into_iter().find(|dir| {
            dir.join("src/index.mjs").is_file()
                && dir
                    .join("node_modules/@betteroffice/xlsx/package.json")
                    .is_file()
        })?;
        Some((config.office.node.clone(), dir.join("src/index.mjs")))
    }

    async fn worker(self: &Arc<Self>) -> Result<Arc<Worker>> {
        let mut guard = self.worker.lock().await;
        if let Some(worker) = guard.as_ref().map(|entry| &entry.value)
            && !worker.stdin.is_closed()
        {
            return Ok(worker.clone());
        }
        let Some((node, script)) = self.locate() else {
            return Err(KbError::Unavailable(
                "办公文档协同服务没有安装(office-worker)".to_owned(),
            ));
        };
        let mut child = tokio::process::Command::new(&node)
            .arg(&script)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|err| KbError::Unavailable(format!("启动协同服务({node})失败: {err}")))?;
        let generation = self.worker.next_generation();
        let mut stdin = child.stdin.take().expect("stdin");
        let mut stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                if stdin.write_all(&frame).await.is_err() {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                tracing::info!(target: "office_worker", "{line}");
            }
        });
        let (ready_tx, ready_rx) = oneshot::channel::<()>();
        let this = self.clone();
        tokio::spawn(async move {
            let mut ready = Some(ready_tx);
            let mut buffer: Vec<u8> = Vec::new();
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                let read = match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => read,
                };
                buffer.extend_from_slice(&chunk[..read]);
                while buffer.len() >= 8 {
                    let total = u32::from_be_bytes(buffer[..4].try_into().unwrap()) as usize;
                    if buffer.len() < 4 + total {
                        break;
                    }
                    let json_len = u32::from_be_bytes(buffer[4..8].try_into().unwrap()) as usize;
                    if json_len > total.saturating_sub(4) {
                        tracing::error!("协同服务发来坏帧");
                        buffer.clear();
                        break;
                    }
                    let meta: Value =
                        serde_json::from_slice(&buffer[8..8 + json_len]).unwrap_or(Value::Null);
                    let body = buffer[8 + json_len..4 + total].to_vec();
                    buffer.drain(..4 + total);
                    if meta["t"] == "ready" {
                        if let Some(ready) = ready.take() {
                            let _ = ready.send(());
                        }
                        continue;
                    }
                    this.dispatch(generation, meta, body);
                }
            }
            this.worker_gone(generation).await;
            let _ = child.wait().await;
        });
        tokio::time::timeout(WORKER_TIMEOUT, ready_rx)
            .await
            .map_err(|_| KbError::Unavailable("协同服务启动超时".to_owned()))?
            .map_err(|_| KbError::Unavailable("协同服务启动后马上退出了".to_owned()))?;
        let worker = Arc::new(Worker {
            generation,
            stdin: tx,
        });
        *guard = Some(kb_service::supervise::Entry {
            generation,
            value: worker.clone(),
        });
        Ok(worker)
    }

    /// office-worker 退出了(空闲退出或崩溃):这一代的房间都标成没开,连接都断开让浏览器重连。
    async fn worker_gone(&self, generation: u64) {
        // 只有「还是这一代」才算数:拉起重试之后旧进程晚到的退出通知不能清掉新进程。
        self.worker.retire(generation).await;
        let mut state = self.state.lock().unwrap();
        let mut closing: Vec<u64> = Vec::new();
        for room in state.rooms.values_mut() {
            if room.generation == generation {
                room.open = false;
                closing.extend(room.conns.drain());
            }
        }
        for conn in closing {
            if let Some(conn) = state.conns.remove(&conn) {
                let _ = conn.tx.try_send(OfficeOut::Close(
                    1012,
                    "协同服务重启了,正在重新连接".to_owned(),
                ));
            }
        }
        // 没人、内容也落地了的房间直接忘掉;还有没落地内容的留着,下次打开从持久化的增量恢复
        state.rooms.retain(|_, room| room.open || room.dirty);
        for (_, waiters) in state.opening.drain() {
            for waiter in waiters {
                let _ = waiter.send(Err("协同服务退出了".to_owned()));
            }
        }
    }

    fn dispatch(self: &Arc<Self>, generation: u64, meta: Value, body: Vec<u8>) {
        let kind = meta["t"].as_str().unwrap_or_default();
        let room_id = meta["room"].as_str().unwrap_or_default().to_owned();
        let mut state = self.state.lock().unwrap();
        match kind {
            "send" => {
                let conn = meta["conn"].as_u64().unwrap_or_default();
                Self::deliver(&mut state, conn, body);
            }
            "broadcast" => {
                let except = meta["except"].as_u64();
                let targets: Vec<u64> = state
                    .rooms
                    .get(&room_id)
                    .map(|room| {
                        room.conns
                            .iter()
                            .copied()
                            .filter(|conn| Some(*conn) != except)
                            .collect()
                    })
                    .unwrap_or_default();
                for conn in targets {
                    Self::deliver(&mut state, conn, body.clone());
                }
            }
            "persist" => {
                let user = meta["conn"]
                    .as_u64()
                    .and_then(|conn| state.conns.get(&conn))
                    .map(|conn| (conn.user.id.clone(), conn.user.name.clone()));
                if let Some(room) = state.rooms.get_mut(&room_id) {
                    let (user_id, name) =
                        user.unwrap_or_else(|| ("ai".to_owned(), "AI".to_owned()));
                    room.authors.insert(name);
                    room.dirty = true;
                    let _ = self.persist.send(Persist::Append {
                        space: room.key.space_id().to_owned(),
                        doc: store_id(&room.key),
                        kind: format!("office:{}:{}:{}", room.format, room.base_sha, room.session),
                        update: body,
                        user: user_id,
                    });
                }
            }
            "compact" => {
                if let Some(room) = state.rooms.get(&room_id) {
                    let _ = self.persist.send(Persist::Compact {
                        space: room.key.space_id().to_owned(),
                        doc: store_id(&room.key),
                        kind: format!("office:{}:{}:{}", room.format, room.base_sha, room.session),
                        snapshot: body,
                    });
                }
            }
            "land" => {
                let seq = meta["seq"].as_u64().unwrap_or_default();
                let Some(room) = state.rooms.get(&room_id) else {
                    return;
                };
                let (key, session, expected, authors) = (
                    room.key.clone(),
                    room.session.clone(),
                    room.landed_sha.clone(),
                    room.authors.iter().cloned().collect::<Vec<_>>().join(","),
                );
                drop(state);
                let this = self.clone();
                tokio::spawn(async move {
                    let result = this.land(&key, &body, &expected, &authors, &session).await;
                    let reply = match &result {
                        Ok(sha) => {
                            if let Some(room) = this.state.lock().unwrap().rooms.get_mut(&room_id) {
                                room.landed_sha = sha.clone();
                            }
                            this.schedule_reindex(&room_id, key);
                            json!({ "t": "landed", "seq": seq, "ok": true })
                        }
                        Err(err) => {
                            json!({ "t": "landed", "seq": seq, "ok": false, "error": err.to_string() })
                        }
                    };
                    if let Some(worker) = this.worker.current().await
                        && worker.generation == generation
                    {
                        worker.send(reply, &[]);
                    }
                });
            }
            "status" => {
                if let Some(room) = state.rooms.get_mut(&room_id) {
                    room.dirty = meta["dirty"].as_bool().unwrap_or(false)
                        || meta["landing"].as_bool().unwrap_or(false);
                }
            }
            "opened" => {
                let result = if meta["ok"] == true {
                    Ok(body)
                } else {
                    Err(meta["error"].as_str().unwrap_or("打开失败").to_owned())
                };
                for waiter in state.opening.remove(&room_id).unwrap_or_default() {
                    let _ = waiter.send(result.clone());
                }
            }
            "closed" => {
                if let Some(room) = state.rooms.remove(&room_id) {
                    // 内容已经落地:增量不用再留(下一次协同从新文件开始)
                    let _ = self.persist.send(Persist::Reset {
                        space: room.key.space_id().to_owned(),
                        doc: store_id(&room.key),
                    });
                    for conn in room.conns {
                        if let Some(conn) = state.conns.remove(&conn) {
                            let _ = conn
                                .tx
                                .try_send(OfficeOut::Close(1000, "房间已关闭".to_owned()));
                        }
                    }
                }
            }
            "kick" => {
                let conn = meta["conn"].as_u64().unwrap_or_default();
                let reason = meta["reason"].as_str().unwrap_or("请重连").to_owned();
                if let Some(conn) = state.conns.get(&conn) {
                    let _ = conn.tx.try_send(OfficeOut::Close(4400, reason));
                }
            }
            "seed" | "land_done" | "stats" | "agent_edit" | "agent_read" => {
                if let Some(id) = meta["id"].as_u64()
                    && let Some(reply) = state.rpc.remove(&id)
                {
                    let _ = reply.send((meta, body));
                }
            }
            _ => {}
        }
    }

    /// 发给一条连接;队列满了(连接太慢)就断开它,让它重连补齐。
    fn deliver(state: &mut State, conn: u64, bytes: Vec<u8>) {
        let full = match state.conns.get(&conn) {
            Some(target) => target.tx.try_send(OfficeOut::Frame(bytes)).is_err(),
            None => false,
        };
        if full && let Some(target) = state.conns.remove(&conn) {
            let _ = target
                .tx
                .try_send(OfficeOut::Close(1013, "网络太慢,正在重新同步".to_owned()));
            if let Some(room) = state.rooms.get_mut(&target.room) {
                room.conns.remove(&conn);
            }
        }
    }

    fn edits(runtime: &crate::runtime::Embedded) -> kb_service::edit::FileEditService {
        let index = Arc::new(kb_service::IndexService::new(
            runtime.meta.clone(),
            runtime.store.clone(),
            runtime.embedder.clone(),
            runtime.chunker.clone(),
            runtime.scanner.clone(),
            kb_service::index::IndexOptions::default(),
        ));
        kb_service::edit::FileEditService::new(runtime.meta.clone(), index, runtime.paths.clone())
            .with_keep_versions(runtime.config().office.keep_versions)
    }

    async fn land(
        &self,
        key: &ResourceKey,
        bytes: &[u8],
        expected: &str,
        authors: &str,
        session: &str,
    ) -> Result<String> {
        let (name, path) = file_of(key)?;
        let runtime = self.spaces.get(key.space_id()).await?;
        let edits = Self::edits(&runtime);
        let result =
            crate::spaces::within_space(key.space_id().to_owned(), runtime.clone(), async {
                edits
                    .land_session(name, path, bytes, Some(expected), authors, session)
                    .await
            })
            .await?;
        Ok(result.sha256)
    }

    /// 落地之后停手 30 秒再重新索引(嵌入),期间又落地就重新计时。
    fn schedule_reindex(self: &Arc<Self>, room_id: &str, key: ResourceKey) {
        let this = self.clone();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(REINDEX_DEBOUNCE).await;
            let Ok((name, path)) = file_of(&key) else {
                return;
            };
            let Ok(runtime) = this.spaces.get(key.space_id()).await else {
                return;
            };
            if let Err(err) = Self::edits(&runtime).reindex_file(name, path).await {
                tracing::warn!(doc = %key, error = %err, "协同落地后重新索引失败");
            }
        });
        if let Some(previous) = self
            .state
            .lock()
            .unwrap()
            .reindex
            .insert(room_id.to_owned(), handle)
        {
            previous.abort();
        }
    }

    /// 给 AI 用的房间:没开就按文件现在的内容开一个(没人加入时落地后空闲关闭)。
    /// `write` 时还要求编辑器能无损处理这份文件。返回房间 id。
    async fn agent_room(self: &Arc<Self>, key: &ResourceKey, write: bool) -> Result<String> {
        let api = OfficeApi(self.clone());
        let who = OfficeUser {
            id: "ai".to_owned(),
            name: "AI".to_owned(),
        };
        let prepared = api.prepare(key, &who, Access::Write, false).await?;
        if prepared["mode"] != "collab" {
            return Err(KbError::Unavailable(format!(
                "{}(AI 读写办公文档要用协同服务)",
                prepared["reason"]
                    .as_str()
                    .unwrap_or("这份文档现在不能在线修改")
            )));
        }
        if write && prepared["room_writable"] != true {
            return Err(KbError::InvalidInput(
                "编辑器不能无损处理这份文档,AI 不能直接改它".to_owned(),
            ));
        }
        let room_id = store_id(key);
        self.open_room(&room_id, false).await?;
        Ok(room_id)
    }

    /// AI(经 MCP)改 Office 文件:在服务端副本上做几处「把这段文字换成那段」,实时出现在正在编辑的人那里,
    /// 随后照常落地。没有人在编辑时也一样(临时打开房间)。每处原文必须恰好出现一次,否则整批不改。
    /// `dry` 只核对每处原文能不能定位(提建议时用),不改。
    pub async fn agent_edit(
        self: &Arc<Self>,
        key: &ResourceKey,
        edits: &[(String, String)],
        author: &str,
        dry: bool,
    ) -> Result<usize> {
        let room_id = self.agent_room(key, true).await?;
        if !dry && let Some(room) = self.state.lock().unwrap().rooms.get_mut(&room_id) {
            room.authors.insert(author.to_owned());
        }
        let edits: Vec<Value> = edits
            .iter()
            .map(|(old, new)| json!({ "old": old, "new": new }))
            .collect();
        let (reply, _) = self
            .rpc(json!({ "t": "agent_edit", "room": room_id, "edits": edits, "author": author, "dry": dry }))
            .await?;
        if reply["ok"] != true {
            return Err(KbError::InvalidInput(
                reply["error"].as_str().unwrap_or("修改失败").to_owned(),
            ));
        }
        Ok(reply["changed"].as_u64().unwrap_or_default() as usize)
    }

    /// AI 读 Office 文件的纯文本(房间开着时就是大家正在改的内容,和 `agent_edit` 的查找是同一份)。
    pub async fn agent_read(self: &Arc<Self>, key: &ResourceKey) -> Result<String> {
        let room_id = self.agent_room(key, false).await?;
        let (reply, body) = self
            .rpc(json!({ "t": "agent_read", "room": room_id }))
            .await?;
        if reply["ok"] != true {
            return Err(KbError::InvalidInput(
                reply["error"].as_str().unwrap_or("读取失败").to_owned(),
            ));
        }
        String::from_utf8(body).map_err(|_| KbError::Internal("协同服务返回的不是文本".to_owned()))
    }

    /// 这份文件有没有正在进行的协同(有的话,房间外的整文件替换要拒绝,不能盖掉大家正在改的内容)。
    pub fn active(&self, key: &ResourceKey) -> bool {
        let state = self.state.lock().unwrap();
        state
            .rooms
            .get(&store_id(key))
            .is_some_and(|room| room.open || room.dirty || !room.conns.is_empty())
    }

    /// 房间外的写入前调用:有协同在进行就返回冲突。
    pub fn guard(&self, key: &ResourceKey) -> Result<()> {
        if self.active(key) {
            return Err(KbError::Exists(
                "这份文档正在多人在线编辑,先在编辑页里保存并让大家关闭后再替换".to_owned(),
            ));
        }
        Ok(())
    }

    async fn rpc(self: &Arc<Self>, meta: Value) -> Result<(Value, Vec<u8>)> {
        let worker = self.worker().await?;
        let id = self.id();
        let (tx, rx) = oneshot::channel();
        self.state.lock().unwrap().rpc.insert(id, tx);
        let mut meta = meta;
        meta["id"] = json!(id);
        worker.send(meta, &[]);
        tokio::time::timeout(WORKER_TIMEOUT, rx)
            .await
            .map_err(|_| KbError::Unavailable("协同服务没有回答".to_owned()))?
            .map_err(|_| KbError::Unavailable("协同服务退出了".to_owned()))
    }

    /// 把房间在 office-worker 里打开(或确认已经开着)。返回 `None` 表示已经开着。
    async fn open_room(self: &Arc<Self>, room_id: &str, check: bool) -> Result<Option<Vec<u8>>> {
        let worker = self.worker().await?;
        let (format, sha, session, space) = {
            let state = self.state.lock().unwrap();
            let room = state
                .rooms
                .get(room_id)
                .ok_or_else(|| KbError::NotFound("房间".to_owned()))?;
            if room.open && room.generation == worker.generation {
                return Ok(None);
            }
            (
                room.format,
                room.base_sha.clone(),
                room.session.clone(),
                room.key.space_id().to_owned(),
            )
        };
        let runtime = self.spaces.get(&space).await?;
        let base_path = Self::edits(&runtime)
            .blob_file(&sha)
            .ok_or_else(|| KbError::NotFound("协同的底稿找不到了".to_owned()))?;
        let (tx, rx) = oneshot::channel();
        let first = {
            let mut state = self.state.lock().unwrap();
            let waiters = state.opening.entry(room_id.to_owned()).or_default();
            waiters.push(tx);
            waiters.len() == 1
        };
        if first {
            worker.send(
                json!({ "t": "open", "room": room_id, "format": format, "base": base_path, "sha": sha, "check": check }),
                &[],
            );
        }
        let resaved = tokio::time::timeout(WORKER_TIMEOUT, rx)
            .await
            .map_err(|_| KbError::Unavailable("打开协同房间超时".to_owned()))?
            .map_err(|_| KbError::Unavailable("协同服务退出了".to_owned()))?
            .map_err(|err| KbError::InvalidInput(format!("这份文档开不了多人协同:{err}")))?;
        // 进程重启 / 守护进程重启后:把持久化的、还没落地的增量补回副本
        let row = runtime.meta.collab_load(room_id).await?;
        if first
            && let Some(row) = row
            && row.kind == format!("office:{format}:{sha}:{session}")
        {
            // 先补合并过的那一份(相对底稿),再补它之后的增量
            for update in std::iter::once(row.snapshot)
                .chain(row.updates)
                .filter(|update| !update.is_empty())
            {
                worker.send(json!({ "t": "restore", "room": room_id }), &update);
            }
        }
        {
            let mut state = self.state.lock().unwrap();
            if let Some(room) = state.rooms.get_mut(room_id) {
                room.open = true;
                room.generation = worker.generation;
            }
        }
        Ok(if first && check { Some(resaved) } else { None })
    }

    fn describe(room: &Room, access: Access, available: bool) -> Value {
        json!({
            "mode": if available { "collab" } else { "single" },
            "format": room.format,
            "base_sha": room.base_sha,
            "size": room.base_size,
            "writable": access == Access::Write && room.writable,
            "room_writable": room.writable,
            "lossless": room.verdict.lossless,
            "forceable": room.verdict.forceable,
            "report": room.verdict.report,
            "participants": room.conns.len(),
        })
    }
}

fn single(reason: impl Into<String>) -> Value {
    json!({ "mode": "single", "reason": reason.into() })
}

/// 用 kb-extract 的整包检查判断「不改直接保存」是否无损。
fn verdict_of(original: &[u8], resaved: &[u8], format: &str) -> Verdict {
    let valid = kb_extract::office_check::validate(resaved, format);
    let diff = kb_extract::office_check::compare(original, resaved).unwrap_or_default();
    let lossless = valid.is_ok() && diff.is_identical();
    let forceable = valid.is_ok() && diff.removed.is_empty();
    Verdict {
        lossless,
        forceable: !lossless && forceable,
        report: json!({
            "valid": valid.is_ok(),
            "reason": valid.err(),
            "changed_parts": diff.changed,
            "removed_parts": diff.removed,
            "added_parts": diff.added,
        }),
    }
}

/// 给 kb-web 用的接口(包一层:孤儿规则不许直接给 `Arc<OfficeCollab>` 实现外面的 trait)。
pub struct OfficeApi(pub Arc<OfficeCollab>);

#[async_trait]
impl OfficeCollabApi for OfficeApi {
    async fn prepare(
        &self,
        key: &ResourceKey,
        _user: &OfficeUser,
        access: Access,
        force: bool,
    ) -> Result<Value> {
        let (name, path) = file_of(key)?;
        let Some(format) = format_of(path) else {
            return Err(KbError::InvalidInput(
                "只有 Word / Excel / PowerPoint 文件能协同编辑".to_owned(),
            ));
        };
        if !self.0.config.get().office.collab {
            return Ok(single("系统参数里关掉了办公文档的多人协同"));
        }
        let Some(_) = self.0.locate() else {
            return Ok(single("办公文档协同服务没有安装,只能一个人编辑"));
        };
        let room_id = store_id(key);
        let runtime = self.0.spaces.get(key.space_id()).await?;
        let edits = OfficeCollab::edits(&runtime);
        if edits.origin(name, path).await? != "upload" {
            return Ok(single(
                "这个文件在项目目录里,由代码仓库管理,不能在页面里直接改它",
            ));
        }
        // 已经开着的房间:按需把「仍然编辑」记上
        let existing = {
            let mut state = self.0.state.lock().unwrap();
            state.rooms.get_mut(&room_id).map(|room| {
                if force && room.verdict.forceable {
                    room.writable = true;
                }
                room.open
            })
        };
        if existing.is_none() {
            let (sha, size, _) = edits.session_base(name, path).await?;
            if format == "xlsx" && size > XLSX_COLLAB_MAX_BYTES {
                return Ok(single(format!(
                    "表格有 {:.1} MB,超过多人协同支持的 {:.1} MB,只能一个人编辑",
                    size as f64 / 1048576.0,
                    XLSX_COLLAB_MAX_BYTES as f64 / 1048576.0
                )));
            }
            // 上次没落地完的会话(守护进程或协同服务中途退出):接着用它的底稿和会话,增量补回去
            let previous = runtime.meta.collab_load(&room_id).await?.and_then(|row| {
                let mut parts = row.kind.splitn(4, ':');
                match (parts.next(), parts.next(), parts.next(), parts.next()) {
                    (Some("office"), Some(f), Some(base), Some(session))
                        if f == format && edits.blob_file(base).is_some() =>
                    {
                        Some((base.to_owned(), session.to_owned()))
                    }
                    _ => None,
                }
            });
            let (base_sha, session) = previous
                .unwrap_or_else(|| (sha.clone(), format!("office-{}", uuid::Uuid::now_v7())));
            let verdict = self
                .0
                .state
                .lock()
                .unwrap()
                .verdicts
                .get(&base_sha)
                .cloned();
            let mut state = self.0.state.lock().unwrap();
            state.rooms.entry(room_id.clone()).or_insert_with(|| Room {
                key: key.clone(),
                format,
                base_sha: base_sha.clone(),
                base_size: size,
                session,
                open: false,
                generation: 0,
                writable: verdict
                    .as_ref()
                    .is_some_and(|v| v.lossless || (force && v.forceable)),
                verdict: verdict.clone().unwrap_or(Verdict {
                    lossless: false,
                    forceable: false,
                    report: Value::Null,
                }),
                landed_sha: sha,
                authors: BTreeSet::new(),
                conns: HashSet::new(),
                dirty: false,
            });
        }
        let needs_check = {
            let state = self.0.state.lock().unwrap();
            let room = &state.rooms[&room_id];
            !state.verdicts.contains_key(&room.base_sha)
        };
        let resaved = match self.0.open_room(&room_id, needs_check).await {
            Ok(resaved) => resaved,
            Err(err) => {
                self.0.state.lock().unwrap().rooms.remove(&room_id);
                return Ok(single(err.to_string()));
            }
        };
        if let Some(resaved) = resaved {
            let base_sha = self.0.state.lock().unwrap().rooms[&room_id]
                .base_sha
                .clone();
            let original = std::fs::read(
                edits
                    .blob_file(&base_sha)
                    .ok_or_else(|| KbError::NotFound("底稿".to_owned()))?,
            )
            .map_err(|err| KbError::Internal(format!("读底稿失败: {err}")))?;
            let fmt = format.to_owned();
            let verdict =
                tokio::task::spawn_blocking(move || verdict_of(&original, &resaved, &fmt))
                    .await
                    .map_err(|err| KbError::Internal(format!("检查线程异常: {err}")))?;
            let mut state = self.0.state.lock().unwrap();
            state.verdicts.insert(base_sha, verdict.clone());
            if let Some(room) = state.rooms.get_mut(&room_id) {
                room.writable = verdict.lossless || (force && verdict.forceable);
                room.verdict = verdict;
            }
        }
        let state = self.0.state.lock().unwrap();
        let room = state
            .rooms
            .get(&room_id)
            .ok_or_else(|| KbError::NotFound("房间".to_owned()))?;
        Ok(OfficeCollab::describe(room, access, true))
    }

    async fn base(&self, key: &ResourceKey, sha: &str) -> Result<Vec<u8>> {
        let allowed = self
            .0
            .state
            .lock()
            .unwrap()
            .rooms
            .get(&store_id(key))
            .is_some_and(|room| room.base_sha == sha);
        if !allowed {
            return Err(KbError::NotFound("这份底稿".to_owned()));
        }
        let runtime = self.0.spaces.get(key.space_id()).await?;
        let path = OfficeCollab::edits(&runtime)
            .blob_file(sha)
            .ok_or_else(|| KbError::NotFound("这份底稿".to_owned()))?;
        tokio::fs::read(&path)
            .await
            .map_err(|err| KbError::Internal(format!("读底稿失败: {err}")))
    }

    async fn seed(&self, key: &ResourceKey) -> Result<Vec<u8>> {
        let room_id = store_id(key);
        self.0.open_room(&room_id, false).await?;
        let (meta, body) = self.0.rpc(json!({ "t": "seed", "room": room_id })).await?;
        if meta["ok"] != true {
            return Err(KbError::InvalidInput("这个格式没有初始状态".to_owned()));
        }
        Ok(body)
    }

    async fn join(
        &self,
        key: &ResourceKey,
        user: &OfficeUser,
        access: Access,
    ) -> Result<OfficeConn> {
        let room_id = store_id(key);
        if !self.0.state.lock().unwrap().rooms.contains_key(&room_id) {
            let prepared = self.prepare(key, user, access, false).await?;
            if prepared["mode"] != "collab" {
                return Err(KbError::InvalidInput(
                    prepared["reason"]
                        .as_str()
                        .unwrap_or("这份文档不能多人协同")
                        .to_owned(),
                ));
            }
        }
        self.0.open_room(&room_id, false).await?;
        let worker = self.0.worker().await?;
        let conn = self.0.id();
        let (tx, rx) = mpsc::channel(CONN_QUEUE);
        let writable = {
            let mut state = self.0.state.lock().unwrap();
            let room = state
                .rooms
                .get_mut(&room_id)
                .ok_or_else(|| KbError::NotFound("房间".to_owned()))?;
            room.conns.insert(conn);
            let writable = access == Access::Write && room.writable;
            state.conns.insert(
                conn,
                Conn {
                    room: room_id.clone(),
                    user: user.clone(),
                    tx,
                },
            );
            writable
        };
        worker.send(
            json!({ "t": "join", "room": room_id, "conn": conn, "writable": writable, "user": { "id": user.id, "name": user.name } }),
            &[],
        );
        Ok(OfficeConn {
            rx,
            handle: Box::new(ConnHandle {
                collab: self.0.clone(),
                worker,
                room: room_id,
                conn,
            }),
        })
    }
}

struct ConnHandle {
    collab: Arc<OfficeCollab>,
    worker: Arc<Worker>,
    room: String,
    conn: u64,
}

impl OfficeConnHandle for ConnHandle {
    fn frame(&self, bytes: Vec<u8>) {
        self.worker.send(
            json!({ "t": "frame", "room": self.room, "conn": self.conn }),
            &bytes,
        );
    }
}

impl Drop for ConnHandle {
    fn drop(&mut self) {
        {
            let mut state = self.collab.state.lock().unwrap();
            state.conns.remove(&self.conn);
            if let Some(room) = state.rooms.get_mut(&self.room) {
                room.conns.remove(&self.conn);
            }
        }
        self.worker.send(
            json!({ "t": "leave", "room": self.room, "conn": self.conn }),
            &[],
        );
    }
}
