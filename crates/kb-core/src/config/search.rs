//! 检索类配置。
//!
//! 由 `config.rs` 拆出:路径不变,入口仍是 `kb_core::config`。
use serde::{Deserialize, Serialize};

/// `[search]`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SearchConfig {
    /// 返回条数。
    pub k: usize,
    /// 跨 collection RRF 时 `_global` 的权重。
    pub global_weight: f64,
    /// RRF 常数。
    pub rrf_k: usize,
    /// sentence-window 补充的前后行数。
    pub window_context_lines: usize,
    /// MCP 输出长度上限(字符)。
    pub mcp_max_output_chars: usize,
    /// 各 collection 的 RRF 权重(反馈调权写入;没写的按 1.0)。
    ///
    /// `_global` 仍用 [`Self::global_weight`],这里只放项目 collection。
    pub collection_weights: std::collections::BTreeMap<String, f64>,
    /// 每个知识库的查询向量缓存条数(0 = 关)。
    ///
    /// 重复问句直接复用向量,省掉一次嵌入;热更新即生效。
    pub query_cache_entries: usize,
    /// 查询向量缓存的存活秒数(0 = 不过期)。
    ///
    /// 保守兜底:换模型或重调索引参数后,旧向量只会在候选集里制造噪音。
    pub query_cache_ttl_secs: u64,
    /// 同时进行的检索上限(`None` = 按核数自动:核数 / 2,上限 8,至少 1;`0` = 不限)。
    ///
    /// 16 核实测 8 个并发把单请求从 ≈220 ms 拉到 ≈1.1 s:嵌入与向量检索抢同一批核,
    /// 一起变慢之后谁都跑不快。超出的请求排队,排队时间记在 `queue_ms` 里。热更新即生效。
    pub max_concurrency: Option<usize>,
    /// 排队等待的检索请求上限(`0` = 不排队,拿不到许可直接返回 busy)。
    ///
    /// 只靠信号量排队时,极端流量(例如 1000 个客户端同时打)会把请求全部堆在内存里:
    /// 每个请求都要等前面的跑完,最后不但延迟不可控,调用方也拿不到「忙」的明确信号。
    /// 队列满了返回 `unavailable`,由 MCP / Web / CLI 调用方自行降级或重试。
    /// 热更新即生效;排队超过 15 秒也会按 busy 返回,避免请求无限期挂着。
    pub max_queue: usize,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            k: 8,
            global_weight: 0.8,
            rrf_k: 60,
            window_context_lines: 8,
            mcp_max_output_chars: 24_000,
            collection_weights: std::collections::BTreeMap::new(),
            query_cache_entries: 512,
            query_cache_ttl_secs: 900,
            max_concurrency: None,
            // 8 个许可 + 256 个等待位:100 并发全部能排进来,1000 并发在入口就被挡住,
            // 不会把 tokio 任务和 Lance 查询堆到不可控
            max_queue: 256,
        }
    }
}

impl SearchConfig {
    /// 实际同时进行的检索上限;`None` = 不限。
    ///
    /// 不写配置时按核数自动(核数 / 2,上限 8,至少 1):单核机器上并发检索只会互相拖慢,
    /// 16 核以上再多也没意义——嵌入是 CPU 推理,核数再多也是排队。
    pub fn search_concurrency(&self) -> Option<usize> {
        match self.max_concurrency {
            Some(0) => None,
            Some(limit) => Some(limit),
            None => {
                let cores = std::thread::available_parallelism()
                    .map(std::num::NonZeroUsize::get)
                    .unwrap_or(4);
                Some((cores / 2).clamp(1, 8))
            }
        }
    }

    /// 队列里最多能等多少个检索请求;`0` = 不排队(拿不到许可立即返回 busy)。
    ///
    /// 与 `max_concurrency` 的 `0 = 不限` 不同:队列长度 0 有明确含义——只做「立即尝试」,
    /// 不把请求挂在这里。这样极端流量下调用方能马上拿到 `unavailable` 并降级。
    pub fn search_queue_limit(&self) -> usize {
        self.max_queue
    }
}
