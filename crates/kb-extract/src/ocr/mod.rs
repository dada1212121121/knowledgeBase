//! OCR 后端插件化(从该版本起,2026-10-21 换默认后端)。
//!
//! 两种后端,统一接口([`OcrBackend`]):
//!
//! | 后端 | 运行时 | 模型 | 说明 |
//! |---|---|---|---|
//! | **rapidocr**(默认) | ONNX Runtime(轻量) | **PP-OCRv6**(small 默认 / medium 可配) | 准确率与同代 PaddleOCR 几乎持平,CPU 友好,不需要整装 paddlepaddle |
//! | tesseract(降级) | 系统包 | `chi_sim+eng` | 装了就用作兜底;没装就占位 |
//!
//! 设计要点:
//! - **不硬依赖**:没装 RapidOCR / 模型缺失时,`detect` 报 [`OcrAvailability::MissingRuntime`] /
//!   [`OcrAvailability::MissingModel`],抽取降级成“占位块 + 提示”,不阻塞入库;
//! - **可切换**:配置 `[extract] ocr_backend = "rapidocr" | "tesseract"`,下一次抽取生效;
//! - 调用约定(薄封装脚本 / CLI 都适用):
//!   `rapidocr --image <图片> --model-dir <目录> --model <small|medium> --output json`,
//!   stdout 输出 `{"lines":[{"text":"..."}]}` 或直接输出纯文本(两种都认)。

pub mod installer;
pub mod transcribe;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use kb_core::config::ExtractConfig;

pub use installer::{InstallSnapshot, InstallState, snapshot as install_snapshot, start_install};
pub use transcribe::{TranscribeOutcome, config, install, transcribe_media};

/// OCR 结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OcrOutcome {
    /// 识别出了文字。
    Text(String),
    /// 关掉了 OCR。
    Disabled,
    /// 后端不可用 / 超时 / 失败(带原因,写进块的 caption)。
    Unavailable(String),
    /// 跑了但没识别出文字。
    Empty,
}

/// 后端可用性(设置中心 UI 用)。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OcrAvailability {
    /// 运行时与模型都就绪。
    Ready,
    /// 命令找不到(没装运行时)。
    MissingRuntime(String),
    /// 命令在,但模型目录里没有对应的 onnx。
    MissingModel(String),
}

impl OcrAvailability {
    /// 是否可以直接用。
    pub fn is_ready(&self) -> bool {
        matches!(self, Self::Ready)
    }

    /// 给人看的一句话。
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Ready => None,
            Self::MissingRuntime(reason) | Self::MissingModel(reason) => Some(reason),
        }
    }
}

/// 一个 OCR 后端。
pub trait OcrBackend: Send + Sync {
    /// 后端 id(`rapidocr` / `tesseract`)。
    fn id(&self) -> &'static str;
    /// 是否就绪(命令 + 模型)。
    fn detect(&self) -> OcrAvailability;
    /// 识别一张图片。
    fn ocr_image(&self, path: &Path) -> OcrOutcome;
}

/// 按配置构造后端列表:当前选中的在前,其余作为降级。
pub fn backends(config: &ExtractConfig) -> Vec<Box<dyn OcrBackend>> {
    let rapidocr = Box::new(RapidOcrBackend::new(config.clone())) as Box<dyn OcrBackend>;
    let tesseract = Box::new(TesseractBackend::new(config.clone())) as Box<dyn OcrBackend>;
    match config.ocr_backend.as_str() {
        "tesseract" => vec![tesseract, rapidocr],
        _ => vec![rapidocr, tesseract],
    }
}

/// 对一张图片做 OCR(用当前注入的配置)。
pub fn ocr_image(path: &Path) -> OcrOutcome {
    ocr_image_with(&config(), path)
}

/// 对一张图片做 OCR:按配置顺序尝试,第一个就绪的后端说了算。
pub fn ocr_image_with(config: &ExtractConfig, path: &Path) -> OcrOutcome {
    if !config.ocr_enabled {
        return OcrOutcome::Disabled;
    }
    let mut reasons = Vec::new();
    for backend in backends(config) {
        match backend.detect() {
            OcrAvailability::Ready => return backend.ocr_image(path),
            other => {
                if let Some(reason) = other.reason() {
                    reasons.push(format!("{}: {reason}", backend.id()));
                }
            }
        }
    }
    OcrOutcome::Unavailable(if reasons.is_empty() {
        "没有可用的 OCR 后端".to_owned()
    } else {
        format!("没有可用的 OCR 后端({})", reasons.join("; "))
    })
}

/// RapidOCR(ONNX Runtime + PP-OCRv6)。
pub struct RapidOcrBackend {
    config: ExtractConfig,
}

impl RapidOcrBackend {
    /// 构造。
    pub fn new(config: ExtractConfig) -> Self {
        Self { config }
    }

    /// 模型目录(没配就用 `<KB_HOME>/models/ocr/ppocrv6`)。
    pub fn model_dir(&self) -> PathBuf {
        match self.config.ocr_model_dir.as_deref() {
            Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
            _ => PathBuf::from("models/ocr/ppocrv6"),
        }
    }

    /// 期望的模型文件名(PP-OCRv6 的检测 + 识别两个 onnx)。
    pub fn expected_models(&self) -> Vec<String> {
        let size = self.config.ocr_model_size.as_str();
        vec![
            format!("ppocrv6_det_{size}.onnx"),
            format!("ppocrv6_rec_{size}.onnx"),
        ]
    }
}

impl OcrBackend for RapidOcrBackend {
    fn id(&self) -> &'static str {
        "rapidocr"
    }

    fn detect(&self) -> OcrAvailability {
        if command_exists(&self.config.ocr_command).is_none() {
            return OcrAvailability::MissingRuntime(format!(
                "找不到命令 {};装 rapidocr-onnxruntime 或指向薄封装脚本",
                self.config.ocr_command
            ));
        }
        let dir = self.model_dir();
        let missing: Vec<String> = self
            .expected_models()
            .into_iter()
            .filter(|name| !dir.join(name).is_file())
            .collect();
        if !missing.is_empty() {
            return OcrAvailability::MissingModel(format!(
                "{} 缺少 {}",
                dir.display(),
                missing.join(" / ")
            ));
        }
        OcrAvailability::Ready
    }

    fn ocr_image(&self, path: &Path) -> OcrOutcome {
        let dir = self.model_dir();
        let args = vec![
            "--image".to_owned(),
            path.to_string_lossy().into_owned(),
            "--model-dir".to_owned(),
            dir.to_string_lossy().into_owned(),
            "--model".to_owned(),
            self.config.ocr_model_size.clone(),
            "--output".to_owned(),
            "json".to_owned(),
        ];
        match run_with_timeout(&self.config.ocr_command, &args, Duration::from_secs(120)) {
            Ok(stdout) => text_of_ocr_output(&stdout),
            Err(err) => OcrOutcome::Unavailable(err),
        }
    }
}

/// Tesseract(降级后端)。
pub struct TesseractBackend {
    config: ExtractConfig,
}

impl TesseractBackend {
    /// 构造。
    pub fn new(config: ExtractConfig) -> Self {
        Self { config }
    }
}

impl OcrBackend for TesseractBackend {
    fn id(&self) -> &'static str {
        "tesseract"
    }

    fn detect(&self) -> OcrAvailability {
        match command_exists(&self.config.ocr_fallback_command) {
            Some(_) => OcrAvailability::Ready,
            None => OcrAvailability::MissingRuntime(format!(
                "找不到命令 {};装上 tesseract 即可作为降级后端",
                self.config.ocr_fallback_command
            )),
        }
    }

    fn ocr_image(&self, path: &Path) -> OcrOutcome {
        let args = vec![
            path.to_string_lossy().into_owned(),
            "stdout".to_owned(),
            "-l".to_owned(),
            self.config.ocr_language.clone(),
        ];
        match run_with_timeout(
            &self.config.ocr_fallback_command,
            &args,
            Duration::from_secs(60),
        ) {
            Ok(stdout) => text_of_ocr_output(&stdout),
            Err(err) => OcrOutcome::Unavailable(err),
        }
    }
}

/// OCR 输出 → 结果:先按 JSON(`{"lines":[{"text":…}]}`)解析,失败就当纯文本。
pub fn text_of_ocr_output(stdout: &str) -> OcrOutcome {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return OcrOutcome::Empty;
    }
    if trimmed.starts_with('{')
        && let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed)
        && let Some(lines) = value.get("lines").and_then(serde_json::Value::as_array)
    {
        let text = lines
            .iter()
            .filter_map(|line| line.get("text").and_then(serde_json::Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        let text = text.trim().to_owned();
        return if text.is_empty() {
            OcrOutcome::Empty
        } else {
            OcrOutcome::Text(text)
        };
    }
    OcrOutcome::Text(trimmed.to_owned())
}

/// 命令是否存在:给了路径就看文件,否则沿 `PATH` 找一个可执行文件。
///
/// 不再用 `--version` 探活:每次探测要真的拉起一个进程(rapidocr 约 30 ms、whisper-cli 约 60 ms),
/// 系统状态页一次刷新要探好几遍,是它变慢的主要原因。代价是“文件存在但解释器坏了”的脚本
/// 会被当成存在,真正跑的时候(`run_with_timeout`)仍会得到明确的错误。
pub fn command_exists(command: &str) -> Option<()> {
    if command.is_empty() {
        return None;
    }
    let path = Path::new(command);
    if path.components().count() > 1 {
        return is_executable_file(path).then_some(());
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .any(|dir| is_executable_file(&dir.join(command)))
        .then_some(())
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// 跑一个命令并取 stdout(带超时;命令不存在时返回原因)。
pub(crate) fn run_with_timeout(
    command: &str,
    args: &[String],
    timeout: Duration,
) -> Result<String, String> {
    let mut child = Command::new(command)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("命令 {command} 不可用: {err}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let output = child
                    .wait_with_output()
                    .map_err(|err| format!("读取 {command} 输出失败: {err}"))?;
                if !status.success() {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let stderr = stderr.trim();
                    return Err(if stderr.is_empty() {
                        format!("{command} 退出码 {:?}", status.code())
                    } else {
                        format!("{command} 失败: {stderr}")
                    });
                }
                return Ok(String::from_utf8_lossy(&output.stdout).into_owned());
            }
            Ok(None) => {
                if started.elapsed() > timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{command} 超时({}s)", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(err) => return Err(format!("等待 {command} 失败: {err}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn command_exists_checks_path_and_exec_bit_without_spawning() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("kb-cmd-exists-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建目录");
        let exe = dir.join("fake-tool");
        std::fs::write(&exe, "#!/nonexistent-interpreter\n").expect("写文件");
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).expect("权限");
        let plain = dir.join("not-exec");
        std::fs::write(&plain, "x").expect("写文件");
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).expect("权限");

        // 带路径:解释器坏了也算存在(不会真的执行);没有执行位或不存在都算没有
        assert!(command_exists(exe.to_str().expect("utf8")).is_some());
        assert!(command_exists(plain.to_str().expect("utf8")).is_none());
        assert!(command_exists(dir.join("missing").to_str().expect("utf8")).is_none());
        assert!(command_exists("").is_none());
        // 不带路径:沿 PATH 找
        assert!(command_exists("sh").is_some());
        assert!(command_exists("kb-definitely-not-a-command").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn config() -> ExtractConfig {
        ExtractConfig::default()
    }

    #[test]
    fn rapidocr_is_the_default_backend() {
        let config = config();
        assert_eq!(config.ocr_backend, "rapidocr");
        assert_eq!(config.ocr_command, "rapidocr");
        assert_eq!(config.ocr_model_size, "small");
        assert!(!config.ocr_enabled, "默认仍然关闭,开启才跑");
    }

    #[test]
    fn expected_models_follow_the_size() {
        let mut config = config();
        let backend = RapidOcrBackend::new(config.clone());
        assert_eq!(
            backend.expected_models(),
            vec!["ppocrv6_det_small.onnx", "ppocrv6_rec_small.onnx"]
        );
        config.ocr_model_size = "medium".to_owned();
        let backend = RapidOcrBackend::new(config);
        assert_eq!(
            backend.expected_models(),
            vec!["ppocrv6_det_medium.onnx", "ppocrv6_rec_medium.onnx"]
        );
    }

    #[test]
    fn missing_runtime_and_model_are_reported_separately() {
        let mut config = config();
        config.ocr_command = "definitely-not-rapidocr".to_owned();
        let backend = RapidOcrBackend::new(config.clone());
        assert!(matches!(
            backend.detect(),
            OcrAvailability::MissingRuntime(_)
        ));
        // 用一个存在的命令(这里用 sh)+ 不存在的模型目录 → MissingModel
        config.ocr_command = "sh".to_owned();
        config.ocr_model_dir = Some("/nonexistent/ppocrv6".to_owned());
        let backend = RapidOcrBackend::new(config);
        assert!(matches!(backend.detect(), OcrAvailability::MissingModel(_)));
    }

    #[test]
    fn json_and_plain_outputs_are_both_accepted() {
        assert_eq!(
            text_of_ocr_output(r#"{"lines":[{"text":"发票金额"},{"text":"1200 元"}]}"#),
            OcrOutcome::Text("发票金额\n1200 元".to_owned())
        );
        assert_eq!(
            text_of_ocr_output("纯文本输出"),
            OcrOutcome::Text("纯文本输出".to_owned())
        );
        assert_eq!(text_of_ocr_output("   "), OcrOutcome::Empty);
    }

    #[test]
    fn fallback_order_follows_the_config() {
        let mut config = config();
        let ids: Vec<&str> = backends(&config).iter().map(|b| b.id()).collect();
        assert_eq!(ids, vec!["rapidocr", "tesseract"]);
        config.ocr_backend = "tesseract".to_owned();
        let ids: Vec<&str> = backends(&config).iter().map(|b| b.id()).collect();
        assert_eq!(ids, vec!["tesseract", "rapidocr"]);
    }
}
