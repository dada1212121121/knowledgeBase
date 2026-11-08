//! 任务队列「等久了提级」在 worker 层面的表现:取任务顺序、按片让出语义。
//!
//! 排序本身的细节(整分钟、封顶、迁移不越级……)在 `kb-meta/tests/job_aging.rs`;
//! 这里只确认 worker 真的按有效优先级取任务,并且「保存经验 / 编辑单条」仍能在片间抢占。
//! 等待时间靠直接写库造出过去的 `created_at`,不 sleep。

use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kb_core::model::{Job, JobState};
use kb_core::ports::repo::JobRepo;
use kb_core::timezone::now_millis;
use kb_service::jobs::{JobHandler, JobQueue, NewJob, SliceProgress, Worker, priority};
use kb_testkit::TestEnv;
use tokio::sync::watch;

const MINUTE: i64 = 60_000;

/// 记录每个分片跑的是哪个任务;`on_first_slice` 在第一个分片里往队列里塞一个新任务,
/// 模拟「索引做到一半,别的会话又改了仓库 / 用户保存了一条经验」。
struct Recorder {
    queue: Arc<JobQueue>,
    log: Mutex<Vec<String>>,
    /// id 为 `full` 的任务要跑几片才算完成;其余任务(测试中途塞进来的)一片就完成。
    slices: usize,
    on_first_slice: Mutex<Option<NewJob>>,
}

#[async_trait]
impl JobHandler for Recorder {
    async fn run_slice(&self, job: &Job) -> kb_core::Result<SliceProgress> {
        let done_before = {
            let mut log = self.log.lock().unwrap();
            let done = log.iter().filter(|id| **id == job.id).count();
            log.push(job.id.clone());
            done
        };
        // 先把值取出来再 await:`if let` 的临时 MutexGuard 会活到整个块结束,跨 await 持锁
        let extra = self.on_first_slice.lock().unwrap().take();
        if let Some(extra) = extra {
            self.queue.enqueue(extra).await.expect("中途入队");
        }
        let done = done_before + 1;
        let total = if job.id == "full" { self.slices } else { 1 };
        // 和真实处理器(索引 / 迁移)一样,每做完一片就留下检查点:提级只奖励还没开始的任务
        Ok(SliceProgress {
            done: done as u64,
            total: Some(total as u64),
            finished: done >= total,
            checkpoint: Some(format!("{{\"done\":{done}}}")),
            ..Default::default()
        })
    }
}

struct Fixture {
    worker: Worker,
    handler: Arc<Recorder>,
    env: TestEnv,
    _keep_alive: watch::Sender<bool>,
}

async fn fixture(slices: usize, on_first_slice: Option<NewJob>) -> Fixture {
    let env = TestEnv::new().await;
    let queue = Arc::new(JobQueue::new(env.meta.clone()));
    let handler = Arc::new(Recorder {
        queue: queue.clone(),
        log: Mutex::new(Vec::new()),
        slices,
        on_first_slice: Mutex::new(on_first_slice),
    });
    let (tx, rx) = watch::channel(false);
    let worker = Worker::new(queue.clone(), handler.clone(), rx);
    Fixture {
        worker,
        handler,
        env,
        _keep_alive: tx,
    }
}

/// 直接写库造一个「`waited_minutes` 分钟前就入队」的任务;`JobQueue::enqueue` 只会盖当前时间。
async fn enqueue_aged(env: &TestEnv, id: &str, job_priority: i32, waited_minutes: i64) {
    JobRepo::enqueue(
        env.meta.as_ref(),
        Job {
            id: id.to_owned(),
            kind: "index".to_owned(),
            collection: None,
            priority: job_priority,
            state: JobState::Queued,
            payload_json: "{}".to_owned(),
            checkpoint_json: None,
            detail: None,
            progress_done: 0,
            progress_total: None,
            rate: None,
            error: None,
            created_at: now_millis() - waited_minutes * MINUTE,
            started_at: None,
            finished_at: None,
        },
    )
    .await
    .expect("入队");
}

fn log_of(fixture: &Fixture) -> Vec<String> {
    fixture.handler.log.lock().unwrap().clone()
}

/// 现场的问题:新项目的全量索引(20)排在不断到来的增量(80)后面。
/// 全量已经等了 30 分钟,worker 应当先做它,而不是先做刚入队的增量。
#[tokio::test]
async fn the_worker_runs_a_long_waiting_full_index_before_a_newer_incremental_job() {
    let fixture = fixture(1, None).await;
    enqueue_aged(&fixture.env, "full", priority::FULL_INDEX, 30).await;
    enqueue_aged(&fixture.env, "incremental", priority::HOOK_INCREMENTAL, 0).await;

    while fixture.worker.run_once().await.expect("执行").is_some() {}

    assert_eq!(log_of(&fixture), ["full", "incremental"]);
}

/// 对照:刚入队的全量索引没有提级,增量照旧先走(提级只奖励「等」,不改变日常顺序)。
#[tokio::test]
async fn a_freshly_queued_full_index_still_waits_for_the_incremental_job() {
    let fixture = fixture(1, None).await;
    enqueue_aged(&fixture.env, "full", priority::FULL_INDEX, 0).await;
    enqueue_aged(&fixture.env, "incremental", priority::HOOK_INCREMENTAL, 0).await;

    while fixture.worker.run_once().await.expect("执行").is_some() {}

    assert_eq!(log_of(&fixture), ["incremental", "full"]);
}

/// 按片调度的让出不变:等久了的全量索引做到一半,用户保存了一条经验(90)——
/// 全量最多提到 80,仍要在片间让出给它,保存经验先做完再回来续跑。
#[tokio::test]
async fn an_aged_full_index_still_yields_to_a_save_insight_job_between_slices() {
    let save = NewJob {
        kind: "save_insight".to_owned(),
        collection: None,
        priority: priority::SAVE_INSIGHT,
        payload: serde_json::json!({}),
    };
    let fixture = fixture(3, Some(save)).await;
    enqueue_aged(&fixture.env, "full", priority::FULL_INDEX, 30).await;

    // 第一次执行:全量第 1 片 → 队列里出现保存经验 → 让出,run_once 返回(未完成)
    let yielded = fixture
        .worker
        .run_once()
        .await
        .expect("执行")
        .expect("有任务");
    assert_eq!(yielded.id, "full");
    assert_eq!(yielded.state, JobState::Queued, "应当让出回队列");

    while fixture.worker.run_once().await.expect("执行").is_some() {}

    let log = log_of(&fixture);
    assert_eq!(log.len(), 4, "全量 3 片 + 保存经验 1 片:{log:?}");
    assert_eq!(log[0], "full");
    assert_ne!(
        log[1], "full",
        "第 2 个分片必须是保存经验,不能是全量续跑:{log:?}"
    );
    assert_eq!(&log[2..], ["full", "full"], "保存经验做完后全量续跑");
}

/// 等久了的全量索引**开始之后**就不再享受提级:做完第一片留下检查点,此时来了一个新增量(80),
/// 增量要在片间抢到它前面。否则这个全量(20 → 80,且入队更早)会每片让出后又被自己取回,
/// 一个大项目的全量索引能把所有项目的实时增量挡几个小时。
#[tokio::test]
async fn a_started_full_index_yields_to_a_new_incremental_job_between_slices() {
    let incremental = NewJob {
        kind: "index".to_owned(),
        collection: Some("proj_demo".to_owned()),
        priority: priority::HOOK_INCREMENTAL,
        payload: serde_json::json!({ "mode": "incremental", "paths": [] }),
    };
    let fixture = fixture(3, Some(incremental)).await;
    enqueue_aged(&fixture.env, "full", priority::FULL_INDEX, 30).await;

    while fixture.worker.run_once().await.expect("执行").is_some() {}

    let log = log_of(&fixture);
    assert_eq!(log.len(), 4, "全量 3 片 + 增量 1 片:{log:?}");
    assert_eq!(log[0], "full", "等够久的全量先开始:{log:?}");
    assert_ne!(
        log[1], "full",
        "第 1 片之后新来的增量必须先于全量续跑:{log:?}"
    );
    assert_eq!(&log[2..], ["full", "full"], "增量做完后全量续跑:{log:?}");
}
