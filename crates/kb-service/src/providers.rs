//! 组件目录(ProviderCatalog):OCR / 转写 / 嵌入 / 重排的统一“可插拔组件”视图。
//!
//! 目标:设置中心与系统状态页只需要问一份数据 —— “这台机器上装了哪些组件、哪个是默认、
//! 能不能装/卸”。各组件自己的运行时细节(怎么调、模型在哪)仍归各自的实现管:
//! - OCR / 转写:`kb-extract` 的后端插件(`OcrBackend` / 转写命令);
//! - 嵌入 / 重排:来自配置(`[embed]` / `[rerank]`),没有“安装”概念,只报当前值与可用性。
//!
//! 这里的 [`ProviderCatalog`] 只做聚合与状态判定,**不引入新的抽象层**。
//!
//! 列表的**来源**是 [`kb_core::backends::BackendRegistry`]:`kind` 与可选集合来自声明
//! (内置 + `<KB_HOME>/backends/*/manifest.toml`),`installed` / `ready` / `current` 仍由这里按
//! 配置与运行时探出来。行的身份(`id`)保持原样——OCR 是后端 id、转写是配置里的命令、嵌入是
//! 模型名、重排是端点或 `rerank(auto)`,这样组件页的展示不会因为换了数据源而变样。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kb_core::backends::{BackendKind, BackendRegistry};
use kb_core::config::{Config, ExtractConfig};
use kb_core::paths::KbPaths;
use serde::Serialize;

/// 组件种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// 文档 OCR。
    Ocr,
    /// 音视频转写。
    Transcribe,
    /// 嵌入模型。
    Embed,
    /// 重排模型。
    Rerank,
}

impl ProviderKind {
    /// 中文名(设置页的分区标题)。
    pub fn label(self) -> &'static str {
        match self {
            Self::Ocr => "文档 OCR",
            Self::Transcribe => "音视频转写",
            Self::Embed => "嵌入",
            Self::Rerank => "重排",
        }
    }

    /// 字符串形式(给 UI 过滤用)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ocr => "ocr",
            Self::Transcribe => "transcribe",
            Self::Embed => "embed",
            Self::Rerank => "rerank",
        }
    }
}

/// 一个组件条目。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Provider {
    /// 种类。
    pub kind: ProviderKind,
    /// 组件 id(`rapidocr` / `tesseract` / `whisper-cli` / `bge-m3-int8` …)。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// 是否已安装(运行时在)。
    pub installed: bool,
    /// 是否就绪(运行时 + 模型都在)。
    pub ready: bool,
    /// 是否是当前选用。
    pub current: bool,
    /// 不可用原因 / 说明。
    pub detail: Option<String>,
    /// 模型目录或模型名。
    pub model: Option<String>,
    /// 安装命令(可空 = 不支持自动安装)。
    pub install_command: Option<String>,
    /// 能不能卸载(嵌入 / 重排走配置,这里不支持)。
    pub removable: bool,
}

/// 环境画像(顶部“环境检测”用)。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct EnvProfile {
    /// CPU 逻辑核数。
    pub cpu_cores: usize,
    /// 内存总量(MB)。
    pub memory_mb: u64,
    /// 磁盘可用(GB)。
    pub disk_free_gb: u64,
    /// 有没有 NVIDIA GPU(目前只做存在性判断)。
    pub has_nvidia: bool,
    /// GPU 名称(拿不到就是 `None`)。
    pub gpu: Option<String>,
    /// 是否检测到 Intel 核显(有 `/dev/dri` 就认为有)。
    pub has_intel_gpu: bool,
    /// 已装的 OCR / 转写命令。
    pub tools: Vec<String>,
}

/// 一条推荐。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Recommendation {
    /// 种类。
    pub kind: ProviderKind,
    /// 推荐的组件 id。
    pub provider: String,
    /// 理由。
    pub reason: String,
    /// 是否已经是当前选用。
    pub already_current: bool,
}

/// 组件目录。
pub struct ProviderCatalog {
    config: Config,
    paths: KbPaths,
}

impl ProviderCatalog {
    /// 构造。
    pub fn new(config: Config, paths: KbPaths) -> Self {
        Self { config, paths }
    }

    /// 当前配置。
    pub fn config(&self) -> &Config {
        &self.config
    }

    /// 后端注册表(内置 + `<KB_HOME>/backends/`,见 B5)。
    ///
    /// 每次现读:后端声明是文件,改了要能立刻反映到组件页;条数是个位数,读盘代价可忽略。
    pub fn registry(&self) -> BackendRegistry {
        BackendRegistry::load(self.paths.home())
    }

    /// 列出全部组件。
    pub fn list(&self) -> Vec<Provider> {
        let registry = self.registry();
        let mut providers = Vec::new();
        providers.extend(self.ocr_providers(&registry));
        providers.extend(self.transcribe_providers(&registry));
        providers.extend(self.embed_providers(&registry));
        providers.extend(self.rerank_providers());
        providers
    }

    /// 注册表加载时攒下的问题(坏 manifest 等);组件页可以一并显示。
    pub fn backend_warnings(&self) -> Vec<String> {
        self.registry().warnings().to_vec()
    }

    /// OCR 后端:注册表里 `kind = "ocr"` 的每条一个,宿主没有对应实现的跳过。
    fn ocr_providers(&self, registry: &BackendRegistry) -> Vec<Provider> {
        let backends = kb_extract::ocr::backends(&self.config.extract);
        registry
            .by_kind(BackendKind::Ocr)
            .into_iter()
            .filter_map(|entry| {
                // 声明里有、程序里没有实现的后端不列进组件页(点了只会报错);
                // `kb doctor backends` 会把它列出来,告诉用户「宿主还没有这个实现」
                let backend = backends.iter().find(|item| item.id() == entry.id())?;
                let availability = backend.detect();
                Some(Provider {
                    kind: ProviderKind::Ocr,
                    id: backend.id().to_owned(),
                    // 显示名来自声明,声明没写就退回 id
                    name: entry.manifest.name.clone(),
                    installed: !matches!(
                        availability,
                        kb_extract::ocr::OcrAvailability::MissingRuntime(_)
                    ),
                    ready: availability.is_ready(),
                    current: backend.id() == self.config.extract.ocr_backend,
                    // detail 只写**实时**原因(缺运行时 / 缺模型);声明里的 detail 是安装说明,
                    // 不进这一栏,免得「已就绪」的行也顶着一句固定文案
                    detail: availability.reason().map(str::to_owned),
                    model: Some(match backend.id() {
                        "rapidocr" => format!(
                            "PP-OCRv6 {} · {}",
                            self.config.extract.ocr_model_size,
                            self.model_dir()
                                .map(|dir| dir.display().to_string())
                                .unwrap_or_else(|| "(默认目录)".to_owned())
                        ),
                        _ => self.config.extract.ocr_language.clone(),
                    }),
                    install_command: Some(self.config.extract.ocr_install_command.clone()),
                    removable: entry.manifest.id == "rapidocr",
                })
            })
            .collect()
    }

    /// 转写后端。
    ///
    /// 行的 `id` 仍是**配置里的那条命令**(薄封装脚本的人看到的就是自己的脚本名);
    /// 显示名与说明优先取注册表里同 id 的声明,取不到就退回 `whisper.cpp` 这档老文案。
    fn transcribe_providers(&self, registry: &BackendRegistry) -> Vec<Provider> {
        let command = &self.config.extract.transcribe_command;
        let installed = kb_extract::ocr::command_exists(command).is_some();
        let declared = registry
            .get(command)
            .filter(|entry| entry.kind() == BackendKind::Transcribe);
        vec![Provider {
            kind: ProviderKind::Transcribe,
            id: command.clone(),
            name: declared
                .map(|entry| entry.manifest.name.clone())
                .unwrap_or_else(|| "whisper.cpp".to_owned()),
            installed,
            ready: installed,
            current: true,
            detail: if installed {
                None
            } else {
                Some(format!(
                    "找不到命令 {};装上 whisper.cpp 或指向薄封装脚本",
                    self.config.extract.transcribe_command
                ))
            },
            model: self.config.extract.transcribe_model.clone(),
            install_command: Some(self.config.extract.transcribe_install_command.clone()),
            removable: false,
        }]
    }

    /// 嵌入模型(来自配置,没有安装概念)。
    ///
    /// 行仍是「当前用的那个模型」(`id = embed.model`),不是「后端有哪些」;
    /// 注册表里 `kind = "embed"` 的声明用来补说明(例如 `http` 那档该去哪配地址)。
    fn embed_providers(&self, registry: &BackendRegistry) -> Vec<Provider> {
        let id = self.config.embed.model.clone();
        let ready =
            self.paths.models_dir().join(&id).is_dir() || self.config.embed.backend != "fastembed";
        // 后端名在 `model` 那一行里(`后端 http · 单块 … token`),不在标题上;
        // 注册表在这里的作用是抓拼错:`embed.backend` 写了个没有声明的名字要当场说出来
        let backend = self.config.embed.backend.clone();
        let declared = registry
            .get(&backend)
            .is_some_and(|entry| entry.kind() == BackendKind::Embed);
        vec![Provider {
            kind: ProviderKind::Embed,
            id: id.clone(),
            name: id.clone(),
            installed: true,
            ready,
            current: true,
            detail: if !declared {
                Some(format!(
                    "后端「{backend}」没有声明(内置只有 fastembed / http);检查 embed.backend 是否拼错"
                ))
            } else if ready {
                None
            } else {
                Some(format!(
                    "模型目录 {} 不存在",
                    self.paths.models_dir().join(&id).display()
                ))
            },
            model: Some(format!(
                "后端 {} · 单块 {} token",
                self.config.embed.backend, self.config.embed.max_tokens
            )),
            install_command: None,
            removable: false,
        }]
    }

    /// 重排模型。
    ///
    /// 重排在注册表里只有一条声明(`rerank`),它的 `detail` 是「关掉只是退回融合结果」这类
    /// 固定说明;端点、候选数、预算仍从 `[rerank]` 读。
    fn rerank_providers(&self) -> Vec<Provider> {
        let enabled = self.config.rerank.mode != "off";
        let id = if self.config.rerank.url.is_empty() {
            "rerank(auto)".to_owned()
        } else {
            self.config.rerank.url.clone()
        };
        vec![Provider {
            kind: ProviderKind::Rerank,
            id: id.clone(),
            name: id,
            installed: true,
            ready: enabled,
            current: enabled,
            detail: if enabled {
                None
            } else {
                Some("重排未启用(检索只用融合结果)".to_owned())
            },
            model: Some(format!(
                "候选 {} 条 · 预算 {} ms",
                self.config.rerank.top_n, self.config.rerank.budget_ms
            )),
            install_command: None,
            removable: false,
        }]
    }

    /// 模型目录(RapidOCR)。
    pub fn model_dir(&self) -> Option<PathBuf> {
        match self.config.extract.ocr_model_dir.as_deref() {
            Some(dir) if !dir.trim().is_empty() => Some(PathBuf::from(dir)),
            _ => Some(self.paths.models_dir().join("ocr/ppocrv6")),
        }
    }

    /// 环境画像。
    pub fn env_profile(&self) -> EnvProfile {
        let mut tools = Vec::new();
        for command in [
            &self.config.extract.ocr_command,
            &self.config.extract.ocr_fallback_command,
            &self.config.extract.transcribe_command,
        ] {
            if kb_extract::ocr::command_exists(command).is_some() {
                tools.push(command.clone());
            }
        }
        EnvProfile {
            cpu_cores: std::thread::available_parallelism()
                .map(|value| value.get())
                .unwrap_or(1),
            memory_mb: memory_mb(),
            disk_free_gb: disk_free_gb(self.paths.home()),
            has_nvidia: Path::new("/dev/nvidia0").exists() || command_on_path("nvidia-smi"),
            gpu: gpu_name(),
            has_intel_gpu: Path::new("/dev/dri").exists(),
            tools,
        }
    }

    /// 按环境给推荐(只推荐、不改配置)。
    pub fn recommend(&self) -> Vec<Recommendation> {
        let profile = self.env_profile();
        let mut out = Vec::new();
        // OCR:没有 NVIDIA 且内存 ≥ 8G → RapidOCR small(CPU 友好)
        let ocr_current = &self.config.extract.ocr_backend;
        out.push(Recommendation {
            kind: ProviderKind::Ocr,
            provider: "rapidocr".to_owned(),
            reason: if profile.has_nvidia {
                "检测到 NVIDIA GPU;RapidOCR(ONNX)仍然更轻,推荐保持默认".to_owned()
            } else {
                "没有独显,CPU 推理:RapidOCR small 精度接近同代 Paddle,内存占用低".to_owned()
            },
            already_current: ocr_current == "rapidocr",
        });
        if self.config.extract.ocr_model_size != "small" && profile.memory_mb < 16_384 {
            out.push(Recommendation {
                kind: ProviderKind::Ocr,
                provider: "rapidocr".to_owned(),
                reason: format!(
                    "内存 {} MB,建议用 small 档模型而不是 medium",
                    profile.memory_mb
                ),
                already_current: false,
            });
        }
        // 转写:装了 whisper 才推荐开
        let whisper_ready =
            kb_extract::ocr::command_exists(&self.config.extract.transcribe_command).is_some();
        out.push(Recommendation {
            kind: ProviderKind::Transcribe,
            provider: self.config.extract.transcribe_command.clone(),
            reason: if whisper_ready {
                "已检测到 whisper.cpp,可以打开音视频转写".to_owned()
            } else {
                "未检测到 whisper.cpp;转写保持关闭(不影响入库)".to_owned()
            },
            already_current: whisper_ready && self.config.extract.transcribe_enabled,
        });
        out
    }
}

/// 内存总量(MB),读 `/proc/meminfo`。
pub fn memory_mb() -> u64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|text| {
            text.lines().find_map(|line| {
                let rest = line.strip_prefix("MemTotal:")?;
                let kb: u64 = rest.trim().trim_end_matches(" kB").trim().parse().ok()?;
                Some(kb / 1024)
            })
        })
        .unwrap_or(0)
}

/// 磁盘可用(GB),用 `df` 的等价实现(statvfs 需要 libc,这里读 `/proc/mounts` 太重,
/// 直接用 `df -k` 一次系统调用)。
pub fn disk_free_gb(path: &Path) -> u64 {
    let output = std::process::Command::new("df")
        .arg("-k")
        .arg(path)
        .output()
        .ok();
    let Some(output) = output else { return 0 };
    let text = String::from_utf8_lossy(&output.stdout);
    // 第二行的第 4 列是可用 KB
    text.lines()
        .nth(1)
        .and_then(|line| line.split_whitespace().nth(3).map(str::to_owned))
        .and_then(|value| value.parse::<u64>().ok())
        .map(|kb| kb / 1024 / 1024)
        .unwrap_or(0)
}

/// 命令是否在 PATH 上。
pub fn command_on_path(command: &str) -> bool {
    kb_extract::ocr::command_exists(command).is_some()
}

/// GPU 名称(读 `nvidia-smi` 或 `/sys/class/drm`)。
pub fn gpu_name() -> Option<String> {
    if command_on_path("nvidia-smi")
        && let Ok(output) = std::process::Command::new("nvidia-smi")
            .arg("--query-gpu=name")
            .arg("--format=csv,noheader")
            .output()
        && output.status.success()
    {
        let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        if !name.is_empty() {
            return Some(name.lines().next().unwrap_or_default().to_owned());
        }
    }
    // Intel 核显:没有统一的名字接口,给个通用描述
    Path::new("/dev/dri")
        .exists()
        .then(|| "Intel 核显(/dev/dri)".to_owned())
}

/// 给测试与调用方用的便捷构造。
pub fn catalog(config: Config, paths: KbPaths) -> Arc<ProviderCatalog> {
    Arc::new(ProviderCatalog::new(config, paths))
}

/// OCR 相关的抽取配置(安装 / 切换时改的是它)。
pub fn extract_config(config: &Config) -> ExtractConfig {
    config.extract.clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_have_chinese_labels() {
        assert_eq!(ProviderKind::Ocr.label(), "文档 OCR");
        assert_eq!(ProviderKind::Transcribe.as_str(), "transcribe");
    }

    #[test]
    fn memory_is_reported() {
        // 任何 Linux 机器都应该有 /proc/meminfo
        assert!(memory_mb() > 0, "读不到内存总量");
    }

    /// 组件页的列表从后端声明(`kb-core/src/backends/`)来:名字、id、条数都对得上。
    #[test]
    fn the_catalog_is_generated_from_backend_declarations() {
        let home = tempfile::tempdir().expect("临时目录");
        let catalog = ProviderCatalog::new(Config::default(), KbPaths::from_home(home.path()));
        let providers = catalog.list();
        let ocr: Vec<_> = providers
            .iter()
            .filter(|item| item.kind == ProviderKind::Ocr)
            .map(|item| (item.id.as_str(), item.name.as_str(), item.current))
            .collect();
        // 默认 `ocr_backend = "rapidocr"`,声明里两条 OCR 后端一条不少
        assert_eq!(ocr.len(), 2, "OCR 后端条数不对:{ocr:?}");
        assert!(
            ocr.iter().any(|(id, name, current)| *id == "rapidocr"
                && name.contains("RapidOCR")
                && *current)
        );
        assert!(
            ocr.iter()
                .any(|(id, _, current)| *id == "tesseract" && !*current)
        );
        // 四类各有一条,顺序是 OCR → 转写 → 嵌入 → 重排
        let kinds: Vec<_> = providers.iter().map(|item| item.kind).collect();
        assert_eq!(
            kinds,
            vec![
                ProviderKind::Ocr,
                ProviderKind::Ocr,
                ProviderKind::Transcribe,
                ProviderKind::Embed,
                ProviderKind::Rerank,
            ]
        );
        assert!(
            catalog.backend_warnings().is_empty(),
            "内置声明不该有 warning"
        );
    }

    /// 声明里有、宿主里没有实现的后端不进组件页(点了只会报错),但注册表能查到。
    #[test]
    fn a_declared_backend_without_an_implementation_stays_out_of_the_catalog() {
        let home = tempfile::tempdir().expect("临时目录");
        let dir = home.path().join("backends").join("paddle");
        std::fs::create_dir_all(&dir).expect("建目录");
        std::fs::write(
            dir.join("manifest.toml"),
            "id = \"paddle\"\nname = \"PaddleOCR\"\nkind = \"ocr\"\n",
        )
        .expect("写声明");
        let catalog = ProviderCatalog::new(Config::default(), KbPaths::from_home(home.path()));
        assert!(
            !catalog.list().iter().any(|item| item.id == "paddle"),
            "宿主没有 paddle 的实现,不该出现在组件页"
        );
        assert!(catalog.registry().get("paddle").is_some(), "注册表要能查到");
    }

    /// `embed.backend` 写成没声明的名字时,组件页那一行要直说,而不是装作正常。
    #[test]
    fn an_undeclared_embed_backend_is_reported_on_its_row() {
        let home = tempfile::tempdir().expect("临时目录");
        let mut config = Config::default();
        config.embed.backend = "typo".to_owned();
        let catalog = ProviderCatalog::new(config, KbPaths::from_home(home.path()));
        let row = catalog
            .list()
            .into_iter()
            .find(|item| item.kind == ProviderKind::Embed)
            .expect("嵌入那一行");
        let detail = row.detail.unwrap_or_default();
        assert!(detail.contains("没有声明"), "detail 实为:{detail}");
    }

    #[test]
    fn disk_free_is_a_number() {
        let free = disk_free_gb(Path::new("/"));
        assert!(free > 0, "根分区可用空间读不到");
    }
}
