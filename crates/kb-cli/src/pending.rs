//! 待补向量队列的观测汇总。
//!
//! `kb jobs`、Web 任务页和 `kb doctor --json` 都要回答同样三个问题:
//! 还有多少块没补向量、涉及多少文件、按当前速率还要多久。数字只从两个地方来:
//!
//! - `pending_embeds` 表的 `COUNT / COUNT(DISTINCT path) / MIN(enqueued_at)`;
//! - 正在跑（或刚跑完）的 `index` 任务的 `rate`（块/秒,指数滑动平均）。
//!
//! 不在这里额外扫 Lance:队列本身是「待补」的真源,补完才会删行。

use std::time::{SystemTime, UNIX_EPOCH};

use kb_core::model::{Collection, JobState, Millis, PendingStats};
use kb_core::ports::repo::{ChunkRepo, CollectionRepo, JobRepo, MetaStore};
use kb_core::{KbError, Result};
use serde::Serialize;

/// 单个 collection 的待补队列。
#[derive(Clone, Debug, Serialize)]
pub struct PendingCollection {
    /// collection 名。
    pub collection: String,
    /// 队列块数。
    pub chunks: u64,
    /// 涉及文件数。
    pub files: u64,
    /// 最早入队时间(毫秒)。
    pub oldest_enqueued_at: Option<Millis>,
}

/// 所有 collection 的待补队列汇总。
#[derive(Clone, Debug, Serialize)]
pub struct PendingOverview {
    /// 总块数。
    pub chunks: u64,
    /// 总文件数(按 collection + path 去重后的近似值:同一路径属于两个 collection 会算两次,
    /// 这符合“每个 collection 各自补向量”的实际工作量)。
    pub files: u64,
    /// 最早入队时间(毫秒)。
    pub oldest_enqueued_at: Option<Millis>,
    /// 最老一块已经等了多久(秒)。
    pub oldest_age_secs: Option<u64>,
    /// 当前嵌入速率(块/秒);没有运行中的索引任务时为 `None`。
    pub rate_per_sec: Option<f64>,
    /// 按当前速率还要多久补完(秒);没有速率时为 `None`。
    pub eta_secs: Option<u64>,
    /// 每个 collection 的明细(只列队列非空的;全部为空时是空数组)。
    pub collections: Vec<PendingCollection>,
}

/// 读出所有 collection 的待补队列,并接上当前运行任务的速率 / ETA。
///
/// `only` 给定时只统计这一个 collection(不存在直接 `not_found`,避免把拼错的名字
/// 显示成“队列是空的”)。速率只取 `kind = "index"` 的运行中任务:其它任务
/// (迁移 / 提取)的速率与补向量无关。
pub async fn overview(meta: &dyn MetaStore, only: Option<&str>) -> Result<PendingOverview> {
    let names = match only {
        Some(name) => {
            let collection = CollectionRepo::get(meta, name)
                .await?
                .ok_or_else(|| KbError::NotFound(format!("collection {name}")))?;
            vec![collection.name]
        }
        None => CollectionRepo::list(meta)
            .await?
            .into_iter()
            .map(|collection: Collection| collection.name)
            .collect(),
    };
    let rate = running_index_rate(meta).await?;
    overview_for(meta, names, rate).await
}

/// 按给定 collection 名单汇总;速率由调用方给(测试可以固定)。
pub async fn overview_for(
    meta: &dyn MetaStore,
    names: Vec<String>,
    rate_per_sec: Option<f64>,
) -> Result<PendingOverview> {
    let mut collections = Vec::new();
    for name in names {
        let stats: PendingStats = ChunkRepo::pending_stats(meta, &name).await?;
        if stats.chunks == 0 {
            continue;
        }
        collections.push(PendingCollection {
            collection: name,
            chunks: stats.chunks,
            files: stats.files,
            oldest_enqueued_at: stats.oldest_enqueued_at,
        });
    }
    let chunks = collections.iter().map(|entry| entry.chunks).sum();
    let files = collections.iter().map(|entry| entry.files).sum();
    let oldest = collections
        .iter()
        .filter_map(|entry| entry.oldest_enqueued_at)
        .min();
    let now = now_millis();
    let oldest_age_secs = oldest.map(|at| now.saturating_sub(at).max(0) as u64 / 1000);
    let rate_per_sec = rate_per_sec.filter(|rate| *rate > 0.0);
    let eta_secs = rate_per_sec.map(|rate| (chunks as f64 / rate).ceil() as u64);
    Ok(PendingOverview {
        chunks,
        files,
        oldest_enqueued_at: oldest,
        oldest_age_secs,
        rate_per_sec,
        eta_secs,
        collections,
    })
}

/// 正在跑的索引任务速率之和(块/秒)。
async fn running_index_rate(meta: &dyn MetaStore) -> Result<Option<f64>> {
    let running = JobRepo::list_summaries(meta, Some(JobState::Running)).await?;
    let rate: f64 = running
        .iter()
        .filter(|job| job.kind == "index")
        .filter_map(|job| job.rate)
        .filter(|rate| *rate > 0.0)
        .sum();
    Ok((rate > 0.0).then_some(rate))
}

/// 当前毫秒时间戳。
fn now_millis() -> Millis {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as Millis)
        .unwrap_or(0)
}

/// 人读的「还要多久」;没有运行中的索引任务时说明原因,不要只写「速率未知」。
pub fn eta_text(overview: &PendingOverview) -> String {
    match overview.eta_secs {
        Some(secs) => format!("预计 {}", format_duration(secs)),
        None => "补完时间未知(没有运行中的索引任务)".to_owned(),
    }
}

/// 秒数转「1 分 05 秒」/「2 小时 03 分」。
pub fn format_duration(secs: u64) -> String {
    if secs < 60 {
        format!("{secs} 秒")
    } else if secs < 3600 {
        format!("{} 分 {:02} 秒", secs / 60, secs % 60)
    } else {
        format!("{} 小时 {:02} 分", secs / 3600, secs % 3600 / 60)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::{Collection, CollectionKind, ContextMode};
    use kb_testkit::TestEnv;

    fn collection(name: &str) -> Collection {
        Collection {
            name: name.to_owned(),
            kind: CollectionKind::Project,
            project_id: None,
            embedder_id: "fake".to_owned(),
            dim: 8,
            active_table: format!("{name}__fake__v1"),
            table_version: 1,
            migrating_to: None,
            migration_started_at: None,
            retired_tables: Vec::new(),
            context_mode: ContextMode::Header,
            created_at: 1,
        }
    }

    /// 指定 collection 时只统计它,并校验名字确实存在。
    #[tokio::test]
    async fn overview_only_counts_the_requested_collection() {
        let env = TestEnv::new().await;
        let meta = env.meta.as_ref();
        CollectionRepo::create(meta, collection("proj_a"))
            .await
            .expect("a");
        CollectionRepo::create(meta, collection("proj_b"))
            .await
            .expect("b");
        ChunkRepo::enqueue_pending(
            meta,
            "proj_a",
            &[("a1".to_owned(), "docs/a.md".to_owned())],
            1_700_000_000_000,
        )
        .await
        .expect("a 队列");
        ChunkRepo::enqueue_pending(
            meta,
            "proj_b",
            &[
                ("b1".to_owned(), "docs/b.md".to_owned()),
                ("b2".to_owned(), "docs/b.md".to_owned()),
            ],
            1_700_000_001_000,
        )
        .await
        .expect("b 队列");

        let only = overview(meta, Some("proj_a")).await.expect("只查 a");
        assert_eq!(only.chunks, 1);
        assert_eq!(only.collections.len(), 1);
        assert_eq!(only.collections[0].collection, "proj_a");

        let all = overview(meta, None).await.expect("全部");
        assert_eq!(all.chunks, 3);
        assert_eq!(all.files, 2);
        assert_eq!(all.collections.len(), 2);

        let missing = overview(meta, Some("proj_missing")).await;
        assert!(
            matches!(missing, Err(KbError::NotFound(_))),
            "拼错名字不能显示成空队列"
        );
    }

    #[test]
    fn durations_are_readable_at_every_scale() {
        assert_eq!(format_duration(0), "0 秒");
        assert_eq!(format_duration(59), "59 秒");
        assert_eq!(format_duration(65), "1 分 05 秒");
        assert_eq!(format_duration(3720), "1 小时 02 分");
    }
}
