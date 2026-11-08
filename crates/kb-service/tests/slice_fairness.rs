//! 公平调度(多用户设计说明):多个知识库共用有限的分片名额,轮流用;
//! 一个知识库的大批量导入不能让别人的任务等到它做完。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use kb_core::model::Job;
use kb_service::jobs::slots::SliceGate;
use kb_service::jobs::{JobHandler, JobQueue, NewJob, SliceProgress, Worker, priority};
use kb_testkit::TestEnv;
use tokio::sync::watch;

/// 一个假的「知识库」:有自己的队列和 worker,处理器记录每个分片的顺序与并发。
struct Space {
    queue: Arc<JobQueue>,
    worker: Arc<Worker>,
    _env: TestEnv,
}

struct Recorder {
    name: &'static str,
    slices: usize,
    delay: Duration,
    done: AtomicUsize,
    log: Arc<Mutex<Vec<&'static str>>>,
    running: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

#[async_trait]
impl JobHandler for Recorder {
    async fn run_slice(&self, _job: &Job) -> kb_core::Result<SliceProgress> {
        let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
        self.peak.fetch_max(now, Ordering::SeqCst);
        tokio::time::sleep(self.delay).await;
        self.log.lock().unwrap().push(self.name);
        self.running.fetch_sub(1, Ordering::SeqCst);
        let done = self.done.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(SliceProgress {
            done: done as u64,
            total: Some(self.slices as u64),
            finished: done >= self.slices,
            ..Default::default()
        })
    }
}

struct Shared {
    log: Arc<Mutex<Vec<&'static str>>>,
    running: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
}

async fn space(
    shared: &Shared,
    gate: &Arc<SliceGate>,
    name: &'static str,
    slices: usize,
    delay_ms: u64,
    job_priority: i32,
) -> Space {
    let env = TestEnv::new().await;
    let queue = Arc::new(JobQueue::new(env.meta.clone()));
    queue
        .enqueue(NewJob {
            kind: "index".to_owned(),
            collection: None,
            priority: job_priority,
            payload: serde_json::json!({}),
        })
        .await
        .expect("入队");
    let (_tx, rx) = watch::channel(false);
    let handler = Arc::new(Recorder {
        name,
        slices,
        delay: Duration::from_millis(delay_ms),
        done: AtomicUsize::new(0),
        log: shared.log.clone(),
        running: shared.running.clone(),
        peak: shared.peak.clone(),
    });
    let worker = Arc::new(Worker::new(queue.clone(), handler, rx).with_slots(gate.clone()));
    Space {
        queue,
        worker,
        _env: env,
    }
}

fn shared() -> Shared {
    Shared {
        log: Arc::new(Mutex::new(Vec::new())),
        running: Arc::new(AtomicUsize::new(0)),
        peak: Arc::new(AtomicUsize::new(0)),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn spaces_take_turns_so_a_small_job_does_not_wait_for_a_huge_one() {
    let shared = shared();
    let gate = SliceGate::fixed(1);
    // A 是个 10 片的大批量,B 是只有 2 片的小任务;名额全站只有 1 个
    let a = space(&shared, &gate, "A", 10, 20, priority::FULL_INDEX).await;
    let b = space(&shared, &gate, "B", 2, 20, priority::FULL_INDEX).await;
    let (wa, wb) = (a.worker.clone(), b.worker.clone());
    let task_a = tokio::spawn(async move { wa.run_once().await });
    // 让 A 先开始,再让 B 进来
    tokio::time::sleep(Duration::from_millis(30)).await;
    let task_b = tokio::spawn(async move { wb.run_once().await });
    task_b.await.unwrap().unwrap();
    let log_when_b_done = shared.log.lock().unwrap().clone();
    task_a.await.unwrap().unwrap();
    let a_slices_before_b_finished = log_when_b_done.iter().filter(|name| **name == "A").count();
    assert!(
        a_slices_before_b_finished < 10,
        "B 做完时 A 还没做完,B 没有被饿着:{log_when_b_done:?}"
    );
    assert_eq!(
        shared.peak.load(Ordering::SeqCst),
        1,
        "全站名额是 1:任何时刻最多一个分片在跑"
    );
    let log = shared.log.lock().unwrap().clone();
    assert_eq!(log.iter().filter(|n| **n == "A").count(), 10);
    assert_eq!(log.iter().filter(|n| **n == "B").count(), 2);
    // 交替执行:A 的分片之间夹着 B 的
    let first_b = log.iter().position(|n| *n == "B").unwrap();
    let last_b = log.iter().rposition(|n| *n == "B").unwrap();
    assert!(
        log[first_b..=last_b].contains(&"A"),
        "两个知识库应交替,而不是一个做完另一个才开始:{log:?}"
    );
    drop((a.queue, b.queue));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_note_save_slice_runs_at_once_even_while_bulk_work_holds_every_slot() {
    let shared = shared();
    let gate = SliceGate::fixed(1);
    let bulk = space(&shared, &gate, "BULK", 6, 80, priority::FULL_INDEX).await;
    let note = space(&shared, &gate, "NOTE", 1, 5, priority::SAVE_INSIGHT).await;
    let (wb, wn) = (bulk.worker.clone(), note.worker.clone());
    let task_bulk = tokio::spawn(async move { wb.run_once().await });
    tokio::time::sleep(Duration::from_millis(30)).await; // 批量分片正占着唯一的名额
    let started = std::time::Instant::now();
    tokio::spawn(async move { wn.run_once().await })
        .await
        .unwrap()
        .unwrap();
    assert!(
        started.elapsed() < Duration::from_millis(250),
        "保存笔记不该排在别人的批量导入后面,实际等了 {:?}",
        started.elapsed()
    );
    let log = shared.log.lock().unwrap().clone();
    assert_eq!(log.last().copied(), Some("NOTE"), "{log:?}");
    assert!(log.iter().filter(|n| **n == "BULK").count() < 6, "{log:?}");
    task_bulk.await.unwrap().unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn without_a_gate_workers_are_unrestricted_as_before() {
    let shared = shared();
    // 不挂名额(嵌入式 CLI):行为和以前一样,两个 worker 可以同时跑
    let gate = SliceGate::fixed(1);
    let a = space(&shared, &gate, "A", 3, 40, priority::FULL_INDEX).await;
    let b = space(&shared, &gate, "B", 3, 40, priority::FULL_INDEX).await;
    let (_tx, rx) = watch::channel(false);
    let free_a = Worker::new(
        a.queue.clone(),
        Arc::new(Recorder {
            name: "A",
            slices: 3,
            delay: Duration::from_millis(40),
            done: AtomicUsize::new(0),
            log: shared.log.clone(),
            running: shared.running.clone(),
            peak: shared.peak.clone(),
        }),
        rx.clone(),
    );
    let free_b = Worker::new(
        b.queue.clone(),
        Arc::new(Recorder {
            name: "B",
            slices: 3,
            delay: Duration::from_millis(40),
            done: AtomicUsize::new(0),
            log: shared.log.clone(),
            running: shared.running.clone(),
            peak: shared.peak.clone(),
        }),
        rx,
    );
    let (ra, rb) = tokio::join!(free_a.run_once(), free_b.run_once());
    ra.unwrap();
    rb.unwrap();
    assert_eq!(shared.peak.load(Ordering::SeqCst), 2);
}
