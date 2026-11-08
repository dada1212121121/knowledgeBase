//! `kb daemon`:单实例守护进程 + 双监听。

use std::process::ExitCode;
use std::sync::Arc;

use kb_capability::defs;
use kb_capability::invoke::Invoker;
use kb_core::KbError;
use kb_core::config::{Config, ConfigStore};
use kb_core::paths::KbPaths;
use kb_service::jobs::Worker;
use tokio::sync::watch;

use crate::capability_backend::ServiceBackend;
use crate::error::CliError;
use crate::runtime::Embedded;

/// `kb daemon` 的参数。
#[derive(Clone, Debug, Default)]
pub struct DaemonArgs {
    /// 转到后台运行。
    pub detach: bool,
}

/// 后台化的标记环境变量。
const DETACHED_ENV: &str = "KB_DAEMON_DETACHED";

/// 同一个任务两次 `job.progress` 之间至少隔多久。
///
/// 进度按分片回调,批量索引时一秒能有好几次;每推一次,打开着的任务页 / 系统概览就会去刷新,
/// 推得再密界面也看不出区别。最后一次(做完了)一定推,进度条不会停在 99%。
const PROGRESS_MIN_GAP: std::time::Duration = std::time::Duration::from_secs(1);

/// 把 worker 的进度回调转成 `job.progress` / `job.done` 事件。
pub(crate) struct HubObserver {
    hub: Arc<kb_web::EventHub>,
    /// 每个任务上一次推 `job.progress` 的时间(任务结束时清掉)。
    last_progress: std::sync::Mutex<std::collections::HashMap<String, std::time::Instant>>,
}

impl HubObserver {
    pub(crate) fn new(hub: Arc<kb_web::EventHub>) -> Self {
        Self {
            hub,
            last_progress: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// 这一次进度要不要推:做完了一定推;否则同一任务 [`PROGRESS_MIN_GAP`] 内只推第一次。
    fn should_publish(&self, job_id: &str, complete: bool, now: std::time::Instant) -> bool {
        let mut last = self
            .last_progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let due = complete
            || last
                .get(job_id)
                .is_none_or(|at| now.duration_since(*at) >= PROGRESS_MIN_GAP);
        if due {
            last.insert(job_id.to_owned(), now);
        }
        due
    }
}

impl kb_service::jobs::JobObserver for HubObserver {
    fn on_progress(&self, job: &kb_core::model::Job, progress: &kb_service::jobs::SliceProgress) {
        let complete =
            progress.finished || progress.total.is_some_and(|total| progress.done >= total);
        if !self.should_publish(&job.id, complete, std::time::Instant::now()) {
            return;
        }
        // 剩余时间按当前速率估算(设计规范的 rate 是块/秒)
        let eta_seconds = match (progress.total, job.rate) {
            (Some(total), Some(rate)) if rate > 0.0 => {
                let left = total.saturating_sub(progress.done) as f64;
                Some((left / rate).round() as u64)
            }
            _ => None,
        };
        self.hub.publish(
            "job.progress",
            serde_json::json!({
                "job_id": job.id,
                "kind": job.kind,
                "collection": job.collection,
                "state": job.state.as_str(),
                "done": progress.done,
                "total": progress.total,
                "rate": job.rate,
                "eta_seconds": eta_seconds,
                "errors": progress.errors,
            }),
        );
    }

    fn on_finish(&self, job: &kb_core::model::Job) {
        // 结束(含让出回队列)后清掉记录:表不会随任务数增长,重新开始跑时第一次进度立刻推
        self.last_progress
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&job.id);
        self.hub.publish(
            "job.done",
            serde_json::json!({
                "job_id": job.id,
                "kind": job.kind,
                "collection": job.collection,
                "state": job.state.as_str(),
                "error": job.error,
                "finished_at": job.finished_at,
            }),
        );
    }
}

/// 启动资源采样任务:每 10 秒读一次,跨过整分钟时把上一分钟的聚合行写进 system.db,每小时清一次 30 天前的。
///
/// 读 /proc 和 `df` 都是阻塞调用,放进阻塞线程池;写库失败只记一条警告,不影响采样继续(图上这一分钟断开)。
fn spawn_metrics_sampler(
    hub: kb_service::metrics::MetricsHub,
    system: Arc<kb_meta::SystemStore>,
    data_dir: std::path::PathBuf,
) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(
            kb_service::metrics::SAMPLE_EVERY_SECS,
        ));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut last_prune = 0i64;
        loop {
            tick.tick().await;
            let now = now_millis();
            let dir = data_dir.clone();
            let reading =
                tokio::task::spawn_blocking(move || kb_service::metrics::read_now(now, &dir))
                    .await
                    .ok()
                    .flatten();
            let Some(reading) = reading else { continue };
            if let Some(row) = hub.push(reading)
                && let Err(err) = system.put_metric(row).await
            {
                tracing::warn!(error = %err, "资源采样写库失败,这一分钟的曲线会断开");
            }
            if now - last_prune > 3_600_000 {
                last_prune = now;
                if let Err(err) = system
                    .prune_metrics(now - kb_core::model::METRIC_KEEP_MS)
                    .await
                {
                    tracing::warn!(error = %err, "清理 30 天前的资源采样失败");
                }
            }
        }
    });
}

/// 配置重载结果的观察者:推 WS 事件 + 热更新日志级别。
struct HubConfigObserver {
    hub: Arc<kb_web::EventHub>,
    store: Arc<ConfigStore>,
}

impl kb_service::ConfigObserver for HubConfigObserver {
    fn on_outcome(&self, outcome: &kb_service::ReloadOutcome) {
        if let Some(error) = &outcome.error {
            // 非法配置:内存里的旧配置继续生效,只把原因推给 Web(“写坏配置不炸服务”)
            tracing::warn!(error = %error, "配置文件不可用,继续用当前配置");
            self.hub.publish(
                "config.error",
                serde_json::json!({
                    "error": error,
                    "generation": outcome.generation,
                    "notes": outcome.notes,
                }),
            );
            return;
        }
        if !outcome.migration.is_empty() {
            tracing::warn!(
                keys = %outcome.migration.join(", "),
                "配置里的 embed 改动需要先迁移,本次未生效"
            );
            self.hub.publish(
                "config.migration",
                serde_json::json!({
                    "migration": outcome.migration,
                    "plan": outcome.migration_plan,
                    "notes": outcome.notes,
                    "generation": outcome.generation,
                }),
            );
            return;
        }
        if !outcome.applied {
            // “没变化”:不发事件,但回执要能让 Web 知道已经处理过
            tracing::debug!(notes = ?outcome.notes, "配置没有变化");
            return;
        }
        // 日志级别是热更新项里唯一需要“副作用”的:过滤器在 tracing 里,要就地替换
        if outcome.hot.iter().any(|key| key == "log.level") {
            let level = self.store.get().log.level.clone();
            match crate::logging::set_level(&level) {
                Ok(()) => tracing::info!(level, "日志级别已热更新"),
                Err(err) => tracing::warn!(error = %err, "热更新日志级别失败"),
            }
        }
        tracing::info!(generation = outcome.generation, hot = ?outcome.hot, restart = ?outcome.restart_required, "配置已热更新");
        self.hub.publish(
            "config.changed",
            serde_json::json!({
                "generation": outcome.generation,
                "hot": outcome.hot,
                "restart_required": outcome.restart_required,
                "notes": outcome.notes,
            }),
        );
    }
}

pub(crate) fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 上传解包的限制(与 `[upload]` 配置对齐)。
pub(crate) fn ingest_limits(
    config: &kb_core::config::UploadConfig,
) -> kb_service::upload::unpack::UnpackLimits {
    kb_service::upload::unpack::UnpackLimits {
        max_ratio: config.unpack_max_ratio,
        max_depth: config.unpack_max_depth,
        max_files: config.unpack_max_files,
        max_bytes: config.max_file_mb * 1024 * 1024,
        max_total_bytes: config.max_total_gb * 1024 * 1024 * 1024,
    }
}

/// 启动阶段的计时器。
///
/// 为什么单独记:重启窗口的体感取决于「开库 / 预热 / 恢复任务 / 补表」几段,
/// 没有分阶段数字就只能靠猜。
/// 每段一行 INFO(本段耗时 + 累计),默认日志级别就能看到,不需要开 DEBUG。
struct StartupClock {
    /// 进程内的起点,用来给「累计」计时。
    started: std::time::Instant,
    /// 上一段的终点,用来给「本段」计时。
    at: std::time::Instant,
}

impl StartupClock {
    fn new() -> Self {
        let now = std::time::Instant::now();
        Self {
            started: now,
            at: now,
        }
    }

    /// 记一段(阶段名用英文小写,便于日志检索)。
    fn mark(&mut self, phase: &str) {
        tracing::info!(
            phase,
            ms = self.at.elapsed().as_millis() as u64,
            total_ms = self.started.elapsed().as_millis() as u64,
            "启动阶段"
        );
        self.at = std::time::Instant::now();
    }
}

/// 预热嵌入模型的上限:超过这个时间还没就绪,就认为模型 / sidecar 有问题。
const WARM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// 启动守护进程。
pub async fn run(paths: &KbPaths, config: &Config, args: DaemonArgs) -> Result<ExitCode, CliError> {
    if args.detach && std::env::var(DETACHED_ENV).is_err() {
        return detach(paths);
    }

    // 单实例锁:拿不到说明已经有一个守护进程在跑
    // :配置放在 ConfigStore 里,热重载改的就是这一份
    let mut clock = StartupClock::new();
    let config_store = Arc::new(ConfigStore::new(config.clone()));
    let runtime =
        Arc::new(Embedded::open_with_config_store(paths, config_store.clone(), true).await?);
    clock.mark("open");
    // 预热嵌入模型:默认等它就绪(起不来就退出,问题暴露在启动而不是第一条检索);
    // `server.warm_on_start = false` 改成后台预热,先把服务让出来。
    if config.server.warm_on_start {
        runtime.warm_embedder(WARM_TIMEOUT).await?;
        clock.mark("warm");
    } else {
        let warm_runtime = runtime.clone();
        tokio::spawn(async move {
            match warm_runtime.warm_embedder(WARM_TIMEOUT).await {
                Ok(()) => tracing::info!("后台预热嵌入模型完成"),
                // 不退出:服务已经在跑,预热失败只影响查询,记 WARN 让人去查 sidecar
                Err(err) => tracing::warn!(error = %err, "后台预热嵌入模型失败"),
            }
        });
        tracing::warn!(
            "server.warm_on_start = false:先让服务可用,嵌入模型在后台预热,预热完成前的嵌入请求会报「正在加载」"
        );
    }

    // 账号库:用户、角色、会话、令牌。旧的单密码部署在这里自动变成第一个管理员
    let system = Arc::new(kb_meta::SystemStore::open(paths.system_db())?);
    adopt_legacy_admin(&system, &runtime).await;
    clock.mark("system");

    let queue = Arc::new(runtime.queue());
    let recovered = queue.recover().await?;
    if recovered > 0 {
        tracing::info!(recovered, "恢复了上次中断的任务");
    }
    // 上次被强杀时正在解析的文件会卡在 extracting / chunking / embedding:它们既不在队列里,
    // 也不算完成。拨回 queued 才能让批次接着跑完(否则进度永远差几个、批次提前收尾)。
    match kb_service::IngestService::new(runtime.meta.clone())
        .recover_inflight()
        .await
    {
        Ok(0) => {}
        Ok(requeued) => tracing::info!(requeued, "重新入队了上次中断时在处理中的文件"),
        Err(err) => tracing::warn!(error = %err, "恢复处理中的文件失败"),
    }
    clock.mark("recover");
    // `_global` 是数据模型的一部分(全局经验、`--global` 导入都落在这里)。启动时确保它存在:
    // 否则每次检索都会因为“目标 collection 不存在”打一条 WARN,而且全局经验要先“懒创建”。
    if let Err(err) = runtime.collections().ensure_global().await {
        tracing::warn!(error = %err, "确保 _global collection 失败(检索会跳过它)");
    }
    // 从备份恢复后 `lance/` 是空的:补表并重新嵌入经验条目(平时只是几次 count)
    runtime.heal_restored_tables().await;
    clock.mark("heal");
    // 审核收件箱的抢占标记:上次进程被杀 / 请求被取消时可能留下,启动时清一次
    match kb_core::ports::repo::DraftRepo::clear_stale_claims(
        runtime.meta.as_ref(),
        kb_service::llm_gate::today_now_millis(),
        kb_service::evolution::inbox::CLAIM_TTL_MS,
    )
    .await
    {
        Ok(0) => {}
        Ok(cleared) => tracing::info!(cleared, "清理了过期的草稿抢占标记"),
        Err(err) => tracing::warn!(error = %err, "清理草稿抢占标记失败"),
    }

    clock.mark("claims");
    // 事件中心:任务进度 / 条目变更 / warn 日志都从这里推给 `/api/v1/ws`
    let hub = Arc::new(kb_web::EventHub::new());
    crate::logging::attach_event_hub(hub.clone());
    // :批次进度与 ETA 的平滑状态在每个知识库的运行时里(`runtime.tracker`),
    // 和该知识库的解析任务共用同一个实例,所以这里不再单独建
    // 配置热重载:`update_config` 与文件监听共用同一个重载器
    let reloader = Arc::new(
        kb_service::ConfigReloader::new(config_store.clone(), paths.config_file())
            .with_meta(runtime.meta.clone())
            .with_observer(Arc::new(HubConfigObserver {
                hub: hub.clone(),
                store: config_store.clone(),
            })),
    );
    let agent_grants = Arc::new(kb_web::AgentGrants::new());
    #[cfg(feature = "testkit")]
    if let Ok(token) = std::env::var("KB_TEST_AGENT_TOKEN") {
        let groups =
            std::env::var("KB_TEST_AGENT_GROUPS").unwrap_or_else(|_| "knowledge".to_owned());
        let tool_groups: Vec<String> = groups
            .split(',')
            .map(|item| item.trim().to_owned())
            .filter(|item| !item.is_empty())
            .collect();
        agent_grants.insert_known(
            token,
            kb_web::AgentGrant {
                tool_groups,
                project: None,
                session_id: "test".to_owned(),
                principal: None,
                include_shared: false,
            },
        );
    }
    // 存储配额:上传和新建笔记共用一张带缓存与预留的用量表,并发操作加起来不会超出配额
    let storage_guard = crate::storage_guard::StorageGuard::new(
        kb_service::storage::StorageMeter::new(kb_service::storage::DEFAULT_TTL),
        Some(system.clone()),
        config_store.clone(),
    );
    // 按用户记账:额度 = 全站默认 → 角色 → 用户例外,每次调用现取。能力调用与后台的网页 AI 规范化共用一份
    let llm_ledger: Arc<dyn kb_core::ports::UserLlmLedger> =
        kb_meta::system::SystemLlmLedger::new(system.clone(), config_store.clone());
    let backend = Arc::new(
        ServiceBackend::new(runtime.clone())
            .with_storage_guard(storage_guard.clone())
            .with_system(system.clone())
            // 按用户记账:额度 = 全站默认 → 角色 → 用户例外,每次调用现取
            .with_llm_ledger(llm_ledger.clone())
            .with_hub(hub.clone())
            .with_reloader(reloader.clone())
            .with_agent_grants(agent_grants.clone()),
    );
    // 知识库注册表:每个用户的「知识库内」调用被路由到他自己的 `spaces/<id>/`;主知识库是 KB_HOME 根目录
    let spaces = crate::spaces::SpaceRegistry::new(runtime.clone(), system.clone(), paths.clone());
    let ai_switch: kb_web::api::AiSwitch = {
        let store = config_store.clone();
        Arc::new(move || store.get().ai.state())
    };
    // 多人在线编辑:协作状态存各知识库自己的 meta.db,正文落回各自的笔记 / 文件;
    // 权限(登录用户 / 分享链接)由网络层的核对器负责,房间定期重新核对
    let collab_backend = crate::collab_backend::CollabBackend::new(spaces.clone());
    let collab_hub = Arc::new(kb_collab::CollabHub::new(
        collab_backend.clone(),
        collab_backend.clone(),
        kb_web::collab_ws::WebCollabAuth::new(
            system.clone(),
            config_store.clone(),
            ai_switch.clone(),
        ),
        kb_collab::Limits::default(),
    ));
    backend.set_collab(collab_hub.clone());
    let collab_endpoint = kb_web::collab_ws::CollabEndpoint::new(collab_hub.clone());
    // 办公文档多人协同:office-worker 按需启动;房间外的整文件替换遇到正在协同的文件会被拒绝
    let office_collab =
        crate::office_collab::OfficeCollab::new(spaces.clone(), config_store.clone());
    backend.set_office(office_collab.clone());
    let office_api: Option<Arc<dyn kb_web::office_ws::OfficeCollabApi>> = Some(Arc::new(
        crate::office_collab::OfficeApi(office_collab.clone()),
    ));
    // 个人数据导出:任务表只有一份,HTTP 接口和定时清理用的是同一个
    let exports = crate::personal_export::ExportManager::new(
        paths.clone(),
        paths.exports_dir().to_path_buf(),
        config_store.clone(),
        // 笔记从知识库注册表读:用户自己的笔记在他自己的 meta.db 里
        crate::personal_export::SpaceNotes::new(spaces.clone()),
    );
    // 发信器只建一个:注册接口和管理端的「测试发信」共用,主备冷却状态才是同一份
    let mailer = Arc::new(kb_mail::Mailer::smtp());
    // 通知器只建一个:好友 / 分享的通知和评论的 @ / 回复通知共用
    let notifier =
        kb_web::notify::Notifier::new(system.clone(), Some(hub.clone()), config_store.clone());
    backend.set_comment_directory(crate::comment_backend::SystemCommentDirectory::new(
        system.clone(),
        notifier.clone(),
    ));
    // 资源采样:每 10 秒读一次 /proc,每分钟一行落到 system.db(系统状态页的资源曲线)
    let metrics = kb_service::metrics::MetricsHub::new();
    spawn_metrics_sampler(metrics.clone(), system.clone(), paths.home().to_path_buf());
    let admin: Arc<dyn kb_capability::AdminBackend> = Arc::new(
        crate::admin_backend::SystemAdmin::new(system.clone(), config_store.clone())
            .with_metrics(metrics)
            .with_storage(crate::admin_backend::StorageDeps {
                meter: storage_guard.meter().clone(),
                paths: paths.clone(),
            })
            // 文档分享:授权、批量分享、共享给我 / 我的分享
            .with_share(spaces.clone())
            // 授权 / 链接变更后让协作房间立刻重新核对权限(降级马上只读、收回马上断开)
            .with_collab(collab_hub.clone())
            // 好友与通知:通知写库、实时推给本人、需要时排进邮件队列
            .with_social(notifier.clone())
            .with_mail(crate::admin_registration::MailDeps {
                mailer: mailer.clone(),
                paths: paths.clone(),
            }),
    );
    let registry = Arc::new(defs::build_with_admin(backend.clone(), admin));
    // 强制模式:没有身份的调用一律 401;功能点与范围在能力层统一检查
    let invoker = Arc::new(
        Invoker::new(registry, runtime.meta.clone())
            .with_resolver(spaces.clone())
            // 别人分享给我的内容:点名对方知识库(X-KB-Space)的调用交给分享闸门逐项授权
            .with_share_gate(crate::shared_gate::SharedGate::new(
                system.clone(),
                spaces.clone(),
            ))
            // 管理员只读查看(X-KB-Admin-View):白名单 + 永远只读,审计落 system.db
            .with_admin_view_gate(crate::admin_view_gate::AdminViewGateImpl::new(
                system.clone(),
                spaces.clone(),
                config_store.clone(),
            ))
            .enforcing(),
    );
    // AI 管家要回调能力:构造顺序决定只能事后注入
    backend.set_invoker(invoker.clone());
    // `/mcp`(计划变更 ):只有 mcp.transports 含 http 时才挂载
    let mcp = if config.mcp.http_enabled() {
        let file = paths.mcp_token_file();
        let token = std::fs::read_to_string(&file)
            .map_err(|_| {
                KbError::InvalidInput(format!(
                    "启用了 mcp.transports=http,但缺少 token 文件 {};先运行 `kb mcp token`",
                    file.display()
                ))
            })?
            .trim()
            .to_owned();
        if token.is_empty() {
            return Err(KbError::InvalidInput(
                "token 文件是空的;先运行 `kb mcp token --rotate`".to_owned(),
            )
            .into());
        }
        let addr = kb_core::config::parse_listen(&config.server.listen)?;
        // 默认只允许本机 Host;反向代理暴露 https 时用 mcp.allowed_hosts 加外部域名
        let mut allowed_hosts = vec![
            "localhost".to_owned(),
            "127.0.0.1".to_owned(),
            "::1".to_owned(),
            format!("localhost:{}", addr.port()),
            format!("127.0.0.1:{}", addr.port()),
        ];
        allowed_hosts.extend(config.mcp.allowed_hosts.iter().cloned());
        let mut allowed_origins = vec![
            format!("http://127.0.0.1:{}", addr.port()),
            format!("http://localhost:{}", addr.port()),
        ];
        allowed_origins.extend(kb_web::mcp::origins_from_hosts(&allowed_hosts));
        let gate = kb_web::mcp::McpGate {
            token_file: file.clone(),
            allowed_origins,
            allowed_hosts,
        };
        let client = kb_mcp::uds::UdsClient::new(paths.socket());
        Some(Arc::new(
            kb_web::mcp::McpEndpoint::with_config_store(gate, client, config_store.clone())
                // 令牌用户的 MCP 带着各自的身份走 agent.sock(本机文件令牌仍走 kb.sock)
                .with_agent_socket(paths.agent_socket()),
        ))
    } else {
        None
    };
    // 上一次进程被杀时可能留下“提炼中”的事件行:启动时统一收尾
    if let Err(err) = kb_service::evolution::recover_interrupted_pending(runtime.meta.clone()).await
    {
        tracing::warn!(error = %err, "收尾中断的后台提炼失败");
    }
    let events: Arc<dyn kb_web::events::EventSink> = Arc::new(
        crate::capability_backend::ServiceEvents::with_registry(spaces.clone())
            .with_backend(backend.clone()),
    );
    let state = Arc::new(kb_web::AppState {
        invoker,
        started: std::time::Instant::now(),
        version: env!("CARGO_PKG_VERSION"),
        mcp,
        events: Some(events),
        meta: runtime.meta.clone(),
        system: system.clone(),
        principals: kb_web::auth::PrincipalCache::default(),
        account: kb_web::signup::AccountDeps {
            config: config_store.clone(),
            mailer: mailer.clone(),
            passwords: {
                let paths = paths.clone();
                Arc::new(move || crate::runtime::mail_passwords(&paths))
            },
            limiter: Arc::new(kb_web::auth::ratelimit::LoginLimiter::new()),
            avatars_dir: paths.avatars_dir().to_path_buf(),
            home: paths.home().to_path_buf(),
            exports: exports.clone(),
        },
        // AI 开关:`[ai]` 是热更新项,每个请求现读
        ai_enabled: ai_switch.clone(),
        login_limiter: kb_web::auth::ratelimit::LoginLimiter::new(),
        hub: hub.clone(),
        // :上传接口(分片续传 / 去重 / 解包)
        uploads: Some(Arc::new(
            crate::capability_backend::ServiceUploads::with_registry(spaces.clone())
                .with_storage_guard(storage_guard.clone())
                .with_hub(hub.clone())
                .with_office(office_collab.clone()),
        )),
        agent_grants,
        collab: Some(collab_endpoint.clone()),
        office: office_api.clone(),
    });

    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    spawn_signal_handler(shutdown_tx);

    // 配置热重载:notify 监听 config.toml,500ms 去抖,热项立即生效
    let _config_watcher = reloader.spawn_watch(shutdown_rx.clone())?;

    // 通知邮件:每分钟看一次谁有排队的通知、距上一封是否已满 10 分钟,合并成一封发出;
    // 每小时顺手清掉超过 90 天的站内通知
    {
        let (system, mailer, config_store, paths) = (
            system.clone(),
            mailer.clone(),
            config_store.clone(),
            paths.clone(),
        );
        let mut stop = shutdown_rx.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval_at(
                tokio::time::Instant::now() + std::time::Duration::from_secs(45),
                std::time::Duration::from_secs(60),
            );
            let mut round: u64 = 0;
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        let passwords = crate::runtime::mail_passwords(&paths);
                        kb_web::notify::send_due_digests(
                            system.as_ref(),
                            &mailer,
                            &passwords,
                            &config_store.get(),
                            now_millis(),
                        )
                        .await;
                        round += 1;
                        if round.is_multiple_of(60) {
                            if let Err(err) = system.purge_old_notifications(now_millis()).await {
                                tracing::warn!(error = %err, "清理旧通知失败");
                            }
                            crate::share_housekeeping::run(&system, now_millis()).await;
                        }
                    }
                    _ = stop.changed() => {
                        if *stop.borrow() {
                            break;
                        }
                    }
                }
            }
        });
    }

    // 存储占用统计:每 10 分钟量最久没量的一小批知识库(首轮 1 分钟后),写进 system.db
    {
        let (system, paths) = (system.clone(), paths.clone());
        let mut stop = shutdown_rx.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval_at(
                tokio::time::Instant::now() + std::time::Duration::from_secs(60),
                std::time::Duration::from_secs(600),
            );
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        crate::usage_task::measure_round(
                            &system,
                            &paths,
                            now_millis(),
                            std::time::Duration::from_millis(200),
                        )
                        .await;
                    }
                    _ = stop.changed() => {
                        if *stop.borrow() {
                            break;
                        }
                    }
                }
            }
        });
    }

    // 冷静期结束的账号:每小时扫一轮,真正删除账号和他的数据。
    // 首轮推迟 5 分钟,别在守护进程刚起来、还在加载的时候就做破坏性操作。
    {
        let (system, spaces, paths) = (system.clone(), spaces.clone(), paths.clone());
        let exports = exports.clone();
        let mut stop = shutdown_rx.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval_at(
                tokio::time::Instant::now() + std::time::Duration::from_secs(300),
                std::time::Duration::from_secs(3600),
            );
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        // 过期的个人数据导出文件也在这一拍清掉(不能只靠有人来查状态时顺带清)
                        exports.sweep(now_millis());
                        if let Err(err) = crate::account_cleanup::purge_due_accounts(
                            &system,
                            Some(&spaces),
                            &paths,
                            now_millis(),
                        )
                        .await
                        {
                            tracing::warn!(error = %err, "扫描到期注销账号失败");
                        }
                    }
                    _ = stop.changed() => {
                        if *stop.borrow() {
                            break;
                        }
                    }
                }
            }
        });
    }
    tracing::info!(
        file = %paths.config_file().display(),
        debounce_ms = kb_service::CONFIG_DEBOUNCE_MS,
        "配置热重载已启动"
    );

    // 文件监听:只监听已注册项目,并随项目的增、删、改自动对账。
    // 挂监听要遍历各项目的目录树,大项目要几十秒(生产上实测约 31 秒),
    // 放在后台建,不能挡住后面的端口绑定,否则每次重启这段时间前端代理一直返回 502。
    // 注册表归这个后台任务独占:任务随关闭信号退出时一起释放,所有监听随之停止。
    // 不在添加 / 移除项目的能力里挂钩子:每 30 秒按项目表对账一次就够了,改动面最小。
    if config.index.watch {
        let registry = kb_service::evolution::WatchRegistry::new(
            config_store.clone(),
            Arc::new(kb_service::EventService::new(runtime.meta.clone())),
            config.index.debounce_ms,
        );
        let meta = runtime.meta.clone();
        let mut stop = shutdown_rx.clone();
        tokio::spawn(async move {
            let mut announced = false;
            loop {
                // 大项目挂监听要几十秒,期间收到关闭信号就不再等
                let synced = tokio::select! {
                    synced = sync_file_watchers(&registry, meta.as_ref()) => synced,
                    _ = wait_for_stop(&mut stop) => break,
                };
                match synced {
                    // 首次同步成功:沿用原来的启动日志
                    Some(report) if !announced => {
                        announced = true;
                        tracing::info!(
                            count = report.started,
                            dirs = report.total_dirs,
                            "文件监听已启动"
                        );
                    }
                    // 之后只在监听集合有变化时打一条
                    Some(report) if report.changed() => tracing::info!(
                        started = report.started,
                        stopped = report.stopped,
                        restarted = report.restarted,
                        failed = report.failed,
                        dirs = report.total_dirs,
                        "文件监听已同步"
                    ),
                    _ => {}
                }
                tokio::select! {
                    _ = tokio::time::sleep(FILE_WATCH_SYNC_INTERVAL) => {}
                    _ = wait_for_stop(&mut stop) => break,
                }
            }
        });
    }

    // 上次被杀时留在转换临时目录里的 LibreOffice 配置(动辄几十 MB)清掉;此时还没有任何转换在跑
    crate::bundle::clear_stale_conversions(paths);
    // 后台索引 / 解析任务共用同一个 `IndexService`: 的 `index.exclude` 热更新
    // 直接换掉它的参数,不用重启守护进程
    let worker_index = Arc::new(runtime.index_service());

    // 调度器:每小时 optimize + 夜间指纹校验。
    // `tick` 自己按 `[schedule]` 判断该不该干活,所以这里固定每分钟醒一次即可。
    {
        let index = worker_index.clone();
        // :调度器顺带刷新到点的外部资料(网页 / Git / 本地目录)
        let source_service = Arc::new(
            kb_service::SourceService::new(
                runtime.meta.clone(),
                runtime.store(),
                runtime.scanner.clone(),
                runtime.paths.clone(),
                runtime.config().upload.clone(),
            )
            .with_allow_private_web(config.network.crawl_allow_private)
            .with_skills(runtime.skills()),
        );
        let scheduler = kb_service::scheduler::Scheduler::new(
            runtime.meta.clone(),
            runtime.store(),
            index,
            kb_service::scheduler::options_from(&config.schedule),
            Arc::new(kb_service::scheduler::SystemClock),
        )
        .with_sources(source_service);
        // 设置页「备份」的定时备份 + 保留策略:`[backup]` 是热更新项,每拍重读一次策略。
        // 挂上观察者:定时备份的进度与失败也推 WS(`backup.progress` / `backup.failed`)
        let backup = Arc::new(
            kb_service::backup::BackupService::new(
                runtime.paths.clone(),
                Arc::new(crate::runtime::MetaDbSnapshot::new(runtime.meta.clone())),
            )
            // 多用户:账号库和各用户知识库也进定时备份
            .with_extra_snapshotter(Arc::new(crate::runtime::MetaFileSnapshotter))
            .with_policy(kb_service::backup::BackupPolicy::from_config(
                &config.backup,
            ))
            .with_observer(Arc::new(
                crate::capability_backend::HubBackupObserver::new(hub.clone()),
            )),
        );
        let scheduler = scheduler.with_backup(backup.clone());
        // :夜间质量门禁。夜里最后一件事是抽 15 条黄金集跑一遍,和上一期同指纹的记录比 hit@1,
        // 跌过 5% 才告警 + 写事件;没装黄金集的知识库直接跳过。
        let scheduler = scheduler.with_quality_gate(Arc::new(
            crate::nightly_gate::NightlyEvalGate::new(runtime.clone()),
        ));
        // :夜间顺带按 [retention] 的期限清历史表(jobs / audit / events + 账号库的审计与采样)。
        // 期限是 0 的表不动;失败只告警,不影响夜间校验的其余部分。
        let scheduler =
            scheduler.with_retention(Arc::new(crate::retention::RetentionSweeper::new(
                runtime.meta.clone(),
                system.clone(),
                runtime.config.clone(),
            )));
        // :回收站只留 30 天,过期条目连同磁盘副本一起删掉。
        let scheduler = scheduler.with_trash(std::sync::Arc::new(kb_service::FileOpsService::new(
            runtime.meta.clone(),
            runtime.store(),
            std::sync::Arc::new(runtime.index_service()),
            runtime.paths.clone(),
        )));
        // :夜间顺带跑一次去重(`[evolution] nightly_dedup = false` 时不接)
        let scheduler = Arc::new(if config.evolution.nightly_dedup {
            scheduler.with_dedup(Arc::new(kb_service::evolution::DedupService::new(
                runtime.meta.clone(),
                runtime.embedder.clone(),
                config.evolution.clone(),
            )))
        } else {
            scheduler
        });
        let mut rx = shutdown_rx.clone();
        // :未完成上传的清理也搭这班车(每拍一次,超过 upload.keep_hours 的会被清掉)
        let uploads = runtime.meta.clone();
        let upload_paths = runtime.paths.clone();
        let upload_config = runtime.config().upload.clone();
        // :`[schedule]` / `[backup]` / `index.exclude` 都是热更新项,每拍重读一次
        let hot_store = config_store.clone();
        let refreshable_index = worker_index.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        let cleanup = kb_service::UploadService::new(
                            uploads.clone(),
                            upload_paths.clone(),
                            upload_config.clone(),
                        );
                        match cleanup.cleanup_stale(now_millis()).await {
                            Ok(0) => {}
                            Ok(removed) => tracing::info!(removed, "清理了过期的未完成上传"),
                            Err(err) => tracing::warn!(error = %err, "清理未完成上传失败"),
                        }
                        // :`[schedule]` / `[backup]` / `index.exclude` 改了下一拍就按新值判断
                        apply_hot_config(
                            &hot_store,
                            &scheduler,
                            &backup,
                            &refreshable_index,
                        );
                        match scheduler.tick().await {
                            Ok((plan, report)) if plan.optimize || plan.nightly => {
                                tracing::info!(
                                    optimize = plan.optimize,
                                    nightly = plan.nightly,
                                    resynced = report.resynced,
                                    dropped = report.dropped_tables,
                                    "调度器执行了一拍"
                                );
                            }
                            Ok(_) => {}
                            Err(err) => tracing::warn!(error = %err, "调度器出错"),
                        }
                    }
                    _ = rx.changed() => {
                        if *rx.borrow() {
                            tracing::info!("调度器收到关闭信号");
                            break;
                        }
                    }
                }
            }
        });
    }

    // 单写者 worker:索引 / insight 嵌入 / 换模型迁移 / 上传解析(主知识库和其他知识库同一份路由)
    let router = crate::bundle::build_job_router(
        &runtime,
        &worker_index,
        config,
        &hub,
        Some(llm_ledger.clone()),
    );
    // 全站共享的分片名额:主知识库和其他知识库的后台 worker 轮流用
    let slice_slots = crate::bundle::slice_gate(config_store.clone());
    let worker = Arc::new(
        Worker::new(queue.clone(), Arc::new(router), shutdown_rx.clone())
            .with_slots(slice_slots.clone())
            .with_observer(Arc::new(HubObserver::new(hub.clone()))),
    );
    // 主知识库的后台任务也包进知识库路由:它们推送的事件带 `sp_primary` 标签
    let worker_task = tokio::spawn(crate::spaces::within_space(
        kb_core::account::PRIMARY_SPACE_ID.to_owned(),
        runtime.clone(),
        {
            let worker = worker.clone();
            async move {
                if let Err(err) = worker.run().await {
                    tracing::error!(error = %err, "worker 退出");
                }
            }
        },
    ));
    // skills 热载:`<KB_HOME>/skills/` 里的 manifest / 脚本一改就重扫。
    // 以前要么重启守护进程、要么去设置页点一次「重新扫描」;而重扫本身早就支持热换快照,
    // 缺的只是“有人告诉它该扫了”。
    {
        let runtime = runtime.clone();
        let dir = paths.skills_dir().to_path_buf();
        tokio::spawn(async move {
            // `_watcher` 必须活在这个任务里:它一被丢掉,监听就停了
            let (mut changes, _watcher) = match kb_service::skills_watch::watch_skills_dir(
                &dir,
                kb_service::skills_watch::SKILLS_DEBOUNCE_MS,
            ) {
                Ok(pair) => pair,
                // 挂不上监听(内核监听项用光、无 inotify)不致命:退回手动重扫
                Err(err) => {
                    tracing::warn!(
                        error = %err,
                        dir = %dir.display(),
                        "skills 目录监听未启用,改了插件需要手动重扫或重启"
                    );
                    return;
                }
            };
            tracing::info!(dir = %dir.display(), "已监听 skills 目录,插件改动会热生效");
            while changes.recv().await.is_some() {
                let runtime = runtime.clone();
                // 重扫要读盘 + 解析 manifest,是阻塞活,不能占异步工作线程
                let reloaded = tokio::task::spawn_blocking(move || runtime.reload_skills()).await;
                match reloaded {
                    Ok(registry) => tracing::info!(
                        plugins = registry.plugin_count(),
                        warnings = registry.warnings().len(),
                        "skills 目录有变化,已重扫"
                    ),
                    Err(err) => tracing::warn!(error = %err, "skills 重扫任务异常退出"),
                }
            }
        });
    }
    // 其他知识库:打开时起它自己的后台任务(作业 worker + 调度器),句柄由注册表保管
    {
        let deps = Arc::new(crate::bundle::BundleDeps {
            config_store: config_store.clone(),
            hub: hub.clone(),
            shutdown: shutdown_rx.clone(),
            slots: slice_slots.clone(),
            history: std::sync::Mutex::default(),
            ledger: Some(llm_ledger.clone()),
        });
        spaces.set_on_open(Arc::new(move |space_id, space_runtime| {
            crate::bundle::start_space(deps.clone(), space_id, space_runtime)
        }));
    }
    // 重启恢复(非主知识库那一半):它们按请求懒加载,没人访问就不打开——`queue.recover` /
    // `recover_inflight` 也就不会跑,正在跑的批次会停在原地等下一次访问。
    // 启动后主动扫一遍,有活儿的先拉起来(没有的在探测后立即放掉)。
    {
        let spaces = spaces.clone();
        tokio::spawn(async move {
            for space in spaces.resume_unfinished().await {
                tracing::info!(space = %space, "启动时恢复了没干完的任务,批次接着跑");
            }
        });
    }
    // 空闲的其他知识库关掉(后半):停掉后台任务、放掉连接和句柄,下次访问再打开。每分钟看一次
    {
        let spaces = spaces.clone();
        let mut rx = shutdown_rx.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(60));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = ticker.tick() => {
                        let closed = spaces
                            .close_idle(std::time::Instant::now(), crate::spaces::IDLE_CLOSE_AFTER)
                            .await;
                        for space in closed {
                            tracing::info!(space = %space, "知识库空闲,已关闭(下次访问时再打开)");
                        }
                    }
                    changed = rx.changed() => {
                        if changed.is_err() || *rx.borrow() {
                            break;
                        }
                    }
                }
            }
        });
    }

    let socket = paths.socket().to_path_buf();
    let agent_socket = paths.agent_socket();
    let listen_path = paths.run_dir().join("listen");
    // 上次退出没删掉的话,夹具会在新进程改写之前读到旧端口。
    let _ = std::fs::remove_file(&listen_path);
    let addr = kb_core::config::parse_listen(&config.server.listen)?;
    // 先绑定再服务:任一监听绑不上都直接失败,不留“半个守护进程”。
    // 失败时把已经创建的 socket 文件删掉,否则测试只看到文件还在,连上去却是 Connection refused。
    let uds_listener = match kb_web::bind_uds(&socket) {
        Ok(listener) => listener,
        Err(err) => return Err(err.into()),
    };
    let agent_listener = match kb_web::bind_uds(&agent_socket) {
        Ok(listener) => listener,
        Err(err) => {
            drop(uds_listener);
            let _ = std::fs::remove_file(&socket);
            return Err(err.into());
        }
    };
    let tcp_listener = match kb_web::bind_tcp(addr).await {
        Ok(listener) => listener,
        Err(err) => {
            drop(uds_listener);
            drop(agent_listener);
            let _ = std::fs::remove_file(&socket);
            let _ = std::fs::remove_file(&agent_socket);
            return Err(err.into());
        }
    };
    let bound = match tcp_listener.local_addr() {
        Ok(bound) => bound,
        Err(err) => {
            drop(tcp_listener);
            drop(uds_listener);
            drop(agent_listener);
            let _ = std::fs::remove_file(&socket);
            let _ = std::fs::remove_file(&agent_socket);
            return Err(KbError::Internal(format!("读取监听地址失败: {err}")).into());
        }
    };
    if let Err(err) = std::fs::write(&listen_path, bound.to_string()) {
        drop(tcp_listener);
        drop(uds_listener);
        drop(agent_listener);
        let _ = std::fs::remove_file(&socket);
        let _ = std::fs::remove_file(&agent_socket);
        let _ = std::fs::remove_file(&listen_path);
        return Err(KbError::Internal(format!("写下监听地址失败: {err}")).into());
    }
    tracing::info!(socket = %socket.display(), agent = %agent_socket.display(), addr = %bound, "守护进程启动");

    // 核显 sidecar:`[accel].enabled` 时拉起两个 llama-server。
    // `SidecarPair::supervise` 里有阻塞 sleep,放到专用线程里跑,不占 tokio 线程。
    let mut sidecar_done: Option<std::sync::mpsc::Receiver<()>> = None;
    if config.accel.enabled {
        let paths_for_sidecar = paths.clone();
        let accel = config.accel.clone();
        let mut rx = shutdown_rx.clone();
        let (done_tx, done_rx) = std::sync::mpsc::channel::<()>();
        sidecar_done = Some(done_rx);
        std::thread::Builder::new()
            .name("kb-sidecar".to_owned())
            .spawn(move || {
                // `~` / `$HOME` 要展开,否则默认配置下找不到 llama-server
                let bin =
                    crate::commands::accel::expand_home(&accel.llama_dir).join("llama-server");
                // `[accel] roles` 决定起哪几路:只开重排时不放嵌入 GGUF 也能跑,
                // 嵌入照旧走进程内 fastembed
                let mut specs = Vec::new();
                if accel.role_enabled("embed") {
                    specs.push(kb_embed::SidecarSpec {
                        role: kb_embed::SidecarRole::Embedding,
                        binary: bin.clone(),
                        model: paths_for_sidecar.models_dir().join(&accel.embed_gguf),
                        port: accel.embed_port,
                        ngl: accel.ngl,
                    });
                }
                if accel.role_enabled("rerank") {
                    specs.push(kb_embed::SidecarSpec {
                        role: kb_embed::SidecarRole::Rerank,
                        binary: bin,
                        model: paths_for_sidecar.models_dir().join(&accel.rerank_gguf),
                        port: accel.rerank_port,
                        ngl: accel.ngl,
                    });
                }
                if specs.is_empty() {
                    tracing::warn!("[accel] enabled 但 roles 是空的,不起任何 sidecar");
                    return;
                }
                let mut pair = match kb_embed::SidecarPair::start(specs) {
                    Ok(pair) => pair,
                    Err(err) => {
                        tracing::warn!(error = %err, "sidecar 启动失败,继续以无加速模式运行");
                        return;
                    }
                };
                if pair.any_started() {
                    tracing::info!("sidecar 已启动");
                } else {
                    tracing::warn!(
                        "两路 sidecar 都没起来(缺可执行文件或模型),继续以无加速模式运行"
                    );
                }
                loop {
                    if *rx.borrow() {
                        tracing::info!("sidecar 收到关闭信号,正在停止");
                        pair.stop();
                        let _ = done_tx.send(());
                        return;
                    }
                    let _ = rx.borrow_and_update();
                    pair.supervise();
                    std::thread::sleep(std::time::Duration::from_secs(1));
                }
            })
            .map_err(|err| {
                let _ = std::fs::remove_file(&socket);
                let _ = std::fs::remove_file(&agent_socket);
                let _ = std::fs::remove_file(&listen_path);
                KbError::Internal(format!("启动 sidecar 线程失败: {err}"))
            })?;
    }

    // 装配到此结束:下面三个监听一起对外,所以这里是「服务可用」的时刻
    clock.mark("ready");
    let uds = tokio::spawn({
        let state = state.clone();
        let socket = socket.clone();
        let rx = shutdown_rx.clone();
        async move {
            if let Err(err) = kb_web::serve_uds_listener(
                uds_listener,
                state,
                socket,
                kb_web::SocketKind::Unix,
                rx,
            )
            .await
            {
                tracing::error!(error = %err, "UDS 服务退出");
            }
        }
    });
    let agent_uds = tokio::spawn({
        let state = state.clone();
        let socket = agent_socket.clone();
        let rx = shutdown_rx.clone();
        async move {
            if let Err(err) = kb_web::serve_uds_listener(
                agent_listener,
                state,
                socket,
                kb_web::SocketKind::Agent,
                rx,
            )
            .await
            {
                tracing::error!(error = %err, "agent.sock 服务退出");
            }
        }
    });
    backend.spawn_reaper(shutdown_rx.clone());
    let tcp = tokio::spawn({
        let state = state.clone();
        let rx = shutdown_rx.clone();
        async move {
            if let Err(err) = kb_web::serve_tcp_listener(tcp_listener, state, rx).await {
                tracing::error!(error = %err, "TCP 服务退出");
            }
        }
    });

    // 先等关闭信号(没有信号就一直服务),再给收尾 grace 秒
    // (grace 默认 30 秒,可用 KB_DAEMON_GRACE_SECS 覆盖 —— 测试用）
    let grace = std::env::var("KB_DAEMON_GRACE_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(30);
    let mut shutdown_wait = shutdown_rx.clone();
    let _ = shutdown_wait.wait_for(|value| *value).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), backend.drain_acp()).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(grace), async {
        let _ = uds.await;
        let _ = agent_uds.await;
        let _ = tcp.await;
    })
    .await;
    // 协作房间:把还没写盘的更新、没落地的内容、保存点都收尾(在 worker 之后:落地会投递重新嵌入的任务)
    let _ = tokio::time::timeout(std::time::Duration::from_secs(10), collab_hub.shutdown()).await;
    let _ = tokio::time::timeout(std::time::Duration::from_secs(grace), worker_task).await;
    for task in spaces.take_tasks().await {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(grace), task.stop()).await;
    }
    // 等 sidecar 线程把子进程停掉再退出,避免留下孤儿进程
    if let Some(done) = sidecar_done {
        match done.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(()) => tracing::info!("sidecar 已停止"),
            Err(err) => tracing::warn!(error = %err, "等待 sidecar 停止超时"),
        }
    }
    let _ = std::fs::remove_file(paths.run_dir().join("listen"));
    tracing::info!("守护进程已退出");
    Ok(ExitCode::SUCCESS)
}

/// 文件监听与项目表对账的间隔。
const FILE_WATCH_SYNC_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// 读一次项目表并让文件监听与之对齐;项目表读不出来时返回 `None`,下一轮再试。
async fn sync_file_watchers(
    registry: &kb_service::evolution::WatchRegistry,
    meta: &dyn kb_core::ports::repo::MetaStore,
) -> Option<kb_service::evolution::SyncReport> {
    match kb_core::ports::repo::ProjectRepo::list(meta).await {
        Ok(projects) => Some(registry.sync(projects).await),
        Err(err) => {
            tracing::warn!(error = %err, "读取项目列表失败,本轮文件监听不对账");
            None
        }
    }
}

/// 等到守护进程要关闭。发送端已经没了也算(没人能再通知,留着循环只会成为孤儿任务)。
async fn wait_for_stop(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|value| *value).await;
}

/// 旧的单密码部署升级:还没有人接管主知识库、而主知识库里存着旧的 `password_hash` 时,
/// 把它变成第一个管理员 `admin`(密码不变,原来的人照常登录),并让他接管主知识库。
/// 没有旧密码就什么也不做:第一个管理员由 `kb auth set-password` 创建。
async fn adopt_legacy_admin(system: &kb_meta::SystemStore, runtime: &Embedded) {
    use kb_core::account::{NewUser, ROLE_ADMIN, UserStatus};
    // 已经有人接管了主知识库就不用迁移了;哪怕账号库里已经有别的用户(例如先用 `kb user create` 建过)
    match system.get_space(kb_core::account::PRIMARY_SPACE_ID).await {
        Ok(None) => {}
        Ok(Some(_)) => return,
        Err(err) => {
            tracing::warn!(error = %err, "读取主知识库归属失败,跳过旧密码迁移");
            return;
        }
    }
    let hash =
        match kb_core::ports::repo::AuthRepo::get_setting(runtime.meta.as_ref(), "password_hash")
            .await
        {
            Ok(Some(hash)) if !hash.trim().is_empty() => hash,
            Ok(_) => return,
            Err(err) => {
                tracing::warn!(error = %err, "读取旧密码失败,跳过迁移");
                return;
            }
        };
    let created = system
        .create_user(NewUser {
            username: "admin".to_owned(),
            email: None,
            display_name: Some("管理员".to_owned()),
            password_hash: hash,
            role_id: ROLE_ADMIN.to_owned(),
            status: UserStatus::Active,
            registered_via: "migrated".to_owned(),
            must_change_password: false,
            email_verified: false,
        })
        .await;
    match created {
        Ok((user, space)) => {
            tracing::info!(user = %user.username, space = %space.id, "旧的单密码已迁移为管理员账号");
            let _ = system
                .record_audit(
                    Some(&user.id),
                    "migrate.legacy_admin",
                    Some(&space.id),
                    &serde_json::json!({}),
                    None,
                )
                .await;
        }
        Err(err) => tracing::error!(error = %err, "迁移旧密码失败"),
    }
}

/// 转到后台:重新执行自己,把输出重定向到日志文件。
fn detach(paths: &KbPaths) -> Result<ExitCode, CliError> {
    let exe = std::env::current_exe()
        .map_err(|err| KbError::Internal(format!("取当前可执行文件失败: {err}")))?;
    let log = paths.logs_dir().join("daemon.out");
    std::fs::create_dir_all(paths.logs_dir()).ok();
    let out = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log)
        .map_err(|err| KbError::Internal(format!("打开 {} 失败: {err}", log.display())))?;
    let err = out
        .try_clone()
        .map_err(|err| KbError::Internal(format!("复制日志句柄失败: {err}")))?;
    // 用 setsid 脱离调用者的进程组 / 会话,否则终端关闭(SIGHUP)会把守护进程一起带走
    let mut command = if setsid_available() {
        let mut command = std::process::Command::new("setsid");
        command.arg(exe);
        command
    } else {
        std::process::Command::new(exe)
    };
    let mut child = command
        .arg("daemon")
        .env(DETACHED_ENV, "1")
        .env("KB_HOME", paths.home())
        .env_remove("KB_PROJECT")
        .stdin(std::process::Stdio::null())
        .stdout(out)
        .stderr(err)
        .spawn()
        .map_err(|err| KbError::Internal(format!("启动后台守护进程失败: {err}")))?;
    // 等一小会儿确认它没有立刻退出(例如抢锁失败)
    std::thread::sleep(std::time::Duration::from_millis(400));
    match child.try_wait() {
        Ok(Some(status)) => {
            return Err(KbError::Unavailable(format!(
                "后台守护进程立刻退出({status});请看 {}",
                log.display()
            ))
            .into());
        }
        Ok(None) => {}
        Err(err) => {
            return Err(KbError::Internal(format!("检查后台进程状态失败: {err}")).into());
        }
    }
    println!("守护进程已在后台启动(pid {})", child.id());
    println!("日志:{}", log.display());
    Ok(ExitCode::SUCCESS)
}

/// 系统里有没有 `setsid`。
fn setsid_available() -> bool {
    std::process::Command::new("setsid")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// 收到 SIGTERM / SIGINT 时优雅关闭。
fn spawn_signal_handler(tx: watch::Sender<bool>) {
    tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};
        let Ok(mut interrupt) = signal(SignalKind::interrupt()) else {
            return;
        };
        let Ok(mut terminate) = signal(SignalKind::terminate()) else {
            return;
        };
        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
        }
        tracing::info!("收到退出信号,开始优雅关闭");
        let _ = tx.send(true);
    });
}

/// 每拍把热更新项的当前值喂给后台组件。
///
/// 抽成函数是为了能直接测调用点:`backup.set_policy` 这一行被删掉 / 读错配置段,
/// `hot_backup_policy_reaches_the_service` 会变红(此前只有一条“守护进程每拍喂策略”
/// 的注释,没有任何守卫)。
fn apply_hot_config(
    store: &kb_core::config::ConfigStore,
    scheduler: &kb_service::scheduler::Scheduler,
    backup: &kb_service::backup::BackupService,
    index: &kb_service::IndexService,
) {
    let config = store.get();
    scheduler.set_options(kb_service::scheduler::options_from(&config.schedule));
    backup.set_policy(kb_service::backup::BackupPolicy::from_config(
        &config.backup,
    ));
    index.set_options(kb_service::index::IndexOptions::from_config(&config));
}

#[cfg(all(test, feature = "testkit"))]
mod hot_config_tests {
    use std::sync::Arc;

    use super::*;

    /// 不会用到的快照端口(`apply_hot_config` 只换策略,不打包)。
    struct NoSnapshot;

    #[async_trait::async_trait]
    impl kb_service::backup::DbSnapshot for NoSnapshot {
        async fn snapshot_to(&self, _dest: &std::path::Path) -> kb_core::Result<()> {
            unreachable!("热更新不该触发备份")
        }
    }

    /// 改了 `[backup]` 之后,每拍的热更新必须真的落到备份服务上。
    #[tokio::test]
    async fn hot_backup_policy_reaches_the_service() {
        let env = kb_testkit::TestEnv::new().await;
        let paths = env.paths();
        paths.ensure_dirs().expect("建目录");
        let index = Arc::new(kb_service::IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            kb_service::IndexOptions::default(),
        ));
        let scheduler = kb_service::scheduler::Scheduler::new(
            env.meta.clone(),
            env.store.clone(),
            index.clone(),
            kb_service::scheduler::ScheduleOptions::default(),
            Arc::new(kb_service::scheduler::SystemClock),
        );
        let backup = kb_service::backup::BackupService::new(paths, Arc::new(NoSnapshot));
        let store = kb_core::config::ConfigStore::new(kb_core::config::Config::default());

        apply_hot_config(&store, &scheduler, &backup, &index);
        assert_eq!(backup.policy(), kb_service::backup::BackupPolicy::default());

        let mut next = (*store.get()).clone();
        next.backup.enabled = false;
        next.backup.interval_hours = 6;
        next.backup.keep_count = 2;
        next.backup.keep_days = 90;
        // 异地目录也是热更新项:加一个目录后下一拍就该生效
        next.backup.mirror_dirs = vec!["/mnt/offsite".to_owned()];
        store.replace(next);
        apply_hot_config(&store, &scheduler, &backup, &index);
        let policy = backup.policy();
        assert!(!policy.enabled, "enabled 应跟着配置走");
        assert_eq!(policy.interval_hours, 6);
        assert_eq!(policy.keep_count, 2);
        assert_eq!(policy.keep_days, 90);
        assert_eq!(policy.mirror_dirs, vec!["/mnt/offsite".to_owned()]);
        assert_eq!(
            backup.mirror_dirs(),
            vec![std::path::PathBuf::from("/mnt/offsite")],
            "绝对路径原样使用"
        );
    }
}

#[cfg(test)]
mod hub_observer_tests {
    use super::HubObserver;
    use kb_core::model::{Job, JobState};
    use kb_service::jobs::{JobObserver, SliceProgress};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn job(id: &str) -> Job {
        Job {
            id: id.to_owned(),
            kind: "index".to_owned(),
            collection: Some("proj_a".to_owned()),
            priority: 20,
            state: JobState::Running,
            payload_json: String::new(),
            checkpoint_json: None,
            detail: None,
            progress_done: 0,
            progress_total: Some(10),
            rate: None,
            error: None,
            created_at: 1,
            started_at: Some(2),
            finished_at: None,
        }
    }

    fn progress(done: u64, total: u64) -> SliceProgress {
        SliceProgress {
            done,
            total: Some(total),
            ..SliceProgress::default()
        }
    }

    fn drain(rx: &mut tokio::sync::broadcast::Receiver<kb_web::ServerEvent>) -> Vec<String> {
        let mut kinds = Vec::new();
        while let Ok(event) = rx.try_recv() {
            kinds.push(event.kind);
        }
        kinds
    }

    #[test]
    fn progress_is_throttled_per_job_but_completion_always_goes_out() {
        let observer = HubObserver::new(Arc::new(kb_web::EventHub::new()));
        let t0 = Instant::now();
        assert!(observer.should_publish("a", false, t0), "第一次一定推");
        assert!(!observer.should_publish("a", false, t0 + Duration::from_millis(300)));
        assert!(!observer.should_publish("a", false, t0 + Duration::from_millis(999)));
        assert!(
            observer.should_publish("b", false, t0 + Duration::from_millis(300)),
            "各任务分开算"
        );
        assert!(
            observer.should_publish("a", false, t0 + Duration::from_millis(1_000)),
            "隔满 1 秒再推"
        );
        assert!(
            observer.should_publish("a", true, t0 + Duration::from_millis(1_001)),
            "做完了不受限频"
        );
    }

    #[test]
    fn rapid_slices_publish_once_then_the_final_one_and_finish_resets() {
        let hub = Arc::new(kb_web::EventHub::new());
        let mut rx = hub.subscribe();
        let observer = HubObserver::new(hub);
        let running = job("j1");
        for done in 1..=9 {
            observer.on_progress(&running, &progress(done, 10));
        }
        assert_eq!(drain(&mut rx), ["job.progress"], "连续 9 个分片只推第一个");
        observer.on_progress(&running, &progress(10, 10));
        assert_eq!(drain(&mut rx), ["job.progress"], "做完那一次一定推");
        observer.on_finish(&running);
        assert_eq!(drain(&mut rx), ["job.done"]);
        // 结束后记录清掉:同一个任务再跑起来时第一次进度立刻推
        observer.on_progress(&running, &progress(1, 10));
        assert_eq!(drain(&mut rx), ["job.progress"]);
    }
}
