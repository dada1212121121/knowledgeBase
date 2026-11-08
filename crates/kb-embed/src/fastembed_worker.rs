//! fastembed 工作线程（设计规范）。
//!
//! fastembed 的 `embed(&mut self, ..)` 是**同步阻塞**调用,绝不能在 tokio 工作线程里直接调用。
//! 这里起一个专用 `std::thread` 持有模型,通过 channel 收任务、用 oneshot 返回结果:
//!
//! - **查询优先**:每取一个批量任务之前,先把已经排队的查询任务全部处理掉;
//! - **按长度排序**:同一次请求内部按文本长度排序后分批,减少 padding 浪费;
//! - **空闲卸载**:`idle_unload` 到期后丢弃模型,下次请求再重新加载。

use std::collections::VecDeque;
use std::marker::PhantomData;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use kb_core::model::EmbedderState;
use kb_core::ports::Embedder;
use kb_core::{KbError, Result};

use crate::models::{FastEmbedBackend, LoadOptions, ModelKind};

/// 空闲检查的轮询间隔(有 `idle_unload` 时才用)。
const IDLE_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// 嵌入任务的用途,决定是否加查询前缀。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EmbedMode {
    /// 查询。
    Query,
    /// 文档(批量)。
    Document,
}

/// 工作线程执行的后端。测试里用慢速假后端验证“查询优先”。
pub trait EmbedBackend: Send + 'static {
    /// 批量嵌入(同步阻塞)。
    fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>>;
    /// 向量维度。
    fn dim(&self) -> usize;
    /// 该用途下的文本前缀(e5 需要,其余为空)。
    fn prefix(&self, mode: EmbedMode) -> &'static str {
        let _ = mode;
        ""
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JobKind {
    Query,
    Batch,
}

struct Job {
    kind: JobKind,
    texts: Vec<String>,
    reply: tokio::sync::oneshot::Sender<Result<Vec<Vec<f32>>>>,
}

/// 持有工作线程的 Embedder 实现。
pub struct EmbedWorker<B: EmbedBackend> {
    id: String,
    dim: usize,
    compat_group: String,
    tx: Mutex<Sender<Job>>,
    state: Arc<Mutex<EmbedderState>>,
    backend: PhantomData<fn() -> B>,
}

impl<B: EmbedBackend> EmbedWorker<B> {
    /// 启动工作线程;模型在第一次请求时才加载(`factory` 可以重复调用)。
    pub fn spawn<F>(
        id: String,
        dim: usize,
        compat_group: String,
        factory: F,
        idle_unload: Option<Duration>,
    ) -> Result<Self>
    where
        F: Fn() -> Result<B> + Send + Sync + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        let state = Arc::new(Mutex::new(EmbedderState::Unloaded));
        let factory: Arc<dyn Fn() -> Result<B> + Send + Sync> = Arc::new(factory);
        let thread_state = Arc::clone(&state);
        std::thread::Builder::new()
            .name("kb-embed".to_owned())
            .spawn(move || worker_loop(rx, factory, thread_state, idle_unload))
            .map_err(|err| KbError::Internal(format!("创建嵌入工作线程失败: {err}")))?;
        Ok(Self {
            id,
            dim,
            compat_group,
            tx: Mutex::new(tx),
            state,
            backend: PhantomData,
        })
    }

    /// 预加载模型(守护进程 `embed.preload = true` 时调用)。
    pub async fn preload(&self) -> Result<()> {
        self.submit(JobKind::Query, vec!["kb warm up".to_owned()])
            .await
            .map(|_| ())
    }

    async fn submit(&self, kind: JobKind, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let (reply, response) = tokio::sync::oneshot::channel();
        {
            let sender = self
                .tx
                .lock()
                .map_err(|_| KbError::Internal("嵌入通道锁已中毒".to_owned()))?;
            sender
                .send(Job { kind, texts, reply })
                .map_err(|_| KbError::Unavailable("嵌入工作线程已退出".to_owned()))?;
        }
        response
            .await
            .map_err(|_| KbError::Unavailable("嵌入工作线程未返回结果".to_owned()))?
    }
}

#[async_trait]
impl<B: EmbedBackend> Embedder for EmbedWorker<B> {
    fn id(&self) -> &str {
        &self.id
    }

    fn dim(&self) -> usize {
        self.dim
    }

    fn compat_group(&self) -> &str {
        &self.compat_group
    }

    async fn embed_documents(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        self.submit(JobKind::Batch, texts).await
    }

    async fn embed_query(&self, text: String) -> Result<Vec<f32>> {
        let mut vectors = self.submit(JobKind::Query, vec![text]).await?;
        vectors
            .pop()
            .ok_or_else(|| KbError::Internal("embed_query 没有返回向量".to_owned()))
    }

    fn state(&self) -> EmbedderState {
        match self.state.lock() {
            Ok(guard) => guard.clone(),
            Err(_) => EmbedderState::Failed("嵌入状态锁已中毒".to_owned()),
        }
    }
}

/// 用 fastembed 后端的便捷构造。
pub fn spawn_fastembedder(
    kind: ModelKind,
    options: LoadOptions,
    idle_unload: Option<Duration>,
) -> Result<EmbedWorker<FastEmbedBackend>> {
    let dim = kind.dim();
    let factory = move || FastEmbedBackend::load(kind, &options);
    EmbedWorker::spawn(
        kind.embedder_id(),
        dim,
        kind.compat_group().to_owned(),
        factory,
        idle_unload,
    )
}

fn worker_loop<B: EmbedBackend>(
    rx: Receiver<Job>,
    factory: Arc<dyn Fn() -> Result<B> + Send + Sync>,
    state: Arc<Mutex<EmbedderState>>,
    idle_unload: Option<Duration>,
) {
    let mut backend: Option<B> = None;
    let mut deferred: VecDeque<Job> = VecDeque::new();
    let mut last_used = Instant::now();

    loop {
        // 1. 查询优先:先把已经排队的查询任务全部处理掉
        loop {
            match rx.try_recv() {
                Ok(job) => match job.kind {
                    JobKind::Query => {
                        handle(&mut backend, &factory, &state, job);
                        last_used = Instant::now();
                    }
                    JobKind::Batch => deferred.push_back(job),
                },
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    for job in deferred.drain(..) {
                        handle(&mut backend, &factory, &state, job);
                    }
                    return;
                }
            }
        }

        // 2. 取一个批量任务(每个批量任务之间都会回到第 1 步检查查询)
        if let Some(job) = deferred.pop_front() {
            handle(&mut backend, &factory, &state, job);
            last_used = Instant::now();
            continue;
        }

        // 3. 空闲等待;有 idle_unload 时用带超时的等待来检查卸载
        let received = match idle_unload {
            Some(idle) => {
                let wait = idle.min(IDLE_POLL_INTERVAL).max(Duration::from_millis(50));
                match rx.recv_timeout(wait) {
                    Ok(job) => Some(job),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            None => match rx.recv() {
                Ok(job) => Some(job),
                Err(_) => return,
            },
        };

        match received {
            Some(job) => match job.kind {
                JobKind::Query => {
                    handle(&mut backend, &factory, &state, job);
                    last_used = Instant::now();
                }
                JobKind::Batch => deferred.push_back(job),
            },
            None => {
                if let Some(idle) = idle_unload
                    && backend.is_some()
                    && last_used.elapsed() >= idle
                {
                    backend = None;
                    set_state(&state, EmbedderState::Unloaded);
                }
            }
        }
    }
}

fn handle<B: EmbedBackend>(
    backend: &mut Option<B>,
    factory: &Arc<dyn Fn() -> Result<B> + Send + Sync>,
    state: &Arc<Mutex<EmbedderState>>,
    job: Job,
) {
    if backend.is_none() {
        set_state(state, EmbedderState::Loading);
        match factory() {
            Ok(loaded) => {
                *backend = Some(loaded);
                set_state(state, EmbedderState::Ready);
            }
            Err(err) => {
                set_state(state, EmbedderState::Failed(err.to_string()));
                // 接收方可能已经放弃等待,这里忽略发送失败
                let _ = job.reply.send(Err(err));
                return;
            }
        }
    }
    let Some(backend) = backend.as_mut() else {
        let _ = job
            .reply
            .send(Err(KbError::Internal("嵌入后端未就绪".to_owned())));
        return;
    };
    let mode = match job.kind {
        JobKind::Query => EmbedMode::Query,
        JobKind::Batch => EmbedMode::Document,
    };
    let prefix = backend.prefix(mode);
    let texts: Vec<String> = if prefix.is_empty() {
        job.texts
    } else {
        job.texts
            .iter()
            .map(|text| format!("{prefix}{text}"))
            .collect()
    };
    let result = embed_sorted(backend, texts);
    // 接收方可能已经放弃等待,这里忽略发送失败
    let _ = job.reply.send(result);
}

/// 按文本长度排序后再分批,减少同一批次里的 padding 浪费（设计规范）。
///
/// 返回的向量顺序与输入一致。
fn embed_sorted<B: EmbedBackend>(backend: &mut B, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    let mut order: Vec<usize> = (0..texts.len()).collect();
    order.sort_by_key(|&index| texts[index].chars().count());
    let sorted: Vec<String> = order.iter().map(|&index| texts[index].clone()).collect();
    let mut vectors = backend.embed(&sorted)?;
    if vectors.len() != texts.len() {
        return Err(KbError::Internal(format!(
            "嵌入后端返回 {} 条向量,期望 {} 条",
            vectors.len(),
            texts.len()
        )));
    }
    let mut out: Vec<Vec<f32>> = vec![Vec::new(); texts.len()];
    for (position, &original) in order.iter().enumerate() {
        out[original] = std::mem::take(&mut vectors[position]);
    }
    Ok(out)
}

fn set_state(state: &Arc<Mutex<EmbedderState>>, value: EmbedderState) {
    if let Ok(mut guard) = state.lock() {
        *guard = value;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// 记录被嵌入文本的慢速后端;返回的向量是文本长度,便于验证顺序还原。
    struct SlowBackend {
        log: Arc<Mutex<Vec<String>>>,
        calls: Arc<AtomicUsize>,
        delay: Duration,
    }

    impl EmbedBackend for SlowBackend {
        fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            self.calls.fetch_add(texts.len(), Ordering::SeqCst);
            {
                let mut log = self.log.lock().expect("日志锁");
                log.extend(texts.iter().cloned());
            }
            std::thread::sleep(self.delay);
            Ok(texts
                .iter()
                .map(|text| vec![text.chars().count() as f32; 4])
                .collect())
        }

        fn dim(&self) -> usize {
            4
        }
    }

    fn slow_worker(
        delay_ms: u64,
        idle_unload: Option<Duration>,
    ) -> (
        EmbedWorker<SlowBackend>,
        Arc<Mutex<Vec<String>>>,
        Arc<AtomicUsize>,
    ) {
        let log = Arc::new(Mutex::new(Vec::new()));
        let calls = Arc::new(AtomicUsize::new(0));
        let factory_log = Arc::clone(&log);
        let factory_calls = Arc::clone(&calls);
        let worker = EmbedWorker::spawn(
            "test:slow".to_owned(),
            4,
            "test".to_owned(),
            move || {
                Ok(SlowBackend {
                    log: Arc::clone(&factory_log),
                    calls: Arc::clone(&factory_calls),
                    delay: Duration::from_millis(delay_ms),
                })
            },
            idle_unload,
        )
        .expect("启动工作线程");
        (worker, log, calls)
    }

    #[tokio::test]
    async fn query_jumps_ahead_of_queued_batches() {
        let (worker, log, _calls) = slow_worker(120, None);
        let worker = Arc::new(worker);

        // 第一个批量任务先占住工作线程
        let first = tokio::spawn({
            let worker = Arc::clone(&worker);
            async move { worker.embed_documents(vec!["batch1".to_owned()]).await }
        });
        tokio::time::sleep(Duration::from_millis(30)).await;

        // 批量 2 先入队,查询后入队
        let second = tokio::spawn({
            let worker = Arc::clone(&worker);
            async move { worker.embed_documents(vec!["batch2".to_owned()]).await }
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        let query = tokio::spawn({
            let worker = Arc::clone(&worker);
            async move { worker.embed_query("query1".to_owned()).await }
        });

        first.await.expect("批量 1 任务").expect("批量 1 结果");
        second.await.expect("批量 2 任务").expect("批量 2 结果");
        query.await.expect("查询任务").expect("查询结果");

        let seen = log.lock().expect("日志锁").clone();
        assert_eq!(
            seen,
            vec!["batch1", "query1", "batch2"],
            "查询应插到已排队的批量任务之前"
        );
    }

    #[tokio::test]
    async fn concurrent_requests_all_succeed() {
        let (worker, _log, calls) = slow_worker(5, None);
        let worker = Arc::new(worker);
        let mut handles = Vec::new();
        for index in 0..20 {
            let worker = Arc::clone(&worker);
            handles.push(tokio::spawn(async move {
                let vector = worker
                    .embed_query(format!("查询 {index}"))
                    .await
                    .expect("查询");
                assert_eq!(vector.len(), 4);
                let vectors = worker
                    .embed_documents(vec![format!("文档 {index} a"), format!("文档 {index} b")])
                    .await
                    .expect("批量");
                assert_eq!(vectors.len(), 2);
            }));
        }
        for handle in handles {
            handle.await.expect("任务未 panic");
        }
        assert_eq!(calls.load(Ordering::SeqCst), 20 * 3);
    }

    #[tokio::test]
    async fn idle_unload_releases_the_model() {
        let (worker, _log, _calls) = slow_worker(1, Some(Duration::from_millis(100)));
        worker.embed_query("第一次".to_owned()).await.expect("查询");
        assert_eq!(worker.state(), EmbedderState::Ready);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(worker.state(), EmbedderState::Unloaded);
        worker.embed_query("第二次".to_owned()).await.expect("查询");
        assert_eq!(worker.state(), EmbedderState::Ready);
    }

    #[tokio::test]
    async fn empty_input_short_circuits() {
        let (worker, _log, calls) = slow_worker(1, None);
        assert!(
            worker
                .embed_documents(Vec::new())
                .await
                .expect("空输入")
                .is_empty()
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn texts_are_sorted_by_length_but_results_keep_input_order() {
        let (worker, log, _calls) = slow_worker(1, None);
        let vectors = worker
            .embed_documents(vec![
                "很长很长很长的一段文本".to_owned(), // 11 字
                "短".to_owned(),                     // 1 字
                "中等长度".to_owned(),               // 4 字
            ])
            .await
            .expect("批量");

        // 后端看到的顺序按长度升序
        let seen = log.lock().expect("日志锁").clone();
        assert_eq!(seen, vec!["短", "中等长度", "很长很长很长的一段文本"]);
        // 返回给调用方的顺序与输入一致
        assert_eq!(vectors[0][0], 11.0);
        assert_eq!(vectors[1][0], 1.0);
        assert_eq!(vectors[2][0], 4.0);
    }

    /// 只记录收到的文本,并声明 e5 风格的前缀。
    struct PrefixedBackend {
        log: Arc<Mutex<Vec<String>>>,
    }

    impl EmbedBackend for PrefixedBackend {
        fn embed(&mut self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
            let mut log = self.log.lock().expect("日志锁");
            log.extend(texts.iter().cloned());
            Ok(texts.iter().map(|_| vec![1.0; 4]).collect())
        }

        fn dim(&self) -> usize {
            4
        }

        fn prefix(&self, mode: EmbedMode) -> &'static str {
            match mode {
                EmbedMode::Query => "query: ",
                EmbedMode::Document => "passage: ",
            }
        }
    }

    #[tokio::test]
    async fn backend_prefixes_are_applied_per_mode() {
        let log = Arc::new(Mutex::new(Vec::new()));
        let factory_log = Arc::clone(&log);
        let worker = EmbedWorker::spawn(
            "test:prefixed".to_owned(),
            4,
            "test".to_owned(),
            move || {
                Ok(PrefixedBackend {
                    log: Arc::clone(&factory_log),
                })
            },
            None,
        )
        .expect("启动工作线程");

        worker.embed_query("问题".to_owned()).await.expect("查询");
        worker
            .embed_documents(vec!["文档".to_owned()])
            .await
            .expect("文档");

        let seen = log.lock().expect("日志锁").clone();
        assert_eq!(seen, vec!["query: 问题", "passage: 文档"]);
    }

    #[tokio::test]
    async fn load_failure_is_reported_and_state_marks_failed() {
        let worker: EmbedWorker<SlowBackend> = EmbedWorker::spawn(
            "test:broken".to_owned(),
            4,
            "test".to_owned(),
            || Err(KbError::Unavailable("模型加载失败".to_owned())),
            None,
        )
        .expect("启动工作线程");
        let err = worker
            .embed_query("查询".to_owned())
            .await
            .expect_err("应失败");
        assert!(matches!(err, KbError::Unavailable(_)));
        assert!(matches!(worker.state(), EmbedderState::Failed(_)));
    }
}
