//! 待补向量队列的短缓存。
//!
//! 每次混合检索都要问一次「这个 collection 还有没有待补向量的块」。这个问题很便宜
//! (一条走索引的 SQLite 查询),但 100 并发时每个请求都问一遍仍然是白花的 IO,
//! 而且两次嵌入之间队列几乎不会变。缓存 2 秒:
//!
//! - 命中缓存时**不查 SQLite**,也不额外查 Lance / FTS;
//! - key 带上 `space_id`:主知识库和其他知识库的 collection 可能同名,不能串;
//! - 队列在嵌入完成后清空,最多 2 秒后检索才会看到「没有 pending」;这 2 秒里
//!   补充列表为空,不影响正确性。
//!
//! 这个缓存放在运行时里、跨请求共享;`SearchService` 每次请求新建,不能把缓存挂在它身上。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use kb_core::Result;

/// 队列状态的缓存时长:足够吸收一次并发突发,又不会让「补完了」晚太久被看到。
pub const PENDING_CACHE_TTL: Duration = Duration::from_secs(2);

struct Entry {
    checked_at: Instant,
    exists: bool,
}

/// 一个知识库内「collection → 是否有待补向量块」的短缓存。
pub struct PendingExistsCache {
    space_id: String,
    ttl: Duration,
    entries: Mutex<HashMap<String, Entry>>,
}

impl PendingExistsCache {
    /// 默认 2 秒;`space_id` 参与缓存 key,避免不同知识库的同名 collection 互相污染。
    pub fn new(space_id: impl Into<String>) -> Self {
        Self::with_ttl(space_id, PENDING_CACHE_TTL)
    }

    /// 指定 TTL(测试用;TTL 为 0 表示不缓存)。
    pub fn with_ttl(space_id: impl Into<String>, ttl: Duration) -> Self {
        Self {
            space_id: space_id.into(),
            ttl,
            entries: Mutex::new(HashMap::new()),
        }
    }

    /// 这个 collection 是否有待补向量块。
    ///
    /// `load` 只在缓存未命中时执行。缓存命中时连接口都不碰,所以调用方可以放心
    /// 把真实的 SQLite 查询放进来。
    pub async fn exists<F, Fut>(&self, collection: &str, load: F) -> Result<bool>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<bool>>,
    {
        if let Some(exists) = self.cached(collection) {
            return Ok(exists);
        }
        let exists = load().await?;
        self.store(collection, exists);
        Ok(exists)
    }

    /// 缓存命中且没过期时返回结果;过期的条目顺手删掉,避免长期不用的 collection 一直占内存。
    fn cached(&self, collection: &str) -> Option<bool> {
        if self.ttl.is_zero() {
            return None;
        }
        let key = self.key(collection);
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match entries.get(&key) {
            Some(entry) if entry.checked_at.elapsed() < self.ttl => Some(entry.exists),
            Some(_) => {
                entries.remove(&key);
                None
            }
            None => None,
        }
    }

    fn store(&self, collection: &str, exists: bool) {
        if self.ttl.is_zero() {
            return;
        }
        let key = self.key(collection);
        let mut entries = self
            .entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // 顺手清掉别的过期条目:知识库很多时 collection 名会越积越多
        entries.retain(|_, entry| entry.checked_at.elapsed() < self.ttl);
        entries.insert(
            key,
            Entry {
                checked_at: Instant::now(),
                exists,
            },
        );
    }

    fn key(&self, collection: &str) -> String {
        format!("{}\0{collection}", self.space_id)
    }

    /// 当前缓存条数(测试 / 观测用)。
    pub fn len(&self) -> usize {
        self.entries
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .len()
    }

    /// 缓存是否为空。
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[tokio::test]
    async fn a_hit_skips_the_loader_until_the_ttl_expires() {
        let cache = PendingExistsCache::with_ttl("sp_primary", Duration::from_millis(30));
        let calls = AtomicUsize::new(0);
        let load = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        };
        assert!(cache.exists("proj_demo", load).await.expect("第一次"));
        assert!(cache.exists("proj_demo", load).await.expect("缓存命中"));
        assert_eq!(calls.load(Ordering::SeqCst), 1, "2 秒内只查一次 SQLite");
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(cache.exists("proj_demo", load).await.expect("过期后重查"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn different_spaces_or_collections_do_not_share_entries() {
        let first = PendingExistsCache::new("sp_a");
        let second = PendingExistsCache::new("sp_b");
        let calls = AtomicUsize::new(0);
        let load = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(true)
        };
        first.exists("proj_same", load).await.expect("a");
        second.exists("proj_same", load).await.expect("b");
        first
            .exists("proj_other", load)
            .await
            .expect("另一个 collection");
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "space + collection 都要进 key"
        );
    }

    #[tokio::test]
    async fn a_zero_ttl_never_caches() {
        let cache = PendingExistsCache::with_ttl("sp_primary", Duration::ZERO);
        let calls = AtomicUsize::new(0);
        let load = || async {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(false)
        };
        assert!(!cache.exists("proj_demo", load).await.expect("第一次"));
        assert!(!cache.exists("proj_demo", load).await.expect("第二次"));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
        assert!(cache.is_empty());
    }
}
