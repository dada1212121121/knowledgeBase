//! 服务器类配置:监听、路径、网络、日志、保留期、调度、备份、上传、MCP。
//!
//! 由 `config.rs` 拆出:路径不变,入口仍是 `kb_core::config`。
use serde::{Deserialize, Serialize};

/// `[server]`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    /// 监听地址,默认 `127.0.0.1:7878`。
    pub listen: String,
    /// 是否允许监听非回环地址。
    pub allow_remote: bool,
    /// Unix socket 路径;空 = `<KB_HOME>/run/kb.sock`。
    pub socket: String,
    /// 启动时是否**等**嵌入模型就绪再对外服务。默认等(起不来就退出,运维当场知道);
    /// 设 `false` 时改成后台预热,HTTP 先可用,模型边加载边服务。
    /// 场景:守护进程与 embed sidecar 一起重启时,等模型就绪会让「重启窗口」变长;
    /// 代价是预热完成前到达的嵌入请求会拿到「正在加载」而不是排队等。
    pub warm_on_start: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            listen: "127.0.0.1:7878".to_owned(),
            allow_remote: false,
            socket: String::new(),
            warm_on_start: true,
        }
    }
}

/// `[paths]`
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PathsConfig {
    /// 模型缓存目录;空 = `<KB_HOME>/models`。
    pub models_dir: String,
}

/// `[network]`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NetworkConfig {
    /// 启动时把 `.hf.co` 追加进 `NO_PROXY`(必须在 tokio 运行时启动前做)。
    pub hf_cdn_direct: bool,
    /// 网页来源是否允许抓内网 / 本机 / 云元数据地址(127.0.0.0/8、10/8、172.16/12、192.168/16、
    /// 169.254/16 等)。默认关:多用户下任何人都能添加网页来源,放开会让他经本服务器去读内网服务和
    /// 云主机的元数据凭据。只有确实要抓公司内网文档站时才打开(要重启)。
    pub crawl_allow_private: bool,
}

impl Default for NetworkConfig {
    fn default() -> Self {
        Self {
            hf_cdn_direct: true,
            crawl_allow_private: false,
        }
    }
}

/// `[retention]`:历史表保留多久。
///
/// 四张表只增不减:`jobs` / `audit` / `events`(知识库库)+ `metric_samples`(账号库)。
/// 数量在生产上已经到了「万级」,不清的话备份体积、查询与 `kb doctor` 都会慢慢变慢。
/// **`audit` 是合规痕迹**,默认 90 天且可以调更久(设 `0` = 永不清理)。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RetentionConfig {
    /// 已完成(成功/失败/取消)的任务留多少天(`0` = 不清理)。
    pub jobs_days: u64,
    /// 能力调用审计留多少天(`0` = 不清理;合规要求更久就调大)。
    pub audit_days: u64,
    /// 进化事件留多少天(`0` = 不清理)。
    pub events_days: u64,
    /// 资源采样留多少天(`0` = 不清理;曲线只画最近几小时,留 30 天够回溯)。
    pub metric_samples_days: u64,
}

impl Default for RetentionConfig {
    fn default() -> Self {
        Self {
            jobs_days: 30,
            audit_days: 90,
            events_days: 30,
            metric_samples_days: 30,
        }
    }
}

/// `[mcp]`:MCP 传输模式(计划变更 )。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct McpConfig {
    /// 启用的传输:`stdio`(默认)/ `http`;可以同时开。
    pub transports: Vec<String>,
    /// `/mcp` 允许的 `Host` 头(默认只含本机;经反向代理暴露时把外部域名加进来)。
    pub allowed_hosts: Vec<String>,
}

impl Default for McpConfig {
    fn default() -> Self {
        Self {
            transports: vec!["stdio".to_owned()],
            allowed_hosts: Vec::new(),
        }
    }
}

impl McpConfig {
    /// 是否启用 stdio(`kb mcp`)。
    pub fn stdio_enabled(&self) -> bool {
        self.transports.iter().any(|item| item == "stdio")
    }

    /// 是否启用 `/mcp`(streamable HTTP,默认关闭)。
    pub fn http_enabled(&self) -> bool {
        self.transports.iter().any(|item| item == "http")
    }
}

/// `[meta]`:元数据库。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MetaConfig {
    /// 只读连接池大小(写连接恒为 1)。
    pub read_pool: usize,
}

impl MetaConfig {
    /// 读连接池上限(设计规范 / :默认 4、上限 8)。
    pub const MAX_READ_POOL: usize = 8;
}

impl Default for MetaConfig {
    fn default() -> Self {
        Self { read_pool: 4 }
    }
}

/// `[upload]`:数据源与上传。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UploadConfig {
    /// 单个文件上限(MB)。 默认 512。
    pub max_file_mb: u64,
    /// 上传总配额(GB):`<KB_HOME>/sources` 与未完成分片合计不得超过它。
    pub max_total_gb: u64,
    /// 分片大小(MB),默认 8。
    pub chunk_mb: u64,
    /// 未完成上传保留多少小时后清理。
    pub keep_hours: u64,
    /// 解压总量上限相对压缩包大小的倍数(防 zip 炸弹,默认 10)。
    pub unpack_max_ratio: u64,
    /// 压缩包嵌套层数上限(默认 3)。
    pub unpack_max_depth: u32,
    /// 一次解包最多多少个文件。
    pub unpack_max_files: u32,
}

impl UploadConfig {
    /// 分片大小上限(再大对浏览器的内存与断点续传都没好处)。
    pub const MAX_CHUNK_MB: u64 = 64;
    /// 嵌套层数上限。
    pub const MAX_UNPACK_DEPTH: u32 = 8;
}

impl Default for UploadConfig {
    fn default() -> Self {
        Self {
            max_file_mb: 512,
            max_total_gb: 20,
            chunk_mb: 8,
            keep_hours: 24,
            unpack_max_ratio: 10,
            unpack_max_depth: 3,
            unpack_max_files: 2000,
        }
    }
}

/// `[schedule]`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ScheduleConfig {
    /// 夜间全量校验时间,`HH:MM`。
    pub nightly_at: String,
    /// optimize 检查间隔(分钟)。
    pub optimize_interval_minutes: u64,
    /// 热点表的 optimize 间隔(分钟)。
    ///
    /// 整点那趟要等满 `optimize_interval_minutes`;而索引任务写完一个文件就可能留下
    /// 一个碎片,热点表在一小时内能堆出几百个。这里单独给「上次整理后又被写过」的表
    /// 定一个更短的间隔(默认 10 分钟),把碎片清在长起来之前。
    pub hot_optimize_interval_minutes: u64,
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        Self {
            nightly_at: "03:00".to_owned(),
            optimize_interval_minutes: 60,
            hot_optimize_interval_minutes: 10,
        }
    }
}

/// `[backup]`:定时备份与保留策略(设置页「备份」分区)。
///
/// 归档只增不减会把磁盘吃满,所以默认每 24 小时自动备份一次、最多留 7 份;
/// **保留策略对手动备份同样生效**(`kb backup prune` 按同一份策略清理)。
/// 到点判断不靠内存状态:以归档目录里最新一份的时间为准,重启后不会重复备份。
///
/// `mirror_dirs` 是**异地 / 外部存储**:每份归档在 `<KB_HOME>/backups/` 落盘之后,
/// 再复制一份到这里(挂载的移动硬盘 / NAS / 另一个数据盘都算)。复制失败不影响本次备份
/// (本机已经有一份),但会进 `backups/.failures.json` 并挂到设置页与横幅上。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct BackupConfig {
    /// 是否开启定时备份(守护进程每拍判断,到点才真的打包)。
    pub enabled: bool,
    /// 备份间隔(小时)。
    pub interval_hours: u64,
    /// 最多保留几份归档(`0` = 不按份数清理;最新一份永远保留)。
    pub keep_count: u64,
    /// 超过多少天的归档删掉(`0` = 不按时间清理;最新一份永远保留)。
    pub keep_days: u64,
    /// 定时备份时是否把原件(`sources/`)一起打进去。
    pub include_sources: bool,
    /// 异地 / 外部存储目录(绝对路径,或相对 `KB_HOME` 的路径;留空 = 不复制)。
    ///
    /// 每个目录都按 `<目录>/kb-<时间>.tar.gz` 放一份副本;清理与删除也会同步到这些目录。
    pub mirror_dirs: Vec<String>,
}

impl BackupConfig {
    /// 间隔下限(小时)。
    pub const MIN_INTERVAL_HOURS: u64 = 1;
    /// 间隔上限(小时):30 天。
    pub const MAX_INTERVAL_HOURS: u64 = 720;
    /// 份数上限(再大就不像“保留策略”了)。
    pub const MAX_KEEP_COUNT: u64 = 365;
    /// 天数上限(10 年)。
    pub const MAX_KEEP_DAYS: u64 = 3650;
    /// 异地目录最多几个(再多就是“没有目的地”的配置噪音)。
    pub const MAX_MIRROR_DIRS: usize = 4;
}

impl Default for BackupConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_hours: 24,
            keep_count: 7,
            keep_days: 0,
            include_sources: false,
            mirror_dirs: Vec::new(),
        }
    }
}

/// `[log]`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LogConfig {
    /// 日志级别。
    pub level: String,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            level: "info".to_owned(),
        }
    }
}
