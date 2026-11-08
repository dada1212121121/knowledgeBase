//! 数据保留:按 `[retention]` 的期限清历史表。
//!
//! 要清的表分在两个库里:
//! - 知识库的 `meta.db`:`jobs`(只清已结束的)、`audit`(能力调用审计)、`events`(进化事件);
//! - 账号库 `system.db`:`system_audit`、`metric_samples`。
//!
//! 两边的期限都来自同一份配置,所以把它们放进一个清理器:夜间调度跑一次、`kb retention prune`
//! 手动跑一次,都是同一个实现。默认**只预览**(打印会删多少行),`--yes` 才真删。

use std::sync::Arc;

use kb_core::Result;
use kb_core::config::ConfigStore;
use kb_meta::{RetentionTable, SqliteMetaStore, SystemRetentionTable, SystemStore};
use kb_service::scheduler::RetentionHook;

/// 一天有多少毫秒(期限换算)。
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// 一次清理的账:每张表删了(或会删)多少行。
pub type PruneCounts = Vec<(String, u64)>;

/// 按配置清历史表。
pub struct RetentionSweeper {
    meta: Arc<SqliteMetaStore>,
    system: Arc<SystemStore>,
    config: Arc<ConfigStore>,
}

impl RetentionSweeper {
    /// 构造。
    pub fn new(
        meta: Arc<SqliteMetaStore>,
        system: Arc<SystemStore>,
        config: Arc<ConfigStore>,
    ) -> Self {
        Self {
            meta,
            system,
            config,
        }
    }

    /// 清一次(`dry_run` 只数不删)。
    ///
    /// 某张表期限设成 0 就是「不清理」:不查也不删,账上记 0 行,免得让人以为清过了。
    pub async fn run(&self, dry_run: bool) -> Result<PruneCounts> {
        let retention = self.config.get().retention.clone();
        let now = now_millis();
        let mut counts = Vec::new();
        for (table, days) in [
            (RetentionTable::Jobs, retention.jobs_days),
            (RetentionTable::Audit, retention.audit_days),
            (RetentionTable::Events, retention.events_days),
        ] {
            let removed = if days == 0 {
                0
            } else {
                self.meta
                    .prune_history(table, now - days as i64 * DAY_MS, dry_run)
                    .await?
            };
            counts.push((table.as_str().to_owned(), removed));
        }
        for (table, days) in [
            // 系统审计与能力调用审计同一个期限:都是「谁干了什么」的痕迹
            (SystemRetentionTable::SystemAudit, retention.audit_days),
            (
                SystemRetentionTable::MetricSamples,
                retention.metric_samples_days,
            ),
        ] {
            let removed = if days == 0 {
                0
            } else {
                self.system
                    .prune_history(table, now - days as i64 * DAY_MS, dry_run)
                    .await?
            };
            counts.push((table.as_str().to_owned(), removed));
        }
        Ok(counts)
    }
}

#[async_trait::async_trait]
impl RetentionHook for RetentionSweeper {
    async fn prune(&self, dry_run: bool) -> Result<PruneCounts> {
        self.run(dry_run).await
    }
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::{Event, JobState, MetricRow};
    use kb_core::ports::repo::EventRepo;
    use kb_service::jobs::queue::{JobQueue, NewJob};

    fn metric(at: i64) -> MetricRow {
        MetricRow {
            at,
            cpu: 0.1,
            cpu_max: 0.2,
            mem_used: 1024,
            mem_total: 2048,
            load1: 0.3,
            disk_used: 4096,
            disk_total: 8192,
            proc_cpu: 0.01,
            proc_rss: 512,
        }
    }

    /// 把一条任务的时间改成「很久以前」(接口里没有「假装一个月前」的入口,直接改库)。
    fn age_job(path: &std::path::Path, id: &str, at: i64) {
        let conn = rusqlite::Connection::open(path).expect("打开 meta.db");
        conn.execute(
            "UPDATE jobs SET created_at = ?1, finished_at = ?1 WHERE id = ?2",
            rusqlite::params![at, id],
        )
        .expect("改时间");
    }

    fn row_of(counts: &PruneCounts, table: &str) -> u64 {
        counts
            .iter()
            .find(|(name, _)| name == table)
            .map(|(_, rows)| *rows)
            .unwrap_or(0)
    }

    /// 一套临时库:知识库库 + 账号库。
    fn stores() -> (tempfile::TempDir, Arc<SqliteMetaStore>, Arc<SystemStore>) {
        let dir = tempfile::tempdir().expect("临时目录");
        let meta = Arc::new(SqliteMetaStore::open(dir.path().join("meta.db")).expect("meta.db"));
        let system = Arc::new(SystemStore::open(dir.path().join("system.db")).expect("账号库"));
        (dir, meta, system)
    }

    /// 端到端:过期行被清、没过期的留着;`dry_run` 只数不删;期限 0 表示不查不删。
    #[tokio::test]
    async fn sweeper_respects_the_configured_windows() {
        let (dir, meta, system) = stores();
        let mut config = kb_core::config::Config::default();
        config.retention.events_days = 30;
        config.retention.audit_days = 0; // 审计不清理
        config.retention.jobs_days = 30;
        let sweeper = RetentionSweeper::new(
            meta.clone(),
            system.clone(),
            Arc::new(ConfigStore::new(config)),
        );

        let now = now_millis();
        let long_ago = now - 40 * DAY_MS;
        // 事件:一条过期、一条新鲜(时间由我们自己给)
        for (id, at) in [("e_old", long_ago), ("e_new", now)] {
            EventRepo::append(
                meta.as_ref(),
                Event {
                    id: id.to_owned(),
                    kind: "manual".to_owned(),
                    project_id: None,
                    payload_json: "{}".to_owned(),
                    received_at: at,
                    processed_at: None,
                    result: None,
                },
            )
            .await
            .expect("写事件");
        }
        // 任务:一条已完成很久、一条刚完成
        let queue = JobQueue::new(meta.clone());
        for (paths, at) in [(&["a.rs"][..], long_ago), (&["b.rs"][..], now)] {
            let paths: Vec<String> = paths.iter().map(|path| (*path).to_owned()).collect();
            let job = queue
                .enqueue(NewJob::incremental_index("p1", "proj_demo", &paths))
                .await
                .expect("投递");
            queue
                .finish(&job, JobState::Done, None)
                .await
                .expect("完成");
            age_job(&dir.path().join("meta.db"), &job.id, at);
        }
        // 采样:同样一老一新
        for at in [long_ago, now] {
            system.put_metric(metric(at)).await.expect("写采样");
        }

        // 预览:只数不删,连跑两次数值不变
        let preview = sweeper.run(true).await.expect("预览");
        assert_eq!(row_of(&preview, "events"), 1, "过期事件算 1 条:{preview:?}");
        assert_eq!(row_of(&preview, "jobs"), 1, "过期任务算 1 条:{preview:?}");
        assert_eq!(row_of(&preview, "metric_samples"), 1);
        assert_eq!(
            row_of(&sweeper.run(true).await.expect("再预览"), "events"),
            1,
            "预览不该删东西"
        );

        // 真删:过期的没了,新鲜的还在
        let removed = sweeper.run(false).await.expect("真删");
        assert_eq!(row_of(&removed, "events"), 1);
        assert_eq!(row_of(&removed, "jobs"), 1);
        assert_eq!(row_of(&removed, "metric_samples"), 1);
        let after = sweeper.run(true).await.expect("复查");
        assert_eq!(row_of(&after, "events"), 0);
        assert_eq!(row_of(&after, "jobs"), 0);
        assert_eq!(row_of(&after, "metric_samples"), 0);
        // 审计期限设成 0:不查也不删
        assert_eq!(row_of(&after, "audit"), 0);
        assert_eq!(row_of(&after, "system_audit"), 0);
    }

    /// 排队/运行中的任务不是历史,不能被「期限」清掉。
    #[tokio::test]
    async fn sweeper_never_touches_unfinished_jobs() {
        let (dir, meta, system) = stores();
        let sweeper = RetentionSweeper::new(
            meta.clone(),
            system,
            Arc::new(ConfigStore::new(kb_core::config::Config::default())),
        );
        let queue = JobQueue::new(meta.clone());
        let job = queue
            .enqueue(NewJob::incremental_index("p1", "proj_demo", &[]))
            .await
            .expect("投递");
        age_job(
            &dir.path().join("meta.db"),
            &job.id,
            now_millis() - 400 * DAY_MS,
        );
        let removed = sweeper.run(false).await.expect("清理");
        assert_eq!(
            row_of(&removed, "jobs"),
            0,
            "排队中的任务不该被清:{removed:?}"
        );
    }
}
