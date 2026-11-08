//! 任务入队、去重合并与状态流转。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, Weak};

use kb_core::model::{Job, JobState, Millis};
use kb_core::ports::repo::{JobRepo, MetaStore};
use kb_core::{KbError, Result};
use serde_json::Value;
use tokio::sync::Notify;

/// 任务优先级（设计规范）。
///
/// 取任务时还会按排队时间给低优先级任务「提级」(实现与常量在 `kb-meta` 的 `repo/job.rs`,
/// 那里不能依赖本表,所以改这张表时要回去核对:迁移 + 加成上限 < 增量,提级天花板 < 保存经验)。
pub mod priority {
    /// 编辑单条。
    pub const EDIT_ITEM: i32 = 100;
    /// save_insight。
    pub const SAVE_INSIGHT: i32 = 90;
    /// 用户刚上传的文件(解析任务的首次投递)。
    ///
    /// 为什么和 `SAVE_INSIGHT` 同级而不是沿用 `REVIEW_EXTRACT`(60):解析一个几百份文件的
    /// 批次要跑几个小时,期间新上传的文档按 FIFO 只能排在后面,用户界面上就是「传完了却
    /// 搜不到」。worker 每跑完一片都会看 `has_higher_priority` 并让出(见 `jobs/worker.rs`),
    /// 所以把首次投递提到老化的天花板(89)之上,新上传就能插队到下一片,旧批次让一让再回来,
    /// 不会饿死 —— 它是让出而不是被取消。高优先级只决定排队位置,通道仍是批量
    /// (解析那类任务的处理器不声明交互通道,见 `JobHandler::lane`)。
    pub const INGEST_UPLOAD: i32 = 90;
    /// hook 增量索引。
    pub const HOOK_INCREMENTAL: i32 = 80;
    /// review / extract。
    pub const REVIEW_EXTRACT: i32 = 60;
    /// 全量索引。
    pub const FULL_INDEX: i32 = 20;
    /// 迁移。
    pub const MIGRATE: i32 = 10;
    /// 维护。
    pub const MAINTENANCE: i32 = 5;
}

/// 任务类型(`kind` 列)里会被调度策略直接引用的几个值。
pub mod kind {
    /// 上传 / 网页 / 来源解析:一次导入的首次投递与继续。
    ///
    /// 它优先级很高(见 [`priority::INGEST_UPLOAD`]),但走**批量**通道而不是交互通道 ——
    /// 解析那类任务的处理器不声明交互通道(见 `JobHandler::lane`)。
    pub const INGEST: &str = "ingest";
}

/// 入队请求。
#[derive(Clone, Debug)]
pub struct NewJob {
    /// 任务类型(`index` / `save_insight` / `migrate` …)。
    pub kind: String,
    /// 相关 collection。
    pub collection: Option<String>,
    /// 优先级。
    pub priority: i32,
    /// 任务参数。
    pub payload: Value,
}

impl NewJob {
    /// 全量索引任务。
    pub fn full_index(project_id: &str, collection: &str) -> Self {
        Self {
            kind: "index".to_owned(),
            collection: Some(collection.to_owned()),
            priority: priority::FULL_INDEX,
            payload: serde_json::json!({
                "project_id": project_id,
                "mode": "full",
                "paths": [],
            }),
        }
    }

    /// 增量索引任务。
    pub fn incremental_index(project_id: &str, collection: &str, paths: &[String]) -> Self {
        Self {
            kind: "index".to_owned(),
            collection: Some(collection.to_owned()),
            priority: priority::HOOK_INCREMENTAL,
            payload: serde_json::json!({
                "project_id": project_id,
                "mode": "incremental",
                "paths": paths,
            }),
        }
    }
}

/// 同一个元数据库对应的「有新任务了」通知,进程内共用一份。
///
/// 生产里各服务(上传、检索、编辑、调度……)各自 `JobQueue::new(meta.clone)`,队列对象不是同一个,
/// 共享的只有元数据库,所以通知按元数据库的地址登记。登记表里只存弱引用:
/// 队列都丢掉后通知自然释放;队列持有元数据库的 `Arc`,地址在队列活着期间不会被别的库复用。
fn wake_for(meta: &Arc<dyn MetaStore>) -> Arc<Notify> {
    type Registry = Mutex<HashMap<usize, Weak<Notify>>>;
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    let key = Arc::as_ptr(meta) as *const () as usize;
    let mut map = REGISTRY
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    if let Some(existing) = map.get(&key).and_then(Weak::upgrade) {
        return existing;
    }
    map.retain(|_, weak| weak.strong_count() > 0);
    let fresh = Arc::new(Notify::new());
    map.insert(key, Arc::downgrade(&fresh));
    fresh
}

/// 任务队列(元数据仓储之上的薄封装)。
#[derive(Clone)]
pub struct JobQueue {
    meta: Arc<dyn MetaStore>,
    /// 入队 / 继续时叫醒空闲的 worker。
    wake: Arc<Notify>,
}

impl JobQueue {
    /// 构造。
    pub fn new(meta: Arc<dyn MetaStore>) -> Self {
        let wake = wake_for(&meta);
        Self { meta, wake }
    }

    /// 给 worker 等新任务用的通知。
    pub(crate) fn wake(&self) -> &Arc<Notify> {
        &self.wake
    }

    /// 入队;同一 collection 排队中的增量索引任务会合并。
    pub async fn enqueue(&self, request: NewJob) -> Result<Job> {
        if let Some(existing) = self.find_mergeable(&request).await? {
            // 合并前重新读一次:期间任务可能已经被 worker 认领(变成 running),
            // 这时不能再覆盖它的 state / checkpoint
            if let Some(current) = JobRepo::get(self.meta.as_ref(), &existing.id).await?
                && current.state == JobState::Queued
            {
                let merged = merge_into(current, &request)?;
                JobRepo::update(self.meta.as_ref(), merged.clone()).await?;
                self.wake.notify_one();
                return Ok(merged);
            }
        }
        let job = Job {
            id: new_job_id(),
            kind: request.kind,
            collection: request.collection,
            priority: request.priority,
            state: JobState::Queued,
            payload_json: request.payload.to_string(),
            checkpoint_json: None,
            detail: None,
            progress_done: 0,
            progress_total: None,
            rate: None,
            error: None,
            created_at: now_millis(),
            started_at: None,
            finished_at: None,
        };
        JobRepo::enqueue(self.meta.as_ref(), job.clone()).await?;
        // 写库之后再叫醒:`notify_one` 在没人等的时候会存下一次许可,worker 下次等待时立刻醒,不会漏
        self.wake.notify_one();
        Ok(job)
    }

    /// 找可以合并的排队中任务。
    ///
    /// 两个阶段开关(`phase` / `stop_after_text`)是手动入口的明确意图,带这两个字段的任务
    /// 不能和普通增量索引互相合并:否则「先 `--text-only`,再普通 `kb index --paths ...`」
    /// 会把普通索引并进只写正文的任务,向量永远补不上;反过来也会把手动阶段吞掉。
    async fn find_mergeable(&self, request: &NewJob) -> Result<Option<Job>> {
        if request.kind != "index"
            || payload_mode(&request.payload) != Some("incremental")
            || payload_is_staged(&request.payload)
        {
            return Ok(None);
        }
        let queued = JobRepo::list(self.meta.as_ref(), Some(JobState::Queued)).await?;
        Ok(queued.into_iter().find(|job| {
            job.kind == "index"
                && job.collection == request.collection
                && payload_mode_str(&job.payload_json) == Some("incremental")
                && !payload_is_staged_str(&job.payload_json)
                // 跑过分片的任务已经把文件顺序 / 阶段固化在 checkpoint 里，合并只改 payload：
                // 新路径不会进 checkpoint（phase=embed 时更会被整段忽略），随后任务照样标记完成。
                // 这类任务必须另起一个 job，否则用户以为新路径被处理了，实际什么都没做。
                && job.checkpoint_json.is_none()
        }))
    }

    /// 取下一个可执行任务(只读,不认领)。并发取任务时只拿它看优先级、领名额,
    /// 真正把任务领到手要用 [`JobQueue::claim_next`]。
    pub async fn next(&self) -> Result<Option<Job>> {
        JobRepo::next_runnable(self.meta.as_ref()).await
    }

    /// 认领下一个可执行任务(同一个写事务里盖成 `running`)。
    ///
    /// 一个知识库的后台同时跑好几个分片时必须用它,否则两个分片会领到同一个任务。
    pub async fn claim_next(&self) -> Result<Option<Job>> {
        JobRepo::claim_next(self.meta.as_ref()).await
    }

    /// 还有没有要 worker 干的活:排队中或运行中的任务(暂停的不算,要等人点「继续」)。
    ///
    /// 空闲的知识库要关掉后台任务之前用它判断:有活就不关,否则这些任务要等到下次有人访问才会被执行。
    pub async fn has_pending(&self) -> Result<bool> {
        if JobRepo::next_runnable(self.meta.as_ref()).await?.is_some() {
            return Ok(true);
        }
        Ok(
            !JobRepo::list_summaries(self.meta.as_ref(), Some(JobState::Running))
                .await?
                .is_empty(),
        )
    }

    /// 是否有比 `priority` 更高优先级的排队任务(用于长任务让出)。
    pub async fn has_higher_priority(&self, priority: i32) -> Result<bool> {
        JobRepo::has_queued_above(self.meta.as_ref(), priority).await
    }

    /// 标记为运行中。
    pub async fn start(&self, job: &Job) -> Result<Job> {
        let mut running = job.clone();
        running.state = JobState::Running;
        running.started_at = Some(now_millis());
        JobRepo::update(self.meta.as_ref(), running.clone()).await?;
        Ok(running)
    }

    /// 更新进度与速率(速率由 worker 按“块/秒”算好传入)。
    pub async fn progress(
        &self,
        job: &Job,
        done: u64,
        total: Option<u64>,
        rate: Option<f64>,
        checkpoint: Option<String>,
    ) -> Result<Job> {
        let mut updated = job.clone();
        updated.progress_done = done;
        updated.progress_total = total;
        updated.rate = rate;
        if checkpoint.is_some() {
            updated.checkpoint_json = checkpoint;
        }
        JobRepo::update(self.meta.as_ref(), updated.clone()).await?;
        Ok(updated)
    }

    /// 暂停:任务落到 `paused`,worker 不再继续;`resume` 之前不会被取到。
    pub async fn pause(&self, job: &Job) -> Result<Job> {
        let mut paused = job.clone();
        paused.state = JobState::Paused;
        paused.started_at = None;
        JobRepo::update(self.meta.as_ref(), paused.clone()).await?;
        Ok(paused)
    }

    /// 继续:把 `paused` 的任务放回 `queued`。
    pub async fn resume(&self, job_id: &str) -> Result<Option<Job>> {
        let Some(job) = JobRepo::get(self.meta.as_ref(), job_id).await? else {
            return Ok(None);
        };
        if job.state != JobState::Paused {
            return Ok(Some(job));
        }
        let mut resumed = job;
        resumed.state = JobState::Queued;
        resumed.started_at = None;
        JobRepo::update(self.meta.as_ref(), resumed.clone()).await?;
        self.wake.notify_one();
        Ok(Some(resumed))
    }

    /// 让出:回到 `queued`,保留检查点。
    pub async fn yield_job(&self, job: &Job) -> Result<Job> {
        let mut yielded = job.clone();
        yielded.state = JobState::Queued;
        yielded.started_at = None;
        JobRepo::update(self.meta.as_ref(), yielded.clone()).await?;
        Ok(yielded)
    }

    /// 结束任务。
    pub async fn finish(&self, job: &Job, state: JobState, error: Option<String>) -> Result<Job> {
        let mut finished = job.clone();
        finished.state = state;
        finished.error = error;
        finished.finished_at = Some(now_millis());
        JobRepo::update(self.meta.as_ref(), finished.clone()).await?;
        Ok(finished)
    }

    /// 启动恢复:`running` → `queued`,返回受影响的任务数。
    pub async fn recover(&self) -> Result<u64> {
        JobRepo::requeue_running(self.meta.as_ref()).await
    }

    /// 按 id 取任务。
    pub async fn get(&self, id: &str) -> Result<Option<Job>> {
        JobRepo::get(self.meta.as_ref(), id).await
    }

    /// 列出任务。
    pub async fn list(&self, state: Option<JobState>) -> Result<Vec<Job>> {
        JobRepo::list(self.meta.as_ref(), state).await
    }

    /// 列出任务摘要(不含 payload / checkpoint),只做展示时用这个。
    pub async fn list_summaries(&self, state: Option<JobState>) -> Result<Vec<Job>> {
        JobRepo::list_summaries(self.meta.as_ref(), state).await
    }

    /// 清理早于 `before` 的失败任务(`dry_run` 只数不删),返回条数。
    pub async fn prune_failed(&self, before: Millis, dry_run: bool) -> Result<u64> {
        JobRepo::prune_failed(self.meta.as_ref(), before, dry_run).await
    }
}

/// 估算剩余秒数。
///
/// `rate` 是“块/秒”（设计规范）,所以先把剩余文件数换算成剩余块数:
/// 用“已嵌入块数 ÷ 已处理文件数”估每个文件的平均块数。
pub fn eta_seconds(
    done_files: u64,
    total_files: Option<u64>,
    embedded_chunks: u64,
    rate: Option<f64>,
) -> Option<f64> {
    let total = total_files?;
    let rate = rate.filter(|rate| *rate > 0.0)?;
    let remaining_files = total.saturating_sub(done_files) as f64;
    if remaining_files == 0.0 {
        return Some(0.0);
    }
    let average_chunks = if done_files > 0 {
        embedded_chunks as f64 / done_files as f64
    } else {
        return None;
    };
    Some(remaining_files * average_chunks / rate)
}

fn payload_mode(payload: &Value) -> Option<&str> {
    payload.get("mode").and_then(Value::as_str)
}

/// payload 是否带手动阶段开关(`phase` 非空,或 `stop_after_text` 为 true)。
fn payload_is_staged(payload: &Value) -> bool {
    payload.get("phase").is_some_and(|value| !value.is_null())
        || payload
            .get("stop_after_text")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

/// 解析 JSON 后判断是否带手动阶段开关;坏 payload 不参与合并(交给 worker 报错)。
fn payload_is_staged_str(payload: &str) -> bool {
    serde_json::from_str::<Value>(payload)
        .map(|value| payload_is_staged(&value))
        .unwrap_or(true)
}

fn payload_mode_str(payload: &str) -> Option<&'static str> {
    let value: Value = serde_json::from_str(payload).ok()?;
    match payload_mode(&value) {
        Some("incremental") => Some("incremental"),
        Some("full") => Some("full"),
        _ => None,
    }
}

/// 把新请求合并进已有任务(主要合并 `paths`)。
fn merge_into(mut existing: Job, request: &NewJob) -> Result<Job> {
    let mut payload: Value = serde_json::from_str(&existing.payload_json)
        .map_err(|err| KbError::Internal(format!("解析任务 payload 失败: {err}")))?;
    let merged_paths = merge_paths(&payload, &request.payload);
    payload["paths"] = Value::Array(merged_paths.into_iter().map(Value::String).collect());
    existing.payload_json = payload.to_string();
    existing.priority = existing.priority.max(request.priority);
    Ok(existing)
}

fn merge_paths(left: &Value, right: &Value) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for value in [left, right] {
        if let Some(items) = value.get("paths").and_then(Value::as_array) {
            for item in items {
                if let Some(path) = item.as_str()
                    && !paths.iter().any(|existing| existing == path)
                {
                    paths.push(path.to_owned());
                }
            }
        }
    }
    paths
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

fn new_job_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eta_is_derived_from_chunk_rate() {
        // 每个文件 10 块,速率 10 块/秒:还剩 100 个文件 → 100 秒
        assert_eq!(eta_seconds(0, Some(100), 0, Some(10.0)), None);
        assert_eq!(eta_seconds(50, Some(100), 500, Some(10.0)), Some(50.0));
        assert_eq!(eta_seconds(100, Some(100), 1000, Some(5.0)), Some(0.0));
        assert_eq!(eta_seconds(0, None, 0, Some(5.0)), None);
        assert_eq!(eta_seconds(0, Some(10), 0, Some(0.0)), None);
    }

    #[test]
    fn priorities_match_the_plan() {
        let order = [
            priority::EDIT_ITEM,
            priority::SAVE_INSIGHT,
            priority::HOOK_INCREMENTAL,
            priority::REVIEW_EXTRACT,
            priority::FULL_INDEX,
            priority::MIGRATE,
            priority::MAINTENANCE,
        ];
        for window in order.windows(2) {
            assert!(window[0] > window[1], "优先级应从高到低排列:{window:?}");
        }
    }

    #[test]
    fn merging_paths_dedupes() {
        let left = serde_json::json!({"paths": ["a", "b"]});
        let right = serde_json::json!({"paths": ["b", "c"]});
        assert_eq!(merge_paths(&left, &right), vec!["a", "b", "c"]);
    }

    #[test]
    fn new_job_payloads_carry_mode() {
        let full = NewJob::full_index("p1", "proj_demo");
        assert_eq!(payload_mode(&full.payload), Some("full"));
        let incremental = NewJob::incremental_index("p1", "proj_demo", &["src/a.rs".to_owned()]);
        assert_eq!(payload_mode(&incremental.payload), Some("incremental"));
        assert_eq!(incremental.priority, priority::HOOK_INCREMENTAL);
    }
}
