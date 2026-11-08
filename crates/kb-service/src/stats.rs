//! 仪表盘概览(`stats_overview`)。
//!
//! 一次调用把 Dashboard 需要的数字都取齐:各 collection 行数与最近索引时间、任务队列、
//! 待审草稿、模型 / 重排状态、最近的进化事件。所有数据都来自既有端口,不做额外缓存。

use std::sync::Arc;

use kb_core::Result;
use kb_core::filter::Filter;
use kb_core::model::{
    CollectionKind, DraftState, EmbedderState, Event, ItemStatus, JobState, Millis, Project,
    RecordKind,
};
use kb_core::ports::repo::{
    CollectionRepo, DraftRepo, EventRepo, InsightRepo, JobRepo, MetaStore, ProjectRepo,
};
use kb_core::ports::{Embedder, Reranker, VectorStore};
use serde::Serialize;

/// 单个 collection 的概览。
#[derive(Clone, Debug, Serialize)]
pub struct CollectionStats {
    /// collection 名。
    pub name: String,
    /// 种类。
    pub kind: CollectionKind,
    /// 所属项目 id。
    pub project_id: Option<String>,
    /// 向量库行数(块数)。
    pub rows: u64,
    /// 可浏览的条目数(文件 + 笔记),界面上的“多少条”用它。
    pub items: u64,
    /// 当前 embedder。
    pub embedder_id: String,
    /// 向量维度。
    pub dim: usize,
    /// 最近索引时间(项目 collection 才有)。
    pub last_indexed_at: Option<Millis>,
}

/// 任务队列计数。
#[derive(Clone, Debug, Default, Serialize)]
pub struct JobCounts {
    /// 排队中。
    pub queued: u64,
    /// 执行中。
    pub running: u64,
    /// 暂停。
    pub paused: u64,
    /// 已完成。
    pub done: u64,
    /// 失败。
    pub failed: u64,
    /// 已取消。
    pub canceled: u64,
}

/// 嵌入器状态。
#[derive(Clone, Debug, Serialize)]
pub struct EmbedderStats {
    /// 模型标识。
    pub id: String,
    /// 维度。
    pub dim: usize,
    /// `unloaded` / `loading` / `ready` / `failed`。
    pub state: String,
    /// 失败原因(仅 `failed` 时有)。
    pub error: Option<String>,
}

/// 重排器状态。
#[derive(Clone, Debug, Serialize)]
pub struct RerankerStats {
    /// `auto` / `off` / `on`。
    pub mode: String,
    /// 当前是否可用。
    pub available: bool,
}

/// 总数。
#[derive(Clone, Debug, Default, Serialize)]
pub struct Totals {
    /// 全部记录行数(块数)。
    pub rows: u64,
    /// 全部可浏览条目数(各集合的文件 + 笔记之和)。
    pub items: u64,
    /// insight 行数。
    pub insights: u64,
    /// 项目数。
    pub projects: u64,
}

/// 仪表盘概览。
#[derive(Clone, Debug, Serialize)]
pub struct Overview {
    /// 各 collection。
    pub collections: Vec<CollectionStats>,
    /// 总数。
    pub totals: Totals,
    /// 任务队列。
    pub jobs: JobCounts,
    /// 待审草稿数(AI 起才有内容,现在恒为 0)。
    pub drafts_pending: u64,
    /// 嵌入器。
    pub embedder: EmbedderStats,
    /// 重排器。
    pub reranker: RerankerStats,
    /// 最近的进化事件(新的在前)。
    pub recent_events: Vec<Event>,
    /// 近 7 天每个 collection 新增的 insight 条数(Dashboard 的进化活跃度)。
    pub activity_7d: Vec<DayActivity>,
}

/// 某一天、某个 collection 的新增 insight 条数。
#[derive(Clone, Debug, Serialize)]
pub struct DayActivity {
    /// `YYYY-MM-DD`(站点时区)。
    pub day: String,
    /// collection 名。
    pub collection: String,
    /// 新增 insight 条数。
    pub insights: u64,
}

/// 概览服务。
pub struct StatsService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    reranker: Arc<dyn Reranker>,
    rerank_mode: String,
}

impl StatsService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
        reranker: Arc<dyn Reranker>,
        rerank_mode: impl Into<String>,
    ) -> Self {
        Self {
            meta,
            store,
            embedder,
            reranker,
            rerank_mode: rerank_mode.into(),
        }
    }

    /// 取概览;`recent_events` 最多 10 条。
    pub async fn overview(&self) -> Result<Overview> {
        let projects = ProjectRepo::list(self.meta.as_ref()).await?;
        let mut collections = Vec::new();
        let mut rows_total = 0u64;
        // insight 计数走过滤表达式(不手写 SQL):只按 kind 过滤,状态不限
        let insight_filter = Filter {
            kinds: vec![RecordKind::Insight],
            statuses: ItemStatus::ALL.to_vec(),
            ..Filter::default()
        }
        .to_sql()?;
        let mut insights = 0u64;
        let mut items_total = 0u64;
        // 一次遍历同时数总行数和 insight 数(以前是遍历两遍 collection)
        for collection in CollectionRepo::list(self.meta.as_ref()).await? {
            let rows = self.store.count(&collection.active_table, None).await?;
            insights += self
                .store
                .count(&collection.active_table, insight_filter.as_deref())
                .await?;
            rows_total += rows;
            let items =
                crate::collections::browsable_items(self.store.as_ref(), &collection.active_table)
                    .await?;
            items_total += items;
            let last_indexed_at = collection
                .project_id
                .as_ref()
                .and_then(|id| projects.iter().find(|project| &project.id == id))
                .and_then(|project| project.last_indexed_at);
            collections.push(CollectionStats {
                name: collection.name,
                kind: collection.kind,
                project_id: collection.project_id,
                rows,
                items,
                embedder_id: collection.embedder_id,
                dim: collection.dim,
                last_indexed_at,
            });
        }
        // 任务数在 SQL 里分组计数:任务表上万条、单条 payload 可达几 MB,不能整表读出来再数
        let mut jobs = JobCounts::default();
        for (state, count) in JobRepo::count_by_state(self.meta.as_ref()).await? {
            match state {
                JobState::Queued => jobs.queued = count,
                JobState::Running => jobs.running = count,
                JobState::Paused => jobs.paused = count,
                JobState::Done => jobs.done = count,
                JobState::Failed => jobs.failed = count,
                JobState::Canceled => jobs.canceled = count,
            }
        }
        let drafts_pending =
            DraftRepo::count(self.meta.as_ref(), Some(DraftState::Pending)).await?;
        let state = self.embedder.state();
        let (state_name, error) = match &state {
            EmbedderState::Unloaded => ("unloaded", None),
            EmbedderState::Loading => ("loading", None),
            EmbedderState::Ready => ("ready", None),
            EmbedderState::Failed(message) => ("failed", Some(message.clone())),
        };
        Ok(Overview {
            collections,
            totals: Totals {
                rows: rows_total,
                items: items_total,
                insights,
                projects: projects.len() as u64,
            },
            jobs,
            drafts_pending,
            embedder: EmbedderStats {
                id: self.embedder.id().to_owned(),
                dim: self.embedder.dim(),
                state: state_name.to_owned(),
                error,
            },
            reranker: RerankerStats {
                mode: self.rerank_mode.clone(),
                available: self.reranker.available(),
            },
            recent_events: EventRepo::recent(self.meta.as_ref(), 10).await?,
            activity_7d: self.activity_7d(&projects).await?,
        })
    }

    /// 近 7 天每个 collection 新增的 insight 条数(按站点时区的自然日分桶)。
    ///
    /// 数据源是 `insights` 表(权威数据),不是 LanceDB 副本:副本可能还没嵌入完。
    async fn activity_7d(&self, projects: &[Project]) -> Result<Vec<DayActivity>> {
        let now = now_millis();
        let day_ms: i64 = 24 * 60 * 60 * 1000;
        let today_start = kb_core::timezone::day_start(now);
        let since = today_start - 6 * day_ms;
        let mut buckets: std::collections::BTreeMap<(String, String), u64> =
            std::collections::BTreeMap::new();
        // 只取 (collection, created_at) 两列:以前每个 collection 读 1 万条完整 insight(含正文)再丢掉
        for (collection, created_at) in
            InsightRepo::created_since(self.meta.as_ref(), since).await?
        {
            let day = kb_core::timezone::day_key(created_at);
            *buckets.entry((day, collection)).or_default() += 1;
        }
        let _ = projects;
        Ok(buckets
            .into_iter()
            .map(|((day, collection), insights)| DayActivity {
                day,
                collection,
                insights,
            })
            .collect())
    }

    /// 最近事件(给 `stats_overview` 之外的小接口复用)。
    pub async fn recent_events(&self, limit: u32) -> Result<Vec<Event>> {
        EventRepo::recent(self.meta.as_ref(), limit).await
    }

    /// 分页列出任务(给 Dashboard 的队列卡片用)。
    pub async fn jobs(&self) -> Result<Vec<kb_core::model::Job>> {
        JobRepo::list_summaries(self.meta.as_ref(), None).await
    }
}

/// 最近 `days` 天的窗口(站点时区):返回第一天零点的毫秒数和每天的 `YYYY-MM-DD`,最后一天是 `now_ms` 所在的那天。
///
/// 趋势图按「自然日」分桶,零点以 `[site] timezone` 为准(默认上海),和 `stats_overview` 的 7 日活动同一口径。
pub fn day_window(now_ms: Millis, days: u32) -> (Millis, Vec<String>) {
    let days = days.max(1);
    let today = kb_core::timezone::day_key(now_ms);
    let labels: Vec<String> = (0..days)
        .rev()
        .map(|back| kb_core::timezone::shift_day(&today, -i64::from(back)))
        .collect();
    let start = labels
        .first()
        .and_then(|day| kb_core::timezone::day_start_for(day))
        .unwrap_or(now_ms - i64::from(days) * 86_400_000);
    (start, labels)
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// **站点时区**今天零点的毫秒值(统计「今天新增」用)。
///
/// 已知限制:「今天」按**入队行**的 `created_at` 计,重复同步会重复计数。
pub fn today_start_millis() -> kb_core::model::Millis {
    kb_core::timezone::day_start(now_millis())
}

#[cfg(test)]
mod day_window_tests {
    use super::day_window;
    use chrono::DateTime;

    fn at(text: &str) -> i64 {
        DateTime::parse_from_rfc3339(text)
            .unwrap()
            .timestamp_millis()
    }

    #[test]
    fn the_window_ends_today_has_one_label_per_day_and_starts_at_site_midnight() {
        let now = at("2026-11-01T15:30:00+08:00");
        let (start, labels) = day_window(now, 3);
        assert_eq!(labels, ["2026-10-30", "2026-10-31", "2026-11-01"]);
        assert_eq!(start, at("2026-10-30T00:00:00+08:00"));
        assert!(now - start < 3 * 86_400_000 + 3_600_000 && now > start);
    }

    #[test]
    fn labels_cross_month_and_year_boundaries_and_zero_days_means_one() {
        let now = at("2027-01-02T01:00:00+08:00");
        assert_eq!(
            day_window(now, 4).1,
            ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]
        );
        assert_eq!(day_window(now, 0).1, ["2027-01-02"]);
    }

    #[test]
    fn a_utc_instant_before_midnight_shanghai_belongs_to_the_previous_day() {
        // 2026-10-29 02:00 上海 = 2026-10-28 18:00 UTC:仍算 10-29,而不是 UTC 的 10-28
        let now = at("2026-10-29T02:00:00+08:00");
        assert_eq!(day_window(now, 1).1, ["2026-10-29"]);
        assert_eq!(
            day_window(now, 1).0,
            at("2026-10-29T00:00:00+08:00"),
            "零点按北京时间"
        );
    }
}
