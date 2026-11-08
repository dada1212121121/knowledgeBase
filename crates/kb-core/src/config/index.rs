//! 索引与模型类配置:嵌入、重排、核显加速、建表与大小上限。
//!
//! 由 `config.rs` 拆出:路径不变,入口仍是 `kb_core::config`。
use serde::{Deserialize, Serialize};

/// `[embed]`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EmbedConfig {
    /// `fastembed` | `http` | `fake`(仅 testkit feature 下可用)。
    pub backend: String,
    /// `bge-m3-int8` | `bge-m3` | `multilingual-minilm` | `multilingual-e5-base`。
    pub model: String,
    /// 单块上限,超出部分截断。
    pub max_tokens: usize,
    /// 批量大小,范围 1..=64。
    pub batch_size: usize,
    /// 0 = 自动(物理核数)。
    pub threads: usize,
    /// 守护进程启动时加载模型。
    pub preload: bool,
    /// 0 = 永不卸载;内存紧张时设 30。
    pub idle_unload_minutes: u64,
    /// 同组的后端切换不需要迁移(需 `kb eval` 确认)。
    pub compat_group: String,
    /// `backend = "http"` 时的 OpenAI 兼容端点。
    pub http: HttpEmbedConfig,
}

impl Default for EmbedConfig {
    fn default() -> Self {
        Self {
            backend: "fastembed".to_owned(),
            model: "bge-m3-int8".to_owned(),
            max_tokens: 512,
            batch_size: 8,
            threads: 0,
            preload: true,
            idle_unload_minutes: 0,
            compat_group: "bge-m3".to_owned(),
            http: HttpEmbedConfig::default(),
        }
    }
}

impl EmbedConfig {
    /// 模型族:取路径最后一段,并去掉 `-int8` / `-fp16` 这类量化后缀。
    ///
    /// 所以 `bge-m3` 与 `bge-m3-int8`、`BAAI/bge-m3` 与 `bge-m3` 都归到同一族。
    pub fn model_group(&self) -> String {
        let tail = self.model.rsplit(['/', '\\']).next().unwrap_or(&self.model);
        let tail = tail.trim();
        let tail = tail
            .strip_suffix("-int8")
            .or_else(|| tail.strip_suffix("-fp16"))
            .unwrap_or(tail);
        tail.to_lowercase()
    }

    /// 与另一份 embed 配置是否同一兼容组（设计规范）。
    ///
    /// 判据是**两条都成立**:声明的 `compat_group` 相同,且模型族相同。
    /// 只看 `compat_group` 会被“改了 `model` 但没改 `compat_group`”的旧配置骗过
    /// (它的默认值永远是 `bge-m3`),从而给出“不用迁移”的危险结论;
    /// 反过来多判一次模型族只会让人多跑一次迁移,代价小得多。
    pub fn same_compat_group(&self, next: &EmbedConfig) -> bool {
        fn normalize(group: &str) -> String {
            let group = group.trim().to_lowercase();
            let group = group.rsplit(':').next().unwrap_or(&group).to_owned();
            group
                .strip_suffix("-int8")
                .or_else(|| group.strip_suffix("-fp16"))
                .unwrap_or(&group)
                .to_owned()
        }
        normalize(&self.compat_group) == normalize(&next.compat_group)
            && self.model_group() == next.model_group()
    }
}

/// `[embed.http]`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HttpEmbedConfig {
    /// OpenAI 兼容的 embeddings 端点。
    pub url: String,
    /// 请求里的模型名。
    pub model: String,
    /// 向量维度。
    pub dim: usize,
}

impl Default for HttpEmbedConfig {
    fn default() -> Self {
        Self {
            url: "http://127.0.0.1:18081/v1/embeddings".to_owned(),
            model: "bge-m3".to_owned(),
            dim: 1024,
        }
    }
}

/// `[rerank]`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RerankConfig {
    /// `auto`(sidecar 可用才开)| `off` | `on`。
    pub mode: String,
    /// OpenAI 兼容的 rerank 端点。
    pub url: String,
    /// 参与重排的候选数。
    ///
    /// 默认 10(不是 20):真机 A/B(50 条黄金集)里 20 条候选把 hit@1 从 0.76 压到 0.66,
    /// 缩到 10 才与不重排打平——候选越多,重排器越容易被长片段带偏,还更慢。
    pub top_n: usize,
    /// 每条候选截断的字符数。
    ///
    /// 默认 300(不是 400):同样这批数据里 400 字反而更差(0.66 vs 0.76),
    /// 300 字与不重排打平且每条省约 0.8 秒。
    pub truncate_chars: usize,
    /// 时间预算,超时则退回 RRF 结果并标记 degraded。
    pub budget_ms: u64,
}

impl Default for RerankConfig {
    fn default() -> Self {
        Self {
            mode: "auto".to_owned(),
            url: "http://127.0.0.1:18082/v1/rerank".to_owned(),
            top_n: 10,
            truncate_chars: 300,
            budget_ms: 3000,
        }
    }
}

/// `[accel]`(核显 sidecar)
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AccelConfig {
    /// 是否启用核显 sidecar。
    pub enabled: bool,
    /// llama.cpp 安装目录(支持 `~` 展开)。
    pub llama_dir: String,
    /// 相对 `models_dir` 的 embedding GGUF。
    pub embed_gguf: String,
    /// 相对 `models_dir` 的 rerank GGUF。
    pub rerank_gguf: String,
    /// embedding 服务端口。
    pub embed_port: u16,
    /// rerank 服务端口。
    pub rerank_port: u16,
    /// 卸载到 GPU 的层数(`-ngl`)。默认 99 = 全放显卡;核显对 Q8 的 BERT 没有加速比时填 0
    /// 可以省掉一次层搬运,延迟基本不变。
    pub ngl: i32,
    /// 要起哪几路 sidecar:默认两路都起。只想要重排、不放嵌入 GGUF 时填 `["rerank"]`
    /// (以前是任意一路起不来就整组失败,于是只开重排根本起不来)。
    pub roles: Vec<String>,
}

impl AccelConfig {
    /// 这一路要不要起(大小写与首尾空白都不敏感)。
    pub fn role_enabled(&self, role: &str) -> bool {
        self.roles
            .iter()
            .any(|item| item.trim().eq_ignore_ascii_case(role))
    }
}

impl Default for AccelConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            llama_dir: "~/.kb/bin/llama-b12034".to_owned(),
            embed_gguf: "gguf/bge-m3-Q8_0.gguf".to_owned(),
            rerank_gguf: "gguf/bge-reranker-v2-m3-Q8_0.gguf".to_owned(),
            embed_port: 18081,
            rerank_port: 18082,
            ngl: 99,
            roles: vec!["embed".to_owned(), "rerank".to_owned()],
        }
    }
}

/// 项目扫描收 PDF / Office 等办公文档的大小上限(64 MB,与预览页内联读取的上限一致)。
///
/// 放在这里而不是 `kb-index`:扫描器要用它判断跳过,AI 接入指南(`kb-web`)也要把同一个数字写给接入方,
/// 两边必须是同一个值。
pub const RICH_DOC_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// 项目扫描收 Markdown 文档(`.md` / `.mdx`)的大小上限(2 MiB)。
///
/// `[index] max_file_bytes`(默认 200KB)是按源码定的,拿它卡文档会把项目自己的设计 / 决策 / 进度文档
/// 整份挡在索引外(生产上 584KB 的架构设计说明、569KB 的测试用例文档都因此搜不到)。
/// 文档和源码不同:它们是写给人读的长文,单份几百 KB 很常见,而且按标题分块,584KB 的架构设计说明实测 446 块,
/// 拼到 2 MiB 约 1560 块。仍留一个硬上限,挡住误放进来的巨型文本。
///
/// 和 [`RICH_DOC_MAX_BYTES`] 一样是常量,不做成配置项:生效规则是 `max(max_file_bytes, TEXT_DOC_MAX_BYTES)`,
/// 只会放宽、不会收紧用户已经调大的 `max_file_bytes`;代码文件以及 `.txt` / `.rst` 的上限不受影响。
pub const TEXT_DOC_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// `[index]`
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct IndexConfig {
    /// 单文件大小上限,超过则跳过。
    pub max_file_bytes: u64,
    /// 块的目标 token 数。
    pub target_tokens: usize,
    /// 行窗口分块的行数。
    pub window_lines: usize,
    /// 行窗口分块的重叠行数。
    pub window_overlap: usize,
    /// 排除的 glob 列表。
    pub exclude: Vec<String>,
    /// 是否监听文件变化(未提交的改动)。
    pub watch: bool,
    /// 文件监听的去抖时间。
    pub debounce_ms: u64,
    /// 累计写入多少行后做一次 optimize。
    pub optimize_after_rows: u64,
    /// 超过多少行后在空闲时建向量索引。
    ///
    /// 默认 1 万行(R1b，见下文):在真实 3.3 万行表上实测,暴力扫描单查询 394 ms CPU,
    /// 建索引后走生产路径(精排倍数 10)是 21 ms、召回 0.973 —— 差 19 倍,不值得再等。
    pub vector_index_min_rows: u64,
    /// 文本优先索引:先写正文与全文索引,向量由后台队列补齐。
    ///
    /// / 期间默认关闭:代码路径已可切换,但并发门槛与恢复演练没完成前不改变默认行为。
    /// 打开后新写入的行先落 `embed_state=pending`,检索通过 pending 补充列表兜底。
    pub text_first: bool,
    /// 全站同时最多跑几个**批量**索引分片。0 = 自动(按核数的 1/4,最少 1、最多 4)。
    ///
    /// 它决定每个知识库的后台一次能做几个任务。以前是一个知识库只做一个任务:一次导入几百个
    /// 单文件批次时,一个文件在嵌入、其余文件连解析都排不上,机器大半时间在闲。
    /// 分片排队先到先得,所以一个人导入一万个文件不会让别人等几小时。
    /// 编辑、保存笔记这类交互式任务走单独的通道,不占这个名额。
    /// 上限 [`IndexConfig::MAX_PARALLEL_SLICES`]:每个知识库的后台就开这么多条循环去抢任务。
    pub parallel_slices: u32,
    /// 同一个批次里同时解析几个文件(读 → 抽取 / 转换 → 分块 → 嵌入)。1 = 逐个处理。
    ///
    /// PDF / Office 抽取、旧格式转换这些活主要花在 CPU 与子进程上,逐个跑时界面上永远只显示
    /// 「1 个并发」。调大后这些文件同时准备、同时嵌入,写 LanceDB 撞上提交冲突会自动重试。
    /// 默认 1:不改变已有安装的行为;批量导入很多 PDF 时调到 2–4 最划算。
    /// 旧格式转换仍要先过 `[convert] max_concurrent` 这道闸门。
    pub parallel_files: u32,
}

impl IndexConfig {
    /// 同时解析的文件数上限:每个文件都要整份读进内存,再大就是拿内存换速度。
    pub const MAX_PARALLEL_FILES: u32 = 8;

    /// 全站批量分片的并发上限:每个知识库的后台就开这么多条循环去抢任务。
    pub const MAX_PARALLEL_SLICES: u32 = 8;
}

impl Default for IndexConfig {
    fn default() -> Self {
        Self {
            max_file_bytes: 204_800,
            target_tokens: 400,
            window_lines: 60,
            window_overlap: 10,
            exclude: [
                "**/node_modules/**",
                "**/target/**",
                "**/dist/**",
                "**/build/**",
                "**/.venv/**",
                "**/__pycache__/**",
                "**/coverage/**",
                "**/*.min.js",
                "**/*.map",
                "**/*.lock",
                "**/package-lock.json",
                "**/pnpm-lock.yaml",
                "**/yarn.lock",
            ]
            .iter()
            .map(|s| (*s).to_owned())
            .collect(),
            watch: true,
            debounce_ms: 2000,
            optimize_after_rows: 2000,
            vector_index_min_rows: 10_000,
            text_first: false,
            parallel_slices: 0,
            parallel_files: 1,
        }
    }
}
