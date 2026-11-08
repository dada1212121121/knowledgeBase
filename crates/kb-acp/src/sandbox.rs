//! 沙箱参数与路径范围。
//!
//! bwrap 只给代理工作目录、已登记的项目目录和 `agent.sock`。
//! `kb.sock`(本机 Admin)不挂进去。环境先 `--clearenv`,再放行白名单和代理自己的 `env`。

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use super::AgentSpec;

/// 从宿主环境放行给代理的变量。密钥类变量不在这里,只来自代理定义里的 `env`。
const ENV_WHITELIST: &[&str] = &[
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "no_proxy",
    "NO_PROXY",
    "ALL_PROXY",
    "all_proxy",
];

/// 沙箱挂载。调用方已经决定哪些路径存在。
pub struct SandboxMounts<'a> {
    /// 工作目录(读写的是 workspace;cwd 只读另挂)。
    pub cwd: &'a Path,
    /// `<KB_HOME>`。
    pub kb_home: &'a Path,
    /// 宿主 HOME(代理配置目录在它下面)。
    pub host_home: &'a Path,
    /// 空的代理工作目录。
    pub workspace: &'a Path,
    /// `kb` 可执行文件。
    pub exe: Option<&'a Path>,
    /// `run/agent.sock`。`None` = 不挂(文件还不存在)。
    pub agent_socket: Option<&'a Path>,
    /// `<KB_HOME>/acp-tools`。装好的代理在这里,要整棵只读挂进去(bin 是指向 node_modules 的链接)。
    pub acp_tools: Option<&'a Path>,
    /// 代理配置目录(绝对路径)。
    pub config_dirs: &'a [PathBuf],
    /// 配置目录是否只读挂进去。普通用户的会话只读:这些目录里是管理员给代理配的登录态 / 密钥,
    /// 所有用户共用,不能让某个用户的代理改写它们(代价:代理要往里写状态会失败,由管理员决定是否给该用户开 ACP)。
    pub config_dirs_readonly: bool,
}

/// 只有这类错误才允许考虑回退到无沙箱:bwrap 不存在,或内核不允许 namespace。
pub fn sandbox_fallback_eligible(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    let namespace = text.contains("namespace")
        || text.contains("operation not permitted")
        || text.contains("eperm")
        || text.contains("unshare")
        || text.contains("clone_newuser");
    let missing = (text.contains("no such file")
        || text.contains("not found")
        || text.contains("os error 2"))
        && (text.contains("bwrap") || text.contains("bubblewrap"));
    namespace || missing
}

/// 按组件消解 `.` / `..`。相对路径返回 `None`。不要求路径存在。
pub fn lexical_absolute(path: &Path) -> Option<PathBuf> {
    if !path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir => out.push("/"),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return None;
                }
                if out.as_os_str().is_empty() {
                    out.push("/");
                }
            }
            Component::Normal(part) => out.push(part),
            Component::Prefix(_) => return None,
        }
    }
    if out.as_os_str().is_empty() {
        out.push("/");
    }
    Some(out)
}

/// 先按组件消解,存在的路径再 `canonicalize`(解开符号链接)。
pub fn resolve_scope(path: &Path) -> Option<PathBuf> {
    let lexical = lexical_absolute(path)?;
    if lexical.exists() {
        std::fs::canonicalize(&lexical).ok()
    } else {
        Some(lexical)
    }
}

/// `path` 是否落在 `root` 里面(含 root 自己)。相对路径、逃出 `..`、越界符号链接都否。
pub fn path_within(path: &Path, root: &Path) -> bool {
    match (resolve_scope(path), resolve_scope(root)) {
        (Some(path), Some(root)) => path.starts_with(&root),
        _ => false,
    }
}

/// `cwd` 必须落在某个已登记项目根(或其子目录)下。
pub fn cwd_within_projects(cwd: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path_within(cwd, root))
}

/// 用 bwrap 包一层。返回的 `env` 是空的:变量只通过 `--setenv` 进入沙箱。
pub fn bwrap_agent(
    inner: &AgentSpec,
    mounts: &SandboxMounts<'_>,
    host_env: &[(String, String)],
) -> AgentSpec {
    let workspace = mounts.workspace;
    let _ = std::fs::create_dir_all(workspace);
    let mut args: Vec<String> = Vec::new();
    for (flag, value) in [("--tmpfs", "/tmp"), ("--dev", "/dev"), ("--proc", "/proc")] {
        args.push(flag.to_owned());
        args.push(value.to_owned());
    }
    for dir in [
        "/usr",
        "/lib",
        "/lib64",
        "/bin",
        "/sbin",
        "/etc/ssl",
        "/etc/ca-certificates",
        "/etc/alternatives",
    ] {
        let path = Path::new(dir);
        if path.exists() {
            add_bind(&mut args, "--ro-bind", path);
        }
    }
    let passwd = workspace.join(".sandbox-passwd");
    if !passwd.exists() {
        let _ = std::fs::write(
            &passwd,
            "root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n",
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&passwd, std::fs::Permissions::from_mode(0o644));
        }
    }
    args.push("--ro-bind".to_owned());
    args.push(passwd.display().to_string());
    args.push("/etc/passwd".to_owned());
    for file in [
        "/etc/resolv.conf",
        "/etc/hosts",
        "/etc/nsswitch.conf",
        "/etc/group",
        "/etc/ld.so.cache",
        "/etc/localtime",
    ] {
        let path = Path::new(file);
        if path.exists() {
            add_bind(&mut args, "--ro-bind", path);
        }
    }
    if let Some(exe) = mounts.exe {
        add_bind(&mut args, "--ro-bind", exe);
    }
    let config = mounts.kb_home.join("config.toml");
    if config.exists() {
        add_bind(&mut args, "--ro-bind", &config);
    }
    // 只挂受限身份的 agent.sock,不挂 kb.sock
    if let Some(socket) = mounts.agent_socket {
        add_bind(&mut args, "--ro-bind", socket);
    }
    if let Some(tools) = mounts.acp_tools
        && tools.exists()
    {
        add_bind(&mut args, "--ro-bind", tools);
    }
    add_bind(&mut args, "--bind", workspace);
    if mounts.cwd != workspace && mounts.cwd.exists() {
        add_bind(&mut args, "--ro-bind", mounts.cwd);
    }
    let config_flag = if mounts.config_dirs_readonly {
        "--ro-bind"
    } else {
        "--bind"
    };
    for path in mounts.config_dirs {
        if path.exists() {
            add_bind(&mut args, config_flag, path);
        }
    }
    let command = Path::new(&inner.command);
    if command.is_absolute()
        && let Some(parent) = command.parent()
    {
        add_bind(&mut args, "--ro-bind", parent);
    }
    for arg in &inner.args {
        let path = Path::new(arg);
        if path.is_absolute()
            && path.is_file()
            && let Some(parent) = path.parent()
        {
            add_bind(&mut args, "--ro-bind", parent);
        }
    }
    for flag in [
        "--die-with-parent",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-cgroup",
        "--clearenv",
        // 守护进程常以 root 运行:不丢能力的话,沙箱里的代理仍握着全部 capability,
        // 能 `mknod` 出宿主的块设备直接读写磁盘、`mount`、改 `/proc/sys`,等于没有沙箱
        "--cap-drop",
        "ALL",
        // 脱离控制终端的会话,挡住 TIOCSTI 往宿主终端里注入按键
        "--new-session",
    ] {
        args.push(flag.to_owned());
    }
    // 再套一层用户命名空间:沙箱里的 root 对宿主的资源(设备、/proc/sys)没有权限。
    // 内核不允许用户命名空间时(`max_user_namespaces = 0`)bwrap 起不来,所以只在可用时加;
    // 此时仍有上面的 `--cap-drop ALL` 兜底。
    if user_namespaces_available() {
        args.push("--unshare-user".to_owned());
    }
    for (key, value) in cleared_pairs(&inner.env, mounts.kb_home, host_env) {
        args.push("--setenv".to_owned());
        args.push(key);
        args.push(value);
    }
    args.push("--chdir".to_owned());
    args.push(mounts.cwd.display().to_string());
    args.push("--".to_owned());
    args.push(inner.command.clone());
    args.extend(inner.args.iter().cloned());
    let _ = mounts.host_home;
    AgentSpec {
        id: inner.id.clone(),
        name: inner.name.clone(),
        command: "bwrap".to_owned(),
        args,
        env: BTreeMap::new(),
    }
}

/// 内核是否允许创建用户命名空间(`/proc/sys/user/max_user_namespaces` 大于 0)。
/// 读不到这个文件(非 Linux 或被屏蔽)按可用处理:bwrap 本来就依赖它,不可用时会明确报错。
fn user_namespaces_available() -> bool {
    std::fs::read_to_string("/proc/sys/user/max_user_namespaces")
        .ok()
        .and_then(|text| text.trim().parse::<u64>().ok())
        .is_none_or(|max| max > 0)
}

/// 给启动命令外面套一层资源上限(`prlimit`):单进程 CPU 秒数、单文件大小。
///
/// 这是纵深防御:沙箱里的代理跑飞了(死循环、往磁盘灌文件)时,内核会杀掉它。
/// 不设内存上限——Node 一类的运行时会预留很大的虚拟地址空间,`RLIMIT_AS` 会让它们起不来;
/// 内存需要 cgroup,在没有特权的守护进程里做不到。`prlimit` 不存在时原样返回。
pub fn with_limits(spec: AgentSpec, cpu_secs: u64, fsize_bytes: u64) -> AgentSpec {
    if !Path::new("/usr/bin/prlimit").is_file() && !Path::new("/bin/prlimit").is_file() {
        return spec;
    }
    let mut args = Vec::new();
    if cpu_secs > 0 {
        args.push(format!("--cpu={cpu_secs}"));
    }
    if fsize_bytes > 0 {
        args.push(format!("--fsize={fsize_bytes}"));
    }
    if args.is_empty() {
        return spec;
    }
    args.push("--".to_owned());
    args.push(spec.command.clone());
    args.extend(spec.args.iter().cloned());
    AgentSpec {
        id: spec.id,
        name: spec.name,
        command: "prlimit".to_owned(),
        args,
        env: spec.env,
    }
}

/// 不用沙箱时也清环境:`/usr/bin/env -i` 只留下白名单和代理自己的变量。
pub fn cleared_agent(
    inner: &AgentSpec,
    kb_home: &Path,
    host_env: &[(String, String)],
) -> AgentSpec {
    let env_bin = if Path::new("/usr/bin/env").is_file() {
        "/usr/bin/env"
    } else {
        "env"
    };
    // `env` 的写法是 `env [选项] [--] [变量=值]… 命令`:`--` 必须在变量赋值**前面**,
    // 放在后面会被当成要执行的命令名(`env: '--': No such file or directory`)
    let mut args = vec!["-i".to_owned(), "--".to_owned()];
    for (key, value) in cleared_pairs(&inner.env, kb_home, host_env) {
        args.push(format!("{key}={value}"));
    }
    args.push(inner.command.clone());
    args.extend(inner.args.iter().cloned());
    AgentSpec {
        id: inner.id.clone(),
        name: inner.name.clone(),
        command: env_bin.to_owned(),
        args,
        env: BTreeMap::new(),
    }
}

fn cleared_pairs(
    extra: &BTreeMap<String, String>,
    kb_home: &Path,
    host_env: &[(String, String)],
) -> Vec<(String, String)> {
    let mut out = BTreeMap::new();
    for key in ENV_WHITELIST {
        if let Some((_, value)) = host_env.iter().find(|(name, _)| name == key)
            && !value.is_empty()
        {
            out.insert((*key).to_owned(), value.clone());
        }
    }
    let prefix = kb_home.join("acp-tools/bin");
    let path = out
        .get("PATH")
        .cloned()
        .unwrap_or_else(|| "/usr/local/bin:/usr/bin:/bin".to_owned());
    out.insert("PATH".to_owned(), format!("{}:{path}", prefix.display()));
    for (key, value) in extra {
        out.insert(key.clone(), value.clone());
    }
    out.into_iter().collect()
}

fn add_bind(args: &mut Vec<String>, flag: &str, path: &Path) {
    let text = path.display().to_string();
    args.push(flag.to_owned());
    args.push(text.clone());
    args.push(text);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> AgentSpec {
        let mut env = BTreeMap::new();
        env.insert("DEEPSEEK_API_KEY".to_owned(), "sk-test".to_owned());
        AgentSpec {
            id: "deepseek".to_owned(),
            name: "DeepSeek".to_owned(),
            command: "deepseek-acp".to_owned(),
            args: vec!["--acp".to_owned()],
            env,
        }
    }

    fn mounts<'a>(
        workspace: &'a Path,
        configs: &'a [PathBuf],
        readonly: bool,
    ) -> SandboxMounts<'a> {
        SandboxMounts {
            cwd: workspace,
            kb_home: workspace,
            host_home: workspace,
            workspace,
            exe: None,
            agent_socket: None,
            acp_tools: None,
            config_dirs: configs,
            config_dirs_readonly: readonly,
        }
    }

    fn binds(spec: &AgentSpec, target: &str) -> Vec<String> {
        // 取出所有挂载目标是 target 的那个 flag
        spec.args
            .windows(3)
            .filter(|w| w[1] == target && w[2] == target)
            .map(|w| w[0].clone())
            .collect()
    }

    #[test]
    fn config_dirs_are_writable_for_the_admin_but_read_only_for_everyone_else() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("agent-config");
        std::fs::create_dir_all(&config).unwrap();
        let workspace = dir.path().join("ws");
        let configs = vec![config.clone()];
        let admin = bwrap_agent(&spec(), &mounts(&workspace, &configs, false), &[]);
        assert_eq!(binds(&admin, &config.display().to_string()), vec!["--bind"]);
        let user = bwrap_agent(&spec(), &mounts(&workspace, &configs, true), &[]);
        assert_eq!(
            binds(&user, &config.display().to_string()),
            vec!["--ro-bind"]
        );
        // 工作目录始终可写,而且只有传进来的这一个
        assert_eq!(
            binds(&user, &workspace.display().to_string()),
            vec!["--bind"]
        );
    }

    #[test]
    fn limits_wrap_the_whole_command_and_keep_the_env() {
        if !Path::new("/usr/bin/prlimit").is_file() && !Path::new("/bin/prlimit").is_file() {
            return;
        }
        let wrapped = with_limits(spec(), 1800, 512 * 1024 * 1024);
        assert_eq!(wrapped.command, "prlimit");
        assert_eq!(
            wrapped.args[..3],
            [
                "--cpu=1800".to_owned(),
                "--fsize=536870912".to_owned(),
                "--".to_owned()
            ]
        );
        assert_eq!(wrapped.args[3], "deepseek-acp");
        assert_eq!(
            wrapped.env.get("DEEPSEEK_API_KEY").map(String::as_str),
            Some("sk-test")
        );
        // 两个上限都是 0 = 不加限制,原样返回
        assert_eq!(with_limits(spec(), 0, 0).command, "deepseek-acp");
    }

    #[test]
    fn fallback_only_for_missing_bwrap_or_namespace() {
        assert!(sandbox_fallback_eligible(
            "启动 ACP 代理失败: No such file or directory (os error 2) bwrap"
        ));
        assert!(sandbox_fallback_eligible(
            "bwrap: setting up uid map: Operation not permitted"
        ));
        assert!(sandbox_fallback_eligible("unshare: namespace 不可用"));
        assert!(!sandbox_fallback_eligible(
            "ACP 代理 30 秒内没有完成 initialize"
        ));
        assert!(!sandbox_fallback_eligible("连接被拒绝"));
    }

    #[test]
    fn lexical_rejects_relative_and_parent_escape() {
        assert!(lexical_absolute(Path::new("proj/file")).is_none());
        assert!(lexical_absolute(Path::new("../etc/passwd")).is_none());
        assert_eq!(
            lexical_absolute(Path::new("/proj/../etc/passwd")).as_deref(),
            Some(Path::new("/etc/passwd"))
        );
        assert_eq!(
            lexical_absolute(Path::new("/proj/./src")).as_deref(),
            Some(Path::new("/proj/src"))
        );
    }

    #[test]
    fn path_within_blocks_escape_sibling_and_symlink() {
        let root = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let inside = root.path().join("src");
        std::fs::create_dir_all(&inside).expect("mkdir");
        std::fs::write(inside.join("a.rs"), "fn a() {}\n").expect("write");
        std::fs::write(outside.path().join("secret"), "nope").expect("write");
        let link = root.path().join("leak");
        std::os::unix::fs::symlink(outside.path().join("secret"), &link).expect("symlink");

        assert!(path_within(&inside.join("a.rs"), root.path()));
        assert!(path_within(root.path(), root.path()));
        assert!(!path_within(outside.path(), root.path()));
        assert!(!path_within(Path::new("/proj/../etc/passwd"), root.path()));
        assert!(!path_within(&link, root.path()), "符号链接不能逃出项目根");
        let sibling = PathBuf::from(format!("{}2/x", root.path().display()));
        assert!(!path_within(&sibling, root.path()));
    }

    #[test]
    fn sandbox_drops_all_capabilities_and_detaches_the_session() {
        let workspace = tempfile::tempdir().unwrap();
        let configs: Vec<PathBuf> = Vec::new();
        let args = bwrap_agent(&spec(), &mounts(workspace.path(), &configs, true), &[]).args;
        let position = |flag: &str| args.iter().position(|arg| arg == flag);
        // `--cap-drop ALL` 必须是连着的两个参数,而且在 `--` 之前(之后就成了代理自己的参数)
        let separator = position("--").expect("命令分隔符");
        let cap = position("--cap-drop").expect("要丢掉全部 capability");
        assert_eq!(args[cap + 1], "ALL");
        assert!(cap < separator);
        assert!(position("--new-session").is_some_and(|at| at < separator));
        // 用户命名空间:内核允许时必须开
        if user_namespaces_available() {
            assert!(position("--unshare-user").is_some_and(|at| at < separator));
        }
        // 代理需要联网访问模型接口,所以网络命名空间不隔离(已知限制,见文档)
        assert!(position("--unshare-net").is_none());
    }

    #[test]
    fn cwd_must_sit_under_a_project_root() {
        let project = tempfile::tempdir().expect("project");
        let home = tempfile::tempdir().expect("home");
        let roots = vec![project.path().to_path_buf()];
        assert!(cwd_within_projects(project.path(), &roots));
        assert!(
            cwd_within_projects(&project.path().join("src"), &roots) || {
                std::fs::create_dir_all(project.path().join("src")).ok();
                cwd_within_projects(&project.path().join("src"), &roots)
            }
        );
        assert!(!cwd_within_projects(home.path(), &roots));
        assert!(!cwd_within_projects(Path::new("/root"), &roots));
        assert!(!cwd_within_projects(Path::new("../"), &roots));
    }

    #[test]
    fn bwrap_args_clear_env_and_skip_admin_socket() {
        let dir = tempfile::tempdir().expect("dir");
        let workspace = dir.path().join("agent-workspace");
        std::fs::create_dir_all(&workspace).expect("workspace");
        let agent_sock = dir.path().join("run/agent.sock");
        std::fs::create_dir_all(agent_sock.parent().expect("parent")).expect("run");
        std::fs::write(&agent_sock, "").expect("sock placeholder");
        let acp_tools = dir.path().join("acp-tools");
        std::fs::create_dir_all(acp_tools.join("bin")).expect("acp-tools");
        let cwd = dir.path().join("proj");
        std::fs::create_dir_all(&cwd).expect("cwd");
        let mounts = SandboxMounts {
            cwd: &cwd,
            kb_home: dir.path(),
            host_home: dir.path(),
            workspace: &workspace,
            exe: None,
            agent_socket: Some(&agent_sock),
            acp_tools: Some(&acp_tools),
            config_dirs: &[],
            config_dirs_readonly: false,
        };
        let host = vec![
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("HOME".to_owned(), "/root".to_owned()),
            (
                "AWS_SECRET_ACCESS_KEY".to_owned(),
                "should-not-leak".to_owned(),
            ),
        ];
        let spec = bwrap_agent(&spec(), &mounts, &host);
        let joined = spec.args.join("\n");
        assert!(joined.contains("--clearenv"), "{joined}");
        assert!(joined.contains("agent.sock"), "{joined}");
        assert!(joined.contains("acp-tools"), "{joined}");
        assert!(!joined.contains("kb.sock"), "{joined}");
        assert!(!joined.contains("should-not-leak"), "{joined}");
        assert!(joined.contains("DEEPSEEK_API_KEY"), "{joined}");
        assert!(spec.env.is_empty());
    }

    #[test]
    fn the_unsandboxed_command_line_actually_runs_with_a_cleared_environment() {
        // 只比对字符串发现不了 `--` 放错位置的问题(env 会把它当成命令名):真的执行一次
        let dir = tempfile::tempdir().expect("dir");
        let mut inner = spec();
        inner.command = "/usr/bin/printenv".to_owned();
        inner.args = vec!["DEEPSEEK_API_KEY".to_owned()];
        let host = vec![
            ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
            ("SECRET_FROM_HOST".to_owned(), "leak".to_owned()),
        ];
        let launch = cleared_agent(&inner, dir.path(), &host);
        let output = std::process::Command::new(&launch.command)
            .args(&launch.args)
            .output()
            .expect("能执行");
        assert!(
            output.status.success(),
            "{:?}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "sk-test");
        // 宿主环境里的变量没有带进去
        let mut leak = inner.clone();
        leak.args = vec!["SECRET_FROM_HOST".to_owned()];
        let launch = cleared_agent(&leak, dir.path(), &host);
        let output = std::process::Command::new(&launch.command)
            .args(&launch.args)
            .output()
            .expect("能执行");
        assert!(!output.status.success(), "宿主变量不该出现在代理的环境里");
    }

    #[test]
    fn unsandboxed_launch_also_clears_the_environment() {
        let dir = tempfile::tempdir().expect("dir");
        let host = vec![
            ("PATH".to_owned(), "/usr/bin".to_owned()),
            ("GIT_CONFIG_COUNT".to_owned(), "1".to_owned()),
        ];
        let spec = cleared_agent(&spec(), dir.path(), &host);
        assert!(spec.command.ends_with("env"));
        assert_eq!(spec.args.first().map(String::as_str), Some("-i"));
        let joined = spec.args.join("\n");
        assert!(joined.contains("DEEPSEEK_API_KEY=sk-test"), "{joined}");
        assert!(!joined.contains("GIT_CONFIG_COUNT"), "{joined}");
        assert!(spec.env.is_empty());
        assert!(joined.contains("deepseek-acp"));
    }
}
