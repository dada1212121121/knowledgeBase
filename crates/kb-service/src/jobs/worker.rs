//! 任务 worker:多条循环并行跑不同任务,分片保存检查点,可被更高优先级任务或关闭信号打断。

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{Job, JobState};
use tokio::sync::watch;

use std::collections::HashMap;

use kb_core::KbError;

use crate::jobs::queue::JobQueue;
use crate::jobs::slots::{Lane, SliceGate, lane_of};

/// 一个分片的执行结果。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SliceProgress {
    /// 已完成的工作量。
    pub done: u64,
    /// 总工作量(未知时为 `None`)。
    pub total: Option<u64>,
    /// 整个任务是否已经完成。
    pub finished: bool,
    /// 新的检查点(JSON)。
    pub checkpoint: Option<String>,
    /// 本分片里的非致命错误。
    pub errors: Vec<String>,
    /// 速率口径:累计已嵌入的块数(设计规范用块/秒)。
    pub rate_basis: u64,
    /// 批次被暂停:任务转 `paused`,不再继续取文件。
    pub paused: bool,
}

/// 任务进度观察者(Web 端 `/api/v1/ws` 的 `job.progress` / `job.done` 推送用)。
///
/// 由组装根(`kb-cli`)实现并注入,`kb-service` 只负责在状态变化时回调,
/// 不关心事件最终发到哪里。
pub trait JobObserver: Send + Sync {
    /// 一个分片跑完、进度与速率已经落库。
    fn on_progress(&self, job: &Job, progress: &SliceProgress);
    /// 任务结束(完成 / 失败 / 让出回队列)。
    fn on_finish(&self, job: &Job);
}

/// 任务处理器:每种任务类型实现一个。
#[async_trait]
pub trait JobHandler: Send + Sync {
    /// 这条任务走哪条通道(批量 / 交互,B8)。
    ///
    /// 为什么由处理器自己声明、而不是在 `slots` 里按 `kind` 字符串判:通道取决于**活的性质**,
    /// 而「这批活是什么性质」只有处理器知道。原来 `slots::lane_of` 里挂着一条
    /// `job_kind == "ingest"` 的特例(解析优先级 90 但必须走批量,否则几百份导入会把 2 个
    /// 交互席位占死),新增一种任务就得回去改那张全局表,漏了就是一次「莫名其妙只有 2 个文件
    /// 在跑」。默认**批量**:长活是常态,要交互的处理器自己声明。
    ///
    /// **装饰器必须转发**:包一层别的处理器(限速、重试、计数)时要把 `lane` 一起转出去,
    /// 否则内层声明的交互通道会被默认值吞掉,表现是「本来插队的活排到了队尾」——
    /// `kb-service/tests/jobs.rs` 的 `higher_priority_job_runs_alongside_the_full_index`
    /// 就是靠这一条抓出来的。
    fn lane(&self, _job: &Job) -> Lane {
        Lane::Bulk
    }

    /// 执行一个分片;`job.checkpoint_json` 是上一次保存的检查点。
    async fn run_slice(&self, job: &Job) -> Result<SliceProgress>;
}

/// 按 `job.kind` 分发到具体处理器。
#[derive(Default)]
pub struct JobRouter {
    routes: HashMap<String, Arc<dyn JobHandler>>,
}

impl JobRouter {
    /// 空路由。
    pub fn new() -> Self {
        Self::default()
    }

    /// 注册一种任务类型。
    pub fn register(&mut self, kind: &str, handler: Arc<dyn JobHandler>) {
        self.routes.insert(kind.to_owned(), handler);
    }
}

#[async_trait]
impl JobHandler for JobRouter {
    /// 按 `job.kind` 交给对应处理器判定;没注册的 kind 按优先级兜底
    /// (它会因为「没有处理器」在 `run_slice` 里失败,这里只是别让名额判定先 panic)。
    fn lane(&self, job: &Job) -> Lane {
        match self.routes.get(&job.kind) {
            Some(handler) => handler.lane(job),
            None => lane_of(job.priority),
        }
    }

    async fn run_slice(&self, job: &Job) -> Result<SliceProgress> {
        match self.routes.get(&job.kind) {
            Some(handler) => handler.run_slice(job).await,
            None => Err(KbError::InvalidInput(format!(
                "没有为任务类型 {} 注册处理器",
                job.kind
            ))),
        }
    }
}

/// 兜底轮询间隔:入队会主动叫醒 worker,轮询只负责发现别的进程直接写库的任务。
pub const DEFAULT_IDLE_POLL: Duration = Duration::from_secs(5);

/// 一个知识库的后台同时开几条循环去抢任务。
///
/// 真正能同时干活的片数由全站名额(`index.parallel_slices`,热读)决定,这里只是把循环开够,
/// 让机器不在「一个文件在嵌入、其余文件连解析都排不上」时空转。
/// 上限跟 `kb_core::config::IndexConfig::MAX_PARALLEL_SLICES` 对齐:再多循环也只是在名额上排队。
const MAX_PARALLEL_SLICES: usize = 8;

/// 任务 worker(`run` 会开多条循环,并发度由全站名额决定)。
pub struct Worker {
    queue: Arc<JobQueue>,
    handler: Arc<dyn JobHandler>,
    shutdown: watch::Receiver<bool>,
    idle_poll: Duration,
    observer: Option<Arc<dyn JobObserver>>,
    /// 跨知识库共享的分片名额(多用户公平调度);`None` 表示不限(嵌入式 CLI、单库)。
    slots: Option<Arc<SliceGate>>,
}

impl Worker {
    /// 构造;`shutdown` 收到 `true` 后不再开始新分片。
    pub fn new(
        queue: Arc<JobQueue>,
        handler: Arc<dyn JobHandler>,
        shutdown: watch::Receiver<bool>,
    ) -> Self {
        Self {
            queue,
            handler,
            shutdown,
            idle_poll: DEFAULT_IDLE_POLL,
            observer: None,
            slots: None,
        }
    }

    /// 改兜底轮询间隔(默认 [`DEFAULT_IDLE_POLL`])。入队会主动叫醒 worker,
    /// 这个间隔只用来发现别的进程直接写库的任务。
    pub fn with_idle_poll(mut self, idle_poll: Duration) -> Self {
        self.idle_poll = idle_poll;
        self
    }

    /// 接入全站共享的分片名额:每个分片开始前先领名额、做完归还,各知识库轮流用。
    pub fn with_slots(mut self, slots: Arc<SliceGate>) -> Self {
        self.slots = Some(slots);
        self
    }

    /// 挂一个进度观察者(WS 推送)。
    pub fn with_observer(mut self, observer: Arc<dyn JobObserver>) -> Self {
        self.observer = Some(observer);
        self
    }

    fn notify_progress(&self, job: &Job, progress: &SliceProgress) {
        if let Some(observer) = &self.observer {
            observer.on_progress(job, progress);
        }
    }

    fn notify_finish(&self, job: &Job) {
        if let Some(observer) = &self.observer {
            observer.on_finish(job);
        }
    }

    fn shutting_down(&self) -> bool {
        *self.shutdown.borrow()
    }

    /// 取一个任务并执行,直到完成、失败、让出或收到关闭信号。
    pub async fn run_once(&self) -> Result<Option<Job>> {
        // 先看下一个任务是哪个优先级、走哪条通道(只读,不认领),按它领名额。
        // 名额到手才认领:否则好几个循环会把任务都标成 `running` 干等着名额,
        // 界面上一堆任务在「跑」、实际上一个都没动。
        let Some(peek) = self.queue.next().await? else {
            return Ok(None);
        };
        let mut permit = match &self.slots {
            Some(slots) => Some(slots.acquire(self.handler.lane(&peek)).await),
            None => None,
        };
        // 认领 = 「挑一个 + 转 running」同一个写事务。别的循环刚把它领走时这里拿到 None,
        // 名额还给别人,下一轮重新看队列。
        let Some(job) = self.queue.claim_next().await? else {
            drop(permit);
            return Ok(None);
        };
        let mut job = job;
        // 认领到的未必是刚才看到的那个(可能被别的循环领走了,通道也可能不同),
        // 就按任务自己的通道重新领,别让交互任务占着批量名额(反之亦然)。
        if permit
            .as_ref()
            .is_some_and(|held| held.lane() != self.handler.lane(&job))
        {
            drop(permit.take());
        }
        let mut rate_state: Option<(u64, tokio::time::Instant)> = None;
        loop {
            // 名额只覆盖「执行这一片」本身:第一片用刚才领的,之后的每一片重新领
            // (做完一片就该排到队尾,让别的知识库先走)。
            let permit = match permit.take() {
                Some(held) => Some(held),
                None => match &self.slots {
                    Some(slots) => Some(slots.acquire(self.handler.lane(&job)).await),
                    None => None,
                },
            };
            let progress = self.handler.run_slice(&job).await;
            drop(permit);
            match progress {
                Ok(progress) => {
                    // 速率按“块/秒”的指数滑动平均（设计规范）
                    let now = tokio::time::Instant::now();
                    let instant_rate = match rate_state {
                        Some((basis, at)) => {
                            let delta = progress.rate_basis.saturating_sub(basis) as f64;
                            let seconds = now.duration_since(at).as_secs_f64().max(0.001);
                            delta / seconds
                        }
                        None => 0.0,
                    };
                    rate_state = Some((progress.rate_basis, now));
                    let rate = match job.rate {
                        Some(previous) => Some(previous * 0.7 + instant_rate * 0.3),
                        None => Some(instant_rate),
                    };
                    job = self
                        .queue
                        .progress(
                            &job,
                            progress.done,
                            progress.total,
                            rate,
                            // 检查点要留给观察者,不能直接 move 进队列
                            progress.checkpoint.clone(),
                        )
                        .await?;
                    self.notify_progress(&job, &progress);
                    // 批次被暂停:任务落到 `paused`,重启后仍保持暂停
                    if progress.paused {
                        let paused = self.queue.pause(&job).await?;
                        self.notify_finish(&paused);
                        return Ok(Some(paused));
                    }
                    if progress.finished {
                        let error = if progress.errors.is_empty() {
                            None
                        } else {
                            Some(progress.errors.join("; "))
                        };
                        let finished = self.queue.finish(&job, JobState::Done, error).await?;
                        self.notify_finish(&finished);
                        return Ok(Some(finished));
                    }
                    // 让出:收到关闭信号,或队列里有更高优先级的任务
                    if self.shutting_down() || self.queue.has_higher_priority(job.priority).await? {
                        let yielded = self.queue.yield_job(&job).await?;
                        self.notify_finish(&yielded);
                        return Ok(Some(yielded));
                    }
                }
                Err(err) => {
                    let failed = self
                        .queue
                        .finish(&job, JobState::Failed, Some(err.to_string()))
                        .await?;
                    self.notify_finish(&failed);
                    return Ok(Some(failed));
                }
            }
        }
    }

    /// 执行到队列为空(CLI 嵌入式模式用)。
    pub async fn run_until_idle(&self) -> Result<()> {
        while self.run_once().await?.is_some() {
            if self.shutting_down() {
                return Ok(());
            }
        }
        Ok(())
    }

    /// 循环执行,直到收到关闭信号(守护进程用)。
    ///
    /// 开 [`MAX_PARALLEL_SLICES`] 条循环并行跑**不同任务**(一个知识库过去一次只跑一片,
    /// 一次导入几百个单文件批次时机器大半时间是闲的:一个文件在嵌入,别的文件连解析都不能开始)。
    /// 真正的并发度由全站名额(`index.parallel_slices`,热读)决定,多开的循环只是在
    /// `acquire` 上等着,既不会超额干活,也不会多占数据库连接。
    pub async fn run(self: Arc<Self>) -> Result<()> {
        let mut loops = tokio::task::JoinSet::new();
        for _ in 0..MAX_PARALLEL_SLICES {
            let worker = self.clone();
            loops.spawn(async move { worker.run_loop().await });
        }
        // 循环只在收到关闭信号后才会退出;任何一个出错都记日志,但不影响其余分片
        while let Some(joined) = loops.join_next().await {
            match joined {
                Ok(Ok(())) => {}
                Ok(Err(err)) => tracing::warn!(error = %err, "worker 退出"),
                Err(err) => tracing::warn!(error = %err, "worker 任务异常结束"),
            }
        }
        Ok(())
    }

    /// 一条循环:有活就干,没活就等(`run` 会开好几条)。
    async fn run_loop(&self) -> Result<()> {
        let wake = self.queue.wake().clone();
        loop {
            if self.shutting_down() {
                return Ok(());
            }
            // 先登记「有新任务就叫我」,再查队列:查完到开始等之间入队的任务不会漏
            let notified = wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            match self.run_once().await {
                Ok(Some(_)) => continue,
                Ok(None) => {
                    if self.shutting_down() {
                        return Ok(());
                    }
                    self.wait_for_work(notified).await;
                }
                Err(err) => {
                    tracing::warn!(error = %err, "worker 执行任务失败");
                    self.wait_for_work(notified).await;
                }
            }
        }
    }

    /// 空闲时等:有人入队 / 继续任务、兜底间隔到点、或收到关闭信号,三者先到者醒。
    ///
    /// 以前是每 200 毫秒查一次库,每个打开过的知识库一个 worker,空闲也永不停。
    /// 现在入队主动叫醒;兜底轮询只负责发现别的进程直接写库的任务(比如嵌入式 CLI),
    /// 所以间隔可以拉长。
    async fn wait_for_work(
        &self,
        notified: std::pin::Pin<&mut tokio::sync::futures::Notified<'_>>,
    ) {
        let mut shutdown = self.shutdown.clone();
        // 关闭信号在上次检查之后、克隆之前到的话,克隆出来的接收端会把它当「已看过」,这里补一次检查
        if *shutdown.borrow_and_update() {
            return;
        }
        tokio::select! {
            () = notified => {}
            () = tokio::time::sleep(self.idle_poll) => {}
            // 发送端被丢掉时 `changed` 会一直立刻返回错误,不能让它把等待变成空转,所以这一支改成永远等
            () = async {
                if shutdown.changed().await.is_err() {
                    std::future::pending::<()>().await;
                }
            } => {}
        }
    }
}
