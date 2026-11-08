//! 批次流水线:进度聚合、ETA 与暂停 / 继续 / 取消。
//!
//! - [`ProgressTracker`]:把 `ingest_stage_events` 聚合成批次进度(7 段、块 / 向量计数、吞吐与 ETA),
//!   并负责 `ingest.stage` 的推送节流(≤ 2 次/秒);
//! - [`BatchService`]:批次的暂停 / 继续 / 取消,以及单文件的“从某阶段重跑 / 跳过 / 隔离”。

pub mod progress;

use std::sync::Arc;

use kb_core::model::{
    IngestBatchState, IngestFile, IngestFilter, IngestStage, IngestStageEvent, IngestStageStatus,
    IngestState, Millis, Page,
};
use kb_core::ports::repo::{IngestProgressRepo, IngestRepo, MetaStore};
use kb_core::{KbError, Result};
use serde::Serialize;

use crate::jobs::queue::JobQueue;
use crate::revert::remove_indexed_path;
use crate::write_gate::WriteGate;

pub use progress::{
    BatchProgress, EtaSmoother, ProgressTracker, PushThrottle, StageProgress, THROUGHPUT_WINDOW,
};

/// 单文件的阶段时间线。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct FileTimeline {
    /// 文件本身。
    pub file: IngestFile,
    /// 各阶段(按开始时间升序)。
    pub stages: Vec<StageEntry>,
    /// 总耗时(毫秒;没跑完时是 `None`)。
    pub total_ms: Option<u64>,
}

/// 时间线里的一段。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StageEntry {
    /// 阶段。
    pub stage: IngestStage,
    /// 中文名。
    pub label: String,
    /// 状态。
    pub status: IngestStageStatus,
    /// 开始时间。
    pub started_at: Millis,
    /// 结束时间。
    pub ended_at: Option<Millis>,
    /// 耗时(毫秒)。
    pub duration_ms: Option<u64>,
    /// 块数。
    pub chunks: u64,
    /// 向量数。
    pub vectors: u64,
    /// 失败 / 跳过 / 隔离的原因。
    pub error: Option<String>,
}

impl StageEntry {
    /// 从事件裁剪。
    pub fn of(event: &IngestStageEvent) -> Self {
        Self {
            stage: event.stage,
            label: event.stage.label().to_owned(),
            status: event.status,
            started_at: event.started_at,
            ended_at: event.ended_at,
            duration_ms: event
                .ended_at
                .map(|end| (end - event.started_at).max(0) as u64),
            chunks: event.chunks,
            vectors: event.vectors,
            error: event.error.clone(),
        }
    }
}

/// 取消批次的结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CancelReport {
    /// 批次 id。
    pub batch: String,
    /// 回滚掉的在途文件数。
    pub rolled_back: u64,
    /// 标记为取消的排队文件数。
    pub canceled: u64,
    /// 已完成的文件数(保留,仍可检索)。
    pub kept: u64,
}

/// 批次控制服务。
pub struct BatchService {
    meta: Arc<dyn MetaStore>,
    queue: JobQueue,
    tracker: Arc<ProgressTracker>,
    gate: WriteGate,
    store: Arc<dyn kb_core::ports::VectorStore>,
}

impl BatchService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn kb_core::ports::VectorStore>,
        tracker: Arc<ProgressTracker>,
    ) -> Self {
        Self {
            queue: JobQueue::new(meta.clone()),
            meta,
            tracker,
            gate: WriteGate::new(),
            store,
        }
    }

    /// 换用与索引 / 迁移共享的写闸门。
    pub fn with_write_gate(mut self, gate: WriteGate) -> Self {
        self.gate = gate;
        self
    }

    /// 批次进度(暂停 / 取消也会体现在 `state` 上)。
    pub async fn progress(&self, batch_id: &str) -> Result<BatchProgress> {
        let mut progress = self.tracker.progress(batch_id, now_millis()).await?;
        // 用平滑 + ±20% 抖动限制后的 ETA
        progress.eta_s = self
            .tracker
            .eta_seconds(batch_id, progress.eta_s.map(|value| value as f64));
        Ok(progress)
    }

    /// 单文件的阶段时间线。
    pub async fn timeline(&self, file_id: &str) -> Result<FileTimeline> {
        let file = IngestRepo::get(self.meta.as_ref(), file_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("ingest file {file_id}")))?;
        let events = IngestProgressRepo::stages_of_file(self.meta.as_ref(), file_id).await?;
        let stages: Vec<StageEntry> = events.iter().map(StageEntry::of).collect();
        let total_ms = file.elapsed_ms.or_else(|| {
            let first = stages.first()?.started_at;
            let last = stages
                .iter()
                .filter_map(|stage| stage.ended_at)
                .next_back()?;
            Some((last - first).max(0) as u64)
        });
        Ok(FileTimeline {
            file,
            stages,
            total_ms,
        })
    }

    /// 暂停:不再取新文件;在途文件跑完当前阶段后停下。任务转 `paused`,重启后仍保持暂停。
    pub async fn pause(&self, batch_id: &str) -> Result<BatchProgress> {
        let batch = self.require_batch(batch_id).await?;
        if batch.state == IngestBatchState::Canceled {
            return Err(KbError::InvalidInput("批次已取消,不能再暂停".to_owned()));
        }
        IngestProgressRepo::set_ingest_batch_state(
            self.meta.as_ref(),
            batch_id,
            IngestBatchState::Paused,
            now_millis(),
        )
        .await?;
        self.progress(batch_id).await
    }

    /// 继续:批次状态回到运行中,暂停的任务重新入队。
    pub async fn resume(&self, batch_id: &str) -> Result<BatchProgress> {
        let batch = self.require_batch(batch_id).await?;
        if batch.state == IngestBatchState::Canceled {
            return Err(KbError::InvalidInput(
                "批次已取消;要重跑请用 retry_ingest 或 retry_file_stage".to_owned(),
            ));
        }
        IngestProgressRepo::set_ingest_batch_state(
            self.meta.as_ref(),
            batch_id,
            IngestBatchState::Running,
            now_millis(),
        )
        .await?;
        // 暂停中的任务放回队列(没有暂停任务时补投一个)
        let mut resumed = false;
        for job in self
            .queue
            .list(Some(kb_core::model::JobState::Paused))
            .await?
        {
            if job.kind == "ingest" && job.collection.as_deref() == Some(batch.collection.as_str())
            {
                self.queue.resume(&job.id).await?;
                resumed = true;
                break;
            }
        }
        if !resumed {
            self.queue
                .enqueue(crate::jobs::queue::NewJob {
                    kind: "ingest".to_owned(),
                    collection: Some(batch.collection.clone()),
                    priority: crate::jobs::queue::priority::INGEST_UPLOAD,
                    payload: serde_json::json!({
                        "batch_id": batch_id,
                        "collection": batch.collection,
                    }),
                })
                .await?;
        }
        self.progress(batch_id).await
    }

    /// 取消:在途文件回滚(块 / 向量 / 文件行),已完成的文件保留,排队中的标记为失败可重试。
    pub async fn cancel(&self, batch_id: &str) -> Result<CancelReport> {
        let batch = self.require_batch(batch_id).await?;
        IngestProgressRepo::set_ingest_batch_state(
            self.meta.as_ref(),
            batch_id,
            IngestBatchState::Canceled,
            now_millis(),
        )
        .await?;
        let files = self.batch_files(batch_id).await?;
        let mut rolled_back = 0u64;
        let mut canceled = 0u64;
        let mut kept = 0u64;
        for file in &files {
            match file.state {
                IngestState::Done | IngestState::Skipped => kept += 1,
                IngestState::Extracting | IngestState::Chunking | IngestState::Embedding => {
                    // 在途:清掉半成品,避免留下孤儿块
                    remove_indexed_path(
                        self.meta.as_ref(),
                        self.store.as_ref(),
                        &self.gate,
                        &file.collection,
                        &file.rel_path,
                    )
                    .await?;
                    IngestRepo::finish(
                        self.meta.as_ref(),
                        &file.id,
                        IngestState::Failed,
                        0,
                        0,
                        file.elapsed_ms.unwrap_or(0),
                        Some("批次已取消(在途文件已回滚)"),
                    )
                    .await?;
                    rolled_back += 1;
                }
                _ => {
                    IngestRepo::set_state(
                        self.meta.as_ref(),
                        &file.id,
                        IngestState::Failed,
                        Some("批次已取消"),
                    )
                    .await?;
                    canceled += 1;
                }
            }
        }
        // 暂停中的任务直接作废(取消后不再跑)
        for job in self
            .queue
            .list(Some(kb_core::model::JobState::Paused))
            .await?
        {
            if job.kind == "ingest" && job.collection.as_deref() == Some(batch.collection.as_str())
            {
                self.queue
                    .finish(
                        &job,
                        kb_core::model::JobState::Canceled,
                        Some("批次已取消".to_owned()),
                    )
                    .await?;
            }
        }
        self.tracker.forget(batch_id);
        Ok(CancelReport {
            batch: batch_id.to_owned(),
            rolled_back,
            canceled,
            kept,
        })
    }

    /// 从某个阶段重跑一个文件(不重新上传):清掉该阶段起的记录并重新入队。
    pub async fn retry_stage(&self, file_id: &str, stage: IngestStage) -> Result<IngestFile> {
        let file = IngestRepo::get(self.meta.as_ref(), file_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("ingest file {file_id}")))?;
        if matches!(
            file.state,
            IngestState::Extracting | IngestState::Chunking | IngestState::Embedding
        ) {
            return Err(KbError::InvalidInput(format!(
                "{} 正在处理,等它停下来再重试",
                file.rel_path
            )));
        }
        IngestProgressRepo::reset_stages_from(self.meta.as_ref(), file_id, stage).await?;
        IngestRepo::set_state(self.meta.as_ref(), file_id, IngestState::Queued, None).await?;
        let Some(batch_id) = &file.batch_id else {
            return Err(KbError::InvalidInput(
                "这个文件没有归属批次,无法重跑".to_owned(),
            ));
        };
        IngestProgressRepo::ensure_ingest_batch(
            self.meta.as_ref(),
            batch_id,
            &file.collection,
            now_millis(),
        )
        .await?;
        IngestProgressRepo::set_ingest_batch_state(
            self.meta.as_ref(),
            batch_id,
            IngestBatchState::Running,
            now_millis(),
        )
        .await?;
        self.queue
            .enqueue(crate::jobs::queue::NewJob {
                kind: "ingest".to_owned(),
                collection: Some(file.collection.clone()),
                priority: crate::jobs::queue::priority::INGEST_UPLOAD,
                payload: serde_json::json!({
                    "batch_id": batch_id,
                    "collection": file.collection,
                }),
            })
            .await?;
        self.reload(file_id).await
    }

    /// 跳过:记为 `skipped`(不算失败,之后还能重试)。
    pub async fn skip(&self, file_id: &str) -> Result<IngestFile> {
        let file = self.get(file_id).await?;
        IngestRepo::finish(
            self.meta.as_ref(),
            file_id,
            IngestState::Skipped,
            file.chunks,
            file.vectors,
            file.elapsed_ms.unwrap_or(0),
            Some("已跳过"),
        )
        .await?;
        self.reload(file_id).await
    }

    /// 人工隔离:标记为 `quarantined`(字节留在原处,方便排查)。
    pub async fn quarantine(&self, file_id: &str) -> Result<IngestFile> {
        self.get(file_id).await?;
        IngestRepo::set_state(
            self.meta.as_ref(),
            file_id,
            IngestState::Quarantined,
            Some("人工隔离"),
        )
        .await?;
        self.reload(file_id).await
    }

    async fn get(&self, file_id: &str) -> Result<IngestFile> {
        IngestRepo::get(self.meta.as_ref(), file_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("ingest file {file_id}")))
    }

    async fn reload(&self, file_id: &str) -> Result<IngestFile> {
        self.get(file_id).await
    }

    async fn require_batch(&self, batch_id: &str) -> Result<kb_core::model::IngestBatch> {
        IngestProgressRepo::ingest_batch(self.meta.as_ref(), batch_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("batch {batch_id}")))
    }

    async fn batch_files(&self, batch_id: &str) -> Result<Vec<IngestFile>> {
        IngestRepo::list(
            self.meta.as_ref(),
            IngestFilter {
                collection: None,
                batch_id: Some(batch_id.to_owned()),
                source_id: None,
                state: None,
            },
            Page::new(10_000, 0),
        )
        .await
    }
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
