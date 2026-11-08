//! 检索并发闸门。
//!
//! 16 核实测:8 个并发检索把单请求从 ≈220 ms 拉到 ≈1.1 s——查询嵌入(CPU 推理)与向量检索
//! 抢同一批核,一起变慢之后谁都跑不快,尾部请求还叠加排队时间。闸门把并发放到上限,
//! 超出的请求排队(排队的这段时间记为 `queue_ms`,看得见)。
//!
//! 上限来自 `search.max_concurrency`:不写 = 按核数自动(核数 / 2,上限 8,至少 1),
//! `0` = 不限。配置改了下一拍就生效([`SearchGate::following`] 盯配置存储的更新代次),
//! 已经在跑的请求继续持有旧许可,不会被中途收走。
//!
//! 等待位由 `search.max_queue` 限制(`0` = 不排队):队列满或等超过 15 秒时返回
//! `KbError::Unavailable`(code = `unavailable`),调用方(MCP / Web / CLI)可以据此降级,
//! 而不是把请求无限期堆在进程里。

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use kb_core::config::ConfigStore;
use kb_core::{KbError, Result};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, TryAcquireError};

/// 排队等待的硬上限:超过这个时间还没轮到就不再等,按忙返回。
///
/// 100 并发档的验收上限是 15 秒;再久调用方早就超时了,继续挂着只会占内存。
const QUEUE_WAIT_LIMIT: Duration = Duration::from_secs(15);

/// 检索闸门:拿不到许可就排队,队列有界。
pub struct SearchGate {
    /// 上限来源(固定值 / 跟着配置存储走)。
    limits: Limits,
    /// 当前这一轮的许可。
    current: Mutex<Current>,
    /// 正在等待许可的请求数(不含已经拿到许可的)。
    ///
    /// 放在 `Current` 外面:配置热更新会重建信号量,正在等的请求仍属于同一份队列,
    /// 不能被新配置「清零」计数。
    queued: AtomicUsize,
}

/// 上限从哪来。
enum Limits {
    /// 固定值(测试与非守护进程场景),`None` = 不限。
    Fixed(Option<usize>),
    /// 跟着配置存储走:每次取许可现读。
    Config(Arc<ConfigStore>),
}

/// 当前这一轮许可。
struct Current {
    /// 建这一轮许可时配置的更新代次;固定值恒为 0。
    generation: u64,
    /// 这一轮的上限,`None` = 不限。
    limit: Option<usize>,
    /// 这一轮最多允许多少个请求排队,`0` = 不排队。
    max_queue: usize,
    /// 这一轮等许可的最长时间。
    wait: Duration,
    /// 这一轮的信号量,与 `limit` 同时为 `None`。
    semaphore: Option<Arc<Semaphore>>,
}

impl Current {
    fn new(generation: u64, limit: Option<usize>, max_queue: usize, wait: Duration) -> Self {
        // `0` 一律当"不限":`Semaphore::new(0)` 会一个许可都不放,把检索永久卡死,
        // 而配置里 `0` 的语义本来就是不限(`SearchConfig::search_concurrency`)
        let limit = limit.filter(|limit| *limit > 0);
        Self {
            generation,
            limit,
            max_queue,
            wait,
            semaphore: limit.map(|limit| Arc::new(Semaphore::new(limit))),
        }
    }
}

impl SearchGate {
    /// 固定上限(测试用):`None` 与 `Some(0)` 都是不限,不设排队上限。
    pub fn fixed(limit: Option<usize>) -> Self {
        Self::fixed_bounded(limit, None, QUEUE_WAIT_LIMIT)
    }

    /// 固定上限 + 有界队列 + 等待超时(测试用)。
    ///
    /// `max_queue = None` 表示队列不限;`Some(0)` 表示不排队,拿不到许可立即返回 busy。
    pub fn fixed_bounded(limit: Option<usize>, max_queue: Option<usize>, wait: Duration) -> Self {
        let max_queue = max_queue.unwrap_or(usize::MAX);
        Self {
            limits: Limits::Fixed(limit),
            current: Mutex::new(Current::new(0, limit, max_queue, wait)),
            queued: AtomicUsize::new(0),
        }
    }

    /// 跟着配置存储走:`search.max_concurrency` / `search.max_queue` 改了,下一次取许可就用新值。
    pub fn following(store: Arc<ConfigStore>) -> Self {
        let search = &store.get().search;
        let limit = search.search_concurrency();
        Self {
            // 代次先记 `u64::MAX`:第一次取许可时按当时的配置重算一次,免得构造与使用之间隔着一次重载
            limits: Limits::Config(store),
            current: Mutex::new(Current::new(
                u64::MAX,
                limit,
                search.search_queue_limit(),
                QUEUE_WAIT_LIMIT,
            )),
            queued: AtomicUsize::new(0),
        }
    }

    /// 现在的上限;`None` = 不限。
    pub fn limit(&self) -> Option<usize> {
        self.current_now().0
    }

    /// 当前排队上限(`usize::MAX` = 不限)。
    pub fn queue_limit(&self) -> usize {
        self.current_now().1
    }

    /// 取一个许可;不限并发时直接返回 `None`。
    ///
    /// 返回的许可跟着调用方走:算完这一次检索就还回去(丢进 `_permit` 即可)。
    /// 队列已满或等太久时返回 [`KbError::Unavailable`],不是内部错误:
    /// 调用方应当降级(例如只做全文检索)或稍后重试。
    pub async fn acquire(&self) -> Result<Option<OwnedSemaphorePermit>> {
        let (_, max_queue, wait, semaphore) = self.current_now();
        let Some(semaphore) = semaphore else {
            return Ok(None);
        };
        // 先做一次不排队的尝试:有空位就立刻拿到,不占排队计数,也不受队列上限影响。
        // `try_acquire_owned` 只在信号量关闭时报错;这里的信号量由 `Arc` 持有,不会关闭。
        match semaphore.clone().try_acquire_owned() {
            Ok(permit) => return Ok(Some(permit)),
            Err(TryAcquireError::NoPermits) => {}
            Err(TryAcquireError::Closed) => {
                return Err(KbError::Internal("检索并发闸门已关闭(不应发生)".to_owned()));
            }
        }
        if max_queue == 0 {
            return Err(busy("队列已满(上限 0,不排队)"));
        }
        // 没有空位,才进入等待队列;计数含所有还没拿到许可的请求。
        let waiting = self.queued.fetch_add(1, Ordering::SeqCst) + 1;
        if waiting > max_queue {
            self.queued.fetch_sub(1, Ordering::SeqCst);
            return Err(busy(&format!("排队已满(上限 {max_queue})")));
        }
        let outcome = tokio::time::timeout(wait, semaphore.acquire_owned()).await;
        // 无论拿到、超时还是信号量关闭,都要先退还排队计数,否则后续流量会被永久挡住。
        self.queued.fetch_sub(1, Ordering::SeqCst);
        match outcome {
            Ok(Ok(permit)) => Ok(Some(permit)),
            Ok(Err(_)) => Err(KbError::Internal("检索并发闸门已关闭(不应发生)".to_owned())),
            Err(_) => Err(busy(&format!(
                "等待超过 {} 秒",
                wait.as_secs_f32().round() as u64
            ))),
        }
    }

    /// 当前这一轮(配置更新过就按新值重建),返回 (上限, 队列上限, 等待超时, 信号量)。
    fn current_now(&self) -> (Option<usize>, usize, Duration, Option<Arc<Semaphore>>) {
        let generation = match &self.limits {
            Limits::Fixed(_) => 0,
            Limits::Config(store) => store.generation(),
        };
        let mut current = self
            .current
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if current.generation != generation {
            let (limit, max_queue) = match &self.limits {
                Limits::Fixed(limit) => (*limit, current.max_queue),
                Limits::Config(store) => {
                    let search = &store.get().search;
                    (search.search_concurrency(), search.search_queue_limit())
                }
            };
            *current = Current::new(generation, limit, max_queue, QUEUE_WAIT_LIMIT);
        }
        (
            current.limit,
            current.max_queue,
            current.wait,
            current.semaphore.clone(),
        )
    }
}

/// 忙的提示统一带「稍后重试」,日志里能一眼看出是流量问题而不是数据问题。
fn busy(reason: &str) -> KbError {
    KbError::Unavailable(format!("检索{};请稍后重试", reason))
}

impl Default for SearchGate {
    /// 默认不限:`SearchService` 没接闸门时的行为与以前完全一样。
    fn default() -> Self {
        Self::fixed(None)
    }
}

impl std::fmt::Debug for SearchGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SearchGate")
            .field("limit", &self.limit())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::config::Config;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn an_unlimited_gate_hands_out_nothing_and_blocks_nobody() {
        for unlimited in [SearchGate::fixed(None), SearchGate::fixed(Some(0))] {
            assert_eq!(unlimited.limit(), None);
            // 不限并发:拿不到许可也立刻返回,不会卡住
            assert!(
                unlimited
                    .acquire()
                    .await
                    .expect("不限并发不会失败")
                    .is_none()
            );
        }
    }

    #[tokio::test]
    async fn queued_callers_wait_for_a_permit() {
        let gate = Arc::new(SearchGate::fixed(Some(1)));
        let inflight = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut tasks = Vec::new();
        for _ in 0..3 {
            let gate = gate.clone();
            let inflight = inflight.clone();
            let peak = peak.clone();
            tasks.push(tokio::spawn(async move {
                let _permit = gate.acquire().await.expect("应拿到许可");
                let now = inflight.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(30)).await;
                inflight.fetch_sub(1, Ordering::SeqCst);
            }));
        }
        for task in tasks {
            task.await.expect("任务");
        }
        assert_eq!(peak.load(Ordering::SeqCst), 1, "上限 1 时只能有一个在跑");
    }

    #[tokio::test]
    async fn a_configured_gate_switches_limit_without_a_restart() {
        let config = Config::default();
        let store = Arc::new(ConfigStore::new(config.clone()));
        let gate = SearchGate::following(store.clone());
        assert_eq!(gate.limit(), config.search.search_concurrency());

        // 改成 2:下一次取许可就是 2
        let mut next = config.clone();
        next.search.max_concurrency = Some(2);
        store.replace(next);
        assert_eq!(gate.limit(), Some(2));

        // 0 = 不限
        let mut next = config;
        next.search.max_concurrency = Some(0);
        store.replace(next);
        assert_eq!(gate.limit(), None);
        assert!(gate.acquire().await.expect("不限并发不会失败").is_none());
    }

    #[tokio::test]
    async fn the_configured_value_is_used_and_zero_means_unlimited() {
        let mut search = kb_core::config::SearchConfig::default();
        // 不写 = 按核数自动(核数 / 2,上限 8,至少 1)
        let auto = search.search_concurrency().expect("自动上限");
        assert!((1..=8).contains(&auto), "{auto}");
        search.max_concurrency = Some(0);
        assert_eq!(search.search_concurrency(), None, "0 = 不限");
        search.max_concurrency = Some(3);
        assert_eq!(search.search_concurrency(), Some(3));
    }

    #[tokio::test]
    async fn a_full_queue_returns_busy_instead_of_waiting_forever() {
        let gate = Arc::new(SearchGate::fixed_bounded(
            Some(1),
            Some(1),
            Duration::from_secs(5),
        ));
        let held = gate.acquire().await.expect("第一个许可").expect("有信号量");
        // 第二个请求占住唯一的等待位
        let waiting = {
            let gate = gate.clone();
            tokio::spawn(async move { gate.acquire().await })
        };
        tokio::time::sleep(Duration::from_millis(20)).await;
        let error = gate.acquire().await.expect_err("队列已满应返回 busy");
        assert_eq!(error.code(), "unavailable", "{error}");
        drop(held);
        assert!(waiting.await.expect("等待任务").is_ok());
    }

    #[tokio::test]
    async fn a_zero_length_queue_rejects_immediately_when_busy() {
        let gate = Arc::new(SearchGate::fixed_bounded(
            Some(1),
            Some(0),
            Duration::from_secs(5),
        ));
        let _held = gate.acquire().await.expect("第一个许可").expect("有信号量");
        let started = std::time::Instant::now();
        let error = gate.acquire().await.expect_err("不排队应直接 busy");
        assert_eq!(error.code(), "unavailable");
        assert!(started.elapsed() < Duration::from_secs(1), "不应等待");
    }

    #[tokio::test]
    async fn a_waiter_gives_up_after_the_timeout() {
        let gate = Arc::new(SearchGate::fixed_bounded(
            Some(1),
            Some(4),
            Duration::from_millis(30),
        ));
        let held = gate.acquire().await.expect("第一个许可").expect("有信号量");
        let started = std::time::Instant::now();
        let error = gate.acquire().await.expect_err("等不到许可应返回 busy");
        assert_eq!(error.code(), "unavailable");
        assert!(started.elapsed() >= Duration::from_millis(25), "应等满超时");
        drop(held);
        // 超时后排队计数必须还回去,否则后续请求会被永久挡住
        assert!(gate.acquire().await.expect("超时后应能重新排队").is_some());
    }

    #[tokio::test]
    async fn the_queue_limit_follows_the_config() {
        let config = Config::default();
        let store = Arc::new(ConfigStore::new(config));
        let gate = SearchGate::following(store.clone());
        assert_eq!(gate.queue_limit(), 256);
        let mut next = store.get().as_ref().clone();
        next.search.max_queue = 3;
        store.replace(next);
        assert_eq!(gate.queue_limit(), 3, "热更新后下一次取许可就用新排队上限");
    }
}
