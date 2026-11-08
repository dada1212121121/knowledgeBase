//! 配置变更:范围分类、差异、热重载存储。
//!
//! 由 `config.rs` 拆出:路径不变,入口仍是 `kb_core::config`。
use super::Config;

/// 一条配置改动的生效方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeScope {
    /// 下一个请求就按新值走(检索参数、重排、调度、日志级别、索引排除、MCP 输出上限)。
    Hot,
    /// 只在启动时读一次(监听地址、路径、上传上限、文件监听开关、MCP 传输……):提示重启。
    Restart,
    /// 涉及 embedder:向量维度会变,必须先迁移 collection,再重启。
    Migration,
}

impl ChangeScope {
    /// 稳定的字符串形式(WS 事件与能力返回值里用)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hot => "hot",
            Self::Restart => "restart",
            Self::Migration => "migration",
        }
    }
}

/// 一条配置改动。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigChange {
    /// 点号叶子键,例如 `search.k`。
    pub key: String,
    /// 生效方式。
    pub scope: ChangeScope,
}

/// 两份配置之间的差异。
///
/// 用 `serde_json` 的树逐层比较,**叶子键**进结果(数组整体算一个叶子),所以
/// `index.exclude` 里加一行是 `index.exclude` 一条,而不是逐元素一大堆。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfigDiff {
    /// 全部改动,按 `key` 排序。
    pub changes: Vec<ConfigChange>,
}

impl ConfigDiff {
    /// 有没有改动。
    pub fn is_empty(&self) -> bool {
        self.changes.is_empty()
    }

    /// 某一类改动的键列表。
    pub fn keys_with(&self, scope: ChangeScope) -> Vec<String> {
        self.changes
            .iter()
            .filter(|change| change.scope == scope)
            .map(|change| change.key.clone())
            .collect()
    }

    /// 立即生效的键。
    pub fn hot(&self) -> Vec<String> {
        self.keys_with(ChangeScope::Hot)
    }

    /// 需要重启的键。
    pub fn restart_required(&self) -> Vec<String> {
        self.keys_with(ChangeScope::Restart)
    }

    /// 需要先迁移的键。
    pub fn migration(&self) -> Vec<String> {
        self.keys_with(ChangeScope::Migration)
    }
}

/// 一条点号键的生效方式（设计规范）。
///
/// 规则按**前缀**判断,顺序不能改:`embed.*` 先判(迁移),再看热更新白名单,
/// 其余一律算“要重启”。新增配置项时只要落在下面某条规则里就不用改这里。
///
/// `embed.*` 里只有「启动时读一次、不改变向量内容」的键例外:卸载时间、线程数、预加载。
/// 它们和向量维度、模型无关,却曾被整个 `embed.*` 前缀一起判成迁移,
/// 结果改一个卸载时间就让整份配置(连同同时改的热更新项)都不生效。
/// 判不准的键(比如 `batch_size`)仍按迁移处理,宁可多迁一次,不能让向量悄悄变。
pub fn classify_change(key: &str) -> ChangeScope {
    if matches!(
        key,
        "embed.idle_unload_minutes" | "embed.threads" | "embed.preload"
    ) {
        return ChangeScope::Restart;
    }
    if key == "embed" || key.starts_with("embed.") {
        return ChangeScope::Migration;
    }
    // 热更新白名单:这些项在每次请求 / 每拍调度 / 每次索引任务里重读
    if key.starts_with("search.")
        // 多用户的系统参数:AI 开关、注册、配额、分享、站点——每个请求 / 每次调用现读
        || key.starts_with("ai.")
        || key.starts_with("accounts.")
        || key.starts_with("quota.")
        || key.starts_with("share.")
        || key.starts_with("site.")
        || key.starts_with("mail.")
        || key.starts_with("rerank.")
        || key.starts_with("schedule.")
        || key.starts_with("backup.")
        || key.starts_with("office.")
        // 编辑器扩展:清单 / 文件接口每个请求现读开关与目录
        || key.starts_with("editor.")
        // 网页 AI 规范化:后台任务每个分片现读
        || key.starts_with("web_extract.")
        || key == "log.level"
        || key == "index.exclude"
        || key == "index.parallel_slices"
        // 每个分片现读:调大后下一片就有多个文件同时准备,不用重启
        || key == "index.parallel_files"
        || key == "evolution.session_roots"
        // LLM 的提供商 / 地址 / 模型 / 额度都是每次调用时从 ConfigStore 读
        // (`chat_model` 现场构造客户端、`llm_api_key` 每次读 secrets.toml),
        // 所以改完立即生效,不需要重启。
        || key == "llm.daily_token_budget"
        || key == "llm.max_calls_per_hour"
        || key == "llm.provider"
        || key == "llm.base_url"
        || key == "llm.extract_model"
        || key == "llm.review_model"
        || key == "llm.agent_model"
    {
        return ChangeScope::Hot;
    }
    ChangeScope::Restart
}

/// 把两份 JSON 值摊平成“叶子键 → 值”,只收集不同的那些键。
pub(super) fn collect_changed_keys(
    prefix: &str,
    left: &serde_json::Value,
    right: &serde_json::Value,
    out: &mut Vec<String>,
) {
    match (left, right) {
        (serde_json::Value::Object(left), serde_json::Value::Object(right)) => {
            // 两边键的并集,排序保证输出稳定
            let mut keys: Vec<&String> = left.keys().chain(right.keys()).collect();
            keys.sort();
            keys.dedup();
            for key in keys {
                let path = if prefix.is_empty() {
                    key.clone()
                } else {
                    format!("{prefix}.{key}")
                };
                match (left.get(key), right.get(key)) {
                    (Some(left), Some(right)) => collect_changed_keys(&path, left, right, out),
                    // 一侧缺这个键(理论上不会发生:`#[serde(default)]` 会补齐),按整段算一条
                    _ => out.push(path),
                }
            }
        }
        // 标量 / 数组 / 类型不同:整条算一个叶子
        (left, right) if left == right => {}
        _ => out.push(prefix.to_owned()),
    }
}

/// 进程内的“当前配置”。
///
/// 守护进程启动时建一个,所有服务**按请求读取**而不是各自留一份快照;
/// 配置文件变了就 [`ConfigStore::replace`],并把代际号 +1(便于日志与测试断言)。
#[derive(Debug)]
pub struct ConfigStore {
    current: std::sync::RwLock<std::sync::Arc<Config>>,
    generation: std::sync::atomic::AtomicU64,
}

impl ConfigStore {
    /// 用一份配置构造,代际号从 1 开始。
    pub fn new(config: Config) -> Self {
        // 启动时先把进程时区定下来:守护进程里所有“今天”“本地几点”都读这一份。
        // 配置校验已经确认名字合法;这里失败只可能来自直接构造 ConfigStore 的测试数据,退回默认值。
        let _ = crate::timezone::set_site_timezone(&config.site.timezone);
        Self {
            current: std::sync::RwLock::new(std::sync::Arc::new(config)),
            generation: std::sync::atomic::AtomicU64::new(1),
        }
    }

    /// 当前配置(拿到的是快照,可以在请求里随意持有)。
    pub fn get(&self) -> std::sync::Arc<Config> {
        // 配置写入只在重载线程里发生且不 panic,中毒时取出内层继续用,不让读路径跟着崩
        self.current
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    /// 当前代际号(每次成功替换 +1)。
    pub fn generation(&self) -> u64 {
        self.generation.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// 换成新配置,返回(新代际号, 与旧配置的差异)。
    pub fn replace(&self, next: Config) -> (u64, ConfigDiff) {
        // 热更新 `site.timezone` 立即生效:额度日界、调度器下一拍就会按新时区算。
        // 非法名字在校验阶段就被拒了;这里失败时保持原时区。
        let _ = crate::timezone::set_site_timezone(&next.site.timezone);
        let mut guard = self.current.write().unwrap_or_else(|err| err.into_inner());
        let diff = guard.diff(&next);
        *guard = std::sync::Arc::new(next);
        drop(guard);
        let generation = self
            .generation
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        (generation, diff)
    }
}
