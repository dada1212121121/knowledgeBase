//! 一个房间的全部同步逻辑。
//!
//! 这里没有网络、没有时钟(时间由参数传入)、没有存储:连接收到的字节进来,
//! 要回的字节通过每条连接的发送队列出去,要持久化的更新攒在 `pending` 里等外面取走,
//! 需要异步做的事(落地、保存点)以 [`Request`] 的形式交给外面。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::time::Instant;
use yrs::sync::awareness::{AwarenessUpdate, AwarenessUpdateEntry};
use yrs::sync::protocol::{Message, MessageReader, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::Encode;
use yrs::{Doc, OffsetKind, Options, ReadTxn, StateVector, Text, Transact, Update};

use crate::types::{DocKind, DocRef, Frame, Limits, Participant, TEXT_ROOT};

/// 连接 id(房间内唯一,不复用)。
pub type ConnId = u64;

/// 服务端发给客户端的控制消息(`Message::Custom` 的这个标签)。
pub const CTRL_SERVER: u8 = 100;
/// 客户端发给服务端的控制消息。
pub const CTRL_CLIENT: u8 = 101;

/// 服务端 → 客户端的控制消息。
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerCtrl {
    /// 连接建立后的第一条:告诉客户端它是谁、能不能写、要不要初始化。
    Hello {
        /// 服务端认定的身份(光标上显示的就是这个)。
        you: Identity,
        /// 当前能不能编辑。
        writable: bool,
        /// 文档结构。
        kind: DocKind,
        /// 文档内容是否已经就绪。`false` 时先别输入,等 `ready`。
        ready: bool,
        /// 本连接被指定为**初始化者**:用这段 Markdown 初始化编辑器(只发给初始化者)。
        init: Option<String>,
        /// 本连接是不是落地者。
        lander: bool,
        /// 房间被锁成只读的原因(比如文档太大)。
        readonly_reason: Option<String>,
    },
    /// 角色变了(被降级成只读,或升级成可编辑)。
    Role {
        /// 现在能不能编辑。
        writable: bool,
    },
    /// 落地者变了。
    Lander {
        /// 是不是你。
        you: bool,
    },
    /// 文档内容就绪。
    Ready,
    /// 服务端要求落地者**马上**提交一次(库里有没落地的内容,或者太久没提交)。
    LandNow,
    /// 一次落地 / 保存点的结果。
    Saved {
        /// 这次是不是保存点。
        savepoint: bool,
    },
    /// 一次提交被拒绝(落地者不是你、状态向量落后……)。
    Rejected {
        /// 原因。
        reason: String,
    },
    /// 服务端要关闭这条连接。
    Closing {
        /// 原因。
        reason: String,
    },
}

/// 光标 / 在线列表上显示的身份。
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Identity {
    /// 用户 id 或游客标识。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// 颜色。
    pub color: String,
}

impl From<&Participant> for Identity {
    fn from(who: &Participant) -> Self {
        Self {
            id: who.id.clone(),
            name: who.name.clone(),
            color: who.color().to_owned(),
        }
    }
}

/// 客户端 → 服务端的控制消息。
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ClientCtrl {
    /// 初始化者应用完模板后。
    InitDone,
    /// 落地者提交 Markdown 和当时的状态向量(base64)。
    Land { markdown: String, sv: String },
    /// 点了「保存版本」。
    SavePoint,
}

/// 需要外面异步处理的事。
#[derive(Debug, PartialEq)]
pub enum Request {
    /// 初始化完成,文档内容就绪:外面要记下「此刻内容 = 正文」。
    InitDone {
        /// 初始化时用的 Markdown 哈希所对应的正文就是现在的内容;外面按需持久化。
        sv: Vec<u8>,
    },
    /// 落地者提交了 Markdown(已通过同步检查)。
    Land {
        /// 提交者。
        conn: ConnId,
        /// 内容。
        markdown: String,
        /// 提交时客户端的状态向量(编码后的字节)。
        sv: Vec<u8>,
    },
    /// 有人要求保存版本。
    SavePoint {
        /// 谁点的。
        conn: ConnId,
    },
}

/// 初始化状态(只对笔记 `Rich` 有意义)。
#[derive(Clone, Debug, PartialEq, Eq)]
enum Init {
    /// 还没有人初始化。
    Needed,
    /// 某条连接正在初始化。
    Pending { conn: ConnId, since: Instant },
    /// 内容已就绪。
    Done,
}

struct Conn {
    who: Participant,
    /// 握手时网络层给的不透明上下文,核对权限时原样传回。
    ctx: String,
    writable: bool,
    out: mpsc::Sender<Frame>,
    /// 加入顺序,用来选落地者(最早加入的可编辑者)。
    joined: u64,
    /// 这条连接在在线状态里占的 client id(第一次发在线状态时认领,之后只能用这一个)。
    awareness_id: Option<u64>,
    awareness_clock: u32,
    /// 已经过服务端改写的在线状态 JSON(`null` 表示没有)。
    presence: Option<Arc<str>>,
    /// 令牌桶。
    tokens: f64,
    last_refill: Instant,
}

/// 一个房间。
pub struct RoomCore {
    doc_ref: DocRef,
    doc: Doc,
    limits: Limits,
    conns: BTreeMap<ConnId, Conn>,
    next_conn: ConnId,
    next_join: u64,
    /// 文档观察者收集到的、已并入文档的更新(广播与持久化都用它,而不是客户端发来的原始字节:
    /// 乱序到达的依赖会在这里一起并入,广播出去的才是完整的)。
    captured: Arc<Mutex<Vec<Vec<u8>>>>,
    /// 还没写盘的更新(更新字节,产生者)。
    pending: Vec<(Vec<u8>, String)>,
    /// 写盘后累计、还没并进快照的更新条数 / 字节。
    since_compact: usize,
    bytes_since_compact: usize,
    snapshot_bytes: usize,
    /// 自上个保存点以来参与编辑的人。
    participants: BTreeSet<Participant>,
    /// 自上次落地以来内容有没有变。
    dirty: bool,
    last_change: Option<Instant>,
    /// 上一个保存点之后是否有过变化(没变化就不需要再生成保存点)。
    savepoint_due: bool,
    last_landed_sv: Option<StateVector>,
    init: Init,
    /// 初始化用的 Markdown(笔记且需要初始化时)。
    init_markdown: Option<String>,
    readonly_reason: Option<String>,
    lander: Option<ConnId>,
}

/// 同步检查落地提交没通过的原因。
#[derive(Debug, PartialEq, Eq)]
pub enum LandReject {
    /// 这条连接不是落地者。
    NotLander,
    /// 提交的状态向量落后于已落地的版本。
    Behind,
    /// 状态向量不合法(解不开,或声称比服务端还新)。
    Invalid,
    /// 文档结构不需要客户端落地(文本由服务端自己取)。
    NotNeeded,
}

impl LandReject {
    /// 给客户端看的原因。
    pub fn reason(&self) -> &'static str {
        match self {
            LandReject::NotLander => "你现在不是落地者",
            LandReject::Behind => "提交的状态落后于已保存的版本",
            LandReject::Invalid => "提交的状态不合法",
            LandReject::NotNeeded => "这种文档由服务端自己保存",
        }
    }
}

impl RoomCore {
    /// 新建房间。`snapshot` 与 `updates` 是库里的内容(没有就空);
    /// `init_markdown` 是需要(重新)初始化时要用的正文。
    pub fn new(
        doc_ref: DocRef,
        limits: Limits,
        snapshot: &[u8],
        updates: &[Vec<u8>],
        last_landed_sv: Option<&[u8]>,
        init_markdown: Option<String>,
        now: Instant,
    ) -> Result<Self, String> {
        let doc = Doc::with_options(Options {
            // 浏览器里的 Yjs 用 UTF-16 码元计偏移;服务端必须一致,否则含中文 / emoji 的文本位置会错位
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        {
            let mut txn = doc.transact_mut();
            for blob in std::iter::once(snapshot).chain(updates.iter().map(Vec::as_slice)) {
                if blob.is_empty() {
                    continue;
                }
                let update =
                    Update::decode_v1(blob).map_err(|err| format!("协作状态损坏: {err}"))?;
                txn.apply_update(update)
                    .map_err(|err| format!("协作状态无法应用: {err}"))?;
            }
        }
        let captured: Arc<Mutex<Vec<Vec<u8>>>> = Arc::default();
        let sink = captured.clone();
        doc.observe_update_v1("kb-collab", move |_, event| {
            sink.lock().unwrap().push(event.update.clone());
        })
        .map_err(|err| format!("无法监听文档: {err}"))?;
        let landed = last_landed_sv.and_then(|bytes| StateVector::decode_v1(bytes).ok());
        let has_state = !(snapshot.is_empty() && updates.is_empty());
        let mut core = Self {
            doc_ref,
            doc,
            limits,
            conns: BTreeMap::new(),
            next_conn: 1,
            next_join: 0,
            captured,
            pending: Vec::new(),
            since_compact: updates.len(),
            bytes_since_compact: updates.iter().map(Vec::len).sum(),
            snapshot_bytes: snapshot.len(),
            participants: BTreeSet::new(),
            dirty: false,
            last_change: None,
            savepoint_due: false,
            last_landed_sv: landed,
            init: Init::Done,
            init_markdown: None,
            readonly_reason: None,
            lander: None,
        };
        // 库里有状态且和正文一致:直接就绪。有状态但落地的向量不全(崩溃时还有没落地的修改)也直接就绪,
        // 第一个落地者会补写(设计规范第 6 步)。
        if !has_state {
            match (core.doc_ref.kind, init_markdown) {
                (DocKind::Text, text) => core.init_text(text.as_deref().unwrap_or("")),
                (DocKind::Rich, text) => {
                    core.init = Init::Needed;
                    core.init_markdown = Some(text.unwrap_or_default());
                }
            }
        }
        // 比库里更新的那部分(初始化文本)要写盘,但它和正文一致,不算「未落地」
        core.drain_captured(None);
        core.dirty = false;
        core.savepoint_due = false;
        // 库里的状态比上次落地的更新(上次关闭 / 崩溃时还有没落地的修改):标成未落地,
        // 笔记由第一个落地者补写,文本由服务端补写(设计规范第 6 步)
        if has_state {
            let current = core.doc.transact().state_vector();
            core.dirty = core.last_landed_sv.as_ref() != Some(&current);
            if core.dirty {
                // 落地 / 催促的去抖从房间打开那一刻开始算,否则没有人编辑就永远不会触发
                core.last_change = Some(now);
            }
        }
        Ok(core)
    }

    /// 文本文档:服务端自己把正文放进去。
    fn init_text(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let root = self.doc.get_or_insert_text(TEXT_ROOT);
        let mut txn = self.doc.transact_mut();
        root.insert(&mut txn, 0, text);
    }

    /// 文档键与结构。
    pub fn doc_ref(&self) -> &DocRef {
        &self.doc_ref
    }

    /// 现在有几条连接。
    pub fn conn_count(&self) -> usize {
        self.conns.len()
    }

    /// 有没有未落地的内容。
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// 有没有待写盘的更新。
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }

    /// 上一个保存点之后有没有变化。
    pub fn savepoint_due(&self) -> bool {
        self.savepoint_due
    }

    /// 最近一次变化的时间。
    pub fn last_change(&self) -> Option<Instant> {
        self.last_change
    }

    /// 自上个保存点以来的参与者。
    pub fn participants(&self) -> Vec<Participant> {
        self.participants.iter().cloned().collect()
    }

    /// 把一次落地的作者补进参与者名单。
    ///
    /// 为什么需要:落地(`hooks.land`)是服务端直接写库,不经过 `apply_update` / `apply_text_edits`,
    /// 而名单只在那两处插入 —— 于是「只提交、不逐字敲」的落地者从名单里凭空消失。
    /// 两人协作实测:保存点版本历史的 `author` 只写了编辑的那个人,落地者没了(`e2e_collab`
    /// 的 `two_people_edit_one_note_*` 就卡在这条断言上)。
    /// 注意:只在落地**成功后**调,被拒绝的提交不该进名单。
    pub fn record_lander(&mut self, conn: ConnId) {
        // 先 clone 再 insert:不把 `conns` 的不可变借持到 `participants` 的可变借用里
        let who = self.conns.get(&conn).map(|entry| entry.who.clone());
        if let Some(who) = who {
            self.participants.insert(who);
        }
    }

    /// 保存点生成后清空参与者与待办标记。
    pub fn savepoint_done(&mut self) {
        self.participants.clear();
        self.savepoint_due = false;
    }

    /// 文本文档当前的内容(服务端自己取)。
    pub fn text(&self) -> String {
        use yrs::GetString;
        let root = self.doc.get_or_insert_text(TEXT_ROOT);
        let txn = self.doc.transact();
        root.get_string(&txn)
    }

    /// 在房间里直接做几处「把这段文字换成那段」的修改(AI 经 MCP 改正在多人编辑的文档时用):
    /// 修改作为服务端自己的一笔更新广播给所有人、排进待写盘,和有人在编辑器里敲了这些字一样,
    /// 不会把正在编辑的人踢出去,也不会覆盖他们刚写的内容。
    ///
    /// 每处 `old` 必须在当前内容里恰好出现一次(没有或不止一处都整批拒绝,什么都不改)。
    /// 纯文本房间在 Y.Text 上改;富文本房间(笔记、Markdown 文件)在段落里的文字节点上改,
    /// `old` 不能跨段落,插入的文字沿用原位置的格式(加粗、链接……)。
    pub fn apply_text_edits(
        &mut self,
        edits: &[(String, String)],
        author: &Participant,
        now: Instant,
    ) -> Result<usize, String> {
        if self.readonly_reason.is_some() {
            return Err(self.readonly_reason.clone().unwrap_or_default());
        }
        if edits.is_empty() {
            return Ok(0);
        }
        for (old, _) in edits {
            if old.is_empty() {
                return Err("要替换的原文不能为空".to_owned());
            }
        }
        // 先在副本上把每一处都找到、确认唯一,全部能改才动真的文档
        match self.doc_ref.kind {
            DocKind::Text => {
                let mut text = self.text();
                let mut plan: Vec<(u32, u32, String)> = Vec::new();
                for (old, new) in edits {
                    let at = unique_match(&text, old)?;
                    plan.push((utf16_len(&text[..at]), utf16_len(old), new.clone()));
                    text.replace_range(at..at + old.len(), new);
                }
                let root = self.doc.get_or_insert_text(TEXT_ROOT);
                let mut txn = self.doc.transact_mut();
                for (index, len, new) in plan {
                    root.remove_range(&mut txn, index, len);
                    root.insert(&mut txn, index, &new);
                }
            }
            DocKind::Rich => {
                for (old, new) in edits {
                    self.rich_replace(old, new)?;
                }
            }
        }
        if self.drain_captured(Some(author)) {
            self.dirty = true;
            self.savepoint_due = true;
            self.last_change = Some(now);
            self.participants.insert(author.clone());
            self.check_size();
        }
        Ok(edits.len())
    }

    /// 给 AI 看的当前内容:纯文本房间就是正文;富文本房间是每段的文字(一段一行,不带 Markdown 标记),
    /// 和 [`Self::apply_text_edits`] 查找用的是同一份。
    pub fn plain_text(&self) -> String {
        use yrs::{GetString, XmlFragment, XmlOut};
        match self.doc_ref.kind {
            DocKind::Text => self.text(),
            DocKind::Rich => {
                let root = self.doc.get_or_insert_xml_fragment(crate::types::RICH_ROOT);
                let txn = self.doc.transact();
                let mut lines = Vec::new();
                for node in root.successors(&txn) {
                    if let XmlOut::Text(text) = node {
                        lines.push(text.get_string(&txn));
                    }
                }
                lines.join("\n")
            }
        }
    }

    /// 富文本:在某个文字节点里恰好找到一处 `old`,换成 `new`(沿用那里的格式)。
    fn rich_replace(&mut self, old: &str, new: &str) -> Result<(), String> {
        use yrs::types::text::YChange;
        use yrs::{Out, XmlFragment, XmlOut};
        let root = self.doc.get_or_insert_xml_fragment(crate::types::RICH_ROOT);
        // 找到的节点、原文在节点里的位置(UTF-16)、新文字要带的格式
        let mut found: Option<(yrs::XmlTextRef, u32, yrs::types::Attrs)> = None;
        let mut count = 0usize;
        {
            let txn = self.doc.transact();
            for node in root.successors(&txn) {
                let XmlOut::Text(text) = node else { continue };
                let chunks = text.diff(&txn, YChange::identity);
                let mut plain = String::new();
                // 每段文字的 [起点, 终点) 和格式
                let mut spans: Vec<(usize, usize, Option<Box<yrs::types::Attrs>>)> = Vec::new();
                for chunk in chunks {
                    if let Out::Any(yrs::Any::String(piece)) = &chunk.insert {
                        let start = plain.len();
                        plain.push_str(piece);
                        spans.push((start, plain.len(), chunk.attributes.clone()));
                    }
                }
                let hits: Vec<usize> = plain.match_indices(old).map(|(at, _)| at).collect();
                count += hits.len();
                if let Some(&at) = hits.first() {
                    let attrs_at = |byte: usize| {
                        spans
                            .iter()
                            .find(|(start, end, _)| *start <= byte && byte < *end)
                            .and_then(|(_, _, attrs)| attrs.as_deref().cloned())
                            .unwrap_or_default()
                    };
                    // 新文字沿用原文第一个字的格式;Y.Text 不带格式插入时会继承前一个字的格式,
                    // 所以前一个字有、原文没有的格式要显式清掉(否则「**重要**事项」改「事项」会变成加粗)
                    let mut attrs = attrs_at(at);
                    if at > 0 {
                        let previous = plain[..at].chars().next_back().map_or(0, char::len_utf8);
                        for key in attrs_at(at - previous).into_keys() {
                            attrs.entry(key).or_insert(yrs::Any::Null);
                        }
                    }
                    found = Some((text.clone(), utf16_len(&plain[..at]), attrs));
                }
            }
        }
        if count == 0 {
            return Err(format!("没找到要替换的原文:{}", preview(old)));
        }
        if count > 1 {
            return Err(format!(
                "原文出现了 {count} 处,不知道改哪一处,请带上更多上下文:{}",
                preview(old)
            ));
        }
        let (text, index, attrs) = found.expect("恰好一处");
        let mut txn = self.doc.transact_mut();
        text.remove_range(&mut txn, index, utf16_len(old));
        if attrs.is_empty() {
            text.insert(&mut txn, index, new);
        } else {
            text.insert_with_attributes(&mut txn, index, new, attrs);
        }
        Ok(())
    }

    /// 服务端当前的状态向量(编码)。
    pub fn state_vector(&self) -> Vec<u8> {
        self.doc.transact().state_vector().encode_v1()
    }

    /// 完整状态(快照用)。
    pub fn full_state(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    /// 写盘失败时把更新放回队首,下次再写。
    pub fn requeue(&mut self, mut updates: Vec<(Vec<u8>, String)>) {
        updates.append(&mut self.pending);
        self.pending = updates;
    }

    /// 取走待写盘的更新。
    pub fn take_pending(&mut self) -> Vec<(Vec<u8>, String)> {
        std::mem::take(&mut self.pending)
    }

    /// 写盘成功后调用:记录累计量,决定要不要并快照。
    pub fn flushed(&mut self, updates: usize, bytes: usize) {
        self.since_compact += updates;
        self.bytes_since_compact += bytes;
    }

    /// 该并快照了吗。
    pub fn should_compact(&self) -> bool {
        self.since_compact >= self.limits.compact_after_updates
            || self.bytes_since_compact > self.limits.max_doc_bytes / 4
    }

    /// 并完快照。
    pub fn compacted(&mut self, snapshot_len: usize) {
        self.since_compact = 0;
        self.bytes_since_compact = 0;
        self.snapshot_bytes = snapshot_len;
    }

    // ---------------------------------------------------------------- 连接

    /// 加入一条连接。返回连接 id;失败(房间满了)返回 `None`。
    pub fn join(
        &mut self,
        who: Participant,
        ctx: String,
        writable: bool,
        out: mpsc::Sender<Frame>,
        now: Instant,
    ) -> Option<ConnId> {
        if self.conns.len() >= self.limits.max_conns_per_room {
            return None;
        }
        let id = self.next_conn;
        self.next_conn += 1;
        let joined = self.next_join;
        self.next_join += 1;
        let writable = writable && self.readonly_reason.is_none();
        self.conns.insert(
            id,
            Conn {
                who,
                ctx,
                writable,
                out,
                joined,
                awareness_id: None,
                awareness_clock: 0,
                presence: None,
                tokens: f64::from(self.limits.message_burst),
                last_refill: now,
            },
        );
        // 笔记还没就绪:第一个可编辑的连接当初始化者
        let mut init_text = None;
        if self.doc_ref.kind == DocKind::Rich && self.init == Init::Needed && writable {
            self.init = Init::Pending {
                conn: id,
                since: now,
            };
            init_text = self.init_markdown.clone();
        }
        let ready = self.init == Init::Done;
        let hello = ServerCtrl::Hello {
            you: Identity::from(&self.conns[&id].who),
            writable,
            kind: self.doc_ref.kind,
            ready,
            init: init_text,
            lander: false,
            readonly_reason: self.readonly_reason.clone(),
        };
        self.send_ctrl(id, &hello);
        // 先发一条 SyncStep1,让客户端把它多出来的(离线修改)送过来;客户端自己也会发 SyncStep1
        let step1 = Message::Sync(SyncMessage::SyncStep1(self.doc.transact().state_vector()));
        self.send_message(id, &step1);
        // 当前所有人的在线状态
        if let Some(update) = self.presence_update(Some(id)) {
            self.send_message(id, &Message::Awareness(update));
        }
        self.elect_lander();
        Some(id)
    }

    /// 移除一条连接。返回需要外面处理的事(目前没有)。
    pub fn leave(&mut self, conn: ConnId, now: Instant) {
        let Some(gone) = self.conns.remove(&conn) else {
            return;
        };
        // 广播他的光标消失
        if let (Some(client), Some(_)) = (gone.awareness_id, &gone.presence) {
            let mut clients = std::collections::HashMap::new();
            clients.insert(
                yrs::block::ClientID::new(client),
                AwarenessUpdateEntry {
                    clock: gone.awareness_clock.saturating_add(1),
                    json: Arc::from("null"),
                },
            );
            self.broadcast(None, &Message::Awareness(AwarenessUpdate { clients }));
        }
        // 初始化者中途离开:内容已经进来了就算完成,否则让下一个可编辑者来
        if let Init::Pending {
            conn: initiator, ..
        } = self.init
            && initiator == conn
        {
            if self.doc_has_content() {
                self.finish_init();
            } else {
                self.init = Init::Needed;
                self.assign_initializer(now);
            }
        }
        self.elect_lander();
    }

    fn doc_has_content(&self) -> bool {
        let txn = self.doc.transact();
        !txn.state_vector().is_empty()
    }

    /// 给下一个可编辑者派初始化的活。
    fn assign_initializer(&mut self, now: Instant) {
        if self.init != Init::Needed {
            return;
        }
        let next = self
            .conns
            .iter()
            .filter(|(_, conn)| conn.writable)
            .min_by_key(|(_, conn)| conn.joined)
            .map(|(id, _)| *id);
        if let Some(id) = next {
            self.init = Init::Pending {
                conn: id,
                since: now,
            };
            // 已经发过 hello 的连接再补发一次初始化指令:用 Hello 的同样结构,client 按 init 字段处理
            let hello = ServerCtrl::Hello {
                you: Identity::from(&self.conns[&id].who),
                writable: true,
                kind: self.doc_ref.kind,
                ready: false,
                init: self.init_markdown.clone(),
                lander: false,
                readonly_reason: self.readonly_reason.clone(),
            };
            self.send_ctrl(id, &hello);
        }
    }

    fn finish_init(&mut self) {
        self.init = Init::Done;
        self.init_markdown = None;
        let ids: Vec<ConnId> = self.conns.keys().copied().collect();
        for id in ids {
            self.send_ctrl(id, &ServerCtrl::Ready);
        }
        self.elect_lander();
    }

    /// 初始化超时就换人。定时器每个节拍调用。
    pub fn tick(&mut self, now: Instant) {
        if let Init::Pending { conn, since } = self.init
            && now.duration_since(since) >= self.limits.init_timeout
        {
            // 踢掉它时 `leave` 已经把初始化交给了下一个可编辑者,这里不能再重复指派
            self.kick(conn, 4408, "初始化超时");
        }
    }

    /// 某个人的权限被收回:断开他在这个房间的所有连接。
    pub fn remove_user(&mut self, user_id: &str, reason: &str) {
        let ids: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(_, conn)| conn.who.id == user_id)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            self.kick(id, 4403, reason);
        }
    }

    /// 谁在编辑 / 查看(给头像栏用)。
    pub fn roster(&self) -> Vec<(Participant, bool)> {
        self.conns
            .values()
            .map(|conn| (conn.who.clone(), conn.writable))
            .collect()
    }

    // ---------------------------------------------------------------- 落地者

    fn elect_lander(&mut self) {
        let next = if self.doc_ref.kind == DocKind::Rich && self.init == Init::Done {
            self.conns
                .iter()
                .filter(|(_, conn)| conn.writable)
                .min_by_key(|(_, conn)| conn.joined)
                .map(|(id, _)| *id)
        } else {
            None
        };
        if next == self.lander {
            return;
        }
        let previous = self.lander;
        self.lander = next;
        if let Some(id) = previous
            && self.conns.contains_key(&id)
        {
            self.send_ctrl(id, &ServerCtrl::Lander { you: false });
        }
        if let Some(id) = next {
            self.send_ctrl(id, &ServerCtrl::Lander { you: true });
            if self.dirty {
                self.send_ctrl(id, &ServerCtrl::LandNow);
            }
        }
    }

    /// 让落地者马上提交(有未落地的内容时)。返回有没有发出。
    pub fn nudge_lander(&mut self) -> bool {
        match self.lander {
            Some(id) if self.dirty && self.conns.contains_key(&id) => {
                self.send_ctrl(id, &ServerCtrl::LandNow);
                true
            }
            _ => false,
        }
    }

    /// 每个连接的权限核对目标:(连接, 谁, 上下文, 现在能不能写)。
    pub fn recheck_targets(&self) -> Vec<(ConnId, Participant, String, bool)> {
        self.conns
            .iter()
            .map(|(id, conn)| (*id, conn.who.clone(), conn.ctx.clone(), conn.writable))
            .collect()
    }

    /// 按核对结果改变一条连接的编辑权限。
    pub fn set_conn_writable(&mut self, conn: ConnId, writable: bool, now: Instant) {
        let writable = writable && self.readonly_reason.is_none();
        let Some(entry) = self.conns.get_mut(&conn) else {
            return;
        };
        if entry.writable == writable {
            return;
        }
        entry.writable = writable;
        self.send_ctrl(conn, &ServerCtrl::Role { writable });
        if !writable && matches!(self.init, Init::Pending { conn: c, .. } if c == conn) {
            self.init = Init::Needed;
        }
        self.assign_initializer(now);
        self.elect_lander();
    }

    /// 当前的落地者。
    pub fn lander(&self) -> Option<ConnId> {
        self.lander
    }

    /// 同步检查一次落地提交。通过返回客户端的状态向量。
    pub fn check_land(&self, conn: ConnId, sv: &[u8]) -> Result<StateVector, LandReject> {
        if self.doc_ref.kind != DocKind::Rich {
            return Err(LandReject::NotNeeded);
        }
        if self.lander != Some(conn) {
            return Err(LandReject::NotLander);
        }
        let client = StateVector::decode_v1(sv).map_err(|_| LandReject::Invalid)?;
        let server = self.doc.transact().state_vector();
        // 客户端不可能比服务端还新(所有更新都经过服务端):声称更新的是在伪造
        if !matches!(
            client.partial_cmp(&server),
            Some(std::cmp::Ordering::Less | std::cmp::Ordering::Equal)
        ) {
            return Err(LandReject::Invalid);
        }
        if let Some(landed) = &self.last_landed_sv
            && !matches!(
                client.partial_cmp(landed),
                Some(std::cmp::Ordering::Greater | std::cmp::Ordering::Equal)
            )
        {
            return Err(LandReject::Behind);
        }
        Ok(client)
    }

    /// 记录一次成功的落地。服务端比提交的状态更新时仍然算「有未落地内容」。
    pub fn record_landed(&mut self, sv: StateVector) {
        let server = self.doc.transact().state_vector();
        self.dirty = server != sv;
        self.last_landed_sv = Some(sv);
    }

    /// 文本文档由服务端落地:记下此刻的状态。
    pub fn record_landed_now(&mut self) {
        let server = self.doc.transact().state_vector();
        self.dirty = false;
        self.last_landed_sv = Some(server);
    }

    /// 通知一条连接:提交被拒绝 / 已保存。
    pub fn notify(&self, conn: ConnId, ctrl: &ServerCtrl) {
        self.send_ctrl(conn, ctrl);
    }

    /// 通知所有连接:保存点已生成。
    pub fn notify_all(&self, ctrl: &ServerCtrl) {
        for id in self.conns.keys().copied().collect::<Vec<_>>() {
            self.send_ctrl(id, ctrl);
        }
    }

    // ---------------------------------------------------------------- 入站

    /// 处理一条连接发来的二进制数据。返回需要外面异步处理的事。
    pub fn on_binary(&mut self, conn: ConnId, data: &[u8], now: Instant) -> Vec<Request> {
        let mut requests = Vec::new();
        let Some(entry) = self.conns.get_mut(&conn) else {
            return requests;
        };
        if data.len() > self.limits.max_message_bytes {
            self.kick(conn, 1009, "消息太大");
            return requests;
        }
        // 令牌桶:刷一下、扣一个;没有了就断开(正常编辑远到不了这个速率)
        let elapsed = now.duration_since(entry.last_refill).as_secs_f64();
        entry.tokens = (entry.tokens + elapsed * f64::from(self.limits.messages_per_second))
            .min(f64::from(self.limits.message_burst));
        entry.last_refill = now;
        if entry.tokens < 1.0 {
            self.kick(conn, 1008, "消息太频繁");
            return requests;
        }
        entry.tokens -= 1.0;

        let mut decoder = DecoderV1::new(yrs::encoding::read::Cursor::new(data));
        let reader = MessageReader::new(&mut decoder);
        let mut messages = Vec::new();
        for next in reader {
            match next {
                Ok(message) => messages.push(message),
                Err(_) => {
                    self.kick(conn, 1003, "协议错误");
                    return requests;
                }
            }
        }
        for message in messages {
            if !self.conns.contains_key(&conn) {
                break;
            }
            self.on_message(conn, message, now, &mut requests);
        }
        requests
    }

    fn on_message(
        &mut self,
        conn: ConnId,
        message: Message,
        now: Instant,
        requests: &mut Vec<Request>,
    ) {
        match message {
            Message::Sync(SyncMessage::SyncStep1(sv)) => {
                let update = self.doc.transact().encode_state_as_update_v1(&sv);
                self.send_message(conn, &Message::Sync(SyncMessage::SyncStep2(update)));
            }
            Message::Sync(SyncMessage::SyncStep2(bytes) | SyncMessage::Update(bytes)) => {
                self.apply_client_update(conn, &bytes, now);
            }
            Message::Awareness(update) => self.on_awareness(conn, update),
            Message::AwarenessQuery => {
                if let Some(update) = self.presence_update(None) {
                    self.send_message(conn, &Message::Awareness(update));
                }
            }
            Message::Auth(_) => {}
            Message::Custom(CTRL_CLIENT, body) => self.on_ctrl(conn, &body, now, requests),
            Message::Custom(..) => {}
        }
    }

    fn apply_client_update(&mut self, conn: ConnId, bytes: &[u8], now: Instant) {
        let Some(entry) = self.conns.get(&conn) else {
            return;
        };
        // 查看者(或被降级的人)发来的修改直接丢弃;房间被锁成只读时所有人都一样
        if !entry.writable || self.readonly_reason.is_some() {
            return;
        }
        let who = entry.who.clone();
        let Ok(update) = Update::decode_v1(bytes) else {
            self.kick(conn, 1003, "更新格式错误");
            return;
        };
        {
            let mut txn = self.doc.transact_mut();
            if txn.apply_update(update).is_err() {
                drop(txn);
                self.kick(conn, 1003, "更新无法应用");
                return;
            }
        }
        if self.drain_captured(Some(&who)) {
            self.dirty = true;
            self.savepoint_due = true;
            self.last_change = Some(now);
            self.participants.insert(who);
            self.check_size();
        }
    }

    /// 把观察者收到的更新广播并排进待写盘。返回有没有新内容。
    fn drain_captured(&mut self, author: Option<&Participant>) -> bool {
        let batch: Vec<Vec<u8>> = std::mem::take(&mut *self.captured.lock().unwrap());
        let user = author.map(|who| who.id.clone()).unwrap_or_default();
        let mut changed = false;
        for blob in batch {
            // 空更新(只有空的结构表和删除集)不值得广播和存
            if blob.len() <= 2 {
                continue;
            }
            changed = true;
            self.broadcast(None, &Message::Sync(SyncMessage::Update(blob.clone())));
            self.pending.push((blob, user.clone()));
        }
        changed
    }

    /// 文档超过上限就锁成只读,并告诉所有人。
    fn check_size(&mut self) {
        let estimate = self.snapshot_bytes
            + self.bytes_since_compact
            + self
                .pending
                .iter()
                .map(|(blob, _)| blob.len())
                .sum::<usize>();
        if estimate <= self.limits.max_doc_bytes || self.readonly_reason.is_some() {
            return;
        }
        // 估算是上界(删除会让真实大小变小),超了再精确量一次
        if self.full_state().len() <= self.limits.max_doc_bytes {
            return;
        }
        let reason = "文档太大,已锁定为只读".to_owned();
        self.readonly_reason = Some(reason.clone());
        for id in self.conns.keys().copied().collect::<Vec<_>>() {
            if let Some(conn) = self.conns.get_mut(&id) {
                conn.writable = false;
            }
            self.send_ctrl(id, &ServerCtrl::Role { writable: false });
            self.send_ctrl(
                id,
                &ServerCtrl::Rejected {
                    reason: reason.clone(),
                },
            );
        }
        self.elect_lander();
    }

    fn on_ctrl(&mut self, conn: ConnId, body: &[u8], now: Instant, requests: &mut Vec<Request>) {
        let Ok(ctrl) = serde_json::from_slice::<ClientCtrl>(body) else {
            self.kick(conn, 1003, "控制消息格式错误");
            return;
        };
        let writable = self.conns.get(&conn).is_some_and(|c| c.writable);
        match ctrl {
            ClientCtrl::InitDone => {
                if matches!(self.init, Init::Pending { conn: c, .. } if c == conn) && writable {
                    self.finish_init();
                    requests.push(Request::InitDone {
                        sv: self.state_vector(),
                    });
                }
            }
            ClientCtrl::Land { markdown, sv } => {
                let Some(sv) = base64_decode(&sv) else {
                    self.send_ctrl(
                        conn,
                        &ServerCtrl::Rejected {
                            reason: LandReject::Invalid.reason().to_owned(),
                        },
                    );
                    return;
                };
                match self.check_land(conn, &sv) {
                    Ok(_) => requests.push(Request::Land { conn, markdown, sv }),
                    Err(reject) => self.send_ctrl(
                        conn,
                        &ServerCtrl::Rejected {
                            reason: reject.reason().to_owned(),
                        },
                    ),
                }
            }
            ClientCtrl::SavePoint => {
                if writable {
                    requests.push(Request::SavePoint { conn });
                }
            }
        }
        let _ = now;
    }

    // ---------------------------------------------------------------- 在线状态

    fn on_awareness(&mut self, conn: ConnId, update: AwarenessUpdate) {
        let Some(entry) = self.conns.get_mut(&conn) else {
            return;
        };
        let identity = Identity::from(&entry.who);
        let mut accepted = std::collections::HashMap::new();
        for (client, item) in update.clients {
            let client_id: u64 = client.get();
            // 一条连接只能用一个 client id:第一次认领,之后别的 id(伪造别人的光标)一概忽略
            match entry.awareness_id {
                None => entry.awareness_id = Some(client_id),
                Some(own) if own == client_id => {}
                Some(_) => continue,
            }
            if item.json.len() > self.limits.max_awareness_bytes {
                continue;
            }
            // 时钟倒退的忽略(重放)
            if item.clock < entry.awareness_clock && entry.presence.is_some() {
                continue;
            }
            let json = if item.json.as_ref() == "null" {
                "null".to_owned()
            } else {
                // 状态必须是 JSON 对象;身份由服务端改写,客户端自称的名字 / 颜色不采信
                let Ok(serde_json::Value::Object(mut map)) =
                    serde_json::from_str::<serde_json::Value>(&item.json)
                else {
                    continue;
                };
                map.insert(
                    "user".to_owned(),
                    serde_json::json!({ "id": identity.id, "name": identity.name, "color": identity.color }),
                );
                serde_json::Value::Object(map).to_string()
            };
            entry.awareness_clock = item.clock;
            entry.presence = (json != "null").then(|| Arc::from(json.as_str()));
            accepted.insert(
                client,
                AwarenessUpdateEntry {
                    clock: item.clock,
                    json: Arc::from(json.as_str()),
                },
            );
        }
        if !accepted.is_empty() {
            self.broadcast(
                Some(conn),
                &Message::Awareness(AwarenessUpdate { clients: accepted }),
            );
        }
    }

    /// 全部(或除某条连接外)在线状态组成的更新。
    fn presence_update(&self, except: Option<ConnId>) -> Option<AwarenessUpdate> {
        let mut clients = std::collections::HashMap::new();
        for (id, conn) in &self.conns {
            if Some(*id) == except {
                continue;
            }
            if let (Some(client), Some(json)) = (conn.awareness_id, &conn.presence) {
                clients.insert(
                    yrs::block::ClientID::new(client),
                    AwarenessUpdateEntry {
                        clock: conn.awareness_clock,
                        json: json.clone(),
                    },
                );
            }
        }
        (!clients.is_empty()).then_some(AwarenessUpdate { clients })
    }

    // ---------------------------------------------------------------- 发送

    fn send_message(&mut self, conn: ConnId, message: &Message) {
        self.send_frame(conn, Frame::Binary(message.encode_v1()));
    }

    fn send_ctrl(&self, conn: ConnId, ctrl: &ServerCtrl) {
        let body = serde_json::to_vec(ctrl).unwrap_or_default();
        let frame = Frame::Binary(Message::Custom(CTRL_SERVER, body).encode_v1());
        if let Some(entry) = self.conns.get(&conn) {
            let _ = entry.out.try_send(frame);
        }
    }

    fn send_frame(&mut self, conn: ConnId, frame: Frame) {
        let full = match self.conns.get(&conn) {
            Some(entry) => entry.out.try_send(frame).is_err(),
            None => false,
        };
        if full {
            // 队列满了说明对端太慢或已死:断开让它重连后补齐差异,比让整个房间等它强
            self.kick(conn, 1013, "连接太慢");
        }
    }

    fn broadcast(&mut self, except: Option<ConnId>, message: &Message) {
        let frame = Frame::Binary(message.encode_v1());
        let ids: Vec<ConnId> = self
            .conns
            .keys()
            .copied()
            .filter(|id| Some(*id) != except)
            .collect();
        for id in ids {
            self.send_frame(id, frame.clone());
        }
    }

    /// 关闭一条连接:告诉它原因,然后从房间移除(连接自己的读循环随后会结束)。
    pub fn kick(&mut self, conn: ConnId, code: u16, reason: &str) {
        if let Some(entry) = self.conns.get(&conn) {
            let _ = entry.out.try_send(Frame::Close {
                code,
                reason: reason.to_owned(),
            });
        }
        self.leave(conn, Instant::now());
    }
}

/// 标准 base64(带填充)解码。控制消息里的状态向量用它传。
pub fn base64_decode(text: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut lookup = [255u8; 256];
    for (i, c) in TABLE.iter().enumerate() {
        lookup[*c as usize] = i as u8;
    }
    let bytes: Vec<u8> = text.bytes().filter(|b| *b != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0;
    for byte in bytes {
        let value = lookup[byte as usize];
        if value == 255 {
            return None;
        }
        acc = (acc << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

/// 标准 base64 编码(测试与客户端模拟用)。
pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn utf16_len(text: &str) -> u32 {
    text.encode_utf16().count() as u32
}

fn preview(text: &str) -> String {
    let mut out: String = text.chars().take(40).collect();
    if text.chars().count() > 40 {
        out.push('…');
    }
    out
}

/// 在一段文字上按顺序做几处替换,每处原文必须恰好出现一次(和房间里的规则一样),否则整批不改。
/// 没有开着的房间时,AI 的修改就用它改存储里的正文。
pub fn replace_unique(text: &str, edits: &[(String, String)]) -> Result<String, String> {
    let mut out = text.to_owned();
    for (old, new) in edits {
        if old.is_empty() {
            return Err("要替换的原文不能为空".to_owned());
        }
        let at = unique_match(&out, old)?;
        out.replace_range(at..at + old.len(), new);
    }
    Ok(out)
}

/// 恰好出现一次的位置(字节下标)。
fn unique_match(text: &str, needle: &str) -> Result<usize, String> {
    let mut hits = text.match_indices(needle);
    let Some((at, _)) = hits.next() else {
        return Err(format!("没找到要替换的原文:{}", preview(needle)));
    };
    let more = hits.count();
    if more > 0 {
        return Err(format!(
            "原文出现了 {} 处,不知道改哪一处,请带上更多上下文:{}",
            more + 1,
            preview(needle)
        ));
    }
    Ok(at)
}
