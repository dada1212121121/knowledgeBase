//! 上传服务（设计规范）:分片续传、去重、安全解包、入解析队列。
//!
//! 一次上传的完整流程:
//! 1. [`UploadService::create`]:声明文件(`name` / `size` / `sha256` / `rel_path` / 目标集合 / 标签),
//!    返回分片规划与**已收分片**(续传靠它,不靠客户端记忆);
//! 2. [`UploadService::put_part`]:逐片上传,单片校验 sha256,重传同一片是幂等的;
//! 3. [`UploadService::complete`]:按序合并 → 校验整体 sha256 → 去重(秒传 / 跳过 / 覆盖 / 保留两者)
//!    → 落到 `KB_HOME/sources/<source_id>/<rel_path>` → 写 `ingest_files`(queued)→ 入队 `ingest` 任务。
//!
//! 写入约定:
//! - 一次上传 = 一个批次(`uploads.batch_id`),每个文件在 `changes` 里留一条 `ingest.file`,
//!   因此 `revert_batch` 能把文件、块、向量与磁盘上的字节一起清干净;
//! - 落盘路径只由服务端拼(集合内相对路径已做穿越校验),不信任客户端给的绝对路径;
//! - 未完成的上传 24 小时后由 [`UploadService::cleanup_stale`] 清理。

pub mod chunked;
pub mod dedup;
pub mod ingest;
pub(crate) mod offload;
pub mod unpack;

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use kb_core::config::UploadConfig;
use kb_core::filter::validate_tag_value;
use kb_core::hash::sha256_hex_bytes;
use kb_core::model::{
    DedupStrategy, IngestFile, IngestStage, IngestStageStatus, IngestState, Millis, Source,
    SourceKind, SourceStatus, Upload, UploadPart, UploadState,
};
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{
    AuditRepo, CollectionRepo, IngestProgressRepo, IngestRepo, MetaStore, SourceRepo, UploadRepo,
};
use kb_core::{KbError, Result};
use serde::Serialize;
use serde_json::json;

use crate::jobs::queue::{JobQueue, NewJob, priority};
use crate::upload::chunked::MergedFile;
use crate::upload::dedup::{DedupService, IngestBrief, PrecheckStatus};
use crate::write_gate::WriteGate;

pub use chunked::{ChunkPlan, RetryPolicy};
pub use dedup::{Decision, PrecheckItem, PrecheckResult};
pub use ingest::{IngestJobHandler, IngestPayload, IngestService, IngestStatus, RetryReport};

/// 上传批次的变更操作名(撤销时按它识别)。
pub const OP_INGEST_FILE: &str = "ingest.file";

/// 上传 / 解析的观察者(WS 的 `upload.progress` / `ingest.status` 推送用)。
///
/// 由组装根(`kb-cli`)实现并注入;`kb-service` 只负责在状态变化时回调。
pub trait UploadObserver: Send + Sync {
    /// 上传状态变化(收到分片 / 完成 / 取消)。
    fn on_upload(&self, upload: &Upload);
    /// 一个文件的解析状态变化。
    fn on_ingest(&self, file: &IngestFile);
    /// 批次流水线进度(`ingest.stage`;调用方已按 ≤2 次/秒节流)。
    fn on_batch_progress(&self, progress: &crate::ingest::BatchProgress);
}

/// 新建上传的请求。
#[derive(Clone, Debug)]
pub struct NewUpload {
    /// 文件名。
    pub name: String,
    /// 集合内相对路径(文件夹上传时带目录;空 = 用文件名)。
    pub rel_path: Option<String>,
    /// 字节数。
    pub size: u64,
    /// 客户端算的 sha256(可空)。
    pub sha256: Option<String>,
    /// 目标 collection。
    pub collection: String,
    /// 标签。
    pub tags: Vec<String>,
    /// 共享批次 id(同一个文件夹 / 一次拖拽用同一个;空 = 服务端生成)。
    pub batch: Option<String>,
    /// 同名不同内容的策略。
    pub strategy: Option<DedupStrategy>,
}

/// 新建上传的返回:分片规划 + 已收分片 + 去重提示。
#[derive(Clone, Debug, Serialize)]
pub struct UploadSession {
    /// 上传 id。
    pub upload_id: String,
    /// 会话状态:`pending` / `completed` / `aborted`。
    pub state: String,
    /// 批次 id(一次上传 = 一个 batch,可整批撤销)。
    pub batch_id: String,
    /// 文件名。
    pub name: String,
    /// 集合内相对路径。
    pub rel_path: String,
    /// 每片字节数。
    pub chunk_size: u64,
    /// 分片总数。
    pub parts_total: u32,
    /// 已收到的分片序号(续传时只补传缺的)。
    pub received: Vec<u32>,
    /// 已收到的字节数。
    pub received_bytes: u64,
    /// 去重判定。
    pub dedup: PrecheckStatus,
    /// 命中的已有文件。
    pub existing: Option<IngestBrief>,
}

/// 一个分片写入后的回执。
#[derive(Clone, Debug, Serialize)]
pub struct PartAck {
    /// 分片序号。
    pub part_no: u32,
    /// 字节数。
    pub size: u64,
    /// 服务端算的 sha256。
    pub sha256: String,
    /// 已收分片数。
    pub parts_received: u32,
    /// 分片总数。
    pub parts_total: u32,
}

/// 上传完成的结果。
#[derive(Clone, Debug, Serialize)]
pub struct CompletedUpload {
    /// 上传 id。
    pub upload_id: String,
    /// 批次 id。
    pub batch_id: String,
    /// 目标 collection。
    pub collection: String,
    /// 新入解析队列的文件。
    pub files: Vec<IngestFile>,
    /// 被跳过的文件(秒传 / 策略为 skip)。
    pub skipped: Vec<SkippedUpload>,
    /// 解析任务 id。
    pub job_id: Option<String>,
}

/// 一个被跳过的文件。
#[derive(Clone, Debug, Serialize)]
pub struct SkippedUpload {
    /// 相对路径。
    pub rel_path: String,
    /// 原因:`same_content` / `skip`。
    pub reason: String,
    /// 命中的已有文件。
    pub existing: Option<IngestBrief>,
}

/// 上传服务。
pub struct UploadService {
    meta: Arc<dyn MetaStore>,
    paths: KbPaths,
    config: UploadConfig,
    queue: JobQueue,
    /// 与索引 / 迁移共享的写闸门(落盘与索引写入都受它保护)。
    gate: WriteGate,
    observer: Option<Arc<dyn UploadObserver>>,
    /// 带缓存与预留的用量表和它在表里的键(知识库 id)。
    meter: Option<(Arc<crate::storage::StorageMeter>, String)>,
}

impl UploadService {
    /// 构造。
    pub fn new(meta: Arc<dyn MetaStore>, paths: KbPaths, config: UploadConfig) -> Self {
        Self {
            queue: JobQueue::new(meta.clone()),
            meta,
            paths,
            config,
            gate: WriteGate::new(),
            observer: None,
            meter: None,
        }
    }

    /// 配额改用带缓存与预留的用量表(守护进程):同时数向量索引等看不见的部分,并发上传加起来也不会超额。
    /// 不挂(嵌入式 CLI)时沿用老办法——每次现数 `sources` + `uploads`。
    pub fn with_storage_meter(
        mut self,
        meter: Arc<crate::storage::StorageMeter>,
        space_id: impl Into<String>,
    ) -> Self {
        self.meter = Some((meter, space_id.into()));
        self
    }

    /// 换用与索引共享的写闸门。
    pub fn with_write_gate(mut self, gate: WriteGate) -> Self {
        self.gate = gate;
        self
    }

    /// 挂上观察者。
    pub fn with_observer(mut self, observer: Arc<dyn UploadObserver>) -> Self {
        self.observer = Some(observer);
        self
    }

    /// 配置里的单文件上限(字节)。
    pub fn max_file_bytes(&self) -> u64 {
        self.config.max_file_mb * 1024 * 1024
    }

    /// 1. 新建上传(返回分片规划、已收分片与去重提示)。
    pub async fn create(&self, request: NewUpload) -> Result<UploadSession> {
        let collection = request.collection.trim().to_owned();
        if CollectionRepo::get(self.meta.as_ref(), &collection)
            .await?
            .is_none()
        {
            return Err(KbError::NotFound(format!("collection {collection}")));
        }
        let name = validate_file_name(&request.name)?;
        let rel_path = match request.rel_path.as_deref() {
            Some(raw) if !raw.trim().is_empty() => sanitize_rel_path(raw)?,
            _ => name.clone(),
        };
        if request.size == 0 {
            return Err(KbError::InvalidInput("空文件不上传".to_owned()));
        }
        if request.size > self.max_file_bytes() {
            return Err(KbError::InvalidInput(format!(
                "文件 {} 字节超过单文件上限 {} MB",
                request.size, self.config.max_file_mb
            )));
        }
        for tag in &request.tags {
            validate_tag_value(tag)?;
        }
        self.ensure_quota(request.size).await?;

        let plan = chunked::plan(request.size, self.config.chunk_mb);
        let now = now_millis();
        let upload = Upload {
            id: uuid::Uuid::now_v7().to_string(),
            name,
            rel_path: rel_path.clone(),
            collection: collection.clone(),
            tags: request.tags,
            size: request.size,
            sha256: request.sha256.map(|value| value.to_ascii_lowercase()),
            chunk_size: plan.chunk_size,
            parts_total: plan.parts_total,
            parts_received: 0,
            state: UploadState::Pending,
            source_id: None,
            batch_id: Some(
                request
                    .batch
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| uuid::Uuid::now_v7().to_string()),
            ),
            strategy: request.strategy,
            created_at: now,
            updated_at: now,
            completed_at: None,
        };
        // 批次行在 complete 时才落库(`ensure_batch`),避免取消的上传留下空批次
        UploadRepo::create(self.meta.as_ref(), upload.clone()).await?;
        std::fs::create_dir_all(self.paths.upload_dir(&upload.id)).map_err(|err| {
            KbError::Internal(format!(
                "创建上传目录 {} 失败: {err}",
                self.paths.upload_dir(&upload.id).display()
            ))
        })?;

        // 去重提示(客户端据此决定要不要传字节)
        let (status, existing) = match &upload.sha256 {
            Some(sha256) => {
                let results = DedupService::new(self.meta.clone())
                    .precheck(
                        &collection,
                        &[PrecheckItem {
                            rel_path: rel_path.clone(),
                            size: upload.size,
                            sha256: sha256.clone(),
                        }],
                    )
                    .await?;
                let first = results.into_iter().next();
                match first {
                    Some(result) => (result.status, result.existing),
                    None => (PrecheckStatus::New, None),
                }
            }
            None => (PrecheckStatus::New, None),
        };
        Ok(UploadSession {
            upload_id: upload.id.clone(),
            state: upload.state.as_str().to_owned(),
            batch_id: upload.batch_id.clone().unwrap_or_default(),
            name: upload.name.clone(),
            rel_path,
            chunk_size: plan.chunk_size,
            parts_total: plan.parts_total,
            received: Vec::new(),
            received_bytes: 0,
            dedup: status,
            existing,
        })
    }

    /// 2. 写一个分片(幂等;重传覆盖)。
    pub async fn put_part(
        &self,
        upload_id: &str,
        part_no: u32,
        bytes: Vec<u8>,
        client_sha256: Option<&str>,
    ) -> Result<PartAck> {
        let mut upload = self.upload(upload_id).await?;
        if upload.state != UploadState::Pending {
            return Err(KbError::InvalidInput(format!(
                "上传 {upload_id} 的状态是 {},不能再写分片",
                upload.state.as_str()
            )));
        }
        let plan = ChunkPlan {
            chunk_size: upload.chunk_size,
            parts_total: upload.parts_total,
        };
        let expected = chunked::part_len(plan, upload.size, part_no).ok_or_else(|| {
            KbError::InvalidInput(format!(
                "分片序号 {part_no} 越界(共 {} 片)",
                upload.parts_total
            ))
        })?;
        if bytes.len() as u64 != expected {
            return Err(KbError::InvalidInput(format!(
                "分片 {part_no} 应为 {expected} 字节,收到 {}",
                bytes.len()
            )));
        }
        let sha256 = sha256_hex_bytes(&bytes);
        if let Some(declared) = client_sha256 {
            let declared = declared.trim().to_ascii_lowercase();
            if !declared.is_empty() && declared != sha256 {
                return Err(KbError::InvalidInput(format!(
                    "分片 {part_no} 的 sha256 不符:声明 {declared},实际 {sha256}"
                )));
            }
        }
        chunked::write_part(&self.paths.upload_dir(upload_id), part_no, &bytes)?;
        let now = now_millis();
        UploadRepo::put_part(
            self.meta.as_ref(),
            UploadPart {
                upload_id: upload_id.to_owned(),
                part_no,
                size: bytes.len() as u64,
                sha256: sha256.clone(),
                received_at: now,
            },
        )
        .await?;
        let parts = UploadRepo::parts(self.meta.as_ref(), upload_id).await?;
        upload.parts_received = parts.len() as u32;
        upload.updated_at = now;
        UploadRepo::update(self.meta.as_ref(), upload.clone()).await?;
        self.notify_upload(&upload);
        Ok(PartAck {
            part_no,
            size: bytes.len() as u64,
            sha256,
            parts_received: upload.parts_received,
            parts_total: upload.parts_total,
        })
    }

    /// 上传的续传信息(已收分片 + 缺哪些)。
    pub async fn status(&self, upload_id: &str) -> Result<UploadSession> {
        let upload = self.upload(upload_id).await?;
        let parts = UploadRepo::parts(self.meta.as_ref(), upload_id).await?;
        let received: Vec<u32> = parts.iter().map(|part| part.part_no).collect();
        let received_bytes: u64 = parts.iter().map(|part| part.size).sum();
        Ok(UploadSession {
            upload_id: upload.id.clone(),
            state: upload.state.as_str().to_owned(),
            batch_id: upload.batch_id.clone().unwrap_or_default(),
            name: upload.name.clone(),
            rel_path: upload.rel_path.clone(),
            chunk_size: upload.chunk_size,
            parts_total: upload.parts_total,
            received,
            received_bytes,
            dedup: PrecheckStatus::New,
            existing: None,
        })
    }

    /// 缺哪些分片(客户端重连后照着补传)。
    pub async fn missing_parts(&self, upload_id: &str) -> Result<Vec<u32>> {
        let upload = self.upload(upload_id).await?;
        let parts = UploadRepo::parts(self.meta.as_ref(), upload_id).await?;
        let received: HashSet<u32> = parts.iter().map(|part| part.part_no).collect();
        Ok((0..upload.parts_total)
            .filter(|part| !received.contains(part))
            .collect())
    }

    /// 3. 完成上传:合并 → 校验 → 去重 → 落盘 → 入队。
    pub async fn complete(&self, actor: &str, upload_id: &str) -> Result<CompletedUpload> {
        let mut upload = self.upload(upload_id).await?;
        if upload.state == UploadState::Completed {
            // 重复 complete 是幂等的:返回已经入队的文件
            let files = IngestRepo::list(
                self.meta.as_ref(),
                kb_core::model::IngestFilter {
                    collection: Some(upload.collection.clone()),
                    batch_id: upload.batch_id.clone(),
                    source_id: None,
                    state: None,
                },
                kb_core::model::Page::new(200, 0),
            )
            .await?;
            return Ok(CompletedUpload {
                upload_id: upload.id.clone(),
                batch_id: upload.batch_id.clone().unwrap_or_default(),
                collection: upload.collection.clone(),
                files,
                skipped: Vec::new(),
                job_id: None,
            });
        }
        if upload.state != UploadState::Pending {
            return Err(KbError::InvalidInput(format!(
                "上传 {upload_id} 的状态是 {},不能完成",
                upload.state.as_str()
            )));
        }
        let missing = self.missing_parts(upload_id).await?;
        let upload_dir = self.paths.upload_dir(upload_id);
        let merged_path = upload_dir.join("merged.bin");
        let merged: MergedFile = if missing.len() == upload.parts_total as usize {
            // 一个分片都没收到:只可能是秒传(客户端按 precheck 的结果没传字节)
            match self.instant_copy(&upload).await? {
                Some(InstantCopy::AlreadyIndexed(existing)) => {
                    cleanup_upload_dir(&upload_dir);
                    let skipped = SkippedUpload {
                        rel_path: upload.rel_path.clone(),
                        reason: "same_content".to_owned(),
                        existing: Some(IngestBrief::of(&existing)),
                    };
                    self.finish_upload(&mut upload, None).await?;
                    return Ok(CompletedUpload {
                        upload_id: upload.id.clone(),
                        batch_id: upload.batch_id.clone().unwrap_or_default(),
                        collection: upload.collection.clone(),
                        files: Vec::new(),
                        skipped: vec![skipped],
                        job_id: None,
                    });
                }
                Some(InstantCopy::Copied { from, size }) => {
                    // 同内容、不同路径:本地复制一份,后面照常落盘与解析
                    std::fs::create_dir_all(&upload_dir)
                        .map_err(|err| KbError::Internal(format!("创建上传目录失败: {err}")))?;
                    std::fs::copy(&from, &merged_path).map_err(|err| {
                        KbError::Internal(format!("秒传复制 {} 失败: {err}", from.display()))
                    })?;
                    MergedFile {
                        size,
                        sha256: upload.sha256.clone().unwrap_or_default(),
                    }
                }
                None => {
                    return Err(KbError::InvalidInput(format!(
                        "还缺 {} 个分片(前几个:{:?})",
                        missing.len(),
                        &missing[..missing.len().min(10)]
                    )));
                }
            }
        } else {
            if !missing.is_empty() {
                return Err(KbError::InvalidInput(format!(
                    "还缺 {} 个分片(前几个:{:?})",
                    missing.len(),
                    &missing[..missing.len().min(10)]
                )));
            }
            // 合并 + 整体校验
            chunked::merge_parts(&upload_dir, upload.parts_total, &merged_path)?
        };
        if merged.size != upload.size {
            cleanup_upload_dir(&upload_dir);
            return Err(KbError::InvalidInput(format!(
                "合并后 {} 字节,与声明的 {} 字节不符",
                merged.size, upload.size
            )));
        }
        if let Some(declared) = &upload.sha256
            && declared != &merged.sha256
        {
            cleanup_upload_dir(&upload_dir);
            return Err(KbError::InvalidInput(format!(
                "整体 sha256 不符:声明 {declared},实际 {}",
                merged.sha256
            )));
        }

        let batch_id = upload.batch_id.clone().unwrap_or_else(|| {
            let id = uuid::Uuid::now_v7().to_string();
            upload.batch_id = Some(id.clone());
            id
        });
        let strategy = upload.strategy.unwrap_or_default();
        let dedup = DedupService::new(self.meta.clone());
        let decision = dedup
            .decide(
                &upload.collection,
                &upload.rel_path,
                &merged.sha256,
                strategy,
            )
            .await?;

        // 秒传 / 跳过:不落盘、不入库
        match &decision {
            Decision::AlreadyExists(existing) if existing.state == IngestState::Done => {
                cleanup_upload_dir(&upload_dir);
                let skipped = SkippedUpload {
                    rel_path: upload.rel_path.clone(),
                    reason: "same_content".to_owned(),
                    existing: Some(IngestBrief::of(existing)),
                };
                self.finish_upload(&mut upload, None).await?;
                return Ok(CompletedUpload {
                    upload_id: upload.id.clone(),
                    batch_id,
                    collection: upload.collection.clone(),
                    files: Vec::new(),
                    skipped: vec![skipped],
                    job_id: None,
                });
            }
            Decision::Skip(existing) => {
                cleanup_upload_dir(&upload_dir);
                let skipped = SkippedUpload {
                    rel_path: upload.rel_path.clone(),
                    reason: "skip".to_owned(),
                    existing: Some(IngestBrief::of(existing)),
                };
                self.finish_upload(&mut upload, None).await?;
                return Ok(CompletedUpload {
                    upload_id: upload.id.clone(),
                    batch_id,
                    collection: upload.collection.clone(),
                    files: Vec::new(),
                    skipped: vec![skipped],
                    job_id: None,
                });
            }
            _ => {}
        }

        // 落盘:同一个批次共用一个数据源目录
        let is_archive = is_archive_name(&upload.name) || looks_like_archive_file(&merged_path);
        let source = self.ensure_source(&upload, &batch_id, is_archive).await?;
        let target_rel_path = match &decision {
            Decision::KeepBoth { rel_path, .. } => rel_path.clone(),
            _ => upload.rel_path.clone(),
        };
        let target = source_path(&self.paths, &source.id, &target_rel_path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|err| {
                KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
            })?;
        }
        let now = now_millis();

        // 覆盖:先把旧字节挪进备份目录,撤销时再还原
        let mut before: Option<serde_json::Value> = None;
        let mut existing_id: Option<String> = None;
        if let Decision::Overwrite(existing) = &decision {
            let backup_dir = self.paths.source_dir(&source.id).join(".kb-prev");
            std::fs::create_dir_all(&backup_dir)
                .map_err(|err| KbError::Internal(format!("创建备份目录失败: {err}")))?;
            let backup = backup_dir.join(format!("{}.bak", existing.id));
            let old_bytes = PathBuf::from(&existing.abs_path);
            if old_bytes.is_file() {
                std::fs::rename(&old_bytes, &backup)
                    .map_err(|err| KbError::Internal(format!("备份旧文件失败: {err}")))?;
            }
            before = Some(json!({
                "ingest_id": existing.id,
                "batch_id": existing.batch_id,
                "source_id": existing.source_id,
                "rel_path": existing.rel_path,
                "size": existing.size,
                "sha256": existing.sha256,
                "abs_path": existing.abs_path,
                "backup_path": backup.display().to_string(),
            }));
            existing_id = Some(existing.id.clone());
        }
        // `AlreadyExists`(同名同内容但上次没跑完)也走“替换”路径:内容一样,重跑一次
        if let Decision::AlreadyExists(existing) = &decision {
            existing_id = Some(existing.id.clone());
            before = Some(json!({
                "ingest_id": existing.id,
                "batch_id": existing.batch_id,
                "source_id": existing.source_id,
                "rel_path": existing.rel_path,
                "size": existing.size,
                "sha256": existing.sha256,
                "abs_path": existing.abs_path,
            }));
        }

        std::fs::rename(&merged_path, &target)
            .or_else(|_| copy_then_remove(&merged_path, &target))
            .map_err(|err| KbError::Internal(format!("落盘 {} 失败: {err}", target.display())))?;
        cleanup_upload_dir(&upload_dir);

        // 批次行(同一个 batch 只建一次)
        AuditRepo::ensure_batch(
            self.meta.as_ref(),
            &batch_id,
            actor,
            &format!("上传 {} 到 {}", upload.name, upload.collection),
        )
        .await?;

        // ingest_files:覆盖时复用原行(保持 id,撤销时按它清),否则新建
        let ingest = match existing_id {
            Some(id) => {
                let mut file = IngestRepo::get(self.meta.as_ref(), &id)
                    .await?
                    .ok_or_else(|| KbError::NotFound(format!("ingest file {id}")))?;
                file.rel_path = target_rel_path.clone();
                file.abs_path = target.display().to_string();
                file.size = merged.size;
                file.sha256 = Some(merged.sha256.clone());
                file.state = IngestState::Queued;
                file.error = None;
                // 换上新的批次:解析任务是按 `payload.batch_id` 取 `queued` 行的,
                // 继续挂着旧批次的话覆盖上传根本没有任务会处理它(索引一直是旧正文、状态停在 queued)
                file.batch_id = Some(batch_id.clone());
                // 覆盖上传:旧文件的抽取元信息不能沿用(新版本可能被隔离 / 抽取失败)
                file.extract_meta = None;
                file.updated_at = now;
                self.update_ingest(&file).await?;
                file
            }
            None => {
                let file = IngestFile {
                    id: uuid::Uuid::now_v7().to_string(),
                    batch_id: Some(batch_id.clone()),
                    source_id: Some(source.id.clone()),
                    upload_id: Some(upload.id.clone()),
                    collection: upload.collection.clone(),
                    rel_path: target_rel_path.clone(),
                    abs_path: target.display().to_string(),
                    size: merged.size,
                    sha256: Some(merged.sha256.clone()),
                    state: IngestState::Queued,
                    error: None,
                    chunks: 0,
                    vectors: 0,
                    extract_meta: None,
                    // 上传的文件没有父条目(邮件附件 / 压缩包内的文件才会填)
                    derived_from: None,
                    elapsed_ms: None,
                    created_at: now,
                    updated_at: now,
                };
                IngestRepo::create(self.meta.as_ref(), file.clone()).await?;
                file
            }
        };

        // 可撤销记录
        let after = json!({
            "ingest_id": ingest.id,
            "collection": ingest.collection,
            "rel_path": ingest.rel_path,
            "source_id": source.id,
            "abs_path": ingest.abs_path,
            "sha256": ingest.sha256,
            "size": ingest.size,
        });
        crate::upload::ingest::record_ingest_change(
            self.meta.as_ref(),
            &batch_id,
            &ingest.id,
            before,
            after,
        )
        .await?;

        // 批次行(流水线状态)与“上传”阶段留痕
        IngestProgressRepo::ensure_ingest_batch(
            self.meta.as_ref(),
            &batch_id,
            &upload.collection,
            now,
        )
        .await?;
        if let Ok(event) = IngestProgressRepo::begin_stage(
            self.meta.as_ref(),
            &ingest.id,
            Some(&batch_id),
            IngestStage::Upload,
            now,
        )
        .await
        {
            let _ = IngestProgressRepo::end_stage(
                self.meta.as_ref(),
                event,
                IngestStageStatus::Ok,
                None,
                0, // 上传阶段不产块
                0,
                now,
            )
            .await;
        }
        let job_id = self
            .enqueue_ingest(&batch_id, &upload.collection)
            .await
            .ok();
        self.finish_upload(&mut upload, Some(source.id.clone()))
            .await?;
        self.notify_ingest(&ingest);
        SourceRepo::set_file_count(
            self.meta.as_ref(),
            &source.id,
            count_source_files(self.meta.as_ref(), &source.id).await?,
        )
        .await?;
        Ok(CompletedUpload {
            upload_id: upload.id.clone(),
            batch_id,
            collection: upload.collection.clone(),
            files: vec![ingest],
            skipped: Vec::new(),
            job_id,
        })
    }

    /// 取消一个未完成的上传(清掉分片与临时文件)。
    pub async fn abort(&self, upload_id: &str) -> Result<Upload> {
        let mut upload = self.upload(upload_id).await?;
        if upload.state == UploadState::Completed {
            return Err(KbError::InvalidInput(
                "已完成的不能再取消;要清理请撤销它所在的批次".to_owned(),
            ));
        }
        cleanup_upload_dir(&self.paths.upload_dir(upload_id));
        UploadRepo::delete_parts(self.meta.as_ref(), upload_id).await?;
        upload.state = UploadState::Aborted;
        upload.updated_at = now_millis();
        UploadRepo::update(self.meta.as_ref(), upload.clone()).await?;
        self.notify_upload(&upload);
        Ok(upload)
    }

    /// 清理超过 `upload.keep_hours` 仍未完成的上传,返回清理条数。
    pub async fn cleanup_stale(&self, now: Millis) -> Result<u64> {
        let deadline = now - (self.config.keep_hours as i64) * 3_600_000;
        let mut removed = 0u64;
        for upload in UploadRepo::list_pending(self.meta.as_ref()).await? {
            if upload.updated_at >= deadline {
                continue;
            }
            cleanup_upload_dir(&self.paths.upload_dir(&upload.id));
            UploadRepo::delete_parts(self.meta.as_ref(), &upload.id).await?;
            let mut upload = upload;
            upload.state = UploadState::Aborted;
            upload.updated_at = now;
            UploadRepo::update(self.meta.as_ref(), upload).await?;
            removed += 1;
        }
        Ok(removed)
    }

    /// 取一个上传(不存在时报 `NotFound`)。
    pub async fn upload(&self, upload_id: &str) -> Result<Upload> {
        UploadRepo::get(self.meta.as_ref(), upload_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("upload {upload_id}")))
    }

    /// 同一个批次共用一个数据源(`KB_HOME/sources/<id>`)。
    async fn ensure_source(
        &self,
        upload: &Upload,
        batch_id: &str,
        is_archive: bool,
    ) -> Result<Source> {
        let name = format!("upload:{batch_id}");
        if let Some(existing) = SourceRepo::get_by_name(self.meta.as_ref(), &name).await? {
            return Ok(existing);
        }
        let id = uuid::Uuid::now_v7().to_string();
        let dir = self.paths.source_dir(&id);
        std::fs::create_dir_all(&dir)
            .map_err(|err| KbError::Internal(format!("创建数据源目录失败: {err}")))?;
        let source = Source {
            id,
            kind: if is_archive {
                SourceKind::Archive
            } else {
                SourceKind::Upload
            },
            name,
            uri: dir.display().to_string(),
            collection: upload.collection.clone(),
            tags: upload.tags.clone(),
            include: Vec::new(),
            exclude: Vec::new(),
            depth: 1,
            allow_hosts: Vec::new(),
            refresh_minutes: None,
            status: SourceStatus::Idle,
            last_synced_at: None,
            last_error: None,
            files: 0,
            created_at: now_millis(),
            ai_extract: false,
            extract_prompt: String::new(),
            ai_status: None,
        };
        SourceRepo::create(self.meta.as_ref(), source.clone()).await?;
        Ok(source)
    }

    /// 标记上传完成。
    async fn finish_upload(&self, upload: &mut Upload, source_id: Option<String>) -> Result<()> {
        let now = now_millis();
        upload.state = UploadState::Completed;
        upload.completed_at = Some(now);
        upload.updated_at = now;
        if let Some(source_id) = source_id {
            upload.source_id = Some(source_id);
        }
        UploadRepo::update(self.meta.as_ref(), upload.clone()).await?;
        UploadRepo::delete_parts(self.meta.as_ref(), &upload.id).await?;
        self.notify_upload(upload);
        Ok(())
    }

    /// 写入一条 ingest 行(覆盖时整行更新)。
    async fn update_ingest(&self, file: &IngestFile) -> Result<()> {
        // 仓储没有整行 update:先删后插(同一事务性由单条写连接保证)
        IngestRepo::delete(self.meta.as_ref(), &file.id).await?;
        IngestRepo::create(self.meta.as_ref(), file.clone()).await
    }

    /// 入队解析任务。
    async fn enqueue_ingest(&self, batch_id: &str, collection: &str) -> Result<String> {
        let job = self
            .queue
            .enqueue(NewJob {
                kind: "ingest".to_owned(),
                collection: Some(collection.to_owned()),
                // 用户刚上传:排在积压前面,见 `priority::INGEST_UPLOAD`
                priority: priority::INGEST_UPLOAD,
                payload: json!({ "batch_id": batch_id, "collection": collection }),
            })
            .await?;
        Ok(job.id)
    }

    /// 配额检查:`KB_HOME/sources` + `KB_HOME/uploads` 的占用不得超过 `upload.max_total_gb`。
    async fn ensure_quota(&self, extra: u64) -> Result<()> {
        let limit = self.config.max_total_gb.saturating_mul(1024 * 1024 * 1024);
        if limit == 0 {
            return Ok(());
        }
        if let Some((meter, space_id)) = &self.meter {
            return meter.reserve(space_id, &self.paths, extra, limit).await;
        }
        let used = dir_usage(self.paths.sources_dir()) + dir_usage(self.paths.uploads_dir());
        if used.saturating_add(extra) > limit {
            return Err(KbError::InvalidInput(format!(
                "上传配额不足:已用 {} MB,上限 {} GB",
                used / (1024 * 1024),
                self.config.max_total_gb
            )));
        }
        Ok(())
    }

    /// 秒传判定:声明了整体 sha256、且已有同内容且已完成的文件。
    ///
    /// 同路径 → 什么都不用做;不同路径 → 把已有字节复制过来(本地复制,不经过网络)。
    async fn instant_copy(&self, upload: &Upload) -> Result<Option<InstantCopy>> {
        let Some(declared) = &upload.sha256 else {
            return Ok(None);
        };
        let Some(existing) =
            IngestRepo::find_done_by_sha(self.meta.as_ref(), &upload.collection, declared).await?
        else {
            return Ok(None);
        };
        if existing.rel_path == upload.rel_path {
            return Ok(Some(InstantCopy::AlreadyIndexed(Box::new(existing))));
        }
        let from = PathBuf::from(&existing.abs_path);
        if !from.is_file() {
            return Ok(None);
        }
        let size = std::fs::metadata(&from)
            .map_err(|err| KbError::Internal(format!("读取 {} 失败: {err}", from.display())))?
            .len();
        if size != upload.size {
            // 大小不一致说明不是同一份内容,老老实实走分片
            return Ok(None);
        }
        Ok(Some(InstantCopy::Copied { from, size }))
    }

    /// 写闸门(解析任务与索引共享同一把)。
    pub fn write_gate(&self) -> WriteGate {
        self.gate.clone()
    }

    fn notify_upload(&self, upload: &Upload) {
        if let Some(observer) = &self.observer {
            observer.on_upload(upload);
        }
    }

    fn notify_ingest(&self, file: &IngestFile) {
        if let Some(observer) = &self.observer {
            observer.on_ingest(file);
        }
    }
}

/// 秒传的两种结局。
enum InstantCopy {
    /// 同路径同内容且已完成:什么也不用做。
    AlreadyIndexed(Box<IngestFile>),
    /// 同内容但在别的路径:本地复制一份再入库。
    Copied { from: PathBuf, size: u64 },
}

/// 数据源里的文件绝对路径(拒绝任何越界)。
pub fn source_path(paths: &KbPaths, source_id: &str, rel_path: &str) -> Result<PathBuf> {
    let root = paths.source_dir(source_id);
    let relative = sanitize_rel_path(rel_path)?;
    let target = root.join(&relative);
    if !target.starts_with(&root) {
        return Err(KbError::InvalidInput(format!(
            "{rel_path} 会写到数据源目录之外"
        )));
    }
    Ok(target)
}

/// 校验文件名:不能带路径分隔符,长度 1..=255。
pub fn validate_file_name(name: &str) -> Result<String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(KbError::InvalidInput("文件名不能为空".to_owned()));
    }
    if name.chars().count() > 255 {
        return Err(KbError::InvalidInput("文件名太长".to_owned()));
    }
    if name.contains('/') || name.contains('\\') {
        return Err(KbError::InvalidInput(format!(
            "文件名不能带路径分隔符:{name}"
        )));
    }
    if name == "." || name == ".." {
        return Err(KbError::InvalidInput(format!("非法文件名:{name}")));
    }
    if name.chars().any(|ch| ch.is_control()) {
        return Err(KbError::InvalidInput("文件名含控制字符".to_owned()));
    }
    Ok(name.to_owned())
}

/// 规整集合内相对路径:`/` 分隔、去掉空段与 `.`、拒绝 `..` 与绝对路径。
pub fn sanitize_rel_path(raw: &str) -> Result<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(KbError::InvalidInput("相对路径不能为空".to_owned()));
    }
    if raw.contains('\\') {
        return Err(KbError::InvalidInput(format!("相对路径要用 / 分隔:{raw}")));
    }
    if raw.starts_with('/') {
        return Err(KbError::InvalidInput(format!(
            "相对路径不能是绝对路径:{raw}"
        )));
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in raw.split('/') {
        match part {
            "" | "." => continue,
            ".." => {
                return Err(KbError::InvalidInput(format!("相对路径不能含 ..:{raw}")));
            }
            other => {
                if other.chars().any(|ch| ch.is_control()) {
                    return Err(KbError::InvalidInput("相对路径含控制字符".to_owned()));
                }
                parts.push(other);
            }
        }
    }
    if parts.is_empty() {
        return Err(KbError::InvalidInput("相对路径不能为空".to_owned()));
    }
    Ok(parts.join("/"))
}

/// 扩展名是 zip 就当压缩包(内容判断在 [`looks_like_archive_file`])。
fn is_archive_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".zip")
}

/// 按魔数判断是不是压缩包(不看扩展名)。
fn looks_like_archive_file(path: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 4];
    match std::fs::File::open(path).and_then(|mut file| file.read_exact(&mut head)) {
        Ok(()) => unpack::looks_like_zip(&head),
        Err(_) => false,
    }
}

/// 删掉一个上传的临时目录。
fn cleanup_upload_dir(dir: &Path) {
    if dir.exists() {
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn copy_then_remove(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::copy(from, to)?;
    std::fs::remove_file(from)?;
    Ok(())
}

/// 目录占用字节数(配额统计用;读不到就当 0,不因为一个坏链接挡住上传)。
pub fn dir_usage(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => total += dir_usage(&path),
            Ok(kind) if kind.is_file() => {
                total += entry.metadata().map(|meta| meta.len()).unwrap_or(0)
            }
            _ => {}
        }
    }
    total
}

/// 统计某个数据源下已入库的文件数。
async fn count_source_files(meta: &dyn MetaStore, source_id: &str) -> Result<u64> {
    IngestRepo::count(
        meta,
        kb_core::model::IngestFilter {
            collection: None,
            batch_id: None,
            source_id: Some(source_id.to_owned()),
            state: None,
        },
    )
    .await
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
