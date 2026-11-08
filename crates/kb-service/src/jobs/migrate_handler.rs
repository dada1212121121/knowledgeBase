//! `migrate` 任务的处理:把换模型迁移放进任务队列。
//!
//! 为什么改成任务:
//! - 迁移可能跑几分钟,同步调用会把 HTTP / UDS 请求挂住,页面上也看不到进度;
//! - 队列已有分片、检查点、速率与 `job.progress` 推送(`JobObserver` → `/api/v1/ws`),
//!   迁移直接复用这一套,不必自己写进度通道。
//!
//! 分片推进(见 [`MigrationPhase`]):
//! 1. `Copy`:每片 256 个块;
//! 2. `Insights`:复制 insight 行(条数少,一次做完);
//! 3. `Finalize`:写锁内追平、校验、切换(必须一次做完,不能跨分片持锁)。
//!
//! 状态放在本结构体的内存表里(按任务 id)。进程重启后内存状态丢失,此时按**续跑**处理:
//! 重建目标表、从头复制(取舍),`jobs.checkpoint_json` 只用来判断“这是续跑”。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kb_core::model::Job;
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};

use crate::jobs::worker::{JobHandler, SliceProgress};
use crate::migration::{MigrationPhase, MigrationService, MigrationState};

/// `migrate` 任务的参数。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MigratePayload {
    /// collection 名。
    pub collection: String,
    /// 目标 embedder id(必须与当前配置一致)。
    pub to: String,
}

/// 迁移任务处理器。
pub struct MigrateJobHandler {
    service: Arc<MigrationService>,
    /// 按任务 id 保存分片状态(进程内)。
    states: Mutex<HashMap<String, MigrationState>>,
}

impl MigrateJobHandler {
    /// 构造。
    pub fn new(service: Arc<MigrationService>) -> Self {
        Self {
            service,
            states: Mutex::new(HashMap::new()),
        }
    }

    /// 取出(或开始)一个任务的分片状态。
    async fn state_of(&self, job: &Job) -> Result<MigrationState> {
        let payload: MigratePayload = serde_json::from_str(&job.payload_json)
            .map_err(|err| KbError::InvalidInput(format!("migrate 参数非法: {err}")))?;
        if let Some(state) = self.states.lock().expect("锁").get(&job.id).cloned() {
            return Ok(state);
        }
        // 内存里没有:要么是第一次跑,要么进程重启过。`checkpoint_json` 有值说明是后者,
        // 目标表可能是半成品,必须重建。
        let resuming = job.checkpoint_json.is_some();
        let state = self
            .service
            .begin(&payload.collection, &payload.to, resuming)
            .await?;
        Ok(state)
    }

    fn store_state(&self, job_id: &str, state: MigrationState) {
        self.states
            .lock()
            .expect("锁")
            .insert(job_id.to_owned(), state);
    }
}

#[async_trait]
impl JobHandler for MigrateJobHandler {
    async fn run_slice(&self, job: &Job) -> Result<SliceProgress> {
        let mut state = self.state_of(job).await?;
        let progress = match state.phase {
            MigrationPhase::Copy => {
                let has_more = self.service.copy_slice(&mut state).await?;
                if !has_more {
                    // 主遍历结束,下一步复制 insight 行
                    state.phase = MigrationPhase::Insights;
                }
                SliceProgress {
                    done: state.done(),
                    total: Some(state.total()),
                    finished: false,
                    checkpoint: Some(checkpoint_json(&state)),
                    errors: Vec::new(),
                    rate_basis: state.chunks_done,
                    paused: false,
                }
            }
            MigrationPhase::Insights => {
                self.service.copy_insights_slice(&mut state).await?;
                SliceProgress {
                    done: state.done(),
                    total: Some(state.total()),
                    finished: false,
                    checkpoint: Some(checkpoint_json(&state)),
                    errors: Vec::new(),
                    rate_basis: state.chunks_done,
                    paused: false,
                }
            }
            MigrationPhase::Finalize => {
                let report = self.service.finalize(&state).await?;
                // 收尾完成后状态作废:同一个任务不会再被调度
                self.states.lock().expect("锁").remove(&job.id);
                tracing::info!(
                    collection = %state.collection,
                    to_table = %report.to_table,
                    rows = report.rows,
                    warnings = report.warnings.len(),
                    "迁移任务完成"
                );
                return Ok(SliceProgress {
                    done: report.rows.max(state.total()),
                    total: Some(report.rows.max(state.total())),
                    finished: true,
                    checkpoint: None,
                    errors: report.warnings,
                    rate_basis: state.chunks_done,
                    paused: false,
                });
            }
        };
        self.store_state(&job.id, state);
        Ok(progress)
    }
}

/// 检查点:只记阶段与游标(真正的分片状态在内存里,见模块注释)。
fn checkpoint_json(state: &MigrationState) -> String {
    serde_json::json!({
        "phase": state.phase,
        "after": state.after,
        "chunks_done": state.chunks_done,
    })
    .to_string()
}
