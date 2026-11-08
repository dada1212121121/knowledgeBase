//! 测试用的假外部(正文库、权限)和一个模拟浏览器的客户端。

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use kb_collab::core::{CTRL_CLIENT, CTRL_SERVER, base64_encode};
use kb_collab::{
    Access, Body, CollabAuth, CollabHooks, CollabHub, DocKind, DocRef, Frame, JoinRequest, Landing,
    Limits, MemoryStore, Participant, Session,
};
use kb_core::{KbError, Result};
use serde_json::Value;
use yrs::sync::awareness::AwarenessUpdate;
use yrs::sync::protocol::{Message, MessageReader, SyncMessage};
use yrs::updates::decoder::{Decode, DecoderV1};
use yrs::updates::encoder::Encode;
use yrs::{
    Doc, GetString, OffsetKind, Options, ReadTxn, StateVector, Text, Transact, Update,
    XmlElementPrelim, XmlFragment, XmlTextPrelim,
};

pub fn hash(text: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{h:016x}")
}

#[derive(Default)]
pub struct FakeHooks {
    pub bodies: Mutex<HashMap<String, String>>,
    pub lands: Mutex<Vec<(String, String, Vec<Participant>)>>,
    pub savepoints: Mutex<Vec<(String, Vec<Participant>)>>,
    pub fail_land: Mutex<bool>,
}

impl FakeHooks {
    pub fn set_body(&self, key: &str, text: &str) {
        self.bodies
            .lock()
            .unwrap()
            .insert(key.to_owned(), text.to_owned());
    }
    pub fn body(&self, key: &str) -> String {
        self.bodies
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .unwrap_or_default()
    }
}

#[async_trait]
impl CollabHooks for FakeHooks {
    async fn exists(&self, doc: &DocRef) -> bool {
        self.bodies.lock().unwrap().contains_key(&doc.key)
    }

    async fn load_body(&self, doc: &DocRef) -> Result<Body> {
        self.bodies
            .lock()
            .unwrap()
            .get(&doc.key)
            .map(|text| Body { text: text.clone() })
            .ok_or_else(|| KbError::NotFound(doc.key.clone()))
    }

    async fn land(&self, doc: &DocRef, landing: Landing) -> Result<String> {
        if *self.fail_land.lock().unwrap() {
            return Err(KbError::Internal("写入失败".to_owned()));
        }
        self.bodies
            .lock()
            .unwrap()
            .insert(doc.key.clone(), landing.text.clone());
        self.lands.lock().unwrap().push((
            doc.key.clone(),
            landing.text.clone(),
            landing.participants,
        ));
        Ok(hash(&landing.text))
    }

    async fn savepoint(&self, doc: &DocRef, participants: Vec<Participant>) -> Result<()> {
        self.savepoints
            .lock()
            .unwrap()
            .push((doc.key.clone(), participants));
        Ok(())
    }

    fn hash(&self, text: &str) -> String {
        hash(text)
    }
}

/// 用户 → 权限。没登记的算没权限。
#[derive(Default)]
pub struct FakeAuth {
    pub access: Mutex<HashMap<String, Access>>,
}

impl FakeAuth {
    pub fn set(&self, user: &str, access: Access) {
        self.access.lock().unwrap().insert(user.to_owned(), access);
    }
}

#[async_trait]
impl CollabAuth for FakeAuth {
    async fn access(&self, _doc: &DocRef, who: &Participant, _ctx: &str) -> Access {
        self.access
            .lock()
            .unwrap()
            .get(&who.id)
            .copied()
            .unwrap_or(Access::Denied)
    }
}

pub struct World {
    pub hub: CollabHub,
    pub hooks: Arc<FakeHooks>,
    pub auth: Arc<FakeAuth>,
    pub store: Arc<MemoryStore>,
}

/// 测试用的短时间参数:所有定时都压到几十毫秒。
pub fn fast_limits() -> Limits {
    Limits {
        flush_interval: Duration::from_millis(20),
        idle_close: Duration::from_millis(150),
        land_debounce: Duration::from_millis(60),
        savepoint_idle: Duration::from_millis(250),
        tick: Duration::from_millis(10),
        recheck_interval: Duration::from_secs(3600),
        init_timeout: Duration::from_millis(400),
        compact_after_updates: 5,
        ..Limits::default()
    }
}

impl World {
    pub fn new(limits: Limits) -> Self {
        let hooks = Arc::new(FakeHooks::default());
        let auth = Arc::new(FakeAuth::default());
        let store = Arc::new(MemoryStore::new());
        let hub = CollabHub::new(store.clone(), hooks.clone(), auth.clone(), limits);
        Self {
            hub,
            hooks,
            auth,
            store,
        }
    }

    /// 房间是不是都关了。
    pub fn hub_rooms_empty(&self) -> bool {
        self.hub.open_rooms() == 0
    }

    pub async fn join(&self, doc: &DocRef, who: &Participant, writable: bool) -> Client {
        self.auth.set(
            &who.id,
            if writable {
                Access::Write
            } else {
                Access::Read
            },
        );
        let session = self
            .hub
            .join(JoinRequest {
                doc: doc.clone(),
                who: who.clone(),
                ctx: String::new(),
                writable,
            })
            .await
            .expect("加入房间");
        Client::new(session, who.clone(), doc.kind).await
    }
}

pub fn person(id: &str) -> Participant {
    Participant {
        id: id.to_owned(),
        name: format!("{id} 的名字"),
    }
}

pub fn text_doc(key: &str) -> DocRef {
    DocRef {
        key: key.to_owned(),
        kind: DocKind::Text,
    }
}

pub fn rich_doc(key: &str) -> DocRef {
    DocRef {
        key: key.to_owned(),
        kind: DocKind::Rich,
    }
}

/// 模拟浏览器里的 Yjs + 同步提供者。
pub struct Client {
    pub doc: Doc,
    session: Option<Session>,
    pub who: Participant,
    pub kind: DocKind,
    pub ctrl: Vec<Value>,
    pub presence: Vec<AwarenessUpdate>,
    pub closed: Option<(u16, String)>,
}

impl Client {
    async fn new(session: Session, who: Participant, kind: DocKind) -> Self {
        let doc = Doc::with_options(Options {
            offset_kind: OffsetKind::Utf16,
            ..Options::default()
        });
        let mut client = Self {
            doc,
            session: Some(session),
            who,
            kind,
            ctrl: Vec::new(),
            presence: Vec::new(),
            closed: None,
        };
        // 和 y-websocket 一样:连上就发 SyncStep1
        let sv = client.doc.transact().state_vector();
        client
            .send_message(&Message::Sync(SyncMessage::SyncStep1(sv)))
            .await;
        client.pump().await;
        client
    }

    /// 可变的当前连接。
    pub fn session_mut(&mut self) -> &mut Session {
        self.session.as_mut().expect("客户端已断线")
    }

    /// 当前连接(断线时没有)。
    pub fn session(&self) -> &Session {
        self.session.as_ref().expect("客户端已断线")
    }

    pub async fn send_message(&self, message: &Message) {
        if let Some(session) = &self.session {
            session.send(&message.encode_v1()).await;
        }
    }

    /// 主动断线:离开房间,保留本地文档(之后的修改只存在本地)。
    pub async fn disconnect(&mut self) {
        if let Some(session) = self.session.take() {
            session.leave().await;
        }
    }

    pub async fn send_ctrl(&self, body: Value) {
        let bytes = Message::Custom(CTRL_CLIENT, serde_json::to_vec(&body).unwrap()).encode_v1();
        if let Some(session) = &self.session {
            session.send(&bytes).await;
        }
    }

    /// 排空服务端发来的所有帧并按协议处理。
    pub async fn pump(&mut self) {
        loop {
            let Some(frame) = self.session.as_mut().and_then(Session::try_recv) else {
                // 队列空了:如果房间那边已经把这条连接摘掉,就等于断线了
                if self.closed.is_none() && self.session.as_ref().is_some_and(Session::is_closed) {
                    self.closed = Some((1006, "连接已断开".to_owned()));
                }
                break;
            };
            match frame {
                Frame::Close { code, reason } => self.closed = Some((code, reason)),
                Frame::Binary(bytes) => self.handle(&bytes).await,
            }
        }
    }

    async fn handle(&mut self, bytes: &[u8]) {
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
                Message::Awareness(update) => self.presence.push(update),
                Message::Custom(CTRL_SERVER, body) => {
                    self.ctrl
                        .push(serde_json::from_slice(&body).expect("控制消息是 JSON"));
                }
                _ => {}
            }
        }
        for reply in replies {
            self.send_message(&reply).await;
        }
    }

    /// 最近一条某类型的控制消息。
    pub fn last_ctrl(&self, kind: &str) -> Option<&Value> {
        self.ctrl.iter().rev().find(|c| c["type"] == kind)
    }

    pub fn ctrl_count(&self, kind: &str) -> usize {
        self.ctrl.iter().filter(|c| c["type"] == kind).count()
    }

    /// 文本内容(Text 结构)。
    pub fn text(&self) -> String {
        let root = self.doc.get_or_insert_text("text");
        let txn = self.doc.transact();
        root.get_string(&txn)
    }

    /// 本地编辑并把增量发出去(像浏览器里打字)。
    pub async fn insert(&self, index: u32, text: &str) {
        let before = self.doc.transact().state_vector();
        {
            let root = self.doc.get_or_insert_text("text");
            let mut txn = self.doc.transact_mut();
            root.insert(&mut txn, index, text);
        }
        self.push_since(&before).await;
    }

    pub async fn remove(&self, index: u32, len: u32) {
        let before = self.doc.transact().state_vector();
        {
            let root = self.doc.get_or_insert_text("text");
            let mut txn = self.doc.transact_mut();
            root.remove_range(&mut txn, index, len);
        }
        self.push_since(&before).await;
    }

    /// 只在本地改,不发(模拟断线时的离线编辑)。
    pub fn insert_offline(&self, index: u32, text: &str) {
        let root = self.doc.get_or_insert_text("text");
        let mut txn = self.doc.transact_mut();
        root.insert(&mut txn, index, text);
    }

    pub async fn push_since(&self, before: &StateVector) {
        let update = self.doc.transact().encode_state_as_update_v1(before);
        self.send_message(&Message::Sync(SyncMessage::Update(update)))
            .await;
    }

    /// 笔记结构:往 ProseMirror 根节点末尾加一个段落(像 Milkdown 里敲了一段话)。
    pub async fn add_paragraph(&self, text: &str) {
        let before = self.doc.transact().state_vector();
        {
            let root = self.doc.get_or_insert_xml_fragment("prosemirror");
            let mut txn = self.doc.transact_mut();
            let paragraph = root.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
            paragraph.push_back(&mut txn, XmlTextPrelim::new(text));
        }
        self.push_since(&before).await;
    }

    /// 笔记内容的字符串形式(各端比对用)。
    pub fn rich_text(&self) -> String {
        let root = self.doc.get_or_insert_xml_fragment("prosemirror");
        let txn = self.doc.transact();
        root.get_string(&txn)
    }

    /// 本地状态向量(base64),落地提交用。
    pub fn sv_b64(&self) -> String {
        base64_encode(&self.doc.transact().state_vector().encode_v1())
    }

    pub async fn land(&self, markdown: &str) {
        self.send_ctrl(
            serde_json::json!({ "type": "land", "markdown": markdown, "sv": self.sv_b64() }),
        )
        .await;
    }

    pub async fn leave(mut self) {
        self.disconnect().await;
    }

    /// 断线后重连:本地文档(含离线期间的修改)保留,换一条新连接,重新走一遍同步。
    pub async fn rejoin(&mut self, world: &World, doc: &DocRef, writable: bool) {
        world.auth.set(
            &self.who.id,
            if writable {
                Access::Write
            } else {
                Access::Read
            },
        );
        self.session = Some(
            world
                .hub
                .join(JoinRequest {
                    doc: doc.clone(),
                    who: self.who.clone(),
                    ctx: String::new(),
                    writable,
                })
                .await
                .expect("重新加入房间"),
        );
        self.closed = None;
        self.ctrl.clear();
        self.presence.clear();
        let sv = self.doc.transact().state_vector();
        self.send_message(&Message::Sync(SyncMessage::SyncStep1(sv)))
            .await;
        self.pump().await;
    }

    /// 文本长度(UTF-16 码元)。
    pub fn text_len(&self) -> u32 {
        let root = self.doc.get_or_insert_text("text");
        let txn = self.doc.transact();
        root.len(&txn)
    }
}

/// 等条件成立,最多 `ms` 毫秒。
pub async fn eventually(ms: u64, mut check: impl FnMut() -> bool) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(ms);
    loop {
        if check() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}
