//! 后端清单的形状:一份 manifest 声明「我是谁、哪一类、怎么装、怎么探活、改哪些配置键」。
//!
//! 为什么要有它:`<KB_HOME>/skills/` 那套插件是「能力贡献者」(loader rule / 工具),而后端是
//! 「可替换的实现」——OCR 换 tesseract、嵌入换 OpenAI 兼容服务、转写换 whisper,都是同一件事:
//! 用户在 `manifest.toml` 里声明,宿主负责读声明、构造、探活、降级、列给界面。本模块只做**清单**,
//! 构造与降级归各自的实现(B6 起逐个接)。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// 当前认识的 manifest 版本。版本对不上就整份跳过并记 warning,不猜兼容性。
pub const API_VERSION: u32 = 1;

/// 后端种类。与 `kb_service::providers::ProviderKind` 一一对应(那边是给界面用的视图)。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    /// 文档 OCR。
    Ocr,
    /// 音视频转写。
    Transcribe,
    /// 嵌入模型。
    Embed,
    /// 重排模型。
    Rerank,
}

impl BackendKind {
    /// 字符串形式(与 manifest 里的写法一致)。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ocr => "ocr",
            Self::Transcribe => "transcribe",
            Self::Embed => "embed",
            Self::Rerank => "rerank",
        }
    }

    /// 中文名(与设置页的分区标题同一套字)。
    pub fn label(self) -> &'static str {
        match self {
            Self::Ocr => "文档 OCR",
            Self::Transcribe => "音视频转写",
            Self::Embed => "嵌入",
            Self::Rerank => "重排",
        }
    }
}

/// 一份后端声明(`<KB_HOME>/backends/<id>/manifest.toml`)。
///
/// **不认的键一律报错**(`deny_unknown_fields`):写错一个键如果被静默忽略,用户看到的是
/// 「装了但没生效」,比直接报红难查得多——这条与 `[extract.ocr]` 子表同一个理由。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BackendManifest {
    /// 唯一 id,必须与所在目录名一致(`rapidocr` / `tesseract` / `whisper-cli` …)。
    pub id: String,
    /// 显示名。
    pub name: String,
    /// 种类。
    pub kind: BackendKind,
    /// manifest 版本;缺省当作 [`API_VERSION`]。
    #[serde(default = "default_api_version")]
    pub api_version: u32,
    /// 安装命令(一条 shell 命令,由 `kb backend install` 执行;空 = 不支持自动安装)。
    #[serde(default)]
    pub install: Option<String>,
    /// 卸载命令。
    #[serde(default)]
    pub uninstall: Option<String>,
    /// 探活命令 argv:能起来且退出码为 0 就算装好了。
    #[serde(default)]
    pub probe: Option<Vec<String>>,
    /// 一句话说明(装完 / 失败时给界面看)。
    #[serde(default)]
    pub detail: Option<String>,
    /// 这个后端读哪些配置键(切换它要改哪一项)。只用于展示与校验,不参与装配。
    #[serde(default)]
    pub settings: Vec<String>,
}

fn default_api_version() -> u32 {
    API_VERSION
}

impl BackendManifest {
    /// 校验 id 与必填项。返回中文错误(与配置校验同一套口径)。
    fn validate(&self, dir_name: &str) -> Result<(), String> {
        if self.api_version != API_VERSION {
            return Err(format!(
                "manifest 版本是 {},本进程只认 {API_VERSION};升级 kb 或改低 api_version",
                self.api_version
            ));
        }
        if self.id != dir_name {
            return Err(format!(
                "目录名是 {dir_name},manifest 里写的是 {};两者必须一致(按目录定位后端)",
                self.id
            ));
        }
        if !is_valid_id(&self.id) {
            return Err(format!(
                "id「{}」只能用 a-z、0-9、- 和 _,且以字母或数字开头",
                self.id
            ));
        }
        if self.name.trim().is_empty() {
            return Err("name 不能为空".to_owned());
        }
        if let Some(probe) = &self.probe
            && probe.is_empty()
        {
            return Err("probe 写了但是空的;不想探活就整行删掉".to_owned());
        }
        Ok(())
    }
}

/// id 的字符集:小写字母、数字、`-`、`_`,首字符必须是字母或数字。
///
/// 限制字符集是为了让 id 能直接当目录名与命令行参数用,不必到处转义。
pub fn is_valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return false;
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// 一条清单项从哪来。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BackendSource {
    /// 编译进程序的默认实现。
    Builtin,
    /// 来自 `<KB_HOME>/backends/` 下的 manifest。
    Manifest(PathBuf),
}

impl BackendSource {
    /// 中文说明(`kb doctor backends` 打标用)。
    pub fn label(&self) -> String {
        match self {
            Self::Builtin => "内置".to_owned(),
            Self::Manifest(path) => format!("manifest · {}", path.display()),
        }
    }

    /// 是不是覆盖了同 id 的内置条目。
    pub fn is_manifest(&self) -> bool {
        matches!(self, Self::Manifest(_))
    }
}

/// 一条清单项。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackendEntry {
    /// 声明本体。
    pub manifest: BackendManifest,
    /// 来源。
    pub source: BackendSource,
}

impl BackendEntry {
    /// 内置条目。
    pub fn builtin(manifest: BackendManifest) -> Self {
        Self {
            manifest,
            source: BackendSource::Builtin,
        }
    }

    /// id。
    pub fn id(&self) -> &str {
        &self.manifest.id
    }

    /// 种类。
    pub fn kind(&self) -> BackendKind {
        self.manifest.kind
    }
}

/// 解析一份 manifest 文本。`dir_name` 是它所在目录的名字(用来核对 id)。
///
/// 单独暴露给测试与 `kb doctor backends` 的「先看错在哪」用。
pub fn parse_manifest(text: &str, dir_name: &str) -> Result<BackendManifest, String> {
    let manifest: BackendManifest =
        toml::from_str(text).map_err(|err| format!("解析 manifest 失败:{err}"))?;
    manifest.validate(dir_name)?;
    Ok(manifest)
}

/// 目录名(id)是否合法——给注册表在解析前先挡一道。
pub(crate) fn dir_name_of(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
}
