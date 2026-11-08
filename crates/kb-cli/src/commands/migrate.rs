//! `kb migrate <collection> --to <embedder> [--dry-run]`。

use std::process::ExitCode;

use kb_core::config::Config;
use kb_core::paths::KbPaths;

use crate::error::CliError;
use crate::runtime::Embedded;

/// 执行。
pub async fn run(
    paths: &KbPaths,
    config: &Config,
    collection: &str,
    to: &str,
    dry_run: bool,
) -> Result<ExitCode, CliError> {
    let runtime = Embedded::open(paths, config, !dry_run).await?;
    let service = kb_service::migration::MigrationService::new(
        runtime.meta.clone(),
        runtime.store.clone(),
        runtime.embedder.clone(),
    )
    .with_write_gate(runtime.write_gate());
    if dry_run {
        let plan = service.plan(collection, to).await?;
        println!("collection:   {}", plan.collection);
        println!("表:           {} → {}", plan.from_table, plan.to_table);
        println!(
            "嵌入器:       {} → {}",
            plan.from_embedder, plan.to_embedder
        );
        println!(
            "需重嵌入:     {} 行({} 块 + {} 条 insight)",
            plan.rows,
            plan.rows - plan.insight_rows,
            plan.insight_rows
        );
        println!("估算耗时:     {} 秒", plan.estimated_seconds);
        if plan.can_switch_without_reembed {
            println!("提示:兼容组相同,可免迁移切换(先用 `kb eval` 确认 hit@5 下降 ≤ 0.02)");
        }
        return Ok(ExitCode::SUCCESS);
    }
    let report = service.run(collection, to, None).await?;
    // 切换之后才发现的问题(对账 / 补齐失败)要打出来,不能只留日志
    for warning in &report.warnings {
        println!("警告:{warning}");
    }
    println!(
        "迁移完成:{} 行({};含 insight 行),新表 {},旧表 {} 已退役",
        report.rows,
        if report.resumed { "续跑" } else { "全新" },
        report.to_table,
        report.retired_table
    );
    Ok(ExitCode::SUCCESS)
}
