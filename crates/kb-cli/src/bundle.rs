//! 每个知识库自己的后台任务(多用户设计说明)。
//!
//! 主知识库的后台(调度器 + 备份 + 去重 + 文件监听 + 作业 worker)仍在 `daemon.rs` 里;
//! 其余知识库在**第一次被打开**时起一组精简的后台:作业 worker(索引 / 保存经验 / 解析上传 / 迁移)、
//! 每分钟一拍的调度器(optimize)和未完成上传的清理。非管理员没有服务器目录项目,所以没有文件监听、
//! 定时备份、自动提炼——这些仍只属于主知识库。
//!
//! 整组任务包在 [`crate::spaces::within_space`] 里:里面发出的 `job.progress` 等推送事件带着知识库标签,
//! 只会推给这个知识库的主人。
//!
//! 知识库空闲一段时间后,注册表会用 [`SpaceTasks::stop`] 把这组任务停掉、放掉它的数据库连接和文件句柄,
//! 下次有人访问再起一组(后半,见 [`crate::spaces::SpaceRegistry::close_idle`])。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use kb_core::config::{Config, ConfigStore};
use kb_service::insight::InsightJobHandler;
use kb_service::jobs::{IndexJobHandler, JobRouter, Worker};
use tokio::sync::watch;

use crate::daemon::{HubObserver, ingest_limits, now_millis};
use crate::runtime::Embedded;

/// 起后台任务需要的共享部件。
pub struct BundleDeps {
    /// 配置(热重载)。
    pub config_store: Arc<ConfigStore>,
    /// 事件中心。
    pub hub: Arc<kb_web::EventHub>,
    /// 关闭信号。
    pub shutdown: watch::Receiver<bool>,
    /// 全站共享的分片名额:所有知识库的后台 worker 轮流用(含主知识库)。
    pub slots: Arc<kb_service::jobs::slots::SliceGate>,
    /// 每个知识库的调度器进度(上次 optimize / 夜间校验):知识库被关掉再打开时接着用,
    /// 不然每次重新打开都会把它们重跑一遍。
    pub history: std::sync::Mutex<HashMap<String, kb_service::scheduler::ScheduleHistory>>,
    /// 按用户记 AI 用量(网页 AI 规范化记到发起同步的人名下)。
    pub ledger: Option<Arc<dyn kb_core::ports::UserLlmLedger>>,
}

/// 一个非主知识库正在运行的后台任务(作业 worker + 每分钟一拍的调度器)。
///
/// 丢掉它也会叫停(不等退出),免得后台任务没人管、一直跑到进程退出。
pub struct SpaceTasks {
    stop: watch::Sender<bool>,
    join: Option<tokio::task::JoinHandle<()>>,
    busy: Arc<AtomicBool>,
}

impl SpaceTasks {
    /// 由已经起好的任务组装:`stop` 收到 `true` 时任务应退出;`busy` 为真表示正在执行一拍调度。
    pub fn new(
        stop: watch::Sender<bool>,
        join: tokio::task::JoinHandle<()>,
        busy: Arc<AtomicBool>,
    ) -> Self {
        Self {
            stop,
            join: Some(join),
            busy,
        }
    }

    /// 调度器正在执行一拍(optimize 可能要几十秒)。这时不关,免得这期间来访的请求跟着等。
    pub fn busy(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }

    /// 任务已经退出(测试用)。
    #[cfg(test)]
    fn is_finished(&self) -> bool {
        self.join
            .as_ref()
            .is_none_or(tokio::task::JoinHandle::is_finished)
    }

    /// 叫停并等它退出:worker 在两个分片之间停,调度器在两拍之间停。
    pub async fn stop(mut self) {
        let _ = self.stop.send(true);
        if let Some(join) = self.join.take() {
            let _ = join.await;
        }
    }
}

impl Drop for SpaceTasks {
    fn drop(&mut self) {
        let _ = self.stop.send(true);
    }
}

/// 按配置造全站分片名额。`index.parallel_slices = 0` 表示自动:核数的 1/4,最少 1、最多 4。
/// 容量函数每次领名额时现读配置,热更新后不用重启。
pub fn slice_gate(config_store: Arc<ConfigStore>) -> Arc<kb_service::jobs::slots::SliceGate> {
    kb_service::jobs::slots::SliceGate::new(Arc::new(move || {
        let configured = config_store.get().index.parallel_slices as usize;
        if configured > 0 {
            // 与 worker 的循环数对齐(每个知识库开这么多条),再大也只是在名额上排队
            return configured.min(kb_core::config::IndexConfig::MAX_PARALLEL_SLICES as usize);
        }
        let cores = std::thread::available_parallelism().map_or(4, std::num::NonZero::get);
        (cores / 4).clamp(1, 4)
    }))
}

/// 转换临时目录:`<KB_HOME>/run/convert`(每次转换在里面建一个子目录,转完删掉)。
fn convert_work_dir(paths: &kb_core::paths::KbPaths) -> std::path::PathBuf {
    paths.run_dir().join("convert")
}

/// 清掉上次进程被杀时留下的转换临时目录(里面有 LibreOffice 的用户配置,动辄几十 MB)。
/// 只在进程启动后第一次建转换器时调用:这时还没有任何转换在跑。
fn clear_stale_work(work_dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(work_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let _ = if path.is_dir() {
            std::fs::remove_dir_all(&path)
        } else {
            std::fs::remove_file(&path)
        };
    }
}

/// 按配置建旧格式 Office 转换器:没开、或安装目录里没有 `soffice` 就是 `None`
/// (默认安装目录 `<KB_HOME>/bin/libreoffice`)。不带缓存,方便测试。
fn converter_for(
    config: &Config,
    paths: &kb_core::paths::KbPaths,
) -> Option<kb_service::office_convert::Converter> {
    kb_service::office_convert::Converter::from_config(
        &config.convert,
        &paths.bin_dir().join("libreoffice"),
        convert_work_dir(paths),
    )
}

/// 全站共用的一个转换器:同时转换的个数(每个进程峰值约 320 MB 内存)是全站的上限,
/// 不是每个知识库各有一份。`convert.*` 只在启动时读(改了提示重启),所以进程内只建一次。
///
/// 上传入库(`build_job_router`)和项目目录的索引(`Embedded::index_service`)共用它。
/// 不在这里清理上次留下的临时目录:嵌入式 CLI 也会走到这里,而那时守护进程可能正有转换在跑;
/// 清理由守护进程启动时单独调 [`clear_stale_conversions`]。
pub(crate) fn shared_converter(
    config: &Config,
    paths: &kb_core::paths::KbPaths,
) -> Option<kb_service::office_convert::Converter> {
    static CONVERTER: std::sync::OnceLock<Option<kb_service::office_convert::Converter>> =
        std::sync::OnceLock::new();
    CONVERTER
        .get_or_init(|| converter_for(config, paths))
        .clone()
}

/// 守护进程启动时清掉上次被杀留下的转换临时目录(此时还没有任何转换在跑)。
pub(crate) fn clear_stale_conversions(paths: &kb_core::paths::KbPaths) {
    clear_stale_work(&convert_work_dir(paths));
}

/// 组装作业路由。主知识库和其他知识库用同一份,保证行为一致。
pub fn build_job_router(
    runtime: &Arc<Embedded>,
    worker_index: &Arc<kb_service::IndexService>,
    config: &Config,
    hub: &Arc<kb_web::EventHub>,
    ledger: Option<Arc<dyn kb_core::ports::UserLlmLedger>>,
) -> JobRouter {
    let mut router = JobRouter::new();
    router.register(
        "index",
        Arc::new(IndexJobHandler::new(
            worker_index.clone(),
            runtime.meta.clone(),
            50,
        )),
    );
    router.register(
        "save_insight",
        Arc::new(
            InsightJobHandler::new(
                runtime.meta.clone(),
                runtime.store(),
                runtime.embedder.clone(),
            )
            .with_write_gate(runtime.write_gate()),
        ),
    );
    // 换模型迁移:入队执行,进度 / rate / eta 走 `job.progress` 推送
    let migration = Arc::new(
        kb_service::migration::MigrationService::new(
            runtime.meta.clone(),
            runtime.store.clone(),
            runtime.embedder.clone(),
        )
        .with_write_gate(runtime.write_gate()),
    );
    router.register(
        "migrate",
        Arc::new(kb_service::jobs::MigrateJobHandler::new(migration)),
    );
    // 上传解析:queued → extracting → chunking → embedding → done
    let mut ingest = kb_service::IngestJobHandler::new(
        worker_index.clone(),
        runtime.meta.clone(),
        runtime.paths.clone(),
        ingest_limits(&config.upload),
        10,
        runtime.tracker.clone(),
    )
    .with_observer(Arc::new(crate::capability_backend::HubUploadObserver::new(
        hub.clone(),
    )))
    // 一片内并发解析几个文件:每次分片现读,系统参数里改完不用重启
    .with_parallel_files({
        let runtime = runtime.clone();
        Arc::new(move || runtime.config().index.parallel_files as usize)
    });
    // 旧格式 Office(doc / xls …)没有抽取器时,装了 LibreOffice 就为抽取而转换(原件不动);
    // 没开或没装就是 None,行为和以前一样
    if let Some(converter) = shared_converter(config, &runtime.paths) {
        ingest = ingest.with_converter(converter);
    }
    router.register("ingest", Arc::new(ingest));
    // 网页 AI 规范化:逐页调模型,结果 Markdown 再进上面的解析队列
    router.register(
        kb_service::web_extract::JOB_KIND,
        Arc::new(kb_service::web_extract::WebExtractJobHandler::new(
            runtime.meta.clone(),
            runtime.paths.clone(),
            Arc::new(RuntimeWebExtractDeps {
                runtime: runtime.clone(),
                ledger,
            }),
        )),
    );
    router
}

/// 守护进程侧的网页 AI 规范化依赖:配置、闸门、模型、skills 都从运行时现取(热更新)。
struct RuntimeWebExtractDeps {
    runtime: Arc<Embedded>,
    ledger: Option<Arc<dyn kb_core::ports::UserLlmLedger>>,
}

impl kb_service::web_extract::WebExtractDeps for RuntimeWebExtractDeps {
    fn settings(&self) -> kb_core::config::WebExtractConfig {
        self.runtime.config().web_extract.clone()
    }

    fn ai_enabled(&self) -> bool {
        let config = self.runtime.config();
        config.ai.enabled && config.ai.extract
    }

    fn gate(&self, payer: Option<&str>) -> kb_service::llm_gate::LlmGate {
        let gate = kb_service::llm_gate::LlmGate::new(
            self.runtime.meta.clone(),
            crate::capability_backend::gate_config(&self.runtime.config()),
        );
        match (&self.ledger, payer) {
            (Some(ledger), Some(user_id)) => gate.with_user_budget(ledger.clone(), user_id),
            _ => gate,
        }
    }

    fn model(&self) -> kb_core::Result<Option<Arc<dyn kb_core::ports::ChatModel>>> {
        // 没有 key 时不退回 mock:mock 的固定回复会被写成一堆空壳结果进库
        let config = self.runtime.config();
        crate::capability_backend::configured_chat_model(
            &self.runtime.paths,
            &config,
            &config.llm.extract_model,
        )
    }

    fn prompt_override(&self) -> Option<String> {
        self.runtime
            .skills()
            .prompt(kb_service::skills::PromptStage::WebExtract)
            .map(str::to_owned)
    }
}

/// 给一个非主知识库起后台任务。知识库空闲被关掉、账号被删、守护进程退出时停。
pub fn start_space(deps: Arc<BundleDeps>, space_id: String, runtime: Arc<Embedded>) -> SpaceTasks {
    let (stop_tx, stop_rx) = watch::channel(false);
    // 守护进程退出时也要停:把全局关闭信号转过来。后台任务退出后接收端全没了,转发也随之结束
    let forward = stop_tx.clone();
    let mut global = deps.shutdown.clone();
    tokio::spawn(async move {
        tokio::select! {
            _ = global.wait_for(|closing| *closing) => {
                let _ = forward.send(true);
            }
            () = forward.closed() => {}
        }
    });
    let busy = Arc::new(AtomicBool::new(false));
    let scope_runtime = runtime.clone();
    let scope_id = space_id.clone();
    let task_busy = busy.clone();
    let join = tokio::spawn(crate::spaces::within_space(
        scope_id,
        scope_runtime,
        async move {
            run_space(deps, space_id, runtime, stop_rx, task_busy).await;
        },
    ));
    SpaceTasks::new(stop_tx, join, busy)
}

async fn run_space(
    deps: Arc<BundleDeps>,
    space_id: String,
    runtime: Arc<Embedded>,
    stop: watch::Receiver<bool>,
    busy: Arc<AtomicBool>,
) {
    let config = deps.config_store.get();
    // 上次进程被杀时留下的「运行中」任务、过期的抢占标记,和主知识库启动时做的一样
    let queue = Arc::new(runtime.queue());
    match queue.recover().await {
        Ok(0) => {}
        Ok(recovered) => tracing::info!(space = %space_id, recovered, "恢复了上次中断的任务"),
        Err(err) => tracing::warn!(space = %space_id, error = %err, "恢复中断的任务失败"),
    }
    // 同主知识库:上次被强杀时在处理中的文件要回队,否则批次永远差几个跑不完
    match kb_service::IngestService::new(runtime.meta.clone())
        .recover_inflight()
        .await
    {
        Ok(0) => {}
        Ok(requeued) => {
            tracing::info!(space = %space_id, requeued, "重新入队了上次中断时在处理中的文件")
        }
        Err(err) => tracing::warn!(space = %space_id, error = %err, "恢复处理中的文件失败"),
    }
    if let Err(err) = runtime.collections().ensure_global().await {
        tracing::warn!(space = %space_id, error = %err, "确保 _global collection 失败");
    }
    if let Err(err) = kb_core::ports::repo::DraftRepo::clear_stale_claims(
        runtime.meta.as_ref(),
        kb_service::llm_gate::today_now_millis(),
        kb_service::evolution::inbox::CLAIM_TTL_MS,
    )
    .await
    {
        tracing::warn!(space = %space_id, error = %err, "清理草稿抢占标记失败");
    }

    let worker_index = Arc::new(runtime.index_service());
    let router = build_job_router(
        &runtime,
        &worker_index,
        &config,
        &deps.hub,
        deps.ledger.clone(),
    );
    let worker = Arc::new(
        Worker::new(queue, Arc::new(router), stop.clone())
            .with_slots(deps.slots.clone())
            .with_observer(Arc::new(HubObserver::new(deps.hub.clone()))),
    );

    // 每分钟一拍:清理超时的未完成上传 + optimize(`tick` 自己按 `[schedule]` 判断该不该干活)
    // 接着这个知识库上次被关掉之前的进度:重新打开不重跑 optimize 和当天的夜间校验
    let history = deps
        .history
        .lock()
        .ok()
        .and_then(|history| history.get(&space_id).copied())
        .unwrap_or_default();
    let scheduler = kb_service::scheduler::Scheduler::new(
        runtime.meta.clone(),
        runtime.store(),
        worker_index.clone(),
        kb_service::scheduler::options_from(&config.schedule),
        Arc::new(kb_service::scheduler::SystemClock),
    )
    .with_history(history);
    let mut shutdown = stop.clone();
    let tick_runtime = runtime.clone();
    let tick_store = deps.config_store.clone();
    let tick_deps = deps.clone();
    let tick_space = space_id.clone();
    let tick = async move {
        let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    busy.store(true, Ordering::Release);
                    let config = tick_store.get();
                    let cleanup = kb_service::UploadService::new(
                        tick_runtime.meta.clone(),
                        tick_runtime.paths.clone(),
                        config.upload.clone(),
                    );
                    if let Err(err) = cleanup.cleanup_stale(now_millis()).await {
                        tracing::warn!(error = %err, "清理未完成上传失败");
                    }
                    scheduler.set_options(kb_service::scheduler::options_from(&config.schedule));
                    if let Err(err) = scheduler.tick().await {
                        tracing::warn!(error = %err, "调度器出错");
                    }
                    if let Ok(mut history) = tick_deps.history.lock() {
                        history.insert(tick_space.clone(), scheduler.history());
                    }
                    busy.store(false, Ordering::Release);
                }
                changed = shutdown.changed() => {
                    // 发送端都没了也当作叫停,不能让 `changed` 立刻返回的错误把这里变成空转
                    if changed.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
            }
        }
    };
    tracing::info!(space = %space_id, "知识库的后台任务已启动");
    let worker_task = {
        let worker = worker.clone();
        async move { worker.run().await }
    };
    let (worker_result, ()) = tokio::join!(worker_task, tick);
    if let Err(err) = worker_result {
        tracing::error!(space = %space_id, error = %err, "worker 退出");
    }
    tracing::info!(space = %space_id, "知识库的后台任务已停止");
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::{Upload, UploadState};
    use kb_core::paths::KbPaths;
    use kb_core::ports::repo::UploadRepo;
    use std::time::{Duration, Instant};

    fn paths(home: &std::path::Path) -> KbPaths {
        KbPaths::from_home(home)
    }

    /// 轮询到 `probe` 给出值为止(最多 30 秒)。
    async fn wait_for<T>(mut probe: impl FnMut() -> Option<T>) -> T {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(value) = probe() {
                return value;
            }
            assert!(Instant::now() < deadline, "等了 30 秒还没等到");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// 早就超时的未完成上传:调度器每一拍先清它,再做 optimize / 夜间校验。
    fn stale_upload() -> Upload {
        Upload {
            id: "up_stale".to_owned(),
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
            created_at: 0,
            updated_at: 0,
            completed_at: None,
        }
    }

    /// 真的后台任务(后半):叫停就退出并放掉运行时;调度进度记在 `history` 里,重新打开的那一份
    /// 接着用,不重跑 optimize 和当天的夜间校验;守护进程的关闭信号也会传到。
    #[tokio::test]
    async fn space_tasks_stop_resume_their_schedule_and_follow_daemon_shutdown() {
        let home = tempfile::tempdir().expect("临时目录");
        let paths = paths(home.path());
        paths.ensure_dirs().expect("建目录");
        let mut config = Config::default();
        // 不加载嵌入模型
        config.embed.backend = "http".to_owned();
        let primary = Embedded::open(&paths, &config, false)
            .await
            .expect("主知识库");
        let space_id = "sp_bundletest".to_owned();
        let space_paths = paths.for_space(&space_id).expect("知识库路径");
        let open = || async {
            let runtime = Arc::new(
                primary
                    .open_space(&space_id, space_paths.clone())
                    .await
                    .expect("打开知识库"),
            );
            runtime
                .collections()
                .ensure_global()
                .await
                .expect("_global");
            runtime
        };
        let config_store = Arc::new(ConfigStore::new(config.clone()));
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let deps = Arc::new(BundleDeps {
            config_store: config_store.clone(),
            hub: Arc::new(kb_web::EventHub::new()),
            shutdown: shutdown_rx,
            slots: slice_gate(config_store),
            history: std::sync::Mutex::default(),
            ledger: None,
        });

        // 第一次打开:等第一拍做完、进度记下来,再叫停
        let runtime = open().await;
        let tasks = start_space(deps.clone(), space_id.clone(), runtime.clone());
        let first = wait_for(|| deps.history.lock().ok()?.get(&space_id).copied()).await;
        assert!(first.last_optimize.is_some(), "第一拍做了 optimize");
        let weak = Arc::downgrade(&runtime);
        drop(runtime);
        tokio::time::timeout(Duration::from_secs(30), tasks.stop())
            .await
            .expect("叫停后应很快退出");
        assert!(weak.upgrade().is_none(), "后台任务退出后不再拿着运行时");

        // 重新打开。放一个早就超时的上传当记号:它被清掉,说明这一拍已经开始(清理在调度之前);
        // 再等这一拍做完,进度应该原封不动——没有重跑 optimize / 夜间校验
        let runtime = open().await;
        UploadRepo::create(runtime.meta.as_ref(), stale_upload())
            .await
            .expect("建上传");
        let tasks = start_space(deps.clone(), space_id.clone(), runtime.clone());
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let upload = UploadRepo::get(runtime.meta.as_ref(), "up_stale")
                .await
                .expect("读上传")
                .expect("上传还在");
            if upload.state == UploadState::Aborted {
                break;
            }
            assert!(Instant::now() < deadline, "等不到重新打开后的第一拍");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        wait_for(|| (!tasks.busy()).then_some(())).await;
        assert_eq!(
            deps.history.lock().expect("锁").get(&space_id).copied(),
            Some(first),
            "接着上次的进度"
        );

        // 守护进程退出:不调 stop,只发全局关闭信号,后台任务也要退出
        shutdown_tx.send(true).expect("发关闭信号");
        wait_for(|| tasks.is_finished().then_some(())).await;
    }

    fn install_fake_soffice(dir: &std::path::Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir.join("program")).expect("建目录");
        let soffice = dir.join("program").join("soffice");
        std::fs::write(&soffice, "#!/bin/sh\nexit 0\n").expect("写");
        std::fs::set_permissions(&soffice, std::fs::Permissions::from_mode(0o755)).expect("权限");
    }

    #[test]
    fn converter_is_only_built_when_enabled_and_installed() {
        let home = tempfile::tempdir().expect("临时目录");
        let paths = paths(home.path());
        let mut config = kb_core::config::Config::default();
        // 默认关
        assert!(converter_for(&config, &paths).is_none());
        // 开了但没装
        config.convert.enabled = true;
        assert!(converter_for(&config, &paths).is_none());
        // 装在默认位置 <KB_HOME>/bin/libreoffice
        install_fake_soffice(&paths.bin_dir().join("libreoffice"));
        assert!(converter_for(&config, &paths).is_some());
        // 指定了别的目录,那里没装
        config.convert.install_dir = Some(home.path().join("elsewhere").display().to_string());
        assert!(converter_for(&config, &paths).is_none());
    }

    /// 上次进程被杀时留下的转换临时目录(里面有 LibreOffice 的用户配置,动辄几十 MB)启动时清掉。
    #[test]
    fn stale_conversion_work_dirs_are_cleared() {
        let home = tempfile::tempdir().expect("临时目录");
        let paths = paths(home.path());
        let work = convert_work_dir(&paths);
        std::fs::create_dir_all(work.join("convert-old").join("profile")).expect("建目录");
        std::fs::write(work.join("convert-old").join("profile").join("x"), "x").expect("写");
        clear_stale_work(&work);
        assert!(work.exists(), "工作目录本身要留着");
        assert_eq!(std::fs::read_dir(&work).expect("读").count(), 0);
        // 目录还不存在时不报错
        clear_stale_work(&home.path().join("never-created"));
    }
}
