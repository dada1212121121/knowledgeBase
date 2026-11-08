//! 在线编辑的「谁在编辑」状态:编辑权 + 心跳 + 超时自动释放。
//!
//! 腾讯文档那类产品的做法是多人实时协同,界面上看得到谁在文档里;我们的方案把「多人同时编辑同一个 Office 文件」
//! 列为暂不做(浏览器里的引擎改的是整份文件的字节,没法合并),所以取其中能落地的部分:
//! - **谁在编辑**:打开编辑器的人拿到这份文件的编辑权,别人打开时是只读,并且看得到是谁、多久之前还有动静;
//! - **心跳**:编辑器每隔几秒报一次平安;超过 [`LOCK_TTL`] 没有心跳(关了标签页、断网、电脑睡了)编辑权自动失效,
//!   不会留下一把永远打不开的锁;
//! - **接手**:对方还「在线」但人不在时,可以明确接手(原持有者下次心跳会发现编辑权已经没了,界面退回只读);
//! - **只是建议性的**:不拿编辑权的调用(命令行、其它接口)照旧可以替换文件,真正兜底的是内容哈希的乐观锁;
//!   但**带着会话编号**来替换的请求,如果文件的编辑权在别的会话手里,服务端会拒绝。
//!
//! 状态只放在内存里:守护进程重启后大家的编辑器会在下一次心跳时重新拿到编辑权,不需要持久化。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 编辑权多久没有心跳就自动失效。
pub const LOCK_TTL: Duration = Duration::from_secs(45);
/// 同时登记的编辑权数量上限(防止被刷爆内存;超出时先清掉已过期的,还不够就拒绝新的)。
const MAX_LOCKS: usize = 10_000;

/// 当前时间(毫秒,unix 时间)的来源;测试里换成可控的。
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// 编辑权的持有者。
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct LockHolder {
    /// 谁(账号)。
    pub actor: String,
    /// 哪个编辑器窗口(每个标签页一个随机编号)。
    pub session: String,
    /// 从什么时候开始持有(毫秒,unix 时间)。
    pub since_ms: i64,
    /// 最近一次心跳距今多少秒。
    pub idle_secs: u64,
}

/// 申请编辑权的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Acquire {
    /// 拿到了(或心跳续上了)。`took_over_from` 是被接手的原持有者。
    Granted { took_over_from: Option<LockHolder> },
    /// 别人持有着,没拿到。
    Held { holder: LockHolder },
    /// 登记的编辑权太多了,先不给新的。
    Full,
}

struct Entry {
    actor: String,
    session: String,
    since_ms: i64,
    beat_ms: i64,
}

/// 内存里的编辑权表。键由调用方拼(要带上知识库的编号,各人的库互不相干)。
pub struct FileLocks {
    entries: Mutex<HashMap<String, Entry>>,
    ttl_ms: i64,
    clock: Clock,
}

impl Default for FileLocks {
    fn default() -> Self {
        Self::new()
    }
}

impl FileLocks {
    /// 用系统时钟和默认的 [`LOCK_TTL`]。
    pub fn new() -> Self {
        Self::with_clock(
            LOCK_TTL,
            Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or_default()
            }),
        )
    }

    /// 指定超时和时钟(测试用)。
    pub fn with_clock(ttl: Duration, clock: Clock) -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
            ttl_ms: ttl.as_millis() as i64,
            clock,
        }
    }

    /// 超时时长(秒),界面据此决定心跳间隔。
    pub fn ttl_secs(&self) -> u64 {
        (self.ttl_ms / 1000) as u64
    }

    fn holder_of(&self, entry: &Entry, now: i64) -> LockHolder {
        LockHolder {
            actor: entry.actor.clone(),
            session: entry.session.clone(),
            since_ms: entry.since_ms,
            idle_secs: ((now - entry.beat_ms).max(0) / 1000) as u64,
        }
    }

    fn live(&self, entry: &Entry, now: i64) -> bool {
        now - entry.beat_ms < self.ttl_ms
    }

    /// 申请(或用同一个会话再次申请 = 心跳)编辑权。
    ///
    /// - 没人持有 / 已过期 / 持有者就是这个会话:给,并记下最近一次心跳;
    /// - 别人持有且还活着:`take_over` 为真就接手,否则返回 [`Acquire::Held`]。
    pub fn acquire(&self, key: &str, actor: &str, session: &str, take_over: bool) -> Acquire {
        let now = (self.clock)();
        let mut entries = self.entries.lock().expect("编辑权表的锁");
        if let Some(entry) = entries.get_mut(key) {
            if entry.session == session {
                entry.beat_ms = now;
                entry.actor = actor.to_owned();
                return Acquire::Granted {
                    took_over_from: None,
                };
            }
            if self.live(entry, now) && !take_over {
                return Acquire::Held {
                    holder: self.holder_of(entry, now),
                };
            }
            let previous = self.live(entry, now).then(|| self.holder_of(entry, now));
            *entry = Entry {
                actor: actor.to_owned(),
                session: session.to_owned(),
                since_ms: now,
                beat_ms: now,
            };
            return Acquire::Granted {
                took_over_from: previous,
            };
        }
        if entries.len() >= MAX_LOCKS {
            let ttl = self.ttl_ms;
            entries.retain(|_, entry| now - entry.beat_ms < ttl);
            if entries.len() >= MAX_LOCKS {
                return Acquire::Full;
            }
        }
        entries.insert(
            key.to_owned(),
            Entry {
                actor: actor.to_owned(),
                session: session.to_owned(),
                since_ms: now,
                beat_ms: now,
            },
        );
        Acquire::Granted {
            took_over_from: None,
        }
    }

    /// 主动交还编辑权。只有当前持有者的会话能交还;别人的会话调用什么也不做。返回是否真的释放了。
    pub fn release(&self, key: &str, session: &str) -> bool {
        let mut entries = self.entries.lock().expect("编辑权表的锁");
        match entries.get(key) {
            Some(entry) if entry.session == session => {
                entries.remove(key);
                true
            }
            _ => false,
        }
    }

    /// 这份文件现在有没有**别的会话**活着地持有着编辑权(替换文件前问一下)。
    /// `session` 为空(调用方没带会话编号)时,任何活着的持有者都算「别人」。
    pub fn held_by_other(&self, key: &str, session: Option<&str>) -> Option<LockHolder> {
        let now = (self.clock)();
        let entries = self.entries.lock().expect("编辑权表的锁");
        let entry = entries.get(key)?;
        if !self.live(entry, now) || session == Some(entry.session.as_str()) {
            return None;
        }
        Some(self.holder_of(entry, now))
    }

    /// 现在的持有者(过期的不算)。
    pub fn holder(&self, key: &str) -> Option<LockHolder> {
        let now = (self.clock)();
        let entries = self.entries.lock().expect("编辑权表的锁");
        let entry = entries.get(key)?;
        self.live(entry, now).then(|| self.holder_of(entry, now))
    }

    /// 登记着多少条(含已过期还没清掉的),测试和监控用。
    pub fn len(&self) -> usize {
        self.entries.lock().expect("编辑权表的锁").len()
    }

    /// 是否一条都没有。
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn locks() -> (FileLocks, Arc<AtomicI64>) {
        let now = Arc::new(AtomicI64::new(1_000_000));
        let clock = {
            let now = now.clone();
            Arc::new(move || now.load(Ordering::SeqCst)) as Clock
        };
        (FileLocks::with_clock(Duration::from_secs(45), clock), now)
    }

    fn advance(now: &AtomicI64, secs: i64) {
        now.fetch_add(secs * 1000, Ordering::SeqCst);
    }

    #[test]
    fn the_first_session_gets_it_and_a_second_one_is_told_who_holds_it() {
        let (locks, now) = locks();
        assert_eq!(
            locks.acquire("k", "alice", "tab-a", false),
            Acquire::Granted {
                took_over_from: None
            }
        );
        advance(&now, 12);
        match locks.acquire("k", "bob", "tab-b", false) {
            Acquire::Held { holder } => {
                assert_eq!(holder.actor, "alice");
                assert_eq!(holder.session, "tab-a");
                assert_eq!(holder.idle_secs, 12, "最近一次心跳是 12 秒前");
                assert_eq!(holder.since_ms, 1_000_000);
            }
            other => panic!("应被拒绝: {other:?}"),
        }
        // 别的文件互不相干
        assert!(matches!(
            locks.acquire("other", "bob", "tab-b", false),
            Acquire::Granted { .. }
        ));
    }

    #[test]
    fn the_same_session_asking_again_is_a_heartbeat_that_keeps_the_original_start_time() {
        let (locks, now) = locks();
        locks.acquire("k", "alice", "tab-a", false);
        advance(&now, 40);
        assert!(matches!(
            locks.acquire("k", "alice", "tab-a", false),
            Acquire::Granted {
                took_over_from: None
            }
        ));
        advance(&now, 40); // 距第一次 80 秒,但距上次心跳只有 40 秒:仍然活着
        let holder = locks.holder("k").expect("心跳续上了");
        assert_eq!(holder.since_ms, 1_000_000, "开始时间不因心跳改变");
        assert_eq!(holder.idle_secs, 40);
        assert!(matches!(
            locks.acquire("k", "bob", "tab-b", false),
            Acquire::Held { .. }
        ));
    }

    #[test]
    fn without_a_heartbeat_the_lock_expires_by_itself() {
        let (locks, now) = locks();
        locks.acquire("k", "alice", "tab-a", false);
        advance(&now, 44);
        assert!(locks.holder("k").is_some(), "44 秒还活着");
        advance(&now, 1);
        assert!(locks.holder("k").is_none(), "满 45 秒没有心跳就失效");
        assert_eq!(locks.held_by_other("k", Some("tab-b")), None);
        // 别人可以直接拿,而且不算「接手」(原持有者已经不在了)
        assert_eq!(
            locks.acquire("k", "bob", "tab-b", false),
            Acquire::Granted {
                took_over_from: None
            }
        );
        assert_eq!(locks.holder("k").unwrap().actor, "bob");
    }

    #[test]
    fn taking_over_replaces_a_live_holder_and_reports_who_lost_it() {
        let (locks, now) = locks();
        locks.acquire("k", "alice", "tab-a", false);
        advance(&now, 5);
        match locks.acquire("k", "bob", "tab-b", true) {
            Acquire::Granted {
                took_over_from: Some(previous),
            } => {
                assert_eq!(
                    (previous.actor.as_str(), previous.session.as_str()),
                    ("alice", "tab-a")
                );
            }
            other => panic!("应接手成功并点名原持有者: {other:?}"),
        }
        // 原持有者下一次心跳发现自己已经不是持有者
        assert!(matches!(
            locks.acquire("k", "alice", "tab-a", false),
            Acquire::Held { holder } if holder.actor == "bob"
        ));
    }

    #[test]
    fn only_the_holder_can_release_it() {
        let (locks, _) = locks();
        locks.acquire("k", "alice", "tab-a", false);
        assert!(!locks.release("k", "tab-b"), "别人不能替她交还");
        assert!(locks.holder("k").is_some());
        assert!(locks.release("k", "tab-a"));
        assert!(locks.holder("k").is_none());
        assert!(!locks.release("k", "tab-a"), "已经没有了");
        assert!(matches!(
            locks.acquire("k", "bob", "tab-b", false),
            Acquire::Granted { .. }
        ));
    }

    #[test]
    fn replacing_is_refused_only_when_another_live_session_holds_it() {
        let (locks, now) = locks();
        // 没人持有:谁都可以(命令行、旧客户端)
        assert_eq!(locks.held_by_other("k", None), None);
        assert_eq!(locks.held_by_other("k", Some("tab-x")), None);

        locks.acquire("k", "alice", "tab-a", false);
        assert_eq!(locks.held_by_other("k", Some("tab-a")), None, "持有者自己");
        assert_eq!(
            locks.held_by_other("k", Some("tab-b")).unwrap().actor,
            "alice"
        );
        assert_eq!(
            locks.held_by_other("k", None).unwrap().actor,
            "alice",
            "没带会话编号的调用,遇到活着的持有者也要拒绝"
        );
        advance(&now, 60);
        assert_eq!(locks.held_by_other("k", None), None, "过期了就不拦");
    }

    #[test]
    fn the_table_cannot_grow_without_bound_and_expired_entries_are_reclaimed() {
        let (locks, now) = locks();
        for index in 0..MAX_LOCKS {
            assert!(matches!(
                locks.acquire(&format!("k{index}"), "u", "s", false),
                Acquire::Granted { .. }
            ));
        }
        assert_eq!(locks.acquire("new", "u", "s2", false), Acquire::Full);
        advance(&now, 60); // 全部过期
        assert!(matches!(
            locks.acquire("new", "u", "s2", false),
            Acquire::Granted { .. }
        ));
        assert!(locks.len() < MAX_LOCKS, "过期的被清掉了:{}", locks.len());
    }

    #[test]
    fn ttl_is_reported_in_seconds_for_the_heartbeat_interval() {
        let (locks, _) = locks();
        assert_eq!(locks.ttl_secs(), 45);
        assert_eq!(FileLocks::new().ttl_secs(), LOCK_TTL.as_secs());
    }
}
