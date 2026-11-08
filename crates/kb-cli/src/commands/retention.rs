//! `kb retention`:按 `[retention]` 的期限清历史表(默认只预览)。

use std::process::ExitCode;
use std::sync::Arc;

use kb_core::config::Config;
use kb_core::paths::KbPaths;
use kb_meta::SystemStore;

use crate::error::CliError;
use crate::retention::RetentionSweeper;

/// 手动入口:`kb retention prune`,默认只预览。
pub async fn prune(
    paths: &KbPaths,
    config: &Config,
    yes: bool,
    json: bool,
) -> Result<ExitCode, CliError> {
    let runtime = crate::runtime::Embedded::open(paths, config, false).await?;
    let system = SystemStore::open(paths.system_db())?;
    let sweeper = RetentionSweeper::new(
        runtime.meta.clone(),
        Arc::new(system),
        runtime.config.clone(),
    );
    let counts = sweeper.run(!yes).await?;
    if json {
        let payload: Vec<serde_json::Value> = counts
            .iter()
            .map(|(table, rows)| serde_json::json!({ "table": table, "rows": rows }))
            .collect();
        println!(
            "{}",
            serde_json::json!({ "dry_run": !yes, "tables": payload })
        );
        return Ok(ExitCode::SUCCESS);
    }
    let retention = &config.retention;
    println!(
        "期限:任务 {} 天 · 审计 {} 天 · 事件 {} 天 · 采样 {} 天(0 = 不清理)",
        retention.jobs_days,
        retention.audit_days,
        retention.events_days,
        retention.metric_samples_days
    );
    for (table, rows) in &counts {
        if yes {
            println!("已清理 {table}:{rows} 行");
        } else {
            println!("可清理 {table}:{rows} 行");
        }
    }
    if !yes {
        println!("以上只是预览。确认无误后加 --yes 才会删除(建议先 `kb backup create`)。");
    }
    Ok(ExitCode::SUCCESS)
}
