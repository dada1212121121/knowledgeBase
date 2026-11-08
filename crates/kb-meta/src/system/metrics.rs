//! 资源采样的存取(`metric_samples`,卡 D):每分钟一行,保留 30 天。
//!
//! 采样本身在 `kb-service::metrics`(读 /proc、攒环形缓冲);这里只管落库和按范围取回。
//! 取回时按范围降采样:同一个时间桶里的行取平均(CPU 另取最大值),这样 30 天的图也只有几百个点。

use kb_core::Result;
use rusqlite::params;

use super::SystemStore;
use crate::sql::map_sqlite_error;

pub use kb_core::model::MetricRow;

impl SystemStore {
    /// 写一行(同一分钟已有就覆盖)。
    pub async fn put_metric(&self, row: MetricRow) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT OR REPLACE INTO metric_samples \
                 (at, cpu, cpu_max, mem_used, mem_total, load1, disk_used, disk_total, proc_cpu, proc_rss) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    row.at,
                    row.cpu,
                    row.cpu_max,
                    row.mem_used as i64,
                    row.mem_total as i64,
                    row.load1,
                    row.disk_used as i64,
                    row.disk_total as i64,
                    row.proc_cpu,
                    row.proc_rss as i64
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    /// 删掉 `before` 之前的行,返回删了几行。
    pub async fn prune_metrics(&self, before: i64) -> Result<u64> {
        self.write(move |conn| {
            let removed = conn
                .execute("DELETE FROM metric_samples WHERE at < ?1", params![before])
                .map_err(map_sqlite_error)?;
            Ok(removed as u64)
        })
        .await
    }

    /// `[since, until]` 之间的读数,按 `bucket_ms` 分桶取平均(`bucket_ms` 为 60 000 时就是原始行)。
    /// 返回按时间升序;空桶不出现(采样器没跑的时段就是断开的)。
    pub async fn metric_series(
        &self,
        since: i64,
        until: i64,
        bucket_ms: i64,
    ) -> Result<Vec<MetricRow>> {
        let bucket = bucket_ms.max(60_000);
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT (at / ?3) * ?3, AVG(cpu), MAX(cpu_max), AVG(mem_used), MAX(mem_total), AVG(load1), \
                            AVG(disk_used), MAX(disk_total), AVG(proc_cpu), AVG(proc_rss) \
                     FROM metric_samples WHERE at >= ?1 AND at <= ?2 GROUP BY at / ?3 ORDER BY 1",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![since, until, bucket], |row| {
                    Ok(MetricRow {
                        at: row.get(0)?,
                        cpu: row.get(1)?,
                        cpu_max: row.get(2)?,
                        mem_used: row.get::<_, f64>(3)?.round() as u64,
                        mem_total: row.get::<_, i64>(4)? as u64,
                        load1: row.get(5)?,
                        disk_used: row.get::<_, f64>(6)?.round() as u64,
                        disk_total: row.get::<_, i64>(7)? as u64,
                        proc_cpu: row.get(8)?,
                        proc_rss: row.get::<_, f64>(9)?.round() as u64,
                    })
                })
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(rows)
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(at: i64, cpu: f64, mem_used: u64) -> MetricRow {
        MetricRow {
            at,
            cpu,
            cpu_max: cpu,
            mem_used,
            mem_total: 64 << 30,
            load1: 1.5,
            disk_used: 100 << 30,
            disk_total: 500 << 30,
            proc_cpu: 0.02,
            proc_rss: 2 << 30,
        }
    }

    async fn store() -> (tempfile::TempDir, SystemStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SystemStore::open(dir.path().join("system.db")).unwrap();
        (dir, store)
    }

    #[tokio::test]
    async fn rows_round_trip_and_the_same_minute_is_overwritten() {
        let (_dir, store) = store().await;
        store.put_metric(row(60_000, 0.25, 10 << 30)).await.unwrap();
        store.put_metric(row(60_000, 0.50, 11 << 30)).await.unwrap();
        store
            .put_metric(row(120_000, 0.75, 12 << 30))
            .await
            .unwrap();
        let got = store.metric_series(0, 10 * 60_000, 60_000).await.unwrap();
        assert_eq!(got.len(), 2, "同一分钟只有一行");
        assert_eq!(got[0], row(60_000, 0.50, 11 << 30));
        assert_eq!(got[1].at, 120_000);
    }

    #[tokio::test]
    async fn buckets_average_the_rows_keep_the_cpu_peak_and_skip_empty_ones() {
        let (_dir, store) = store().await;
        // 10 分钟一个桶:前 3 行落在第一个桶,中间空两个桶,最后一行在第四个桶
        for (at, cpu) in [(0, 0.2), (60_000, 0.4), (120_000, 0.9)] {
            let mut r = row(at, cpu, 8 << 30);
            r.cpu_max = cpu + 0.05;
            store.put_metric(r).await.unwrap();
        }
        store
            .put_metric(row(35 * 60_000, 0.1, 9 << 30))
            .await
            .unwrap();
        let got = store
            .metric_series(0, 60 * 60_000, 10 * 60_000)
            .await
            .unwrap();
        assert_eq!(got.len(), 2, "没有数据的桶不出现");
        assert_eq!(got[0].at, 0);
        assert!((got[0].cpu - 0.5).abs() < 1e-9, "平均值:{}", got[0].cpu);
        assert!(
            (got[0].cpu_max - 0.95).abs() < 1e-9,
            "最大值取各行的最大:{}",
            got[0].cpu_max
        );
        assert_eq!(got[1].at, 30 * 60_000, "桶的起点对齐到桶宽");
    }

    #[tokio::test]
    async fn the_range_is_inclusive_and_bucket_never_goes_below_a_minute() {
        let (_dir, store) = store().await;
        for minute in 0..5 {
            store
                .put_metric(row(minute * 60_000, 0.1, 1 << 30))
                .await
                .unwrap();
        }
        let got = store.metric_series(60_000, 3 * 60_000, 1).await.unwrap();
        assert_eq!(
            got.iter().map(|r| r.at).collect::<Vec<_>>(),
            vec![60_000, 120_000, 180_000]
        );
    }

    #[tokio::test]
    async fn pruning_removes_only_what_is_older() {
        let (_dir, store) = store().await;
        for minute in 0..4 {
            store
                .put_metric(row(minute * 60_000, 0.1, 1 << 30))
                .await
                .unwrap();
        }
        assert_eq!(store.prune_metrics(2 * 60_000).await.unwrap(), 2);
        let left = store.metric_series(0, i64::MAX / 2, 60_000).await.unwrap();
        assert_eq!(
            left.iter().map(|r| r.at).collect::<Vec<_>>(),
            vec![120_000, 180_000]
        );
    }
}
