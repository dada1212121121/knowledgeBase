//! 提取类配置:Office / 编辑器 / 旧格式转换、OCR、转写。
//!
//! 由 `config.rs` 拆出:路径不变,入口仍是 `kb_core::config`。
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::Duration;

/// `[web_extract]`:网页来源抓到的页面交给内置模型整理成规范化结果。
///
/// 每次后台任务分片时现读,改完下一页就生效(热更新)。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct WebExtractConfig {
    /// 新建网页数据源时,「AI 规范化」开关的默认值。只影响新建,不改已有的数据源。
    pub enabled_by_default: bool,
    /// 单次送给模型的正文上限(字符)。超长页面按块边界切段,每段一次调用。
    /// 默认 24000,与提炼的 `MAX_INPUT_CHARS` 同一量级(约 8k token)。
    pub max_input_chars: usize,
    /// 超长页面最多切几段;超出的部分不送模型(原文仍完整入库)。
    pub max_parts: usize,
    /// 每次同步最多整理几页;其余留到下次同步补,防止一个大站一次花光当天额度。
    pub max_pages_per_sync: usize,
}

impl WebExtractConfig {
    /// `max_input_chars` 的取值范围:太小切得太碎、调用次数暴涨;太大超过常见模型的上下文。
    pub const INPUT_CHARS_RANGE: std::ops::RangeInclusive<usize> = 2_000..=200_000;
    /// `max_parts` 的上限。
    pub const MAX_PARTS: usize = 20;
    /// `max_pages_per_sync` 的上限(与抓取的页数上限 200 对齐)。
    pub const MAX_PAGES_PER_SYNC: usize = 200;
}

impl Default for WebExtractConfig {
    fn default() -> Self {
        Self {
            enabled_by_default: true,
            max_input_chars: 24_000,
            max_parts: 4,
            max_pages_per_sync: 50,
        }
    }
}

/// 声明式 skills（设计规范）。
///
/// `~/.kb/skills/<name>/manifest.toml` 里的规则在守护进程启动时扫描并热加载;
/// 这里只有开关:**默认不允许可执行脚本类 skill**(只允许声明式的 loader-rule / prompt / insight-template)。
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SkillsConfig {
    /// 是否允许加载可执行脚本类 skill。
    pub allow_exec: bool,
    /// bwrap 沙箱不可用时,是否允许插件进程裸跑。
    ///
    /// 默认 `false`:进程钩子宁可被禁用,也不能悄悄脱离沙箱。只有管理员确认
    /// 机器没有可用沙箱、仍要运行插件时才显式打开;打开后设置页的告警里会标出来。
    pub allow_unsandboxed: bool,
}

/// `[extract.ocr]`:OCR 的**资源**参数——同时跑几份、单份多久、最多几页。
///
/// 与 `[extract]` 上面那批 `ocr_*` 键分开:那批是“用哪个后端、哪个命令、哪个模型”(换后端),
/// 这批是“允许多猛”(管机器)。三项原先都是 `kb-extract/src/pdf.rs` 里的常量,只能改代码重编,
/// 而它们恰恰是最常需要按机器调整的:`slots` 影响了 16 核机器会不会被打到 load 89。
///
/// **生效方式**:整份 `[extract]` 在进程启动时注入一次(`main.rs` 的 `kb_extract::install`),
/// 所以这三项改了都要**重启守护进程**才生效,不是热更新(`classify_change` 也按重启算)。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct OcrConfig {
    /// 同时 OCR 几份文件;`0` = 按核数自动(核数/4,夹 1..=4),与搬迁前的常量行为一致。
    pub slots: usize,
    /// 单份文件的 OCR 总时长上限(秒)。到点就停,剩下的页继续留 `needs_ocr` 提示。
    ///
    /// 页数上限管不住“每页都很慢”(大页面、复杂版式):两者一起才保证单个文件不会失控。
    pub budget_secs: u64,
    /// 单份 PDF 最多 OCR 多少页。
    ///
    /// 扫描件动辄几百页,单页约 0.3~1 秒:不设上限时一个文件能把入库队列占住十几分钟
    /// (入库是单并发 FIFO,后面几百份文件都得等)。
    pub max_pages: usize,
}

impl OcrConfig {
    /// `slots` 的上限:再多也不是“更快”,只是把机器压垮的姿势变了。
    pub const MAX_SLOTS: usize = 16;
    /// `budget_secs` 的取值范围。
    pub const BUDGET_RANGE: std::ops::RangeInclusive<u64> = 30..=3_600;
    /// `max_pages` 的上限。
    pub const MAX_PAGES: usize = 500;

    /// 同时 OCR 几份文件(传本机核数进来,纯函数好测)。
    ///
    /// `slots = 0`(默认)按核数自动算,公式与搬迁前的 `ocr_slots` 一字不差;
    /// 非 0 就用它自己,再夹到 [`Self::MAX_SLOTS`]。
    pub fn effective_slots(&self, cores: usize) -> usize {
        if self.slots == 0 {
            (cores / 4).clamp(1, 4)
        } else {
            self.slots.min(Self::MAX_SLOTS)
        }
    }

    /// 单份文件的 OCR 预算(至少 1 秒,避免 0 让循环第一次就退出)。
    pub fn budget(&self) -> Duration {
        Duration::from_secs(self.budget_secs.max(1))
    }

    /// 单份 PDF 最多 OCR 几页(至少 1 页)。
    pub fn page_cap(&self) -> usize {
        self.max_pages.clamp(1, Self::MAX_PAGES)
    }
}

impl Default for OcrConfig {
    /// 默认值与搬迁前的常量一致(40 页 / 300 秒 / 名额按核数自动)。
    fn default() -> Self {
        Self {
            slots: 0,
            budget_secs: 300,
            max_pages: 40,
        }
    }
}

/// 多格式抽取。
///
/// OCR 与转写都依赖外部命令(tesseract / whisper.cpp),默认**关闭**;
/// 关闭或命令不可用时降级成“占位块 + 提示”,不阻塞入库。
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct ExtractConfig {
    /// 是否对图片做 OCR。
    #[serde(default)]
    pub ocr_enabled: bool,
    /// OCR 后端:`rapidocr`(默认,ONNX + PP-OCRv6)/ `tesseract`(降级)。
    #[serde(default = "default_ocr_backend")]
    pub ocr_backend: String,
    /// RapidOCR 命令(默认 `rapidocr`;也可以指向薄封装脚本)。
    #[serde(default = "default_ocr_command")]
    pub ocr_command: String,
    /// PP-OCRv6 模型目录(默认 `<KB_HOME>/models/ocr/ppocrv6`)。
    #[serde(default)]
    pub ocr_model_dir: Option<String>,
    /// 模型档位:`small`(默认)/ `medium`。
    #[serde(default = "default_ocr_model_size")]
    pub ocr_model_size: String,
    /// 降级后端(tesseract)的命令。
    #[serde(default = "default_ocr_fallback_command")]
    pub ocr_fallback_command: String,
    /// 降级后端的语言(默认 `chi_sim+eng`)。
    #[serde(default = "default_ocr_language")]
    pub ocr_language: String,
    /// 安装 / 下载 RapidOCR 与模型的命令(设置中心的“下载”按钮会跑它)。
    #[serde(default = "default_ocr_install_command")]
    pub ocr_install_command: String,
    /// 是否对音视频做转写。
    #[serde(default)]
    pub transcribe_enabled: bool,
    /// 转写命令(默认 `whisper-cli`;参数固定为 `-m <模型> -f <文件> -nt` 一类)。
    #[serde(default = "default_transcribe_command")]
    pub transcribe_command: String,
    /// 转写模型路径(为空时命令自己找)。
    #[serde(default)]
    pub transcribe_model: Option<String>,
    /// 安装 / 下载转写运行时与模型的命令(设置中心的“下载”按钮会跑它)。
    #[serde(default = "default_transcribe_install_command")]
    pub transcribe_install_command: String,
    /// 单个音视频最长处理多少秒(超出只转前段)。
    #[serde(default = "default_media_seconds")]
    pub max_media_seconds: u64,
    /// OCR 的资源参数(`[extract.ocr]` 子表,B4)。
    #[serde(default)]
    pub ocr: OcrConfig,
}

fn default_ocr_backend() -> String {
    "rapidocr".to_owned()
}

fn default_ocr_command() -> String {
    "rapidocr".to_owned()
}

fn default_ocr_model_size() -> String {
    "small".to_owned()
}

fn default_ocr_fallback_command() -> String {
    "tesseract".to_owned()
}

fn default_ocr_install_command() -> String {
    "rapidocr --install --model-dir models/ocr/ppocrv6".to_owned()
}

fn default_ocr_language() -> String {
    "chi_sim+eng".to_owned()
}

fn default_transcribe_command() -> String {
    "whisper-cli".to_owned()
}

fn default_media_seconds() -> u64 {
    1800
}

fn default_transcribe_install_command() -> String {
    "whisper-cli --install --model-dir models/whisper".to_owned()
}

impl Default for ExtractConfig {
    /// 默认:OCR 与转写都关,但命令名先填好(打开即用)。
    fn default() -> Self {
        Self {
            ocr_enabled: false,
            ocr_backend: default_ocr_backend(),
            ocr_command: default_ocr_command(),
            ocr_model_dir: None,
            ocr_model_size: default_ocr_model_size(),
            ocr_fallback_command: default_ocr_fallback_command(),
            ocr_language: default_ocr_language(),
            ocr_install_command: default_ocr_install_command(),
            transcribe_enabled: false,
            transcribe_command: default_transcribe_command(),
            transcribe_model: None,
            transcribe_install_command: default_transcribe_install_command(),
            max_media_seconds: default_media_seconds(),
            ocr: OcrConfig::default(),
        }
    }
}

/// `[office]`:办公文档(docx / xlsx / pptx)在线编辑。
///
/// 保存时新内容替换原文件,旧内容记成版本备份(按内容寻址的字节副本)。每个文件的备份份数有上限,
/// 超出的从最旧的开始删,备份文件没人引用了也一起删。每次读,所以改了立即生效。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct OfficeConfig {
    /// 除了当前这一版,每个文件再留几份旧版本(0 = 不留,保存后旧内容就没了)。
    pub keep_versions: usize,
    /// 多人实时协同。关掉后所有人都退回单人编辑(编辑权 + 心跳）。
    pub collab: bool,
    /// 跑协同服务(office-worker)用的 Node(要 22 以上);默认从 PATH 里找 `node`。
    pub node: String,
    /// office-worker 的目录(含 `src/index.mjs` 和装好的依赖);为空时按约定位置找(见 `kb-cli/src/office_collab.rs`)。
    pub worker_dir: Option<String>,
    /// AI(MCP)能不能**直接**改文档。默认只能提建议,由人接受才生效。
    pub agent_direct_edit: bool,
}

impl OfficeConfig {
    /// 旧版本份数的上限。
    pub const MAX_KEEP_VERSIONS: usize = 50;
}

impl Default for OfficeConfig {
    fn default() -> Self {
        Self {
            keep_versions: 3,
            collab: true,
            node: "node".to_owned(),
            worker_dir: None,
            agent_direct_edit: false,
        }
    }
}

/// `[editor]`:编辑器扩展。
///
/// 第三方扩展 v1 只支持**本地可信目录**:管理员把扩展目录放进 `extensions_dir`,守护进程只负责
/// 列出清单、原样下发扩展目录里的静态文件,真正的 JS 在管理员的浏览器页面里运行(同源、与页面同权)。
/// 所以开关**默认关**,也不进设置页表单——能改 `config.toml` 的人才有资格决定要不要运行这些脚本。
/// 两个键都是每个请求现读,改完立即生效(热更新)。
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct EditorConfig {
    /// 是否从 `extensions_dir` 加载扩展。关着时清单接口返回空列表,文件接口一律 404。
    pub extensions: bool,
    /// 扩展目录;缺省 = `<KB_HOME>/editor-extensions`。写绝对路径,或相对 `KB_HOME` 的路径(不能含 `..`)。
    pub extensions_dir: Option<String>,
}

impl EditorConfig {
    /// 缺省的扩展目录名(位于 `KB_HOME` 下)。
    pub const DEFAULT_DIR_NAME: &str = "editor-extensions";

    /// 解析出实际的扩展目录:未配置用 `<home>/editor-extensions`,相对路径相对 `home`。
    ///
    /// 只做路径拼接,不检查目录是否存在(没建目录就是「没有任何扩展」,不是错误)。
    pub fn resolved_dir(&self, home: &Path) -> std::path::PathBuf {
        match self.extensions_dir.as_deref().map(str::trim) {
            Some(dir) if !dir.is_empty() => {
                let path = Path::new(dir);
                if path.is_absolute() {
                    path.to_path_buf()
                } else {
                    home.join(path)
                }
            }
            _ => home.join(Self::DEFAULT_DIR_NAME),
        }
    }
}

/// `[convert]`:旧格式 Office 文件(doc / xls / ods / odt / rtf 等)入库时转成 OOXML。
///
/// 转换器是外部程序(LibreOffice 无界面),**默认关闭**;没装或没找到时降级成「原样保存、只读显示」,
/// 不阻塞入库。转换会占约 320 MB 内存,所以同时转换的个数有上限。
/// 这些键都只在启动时读(转换器在组装根里建),改了提示重启。
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct ConvertConfig {
    /// 是否开启。
    pub enabled: bool,
    /// LibreOffice 的安装目录(含 `program/soffice`);为空时用 `<KB_HOME>/bin/libreoffice`。
    pub install_dir: Option<String>,
    /// 额外的动态库目录,会作为 `LD_LIBRARY_PATH` 传给转换器进程(冒号分隔)。
    /// 用 Debian 包解开的安装需要它(`soffice.bin` 只在自己的目录里找库,聚合的依赖库在别处);
    /// 官方整包通常自带这些库,不需要。
    pub library_path: Option<String>,
    /// 单个文件最长转换多少秒,超时即杀。
    pub timeout_secs: u64,
    /// 同时转换几个文件(每个进程峰值约 320 MB 内存)。
    pub max_concurrent: usize,
}

impl ConvertConfig {
    /// 单个文件超时的上限(秒)。
    pub const MAX_TIMEOUT_SECS: u64 = 3600;
    /// 并发转换数的上限。
    pub const MAX_CONCURRENT: usize = 8;
}

impl Default for ConvertConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            install_dir: None,
            library_path: None,
            timeout_secs: 120,
            max_concurrent: 1,
        }
    }
}
