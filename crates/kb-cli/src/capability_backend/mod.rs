//! 能力后端的 `kb-cli` 实现:把 16 个能力接到 `kb-service`(唯一组装根,设计规范)。

mod acp;
mod acp_registry;
mod agent;
mod backup;
mod doc_agent;
mod docs;
mod files;
mod files_ops;
mod jobs;
mod links;
mod providers;
mod search;
mod system;
mod trait_impl;
mod uploads;

#[allow(unused_imports)]
pub(crate) use self::acp::*;
#[allow(unused_imports)]
pub(crate) use self::acp_registry::*;
#[allow(unused_imports)]
pub(crate) use self::agent::*;
#[allow(unused_imports)]
pub(crate) use self::backup::*;
#[allow(unused_imports)]
pub(crate) use self::doc_agent::*;
#[allow(unused_imports)]
pub(crate) use self::docs::*;
#[allow(unused_imports)]
pub(crate) use self::files::*;
#[allow(unused_imports)]
pub(crate) use self::files_ops::*;
#[allow(unused_imports)]
pub(crate) use self::jobs::*;
#[allow(unused_imports)]
pub(crate) use self::links::*;
#[allow(unused_imports)]
pub(crate) use self::providers::*;
#[allow(unused_imports)]
pub(crate) use self::search::*;
#[allow(unused_imports)]
pub(crate) use self::system::*;
#[allow(unused_imports)]
pub(crate) use self::uploads::*;

pub(crate) use std::sync::Arc;

pub(crate) use async_trait::async_trait;
pub(crate) use kb_capability::defs::MaintainIndexesArgs;
pub(crate) use kb_capability::defs::{
    AcpAgentIdArgs, AcpCancelArgs, AcpChatArgs, AcpDefaultArgs, AcpPermissionArgs,
    AcpPermissionDecisionArgs, AcpSandboxArgs, AcpSaveAgentArgs, AddAnnotationArgs, AddProjectArgs,
    AddSourceArgs, AgentCompressArgs, AgentConfirmArgs, AgentDeleteSessionArgs, AgentHistoryArgs,
    AgentPinSessionArgs, AgentRenameSessionArgs, AgentSendArgs, AgentSessionsArgs, AiWriteArgs,
    ApplyContextArgs, AuditListArgs, BackupCreateArgs, BackupDeleteArgs, BackupPruneArgs,
    BackupVerifyArgs, BatchArgs, BatchIdArgs, BatchTagArgs, CheckLinksArgs, CollectionArgs,
    ConsolidateArgs, ContextEstimateArgs, ConvertMarkdownArgs, CreateItemArgs, CreateTokenArgs,
    CsvEditArgs, CsvEditOp, CsvReadArgs, DedupArgs, DeepSearchArgs, DeleteFileArgs,
    DeleteFolderArgs, DocLinksArgs, EditItemArgs, EvalHistoryArgs, EvalRunArgs, FeedbackArgs,
    FileActionsArgs, FileOpIdArgs, FilePreviewArgs, FileRawArgs, FileVersionArgs, FileVersionsArgs,
    GetItemArgs, HooksArgs, ImportGlobalArgs, IngestIdsArgs, ItemFacetsArgs, ItemIdArgs,
    JobFilesArgs, JobIdArgs, JobListArgs, LinkTarget, ListAnnotationsArgs, ListDraftsArgs,
    ListFilesArgs, ListIngestArgs, ListItemsArgs, ListTrashArgs, MigrateArgs, MoveFileArgs,
    MoveFilesArgs, MoveFolderArgs, PageArgs, ProjectNameArgs, ProviderArgs, QualityReportArgs,
    RefreshSourcesArgs, ReindexArgs, RestoreVersionArgs, RetryStageArgs, ReviewDraftArgs,
    SaveFileArgs, SaveInsightArgs, SearchArgs, SetLlmKeyArgs, SetOcrBackendArgs, SetStatusArgs,
    SupersedeArgs, TestLlmArgs, TokenIdArgs, TrashIdArgs, TuneRetrievalArgs, UpdateConfigArgs,
    UpdateProjectArgs, UpdateSourceArgs,
};
pub(crate) use kb_capability::invoke::CallCtx;
pub(crate) use kb_capability::{
    AgentBackend, DocsBackend, FilesBackend, JobsBackend, OpsBackend, SearchBackend, SkillsBackend,
    SourcesBackend,
};
pub(crate) use kb_core::model::{AgentMessage, ItemStatus, JobState, SourceKind};
pub(crate) use kb_core::ports::VectorStore;
pub(crate) use kb_core::ports::repo::{
    AgentRepo, ChunkRepo, CollectionRepo, DocLinkRepo, FileRepo, IngestRepo, InsightRepo, JobRepo,
    ProjectRepo, SourceRepo,
};
pub(crate) use kb_core::{KbError, Result};
pub(crate) use kb_service::insight::{
    FeedbackRequest, InsightService, ReindexRequest, SaveInsightRequest,
};
pub(crate) use kb_service::search::{SearchOptions, SearchRequest, SearchService};
pub(crate) use kb_service::{CollectionService, ProjectService};
pub(crate) use serde_json::{Value, json};

pub(crate) use crate::runtime::Embedded;
pub(crate) use kb_core::config::QuotaConfig;

/// 在线编辑的原文上限(超过就只读)。
const EDITABLE_MAX_BYTES: u64 = 512 * 1024;

/// 查看用的全文上限。比编辑的上限(512 KB)大得多:页面上看到的必须是整份文档,
/// 不能因为文件稍大就退回去只显示某一个片段。超过它的文件由页面改用原件地址整份读取。
const VIEWABLE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// 读 `path` 的全文:不超过 `max` 字节、合法 UTF-8、没有 NUL 字节,否则返回空串。
fn read_text_within(path: &std::path::Path, max: u64) -> String {
    let Ok(meta) = std::fs::metadata(path) else {
        return String::new();
    };
    if meta.len() > max {
        return String::new();
    }
    match std::fs::read_to_string(path) {
        Ok(text) if !text.contains('\0') => text,
        _ => String::new(),
    }
}

/// 能力后端。
pub struct ServiceBackend {
    /// 主知识库的运行时。系统级调用(配置、模型、备份……)和守护进程自己的后台任务用它;
    /// **知识库内**的调用一律经 [`Self::rt`] 取调用者自己的知识库,不直接用这个字段。
    primary: Arc<Embedded>,
    /// 事件推送(`/api/v1/ws`);嵌入式 CLI 没有页面,`None`。
    hub: Option<Arc<kb_web::EventHub>>,
    /// 能力调用器。构造顺序是先 backend 再 registry,
    /// 所以用 `OnceLock` 事后注入。
    invoker: Arc<std::sync::OnceLock<Arc<kb_capability::invoke::Invoker>>>,
    /// 配置热重载:`update_config` 写完文件后立刻走同一套重载逻辑。
    reloader: Option<Arc<kb_service::ConfigReloader>>,
    /// ACP 代理连接缓存(按管家会话 id 复用,避免每轮重开子进程)。
    acp: Arc<tokio::sync::Mutex<std::collections::HashMap<String, CachedAcp>>>,
    /// 等待界面答复的权限请求(管家会话 id → 请求 id 列表)。
    acp_pending: Arc<tokio::sync::Mutex<std::collections::HashMap<String, Vec<String>>>>,
    /// 会话级伴生令牌。嵌入式 CLI 用自己的空表;守护进程换成和 HTTP 层同一份。
    agent_grants: Arc<kb_web::AgentGrants>,
    /// 按管家会话加锁,拉起代理时不占全局缓存锁。
    acp_locks:
        Arc<tokio::sync::Mutex<std::collections::HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    /// 本轮提示词里 `@` 到的其它会话。代理只能读自己的会话,外加这里列出的。
    history_allow: Arc<tokio::sync::Mutex<std::collections::HashMap<String, Vec<String>>>>,
    /// 按用户记账的 LLM 额度账本(多用户)。没有账本(嵌入式 CLI、单库模式)时不按人限额。
    llm_ledger: Option<Arc<dyn kb_core::ports::UserLlmLedger>>,
    /// 存储配额守门人:新建笔记前检查调用者的知识库还装不装得下。
    storage_guard: Option<Arc<crate::storage_guard::StorageGuard>>,
    /// 账号库:资源被删除时清掉它的授权与分享链接。没有(嵌入式 CLI、单库模式)就没有分享要清。
    system: Option<Arc<kb_meta::SystemStore>>,
    /// 多人在线编辑的协作中心(守护进程事后注入,因为它依赖知识库注册表,而注册表在后端之后才创建)。
    collab: Arc<std::sync::OnceLock<Arc<kb_collab::CollabHub>>>,
    /// 办公文档多人协同(守护进程才有):房间开着时房间外的整文件写入要拒绝。
    office: Arc<std::sync::OnceLock<Arc<crate::office_collab::OfficeCollab>>>,
    /// 评论的通讯录(@ 谁、能不能看到、作者资料、发通知),守护进程事后注入。
    comments: Arc<std::sync::OnceLock<Arc<dyn crate::comment_backend::CommentDirectory>>>,
    /// 正在拉起、还没进缓存的代理占的名额(会话 id → 属主):并发开新会话时名额不会被超卖。
    acp_slots: Arc<tokio::sync::Mutex<std::collections::HashMap<String, String>>>,
}

/// 一个管家会话背后的 ACP 连接。
#[derive(Clone)]
pub(crate) struct CachedAcp {
    /// 会话所在的知识库运行时。回收 / 关闭会话时(后台任务里,没有能力调用的路由)要把被打断的回复
    /// 存回**这个**知识库,而不是主知识库——否则普通用户的对话内容会写进管理员的库里。
    runtime: Arc<Embedded>,
    /// 这个会话属于谁(用户 id;本机超级用户是 `local`)。所有按会话 id 找代理的入口都要核对它,
    /// 否则知道别人会话 id 的人就能接上别人的代理、批准别人的权限请求。
    owner: String,
    client: Arc<kb_acp::AcpClient>,
    acp_session: String,
    /// 这一轮是不是 `session/load` 续上的(续上的不用再带上下文种子)。
    resumed: bool,
    /// 本轮 / 历史累计的助手正文(推送任务写,调用方读)。
    text: Arc<tokio::sync::Mutex<String>>,
    /// 工具调用标题(展示 + 落库)。
    trace: Arc<tokio::sync::Mutex<Vec<String>>>,
    /// 这一轮是不是跑在沙箱里。
    sandboxed: bool,
    /// 最近一次使用,空闲回收用。
    last_used: Arc<std::sync::Mutex<std::time::Instant>>,
    /// prompt 响应到达后,转发任务往这里塞一个结束信号。
    turn_slot: Arc<tokio::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>>,
    /// 同一会话的轮次串行;取消不拿这把锁。
    prompt_lock: Arc<tokio::sync::Mutex<()>>,
}

impl ServiceBackend {
    /// 构造。
    pub fn new(runtime: Arc<Embedded>) -> Self {
        Self {
            primary: runtime,
            hub: None,
            invoker: Arc::new(std::sync::OnceLock::new()),
            reloader: None,
            acp: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            acp_pending: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            agent_grants: Arc::new(kb_web::AgentGrants::new()),
            acp_locks: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            history_allow: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
            llm_ledger: None,
            storage_guard: None,
            system: None,
            collab: Arc::new(std::sync::OnceLock::new()),
            office: Arc::new(std::sync::OnceLock::new()),
            comments: Arc::new(std::sync::OnceLock::new()),
            acp_slots: Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new())),
        }
    }

    /// 注入协作中心。只能设一次。
    /// 注入评论的通讯录(守护进程)。
    pub(crate) fn set_comment_directory(
        &self,
        directory: Arc<dyn crate::comment_backend::CommentDirectory>,
    ) {
        let _ = self.comments.set(directory);
    }

    pub fn set_collab(&self, hub: Arc<kb_collab::CollabHub>) {
        let _ = self.collab.set(hub);
    }

    /// 挂上办公文档协同(守护进程)。
    pub fn set_office(&self, office: Arc<crate::office_collab::OfficeCollab>) {
        let _ = self.office.set(office);
    }

    /// 挂上账号库(守护进程):删除笔记 / 集合时顺手清掉它们的授权与分享链接。
    pub fn with_system(mut self, system: Arc<kb_meta::SystemStore>) -> Self {
        self.system = Some(system);
        self
    }

    /// 挂上存储配额守门人(守护进程):新建笔记会先检查调用者的配额。
    pub fn with_storage_guard(mut self, guard: Arc<crate::storage_guard::StorageGuard>) -> Self {
        self.storage_guard = Some(guard);
        self
    }

    /// 新增内容前的配额检查;没挂守门人(嵌入式 CLI)或不在能力调用里就不检查。
    pub(crate) async fn ensure_room(&self, extra: usize) -> Result<()> {
        let (Some(guard), Some(principal)) =
            (&self.storage_guard, kb_capability::current_principal())
        else {
            return Ok(());
        };
        guard
            .ensure_room(
                &principal,
                &self.call_space_id(),
                &self.rt().paths,
                extra as u64,
            )
            .await
    }

    /// 这篇文档正被多人在线编辑时拒绝直接写入,免得把别人正在写的内容覆盖掉（设计规范）。
    /// 没有挂协作中心(嵌入式 CLI、单库模式)就什么也不查。
    pub(crate) async fn refuse_while_collaborating(
        &self,
        key: Result<kb_core::share::ResourceKey>,
    ) -> Result<()> {
        let Ok(key) = key else {
            return Ok(());
        };
        // 办公文档的房间:房间外的整文件写入(上传新版本、改表格值、恢复版本)会盖掉大家正在改的内容
        if let Some(office) = self.office.get() {
            office.guard(&key)?;
        }
        let Some(hub) = self.collab.get() else {
            return Ok(());
        };
        if hub.is_busy(&key.to_string()).await {
            return Err(KbError::Exists(
                "这篇文档正在被多人编辑,请在编辑器里修改,或等大家都离开后再试".to_owned(),
            ));
        }
        Ok(())
    }

    /// 正文刚被协作之外的途径写过:让协作中心把这篇文档的房间(如果有)作废,
    /// 免得房间里的旧内容稍后又覆盖掉这次写入。
    pub(crate) async fn tell_collab_of_external_write(
        &self,
        key: Option<kb_core::share::ResourceKey>,
    ) {
        if let (Some(hub), Some(key)) = (self.collab.get(), key) {
            hub.external_write(&key.to_string()).await;
        }
    }

    /// 笔记的资源键(要先查它在哪个集合)。不是笔记 / 查不到返回 `None`。
    pub(crate) async fn insight_key(&self, id: &str) -> Option<kb_core::share::ResourceKey> {
        let insight = InsightRepo::get(self.rt().meta.as_ref(), id).await.ok()??;
        kb_core::share::ResourceKey::insight(&self.call_space_id(), &insight.collection, id).ok()
    }

    /// 文档被删除:断开房间、丢掉协作状态(含它底下的所有文档)。
    async fn drop_collab_state(&self, key: &kb_core::share::ResourceKey) {
        let within = |doc: &str| {
            kb_core::share::ResourceKey::parse(doc).is_ok_and(|candidate| candidate.is_within(key))
        };
        if let Some(hub) = self.collab.get() {
            hub.discard_where(within, "文档已被删除").await;
        }
        let meta = &self.rt().meta;
        match meta.collab_docs().await {
            Ok(docs) => {
                let doomed: Vec<String> = docs.into_iter().filter(|doc| within(doc)).collect();
                if let Err(err) = meta.collab_reset_many(&doomed).await {
                    tracing::warn!(error = %err, "清理已删除资源的协作状态失败");
                }
            }
            Err(err) => tracing::warn!(error = %err, "读取协作状态失败"),
        }
    }

    /// 资源被删除后清掉它(及它底下)的授权、停止继承,并撤销指向它的分享链接。
    /// 失败只记日志:资源已经删掉了,残留的授权也访问不到任何东西(权限引擎先查资源是否存在)。
    pub(crate) async fn forget_shares(&self, key: Result<kb_core::share::ResourceKey>) {
        if let Ok(key) = &key {
            self.drop_collab_state(key).await;
        }
        let (Some(system), Ok(key)) = (&self.system, key) else {
            return;
        };
        if let Err(err) = system.forget_resource(&key).await {
            tracing::warn!(error = %err, "清理已删除资源的授权失败");
        }
        if let Err(err) = system
            .revoke_links_within(&key, kb_service::llm_gate::today_now_millis())
            .await
        {
            tracing::warn!(error = %err, "撤销已删除资源的分享链接失败");
        }
    }

    /// 写进批注 / 版本历史的「谁」:登录用户和游客写他们自己的身份(游客是 `guest:昵称#编号`),
    /// 本机超级用户和后台任务沿用 `web`。多人共用一个知识库以后,「web」这种笼统的名字没有意义。
    pub(crate) fn actor_label(&self) -> String {
        match kb_capability::current_principal() {
            Some(principal) if !principal.local => principal.user_id,
            _ => "web".to_owned(),
        }
    }

    /// 这次调用落在哪个知识库:能力调用里取路由(可能是别人分享给我的),否则是主知识库。
    pub(crate) fn call_space_id(&self) -> String {
        match kb_capability::current_call_scope() {
            Some(kb_capability::CallScope::Space { space_id, .. }) => space_id,
            _ => kb_core::account::PRIMARY_SPACE_ID.to_owned(),
        }
    }

    /// 这次调用是不是通过分享链接进来的。链接访问者能打开只读菜单,但不能看到可用的删除 / 移动。
    pub(crate) fn call_via_link(&self) -> bool {
        matches!(
            kb_capability::current_call_scope(),
            Some(kb_capability::CallScope::Space { via_link: true, .. })
        )
    }

    /// 挂上按用户记账的账本(守护进程):之后用户触发的每次 LLM 外发都先查他今天的额度、调完记账。
    pub fn with_llm_ledger(mut self, ledger: Arc<dyn kb_core::ports::UserLlmLedger>) -> Self {
        self.llm_ledger = Some(ledger);
        self
    }

    /// 和 HTTP 层共用一份伴生令牌表(守护进程)。
    pub fn with_agent_grants(mut self, grants: Arc<kb_web::AgentGrants>) -> Self {
        self.agent_grants = grants;
        self
    }

    /// 挂上配置重载器(守护进程用: 的 `update_config` 就地生效)。
    pub fn with_reloader(mut self, reloader: Arc<kb_service::ConfigReloader>) -> Self {
        self.reloader = Some(reloader);
        self
    }

    /// 注入能力调用器(AI 管家用)。构造顺序是先 backend 再 registry,所以这里是事后设置。
    pub fn set_invoker(&self, invoker: Arc<kb_capability::invoke::Invoker>) {
        let _ = self.invoker.set(invoker);
    }

    /// 这次调用该用的知识库运行时。
    ///
    /// - 在能力调用里,且路由到某个知识库:取调用者自己的(由 `Invoker` 设置的任务局部路由,
    ///   句柄是 `SpaceRegistry` 打开的那个 `Embedded`);
    /// - 系统级 / 账号级调用,以及不在任何能力调用里的守护进程后台任务:主知识库。
    ///
    /// 后台任务如果要操作某个非主知识库,必须在派生任务之前先拿到 `Arc<Embedded>` 再带进去,
    /// 任务局部变量不会跟着 `tokio::spawn` 走。
    pub(crate) fn rt(&self) -> Arc<Embedded> {
        match kb_capability::current_call_scope() {
            Some(kb_capability::CallScope::Space { handle, .. }) => {
                handle.downcast::<Embedded>().unwrap_or_else(|_| {
                    unreachable!("知识库路由的句柄必须是 Embedded(SpaceRegistry 是唯一来源)")
                })
            }
            _ => self.primary.clone(),
        }
    }

    /// 批次流水线控制服务。
    pub(crate) fn batches(&self) -> kb_service::BatchService {
        kb_service::BatchService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().tracker.clone(),
        )
        .with_write_gate(self.rt().write_gate())
    }

    /// 推一条批次进度(`ingest.stage`);没有订阅者时什么也不做。
    pub(crate) fn publish_batch_progress(&self, progress: &kb_service::BatchProgress) {
        if let Some(hub) = &self.hub {
            hub.publish(
                "ingest.stage",
                serde_json::to_value(progress).unwrap_or(serde_json::Value::Null),
            );
        }
    }

    /// 推一条 `item.changed`;没有订阅者时什么也不做。
    pub(crate) fn publish_item_changed(&self, action: &str, id: &str, collection: &str) {
        if let Some(hub) = &self.hub {
            hub.publish(
                "item.changed",
                json!({
                    "action": action,
                    "id": id,
                    "collection": collection,
                }),
            );
        }
    }

    pub(crate) fn items(&self) -> kb_service::ItemService {
        kb_service::ItemService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
        )
        .with_write_gate(self.rt().write_gate())
        // :insight-template 类型的 skill 在这里生效
        .with_skills(self.rt().skills())
    }

    pub(crate) fn stats(&self) -> kb_service::StatsService {
        kb_service::StatsService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
            crate::runtime::build_reranker(&self.rt().config()),
            self.rt().config().rerank.mode.clone(),
        )
    }

    pub(crate) fn web(&self) -> kb_service::WebService {
        kb_service::WebService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
            self.rt().paths.config_file(),
        )
    }

    /// 当前配置下跑一遍黄金集的快照(没有黄金集 / 一条可用用例都没有就返回 `None`)。
    ///
    /// 预检与 `kb eval` 同源:调完权再拿一堆「collection 不存在」的用例对比前后,只会得出噪声结论。
    pub(crate) async fn eval_snapshot(&self) -> Result<Option<Value>> {
        let paths = crate::commands::eval::golden_paths(self.rt().paths.eval_dir());
        let Some(set_path) = paths.into_iter().find(|path| path.is_file()) else {
            return Ok(None);
        };
        let golden = crate::commands::eval::load(&set_path).map_err(cli_error)?;
        if golden.case.is_empty() {
            return Ok(None);
        }
        // seed 固定为 0:前/后两次必须是同一批用例,否则对比出来的差就是用例的差
        let prepared =
            crate::commands::eval::prepare(self.rt().meta.as_ref(), &golden, None, Some(0)).await?;
        if prepared.cases.is_empty() {
            return Ok(None);
        }
        let selected = crate::commands::eval::GoldenSet {
            case: prepared.cases.clone(),
        };
        let config = self.rt().config();
        let service = SearchService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
            crate::runtime::build_reranker(&config),
            SearchOptions::from_config(&config),
        );
        // 快照与 `kb eval` 同口径:黄金集自己在索引里时先剔掉,前后对比才比的是同一件事
        let hit_self = crate::commands::eval::self_ref(self.rt().meta.as_ref(), &set_path).await?;
        let (results, counters) =
            crate::commands::eval::evaluate(&service, &selected, 5, hit_self.as_ref(), None)
                .await
                .map_err(cli_error)?;
        let metrics = crate::commands::eval::metrics_of(&results, 5);
        Ok(Some(json!({
            "set": set_path.display().to_string(),
            "cases": results.len(),
            "pool": prepared.pool,
            "set_hash": prepared.set_hash(),
            "invalid_cases": prepared.problems.len(),
            "hit_at_1": metrics.hit_at_1,
            "hit_at_5": metrics.hit_at_k,
            "mrr": metrics.mrr,
            "degraded_cases": counters.degraded_cases,
            "self_hits": counters.self_hits,
        })))
    }

    /// 立即重读一次配置(与 `reload_config` 同一条路径,不额外推事件)。
    pub(crate) async fn reload_config_now(&self) {
        if let Some(reloader) = &self.reloader {
            let _ = reloader.reload().await;
        }
    }

    pub(crate) fn reverts(&self) -> kb_service::RevertService {
        kb_service::RevertService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
        )
        .with_write_gate(self.rt().write_gate())
    }

    pub(crate) fn search_service(&self) -> SearchService {
        SearchService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
            crate::runtime::build_reranker(&self.rt().config()),
            SearchOptions::from_config(&self.rt().config()),
        )
        // 这个知识库自己的查询向量缓存:重复的查询不再嵌入(L3 后半)
        .with_query_cache(self.rt().query_cache.clone())
        // 并发闸门:所有知识库共用,超出的请求排队而不是一起变慢
        .with_gate(self.rt().search_gate.clone())
        // 待补向量队列的 2 秒缓存:命中时不再查 SQLite
        .with_pending_cache(self.rt().pending_cache.clone())
    }

    pub(crate) fn insight(&self) -> InsightService {
        InsightService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
        )
        .with_write_gate(self.rt().write_gate())
    }

    pub(crate) fn projects(&self) -> ProjectService {
        ProjectService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().embedder.clone(),
        )
    }

    /// 数据源服务。
    pub(crate) fn sources(&self) -> kb_service::SourceService {
        kb_service::SourceService::new(
            self.rt().meta.clone(),
            self.rt().store(),
            self.rt().scanner.clone(),
            self.rt().paths.clone(),
            self.rt().config().upload.clone(),
        )
        .with_allow_private_web(self.rt().config().network.crawl_allow_private)
        .with_write_gate(self.rt().write_gate())
        .with_skills(self.rt().skills())
        // :新建网页来源的 AI 规范化默认值;多用户下记到调用者的 AI 额度上;
        // 没有「自动提炼与审核」功能权限的人不能打开,同步也不投递
        .with_ai_extract_default(self.rt().config().web_extract.enabled_by_default)
        .with_payer(ai_payer())
        .with_ai_permitted(ai_extract_permitted())
    }

    /// 这个来源如果是本机目录 / Git 类型,调用者必须有 `sources.local`。
    ///
    /// 管理员收回某人的 `sources.local` 之后,他以前建好的本机目录来源也不能再被他同步或改地址。
    pub(crate) async fn require_local_sources_for(&self, source_id: &str) -> Result<()> {
        let source =
            kb_core::ports::repo::SourceRepo::get(self.rt().meta.as_ref(), source_id).await?;
        if let Some(source) = source
            && matches!(
                source.kind,
                kb_core::model::SourceKind::LocalDir | kb_core::model::SourceKind::Git
            )
        {
            require_local_sources()?;
        }
        Ok(())
    }

    /// 解析队列服务。
    pub(crate) fn ingest(&self) -> kb_service::IngestService {
        kb_service::IngestService::new(self.rt().meta.clone())
    }

    /// 作用域解析（设计规范）:`args.project` > `ctx.project` > `ctx.cwd` > 全部 collection。
    ///
    /// 守护进程是长驻、被任意客户端共享的,这里**绝不读进程环境变量**。
    pub(crate) async fn resolve_scope(
        &self,
        ctx: &CallCtx,
        args: &SearchArgs,
    ) -> Result<Vec<String>> {
        let explicit = match args.project.clone() {
            Some(name) => Some(name),
            None => ctx.project.clone(),
        };
        let project = match (args.scope.as_deref(), explicit) {
            (Some("global"), _) => return Ok(vec!["_global".to_owned()]),
            (Some("all"), _) => return self.all_collections().await,
            (_, Some(name)) => Some(self.projects().resolve(&name).await?),
            (_, None) => match ctx.cwd.as_deref() {
                Some(cwd) => {
                    kb_core::ports::repo::ProjectRepo::match_cwd(self.rt().meta.as_ref(), cwd)
                        .await?
                }
                None => None,
            },
        };
        match project {
            Some(project) => Ok(vec![format!("proj_{}", project.slug), "_global".to_owned()]),
            None => self.all_collections().await,
        }
    }

    async fn all_collections(&self) -> Result<Vec<String>> {
        Ok(CollectionRepo::list(self.rt().meta.as_ref())
            .await?
            .into_iter()
            .map(|collection| collection.name)
            .collect())
    }

    pub(crate) async fn collection_of(&self, id: &str) -> Result<kb_core::model::Collection> {
        for name in self.all_collections().await? {
            let Some(collection) = CollectionRepo::get(self.rt().meta.as_ref(), &name).await?
            else {
                continue;
            };
            let rows = self
                .rt()
                .store()
                .get(
                    &collection.active_table,
                    std::slice::from_ref(&id.to_owned()),
                )
                .await?;
            if !rows.is_empty() {
                return Ok(collection);
            }
        }
        Err(KbError::NotFound(format!("item {id}")))
    }
}

/// 读项目根目录下的源文件,取 `[start - lines, end + lines]` 行作为上下文。
pub(crate) async fn context_lines_of(
    meta: &dyn kb_core::ports::repo::MetaStore,
    collection: &kb_core::model::Collection,
    row: &kb_core::model::RecordRow,
    lines: usize,
) -> Option<String> {
    let project_id = collection.project_id.as_ref()?;
    let project = kb_core::ports::repo::ProjectRepo::get(meta, project_id)
        .await
        .ok()??;
    let (start, end) = (row.start_line?, row.end_line?);
    let path = std::path::Path::new(&project.root_path).join(&row.source);
    let content = std::fs::read_to_string(path).ok()?;
    let all: Vec<&str> = content.lines().collect();
    if all.is_empty() {
        return None;
    }
    let from = (start.max(1) as usize).saturating_sub(lines).max(1);
    let to = ((end.max(0) as usize) + lines).min(all.len());
    if from > to {
        return None;
    }
    Some(all[from - 1..to].join("\n"))
}

/// 块类型名(给前端选渲染器)。
pub(crate) fn block_kind(block: &kb_core::model::Block) -> &'static str {
    match block {
        kb_core::model::Block::Heading { .. } => "heading",
        kb_core::model::Block::Paragraph { .. } => "paragraph",
        kb_core::model::Block::Table { .. } => "table",
        kb_core::model::Block::Code { .. } => "code",
        kb_core::model::Block::Image { .. } => "image",
        kb_core::model::Block::Media { .. } => "media",
    }
}

/// 页码(1 起)与每页条数 → [`kb_core::model::Page`]。
pub(crate) fn page_of(page: Option<u32>, page_size: Option<u32>) -> (kb_core::model::Page, u32) {
    let page = page.unwrap_or(1).max(1);
    let page_size = page_size.unwrap_or(50).clamp(1, 200);
    (
        kb_core::model::Page::new(page_size, (page - 1) * page_size),
        page_size,
    )
}

/// hook 报告转 JSON。
/// 把 CLI 侧的错误转成能力层能返回的错误(评测复用 CLI 的实现,错误类型不同)。
fn cli_error(err: crate::error::CliError) -> KbError {
    KbError::Internal(format!("评测失败: {err}"))
}
