//! 批次流水线进度、ETA 与事件节流。
//!
//! 阶段固定为 7 段(上传 → 类型识别 → 解析/抽取 → 分块 → 向量化 → 写入索引 → 可检索),
//! 每个文件的每一段都在 `ingest_stage_events` 里留一行(started_at / ended_at / 状态 / 块数 / 向量数),
//! 批次进度就是这些行的聚合。
//!
//! **ETA**:按最近 30 秒的“块/秒”算,再对上一次的值做指数平滑并夹在 ±20% 内(卡片的抖动要求)。
//! 剩余块数 = 剩余文件数 × 已完成文件的平均块数(没有已完成文件时按 [`DEFAULT_CHUNKS_PER_FILE`] 估)。
//!
//! **节流**:同一批次的 `ingest.stage` 推送间隔不小于 500 ms(即 ≤ 2 次/秒)。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use kb_core::Result;
use kb_core::model::{
    IngestBatchState, IngestFile, IngestFilter, IngestStage, IngestStageEvent, IngestState, Millis,
    Page,
};
use kb_core::ports::repo::{IngestProgressRepo, IngestRepo, MetaStore};
use serde::Serialize;

/// 吞吐统计窗口(卡片:最近 30 秒)。
pub const THROUGHPUT_WINDOW: Duration = Duration::from_secs(30);
/// 同一批次两次推送的最小间隔(≤ 2 次/秒)。
pub const MIN_PUSH_INTERVAL: Duration = Duration::from_millis(500);
/// 没有已完成文件时,单个文件按多少块估算。
pub const DEFAULT_CHUNKS_PER_FILE: f64 = 4.0;
/// ETA 相对上一次的最大变化幅度。
pub const ETA_MAX_DRIFT: f64 = 0.2;

/// 单个阶段的进度。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StageProgress {
    /// 阶段。
    pub stage: IngestStage,
    /// 中文名。
    pub label: String,
    /// 进入过这个阶段的文件数。
    pub files: u64,
    /// 这个阶段已经结束(成功)的文件数。
    pub done: u64,
    /// 这个阶段产出的块数。
    pub chunks: u64,
    /// 这个阶段产出的向量数。
    pub vectors: u64,
    /// 完成百分比(0–100)。
    pub percent: f64,
}

/// 批次进度(`get_batch_progress` 的返回,也是 `ingest.stage` 推送的内容)。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct BatchProgress {
    /// 批次 id。
    pub batch: String,
    /// 目标 collection。
    pub collection: String,
    /// 批次状态(运行 / 暂停 / 取消 / 完成)。
    pub state: IngestBatchState,
    /// 当前聚合阶段(最靠后的未完成阶段)。
    pub stage: IngestStage,
    /// 已处理完的文件数(完成 / 跳过)。
    pub done: u64,
    /// 文件总数。
    pub total: u64,
    /// 已入库块数。
    pub chunks: u64,
    /// 已入库向量数。
    pub vectors: u64,
    /// 吞吐(块/秒,最近 30 秒)。
    pub throughput_cps: f64,
    /// 预计剩余秒数(`None` = 还算不出来)。
    pub eta_s: Option<u64>,
    /// 已用秒数。
    pub elapsed_s: u64,
    /// 正在处理的文件(最多 5 个)。
    pub current_files: Vec<String>,
    /// 嵌入后端(`cpu-int8` / `igpu-vulkan`)。
    pub backend: String,
    /// 七个阶段各自的进度。
    pub stages: Vec<StageProgress>,
}

/// 推送节流:同一批次两次推送之间至少 [`MIN_PUSH_INTERVAL`]。
#[derive(Default)]
pub struct PushThrottle {
    last: Mutex<HashMap<String, Instant>>,
}

impl PushThrottle {
    /// 是否该推送;返回 `true` 时同时记下这次时间。
    pub fn should_push(&self, batch_id: &str) -> bool {
        self.should_push_at(batch_id, Instant::now())
    }

    /// 同 [`Self::should_push`],时间可注入(测试用)。
    pub fn should_push_at(&self, batch_id: &str, now: Instant) -> bool {
        let mut guard = match self.last.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        match guard.get(batch_id) {
            Some(last) if now.duration_since(*last) < MIN_PUSH_INTERVAL => false,
            _ => {
                guard.insert(batch_id.to_owned(), now);
                true
            }
        }
    }

    /// 清掉一个批次的记录。
    pub fn forget(&self, batch_id: &str) {
        if let Ok(mut guard) = self.last.lock() {
            guard.remove(batch_id);
        }
    }
}

/// ETA 平滑器:指数平滑 + 相邻两次最多变化 ±20%。
#[derive(Default)]
pub struct EtaSmoother {
    last: Mutex<HashMap<String, f64>>,
}

impl EtaSmoother {
    /// 用原始 ETA 算出平滑后的值(秒)。
    pub fn smooth(&self, batch_id: &str, raw_eta: Option<f64>) -> Option<u64> {
        let raw = raw_eta?;
        let mut guard = match self.last.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let smoothed = match guard.get(batch_id) {
            Some(previous) if previous.is_finite() && *previous > 0.0 => {
                // 指数平滑(0.7 旧 / 0.3 新),再夹在 ±20% 之内
                let blended = previous * 0.7 + raw * 0.3;
                blended.clamp(
                    previous * (1.0 - ETA_MAX_DRIFT),
                    previous * (1.0 + ETA_MAX_DRIFT),
                )
            }
            _ => raw,
        };
        guard.insert(batch_id.to_owned(), smoothed);
        Some(smoothed.round().max(0.0) as u64)
    }

    /// 清掉一个批次的状态(重跑时从头算)。
    pub fn forget(&self, batch_id: &str) {
        if let Ok(mut guard) = self.last.lock() {
            guard.remove(batch_id);
        }
    }
}

/// 进度计算器:读 `ingest_stage_events` 聚合出 [`BatchProgress`],并负责推送节流。
pub struct ProgressTracker {
    meta: Arc<dyn MetaStore>,
    backend: String,
    throttle: PushThrottle,
    smoother: EtaSmoother,
}

impl ProgressTracker {
    /// 构造;`backend` 是嵌入后端徽标(`cpu-int8` / `igpu-vulkan`)。
    pub fn new(meta: Arc<dyn MetaStore>, backend: impl Into<String>) -> Self {
        Self {
            meta,
            backend: backend.into(),
            throttle: PushThrottle::default(),
            smoother: EtaSmoother::default(),
        }
    }

    /// 嵌入后端徽标。
    pub fn backend(&self) -> &str {
        &self.backend
    }

    /// 是否该推送(节流:同一批次 ≥ 500 ms 一次)。
    pub fn should_push(&self, batch_id: &str) -> bool {
        self.throttle.should_push(batch_id)
    }

    /// 计算一个批次的进度。
    pub async fn progress(&self, batch_id: &str, now: Millis) -> Result<BatchProgress> {
        let batch = IngestProgressRepo::ingest_batch(self.meta.as_ref(), batch_id).await?;
        let collection = match &batch {
            Some(batch) => batch.collection.clone(),
            None => String::new(),
        };
        let state = batch
            .as_ref()
            .map(|batch| batch.state)
            .unwrap_or(IngestBatchState::Running);
        let created_at = batch.as_ref().map(|batch| batch.created_at).unwrap_or(now);

        let files = IngestRepo::list(
            self.meta.as_ref(),
            IngestFilter {
                collection: None,
                batch_id: Some(batch_id.to_owned()),
                source_id: None,
                state: None,
            },
            Page::new(10_000, 0),
        )
        .await?;
        let events = IngestProgressRepo::stages_of_batch(self.meta.as_ref(), batch_id).await?;

        Ok(aggregate(
            batch_id,
            &collection,
            state,
            created_at,
            &files,
            &events,
            now,
            &self.backend,
        ))
    }

    /// 用吞吐与剩余块数算 ETA,并对上一次的值做平滑 + ±20% 夹取。
    pub fn eta_seconds(&self, batch_id: &str, raw_eta: Option<f64>) -> Option<u64> {
        self.smoother.smooth(batch_id, raw_eta)
    }

    /// 批次结束时清掉平滑 / 节流状态(下次重跑从头算)。
    pub fn forget(&self, batch_id: &str) {
        self.smoother.forget(batch_id);
        self.throttle.forget(batch_id);
    }
}

impl std::fmt::Debug for ProgressTracker {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ProgressTracker")
            .field("backend", &self.backend)
            .finish_non_exhaustive()
    }
}

/// 聚合出批次进度(纯函数,便于测试)。
#[allow(clippy::too_many_arguments)]
pub fn aggregate(
    batch_id: &str,
    collection: &str,
    state: IngestBatchState,
    created_at: Millis,
    files: &[IngestFile],
    events: &[IngestStageEvent],
    now: Millis,
    backend: &str,
) -> BatchProgress {
    let total = files.len() as u64;
    let done = files
        .iter()
        .filter(|file| matches!(file.state, IngestState::Done | IngestState::Skipped))
        .count() as u64;
    let chunks: u64 = files.iter().map(|file| file.chunks).sum();
    let vectors: u64 = files.iter().map(|file| file.vectors).sum();

    // 每个阶段的文件数 / 完成数 / 块数 / 向量数
    let mut stages: Vec<StageProgress> = IngestStage::ALL
        .iter()
        .map(|stage| StageProgress {
            stage: *stage,
            label: stage.label().to_owned(),
            files: 0,
            done: 0,
            chunks: 0,
            vectors: 0,
            percent: 0.0,
        })
        .collect();
    let mut latest_running: HashMap<&str, IngestStage> = HashMap::new();
    for event in events {
        let Some(slot) = stages.iter_mut().find(|slot| slot.stage == event.stage) else {
            continue;
        };
        if event.status == kb_core::model::IngestStageStatus::Ok {
            slot.done += 1;
            slot.chunks += event.chunks;
            slot.vectors += event.vectors;
        } else if event.status == kb_core::model::IngestStageStatus::Running {
            slot.files += 1;
            latest_running.insert(event.file_id.as_str(), event.stage);
        }
    }
    // 每个阶段的“进入过”的文件数 = 该阶段结束的文件数 + 正在跑的文件数
    for slot in &mut stages {
        let finished = slot.done;
        slot.files = slot.files.max(finished);
        slot.percent = if total == 0 {
            0.0
        } else {
            (finished as f64 / total as f64) * 100.0
        };
        if slot.percent > 100.0 {
            slot.percent = 100.0;
        }
    }

    // 当前阶段:最靠前的、还没被全部文件走完的阶段
    let stage = stages
        .iter()
        .find(|slot| slot.done < total)
        .map(|slot| slot.stage)
        .unwrap_or(IngestStage::Searchable);

    // 正在处理的文件(最多 8 个,与 `index.parallel_files` 的上限一致)
    let mut current: Vec<(String, IngestStage)> = latest_running
        .iter()
        .map(|(file_id, stage)| ((*file_id).to_owned(), *stage))
        .collect();
    current.sort_by_key(|(_, stage)| *stage);
    let names: HashMap<&str, &str> = files
        .iter()
        .map(|file| (file.id.as_str(), file.rel_path.as_str()))
        .collect();
    let current_files: Vec<String> = current
        .iter()
        .take(8)
        .map(|(file_id, _)| {
            names
                .get(file_id.as_str())
                .map(|path| (*path).to_owned())
                .unwrap_or_else(|| file_id.clone())
        })
        .collect();

    // 吞吐:最近 30 秒里“可检索”阶段结束的块数 / 实际窗口
    let window_start = now - THROUGHPUT_WINDOW.as_millis() as i64;
    let span_start = window_start.max(created_at);
    let mut window_chunks = 0u64;
    for event in events {
        if event.stage != IngestStage::Searchable
            || event.status != kb_core::model::IngestStageStatus::Ok
        {
            continue;
        }
        if event.ended_at.unwrap_or(0) >= span_start {
            window_chunks += event.chunks;
        }
    }
    let span_seconds = ((now - span_start).max(500) as f64) / 1000.0;
    let throughput = if window_chunks > 0 {
        window_chunks as f64 / span_seconds
    } else {
        // 窗口里没有完成的文件(例如只有一个大文件):退化成整体平均
        let elapsed = ((now - created_at).max(500) as f64) / 1000.0;
        chunks as f64 / elapsed
    };

    // 剩余块数 = 剩余文件 × 已完成文件的平均块数
    let remaining_files = total.saturating_sub(done) as f64;
    let avg_chunks = if done > 0 {
        (chunks as f64 / done as f64).max(1.0)
    } else {
        DEFAULT_CHUNKS_PER_FILE
    };
    let raw_eta = if throughput > 0.0 && remaining_files > 0.0 {
        Some(remaining_files * avg_chunks / throughput)
    } else {
        None
    };

    BatchProgress {
        batch: batch_id.to_owned(),
        collection: collection.to_owned(),
        state,
        stage,
        done,
        total,
        chunks,
        vectors,
        throughput_cps: (throughput * 100.0).round() / 100.0,
        // 平滑与抖动限制由 `ProgressTracker::eta_seconds` 负责;这里给原始值
        eta_s: raw_eta.map(|value| value.round().max(0.0) as u64),
        elapsed_s: ((now - created_at).max(0) / 1000) as u64,
        current_files,
        backend: backend.to_owned(),
        stages,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::IngestStageStatus;

    fn file(id: &str, rel_path: &str, state: IngestState, chunks: u64) -> IngestFile {
        IngestFile {
            id: id.to_owned(),
            batch_id: Some("b1".to_owned()),
            source_id: None,
            upload_id: None,
            collection: "_global".to_owned(),
            rel_path: rel_path.to_owned(),
            abs_path: format!("/tmp/{rel_path}"),
            size: 10,
            sha256: None,
            state,
            error: None,
            chunks,
            vectors: chunks,
            extract_meta: None,
            derived_from: None,
            elapsed_ms: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn event(
        file_id: &str,
        stage: IngestStage,
        status: IngestStageStatus,
        at: Millis,
        chunks: u64,
    ) -> IngestStageEvent {
        IngestStageEvent {
            id: None,
            file_id: file_id.to_owned(),
            batch_id: Some("b1".to_owned()),
            stage,
            started_at: at,
            ended_at: Some(at),
            status,
            error: None,
            chunks,
            vectors: chunks,
        }
    }

    #[test]
    fn stages_add_up_and_current_stage_moves_forward() {
        let now = 1_800_000_000_000i64;
        let files = vec![
            file("f1", "a.md", IngestState::Done, 4),
            file("f2", "b.md", IngestState::Embedding, 0),
        ];
        let mut events = Vec::new();
        for stage in [
            IngestStage::Upload,
            IngestStage::Detect,
            IngestStage::Extract,
        ] {
            events.push(event("f1", stage, IngestStageStatus::Ok, now - 2000, 0));
            events.push(event("f2", stage, IngestStageStatus::Ok, now - 1000, 0));
        }
        events.push(event(
            "f1",
            IngestStage::Chunk,
            IngestStageStatus::Ok,
            now - 800,
            4,
        ));
        events.push(event(
            "f2",
            IngestStage::Chunk,
            IngestStageStatus::Ok,
            now - 700,
            0,
        ));
        events.push(event(
            "f1",
            IngestStage::Embed,
            IngestStageStatus::Ok,
            now - 600,
            4,
        ));
        events.push(event(
            "f2",
            IngestStage::Embed,
            IngestStageStatus::Running,
            now - 100,
            0,
        ));

        let progress = aggregate(
            "b1",
            "_global",
            IngestBatchState::Running,
            now - 5000,
            &files,
            &events,
            now,
            "cpu-int8",
        );
        assert_eq!(progress.total, 2);
        assert_eq!(progress.done, 1);
        assert_eq!(progress.chunks, 4);
        assert_eq!(progress.stage, IngestStage::Embed, "f2 还在向量化");
        assert_eq!(progress.current_files, vec!["b.md".to_owned()]);
        // 前三个阶段两个文件都完成了 → 100%
        assert_eq!(progress.stages[2].percent, 100.0);
        // 分块阶段两个文件都完成 → 100%;向量化只完成 1 个 → 50%
        assert_eq!(progress.stages[3].percent, 100.0);
        assert_eq!(progress.stages[4].percent, 50.0);
        assert!(progress.throughput_cps >= 0.0);
    }

    #[test]
    fn eta_uses_recent_throughput_and_remaining_blocks() {
        let now = 1_800_000_000_000i64;
        // 10 个文件,完成 2 个(每个 10 块 = 20 块),用了 2 秒 → 10 块/秒
        let mut files = Vec::new();
        for index in 0..10 {
            let state = if index < 2 {
                IngestState::Done
            } else {
                IngestState::Queued
            };
            files.push(file(
                &format!("f{index}"),
                &format!("{index}.md"),
                state,
                if index < 2 { 10 } else { 0 },
            ));
        }
        let events: Vec<IngestStageEvent> = (0..2)
            .map(|index| {
                event(
                    &format!("f{index}"),
                    IngestStage::Searchable,
                    IngestStageStatus::Ok,
                    now - 1000 + index as i64 * 100,
                    10,
                )
            })
            .collect();
        let progress = aggregate(
            "b1",
            "_global",
            IngestBatchState::Running,
            now - 2000,
            &files,
            &events,
            now,
            "cpu-int8",
        );
        // 剩余 8 个文件 × 平均 10 块 = 80 块,按 10 块/秒 → 约 8 秒
        let eta = progress.eta_s.expect("应能算出 ETA");
        assert!(
            (5..=12).contains(&eta),
            "ETA 应接近 8 秒,实际 {eta}(吞吐 {} 块/秒)",
            progress.throughput_cps
        );
    }

    #[test]
    fn eta_jitter_is_capped_at_twenty_percent() {
        let smoother = EtaSmoother::default();
        let first = smoother.smooth("b1", Some(100.0)).expect("第一次");
        assert_eq!(first, 100);
        // 原始值突然翻倍,平滑 + 夹取后最多涨 20%
        let second = smoother.smooth("b1", Some(200.0)).expect("第二次");
        assert!(
            second <= 120,
            "连续两次 ETA 的涨幅不应超过 20%,第一次 {first} 第二次 {second}"
        );
        // 原始值突然减半,最多降 20%
        let third = smoother.smooth("b1", Some(10.0)).expect("第三次");
        assert!(
            third >= (second as f64 * 0.8) as u64,
            "跌幅不应超过 20%,第二次 {second} 第三次 {third}"
        );
        // 换批次互不影响
        assert_eq!(smoother.smooth("b2", Some(50.0)), Some(50));
    }

    #[test]
    fn push_is_throttled_to_two_per_second() {
        let throttle = PushThrottle::default();
        let start = Instant::now();
        assert!(throttle.should_push_at("b1", start), "第一次应推送");
        assert!(
            !throttle.should_push_at("b1", start + Duration::from_millis(100)),
            "100 ms 后不应再推"
        );
        assert!(
            !throttle.should_push_at("b1", start + Duration::from_millis(499)),
            "499 ms 后不应再推"
        );
        assert!(
            throttle.should_push_at("b1", start + Duration::from_millis(500)),
            "满 500 ms 应推送"
        );
        assert!(throttle.should_push_at("b2", start), "不同批次各自节流");
        // 一秒内最多 2 次:从 0 ms 起 500 ms 一次
        let mut pushes = 0;
        for step in 0..10 {
            let at = start + Duration::from_millis(step * 100);
            if throttle.should_push_at("b3", at) {
                pushes += 1;
            }
        }
        assert!(pushes <= 2, "1 秒内最多 2 次,实际 {pushes}");
    }
}
