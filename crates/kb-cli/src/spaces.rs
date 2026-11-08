//! 知识库注册表:把「谁」映射到「哪个知识库的存储」(多用户设计说明)。
//!
//! - **主知识库**(`sp_primary`)就是守护进程启动时打开的那个运行时(`KB_HOME` 根目录),本机 `kb.sock` 超级用户用它;
//! - **其他知识库**在第一次被用到时才打开(`spaces/<id>/`),之后缓存在内存里。多个请求同时第一次访问同一个知识库,
//!   只会打开一次(每个知识库一把锁,打开期间后来的请求等着);
//! - 其他知识库**空闲一段时间后关掉**(后半,[`SpaceRegistry::close_idle`]):停掉它的后台任务,放掉数据库连接
//!   和文件句柄,下次有人访问时再打开。以前打开过的知识库一直开到进程退出,每个都有一个 worker 和一个调度器在跑;
//! - 每次「知识库内」的能力调用都经过 [`SpaceResolver::resolve`]:调用者只可能解析到**自己的**知识库,
//!   这是隔离的第一道防线——别人的 id 在这个用户的存储里根本不存在。

use std::collections::HashMap;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use kb_capability::{Principal, ResolvedSpace, SpaceResolver};
use kb_core::account::PRIMARY_SPACE_ID;
use kb_core::model::AuditEntry;
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{AuditRepo, UploadRepo};
use kb_core::{KbError, Result};
use kb_meta::SystemStore;
use tokio::sync::Mutex;

use crate::bundle::SpaceTasks;
use crate::runtime::Embedded;

/// 非主知识库多久没人用就关掉。
///
/// 关掉以后再访问要重新打开(SQLite 和向量库各连一次,通常不到一秒),所以不能太短;
/// 标签页切到后台以后前端不再定时刷新,人离开半小时就算空闲。
pub const IDLE_CLOSE_AFTER: Duration = Duration::from_secs(30 * 60);

/// 知识库被打开时的回调:守护进程在这里给它起后台任务,返回的句柄由注册表保管,关掉时用它停。
pub type OnOpen = Arc<dyn Fn(String, Arc<Embedded>) -> SpaceTasks + Send + Sync>;

/// 注册表里一个非主知识库的位置。
struct Slot {
    state: Mutex<SlotState>,
    /// 最近一次被请求的时刻。
    last_used: std::sync::Mutex<Instant>,
}

enum SlotState {
    /// 还没打开,或空闲后关掉了。`previous` 指向关掉时的运行时:关掉之后还有人拿着它
    /// (比如一次很长的导出),下次打开就接着用同一份,不再开第二份——两份会各有一套写闸门和 SQLite 写连接。
    Closed { previous: Weak<Embedded> },
    /// 打开着。`tasks` 是它的后台任务(没设回调时为空,比如测试)。
    Open {
        runtime: Arc<Embedded>,
        tasks: Option<SpaceTasks>,
    },
}

impl Slot {
    fn new() -> Self {
        Self {
            state: Mutex::new(SlotState::Closed {
                previous: Weak::new(),
            }),
            last_used: std::sync::Mutex::new(Instant::now()),
        }
    }

    fn touch(&self) {
        if let Ok(mut at) = self.last_used.lock() {
            *at = Instant::now();
        }
    }

    /// 到 `now` 为止已经有 `idle_for` 没人用了。
    fn idle(&self, now: Instant, idle_for: Duration) -> bool {
        self.last_used
            .lock()
            .map(|at| now.saturating_duration_since(*at) >= idle_for)
            .unwrap_or(false)
    }
}

/// 知识库注册表。
pub struct SpaceRegistry {
    primary: Arc<Embedded>,
    system: Option<Arc<SystemStore>>,
    paths: KbPaths,
    open: Mutex<HashMap<String, Arc<Slot>>>,
    /// 已核对过归属的知识库:`space_id -> owner_id`。
    owners: std::sync::Mutex<HashMap<String, String>>,
    on_open: std::sync::OnceLock<OnOpen>,
}

impl SpaceRegistry {
    /// 多用户模式:有账号库,能打开别人的知识库。
    pub fn new(primary: Arc<Embedded>, system: Arc<SystemStore>, paths: KbPaths) -> Arc<Self> {
        Arc::new(Self {
            primary,
            system: Some(system),
            paths,
            open: Mutex::new(HashMap::new()),
            owners: std::sync::Mutex::new(HashMap::new()),
            on_open: std::sync::OnceLock::new(),
        })
    }

    /// 账号库。
    pub fn system(&self) -> Option<&Arc<SystemStore>> {
        self.system.as_ref()
    }

    /// 设置「知识库被打开」的回调。只能设一次。
    pub fn set_on_open(&self, callback: OnOpen) {
        let _ = self.on_open.set(callback);
    }

    fn start_tasks(&self, space_id: &str, runtime: &Arc<Embedded>) -> Option<SpaceTasks> {
        self.on_open
            .get()
            .map(|callback| callback(space_id.to_owned(), runtime.clone()))
    }

    /// 取某个知识库的运行时,没打开(或空闲后关掉了)就打开。非主知识库必须在账号库里登记过。
    pub async fn get(&self, space_id: &str) -> Result<Arc<Embedded>> {
        if space_id == PRIMARY_SPACE_ID {
            return Ok(self.primary.clone());
        }
        let Some(system) = &self.system else {
            return Err(KbError::Forbidden(
                "当前是单库模式,没有这个知识库".to_owned(),
            ));
        };
        let slot = {
            let mut open = self.open.lock().await;
            open.entry(space_id.to_owned())
                .or_insert_with(|| Arc::new(Slot::new()))
                .clone()
        };
        slot.touch();
        let mut state = slot.state.lock().await;
        let previous = match &*state {
            SlotState::Open { runtime, .. } => return Ok(runtime.clone()),
            SlotState::Closed { previous } => previous.upgrade(),
        };
        let runtime = match previous {
            Some(alive) => alive,
            None => self.open_runtime(system, space_id).await?,
        };
        let tasks = self.start_tasks(space_id, &runtime);
        *state = SlotState::Open {
            runtime: runtime.clone(),
            tasks,
        };
        tracing::info!(space = space_id, "已打开知识库");
        Ok(runtime)
    }

    async fn open_runtime(&self, system: &SystemStore, space_id: &str) -> Result<Arc<Embedded>> {
        if system.get_space(space_id).await?.is_none() {
            return Err(KbError::NotFound(format!("知识库 {space_id}")));
        }
        let space_paths = self.paths.for_space(space_id)?;
        let opened = self
            .primary
            .open_space(space_id, space_paths)
            .await
            .map_err(|err| KbError::Internal(format!("打开知识库 {space_id} 失败: {err}")))?;
        let opened = Arc::new(opened);
        // 第一个请求就可能是「新建笔记」:`_global` 必须在知识库对外可用之前就存在,
        // 不能等后台任务去建(那样第一个请求会随机地 404)
        opened.collections().ensure_global().await?;
        // 从备份恢复出来的知识库没有向量表:补上,条目重新嵌入
        opened.heal_restored_tables().await;
        Ok(opened)
    }

    /// 关掉空闲的非主知识库:停掉它的后台任务(作业 worker + 调度器),放掉它的数据库连接和文件句柄,
    /// 下次有人访问时再打开。返回这次关掉的知识库 id。守护进程每分钟调一次。
    ///
    /// 不关的情况:最近 `idle_for` 内有人用过;调度器正在执行一拍;队列里还有排队中或运行中的任务
    /// (关了就要等到下次有人访问才会执行);还有没传完的上传(超时清理在调度器里,关了就没人清了)。
    pub async fn close_idle(&self, now: Instant, idle_for: Duration) -> Vec<String> {
        let slots: Vec<(String, Arc<Slot>)> = self
            .open
            .lock()
            .await
            .iter()
            .map(|(id, slot)| (id.clone(), slot.clone()))
            .collect();
        let mut closed = Vec::new();
        for (space_id, slot) in slots {
            if !slot.idle(now, idle_for) {
                continue;
            }
            let mut state = slot.state.lock().await;
            // 上面判断空闲到拿到锁之间,可能刚好有请求来过(它在等这把锁):别刚用完就关
            if !slot.idle(now, idle_for) {
                continue;
            }
            match &mut *state {
                SlotState::Open { runtime, tasks } => {
                    if tasks.as_ref().is_some_and(SpaceTasks::busy) || has_work(runtime).await {
                        continue;
                    }
                    if let Some(running) = tasks.take() {
                        running.stop().await;
                    }
                    // 停的这一会儿,还拿着运行时的请求可能投了新任务:把后台重新起来,这次不关
                    if has_work(runtime).await {
                        *tasks = self.start_tasks(&space_id, runtime);
                        continue;
                    }
                    let previous = Arc::downgrade(runtime);
                    *state = SlotState::Closed { previous };
                    closed.push(space_id);
                }
                SlotState::Closed { previous } => {
                    // 关掉以后仍有人拿着运行时、还往队列里投了任务(很少见):把后台重新起来,
                    // 不然这些任务要等到下次有人访问才会执行
                    if let Some(alive) = previous.upgrade()
                        && has_work(&alive).await
                    {
                        let tasks = self.start_tasks(&space_id, &alive);
                        *state = SlotState::Open {
                            runtime: alive,
                            tasks,
                        };
                    }
                }
            }
        }
        closed
    }

    /// 守护进程退出时,取走所有打开着的知识库的后台任务,由调用方等它们收尾
    /// (全局关闭信号已经转给了它们)。
    pub async fn take_tasks(&self) -> Vec<SpaceTasks> {
        let slots: Vec<Arc<Slot>> = self.open.lock().await.values().cloned().collect();
        let mut taken = Vec::new();
        for slot in slots {
            if let SlotState::Open { tasks, .. } = &mut *slot.state.lock().await
                && let Some(running) = tasks.take()
            {
                taken.push(running);
            }
        }
        taken
    }

    /// 启动时把「还有活儿没干完」的非主知识库重新拉起来。
    ///
    /// 非主知识库是按请求懒加载的(`get` 收到请求才 `open_runtime` 并起后台任务),
    /// 恢复中断任务的 `queue.recover` / `recover_inflight` 也就只在那一刻跑。
    /// 守护进程重启后没人访问这个知识库,批次就停在原地:文件全留在 `queued`,
    /// 界面看着在跑其实一动不动(2026-11-07 生产重启后踩到过)。
    ///
    /// 所以启动后扫一遍账号库:有排队任务或没传完的上传就打开(顺带把恢复跑了),
    /// 没活儿的立刻放掉——开一个知识库要各连一次 SQLite 和向量库,不能给空库白占。
    pub async fn resume_unfinished(&self) -> Vec<String> {
        let Some(system) = &self.system else {
            return Vec::new();
        };
        let spaces = match system.list_spaces().await {
            Ok(spaces) => spaces,
            Err(err) => {
                tracing::warn!(error = %err, "列举知识库失败,启动时跳过未完成任务的恢复");
                return Vec::new();
            }
        };
        let mut resumed = Vec::new();
        for space in spaces {
            // 主知识库启动时已经恢复过一遍,不用再走懒加载这条路
            if space.id == PRIMARY_SPACE_ID {
                continue;
            }
            let runtime = match self.get(&space.id).await {
                Ok(runtime) => runtime,
                // 单个知识库打不开(目录丢了、库坏了)不能挡住后面的:记一条,继续
                Err(err) => {
                    tracing::warn!(space = %space.id, error = %err, "启动时打开知识库失败");
                    continue;
                }
            };
            if has_work(&runtime).await {
                resumed.push(space.id);
                continue;
            }
            self.release(&space.id).await;
        }
        resumed
    }

    /// 立刻放掉一个知识库(停掉后台任务、标记为已关闭),不等空闲超时。
    ///
    /// 只给启动时的探测用:打开是为了看它有没有活儿,没活儿要马上还回去。
    async fn release(&self, space_id: &str) {
        let slot = self.open.lock().await.get(space_id).cloned();
        let Some(slot) = slot else {
            return;
        };
        let mut state = slot.state.lock().await;
        if let SlotState::Open { runtime, tasks } = &mut *state {
            if let Some(running) = tasks.take() {
                running.stop().await;
            }
            let previous = Arc::downgrade(runtime);
            *state = SlotState::Closed { previous };
        }
    }

    /// 把一个知识库从缓存里摘掉(账号被真正删除之前用)。主知识库不能摘。
    ///
    /// 先停掉它的后台任务(等 worker 做完手上这一片):调用方接着要删它的目录,不能还有任务在里面写。
    /// 已经拿到 `Arc<Embedded>` 的请求会各自释放。
    pub async fn evict(&self, space_id: &str) -> Result<()> {
        if space_id == PRIMARY_SPACE_ID {
            return Err(KbError::Forbidden("主知识库不能摘除".to_owned()));
        }
        let slot = self.open.lock().await.remove(space_id);
        if let Some(slot) = slot {
            let mut state = slot.state.lock().await;
            if let SlotState::Open { tasks, .. } = &mut *state
                && let Some(running) = tasks.take()
            {
                running.stop().await;
            }
            *state = SlotState::Closed {
                previous: Weak::new(),
            };
        }
        if let Ok(mut owners) = self.owners.lock() {
            owners.remove(space_id);
        }
        Ok(())
    }

    /// 核对「这个用户确实拥有这个知识库」。第一次查账号库,之后用缓存。
    async fn check_owner(&self, space_id: &str, user_id: &str) -> Result<()> {
        if let Ok(owners) = self.owners.lock()
            && let Some(owner) = owners.get(space_id)
        {
            return if owner == user_id {
                Ok(())
            } else {
                Err(KbError::Forbidden("这个知识库不属于你".to_owned()))
            };
        }
        let Some(system) = &self.system else {
            return Ok(());
        };
        let space = system
            .get_space(space_id)
            .await?
            .ok_or_else(|| KbError::Forbidden("没有可用的知识库".to_owned()))?;
        if let Ok(mut owners) = self.owners.lock() {
            owners.insert(space_id.to_owned(), space.owner_id.clone());
        }
        if space.owner_id == user_id {
            Ok(())
        } else {
            Err(KbError::Forbidden("这个知识库不属于你".to_owned()))
        }
    }

    /// 给一个调用者选定运行时(上传、事件等不经过能力调用器的入口用)。
    pub async fn runtime_for(&self, principal: &Principal) -> Result<Arc<Embedded>> {
        let space_id = self.space_id_for(principal)?;
        if !principal.local {
            self.check_owner(&space_id, &principal.user_id).await?;
        }
        self.get(&space_id).await
    }

    /// 调用者对应的知识库 id:本机超级用户是主知识库,用户是自己的个人知识库。
    pub fn space_id_for(&self, principal: &Principal) -> Result<String> {
        match (principal.local, &principal.space_id) {
            (true, _) => Ok(PRIMARY_SPACE_ID.to_owned()),
            (false, Some(id)) => Ok(id.clone()),
            (false, None) => Err(KbError::Forbidden("你的账号还没有知识库".to_owned())),
        }
    }
}

#[async_trait]
impl SpaceResolver for SpaceRegistry {
    async fn resolve(&self, principal: &Principal) -> Result<ResolvedSpace> {
        let space_id = self.space_id_for(principal)?;
        let runtime = self.runtime_for(principal).await?;
        let audit: Arc<dyn AuditRepo> = runtime.meta.clone();
        Ok(ResolvedSpace {
            space_id,
            audit,
            handle: runtime,
        })
    }

    async fn audit_shared(&self, entry: AuditEntry) {
        let Some(system) = &self.system else {
            if let Err(err) = AuditRepo::record(self.primary.meta.as_ref(), entry).await {
                tracing::warn!(error = %err, "写审计失败");
            }
            return;
        };
        let user_id = entry.actor.starts_with("usr_").then(|| entry.actor.clone());
        let detail = serde_json::json!({
            "actor": entry.actor,
            "ok": entry.ok,
            "error": entry.error,
            "dry_run": entry.dry_run,
            "args": serde_json::from_str::<serde_json::Value>(&entry.args_json)
                .unwrap_or(serde_json::Value::Null),
        });
        if let Err(err) = system
            .record_audit(user_id.as_deref(), &entry.capability, None, &detail, None)
            .await
        {
            tracing::warn!(error = %err, "写系统审计失败");
        }
    }
}

/// 这个知识库还有没有要后台去做的事:排队中 / 运行中的任务,或者没传完的上传。查不出来按「有」算(宁可不关)。
async fn has_work(runtime: &Embedded) -> bool {
    match runtime.queue().has_pending().await {
        Ok(false) => {}
        Ok(true) | Err(_) => return true,
    }
    UploadRepo::list_pending(runtime.meta.as_ref())
        .await
        .map_or(true, |uploads| !uploads.is_empty())
}

/// 在某个知识库的路由里执行一段异步代码。
///
/// 不经过 `Invoker` 的入口(上传、事件)和每个知识库自己的后台任务用它:里面发出的推送事件会带上知识库标签,
/// `ServiceBackend::rt` 也会取到这个知识库。路由是任务局部变量,不会跟着 `tokio::spawn` 走,
/// 派生出去的任务要自己再包一层。
pub async fn within_space<T>(
    space_id: String,
    runtime: Arc<Embedded>,
    future: impl std::future::Future<Output = T>,
) -> T {
    kb_capability::CALL_SCOPE
        .scope(
            kb_capability::CallScope::Space {
                space_id,
                handle: runtime,
                via_link: false,
            },
            future,
        )
        .await
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserStatus};
    use kb_core::config::Config;
    use kb_core::model::{Upload, UploadState};
    use kb_service::jobs::NewJob;
    use tokio::sync::watch;

    use super::*;

    fn new_user(name: &str, role: &str) -> NewUser {
        NewUser {
            username: name.to_owned(),
            email: Some(format!("{name}@example.com")),
            display_name: None,
            password_hash: "x".to_owned(),
            role_id: role.to_owned(),
            status: UserStatus::Active,
            registered_via: "test".to_owned(),
            must_change_password: false,
            email_verified: true,
        }
    }

    fn noop_job() -> NewJob {
        NewJob {
            kind: "noop".to_owned(),
            collection: None,
            priority: 50,
            payload: serde_json::json!({}),
        }
    }

    fn pending_upload() -> Upload {
        let now = crate::daemon::now_millis();
        Upload {
            id: "up_test".to_owned(),
            name: "a.txt".to_owned(),
            rel_path: "a.txt".to_owned(),
            collection: kb_core::ids::GLOBAL_COLLECTION.to_owned(),
            tags: Vec::new(),
            size: 10,
            sha256: None,
            chunk_size: 10,
            parts_total: 1,
            parts_received: 0,
            state: UploadState::Pending,
            source_id: None,
            batch_id: None,
            strategy: None,
            created_at: now,
            updated_at: now,
            completed_at: None,
        }
    }

    struct Rig {
        _home: tempfile::TempDir,
        registry: Arc<SpaceRegistry>,
        space: String,
        /// 后台任务被起过几次。
        opened: Arc<AtomicUsize>,
        /// 后台任务被停过几次。
        stopped: Arc<AtomicUsize>,
        /// 假装调度器正在执行一拍。
        busy: Arc<AtomicBool>,
        /// 收到叫停时先往队列里投一个任务再退出(模拟停的这一会儿里有人投了任务)。
        enqueue_on_stop: Arc<AtomicBool>,
    }

    /// 一个普通用户的知识库,加一组假的后台任务:和真的一样拿着运行时,收到叫停就退出,并计数。
    async fn rig() -> Rig {
        let home = tempfile::tempdir().expect("临时目录");
        let paths = KbPaths::from_home(home.path());
        paths.ensure_dirs().expect("建目录");
        let mut config = Config::default();
        // 不加载嵌入模型
        config.embed.backend = "http".to_owned();
        let primary = Arc::new(
            Embedded::open(&paths, &config, false)
                .await
                .expect("主知识库"),
        );
        let system = Arc::new(SystemStore::open(paths.system_db()).expect("账号库"));
        system
            .create_user(new_user("first_admin", ROLE_ADMIN))
            .await
            .expect("管理员");
        let (_, space) = system
            .create_user(new_user("alice", ROLE_USER))
            .await
            .expect("普通用户");
        let registry = SpaceRegistry::new(primary, system, paths);
        let opened = Arc::new(AtomicUsize::new(0));
        let stopped = Arc::new(AtomicUsize::new(0));
        let busy = Arc::new(AtomicBool::new(false));
        let enqueue_on_stop = Arc::new(AtomicBool::new(false));
        {
            let (opened, stopped, busy, enqueue_on_stop) = (
                opened.clone(),
                stopped.clone(),
                busy.clone(),
                enqueue_on_stop.clone(),
            );
            registry.set_on_open(Arc::new(move |_space, runtime| {
                opened.fetch_add(1, Ordering::SeqCst);
                let (stop, mut stop_rx) = watch::channel(false);
                let stopped = stopped.clone();
                let enqueue = enqueue_on_stop.clone();
                let join = tokio::spawn(async move {
                    let _ = stop_rx.wait_for(|stop| *stop).await;
                    if enqueue.swap(false, Ordering::SeqCst) {
                        runtime.queue().enqueue(noop_job()).await.expect("入队");
                    }
                    stopped.fetch_add(1, Ordering::SeqCst);
                    drop(runtime);
                });
                SpaceTasks::new(stop, join, busy.clone())
            }));
        }
        Rig {
            _home: home,
            registry,
            space: space.id,
            opened,
            stopped,
            busy,
            enqueue_on_stop,
        }
    }

    fn later(minutes: u64) -> Instant {
        Instant::now() + Duration::from_secs(minutes * 60)
    }

    /// 空闲超过时限就关:后台任务停了,运行时(SQLite 连接、向量库句柄)放掉了;
    /// 下次访问重新打开、重新起后台任务。
    #[tokio::test]
    async fn an_idle_space_is_closed_and_reopened_on_next_use() {
        let rig = rig().await;
        let runtime = rig.registry.get(&rig.space).await.expect("打开");
        let weak = Arc::downgrade(&runtime);
        drop(runtime);
        assert_eq!(rig.opened.load(Ordering::SeqCst), 1);

        assert!(
            rig.registry
                .close_idle(later(10), IDLE_CLOSE_AFTER)
                .await
                .is_empty(),
            "10 分钟前刚用过,不关"
        );
        assert_eq!(rig.stopped.load(Ordering::SeqCst), 0);

        assert_eq!(
            rig.registry.close_idle(later(31), IDLE_CLOSE_AFTER).await,
            vec![rig.space.clone()]
        );
        assert_eq!(rig.stopped.load(Ordering::SeqCst), 1, "后台任务停了");
        assert!(
            weak.upgrade().is_none(),
            "没人再拿着运行时:数据库连接和文件句柄都放掉了"
        );

        let reopened = rig.registry.get(&rig.space).await.expect("重新打开");
        assert_eq!(rig.opened.load(Ordering::SeqCst), 2, "重新起了后台任务");
        reopened.collections().list().await.expect("重新打开的能用");
    }

    /// 重启后没人访问的知识库也要主动看一遍:有排队任务的留下来接着跑(恢复中断的任务
    /// 就在打开这一步做),没活儿的打开确认后立刻放掉,不白占连接。
    #[tokio::test]
    async fn resume_unfinished_opens_only_spaces_with_work() {
        let rig = rig().await;
        // 没活儿:打开看了一眼就放掉,后台任务起过又停了
        assert!(rig.registry.resume_unfinished().await.is_empty());
        assert_eq!(rig.opened.load(Ordering::SeqCst), 1, "主动打开看过一眼");
        assert_eq!(rig.stopped.load(Ordering::SeqCst), 1, "没活儿:马上放掉");

        // 有排队任务:留在打开状态,后台任务不歇(不关就不会等到下次访问才跑)
        let runtime = rig.registry.get(&rig.space).await.expect("打开");
        runtime.queue().enqueue(noop_job()).await.expect("入队");
        drop(runtime);
        assert_eq!(
            rig.registry.resume_unfinished().await,
            vec![rig.space.clone()]
        );
        assert_eq!(rig.stopped.load(Ordering::SeqCst), 1, "有活儿:后台任务留着");
    }

    /// 队列里还有排队中的任务就不关:关了这些任务要等到下次有人访问才会执行。
    #[tokio::test]
    async fn a_space_with_queued_jobs_is_not_closed() {
        let rig = rig().await;
        let runtime = rig.registry.get(&rig.space).await.expect("打开");
        runtime.queue().enqueue(noop_job()).await.expect("入队");
        drop(runtime);
        assert!(
            rig.registry
                .close_idle(later(31), IDLE_CLOSE_AFTER)
                .await
                .is_empty()
        );
        assert_eq!(rig.stopped.load(Ordering::SeqCst), 0);
    }

    /// 还有没传完的上传就不关:超时清理在调度器里,关了就没人清了。
    #[tokio::test]
    async fn a_space_with_an_unfinished_upload_is_not_closed() {
        let rig = rig().await;
        let runtime = rig.registry.get(&rig.space).await.expect("打开");
        UploadRepo::create(runtime.meta.as_ref(), pending_upload())
            .await
            .expect("建上传");
        drop(runtime);
        assert!(
            rig.registry
                .close_idle(later(31), IDLE_CLOSE_AFTER)
                .await
                .is_empty()
        );
        assert_eq!(rig.stopped.load(Ordering::SeqCst), 0);
    }

    /// 调度器正在执行一拍(可能是几十秒的 optimize)时不关,等它做完的下一轮再关。
    #[tokio::test]
    async fn a_space_whose_scheduler_is_mid_tick_is_not_closed() {
        let rig = rig().await;
        drop(rig.registry.get(&rig.space).await.expect("打开"));
        rig.busy.store(true, Ordering::SeqCst);
        assert!(
            rig.registry
                .close_idle(later(31), IDLE_CLOSE_AFTER)
                .await
                .is_empty()
        );
        rig.busy.store(false, Ordering::SeqCst);
        assert_eq!(
            rig.registry
                .close_idle(later(31), IDLE_CLOSE_AFTER)
                .await
                .len(),
            1
        );
    }

    /// 停后台的那一会儿里有人投了任务:把后台重新起来,这次不关。
    #[tokio::test]
    async fn work_queued_while_stopping_keeps_the_space_open() {
        let rig = rig().await;
        drop(rig.registry.get(&rig.space).await.expect("打开"));
        rig.enqueue_on_stop.store(true, Ordering::SeqCst);
        assert!(
            rig.registry
                .close_idle(later(31), IDLE_CLOSE_AFTER)
                .await
                .is_empty(),
            "停的时候进了新任务,不关"
        );
        assert_eq!(rig.stopped.load(Ordering::SeqCst), 1);
        assert_eq!(
            rig.opened.load(Ordering::SeqCst),
            2,
            "后台任务重新起来了,新任务有人执行"
        );
    }

    /// 关掉时还有人拿着运行时(比如一次很长的导出):下次访问接着用同一份,不开第二份。
    #[tokio::test]
    async fn a_runtime_still_held_is_reused_instead_of_opened_twice() {
        let rig = rig().await;
        let held = rig.registry.get(&rig.space).await.expect("打开");
        assert_eq!(
            rig.registry
                .close_idle(later(31), IDLE_CLOSE_AFTER)
                .await
                .len(),
            1
        );
        let again = rig.registry.get(&rig.space).await.expect("再取");
        assert!(Arc::ptr_eq(&held, &again), "同一份运行时");
        assert_eq!(rig.opened.load(Ordering::SeqCst), 2, "后台任务重新起了");
    }

    /// 关掉以后,还拿着运行时的人又投了任务:下一轮把后台重新起来,不让任务一直等到有人访问。
    #[tokio::test]
    async fn work_queued_through_a_held_runtime_restarts_the_tasks() {
        let rig = rig().await;
        let held = rig.registry.get(&rig.space).await.expect("打开");
        assert_eq!(
            rig.registry
                .close_idle(later(31), IDLE_CLOSE_AFTER)
                .await
                .len(),
            1
        );
        held.queue().enqueue(noop_job()).await.expect("入队");
        assert!(
            rig.registry
                .close_idle(later(32), IDLE_CLOSE_AFTER)
                .await
                .is_empty()
        );
        assert_eq!(rig.opened.load(Ordering::SeqCst), 2, "后台任务重新起来了");
    }

    /// 判断「空闲」之后、拿到这个知识库的锁之前,刚好有请求来过(它也在等这把锁):不关,免得刚用完就关。
    #[tokio::test]
    async fn a_space_used_while_close_idle_waits_for_its_lock_is_not_closed() {
        let rig = rig().await;
        drop(rig.registry.get(&rig.space).await.expect("打开"));
        let slot = rig
            .registry
            .open
            .lock()
            .await
            .get(&rig.space)
            .cloned()
            .expect("槽位");
        // 先占住这个知识库的锁,让 close_idle 通过第一次空闲判断后卡在拿锁上
        let guard = slot.state.lock().await;
        let registry = rig.registry.clone();
        let closing =
            tokio::spawn(async move { registry.close_idle(later(31), IDLE_CLOSE_AFTER).await });
        tokio::time::sleep(Duration::from_millis(100)).await;
        // 这时来了一个请求(时间戳比 close_idle 看的「现在」还晚)
        *slot.last_used.lock().expect("锁") = later(40);
        drop(guard);
        assert!(
            closing.await.expect("任务").is_empty(),
            "拿到锁以后要重新判断空闲"
        );
        assert_eq!(rig.stopped.load(Ordering::SeqCst), 0, "后台任务没停");
    }

    /// 删账号前摘掉知识库:后台任务先停(调用方接着要删它的目录)。
    #[tokio::test]
    async fn evict_stops_the_tasks_first() {
        let rig = rig().await;
        drop(rig.registry.get(&rig.space).await.expect("打开"));
        rig.registry.evict(&rig.space).await.expect("摘掉");
        assert_eq!(rig.stopped.load(Ordering::SeqCst), 1);
    }

    /// 守护进程退出时取走所有后台任务,由它等收尾。
    #[tokio::test]
    async fn take_tasks_hands_over_every_open_space() {
        let rig = rig().await;
        drop(rig.registry.get(&rig.space).await.expect("打开"));
        let tasks = rig.registry.take_tasks().await;
        assert_eq!(tasks.len(), 1);
        for task in tasks {
            task.stop().await;
        }
        assert_eq!(rig.stopped.load(Ordering::SeqCst), 1);
    }
}
