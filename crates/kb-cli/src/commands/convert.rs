//! `kb convert install|status`:旧格式 Office 入库转换用的 LibreOffice。
//!
//! 安装逻辑在 `kb_service::office_install`;这里只负责参数、输出和提示。
//! 装好以后还要在 `config.toml` 里打开 `[convert] enabled = true` 并重启守护进程,转换器才会被用上。

use std::process::ExitCode;

use kb_core::config::Config;
use kb_core::paths::KbPaths;
use kb_service::office_install::{self, Package, Source};

use crate::error::CliError;

/// `kb convert install [--from <文件>]`。
pub async fn install(
    paths: &KbPaths,
    from: Option<std::path::PathBuf>,
    json: bool,
) -> Result<ExitCode, CliError> {
    let package = Package::locked();
    let source = match from {
        Some(file) => Source::File(file),
        None => Source::Download,
    };
    if !json {
        println!(
            "安装 LibreOffice {} 到 {}(约 {} MB,只在缺的时候下载)…",
            package.version,
            office_install::install_dir(paths.bin_dir(), &package.version).display(),
            package.size / 1_000_000
        );
    }
    let installed = office_install::install(paths.bin_dir(), &package, source).await?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&installed).unwrap_or_default()
        );
        return Ok(ExitCode::SUCCESS);
    }
    if installed.already {
        println!("已经装好了,核对通过:{}", installed.reported);
    } else {
        println!("装好了:{}", installed.reported);
    }
    println!(
        "转换器找的位置:{} -> {}",
        installed.link.display(),
        installed.dir.display()
    );
    println!(
        "要让入库时自动转换旧格式,在 config.toml 里设 [convert] enabled = true,然后重启守护进程"
    );
    Ok(ExitCode::SUCCESS)
}

/// `kb convert status`。
pub async fn status(paths: &KbPaths, config: &Config, json: bool) -> Result<ExitCode, CliError> {
    let package = Package::locked();
    let link = paths.bin_dir().join(office_install::LINK_NAME);
    let install_dir = config
        .convert
        .install_dir
        .as_deref()
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| link.clone());
    let installed = office_install::installed_version(paths.bin_dir());
    let soffice = kb_service::office_convert::Converter::locate(&install_dir);
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&serde_json::json!({
                "enabled": config.convert.enabled,
                "install_dir": install_dir,
                "soffice": soffice,
                "installed_version": installed,
                "locked_version": package.version,
                "library_path": config.convert.library_path,
            }))
            .unwrap_or_default()
        );
        return Ok(ExitCode::SUCCESS);
    }
    println!("[convert] enabled: {}", config.convert.enabled);
    println!("安装目录:        {}", install_dir.display());
    match &soffice {
        Some(path) => println!("soffice:         {}", path.display()),
        None => println!("soffice:         没找到(运行 `kb convert install` 安装)"),
    }
    match &installed {
        Some(version) if *version == package.version => {
            println!("已装版本:        {version}(就是锁定的版本)")
        }
        Some(version) => println!(
            "已装版本:        {version}(锁定的是 {},运行 `kb convert install` 升级)",
            package.version
        ),
        None if soffice.is_some() => {
            println!("已装版本:        不是 `kb convert install` 装的,不知道版本")
        }
        None => println!("已装版本:        无"),
    }
    if let Some(library_path) = &config.convert.library_path {
        println!("library_path:    {library_path}");
    }
    if config.convert.enabled && soffice.is_none() {
        println!("注意:[convert] 已打开,但没装 LibreOffice,旧格式文件照旧原样保存、只读显示");
    }
    Ok(ExitCode::SUCCESS)
}
