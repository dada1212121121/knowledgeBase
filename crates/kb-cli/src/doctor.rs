//! `kb doctor`:环境自检。
//!
//! 检查项分两级:
//! - **error**:影响退出码。g++ / libstdc++ 缺失、数据目录不可写、磁盘剩余 < 10GB;
//! - **warn**:以 `warn:` 前缀输出,不影响退出码。未识别到核显、模型缓存不存在、
//!   socket 不可连接、代理环境变量不合适。

use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::process::{Command, ExitCode, Stdio};

use kb_core::Result;
use kb_core::config::Config;
use kb_core::paths::KbPaths;
use kb_core::ports::VectorStore;
use rusqlite::OpenFlags;

/// 磁盘剩余空间的 error 阈值:10GB。
const MIN_FREE_DISK_BYTES: u64 = 10 * 1024 * 1024 * 1024;
/// 可用内存的 warn 阈值:8GB(加载 BGE-M3 后常驻 5–8GB)。
const MIN_AVAILABLE_MEMORY_BYTES: u64 = 8 * 1024 * 1024 * 1024;

/// 一条检查结果(文本与 `--json` 共用同一份数据,不各写一遍)。
struct Check {
    level: &'static str,
    name: String,
    detail: String,
}

/// 单个 collection 的账目:向量库行数、meta 行数、两边各自多出来的 id 数。
///
/// `store_rows` 只数 `kind IN ('code', 'doc')`;insight 不写 `chunks` 表,混进来会对不上。
#[derive(Clone, Debug, serde::Serialize)]
struct CollectionHealth {
    collection: String,
    table: String,
    store_rows: usize,
    meta_rows: usize,
    orphans: usize,
    missing: usize,
}

/// 待补向量队列的体检结果与修复计数。
#[derive(Clone, Debug, Default, serde::Serialize)]
struct QueueHealth {
    chunks: u64,
    files: u64,
    oldest_enqueued_at: Option<kb_core::model::Millis>,
    oldest_age_secs: Option<u64>,
    rate_per_sec: Option<f64>,
    eta_secs: Option<u64>,
    /// 扫过的 collection 数。
    checked: usize,
    /// 队列指向已不存在的块(元数据里没有),已自动出队。
    missing_meta_fixed: usize,
    /// 队列指向的行已经在向量库 ready,已自动出队。
    stale_ready_fixed: usize,
    /// 队列指向的块还在 meta,但向量行丢了;不能自动修,必须重跑文本阶段。
    missing_lance: usize,
    /// 队列与向量行的 `embed_input_hash` 不一致;不能自动修,必须重跑索引。
    hash_mismatch: usize,
}

/// 自检结果收集器。
#[derive(Default)]
struct Report {
    lines: Vec<String>,
    checks: Vec<Check>,
    /// 表的物理状况(`--json` 时原样输出;文本模式只输出一行摘要)
    tables: Vec<kb_core::model::TableStats>,
    /// 每个 collection 的账目(逐 id 对账的结果)
    collections: Vec<CollectionHealth>,
    /// 待补向量队列的状况
    queue: QueueHealth,
    errors: usize,
    warns: usize,
}

impl Report {
    fn push(&mut self, level: &'static str, name: &str, detail: impl std::fmt::Display) {
        let detail = detail.to_string();
        self.checks.push(Check {
            level,
            name: name.to_owned(),
            detail: detail.clone(),
        });
        let pad = if level == "info" || level == "ok" {
            "  "
        } else {
            ""
        };
        self.lines.push(format!("{level}:{pad}{name}: {detail}"));
    }

    fn note(&mut self, name: &str, detail: impl std::fmt::Display) {
        self.push("info", name, detail);
    }

    fn ok(&mut self, name: &str, detail: impl std::fmt::Display) {
        self.push("ok", name, detail);
    }

    fn warn(&mut self, name: &str, detail: impl std::fmt::Display) {
        self.warns += 1;
        self.push("warn", name, detail);
    }

    fn error(&mut self, name: &str, detail: impl std::fmt::Display) {
        self.errors += 1;
        self.push("error", name, detail);
    }

    /// `--json`:给运维脚本 / 前端用的结构化结果(表的碎片数在这里,不用再数文件)。
    fn print_json(&self) {
        let body = serde_json::json!({
            "errors": self.errors,
            "warns": self.warns,
            "kb_home": std::env::var(kb_core::paths::KB_HOME_ENV).unwrap_or_default(),
            "checks": self
                .checks
                .iter()
                .map(|check| serde_json::json!({
                    "level": check.level,
                    "name": check.name,
                    "detail": check.detail,
                }))
                .collect::<Vec<_>>(),
            "tables": self.tables,
            "collections": self.collections,
            "pending": self.queue,
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&body).unwrap_or_else(|_| "{}".to_owned())
        );
    }

    fn print(&self) {
        for line in &self.lines {
            println!("{line}");
        }
        println!();
        println!(
            "doctor: {} error, {} warn(KB_HOME={})",
            self.errors,
            self.warns,
            std::env::var(kb_core::paths::KB_HOME_ENV).unwrap_or_else(|_| "未设置".to_owned())
        );
    }
}

/// 执行自检,返回进程退出码。
pub async fn run(
    paths: &KbPaths,
    config: &Config,
    json: bool,
    what: Option<&str>,
) -> Result<ExitCode> {
    // `kb doctor backends`:只看后端清单,不跑其余检查 —— 一次只回答一个问题
    if let Some(what) = what {
        return match what {
            "backends" => backends_report(paths, json),
            other => Err(kb_core::KbError::InvalidInput(format!(
                "kb doctor {other} 不认识;目前只支持 backends"
            ))),
        };
    }
    let mut report = Report::default();
    report.note("KB_HOME", paths.home().display());
    report.note("config", config_path_note(paths));
    report.note("listen", &config.server.listen);
    report.note("环境变量", env_summary());

    check_data_dir(&mut report, paths);
    check_toolchain(&mut report);
    check_disk(&mut report, paths.home());
    check_memory(&mut report);
    check_vulkan(&mut report);
    check_models(&mut report, paths);
    check_ocr_limits(&mut report, config);
    check_socket(&mut report, paths).await;
    check_proxy(&mut report, config);
    check_tables(&mut report, paths, config).await;

    if json {
        report.print_json();
    } else {
        report.print();
    }
    Ok(if report.errors == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

/// 表的物理状况:碎片数、数据文件数,以及「行数早过了阈值却没建向量索引」的表。
///
/// 只读打开 Lance 目录(不开守护进程、不建索引),因此 `kb doctor` 在服务停机时也能查。
/// 碎片从几十涨到上千,单次检索就要多开上千个文件——这条检查是检索变慢时第一眼要看的地方。
async fn check_tables(report: &mut Report, paths: &KbPaths, config: &Config) {
    let Ok(store) = kb_store_lance::LanceStore::connect(paths.lance_dir().to_string_lossy()).await
    else {
        report.warn("表状况", "打不开 Lance 目录(还没建过索引?)");
        return;
    };
    let Ok(stats) = store.table_stats().await else {
        report.warn("表状况", "读不到表清单");
        return;
    };
    if stats.is_empty() {
        report.note("表状况", "还没有物理表");
        // 没有物理表也可能有残留队列(建表前就崩了):队列体检仍要跑一次
        check_pending_queues(report, paths, &store, &[]).await;
        return;
    }
    report.tables = stats.clone();
    let total_files: u64 = stats.iter().map(|table| table.data_files).sum();
    let total_rows: u64 = stats.iter().map(|table| table.rows).sum();
    let fattest = stats
        .iter()
        .max_by_key(|table| table.data_files)
        .map(|table| format!("{} {} 个文件", table.table, table.data_files))
        .unwrap_or_else(|| "-".to_owned());
    // 阈值只在「该建却没建」时才值得提醒;碎片多则是另一类问题
    let threshold = config.index.vector_index_min_rows;
    let missing: Vec<&str> = stats
        .iter()
        .filter(|table| table.rows >= threshold && table.index_kind.is_none())
        .map(|table| table.table.as_str())
        .collect();
    let detail = format!(
        "{} 张表 / {} 行 / {} 个数据文件(最碎: {fattest})",
        stats.len(),
        total_rows,
        total_files
    );
    if missing.is_empty() {
        report.ok("表状况", detail);
    } else {
        report.warn(
            "表状况",
            format!(
                "{detail};{} 张表过了 {} 行阈值却没有向量索引: {}。可在系统状态页「资源 → 向量表」点「整理索引」,或等夜间任务",
                missing.len(),
                threshold,
                missing.join("、")
            ),
        );
    }
    // 碎片超过 200 个文件时单独提示:检索延迟会被文件数拖累(见检索性能说明 )
    if total_files > 200 {
        report.warn(
            "碎片",
            format!(
                "{total_files} 个数据文件,建议在系统状态页「资源 → 向量表」整理一次再评估检索延迟"
            ),
        );
    }
    // 物理表清单已经拿到了，顺手和 meta.db 的 chunks 逐 id 对一下：
    // 孤儿/缺失在检索层不一定立刻表现出来，但在这里能第一时间看见。
    let audits = check_chunk_consistency(report, paths, &store, &stats).await;
    // 每个 collection 的账目单独一行:块对账只报总数,排查时要能直接看到是哪张表多了/少了
    let ledger: Vec<String> = report
        .collections
        .iter()
        .map(|health| {
            format!(
                "{}: 向量 {} 行 / meta {} 行 / 孤儿 {} / 缺失 {}",
                health.collection,
                health.store_rows,
                health.meta_rows,
                health.orphans,
                health.missing
            )
        })
        .collect();
    for line in ledger {
        report.note("表账", line);
    }
    // 队列体检复用同一次指纹扫描:不再为 pending 查第二遍整表
    check_pending_queues(report, paths, &store, &audits).await;
}

/// 每个 collection 的 `chunks` id 与向量库里 `kind IN ('code', 'doc')` 的 id 逐条对照。
///
/// 只读：用只读连接打开 `meta.db`，用已连接的 Lance 存储做 `list_fingerprints`，不建表、
/// 不迁移、不写任何一边。这里按 id 比较而不是只比行数：历史上出现过「两边行数相等，
/// 但一边少 5 块、另一边多 5 条孤儿」的抵消场景，只比数量会漏掉。
///
/// 只报差异，不自动修：删孤儿或重建缺失块都可能改动生产数据，必须由夜间校验或人工判断。
async fn check_chunk_consistency(
    report: &mut Report,
    paths: &KbPaths,
    store: &kb_store_lance::LanceStore,
    stats: &[kb_core::model::TableStats],
) -> Vec<(String, String, HashSet<String>)> {
    let path = paths.meta_db();
    if !path.is_file() {
        report.note(
            "块对账",
            format!("{} 不存在(还没建过索引?)", path.display()),
        );
        return Vec::new();
    }
    let expected = match read_meta_chunks(path) {
        Ok(expected) => expected,
        Err(err) => {
            report.warn("块对账", format!("读 meta.db 失败: {err}"));
            return Vec::new();
        }
    };
    if expected.is_empty() {
        report.ok("块对账", "meta.db 里还没有 collection");
        return Vec::new();
    }
    let by_table: BTreeMap<&str, u64> = stats
        .iter()
        .map(|table| (table.table.as_str(), table.rows))
        .collect();
    let mut checked = 0usize;
    let mut total_chunks = 0usize;
    let mut differences = Vec::new();
    let mut audits = Vec::new();
    for (collection, table, ids) in expected {
        let known: HashSet<String> = ids.iter().cloned().collect();
        if !by_table.contains_key(table.as_str()) {
            if !ids.is_empty() {
                differences.push(format!(
                    "{collection}: meta {} 块，但活动表 {table} 不在物理表清单里",
                    ids.len()
                ));
            }
            report.collections.push(CollectionHealth {
                collection: collection.clone(),
                table: table.clone(),
                store_rows: 0,
                meta_rows: ids.len(),
                orphans: 0,
                missing: ids.len(),
            });
            audits.push((collection, table, HashSet::new()));
            continue;
        }
        let fingerprints = match store
            .list_fingerprints(&table, Some("kind IN ('code', 'doc')"))
            .await
        {
            Ok(fingerprints) => fingerprints,
            Err(err) => {
                differences.push(format!("{collection}: 读向量库 {table} 失败: {err}"));
                report.collections.push(CollectionHealth {
                    collection: collection.clone(),
                    table: table.clone(),
                    store_rows: 0,
                    meta_rows: ids.len(),
                    orphans: 0,
                    missing: ids.len(),
                });
                audits.push((collection, table, HashSet::new()));
                continue;
            }
        };
        let actual: HashSet<String> = fingerprints
            .into_iter()
            .map(|fingerprint| fingerprint.id)
            .collect();
        let missing = known.iter().filter(|id| !actual.contains(*id)).count();
        let orphans = actual.iter().filter(|id| !known.contains(*id)).count();
        report.collections.push(CollectionHealth {
            collection: collection.clone(),
            table: table.clone(),
            store_rows: actual.len(),
            meta_rows: ids.len(),
            orphans,
            missing,
        });
        if missing > 0 || orphans > 0 {
            differences.push(format!(
                "{collection}: meta 有 {missing} 块在向量库找不到，向量库有 {orphans} 行在 meta 找不到(活动表 {table})"
            ));
        } else {
            checked += 1;
            total_chunks += ids.len();
        }
        audits.push((collection, table, actual));
    }
    if differences.is_empty() {
        report.ok(
            "块对账",
            format!("{checked} 个 collection 逐 id 一致，共 {total_chunks} 块"),
        );
    } else {
        report.warn(
            "块对账",
            format!(
                "{} 个 collection 不一致：{}。先看夜间校验日志；不要在守护进程写入时手工删行",
                differences.len(),
                differences.join("；")
            ),
        );
    }
    audits
}

/// 待补向量队列体检:脏队列 / 漏删队列 / pending 行缺元数据或 hash 不一致。
///
/// 三类问题分开处理:
/// - **能安全修的自动修**:队列指向的块在 `chunks` 里已经不存在(删文件 / 重建残留),或者
///   队列还在但向量行已经 ready(漏删),直接从队列删掉,next 一次检索不再白查;
/// - **不能自动修的报 error**:块还在 meta、向量行却丢了(pending 行写坏 / 被误删),
///   只能重跑文本阶段;hash 对不上说明索引写入了旧内容,也要重跑;
/// - 以上都没有时输出 ok。修复用的是 `SQLITE_OPEN_READ_WRITE`,只动 `pending_embeds`,
///   不碰 `chunks` / 向量库。
async fn check_pending_queues(
    report: &mut Report,
    paths: &KbPaths,
    store: &kb_store_lance::LanceStore,
    audits: &[(String, String, HashSet<String>)],
) {
    let path = paths.meta_db();
    if !path.is_file() {
        report.ok("待补向量", "没有 meta.db(还没建过索引)");
        return;
    }
    let rows = match read_pending_rows(path) {
        Ok(rows) => rows,
        Err(err) => {
            if err.to_string().contains("no such table") {
                // 老库还没跑 0026 迁移:还没有文本优先索引,也就不会有待补队列
                report.ok("待补向量", "还没有 pending_embeds 表");
                return;
            }
            report.warn("队列体检", format!("读 pending_embeds 失败: {err}"));
            return;
        }
    };
    if rows.is_empty() {
        report.queue.rate_per_sec = read_running_rate(path);
        report.queue.eta_secs = None;
        report.ok("待补向量", "无");
        report.ok("队列体检", "没有待补向量的块");
        return;
    }
    let by_collection: BTreeMap<&str, &(String, String, HashSet<String>)> = audits
        .iter()
        .map(|audit| (audit.0.as_str(), audit))
        .collect();
    // 每个 collection 只扫一次 pending 行:队列可能上千条,不能每条队列记录都去 Lance 查一遍
    let queued_collections: HashSet<&str> =
        rows.iter().map(|row| row.collection.as_str()).collect();
    let mut pending_by_collection: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for collection in queued_collections {
        let Some((_, table, _)) = by_collection.get(collection) else {
            continue;
        };
        // 旧表没有 `embed_state` 列:这种表不可能有 产生的 pending 行,
        // 队列统一按「漏删」处理(下面的 stale_ready 分支),所以查不出来就当空的
        let pending = store
            .list_fingerprints(table, Some("embed_state = 'pending'"))
            .await
            .unwrap_or_default();
        pending_by_collection.insert(
            collection.to_owned(),
            pending
                .into_iter()
                .map(|fingerprint| (fingerprint.id, fingerprint.embed_input_hash))
                .collect(),
        );
    }
    let mut delete_by_collection: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut missing_lance = Vec::new();
    let mut hash_mismatch = Vec::new();
    let mut checked = 0usize;
    for row in &rows {
        checked += 1;
        let Some((_, _table, present)) = by_collection.get(row.collection.as_str()) else {
            if row.embed_input_hash.is_none() {
                // collection / 块都已经不在 meta:这一条就是脏队列,可以安全删
                report.queue.missing_meta_fixed += 1;
                delete_by_collection
                    .entry(row.collection.clone())
                    .or_default()
                    .push(row.chunk_id.clone());
            } else {
                // 块还在,只是物理表不在清单里(建表前崩了 / 表被误删):不能删队列,必须重建
                report.queue.missing_lance += 1;
                missing_lance.push(format!("{}/{}", row.collection, row.chunk_id));
            }
            continue;
        };
        if row.embed_input_hash.is_none() {
            // LEFT JOIN 没命中 chunks:块已经不在了,留着只会让每次检索都查一次空队列
            report.queue.missing_meta_fixed += 1;
            delete_by_collection
                .entry(row.collection.clone())
                .or_default()
                .push(row.chunk_id.clone());
            continue;
        }
        if !present.contains(&row.chunk_id) {
            // 块还在 meta,向量行却不在:不能当成「删干净了」,必须重建文本阶段
            report.queue.missing_lance += 1;
            missing_lance.push(format!("{}/{}", row.collection, row.chunk_id));
            continue;
        }
        let pending = pending_by_collection.get(&row.collection);
        match pending.and_then(|pending| pending.get(&row.chunk_id)) {
            Some(hash) if row.embed_input_hash.as_deref() != Some(hash.as_str()) => {
                // 队列记的是旧输入的 hash,补出来的向量会对应旧正文
                report.queue.hash_mismatch += 1;
                hash_mismatch.push(format!("{}/{}", row.collection, row.chunk_id));
            }
            Some(_) => {}
            None => {
                // 行在向量库、但已经 ready:队列是漏删,删掉即可
                report.queue.stale_ready_fixed += 1;
                delete_by_collection
                    .entry(row.collection.clone())
                    .or_default()
                    .push(row.chunk_id.clone());
            }
        }
    }
    if !delete_by_collection.is_empty()
        && let Err(err) = delete_pending_rows(path, &delete_by_collection)
    {
        // 计数是「检测到」的,删除失败时不要把修复说成功
        report.warn("队列体检", format!("自动清理失败: {err}"));
    }
    let mut remaining: BTreeMap<String, Vec<&PendingRow>> = BTreeMap::new();
    for row in &rows {
        let removed = delete_by_collection
            .get(&row.collection)
            .is_some_and(|ids| ids.contains(&row.chunk_id));
        if !removed {
            remaining
                .entry(row.collection.clone())
                .or_default()
                .push(row);
        }
    }
    let mut files_by_collection: BTreeMap<String, HashSet<&str>> = BTreeMap::new();
    for (collection, rows) in &remaining {
        files_by_collection
            .entry(collection.clone())
            .or_default()
            .extend(rows.iter().map(|row| row.path.as_str()));
    }
    report.queue.chunks = remaining.values().map(Vec::len).sum::<usize>() as u64;
    report.queue.files = files_by_collection
        .values()
        .map(|paths| paths.len() as u64)
        .sum();
    report.queue.oldest_enqueued_at = remaining
        .values()
        .flat_map(|rows| rows.iter().map(|row| row.enqueued_at))
        .min();
    let now = now_millis();
    report.queue.oldest_age_secs = report
        .queue
        .oldest_enqueued_at
        .map(|at| now.saturating_sub(at).max(0) as u64 / 1000);
    report.queue.rate_per_sec = read_running_rate(path);
    report.queue.eta_secs = report
        .queue
        .rate_per_sec
        .filter(|rate| *rate > 0.0)
        .map(|rate| (report.queue.chunks as f64 / rate).ceil() as u64);
    report.queue.checked = checked;
    if report.queue.chunks == 0 {
        report.ok("待补向量", "无");
    } else {
        report.ok(
            "待补向量",
            format!(
                "{} 块 / {} 个文件，最老已等 {}，{}",
                report.queue.chunks,
                report.queue.files,
                report
                    .queue
                    .oldest_age_secs
                    .map(crate::pending::format_duration)
                    .unwrap_or_else(|| "未知".to_owned()),
                report
                    .queue
                    .eta_secs
                    .map(|secs| format!("预计 {}", crate::pending::format_duration(secs)))
                    .unwrap_or_else(|| "补完时间未知(没有运行中的索引任务)".to_owned()),
            ),
        );
    }
    let fixed = report.queue.missing_meta_fixed + report.queue.stale_ready_fixed;
    if report.queue.missing_lance > 0 || report.queue.hash_mismatch > 0 {
        let mut parts = Vec::new();
        if report.queue.missing_lance > 0 {
            parts.push(format!(
                "{} 块还在 meta，但向量行丢了: {}",
                report.queue.missing_lance,
                sample_list(&missing_lance)
            ));
        }
        if report.queue.hash_mismatch > 0 {
            parts.push(format!(
                "{} 块的嵌入输入 hash 与向量行不一致: {}",
                report.queue.hash_mismatch,
                sample_list(&hash_mismatch)
            ));
        }
        report.error(
            "队列体检",
            format!(
                "{}。自动出队 {fixed} 条；请对相关项目重跑 `kb index --full`",
                parts.join("；")
            ),
        );
    } else if fixed > 0 {
        report.warn(
            "队列体检",
            format!(
                "自动出队 {fixed} 条（块已删除或已 ready），队列现在 {} 块",
                report.queue.chunks
            ),
        );
    } else {
        report.ok(
            "队列体检",
            format!("{checked} 条队列记录都有对应块，且都还是 pending"),
        );
    }
}

/// 体检错误里最多列几条 id:生产上一次哈希不符可能有上千条,全量拼进一行会把
/// 终端和 `--json` 的 errors 撑爆;只给前几条让人能定位,总数另外写。
const SAMPLE_LIMIT: usize = 5;

fn sample_list(items: &[String]) -> String {
    if items.len() <= SAMPLE_LIMIT {
        return items.join("、");
    }
    format!(
        "{}、…(共 {} 条)",
        items[..SAMPLE_LIMIT].join("、"),
        items.len()
    )
}

/// `pending_embeds` 的一行 + `chunks` 里的 hash(LEFT JOIN 没命中时是 `None`)。
struct PendingRow {
    collection: String,
    chunk_id: String,
    path: String,
    enqueued_at: kb_core::model::Millis,
    embed_input_hash: Option<String>,
}

/// 只读队列行:用只读连接,不建库、不改 WAL。
fn read_pending_rows(path: &Path) -> rusqlite::Result<Vec<PendingRow>> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let mut statement = conn.prepare(
        "SELECT p.collection, p.chunk_id, p.path, p.enqueued_at, k.embed_input_hash \
         FROM pending_embeds p \
         LEFT JOIN chunks k ON k.collection = p.collection AND k.id = p.chunk_id \
         ORDER BY p.collection, p.chunk_id",
    )?;
    let rows = statement.query_map([], |row| {
        Ok(PendingRow {
            collection: row.get(0)?,
            chunk_id: row.get(1)?,
            path: row.get(2)?,
            enqueued_at: row.get(3)?,
            embed_input_hash: row.get(4)?,
        })
    })?;
    rows.collect()
}

/// 删除能安全修的队列行;返回真实删除的行数。
///
/// 只有 `kb doctor` 会调,且只在「块已不在 meta」或「行已 ready」时调;删除按 collection
/// 分批(每批 500,避免 SQLite 变量上限)。
fn delete_pending_rows(
    path: &Path,
    by_collection: &BTreeMap<String, Vec<String>>,
) -> rusqlite::Result<usize> {
    let mut conn = rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let tx = conn.transaction()?;
    let mut deleted = 0usize;
    for (collection, ids) in by_collection {
        for batch in ids.chunks(500) {
            let placeholders = std::iter::repeat_n("?", batch.len())
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "DELETE FROM pending_embeds WHERE collection = ?1 AND chunk_id IN ({placeholders})"
            );
            let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(batch.len() + 1);
            values.push(collection);
            for id in batch {
                values.push(id);
            }
            deleted += tx.execute(&sql, rusqlite::params_from_iter(values))?;
        }
    }
    tx.commit()?;
    Ok(deleted)
}

/// 运行中的索引任务速率之和(块/秒);没有任务 / 旧库没有 rate 列时返回 `None`。
fn read_running_rate(path: &Path) -> Option<f64> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    conn.busy_timeout(std::time::Duration::from_secs(5)).ok()?;
    let mut statement = conn
        .prepare("SELECT rate FROM jobs WHERE state = 'running' AND kind = 'index'")
        .ok()?;
    let rates = statement
        .query_map([], |row| row.get::<_, Option<f64>>(0))
        .ok()?;
    let sum: f64 = rates
        .filter_map(|rate| rate.ok().flatten())
        .filter(|rate| *rate > 0.0)
        .sum();
    (sum > 0.0).then_some(sum)
}

/// 当前毫秒时间戳。
fn now_millis() -> kb_core::model::Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as kb_core::model::Millis)
        .unwrap_or(0)
}

/// 从 `meta.db` 只读取 `(collection, active_table, 全部 chunks id)`。
///
/// 用 `SQLITE_OPEN_READ_ONLY`，避免 `kb doctor` 在服务停机时顺手建出空库或改动 WAL。
/// 没有块的空 collection 也会返回一条空 id 列表，供上层区分「没有表」和「没有块」。
fn read_meta_chunks(path: &Path) -> rusqlite::Result<Vec<(String, String, Vec<String>)>> {
    let conn = rusqlite::Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let mut statement = conn.prepare(
        "SELECT c.name, c.active_table, k.id \
         FROM collections c LEFT JOIN chunks k ON k.collection = c.name \
         ORDER BY c.name, k.id",
    )?;
    let mut by_collection: BTreeMap<(String, String), Vec<String>> = BTreeMap::new();
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
        ))
    })?;
    for row in rows {
        let (collection, table, id) = row?;
        let entry = by_collection.entry((collection, table)).or_default();
        if let Some(id) = id {
            entry.push(id);
        }
    }
    Ok(by_collection
        .into_iter()
        .map(|((collection, table), ids)| (collection, table, ids))
        .collect())
}

/// 打印启动前设置的环境变量,便于确认它们确实指向本 `KB_HOME`。
fn env_summary() -> String {
    let value = |key: &str| std::env::var(key).unwrap_or_else(|_| "未设置".to_owned());
    format!(
        "LANCE_LANGUAGE_MODEL_HOME={} FASTEMBED_CACHE_DIR={} HF_HOME={}",
        value("LANCE_LANGUAGE_MODEL_HOME"),
        value("FASTEMBED_CACHE_DIR"),
        value("HF_HOME")
    )
}

fn config_path_note(paths: &KbPaths) -> String {
    let path = paths.config_file();
    if path.exists() {
        path.display().to_string()
    } else {
        format!("{} 不存在,使用默认配置", path.display())
    }
}

/// 目录可写 + jieba 词典写出(验收要求 `kb doctor` 能创建目录结构并写出词典)。
fn check_data_dir(report: &mut Report, paths: &KbPaths) {
    match crate::prepare(paths) {
        Ok(()) => {
            report.ok("数据目录", format!("{} 可写", paths.home().display()));
            let dict = paths.jieba_dir().join("dict.txt");
            match std::fs::metadata(&dict) {
                Ok(meta) => report.ok(
                    "jieba 词典",
                    format!("{} ({} 字节)", dict.display(), meta.len()),
                ),
                Err(err) => report.error("jieba 词典", format!("{} 不可用: {err}", dict.display())),
            }
        }
        Err(err) => report.error("数据目录", err.to_string()),
    }
}

/// g++ 与 libstdc++.so(链接必需,设计规范坑 2)。
fn check_toolchain(report: &mut Report) {
    let Some(version) = output_of("g++", &["--version"]) else {
        report.error(
            "g++",
            "未安装;链接需要 libstdc++.so,请执行 apt-get install -y g++",
        );
        return;
    };
    let version = version.lines().next().unwrap_or("g++").trim().to_owned();
    match output_of("g++", &["-print-file-name=libstdc++.so"]) {
        Some(found) if Path::new(found.trim()).is_absolute() => {
            report.ok("g++ / libstdc++", format!("{version}; {}", found.trim()));
        }
        _ => report.error(
            "libstdc++",
            format!("{version} 找不到 libstdc++.so,链接会失败:apt-get install -y g++"),
        ),
    }
}

/// `kb doctor backends`:内置条目 + `<KB_HOME>/backends/*/manifest.toml` 合成的清单。
///
/// 每条尽量跑一次 manifest 里声明的 `probe`。**探活失败不算 error**:没装某个后端是
/// 正常状态(用户可能就用内置那个),装没装的判据是「命令在不在 PATH 上」,
/// 退出码非 0 只写进说明(有些命令没有 `--version`,`--help` 也会返回 1)。
fn backends_report(paths: &KbPaths, json: bool) -> Result<ExitCode> {
    let registry = kb_core::backends::BackendRegistry::load(paths.home());
    let mut report = Report::default();
    report.note(
        "后端清单",
        format!(
            "{} 条(内置 {} / manifest {}) · 目录 {}",
            registry.len(),
            registry.len() - registry.manifest_count(),
            registry.manifest_count(),
            paths.backends_dir().display()
        ),
    );
    for entry in registry.list() {
        let manifest = &entry.manifest;
        let name = format!("{}/{}", manifest.kind.as_str(), manifest.id);
        let source = match &entry.source {
            kb_core::backends::BackendSource::Builtin => "内置".to_owned(),
            kb_core::backends::BackendSource::Manifest(path) => {
                format!("覆盖内置 · {}", path.display())
            }
        };
        let switch = if manifest.settings.is_empty() {
            String::new()
        } else {
            format!(" · 切换看 {}", manifest.settings.join(" / "))
        };
        match manifest.probe.as_deref() {
            Some(argv) if !argv.is_empty() => match probe(argv) {
                ProbeOutcome::Ready => {
                    report.ok(
                        &name,
                        format!("{} · 已装 · {source}{switch}", manifest.name),
                    );
                }
                ProbeOutcome::Present { code } => report.note(
                    &name,
                    format!(
                        "{} · 命令在,但 `{}` 退出码 {code}(可能不支持这个参数)· {source}{switch}",
                        manifest.name,
                        argv.join(" ")
                    ),
                ),
                ProbeOutcome::Missing(reason) => report.warn(
                    &name,
                    format!("{} · 未装:{reason} · {source}{switch}", manifest.name),
                ),
            },
            _ => report.note(
                &name,
                format!(
                    "{} · 没有独立命令,按配置判定 · {source}{switch}",
                    manifest.name
                ),
            ),
        }
    }
    // manifest 的问题单列在最后:它们不会让守护进程起不来,但必须让用户看见
    for warning in registry.warnings() {
        report.warn("manifest", warning);
    }
    if json {
        report.print_json();
    } else {
        report.print();
    }
    Ok(ExitCode::SUCCESS)
}

/// 探活结果。
enum ProbeOutcome {
    /// 命令跑起来了,退出码 0。
    Ready,
    /// 命令在,但退出码非 0(拿到的码)。
    Present { code: String },
    /// 命令根本没起来。
    Missing(String),
}

/// 跑一次探活命令(manifest 里的 `probe` 数组,argv 形式,不经 shell)。
fn probe(argv: &[String]) -> ProbeOutcome {
    let Some((program, rest)) = argv.split_first() else {
        return ProbeOutcome::Missing("probe 是空的".to_owned());
    };
    match Command::new(program)
        .args(rest)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(status) if status.success() => ProbeOutcome::Ready,
        Ok(status) => ProbeOutcome::Present {
            code: status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "被信号杀掉".to_owned()),
        },
        Err(err) => ProbeOutcome::Missing(format!("找不到命令 {program}:{err}")),
    }
}

/// OCR 资源参数:`[extract.ocr]` 三项,以及按本机核数算出来的**实际生效**名额。
///
/// `slots = 0` 是“按核数自动”(核数/4,夹 1..=4),光看配置看不出到底几份在并发,所以这里把算出来的值
/// 印出来。整份 `[extract]` 是启动时注入一次,改了要重启;重启前看到的仍是旧值,因此这条只报当前生效值。
fn check_ocr_limits(report: &mut Report, config: &Config) {
    let ocr = &config.extract.ocr;
    let cores = std::thread::available_parallelism()
        .map(|count| count.get())
        .unwrap_or(4);
    let slots = ocr.effective_slots(cores);
    let how = if ocr.slots == 0 {
        format!("按 {cores} 核自动")
    } else {
        "配置指定".to_owned()
    };
    let state = if config.extract.ocr_enabled {
        "开"
    } else {
        "关(扫描件只留占位提示)"
    };
    report.note(
        "OCR 资源",
        format!(
            "{state} · 后端 {} · 同时 {slots} 份({how})· 单份 {} 秒 / {} 页 · 改了要重启",
            config.extract.ocr_backend,
            ocr.budget().as_secs(),
            ocr.page_cap()
        ),
    );
}

/// 磁盘剩余空间。
fn check_disk(report: &mut Report, home: &Path) {
    let target = if home.exists() { home } else { Path::new(".") };
    let target_str = target.to_string_lossy().into_owned();
    let Some(out) = output_of("df", &["-Pk", &target_str]) else {
        report.warn("磁盘剩余", "df 不可用,跳过检查");
        return;
    };
    let available_kb = out
        .lines()
        .nth(1)
        .and_then(|line| line.split_whitespace().nth(3))
        .and_then(|value| value.parse::<u64>().ok());
    match available_kb {
        Some(kb) => {
            let bytes = kb.saturating_mul(1024);
            if bytes < MIN_FREE_DISK_BYTES {
                report.error(
                    "磁盘剩余",
                    format!(
                        "{} 只剩 {:.1}GB,低于 10GB 下限",
                        target_str,
                        bytes as f64 / 1024.0 / 1024.0 / 1024.0
                    ),
                );
            } else {
                report.ok(
                    "磁盘剩余",
                    format!(
                        "{:.1}GB 可用({target_str})",
                        bytes as f64 / 1024.0 / 1024.0 / 1024.0
                    ),
                );
            }
        }
        None => report.warn("磁盘剩余", format!("无法解析 df 输出:{out}")),
    }
}

/// 内存(加载 BGE-M3 后常驻 5–8GB)。
fn check_memory(report: &mut Report) {
    let total = meminfo_kb("MemTotal:");
    let available = meminfo_kb("MemAvailable:");
    match (total, available) {
        (Some(total), Some(available)) => {
            let detail = format!(
                "总 {:.1}GB,可用 {:.1}GB",
                kb_to_gb(total),
                kb_to_gb(available)
            );
            if available.saturating_mul(1024) < MIN_AVAILABLE_MEMORY_BYTES {
                report.warn(
                    "内存",
                    format!("{detail};可用内存偏低,建议开启 embed.idle_unload_minutes"),
                );
            } else {
                report.ok("内存", detail);
            }
        }
        _ => report.warn("内存", "无法读取 /proc/meminfo"),
    }
}

/// 核显(Vulkan)。识别不到只影响重排/加速,不影响索引与检索。
fn check_vulkan(report: &mut Report) {
    let output = output_of("vulkaninfo", &["--summary"]).or_else(|| output_of("vulkaninfo", &[]));
    match output {
        Some(text) => match device_name(&text) {
            Some(name) => report.ok("核显", name),
            None => report.warn("核显", "vulkaninfo 未列出设备,重排与加速将退回 CPU"),
        },
        None => report.warn(
            "核显",
            "vulkaninfo 不可用或未识别到核显(重排与加速将退回 CPU)",
        ),
    }
}

/// 模型缓存目录(设计规范已下载的 9.7GB 模型)。
fn check_models(report: &mut Report, paths: &KbPaths) {
    let dir = paths.models_dir();
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            let count = entries.filter_map(|entry| entry.ok()).count();
            if count == 0 {
                report.warn(
                    "模型缓存",
                    format!("{} 为空,首次使用会下载模型", dir.display()),
                );
            } else {
                report.ok("模型缓存", format!("{} ({} 项)", dir.display(), count));
            }
        }
        Err(_) => report.warn("模型缓存", format!("{} 不存在", dir.display())),
    }
}

/// 守护进程 socket 是否可连接(守护进程启动后才有意义,现在通常只是 warn)。
async fn check_socket(report: &mut Report, paths: &KbPaths) {
    let socket = paths.socket();
    if !socket.exists() {
        report.warn(
            "socket",
            format!("{} 不存在(守护进程未运行)", socket.display()),
        );
        return;
    }
    match tokio::net::UnixStream::connect(socket).await {
        Ok(_) => report.ok("socket", format!("{} 可连接", socket.display())),
        Err(err) => report.warn("socket", format!("{} 连接失败: {err}", socket.display())),
    }
}

/// 代理环境变量（设计规范）。
fn check_proxy(report: &mut Report, config: &Config) {
    match std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .ok()
        .filter(|value| !value.is_empty())
    {
        Some(proxy) => report.ok("代理", proxy),
        None => report.warn(
            "代理",
            "未设置 HTTPS_PROXY:huggingface.co / github.com 可能不可达",
        ),
    }

    let no_proxy = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    let has = |domain: &str| no_proxy.split(',').any(|item| item.trim() == domain);
    let mut missing: Vec<&str> = Vec::new();
    if !has(".hf.co") {
        missing.push(".hf.co");
    }
    if !has("crates.io") {
        missing.push("crates.io");
    }
    if missing.is_empty() {
        report.ok("NO_PROXY", no_proxy);
    } else {
        report.warn(
            "NO_PROXY",
            format!("缺少 {};建议先 source scripts/env.sh", missing.join(", ")),
        );
    }

    if std::env::var("HF_ENDPOINT").is_ok_and(|value| !value.is_empty()) {
        report.warn(
            "HF_ENDPOINT",
            "已设置;fastembed 走 hf-mirror 会报 Content-Range 错误,应取消该变量",
        );
    }

    if config.network.hf_cdn_direct {
        report.ok("hf_cdn_direct", "启动时已把 .hf.co 追加进 NO_PROXY");
    }
}

fn meminfo_kb(key: &str) -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    text.lines()
        .find(|line| line.starts_with(key))?
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

fn kb_to_gb(kb: u64) -> f64 {
    kb as f64 / 1024.0 / 1024.0
}

fn device_name(text: &str) -> Option<String> {
    text.lines()
        .find(|line| line.contains("deviceName"))
        .map(|line| line.split('=').nth(1).unwrap_or(line).trim().to_owned())
        .filter(|name| !name.is_empty())
}

/// 运行外部命令并捕获 stdout;非零退出码或命令不存在时返回 `None`。
fn output_of(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_meta(path: &Path) {
        let conn = rusqlite::Connection::open(path).expect("建测试库");
        conn.execute_batch(
            "CREATE TABLE collections (name TEXT PRIMARY KEY, active_table TEXT NOT NULL);\
             CREATE TABLE chunks (id TEXT PRIMARY KEY, collection TEXT NOT NULL);\
             INSERT INTO collections (name, active_table) VALUES ('proj_a', 'proj_a__v1');\
             INSERT INTO collections (name, active_table) VALUES ('proj_b', 'proj_b__v1');\
             INSERT INTO collections (name, active_table) VALUES ('proj_empty', 'proj_empty__v1');\
             INSERT INTO chunks (id, collection) VALUES ('a1', 'proj_a');\
             INSERT INTO chunks (id, collection) VALUES ('a2', 'proj_a');\
             INSERT INTO chunks (id, collection) VALUES ('b1', 'proj_b');",
        )
        .expect("写测试数据");
    }

    #[test]
    fn meta_chunks_reads_every_collection_including_empty_ones() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("meta.db");
        write_meta(&path);

        assert_eq!(
            read_meta_chunks(&path).expect("读 chunks"),
            vec![
                (
                    "proj_a".to_owned(),
                    "proj_a__v1".to_owned(),
                    vec!["a1".to_owned(), "a2".to_owned()]
                ),
                (
                    "proj_b".to_owned(),
                    "proj_b__v1".to_owned(),
                    vec!["b1".to_owned()]
                ),
                (
                    "proj_empty".to_owned(),
                    "proj_empty__v1".to_owned(),
                    Vec::new()
                ),
            ]
        );
    }

    #[test]
    fn meta_chunks_does_not_create_a_missing_database() {
        let dir = tempfile::tempdir().expect("临时目录");
        let path = dir.path().join("missing.db");
        assert!(read_meta_chunks(&path).is_err());
        assert!(!path.exists(), "只读检查不能顺手建出空 meta.db");
    }
}

#[cfg(test)]
mod queue_tests {
    use super::*;
    use kb_core::model::{ItemStatus, RecordKind, RecordRow};
    use kb_core::ports::VectorStore;

    fn row(id: &str, table: &str, pending: bool, hash: &str) -> RecordRow {
        RecordRow {
            id: id.to_owned(),
            collection: table.split("__").next().unwrap_or("demo").to_owned(),
            kind: RecordKind::Doc,
            lang: None,
            source: format!("docs/{id}.md"),
            start_line: Some(1),
            end_line: Some(1),
            symbol: None,
            title: None,
            text: format!("正文 {id}"),
            header: "demo".to_owned(),
            lex: format!("正文 {id}"),
            tags: Vec::new(),
            status: ItemStatus::Active,
            content_hash: format!("content-{id}"),
            meta_hash: format!("meta-{id}"),
            embed_input_hash: hash.to_owned(),
            updated_at: 1,
            anchor: None,
            vector: (!pending).then(|| vec![0.5; 4]),
        }
    }

    fn create_meta(path: &Path) {
        let conn = rusqlite::Connection::open(path).expect("meta");
        conn.execute_batch(
            "CREATE TABLE collections (name TEXT PRIMARY KEY, active_table TEXT NOT NULL);
             CREATE TABLE chunks (collection TEXT, id TEXT, embed_input_hash TEXT, path TEXT);
             CREATE TABLE pending_embeds (
                 collection TEXT, chunk_id TEXT, path TEXT, enqueued_at INTEGER,
                 PRIMARY KEY (collection, chunk_id)
             );",
        )
        .expect("schema");
    }

    #[test]
    fn error_samples_are_capped() {
        let one = vec!["a".to_owned()];
        assert_eq!(sample_list(&one), "a");
        let many: Vec<String> = (1..=8).map(|index| index.to_string()).collect();
        let text = sample_list(&many);
        assert!(text.starts_with("1、2、3、4、5"), "{text}");
        assert!(text.ends_with("(共 8 条)"), "{text}");
        assert!(!text.contains('6'), "只列前 5 条:{text}");
    }

    #[tokio::test]
    async fn queue_health_auto_drops_orphans_and_reports_unfixable_rows() {
        let dir = tempfile::tempdir().expect("tmp");
        let paths = KbPaths::from_home(dir.path());
        create_meta(paths.meta_db());
        let conn = rusqlite::Connection::open(paths.meta_db()).expect("meta");
        conn.execute(
            "INSERT INTO collections (name, active_table) VALUES ('demo', 'demo__fake4__v1')",
            [],
        )
        .expect("collection");
        for (id, hash) in [
            ("0000000000000000000000000000000b", "hash-b"),
            ("0000000000000000000000000000000c", "hash-c"),
            ("0000000000000000000000000000000d", "hash-d"),
            ("0000000000000000000000000000000e", "old-e"),
        ] {
            conn.execute(
                "INSERT INTO chunks (collection, id, embed_input_hash, path) VALUES ('demo', ?1, ?2, ?3)",
                rusqlite::params![id, hash, format!("docs/{id}.md")],
            )
            .expect("chunk");
        }
        for id in [
            "0000000000000000000000000000000a",
            "0000000000000000000000000000000b",
            "0000000000000000000000000000000c",
            "0000000000000000000000000000000d",
            "0000000000000000000000000000000e",
        ] {
            conn.execute(
                "INSERT INTO pending_embeds (collection, chunk_id, path, enqueued_at) VALUES ('demo', ?1, ?2, 1)",
                rusqlite::params![id, format!("docs/{id}.md")],
            )
            .expect("pending");
        }
        drop(conn);

        let store = kb_store_lance::LanceStore::connect(paths.lance_dir().to_string_lossy())
            .await
            .expect("lance");
        store
            .ensure_table("demo__fake4__v1", 4)
            .await
            .expect("table");
        store
            .upsert(
                "demo__fake4__v1",
                vec![
                    // b: 还在 pending,hash 一致
                    row(
                        "0000000000000000000000000000000b",
                        "demo__fake4__v1",
                        true,
                        "hash-b",
                    ),
                    // c: 已经 ready,队列是漏删
                    row(
                        "0000000000000000000000000000000c",
                        "demo__fake4__v1",
                        false,
                        "hash-c",
                    ),
                    // e: pending,但队列里的 hash 是旧的
                    row(
                        "0000000000000000000000000000000e",
                        "demo__fake4__v1",
                        true,
                        "new-e",
                    ),
                ],
            )
            .await
            .expect("rows");
        let fingerprints = store
            .list_fingerprints("demo__fake4__v1", Some("kind IN ('code', 'doc')"))
            .await
            .expect("fingerprints");
        let present = fingerprints
            .into_iter()
            .map(|fingerprint| fingerprint.id)
            .collect();
        let audits = vec![("demo".to_owned(), "demo__fake4__v1".to_owned(), present)];

        let mut report = Report::default();
        check_pending_queues(&mut report, &paths, &store, &audits).await;

        assert_eq!(report.queue.missing_meta_fixed, 1, "a 不在 chunks");
        assert_eq!(report.queue.stale_ready_fixed, 1, "c 已 ready");
        assert_eq!(report.queue.missing_lance, 1, "d 的向量行丢了");
        assert_eq!(report.queue.hash_mismatch, 1, "e 的 hash 不一致");
        assert_eq!(report.queue.chunks, 3, "剩下 b/d/e");
        assert_eq!(report.queue.files, 3);
        assert_eq!(report.errors, 1);
        // 能修的 a/c 已经出队,d 必须保留等重跑
        let conn = rusqlite::Connection::open(paths.meta_db()).expect("meta");
        let left: Vec<String> = conn
            .prepare("SELECT chunk_id FROM pending_embeds ORDER BY chunk_id")
            .expect("stmt")
            .query_map([], |row| row.get(0))
            .expect("query")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("rows");
        assert_eq!(left.len(), 3);
        assert!(!left.contains(&"0000000000000000000000000000000a".to_owned()));
        assert!(!left.contains(&"0000000000000000000000000000000c".to_owned()));
    }
}
