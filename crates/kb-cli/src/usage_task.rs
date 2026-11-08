//! 定时统计各知识库的磁盘占用(多用户设计说明),写进 `system.db` 的 `space_usage`。
//!
//! 数磁盘是纯 I/O 活:每一轮只量最久没量的一小批,每个之间歇一下,放进阻塞线程,
//! 不占异步线程,也不会因为上千个知识库同时被读而把磁盘顶满。顺手清掉过旧的 LLM 用量行。

use std::sync::Arc;
use std::time::Duration;

use kb_core::model::Millis;
use kb_core::paths::KbPaths;
use kb_meta::SystemStore;

/// 每一轮最多量几个知识库。
pub const PER_ROUND: u32 = 20;
/// LLM 用量行保留多少天。
const KEEP_LLM_DAYS: i64 = 40;

/// 量一轮。返回量了几个。单个知识库失败只记日志,不影响其余。
pub async fn measure_round(
    system: &Arc<SystemStore>,
    paths: &KbPaths,
    now: Millis,
    pause: Duration,
) -> usize {
    let ids = match system.spaces_by_staleness(PER_ROUND).await {
        Ok(ids) => ids,
        Err(err) => {
            tracing::warn!(error = %err, "读取待统计的知识库失败");
            return 0;
        }
    };
    let mut measured = 0;
    for id in ids {
        // 主知识库就是数据根目录本身(`for_space` 已处理)
        let Ok(space_paths) = paths.for_space(&id) else {
            tracing::warn!(space = %id, "知识库路径不合法,跳过统计");
            continue;
        };
        let usage =
            tokio::task::spawn_blocking(move || kb_service::storage::measure_space(&space_paths))
                .await;
        match usage {
            Ok(usage) => match system.save_space_usage(&id, usage, now).await {
                Ok(()) => measured += 1,
                Err(err) => tracing::warn!(space = %id, error = %err, "保存存储统计失败"),
            },
            Err(err) => tracing::warn!(space = %id, error = %err, "统计存储占用失败"),
        }
        tokio::time::sleep(pause).await;
    }
    // 旧的 LLM 用量行:额度只看当天,排行最多看近几周
    let cutoff = kb_service::llm_gate::day_text(now - KEEP_LLM_DAYS * 86_400_000);
    if let Err(err) = system.purge_llm_usage_before(&cutoff).await {
        tracing::warn!(error = %err, "清理旧的 LLM 用量失败");
    }
    measured
}

#[cfg(test)]
mod tests;
