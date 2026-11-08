//! 任务能力的参数与摘要(卡 A:任务页性能)。
//!
//! `job_get` 的 `brief` 模式:任务页的详情卡只需要「这个任务做了什么、做到哪了、出了什么错」,
//! 而索引任务的 `payload_json` 单条最大到 3.45 MB(里面是要索引的文件清单),整份发到浏览器毫无用处。
//! 摘要在能力层对 JSON 做,不改后端接口:数组只留前几项并写明总数,长字符串截断,嵌套太深的折掉。

use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// `job_get` 的参数。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct JobGetArgs {
    /// 任务 id。
    pub id: String,
    /// 只要摘要:不返回原始的 `payload_json` / `checkpoint_json`,
    /// 改成解析后的 `payload` / `checkpoint`,其中数组最多 10 项(超出时写成 `{total, items}`)、字符串最多 500 字。
    #[serde(default)]
    pub brief: bool,
}

/// `job_files` 的参数:任务详情里「改动的文件」清单,按页取。
///
/// 不塞进 `job_get`:一次全量索引可能几千个文件,摘要模式只留前 10 项;清单要分页、要统计,
/// 而且任务跑的过程中还在增长。
#[derive(Clone, Debug, Deserialize, JsonSchema)]
pub struct JobFilesArgs {
    /// 任务 id。
    pub id: String,
    /// 第几页(默认 1)。
    #[serde(default)]
    pub page: Option<u32>,
    /// 每页条数(默认 200,最大 200)。
    #[serde(default)]
    pub page_size: Option<u32>,
}

/// `job_stats` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct JobStatsArgs {
    /// 不统计这几种类型(AI 总开关关闭时,界面上不出现自动提炼 / 审核类任务,统计也要跟着排除)。
    #[serde(default)]
    pub exclude_kinds: Vec<String>,
    /// 只统计这个 collection 的任务。
    #[serde(default)]
    pub collection: Option<String>,
    /// 还要一份随时间变化的序列(吞吐、排队深度):`24h`(每小时一个点)/ `7d`(每 6 小时)/ `30d`(每天)。
    #[serde(default)]
    pub range: Option<String>,
}

/// `ingest_stats` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct IngestStatsArgs {
    /// 每小时一个点,看最近多少小时(默认 24,最多 72)。
    #[serde(default)]
    pub hours: Option<u32>,
}

/// `activity_series` 的参数。
#[derive(Clone, Debug, Default, Deserialize, JsonSchema)]
pub struct ActivitySeriesArgs {
    /// 最近多少天(默认 30,最多 90)。
    #[serde(default)]
    pub days: Option<u32>,
}

/// 任务序列的时间窗口:(第一个桶的起点, 桶宽, 桶数)。
///
/// 桶边界按服务器本地时区对齐(`offset_ms` 是本地时区相对 UTC 的偏移),最后一个桶包含 `now`。
/// 认不出的范围返回 `None`。
pub fn job_series_window(range: &str, now: i64, offset_ms: i64) -> Option<(i64, i64, usize)> {
    const HOUR: i64 = 3_600_000;
    let (step, count) = match range {
        "24h" => (HOUR, 24),
        "7d" => (6 * HOUR, 28),
        "30d" => (24 * HOUR, 30),
        _ => return None,
    };
    // 当前桶的末尾(本地时区下对齐到桶宽),往前数 count 个
    let end = ((now + offset_ms).div_euclid(step) + 1) * step - offset_ms;
    Some((end - step * count as i64, step, count))
}

/// 摘要里数组最多留几项。
pub const BRIEF_ITEMS: usize = 10;
/// 摘要里字符串最多留几个字。
pub const BRIEF_CHARS: usize = 500;
/// 摘要最多展开几层(再往下的写成「…」)。
const BRIEF_DEPTH: usize = 4;

fn summarize(value: Value, depth: usize) -> Value {
    if depth >= BRIEF_DEPTH && matches!(value, Value::Array(_) | Value::Object(_)) {
        return Value::String("…".to_owned());
    }
    match value {
        Value::String(text) => Value::String(clip(&text)),
        Value::Array(items) => {
            let total = items.len();
            let kept: Vec<Value> = items
                .into_iter()
                .take(BRIEF_ITEMS)
                .map(|item| summarize(item, depth + 1))
                .collect();
            if total > BRIEF_ITEMS {
                json!({ "total": total, "items": kept })
            } else {
                Value::Array(kept)
            }
        }
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, item)| (key, summarize(item, depth + 1)))
                .collect::<Map<_, _>>(),
        ),
        other => other,
    }
}

fn clip(text: &str) -> String {
    if text.chars().count() <= BRIEF_CHARS {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(BRIEF_CHARS).collect();
    out.push('…');
    out
}

/// 原始 JSON 文本 → 摘要;解析不了的按普通字符串截断,空的给 `null`。
fn brief_text(raw: Option<&Value>) -> Value {
    match raw {
        Some(Value::String(text)) if !text.is_empty() => match serde_json::from_str(text) {
            Ok(parsed) => summarize(parsed, 0),
            Err(_) => Value::String(clip(text)),
        },
        _ => Value::Null,
    }
}

/// 把 `job_get` 的结果(`{"job": {...}}`)换成摘要:去掉 `payload_json` / `checkpoint_json`,
/// 加上解析并截短后的 `payload` / `checkpoint`。形状不对的输入原样返回。
pub fn brief_job(mut found: Value) -> Value {
    let Some(job) = found.get_mut("job").and_then(Value::as_object_mut) else {
        return found;
    };
    let payload = brief_text(job.remove("payload_json").as_ref());
    let checkpoint = brief_text(job.remove("checkpoint_json").as_ref());
    job.insert("payload".to_owned(), payload);
    job.insert("checkpoint".to_owned(), checkpoint);
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn series_windows_end_with_the_bucket_that_holds_now_and_align_to_local_time() {
        let hour = 3_600_000;
        // 北京时间 2026-11-01 15:30(UTC 07:30):24 小时窗口的最后一个桶是 15:00–16:00
        let now = 1_793_518_200_000;
        let tz = 8 * hour;
        let (start, step, count) = job_series_window("24h", now, tz).expect("认得");
        assert_eq!((step, count), (hour, 24));
        let end = start + step * count as i64;
        assert!(
            start < now && now < end && end - now <= hour,
            "最后一个桶包含现在"
        );
        assert_eq!((end + tz) % hour, 0, "桶边界在本地整点上");
        // 30 天的桶是本地的自然日:边界在本地零点
        let (start30, step30, count30) = job_series_window("30d", now, tz).expect("认得");
        assert_eq!((step30, count30), (24 * hour, 30));
        assert_eq!((start30 + tz) % (24 * hour), 0, "第一个桶从本地零点开始");
        assert!(job_series_window("1y", now, tz).is_none());
        assert!(job_series_window("", now, tz).is_none());
    }

    #[test]
    fn brief_keeps_the_shape_but_drops_the_bulk() {
        let paths: Vec<String> = (0..5_000).map(|index| format!("src/f{index}.rs")).collect();
        let payload = json!({ "project_id": "p1", "mode": "full", "paths": paths }).to_string();
        let checkpoint = json!({
            "done": 12,
            "errors": 2,
            "error_samples": ["x".repeat(2_000), "短的"],
        })
        .to_string();
        let found = json!({ "job": {
            "id": "j1", "kind": "index", "state": "done",
            "payload_json": payload, "checkpoint_json": checkpoint,
        }});
        let raw_len = found.to_string().len();
        let brief = brief_job(found);
        let job = &brief["job"];
        assert!(job.get("payload_json").is_none() && job.get("checkpoint_json").is_none());
        assert_eq!(job["id"], "j1", "其他字段原样保留");
        assert_eq!(job["payload"]["mode"], "full");
        assert_eq!(job["payload"]["paths"]["total"], 5_000, "超长数组写明总数");
        assert_eq!(
            job["payload"]["paths"]["items"].as_array().map(Vec::len),
            Some(BRIEF_ITEMS)
        );
        assert_eq!(job["checkpoint"]["errors"], 2);
        let sample = job["checkpoint"]["error_samples"][0]
            .as_str()
            .expect("字符串");
        assert_eq!(
            sample.chars().count(),
            BRIEF_CHARS + 1,
            "截到 500 字加省略号"
        );
        assert_eq!(
            job["checkpoint"]["error_samples"][1], "短的",
            "短数组不改形状"
        );
        assert!(brief.to_string().len() * 50 < raw_len, "摘要比原文小得多");
    }

    #[test]
    fn brief_tolerates_empty_broken_and_deep_json() {
        let deep = json!({ "a": { "b": { "c": { "d": { "e": 1 } } } } }).to_string();
        let found = json!({ "job": { "payload_json": "", "checkpoint_json": "{不是 JSON" }});
        let brief = brief_job(found);
        assert_eq!(brief["job"]["payload"], Value::Null);
        assert_eq!(brief["job"]["checkpoint"], "{不是 JSON");
        let brief = brief_job(json!({ "job": { "payload_json": deep, "checkpoint_json": null }}));
        assert_eq!(
            brief["job"]["payload"]["a"]["b"]["c"]["d"], "…",
            "太深的折掉"
        );
        assert_eq!(brief["job"]["checkpoint"], Value::Null);
        // 形状不对的输入原样返回
        assert_eq!(brief_job(json!({ "x": 1 })), json!({ "x": 1 }));
    }
}
