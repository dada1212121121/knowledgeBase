//! `jobs` 表:任务队列。

use async_trait::async_trait;
use kb_core::model::{
    FileChange, JOB_DURATION_EDGES_MS, Job, JobBucket, JobFile, JobFilter, JobSeries, JobState,
    JobStats, Millis, Page, job_detail_hint,
};
use kb_core::ports::repo::JobRepo;
use kb_core::timezone::now_millis;
use kb_core::{KbError, Result};
use rusqlite::types::Value as SqlValue;
use rusqlite::{OptionalExtension, params, params_from_iter};

use crate::SqliteMetaStore;
use crate::sql::{map_sqlite_error, parse_job_state};

/// 完整查询的列。最后 6 列是摘要查询才用到的标量,这里固定给 `NULL`,让两边的列数一致,
/// 可以共用 `raw_from_row`(完整任务的详情由调用方从 payload 里解,见 `job_summary`)。
const SELECT_COLUMNS: &str = "id, kind, collection, priority, state, payload_json, checkpoint_json, \
     progress_done, progress_total, rate, error, created_at, started_at, finished_at, \
     NULL AS paths_total, NULL AS first_path, NULL AS payload_mode, NULL AS insight_id, \
     NULL AS batch_id, NULL AS single_path";

/// 摘要列:`payload_json` / `checkpoint_json` 用常量占位,SQLite 不会去读那两列的大对象,
/// 同时列顺序与 [`SELECT_COLUMNS`] 一致,可以复用 `raw_from_row`。
///
/// 列表还要显示一句话详情(前端「详情」列、「N 个文件」入口),所以额外取 6 个标量:
/// 文件个数 / 第一个文件 / mode / insight_id / batch_id / path。用 json1 在 SQLite 里取,
/// 只有几字节过桥,比把整份 payload(单条最大 3.4 MB)搬到 Rust 再解析快三个数量级。
/// 所有 json 函数都套在 `json_valid` 里面:老库或手工改过的行可能是坏 JSON,不能让整页报错。
const SUMMARY_COLUMNS: &str = "id, kind, collection, priority, state, '' AS payload_json, \
     NULL AS checkpoint_json, progress_done, progress_total, rate, error, created_at, started_at, \
     finished_at, \
     CASE WHEN json_valid(payload_json) THEN CASE WHEN json_type(payload_json, '$.paths') = 'array' \
         THEN json_array_length(payload_json, '$.paths') END END AS paths_total, \
     CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.paths[0]') END AS first_path, \
     CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.mode') END AS payload_mode, \
     CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.insight_id') END AS insight_id, \
     CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.batch_id') END AS batch_id, \
     CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.path') END AS single_path";

struct RawJob {
    id: String,
    kind: String,
    collection: Option<String>,
    priority: i64,
    state: String,
    payload_json: String,
    checkpoint_json: Option<String>,
    progress_done: i64,
    progress_total: Option<i64>,
    rate: Option<f64>,
    error: Option<String>,
    created_at: i64,
    started_at: Option<i64>,
    finished_at: Option<i64>,
    /// 以下六项只在摘要查询里有值(完整查询走 `SELECT_COLUMNS`,这里都是 `None`)。
    paths_total: Option<i64>,
    first_path: Option<String>,
    payload_mode: Option<String>,
    insight_id: Option<String>,
    batch_id: Option<String>,
    single_path: Option<String>,
}

fn raw_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<RawJob> {
    Ok(RawJob {
        id: row.get(0)?,
        kind: row.get(1)?,
        collection: row.get(2)?,
        priority: row.get(3)?,
        state: row.get(4)?,
        payload_json: row.get(5)?,
        checkpoint_json: row.get(6)?,
        progress_done: row.get(7)?,
        progress_total: row.get(8)?,
        rate: row.get(9)?,
        error: row.get(10)?,
        created_at: row.get(11)?,
        started_at: row.get(12)?,
        finished_at: row.get(13)?,
        paths_total: row.get(14)?,
        first_path: row.get(15)?,
        payload_mode: row.get(16)?,
        insight_id: row.get(17)?,
        batch_id: row.get(18)?,
        single_path: row.get(19)?,
    })
}

impl RawJob {
    fn into_job(self) -> Result<Job> {
        Ok(Job {
            state: parse_job_state(&self.state)?,
            id: self.id,
            kind: self.kind,
            collection: self.collection,
            priority: i32::try_from(self.priority)
                .map_err(|_| KbError::Internal(format!("jobs.priority 非法: {}", self.priority)))?,
            payload_json: self.payload_json,
            checkpoint_json: self.checkpoint_json,
            detail: job_detail_hint(
                self.paths_total.map(|value| value.max(0) as usize),
                self.first_path.as_deref(),
                self.payload_mode.as_deref(),
                self.insight_id.as_deref(),
                self.batch_id.as_deref(),
                self.single_path.as_deref(),
            ),
            progress_done: self.progress_done as u64,
            progress_total: self.progress_total.map(|value| value as u64),
            rate: self.rate,
            error: self.error,
            created_at: self.created_at,
            started_at: self.started_at,
            finished_at: self.finished_at,
        })
    }
}

const JOB_STATES: [JobState; 6] = [
    JobState::Queued,
    JobState::Running,
    JobState::Paused,
    JobState::Done,
    JobState::Failed,
    JobState::Canceled,
];

fn query_jobs(
    conn: &rusqlite::Connection,
    columns: &str,
    state: Option<JobState>,
) -> Result<Vec<Job>> {
    let sql = match state {
        Some(_) => format!(
            "SELECT {columns} FROM jobs WHERE state = ?1 ORDER BY priority DESC, created_at"
        ),
        None => format!("SELECT {columns} FROM jobs ORDER BY priority DESC, created_at"),
    };
    let mut stmt = conn.prepare(&sql).map_err(map_sqlite_error)?;
    let rows = match state {
        Some(state) => stmt
            .query_map(params![state.as_str()], raw_from_row)
            .map_err(map_sqlite_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(map_sqlite_error)?,
        None => stmt
            .query_map([], raw_from_row)
            .map_err(map_sqlite_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(map_sqlite_error)?,
    };
    rows.into_iter().map(RawJob::into_job).collect()
}

/// 筛选条件 → `WHERE` 子句与绑定值。
///
/// SQL 里只出现列名、固定的比较符和 `?` 占位符;状态、类型、collection 的值一律走绑定参数,
/// 不把调用方传来的字符串拼进 SQL。`extra` 是调用方写死的附加条件(不含外部输入),
/// 它们的 `?` 对应的值由调用方在返回的绑定值之后追加。
fn filter_clause(filter: &JobFilter, extra: &[&str]) -> (String, Vec<SqlValue>) {
    let mut conds: Vec<String> = Vec::new();
    let mut values: Vec<SqlValue> = Vec::new();
    let mut list = |column: &str, op: &str, items: Vec<String>| {
        if items.is_empty() {
            return;
        }
        let marks = vec!["?"; items.len()].join(", ");
        conds.push(format!("{column} {op} ({marks})"));
        values.extend(items.into_iter().map(SqlValue::Text));
    };
    list(
        "state",
        "IN",
        filter
            .states
            .iter()
            .map(|state| state.as_str().to_owned())
            .collect(),
    );
    list("kind", "IN", filter.kinds.clone());
    list("kind", "NOT IN", filter.exclude_kinds.clone());
    list("collection", "IN", filter.collections.clone());
    conds.extend(extra.iter().map(|cond| (*cond).to_owned()));
    if conds.is_empty() {
        (String::new(), values)
    } else {
        (format!(" WHERE {}", conds.join(" AND ")), values)
    }
}

/// 列表顺序:运行中 → 排队(按执行顺序:优先级高的、先到的在前)→ 其余按结束时间倒序。
/// 和任务页、系统概览原来在前端排的顺序一致,第一页总能看到正在跑和等着的任务。
const PAGE_ORDER: &str = "ORDER BY CASE state WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, \
     CASE WHEN state = 'queued' THEN -priority ELSE 0 END, \
     CASE WHEN state IN ('running', 'queued') THEN created_at \
          ELSE -COALESCE(finished_at, created_at) END, \
     id";

/// 已排好序的用时 → 5 段计数、中位数、P95。
///
/// 分段边界含上界(和前端 `bucketize` 一致);中位数偶数个取中间两个的平均;P95 用最近秩法。
fn duration_summary(sorted: &[i64]) -> (Vec<u64>, Option<f64>, Option<f64>) {
    let mut buckets = vec![0u64; JOB_DURATION_EDGES_MS.len() + 1];
    for span in sorted {
        let at = JOB_DURATION_EDGES_MS
            .iter()
            .position(|edge| span <= edge)
            .unwrap_or(JOB_DURATION_EDGES_MS.len());
        buckets[at] += 1;
    }
    if sorted.is_empty() {
        return (buckets, None, None);
    }
    let len = sorted.len();
    let mid = len / 2;
    let median = if len % 2 == 1 {
        sorted[mid] as f64
    } else {
        (sorted[mid - 1] as f64 + sorted[mid] as f64) / 2.0
    };
    // 最近秩:第 ceil(0.95 × n) 个(从 1 数)
    let rank = (len * 95).div_ceil(100).max(1);
    let p95 = sorted[rank - 1] as f64;
    (buckets, Some(median), Some(p95))
}

fn stats_on(conn: &rusqlite::Connection, filter: &JobFilter, since: Millis) -> Result<JobStats> {
    let rows_of = |extra: &[&str], tail: &[SqlValue], select: &str, rest: &str| {
        let (clause, mut values) = filter_clause(filter, extra);
        values.extend(tail.iter().cloned());
        (format!("SELECT {select} FROM jobs{clause}{rest}"), values)
    };

    // 1. 各状态计数(六种固定顺序,没有的补 0)
    let (sql, values) = rows_of(&[], &[], "state, COUNT(*)", " GROUP BY state");
    let found = conn
        .prepare(&sql)
        .map_err(map_sqlite_error)?
        .query_map(params_from_iter(values), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(map_sqlite_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(map_sqlite_error)?;
    let by_state: Vec<(JobState, u64)> = JOB_STATES
        .iter()
        .map(|state| {
            let count = found
                .iter()
                .find(|(name, _)| name == state.as_str())
                .map(|(_, count)| *count as u64)
                .unwrap_or(0);
            (*state, count)
        })
        .collect();
    let total = by_state.iter().map(|(_, count)| count).sum();

    // 2. 类型分布(任务页的「类型」下拉从这里来,不再靠前端扫全量)
    let (sql, values) = rows_of(
        &[],
        &[],
        "kind, COUNT(*)",
        " GROUP BY kind ORDER BY COUNT(*) DESC, kind",
    );
    let kinds = conn
        .prepare(&sql)
        .map_err(map_sqlite_error)?
        .query_map(params_from_iter(values), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? as u64))
        })
        .map_err(map_sqlite_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(map_sqlite_error)?;

    // 3. 最近窗口:按状态计数,完成任务另算平均用时
    let (sql, values) = rows_of(
        &["COALESCE(finished_at, created_at) > ?"],
        &[SqlValue::Integer(since)],
        "state, COUNT(*), \
         SUM(CASE WHEN started_at IS NOT NULL AND finished_at >= started_at \
             THEN finished_at - started_at END), \
         COUNT(CASE WHEN started_at IS NOT NULL AND finished_at >= started_at THEN 1 END)",
        " GROUP BY state",
    );
    let recent = conn
        .prepare(&sql)
        .map_err(map_sqlite_error)?
        .query_map(params_from_iter(values), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)? as u64,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(map_sqlite_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(map_sqlite_error)?;
    let recent_of = |state: JobState| {
        recent
            .iter()
            .find(|(name, ..)| name == state.as_str())
            .map(|(_, count, ..)| *count)
            .unwrap_or(0)
    };
    let recent_avg_ms = recent
        .iter()
        .find(|(name, ..)| name == JobState::Done.as_str())
        .and_then(|(_, _, sum, counted)| match (sum, counted) {
            (Some(sum), counted) if *counted > 0 => Some(*sum as f64 / *counted as f64),
            _ => None,
        });

    // 4. 排队最久的、最早开始的运行中任务(指标卡的小字)
    let (sql, values) = rows_of(&["state = 'queued'"], &[], "MIN(created_at)", "");
    let oldest_queued_at = conn
        .query_row(&sql, params_from_iter(values), |row| {
            row.get::<_, Option<i64>>(0)
        })
        .map_err(map_sqlite_error)?;
    let (sql, values) = rows_of(
        &["state = 'running'"],
        &[],
        "kind, collection",
        " ORDER BY COALESCE(started_at, created_at), created_at, id LIMIT 1",
    );
    let first_running = conn
        .query_row(&sql, params_from_iter(values), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .optional()
        .map_err(map_sqlite_error)?;

    // 5. 已完成任务的用时:只取两个整数列,在这里排序算分位数(1.4 万个整数,开销可以忽略)
    let (sql, values) = rows_of(
        &[
            "state = 'done'",
            "started_at IS NOT NULL",
            "finished_at IS NOT NULL",
            "finished_at >= started_at",
        ],
        &[],
        "finished_at - started_at",
        " ORDER BY 1",
    );
    let spans = conn
        .prepare(&sql)
        .map_err(map_sqlite_error)?
        .query_map(params_from_iter(values), |row| row.get::<_, i64>(0))
        .map_err(map_sqlite_error)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(map_sqlite_error)?;
    let (duration_buckets, duration_median_ms, duration_p95_ms) = duration_summary(&spans);

    Ok(JobStats {
        total,
        by_state,
        kinds,
        recent_since: since,
        recent_done: recent_of(JobState::Done),
        recent_failed: recent_of(JobState::Failed),
        recent_canceled: recent_of(JobState::Canceled),
        recent_avg_ms,
        oldest_queued_at,
        first_running,
        duration_buckets,
        duration_count: spans.len() as u64,
        duration_median_ms,
        duration_p95_ms,
    })
}

/// 每个桶末尾还在排队的任务数。
///
/// 一个任务在 `[created, leave)` 期间在排队,`leave` 是它开始(没开始就取结束时间)的时刻,从没离开过的是 `None`(现在还在排队)。
/// 差分数组:创建所在的桶 +1,离开所在的桶 −1(两者在同一个桶里就抵消,桶末已经不在队里);
/// 创建早于窗口的从第 0 个桶算起,离开晚于窗口的一直算到最后。
pub(crate) fn queue_depths(
    waits: &[(Millis, Option<Millis>)],
    start: Millis,
    step_ms: i64,
    count: usize,
) -> Vec<u64> {
    let mut diff = vec![0i64; count + 1];
    let bucket_of = |at: Millis| -> usize {
        if at < start {
            0
        } else {
            (((at - start) / step_ms.max(1)) as usize).min(count)
        }
    };
    for (created, leave) in waits {
        let from = bucket_of(*created);
        let to = leave.map_or(count, bucket_of);
        if from < to {
            diff[from] += 1;
            diff[to] -= 1;
        }
    }
    let mut depth = 0i64;
    (0..count)
        .map(|at| {
            depth += diff[at];
            depth.max(0) as u64
        })
        .collect()
}

/// 排队任务每等满一分钟加几分有效优先级。
///
/// 取任务是严格按优先级的:只要高优先级任务源源不断(别的会话一直在改仓库 → 一直有优先级 80 的增量),
/// 低优先级的全量索引(20)就永远轮不到(生产上实测新项目首次全量索引排了 9 分钟)。
/// 所以让「等」本身值分:每分钟 +6,全量索引等 10 分钟追平增量(80),且因为更早入队会先于之后来的增量。
const AGING_STEP_PER_MINUTE: i64 = 6;

/// 等待加成的上限(分)。
///
/// 封顶是为了让后台活「最多追平、不越级」:迁移(10)最多提到 70,
/// 永远追不上增量(80),后台迁移让路给日常增量是设计,只是不再被饿到一动不动。
const AGING_MAX_BOOST: i64 = 60;

/// 提级后有效优先级的天花板(分),只约束优先级低于它的任务。
///
/// 保存经验(90)与编辑单条(100)是用户当场在等的操作,必须永远排在所有「靠等提级」的任务前面;
/// 没有这条的话,增量(80)等 4 分钟就是 104,会越过刚入队的编辑单条。
/// 优先级本身不低于天花板的任务不受影响(取 `MAX(priority, 天花板)`),90 与 100 之间仍严格按优先级。
/// 改优先级表(`kb-service` 的 `jobs::queue::priority`)时要核对这三个常量仍满足:
/// 迁移 + 上限 < 增量,天花板 < 保存经验。
const AGING_CEILING: i64 = 89;

/// 一分钟的毫秒数。等待时间按「整分钟」折算,不满一分钟不加分,避免每次取任务都在微调排序。
const MILLIS_PER_MINUTE: i64 = 60_000;

/// 有效优先级(SQL 表达式):`?1` = 现在(毫秒),`?2` = 每分钟加成,`?3` = 加成上限,`?4` = 天花板,
/// `?5` = 一分钟的毫秒数。
///
/// **只给还没有检查点的任务(一片都没跑过)提级。** 按片调度的任务每做完一片就让出回队列、保留检查点
/// (`JobQueue::yield_job`),`created_at` 却不变:如果让这样的任务继续按 `created_at` 积累加成,
/// 一个跑了几个小时的全量索引(20 → 提到 80)会一直和新来的增量(80)同分,而它入队更早 ——
/// 每片让出后又立刻被自己取回,别的项目的实时增量要等它整个做完。有检查点的任务按原始优先级排,
/// 片间照旧让给更高优先级的新任务(这正是按片调度本来的语义)。
///
/// `MAX(? - created_at, 0)` 把「创建时间比现在还晚」(时钟回拨、跨机器写入)当成没等过,不让负数把任务往后压。
/// 全部用参数绑定,SQL 里没有拼接值。
const EFFECTIVE_PRIORITY_SQL: &str = "MIN(priority + CASE WHEN checkpoint_json IS NULL \
     THEN MIN(MAX(?1 - created_at, 0) / ?5 * ?2, ?3) ELSE 0 END, MAX(priority, ?4))";

impl SqliteMetaStore {
    /// 以 `now`(Unix 毫秒)为「现在」取下一个可执行任务:有效优先级高的先走,同分按创建时间先到先得。
    ///
    /// 「现在」做成参数,是为了测试能直接构造「已经等了很久」的队列而不必真的等;
    /// 生产里 [`JobRepo::next_runnable`] 传的是当前时间。
    /// 只看 `queued`:`running` 的任务不在候选里,所以按片调度的让出语义
    /// (`has_queued_above` 仍按原始优先级比较)不受影响。
    ///
    /// 等待时间从 `created_at` 算起,且只算「还没有检查点」的任务:表里没有「最近一次进队列」的时间戳,
    /// 让出后重新排队的任务若也按 `created_at` 积累,会把之前跑过的时间算成等待(见 [`EFFECTIVE_PRIORITY_SQL`])。
    /// 代价:已经开始的低优先级任务在片间可能再次被持续到来的高优先级任务拖住 —— 这和提级之前一样,
    /// 要连这一段也保证,得给 `jobs` 加一列「最近入队时间」。
    pub async fn next_runnable_at(&self, now: Millis) -> Result<Option<Job>> {
        self.read(move |conn| select_next_queued(conn, now)).await
    }

    /// 认领下一个可执行任务:**在同一个写事务里**「挑一个 + 转 running」。
    ///
    /// 多个后台分片并发取任务时只能走它。分两步(`next_runnable` 再 `update`)的话,
    /// 两个分片会读到同一条 `queued`,各自把它跑一遍。写连接只有一条、写事务串行,
    /// 所以这里挑中的那一条在提交之前不会被别人抢走。
    pub async fn claim_next_at(&self, now: Millis) -> Result<Option<Job>> {
        self.write(move |conn| {
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            let Some(raw) = select_next_queued(&tx, now)? else {
                return Ok(None);
            };
            let id = raw.id.clone();
            let changed = tx
                .execute(
                    "UPDATE jobs SET state = 'running', started_at = ?2 \
                     WHERE id = ?1 AND state = 'queued'",
                    params![id, now],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                // 挑到之后状态被改了(理论上写事务串行时不会发生):这一轮当没任务,下一轮重来
                return Ok(None);
            }
            tx.commit().map_err(map_sqlite_error)?;
            // 返回「已认领」后的形状:挑中的那一行是 `queued` 的旧值,
            // 直接交回去会让调用方把任务当 `queued` 再写一遍(等于没认领,还会被别的分片重跑)
            let mut job = raw;
            job.state = JobState::Running;
            job.started_at = Some(now);
            Ok(Some(job))
        })
        .await
    }
}

/// 挑下一个可执行任务(只读)。`claim_next_at` 在写事务里复用它。
fn select_next_queued(conn: &rusqlite::Connection, now: Millis) -> Result<Option<Job>> {
    let raw = conn
        .query_row(
            &format!(
                "SELECT {SELECT_COLUMNS} FROM jobs WHERE state = 'queued' \
                 ORDER BY {EFFECTIVE_PRIORITY_SQL} DESC, created_at LIMIT 1"
            ),
            params![
                now,
                AGING_STEP_PER_MINUTE,
                AGING_MAX_BOOST,
                AGING_CEILING,
                MILLIS_PER_MINUTE
            ],
            raw_from_row,
        )
        .optional()
        .map_err(map_sqlite_error)?;
    raw.map(RawJob::into_job).transpose()
}

#[async_trait]
impl JobRepo for SqliteMetaStore {
    async fn enqueue(&self, job: Job) -> Result<()> {
        self.write(move |conn| {
            conn.execute(
                "INSERT INTO jobs (id, kind, collection, priority, state, payload_json, checkpoint_json, \
                 progress_done, progress_total, rate, error, created_at, started_at, finished_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
                params![
                    job.id,
                    job.kind,
                    job.collection,
                    job.priority,
                    job.state.as_str(),
                    job.payload_json,
                    job.checkpoint_json,
                    job.progress_done as i64,
                    job.progress_total.map(|value| value as i64),
                    job.rate,
                    job.error,
                    job.created_at,
                    job.started_at,
                    job.finished_at,
                ],
            )
            .map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn next_runnable(&self) -> Result<Option<Job>> {
        self.next_runnable_at(now_millis()).await
    }

    async fn claim_next(&self) -> Result<Option<Job>> {
        self.claim_next_at(now_millis()).await
    }

    async fn update(&self, job: Job) -> Result<()> {
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE jobs SET kind = ?2, collection = ?3, priority = ?4, state = ?5, \
                     payload_json = ?6, checkpoint_json = ?7, progress_done = ?8, progress_total = ?9, \
                     rate = ?10, error = ?11, started_at = ?12, finished_at = ?13 WHERE id = ?1",
                    params![
                        job.id,
                        job.kind,
                        job.collection,
                        job.priority,
                        job.state.as_str(),
                        job.payload_json,
                        job.checkpoint_json,
                        job.progress_done as i64,
                        job.progress_total.map(|value| value as i64),
                        job.rate,
                        job.error,
                        job.started_at,
                        job.finished_at,
                    ],
                )
                .map_err(map_sqlite_error)?;
            if changed == 0 {
                return Err(KbError::NotFound(format!("job {}", job.id)));
            }
            Ok(())
        })
        .await
    }

    async fn get(&self, id: &str) -> Result<Option<Job>> {
        let id = id.to_owned();
        self.read(move |conn| {
            let raw = conn
                .query_row(
                    &format!("SELECT {SELECT_COLUMNS} FROM jobs WHERE id = ?1"),
                    params![id],
                    raw_from_row,
                )
                .optional()
                .map_err(map_sqlite_error)?;
            raw.map(RawJob::into_job).transpose()
        })
        .await
    }

    async fn list(&self, state: Option<JobState>) -> Result<Vec<Job>> {
        self.read(move |conn| query_jobs(conn, SELECT_COLUMNS, state))
            .await
    }

    async fn list_summaries(&self, state: Option<JobState>) -> Result<Vec<Job>> {
        self.read(move |conn| query_jobs(conn, SUMMARY_COLUMNS, state))
            .await
    }

    async fn recent_summaries(&self, limit: u32) -> Result<Vec<Job>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {SUMMARY_COLUMNS} FROM jobs ORDER BY created_at DESC LIMIT ?1"
                ))
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(params![i64::from(limit)], raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            rows.into_iter().map(RawJob::into_job).collect()
        })
        .await
    }

    async fn count_by_state(&self) -> Result<Vec<(JobState, u64)>> {
        self.read(move |conn| {
            let mut stmt = conn
                .prepare("SELECT state, COUNT(*) FROM jobs GROUP BY state")
                .map_err(map_sqlite_error)?;
            let found = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            // 六种状态固定顺序输出,没有记录的补 0,调用方不用再处理缺项
            let mut counts = Vec::with_capacity(JOB_STATES.len());
            for state in JOB_STATES {
                let count = found
                    .iter()
                    .find(|(name, _)| name == state.as_str())
                    .map(|(_, count)| *count as u64)
                    .unwrap_or(0);
                counts.push((state, count));
            }
            Ok(counts)
        })
        .await
    }

    async fn list_page(&self, filter: JobFilter, page: Page) -> Result<(Vec<Job>, u64)> {
        self.read(move |conn| {
            let (clause, values) = filter_clause(&filter, &[]);
            let total: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM jobs{clause}"),
                    params_from_iter(values.iter()),
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            let mut paged = values;
            paged.push(SqlValue::Integer(i64::from(page.limit)));
            paged.push(SqlValue::Integer(i64::from(page.offset)));
            let rows = conn
                .prepare(&format!(
                    "SELECT {SUMMARY_COLUMNS} FROM jobs{clause} {PAGE_ORDER} LIMIT ? OFFSET ?"
                ))
                .map_err(map_sqlite_error)?
                .query_map(params_from_iter(paged), raw_from_row)
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            let jobs = rows
                .into_iter()
                .map(RawJob::into_job)
                .collect::<Result<Vec<_>>>()?;
            Ok((jobs, total as u64))
        })
        .await
    }

    async fn stats(&self, filter: JobFilter, recent_since: Millis) -> Result<JobStats> {
        self.read(move |conn| stats_on(conn, &filter, recent_since))
            .await
    }

    async fn series(
        &self,
        filter: JobFilter,
        start: Millis,
        step_ms: i64,
        count: usize,
    ) -> Result<JobSeries> {
        let step = step_ms.max(1);
        self.read(move |conn| {
            let end = start + step * count as i64;
            let mut buckets = vec![JobBucket::default(); count];

            // 完成 / 失败 / 取消:按结束时间归桶;完成的另算平均用时
            // 起点和步长也走绑定参数(SELECT 里的 ? 在前,所以先放进去)
            let (clause, filter_values) = filter_clause(&filter, &["finished_at >= ?", "finished_at < ?"]);
            let mut values = vec![SqlValue::Integer(start), SqlValue::Integer(step)];
            values.extend(filter_values);
            values.extend([SqlValue::Integer(start), SqlValue::Integer(end)]);
            let sql = format!(
                "SELECT CAST((finished_at - ?) / ? AS INTEGER), state, COUNT(*), \
                        SUM(CASE WHEN started_at IS NOT NULL AND finished_at >= started_at THEN finished_at - started_at END), \
                        COUNT(CASE WHEN started_at IS NOT NULL AND finished_at >= started_at THEN 1 END) \
                 FROM jobs{clause} GROUP BY 1, 2"
            );
            let finished = conn
                .prepare(&sql)
                .map_err(map_sqlite_error)?
                .query_map(params_from_iter(values), |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)? as u64, row.get::<_, Option<i64>>(3)?, row.get::<_, i64>(4)?))
                })
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            for (at, state, n, span_sum, spans) in finished {
                let Some(bucket) = usize::try_from(at).ok().filter(|at| *at < count).map(|at| &mut buckets[at]) else { continue };
                match state.as_str() {
                    "done" => {
                        bucket.done = n;
                        bucket.avg_ms = span_sum.filter(|_| spans > 0).map(|sum| sum as f64 / spans as f64);
                    }
                    "failed" => bucket.failed = n,
                    "canceled" => bucket.canceled = n,
                    _ => {}
                }
            }

            // 创建:按创建时间归桶
            let (clause, filter_values) = filter_clause(&filter, &["created_at >= ?", "created_at < ?"]);
            let mut values = vec![SqlValue::Integer(start), SqlValue::Integer(step)];
            values.extend(filter_values);
            values.extend([SqlValue::Integer(start), SqlValue::Integer(end)]);
            let sql = format!("SELECT CAST((created_at - ?) / ? AS INTEGER), COUNT(*) FROM jobs{clause} GROUP BY 1");
            let created = conn
                .prepare(&sql)
                .map_err(map_sqlite_error)?
                .query_map(params_from_iter(values), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? as u64)))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            for (at, n) in created {
                if let Some(at) = usize::try_from(at).ok().filter(|at| *at < count) {
                    buckets[at].created = n;
                }
            }

            // 排队深度:窗口内曾经排过队的任务(创建早于窗口末尾、离开队伍晚于窗口起点或还没离开)
            let (clause, mut values) = filter_clause(&filter, &["created_at < ?", "(COALESCE(started_at, finished_at) IS NULL OR COALESCE(started_at, finished_at) > ?)"]);
            values.extend([SqlValue::Integer(end), SqlValue::Integer(start)]);
            let sql = format!("SELECT created_at, COALESCE(started_at, finished_at) FROM jobs{clause}");
            let waits = conn
                .prepare(&sql)
                .map_err(map_sqlite_error)?
                .query_map(params_from_iter(values), |row| Ok((row.get::<_, i64>(0)?, row.get::<_, Option<i64>>(1)?)))
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            for (bucket, depth) in buckets.iter_mut().zip(queue_depths(&waits, start, step, count)) {
                bucket.queue_depth = depth;
            }
            Ok(JobSeries { start, step_ms: step, buckets })
        })
        .await
    }

    async fn has_queued_above(&self, priority: i32) -> Result<bool> {
        self.read(move |conn| {
            conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM jobs WHERE state = 'queued' AND priority > ?1)",
                params![priority],
                |row| row.get::<_, i64>(0),
            )
            .map(|found| found != 0)
            .map_err(map_sqlite_error)
        })
        .await
    }

    async fn prune_failed(&self, before: Millis, dry_run: bool) -> Result<u64> {
        self.write(move |conn| {
            // 失败任务可能没有 finished_at(被强杀时),这时用创建时间判断年龄
            let age = "state = 'failed' AND COALESCE(finished_at, created_at) < ?1";
            if dry_run {
                let count: i64 = conn
                    .query_row(
                        &format!("SELECT COUNT(*) FROM jobs WHERE {age}"),
                        params![before],
                        |row| row.get(0),
                    )
                    .map_err(map_sqlite_error)?;
                return Ok(count as u64);
            }
            // 逐文件明细跟着任务一起走,否则表会越攒越大(任务本身会被定时清掉)
            conn.execute(
                &format!("DELETE FROM job_files WHERE job_id IN (SELECT id FROM jobs WHERE {age})"),
                params![before],
            )
            .map_err(map_sqlite_error)?;
            let removed = conn
                .execute(&format!("DELETE FROM jobs WHERE {age}"), params![before])
                .map_err(map_sqlite_error)?;
            Ok(removed as u64)
        })
        .await
    }

    async fn requeue_running(&self) -> Result<u64> {
        self.write(move |conn| {
            let changed = conn
                .execute(
                    "UPDATE jobs SET state = 'queued', started_at = NULL WHERE state = 'running'",
                    [],
                )
                .map_err(map_sqlite_error)?;
            Ok(changed as u64)
        })
        .await
    }

    async fn record_job_files(&self, job_id: &str, files: &[JobFile]) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        let job_id = job_id.to_owned();
        let files = files.to_vec();
        self.write(move |conn| {
            // 一个分片写一次:几十到几百条走同一个事务,不必每条一次 fsync。
            // 续跑重写同一个路径时以最后一次为准,所以是 upsert 不是 insert。
            let tx = conn.transaction().map_err(map_sqlite_error)?;
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO job_files (job_id, path, change, chunks, meta_chunks, \
                         deleted_chunks, error, done_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) \
                         ON CONFLICT(job_id, path) DO UPDATE SET change = excluded.change, \
                         chunks = excluded.chunks, meta_chunks = excluded.meta_chunks, \
                         deleted_chunks = excluded.deleted_chunks, error = excluded.error, \
                         done_at = excluded.done_at",
                    )
                    .map_err(map_sqlite_error)?;
                for file in &files {
                    stmt.execute(params![
                        job_id,
                        file.path,
                        file.change.as_str(),
                        file.chunks as i64,
                        file.meta_chunks as i64,
                        file.deleted_chunks as i64,
                        file.error,
                        file.done_at,
                    ])
                    .map_err(map_sqlite_error)?;
                }
            }
            tx.commit().map_err(map_sqlite_error)?;
            Ok(())
        })
        .await
    }

    async fn list_job_files(
        &self,
        job_id: &str,
        page: Page,
    ) -> Result<(Vec<JobFile>, u64, Vec<(FileChange, u64)>)> {
        let job_id = job_id.to_owned();
        self.read(move |conn| {
            let total: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM job_files WHERE job_id = ?1",
                    params![job_id],
                    |row| row.get(0),
                )
                .map_err(map_sqlite_error)?;
            // 排序:失败 / 删除 / 新增 / 更新 / 只改元数据 / 没变(和 FileChange::order 一致)
            let mut stmt = conn
                .prepare(
                    "SELECT path, change, chunks, meta_chunks, deleted_chunks, error, done_at \
                     FROM job_files WHERE job_id = ?1 \
                     ORDER BY CASE change WHEN 'error' THEN 0 WHEN 'delete' THEN 1 WHEN 'new' THEN 2 \
                         WHEN 'update' THEN 3 WHEN 'meta' THEN 4 ELSE 5 END, path \
                     LIMIT ?2 OFFSET ?3",
                )
                .map_err(map_sqlite_error)?;
            let rows = stmt
                .query_map(
                    params![job_id, page.limit as i64, page.offset as i64],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, i64>(4)?,
                            row.get::<_, Option<String>>(5)?,
                            row.get::<_, i64>(6)?,
                        ))
                    },
                )
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            let mut files = Vec::with_capacity(rows.len());
            for (path, change, chunks, meta_chunks, deleted_chunks, error, done_at) in rows {
                let change = FileChange::parse(&change).ok_or_else(|| {
                    KbError::Internal(format!("job_files.change 非法: {change}"))
                })?;
                files.push(JobFile {
                    path,
                    change,
                    chunks: chunks.max(0) as usize,
                    meta_chunks: meta_chunks.max(0) as usize,
                    deleted_chunks: deleted_chunks.max(0) as usize,
                    error,
                    done_at,
                });
            }
            let mut counts = Vec::new();
            let mut count_stmt = conn
                .prepare("SELECT change, COUNT(*) FROM job_files WHERE job_id = ?1 GROUP BY change")
                .map_err(map_sqlite_error)?;
            let raw = count_stmt
                .query_map(params![job_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(map_sqlite_error)?
                .collect::<rusqlite::Result<Vec<_>>>()
                .map_err(map_sqlite_error)?;
            for (change, n) in raw {
                if let Some(change) = FileChange::parse(&change) {
                    counts.push((change, n.max(0) as u64));
                }
            }
            counts.sort_by_key(|(change, _)| change.order());
            Ok((files, total.max(0) as u64, counts))
        })
        .await
    }
}

#[cfg(test)]
mod tests {
    use super::queue_depths;

    #[test]
    fn queue_depth_edges_are_clamped_to_the_window() {
        // 窗口:起点 0,10 个宽 100 的桶。
        // 离开早于创建(时钟问题)不产生负数;创建早于窗口的从第 0 桶算起;离开晚于窗口的算到最后;同桶创建又离开的抵消
        let depths = queue_depths(
            &[
                (-500, Some(-100)),
                (50, Some(40)),
                (-10, None),
                (990, Some(5_000)),
                (150, Some(180)),
            ],
            0,
            100,
            10,
        );
        assert_eq!(depths, [1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
    }

    #[test]
    fn an_empty_window_has_zero_depth_everywhere() {
        assert_eq!(queue_depths(&[], 0, 100, 4), [0, 0, 0, 0]);
        assert_eq!(queue_depths(&[(5, None)], 0, 100, 0), Vec::<u64>::new());
    }
}
