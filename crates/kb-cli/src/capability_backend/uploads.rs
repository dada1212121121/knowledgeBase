//! 上传与事件:分片上传、Web 事件桥、磁盘护栏。

use crate::capability_backend::*;

impl ServiceBackend {
    /// 挂上事件中心(守护进程用,`item.changed` 会推给浏览器)。
    pub fn with_hub(mut self, hub: Arc<kb_web::EventHub>) -> Self {
        self.hub = Some(hub);
        self
    }
}

/// 事件接收:把 `POST /api/v1/events` 转给 `kb-service` 的 `EventService`。
pub struct ServiceEvents {
    spaces: Arc<crate::spaces::SpaceRegistry>,
    /// 自动提炼(收尾阶段):`session_end` 事件要提炼经验,模型与闸门都从能力后端取。
    backend: Option<Arc<ServiceBackend>>,
}

impl ServiceEvents {
    /// 构造:按调用者选知识库。
    pub fn with_registry(spaces: Arc<crate::spaces::SpaceRegistry>) -> Self {
        Self {
            spaces,
            backend: None,
        }
    }

    /// 接上自动提炼(组装根在守护进程里注入;嵌入式 CLI 不接)。
    pub fn with_backend(mut self, backend: Arc<ServiceBackend>) -> Self {
        self.backend = Some(backend);
        self
    }
}

#[async_trait::async_trait]
impl kb_web::events::EventSink for ServiceEvents {
    async fn handle_event(
        &self,
        caller: &kb_web::auth::Caller,
        request: serde_json::Value,
    ) -> kb_core::Result<serde_json::Value> {
        let request: kb_service::EventRequest = serde_json::from_value(request)
            .map_err(|err| kb_core::KbError::InvalidInput(format!("事件体不合法: {err}")))?;
        // 事件落进调用者自己的知识库(本机 hook 是主知识库)
        let runtime = self.spaces.runtime_for(&caller.principal).await?;
        let mut service = kb_service::EventService::new(runtime.meta.clone())
            .with_session_roots(session_roots(&runtime.config()));
        // 只有会话事件才需要模型:git 事件不该因为 `chat_model` 失败而一起失败,
        // 也不该每条事件都新建两个模型实例。
        if needs_evolution(&request.kind)
            && let Some(backend) = &self.backend
        {
            service = service
                .with_evolution(Arc::new(backend.evolution_service().await?))
                // 提炼在后台跑完再写回:客户端(会话 hook)超时断开不会取消它
                .with_background_extraction();
        }
        // 整个处理放进独立任务:客户端(hook)超时断开时,hyper 丢弃的是外层 future,
        // 事件落库与后台提炼照常完成。
        let outcome = tokio::spawn(async move { service.handle(request).await })
            .await
            .map_err(|err| {
                // `JoinError` 的 Display 带 panic 消息(可能有路径 / 内部状态):只进日志
                tracing::error!(error = %err, "处理事件的任务异常结束");
                kb_core::KbError::Internal("处理事件失败".to_owned())
            })??;
        Ok(serde_json::json!({
            "event_id": outcome.event_id,
            "project": outcome.project,
            "collection": outcome.collection,
            "job_id": outcome.job_id,
            "changed_files": outcome.changed_files,
            "mode": outcome.mode,
            "result": outcome.result,
        }))
    }
}

/// 上传接口的实现:把 `kb-web` 的 HTTP 请求转给 `kb-service::UploadService`。
///
/// 上传与能力调用分开:分片是二进制,走不了 JSON 能力层。
pub struct ServiceUploads {
    spaces: Arc<crate::spaces::SpaceRegistry>,
    hub: Option<Arc<kb_web::EventHub>>,
    /// 存储配额守门人:上传占的空间走带缓存与预留的用量表。
    guard: Option<Arc<crate::storage_guard::StorageGuard>>,
    /// 办公文档多人协同:房间开着时不让整文件替换。
    office: Option<Arc<crate::office_collab::OfficeCollab>>,
    /// 在线编辑的「谁在编辑」状态(内存里;全站一份,键里带知识库编号)。
    locks: Arc<kb_service::edit::lock::FileLocks>,
}

impl ServiceUploads {
    /// 构造:每个调用者上传到自己的知识库。
    pub fn with_registry(spaces: Arc<crate::spaces::SpaceRegistry>) -> Self {
        Self {
            spaces,
            hub: None,
            guard: None,
            office: None,
            locks: Arc::new(kb_service::edit::lock::FileLocks::new()),
        }
    }

    /// 挂上办公文档协同(守护进程)。
    pub fn with_office(mut self, office: Arc<crate::office_collab::OfficeCollab>) -> Self {
        self.office = Some(office);
        self
    }

    /// 编辑权表里的键:知识库编号 + collection + 路径(各人的库互不相干)。
    fn lock_key(space_id: &str, collection: &str, path: &str) -> String {
        format!("{space_id}\u{0}{collection}\u{0}{path}")
    }

    /// 挂上存储配额守门人(守护进程)。
    pub fn with_storage_guard(mut self, guard: Arc<crate::storage_guard::StorageGuard>) -> Self {
        self.guard = Some(guard);
        self
    }

    /// 调用者的知识库:`(id, 运行时)`。上传只可能落进调用者自己的库,upload_id 在别人的库里根本查不到。
    pub(crate) async fn target(
        &self,
        caller: &kb_web::auth::Caller,
    ) -> Result<(String, Arc<Embedded>)> {
        let runtime = self.spaces.runtime_for(&caller.principal).await?;
        Ok((self.spaces.space_id_for(&caller.principal)?, runtime))
    }

    /// 挂上事件中心(`upload.progress` / `ingest.status` 推给浏览器)。
    pub fn with_hub(mut self, hub: Arc<kb_web::EventHub>) -> Self {
        self.hub = Some(hub);
        self
    }

    /// 调用者最终生效的配额:全站 `[quota]` → 角色覆盖 → 用户覆盖。本机超级用户用全站默认。
    async fn quota_of(
        &self,
        caller: &kb_web::auth::Caller,
        runtime: &Embedded,
    ) -> Result<QuotaConfig> {
        let defaults = runtime.config().quota.clone();
        match (caller.principal.local, self.spaces.system()) {
            (false, Some(system)) => {
                system
                    .effective_quota(&caller.principal.user_id, &defaults)
                    .await
            }
            _ => Ok(defaults),
        }
    }

    /// 上传服务,单文件和总量上限取自调用者的配额,而不是全站统一的 `[upload]`
    /// (`upload.max_total_gb` 默认 20 GB,和「每人 100 GB」矛盾)。分片大小、保留时长等仍用 `[upload]`。
    pub(crate) async fn service(
        &self,
        caller: &kb_web::auth::Caller,
        runtime: &Arc<Embedded>,
    ) -> Result<kb_service::UploadService> {
        let quota = self.quota_of(caller, runtime).await?;
        let mut upload_config = runtime.config().upload.clone();
        upload_config.max_file_mb = quota.max_upload_mb;
        upload_config.max_total_gb = quota.storage_gb;
        let service = kb_service::UploadService::new(
            runtime.meta.clone(),
            runtime.paths.clone(),
            upload_config,
        )
        .with_write_gate(runtime.write_gate());
        let service = match &self.guard {
            Some(guard) => service.with_storage_meter(
                guard.meter().clone(),
                self.spaces.space_id_for(&caller.principal)?,
            ),
            None => service,
        };
        Ok(match &self.hub {
            Some(hub) => service.with_observer(Arc::new(HubUploadObserver::new(hub.clone()))),
            None => service,
        })
    }
}

/// 整盘保护:数据盘剩余空间低于「全站保留空间 + 这次要写的」就拒绝上传。
///
/// `df` 是一次子进程调用,文件夹上传一次会连续创建成百上千个上传会话,所以结果缓存 15 秒。
/// 缓存的是「剩余字节」,检查时再减去这 15 秒内已经放行的上传大小(`reserved`),
/// 避免一批并发的大文件同时通过检查、一起把盘写满。
pub struct DiskGuard {
    state: std::sync::Mutex<DiskSample>,
}

struct DiskSample {
    at: Option<std::time::Instant>,
    free_bytes: u64,
    reserved: u64,
}

impl DiskGuard {
    pub(crate) const fn new() -> Self {
        Self {
            state: std::sync::Mutex::new(DiskSample {
                at: None,
                free_bytes: 0,
                reserved: 0,
            }),
        }
    }

    /// 检查并(放行时)预留 `size` 字节。`reserve_gb == 0` 表示不设保护。
    pub fn check(&self, home: &std::path::Path, reserve_gb: u64, size: u64) -> Result<()> {
        self.check_with(reserve_gb, size, || {
            kb_service::providers::disk_free_gb(home).saturating_mul(1024 * 1024 * 1024)
        })
    }

    /// 同 [`Self::check`],剩余字节由 `probe` 现场读(测试注入)。
    pub fn check_with(
        &self,
        reserve_gb: u64,
        size: u64,
        probe: impl FnOnce() -> u64,
    ) -> Result<()> {
        if reserve_gb == 0 {
            return Ok(());
        }
        let mut sample = self
            .state
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if sample
            .at
            .is_none_or(|at| at.elapsed() > std::time::Duration::from_secs(15))
        {
            sample.free_bytes = probe();
            sample.reserved = 0;
            sample.at = Some(std::time::Instant::now());
        }
        let reserve = reserve_gb.saturating_mul(1024 * 1024 * 1024);
        let needed = reserve.saturating_add(sample.reserved).saturating_add(size);
        if sample.free_bytes < needed {
            return Err(KbError::Unavailable(format!(
                "服务器磁盘空间不足(剩余 {} GB,需要保留 {reserve_gb} GB),已暂停上传,请联系管理员",
                sample.free_bytes / (1024 * 1024 * 1024)
            )));
        }
        sample.reserved = sample.reserved.saturating_add(size);
        Ok(())
    }
}

static DISK_GUARD: DiskGuard = DiskGuard::new();

/// 把备份的进度 / 成功 / 失败推给 `/api/v1/ws`(定时备份与手动备份共用)。
///
/// 事件:
/// - `backup.progress`:打包进度(服务层已按 400ms 节流);
/// - `backup.done`:一份备份写成功;
/// - `backup.failed`:一次备份失败(页面据此弹告警,不必等下次打开设置页)。
pub struct HubBackupObserver {
    hub: Arc<kb_web::EventHub>,
}

impl HubBackupObserver {
    /// 构造。
    pub fn new(hub: Arc<kb_web::EventHub>) -> Self {
        Self { hub }
    }
}

impl kb_service::backup::BackupObserver for HubBackupObserver {
    fn progress(&self, progress: &kb_service::backup::BackupProgress) {
        self.hub.publish(
            "backup.progress",
            serde_json::to_value(progress).unwrap_or(serde_json::Value::Null),
        );
    }

    fn done(
        &self,
        entry: &kb_service::backup::BackupEntry,
        trigger: kb_service::backup::BackupTrigger,
    ) {
        self.hub.publish(
            "backup.done",
            json!({
                "archive": entry.name,
                "size_bytes": entry.size_bytes,
                "created_at": entry.created_at,
                "trigger": trigger.as_str(),
            }),
        );
    }

    fn failed(&self, failure: &kb_service::backup::BackupFailure) {
        self.hub.publish(
            "backup.failed",
            json!({
                "at": failure.at,
                "trigger": failure.trigger.as_str(),
                "error": failure.error,
            }),
        );
    }
}

/// 把上传 / 解析的状态变化推给 `/api/v1/ws`。
pub struct HubUploadObserver {
    hub: Arc<kb_web::EventHub>,
}

impl HubUploadObserver {
    /// 构造。
    pub fn new(hub: Arc<kb_web::EventHub>) -> Self {
        Self { hub }
    }
}

impl kb_service::UploadObserver for HubUploadObserver {
    fn on_upload(&self, upload: &kb_core::model::Upload) {
        self.hub.publish(
            "upload.progress",
            json!({
                "upload_id": upload.id,
                "name": upload.name,
                "rel_path": upload.rel_path,
                "collection": upload.collection,
                "state": upload.state.as_str(),
                "parts_received": upload.parts_received,
                "parts_total": upload.parts_total,
                "batch_id": upload.batch_id,
            }),
        );
    }

    fn on_batch_progress(&self, progress: &kb_service::BatchProgress) {
        // 频率由 `ProgressTracker` 的节流保证(≤ 2 次/秒)
        self.hub.publish(
            "ingest.stage",
            serde_json::to_value(progress).unwrap_or(serde_json::Value::Null),
        );
    }

    fn on_ingest(&self, file: &kb_core::model::IngestFile) {
        self.hub.publish(
            "ingest.status",
            json!({
                "file_id": file.id,
                "batch_id": file.batch_id,
                "collection": file.collection,
                "rel_path": file.rel_path,
                "state": file.state.as_str(),
                "chunks": file.chunks,
                "error": file.error,
            }),
        );
    }
}

#[async_trait]
impl kb_web::upload::UploadApi for ServiceUploads {
    async fn create_upload(
        &self,
        caller: &kb_web::auth::Caller,
        request: kb_web::CreateUploadRequest,
    ) -> Result<Value> {
        let strategy = match request.strategy.as_deref() {
            None => None,
            Some(text) => Some(kb_core::model::DedupStrategy::parse(text).ok_or_else(|| {
                KbError::InvalidInput(format!(
                    "strategy 只能是 skip / overwrite / keep_both,收到 {text}"
                ))
            })?),
        };
        let (space_id, runtime) = self.target(caller).await?;
        // 整盘保护:磁盘剩余低于全站保留空间时,所有人暂停上传(读、删、改笔记不受影响)
        let quota = self.quota_of(caller, &runtime).await?;
        DISK_GUARD.check(runtime.paths.home(), quota.disk_reserve_gb, request.size)?;
        // 在知识库路由里执行:服务里推送的 `upload.progress` 等事件会带上知识库标签,只推给这个用户
        let session = crate::spaces::within_space(space_id, runtime.clone(), async {
            self.service(caller, &runtime)
                .await?
                .create(kb_service::NewUpload {
                    name: request.name,
                    rel_path: request.rel_path,
                    size: request.size,
                    sha256: request.sha256,
                    collection: request.collection,
                    tags: request.tags,
                    batch: request.batch,
                    strategy,
                })
                .await
        })
        .await?;
        Ok(serde_json::to_value(session)
            .map_err(|err| KbError::Internal(format!("序列化上传会话失败: {err}")))?)
    }

    async fn upload_status(&self, caller: &kb_web::auth::Caller, upload_id: &str) -> Result<Value> {
        let (_, runtime) = self.target(caller).await?;
        let session = self
            .service(caller, &runtime)
            .await?
            .status(upload_id)
            .await?;
        Ok(serde_json::to_value(session)
            .map_err(|err| KbError::Internal(format!("序列化上传会话失败: {err}")))?)
    }

    async fn put_part(
        &self,
        caller: &kb_web::auth::Caller,
        upload_id: &str,
        part_no: u32,
        bytes: Vec<u8>,
        sha256: Option<String>,
    ) -> Result<Value> {
        let (space_id, runtime) = self.target(caller).await?;
        let ack = crate::spaces::within_space(space_id, runtime.clone(), async {
            self.service(caller, &runtime)
                .await?
                .put_part(upload_id, part_no, bytes, sha256.as_deref())
                .await
        })
        .await?;
        Ok(serde_json::to_value(ack)
            .map_err(|err| KbError::Internal(format!("序列化分片回执失败: {err}")))?)
    }

    async fn complete_upload(
        &self,
        caller: &kb_web::auth::Caller,
        upload_id: &str,
    ) -> Result<Value> {
        let (space_id, runtime) = self.target(caller).await?;
        let completed = crate::spaces::within_space(space_id, runtime.clone(), async {
            self.service(caller, &runtime)
                .await?
                .complete(&caller.actor, upload_id)
                .await
        })
        .await?;
        Ok(serde_json::to_value(completed)
            .map_err(|err| KbError::Internal(format!("序列化上传结果失败: {err}")))?)
    }

    async fn abort_upload(&self, caller: &kb_web::auth::Caller, upload_id: &str) -> Result<Value> {
        let (space_id, runtime) = self.target(caller).await?;
        let upload = crate::spaces::within_space(space_id, runtime.clone(), async {
            self.service(caller, &runtime).await?.abort(upload_id).await
        })
        .await?;
        Ok(json!({ "upload_id": upload.id, "state": upload.state.as_str() }))
    }

    async fn roundtrip_check(
        &self,
        caller: &kb_web::auth::Caller,
        request: kb_web::RoundtripCheckRequest,
        bytes: Vec<u8>,
    ) -> Result<Value> {
        let (space_id, runtime) = self.target(caller).await?;
        let report = crate::spaces::within_space(space_id, runtime.clone(), async {
            let index = std::sync::Arc::new(kb_service::IndexService::new(
                runtime.meta.clone(),
                runtime.store.clone(),
                runtime.embedder.clone(),
                runtime.chunker.clone(),
                runtime.scanner.clone(),
                kb_service::index::IndexOptions::default(),
            ));
            kb_service::edit::FileEditService::new(
                runtime.meta.clone(),
                index,
                runtime.paths.clone(),
            )
            .roundtrip_report(&request.collection, &request.path, &bytes)
            .await
        })
        .await?;
        Ok(serde_json::to_value(report)
            .map_err(|err| KbError::Internal(format!("序列化检查结果失败: {err}")))?)
    }

    async fn lock_file(
        &self,
        caller: &kb_web::auth::Caller,
        request: kb_web::FileLockRequest,
    ) -> Result<Value> {
        use kb_service::edit::lock::Acquire;
        let (space_id, _) = self.target(caller).await?;
        if request.session.trim().is_empty() || request.session.len() > 128 {
            return Err(KbError::InvalidInput(
                "session 不能为空,最长 128 个字符".to_owned(),
            ));
        }
        let key = Self::lock_key(&space_id, &request.collection, &request.path);
        let ttl_secs = self.locks.ttl_secs();
        Ok(
            match self
                .locks
                .acquire(&key, &caller.actor, &request.session, request.take_over)
            {
                Acquire::Granted { took_over_from } => json!({
                    "held": true,
                    "ttl_secs": ttl_secs,
                    "took_over_from": took_over_from,
                }),
                Acquire::Held { holder } => json!({
                    "held": false,
                    "ttl_secs": ttl_secs,
                    // 同一个账号在另一个窗口 / 设备上:界面说「你在另一个窗口里正在编辑」
                    "same_user": holder.actor == caller.actor,
                    "holder": holder,
                }),
                Acquire::Full => {
                    return Err(KbError::Unavailable(
                        "同时在线编辑的文件太多了,请稍后再试".to_owned(),
                    ));
                }
            },
        )
    }

    async fn unlock_file(
        &self,
        caller: &kb_web::auth::Caller,
        request: kb_web::FileUnlockRequest,
    ) -> Result<Value> {
        let (space_id, _) = self.target(caller).await?;
        let key = Self::lock_key(&space_id, &request.collection, &request.path);
        Ok(json!({ "released": self.locks.release(&key, &request.session) }))
    }

    async fn replace_file(
        &self,
        caller: &kb_web::auth::Caller,
        request: kb_web::ReplaceFileRequest,
        bytes: Vec<u8>,
    ) -> Result<Value> {
        let (space_id, runtime) = self.target(caller).await?;
        // 正在多人协同的文件:房间外不能整文件替换(会盖掉大家正在改的内容)
        if let Some(office) = &self.office
            && let Ok(file_key) =
                kb_core::share::ResourceKey::file(&space_id, &request.collection, &request.path)
        {
            office.guard(&file_key)?;
        }
        // 文件的编辑权在别的窗口手里:不让替换(没人持有时照旧可以,命令行和旧客户端不受影响)
        let key = Self::lock_key(&space_id, &request.collection, &request.path);
        if let Some(holder) = self.locks.held_by_other(&key, request.session.as_deref()) {
            return Err(KbError::Exists(format!(
                "{}正在编辑这份文件(最近 {} 秒前还有动静),这次保存没有写入。请先让对方保存并关闭,或在编辑页重新打开后接手",
                if holder.actor == caller.actor {
                    "你在另一个窗口里".to_owned()
                } else {
                    holder.actor
                },
                holder.idle_secs
            )));
        }
        // 新内容会写进版本备份库,算进这个人的存储用量:先过配额和整盘保护
        let quota = self.quota_of(caller, &runtime).await?;
        DISK_GUARD.check(
            runtime.paths.home(),
            quota.disk_reserve_gb,
            bytes.len() as u64,
        )?;
        let args_json = serde_json::json!({ "collection": request.collection, "path": request.path, "size": bytes.len() }).to_string();
        // 审计要记耗时(迁移 0020);这条路径不走能力调用,自己掐表
        let started = std::time::Instant::now();
        let result = crate::spaces::within_space(space_id, runtime.clone(), async {
            let index = std::sync::Arc::new(kb_service::IndexService::new(
                runtime.meta.clone(),
                runtime.store.clone(),
                runtime.embedder.clone(),
                runtime.chunker.clone(),
                runtime.scanner.clone(),
                kb_service::index::IndexOptions::default(),
            ));
            kb_service::edit::FileEditService::new(
                runtime.meta.clone(),
                index,
                runtime.paths.clone(),
            )
            .with_keep_versions(runtime.config().office.keep_versions)
            .replace_bytes(
                &request.collection,
                &request.path,
                &bytes,
                request.expected_sha256.as_deref(),
                &caller.actor,
            )
            .await
        })
        .await;
        // 这条路不经过能力调用(请求体是原始字节),审计在这里补上,成败都记
        let entry = kb_core::model::AuditEntry {
            id: None,
            at: chrono::Utc::now().timestamp_millis(),
            actor: caller.actor.clone(),
            capability: "replace_file".to_owned(),
            args_json,
            ok: result.is_ok(),
            error: result.as_ref().err().map(ToString::to_string),
            batch_id: None,
            dry_run: false,
            took_ms: Some(started.elapsed().as_millis() as u64),
            degraded: None,
        };
        if let Err(err) =
            kb_core::ports::repo::AuditRepo::record(runtime.meta.as_ref(), entry).await
        {
            tracing::warn!(error = %err, "写审计失败");
        }
        let result = result?;
        if let Some(hub) = &self.hub
            && !result.unchanged
        {
            hub.publish(
                "item.changed",
                json!({ "action": "file.replaced", "collection": result.collection, "path": result.path, "version": result.version }),
            );
        }
        Ok(serde_json::to_value(result)
            .map_err(|err| KbError::Internal(format!("序列化替换结果失败: {err}")))?)
    }

    async fn precheck(
        &self,
        caller: &kb_web::auth::Caller,
        request: kb_web::PrecheckRequest,
    ) -> Result<Value> {
        let (_, runtime) = self.target(caller).await?;
        let items: Vec<kb_service::PrecheckItem> = request
            .files
            .into_iter()
            .map(|file| kb_service::PrecheckItem {
                rel_path: file.rel_path,
                size: file.size,
                sha256: file.sha256.to_ascii_lowercase(),
            })
            .collect();
        let results = kb_service::upload::dedup::DedupService::new(runtime.meta.clone())
            .precheck(&request.collection, &items)
            .await?;
        Ok(json!({ "results": results }))
    }
}

#[cfg(test)]
mod event_tests {
    //! 事件入口的取舍:只有会话事件才构造提炼服务。
    use super::needs_evolution;

    #[test]
    fn only_session_events_need_a_model() {
        assert!(needs_evolution("session_end"));
        // git 事件与文件变化都不该碰模型(否则 chat_model 失败会连索引一起失败)
        for kind in [
            "git_commit",
            "git_merge",
            "git_checkout",
            "file_change",
            "manual",
        ] {
            assert!(!needs_evolution(kind), "{kind} 不该构造提炼服务");
        }
    }
}

#[cfg(test)]
mod disk_guard_tests {
    use super::*;

    const GB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn zero_reserve_means_no_protection_and_never_probes() {
        let guard = DiskGuard::new();
        guard
            .check_with(0, 500 * GB, || unreachable!("不设保护就不该去读磁盘"))
            .expect("放行");
    }

    #[test]
    fn uploads_are_refused_once_free_space_would_dip_below_the_reserve() {
        let guard = DiskGuard::new();
        // 剩 100 GB、保留 30 GB:最多还能放 70 GB
        guard
            .check_with(30, 60 * GB, || 100 * GB)
            .expect("60 GB 放行");
        let error = guard
            .check_with(30, 20 * GB, || unreachable!("15 秒内用缓存"))
            .unwrap_err();
        assert!(matches!(error, KbError::Unavailable(_)), "{error:?}");
        assert!(error.to_string().contains("磁盘空间不足"), "{error}");
        // 没超的小文件还能进
        guard
            .check_with(30, 5 * GB, || unreachable!())
            .expect("5 GB 放行");
    }

    #[test]
    fn a_batch_of_concurrent_big_files_cannot_all_pass_together() {
        let guard = DiskGuard::new();
        // 剩 50 GB、保留 10 GB、每个 15 GB:只能放 2 个,第 3 个必须被拒
        let probe = || 50 * GB;
        assert!(guard.check_with(10, 15 * GB, probe).is_ok());
        assert!(guard.check_with(10, 15 * GB, || unreachable!()).is_ok());
        assert!(
            guard.check_with(10, 15 * GB, || unreachable!()).is_err(),
            "已预留的也要算进去"
        );
    }

    #[test]
    fn a_refused_upload_does_not_hold_a_reservation() {
        let guard = DiskGuard::new();
        assert!(guard.check_with(10, 100 * GB, || 50 * GB).is_err());
        // 被拒的那次不占额度:小文件照常进
        assert!(guard.check_with(10, 20 * GB, || unreachable!()).is_ok());
    }
}
