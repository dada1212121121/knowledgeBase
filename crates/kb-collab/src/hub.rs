//! 把房间放进异步世界:按文档找房间、加载与持久化、定时器、会话。

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{SystemTime, UNIX_EPOCH};

use kb_core::model::Millis;
use kb_core::{KbError, Result};
use tokio::sync::{Mutex, OnceCell, mpsc};
use tokio::time::Instant;
use yrs::StateVector;
use yrs::updates::decoder::Decode;

use crate::core::{ConnId, Request, RoomCore, ServerCtrl};
use crate::hooks::{Access, CollabAuth, CollabHooks, Landing};
use crate::store::CollabStore;
use crate::types::{DocKind, DocRef, Frame, Limits, Participant};

fn now_ms() -> Millis {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as Millis)
        .unwrap_or(0)
}

/// 加入一个房间要的东西。
pub struct JoinRequest {
    /// 文档。
    pub doc: DocRef,
    /// 认定的身份。
    pub who: Participant,
    /// 不透明的上下文(经哪个分享链接进来……),权限核对时原样传回。
    pub ctx: String,
    /// 初始权限(网络层已经核对过)。
    pub writable: bool,
}

/// 管理后台看到的房间概况。
#[derive(Clone, Debug)]
pub struct RoomInfo {
    /// 文档键。
    pub key: String,
    /// 连接数。
    pub conns: usize,
    /// 有没有未落地的内容。
    pub dirty: bool,
}

struct RoomState {
    core: RoomCore,
    closed: bool,
    empty_since: Option<Instant>,
    last_flush: Instant,
    last_recheck: Instant,
    last_nudge: Option<Instant>,
    /// 最近一次落地(或初始化)时正文的哈希:正文现在的哈希和它不一样,说明被别的途径改过。
    landed_hash: Option<String>,
}

struct Room {
    doc: DocRef,
    state: Mutex<RoomState>,
}

struct Inner {
    store: Arc<dyn CollabStore>,
    hooks: Arc<dyn CollabHooks>,
    auth: Arc<dyn CollabAuth>,
    limits: Limits,
    rooms: StdMutex<HashMap<String, Arc<OnceCell<Arc<Room>>>>>,
    /// 谁现在待在哪些房间里(按人 → 文档键 → 连接数),用来给每个人限额。
    memberships: StdMutex<HashMap<String, HashMap<String, usize>>>,
}

/// 一个人占着某篇文档的名额。随 [`Session`] 一起释放(正常离开、任务被取消都一样)。
struct RoomLease {
    inner: Arc<Inner>,
    user: String,
    doc: String,
}

impl Drop for RoomLease {
    fn drop(&mut self) {
        let mut map = self
            .inner
            .memberships
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(rooms) = map.get_mut(&self.user) {
            if let Some(count) = rooms.get_mut(&self.doc) {
                *count -= 1;
                if *count == 0 {
                    rooms.remove(&self.doc);
                }
            }
            if rooms.is_empty() {
                map.remove(&self.user);
            }
        }
    }
}

/// 协作中心:全站一个。
#[derive(Clone)]
pub struct CollabHub {
    inner: Arc<Inner>,
}

impl CollabHub {
    /// 新建。
    pub fn new(
        store: Arc<dyn CollabStore>,
        hooks: Arc<dyn CollabHooks>,
        auth: Arc<dyn CollabAuth>,
        limits: Limits,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                store,
                hooks,
                auth,
                limits,
                rooms: StdMutex::new(HashMap::new()),
                memberships: StdMutex::new(HashMap::new()),
            }),
        }
    }

    /// 加入一篇文档的房间(没有就开)。
    pub async fn join(&self, request: JoinRequest) -> Result<Session> {
        // 先占这个人的名额,再去开房间:被拒绝的人不能顺手把房间开出来
        let lease = self
            .inner
            .lease(&request.who.id, &request.doc.key)
            .ok_or_else(|| {
                KbError::Unavailable(format!(
                    "你同时在线编辑的文档太多(最多 {} 篇),请先关掉几篇",
                    self.inner.limits.max_rooms_per_user
                ))
            })?;
        for _ in 0..3 {
            let room = self.inner.room_for(&request.doc).await?;
            let mut state = room.state.lock().await;
            if state.closed {
                // 正好在关:稍后重新开一个
                drop(state);
                tokio::task::yield_now().await;
                continue;
            }
            // 闲置着的房间(最后一人走了、还没到关闭时间)里的内容可能已经过期:这段时间里
            // API、导入、批次撤销都可能改过正文。正文哈希对不上就作废重开,按新正文初始化
            if state.empty_since.is_some() {
                let body = self.inner.hooks.load_body(&request.doc).await?;
                if state.landed_hash.as_deref() != Some(self.inner.hooks.hash(&body.text).as_str())
                {
                    self.inner.retire(&room, &mut state);
                    drop(state);
                    continue;
                }
            }
            let (tx, rx) = mpsc::channel(self.inner.limits.send_queue);
            let Some(conn) = state.core.join(
                request.who.clone(),
                request.ctx.clone(),
                request.writable,
                tx,
                Instant::now(),
            ) else {
                return Err(KbError::Unavailable(
                    "这篇文档的在线编辑人数已满,请稍后再试".to_owned(),
                ));
            };
            state.empty_since = None;
            drop(state);
            return Ok(Session {
                inner: self.inner.clone(),
                room,
                conn,
                rx,
                left: false,
                _lease: lease,
            });
        }
        Err(KbError::Internal("房间正在切换,请重试".to_owned()))
    }

    /// 文档还在不在(网络层握手时先问一句)。
    pub async fn doc_exists(&self, doc: &DocRef) -> bool {
        self.inner.hooks.exists(doc).await
    }

    /// 这篇文档现在是不是在被协作编辑(有人连着,或者还有没落地 / 没写盘的内容)。
    /// 用 API 直接写正文前先问它:是就返回 409,否则会把别人正在写的内容覆盖掉。
    pub async fn is_busy(&self, key: &str) -> bool {
        let cell = self.inner.rooms.lock().unwrap().get(key).cloned();
        let Some(room) = cell.and_then(|cell| cell.get().cloned()) else {
            return false;
        };
        let state = room.state.lock().await;
        !state.closed
            && (state.core.conn_count() > 0 || state.core.is_dirty() || state.core.has_pending())
    }

    /// 在正开着的房间里直接做几处文字替换(AI 改正在多人编辑的文档):修改实时出现在每个人的编辑器里,
    /// 之后照常落地。没有开着的房间返回 `None`,调用方直接改存储里的正文。
    pub async fn apply_edits(
        &self,
        key: &str,
        edits: &[(String, String)],
        author: Participant,
    ) -> Option<Result<usize>> {
        let cell = self.inner.rooms.lock().unwrap().get(key).cloned();
        let room = cell.and_then(|cell| cell.get().cloned())?;
        let mut state = room.state.lock().await;
        if state.closed {
            return None;
        }
        Some(
            state
                .core
                .apply_text_edits(edits, &author, Instant::now())
                .map_err(KbError::InvalidInput),
        )
    }

    /// 正开着的房间里现在的内容(给 AI 看,见 `RoomCore::plain_text`)。没有开着的房间返回 `None`。
    pub async fn read_live(&self, key: &str) -> Option<String> {
        let cell = self.inner.rooms.lock().unwrap().get(key).cloned();
        let room = cell.and_then(|cell| cell.get().cloned())?;
        let state = room.state.lock().await;
        (!state.closed).then(|| state.core.plain_text())
    }

    /// 立刻重新核对匹配的房间里每个连接的权限(授权变更、账号停用时调用)。
    pub async fn refresh_where(&self, matches: impl Fn(&str) -> bool) {
        let rooms: Vec<Arc<Room>> = {
            let map = self.inner.rooms.lock().unwrap();
            map.iter()
                .filter(|(key, _)| matches(key))
                .filter_map(|(_, cell)| cell.get().cloned())
                .collect()
        };
        for room in rooms {
            let mut state = room.state.lock().await;
            if !state.closed {
                self.inner.recheck(&room, &mut state).await;
            }
        }
    }

    /// 文档正文被协作之外的途径写过了(API 的竞态窗口里也可能发生):把房间里的人请出去重新打开,
    /// 重开时会按新正文初始化。没有房间就什么也不做。
    pub async fn external_write(&self, key: &str) {
        let cell = self.inner.rooms.lock().unwrap().get(key).cloned();
        let Some(room) = cell.and_then(|cell| cell.get().cloned()) else {
            return;
        };
        let mut state = room.state.lock().await;
        if state.closed {
            return;
        }
        let ids: Vec<ConnId> = state.core.recheck_targets().iter().map(|t| t.0).collect();
        for id in ids {
            state.core.kick(id, 4409, "文档在别处被修改了,请重新打开");
        }
        self.inner.retire(&room, &mut state);
    }

    /// 文档被删除了:断开房间里所有人并丢弃房间,**不**写盘、不落地、不生成保存点
    /// (内容已经没有归宿)。协作状态的清理由调用方另做。
    pub async fn discard_where(&self, matches: impl Fn(&str) -> bool, reason: &str) {
        let rooms: Vec<(String, Arc<Room>)> = {
            let map = self.inner.rooms.lock().unwrap();
            map.iter()
                .filter(|(key, _)| matches(key))
                .filter_map(|(key, cell)| cell.get().cloned().map(|room| (key.clone(), room)))
                .collect()
        };
        for (_key, room) in rooms {
            let mut state = room.state.lock().await;
            if state.closed {
                continue;
            }
            let ids: Vec<ConnId> = state.core.recheck_targets().iter().map(|t| t.0).collect();
            for id in ids {
                state.core.kick(id, 4404, reason);
            }
            self.inner.retire(&room, &mut state);
        }
    }

    /// 现在有几个房间开着(含正在关闭前的闲置房间)。
    pub fn open_rooms(&self) -> usize {
        self.inner
            .rooms
            .lock()
            .unwrap()
            .values()
            .filter(|cell| cell.get().is_some())
            .count()
    }

    /// 当前打开的房间。
    pub async fn rooms(&self) -> Vec<RoomInfo> {
        let rooms: Vec<Arc<Room>> = self
            .inner
            .rooms
            .lock()
            .unwrap()
            .values()
            .filter_map(|cell| cell.get().cloned())
            .collect();
        let mut out = Vec::new();
        for room in rooms {
            let state = room.state.lock().await;
            if !state.closed {
                out.push(RoomInfo {
                    key: room.doc.key.clone(),
                    conns: state.core.conn_count(),
                    dirty: state.core.is_dirty(),
                });
            }
        }
        out
    }

    /// 关闭所有房间:写盘、落地、保存点。守护进程退出前调用。
    pub async fn shutdown(&self) {
        let rooms: Vec<Arc<Room>> = self
            .inner
            .rooms
            .lock()
            .unwrap()
            .values()
            .filter_map(|cell| cell.get().cloned())
            .collect();
        for room in rooms {
            let mut state = room.state.lock().await;
            if !state.closed {
                let ids: Vec<ConnId> = state.core.recheck_targets().iter().map(|t| t.0).collect();
                for id in ids {
                    state.core.kick(id, 1001, "服务正在重启");
                }
                self.inner.close_room(&room, &mut state).await;
            }
        }
    }
}

impl Inner {
    /// 占一个人在某篇文档里的名额。已经在这篇文档里(多开标签页)不算新的一篇;
    /// 这个人待的不同文档数到了上限就拒绝。
    fn lease(self: &Arc<Self>, user: &str, doc: &str) -> Option<RoomLease> {
        let mut map = self
            .memberships
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let rooms = map.entry(user.to_owned()).or_default();
        if !rooms.contains_key(doc) && rooms.len() >= self.limits.max_rooms_per_user {
            if rooms.is_empty() {
                map.remove(user);
            }
            return None;
        }
        *rooms.entry(doc.to_owned()).or_default() += 1;
        Some(RoomLease {
            inner: self.clone(),
            user: user.to_owned(),
            doc: doc.to_owned(),
        })
    }

    async fn room_for(self: &Arc<Self>, doc: &DocRef) -> Result<Arc<Room>> {
        let cell = {
            let mut rooms = self.rooms.lock().unwrap();
            if rooms.len() >= self.limits.max_rooms && !rooms.contains_key(&doc.key) {
                return Err(KbError::Unavailable(
                    "同时在线编辑的文档太多,请稍后再试".to_owned(),
                ));
            }
            rooms.entry(doc.key.clone()).or_default().clone()
        };
        let opened = cell
            .get_or_try_init(|| async { self.open_room(doc).await })
            .await;
        match opened {
            Ok(room) => Ok(room.clone()),
            Err(err) => {
                let mut rooms = self.rooms.lock().unwrap();
                if rooms.get(&doc.key).is_some_and(|c| c.get().is_none()) {
                    rooms.remove(&doc.key);
                }
                Err(err)
            }
        }
    }

    async fn open_room(self: &Arc<Self>, doc: &DocRef) -> Result<Arc<Room>> {
        let body = self.hooks.load_body(doc).await?;
        let body_hash = self.hooks.hash(&body.text);
        let mut stored = self.store.load(&doc.key).await?;
        // 正文被别的途径(API、恢复版本、批次撤销)改过,或结构对不上:协作状态作废,按正文重新开始
        if let Some(found) = &stored
            && (found.kind.is_some_and(|k| k != doc.kind)
                || found.landed_hash.as_ref().is_some_and(|h| *h != body_hash))
        {
            self.store.reset(&doc.key).await?;
            stored = None;
        }
        let (snapshot, updates, landed_sv) = match &stored {
            Some(found) => (
                found.snapshot.clone(),
                found.updates.clone(),
                found.materialized_sv.clone(),
            ),
            None => (Vec::new(), Vec::new(), None),
        };
        let fresh = snapshot.is_empty() && updates.is_empty();
        let now = Instant::now();
        let core = RoomCore::new(
            doc.clone(),
            self.limits.clone(),
            &snapshot,
            &updates,
            landed_sv.as_deref(),
            Some(body.text.clone()),
            now,
        )
        .map_err(KbError::Internal)?;
        // 文本文档的初始化由服务端做完了:内容 = 正文,记为已落地
        if fresh && doc.kind == DocKind::Text {
            self.store
                .set_landed(&doc.key, &core.state_vector(), &body_hash, now_ms())
                .await?;
        }
        let room = Arc::new(Room {
            doc: doc.clone(),
            state: Mutex::new(RoomState {
                core,
                closed: false,
                empty_since: None,
                last_flush: now,
                last_recheck: now,
                last_nudge: None,
                landed_hash: Some(body_hash),
            }),
        });
        tokio::spawn(run_room(self.clone(), room.clone()));
        Ok(room)
    }

    /// 写盘:把攒着的更新合并成一条追加,必要时并快照。
    async fn flush(&self, room: &Room, state: &mut RoomState) {
        state.last_flush = Instant::now();
        let pending = state.core.take_pending();
        if !pending.is_empty() {
            let merged = if pending.len() == 1 {
                Ok(pending[0].0.clone())
            } else {
                yrs::merge_updates_v1(pending.iter().map(|(blob, _)| blob.as_slice()))
                    .map_err(|err| err.to_string())
            };
            let user = pending
                .iter()
                .rev()
                .map(|(_, user)| user.as_str())
                .find(|user| !user.is_empty())
                .unwrap_or("")
                .to_owned();
            match merged {
                Ok(blob) => {
                    match self
                        .store
                        .append(&room.doc.key, room.doc.kind, &blob, &user, now_ms())
                        .await
                    {
                        Ok(()) => state.core.flushed(1, blob.len()),
                        Err(err) => {
                            tracing::warn!(doc = %room.doc.key, error = %err, "协作更新写盘失败,稍后重试");
                            state.core.requeue(pending);
                            return;
                        }
                    }
                }
                Err(err) => {
                    // 合并失败说明某条更新坏了:逐条写,保住能写的
                    tracing::warn!(doc = %room.doc.key, error = %err, "合并协作更新失败,改为逐条写盘");
                    for (blob, user) in &pending {
                        if let Err(err) = self
                            .store
                            .append(&room.doc.key, room.doc.kind, blob, user, now_ms())
                            .await
                        {
                            tracing::warn!(doc = %room.doc.key, error = %err, "协作更新写盘失败");
                        } else {
                            state.core.flushed(1, blob.len());
                        }
                    }
                }
            }
        }
        if state.core.should_compact() {
            self.compact(room, state).await;
        }
    }

    async fn compact(&self, room: &Room, state: &mut RoomState) {
        // 先把还没写盘的写掉,再用完整状态替换快照,这样快照一定不落后于库里的增量
        let full = state.core.full_state();
        match self
            .store
            .compact(&room.doc.key, room.doc.kind, &full, now_ms())
            .await
        {
            Ok(()) => state.core.compacted(full.len()),
            Err(err) => tracing::warn!(doc = %room.doc.key, error = %err, "合并协作快照失败"),
        }
    }

    /// 文本文档由服务端自己落地。
    async fn land_text(&self, room: &Room, state: &mut RoomState) {
        let text = state.core.text();
        let landing = Landing {
            text,
            savepoint: false,
            participants: state.core.participants(),
        };
        match self.hooks.land(&room.doc, landing).await {
            Ok(hash) => {
                if let Err(err) = self
                    .store
                    .set_landed(&room.doc.key, &state.core.state_vector(), &hash, now_ms())
                    .await
                {
                    tracing::warn!(doc = %room.doc.key, error = %err, "记录落地状态失败");
                }
                state.core.record_landed_now();
                state
                    .core
                    .notify_all(&ServerCtrl::Saved { savepoint: false });
            }
            Err(err) => {
                tracing::warn!(doc = %room.doc.key, error = %err, "文本落地失败,稍后重试");
            }
        }
    }

    async fn savepoint(&self, room: &Room, state: &mut RoomState) {
        let participants = state.core.participants();
        if participants.is_empty() {
            state.core.savepoint_done();
            return;
        }
        match self.hooks.savepoint(&room.doc, participants).await {
            Ok(()) => {
                state.core.savepoint_done();
                state
                    .core
                    .notify_all(&ServerCtrl::Saved { savepoint: true });
            }
            Err(err) => {
                tracing::warn!(doc = %room.doc.key, error = %err, "生成保存点失败,稍后重试");
            }
        }
    }

    async fn recheck(&self, room: &Room, state: &mut RoomState) {
        state.last_recheck = Instant::now();
        for (conn, who, ctx, writable) in state.core.recheck_targets() {
            match self.auth.access(&room.doc, &who, &ctx).await {
                Access::Denied => state.core.kick(conn, 4403, "你已经没有这篇文档的权限"),
                Access::Read if writable => {
                    state.core.set_conn_writable(conn, false, Instant::now());
                }
                Access::Write if !writable => {
                    state.core.set_conn_writable(conn, true, Instant::now());
                }
                _ => {}
            }
        }
    }

    async fn handle_request(&self, room: &Room, state: &mut RoomState, request: Request) {
        match request {
            Request::InitDone { sv } => {
                if let Some(hash) = state.landed_hash.clone()
                    && let Err(err) = self
                        .store
                        .set_landed(&room.doc.key, &sv, &hash, now_ms())
                        .await
                {
                    tracing::warn!(doc = %room.doc.key, error = %err, "记录初始化状态失败");
                }
                state.core.record_landed_now();
            }
            Request::Land { conn, markdown, sv } => {
                let landing = Landing {
                    text: markdown,
                    savepoint: false,
                    participants: state.core.participants(),
                };
                match self.hooks.land(&room.doc, landing).await {
                    Ok(hash) => {
                        // 落地者也算这段时间的参与者:保存点的版本历史要把他记上(光靠 apply_update
                        // 收不到 —— 落地走的是服务端直接写库)
                        state.core.record_lander(conn);
                        if let Ok(client_sv) = StateVector::decode_v1(&sv) {
                            state.core.record_landed(client_sv);
                        }
                        if let Err(err) = self
                            .store
                            .set_landed(&room.doc.key, &sv, &hash, now_ms())
                            .await
                        {
                            tracing::warn!(doc = %room.doc.key, error = %err, "记录落地状态失败");
                        }
                        state.landed_hash = Some(hash);
                        state
                            .core
                            .notify(conn, &ServerCtrl::Saved { savepoint: false });
                    }
                    Err(err) => state.core.notify(
                        conn,
                        &ServerCtrl::Rejected {
                            reason: format!("保存失败:{err}"),
                        },
                    ),
                }
            }
            Request::SavePoint { conn } => {
                let _ = conn;
                self.savepoint(room, state).await;
            }
        }
    }

    async fn on_tick(&self, room: &Room, state: &mut RoomState) {
        let now = Instant::now();
        state.core.tick(now);
        if state.core.has_pending()
            && now.duration_since(state.last_flush) >= self.limits.flush_interval
        {
            self.flush(room, state).await;
        }
        let idle_for = state.core.last_change().map(|at| now.duration_since(at));
        // 文本:内容停止变化一阵后服务端自己落地
        if room.doc.kind == DocKind::Text
            && state.core.is_dirty()
            && idle_for.is_some_and(|idle| idle >= self.limits.land_debounce)
        {
            self.land_text(room, state).await;
        }
        // 笔记:落地者迟迟没提交就催一下
        if room.doc.kind == DocKind::Rich
            && state.core.is_dirty()
            && idle_for.is_some_and(|idle| idle >= self.limits.land_debounce * 3)
            && state
                .last_nudge
                .is_none_or(|at| now.duration_since(at) >= self.limits.land_debounce * 3)
            && state.core.nudge_lander()
        {
            state.last_nudge = Some(now);
        }
        // 保存点:内容都落地了,且所有人空闲够久
        if state.core.savepoint_due()
            && !state.core.is_dirty()
            && idle_for.is_some_and(|idle| idle >= self.limits.savepoint_idle)
        {
            self.savepoint(room, state).await;
        }
        if now.duration_since(state.last_recheck) >= self.limits.recheck_interval {
            self.recheck(room, state).await;
        }
        // 没人了:先立刻写盘 / 落地 / 保存点(每个人离开时已经做过),再到点关房
        if state.core.conn_count() == 0 {
            let since = *state.empty_since.get_or_insert(now);
            if now.duration_since(since) >= self.limits.idle_close {
                self.close_room(room, state).await;
            }
        }
    }

    /// 最后一个人离开时立刻做完该做的事,不等房间关闭。
    async fn on_empty(&self, room: &Room, state: &mut RoomState) {
        state.empty_since = Some(Instant::now());
        self.flush(room, state).await;
        if room.doc.kind == DocKind::Text && state.core.is_dirty() {
            self.land_text(room, state).await;
        }
        if state.core.savepoint_due() && !state.core.is_dirty() {
            self.savepoint(room, state).await;
        }
    }

    /// 房间作废:标记关闭并从表里摘掉(不写盘、不落地)。
    fn retire(&self, room: &Room, state: &mut RoomState) {
        state.closed = true;
        let mut rooms = self.rooms.lock().unwrap();
        if rooms
            .get(&room.doc.key)
            .and_then(|cell| cell.get())
            .is_some_and(|current| std::ptr::eq(Arc::as_ptr(current), room))
        {
            rooms.remove(&room.doc.key);
        }
    }

    async fn close_room(&self, room: &Room, state: &mut RoomState) {
        self.flush(room, state).await;
        if room.doc.kind == DocKind::Text && state.core.is_dirty() {
            self.land_text(room, state).await;
        }
        if state.core.savepoint_due() && !state.core.is_dirty() {
            self.savepoint(room, state).await;
        }
        self.compact(room, state).await;
        state.closed = true;
        let mut rooms = self.rooms.lock().unwrap();
        if rooms
            .get(&room.doc.key)
            .and_then(|cell| cell.get())
            .is_some_and(|current| std::ptr::eq(Arc::as_ptr(current), room))
        {
            rooms.remove(&room.doc.key);
        }
    }
}

async fn run_room(inner: Arc<Inner>, room: Arc<Room>) {
    let mut interval = tokio::time::interval(inner.limits.tick);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        interval.tick().await;
        let mut state = room.state.lock().await;
        if state.closed {
            break;
        }
        inner.on_tick(&room, &mut state).await;
        if state.closed {
            break;
        }
    }
}

/// 一条连接。网络层(WebSocket)拿着它:收到的二进制交给 [`Session::send`],
/// 从 [`Session::recv`] 取要发出去的帧。
pub struct Session {
    inner: Arc<Inner>,
    room: Arc<Room>,
    conn: ConnId,
    rx: mpsc::Receiver<Frame>,
    left: bool,
    /// 这个人占的名额;Session 没了它就自动释放。
    _lease: RoomLease,
}

impl Session {
    /// 连接 id。
    pub fn id(&self) -> ConnId {
        self.conn
    }

    /// 取下一帧要发出去的内容;房间那边把这条连接移除(被踢、房间关闭)后返回 `None`。
    pub async fn recv(&mut self) -> Option<Frame> {
        self.rx.recv().await
    }

    /// 不等待地取一帧(没有就 `None`)。测试和批量排空用。
    pub fn try_recv(&mut self) -> Option<Frame> {
        self.rx.try_recv().ok()
    }

    /// 房间那边是否已经把这条连接移除(被踢、房间关闭)。网络层据此关掉 WebSocket,
    /// 客户端会自动重连并补齐差异。被踢时发送队列往往是满的,关闭帧塞不进去,只能靠这个发现。
    pub fn is_closed(&self) -> bool {
        self.rx.is_closed()
    }

    /// 处理客户端发来的二进制消息。
    pub async fn send(&self, data: &[u8]) {
        let mut state = self.room.state.lock().await;
        if state.closed {
            return;
        }
        let requests = state.core.on_binary(self.conn, data, Instant::now());
        for request in requests {
            self.inner
                .handle_request(&self.room, &mut state, request)
                .await;
        }
    }

    /// 离开。
    pub async fn leave(mut self) {
        self.left = true;
        let mut state = self.room.state.lock().await;
        if state.closed {
            return;
        }
        state.core.leave(self.conn, Instant::now());
        if state.core.conn_count() == 0 {
            self.inner.on_empty(&self.room, &mut state).await;
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if self.left {
            return;
        }
        // 网络层没来得及调 leave(任务被取消 / panic):补一个,否则这条连接会一直占着房间
        let inner = self.inner.clone();
        let room = self.room.clone();
        let conn = self.conn;
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            handle.spawn(async move {
                let mut state = room.state.lock().await;
                if state.closed {
                    return;
                }
                state.core.leave(conn, Instant::now());
                if state.core.conn_count() == 0 {
                    inner.on_empty(&room, &mut state).await;
                }
            });
        }
    }
}
