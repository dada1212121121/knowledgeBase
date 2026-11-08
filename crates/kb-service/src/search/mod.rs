//! SearchService:解析 → 作用域 → 混合检索 → 跨 collection 融合 → 去重 → 重排 → 窗口扩展
//! → 关系一跳 → explain（设计规范）。

pub mod explain;
pub mod fuse;
pub mod gate;
mod pending_cache;
mod query_cache;
pub mod window;

pub use gate::SearchGate;
pub use pending_cache::{PENDING_CACHE_TTL, PendingExistsCache};
pub use query_cache::{DEFAULT_CAPACITY as QUERY_CACHE_CAPACITY, QueryVectorCache};

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;

use kb_core::filter::Filter;
use kb_core::model::EmbedderState;
use kb_core::model::{
    Collection, ItemStatus, Millis, RecordKind, SearchHit, SearchMode, StoreQuery,
};
use kb_core::ports::repo::{ChunkRepo, CollectionRepo, MetaStore, ProjectRepo};
use kb_core::ports::{Embedder, Reranker, VectorStore};
use kb_core::query::ParsedQuery;
use kb_core::{KbError, Result};

use crate::search::fuse::{CollectionHits, FusedHit, dedupe_overlaps, fuse};
use crate::search::window::expand_async;

/// pending 补充列表在融合时的权重(保守起点,避免少量 pending 结果把稳定结果挤下去)。
const PENDING_WEIGHT: f64 = 0.8;

/// 检索参数。
#[derive(Clone, Debug)]
pub struct SearchOptions {
    /// 默认返回条数。
    pub k: usize,
    /// RRF 常数。
    pub rrf_k: usize,
    /// `_global` 的融合权重。
    pub global_weight: f64,
    /// 窗口扩展的行数。
    pub window_lines: usize,
    /// 重排取前多少条。
    pub rerank_top_n: usize,
    /// 重排时每条截断到多少字符。
    pub rerank_truncate_chars: usize,
    /// 重排的时间预算(毫秒)。
    pub budget_ms: u64,
    /// 嵌入模型没加载(空闲卸载后的第一次搜索)时,最多等它加载多久(毫秒)。等到了就照常做混合检索,
    /// 超时才退回只做全文检索;模型加载本身不会被打断,下一次搜索就是现成的。
    pub load_wait_ms: u64,
    /// 重排开关:`auto` / `off` / `on`(来自 `[rerank].mode`)。
    pub rerank_mode: String,
    /// 各 collection 的 RRF 权重。
    pub collection_weights: std::collections::BTreeMap<String, f64>,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            k: 8,
            rrf_k: 60,
            global_weight: 0.8,
            window_lines: 20,
            rerank_top_n: 20,
            rerank_truncate_chars: 1200,
            budget_ms: 3000,
            load_wait_ms: 10_000,
            rerank_mode: "auto".to_owned(),
            collection_weights: std::collections::BTreeMap::new(),
        }
    }
}

impl SearchOptions {
    /// 从全局配置构造。
    pub fn from_config(config: &kb_core::config::Config) -> Self {
        Self {
            k: config.search.k,
            rrf_k: config.search.rrf_k,
            global_weight: config.search.global_weight,
            window_lines: config.search.window_context_lines,
            rerank_top_n: config.rerank.top_n,
            rerank_truncate_chars: config.rerank.truncate_chars,
            budget_ms: config.rerank.budget_ms,
            load_wait_ms: 10_000,
            rerank_mode: config.rerank.mode.clone(),
            collection_weights: config.search.collection_weights.clone(),
        }
    }
}

/// 一次检索请求。
#[derive(Clone, Debug)]
pub struct SearchRequest {
    /// 原始查询串(含 `kind:` 之类的前缀)。
    pub query: String,
    /// 已解析好的 collection 名(项目 + `_global`)。
    pub collections: Vec<String>,
    /// 返回条数,`None` 用默认值。
    pub k: Option<usize>,
    /// 是否返回 explain。
    pub explain: bool,
    /// 是否重排,`None` 表示按配置。
    pub rerank: Option<bool>,
}

/// 一次检索的结果。
#[derive(Clone, Debug)]
pub struct SearchResponse {
    /// 命中列表。
    pub hits: Vec<SearchHit>,
    /// 实际检索的 collection。
    pub scope: Vec<String>,
    /// 解析后的查询。
    pub query_parsed: ParsedQuery,
    /// 降级原因:`embedder_loading` / `rerank_timeout` / `rerank_unavailable` /
    /// `embedder_unavailable` / `vector_pending`(命中了还没补向量的块,只按全文相关性排序)。
    pub degraded: Option<String>,
    /// 各阶段耗时(毫秒;只有 `explain = true` 时才采集)。
    pub timings: Option<SearchTimings>,
    /// 这次检索**确实应用了**重排(`false` = 没配重排器 / 模式为 off / 重排失败)。
    pub reranked: bool,
}

/// 一次检索里各阶段的耗时(毫秒)。
///
/// 只有 `explain = true` 才采集:关掉时多测几个 `Instant` 没意义,还会让返回体变大。
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
pub struct SearchTimings {
    /// 查询解析(前缀 / 过滤条件)。
    pub parse_ms: f64,
    /// 查询嵌入。
    pub embed_ms: f64,
    /// 存储层检索(混合那一次)。
    pub store_ms: f64,
    /// explain 额外跑的纯全文检索。
    pub fts_ms: f64,
    /// explain 额外跑的纯向量检索。
    pub vector_ms: f64,
    /// 在并发闸门前排队的时长(没有闸门或没排队时是 0)。
    pub queue_ms: f64,
    /// 融合 + 去重。
    pub fuse_ms: f64,
    /// 重排。
    pub rerank_ms: f64,
    /// 汇总。
    pub total_ms: f64,
}

/// 检索服务。
pub struct SearchService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    reranker: Arc<dyn Reranker>,
    options: SearchOptions,
    /// 这个知识库的查询向量缓存(L3 后半);没接就每次都嵌入。
    query_cache: Option<Arc<QueryVectorCache>>,
    /// 并发闸门;没接就不限并发(嵌入式 CLI 与非守护进程场景)。
    gate: Option<Arc<SearchGate>>,
    /// 待补向量队列的 2 秒缓存;没接就每次检索都查一次 SQLite。
    pending_cache: Option<Arc<PendingExistsCache>>,
}

/// 一个检索目标。
struct Target {
    collection: Collection,
    weight: f64,
    root: Option<PathBuf>,
}

impl SearchService {
    /// 用注入的端口构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
        reranker: Arc<dyn Reranker>,
        options: SearchOptions,
    ) -> Self {
        Self {
            meta,
            store,
            embedder,
            reranker,
            options,
            query_cache: None,
            gate: None,
            pending_cache: None,
        }
    }

    /// 接上这个知识库的查询向量缓存:重复的查询不再嵌入(命中时也不用等模型加载)。
    /// 每个知识库一份,不要跨用户共享(见 [`QueryVectorCache`])。
    pub fn with_query_cache(mut self, cache: Arc<QueryVectorCache>) -> Self {
        self.query_cache = Some(cache);
        self
    }

    /// 接上并发闸门:超过上限的检索排队,排队时间进 `queue_ms`。
    ///
    /// 闸门放在运行时里、多个请求共用一份;这里只是借用。
    pub fn with_gate(mut self, gate: Arc<SearchGate>) -> Self {
        self.gate = Some(gate);
        self
    }

    /// 接上待补向量队列的短缓存:每个知识库一份,key 含知识库 id。
    ///
    /// 缓存命中时不查 SQLite,也不额外查 Lance / FTS;队列 2 秒内发生变化最多晚一拍看到。
    pub fn with_pending_cache(mut self, cache: Arc<PendingExistsCache>) -> Self {
        self.pending_cache = Some(cache);
        self
    }

    /// 这个 collection 是否还有待补向量的块。
    ///
    /// 评测需要它来判断「这一批数字是不是在队列没清空时产生的」:待补块可能没进
    /// top-k,结果里看不到 `vector_pending`,但召回分母已经变了,不能当基线。
    pub async fn has_pending(&self, collection: &str) -> Result<bool> {
        ChunkRepo::has_pending(self.meta.as_ref(), collection).await
    }

    /// 执行一次检索。
    pub async fn search(&self, request: SearchRequest) -> Result<SearchResponse> {
        // 并发闸门放在最前面:排队时间单独记(`queue_ms`),不要算进各阶段耗时里
        let queue_started = std::time::Instant::now();
        // 队列满 / 等太久时闸门返回 `Unavailable`:直接抛给调用方降级,不能当成“没接闸门”
        let _permit = match &self.gate {
            Some(gate) => gate.acquire().await?,
            None => None,
        };
        let queue_ms = queue_started.elapsed().as_secs_f64() * 1000.0;
        let parse_started = std::time::Instant::now();
        let parsed = ParsedQuery::parse(&request.query);
        let parse_ms = parse_started.elapsed().as_secs_f64() * 1000.0;
        if parsed.text.trim().is_empty() {
            return Err(KbError::InvalidInput(
                "查询词不能为空(只写过滤前缀时也要带上关键词)".to_owned(),
            ));
        }
        let k = request.k.unwrap_or(self.options.k).clamp(1, 100);
        let filter = self.build_filter(&parsed)?;

        let targets = self.resolve(&request.collections).await?;
        if targets.is_empty() {
            return Ok(SearchResponse {
                hits: Vec::new(),
                scope: Vec::new(),
                query_parsed: parsed,
                degraded: None,
                timings: None,
                reranked: false,
            });
        }

        // 嵌入器未就绪时只做全文检索,并标记降级(设计规范第 3 步)
        let mut degraded = None;
        let embed_started = std::time::Instant::now();
        let cached = self
            .query_cache
            .as_ref()
            .and_then(|cache| cache.get(self.embedder.id(), &parsed.text));
        let from_cache = cached.is_some();
        let vector = match cached {
            // 同一个查询刚嵌入过:直接用,不跑模型,也不用管模型这会儿是不是在加载
            Some(vector) => Some(vector),
            None => match self.embedder.state() {
                // Ready 也可能失败(HTTP sidecar 刚被杀、请求超时):降级成全文检索,
                // 不要把错误抛给调用方
                EmbedderState::Ready => {
                    match self.embedder.embed_query(parsed.text.clone()).await {
                        Ok(vector) => Some(vector),
                        Err(err) => {
                            tracing::warn!(error = %err, "查询嵌入失败,本次只做全文检索");
                            degraded = Some("embedder_unavailable".to_owned());
                            None
                        }
                    }
                }
                EmbedderState::Unloaded => {
                    // 从未加载(或空闲卸载后第一次搜索):这次请求自己去触发加载,并等它加载完再查。
                    // 加载一般几秒;空闲卸载打开后几乎每个人隔一阵第一次搜都会碰上,直接降级成纯关键词
                    // 等于每次都给一份更差的结果。等不到就退回全文检索——加载仍在后台继续(丢掉这个等待
                    // 不会打断它),下一次搜索就是现成的
                    let wait = std::time::Duration::from_millis(self.options.load_wait_ms);
                    match tokio::time::timeout(wait, self.embedder.embed_query(parsed.text.clone()))
                        .await
                    {
                        Ok(Ok(vector)) => Some(vector),
                        Ok(Err(err)) => {
                            tracing::warn!(error = %err, "嵌入模型加载失败,本次只做全文检索");
                            degraded = Some("embedder_unavailable".to_owned());
                            None
                        }
                        Err(_) => {
                            degraded = Some("embedder_loading".to_owned());
                            None
                        }
                    }
                }
                EmbedderState::Loading => {
                    degraded = Some("embedder_loading".to_owned());
                    None
                }
                EmbedderState::Failed(reason) => {
                    tracing::warn!(reason = %reason, "嵌入器不可用,本次只做全文检索");
                    degraded = Some("embedder_unavailable".to_owned());
                    None
                }
            },
        };
        if !from_cache && let (Some(cache), Some(vector)) = (&self.query_cache, &vector) {
            cache.put(self.embedder.id(), &parsed.text, vector);
        }
        let embed_ms = embed_started.elapsed().as_secs_f64() * 1000.0;
        let mode = if vector.is_some() {
            SearchMode::Hybrid
        } else {
            SearchMode::Fts
        };

        let mut timings = request.explain.then(|| SearchTimings {
            embed_ms,
            queue_ms,
            ..SearchTimings::default()
        });
        let mut lists: Vec<CollectionHits> = Vec::with_capacity(targets.len());
        let mut fts_stats: HashMap<String, explain::StageStats> = HashMap::new();
        let mut vector_stats: HashMap<String, explain::StageStats> = HashMap::new();
        // 各集合的主检索并发执行:项目和 `_global` 原来是一个等一个,
        // 总耗时是几个集合之和,现在是最慢的那一个。
        // 留在请求自己的任务里并发(不 spawn):知识库路由是任务局部变量,派生出去的任务不会带上它;
        // 返回顺序与 `targets` 一致,融合结果不变。`store_ms` 记这一整段的墙钟时间,
        // 不是各集合耗时之和,这样「各段之和不超过合计」的自洽关系仍然成立。
        let store_started = std::time::Instant::now();
        let searches = targets.iter().map(|target| {
            let table = &target.collection.active_table;
            let query = StoreQuery {
                mode,
                text: Some(parsed.text.clone()),
                vector: vector.clone(),
                filter: filter.clone(),
                limit: k * 3,
                offset: 0,
                with_vector: false,
            };
            let meta = self.meta.clone();
            let pending_cache = self.pending_cache.clone();
            async move {
                // 先看队列里有没有待补向量的块:没有就完全走旧路径,
                // 不增加任何 Lance / FTS 查询。纯全文检索本身就能搜到 pending 行,
                // 不需要补充列表,也不必查队列。
                //
                // `pending_exists` 走 2 秒缓存:缓存命中时不碰 SQLite,更不会额外查 Lance / FTS。
                // key 含知识库 id 与 collection,不同用户/同名 collection 不会串。
                let has_pending = if mode == SearchMode::Fts {
                    false
                } else {
                    let collection = target.collection.name.clone();
                    match &pending_cache {
                        Some(cache) => {
                            let meta = meta.clone();
                            let key = collection.clone();
                            cache
                                .exists(&collection, || async move {
                                    ChunkRepo::has_pending(meta.as_ref(), &key).await
                                })
                                .await?
                        }
                        None => {
                            ChunkRepo::has_pending(meta.as_ref(), &target.collection.name).await?
                        }
                    }
                };
                let main = self.store.search(table, &query).await?;
                // 纯全文检索已经能搜到 pending 行;再来一份补充列表会把同一 id 的 RRF
                // 分数加两遍,把待补向量的结果抬到不该有的位置。
                let pending = if has_pending && mode != SearchMode::Fts {
                    self.store
                        .search_pending(
                            table,
                            &StoreQuery {
                                limit: k * 2,
                                ..query.clone()
                            },
                        )
                        .await?
                } else {
                    Vec::new()
                };
                Ok::<_, KbError>((main, pending))
            }
        });
        let mut results = futures::future::try_join_all(searches).await?.into_iter();
        if let Some(timings) = timings.as_mut() {
            timings.store_ms += store_started.elapsed().as_secs_f64() * 1000.0;
        }
        // pending 命中的 id:融合后只用于标记 explain / degraded,不参与排序之外的任何事。
        let mut pending_ids: HashSet<String> = HashSet::new();
        for target in &targets {
            let (hits, pending_hits) = results.next().unwrap_or_default();
            pending_ids.extend(pending_hits.iter().map(|hit| hit.row.id.clone()));
            if request.explain {
                // 额外跑一次纯全文检索,只为 explain 提供“全文阶段名次与分数”
                let fts_started = std::time::Instant::now();
                let fts = self
                    .store
                    .search(
                        &target.collection.active_table,
                        &StoreQuery {
                            mode: SearchMode::Fts,
                            text: Some(parsed.text.clone()),
                            vector: None,
                            filter: filter.clone(),
                            limit: k * 3,
                            offset: 0,
                            with_vector: false,
                        },
                    )
                    .await?;
                if let Some(timings) = timings.as_mut() {
                    timings.fts_ms += fts_started.elapsed().as_secs_f64() * 1000.0;
                }
                fts_stats.insert(
                    target.collection.name.clone(),
                    explain::StageStats::from_hits(&fts),
                );
                // 纯向量那一趟:只为 explain 提供“向量阶段名次与分数”
                if let Some(vector) = &vector {
                    let vector_started = std::time::Instant::now();
                    let vec_hits = self
                        .store
                        .search(
                            &target.collection.active_table,
                            &StoreQuery {
                                mode: SearchMode::Vector,
                                text: None,
                                vector: Some(vector.clone()),
                                filter: filter.clone(),
                                limit: k * 3,
                                offset: 0,
                                with_vector: false,
                            },
                        )
                        .await?;
                    if let Some(timings) = timings.as_mut() {
                        timings.vector_ms += vector_started.elapsed().as_secs_f64() * 1000.0;
                    }
                    vector_stats.insert(
                        target.collection.name.clone(),
                        explain::StageStats::from_hits(&vec_hits),
                    );
                }
            }
            lists.push(CollectionHits {
                collection: target.collection.name.clone(),
                weight: target.weight,
                hits,
            });
            // pending 列表必须和主列表一起进全局 RRF:等融合完再追加就绕过了去重、重排、
            // 窗口扩展,变成「挂在末尾」的第二类结果。
            if !pending_hits.is_empty() {
                lists.push(CollectionHits {
                    collection: target.collection.name.clone(),
                    weight: target.weight * PENDING_WEIGHT,
                    hits: pending_hits,
                });
            }
        }

        let fuse_started = std::time::Instant::now();
        let mut fused = dedupe_overlaps(fuse(&lists, self.options.rrf_k));

        // 重排(设计规范第 7 步:仅当重排器可用且 mode≠off)
        //
        // `mode = auto`:请求显式给了就按请求,没说话就看重排器是否可用;
        // `mode = on`:默认开,除非请求显式 `rerank=false`;`mode = off`:永远不重排。
        let rerank_wanted = match self.options.rerank_mode.as_str() {
            "off" => false,
            "on" => request.rerank != Some(false),
            _ => request.rerank != Some(false),
        };
        // 只有“确实想要重排但不可用”才降级:auto + 未显式要求 + 不可用属于正常情况
        let rerank_requested = request.rerank == Some(true) || self.options.rerank_mode == "on";
        if rerank_wanted && rerank_requested && !self.reranker.available() {
            degraded = Some("rerank_unavailable".to_owned());
        }
        if let Some(timings) = timings.as_mut() {
            timings.fuse_ms = fuse_started.elapsed().as_secs_f64() * 1000.0;
        }
        let rerank_started = std::time::Instant::now();
        let mut reranked = false;
        if rerank_wanted && self.reranker.available() && !fused.is_empty() {
            let top_n = fused.len().min(self.options.rerank_top_n);
            let docs: Vec<String> = fused[..top_n]
                .iter()
                .map(|hit| truncate(&hit.row.text, self.options.rerank_truncate_chars))
                .collect();
            match tokio::time::timeout(
                std::time::Duration::from_millis(self.options.budget_ms),
                self.reranker.rerank(&parsed.text, &docs),
            )
            .await
            {
                Ok(Ok(scores)) => {
                    apply_rerank(&mut fused, &scores);
                    reranked = true;
                }
                Ok(Err(err)) => {
                    tracing::warn!(error = %err, "重排失败,使用融合结果");
                    degraded = Some("rerank_unavailable".to_owned());
                }
                Err(_) => degraded = Some("rerank_timeout".to_owned()),
            }
        }

        if let Some(timings) = timings.as_mut() {
            timings.rerank_ms = rerank_started.elapsed().as_secs_f64() * 1000.0;
            timings.parse_ms = parse_ms;
            timings.total_ms = parse_started.elapsed().as_secs_f64() * 1000.0;
        }

        let fused_ranks: HashMap<String, usize> = fused
            .iter()
            .enumerate()
            .map(|(index, hit)| (hit.row.id.clone(), index + 1))
            .collect();
        let mut hits = Vec::with_capacity(k);
        for fused_hit in fused.into_iter().take(k) {
            let target = targets
                .iter()
                .find(|target| target.collection.name == fused_hit.collection);
            // 读盘走阻塞线程池:一次检索最多展开 k 条命中,同步读会占住 tokio 工作线程
            let windowed = expand_async(
                &fused_hit.row,
                self.options.window_lines,
                target.and_then(|target| target.root.as_deref()),
            )
            .await;
            let explain = request.explain.then(|| {
                let mut explain = explain::build(
                    explain::FusedInfo {
                        collection: &fused_hit.collection,
                        store_rank: fused_hit.store_rank,
                        fused_rank: *fused_ranks.get(&fused_hit.row.id).unwrap_or(&0),
                        fused_score: fused_hit.score,
                        fused_weight: target.map(|target| target.weight as f32).unwrap_or(1.0),
                        id: &fused_hit.row.id,
                    },
                    fts_stats.get(&fused_hit.collection),
                    vector_stats.get(&fused_hit.collection),
                );
                explain.window = Some(windowed.explain);
                explain.pending = pending_ids.contains(&fused_hit.row.id);
                explain
            });
            hits.push(SearchHit {
                id: fused_hit.row.id.clone(),
                collection: fused_hit.collection.clone(),
                kind: fused_hit.row.kind,
                source: fused_hit.row.source.clone(),
                start_line: fused_hit.row.start_line.map(|line| line as u32),
                end_line: fused_hit.row.end_line.map(|line| line as u32),
                symbol: fused_hit.row.symbol.clone(),
                title: fused_hit.row.title.clone(),
                snippet: windowed.snippet,
                score: fused_hit.score as f32,
                related: Vec::new(),
                explain,
                anchor: fused_hit.row.anchor.clone(),
            });
        }
        // 结果里确实含 pending 命中时才降级提示。
        // 优先级:`embedder_unavailable` / `embedder_loading` > `vector_pending` > 重排失败。
        // 嵌入器彻底不可用时用户最需要知道的是「这次只有关键词结果」,不能被「部分向量待补」盖住;
        // 反过来,向量待补确实影响结果完整性,比重排没跑成更值得提示。
        let used_pending = hits.iter().any(|hit| pending_ids.contains(&hit.id));
        if used_pending {
            prefer_degraded(&mut degraded, "vector_pending");
        }
        Ok(SearchResponse {
            hits,
            scope: targets
                .iter()
                .map(|target| target.collection.name.clone())
                .collect(),
            query_parsed: parsed,
            degraded,
            timings,
            reranked,
        })
    }

    /// 把解析出的前缀转成过滤条件。
    fn build_filter(&self, parsed: &ParsedQuery) -> Result<Filter> {
        let mut filter = Filter::default();
        // 没有任何 kind 过滤时用默认三种(code / doc / insight);用户写了 `kind:` 前缀
        // 或传了 `kinds` 参数就完全按他的来。
        if parsed.kinds.is_empty() {
            filter.kinds = vec![RecordKind::Code, RecordKind::Doc, RecordKind::Insight];
        }
        for kind in &parsed.kinds {
            match kind.as_str() {
                "code" => filter.kinds.push(RecordKind::Code),
                "doc" => filter.kinds.push(RecordKind::Doc),
                "insight" => filter.kinds.push(RecordKind::Insight),
                "external" => filter.kinds.push(RecordKind::External),
                "summary" => filter.kinds.push(RecordKind::Summary),
                other => {
                    return Err(KbError::InvalidInput(format!("未知的 kind:{other}")));
                }
            }
        }
        match parsed.status.as_deref() {
            Some("all") => {
                filter.statuses = vec![
                    ItemStatus::Active,
                    ItemStatus::Superseded,
                    ItemStatus::Deprecated,
                ];
            }
            Some("active") | None => {}
            Some("superseded") => filter.statuses = vec![ItemStatus::Superseded],
            Some("deprecated") => filter.statuses = vec![ItemStatus::Deprecated],
            Some(other) => {
                return Err(KbError::InvalidInput(format!("未知的 status:{other}")));
            }
        }
        filter.lang = parsed.lang.clone();
        filter.path_prefix = parsed.path_prefix.clone();
        filter.tag = parsed.tag.clone();
        if let Some(since) = parsed.since {
            filter.updated_since = Some(now_millis() - since.millis());
        }
        Ok(filter)
    }

    /// 解析 collection 名(不存在的跳过并 warn)。
    async fn resolve(&self, names: &[String]) -> Result<Vec<Target>> {
        let mut targets = Vec::new();
        for name in names {
            let Some(collection) = CollectionRepo::get(self.meta.as_ref(), name).await? else {
                tracing::warn!(collection = %name, "检索目标不存在,已跳过");
                continue;
            };
            let root = match &collection.project_id {
                Some(project_id) => ProjectRepo::get(self.meta.as_ref(), project_id)
                    .await?
                    .map(|project| PathBuf::from(project.root_path)),
                None => None,
            };
            let weight = if collection.name == "_global" {
                self.options.global_weight
            } else {
                self.options
                    .collection_weights
                    .get(&collection.name)
                    .copied()
                    .unwrap_or(1.0)
            };
            targets.push(Target {
                collection,
                weight,
                root,
            });
        }
        Ok(targets)
    }
}

fn truncate(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    text.chars().take(limit).collect()
}

/// 降级原因的优先级:数字越大越严重。
///
/// 只影响「已经有一种降级原因时,要不要换成另一种」;未知原因按 0 处理,保持旧行为
/// (先出现的先留下)。
fn degraded_rank(code: &str) -> u8 {
    match code {
        "rerank_unavailable" => 1,
        "rerank_timeout" => 2,
        "vector_pending" => 3,
        "embedder_loading" => 4,
        "embedder_unavailable" => 5,
        _ => 0,
    }
}

/// 新原因比当前原因更严重时才替换。
fn prefer_degraded(slot: &mut Option<String>, next: &str) {
    let replace = slot
        .as_deref()
        .is_none_or(|current| degraded_rank(next) > degraded_rank(current));
    if replace {
        *slot = Some(next.to_owned());
    }
}

/// 只按重排分数调整前 `top_n` 条,其余保持原顺序接在后面。
fn apply_rerank(fused: &mut [FusedHit], scores: &[f32]) {
    let top_n = scores.len().min(fused.len());
    if top_n == 0 {
        return;
    }
    let mut pairs: Vec<(usize, f32)> = scores.iter().take(top_n).copied().enumerate().collect();
    pairs.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let original: Vec<FusedHit> = fused[..top_n].to_vec();
    for (slot, (index, _score)) in pairs.iter().enumerate() {
        fused[slot] = original[*index].clone();
    }
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 没有重排器时用的占位实现。
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopReranker;

#[async_trait::async_trait]
impl Reranker for NoopReranker {
    async fn rerank(&self, _query: &str, docs: &[String]) -> Result<Vec<f32>> {
        Ok(vec![0.0; docs.len()])
    }

    fn available(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod degraded_tests {
    use super::{degraded_rank, prefer_degraded};

    /// 未知降级码按 0 分:先出现的先留,避免新代码被旧的已知码顶掉。
    #[test]
    fn unknown_degraded_codes_do_not_overwrite_an_earlier_one() {
        assert_eq!(degraded_rank("embedder_unavailable"), 5);
        assert!(degraded_rank("embedder_unavailable") > degraded_rank("vector_pending"));
        assert!(degraded_rank("vector_pending") > degraded_rank("rerank_timeout"));
        // 未知的「新原因」不会顶掉已知的更严重的旧原因
        let mut slot = Some("vector_pending".to_owned());
        prefer_degraded(&mut slot, "future_code");
        assert_eq!(slot.as_deref(), Some("vector_pending"));
        // 只有未知原因时先留下它,不让槽位空着
        let mut empty = None;
        prefer_degraded(&mut empty, "future_code");
        assert_eq!(empty.as_deref(), Some("future_code"));
    }
}
