//! 嵌入式运行时:在 CLI 进程内组装具体适配器（设计规范）。
//!
//! 守护进程之前没有常驻进程,所以 CLI 总是嵌入式模式;写操作要先拿到 `run/daemon.lock`,
//! 保证 LanceDB 只有一个写者。

use std::sync::Arc;

use kb_core::KbError;
use kb_core::config::{Config, ConfigStore};
use kb_core::paths::KbPaths;
use kb_core::ports::{Chunker, Embedder, Scanner};
use kb_embed::{LoadOptions, ModelKind, spawn_fastembedder};
use kb_index::chunk::{ChunkOptions, DefaultChunker};
use kb_index::scan::FsScanner;
use kb_meta::SqliteMetaStore;
use kb_service::{CollectionService, IndexOptions, IndexService, JobQueue, ProjectService};
use kb_store_lance::LanceStore;

use crate::error::CliError;

/// 嵌入式运行时。
pub struct Embedded {
    /// SQLite 元数据。
    pub meta: Arc<SqliteMetaStore>,
    /// LanceDB。
    pub store: Arc<LanceStore>,
    /// 嵌入器。
    pub embedder: Arc<dyn Embedder>,
    /// 分块器。
    pub chunker: Arc<dyn Chunker>,
    /// 扫描器。
    pub scanner: Arc<dyn Scanner>,
    /// 全局配置。
    pub config: Arc<ConfigStore>,
    /// 数据目录。
    pub paths: KbPaths,
    /// 写锁(写操作用,进程内持有)。
    _lock: Option<std::fs::File>,
    /// 批次进度与 ETA 的平滑 / 节流状态。每个知识库一份,和它的解析任务共用同一个实例。
    pub tracker: Arc<kb_service::ProgressTracker>,
    /// 查询向量缓存(L3 后半):每个知识库一份,不跨用户共享;知识库被关掉时跟着释放。
    pub query_cache: Arc<kb_service::search::QueryVectorCache>,
    /// 检索并发闸门:**所有知识库共用一份**——限额是按整机 CPU 算的,不是按知识库。
    pub search_gate: Arc<kb_service::search::SearchGate>,
    /// 待补向量队列的 2 秒缓存:每个知识库一份,key 含知识库 id。
    pub pending_cache: Arc<kb_service::search::PendingExistsCache>,
    /// collection 写闸门:索引写路径与迁移收尾共享同一个实例。
    gate: kb_service::WriteGate,
    /// 声明式 skills:守护进程启动时扫描 `~/.kb/skills`,可经 `reload_skills` 重扫。
    ///
    /// 用 `Arc<RwLock<..>>` 与索引服务**共享同一个句柄**:重扫后后台索引任务下一个文件就按新规则走。
    skills: Arc<std::sync::RwLock<Arc<kb_service::SkillRegistry>>>,
}

impl Embedded {
    /// 打开嵌入式运行时;`write = true` 时先抢 `run/daemon.lock`。
    pub async fn open(
        paths: &KbPaths,
        config: &Config,
        write: bool,
    ) -> std::result::Result<Self, CliError> {
        let store = Arc::new(ConfigStore::new(config.clone()));
        Self::open_with_config_store(paths, store, write).await
    }

    /// 用已有的配置存储打开(守护进程用:配置热重载要改的就是这一份)。
    pub async fn open_with_config_store(
        paths: &KbPaths,
        store: Arc<ConfigStore>,
        write: bool,
    ) -> std::result::Result<Self, CliError> {
        let config_store = store;
        let snapshot = config_store.get();
        let config = snapshot.as_ref();
        let lock = if write {
            Some(acquire_write_lock(paths).await?)
        } else {
            None
        };
        let meta = Arc::new(SqliteMetaStore::open_with_pool(
            paths.meta_db(),
            config.meta.read_pool,
        )?);
        let store =
            Arc::new(LanceStore::connect(paths.lance_dir().to_string_lossy().to_string()).await?);
        let embedder = build_embedder(paths, config).await?;
        let chunker: Arc<dyn Chunker> = Arc::new(DefaultChunker::new(ChunkOptions::from_config(
            &config.index,
            &config.embed,
        )));
        let scanner: Arc<dyn Scanner> = Arc::new(FsScanner);
        let skills = Arc::new(load_skills(paths, config));
        let tracker = Arc::new(kb_service::ProgressTracker::new(
            meta.clone(),
            crate::capability_backend::embed_backend_badge(config),
        ));
        Ok(Self {
            meta,
            store,
            embedder,
            chunker,
            scanner,
            // 容量与 TTL 每拍从配置存储现读:`search.query_cache_entries` 是热更新项
            query_cache: Arc::new(kb_service::search::QueryVectorCache::following(
                config_store.clone(),
            )),
            // 并发上限同样现读 `search.max_concurrency`
            search_gate: Arc::new(kb_service::search::SearchGate::following(
                config_store.clone(),
            )),
            pending_cache: Arc::new(kb_service::search::PendingExistsCache::new(
                kb_core::account::PRIMARY_SPACE_ID,
            )),
            config: config_store,
            paths: paths.clone(),
            _lock: lock,
            tracker,
            gate: kb_service::WriteGate::new(),
            skills: Arc::new(std::sync::RwLock::new(skills)),
        })
    }

    /// 在同一个进程里再打开一个知识库(多用户):共用嵌入器、分块器、扫描器、配置和 skills,
    /// 单独打开这个知识库自己的 `meta.db` 与向量库;写闸门、进度计算器每个知识库一份。
    ///
    /// `space_paths` 来自 `KbPaths::for_space`:只有 meta / lance / sources / uploads 指向知识库目录,
    /// 其余(配置、模型、socket……)仍是全局的。不拿 `daemon.lock`,锁由主运行时持有。
    pub async fn open_space(
        &self,
        space_id: &str,
        space_paths: KbPaths,
    ) -> std::result::Result<Self, CliError> {
        let config = self.config.get();
        for dir in [
            space_paths.meta_db().parent(),
            Some(space_paths.lance_dir()),
            Some(space_paths.sources_dir()),
            Some(space_paths.uploads_dir()),
        ]
        .into_iter()
        .flatten()
        {
            std::fs::create_dir_all(dir).map_err(|err| {
                KbError::Internal(format!("创建知识库目录 {} 失败: {err}", dir.display()))
            })?;
        }
        // 非主知识库的读连接池开小一点:知识库多的时候别把文件句柄吃光
        let meta = Arc::new(SqliteMetaStore::open_with_pool(
            space_paths.meta_db(),
            config.meta.read_pool.min(2),
        )?);
        let store = Arc::new(
            LanceStore::connect(space_paths.lance_dir().to_string_lossy().to_string()).await?,
        );
        let tracker = Arc::new(kb_service::ProgressTracker::new(
            meta.clone(),
            crate::capability_backend::embed_backend_badge(&config),
        ));
        Ok(Self {
            meta,
            store,
            embedder: self.embedder.clone(),
            chunker: self.chunker.clone(),
            scanner: self.scanner.clone(),
            config: self.config.clone(),
            paths: space_paths,
            _lock: None,
            tracker,
            // 每个知识库一份,不跨用户共享(见 QueryVectorCache)
            query_cache: Arc::new(kb_service::search::QueryVectorCache::following(
                self.config.clone(),
            )),
            // 闸门共用:限额是整机 CPU 的,不是单个知识库的
            search_gate: self.search_gate.clone(),
            // 队列缓存按知识库隔离:同名 collection 在不同知识库里是两份数据
            pending_cache: Arc::new(kb_service::search::PendingExistsCache::new(
                space_id.to_owned(),
            )),
            gate: kb_service::WriteGate::new(),
            skills: self.skills.clone(),
        })
    }

    /// 当前配置的快照。
    pub fn config(&self) -> Arc<Config> {
        self.config.get()
    }

    /// 项目服务。
    pub fn projects(&self) -> ProjectService {
        ProjectService::new(self.meta.clone(), self.store.clone(), self.embedder.clone())
    }

    /// Collection 服务。
    pub fn collections(&self) -> CollectionService {
        CollectionService::new(self.meta.clone(), self.store.clone(), self.embedder.clone())
    }

    /// 索引服务。
    pub fn index_service(&self) -> IndexService {
        let index = IndexService::new(
            self.meta.clone(),
            self.store.clone(),
            self.embedder.clone(),
            self.chunker.clone(),
            self.scanner.clone(),
            IndexOptions::from_config(&self.config()),
        )
        .with_write_gate(self.gate.clone())
        .with_shared_skills(self.skills.clone());
        // 旧格式 Office 转换器(没开 / 没装就是 `None`):装了,项目目录里的 .doc / .xls / .ods 才会被
        // 转换后抽取。守护进程的后台索引和嵌入式 `kb index` 都从这里拿索引服务,所以两边行为一致
        match crate::bundle::shared_converter(&self.config(), &self.paths) {
            Some(converter) => index.with_converter(converter),
            None => index,
        }
    }

    /// 当前 skills 快照。
    pub fn skills(&self) -> Arc<kb_service::SkillRegistry> {
        self.skills
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// 重新扫描 skills 目录;返回新的 registry,调用方负责把 warning 报出去。
    pub fn reload_skills(&self) -> Arc<kb_service::SkillRegistry> {
        let next = Arc::new(load_skills(&self.paths, &self.config()));
        *self
            .skills
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = next.clone();
        next
    }

    /// collection 写闸门(迁移服务要用同一个实例)。
    pub fn write_gate(&self) -> kb_service::WriteGate {
        self.gate.clone()
    }

    /// 向量存储(检索服务用)。
    pub fn store(&self) -> Arc<dyn kb_core::ports::VectorStore> {
        self.store.clone()
    }

    /// 任务队列。
    pub fn queue(&self) -> JobQueue {
        JobQueue::new(self.meta.clone())
    }

    /// 从备份恢复后的自愈:向量表缺了就补一张空表,并把经验条目重新投递嵌入。
    ///
    /// 平时(表都在)只是每个集合一次 `count`,几乎没有成本。项目文件的向量补不回来
    /// (要读原件),只能提示用户跑 `kb index <项目> --full`。
    pub async fn heal_restored_tables(&self) {
        let healed = match self.collections().heal_tables().await {
            Ok(healed) => healed,
            Err(err) => {
                tracing::warn!(error = %err, "检查向量表失败(检索可能报表不存在)");
                return;
            }
        };
        if healed.is_empty() {
            return;
        }
        let items = kb_service::items::ItemService::new(
            self.meta.clone(),
            self.store.clone(),
            self.embedder.clone(),
        );
        for collection in healed {
            match items.reindex_collection(&collection.name).await {
                Ok(queued) => tracing::warn!(
                    collection = %collection.name,
                    queued,
                    "向量表缺失(多半是从备份恢复),已补空表并重新投递 {queued} 条经验条目的嵌入"
                ),
                Err(err) => tracing::warn!(
                    collection = %collection.name,
                    error = %err,
                    "重新投递经验条目失败"
                ),
            }
            if collection.project_id.is_some() {
                tracing::warn!(
                    collection = %collection.name,
                    "项目文件的向量需要重建:kb index <项目名> --full"
                );
            }
        }
    }
}

/// 抢 `run/daemon.lock`;拿不到说明守护进程正在运行。
///
/// 刚被 `kill -9` 的进程,内核回收 `flock` 与本进程重试之间可能有极短的空隙:
/// 这里最多重试 2 秒(每 100 ms 一次),避免把偶发的 `exit=3` 甩给用户。
async fn acquire_write_lock(paths: &KbPaths) -> std::result::Result<std::fs::File, CliError> {
    paths.ensure_private_dirs()?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(paths.lock_file())
        .map_err(|err| {
            KbError::Internal(format!(
                "打开锁文件 {} 失败: {err}",
                paths.lock_file().display()
            ))
        })?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(_) if std::time::Instant::now() < deadline => {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            Err(_) => return Err(CliError::DaemonRunning),
        }
    }
}

/// 测试用的假嵌入器(只在 testkit feature 下可用)。
#[cfg(feature = "testkit")]
fn fake_embedder() -> std::result::Result<Arc<dyn Embedder>, CliError> {
    Ok(Arc::new(kb_embed::FakeEmbedder::new(8)))
}

/// 没开 testkit feature 时的占位实现。
#[cfg(not(feature = "testkit"))]
fn fake_embedder() -> std::result::Result<Arc<dyn Embedder>, CliError> {
    Err(
        KbError::InvalidInput("embed.backend = \"fake\" 只在 testkit feature 下可用".to_owned())
            .into(),
    )
}

impl Embedded {
    /// 触发模型加载(惰性加载的嵌入器在第一次请求前 `state` 是 `Unloaded`)。
    ///
    /// 只有真正需要向量的命令(search / eval / index)才调用它,避免 `project list`
    /// 这类命令白白等一次模型加载。
    pub async fn warm_embedder(
        &self,
        timeout: std::time::Duration,
    ) -> std::result::Result<(), CliError> {
        if matches!(self.embedder.state(), kb_core::model::EmbedderState::Ready) {
            return Ok(());
        }
        let started = std::time::Instant::now();
        match tokio::time::timeout(timeout, self.embedder.embed_query("kb warm up".to_owned()))
            .await
        {
            Ok(Ok(_)) => {
                tracing::debug!(elapsed = ?started.elapsed(), "嵌入模型已就绪");
                Ok(())
            }
            Ok(Err(err)) => Err(err.into()),
            Err(_) => Err(KbError::Unavailable(format!(
                "嵌入模型在 {} 秒内没有加载完成",
                timeout.as_secs()
            ))
            .into()),
        }
    }
}

async fn build_embedder(
    paths: &KbPaths,
    config: &Config,
) -> std::result::Result<Arc<dyn Embedder>, CliError> {
    match config.embed.backend.as_str() {
        "fastembed" => {
            let kind = ModelKind::from_name(&config.embed.model)?;
            let options =
                LoadOptions::from_config(&config.embed, Some(paths.models_dir().to_path_buf()));
            let idle = (config.embed.idle_unload_minutes > 0)
                .then(|| std::time::Duration::from_secs(config.embed.idle_unload_minutes * 60));
            let embedder = spawn_fastembedder(kind, options, idle)?;
            Ok(Arc::new(embedder))
        }
        "fake" => fake_embedder(),
        #[cfg(feature = "testkit")]
        "fake-lazy" => Ok(Arc::new(kb_embed::LazyFakeEmbedder::new(8))),
        #[cfg(feature = "testkit")]
        "fake-failing" => Ok(Arc::new(kb_embed::FailingEmbedder)),
        #[cfg(not(feature = "testkit"))]
        "fake-lazy" | "fake-failing" => Err(KbError::InvalidInput(format!(
            "embed.backend = \"{}\" 只在 testkit feature 下可用",
            config.embed.backend
        ))
        .into()),
        // :调 OpenAI 兼容端点(默认就是本机 sidecar)
        "http" => {
            let embedder = Arc::new(kb_embed::HttpEmbedder::new(
                config.embed.http.url.clone(),
                config.embed.http.model.clone(),
                config.embed.http.dim,
            ));
            // 失败后要能自愈:每 10 秒探活一次,每个进程只起一个任务
            static PROBE: std::sync::Once = std::sync::Once::new();
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let probe = embedder.clone();
                PROBE.call_once(move || {
                    handle.spawn(async move {
                        loop {
                            probe.healthy().await;
                            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                        }
                    });
                });
            }
            Ok(embedder)
        }
        other => Err(KbError::InvalidInput(format!("未知的 embed.backend: {other}")).into()),
    }
}

/// 重排 sidecar 的地址:`[rerank] url` 说了算,留空才退回 `[accel] rerank_port`。
///
/// 以前只认 `accel.rerank_port`,`[rerank] url` 除了在“模型/供应商”页显示之外毫无作用 ——
/// 2026-11-07 生产上想把它挪到 18083 避开别的项目的脚本,改完 url 完全没反应,
/// 还得去改 `[accel]` 里那个字面意思完全不同的端口。地址只有一个真源。
fn rerank_base_url(config: &Config) -> String {
    let url = config.rerank.url.trim();
    if url.is_empty() {
        return format!("http://127.0.0.1:{}", config.accel.rerank_port);
    }
    // `HttpReranker` 自己会剥掉 `/v1/rerank`,这里原样传即可
    url.to_owned()
}

/// 按 `[rerank]` 配置构造重排器。
///
/// `auto`:sidecar 健康才启用(不可用时 `available` 为 false,检索自动跳过重排并标记 degraded);
/// `on`:强制启用;`off`:不重排。
pub fn build_reranker(config: &Config) -> Arc<dyn kb_core::ports::Reranker> {
    // 每个进程只建一个重排器实例并复用它:
    // 之前每次调用都新建一个初值不可用的实例,而探活只服务第一个,导致只有第一次检索会重排。
    type Cached = std::sync::Mutex<Option<(String, Arc<dyn kb_core::ports::Reranker>)>>;
    static SHARED: std::sync::OnceLock<Cached> = std::sync::OnceLock::new();
    let key = format!(
        "{}|{}|{}",
        config.rerank.mode,
        rerank_base_url(config),
        config.accel.rerank_gguf
    );
    let cache = SHARED.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(guard) = cache.lock()
        && let Some((cached_key, reranker)) = guard.as_ref()
        && cached_key == &key
    {
        return reranker.clone();
    }
    let reranker = build_reranker_uncached(config);
    if let Ok(mut guard) = cache.lock() {
        *guard = Some((key, reranker.clone()));
    }
    reranker
}

fn build_reranker_uncached(config: &Config) -> Arc<dyn kb_core::ports::Reranker> {
    let url = rerank_base_url(config);
    let model = config.accel.rerank_gguf.clone();
    match config.rerank.mode.as_str() {
        "off" => Arc::new(kb_service::search::NoopReranker),
        // `on`:强制重排,失败时按设计规范标记 degraded
        "on" => Arc::new(kb_embed::HttpReranker::new(url, model)),
        // `auto`:sidecar 可用才重排;初始不可用,由后台探活翻转,不可用时**不**标记 degraded
        _ => {
            let reranker = Arc::new(kb_embed::HttpReranker::new_auto(url, model));
            // 探活任务**跟着实例走**:`rerank.mode` 是热更新项,
            // 来回切换会换出新的 `auto` 实例;以前用进程级 `Once` 只探第一个实例,
            // 切回 `auto` 后新实例永远没人探活,重排被静默跳过。
            // 这里持 `Weak`:实例被换掉(缓存替换)后探活任务自己退出,不会越积越多。
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                let probe = Arc::downgrade(&reranker);
                handle.spawn(async move {
                    loop {
                        let Some(reranker) = probe.upgrade() else {
                            break;
                        };
                        reranker.refresh_health().await;
                        drop(reranker);
                        tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                    }
                });
            }
            reranker
        }
    }
}

/// 扫描 `~/.kb/skills`。
///
/// 坏 skill 只记 warning,不影响启动;`skills.allow_exec = false`(默认)时只加载声明式部分,
/// 插件的进程钩子被停用并在 warning 里说明。bwrap 不可用时默认连钩子也不启动,
/// 除非管理员显式打开 `skills.allow_unsandboxed`。
fn load_skills(paths: &KbPaths, config: &Config) -> kb_service::SkillRegistry {
    let registry = kb_service::SkillRegistry::load_with_options(
        paths.skills_dir(),
        config.skills.allow_exec,
        config.skills.allow_unsandboxed,
    );
    for warning in registry.warnings() {
        tracing::warn!(warning = %warning, "skills 加载告警");
    }
    if !registry.loader_rules().is_empty()
        || registry.plugin_count() > 0
        || registry.prompt(kb_service::PromptStage::Extract).is_some()
    {
        tracing::info!(
            loader_rules = registry.loader_rules().len(),
            plugins = registry.plugin_count(),
            source_rules = registry.source_rule_count(),
            templates = registry.templates().len(),
            dir = %paths.skills_dir().display(),
            "已加载声明式 skills / 插件"
        );
    }
    registry
}

/// 从 `<KB_HOME>/secrets.toml` 读 LLM API key(没有就返回 `None`)。
///
/// 文件形如:
/// ```toml
/// [llm]
/// api_key = "sk-..."
/// ```
pub fn llm_api_key(paths: &kb_core::paths::KbPaths) -> Option<String> {
    let text = std::fs::read_to_string(paths.secrets_file()).ok()?;
    let value: toml::Value = toml::from_str(&text).ok()?;
    value
        .get("llm")
        .and_then(|llm| llm.get("api_key"))
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

/// 改 `secrets.toml` 里 `[section] key` 这一项(`None` = 删除),保留文件里的其它内容。
///
/// 先写 0600 的临时文件再 rename:不会留下半截文件,也不给别的用户读到密钥的窗口。
pub fn write_secret(
    path: &std::path::Path,
    section: &str,
    key: &str,
    value: Option<&str>,
) -> kb_core::Result<()> {
    use kb_core::KbError;
    let mut doc: toml::Value = match std::fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => toml::from_str(&text)
            .map_err(|err| KbError::InvalidInput(format!("解析 {} 失败: {err}", path.display())))?,
        _ => toml::Value::Table(toml::Table::new()),
    };
    let table = doc
        .as_table_mut()
        .ok_or_else(|| KbError::Internal(format!("{} 顶层必须是表", path.display())))?;
    let entry = table
        .entry(section)
        .or_insert_with(|| toml::Value::Table(toml::Table::new()));
    let entry = entry
        .as_table_mut()
        .ok_or_else(|| KbError::Internal(format!("{} 的 [{section}] 必须是表", path.display())))?;
    match value {
        Some(text) => {
            entry.insert(key.to_owned(), toml::Value::String(text.to_owned()));
        }
        None => {
            entry.remove(key);
        }
    }
    if entry.is_empty() {
        table.remove(section);
    }
    let text = toml::to_string(&doc)
        .map_err(|err| KbError::Internal(format!("序列化 secrets 失败: {err}")))?;
    let temp = path.with_extension("toml.tmp");
    std::fs::write(&temp, text)
        .map_err(|err| KbError::Internal(format!("写 {} 失败: {err}", temp.display())))?;
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))
            .map_err(|err| KbError::Internal(format!("设置 {} 权限失败: {err}", temp.display())))?;
    }
    std::fs::rename(&temp, path)
        .map_err(|err| KbError::Internal(format!("替换 {} 失败: {err}", path.display())))?;
    Ok(())
}

/// 发件邮箱的授权码,从 `secrets.toml` 读:
///
/// ```toml
/// [mail]
/// primary_password = "..."
/// backup_password = "..."
/// ```
///
/// 每次现读(文件很小),管理员在页面上改了授权码立刻生效,不用重启。
pub fn mail_passwords(paths: &kb_core::paths::KbPaths) -> kb_mail::Passwords {
    let read = |key: &str| -> String {
        std::fs::read_to_string(paths.secrets_file())
            .ok()
            .and_then(|text| toml::from_str::<toml::Value>(&text).ok())
            .and_then(|value| {
                value
                    .get("mail")
                    .and_then(|mail| mail.get(key))
                    .and_then(toml::Value::as_str)
                    .map(|text| text.trim().to_owned())
            })
            .unwrap_or_default()
    };
    kb_mail::Passwords {
        primary: read("primary_password"),
        backup: read("backup_password"),
    }
}

/// 备份用的数据库快照:走 kb-meta 的 `VACUUM INTO`(一致性快照,不用停服)。
///
/// 守护进程 / 嵌入式命令复用已经打开的连接;`kb backup` 只打开元数据库
/// (备份不需要 LanceDB 与嵌入模型)。
pub struct MetaDbSnapshot {
    store: Arc<SqliteMetaStore>,
}

impl MetaDbSnapshot {
    /// 用已经打开的元数据库构造。
    pub fn new(store: Arc<SqliteMetaStore>) -> Self {
        Self { store }
    }

    /// 单独打开一份元数据库(CLI 的 `kb backup` 用)。
    pub fn open(paths: &KbPaths, config: &Config) -> std::result::Result<Self, CliError> {
        let store = SqliteMetaStore::open_with_pool(paths.meta_db(), config.meta.read_pool)?;
        Ok(Self::new(Arc::new(store)))
    }
}

#[async_trait::async_trait]
impl kb_service::backup::DbSnapshot for MetaDbSnapshot {
    async fn snapshot_to(&self, dest: &std::path::Path) -> kb_core::Result<()> {
        self.store.snapshot_to(dest).await
    }
}

/// 给账号库和各用户知识库的元数据库做一致性快照(多用户备份用):另开连接 `VACUUM INTO`,
/// 守护进程正在写也没关系。
pub struct MetaFileSnapshotter;

impl kb_service::backup::SqliteSnapshotter for MetaFileSnapshotter {
    fn snapshot(&self, src: &std::path::Path, dst: &std::path::Path) -> kb_core::Result<()> {
        kb_meta::snapshot_file(src, dst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// 计数假 rerank 服务:回 `/health` 200、`/v1/rerank` 固定结果,并统计调用次数。
    async fn fake_rerank() -> (u16, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定");
        let port = listener.local_addr().expect("地址").port();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    break;
                };
                let hits = counter.clone();
                tokio::spawn(async move {
                    let mut buffer = vec![0u8; 8192];
                    let read = stream.read(&mut buffer).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    let body = if request.contains("/v1/rerank") {
                        hits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        r#"{"results":[{"index":0,"relevance_score":0.5}]}"#.to_owned()
                    } else {
                        "{}".to_owned()
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes()).await;
                });
            }
        });
        (port, hits)
    }

    /// 等到重排器被探活翻成可用(最多 2 秒)。
    async fn wait_available(reranker: &dyn kb_core::ports::Reranker) {
        for _ in 0..40 {
            if reranker.available() {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("重排器一直没有被探活翻成可用");
    }

    /// 把重排地址指到假服务。
    ///
    /// 2026-11-07 起 `[rerank] url` 优先于 `[accel] rerank_port`（卡 D，地址只有一个真源，
    /// 见 `rerank_base_url`），而 `RerankConfig::default` 的 url 是非空的 18082，
    /// 所以只改 `accel.rerank_port` 的用例会去打真实 18082、等不到探活就超时。
    fn point_rerank_at(config: &mut Config, port: u16) {
        config.rerank.url = format!("http://127.0.0.1:{port}");
    }

    #[tokio::test]
    async fn switching_rerank_mode_back_to_auto_still_probes_the_new_instance() {
        // 质量检查:auto → off → auto 会换出新实例;
        // 以前探活用进程级 `Once` 只服务第一个实例,切回来以后没人探活,重排被静默跳过。
        let (port, _hits) = fake_rerank().await;
        let mut config = Config::default();
        point_rerank_at(&mut config, port);
        config.rerank.mode = "auto".to_owned();
        let first = build_reranker(&config);
        wait_available(first.as_ref()).await;

        config.rerank.mode = "off".to_owned();
        let off = build_reranker(&config);
        assert!(!off.available(), "off 模式不重排");

        config.rerank.mode = "auto".to_owned();
        let again = build_reranker(&config);
        assert!(
            !std::sync::Arc::ptr_eq(&first, &again),
            "切回 auto 应换新实例"
        );
        wait_available(again.as_ref()).await;
    }

    #[tokio::test]
    async fn write_lock_reports_daemon_running_after_the_retry_window() {
        // :锁被占住时要重试一段时间再报错,并把耗时交代清楚
        let home = tempfile::tempdir().expect("临时 KB_HOME");
        let paths = KbPaths::from_home(home.path());
        paths.ensure_private_dirs().expect("建目录");
        let held = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(paths.lock_file())
            .expect("打开锁文件");
        held.try_lock().expect("先占住锁");
        let started = std::time::Instant::now();
        let err = acquire_write_lock(&paths)
            .await
            .expect_err("应报守护进程在运行");
        assert!(matches!(err, CliError::DaemonRunning), "错误类型:{err:?}");
        assert!(
            started.elapsed() >= std::time::Duration::from_secs(2),
            "应重试约 2 秒再放弃,实际 {:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn write_lock_retries_until_the_previous_holder_exits() {
        // 刚被 kill -9 的进程释放 flock 与本进程重试之间的空隙,靠重试吃掉
        let home = tempfile::tempdir().expect("临时 KB_HOME");
        let paths = KbPaths::from_home(home.path());
        paths.ensure_private_dirs().expect("建目录");
        let held = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(paths.lock_file())
            .expect("打开锁文件");
        held.try_lock().expect("先占住锁");
        let releaser = tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            drop(held);
        });
        let file = acquire_write_lock(&paths)
            .await
            .expect("持有者退出后应拿到锁");
        file.try_lock().expect("拿到锁后应能再次加锁校验");
        releaser.await.expect("释放任务");
    }

    #[test]
    fn skills_are_loaded_from_the_configured_home() {
        // 插件要能从 `<KB_HOME>/skills` 被组装根读出来;这里不启动进程,只验证声明式部分。
        let temp = tempfile::tempdir().expect("临时目录");
        let paths = kb_core::paths::KbPaths::from_home(temp.path());
        let plugin_dir = paths.skills_dir().join("vue");
        std::fs::create_dir_all(&plugin_dir).expect("建插件目录");
        std::fs::write(
            plugin_dir.join("manifest.toml"),
            r#"
type = "plugin"
name = "vue"
[index]
include = ["**/*.vue"]
lang = "vue"
tags = ["frontend"]
"#,
        )
        .expect("写清单");
        let config = kb_core::config::Config::default();
        let registry = load_skills(&paths, &config);
        assert!(registry.warnings().is_empty(), "{:?}", registry.warnings());
        assert_eq!(registry.plugin_count(), 1);
        assert_eq!(
            registry
                .match_plugins("demo", "src/App.vue")
                .lang
                .as_deref(),
            Some("vue")
        );
    }

    #[tokio::test]
    async fn build_reranker_reuses_one_instance_per_config() {
        // 每次调用都新建实例会让探活只服务第一个,
        // 只有第一次检索会重排;这里断言同一个配置拿到的是同一个实例。
        let (port, _hits) = fake_rerank().await;
        let mut config = kb_core::config::Config::default();
        config.rerank.mode = "auto".to_owned();
        point_rerank_at(&mut config, port);
        let first = build_reranker(&config);
        let second = build_reranker(&config);
        assert!(
            std::sync::Arc::ptr_eq(&first, &second),
            "同一配置应复用同一个重排器实例"
        );
    }

    #[test]
    fn rerank_url_wins_over_the_accel_port() {
        // `[rerank] url` 是用户能改的地址,`[accel] rerank_port` 是托管 sidecar 的端口;
        // 两者不一致时按 url 连(否则改 url 完全没效果)
        let mut config = kb_core::config::Config::default();
        config.accel.rerank_port = 18082;
        assert_eq!(
            rerank_base_url(&config),
            "http://127.0.0.1:18082/v1/rerank",
            "默认配置两边一致"
        );
        config.rerank.url = "http://127.0.0.1:18083/v1/rerank".to_owned();
        assert_eq!(rerank_base_url(&config), "http://127.0.0.1:18083/v1/rerank");
        // 留空才退回托管端口
        config.rerank.url = String::new();
        assert_eq!(rerank_base_url(&config), "http://127.0.0.1:18082");
    }

    #[tokio::test]
    async fn each_rerank_call_hits_the_sidecar() {
        // (a):N 次重排 → N 次 /v1/rerank
        let (port, hits) = fake_rerank().await;
        let reranker =
            kb_embed::HttpReranker::new_auto(format!("http://127.0.0.1:{port}"), "fake-rerank");
        use kb_core::ports::Reranker;
        assert!(reranker.refresh_health().await, "假服务应健康");
        for _ in 0..3 {
            let scores = reranker
                .rerank("q", &["doc".to_owned()])
                .await
                .expect("重排");
            assert_eq!(scores.len(), 1);
        }
        assert_eq!(
            hits.load(std::sync::atomic::Ordering::SeqCst),
            3,
            "3 次重排应产生 3 次 /v1/rerank 调用"
        );
    }
}
