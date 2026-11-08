//! 插件进程的 bwrap 沙箱。
//!
//! 目标是让「插件能跑」与「插件不能碰宿主」同时成立:
//! - 只把插件自己的目录以读写方式挂进去,其余宿主目录一概不可见;
//! - 系统目录只读挂载,保证 python3 / node 这类解释器能启动;
//! - `/tmp` 是进程私有的 tmpfs,不落宿主磁盘,也不会和别的插件共享;
//! - `permissions.network = false` 时加 `--unshare-net`,连本机回环都连不上;
//! - 清空环境变量后只注入 PATH / HOME / TMPDIR 与 KB_PLUGIN_*。
//!
//! bwrap 不可用时不在这里偷偷降级:是否允许裸跑由 `skills.allow_unsandboxed` 决定,
//! 调用方(SkillRegistry)负责在加载时给出 warning 并决定是否注册进程钩子。
//!
//! 这里没有复用 ACP 的沙箱代码:ACP 的挂载表按「工作区 + 代理 socket + 配置目录」组织,
//! 和插件的「只有插件目录」不是一套语义;抽公共 crate 会把 ACP 的领域模型带进 kb-service。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use kb_core::{KbError, Result};

/// 插件进程的启动方式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SandboxMode {
    /// 直接启动(仅在没有 bwrap 且管理员显式允许时使用)。
    Direct,
    /// 用 bwrap 包起来;`network` 对应清单里的 `permissions.network`。
    Bwrap { network: bool },
}

/// 拼好的 bwrap 启动参数。
#[derive(Debug)]
pub(crate) struct BwrapLaunch {
    /// bwrap 可执行文件。
    pub program: PathBuf,
    /// bwrap 自身参数,已经以 `--` 分隔出真正的插件命令。
    pub args: Vec<String>,
}

/// 系统目录:解释器与动态库从这里来。只读挂载,不暴露宿主用户目录。
const SYSTEM_DIRS: &[&str] = &[
    "/usr",
    "/lib",
    "/lib32",
    "/lib64",
    "/libx32",
    "/bin",
    "/sbin",
    "/nix/store",
];

/// 解释器启动常会读的几个 /etc 文件。逐个文件挂,避免把整个 /etc 暴露出去。
const SYSTEM_FILES: &[&str] = &[
    "/etc/ssl",
    "/etc/alternatives",
    "/etc/resolv.conf",
    "/etc/hosts",
    "/etc/nsswitch.conf",
    "/etc/passwd",
    "/etc/group",
    "/etc/ld.so.cache",
];

/// `/tmp` 的上限:插件只该用它放临时文件,256MB 足够,也防止一个坏插件把磁盘写满。
const TMPFS_SIZE_BYTES: &str = "268435456";

/// 探测 bwrap 是否真的能在这台机器上建立所需 namespace。
///
/// 只看 `which bwrap` 不够:容器里常见二进制在、但 `unshare` 被 seccomp / LSM 拒;
/// 用一次真实启动(`/bin/true`)做判定,失败就当作沙箱不可用。
pub(crate) fn available() -> bool {
    static AVAILABLE: OnceLock<bool> = OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        let Some(bwrap) = bwrap_path() else {
            return false;
        };
        let true_bin = if Path::new("/bin/true").exists() {
            "/bin/true"
        } else {
            "/usr/bin/true"
        };
        let mut command = Command::new(bwrap);
        command.args([
            "--die-with-parent",
            "--new-session",
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--unshare-cgroup",
            "--unshare-net",
        ]);
        if user_namespaces_available() {
            command.arg("--unshare-user");
        }
        command.args([
            "--cap-drop",
            "ALL",
            "--hostname",
            "kb-plugin",
            "--size",
            TMPFS_SIZE_BYTES,
            "--tmpfs",
            "/tmp",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--ro-bind",
            "/",
            "/",
            "--clearenv",
            "--",
            true_bin,
        ]);
        command
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    })
}

/// 找到 bwrap 的绝对路径;找不到返回 `None`。
pub(crate) fn bwrap_path() -> Option<&'static Path> {
    static BWRAP: OnceLock<Option<PathBuf>> = OnceLock::new();
    BWRAP
        .get_or_init(|| {
            find_on_path("bwrap").or_else(|| {
                ["/usr/bin/bwrap", "/bin/bwrap"]
                    .into_iter()
                    .map(PathBuf::from)
                    .find(|path| path.is_file())
            })
        })
        .as_deref()
}

/// 拼出 bwrap 的完整命令行。
///
/// `cwd` 必须是插件目录;它会以读写方式挂载,并作为进程工作目录。
/// `env` 是清空后要注入的环境变量,值不能含 NUL(调用方保证)。
pub(crate) fn bwrap_launch(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env: &[(String, String)],
    network: bool,
) -> Result<BwrapLaunch> {
    let bwrap = bwrap_path().ok_or_else(|| {
        KbError::Unavailable("没有找到 bwrap,插件进程无法进入文件系统 / 网络沙箱".to_owned())
    })?;
    let cwd = cwd.canonicalize().map_err(|err| {
        KbError::InvalidInput(format!(
            "插件目录 {} 无法解析成绝对路径: {err}",
            cwd.display()
        ))
    })?;
    if cwd == Path::new("/") || cwd == Path::new("/tmp") {
        return Err(KbError::InvalidInput(format!(
            "插件目录不能是 {};否则沙箱会把整个宿主根目录或临时目录挂进去",
            cwd.display()
        )));
    }
    let cwd_text = cwd.to_string_lossy().into_owned();
    let program = resolve_program(program, &cwd);
    let program_text = program.to_string_lossy().into_owned();

    let mut out = Vec::with_capacity(64);
    out.extend([
        "--die-with-parent".to_owned(),
        "--new-session".to_owned(),
        "--unshare-pid".to_owned(),
        "--unshare-ipc".to_owned(),
        "--unshare-uts".to_owned(),
        "--unshare-cgroup".to_owned(),
    ]);
    if user_namespaces_available() {
        out.push("--unshare-user".to_owned());
    }
    if !network {
        // 网络隔离靠 network namespace;不设的话插件能连宿主本机的服务。
        out.push("--unshare-net".to_owned());
    }
    out.extend([
        "--cap-drop".to_owned(),
        "ALL".to_owned(),
        "--hostname".to_owned(),
        "kb-plugin".to_owned(),
    ]);

    let mut mounted = HashSet::new();
    for dir in SYSTEM_DIRS {
        let path = Path::new(dir);
        if path.is_dir() {
            push_ro_bind(&mut out, &mut mounted, path);
        }
    }
    for file in SYSTEM_FILES {
        let path = Path::new(file);
        if path.exists() {
            push_ro_bind(&mut out, &mut mounted, path);
        }
    }

    // /tmp 先铺 tmpfs,再把插件目录 bind 进来。插件目录若正好在 /tmp 下,
    // 后挂的读写 bind 会覆盖 tmpfs 上的同名路径,顺序不能反。
    out.extend([
        "--size".to_owned(),
        TMPFS_SIZE_BYTES.to_owned(),
        "--tmpfs".to_owned(),
        "/tmp".to_owned(),
        "--dev".to_owned(),
        "/dev".to_owned(),
        "--proc".to_owned(),
        "/proc".to_owned(),
    ]);

    // 解释器不在系统目录时,把它所在的安装前缀只读挂进来。
    // 例如 /home/u/.venv/bin/python -> /home/u/.venv;只暴露这一个前缀,不暴露整个 home。
    if !program.starts_with(&cwd)
        && !covered_by_system(&program)
        && program != Path::new("/")
        && let Some(mount) = program_prefix(&program)
        && mount != cwd
        && !cwd.starts_with(&mount)
    {
        push_ro_bind(&mut out, &mut mounted, &mount);
    }

    // 插件目录:唯一可写挂载。放在最后,确保它能覆盖上面的只读挂载。
    out.extend(["--bind".to_owned(), cwd_text.clone(), cwd_text.clone()]);
    mounted.insert(cwd.clone());

    out.extend(["--clearenv".to_owned()]);
    for (key, value) in env {
        out.extend(["--setenv".to_owned(), key.clone(), value.clone()]);
    }
    out.extend([
        "--chdir".to_owned(),
        cwd_text,
        "--".to_owned(),
        program_text,
    ]);
    out.extend(args.iter().cloned());

    Ok(BwrapLaunch {
        program: bwrap.to_path_buf(),
        args: out,
    })
}

/// 追加一条只读 bind;同一个目标只挂一次。
///
/// 源路径取 canonical,目标保留调用方给的路径:`/lib64`、`/bin` 在这台机器上是指向
/// `/usr/*` 的软链,如果把目标也改成 canonical,bwrap 内就只剩 `/usr/lib64`,动态加载器
/// `/lib64/ld-linux-*.so` 会找不到。目标必须按宿主上的真实路径建。
fn push_ro_bind(out: &mut Vec<String>, mounted: &mut HashSet<PathBuf>, path: &Path) {
    let Ok(canonical) = path.canonicalize() else {
        return;
    };
    if canonical == Path::new("/") || !mounted.insert(path.to_path_buf()) {
        return;
    }
    let source = canonical.to_string_lossy().into_owned();
    let target = path.to_string_lossy().into_owned();
    out.extend(["--ro-bind".to_owned(), source, target]);
}

/// 解释器安装前缀:装在 `bin` / `sbin` 下时挂父目录(虚拟环境还要读 `pyvenv.cfg`),
/// 其余情况只挂可执行文件本身。
fn program_prefix(program: &Path) -> Option<PathBuf> {
    let parent = program.parent()?;
    if matches!(
        parent.file_name().and_then(|name| name.to_str()),
        Some("bin" | "sbin")
    ) {
        parent.parent().map(Path::to_path_buf)
    } else {
        Some(program.to_path_buf())
    }
}

/// 是否已经被系统目录的只读挂载覆盖。
fn covered_by_system(path: &Path) -> bool {
    SYSTEM_DIRS
        .iter()
        .map(Path::new)
        .any(|dir| path.starts_with(dir))
        || SYSTEM_FILES.iter().map(Path::new).any(|file| path == file)
}

/// 把清单里的命令解析成沙箱内可执行的路径。
///
/// 裸命令(例如 `python3`)先按**宿主** PATH 找到绝对路径,这样沙箱里的 PATH
/// 可以只保留最小集合;找不到时保留原名,交给 bwrap 内的 PATH 兜底。
fn resolve_program(program: &Path, cwd: &Path) -> PathBuf {
    let candidate = if program.is_absolute() {
        program.to_path_buf()
    } else if program.components().count() > 1 {
        cwd.join(program)
    } else {
        let name = program.to_string_lossy();
        find_on_path(&name).unwrap_or_else(|| program.to_path_buf())
    };
    candidate.canonicalize().unwrap_or(candidate)
}

/// 在宿主 PATH 里找一个可执行文件。
fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

/// 用户命名空间是否可用;不可用时 bwrap 仍可通过 setuid 模式工作。
fn user_namespaces_available() -> bool {
    std::fs::read_to_string("/proc/sys/user/max_user_namespaces")
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .is_some_and(|max| max > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 沙箱参数必须包含隔离与最小挂载;这是进程启动前最后一道可单测的防线。
    #[test]
    fn launch_keeps_only_the_plugin_directory_writable() {
        let dir = tempfile::tempdir().expect("临时插件目录");
        let env = vec![("PATH".to_owned(), "/usr/bin:/bin".to_owned())];
        let launch = bwrap_launch(
            Path::new("/usr/bin/python3"),
            &["plugin.py".to_owned()],
            dir.path(),
            &env,
            false,
        )
        .expect("拼 bwrap 参数");
        let args = launch.args.join(" ");
        assert!(args.contains("--unshare-net"));
        assert!(args.contains("--unshare-pid"));
        assert!(args.contains("--cap-drop ALL"));
        assert!(args.contains("--clearenv"));
        assert!(args.contains("--tmpfs /tmp"));
        assert!(args.contains("--setenv PATH /usr/bin:/bin"));
        assert!(args.contains("--chdir"));
        assert!(args.contains("-- /usr/bin/python3"));
        assert!(args.ends_with(" plugin.py"));
        // 插件目录只出现一次可写 bind,且不能把宿主根目录挂进去。
        let writable = launch
            .args
            .windows(3)
            .filter(|window| window[0] == "--bind")
            .count();
        assert_eq!(writable, 1, "{}", args);
        assert!(!args.contains("--bind / /"));
    }

    /// 网络权限打开时只去掉 net namespace,其它隔离仍在。
    #[test]
    fn network_permission_only_removes_the_network_namespace() {
        let dir = tempfile::tempdir().expect("临时插件目录");
        let launch = bwrap_launch(Path::new("/usr/bin/python3"), &[], dir.path(), &[], true)
            .expect("拼 bwrap 参数");
        let args = launch.args.join(" ");
        assert!(!args.contains("--unshare-net"));
        assert!(args.contains("--unshare-pid"));
        assert!(args.contains("--unshare-user") || !user_namespaces_available());
    }

    /// 根目录 / 临时目录不能当插件目录,否则沙箱等于没开。
    #[test]
    fn refuses_dangerous_plugin_directories() {
        for cwd in [Path::new("/"), Path::new("/tmp")] {
            let err = bwrap_launch(Path::new("/usr/bin/python3"), &[], cwd, &[], false)
                .expect_err("危险目录应被拒绝");
            assert!(err.to_string().contains("插件目录不能是"), "{err}");
        }
    }
}
