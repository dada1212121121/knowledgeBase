//! 音视频转写:外部命令(默认 `whisper-cli`),超时与失败降级。

use std::path::Path;
use std::time::Duration;

use kb_core::config::ExtractConfig;

use super::run_with_timeout;

/// 注入的配置(进程内一次)。
static CONFIG: std::sync::OnceLock<ExtractConfig> = std::sync::OnceLock::new();

/// 注入抽取配置(进程内只生效一次;重复调用返回 `false`)。
pub fn install(config: ExtractConfig) -> bool {
    CONFIG.set(config).is_ok()
}

/// 当前配置(没注入就是默认值:OCR 与转写都关)。
pub fn config() -> ExtractConfig {
    CONFIG.get().cloned().unwrap_or_default()
}

/// 转写结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TranscribeOutcome {
    /// 转写出的文本。
    Text(String),
    /// 关掉了转写。
    Disabled,
    /// 命令不可用 / 超时 / 失败。
    Unavailable(String),
    /// 跑了但没有文字。
    Empty,
}

/// 对一段音视频做转写。
pub fn transcribe_media(path: &Path) -> TranscribeOutcome {
    let config = config();
    if !config.transcribe_enabled {
        return TranscribeOutcome::Disabled;
    }
    let mut args = vec!["-f".to_owned(), path.to_string_lossy().into_owned()];
    if let Some(model) = &config.transcribe_model {
        args.push("-m".to_owned());
        args.push(model.clone());
    }
    args.push("-nt".to_owned());
    args.push("-np".to_owned());
    // 转写很慢:超时按“最长处理时长 × 2”给,最少 10 分钟
    let timeout = Duration::from_secs((config.max_media_seconds * 2).max(600));
    match run_with_timeout(&config.transcribe_command, &args, timeout) {
        Ok(text) => {
            let text = text.trim().to_owned();
            if text.is_empty() {
                TranscribeOutcome::Empty
            } else {
                TranscribeOutcome::Text(text)
            }
        }
        Err(err) => TranscribeOutcome::Unavailable(err),
    }
}
