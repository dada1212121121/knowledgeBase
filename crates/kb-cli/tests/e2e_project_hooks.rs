//! 新建 git 项目默认装上「提交后自动索引」钩子(`add_project` 能力的端到端回归)。
//!
//! 运行:`cargo test -p kb-cli --features testkit --test e2e_project_hooks`
//!
//! 走真实守护进程的 UDS(`/api/v1/capabilities/add_project`),项目是真实的临时 git 仓库;
//! 不依赖网络和模型(嵌入器是 fake)。钩子只在 `add_project` 里装,`ProjectService::add` 不碰用户仓库。

#![cfg(feature = "testkit")]

mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;

use serde_json::{Value, json};
use support::{Daemon, Spawn, uds};

/// 安装的四个钩子(与 `kb_service::evolution::HOOK_NAMES` 一致;测试里写死,改名时这里会红)。
const HOOKS: [&str; 4] = ["post-commit", "post-merge", "post-checkout", "post-rewrite"];

/// kb 钩子模板里的识别串;`HookManager` 靠它判断「这个钩子是不是 kb 装的」。
const KB_MARK: &str = "kb 链式 git hook 模板";

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

/// 跑 git。剥掉外层注入的 `GIT_CONFIG_*`,并固定身份,免得被开发机的全局配置影响结果。
fn git(dir: &Path, args: &[&str]) {
    let output = Command::new("git")
        .env_remove("GIT_CONFIG_COUNT")
        .env_remove("GIT_CONFIG_KEY_0")
        .env_remove("GIT_CONFIG_VALUE_0")
        .args(["-c", "user.email=e2e@example.com", "-c", "user.name=e2e"])
        .args(args)
        .current_dir(dir)
        .output()
        .expect("跑 git");
    assert!(
        output.status.success(),
        "git {args:?} 失败:{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// 一个有几个源文件的目录,不是 git 仓库。
fn plain_dir() -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("项目目录");
    for index in 0..2 {
        write(
            &dir.path().join(format!("src/f{index}.rs")),
            &format!("fn f{index}() -> u32 {{\n    {index}\n}}\n"),
        );
    }
    dir
}

/// 一个已经有一次提交的真实 git 仓库。
fn git_repo() -> tempfile::TempDir {
    let dir = plain_dir();
    git(dir.path(), &["init", "-q"]);
    git(dir.path(), &["add", "-A"]);
    git(dir.path(), &["commit", "-qm", "init"]);
    dir
}

/// 一个测试用的守护进程,连同它要活到测试结束的临时目录。
struct Fixture {
    daemon: Daemon,
    _fake_home: tempfile::TempDir,
    _cwd: tempfile::TempDir,
}

/// 起一个守护进程。`HOME` 指到空目录,让 libgit2 读不到开发机的全局 git 配置
/// (比如全局 `core.hooksPath` 会让钩子被当成「由别的工具托管」而不装)。
fn start_daemon() -> Fixture {
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n[mcp]\ntransports = [\"stdio\"]\n\
         [server]\nlisten = \"127.0.0.1:0\"\n",
    );
    let fake_home = tempfile::tempdir().expect("HOME");
    let cwd = tempfile::tempdir().expect("cwd");
    let fake_home_path = fake_home.path().to_string_lossy().into_owned();
    let daemon = Daemon::spawn(
        home,
        Spawn {
            cwd: Some(cwd.path()),
            grace_secs: None,
            env: &[("HOME", &fake_home_path)],
        },
    );
    Fixture {
        daemon,
        _fake_home: fake_home,
        _cwd: cwd,
    }
}

/// 调 `add_project`,返回 (状态码, `data` 字段)。
fn add_project(daemon: &Daemon, path: &Path, name: &str) -> (u16, Value) {
    let (status, body) = uds(
        daemon,
        "POST",
        "/api/v1/capabilities/add_project",
        json!({ "path": path.to_string_lossy(), "name": name }),
    );
    (status, body["data"].clone())
}

/// 读 `list_projects` 里某个项目的那一行。
fn project_row(daemon: &Daemon, name: &str) -> Value {
    let (status, body) = uds(
        daemon,
        "POST",
        "/api/v1/capabilities/list_projects",
        json!({}),
    );
    assert_eq!(status, 200, "{body}");
    body["data"]["projects"]
        .as_array()
        .expect("projects 数组")
        .iter()
        .find(|row| row["project"]["name"] == name)
        .unwrap_or_else(|| panic!("项目 {name} 应已登记:{body}"))["project"]
        .clone()
}

fn is_kb_hook(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|text| text.contains(KB_MARK))
        .unwrap_or(false)
}

/// 新建的 git 项目:四个钩子都装上、`hooks_installed` 为真;自动提炼与云端大模型保持默认关。
#[test]
fn a_new_git_project_gets_the_four_hooks_installed() {
    let fixture = start_daemon();
    let daemon = &fixture.daemon;
    let repo = git_repo();

    let (status, data) = add_project(daemon, repo.path(), "fresh");
    assert_eq!(status, 200, "{data}");
    assert_eq!(data["project"], "fresh", "原有字段不变:{data}");
    assert!(
        data["job_id"].is_string(),
        "原有字段不变,仍要投递索引:{data}"
    );
    assert_eq!(data["hooks"]["installed"], true, "{data}");
    assert!(data["hooks"]["reason"].is_null(), "装上了就没有原因:{data}");

    for name in HOOKS {
        let hook = repo.path().join(".git/hooks").join(name);
        assert!(is_kb_hook(&hook), "{name} 应是 kb 装的钩子");
        let mode = std::fs::metadata(&hook)
            .expect("钩子元数据")
            .permissions()
            .mode();
        assert_ne!(mode & 0o111, 0, "{name} 必须可执行,否则 git 不会调用它");
    }

    let row = project_row(daemon, "fresh");
    assert_eq!(row["hooks_installed"], true, "界面读的就是这个字段:{row}");
    assert_eq!(row["is_git"], true);
    // 红线:只装钩子,不替用户打开会外发内容的开关
    assert_eq!(
        row["extract_enabled"], false,
        "自动提炼必须保持默认关:{row}"
    );
    assert_eq!(
        row["allow_cloud_llm"], false,
        "云端大模型必须保持默认关:{row}"
    );
}

/// 非 git 目录:不装、`hooks.installed` 为假,但登记和索引任务照常成功,目录里也不会冒出 `.git`。
#[test]
fn a_non_git_project_is_added_without_hooks() {
    let fixture = start_daemon();
    let daemon = &fixture.daemon;
    let dir = plain_dir();

    let (status, data) = add_project(daemon, dir.path(), "plain");
    assert_eq!(status, 200, "非 git 目录登记必须成功:{data}");
    assert_eq!(data["project"], "plain");
    assert!(data["job_id"].is_string(), "{data}");
    assert_eq!(data["hooks"]["installed"], false, "{data}");
    assert!(
        data["hooks"]["reason"]
            .as_str()
            .is_some_and(|text| !text.is_empty()),
        "没装要说明原因:{data}"
    );
    assert!(!dir.path().join(".git").exists(), "不能为了装钩子去建 .git");

    let row = project_row(daemon, "plain");
    assert_eq!(row["hooks_installed"], false);
    assert_eq!(row["is_git"], false);
}

/// 仓库里已经有 `post-commit`:链式安装,原钩子改名 `.kb-orig` 且原样可执行;
/// 真的 `git commit` 一次,原钩子仍会先执行,提交成功。
#[test]
fn an_existing_post_commit_hook_is_chained_not_replaced() {
    let fixture = start_daemon();
    let daemon = &fixture.daemon;
    let repo = git_repo();
    let marker = repo.path().join("original-hook-ran");
    let original = format!("#!/bin/sh\necho ran > '{}'\n", marker.display());
    let hook = repo.path().join(".git/hooks/post-commit");
    write(&hook, &original);
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).expect("chmod");

    let (status, data) = add_project(daemon, repo.path(), "chained");
    assert_eq!(status, 200, "{data}");
    assert_eq!(data["hooks"]["installed"], true, "{data}");

    let kept = repo.path().join(".git/hooks/post-commit.kb-orig");
    assert_eq!(
        std::fs::read_to_string(&kept).expect("原钩子应保留为 .kb-orig"),
        original,
        "原钩子内容一字不改"
    );
    let mode = std::fs::metadata(&kept)
        .expect("元数据")
        .permissions()
        .mode();
    assert_ne!(mode & 0o111, 0, ".kb-orig 必须仍可执行,链式调用靠它");
    assert!(is_kb_hook(&hook), "post-commit 本身换成了 kb 钩子");
    // 没有原钩子的另外三个不该凭空多出 .kb-orig
    for name in ["post-merge", "post-checkout", "post-rewrite"] {
        assert!(
            !repo
                .path()
                .join(format!(".git/hooks/{name}.kb-orig"))
                .exists(),
            "{name} 原来没有钩子,不该有备份"
        );
    }

    // 真提交一次:原钩子先跑(留下标记文件),kb 钩子不阻塞也不改变提交结果
    write(&repo.path().join("src/new.rs"), "fn added() {}\n");
    git(repo.path(), &["add", "-A"]);
    git(repo.path(), &["commit", "-qm", "second"]);
    assert!(marker.exists(), "提交后原 post-commit 钩子必须仍被执行");
}

/// 钩子目录装不了(`.git/hooks` 被换成了一个普通文件,root 下 chmod 不管用,所以用这种方式造失败):
/// `add_project` 仍然成功,项目和索引任务都在,只是 `hooks.installed` 为假并带上原因。
#[test]
fn a_hook_install_failure_does_not_fail_add_project() {
    let fixture = start_daemon();
    let daemon = &fixture.daemon;
    let repo = git_repo();
    let hooks_dir = repo.path().join(".git/hooks");
    std::fs::remove_dir_all(&hooks_dir).expect("删掉 hooks 目录");
    write(&hooks_dir, "我是一个文件,不是目录\n");

    let (status, data) = add_project(daemon, repo.path(), "blocked");
    assert_eq!(status, 200, "装钩子失败不能让登记失败:{data}");
    assert_eq!(data["project"], "blocked");
    assert!(data["job_id"].is_string(), "索引任务照常投递:{data}");
    assert_eq!(data["hooks"]["installed"], false, "{data}");
    let reason = data["hooks"]["reason"].as_str().unwrap_or_default();
    assert!(reason.contains("安装钩子失败"), "应写明失败原因:{data}");

    let row = project_row(daemon, "blocked");
    assert_eq!(
        row["hooks_installed"], false,
        "没装上就不能记成已安装:{row}"
    );
    assert_eq!(
        std::fs::read_to_string(&hooks_dir).expect("文件原样还在"),
        "我是一个文件,不是目录\n",
        "失败时不能动用户的东西"
    );
}

/// 钩子目录被别的工具托管(`core.hooksPath`,husky 之类):不改动它,登记成功,原因里说明。
#[test]
fn a_repo_whose_hooks_are_managed_elsewhere_is_left_alone() {
    let fixture = start_daemon();
    let daemon = &fixture.daemon;
    let repo = git_repo();
    git(repo.path(), &["config", "core.hooksPath", ".husky"]);

    let (status, data) = add_project(daemon, repo.path(), "husky");
    assert_eq!(status, 200, "{data}");
    assert_eq!(data["hooks"]["installed"], false, "{data}");
    assert!(
        data["hooks"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("core.hooksPath"),
        "应说明是被别的工具托管:{data}"
    );
    assert!(
        !repo.path().join(".husky").exists(),
        "不能在托管目录里写东西"
    );
    assert_eq!(project_row(daemon, "husky")["hooks_installed"], false);
}

/// 重复登记同一个项目是幂等的,不是「新建」:用户卸掉钩子之后再登记一次,不能悄悄装回去。
#[test]
fn registering_an_existing_project_again_does_not_reinstall_removed_hooks() {
    let fixture = start_daemon();
    let daemon = &fixture.daemon;
    let repo = git_repo();

    let (status, data) = add_project(daemon, repo.path(), "twice");
    assert_eq!(status, 200, "{data}");
    assert_eq!(data["hooks"]["installed"], true, "{data}");

    let (status, body) = uds(
        daemon,
        "POST",
        "/api/v1/capabilities/uninstall_hooks",
        json!({ "project": "twice" }),
    );
    assert_eq!(status, 200, "{body}");
    assert!(!is_kb_hook(&repo.path().join(".git/hooks/post-commit")));

    let (status, data) = add_project(daemon, repo.path(), "twice");
    assert_eq!(status, 200, "重复登记仍应成功:{data}");
    assert_eq!(data["hooks"]["installed"], false, "{data}");
    assert!(
        data["hooks"]["reason"]
            .as_str()
            .unwrap_or_default()
            .contains("已存在"),
        "{data}"
    );
    for name in HOOKS {
        assert!(
            !is_kb_hook(&repo.path().join(".git/hooks").join(name)),
            "{name}:卸掉的钩子不该被重复登记装回去"
        );
    }
    assert_eq!(project_row(daemon, "twice")["hooks_installed"], false);
}
