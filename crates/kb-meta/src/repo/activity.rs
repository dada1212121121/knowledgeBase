//! 按天的活动计数(`ActivityRepo`):首页 / 系统概览的趋势图和迷你线。
//!
//! 每张表一条 `GROUP BY 天序号` 的查询,只返回 `days` 个数,不搬行。天序号 = (时间 − 第一天零点) ÷ 24 小时,
//! 起点和宽度都走绑定参数。

use async_trait::async_trait;
use kb_core::Result;
use kb_core::model::{ActivityCounts, AuditOverview, IngestBucket, IngestOverview, Millis};
use kb_core::ports::repo::ActivityRepo;
use rusqlite::{Connection, params};

use crate::SqliteMetaStore;
use crate::sql::map_sqlite_error;

const DAY_MS: i64 = 86_400_000;

/// 检索类能力(成功的调用算一次检索)。
const SEARCH_CAPABILITIES: &str = "'search_knowledge', 'search_code', 'deep_search'";

/// 跑一条「天序号, 数量[, 数量]」的查询,把结果填进对应的数组。
fn fill(
    conn: &Connection,
    sql: &str,
    start: Millis,
    end: Millis,
    targets: &mut [&mut Vec<u64>],
) -> Result<()> {
    let days = targets.first().map_or(0, |target| target.len());
    let mut stmt = conn.prepare(sql).map_err(map_sqlite_error)?;
    let mut rows = stmt
        .query(params![start, DAY_MS, end])
        .map_err(map_sqlite_error)?;
    while let Some(row) = rows.next().map_err(map_sqlite_error)? {
        let day: i64 = row.get(0).map_err(map_sqlite_error)?;
        let Some(day) = usize::try_from(day).ok().filter(|day| *day < days) else {
            continue;
        };
        for (offset, target) in targets.iter_mut().enumerate() {
            let value: i64 = row.get(offset + 1).map_err(map_sqlite_error)?;
            target[day] = value.max(0) as u64;
        }
    }
    Ok(())
}

#[async_trait]
impl ActivityRepo for SqliteMetaStore {
    async fn activity(&self, start: Millis, labels: Vec<String>) -> Result<ActivityCounts> {
        self.read(move |conn| {
            let days = labels.len();
            let end = start + DAY_MS * days as i64;
            let mut out = ActivityCounts {
                days: labels.clone(),
                notes: vec![0; days],
                edits: vec![0; days],
                imports: vec![0; days],
                imports_done: vec![0; days],
                searches: vec![0; days],
                jobs_done: vec![0; days],
                ai_tokens: vec![0; days],
            };
            fill(conn, "SELECT CAST((created_at - ?1) / ?2 AS INTEGER), COUNT(*) FROM insights WHERE created_at >= ?1 AND created_at < ?3 GROUP BY 1", start, end, &mut [&mut out.notes])?;
            fill(conn, "SELECT CAST((created_at - ?1) / ?2 AS INTEGER), COUNT(*) FROM item_versions WHERE created_at >= ?1 AND created_at < ?3 GROUP BY 1", start, end, &mut [&mut out.edits])?;
            fill(
                conn,
                "SELECT CAST((created_at - ?1) / ?2 AS INTEGER), COUNT(*), COUNT(CASE WHEN state = 'done' THEN 1 END) FROM ingest_files WHERE created_at >= ?1 AND created_at < ?3 GROUP BY 1",
                start,
                end,
                &mut [&mut out.imports, &mut out.imports_done],
            )?;
            fill(
                conn,
                &format!("SELECT CAST((at - ?1) / ?2 AS INTEGER), COUNT(*) FROM audit WHERE at >= ?1 AND at < ?3 AND ok = 1 AND capability IN ({SEARCH_CAPABILITIES}) GROUP BY 1"),
                start,
                end,
                &mut [&mut out.searches],
            )?;
            fill(conn, "SELECT CAST((finished_at - ?1) / ?2 AS INTEGER), COUNT(*) FROM jobs WHERE state = 'done' AND finished_at >= ?1 AND finished_at < ?3 GROUP BY 1", start, end, &mut [&mut out.jobs_done])?;

            // 模型 token:表里按日期字符串存,和调用方给的标签一一对上
            if let (Some(first), Some(last)) = (labels.first(), labels.last()) {
                let mut stmt = conn
                    .prepare("SELECT day, SUM(input_tokens + output_tokens) FROM llm_usage WHERE day >= ?1 AND day <= ?2 GROUP BY day")
                    .map_err(map_sqlite_error)?;
                let rows = stmt
                    .query_map(params![first, last], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
                    .map_err(map_sqlite_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(map_sqlite_error)?;
                for (day, tokens) in rows {
                    if let Some(at) = labels.iter().position(|label| *label == day) {
                        out.ai_tokens[at] = tokens.max(0) as u64;
                    }
                }
            }
            Ok(out)
        })
        .await
    }

    async fn ingest_overview(
        &self,
        start: Millis,
        step_ms: i64,
        count: usize,
        errors: usize,
    ) -> Result<IngestOverview> {
        let step = step_ms.max(1);
        self.read(move |conn| {
            let end = start + step * count as i64;
            // 各状态的文件数
            let by_state = conn
                .prepare("SELECT state, COUNT(*) FROM ingest_files GROUP BY state ORDER BY COUNT(*) DESC, state")
                .map_err(map_sqlite_error)?
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            // 按创建时间归桶
            let mut buckets = vec![IngestBucket::default(); count];
            let rows = conn
                .prepare(
                    "SELECT CAST((created_at - ?1) / ?2 AS INTEGER), COUNT(*), COUNT(CASE WHEN state = 'done' THEN 1 END), \
                            COUNT(CASE WHEN state = 'failed' THEN 1 END) \
                     FROM ingest_files WHERE created_at >= ?1 AND created_at < ?3 GROUP BY 1",
                )
                .map_err(map_sqlite_error)?
                .query_map(params![start, step, end], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)? as u64, row.get::<_, i64>(3)? as u64))
                })
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            for (at, total, done, failed) in rows {
                if let Some(bucket) = usize::try_from(at).ok().and_then(|at| buckets.get_mut(at)) {
                    *bucket = IngestBucket { total, done, failed };
                }
            }
            // 失败原因:同样的文字合并(错误文字里常带文件名,取第一行并截短,免得每个文件各算一种)
            let top_errors = conn
                .prepare(
                    "SELECT substr(COALESCE(error, '(没有写原因)'), 1, 120), COUNT(*) FROM ingest_files WHERE state = 'failed' \
                     GROUP BY 1 ORDER BY COUNT(*) DESC, 1 LIMIT ?1",
                )
                .map_err(map_sqlite_error)?
                .query_map(params![errors as i64], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64)))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(IngestOverview { by_state, start, step_ms: step, buckets, top_errors })
        })
        .await
    }

    async fn audit_overview(
        &self,
        since: Millis,
        offset_secs: i64,
        ignore: Vec<String>,
        top: usize,
    ) -> Result<AuditOverview> {
        self.read(move |conn| {
            // 要忽略的能力名走绑定参数(?4 起),不拼进 SQL
            let marks = if ignore.is_empty() { "''".to_owned() } else { vec!["?"; ignore.len()].join(", ") };
            let filter = format!("at >= ?1 AND capability NOT IN ({marks})");
            let bind = |extra: Vec<rusqlite::types::Value>| {
                let mut values: Vec<rusqlite::types::Value> = vec![since.into(), offset_secs.into()];
                values.extend(extra);
                values.extend(ignore.iter().map(|name| rusqlite::types::Value::Text(name.clone())));
                values
            };
            // 周几 × 几点:SQLite 的 %w 是 0=周日,这里转成周一在最上
            let mut heat = vec![vec![0u64; 24]; 7];
            let rows = conn
                .prepare(&format!(
                    "SELECT CAST(strftime('%w', (at / 1000) + ?2, 'unixepoch') AS INTEGER), CAST(strftime('%H', (at / 1000) + ?2, 'unixepoch') AS INTEGER), COUNT(*), \
                            COUNT(CASE WHEN ok = 0 THEN 1 END) \
                     FROM audit WHERE {filter} GROUP BY 1, 2"
                ))
                .map_err(map_sqlite_error)?
                .query_map(rusqlite::params_from_iter(bind(vec![])), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)? as u64, row.get::<_, i64>(3)? as u64)))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            let (mut total, mut failed) = (0u64, 0u64);
            for (weekday, hour, count, bad) in rows {
                let row = ((weekday + 6) % 7) as usize;
                if let Some(cell) = heat.get_mut(row).and_then(|line| line.get_mut(hour as usize)) {
                    *cell += count;
                }
                total += count;
                failed += bad;
            }
            let mut values = bind(vec![]);
            values.insert(2, (top as i64).into());
            // LIMIT 的占位符放在最后更直观,但 ?1 ?2 是显式编号的,所以 LIMIT 用 ?3,忽略名从 ?4 起
            let sql = format!(
                "SELECT capability, COUNT(*), COUNT(CASE WHEN ok = 0 THEN 1 END) FROM audit WHERE at >= ?1 AND capability NOT IN ({}) \
                 GROUP BY capability ORDER BY COUNT(*) DESC, capability LIMIT ?3",
                if ignore.is_empty() { "''".to_owned() } else { (4..4 + ignore.len()).map(|n| format!("?{n}")).collect::<Vec<_>>().join(", ") }
            );
            let top_rows = conn
                .prepare(&sql)
                .map_err(map_sqlite_error)?
                .query_map(rusqlite::params_from_iter(values), |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)? as u64)))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            Ok(AuditOverview { heat, top: top_rows, total, failed })
        })
        .await
    }

    async fn file_status_counts(&self) -> Result<Vec<(String, String, u64)>> {
        self.read(|conn| {
            conn.prepare("SELECT collection, status, COUNT(*) FROM files GROUP BY collection, status ORDER BY collection, COUNT(*) DESC")
                .map_err(map_sqlite_error)?
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)? as u64)))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)
        })
        .await
    }
}
