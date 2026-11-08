//! 外部资料定期刷新。
//!
//! 已登记的网页 / Git / 本地目录数据源可以设 `refresh_minutes`;到点后重新同步一次。
//! 同步本身复用 [`SourceService::sync`](crate::sources::SourceService::sync):
//! **只有内容变化的页面 / 文件会进新批次并重新嵌入**,没变的不动(索引管线按文件哈希跳过)。
//!
//! 这里只做“谁到点了”的判断与汇总,不重复实现抓取。

use kb_core::Result;
use kb_core::model::{Millis, Source};
use kb_core::ports::repo::{MetaStore, SourceRepo};
use serde::Serialize;

/// 一次刷新的结果。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct RefreshReport {
    /// 到点并尝试同步的数据源数。
    pub attempted: u64,
    /// 成功的数据源数。
    pub refreshed: u64,
    /// 重新入队的文件数。
    pub queued: u64,
    /// 失败的数据源(名字, 原因)。
    pub failed: Vec<(String, String)>,
}

/// 哪些数据源到点了(`refresh_minutes` 为空或 0 表示不自动刷新)。
pub async fn due_sources(meta: &dyn MetaStore, now: Millis) -> Result<Vec<Source>> {
    let mut due = Vec::new();
    for source in SourceRepo::list(meta).await? {
        let Some(minutes) = source.refresh_minutes.filter(|value| *value > 0) else {
            continue;
        };
        let interval = minutes as i64 * 60_000;
        let last = source.last_synced_at.unwrap_or(source.created_at);
        if now - last >= interval {
            due.push(source);
        }
    }
    due.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(due)
}

/// 判断单个数据源是否到点(给 UI / 测试用)。
pub fn is_due(source: &Source, now: Millis) -> bool {
    let Some(minutes) = source.refresh_minutes.filter(|value| *value > 0) else {
        return false;
    };
    let last = source.last_synced_at.unwrap_or(source.created_at);
    now - last >= minutes as i64 * 60_000
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::SourceKind;

    fn source(refresh_minutes: Option<u64>, last_synced_at: Option<Millis>) -> Source {
        Source {
            id: "s1".to_owned(),
            kind: SourceKind::Web,
            name: "docs".to_owned(),
            uri: "https://example.com".to_owned(),
            collection: "_global".to_owned(),
            tags: Vec::new(),
            include: Vec::new(),
            exclude: Vec::new(),
            depth: 2,
            allow_hosts: Vec::new(),
            refresh_minutes,
            status: kb_core::model::SourceStatus::Idle,
            last_synced_at,
            last_error: None,
            files: 0,
            created_at: 1_000,
            ai_extract: false,
            extract_prompt: String::new(),
            ai_status: None,
        }
    }

    #[test]
    fn sources_without_interval_are_never_due() {
        assert!(!is_due(&source(None, None), 10_000_000));
        assert!(!is_due(&source(Some(0), None), 10_000_000));
    }

    #[test]
    fn due_follows_the_interval() {
        let now = 1_000_000;
        // 10 分钟间隔,刚同步过 → 不到点
        assert!(!is_due(&source(Some(10), Some(now - 60_000)), now));
        // 同一份数据源,过了 11 分钟 → 到点
        assert!(is_due(&source(Some(10), Some(now - 11 * 60_000)), now));
        // 从没同步过:用创建时间算
        assert!(is_due(&source(Some(10), None), now));
    }
}
