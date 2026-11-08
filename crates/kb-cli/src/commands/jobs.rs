//! `kb jobs`:列出任务队列。

use std::process::ExitCode;

use kb_core::config::Config;
use kb_core::model::JobState;
use kb_core::paths::KbPaths;

use crate::error::CliError;
use crate::runtime::Embedded;

/// 列出任务。
pub async fn list(
    paths: &KbPaths,
    config: &Config,
    state: Option<String>,
    json: bool,
) -> Result<ExitCode, CliError> {
    let runtime = Embedded::open(paths, config, false).await?;
    let state = match state.as_deref() {
        Some("queued") => Some(JobState::Queued),
        Some("running") => Some(JobState::Running),
        Some("paused") => Some(JobState::Paused),
        Some("done") => Some(JobState::Done),
        Some("failed") => Some(JobState::Failed),
        Some("canceled") => Some(JobState::Canceled),
        Some(other) => {
            return Err(CliError::Kb(kb_core::KbError::InvalidInput(format!(
                "未知的任务状态 {other}"
            ))));
        }
        None => None,
    };
    // 只做展示,不读 payload / checkpoint 两个大列
    let jobs = runtime.queue().list_summaries(state).await?;
    if json {
        let values: Vec<serde_json::Value> = jobs
            .iter()
            .map(|job| {
                serde_json::json!({
                    "id": job.id,
                    "kind": job.kind,
                    "collection": job.collection,
                    "state": job.state.as_str(),
                    "priority": job.priority,
                    "progress_done": job.progress_done,
                    "progress_total": job.progress_total,
                    "rate": job.rate,
                    "created_at": job.created_at,
                    "finished_at": job.finished_at,
                    "error": job.error,
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string_pretty(&values).unwrap_or_default()
        );
        return Ok(ExitCode::SUCCESS);
    }
    if jobs.is_empty() {
        println!("没有任务。");
    } else {
        println!(
            "{:<38} {:<8} {:<10} {:>10}  状态",
            "id", "类型", "collection", "进度"
        );
        for job in jobs {
            let progress = match job.progress_total {
                Some(total) => format!("{}/{}", job.progress_done, total),
                None => job.progress_done.to_string(),
            };
            println!(
                "{:<38} {:<8} {:<10} {:>10}  {}",
                job.id,
                job.kind,
                job.collection.as_deref().unwrap_or("-"),
                progress,
                job.state.as_str()
            );
        }
    }
    // 队列状态单独一行:用户最关心的是「还有多少没补、要等多久」,不是 task 行数
    let pending = crate::pending::overview(runtime.meta.as_ref(), None).await?;
    print_pending(&pending);
    Ok(ExitCode::SUCCESS)
}

/// 打印待补向量队列:总数 + 最老等待时间 + ETA;有明细时按 collection 逐行列出。
fn print_pending(pending: &crate::pending::PendingOverview) {
    if pending.chunks == 0 {
        println!("待补向量: 无");
        return;
    }
    let oldest = pending
        .oldest_age_secs
        .map(crate::pending::format_duration)
        .unwrap_or_else(|| "未知".to_owned());
    println!(
        "待补向量: {} 块 / {} 个文件,最老已等 {oldest},{}",
        pending.chunks,
        pending.files,
        crate::pending::eta_text(pending)
    );
    for entry in &pending.collections {
        println!(
            "  {:<28} {:>8} 块 / {:>5} 个文件",
            entry.collection, entry.chunks, entry.files
        );
    }
}

/// 清理失败的历史任务。默认只预览,`--yes` 才真删;删除前不会自动备份,
/// 失败任务只是历史记录(payload 里的内容都能由项目重新索引得到),要留底请先 `kb backup create`。
pub async fn prune(
    paths: &KbPaths,
    config: &Config,
    older_than_hours: u32,
    yes: bool,
    json: bool,
) -> Result<ExitCode, CliError> {
    let runtime = Embedded::open(paths, config, false).await?;
    let before = now_millis() - i64::from(older_than_hours) * 3_600_000;
    let count = runtime.queue().prune_failed(before, !yes).await?;
    if json {
        println!(
            "{}",
            serde_json::json!({ "dry_run": !yes, "failed_jobs": count, "older_than_hours": older_than_hours })
        );
    } else if yes {
        println!("已清理 {count} 条失败任务(结束于 {older_than_hours} 小时前或更早)。");
    } else {
        println!(
            "预览:有 {count} 条失败任务可清理(结束于 {older_than_hours} 小时前或更早)。加 --yes 才会删除。"
        );
    }
    Ok(ExitCode::SUCCESS)
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
