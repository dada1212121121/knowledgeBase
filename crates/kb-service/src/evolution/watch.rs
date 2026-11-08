//! 文件监听。
//!
//! 只监听已注册项目里**会被索引**的目录;`.git/` 下的变化不处理(交给 hook)。
//! 同一路径在 `debounce_ms` 内的多次写入合并成一次,批量投递一个增量任务。
//!
//! 监听范围与扫描同一套规则(隐藏目录、`.gitignore`、`index.exclude`):被排除的目录
//! (`node_modules`、`target` 这类动辄几万个子目录)一个监听项都不占。以前对项目根目录递归监听,
//! 排除规则要等事件到了才过滤,生产上 9 万多个监听项里只有约 1.3 万个有用,
//! 编译一次还会让监听线程被事件淹没。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use ignore::WalkBuilder;
use kb_core::Result;
use kb_core::config::ConfigStore;
use notify::{RecursiveMode, Watcher};
use tokio::sync::mpsc;

use kb_index::filter::FileFilter;

/// 一次去抖后的批次。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WatchBatch {
    /// 项目根目录。
    pub project_root: PathBuf,
    /// 变化的文件(项目内相对路径)。
    pub paths: Vec<String>,
}

/// 排除规则的来源。
///
/// `Fixed`:一次性清单(测试、单次调用)。
/// `Hot`:守护进程用 —— 全局 `index.exclude` 是热更新项,监听器必须按**当前**配置过滤,
/// 否则热改之后监听器还按启动时的旧规则放行。
enum Excludes {
    /// 固定清单。
    Fixed(Vec<String>),
    /// 全局部分跟着 `ConfigStore` 走,项目部分固定。
    Hot {
        /// 配置存储(热重载改的就是它)。
        store: Arc<ConfigStore>,
        /// 项目自己的排除规则。
        project: Vec<String>,
    },
}

impl Excludes {
    /// 当前该用的完整排除清单(全局 + 项目)。
    fn current(&self) -> Vec<String> {
        match self {
            Self::Fixed(list) => list.clone(),
            Self::Hot { store, project } => {
                let mut list = store.get().index.exclude.clone();
                list.extend(project.clone());
                list
            }
        }
    }

    /// 配置代际号(固定清单恒为 0,不需要重建过滤规则)。
    fn generation(&self) -> u64 {
        match self {
            Self::Fixed(_) => 0,
            Self::Hot { store, .. } => store.generation(),
        }
    }
}

/// 一个项目的监听器:持有底层的 notify 监听器和「已经挂上监听的目录」集合。
///
/// 丢掉它就停止监听(后台的去抖任务只拿弱引用,不会把它留住)。
pub struct ProjectWatcher {
    inner: Arc<WatcherInner>,
}

/// 底层监听器与已监听目录集合,后台任务和注册函数共用。
struct WatcherInner {
    watcher: Mutex<notify::RecommendedWatcher>,
    watched: Mutex<BTreeSet<PathBuf>>,
}

impl ProjectWatcher {
    /// 现在挂着监听的目录个数。
    pub fn watched_dirs(&self) -> usize {
        lock(&self.inner.watched).len()
    }
}

/// 一次文件系统事件对「监听范围」的含义。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Change {
    /// 路径出现了(新建、改名后的新名字):要是目录,得补挂监听并列一遍里面已有的文件。
    Structural,
    /// 路径没了:它和它的子目录要从已监听集合里清掉。
    Removed,
    /// 内容或属性变了:不影响监听范围。
    Content,
}

/// 一条原始事件:路径加上它的含义。
struct RawChange {
    path: PathBuf,
    change: Change,
}

/// 加锁;锁中毒了也继续用里面的数据(这里只存集合和句柄,没有需要回滚的半截状态)。
fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

/// 按事件类型判断它对监听范围的含义;不关心的事件返回 `None`。
fn classify(kind: &notify::EventKind) -> Option<Change> {
    use notify::EventKind;
    use notify::event::ModifyKind;
    match kind {
        EventKind::Create(_) | EventKind::Modify(ModifyKind::Name(_)) => Some(Change::Structural),
        EventKind::Remove(_) => Some(Change::Removed),
        EventKind::Modify(_) => Some(Change::Content),
        _ => None,
    }
}

/// 监听一个项目目录;返回的接收端每次收到一批变化。
///
/// 去抖规则:同一路径在 `debounce_ms` 内只记一次;批次在“最后一次变化后 `debounce_ms`”发出。
/// 启动时要遍历一遍目录树挂监听,是阻塞操作:在异步运行时里调用请包进 `spawn_blocking`。
pub fn watch_project(
    project_root: &Path,
    debounce_ms: u64,
    exclude: Vec<String>,
) -> Result<(mpsc::Receiver<WatchBatch>, ProjectWatcher)> {
    watch_project_inner(project_root, debounce_ms, Excludes::Fixed(exclude))
}

/// 监听一个项目目录,全局排除规则跟着 `ConfigStore` 热更新。
pub fn watch_project_hot(
    project_root: &Path,
    debounce_ms: u64,
    project_exclude: Vec<String>,
    store: Arc<ConfigStore>,
) -> Result<(mpsc::Receiver<WatchBatch>, ProjectWatcher)> {
    watch_project_inner(
        project_root,
        debounce_ms,
        Excludes::Hot {
            store,
            project: project_exclude,
        },
    )
}

/// 在 `root` 下按扫描同一套规则遍历,收集 `scope` 里(含自身)该监听的目录,
/// `with_files` 时再收集里面的文件。
///
/// 隐藏目录、`.gitignore` 命中的目录、`filter` 排除的目录都不进入(整棵剪掉)。
/// 从 `root` 起走而不是从 `scope` 起走,是为了让沿途各级 `.gitignore` 照常生效;
/// 不在 `scope` 这条线上的兄弟目录只列一层就被剪掉,代价很小。
fn walk_scope(
    root: &Path,
    scope: &Path,
    filter: &Arc<FileFilter>,
    with_files: bool,
) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let keep_filter = Arc::clone(filter);
    let scope_owned = scope.to_path_buf();
    let walker = WalkBuilder::new(root)
        // 项目目录不一定在 git 仓库里,但 .gitignore 仍然要生效(与扫描一致)
        .require_git(false)
        .filter_entry(move |entry| {
            if !entry.file_type().is_some_and(|kind| kind.is_dir()) {
                return true;
            }
            let path = entry.path();
            // 只往 scope 这条线上走:要么是它的祖先,要么在它里面
            if !(path.starts_with(&scope_owned) || scope_owned.starts_with(path)) {
                return false;
            }
            !keep_filter.is_excluded(path, true)
        })
        .build();
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in walker.flatten() {
        let path = entry.path();
        if !path.starts_with(scope) {
            continue;
        }
        match entry.file_type() {
            Some(kind) if kind.is_dir() => dirs.push(path.to_path_buf()),
            Some(kind) if kind.is_file() && with_files => files.push(path.to_path_buf()),
            _ => {}
        }
    }
    (dirs, files)
}

/// 给 `scope` 里还没监听的目录补挂监听(逐个目录、非递归);返回这次新挂上的目录。
///
/// 循环到再没有新目录为止:挂监听的间隙里又建出来的子目录,下一轮会发现并补上。
/// 根目录挂不上是硬错误;其它目录挂不上(权限、内核监听项用光)只记警告,不影响别的目录。
fn register_scope(
    inner: &WatcherInner,
    root: &Path,
    scope: &Path,
    filter: &Arc<FileFilter>,
) -> Result<Vec<PathBuf>> {
    let mut added = Vec::new();
    let mut tried: BTreeSet<PathBuf> = BTreeSet::new();
    let mut failed = 0usize;
    loop {
        let (dirs, _) = walk_scope(root, scope, filter, false);
        let fresh: Vec<PathBuf> = {
            let watched = lock(&inner.watched);
            dirs.into_iter()
                .filter(|dir| !watched.contains(dir) && !tried.contains(dir))
                .collect()
        };
        if fresh.is_empty() {
            break;
        }
        for dir in fresh {
            tried.insert(dir.clone());
            let outcome = lock(&inner.watcher).watch(&dir, RecursiveMode::NonRecursive);
            match outcome {
                Ok(()) => {
                    lock(&inner.watched).insert(dir.clone());
                    added.push(dir);
                }
                Err(err) if dir == root => {
                    return Err(kb_core::KbError::Internal(format!(
                        "监听 {} 失败: {err}",
                        dir.display()
                    )));
                }
                Err(err) => {
                    failed += 1;
                    tracing::debug!(dir = %dir.display(), error = %err, "目录挂监听失败");
                }
            }
        }
    }
    if failed > 0 {
        tracing::warn!(failed, root = %root.display(), "部分目录没能挂上监听(权限不足或内核监听项用光)");
    }
    Ok(added)
}

/// 补挂 `scope` 的监听,并返回新挂上的目录里**已经存在**的文件。
///
/// 目录刚建出来时里面的文件可能已经写好了,inotify 来不及给新目录挂监听,这些文件的事件永远收不到;
/// 只能在挂上监听之后列一遍目录补报(重复报告无妨:索引按内容哈希增量,没变的会跳过)。
fn discover(
    inner: &WatcherInner,
    root: &Path,
    scope: &Path,
    filter: &Arc<FileFilter>,
) -> Result<Vec<PathBuf>> {
    let added = register_scope(inner, root, scope, filter)?;
    if added.is_empty() {
        return Ok(Vec::new());
    }
    let added: BTreeSet<PathBuf> = added.into_iter().collect();
    let (_, files) = walk_scope(root, scope, filter, true);
    Ok(files
        .into_iter()
        .filter(|file| file.parent().is_some_and(|parent| added.contains(parent)))
        .collect())
}

/// 把 `path` 和它的子目录从已监听集合里清掉(目录被删了,内核已经自动撤掉了对应的监听)。
fn prune_removed(watched: &Mutex<BTreeSet<PathBuf>>, path: &Path) {
    let mut set = lock(watched);
    // 路径按组件排序,一个目录的所有子孙紧跟在它后面,是连续的一段
    let doomed: Vec<PathBuf> = set
        .range(path.to_path_buf()..)
        .take_while(|candidate| candidate.starts_with(path))
        .cloned()
        .collect();
    for dir in doomed {
        set.remove(&dir);
    }
}

fn watch_project_inner(
    project_root: &Path,
    debounce_ms: u64,
    excludes: Excludes,
) -> Result<(mpsc::Receiver<WatchBatch>, ProjectWatcher)> {
    let root = project_root.to_path_buf();
    // 与扫描用同一套过滤规则(gitignore 语义的 glob),避免“监听放进来、扫描又跳过”
    let mut filter = std::sync::Arc::new(FileFilter::new(&root, u64::MAX, &excludes.current())?);
    let mut filter_generation = excludes.generation();
    let initial_filter = Arc::clone(&filter);
    let (raw_tx, mut raw_rx) = mpsc::channel::<RawChange>(1024);
    let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        let Some(change) = classify(&event.kind) else {
            return;
        };
        for path in event.paths {
            let _ = raw_tx.blocking_send(RawChange { path, change });
        }
    })
    .map_err(|err| kb_core::KbError::Internal(format!("创建监听器失败: {err}")))?;
    let inner = Arc::new(WatcherInner {
        watcher: Mutex::new(watcher),
        watched: Mutex::new(BTreeSet::new()),
    });
    // 后台任务只拿弱引用:调用方丢掉 ProjectWatcher 后监听器随之释放,通道关闭,任务自然退出
    let weak: Weak<WatcherInner> = Arc::downgrade(&inner);

    let (batch_tx, batch_rx) = mpsc::channel::<WatchBatch>(32);
    let debounce = Duration::from_millis(debounce_ms.max(1));
    // 先起后台任务再挂监听:挂监听期间内核事件已经可能进来,没人取走会把有界通道堵满
    tokio::spawn(async move {
        let mut pending: BTreeSet<String> = BTreeSet::new();
        loop {
            let Some(first) = raw_rx.recv().await else {
                break;
            };
            let mut collected = vec![first];
            // 在去抖窗口内继续收集
            let deadline = tokio::time::Instant::now() + debounce;
            loop {
                match tokio::time::timeout_at(deadline, raw_rx.recv()).await {
                    Ok(Some(change)) => collected.push(change),
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            // 配置热更新后(index.exclude 变了)按新规则重建过滤:代际号变化才重建,平时零开销
            let mut rewalk_root = false;
            let generation = excludes.generation();
            if generation != filter_generation {
                match FileFilter::new(&root, u64::MAX, &excludes.current()) {
                    Ok(next) => {
                        filter = std::sync::Arc::new(next);
                        filter_generation = generation;
                        // 规则放宽后,原先被排除的目录要补挂监听、里面已有的文件要补报
                        rewalk_root = true;
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "index.exclude 更新后重建过滤规则失败")
                    }
                }
            }
            let Some(strong) = weak.upgrade() else {
                break;
            };
            let discovered = sync_watches(&strong, &root, &filter, &collected, rewalk_root).await;
            drop(strong);
            let paths = collected
                .into_iter()
                .map(|change| change.path)
                .chain(discovered);
            for path in paths {
                // 目录本身的变化不算文件变化(建目录时会先来一条)
                if path.is_dir() {
                    continue;
                }
                if let Some(relative) = relative_path(&root, &path)
                    && !filter.is_excluded(&path, false)
                {
                    pending.insert(relative);
                }
            }
            if pending.is_empty() {
                continue;
            }
            let batch = WatchBatch {
                project_root: root.clone(),
                paths: pending.iter().cloned().collect(),
            };
            pending.clear();
            if batch_tx.send(batch).await.is_err() {
                break;
            }
        }
    });

    // 只给会被索引的目录逐个挂监听;根目录挂不上直接报错(此时 inner 随函数返回被丢掉,任务随之退出)
    register_scope(&inner, project_root, project_root, &initial_filter)?;
    Ok((batch_rx, ProjectWatcher { inner }))
}

/// 按这一批事件调整监听范围,返回因此新发现的、已经存在的文件。
///
/// - 路径没了:它和子目录从已监听集合里清掉(同名目录重建后才会被重新挂上);
/// - 路径新出现且是目录:补挂监听,并列一遍里面已有的文件;
/// - `rewalk_root`(排除规则放宽了):从项目根重新走一遍,补挂原先被排除的目录。
///
/// 挂监听要遍历目录树,是阻塞操作,放进 `spawn_blocking`,不占异步工作线程。
async fn sync_watches(
    inner: &Arc<WatcherInner>,
    root: &Path,
    filter: &Arc<FileFilter>,
    changes: &[RawChange],
    rewalk_root: bool,
) -> Vec<PathBuf> {
    let mut scopes: Vec<PathBuf> = Vec::new();
    for item in changes {
        match item.change {
            Change::Removed => prune_removed(&inner.watched, &item.path),
            Change::Structural => {
                // 改名走掉的旧名字在这里表现为「路径不存在」:同样要清掉
                if !item.path.exists() {
                    prune_removed(&inner.watched, &item.path);
                } else if item.path.is_dir() && item.path.starts_with(root) {
                    // 同名目录先被删再建的情况:旧条目对应的监听已被内核撤销,先清掉再重挂
                    if !lock(&inner.watched).contains(&item.path)
                        || changes
                            .iter()
                            .any(|other| other.change == Change::Removed && other.path == item.path)
                    {
                        scopes.push(item.path.clone());
                    }
                }
            }
            Change::Content => {}
        }
    }
    if rewalk_root {
        scopes.push(root.to_path_buf());
    }
    if scopes.is_empty() {
        return Vec::new();
    }
    // 去重:排序后,被前面某个范围包含的子范围不用再走一遍
    scopes.sort();
    scopes.dedup();
    let mut kept: Vec<PathBuf> = Vec::new();
    for scope in scopes {
        if !kept.iter().any(|parent| scope.starts_with(parent)) {
            kept.push(scope);
        }
    }

    let inner = Arc::clone(inner);
    let root = root.to_path_buf();
    let filter = Arc::clone(filter);
    let outcome = tokio::task::spawn_blocking(move || {
        let mut found = Vec::new();
        for scope in kept {
            match discover(&inner, &root, &scope, &filter) {
                Ok(files) => found.extend(files),
                Err(err) => {
                    tracing::warn!(scope = %scope.display(), error = %err, "补挂目录监听失败")
                }
            }
        }
        found
    })
    .await;
    outcome.unwrap_or_default()
}

/// 项目内相对路径;`.git/` 下的返回 `None`。
fn relative_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let text = relative.to_string_lossy().replace('\\', "/");
    if text.is_empty() || text.split('/').any(|part| part == ".git") {
        return None;
    }
    Some(text)
}

/// 把批次转成投递用的事件请求。
pub fn batch_to_request(batch: &WatchBatch) -> crate::evolution::events::EventRequest {
    crate::evolution::events::EventRequest {
        kind: "file_change".to_owned(),
        project_root: batch.project_root.to_string_lossy().into_owned(),
        head: None,
        payload: Some(serde_json::json!({ "paths": batch.paths })),
    }
}

/// 便捷封装:监听 + 投递。
pub struct WatcherHandle {
    watcher: ProjectWatcher,
    pub root: PathBuf,
}

impl WatcherHandle {
    /// 现在挂着监听的目录个数。
    pub fn watched_dirs(&self) -> usize {
        self.watcher.watched_dirs()
    }
}

/// 启动监听(供守护进程用)。
pub fn spawn(
    project_root: &Path,
    debounce_ms: u64,
    exclude: Vec<String>,
    service: Arc<crate::evolution::events::EventService>,
) -> Result<WatcherHandle> {
    spawn_inner(
        watch_project(project_root, debounce_ms, exclude)?,
        project_root,
        service,
    )
}

/// 启动监听,全局排除规则跟着 `ConfigStore` 热更新(守护进程用)。
pub fn spawn_hot(
    project_root: &Path,
    debounce_ms: u64,
    project_exclude: Vec<String>,
    store: Arc<ConfigStore>,
    service: Arc<crate::evolution::events::EventService>,
) -> Result<WatcherHandle> {
    spawn_inner(
        watch_project_hot(project_root, debounce_ms, project_exclude, store)?,
        project_root,
        service,
    )
}

fn spawn_inner(
    (mut rx, watcher): (mpsc::Receiver<WatchBatch>, ProjectWatcher),
    project_root: &Path,
    service: Arc<crate::evolution::events::EventService>,
) -> Result<WatcherHandle> {
    let root = project_root.to_path_buf();
    tokio::spawn(async move {
        while let Some(batch) = rx.recv().await {
            let request = batch_to_request(&batch);
            if let Err(err) = service.handle(request).await {
                tracing::warn!(error = %err, "文件变化投递失败");
            }
        }
    });
    Ok(WatcherHandle { watcher, root })
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::config::Config;

    #[test]
    fn git_paths_are_filtered() {
        assert!(relative_path(Path::new("/p"), Path::new("/p/.git/index")).is_none());
        assert_eq!(
            relative_path(Path::new("/p"), Path::new("/p/src/main.rs")).as_deref(),
            Some("src/main.rs")
        );
    }

    /// 质量检查:`index.exclude` 热更新后,监听器要按新规则过滤,不能继续用启动时的快照。
    #[tokio::test]
    async fn hot_excludes_apply_to_the_next_batch() {
        let dir = tempfile::tempdir().expect("临时目录");
        let store = Arc::new(ConfigStore::new(Config::default()));
        let (mut rx, _watcher) =
            watch_project_hot(dir.path(), 60, Vec::new(), store.clone()).expect("起监听");

        // 先写一个不被排除的文件:应该收到
        std::fs::write(dir.path().join("a.rs"), "fn a() {}").expect("写 a.rs");
        let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("5 秒内应收到批次")
            .expect("通道没关");
        assert!(batch.paths.iter().any(|path| path == "a.rs"), "{batch:?}");

        // 热更新:把 *.rs 排除掉
        let mut next = (*store.get()).clone();
        next.index.exclude = vec!["*.rs".to_owned()];
        store.replace(next);

        std::fs::write(dir.path().join("b.rs"), "fn b() {}").expect("写 b.rs");
        let quiet = tokio::time::timeout(Duration::from_millis(600), rx.recv()).await;
        assert!(quiet.is_err(), "热更新后 b.rs 不应再被投递:{quiet:?}");

        // 未被排除的扩展名仍然照常投递(证明监听器没被关掉)
        std::fs::write(dir.path().join("c.md"), "# c").expect("写 c.md");
        let batch = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("5 秒内应收到批次")
            .expect("通道没关");
        assert!(batch.paths.iter().any(|path| path == "c.md"), "{batch:?}");
    }
}
