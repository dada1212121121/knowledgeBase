//! 全站时区(`[site] timezone`,默认 `Asia/Shanghai`)。
//!
//! 数据库里的时间一律是 Unix 毫秒,和时区无关;只有**给人看的时间**和**按自然日算的边界**
//! (每日额度、统计分桶、备份文件名、调度器“到点”)需要用站点时区。以前这些地方有的用
//! 浏览器本地、有的用服务器本地、有的写死 UTC,同一台机器上会看到三种口径。
//!
//! 这里保存一份进程内当前时区:守护进程启动与 `ConfigStore::replace` 时更新,热更新立即生效。
//! 单测默认就是 `Asia/Shanghai`,不依赖跑测试的机器设了什么 `TZ`。

use std::sync::{LazyLock, RwLock};

use chrono::{DateTime, Duration, NaiveDate, Offset, TimeZone, Timelike, Utc};
use chrono_tz::Tz;

use crate::{KbError, Result};

/// 默认时区:上海(北京时间,UTC+8)。
pub const DEFAULT_TIMEZONE: &str = "Asia/Shanghai";

fn default_tz() -> Tz {
    DEFAULT_TIMEZONE
        .parse()
        .expect("内置默认时区必须是合法的 IANA 名称")
}

static SITE_TIMEZONE: LazyLock<RwLock<Tz>> = LazyLock::new(|| RwLock::new(default_tz()));

/// 解析 IANA 时区名(如 `Asia/Shanghai`、`UTC`)。
pub fn parse(name: &str) -> Result<Tz> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(KbError::InvalidInput(
            "site.timezone 不能为空(默认 Asia/Shanghai)".to_owned(),
        ));
    }
    trimmed.parse::<Tz>().map_err(|_| {
        KbError::InvalidInput(format!(
            "site.timezone 不是合法的 IANA 时区名:{trimmed}(例如 Asia/Shanghai)"
        ))
    })
}

/// 换全站时区;配置校验保证名字合法。返回解析后的时区,方便调用方记日志。
pub fn set_site_timezone(name: &str) -> Result<Tz> {
    let tz = parse(name)?;
    let mut guard = SITE_TIMEZONE
        .write()
        .unwrap_or_else(|poison| poison.into_inner());
    *guard = tz;
    Ok(tz)
}

/// 当前全站时区。
pub fn site_timezone() -> Tz {
    *SITE_TIMEZONE
        .read()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// 某个瞬间在指定时区里的日期。
pub fn date_in(millis: i64, tz: Tz) -> NaiveDate {
    Utc.timestamp_millis_opt(millis)
        .single()
        .unwrap_or_else(Utc::now)
        .with_timezone(&tz)
        .date_naive()
}

/// 某个瞬间在指定时区里的 `YYYY-MM-DD`。
pub fn day_key_in(millis: i64, tz: Tz) -> String {
    date_in(millis, tz).format("%Y-%m-%d").to_string()
}

/// 当前时区里的 `YYYY-MM-DD`。
pub fn day_key(millis: i64) -> String {
    day_key_in(millis, site_timezone())
}

/// 今天(当前时区)`YYYY-MM-DD`。
pub fn today() -> String {
    day_key(now_millis())
}

/// `YYYY-MM-DD` 前后挪几天(纯日历运算,和时区无关)。解析失败原样返回,调用方不用为坏输入 panic。
pub fn shift_day(day: &str, delta: i64) -> String {
    NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map(|date| {
            (date + Duration::days(delta))
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_else(|_| day.to_owned())
}

/// 指定时区里某一天零点的 Unix 毫秒。
///
/// 夏令时切换那天零点可能不存在(有些地区跳过 00:00),这时取当天第一个存在的时刻。
pub fn day_start_in(millis: i64, tz: Tz) -> i64 {
    midnight_in(date_in(millis, tz), tz).unwrap_or_else(|| millis - 86_400_000)
}

/// `YYYY-MM-DD` 在站点时区里零点的 Unix 毫秒;日期不合法返回 `None`。
pub fn day_start_for(day: &str) -> Option<i64> {
    let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    midnight_in(date, site_timezone())
}

fn midnight_in(date: NaiveDate, tz: Tz) -> Option<i64> {
    for hour in 0..24 {
        let naive = date.and_hms_opt(hour, 0, 0)?;
        if let Some(local) = tz.from_local_datetime(&naive).earliest() {
            return Some(local.timestamp_millis());
        }
    }
    // 所有小时都不存在只可能是时区数据坏了
    None
}

/// 当前时区里某一天零点的 Unix 毫秒。
pub fn day_start(millis: i64) -> i64 {
    day_start_in(millis, site_timezone())
}

/// 当前时区里的“当天第几分钟”(0..1440)。
pub fn local_minutes(millis: i64) -> u32 {
    let local = Utc
        .timestamp_millis_opt(millis)
        .single()
        .unwrap_or_else(Utc::now)
        .with_timezone(&site_timezone());
    local.hour() * 60 + local.minute()
}

/// 当前时区里的日期。
pub fn local_date(millis: i64) -> NaiveDate {
    date_in(millis, site_timezone())
}

/// 某个瞬间相对 UTC 的偏移(秒,东八区是 28800)。
pub fn offset_seconds(millis: i64) -> i64 {
    offset_seconds_in(millis, site_timezone())
}

/// 指定时区在某个瞬间相对 UTC 的偏移(秒)。
pub fn offset_seconds_in(millis: i64, tz: Tz) -> i64 {
    i64::from(
        Utc.timestamp_millis_opt(millis)
            .single()
            .unwrap_or_else(Utc::now)
            .with_timezone(&tz)
            .offset()
            .fix()
            .local_minus_utc(),
    )
}

/// 某个瞬间相对 UTC 的偏移(毫秒;给任务 / 活动分桶的 SQL 用)。
pub fn offset_millis(millis: i64) -> i64 {
    offset_seconds(millis) * 1000
}

/// 偏移的人话:`UTC+8` / `UTC-5` / `UTC+5:30`。
pub fn offset_text(millis: i64) -> String {
    let seconds = offset_seconds(millis);
    let sign = if seconds < 0 { '-' } else { '+' };
    let minutes = seconds.abs() / 60;
    let (hours, rest) = (minutes / 60, minutes % 60);
    if rest == 0 {
        format!("UTC{sign}{hours}")
    } else {
        format!("UTC{sign}{hours}:{rest:02}")
    }
}

/// 给人看的时间:`2026-11-04 22:30 (UTC+8)`。
///
/// 带上偏移而不是只写“本地时间”:服务器和浏览器可能不在同一个时区,收件人要知道这是哪边的时间。
pub fn format_at(millis: i64) -> String {
    let tz = site_timezone();
    let local = Utc
        .timestamp_millis_opt(millis)
        .single()
        .unwrap_or_else(Utc::now)
        .with_timezone(&tz);
    format!(
        "{} ({})",
        local.format("%Y-%m-%d %H:%M"),
        offset_text(millis)
    )
}

/// 当前时间的 Unix 毫秒。
pub fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 当前时间(当前时区),给需要 `DateTime` 的调用方用。
pub fn now() -> DateTime<Tz> {
    Utc::now().with_timezone(&site_timezone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_shanghai_and_offsets_follow_the_instant() {
        assert_eq!(DEFAULT_TIMEZONE, "Asia/Shanghai");
        let tz = parse(DEFAULT_TIMEZONE).unwrap();
        assert_eq!(offset_text(0), "UTC+8", "默认时区就是北京时间");
        // 2026-10-28 23:59:59 UTC 已经是上海的 10-29 07:59:59
        let at = 1_793_231_999_000;
        assert_eq!(day_key_in(at, tz), "2026-10-29");
        assert_eq!(day_start_in(at, tz), 1_793_203_200_000, "上海 10-29 00:00");
    }

    #[test]
    fn day_start_handles_zones_that_skip_midnight_on_dst() {
        // 圣保罗 2018-11-04 00:00 直接跳到 01:00:当天第一个存在的时刻是 01:00
        let tz: Tz = "America/Sao_Paulo".parse().unwrap();
        let at = chrono::DateTime::parse_from_rfc3339("2018-11-04T12:00:00-03:00")
            .unwrap()
            .timestamp_millis();
        assert_eq!(day_key_in(at, tz), "2018-11-04");
        let start = day_start_in(at, tz);
        let local = Utc
            .timestamp_millis_opt(start)
            .single()
            .unwrap()
            .with_timezone(&tz);
        assert_eq!(
            local.format("%Y-%m-%d %H:%M").to_string(),
            "2018-11-04 01:00"
        );
    }

    #[test]
    fn invalid_timezone_names_are_rejected_with_a_useful_message() {
        assert!(parse("").is_err());
        assert!(parse("Shanghai").is_err());
        assert!(parse("Mars/Olympus").is_err());
        assert!(parse("Asia/Shanghai").is_ok());
        assert!(parse("UTC").is_ok());
    }
}
