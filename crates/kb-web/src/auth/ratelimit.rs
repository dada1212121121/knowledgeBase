//! 登录失败限速:同一来源每分钟最多 5 次失败,超过返回 429。

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Mutex;

use kb_core::model::Millis;

/// 窗口长度(毫秒)。
pub const WINDOW_MS: i64 = 60_000;
/// 窗口内允许的失败次数。
pub const MAX_FAILURES: usize = 5;

/// 按账号计的窗口(毫秒):15 分钟。
pub const ACCOUNT_WINDOW_MS: i64 = 15 * 60_000;
/// 一个账号在窗口内允许的失败次数。
pub const ACCOUNT_MAX_FAILURES: usize = 10;

/// 内存里的失败计数器(进程级;重启后清零)。
///
/// 同一个计数器里可以放不同性质的键,各自带自己的窗口和上限:登录用「来源 IP」(1 分钟 5 次)
/// 和「被试的账号」(15 分钟 10 次)两把锁。只按 IP 不够——换 IP(代理池 / 僵尸网络)就能无限试;
/// 只按账号会被人拿来锁别人,所以两把都要。
#[derive(Default)]
pub struct LoginLimiter {
    failures: Mutex<HashMap<String, VecDeque<Millis>>>,
}

impl LoginLimiter {
    /// 新建。
    pub fn new() -> Self {
        Self::default()
    }

    /// 该来源现在是否已被限速(默认窗口:1 分钟 5 次)。
    pub fn blocked(&self, key: &str, now: Millis) -> bool {
        self.blocked_in(key, now, WINDOW_MS, MAX_FAILURES)
    }

    /// 记一次失败(默认窗口)。
    pub fn record_failure(&self, key: &str, now: Millis) {
        self.record_failure_in(key, now, WINDOW_MS);
    }

    /// 指定窗口和上限:`window_ms` 内失败 `max` 次及以上就算被限速。
    pub fn blocked_in(&self, key: &str, now: Millis, window_ms: i64, max: usize) -> bool {
        let mut guard = self
            .failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let Some(queue) = guard.get_mut(key) else {
            return false;
        };
        prune(queue, now, window_ms);
        queue.len() >= max
    }

    /// 指定窗口记一次失败。
    pub fn record_failure_in(&self, key: &str, now: Millis, window_ms: i64) {
        let mut guard = self
            .failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        // 键是攻击者能随便造的(用户名、IP):表太大时顺手清掉早就过期的,内存不会被撑爆
        if guard.len() > MAX_KEYS {
            guard.retain(|_, queue| {
                queue
                    .back()
                    .is_some_and(|last| now - *last < ACCOUNT_WINDOW_MS)
            });
        }
        let queue = guard.entry(key.to_owned()).or_default();
        prune(queue, now, window_ms);
        queue.push_back(now);
    }

    /// 登录成功后清空。
    ///
    /// **登录不要用它**:攻击者可以用自己的账号登录成功来清掉自己的失败记录,窗口就被无限续期了。
    /// 登录的失败只让它随窗口自然过期;这个方法留给「本人操作」类的场景(比如改密码时的当前密码校验)。
    pub fn reset(&self, key: &str) {
        let mut guard = self
            .failures
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        guard.remove(key);
    }
}

/// 计数器里最多留多少个键,超过就清理过期的。
const MAX_KEYS: usize = 50_000;

fn prune(queue: &mut VecDeque<Millis>, now: Millis, window_ms: i64) {
    while queue
        .front()
        .is_some_and(|earlier| now - *earlier >= window_ms)
    {
        queue.pop_front();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_failures_block_the_sixth_attempt() {
        let limiter = LoginLimiter::new();
        let now = 1_700_000_000_000;
        for i in 0..MAX_FAILURES {
            assert!(
                !limiter.blocked("1.2.3.4", now + i as i64),
                "第 {i} 次不应被挡"
            );
            limiter.record_failure("1.2.3.4", now + i as i64);
        }
        assert!(limiter.blocked("1.2.3.4", now + 10), "第 6 次必须被挡");
        assert!(!limiter.blocked("5.6.7.8", now + 10), "别的来源不受影响");
    }

    #[test]
    fn the_window_slides() {
        let limiter = LoginLimiter::new();
        let now = 1_700_000_000_000;
        for _ in 0..MAX_FAILURES {
            limiter.record_failure("ip", now);
        }
        assert!(limiter.blocked("ip", now + 1000));
        assert!(!limiter.blocked("ip", now + WINDOW_MS), "窗口过后应解封");
    }

    #[test]
    fn success_resets_the_counter() {
        let limiter = LoginLimiter::new();
        let now = 1_700_000_000_000;
        for _ in 0..MAX_FAILURES {
            limiter.record_failure("ip", now);
        }
        limiter.reset("ip");
        assert!(!limiter.blocked("ip", now + 1));
    }

    #[test]
    fn keys_with_different_windows_do_not_interfere() {
        let limiter = LoginLimiter::new();
        let now = 1_700_000_000_000;
        for i in 0..ACCOUNT_MAX_FAILURES as i64 {
            assert!(!limiter.blocked_in(
                "acct:x",
                now + i,
                ACCOUNT_WINDOW_MS,
                ACCOUNT_MAX_FAILURES
            ));
            limiter.record_failure_in("acct:x", now + i, ACCOUNT_WINDOW_MS);
        }
        assert!(limiter.blocked_in("acct:x", now + 20, ACCOUNT_WINDOW_MS, ACCOUNT_MAX_FAILURES));
        // 一分钟以后 IP 那种短窗口早就过期了,但账号的 15 分钟窗口还在
        assert!(limiter.blocked_in(
            "acct:x",
            now + WINDOW_MS + 10,
            ACCOUNT_WINDOW_MS,
            ACCOUNT_MAX_FAILURES
        ));
        assert!(!limiter.blocked_in(
            "acct:x",
            now + ACCOUNT_WINDOW_MS + 10,
            ACCOUNT_WINDOW_MS,
            ACCOUNT_MAX_FAILURES
        ));
    }

    #[test]
    fn the_table_does_not_grow_without_bound() {
        let limiter = LoginLimiter::new();
        let start = 1_700_000_000_000;
        // 攻击者用海量不同的用户名 / IP 各失败一次
        for i in 0..(MAX_KEYS + 10) {
            limiter.record_failure_in(&format!("acct:{i}"), start, ACCOUNT_WINDOW_MS);
        }
        // 窗口过去之后再来一次失败:过期的键被清掉
        limiter.record_failure_in(
            "acct:later",
            start + ACCOUNT_WINDOW_MS + 1,
            ACCOUNT_WINDOW_MS,
        );
        let size = limiter.failures.lock().unwrap().len();
        assert!(size < 100, "过期的键应当被清掉:{size}");
    }
}
