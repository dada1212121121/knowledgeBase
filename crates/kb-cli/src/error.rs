//! CLI 的错误类型与退出码（设计规范）。

use std::process::ExitCode;

use kb_core::KbError;

/// CLI 错误。
#[derive(Debug)]
pub enum CliError {
    /// 普通错误(退出码 1)。
    Kb(KbError),
    /// 守护进程正在运行,写操作不能进入嵌入式模式(退出码 3)。
    DaemonRunning,
    /// 需要守护进程但它没运行(退出码 2)。
    DaemonNotRunning,
}

impl From<KbError> for CliError {
    fn from(err: KbError) -> Self {
        Self::Kb(err)
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Kb(err) => write!(f, "{err}"),
            Self::DaemonRunning => write!(
                f,
                "已经有一个守护进程在运行(拿不到 run/daemon.lock):`kb daemon` 不能再启动;\
                 这个写命令还没有 UDS 版本,请先停掉守护进程再执行"
            ),
            Self::DaemonNotRunning => {
                write!(f, "守护进程没有运行:请先启动 `kb daemon`,或去掉 --remote")
            }
        }
    }
}

impl CliError {
    /// 进程退出码。
    pub fn exit_code(&self) -> ExitCode {
        match self {
            Self::Kb(_) => ExitCode::FAILURE,
            Self::DaemonNotRunning => ExitCode::from(2),
            Self::DaemonRunning => ExitCode::from(3),
        }
    }
}
