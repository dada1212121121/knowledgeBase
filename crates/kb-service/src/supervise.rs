//! 子进程的监护协议:懒启动 + 退出后置空 + 下次调用重拉。
//!
//! 两处用户是同一个形状,所以把「槽 + 代号」抽出来一处:
//!
//! - 插件宿主(`skills/host.rs`):`call` 发现槽里没有进程就拉一个;请求失败立刻
//!   `kill` 并置空——半截响应串到下一个请求比多拉一次进程贵得多。
//! - office-worker(`kb-cli/src/office_collab.rs`):`worker` 发现槽里没有或 stdin 已关
//!   就重拉;进程退出时**还要**把这一代打开的协作房间一起作废(浏览器收到断开后重连)。
//!
//! 抽这层不是为了少几行,而是为了把「只有当前这一代才算数」这个判断收在一处:
//! 两处手写都是 `is_some_and(|x| x.generation == g)` 再置空,漏判或早判的后果分别是
//! 「旧进程退出把新进程清掉了」和「崩溃后状态永远停在上一代」。
//!
//! 这里**不**管进程怎么起、怎么问、怎么杀:那三件事两边完全不同(插件是 argv + bwrap,
//! office-worker 是 node 脚本 + ready 握手),也不该为统一而统一。

use std::sync::atomic::{AtomicU64, Ordering};

use tokio::sync::{Mutex, MutexGuard};

/// 一代子进程的代号。每次拉起一个新进程就 +1,只增不减。
pub type Generation = u64;

/// 槽里的一代:进程本体 + 它的代号。
pub struct Entry<T> {
    /// 这一代的代号。
    pub generation: Generation,
    /// 进程本体(或包着它的 `Arc`)。
    pub value: T,
}

/// 子进程槽:同一时刻最多一个进程,换代时旧的那个作废。
///
/// 用异步锁是因为两处调用方都在 `async` 里取用;进程本身不并发(索引是顺序处理的),
/// 所以这把锁不是瓶颈,以后要并行应当按进程池设计而不是拆这把锁。
pub struct Slot<T> {
    inner: Mutex<Option<Entry<T>>>,
    next: AtomicU64,
}

impl<T> Default for Slot<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> Slot<T> {
    /// 空槽。
    pub const fn new() -> Self {
        Self {
            inner: Mutex::const_new(None),
            next: AtomicU64::new(1),
        }
    }

    /// 直接锁住槽(调用方要拿 `&mut` 时用它)。
    pub async fn lock(&self) -> MutexGuard<'_, Option<Entry<T>>> {
        self.inner.lock().await
    }

    /// 取下一个代号。**先取代号再拉起进程**,拉起失败也不回收——回收会让「失败那次」
    /// 与「重试那次」拿到同一个号,退出回调就分不清是哪一个死了。
    pub fn next_generation(&self) -> Generation {
        self.next.fetch_add(1, Ordering::Relaxed)
    }

    /// 当前这一代的拷贝(需要 `T: Clone`,通常是 `Arc<进程>`)。不持有锁跨 `await`。
    pub async fn current(&self) -> Option<T>
    where
        T: Clone,
    {
        self.inner.lock().await.as_ref().map(|e| e.value.clone())
    }

    /// 进程没了:槽里还是这一代就置空并交还它,否则什么都不做。
    ///
    /// 「还是这一代」是这条协议的全部要害:空闲退出、崩溃、被主动重拉都会走到这里,
    /// 而晚到的通知不能把后来拉起的那个进程清掉。
    pub async fn retire(&self, generation: Generation) -> Option<T> {
        let mut guard = self.inner.lock().await;
        if guard.as_ref().is_some_and(|e| e.generation == generation) {
            guard.take().map(|e| e.value)
        } else {
            None
        }
    }

    /// 无条件置空(请求失败、状态不可信时用)。
    pub async fn clear(&self) -> Option<T> {
        self.inner.lock().await.take().map(|e| e.value)
    }

    /// 槽里是否空着。
    pub async fn is_empty(&self) -> bool {
        self.inner.lock().await.is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_stale_generation_cannot_clear_the_new_one() {
        let slot: Slot<&str> = Slot::new();
        let first = slot.next_generation();
        *slot.lock().await = Some(Entry {
            generation: first,
            value: "first",
        });
        // 旧进程晚到的退出通知:不许动槽里的新进程。
        assert_eq!(slot.retire(first - 1).await, None);
        assert!(!slot.is_empty().await);
        assert_eq!(slot.current().await, Some("first"));
        assert_eq!(slot.retire(first).await, Some("first"));
        assert!(slot.is_empty().await);
    }

    #[tokio::test]
    async fn generations_only_grow_and_skip_nothing() {
        let slot: Slot<u8> = Slot::new();
        let picked: Vec<u64> = (0..3).map(|_| slot.next_generation()).collect();
        assert_eq!(picked, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn clear_takes_whatever_is_there() {
        let slot: Slot<&str> = Slot::new();
        let generation = slot.next_generation();
        *slot.lock().await = Some(Entry {
            generation,
            value: "only",
        });
        assert_eq!(slot.clear().await, Some("only"));
        assert_eq!(slot.clear().await, None);
    }
}
