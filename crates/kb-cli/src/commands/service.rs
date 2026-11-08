//! `kb service`:用 systemd 托管守护进程。
//!
//! - `install`:写 unit 文件并 `daemon-reload` + `enable --now`;
//! - `uninstall`:停掉、禁用并删除 unit;
//! - `status`:报告 active / enabled 与 unit 路径。
//!
//! 作用域:root 默认装**系统级**(`/etc/systemd/system`),普通用户装**用户级**
//! (`~/.config/systemd/user`),`--system` 可强制系统级(需要 root)。
//! `--print` 只打印 unit 内容,不落盘、不调 `systemctl`(给不想让程序动系统的用户)。

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use kb_core::KbError;
use kb_core::config::Config;
use kb_core::paths::KbPaths;

use crate::error::CliError;

/// `kb service` 的动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ServiceAction {
    /// 安装并启动。
    Install,
    /// 停用并删除。
    Uninstall,
    /// 查看状态。
    Status,
}

/// `kb service` 的参数。
#[derive(Clone, Debug)]
pub struct ServiceArgs {
    /// 动作。
    pub action: ServiceAction,
    /// 强制系统级(需要 root)。
    pub system: bool,
    /// 只打印 unit,不落盘。
    pub print: bool,
    /// 覆盖 unit 目录(测试用;为空时按作用域取默认值)。
    pub unit_dir: Option<PathBuf>,
}

/// systemd unit 名。
pub const UNIT_NAME: &str = "kb.service";

/// 该不该装成系统级:显式 `--system`,或当前是 root。
pub fn is_system_scope(force_system: bool) -> bool {
    force_system || is_root()
}

fn is_root() -> bool {
    // 不引入 libc:读 `UID` 环境变量或 `/proc/self/status` 都行,这里用后者(稳定)
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|line| line.starts_with("Uid:"))
                .and_then(|line| line.split_whitespace().nth(1).map(str::to_owned))
        })
        .is_some_and(|uid| uid == "0")
}

/// 默认 unit 目录。
pub fn default_unit_dir(system: bool) -> PathBuf {
    if system {
        PathBuf::from("/etc/systemd/system")
    } else {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_owned());
        PathBuf::from(home).join(".config/systemd/user")
    }
}

/// 生成 unit 文件内容。
///
/// `Environment=` 里带 NO_PROXY / no_proxy:守护进程要直连本机 socket 与 crates.io / 模型源,
/// 继承一个“全走代理”的环境会把它拖慢甚至打不通(FEASIBILITY 设计规范)。
pub fn unit_file(system: bool, binary: &Path, home: &Path) -> String {
    let wanted_by = if system {
        "multi-user.target"
    } else {
        "default.target"
    };
    let no_proxy = "localhost,127.0.0.1,::1,.crates.io,crates.io,.hf.co,registry.npmmirror.com,registry.npmjs.org";
    format!(
        "[Unit]\n\
         Description=knowledgeBase daemon (kb)\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         WorkingDirectory={home}\n\
         ExecStart={binary} daemon\n\
         Restart=on-failure\n\
         RestartSec=3\n\
         Environment=NO_PROXY={no_proxy}\n\
         Environment=no_proxy={no_proxy}\n\
         \n\
         [Install]\n\
         WantedBy={wanted_by}\n",
        home = home.display(),
        binary = binary.display(),
    )
}

/// 安装:写 unit 文件;返回写到的路径。
pub fn install_at(unit_dir: &Path, content: &str) -> Result<PathBuf, CliError> {
    std::fs::create_dir_all(unit_dir)
        .map_err(|err| CliError::Kb(KbError::Internal(format!("建目录失败: {err}"))))?;
    let path = unit_dir.join(UNIT_NAME);
    std::fs::write(&path, content)
        .map_err(|err| CliError::Kb(KbError::Internal(format!("写 unit 失败: {err}"))))?;
    Ok(path)
}

/// 卸载:删除 unit 文件;文件本来就不在也算成功。
pub fn uninstall_at(unit_dir: &Path) -> Result<bool, CliError> {
    let path = unit_dir.join(UNIT_NAME);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(CliError::Kb(KbError::Internal(format!(
            "删除 unit 失败: {err}"
        )))),
    }
}

/// 调 `systemctl`(用户级带 `--user`)。
fn systemctl(system: bool, args: &[&str]) -> Result<std::process::Output, CliError> {
    let mut command = std::process::Command::new("systemctl");
    if !system {
        command.arg("--user");
    }
    command.args(args);
    command.output().map_err(|err| {
        CliError::Kb(KbError::Internal(format!(
            "调用 systemctl 失败({err});本机可能没有 systemd,可以先用 `kb daemon` 前台运行"
        )))
    })
}

/// 执行 `kb service`。
pub async fn run(
    _paths: &KbPaths,
    _config: &Config,
    args: ServiceArgs,
) -> Result<ExitCode, CliError> {
    let system = is_system_scope(args.system);
    let unit_dir = args
        .unit_dir
        .clone()
        .unwrap_or_else(|| default_unit_dir(system));
    let binary = std::env::current_exe()
        .map_err(|err| CliError::Kb(KbError::Internal(format!("取可执行文件路径失败: {err}"))))?;
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_owned());
    let content = unit_file(system, &binary, Path::new(&home));

    match args.action {
        ServiceAction::Install => {
            if args.print {
                print!("{content}");
                return Ok(ExitCode::SUCCESS);
            }
            let path = install_at(&unit_dir, &content)?;
            println!("unit 已写入 {}", path.display());
            // 显式给了 `--unit-dir` 表示“只把文件放过去”(测试 / 打包脚本用),不碰 systemctl
            if args.unit_dir.is_some() {
                println!("提示:指定了 --unit-dir,跳过 systemctl;需要启用时手动 daemon-reload");
                return Ok(ExitCode::SUCCESS);
            }
            systemctl(system, &["daemon-reload"])?;
            let output = systemctl(system, &["enable", "--now", UNIT_NAME])?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return Err(CliError::Kb(KbError::Internal(format!(
                    "systemctl enable --now 失败: {stderr}"
                ))));
            }
            println!("已启用并启动 {UNIT_NAME}({} 级)", scope_name(system));
            println!("查看状态:`kb service status`");
        }
        ServiceAction::Uninstall => {
            // `--print` 是全局的“只看不改”:连文件都不删。
            if args.print {
                println!("将删除 {}", unit_dir.join(UNIT_NAME).display());
                println!("(--print 只打印,未删除文件、未调用 systemctl)");
                return Ok(ExitCode::SUCCESS);
            }
            // 显式给了 `--unit-dir` 时只处理文件,不碰 systemctl:
            // 否则在有 systemd 的机器上会停掉开发者真实的 kb.service。
            let local_only = args.unit_dir.is_some();
            if !local_only {
                // 停用失败不算错(可能本来就没跑)
                let _ = systemctl(system, &["disable", "--now", UNIT_NAME]);
            }
            let removed = uninstall_at(&unit_dir)?;
            if !local_only {
                let _ = systemctl(system, &["daemon-reload"]);
            }
            println!(
                "{} {}",
                if removed {
                    "已删除"
                } else {
                    "本来就没有"
                },
                unit_dir.join(UNIT_NAME).display()
            );
        }
        ServiceAction::Status => {
            let path = unit_dir.join(UNIT_NAME);
            println!("unit:{}", path.display());
            println!("作用域:{}", scope_name(system));
            if args.unit_dir.is_some() || args.print {
                // 只报文件状态,不调 systemctl(测试 / 打包脚本用)
                println!("active:未知(指定了 --unit-dir,未查询 systemd)");
                println!("enabled:未知(指定了 --unit-dir,未查询 systemd)");
                println!(
                    "文件:{}",
                    if path.is_file() {
                        "存在"
                    } else {
                        "不存在"
                    }
                );
                return Ok(ExitCode::SUCCESS);
            }
            let active = systemctl(system, &["is-active", UNIT_NAME])
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
                .unwrap_or_else(|err| format!("未知({err})"));
            let enabled = systemctl(system, &["is-enabled", UNIT_NAME])
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
                .unwrap_or_else(|err| format!("未知({err})"));
            println!("active:{active}");
            println!("enabled:{enabled}");
            if !path.is_file() {
                println!("提示:unit 文件不存在,先 `kb service install`");
            }
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn scope_name(system: bool) -> &'static str {
    if system { "系统" } else { "用户" }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_file_has_restart_and_proxy_environment() {
        let text = unit_file(
            false,
            Path::new("/usr/local/bin/kb"),
            Path::new("/home/user"),
        );
        assert!(
            text.contains("ExecStart=/usr/local/bin/kb daemon"),
            "{text}"
        );
        assert!(text.contains("Restart=on-failure"), "{text}");
        assert!(text.contains("Environment=NO_PROXY="), "{text}");
        assert!(text.contains("Environment=no_proxy="), "{text}");
        assert!(text.contains("WantedBy=default.target"), "{text}");
        assert!(text.contains("WorkingDirectory=/home/user"), "{text}");
    }

    #[test]
    fn system_scope_uses_multi_user_target() {
        let text = unit_file(true, Path::new("/opt/kb"), Path::new("/root"));
        assert!(text.contains("WantedBy=multi-user.target"), "{text}");
    }

    #[test]
    fn install_and_uninstall_roundtrip() {
        let dir = tempfile::tempdir().expect("临时目录");
        let unit_dir = dir.path().join("systemd");
        let path = install_at(&unit_dir, "x").expect("安装");
        assert!(path.is_file());
        assert!(uninstall_at(&unit_dir).expect("卸载"));
        assert!(!path.exists());
        // 再删一次:文件不在也算成功
        assert!(!uninstall_at(&unit_dir).expect("重复卸载"));
    }

    #[test]
    fn scope_defaults_follow_root() {
        // 只断言路径形状:CI 里不一定以 root 跑
        let system_dir = default_unit_dir(true);
        assert_eq!(system_dir, PathBuf::from("/etc/systemd/system"));
        let user_dir = default_unit_dir(false);
        assert!(user_dir.ends_with(".config/systemd/user"), "{user_dir:?}");
    }
}
