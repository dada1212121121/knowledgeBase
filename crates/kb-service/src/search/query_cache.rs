//! 查询向量缓存(L3 后半):同一个知识库里重复的查询不再重新嵌入。
//!
//! 以前同一个查询重复执行,每次都要跑一遍嵌入模型,耗时一点不降。现在每个知识库在运行时里放一份
//! 小缓存(知识库空闲被关掉时跟着释放):
//! - **不跨用户共享**:共享的话,命中与否的耗时差能让一个用户猜出别人刚搜过什么;
//! - 键里带嵌入器 id,换了模型不会拿到旧模型的向量;
//! - 键先规范化(去首尾空白、连续空白压成一个、统一小写):Agent 与用户写的同一句问题常常只差
//!   空格与大小写,不规范化等于每次都重新嵌入。向量只用于召回,全文那一路仍按原文匹配,
//!   所以这里的小写化不会改变「大小写敏感」的匹配结果,只是多复用了一次向量;
//! - 条数可配(`search.query_cache_entries`,默认 512 条,1024 维每条约 4 KB),按最近使用淘汰,
//!   线性查找就够了;另有 TTL(`search.query_cache_ttl_secs`,默认 900 秒)兜底,防止模型或
//!   索引调整后一直命中旧向量;
//! - 容量与 TTL 每拍从配置存储现读(跟着 `search.*` 的热更新走),不需要重启。

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use kb_core::config::{ConfigStore, SearchConfig};

/// 每个知识库默认最多记多少条查询向量。
pub const DEFAULT_CAPACITY: usize = 512;

/// 默认多久之后不再复用(秒)。
pub const DEFAULT_TTL_SECS: u64 = 900;

/// 容量与 TTL 从哪来:测试里固定,守护进程里跟着配置走。
enum Limits {
    Fixed {
        capacity: usize,
        ttl: Option<Duration>,
    },
    Config(std::sync::Arc<ConfigStore>),
}

impl Limits {
    fn now(&self) -> (usize, Option<Duration>) {
        match self {
            Self::Fixed { capacity, ttl } => (*capacity, *ttl),
            Self::Config(store) => {
                let search = &store.get().search;
                (
                    search.query_cache_entries,
                    (search.query_cache_ttl_secs > 0)
                        .then(|| Duration::from_secs(search.query_cache_ttl_secs)),
                )
            }
        }
    }
}

struct Entry {
    key: String,
    vector: Box<[f32]>,
    at: Instant,
}

/// 查询向量缓存。
pub struct QueryVectorCache {
    limits: Limits,
    /// 最近用过的在队尾。
    entries: Mutex<VecDeque<Entry>>,
}

impl Default for QueryVectorCache {
    /// 与 `[search]` 的默认值一致:512 条、15 分钟。
    fn default() -> Self {
        Self::with_ttl(
            DEFAULT_CAPACITY,
            Some(Duration::from_secs(DEFAULT_TTL_SECS)),
        )
    }
}

impl QueryVectorCache {
    /// 最多记 `capacity` 条;0 表示不缓存。不设 TTL(测试与纯条数场景用)。
    pub fn new(capacity: usize) -> Self {
        Self::with_ttl(capacity, None)
    }

    /// 带 TTL 的构造:`ttl` 到点之后不再复用。
    pub fn with_ttl(capacity: usize, ttl: Option<Duration>) -> Self {
        Self {
            limits: Limits::Fixed { capacity, ttl },
            entries: Mutex::new(VecDeque::with_capacity(capacity.min(DEFAULT_CAPACITY))),
        }
    }

    /// 按 `[search]` 配置构造(启动时的初值;之后跟着配置存储热更新)。
    pub fn from_config(search: &SearchConfig) -> Self {
        Self::with_ttl(
            search.query_cache_entries,
            (search.query_cache_ttl_secs > 0)
                .then(|| Duration::from_secs(search.query_cache_ttl_secs)),
        )
    }

    /// 跟着配置存储走:每次读写都现读容量与 TTL,改配置不用重启。
    pub fn following(store: std::sync::Arc<ConfigStore>) -> Self {
        Self {
            limits: Limits::Config(store),
            entries: Mutex::new(VecDeque::with_capacity(DEFAULT_CAPACITY)),
        }
    }

    /// 键:嵌入器 id + 规范化后的查询词。NUL 不会出现在嵌入器 id 里,拼起来不会撞。
    fn key(embedder_id: &str, text: &str) -> String {
        format!("{embedder_id}\u{0}{}", normalize(text))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    /// 取一条;命中的挪到最近使用。过期或被淘汰的顺手清掉。
    pub fn get(&self, embedder_id: &str, text: &str) -> Option<Vec<f32>> {
        let (capacity, ttl) = self.limits.now();
        if capacity == 0 {
            return None;
        }
        let key = Self::key(embedder_id, text);
        let mut entries = self.lock();
        let index = entries.iter().position(|entry| entry.key == key)?;
        let entry = entries.remove(index)?;
        // 过期的不能再复用:模型或索引调整之后,旧向量只会在候选集里制造噪音
        if ttl.is_some_and(|ttl| entry.at.elapsed() > ttl) {
            return None;
        }
        // 容量被调小之后,排在队尾之外的旧条目立刻失效
        while entries.len() >= capacity {
            entries.pop_front();
        }
        let vector = entry.vector.to_vec();
        entries.push_back(entry);
        Some(vector)
    }

    /// 记一条;满了先淘汰最久没用的。
    pub fn put(&self, embedder_id: &str, text: &str, vector: &[f32]) {
        let (capacity, _) = self.limits.now();
        if capacity == 0 {
            return;
        }
        let key = Self::key(embedder_id, text);
        let mut entries = self.lock();
        if let Some(index) = entries.iter().position(|entry| entry.key == key) {
            entries.remove(index);
        }
        while entries.len() >= capacity {
            entries.pop_front();
        }
        entries.push_back(Entry {
            key,
            vector: vector.into(),
            at: Instant::now(),
        });
    }

    /// 现在记着几条。
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// 是不是一条都没有。
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// 规范化查询词:去首尾空白、连续空白压成一个、统一小写。
///
/// 只影响「要不要复用这条向量」,不影响全文匹配用的原文。
fn normalize(text: &str) -> String {
    let mut normalized = String::with_capacity(text.len());
    for word in text.split_whitespace() {
        if !normalized.is_empty() {
            normalized.push(' ');
        }
        normalized.push_str(word);
    }
    normalized.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_least_recently_used_entry_is_evicted_first() {
        let cache = QueryVectorCache::new(2);
        cache.put("m", "a", &[1.0]);
        cache.put("m", "b", &[2.0]);
        // 用一下 a,b 变成最久没用的
        assert_eq!(cache.get("m", "a"), Some(vec![1.0]));
        cache.put("m", "c", &[3.0]);
        assert_eq!(cache.len(), 2);
        assert_eq!(cache.get("m", "b"), None, "最久没用的被淘汰");
        assert_eq!(cache.get("m", "a"), Some(vec![1.0]));
        assert_eq!(cache.get("m", "c"), Some(vec![3.0]));
    }

    #[test]
    fn a_different_embedder_never_gets_another_models_vector() {
        let cache = QueryVectorCache::new(4);
        cache.put("fastembed:bge-m3", "检索", &[1.0, 2.0]);
        assert_eq!(cache.get("http:other-model", "检索"), None);
        assert_eq!(cache.get("fastembed:bge-m3", "检索"), Some(vec![1.0, 2.0]));
    }

    #[test]
    fn putting_the_same_query_again_keeps_one_entry() {
        let cache = QueryVectorCache::new(4);
        cache.put("m", "a", &[1.0]);
        cache.put("m", "a", &[1.5]);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("m", "a"), Some(vec![1.5]));
    }

    #[test]
    fn zero_capacity_caches_nothing() {
        let cache = QueryVectorCache::new(0);
        cache.put("m", "a", &[1.0]);
        assert!(cache.is_empty());
        assert_eq!(cache.get("m", "a"), None);
    }

    #[test]
    fn spacing_and_case_do_not_multiply_entries() {
        let cache = QueryVectorCache::new(8);
        cache.put("m", "  知识库   检索  ", &[1.0]);
        assert_eq!(
            cache.get("m", "知识库 检索"),
            Some(vec![1.0]),
            "空白不同还是同一条"
        );
        assert_eq!(cache.len(), 1);

        // 英文问句的大小写差异同理;全角空格也算空白
        cache.put("m", "How Does Hybrid Search\tWork", &[2.0]);
        assert_eq!(
            cache.get("m", "how does hybrid search work"),
            Some(vec![2.0])
        );
        assert_eq!(cache.len(), 2);
    }

    #[test]
    fn an_expired_entry_is_not_reused() {
        let cache = QueryVectorCache::with_ttl(8, Some(Duration::from_millis(30)));
        cache.put("m", "检索", &[1.0]);
        assert_eq!(cache.get("m", "检索"), Some(vec![1.0]), "没过期时能用");
        std::thread::sleep(Duration::from_millis(60));
        assert_eq!(cache.get("m", "检索"), None, "过期之后不再复用");
        assert!(cache.is_empty(), "过期的那条顺手清掉");
    }

    #[test]
    fn no_ttl_keeps_entries_forever() {
        let cache = QueryVectorCache::with_ttl(4, None);
        cache.put("m", "a", &[1.0]);
        std::thread::sleep(Duration::from_millis(20));
        assert_eq!(cache.get("m", "a"), Some(vec![1.0]));
    }

    /// 容量与 TTL 跟着配置走:调小之后立刻按新容量淘汰。
    #[test]
    fn limits_follow_the_config_store() {
        let mut config = kb_core::config::Config::default();
        config.search.query_cache_entries = 3;
        let store = std::sync::Arc::new(ConfigStore::new(config));
        let cache = QueryVectorCache::following(store.clone());
        for text in ["a", "b", "c"] {
            cache.put("m", text, &[1.0]);
        }
        assert_eq!(cache.len(), 3);

        let mut smaller = (*store.get()).clone();
        smaller.search.query_cache_entries = 1;
        store.replace(smaller);
        // 容量变小之后,旧的先失效,新的一直保持在 1 条
        cache.put("m", "d", &[1.0]);
        assert_eq!(cache.len(), 1);
        assert_eq!(cache.get("m", "d"), Some(vec![1.0]));

        // 关掉缓存(0 条)之后既不再记,也拿不到
        let mut off = (*store.get()).clone();
        off.search.query_cache_entries = 0;
        store.replace(off);
        assert_eq!(cache.get("m", "d"), None);
        cache.put("m", "e", &[1.0]);
        assert_eq!(cache.len(), 1, "关掉之后不再记新的");
    }

    #[test]
    fn from_config_uses_the_configured_numbers() {
        let search = SearchConfig {
            query_cache_entries: 7,
            query_cache_ttl_secs: 60,
            ..SearchConfig::default()
        };
        let cache = QueryVectorCache::from_config(&search);
        for index in 0..10 {
            cache.put("m", &format!("q{index}"), &[1.0]);
        }
        assert_eq!(cache.len(), 7, "按配置的条数淘汰");

        // TTL 为 0 表示不过期
        let never = SearchConfig {
            query_cache_ttl_secs: 0,
            ..SearchConfig::default()
        };
        let no_ttl = QueryVectorCache::from_config(&never);
        no_ttl.put("m", "a", &[1.0]);
        assert_eq!(no_ttl.get("m", "a"), Some(vec![1.0]));
    }
}
