//! 系统状态(`/system` 页六个 Tab 的数据源)。
//!
//! 六块:**总览 / 资源 / 组件 / 任务 / 网络 / 日志**。原则:
//! - 能采到的采真实值(`/proc`、`df`、SQLite 计数、LanceDB 行数);
//! - 采不到的字段**留空并标注原因**,绝不编数(比如 GPU 利用率目前只有存在性判断);
//! - 每块都是“若干小卡”的结构,UI 按卡片网格排,不拼大表。

use std::path::Path;
use std::sync::Arc;

use kb_core::config::Config;
use kb_core::model::IngestFilter;
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{
    CollectionRepo, DraftRepo, IngestRepo, JobRepo, LlmUsageRepo, MetaStore, SourceRepo,
};
use serde::Serialize;

use crate::providers::{EnvProfile, Provider, ProviderCatalog};

/// 服务概况。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ServiceInfo {
    /// 版本。
    pub version: String,
    /// 已运行秒数(拿不到就是 `None`)。
    pub uptime_seconds: Option<u64>,
    /// `KB_HOME`。
    pub home: String,
    /// 监听地址。
    pub listen: String,
}

/// CPU 概况。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct CpuInfo {
    /// 逻辑核数。
    pub cores: usize,
    /// 自启动以来的平均使用率(0..1;不是瞬时值,避免两次采样)。
    pub busy_ratio: f64,
    /// 1 / 5 / 15 分钟负载。
    pub load: [f64; 3],
}

/// 内存概况。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct MemoryInfo {
    /// 总量(MB)。
    pub total_mb: u64,
    /// 可用(MB)。
    pub available_mb: u64,
    /// 已用比例(0..1)。
    pub used_ratio: f64,
}

/// 磁盘概况。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct DiskInfo {
    /// 挂载点。
    pub mount: String,
    /// 可用(GB)。
    pub free_gb: u64,
    /// 总容量(GB)。
    pub total_gb: u64,
    /// 已用比例。
    pub used_ratio: f64,
}

/// GPU 概况(没有就全空)。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct GpuInfo {
    /// 名称。
    pub name: Option<String>,
    /// 利用率(0..1;当前没有采集,恒为 `None`)。
    pub utilization: Option<f64>,
    /// 显存已用(MB;同上)。
    pub memory_used_mb: Option<u64>,
    /// 说明(为什么某些字段是空的)。
    pub note: Option<String>,
}

/// 资源总览。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ResourceInfo {
    /// CPU。
    pub cpu: CpuInfo,
    /// 内存。
    pub memory: MemoryInfo,
    /// 磁盘。
    pub disk: DiskInfo,
    /// GPU。
    pub gpu: GpuInfo,
}

/// 任务队列概况。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct JobsInfo {
    /// 各状态任务数(queued / running / paused / done / failed / canceled)。
    pub by_state: Vec<(String, u64)>,
    /// 最近的任务。
    pub recent: Vec<JobBrief>,
    /// 解析队列:待处理 / 进行中 / 已完成 / 跳过 / 隔离 / 失败。
    pub ingest: Vec<(String, u64)>,
}

/// 一条任务摘要。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct JobBrief {
    /// id。
    pub id: String,
    /// 类型。
    pub kind: String,
    /// 状态。
    pub state: String,
    /// 进度。
    pub done: u64,
    /// 总量。
    pub total: Option<u64>,
    /// 更新时间。
    pub updated_at: i64,
}

/// 网络概况。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct NetworkInfo {
    /// 监听地址。
    pub listen: String,
    /// Unix socket。
    pub socket: String,
    /// 是否允许远程访问。
    pub allow_remote: bool,
    /// MCP 传输方式。
    pub mcp_transports: Vec<String>,
    /// `/mcp` 允许的 Host。
    pub mcp_allowed_hosts: Vec<String>,
    /// 今日 LLM 外发次数。
    pub llm_calls_today: u64,
    /// 今日输入 / 输出 token。
    pub llm_tokens_today: (u64, u64),
    /// 今日外发字符数(来自 `llm_sends` 的近似:调用次数 × 平均字数拿不到,这里只报次数)。
    pub llm_sends_today: u64,
}

/// 日志概况。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct LogInfo {
    /// 日志目录。
    pub dir: String,
    /// 日志文件(名, 字节)。
    pub files: Vec<(String, u64)>,
    /// 最近若干行(默认 200)。
    pub tail: Vec<String>,
    /// 诊断包会包含的文件。
    pub diagnostics: Vec<String>,
}

/// 六块合起来。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct SystemStatus {
    /// 总览:服务 + 规模 + 组件健康摘要。
    pub overview: Overview,
    /// 资源。
    pub resources: ResourceInfo,
    /// 组件。
    pub components: Vec<Provider>,
    /// 环境画像(顶部“环境检测”)。
    pub env: EnvProfile,
    /// 任务。
    pub jobs: JobsInfo,
    /// 网络。
    pub network: NetworkInfo,
    /// 日志。
    pub logs: LogInfo,
}

/// 总览卡。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Overview {
    /// 服务。
    pub service: ServiceInfo,
    /// collection 数。
    pub collections: u64,
    /// 项目数。
    pub projects: u64,
    /// 数据源数。
    pub sources: u64,
    /// 待审草稿。
    pub pending_drafts: u64,
    /// 组件健康:`就绪 / 总数`。
    pub components_ready: (usize, usize),
    /// 一句话状态(有不可用组件时点名)。
    pub note: Option<String>,
}

/// 采集入口。
pub async fn collect(
    meta: Arc<dyn MetaStore>,
    config: &Config,
    paths: &KbPaths,
    log_tail: usize,
) -> kb_core::Result<SystemStatus> {
    let home = paths.home().to_path_buf();
    let config_cloned = config.clone();
    let paths_cloned = paths.clone();
    let (components, env, disk) = tokio::task::spawn_blocking(move || {
        let catalog = ProviderCatalog::new(config_cloned, paths_cloned);
        let components = catalog.list();
        let env = catalog.env_profile();
        let disk = disk_info(&home);
        (components, env, disk)
    })
    .await
    .map_err(|err| kb_core::KbError::Internal(format!("采集环境失败: {err}")))?;
    // CPU 使用率可能要阻塞 200 ms(没有采样器时现采),放进阻塞线程池
    let cpu = tokio::task::spawn_blocking(cpu_busy_ratio)
        .await
        .unwrap_or(0.0);
    let ready = components.iter().filter(|provider| provider.ready).count();
    let not_ready: Vec<String> = components
        .iter()
        .filter(|provider| !provider.ready)
        .map(|provider| format!("{}({})", provider.id, provider.kind.label()))
        .collect();

    let collections = CollectionRepo::list(meta.as_ref()).await?.len() as u64;
    let projects = kb_core::ports::repo::ProjectRepo::list(meta.as_ref())
        .await?
        .len() as u64;
    let sources = SourceRepo::list(meta.as_ref()).await?.len() as u64;
    let pending_drafts = DraftRepo::count(meta.as_ref(), None).await?;

    // 任务按状态在 SQL 里分组计数,最近 8 条只取摘要:不读 payload / checkpoint 两个大列
    let by_state = JobRepo::count_by_state(meta.as_ref())
        .await?
        .into_iter()
        .map(|(state, count)| (state.as_str().to_owned(), count))
        .collect::<Vec<_>>();
    let recent_jobs = JobRepo::recent_summaries(meta.as_ref(), 8).await?;
    let recent = recent_jobs
        .into_iter()
        .map(|job| JobBrief {
            id: job.id,
            kind: job.kind,
            state: job.state.as_str().to_owned(),
            done: job.progress_done,
            total: job.progress_total,
            updated_at: job.created_at,
        })
        .collect();

    let mut ingest = Vec::new();
    for state in [
        kb_core::model::IngestState::Queued,
        kb_core::model::IngestState::Extracting,
        kb_core::model::IngestState::Embedding,
        kb_core::model::IngestState::Done,
        kb_core::model::IngestState::Skipped,
        kb_core::model::IngestState::Quarantined,
        kb_core::model::IngestState::Failed,
    ] {
        let count = IngestRepo::count(
            meta.as_ref(),
            IngestFilter {
                collection: None,
                batch_id: None,
                source_id: None,
                state: Some(state),
            },
        )
        .await?;
        ingest.push((state.as_str().to_owned(), count));
    }

    let day = crate::llm_gate::today();
    let usages = LlmUsageRepo::usage_of_day(meta.as_ref(), &day).await?;
    let llm_calls_today = usages.iter().map(|usage| usage.calls as u64).sum();
    let llm_tokens_today = (
        usages.iter().map(|usage| usage.input_tokens).sum(),
        usages.iter().map(|usage| usage.output_tokens).sum(),
    );

    Ok(SystemStatus {
        overview: Overview {
            service: ServiceInfo {
                version: env!("CARGO_PKG_VERSION").to_owned(),
                uptime_seconds: process_uptime_seconds(),
                home: paths.home().display().to_string(),
                listen: config.server.listen.clone(),
            },
            collections,
            projects,
            sources,
            pending_drafts,
            components_ready: (ready, components.len()),
            note: (!not_ready.is_empty()).then(|| format!("不可用组件:{}", not_ready.join("、"))),
        },
        resources: resources(&env, disk, cpu),
        components,
        env,
        jobs: JobsInfo {
            by_state,
            recent,
            ingest,
        },
        network: NetworkInfo {
            listen: config.server.listen.clone(),
            socket: if config.server.socket.is_empty() {
                paths.socket().display().to_string()
            } else {
                config.server.socket.clone()
            },
            allow_remote: config.server.allow_remote,
            mcp_transports: config.mcp.transports.clone(),
            mcp_allowed_hosts: config.mcp.allowed_hosts.clone(),
            llm_calls_today,
            llm_tokens_today,
            llm_sends_today: llm_calls_today,
        },
        logs: logs(paths, log_tail),
    })
}

/// 资源(CPU / 内存 / 磁盘 / GPU)。
fn resources(env: &EnvProfile, disk: DiskInfo, busy_ratio: f64) -> ResourceInfo {
    ResourceInfo {
        cpu: CpuInfo {
            cores: env.cpu_cores,
            busy_ratio,
            load: load_average(),
        },
        memory: memory_info(),
        disk,
        gpu: GpuInfo {
            name: env.gpu.clone(),
            utilization: None,
            memory_used_mb: None,
            note: Some(
                "GPU 利用率 / 显存未采集(没有统一的跨厂商接口);当前只用它判断是否存在独显"
                    .to_owned(),
            ),
        },
    }
}

/// 日志目录与尾部。
fn logs(paths: &KbPaths, tail: usize) -> LogInfo {
    let dir = paths.logs_dir();
    let mut files = Vec::new();
    let mut tail_lines = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut paths_found: Vec<_> = entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| {
                let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
                name.starts_with("kb.log") || path.extension().is_some_and(|ext| ext == "log")
            })
            .collect();
        paths_found.sort();
        for path in &paths_found {
            let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
            files.push((
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                size,
            ));
        }
        // 取最后一个日志文件的尾部
        if let Some(last) = paths_found.last()
            && let Ok(text) = std::fs::read_to_string(last)
        {
            tail_lines = text
                .lines()
                .rev()
                .take(tail)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            tail_lines.reverse();
        }
    }
    LogInfo {
        dir: dir.display().to_string(),
        files,
        tail: tail_lines,
        diagnostics: vec![
            "config.toml(脱敏)".to_owned(),
            "meta.db 的 schema 版本与表统计".to_owned(),
            "最近 200 行日志".to_owned(),
            "组件检测结果".to_owned(),
        ],
    }
}

/// 现在的 CPU 使用率(0–1)。
///
/// 守护进程里有资源采样器时直接取它最近一次算的值(相邻两次读数的差值,即「这 10 秒」的使用率);
/// 没有(嵌入式命令行)时现采:隔 200 ms 读两次 `/proc/stat` 取差值,**会阻塞 200 ms**,
/// 异步环境里要放进 `spawn_blocking`。以前读一次累计值,算出来的是开机以来的平均,几个月没重启的机器上永远是个很小的数。
pub fn cpu_busy_ratio() -> f64 {
    if let Some(ratio) = crate::metrics::latest_cpu() {
        return ratio;
    }
    let read = || {
        std::fs::read_to_string("/proc/stat")
            .ok()
            .and_then(|text| crate::metrics::parse_stat(&text))
    };
    let Some((idle_a, total_a)) = read() else {
        return 0.0;
    };
    std::thread::sleep(std::time::Duration::from_millis(200));
    let Some((idle_b, total_b)) = read() else {
        return 0.0;
    };
    let total = total_b.saturating_sub(total_a);
    if total == 0 {
        return 0.0;
    }
    1.0 - idle_b.saturating_sub(idle_a).min(total) as f64 / total as f64
}

/// 1 / 5 / 15 分钟负载。
pub fn load_average() -> [f64; 3] {
    std::fs::read_to_string("/proc/loadavg")
        .ok()
        .and_then(|text| {
            let parts: Vec<f64> = text
                .split_whitespace()
                .take(3)
                .filter_map(|value| value.parse().ok())
                .collect();
            (parts.len() == 3).then(|| [parts[0], parts[1], parts[2]])
        })
        .unwrap_or([0.0; 3])
}

/// 内存。
pub fn memory_info() -> MemoryInfo {
    let Ok(text) = std::fs::read_to_string("/proc/meminfo") else {
        return MemoryInfo::default();
    };
    let read = |key: &str| -> u64 {
        text.lines()
            .find_map(|line| {
                let rest = line.strip_prefix(key)?;
                rest.trim()
                    .trim_end_matches(" kB")
                    .trim()
                    .parse::<u64>()
                    .ok()
            })
            .unwrap_or(0)
            / 1024
    };
    let total = read("MemTotal:");
    let available = read("MemAvailable:");
    MemoryInfo {
        total_mb: total,
        available_mb: available,
        used_ratio: if total == 0 {
            0.0
        } else {
            1.0 - available as f64 / total as f64
        },
    }
}

/// 磁盘。
pub fn disk_info(path: &Path) -> DiskInfo {
    let output = std::process::Command::new("df")
        .arg("-k")
        .arg(path)
        .output()
        .ok();
    let Some(output) = output else {
        return DiskInfo {
            mount: path.display().to_string(),
            ..DiskInfo::default()
        };
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let Some(line) = text.lines().nth(1) else {
        return DiskInfo::default();
    };
    let fields: Vec<&str> = line.split_whitespace().collect();
    let total_kb: u64 = fields
        .get(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let free_kb: u64 = fields
        .get(3)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    DiskInfo {
        mount: fields.get(5).copied().unwrap_or("?").to_owned(),
        free_gb: free_kb / 1024 / 1024,
        total_gb: total_kb / 1024 / 1024,
        used_ratio: if total_kb == 0 {
            0.0
        } else {
            1.0 - free_kb as f64 / total_kb as f64
        },
    }
}

/// 进程已运行秒数(`/proc/self/stat` 的 starttime 与 uptime 相减)。
pub fn process_uptime_seconds() -> Option<u64> {
    let stat = std::fs::read_to_string("/proc/self/stat").ok()?;
    // 第 22 个字段是 starttime(从 1 计;进程名里可能有空格,按最后一个 ')' 切)
    let tail = stat.rsplit_once(')')?.1;
    let start_ticks: u64 = tail.split_whitespace().nth(19)?.parse().ok()?;
    let uptime = std::fs::read_to_string("/proc/uptime").ok()?;
    let uptime_seconds: f64 = uptime.split_whitespace().next()?.parse().ok()?;
    let hertz = 100.0f64;
    let started = start_ticks as f64 / hertz;
    Some((uptime_seconds - started).max(0.0) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_ratio_is_a_fraction() {
        let ratio = cpu_busy_ratio();
        assert!((0.0..=1.0).contains(&ratio), "{ratio}");
    }

    #[test]
    fn load_average_has_three_values() {
        let load = load_average();
        assert!(load[0] >= 0.0 && load[1] >= 0.0 && load[2] >= 0.0);
    }

    #[test]
    fn memory_and_disk_are_reported() {
        let memory = memory_info();
        assert!(memory.total_mb > 0, "{memory:?}");
        assert!(memory.used_ratio >= 0.0 && memory.used_ratio <= 1.0);
        let disk = disk_info(Path::new("/"));
        assert!(disk.total_gb > 0, "{disk:?}");
    }

    #[test]
    fn process_uptime_is_available() {
        // 刚启动的进程应该也能拿到一个很小的值
        assert!(process_uptime_seconds().is_some());
    }
}
