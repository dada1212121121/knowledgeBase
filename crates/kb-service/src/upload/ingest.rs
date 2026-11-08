//! 解析队列:把上传 / 数据源同步产生的文件变成可检索的块。
//!
//! 阶段与 `ingest_files.state` 一一对应,并在 `ingest_stage_events` 里逐段留痕:
//! `upload → detect → extract → chunk → embed → write → searchable`。
//! 出错是 `failed`,压缩包不安全是 `quarantined`,人工跳过是 `skipped`。
//!
//! 分片执行:一个 `ingest` 任务按 `created_at` 顺序处理同一批次的 `queued` 文件,
//! 每片处理 `slice_files` 个;**每个文件之前**都检查批次状态:
//! `paused` → 任务转 `paused` 停下(重启后仍是 paused),`canceled` → 结束。
//!
//! 并发:一片内同时处理几个文件由 `index.parallel_files` 决定(读 → 抽取 / 转换 → 分块 → 嵌入),
//! 多个批次之间由后台的多条循环并行(`index.parallel_slices`)。写 LanceDB 是并发提交,
//! 撞上 commit conflict 由存储层退避重试(见 `kb-store-lance` 的 `WRITE_BACKOFF`)。
//! 暂停 / 取消停止领新文件,在途的跑完当前窗口即停。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use futures::stream::{FuturesUnordered, StreamExt};
use kb_core::config::IndexConfig;
use kb_core::hash::sha256_hex_file;
use kb_core::model::{
    Collection, IngestBatchState, IngestFile, IngestFilter, IngestStage, IngestStageStatus,
    IngestState, Job, JobState, Millis, Page, ScanEntry, Source,
};
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{
    AuditRepo, ChunkRepo, CollectionRepo, IngestProgressRepo, IngestRepo, MetaStore, SourceRepo,
};
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::index::{FileIndexSpec, IndexService, IndexStage};
use crate::ingest::ProgressTracker;
use crate::jobs::queue::{JobQueue, NewJob, priority};
use crate::jobs::worker::{JobHandler, SliceProgress};
use crate::upload::unpack::{self, UnpackLimits};
use crate::upload::{OP_INGEST_FILE, UploadObserver};

/// 解析任务的参数。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IngestPayload {
    /// 要处理的批次。
    pub batch_id: String,
    /// 目标 collection。
    pub collection: String,
}

/// `list_ingest` 的返回。
#[derive(Clone, Debug, Serialize)]
pub struct IngestStatus {
    /// 本页的文件。
    pub files: Vec<IngestFile>,
    /// 过滤后的总数。
    pub total: u64,
    /// 页码(1 起)。
    pub page: u32,
    /// 每页条数。
    pub page_size: u32,
}

/// 重试 / 释放隔离的结果。
#[derive(Clone, Debug, Serialize)]
pub struct RetryReport {
    /// 重新入队的文件 id。
    pub requeued: Vec<String>,
    /// 跳过的文件(状态不允许)。
    pub skipped: Vec<String>,
    /// 解析任务 id。
    pub job_id: Option<String>,
}

/// 解析队列服务(入队 / 列表 / 重试 / 释放隔离)。
pub struct IngestService {
    meta: Arc<dyn MetaStore>,
    queue: JobQueue,
}

impl IngestService {
    /// 构造。
    pub fn new(meta: Arc<dyn MetaStore>) -> Self {
        Self {
            queue: JobQueue::new(meta.clone()),
            meta,
        }
    }

    /// 分页列出解析队列。
    pub async fn list(&self, filter: IngestFilter, page: Page) -> Result<IngestStatus> {
        let total = IngestRepo::count(self.meta.as_ref(), filter.clone()).await?;
        let files = IngestRepo::list(self.meta.as_ref(), filter, page).await?;
        Ok(IngestStatus {
            files,
            total,
            page: page.offset / page.limit.max(1) + 1,
            page_size: page.limit,
        })
    }

    /// 把失败 / 隔离 / 跳过的文件重新入队(不重新上传),并投递解析任务。
    pub async fn retry(&self, ids: &[String]) -> Result<RetryReport> {
        let mut requeued = Vec::new();
        let mut skipped = Vec::new();
        // 一批 id 可能来自多个批次(界面上多选就是这样),每个批次都要自己一条解析任务;
        // 而且必须先把批次从 done 拨回 running,否则任务一进来就跑完(见 `reopen_batch`)——
        // 用户看到的就是“点了重试什么都没发生”。
        let mut batches: Vec<(String, String)> = Vec::new();
        for id in ids {
            let Some(file) = IngestRepo::get(self.meta.as_ref(), id).await? else {
                skipped.push(id.clone());
                continue;
            };
            if !matches!(
                file.state,
                IngestState::Failed | IngestState::Quarantined | IngestState::Skipped
            ) {
                skipped.push(id.clone());
                continue;
            }
            // 被隔离过的文件字节在 `.quarantine/<id>/` 里:重试前先挪回原位,
            // 否则重试必然是“读取失败”
            restore_quarantined(&file);
            IngestRepo::set_state(self.meta.as_ref(), id, IngestState::Queued, None).await?;
            requeued.push(id.clone());
            if let Some(batch_id) = &file.batch_id
                && !batches.iter().any(|(seen, _)| seen == batch_id)
            {
                batches.push((batch_id.clone(), file.collection.clone()));
            }
        }
        let mut job_id = None;
        for (batch_id, collection) in &batches {
            self.reopen_batch(batch_id).await?;
            let job = self.enqueue(batch_id, collection).await?;
            job_id.get_or_insert(job.id);
        }
        Ok(RetryReport {
            requeued,
            skipped,
            job_id,
        })
    }

    /// 释放隔离:把文件移回 `queued` 并重新入队。
    pub async fn release_quarantine(&self, id: &str) -> Result<IngestFile> {
        let file = IngestRepo::get(self.meta.as_ref(), id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("ingest file {id}")))?;
        if file.state != IngestState::Quarantined {
            return Err(KbError::InvalidInput(format!(
                "{} 的状态是 {},只有 quarantined 可以释放",
                file.rel_path,
                file.state.as_str()
            )));
        }
        // 隔离时字节被挪到了 `.quarantine/<id>/`:不挪回来就直接重跑,解析拿到的是
        // “文件不存在”,用户看到的就是“释放了还是失败”
        restore_quarantined(&file);
        IngestRepo::set_state(self.meta.as_ref(), id, IngestState::Queued, None).await?;
        if let Some(batch_id) = &file.batch_id {
            // 批次早就 done 了:不拨回 running,投出去的任务在 `run_slice` 开头就
            // 判定“批次已结束”直接收尾,文件永远停在 queued
            self.reopen_batch(batch_id).await?;
            self.enqueue(batch_id, &file.collection).await?;
        }
        IngestRepo::get(self.meta.as_ref(), id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("ingest file {id}")))
    }

    /// 把批次拨回 `running`(只拨 `done` 的),返回是否真的拨了。
    ///
    /// 解析任务的 `run_slice` 一开头就看批次状态:`done` / `canceled` 直接收尾,`paused` 直接让出。
    /// 所以重跑一个已经收尾的批次里的文件,必须先把状态拨回来 —— 这是“重试 / 释放隔离点了没反应”
    /// 的根因。`paused` / `canceled` 是用户主动按下的,不去覆盖。
    async fn reopen_batch(&self, batch_id: &str) -> Result<bool> {
        let Some(batch) = IngestProgressRepo::ingest_batch(self.meta.as_ref(), batch_id).await?
        else {
            return Ok(false);
        };
        if batch.state != IngestBatchState::Done {
            return Ok(false);
        }
        IngestProgressRepo::set_ingest_batch_state(
            self.meta.as_ref(),
            batch_id,
            IngestBatchState::Running,
            now_millis(),
        )
        .await?;
        Ok(true)
    }

    /// 启动恢复:上次进程被杀时正在解析的文件回到 `queued`。
    ///
    /// 领取文件时状态就变成 `extracting`(并发领取靠它占位),进程被杀后会留下卡在
    /// `extracting` / `chunking` / `embedding` 的行:它们既不在队列里(不会重跑),也不算完成
    /// (进度永远差几个),批次还会因为“没有 queued 了”提前收尾。
    ///
    /// 恢复时把它们拨回 `queued` 并从「类型识别」起清掉阶段事件(重跑就是一条干净的路径;
    /// 已经写进索引的块按同一套 chunk id 覆盖,不会重复)。已完成 / 暂停的批次不动;
    /// 被取消的批次跟 `cancel` 一样落成 `failed`,不重新入队。
    pub async fn recover_inflight(&self) -> Result<u64> {
        let files = IngestRepo::list_inflight(self.meta.as_ref()).await?;
        let mut recovered = 0u64;
        // 批次 → collection:恢复完统一补一遍批次状态与任务
        let mut batches: Vec<(String, String)> = Vec::new();
        for file in files {
            let batch_state = match &file.batch_id {
                Some(batch_id) => IngestProgressRepo::ingest_batch(self.meta.as_ref(), batch_id)
                    .await?
                    .map(|batch| batch.state)
                    .unwrap_or(IngestBatchState::Running),
                None => IngestBatchState::Running,
            };
            if batch_state == IngestBatchState::Canceled {
                IngestRepo::finish(
                    self.meta.as_ref(),
                    &file.id,
                    IngestState::Failed,
                    0,
                    0,
                    0,
                    Some("批次已取消"),
                )
                .await?;
                recovered += 1;
                continue;
            }
            IngestProgressRepo::reset_stages_from(
                self.meta.as_ref(),
                &file.id,
                IngestStage::Detect,
            )
            .await?;
            IngestRepo::set_state(self.meta.as_ref(), &file.id, IngestState::Queued, None).await?;
            recovered += 1;
            if let Some(batch_id) = &file.batch_id
                && !batches.iter().any(|(seen, _)| seen == batch_id)
            {
                batches.push((batch_id.clone(), file.collection.clone()));
            }
        }
        for (batch_id, collection) in &batches {
            // 收尾过的批次里本不该有在途文件(真有就是收尾与状态写入之间被杀):拨回来
            let reopened = self.reopen_batch(batch_id).await?;
            // 正常重启时 `queue.recover` 已经把原任务放回队列,不能重复投;
            // 只有原任务已经结束(没活任务了)才补一条,否则文件会一直停在 queued
            if reopened || !self.has_live_job(batch_id).await? {
                self.enqueue(batch_id, collection).await?;
            }
        }
        Ok(recovered)
    }

    /// 这个批次是否已经有排队 / 运行中的解析任务(恢复时用来避免投重复任务)。
    async fn has_live_job(&self, batch_id: &str) -> Result<bool> {
        for state in [JobState::Queued, JobState::Running] {
            for job in self.queue.list(Some(state)).await? {
                if job.kind != "ingest" {
                    continue;
                }
                let payload: Value = serde_json::from_str(&job.payload_json).unwrap_or_default();
                if payload.get("batch_id").and_then(Value::as_str) == Some(batch_id) {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// 投递一个批次的解析任务。
    ///
    /// 首次投递用 `INGEST_UPLOAD`(90)而不是 `REVIEW_EXTRACT`(60):积压几百份文件时,
    /// 新上传要能插到下一片,否则用户传完几个小时都搜不到内容(生产上 p50 等 4.2 小时)。
    /// 优先级只决定**排队位置**,通道仍是批量(`ingest` 不算交互活,见 `jobs/slots.rs`)。
    pub async fn enqueue(&self, batch_id: &str, collection: &str) -> Result<Job> {
        self.queue
            .enqueue(NewJob {
                kind: "ingest".to_owned(),
                collection: Some(collection.to_owned()),
                priority: priority::INGEST_UPLOAD,
                payload: json!({ "batch_id": batch_id, "collection": collection }),
            })
            .await
    }
}

/// 写一条可撤销的 `ingest.file` 变更。
pub async fn record_ingest_change(
    audit: &dyn AuditRepo,
    batch_id: &str,
    ingest_id: &str,
    before: Option<Value>,
    after: Value,
) -> Result<()> {
    crate::revert::record_op(
        audit,
        batch_id,
        ingest_id,
        OP_INGEST_FILE,
        before,
        Some(after),
    )
    .await
}

/// 阶段写入任务收到的消息。
enum StageMsg {
    /// 进入一个阶段。
    Enter(IndexStage),
    /// 当前阶段失败(带上原因)。
    Failed(String),
}

/// 解析任务处理器。
pub struct IngestJobHandler {
    index: Arc<IndexService>,
    meta: Arc<dyn MetaStore>,
    paths: KbPaths,
    limits: UnpackLimits,
    slice_files: usize,
    /// 一片内同时准备几个文件。每次分片现读,热更新后下一片就生效(默认 1 = 逐个处理)。
    parallel_files: Arc<dyn Fn() -> usize + Send + Sync>,
    observer: Option<Arc<dyn UploadObserver>>,
    tracker: Arc<ProgressTracker>,
    /// 旧格式 Office 转换器(LibreOffice 无界面);`None` = 没开或没装,旧格式文件照旧进隔离。
    converter: Option<crate::office_convert::Converter>,
}

/// 一次抽取要用的输入:抽取器、要喂给它的字节,以及(转换过的文件)要记在索引里的原件哈希与大小。
struct ExtractInput {
    extractor: Arc<dyn kb_core::ports::Extractor>,
    bytes: Vec<u8>,
    /// 转换产物里有时间戳,每次转换的字节不一定相同;索引按原件的哈希判断「没变」,
    /// 所以转换过的文件要把原件的(哈希, 大小)带进来覆盖。
    identity: Option<(String, u64)>,
}

impl IngestJobHandler {
    /// 构造;`slice_files` 是每个分片处理多少个文件。
    pub fn new(
        index: Arc<IndexService>,
        meta: Arc<dyn MetaStore>,
        paths: KbPaths,
        limits: UnpackLimits,
        slice_files: usize,
        tracker: Arc<ProgressTracker>,
    ) -> Self {
        Self {
            index,
            meta,
            paths,
            limits,
            slice_files: slice_files.max(1),
            parallel_files: Arc::new(|| 1),
            observer: None,
            tracker,
            converter: None,
        }
    }

    /// 挂上「一片内并发解析几个文件」的取值函数:每次分片现读配置,改完不用重启。
    pub fn with_parallel_files(
        mut self,
        parallel_files: Arc<dyn Fn() -> usize + Send + Sync>,
    ) -> Self {
        self.parallel_files = parallel_files;
        self
    }

    /// 本片最多同时准备几个文件:配错 / 配成 0 也不能让分片卡死,统一收在 1..=8。
    fn parallel_window(&self) -> usize {
        (self.parallel_files)().clamp(1, IndexConfig::MAX_PARALLEL_FILES as usize)
    }

    /// 挂上观察者(WS 的 `ingest.status` / `ingest.stage`)。
    pub fn with_observer(mut self, observer: Arc<dyn UploadObserver>) -> Self {
        self.observer = Some(observer);
        self
    }

    /// 挂上旧格式 Office 转换器:没有抽取器的 doc / xls 等,转成 OOXML 再抽取、入库。
    /// **只为抽取而转换,原件不动**(路径、字节都不变)。
    pub fn with_converter(mut self, converter: crate::office_convert::Converter) -> Self {
        self.converter = Some(converter);
        self
    }

    /// 处理一个文件(返回产出的块数)。
    async fn process(&self, collection: &Collection, file: &IngestFile) -> Result<u64> {
        let started = Instant::now();
        // 1. 类型识别
        // 状态在领取时已经置为 `Extracting`(并发领取要靠它占住文件),这里不再重复写一次。
        let detect = self.begin_stage(file, IngestStage::Detect).await?;
        let path = std::path::PathBuf::from(&file.abs_path);
        if !path.is_file() {
            let reason = format!("文件不存在:{}", file.abs_path);
            self.end_stage(detect, IngestStageStatus::Failed, Some(&reason), 0, 0)
                .await?;
            self.finish(file, IngestState::Failed, 0, Some(&reason), started)
                .await?;
            return Ok(0);
        }
        let head = read_head(&path, 4096);
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        // :魔数优先、扩展名兜底;文本类走原来的索引路径,二进制格式交给抽取器
        let detected = kb_extract::detect::detect(&head, extension);
        // 只有“真的是压缩包”才解包:docx / xlsx / pptx 也是 zip 容器,不能当压缩包拆开
        let is_zip = unpack::looks_like_zip(&head)
            && matches!(
                detected.kind,
                kb_extract::Kind::Zip | kb_extract::Kind::Archive
            );
        // 扩展名说是文本、但内容里有 NUL:多半是坏文件或改错的扩展名,不硬索引
        let looks_binary = head.contains(&0u8);
        let text_like =
            (detected.kind.is_text_like() || !detected.kind.is_binary()) && !looks_binary;
        self.end_stage(detect, IngestStageStatus::Ok, None, 0, 0)
            .await?;

        // 2. 解析 / 抽取(压缩包解包、格式识别都在这一段)
        let extract = self.begin_stage(file, IngestStage::Extract).await?;
        if detected.kind == kb_extract::Kind::Eml {
            return self
                .index_email(collection, file, &path, started, extract)
                .await;
        }
        if !text_like && !is_zip {
            // :有抽取器就走“抽取 → DocChunker → 索引”这条链路
            let registry = kb_extract::registry::global();
            if let Some((extractor, _)) = registry.pick(&head, extension) {
                return self
                    .index_extracted(collection, file, &path, extractor, started, extract)
                    .await;
            }
            // 旧格式 Office(doc / xls …)没有抽取器:装了转换器、并且这种扩展名有真实样本验证过,
            // 就转成 OOXML 再抽取;其余(含 ppt 等没验证过的)照旧进隔离
            if let Some(converter) = &self.converter
                && crate::office_convert::Target::is_verified_extension(extension)
            {
                return self
                    .index_converted(collection, file, &path, converter, started, extract)
                    .await;
            }
            // 还没有抽取器 / 转换器的格式:记 `skipped` 并**保留原件**。
            // 这不是文件坏了,是能力还没装;挪走原件会让用户在列表里点开一片空白、
            // 下载 404 —— 装上抽取器后重跑就能补上
            let reason = if looks_binary && detected.kind.is_text_like() {
                "内容里有 NUL 字节,疑似二进制或损坏文件".to_owned()
            } else {
                format!(
                    "{} 还没有抽取器,已跳过(装上抽取器 / 转换器后重跑即可)",
                    detected.kind.label()
                )
            };
            self.end_stage(extract, IngestStageStatus::Skipped, Some(&reason), 0, 0)
                .await?;
            self.finish(file, IngestState::Skipped, 0, Some(&reason), started)
                .await?;
            return Ok(0);
        }
        if is_zip {
            return self.unpack_archive(file, &path, started, extract).await;
        }
        self.end_stage(extract, IngestStageStatus::Ok, None, 0, 0)
            .await?;

        // 3. 分块 / 向量化 / 写入索引(由索引回调推进阶段事件)
        self.index_file(collection, file, &path, started).await
    }

    /// 索引一个普通文本文件。
    async fn index_file(
        &self,
        collection: &Collection,
        file: &IngestFile,
        path: &std::path::Path,
        started: Instant,
    ) -> Result<u64> {
        // 取消可能在准备期间发生:`cancel` 已经把这个文件回滚成 failed,再写就留下孤儿块。
        if self.batch_canceled(file).await {
            // 取消来在准备期间:`cancel` 已经把这个文件回滚成 failed,再写就留下孤儿块
            self.finish(file, IngestState::Failed, 0, Some("批次已取消"), started)
                .await?;
            return Ok(0);
        }
        let metadata = std::fs::metadata(path)
            .map_err(|err| KbError::Internal(format!("读取 {} 失败: {err}", path.display())))?;
        let entry = ScanEntry {
            path: path.to_path_buf(),
            relative: file.rel_path.clone(),
            size: metadata.len(),
            mtime: crate::index::millis_of(&metadata),
            lang: kb_index::detect_lang(path).to_owned(),
            kind: kb_index::kind_of(path),
        };
        let spec = FileIndexSpec {
            source: file.rel_path.clone(),
            kind: entry.kind,
            tags: self.source_tags(file).await?,
        };
        let name = self.source_name(file).await?;

        // 阶段回调是同步的:通过 channel 交给一个并发任务写库与写阶段事件,
        // 这样 embedding 期间(唯一的长时间 await)状态也能推进。
        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<StageMsg>();
        let writer = tokio::spawn(stage_writer(
            self.meta.clone(),
            self.observer.clone(),
            file.id.clone(),
            file.batch_id.clone(),
            receiver,
        ));
        let stage_sender = sender.clone();
        let on_stage = move |stage: IndexStage| {
            let _ = stage_sender.send(StageMsg::Enter(stage));
        };
        let result = self
            .index
            .index_entry_with_stages(&name, collection, &entry, &spec, now_millis(), &on_stage)
            .await;
        if let Err(err) = &result {
            let _ = sender.send(StageMsg::Failed(err.to_string()));
        }
        // 两个发送端都要丢掉,写库任务才会收到“通道关闭”并结束
        drop(on_stage);
        drop(sender);
        let _ = writer.await;

        match result {
            Ok(stats) => {
                let chunks = stats.chunks as u64;
                // 上传 / 同步进来的文本文件:入库时落一条版本(同名文件被重新上传时接在后面),
                // 文件的历史从「刚进来的那一版」开始。数据源同步只动用户目录的原件,一次几千个文件,
                // 只有已经在版本表里的(上传过的、被在线编辑过的)才继续记
                let versioned = file.upload_id.is_some()
                    || crate::edit::has_versions(
                        self.meta.as_ref(),
                        &file.collection,
                        &file.rel_path,
                    )
                    .await
                    .unwrap_or(false);
                if versioned
                    && let Ok((body, _)) = crate::edit::read_with_encoding(path)
                    && let Err(err) = crate::edit::record_version_from_content(
                        self.meta.as_ref(),
                        &file.collection,
                        &file.rel_path,
                        &body,
                        "upload",
                    )
                    .await
                {
                    tracing::warn!(path = %file.rel_path, error = %err, "记入库版本失败");
                }
                let searchable = self.begin_stage(file, IngestStage::Searchable).await?;
                self.end_stage(searchable, IngestStageStatus::Ok, None, chunks, chunks)
                    .await?;
                self.finish(file, IngestState::Done, chunks, None, started)
                    .await?;
                // 附件索引完成后补 `derived_from` 边(邮件抽取时登记的父子关系)
                self.record_derived(file).await;
                Ok(chunks)
            }
            Err(err) => {
                self.finish(
                    file,
                    IngestState::Failed,
                    0,
                    Some(&err.to_string()),
                    started,
                )
                .await?;
                Ok(0)
            }
        }
    }

    /// 抽取二进制格式(PDF / Office …)并写入索引。
    async fn index_extracted(
        &self,
        collection: &Collection,
        file: &IngestFile,
        path: &std::path::Path,
        extractor: Arc<dyn kb_core::ports::Extractor>,
        started: Instant,
        extract: i64,
    ) -> Result<u64> {
        // 读文件和抽取都放进阻塞线程池:整文件读入和 OOXML 的同步解析会占住异步工作线程,
        // 同线程上的检索、保存、协作请求跟着排队;抽取器 panic 也会变成错误,走下面的隔离
        let bytes = crate::upload::offload::read_file(path).await?;
        let input = ExtractInput {
            extractor,
            bytes,
            identity: None,
        };
        self.index_extracted_input(collection, file, path, input, started, extract)
            .await
    }

    /// 旧格式 Office:转成 OOXML 再抽取。转换只为抽取,原件不动;转换失败进隔离并写明原因。
    async fn index_converted(
        &self,
        collection: &Collection,
        file: &IngestFile,
        path: &std::path::Path,
        converter: &crate::office_convert::Converter,
        started: Instant,
        extract: i64,
    ) -> Result<u64> {
        let original = crate::upload::offload::read_file(path).await?;
        // 原件的(哈希, 大小):索引按它判断「没变」,不能用每次都可能不同的转换产物的
        let identity = (
            crate::index::pipeline::file_hash(&original),
            original.len() as u64,
        );
        drop(original);
        let (target, bytes) = match converter.convert(path).await {
            Ok(done) => done,
            Err(err) => {
                // 转换失败:记 `failed` 并保留原件(挪走原件 = 用户打不开也下不了)
                let reason = format!("旧格式转换失败:{err}");
                self.end_stage(extract, IngestStageStatus::Failed, Some(&reason), 0, 0)
                    .await?;
                self.finish(file, IngestState::Failed, 0, Some(&reason), started)
                    .await?;
                return Ok(0);
            }
        };
        let head_len = bytes.len().min(4096);
        let registry = kb_extract::registry::global();
        let Some((extractor, _)) = registry.pick(&bytes[..head_len], target.extension()) else {
            let reason = format!(
                "旧格式转换失败:转成 {} 后没有对应的抽取器",
                target.extension()
            );
            self.end_stage(extract, IngestStageStatus::Skipped, Some(&reason), 0, 0)
                .await?;
            self.finish(file, IngestState::Skipped, 0, Some(&reason), started)
                .await?;
            return Ok(0);
        };
        let input = ExtractInput {
            extractor,
            bytes,
            identity: Some(identity),
        };
        self.index_extracted_input(collection, file, path, input, started, extract)
            .await
    }

    /// 抽取 → 分块 → 向量化 → 入库(`index_extracted` 与 `index_converted` 共用)。
    async fn index_extracted_input(
        &self,
        collection: &Collection,
        file: &IngestFile,
        path: &std::path::Path,
        input: ExtractInput,
        started: Instant,
        extract: i64,
    ) -> Result<u64> {
        let ExtractInput {
            extractor,
            bytes,
            identity,
        } = input;
        let source = kb_core::model::SourceRef {
            scheme: "file".to_owned(),
            location: file.rel_path.clone(),
            project_root: None,
        };
        let (doc, file_hash, file_size) =
            match crate::upload::offload::extract_off_runtime(extractor, source, bytes).await {
                Ok(extracted) => match identity {
                    Some((hash, size)) => (extracted.doc, hash, size),
                    None => (extracted.doc, extracted.file_hash, extracted.size),
                },
                Err(err) => {
                    // 坏文件 / 加密 / 解析器崩溃:记 `failed` 并写明原因,**不挪走原件**。
                    // 挪走会让用户在列表里看到文件却打不开、下不了(预览空白、下载 404),
                    // 而“这份文件解析失败”完全可以只看状态;临时性错误往上报,下次还会重试
                    let reason = err.to_string();
                    self.end_stage(extract, IngestStageStatus::Failed, Some(&reason), 0, 0)
                        .await?;
                    if matches!(err, KbError::Unavailable(_)) {
                        return Err(err);
                    }
                    self.finish(file, IngestState::Failed, 0, Some(&reason), started)
                        .await?;
                    return Ok(0);
                }
            };
        // 解析队列的「内容」列:从锚点统计页数 / 表数 / 幻灯片(写进 ingest_files.extract_meta)
        let meta = kb_core::model::ExtractMeta::from_doc(&doc);
        match serde_json::to_string(&meta) {
            Ok(text) => {
                if let Err(err) =
                    IngestRepo::set_extract_meta(self.meta.as_ref(), &file.id, Some(&text)).await
                {
                    // 元信息不是关键数据,不拦入库;但要留下线索,否则「内容」列会无声退回块数
                    tracing::warn!(error = %err, file = %file.id, "写 extract_meta 失败");
                }
            }
            Err(err) => tracing::warn!(error = %err, file = %file.id, "序列化 extract_meta 失败"),
        }
        let chunker = kb_extract::DocChunkerImpl::new(kb_extract::DocChunkOptions::from_config(
            512,
            self.source_name(file).await?,
        ));
        let mut chunks = kb_core::ports::DocChunker::chunk_doc(&chunker, &doc);
        // 与项目扫描同一个上限:一份数据导出的 Excel 能拆出几万块,占着解析队列几个小时
        let total_chunks = chunks.len();
        chunks.truncate(crate::index::RICH_DOC_MAX_CHUNKS);
        let truncated_note = (total_chunks > chunks.len()).then(|| {
            format!(
                "内容较多,只索引了前 {} 块(共 {total_chunks} 块);查看和编辑读的是原文件,不受影响",
                chunks.len()
            )
        });
        self.end_stage(extract, IngestStageStatus::Ok, None, 0, 0)
            .await?;
        if chunks.is_empty() {
            // 图片没做 OCR / 音视频没做转写时,抽取是成功的、只是没有可索引文本:
            // 记 `skipped` 而不是 `failed`,文件仍然入库(开关两种配置都要求能入库)
            let reason = format!(
                "{} 没有可索引的文本(图片需 OCR、音视频需转写;见 [extract] 配置)",
                detected_label(file)
            );
            self.finish(file, IngestState::Skipped, 0, Some(&reason), started)
                .await?;
            return Ok(0);
        }

        let metadata = std::fs::metadata(path).ok();
        let doc_src = kb_core::model::SourceDoc {
            source: file.rel_path.clone(),
            lang: doc.meta.lang.clone(),
            text: doc.text(),
            file_hash,
            size: file_size,
            mtime: metadata
                .as_ref()
                .map(crate::index::millis_of)
                .unwrap_or_default(),
            project_name: doc.meta.project_name.clone(),
        };
        let spec = FileIndexSpec {
            source: file.rel_path.clone(),
            kind: kb_core::model::FileKind::Doc,
            tags: self.source_tags(file).await?,
        };

        // 抽取 / 分块已经并行做完了,从这里开始提交:嵌入 + 写 LanceDB + 收尾。
        // 多个文件一起提交时,写入撞上 commit conflict 由存储层退避重试。
        if self.batch_canceled(file).await {
            self.finish(file, IngestState::Failed, 0, Some("批次已取消"), started)
                .await?;
            return Ok(0);
        }

        let (sender, receiver) = tokio::sync::mpsc::unbounded_channel::<StageMsg>();
        let writer = tokio::spawn(stage_writer(
            self.meta.clone(),
            self.observer.clone(),
            file.id.clone(),
            file.batch_id.clone(),
            receiver,
        ));
        let stage_sender = sender.clone();
        let on_stage = move |stage: IndexStage| {
            let _ = stage_sender.send(StageMsg::Enter(stage));
        };
        let chunk_event = self.begin_stage(file, IngestStage::Chunk).await?;
        self.end_stage(
            chunk_event,
            IngestStageStatus::Ok,
            None,
            chunks.len() as u64,
            0,
        )
        .await?;
        let result = self
            .index
            .index_prepared_chunks(&doc_src, collection, &spec, chunks, now_millis(), &on_stage)
            .await;
        if let Err(err) = &result {
            let _ = sender.send(StageMsg::Failed(err.to_string()));
        }
        drop(on_stage);
        drop(sender);
        let _ = writer.await;

        match result {
            Ok(stats) => {
                let chunks = stats.chunks as u64;
                let searchable = self.begin_stage(file, IngestStage::Searchable).await?;
                self.end_stage(searchable, IngestStageStatus::Ok, None, chunks, chunks)
                    .await?;
                self.finish(
                    file,
                    IngestState::Done,
                    chunks,
                    truncated_note.as_deref(),
                    started,
                )
                .await?;
                // 压缩包里的 PDF / HTML 等走的是这条链路,同样要补派生边
                self.record_derived(file).await;
                Ok(chunks)
            }
            Err(err) => {
                self.finish(
                    file,
                    IngestState::Failed,
                    0,
                    Some(&err.to_string()),
                    started,
                )
                .await?;
                Ok(0)
            }
        }
    }

    /// 邮件:正文走抽取链路,附件落盘后各自入队。
    async fn index_email(
        &self,
        collection: &Collection,
        file: &IngestFile,
        path: &std::path::Path,
        started: Instant,
        extract: i64,
    ) -> Result<u64> {
        // 读文件、解析邮件(含附件解码)都放进阻塞线程池
        let bytes = crate::upload::offload::read_file(path).await?;
        let message =
            crate::upload::offload::blocking(move || kb_extract::parse_eml(&bytes)).await?;

        // 附件落到 `<数据源目录>/<邮件目录>/<邮件名>/<附件名>`,再各自入队
        let parent = match file.rel_path.rsplit_once('/') {
            Some((dir, _)) => format!("{dir}/"),
            None => String::new(),
        };
        let stem = std::path::Path::new(&file.rel_path)
            .file_stem()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| "mail".to_owned());
        let base_dir = path.parent().unwrap_or(std::path::Path::new("."));
        let mut created = 0usize;
        let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();
        for attachment in message.attachments {
            let filename = unique_attachment_name(&attachment.filename, &mut used_names);
            let rel_path = format!("{parent}{stem}/{filename}");
            let target = base_dir.join(&stem).join(&filename);
            // 建目录、写附件、算哈希放进阻塞线程池;附件字节移进去,不再多拷一份
            let write_target = target.clone();
            let written = crate::upload::offload::blocking(move || {
                if let Some(dir) = write_target.parent()
                    && std::fs::create_dir_all(dir).is_err()
                {
                    return None;
                }
                std::fs::write(&write_target, &attachment.data).ok()?;
                Some((
                    attachment.data.len() as u64,
                    kb_core::hash::sha256_hex_bytes(&attachment.data),
                ))
            })
            .await?;
            let Some((size, sha256)) = written else {
                continue;
            };
            let child = IngestFile {
                id: uuid::Uuid::now_v7().to_string(),
                batch_id: file.batch_id.clone(),
                source_id: file.source_id.clone(),
                upload_id: file.upload_id.clone(),
                collection: file.collection.clone(),
                rel_path: rel_path.clone(),
                abs_path: target.display().to_string(),
                size,
                sha256: Some(sha256),
                state: IngestState::Queued,
                error: None,
                chunks: 0,
                vectors: 0,
                extract_meta: None,
                // 附件 → 邮件:父条目写在行里,进程重启后重新处理这个附件仍能补上边
                derived_from: Some(file.rel_path.clone()),
                elapsed_ms: None,
                created_at: now_millis(),
                updated_at: now_millis(),
            };
            IngestRepo::create(self.meta.as_ref(), child.clone()).await?;
            if let Some(batch_id) = &file.batch_id {
                record_ingest_change(
                    self.meta.as_ref(),
                    batch_id,
                    &child.id,
                    None,
                    json!({
                        "ingest_id": child.id,
                        "collection": child.collection,
                        "rel_path": child.rel_path,
                        "source_id": child.source_id,
                        "abs_path": child.abs_path,
                        "sha256": child.sha256,
                        "size": child.size,
                    }),
                )
                .await?;
            }
            // 父子关系落在行里(不再放进程内的表):附件索引完成后由 `record_derived` 写边
            created += 1;
        }

        // 正文:复用通用抽取链路
        let extractor: Arc<dyn kb_core::ports::Extractor> = Arc::new(kb_extract::EmlExtractor);
        let chunks = self
            .index_extracted(collection, file, path, extractor, started, extract)
            .await?;
        tracing::info!(mail = %file.rel_path, attachments = created, "邮件已抽取");
        Ok(chunks)
    }

    /// 附件 / 压缩包内文件索引完成后,补一条 `derived_from` 边(子 → 父)。
    ///
    /// 父条目的相对路径来自行里的 `derived_from`(不再依赖进程内的表),
    /// 所以进程重启后重新处理这个文件时同样能把边补上。
    async fn record_derived(&self, file: &IngestFile) {
        let Some(parent) = file.derived_from.clone() else {
            return;
        };
        if let Err(err) = self
            .add_derived_edge(&file.collection, &file.rel_path, &parent)
            .await
        {
            tracing::warn!(error = %err, path = %file.rel_path, "写 derived_from 边失败");
        }
    }

    /// 写一条“`rel_path` → `path:parent`”的 `derived_from` 边(已存在时幂等)。
    ///
    /// 返回是否真的写到了边:子条目一块都没有(例如空压缩包里的嵌套压缩包)时没有可指向的块,
    /// 只能跳过。
    async fn add_derived_edge(
        &self,
        collection: &str,
        rel_path: &str,
        parent: &str,
    ) -> Result<bool> {
        let chunks = ChunkRepo::by_path(self.meta.as_ref(), collection, rel_path).await?;
        let Some(first) = chunks.first() else {
            return Ok(false);
        };
        let edge = kb_core::model::Edge {
            src_id: first.id.clone(),
            dst: format!("path:{parent}"),
            rel: kb_core::model::EdgeRel::DerivedFrom,
            created_at: now_millis(),
        };
        kb_core::ports::repo::EdgeRepo::add(self.meta.as_ref(), edge).await?;
        Ok(true)
    }

    /// 批次收尾时补齐缺失的派生边,返回补了几条。
    ///
    /// 覆盖“子条目已经写完状态、边还没来得及写”这个崩溃窗口:重启后任务把批次跑完时,
    /// 已经没有 `queued` 文件了,不会再有 `record_derived` 的机会,只能在这里按行补。
    async fn repair_derived_edges(&self, collection: &str, batch_id: &str) -> Result<u64> {
        let rows = IngestRepo::derived_done(self.meta.as_ref(), batch_id).await?;
        let mut repaired = 0u64;
        for (rel_path, parent) in rows {
            match self.add_derived_edge(collection, &rel_path, &parent).await {
                Ok(true) => repaired += 1,
                Ok(false) => {}
                Err(err) => {
                    tracing::warn!(error = %err, path = %rel_path, "补齐 derived_from 边失败");
                }
            }
        }
        Ok(repaired)
    }

    /// 解包一个压缩包,并把里面的文件逐个入队。
    async fn unpack_archive(
        &self,
        file: &IngestFile,
        path: &std::path::Path,
        started: Instant,
        extract: i64,
    ) -> Result<u64> {
        let dest = path.with_extension("");
        // 整个压缩包读入内存、逐条解压、逐文件算哈希都是同步重活:放进阻塞线程池,
        // 哈希也在里面一并算完,回到异步任务里只做入队
        let (archive, target, limits) = (path.to_path_buf(), dest.clone(), self.limits);
        let unpacked = crate::upload::offload::blocking(move || {
            unpack::unpack_zip(&archive, &target, limits).map(|outcome| {
                let hashes: Vec<Option<String>> = outcome
                    .files
                    .iter()
                    .map(|entry| sha256_hex_file(&entry.abs_path).ok())
                    .collect();
                (outcome, hashes)
            })
        })
        .await?;
        match unpacked {
            Ok((outcome, hashes)) => {
                self.end_stage(extract, IngestStageStatus::Ok, None, 0, 0)
                    .await?;
                let parent = match file.rel_path.rsplit_once('/') {
                    Some((dir, _)) => format!("{dir}/"),
                    None => String::new(),
                };
                let stem = std::path::Path::new(&file.rel_path)
                    .file_stem()
                    .map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "unpacked".to_owned());
                let mut created = 0usize;
                for (entry, sha256) in outcome.files.iter().zip(hashes) {
                    let child = IngestFile {
                        id: uuid::Uuid::now_v7().to_string(),
                        batch_id: file.batch_id.clone(),
                        source_id: file.source_id.clone(),
                        upload_id: file.upload_id.clone(),
                        collection: file.collection.clone(),
                        rel_path: format!("{parent}{stem}/{}", entry.rel_path),
                        abs_path: entry.abs_path.display().to_string(),
                        size: entry.size,
                        sha256,
                        state: IngestState::Queued,
                        error: None,
                        chunks: 0,
                        vectors: 0,
                        extract_meta: None,
                        // 压缩包里的文件 → 压缩包:入库后写 `derived_from` 边
                        derived_from: Some(file.rel_path.clone()),
                        elapsed_ms: None,
                        created_at: now_millis(),
                        updated_at: now_millis(),
                    };
                    IngestRepo::create(self.meta.as_ref(), child.clone()).await?;
                    if let Some(batch_id) = &file.batch_id {
                        record_ingest_change(
                            self.meta.as_ref(),
                            batch_id,
                            &child.id,
                            None,
                            json!({
                                "ingest_id": child.id,
                                "collection": child.collection,
                                "rel_path": child.rel_path,
                                "source_id": child.source_id,
                                "abs_path": child.abs_path,
                                "sha256": child.sha256,
                                "size": child.size,
                            }),
                        )
                        .await?;
                    }
                    created += 1;
                }
                // 压缩包本身不算“入库文件”:块数记为 0,状态完成
                let searchable = self.begin_stage(file, IngestStage::Searchable).await?;
                self.end_stage(searchable, IngestStageStatus::Ok, None, 0, 0)
                    .await?;
                self.finish(file, IngestState::Done, 0, None, started)
                    .await?;
                tracing::info!(archive = %file.rel_path, files = created, "压缩包已解包");
                Ok(0)
            }
            Err(error) => {
                let unsafe_entry = error.is_unsafe();
                if unsafe_entry {
                    // 隔离:把恶意 / 越界的压缩包挪出数据源目录,并清掉半成品
                    self.quarantine(file, path).await;
                }
                if dest.exists() {
                    let _ = std::fs::remove_dir_all(&dest);
                }
                let status = if unsafe_entry {
                    IngestStageStatus::Quarantined
                } else {
                    IngestStageStatus::Failed
                };
                self.end_stage(extract, status, Some(&error.to_string()), 0, 0)
                    .await?;
                self.finish(
                    file,
                    if unsafe_entry {
                        IngestState::Quarantined
                    } else {
                        IngestState::Failed
                    },
                    0,
                    Some(&error.to_string()),
                    started,
                )
                .await?;
                Ok(0)
            }
        }
    }

    /// 把隔离的文件挪到 `<KB_HOME>/sources/.quarantine/<id>/`,并回写新的路径。
    async fn quarantine(&self, file: &IngestFile, path: &std::path::Path) {
        let dir = self.paths.sources_dir().join(".quarantine").join(&file.id);
        let target = dir.join(
            path.file_name()
                .map(|value| value.to_os_string())
                .unwrap_or_else(|| std::ffi::OsString::from("quarantined")),
        );
        let moved = std::fs::create_dir_all(&dir)
            .and_then(|()| std::fs::rename(path, &target))
            .is_ok();
        if moved {
            let _ = IngestRepo::set_state(
                self.meta.as_ref(),
                &file.id,
                IngestState::Quarantined,
                Some(&format!("已移入隔离区:{}", target.display())),
            )
            .await;
        }
    }

    async fn begin_stage(&self, file: &IngestFile, stage: IngestStage) -> Result<i64> {
        IngestProgressRepo::begin_stage(
            self.meta.as_ref(),
            &file.id,
            file.batch_id.as_deref(),
            stage,
            now_millis(),
        )
        .await
    }

    async fn end_stage(
        &self,
        event_id: i64,
        status: IngestStageStatus,
        error: Option<&str>,
        chunks: u64,
        vectors: u64,
    ) -> Result<()> {
        IngestProgressRepo::end_stage(
            self.meta.as_ref(),
            event_id,
            status,
            error,
            chunks,
            vectors,
            now_millis(),
        )
        .await
    }

    async fn set_state(&self, file: &IngestFile, state: IngestState) -> Result<()> {
        IngestRepo::set_state(self.meta.as_ref(), &file.id, state, None).await?;
        if let Some(observer) = &self.observer {
            let mut updated = file.clone();
            updated.state = state;
            observer.on_ingest(&updated);
        }
        Ok(())
    }

    async fn finish(
        &self,
        file: &IngestFile,
        state: IngestState,
        chunks: u64,
        error: Option<&str>,
        started: Instant,
    ) -> Result<()> {
        let elapsed = started.elapsed().as_millis() as u64;
        IngestRepo::finish(
            self.meta.as_ref(),
            &file.id,
            state,
            chunks,
            chunks,
            elapsed,
            error,
        )
        .await?;
        if let Some(observer) = &self.observer
            && let Some(updated) = IngestRepo::get(self.meta.as_ref(), &file.id).await?
        {
            observer.on_ingest(&updated);
        }
        Ok(())
    }

    /// 数据源的名字(块头里用)。
    async fn source_name(&self, file: &IngestFile) -> Result<String> {
        Ok(self
            .source(file)
            .await?
            .map(|source: Source| source.name)
            .unwrap_or_else(|| "上传".to_owned()))
    }

    /// 数据源的标签(传到块的 tags 上)。
    ///
    /// 网页来源的 AI 规范化结果再加一个 `ai-extract`:检索时能单独看或排除它们。
    async fn source_tags(&self, file: &IngestFile) -> Result<Vec<String>> {
        let mut tags = self
            .source(file)
            .await?
            .map(|source| source.tags)
            .unwrap_or_default();
        if crate::web_extract::is_ai_output(file)
            && !tags.iter().any(|tag| tag == crate::web_extract::AI_TAG)
        {
            tags.push(crate::web_extract::AI_TAG.to_owned());
        }
        Ok(tags)
    }

    async fn source(&self, file: &IngestFile) -> Result<Option<Source>> {
        let Some(source_id) = &file.source_id else {
            return Ok(None);
        };
        SourceRepo::get(self.meta.as_ref(), source_id).await
    }

    /// 批次当前状态(没有批次行时按“运行中”处理)。
    async fn batch_state(&self, batch_id: &str) -> Result<IngestBatchState> {
        Ok(
            IngestProgressRepo::ingest_batch(self.meta.as_ref(), batch_id)
                .await?
                .map(|batch| batch.state)
                .unwrap_or(IngestBatchState::Running),
        )
    }

    /// 这个文件所在的批次是否已被取消。
    ///
    /// 准备阶段可能跑很久,取消是这期间到的:`IngestService::cancel` 已经把在途文件回滚成
    /// `failed` 并清掉半成品块;这时若还照常提交,就会写出没有归属的块(取消 / 重试都清不掉)。
    async fn batch_canceled(&self, file: &IngestFile) -> bool {
        let Some(batch_id) = file.batch_id.as_deref() else {
            return false;
        };
        matches!(
            self.batch_state(batch_id).await,
            Ok(IngestBatchState::Canceled)
        )
    }

    /// 按节流规则推送一次批次进度。
    async fn publish(&self, batch_id: &str) {
        let Some(observer) = &self.observer else {
            return;
        };
        if !self.tracker.should_push(batch_id) {
            return;
        }
        match self.tracker.progress(batch_id, now_millis()).await {
            Ok(progress) => observer.on_batch_progress(&progress),
            Err(err) => tracing::warn!(error = %err, batch = %batch_id, "计算批次进度失败"),
        }
    }
}

/// 阶段写库任务:把索引回调推进成 `ingest_stage_events` 与 `ingest_files.state`。
async fn stage_writer(
    meta: Arc<dyn MetaStore>,
    observer: Option<Arc<dyn UploadObserver>>,
    file_id: String,
    batch_id: Option<String>,
    mut receiver: tokio::sync::mpsc::UnboundedReceiver<StageMsg>,
) {
    let mut open: Option<(i64, IngestStage)> = None;
    while let Some(message) = receiver.recv().await {
        match message {
            StageMsg::Enter(stage) => {
                close_stage(&meta, &mut open, IngestStageStatus::Ok, None, 0, 0).await;
                let next = match stage {
                    IndexStage::Chunking => IngestStage::Chunk,
                    IndexStage::Embedding => IngestStage::Embed,
                    IndexStage::Writing => IngestStage::Write,
                };
                let state = match next {
                    IngestStage::Chunk => IngestState::Chunking,
                    _ => IngestState::Embedding,
                };
                if let Ok(event_id) = IngestProgressRepo::begin_stage(
                    meta.as_ref(),
                    &file_id,
                    batch_id.as_deref(),
                    next,
                    now_millis(),
                )
                .await
                {
                    open = Some((event_id, next));
                }
                if IngestRepo::set_state(meta.as_ref(), &file_id, state, None)
                    .await
                    .is_ok()
                    && let Some(observer) = &observer
                    && let Ok(Some(updated)) = IngestRepo::get(meta.as_ref(), &file_id).await
                {
                    observer.on_ingest(&updated);
                }
            }
            StageMsg::Failed(error) => {
                close_stage(
                    &meta,
                    &mut open,
                    IngestStageStatus::Failed,
                    Some(&error),
                    0,
                    0,
                )
                .await;
            }
        }
    }
    close_stage(&meta, &mut open, IngestStageStatus::Ok, None, 0, 0).await;
}

async fn close_stage(
    meta: &Arc<dyn MetaStore>,
    open: &mut Option<(i64, IngestStage)>,
    status: IngestStageStatus,
    error: Option<&str>,
    chunks: u64,
    vectors: u64,
) {
    if let Some((event_id, _stage)) = open.take() {
        let _ = IngestProgressRepo::end_stage(
            meta.as_ref(),
            event_id,
            status,
            error,
            chunks,
            vectors,
            now_millis(),
        )
        .await;
    }
}

#[async_trait]
impl JobHandler for IngestJobHandler {
    async fn run_slice(&self, job: &Job) -> Result<SliceProgress> {
        let payload: IngestPayload = serde_json::from_str(&job.payload_json)
            .map_err(|err| KbError::InvalidInput(format!("解析任务参数非法: {err}")))?;
        let base = SliceProgress {
            done: job.progress_done,
            total: None,
            finished: false,
            checkpoint: None,
            errors: Vec::new(),
            rate_basis: 0,
            paused: false,
        };
        // 暂停 / 取消:在取新文件之前先看批次状态
        match self.batch_state(&payload.batch_id).await? {
            IngestBatchState::Running => {}
            IngestBatchState::Paused => {
                return Ok(SliceProgress {
                    paused: true,
                    ..base
                });
            }
            IngestBatchState::Canceled | IngestBatchState::Done => {
                return Ok(SliceProgress {
                    finished: true,
                    ..base
                });
            }
        }

        // 写闸门:先拿读锁,再读 collection(迁移可能刚切换了 active 表)
        let _writer = self.index.write_gate().writer().await;
        let collection = CollectionRepo::get(self.meta.as_ref(), &payload.collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {}", payload.collection)))?;

        let total = IngestRepo::count(
            self.meta.as_ref(),
            IngestFilter {
                collection: None,
                batch_id: Some(payload.batch_id.clone()),
                source_id: None,
                state: None,
            },
        )
        .await?;
        let mut done = job.progress_done;
        let mut chunks = 0u64;
        let mut errors = Vec::new();
        let mut seen: HashSet<String> = HashSet::new();
        let mut paused = false;
        let mut rows_since_optimize = 0u64;
        // 一片内并发:窗口里是「准备中」的文件(读 → 抽取 / 转换 → 分块),
        // 提交按完成顺序一次一个 —— 见模块头。
        let parallel = self.parallel_window();
        let mut started = 0usize;
        let mut exhausted = false;
        let mut inflight = FuturesUnordered::new();
        loop {
            // 补满窗口:只在有空位时领新文件,领之前先看批次状态
            while !exhausted && inflight.len() < parallel && started < self.slice_files {
                match self.batch_state(&payload.batch_id).await? {
                    IngestBatchState::Running => {}
                    IngestBatchState::Paused => {
                        paused = true;
                        exhausted = true;
                        break;
                    }
                    IngestBatchState::Canceled | IngestBatchState::Done => {
                        exhausted = true;
                        break;
                    }
                }
                let Some(file) =
                    IngestRepo::next_queued(self.meta.as_ref(), Some(&payload.batch_id)).await?
                else {
                    exhausted = true;
                    break;
                };
                if !seen.insert(file.id.clone()) {
                    // 状态没推进(理论上不会发生):避免死循环
                    exhausted = true;
                    break;
                }
                // 领取即占位:窗口里有好几个文件时,下一次 `next_queued` 只有看到状态已
                // 不再是 `queued` 才不会把同一个文件再发一遍;取消时也能把它当在途文件回滚。
                self.set_state(&file, IngestState::Extracting).await?;
                started += 1;
                // 每个在途任务各持一份 collection:闭包按值捕获,不能反复借用同一份
                let task_collection = collection.clone();
                inflight.push(async move {
                    let produced = self.process(&task_collection, &file).await;
                    (file, produced)
                });
            }
            // 已领的跑完再收尾:暂停 / 取消只停止领取新的,不把在途文件丢在半路
            let Some((file, result)) = inflight.next().await else {
                break;
            };
            match result {
                Ok(produced) => {
                    chunks += produced;
                    rows_since_optimize += produced;
                    done += 1;
                }
                Err(err) => {
                    let message = err.to_string();
                    let _ = self
                        .finish(
                            &file,
                            IngestState::Failed,
                            0,
                            Some(&message),
                            Instant::now(),
                        )
                        .await;
                    errors.push(format!("{}: {message}", file.rel_path));
                    done += 1;
                }
            }
            // 写够一批就整理物理表,避免“越写越慢”
            if rows_since_optimize >= OPTIMIZE_EVERY_ROWS {
                if let Err(err) = self.index.optimize_locked(&collection).await {
                    tracing::warn!(error = %err, "整理物理表失败");
                }
                rows_since_optimize = 0;
            }
            // 每处理完一个文件推一次进度(内部按 ≤2 次/秒节流)
            self.publish(&payload.batch_id).await;
        }

        // 压缩包解出来的文件是处理中新加的:还剩 queued 就继续下一片
        let remaining = IngestRepo::count(
            self.meta.as_ref(),
            IngestFilter {
                collection: None,
                batch_id: Some(payload.batch_id.clone()),
                source_id: None,
                state: Some(IngestState::Queued),
            },
        )
        .await?;
        let finished = remaining == 0 && !paused;
        if finished {
            // 收尾前先把缺失的派生边补上(子条目写完状态、边还没写就崩溃的窗口)
            match self
                .repair_derived_edges(&collection.name, &payload.batch_id)
                .await
            {
                Ok(0) => {}
                Ok(repaired) => {
                    tracing::info!(batch = %payload.batch_id, repaired, "补齐了派生边");
                }
                Err(err) => tracing::warn!(error = %err, "补齐派生边失败"),
            }
            // 条件收尾:期间被取消 / 暂停的批次不能被改回 done(取消优先)
            let landed = IngestProgressRepo::finish_ingest_batch_if_running(
                self.meta.as_ref(),
                &payload.batch_id,
                now_millis(),
            )
            .await?;
            if !landed {
                tracing::info!(batch = %payload.batch_id, "批次已取消或已暂停,不再收尾");
            }
            self.tracker.forget(&payload.batch_id);
            if landed && let Err(err) = self.index.ensure_indexes_locked(&collection).await {
                tracing::warn!(error = %err, "确保全文索引失败");
            }
        }
        self.publish(&payload.batch_id).await;
        Ok(SliceProgress {
            done,
            total: Some(total.max(done)),
            finished,
            checkpoint: None,
            errors,
            rate_basis: chunks,
            paused,
        })
    }
}

/// 每写入这么多块整理一次物理表。
///
/// 一个文件一次 upsert:单块小文件的批次(例如几百个笔记)会攒出几百个版本,
/// 写入越来越慢、ETA 也就越来越不准。整理一次(compact)能把写入速率拉回稳定区间。
const OPTIMIZE_EVERY_ROWS: u64 = 200;

/// 给提示用的简短类型名(取扩展名)。
fn detected_label(file: &IngestFile) -> String {
    std::path::Path::new(&file.rel_path)
        .extension()
        .and_then(|value| value.to_str())
        .map(|ext| format!(".{ext} 文件"))
        .unwrap_or_else(|| "该文件".to_owned())
}

/// 附件名兜底与去重:只保留最后一段(挡路径穿越);同名时加序号。
fn unique_attachment_name(name: &str, used: &mut std::collections::HashSet<String>) -> String {
    let name = name.trim();
    let base = if name.is_empty() {
        "attachment".to_owned()
    } else {
        name.rsplit(['/', '\\']).next().unwrap_or(name).to_owned()
    };
    if used.insert(base.clone()) {
        return base;
    }
    let mut counter = 2usize;
    loop {
        let candidate = match base.rsplit_once('.') {
            Some((stem, ext)) => format!("{stem}-{counter}.{ext}"),
            None => format!("{base}-{counter}"),
        };
        if used.insert(candidate.clone()) {
            return candidate;
        }
        counter += 1;
    }
}

/// 读文件开头若干字节(判断魔数)。
fn read_head(path: &std::path::Path, max: usize) -> Vec<u8> {
    use std::io::Read;
    let mut head = vec![0u8; max];
    match std::fs::File::open(path).and_then(|mut file| file.read(&mut head)) {
        Ok(read) => {
            head.truncate(read);
            head
        }
        Err(_) => Vec::new(),
    }
}

/// 把隔离区里的原件挪回原位。
///
/// 释放隔离 / 重试前必须做:字节挪回来了,解析才有东西可读。找不到隔离副本或挪不动时
/// 只记日志——状态照样改回 `queued`,下一次解析会明确报“读取失败”,比静默地停在隔离里好排查。
///
/// 隔离区的布局是 `<数据源根>/sources/.quarantine/<文件 id>/<文件名>`,而 `abs_path` 是
/// `<数据源根>/sources/<source_id>/<相对路径>`:从文件往上找那个真的存在 `.quarantine/<id>`
/// 的祖先,就不会被用户自己的 `sources` 目录名骗到。
fn restore_quarantined(file: &IngestFile) {
    let target = std::path::PathBuf::from(&file.abs_path);
    if target.exists() {
        return;
    }
    let Some(dir) = std::path::Path::new(&file.abs_path)
        .ancestors()
        .filter_map(|path| path.parent())
        .map(|root| root.join(".quarantine").join(&file.id))
        .find(|dir| dir.is_dir())
    else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let Some(source) = entries.flatten().next().map(|entry| entry.path()) else {
        return;
    };
    if let Some(parent) = target.parent()
        && let Err(err) = std::fs::create_dir_all(parent)
    {
        tracing::warn!(path = %target.display(), error = %err, "恢复隔离文件失败:建不了目录");
        return;
    }
    match std::fs::rename(&source, &target) {
        Ok(()) => {
            let _ = std::fs::remove_dir(&dir);
            tracing::info!(path = %target.display(), "已把隔离文件挪回原位");
        }
        Err(err) => {
            tracing::warn!(
                from = %source.display(),
                to = %target.display(),
                error = %err,
                "恢复隔离文件失败"
            );
        }
    }
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
