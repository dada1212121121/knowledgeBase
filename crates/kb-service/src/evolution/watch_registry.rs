//! 文件监听注册表:让监听器随项目的增、删、改自动对账。
//!
//! 以前守护进程只在启动时对当时的项目列表挂一次监听(`watch::spawn_hot`),之后:
//! 新增的项目没有实时监听(要等重启或夜间校验),移除的项目监听器一直留到重启,
//! 项目的根目录或排除规则被改后监听器还按旧的来。
//!
//! 注册表按项目 id 记住每个项目挂着的监听器(以及挂它时用的根目录和排除规则),
//! 调用方周期性地把「现在的项目列表」交给 [`WatchRegistry::sync`],注册表自己算出差异:
//!
//! - 新项目:起监听;
//! - 已经不在列表里:撤掉(丢掉句柄,监听随之停止);
//! - 根目录或项目排除规则变了:先撤再起;
//! - 根目录不存在:跳过,目录出现后下一轮自动开始;
//! - 某个项目起不来:只记警告,别的项目照常。
//!
//! 全局 `index.exclude` 不在比较范围内:它是热更新项,监听器本来就按 `ConfigStore` 的当前值过滤
//! (见 `watch.rs` 的 `Excludes::Hot`),不需要重起。
//!
//! 同一份状态不同时被两次 `sync` 修改:`sync` 内部串行。

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use kb_core::config::ConfigStore;
use kb_core::model::Project;

use crate::evolution::events::EventService;
use crate::evolution::watch::{WatcherHandle, spawn_hot};

/// 一次 [`WatchRegistry::sync`] 做了什么。
///
/// 前四项是这一次的**变化量**:对同样的输入连续 `sync` 两次,第二次整份报告都是 0,
/// 这样调用方可以直接用 [`SyncReport::changed`] 判断「要不要打日志」。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// 新起了监听的项目数。
    pub started: usize,
    /// 撤掉了监听的项目数(项目被移除,或根目录不见了)。
    pub stopped: usize,
    /// 因根目录或排除规则变化而重起了监听的项目数。
    pub restarted: usize,
    /// 这一次尝试起监听但失败的项目数。失败的项目下一轮会再试,所以持续失败时每轮都会计一次。
    pub failed: usize,
    /// 这一次新挂上的监听目录总数(本次 `started` 与 `restarted` 的监听器之和)。
    ///
    /// 不是注册表当前的总量:没有变化时为 0。要当前总量用 [`WatchRegistry::watched_dirs`]。
    pub total_dirs: usize,
}

impl SyncReport {
    /// 监听的集合有没有变化(从该版本起、停、重起任一项非 0)。仅有失败不算:失败已经在注册表里记过警告。
    pub fn changed(&self) -> bool {
        self.started + self.stopped + self.restarted > 0
    }
}

/// 一个正在监听的项目。
struct Entry {
    /// 挂监听时的根目录。
    root_path: String,
    /// 挂监听时的项目排除规则。
    exclude: Vec<String>,
    /// 监听句柄:丢掉即停止监听。
    handle: WatcherHandle,
}

/// 项目当前没有监听的原因。
#[derive(Clone, Debug, PartialEq, Eq)]
enum Skipped {
    /// 根目录不存在(或不是目录)。
    MissingRoot,
    /// 拉起监听失败,附错误原文。
    Failed(String),
}

/// 一次「没监听」的记录,用来让同一条日志只在状态变化时打一次。
#[derive(Clone, Debug, PartialEq, Eq)]
struct Note {
    root_path: String,
    reason: Skipped,
}

/// 注册表内部状态。
#[derive(Default)]
struct State {
    /// 项目 id → 正在监听的项目。
    running: HashMap<String, Entry>,
    /// 项目 id → 上一次没监听的原因。项目起来了或从列表里消失就清掉。
    noted: HashMap<String, Note>,
}

/// 加锁;锁中毒了也继续用里面的数据(这里只存映射和句柄,没有需要回滚的半截状态)。
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// 文件监听注册表。
pub struct WatchRegistry {
    store: Arc<ConfigStore>,
    events: Arc<EventService>,
    debounce_ms: u64,
    state: Mutex<State>,
    /// 串行化 `sync`:起监听要等阻塞任务,期间不能让另一次 `sync` 对同一个项目再起一份。
    /// `state` 只在不跨越 `.await` 的短时间内持有,查询接口不会被长时间的同步挡住。
    gate: tokio::sync::Mutex<()>,
}

impl WatchRegistry {
    /// 构造。`debounce_ms` 是监听去抖窗口(`index.debounce_ms`)。
    pub fn new(store: Arc<ConfigStore>, events: Arc<EventService>, debounce_ms: u64) -> Self {
        Self {
            store,
            events,
            debounce_ms,
            state: Mutex::new(State::default()),
            gate: tokio::sync::Mutex::new(()),
        }
    }

    /// 这个项目现在是否挂着监听。
    pub fn is_watching(&self, project_id: &str) -> bool {
        lock(&self.state).running.contains_key(project_id)
    }

    /// 现在所有监听器挂着的目录总数(实时快照,会随项目里新建目录而变化)。
    pub fn watched_dirs(&self) -> usize {
        lock(&self.state)
            .running
            .values()
            .map(|entry| entry.handle.watched_dirs())
            .sum()
    }

    /// 让监听器与 `projects` 对齐,返回这一次做了什么。
    ///
    /// 拉起监听要遍历项目的目录树,大项目要几十秒,所以逐个项目放进 `spawn_blocking`,
    /// 不占异步工作线程。项目按给定顺序依次处理:一次只遍历一个目录树,
    /// 不让几个大项目同时抢磁盘。单个项目失败只记警告,不影响后面的项目。
    pub async fn sync(&self, projects: Vec<Project>) -> SyncReport {
        let _serial = self.gate.lock().await;
        let mut report = SyncReport::default();

        // 1. 已经不在项目表里的:撤掉监听,并忘掉它的「没监听」记录。
        //    句柄在锁外丢弃,不在持锁时做关闭监听的系统调用。
        let wanted: HashSet<&str> = projects.iter().map(|project| project.id.as_str()).collect();
        let gone: Vec<(String, Entry)> = {
            let mut state = lock(&self.state);
            state.noted.retain(|id, _| wanted.contains(id.as_str()));
            let ids: Vec<String> = state
                .running
                .keys()
                .filter(|id| !wanted.contains(id.as_str()))
                .cloned()
                .collect();
            ids.into_iter()
                .filter_map(|id| state.running.remove(&id).map(|entry| (id, entry)))
                .collect()
        };
        for (id, entry) in gone {
            report.stopped += 1;
            tracing::info!(project_id = %id, root = %entry.root_path, "项目已移除,文件监听已撤掉");
        }

        // 2. 逐个项目对账
        for project in projects {
            let root_exists = Path::new(&project.root_path).is_dir();
            let previous = {
                let mut state = lock(&self.state);
                let unchanged = state.running.get(&project.id).is_some_and(|entry| {
                    entry.root_path == project.root_path && entry.exclude == project.exclude
                });
                if unchanged && root_exists {
                    // 没有任何变化:不动它。也不碰它的记录,保证幂等。
                    continue;
                }
                state.running.remove(&project.id)
            };
            // 先撤旧的再起新的(也让旧监听在新监听遍历目录之前释放内核监听项)
            let was_running = previous.is_some();
            drop(previous);

            if !root_exists {
                // 根目录不见了(或本来就没有):已有的监听随目录失效,撤掉;
                // 同样的原因只记一次警告,目录出现后下一轮自动开始
                if was_running {
                    report.stopped += 1;
                }
                self.note(&project, Skipped::MissingRoot);
                continue;
            }

            match self.start(&project).await {
                Ok(handle) => {
                    let dirs = handle.watched_dirs();
                    report.total_dirs += dirs;
                    {
                        let mut state = lock(&self.state);
                        state.noted.remove(&project.id);
                        state.running.insert(
                            project.id.clone(),
                            Entry {
                                root_path: project.root_path.clone(),
                                exclude: project.exclude.clone(),
                                handle,
                            },
                        );
                    }
                    if was_running {
                        report.restarted += 1;
                        tracing::info!(project = %project.name, dirs, "项目配置变化,文件监听已重起");
                    } else {
                        report.started += 1;
                        tracing::info!(project = %project.name, dirs, "文件监听已启动");
                    }
                }
                Err(message) => {
                    report.failed += 1;
                    self.note(&project, Skipped::Failed(message));
                }
            }
        }
        report
    }

    /// 给一个项目起监听。遍历目录树是阻塞操作,放进 `spawn_blocking`;
    /// 与扫描同一套排除规则:全局 `index.exclude`(跟着 `ConfigStore` 热更新)加项目自己的 `exclude`。
    async fn start(&self, project: &Project) -> Result<WatcherHandle, String> {
        let root = project.root_path.clone();
        let exclude = project.exclude.clone();
        let store = self.store.clone();
        let events = self.events.clone();
        let debounce_ms = self.debounce_ms;
        let outcome = tokio::task::spawn_blocking(move || {
            spawn_hot(Path::new(&root), debounce_ms, exclude, store, events)
        })
        .await;
        match outcome {
            Ok(Ok(handle)) => Ok(handle),
            Ok(Err(err)) => Err(err.to_string()),
            Err(err) => Err(format!("启动监听的任务异常退出: {err}")),
        }
    }

    /// 记下「这个项目现在没监听」及原因;原因和上一次一样就不再打日志。
    ///
    /// 同步是周期性的(守护进程里每 30 秒一次),根目录一直不存在或一直起不来的项目
    /// 如果每轮都打一条警告,日志很快会被同一句话占满。
    fn note(&self, project: &Project, reason: Skipped) {
        let note = Note {
            root_path: project.root_path.clone(),
            reason,
        };
        let mut state = lock(&self.state);
        if state.noted.get(&project.id) == Some(&note) {
            return;
        }
        match &note.reason {
            Skipped::MissingRoot => tracing::warn!(
                project = %project.name,
                root = %project.root_path,
                "项目根目录不存在,暂不监听(目录出现后自动开始)"
            ),
            Skipped::Failed(message) => tracing::warn!(
                project = %project.name,
                root = %project.root_path,
                error = %message,
                "启动文件监听失败(下一轮同步会重试)"
            ),
        }
        state.noted.insert(project.id.clone(), note);
    }
}
