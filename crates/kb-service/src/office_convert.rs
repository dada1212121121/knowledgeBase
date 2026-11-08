//! 旧格式 Office 文件转成 OOXML(LibreOffice 无界面模式)。
//!
//! 只做「调用转换器并检查结果」这一层:接入入库流程、迁移已有文件是另外的事。
//! 转换器是外部程序,没装就找不到(见 [`Converter::locate`]),调用方据此退回「原样保存、只读显示」。
//!
//! 实测(实测报告)得到的几条约束都在这里落成了检查:
//! - **退出码 0 不代表成功**:加载失败时 LibreOffice 照样退出 0、不产出文件,所以以「产出文件存在且合法」为准;
//! - **0 字节的输入会被转成空白文档**:输入为空直接拒绝,不去调用转换器;
//! - 每次转换用独立的用户配置目录和 HOME,互不干扰,转完整个删掉;
//! - 有超时,超时即杀;同时转换的个数有上限(每个进程峰值约 320 MB 内存)。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tokio::process::Command;
use tokio::sync::Semaphore;

/// 转换后的格式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    /// Word。
    Docx,
    /// Excel。
    Xlsx,
    /// PowerPoint。
    Pptx,
}

impl Target {
    /// 按旧文件的扩展名决定转成什么;不认识的返回 `None`。
    pub fn for_extension(ext: &str) -> Option<Self> {
        match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
            "doc" | "rtf" | "odt" | "wps" => Some(Self::Docx),
            "xls" | "ods" | "et" => Some(Self::Xlsx),
            "ppt" | "odp" | "dps" => Some(Self::Pptx),
            _ => None,
        }
    }

    /// 这几种扩展名有真实样本验证过转换质量(文字无损);其余(ppt / odp / wps / et / dps)没有证据。
    /// 入库流程应只对这几种自动转换。
    pub fn is_verified_extension(ext: &str) -> bool {
        matches!(
            ext.trim_start_matches('.').to_ascii_lowercase().as_str(),
            "doc" | "rtf" | "odt" | "xls" | "ods"
        )
    }

    /// 转换后文件的扩展名。
    pub fn extension(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
        }
    }

    /// 合法产物里一定有的主文件。
    fn main_part(self) -> &'static str {
        match self {
            Self::Docx => "word/document.xml",
            Self::Xlsx => "xl/workbook.xml",
            Self::Pptx => "ppt/presentation.xml",
        }
    }
}

/// 转换失败的原因。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConvertError {
    /// 扩展名不在支持的旧格式里。
    Unsupported(String),
    /// 输入是空文件(LibreOffice 会把它转成空白文档,必须拦掉)。
    EmptyInput,
    /// 读写文件出错。
    Io(String),
    /// 启动转换器失败(没装、没有执行权限等)。
    Spawn(String),
    /// 超时被杀掉。
    Timeout,
    /// 转换器以非零状态退出。
    Failed(String),
    /// 退出码是 0,但没有产出合法文件(加载失败时就是这样)。
    BadOutput(String),
}

impl std::fmt::Display for ConvertError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsupported(ext) => write!(f, "不支持转换的格式:{ext}"),
            Self::EmptyInput => write!(f, "输入文件是空的"),
            Self::Io(detail) => write!(f, "读写文件出错:{detail}"),
            Self::Spawn(detail) => write!(f, "无法启动转换器:{detail}"),
            Self::Timeout => write!(f, "转换超时"),
            Self::Failed(detail) => write!(f, "转换失败:{detail}"),
            Self::BadOutput(detail) => write!(f, "转换没有产出合法文件:{detail}"),
        }
    }
}

impl std::error::Error for ConvertError {}

/// LibreOffice 无界面转换器。
#[derive(Clone)]
pub struct Converter {
    soffice: PathBuf,
    work_dir: PathBuf,
    timeout: Duration,
    gate: Arc<Semaphore>,
    extra_env: Vec<(String, String)>,
}

impl Converter {
    /// `soffice` 是可执行文件,`work_dir` 放每次转换的临时目录,
    /// `max_concurrent` 是同时转换的上限(至少 1)。
    pub fn new(
        soffice: PathBuf,
        work_dir: PathBuf,
        timeout: Duration,
        max_concurrent: usize,
    ) -> Self {
        Self {
            soffice,
            work_dir,
            timeout,
            gate: Arc::new(Semaphore::new(max_concurrent.max(1))),
            extra_env: Vec::new(),
        }
    }

    /// 给转换器进程加环境变量(比如装在项目目录里时的 `LD_LIBRARY_PATH`)。
    pub fn with_env(mut self, key: &str, value: &str) -> Self {
        self.extra_env.push((key.to_owned(), value.to_owned()));
        self
    }

    /// 在安装目录里找 `soffice`:`<目录>/program/soffice` 或 `<目录>/soffice`。没装就是 `None`。
    pub fn locate(install_dir: &Path) -> Option<PathBuf> {
        [
            install_dir.join("program").join("soffice"),
            install_dir.join("soffice"),
        ]
        .into_iter()
        .find(|candidate| candidate.is_file())
    }

    /// 按配置建转换器(组装根里用)。没开、或者在安装目录里找不到 `soffice`,返回 `None`——
    /// 调用方据此退回「旧格式原样保存、只读显示」;开了却找不到时写一条警告,免得悄悄不生效。
    ///
    /// `default_install_dir` 是配置里没写 `install_dir` 时用的目录(`<KB_HOME>/bin/libreoffice`)。
    pub fn from_config(
        config: &kb_core::config::ConvertConfig,
        default_install_dir: &Path,
        work_dir: PathBuf,
    ) -> Option<Self> {
        if !config.enabled {
            return None;
        }
        let install_dir = config
            .install_dir
            .as_deref()
            .map(PathBuf::from)
            .unwrap_or_else(|| default_install_dir.to_path_buf());
        let Some(soffice) = Self::locate(&install_dir) else {
            tracing::warn!(
                dir = %install_dir.display(),
                "[convert] 已开启,但在安装目录里没找到 soffice:旧格式 Office 文件照旧原样保存、只读显示"
            );
            return None;
        };
        let mut converter = Self::new(
            soffice,
            work_dir,
            Duration::from_secs(config.timeout_secs),
            config.max_concurrent,
        );
        if let Some(library_path) = &config.library_path {
            converter = converter.with_env("LD_LIBRARY_PATH", library_path);
        }
        Some(converter)
    }

    /// 把 `input` 转成 OOXML,返回转换后的格式和字节。输入文件本身不会被改动。
    pub async fn convert(&self, input: &Path) -> Result<(Target, Vec<u8>), ConvertError> {
        let ext = input
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let target =
            Target::for_extension(ext).ok_or_else(|| ConvertError::Unsupported(ext.to_owned()))?;
        let size = tokio::fs::metadata(input)
            .await
            .map_err(|err| ConvertError::Io(format!("{}: {err}", input.display())))?
            .len();
        if size == 0 {
            return Err(ConvertError::EmptyInput);
        }
        let _permit = self
            .gate
            .acquire()
            .await
            .map_err(|_| ConvertError::Io("并发闸门已关闭".to_owned()))?;
        let job_dir = self
            .work_dir
            .join(format!("convert-{}", uuid::Uuid::now_v7()));
        let result = self.run(input, target, &job_dir).await;
        // 成功失败都把临时目录(含 LibreOffice 的用户配置)删干净
        let _ = tokio::fs::remove_dir_all(&job_dir).await;
        result.map(|bytes| (target, bytes))
    }

    async fn run(
        &self,
        input: &Path,
        target: Target,
        job_dir: &Path,
    ) -> Result<Vec<u8>, ConvertError> {
        let (profile, out, home) = (
            job_dir.join("profile"),
            job_dir.join("out"),
            job_dir.join("home"),
        );
        for dir in [&profile, &out, &home] {
            tokio::fs::create_dir_all(dir)
                .await
                .map_err(|err| ConvertError::Io(format!("{}: {err}", dir.display())))?;
        }
        let mut command = Command::new(&self.soffice);
        command
            .args(["--headless", "--norestore", "--nolockcheck", "--nodefault"])
            .arg(format!(
                "-env:UserInstallation=file://{}",
                profile.display()
            ))
            .arg("--convert-to")
            .arg(target.extension())
            .arg("--outdir")
            .arg(&out)
            .arg(input)
            .env("HOME", &home)
            // 超时时 future 被丢掉,进程跟着被杀
            .kill_on_drop(true);
        for (key, value) in &self.extra_env {
            command.env(key, value);
        }
        let mut attempts = 0;
        let output = loop {
            match tokio::time::timeout(self.timeout, command.output()).await {
                Err(_) => return Err(ConvertError::Timeout),
                // 刚解开 / 刚写好的可执行文件可能短暂处于「正在被写」的状态,稍等重试
                Ok(Err(err))
                    if err.kind() == std::io::ErrorKind::ExecutableFileBusy && attempts < 3 =>
                {
                    attempts += 1;
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Ok(Err(err)) => return Err(ConvertError::Spawn(err.to_string())),
                Ok(Ok(output)) => break output,
            }
        };
        let stderr_tail = String::from_utf8_lossy(&output.stderr)
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_owned();
        if !output.status.success() {
            return Err(ConvertError::Failed(format!(
                "{}{}",
                output.status,
                if stderr_tail.is_empty() {
                    String::new()
                } else {
                    format!(":{stderr_tail}")
                }
            )));
        }
        let stem = input
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or("out");
        let produced = out.join(format!("{stem}.{}", target.extension()));
        let bytes = tokio::fs::read(&produced).await.map_err(|_| {
            ConvertError::BadOutput(format!("没有产出文件(转换器说:{stderr_tail})"))
        })?;
        validate_output(&bytes, target)?;
        Ok(bytes)
    }
}

/// 产物必须非空、是 zip、且含该格式的主文件。
fn validate_output(bytes: &[u8], target: Target) -> Result<(), ConvertError> {
    if bytes.is_empty() {
        return Err(ConvertError::BadOutput("产出文件是空的".to_owned()));
    }
    if !bytes.starts_with(b"PK\x03\x04") {
        return Err(ConvertError::BadOutput("产出文件不是 zip".to_owned()));
    }
    let part = target.main_part().as_bytes();
    if !bytes.windows(part.len()).any(|window| window == part) {
        return Err(ConvertError::BadOutput(format!(
            "产出文件里没有 {}",
            target.main_part()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::Instant;

    /// 写一个假的 soffice:解析出 `--outdir` 和最后一个参数(输入文件),再执行 `body`。
    fn fake_soffice(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("fake-soffice");
        let script = format!(
            "#!/bin/sh\nout=''; prev=''; last=''\nfor a in \"$@\"; do\n  if [ \"$prev\" = '--outdir' ]; then out=\"$a\"; fi\n  prev=\"$a\"; last=\"$a\"\ndone\nstem=$(basename \"$last\"); stem=\"${{stem%.*}}\"\n{body}\n"
        );
        std::fs::write(&path, script).expect("写假 soffice");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("加执行权限");
        path
    }

    /// 产出一个带 word/document.xml 名字的最小 zip 头(够过合法性检查)。
    const GOOD_DOCX: &str = "printf 'PK\\003\\004....word/document.xml....' > \"$out/$stem.docx\"";

    fn converter(dir: &Path, body: &str, timeout: Duration, concurrent: usize) -> Converter {
        Converter::new(
            fake_soffice(dir, body),
            dir.join("work"),
            timeout,
            concurrent,
        )
    }

    fn input(dir: &Path, name: &str, content: &[u8]) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, content).expect("写输入");
        path
    }

    #[test]
    fn extensions_map_to_targets_and_only_verified_ones_are_auto() {
        assert_eq!(Target::for_extension("DOC"), Some(Target::Docx));
        assert_eq!(Target::for_extension(".xls"), Some(Target::Xlsx));
        assert_eq!(Target::for_extension("ppt"), Some(Target::Pptx));
        assert_eq!(Target::for_extension("pdf"), None);
        assert!(Target::is_verified_extension("doc"));
        assert!(Target::is_verified_extension("ods"));
        // 没有真实样本的:不在自动转换的名单里
        for ext in ["ppt", "odp", "wps", "et", "dps"] {
            assert!(!Target::is_verified_extension(ext), "{ext}");
        }
    }

    #[tokio::test]
    async fn converts_and_returns_the_produced_docx() {
        let dir = tempfile::tempdir().expect("临时目录");
        let c = converter(dir.path(), GOOD_DOCX, Duration::from_secs(10), 2);
        let (target, bytes) = c
            .convert(&input(dir.path(), "a.doc", b"legacy"))
            .await
            .expect("转换");
        assert_eq!(target, Target::Docx);
        assert!(bytes.starts_with(b"PK\x03\x04"));
        // 临时目录转完就删
        let left = std::fs::read_dir(dir.path().join("work"))
            .map(|entries| entries.count())
            .unwrap_or(0);
        assert_eq!(left, 0, "转换的临时目录应被清掉");
    }

    #[tokio::test]
    async fn an_empty_input_is_rejected_without_starting_the_converter() {
        let dir = tempfile::tempdir().expect("临时目录");
        let marker = dir.path().join("ran");
        let body = format!("touch {}\n{GOOD_DOCX}", marker.display());
        let c = converter(dir.path(), &body, Duration::from_secs(10), 1);
        let err = c
            .convert(&input(dir.path(), "empty.odt", b""))
            .await
            .expect_err("空文件应被拒绝");
        assert_eq!(err, ConvertError::EmptyInput);
        assert!(!marker.exists(), "不该启动转换器(它会把空文件转成空白文档)");
    }

    /// 实测:加载失败时 LibreOffice 退出码 0、不产出文件。
    #[tokio::test]
    async fn exit_code_zero_without_output_is_a_failure() {
        let dir = tempfile::tempdir().expect("临时目录");
        let c = converter(
            dir.path(),
            "echo 'Error: source file could not be loaded' >&2\nexit 0",
            Duration::from_secs(10),
            1,
        );
        let err = c
            .convert(&input(dir.path(), "bad.ppt", b"x"))
            .await
            .expect_err("没有产出文件应算失败");
        match err {
            ConvertError::BadOutput(detail) => {
                assert!(detail.contains("could not be loaded"), "{detail}")
            }
            other => panic!("应是 BadOutput:{other:?}"),
        }
    }

    #[tokio::test]
    async fn junk_or_wrong_kind_of_output_is_rejected() {
        let dir = tempfile::tempdir().expect("临时目录");
        // 不是 zip
        let c = converter(
            dir.path(),
            "printf 'not a zip' > \"$out/$stem.docx\"",
            Duration::from_secs(10),
            1,
        );
        let err = c
            .convert(&input(dir.path(), "a.doc", b"x"))
            .await
            .expect_err("非 zip");
        assert!(matches!(err, ConvertError::BadOutput(_)), "{err:?}");
        // 文本里带着主文件的名字,但开头不是 zip 魔数:只靠「含主文件名」会被它骗过去
        let c = converter(
            dir.path(),
            "printf 'xx word/document.xml xx' > \"$out/$stem.docx\"",
            Duration::from_secs(10),
            1,
        );
        let err = c
            .convert(&input(dir.path(), "z.doc", b"x"))
            .await
            .expect_err("不是 zip 魔数");
        assert!(matches!(err, ConvertError::BadOutput(_)), "{err:?}");
        // 是 zip,但没有 Word 的主文件
        let c = converter(
            dir.path(),
            "printf 'PK\\003\\004....xl/workbook.xml....' > \"$out/$stem.docx\"",
            Duration::from_secs(10),
            1,
        );
        let err = c
            .convert(&input(dir.path(), "b.doc", b"x"))
            .await
            .expect_err("缺主文件");
        assert!(matches!(err, ConvertError::BadOutput(_)), "{err:?}");
        // 空产物
        let c = converter(
            dir.path(),
            ": > \"$out/$stem.docx\"",
            Duration::from_secs(10),
            1,
        );
        let err = c
            .convert(&input(dir.path(), "c.doc", b"x"))
            .await
            .expect_err("空产物");
        assert!(matches!(err, ConvertError::BadOutput(_)), "{err:?}");
    }

    #[tokio::test]
    async fn non_zero_exit_and_unsupported_extensions_are_reported() {
        let dir = tempfile::tempdir().expect("临时目录");
        let c = converter(
            dir.path(),
            "echo boom >&2\nexit 3",
            Duration::from_secs(10),
            1,
        );
        let err = c
            .convert(&input(dir.path(), "a.doc", b"x"))
            .await
            .expect_err("非零退出");
        match err {
            ConvertError::Failed(detail) => assert!(detail.contains("boom"), "{detail}"),
            other => panic!("应是 Failed:{other:?}"),
        }
        let err = c
            .convert(&input(dir.path(), "a.pdf", b"x"))
            .await
            .expect_err("不支持");
        assert_eq!(err, ConvertError::Unsupported("pdf".to_owned()));
    }

    #[tokio::test]
    async fn a_hung_converter_is_killed_at_the_timeout() {
        let dir = tempfile::tempdir().expect("临时目录");
        let c = converter(dir.path(), "sleep 20", Duration::from_millis(300), 1);
        let started = Instant::now();
        let err = c
            .convert(&input(dir.path(), "a.doc", b"x"))
            .await
            .expect_err("应超时");
        assert_eq!(err, ConvertError::Timeout);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[tokio::test]
    async fn concurrency_is_capped() {
        let dir = tempfile::tempdir().expect("临时目录");
        let body = format!("sleep 0.3\n{GOOD_DOCX}");
        let c = converter(dir.path(), &body, Duration::from_secs(20), 1);
        let (a, b) = (
            input(dir.path(), "a.doc", b"x"),
            input(dir.path(), "b.doc", b"x"),
        );
        let started = Instant::now();
        let (ra, rb) = tokio::join!(c.convert(&a), c.convert(&b));
        ra.expect("a");
        rb.expect("b");
        // 上限是 1:两个转换只能一个接一个,总时间不会短于两次之和
        assert!(
            started.elapsed() >= Duration::from_millis(600),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn locate_finds_soffice_in_an_install_dir_or_reports_none() {
        let dir = tempfile::tempdir().expect("临时目录");
        assert_eq!(Converter::locate(dir.path()), None);
        std::fs::create_dir_all(dir.path().join("program")).expect("建目录");
        std::fs::write(dir.path().join("program").join("soffice"), "").expect("写");
        assert_eq!(
            Converter::locate(dir.path()),
            Some(dir.path().join("program").join("soffice"))
        );
    }

    // ------------------------------------------------------------ 按配置建转换器

    use kb_core::config::ConvertConfig;

    /// 在 `<install>/program/soffice` 放一个假转换器:先把收到的 `LD_LIBRARY_PATH` 记到 `<install>/seen-ld`,
    /// 再执行 `body`(里面可用 `$out` `$stem`)。
    fn install_fake(install: &Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(install.join("program")).expect("建目录");
        let path = install.join("program").join("soffice");
        let script = format!(
            "#!/bin/sh\nout=''; prev=''; last=''\nfor a in \"$@\"; do\n  if [ \"$prev\" = '--outdir' ]; then out=\"$a\"; fi\n  prev=\"$a\"; last=\"$a\"\ndone\nstem=$(basename \"$last\"); stem=\"${{stem%.*}}\"\nprintf '%s' \"$LD_LIBRARY_PATH\" > {}\n{body}\n",
            install.join("seen-ld").display()
        );
        std::fs::write(&path, script).expect("写假 soffice");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("加执行权限");
    }

    fn enabled() -> ConvertConfig {
        ConvertConfig {
            enabled: true,
            ..ConvertConfig::default()
        }
    }

    #[test]
    fn from_config_is_none_when_disabled_or_not_installed() {
        let dir = tempfile::tempdir().expect("临时目录");
        let default_dir = dir.path().join("default-lo");
        install_fake(&default_dir, GOOD_DOCX);
        let work = dir.path().join("work");
        // 装了,但配置里没开
        assert!(
            Converter::from_config(&ConvertConfig::default(), &default_dir, work.clone()).is_none()
        );
        // 开了,但指定的目录里没装
        let config = ConvertConfig {
            install_dir: Some(dir.path().join("nowhere").display().to_string()),
            ..enabled()
        };
        assert!(Converter::from_config(&config, &default_dir, work.clone()).is_none());
        // 开了,没指定目录,默认目录里也没装
        let empty = dir.path().join("empty");
        assert!(Converter::from_config(&enabled(), &empty, work).is_none());
    }

    #[tokio::test]
    async fn from_config_finds_the_default_dir_and_passes_the_library_path() {
        let dir = tempfile::tempdir().expect("临时目录");
        let default_dir = dir.path().join("default-lo");
        install_fake(&default_dir, GOOD_DOCX);
        let config = ConvertConfig {
            library_path: Some("/opt/x/lib:/opt/y".to_owned()),
            ..enabled()
        };
        let converter = Converter::from_config(&config, &default_dir, dir.path().join("work"))
            .expect("应在默认目录里找到转换器");
        converter
            .convert(&input(dir.path(), "a.doc", b"x"))
            .await
            .expect("转换");
        assert_eq!(
            std::fs::read_to_string(default_dir.join("seen-ld")).expect("读"),
            "/opt/x/lib:/opt/y",
            "library_path 应作为 LD_LIBRARY_PATH 传给转换器"
        );
    }

    #[tokio::test]
    async fn from_config_prefers_install_dir_over_the_default_dir() {
        let dir = tempfile::tempdir().expect("临时目录");
        let (default_dir, chosen) = (dir.path().join("default-lo"), dir.path().join("chosen-lo"));
        install_fake(&default_dir, "touch ran-default\nexit 1");
        install_fake(&chosen, GOOD_DOCX);
        let config = ConvertConfig {
            install_dir: Some(chosen.display().to_string()),
            ..enabled()
        };
        let converter = Converter::from_config(&config, &default_dir, dir.path().join("work"))
            .expect("找到指定目录里的转换器");
        converter
            .convert(&input(dir.path(), "a.doc", b"x"))
            .await
            .expect("应该用的是 install_dir 里的那个");
    }

    #[tokio::test]
    async fn from_config_applies_the_timeout() {
        let dir = tempfile::tempdir().expect("临时目录");
        let default_dir = dir.path().join("default-lo");
        install_fake(&default_dir, "sleep 20");
        let config = ConvertConfig {
            timeout_secs: 1,
            ..enabled()
        };
        let converter = Converter::from_config(&config, &default_dir, dir.path().join("work"))
            .expect("找到转换器");
        let started = Instant::now();
        let err = converter
            .convert(&input(dir.path(), "a.doc", b"x"))
            .await
            .expect_err("应超时");
        assert_eq!(err, ConvertError::Timeout);
        assert!(
            started.elapsed() < Duration::from_secs(8),
            "{:?}",
            started.elapsed()
        );
    }

    /// 并发数取配置里的 `max_concurrent`:设成 2 时,两个转换的「开始」都出现在任何一个「结束」之前。
    #[tokio::test]
    async fn from_config_applies_the_concurrency_limit() {
        let dir = tempfile::tempdir().expect("临时目录");
        let default_dir = dir.path().join("default-lo");
        let log = dir.path().join("events.log");
        install_fake(
            &default_dir,
            &format!(
                "echo start >> {0}\nsleep 0.5\necho end >> {0}\n{GOOD_DOCX}",
                log.display()
            ),
        );
        let config = ConvertConfig {
            max_concurrent: 2,
            ..enabled()
        };
        let converter = Converter::from_config(&config, &default_dir, dir.path().join("work"))
            .expect("找到转换器");
        let (a, b) = (
            input(dir.path(), "a.doc", b"x"),
            input(dir.path(), "b.doc", b"x"),
        );
        let (ra, rb) = tokio::join!(converter.convert(&a), converter.convert(&b));
        ra.expect("a");
        rb.expect("b");
        let events: Vec<String> = std::fs::read_to_string(&log)
            .expect("读日志")
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(events, ["start", "start", "end", "end"], "两个转换应重叠");
    }
}
