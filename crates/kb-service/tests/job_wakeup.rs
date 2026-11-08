//! 任务入队主动唤醒空闲的 worker,空闲时不再每 200 毫秒查一次库。

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Job, JobState};
use kb_core::ports::repo::JobRepo;
use kb_service::jobs::{JobHandler, JobQueue, NewJob, SliceProgress, Worker};
use kb_testkit::TestEnv;
use tokio::sync::watch;

/// 每跑一个分片就计一次数,一个分片就把任务做完。
struct Counting {
    ran: Arc<AtomicUsize>,
}

#[async_trait]
impl JobHandler for Counting {
    async fn run_slice(&self, _job: &Job) -> Result<SliceProgress> {
        self.ran.fetch_add(1, Ordering::SeqCst);
        Ok(SliceProgress {
            finished: true,
            ..SliceProgress::default()
        })
    }
}

fn noop_job() -> NewJob {
    NewJob {
        kind: "noop".to_owned(),
        collection: None,
        priority: 50,
        payload: serde_json::json!({}),
    }
}

/// 等计数器到达 `expected`;超时返回当前值。
async fn wait_for(counter: &AtomicUsize, expected: usize, within: Duration) -> usize {
    let deadline = tokio::time::Instant::now() + within;
    while tokio::time::Instant::now() < deadline {
        if counter.load(Ordering::SeqCst) >= expected {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    counter.load(Ordering::SeqCst)
}

struct Rig {
    env: TestEnv,
    ran: Arc<AtomicUsize>,
    worker: Arc<Worker>,
    shutdown: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

/// 起一个 worker 并让它先空转一会儿(进入空闲等待)。`fallback` 是兜底轮询间隔。
async fn start(fallback: Duration) -> Rig {
    let env = TestEnv::new().await;
    let ran = Arc::new(AtomicUsize::new(0));
    let (shutdown, rx) = watch::channel(false);
    let worker = Arc::new(
        Worker::new(
            Arc::new(JobQueue::new(env.meta.clone())),
            Arc::new(Counting { ran: ran.clone() }),
            rx,
        )
        .with_idle_poll(fallback),
    );
    let runner = worker.clone();
    let task = tokio::spawn(async move {
        let _ = runner.run().await;
    });
    // 给它时间跑完第一轮空查询,停在等待上
    tokio::time::sleep(Duration::from_millis(150)).await;
    Rig {
        env,
        ran,
        worker,
        shutdown,
        task,
    }
}

/// 兜底间隔设成 30 秒:任务能在 2 秒内被取走,只可能是入队时主动唤醒了 worker。
/// 入队用的是另一个 `JobQueue` 实例(生产里各服务各建各的队列对象,共享的只有元数据库)。
#[tokio::test]
async fn enqueue_wakes_an_idle_worker_without_waiting_for_the_fallback_poll() {
    let rig = start(Duration::from_secs(30)).await;
    let other_queue = JobQueue::new(rig.env.meta.clone());
    other_queue.enqueue(noop_job()).await.expect("入队");
    let ran = wait_for(&rig.ran, 1, Duration::from_secs(2)).await;
    assert_eq!(ran, 1, "入队后应立刻被取走,而不是等 30 秒的兜底轮询");
    let _ = rig.shutdown.send(true);
    let _ = rig.task.await;
    let _ = rig.worker;
}

/// 暂停的任务点「继续」也是入队语义,同样要立刻唤醒。
#[tokio::test]
async fn resume_wakes_an_idle_worker() {
    let rig = start(Duration::from_secs(30)).await;
    let queue = JobQueue::new(rig.env.meta.clone());
    // 先造一个暂停的任务:入队 → 标记运行 → 暂停(此时 worker 若醒来会取走排队中的,所以直接落库成 paused)
    let mut job = queue.enqueue(noop_job()).await.expect("入队");
    let _ = wait_for(&rig.ran, 1, Duration::from_secs(2)).await;
    job.state = JobState::Paused;
    job.finished_at = None;
    JobRepo::update(rig.env.meta.as_ref(), job.clone())
        .await
        .expect("改成暂停");
    tokio::time::sleep(Duration::from_millis(150)).await;
    let before = rig.ran.load(Ordering::SeqCst);

    queue.resume(&job.id).await.expect("继续");
    let after = wait_for(&rig.ran, before + 1, Duration::from_secs(2)).await;
    assert_eq!(after, before + 1, "继续后应立刻被取走");
    let _ = rig.shutdown.send(true);
    let _ = rig.task.await;
}

/// 别的进程(或绕过 JobQueue 的写入)不会触发唤醒,靠兜底轮询发现。
#[tokio::test]
async fn a_job_written_behind_the_queues_back_is_found_by_the_fallback_poll() {
    let rig = start(Duration::from_millis(100)).await;
    let queue = JobQueue::new(rig.env.meta.clone());
    // 借 JobQueue 造出一条任务行,再让它回到 queued——不经过 enqueue,所以没有唤醒
    let job = queue.enqueue(noop_job()).await.expect("入队");
    let _ = wait_for(&rig.ran, 1, Duration::from_secs(2)).await;
    let mut again = job.clone();
    again.id = "behind-the-back".to_owned();
    again.state = JobState::Queued;
    again.started_at = None;
    again.finished_at = None;
    JobRepo::enqueue(rig.env.meta.as_ref(), again)
        .await
        .expect("直接写库");
    let ran = wait_for(&rig.ran, 2, Duration::from_secs(3)).await;
    assert_eq!(ran, 2, "兜底轮询应在 100 毫秒量级发现它");
    let _ = rig.shutdown.send(true);
    let _ = rig.task.await;
}

/// 收到关闭信号时,空闲的 worker 立刻退出,不能等完 30 秒的兜底间隔。
#[tokio::test]
async fn shutdown_stops_an_idle_worker_promptly() {
    let rig = start(Duration::from_secs(30)).await;
    let _ = rig.shutdown.send(true);
    let finished = tokio::time::timeout(Duration::from_secs(2), rig.task).await;
    assert!(finished.is_ok(), "关闭信号应立刻让空闲的 worker 退出");
}

/// 关闭信号的发送端被丢掉(测试里常见 `watch::channel(false).1`)不能让等待变成空转,
/// 也不能让任务丢失:仍然靠兜底轮询取走。
#[tokio::test]
async fn a_dropped_shutdown_sender_still_lets_the_worker_idle_and_work() {
    let env = TestEnv::new().await;
    let ran = Arc::new(AtomicUsize::new(0));
    let worker = Arc::new(
        Worker::new(
            Arc::new(JobQueue::new(env.meta.clone())),
            Arc::new(Counting { ran: ran.clone() }),
            watch::channel(false).1,
        )
        .with_idle_poll(Duration::from_millis(200)),
    );
    let runner = worker.clone();
    let task = tokio::spawn(async move {
        let _ = runner.run().await;
    });
    tokio::time::sleep(Duration::from_millis(100)).await;
    JobQueue::new(env.meta.clone())
        .enqueue(noop_job())
        .await
        .expect("入队");
    assert_eq!(wait_for(&ran, 1, Duration::from_secs(2)).await, 1);
    task.abort();
}

/// 空闲的知识库关掉后台任务之前,先问队列「还有没有活」(后半):
/// 排队中、运行中算;暂停的(要等人点「继续」)、做完的不算。
#[tokio::test]
async fn has_pending_counts_queued_and_running_jobs_only() {
    let env = TestEnv::new().await;
    let queue = JobQueue::new(env.meta.clone());
    assert!(!queue.has_pending().await.expect("查"), "空队列");

    let job = queue.enqueue(noop_job()).await.expect("入队");
    assert!(queue.has_pending().await.expect("查"), "排队中");

    let running = queue.start(&job).await.expect("开始");
    assert!(queue.has_pending().await.expect("查"), "运行中");

    let paused = queue.pause(&running).await.expect("暂停");
    assert!(
        !queue.has_pending().await.expect("查"),
        "暂停的要等人点继续,不算待办"
    );

    queue.resume(&paused.id).await.expect("继续");
    assert!(queue.has_pending().await.expect("查"), "继续以后又排上了");

    let next = queue.next().await.expect("取").expect("有任务");
    let again = queue.start(&next).await.expect("开始");
    queue
        .finish(&again, JobState::Done, None)
        .await
        .expect("结束");
    assert!(!queue.has_pending().await.expect("查"), "做完了");
}
