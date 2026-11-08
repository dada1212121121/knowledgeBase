//! 分享相关数据的定时清理:到期的授权、很久没出现的游客、过期的游客流量记录。
//!
//! 授权到期本身不需要清理也不会生效(`role_of` 查询时就过滤了过期授权),清掉只是别让表无限长;
//! 游客 cookie 有效期 30 天,记录多留到 90 天,方便所有者在统计里还能看到最近的访客。

use kb_core::model::Millis;
use kb_meta::SystemStore;

/// 游客记录多久没出现就清掉(天)。
const KEEP_GUEST_DAYS: i64 = 90;
/// 游客流量按天的记录保留几天(上限只看当天,留几天方便排查)。
const KEEP_BYTES_DAYS: i64 = 7;

/// 跑一遍。每一项独立:一项失败只记日志,不挡住别的。返回 (授权, 游客, 流量记录) 各清了几条。
pub async fn run(system: &SystemStore, now: Millis) -> (usize, usize, usize) {
    let grants = system
        .purge_expired_grants(now)
        .await
        .inspect_err(|err| tracing::warn!(error = %err, "清理过期授权失败"))
        .unwrap_or(0);
    let guests = system
        .purge_stale_guests(now - KEEP_GUEST_DAYS * 86_400_000)
        .await
        .inspect_err(|err| tracing::warn!(error = %err, "清理旧游客记录失败"))
        .unwrap_or(0);
    let day = kb_service::llm_gate::day_text(now - KEEP_BYTES_DAYS * 86_400_000);
    let bytes = system
        .purge_link_bytes_before(&day)
        .await
        .inspect_err(|err| tracing::warn!(error = %err, "清理游客流量记录失败"))
        .unwrap_or(0);
    (grants, guests, bytes)
}

#[cfg(test)]
mod tests;
