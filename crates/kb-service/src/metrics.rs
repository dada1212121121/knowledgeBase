//! 资源采样器(卡 D):每 10 秒读一次 /proc,算出本机和本服务进程的占用,
//! 攒在内存环形缓冲里(最近 1 小时),并在每满一分钟时聚合成一行交给调用方落库。
//!
//! 为什么有它:系统状态页的「处理器使用率」原来读一次 /proc/stat 算的是**开机以来的平均**(不是现在),
//! 也没有任何历史,资源页只能画「现在」。这里用相邻两次读数的差值算当前使用率。
//!
//! 分层:解析函数和 [`Sampler`] 是纯计算(吃文本和数字,方便单测);读文件和 `df` 在 [`read_now`];
//! 落库和定时调度在 kb-cli(守护进程)里,kb-service 不依赖 kb-meta。

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use kb_core::model::MetricRow;

/// 环形缓冲的容量:10 秒一个点,最近 1 小时。
pub const RING_CAP: usize = 360;
/// 采样间隔。
pub const SAMPLE_EVERY_SECS: u64 = 10;
const MINUTE: i64 = 60_000;

/// 一次原始读数(还没算差值)。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Reading {
    /// 读数时间(毫秒)。
    pub at: i64,
    /// /proc/stat 第一行:空闲(idle + iowait)的 jiffies。
    pub cpu_idle: u64,
    /// /proc/stat 第一行:全部 jiffies。
    pub cpu_total: u64,
    /// 本进程累计 CPU jiffies(utime + stime)。
    pub proc_ticks: u64,
    /// 本进程常驻内存(字节)。
    pub proc_rss: u64,
    /// 内存总量(字节)。
    pub mem_total: u64,
    /// 可用内存(字节,含可回收缓存)。
    pub mem_available: u64,
    /// 1 分钟平均负载。
    pub load1: f64,
    /// 数据盘已用(字节)。
    pub disk_used: u64,
    /// 数据盘总量(字节)。
    pub disk_total: u64,
}

/// 环形缓冲里的一个点(已经是「当前使用率」)。
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    /// 时间(毫秒)。
    pub at: i64,
    /// 本机 CPU 使用率 0–1(与上一次读数的差值)。
    pub cpu: f64,
    /// 已用内存(字节)。
    pub mem_used: u64,
    /// 内存总量(字节)。
    pub mem_total: u64,
    /// 1 分钟平均负载。
    pub load1: f64,
    /// 本进程占整机 CPU 的比例 0–1。
    pub proc_cpu: f64,
    /// 本进程常驻内存(字节)。
    pub proc_rss: u64,
    /// 数据盘已用(字节)。
    pub disk_used: u64,
    /// 数据盘总量(字节)。
    pub disk_total: u64,
}

impl Sample {
    /// 转成接口 / 落库用的行(环形缓冲里的点没有「一分钟内的最大值」,最大值就是它自己)。
    pub fn as_row(&self) -> MetricRow {
        MetricRow {
            at: self.at,
            cpu: self.cpu,
            cpu_max: self.cpu,
            mem_used: self.mem_used,
            mem_total: self.mem_total,
            load1: self.load1,
            disk_used: self.disk_used,
            disk_total: self.disk_total,
            proc_cpu: self.proc_cpu,
            proc_rss: self.proc_rss,
        }
    }
}

/* ------------------------------------------------------------------ 解析 */

/// /proc/stat 的第一行 `cpu  user nice system idle iowait irq softirq steal ...` → (空闲, 全部)。
pub fn parse_stat(text: &str) -> Option<(u64, u64)> {
    let line = text.lines().find(|line| line.starts_with("cpu "))?;
    let values: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|value| value.parse().ok())
        .collect();
    if values.len() < 4 {
        return None;
    }
    // guest / guest_nice 已经算在 user / nice 里,不重复加:只取前 8 项
    let total: u64 = values.iter().take(8).sum();
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    Some((idle, total))
}

/// /proc/meminfo → (MemTotal, MemAvailable),字节。
pub fn parse_meminfo(text: &str) -> Option<(u64, u64)> {
    let read = |key: &str| -> Option<u64> {
        text.lines().find_map(|line| {
            let rest = line.strip_prefix(key)?;
            rest.trim()
                .trim_end_matches("kB")
                .trim()
                .parse::<u64>()
                .ok()
                .map(|kb| kb * 1024)
        })
    };
    Some((read("MemTotal:")?, read("MemAvailable:")?))
}

/// /proc/loadavg 的第一项。
pub fn parse_loadavg(text: &str) -> Option<f64> {
    text.split_whitespace().next()?.parse().ok()
}

/// /proc/self/stat → (utime + stime, 常驻页数)。
///
/// 第 2 项是括号括起来的进程名,里面可能有空格和括号,所以从**最后一个** `)` 之后开始数字段:
/// 之后第 1 项是状态(第 3 项),utime 是第 14 项、stime 第 15 项、rss 第 24 项。
pub fn parse_self_stat(text: &str) -> Option<(u64, u64)> {
    let after = text.rsplit_once(')')?.1;
    let fields: Vec<&str> = after.split_whitespace().collect();
    // fields[0] 是第 3 项(状态),所以第 N 项在 fields[N - 3]
    let utime: u64 = fields.get(14 - 3)?.parse().ok()?;
    let stime: u64 = fields.get(15 - 3)?.parse().ok()?;
    let rss_pages: u64 = fields.get(24 - 3)?.parse().ok()?;
    Some((utime + stime, rss_pages))
}

/// `df -kP <路径>` 的输出 → (已用, 总量),字节。
pub fn parse_df(text: &str) -> Option<(u64, u64)> {
    let line = text.lines().nth(1)?;
    let fields: Vec<&str> = line.split_whitespace().collect();
    let total: u64 = fields.get(1)?.parse().ok()?;
    let used: u64 = fields.get(2)?.parse().ok()?;
    Some((used * 1024, total * 1024))
}

/* ------------------------------------------------------------------ 采样器 */

/// 一分钟内的累加。
#[derive(Clone, Copy, Debug, Default)]
struct Minute {
    start: i64,
    count: u32,
    cpu_sum: f64,
    cpu_max: f64,
    proc_cpu_sum: f64,
    last: Sample,
}

/// 采样器:吃原始读数,吐当前使用率,攒环形缓冲,每满一分钟吐一行聚合。
#[derive(Debug, Default)]
pub struct Sampler {
    prev: Option<Reading>,
    ring: VecDeque<Sample>,
    minute: Option<Minute>,
}

impl Sampler {
    /// 新建。
    pub fn new() -> Self {
        Self::default()
    }

    /// 放进一次读数。第一次(没有上一次可比)只记下,不产出点。
    /// 返回值是**刚刚结束的那一分钟**的聚合行(跨过分钟边界时才有)。
    pub fn push(&mut self, reading: Reading) -> Option<MetricRow> {
        let previous = self.prev.replace(reading)?;
        let d_total = reading.cpu_total.saturating_sub(previous.cpu_total);
        // 时间没走(同一次读了两遍)或计数器回绕:这个点作废,不污染图
        if d_total == 0 || reading.at <= previous.at {
            return None;
        }
        let d_idle = reading
            .cpu_idle
            .saturating_sub(previous.cpu_idle)
            .min(d_total);
        let cpu = 1.0 - d_idle as f64 / d_total as f64;
        let proc_cpu = (reading.proc_ticks.saturating_sub(previous.proc_ticks) as f64
            / d_total as f64)
            .clamp(0.0, 1.0);
        let sample = Sample {
            at: reading.at,
            cpu,
            mem_used: reading.mem_total.saturating_sub(reading.mem_available),
            mem_total: reading.mem_total,
            load1: reading.load1,
            proc_cpu,
            proc_rss: reading.proc_rss,
            disk_used: reading.disk_used,
            disk_total: reading.disk_total,
        };
        if self.ring.len() == RING_CAP {
            self.ring.pop_front();
        }
        self.ring.push_back(sample);
        self.accumulate(sample)
    }

    fn accumulate(&mut self, sample: Sample) -> Option<MetricRow> {
        let start = sample.at / MINUTE * MINUTE;
        let finished = match self.minute {
            Some(current) if current.start != start => Some(current),
            _ => None,
        };
        let mut current = match self.minute {
            Some(current) if current.start == start => current,
            _ => Minute {
                start,
                ..Minute::default()
            },
        };
        current.count += 1;
        current.cpu_sum += sample.cpu;
        current.cpu_max = current.cpu_max.max(sample.cpu);
        current.proc_cpu_sum += sample.proc_cpu;
        current.last = sample;
        self.minute = Some(current);
        finished.map(Self::row_of)
    }

    fn row_of(minute: Minute) -> MetricRow {
        let n = f64::from(minute.count.max(1));
        MetricRow {
            at: minute.start,
            cpu: minute.cpu_sum / n,
            cpu_max: minute.cpu_max,
            mem_used: minute.last.mem_used,
            mem_total: minute.last.mem_total,
            load1: minute.last.load1,
            disk_used: minute.last.disk_used,
            disk_total: minute.last.disk_total,
            proc_cpu: minute.proc_cpu_sum / n,
            proc_rss: minute.last.proc_rss,
        }
    }

    /// 最新一个点。
    pub fn latest(&self) -> Option<Sample> {
        self.ring.back().copied()
    }

    /// `since` 之后的点(升序)。
    pub fn since(&self, since: i64) -> Vec<Sample> {
        self.ring
            .iter()
            .filter(|sample| sample.at >= since)
            .copied()
            .collect()
    }
}

/// 共享的采样器:守护进程里的采样任务写,能力层读。
#[derive(Clone, Debug, Default)]
pub struct MetricsHub {
    inner: Arc<Mutex<Sampler>>,
    cores: Arc<std::sync::atomic::AtomicUsize>,
}

impl MetricsHub {
    /// 新建。
    pub fn new() -> Self {
        let hub = Self::default();
        hub.cores.store(
            std::thread::available_parallelism().map_or(1, usize::from),
            std::sync::atomic::Ordering::Relaxed,
        );
        hub
    }

    /// 放进一次读数,返回刚结束的那一分钟(如果有)。
    pub fn push(&self, reading: Reading) -> Option<MetricRow> {
        let row = self
            .inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(reading);
        if let Some(sample) = self.latest() {
            set_latest_cpu(sample.cpu);
        }
        row
    }

    /// 最新一个点。
    pub fn latest(&self) -> Option<Sample> {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .latest()
    }

    /// `since` 之后的点。
    pub fn since(&self, since: i64) -> Vec<Sample> {
        self.inner
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .since(since)
    }

    /// CPU 核数。
    pub fn cores(&self) -> usize {
        self.cores.load(std::sync::atomic::Ordering::Relaxed).max(1)
    }
}

/* ------------------------------------------------------------------ 范围 */

/// 能力 `metrics_series` 的时间范围。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range {
    /// 名字:`1h` / `24h` / `7d` / `30d`。
    pub name: &'static str,
    /// 覆盖多久(毫秒)。
    pub window_ms: i64,
    /// 一个点代表多久(毫秒);1 小时直接用 10 秒的原始点(`SAMPLE_EVERY_SECS`)。
    pub step_ms: i64,
}

/// 认得的范围;每个范围最多 720 个点。
pub const RANGES: [Range; 4] = [
    Range {
        name: "1h",
        window_ms: 3_600_000,
        step_ms: 10_000,
    },
    Range {
        name: "24h",
        window_ms: 24 * 3_600_000,
        step_ms: 2 * MINUTE,
    },
    Range {
        name: "7d",
        window_ms: 7 * 86_400_000,
        step_ms: 15 * MINUTE,
    },
    Range {
        name: "30d",
        window_ms: 30 * 86_400_000,
        step_ms: 60 * MINUTE,
    },
];

/// 范围名 → 规格;不认识的返回 `None`。
pub fn range_of(name: &str) -> Option<Range> {
    RANGES.iter().copied().find(|range| range.name == name)
}

/* ------------------------------------------------------------------ 读取 */

/// 读一次 /proc 和数据盘。任何一项读不到都返回 `None`(不是 Linux 或权限不够:这一拍跳过)。
pub fn read_now(now: i64, data_dir: &Path) -> Option<Reading> {
    let (cpu_idle, cpu_total) = parse_stat(&std::fs::read_to_string("/proc/stat").ok()?)?;
    let (mem_total, mem_available) =
        parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)?;
    let load1 = parse_loadavg(&std::fs::read_to_string("/proc/loadavg").ok()?).unwrap_or_default();
    let (proc_ticks, rss_pages) =
        parse_self_stat(&std::fs::read_to_string("/proc/self/stat").ok()?)?;
    // 页大小在 Linux 上基本都是 4096;读不到 sysconf 时按它算(常驻内存只用来画趋势,差一个页大小不影响判断)
    let (disk_used, disk_total) = disk_cached(data_dir, now);
    Some(Reading {
        at: now,
        cpu_idle,
        cpu_total,
        proc_ticks,
        proc_rss: rss_pages * 4096,
        mem_total,
        mem_available,
        load1,
        disk_used,
        disk_total,
    })
}

/// 磁盘用量一分钟才问一次(`df` 要起子进程,10 秒一次太勤);其余时候用上次的值。
fn disk_cached(path: &Path, now: i64) -> (u64, u64) {
    static CACHE: Mutex<Option<(i64, u64, u64)>> = Mutex::new(None);
    let mut guard = CACHE.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some((at, used, total)) = *guard
        && now - at < MINUTE
    {
        return (used, total);
    }
    let output = std::process::Command::new("df")
        .arg("-kP")
        .arg(path)
        .output()
        .ok();
    let parsed = output
        .and_then(|output| parse_df(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default();
    *guard = Some((now, parsed.0, parsed.1));
    parsed
}

/// 采样器最近一次算出的本机 CPU 使用率(f64 位模式;没采到过是 `u64::MAX`)。
static LATEST_CPU: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(u64::MAX);

fn set_latest_cpu(cpu: f64) {
    LATEST_CPU.store(cpu.to_bits(), std::sync::atomic::Ordering::Relaxed);
}

/// 采样器最近一次算出的本机 CPU 使用率;守护进程没跑采样器(嵌入式命令行)时是 `None`。
pub fn latest_cpu() -> Option<f64> {
    let bits = LATEST_CPU.load(std::sync::atomic::Ordering::Relaxed);
    (bits != u64::MAX).then(|| f64::from_bits(bits))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(at: i64, idle: u64, total: u64, ticks: u64) -> Reading {
        Reading {
            at,
            cpu_idle: idle,
            cpu_total: total,
            proc_ticks: ticks,
            proc_rss: 1 << 30,
            mem_total: 64 << 30,
            mem_available: 24 << 30,
            load1: 2.0,
            disk_used: 100 << 30,
            disk_total: 500 << 30,
        }
    }

    #[test]
    fn proc_files_parse() {
        let stat = "cpu  100 10 50 800 40 5 5 0 7 0\ncpu0 1 1 1 1 1 1 1 0 0 0\n";
        // idle + iowait = 840;全部只算前 8 项(guest 已在 user 里)= 100+10+50+800+40+5+5+0
        assert_eq!(parse_stat(stat), Some((840, 1010)));
        assert_eq!(parse_stat("cpu0 1 2 3 4\n"), None, "只认汇总行");
        assert_eq!(parse_stat("cpu  1 2\n"), None, "字段不够不猜");

        let meminfo = "MemTotal:       65536000 kB\nMemFree: 1 kB\nMemAvailable:   24576000 kB\n";
        assert_eq!(
            parse_meminfo(meminfo),
            Some((65_536_000 * 1024, 24_576_000 * 1024))
        );
        assert_eq!(parse_meminfo("MemTotal: 1 kB\n"), None);

        assert_eq!(parse_loadavg("2.50 1.80 1.10 3/812 99999\n"), Some(2.5));
        assert_eq!(parse_loadavg(""), None);

        assert_eq!(
            parse_df(
                "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda1 1000 400 600 40% /\n"
            ),
            Some((400 * 1024, 1000 * 1024))
        );
        assert_eq!(parse_df("Filesystem\n"), None);
    }

    #[test]
    fn self_stat_survives_a_process_name_with_spaces_and_parens() {
        // 第 2 项 (kb daemon (x)) 里有空格和括号;第 14/15 项 utime/stime = 700/300,第 24 项 rss = 5000
        let text =
            "123 (kb daemon (x)) S 1 2 3 4 5 6 7 8 9 10 700 300 0 0 20 0 8 0 100 200 5000 rest\n";
        assert_eq!(parse_self_stat(text), Some((1000, 5000)));
        assert_eq!(parse_self_stat("garbage"), None);
    }

    #[test]
    fn cpu_is_the_difference_between_two_readings_not_the_average_since_boot() {
        let mut sampler = Sampler::new();
        // 开机以来几乎一直闲着(累计使用率约 5%),但最近这 10 秒忙了一半
        assert!(
            sampler.push(reading(0, 9_500, 10_000, 0)).is_none(),
            "第一次只记下,没有差值"
        );
        sampler.push(reading(10_000, 9_550, 10_100, 25));
        let sample = sampler.latest().expect("有点");
        assert!(
            (sample.cpu - 0.5).abs() < 1e-9,
            "最近 10 秒忙了一半,而不是累计的 5%:{}",
            sample.cpu
        );
        assert!(
            (sample.proc_cpu - 0.25).abs() < 1e-9,
            "本进程占整机的 25%:{}",
            sample.proc_cpu
        );
        assert_eq!(sample.mem_used, 40 << 30, "已用 = 总量 - 可用");
    }

    #[test]
    fn bad_readings_are_dropped_instead_of_polluting_the_chart() {
        let mut sampler = Sampler::new();
        sampler.push(reading(0, 100, 1_000, 0));
        sampler.push(reading(0, 100, 1_000, 0));
        assert!(sampler.latest().is_none(), "时间没走、计数没动的读数作废");
        sampler.push(reading(10_000, 50, 900, 0));
        assert!(sampler.latest().is_none(), "计数器倒退(回绕)作废");
        sampler.push(reading(20_000, 100, 1_100, 0));
        assert!(sampler.latest().is_some());
    }

    #[test]
    fn a_minute_row_comes_out_when_the_next_minute_starts_with_avg_and_peak() {
        let mut sampler = Sampler::new();
        let mut rows = Vec::new();
        // 每 10 秒一次;每次全部 jiffies 涨 100,idle 涨 (100 - 忙的)
        let busy = [10u64, 30, 50, 70, 90, 20];
        let (mut idle, mut total, mut at) = (0u64, 0u64, 60_000i64);
        rows.extend(sampler.push(reading(at - 10_000, idle, total, 0)));
        for step in busy {
            at += 10_000;
            idle += 100 - step;
            total += 100;
            rows.extend(sampler.push(reading(at, idle, total, 0)));
        }
        // 再往后跨过下一个整分钟(第 7 次读数落在 2 分钟起点之后)
        at += 10_000;
        idle += 50;
        total += 100;
        rows.extend(sampler.push(reading(at, idle, total, 0)));
        assert_eq!(rows.len(), 1, "只有跨过分钟边界才吐一行:{rows:?}");
        let row = rows[0];
        assert_eq!(row.at, 60_000, "行的时间是那一分钟的起点");
        assert!(
            row.cpu_max >= 0.9 - 1e-9 && row.cpu_max <= 0.9 + 1e-9,
            "最大值:{}",
            row.cpu_max
        );
        assert!(row.cpu > 0.2 && row.cpu < 0.9, "平均值:{}", row.cpu);
    }

    #[test]
    fn the_ring_keeps_only_the_last_hour() {
        let mut sampler = Sampler::new();
        let (mut idle, mut total) = (0u64, 0u64);
        for step in 0..(RING_CAP as i64 + 50) {
            idle += 80;
            total += 100;
            sampler.push(reading(step * 10_000, idle, total, 0));
        }
        let all = sampler.since(0);
        assert_eq!(all.len(), RING_CAP);
        assert!(all.windows(2).all(|pair| pair[0].at < pair[1].at), "升序");
        assert_eq!(sampler.since(all[all.len() - 1].at).len(), 1);
    }

    #[test]
    fn ranges_have_at_most_720_points_and_unknown_names_are_rejected() {
        for range in RANGES {
            assert!(
                range.window_ms / range.step_ms <= 720,
                "{} 超过 720 点",
                range.name
            );
        }
        assert_eq!(range_of("24h").map(|range| range.step_ms), Some(120_000));
        assert!(range_of("1y").is_none());
        assert!(range_of("").is_none());
    }

    #[test]
    fn the_hub_publishes_the_latest_cpu_for_the_status_page() {
        let hub = MetricsHub::new();
        hub.push(reading(0, 0, 0, 0));
        hub.push(reading(10_000, 25, 100, 0));
        assert!((latest_cpu().expect("采到过") - 0.75).abs() < 1e-9);
        assert!(hub.cores() >= 1);
    }
}
