//! 链式 git hook 安装。
//!
//! 用真实的 `git` 命令跑 hook,验证:原 hook 仍执行且退出码保留、安装幂等、
//! 卸载完全恢复、`git commit` 的额外耗时 < 100ms。

use std::path::Path;
use std::process::Command;

use kb_service::evolution::HookManager;
use tempfile::TempDir;

fn git(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_COUNT", "0")
        .env("GIT_AUTHOR_NAME", "kb-test")
        .env("GIT_AUTHOR_EMAIL", "kb@test.local")
        .env("GIT_COMMITTER_NAME", "kb-test")
        .env("GIT_COMMITTER_EMAIL", "kb@test.local")
        .output()
        .expect("运行 git")
}

fn repo() -> TempDir {
    let dir = tempfile::tempdir().expect("临时仓库");
    assert!(git(dir.path(), &["init", "-q"]).status.success());
    std::fs::write(dir.path().join("a.txt"), "one\n").expect("写文件");
    assert!(git(dir.path(), &["add", "."]).status.success());
    assert!(
        git(dir.path(), &["commit", "-q", "-m", "init"])
            .status
            .success()
    );
    dir
}

fn write_hook(dir: &Path, name: &str, body: &str) {
    let hooks = dir.join(".git/hooks");
    std::fs::create_dir_all(&hooks).expect("建 hooks 目录");
    let path = hooks.join(name);
    std::fs::write(&path, body).expect("写 hook");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
}

#[test]
fn install_chains_the_original_hook_and_keeps_its_exit_code() {
    let dir = repo();
    write_hook(
        dir.path(),
        "post-commit",
        "#!/bin/sh\necho ran >> hook.log\nexit 3\n",
    );

    let manager = HookManager::open(dir.path()).expect("打开仓库");
    let report = manager
        .install(Path::new("/tmp/does-not-exist.sock"))
        .expect("安装");
    assert!(!report.managed_by_other);
    assert!(report.hooks.iter().all(|hook| hook.installed));
    assert!(report.hooks.iter().any(|hook| hook.has_original));

    // 直接执行装好的 hook:原 hook 被执行(留下 hook.log),退出码 3 原样返回
    let hook = dir.path().join(".git/hooks/post-commit");
    let output = Command::new(&hook)
        .current_dir(dir.path())
        .output()
        .expect("运行 hook");
    assert_eq!(output.status.code(), Some(3), "退出码应原样保留");
    let log = std::fs::read_to_string(dir.path().join("hook.log")).expect("原 hook 应执行");
    assert!(log.contains("ran"), "{log}");

    // 真实提交时 hook 也会跑(git 本身忽略 post-commit 的退出码)
    std::fs::write(dir.path().join("a.txt"), "two\n").expect("改文件");
    assert!(git(dir.path(), &["add", "."]).status.success());
    let output = git(dir.path(), &["commit", "-q", "-m", "second"]);
    assert!(
        output.status.success(),
        "post-commit 的退出码不影响提交结果"
    );
    let log = std::fs::read_to_string(dir.path().join("hook.log")).expect("原 hook 应执行");
    assert_eq!(log.matches("ran").count(), 2, "提交时 hook 也应执行:{log}");
}

#[test]
fn install_is_idempotent() {
    let dir = repo();
    write_hook(dir.path(), "post-commit", "#!/bin/sh\nexit 0\n");
    let manager = HookManager::open(dir.path()).expect("打开仓库");
    manager.install(Path::new("/tmp/x.sock")).expect("第一次");
    let first = std::fs::read_to_string(dir.path().join(".git/hooks/post-commit")).expect("读");
    let backup =
        std::fs::read_to_string(dir.path().join(".git/hooks/post-commit.kb-orig")).expect("备份");

    manager.install(Path::new("/tmp/x.sock")).expect("第二次");
    let second = std::fs::read_to_string(dir.path().join(".git/hooks/post-commit")).expect("读");
    assert_eq!(first, second, "重复安装不应改变内容");
    assert_eq!(
        backup,
        std::fs::read_to_string(dir.path().join(".git/hooks/post-commit.kb-orig")).expect("备份"),
        "备份不应被覆盖"
    );
}

#[test]
fn uninstall_restores_the_original_hooks() {
    let dir = repo();
    let original = "#!/bin/sh\necho orig >> orig.log\n";
    write_hook(dir.path(), "post-commit", original);
    write_hook(dir.path(), "post-merge", "#!/bin/sh\nexit 0\n");

    let manager = HookManager::open(dir.path()).expect("打开仓库");
    manager.install(Path::new("/tmp/x.sock")).expect("安装");
    assert!(
        std::fs::read_to_string(dir.path().join(".git/hooks/post-commit"))
            .expect("读")
            .contains("kb 链式 git hook")
    );

    let report = manager.uninstall().expect("卸载");
    assert!(report.hooks.iter().all(|hook| !hook.installed));
    assert!(
        !report.hooks.iter().any(|hook| hook.has_original),
        "备份应被恢复"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join(".git/hooks/post-commit")).expect("读"),
        original,
        "原 hook 应完全恢复"
    );
    // 原本没有的 hook(post-rewrite)卸载后不应留下文件
    assert!(!dir.path().join(".git/hooks/post-rewrite").exists());
}

#[test]
fn commit_is_not_slowed_down_by_more_than_100ms() {
    let dir = repo();
    let manager = HookManager::open(dir.path()).expect("打开仓库");
    manager
        .install(Path::new("/tmp/does-not-exist.sock"))
        .expect("安装");

    // 预热一次(创建文件、索引)
    std::fs::write(dir.path().join("b.txt"), "x\n").expect("写");
    assert!(git(dir.path(), &["add", "."]).status.success());
    let started = std::time::Instant::now();
    assert!(
        git(dir.path(), &["commit", "-q", "-m", "warm"])
            .status
            .success()
    );
    let warm = started.elapsed();

    std::fs::write(dir.path().join("b.txt"), "y\n").expect("写");
    assert!(git(dir.path(), &["add", "."]).status.success());
    let started = std::time::Instant::now();
    assert!(
        git(dir.path(), &["commit", "-q", "-m", "measured"])
            .status
            .success()
    );
    let measured = started.elapsed();

    // 基准:同样一次提交在不装 hook 时的耗时
    let plain = repo();
    std::fs::write(plain.path().join("b.txt"), "y\n").expect("写");
    assert!(git(plain.path(), &["add", "."]).status.success());
    let started = std::time::Instant::now();
    assert!(
        git(plain.path(), &["commit", "-q", "-m", "measured"])
            .status
            .success()
    );
    let baseline = started.elapsed();

    let extra = measured.saturating_sub(baseline);
    assert!(
        extra < std::time::Duration::from_millis(100),
        "hook 额外耗时 {extra:?} 应 < 100ms(hook 后 {measured:?},基准 {baseline:?},预热 {warm:?})"
    );
}

#[test]
fn husky_style_hooks_path_is_not_touched() {
    let dir = repo();
    assert!(
        git(dir.path(), &["config", "core.hooksPath", ".husky"])
            .status
            .success()
    );
    let manager = HookManager::open(dir.path()).expect("打开仓库");
    let report = manager.install(Path::new("/tmp/x.sock")).expect("安装");
    assert!(report.managed_by_other, "应识别为被别的工具托管");
    assert!(!dir.path().join(".husky").exists(), "不应创建或改动 .husky");
}

#[test]
fn reinstalling_does_not_clobber_a_hook_written_by_another_tool() {
    // 别的工具在 kb 之后重写了 post-commit:.kb-orig 已存在,不能覆盖用户文件
    let dir = repo();
    // 先有一个用户自己的 hook,安装时会被备份成 .kb-orig
    write_hook(dir.path(), "post-commit", "#!/bin/sh\necho ORIGINAL\n");
    let manager = HookManager::open(dir.path()).expect("打开仓库");
    manager.install(Path::new("/tmp/x.sock")).expect("安装");
    // 别的工具随后重写了 post-commit
    write_hook(dir.path(), "post-commit", "#!/bin/sh\necho OTHER-TOOL\n");

    manager.install(Path::new("/tmp/x.sock")).expect("再次安装");
    // 用户的新 hook 被备份到 .kb-orig.1,原备份仍在
    assert!(dir.path().join(".git/hooks/post-commit.kb-orig").exists());
    let extra = std::fs::read_to_string(dir.path().join(".git/hooks/post-commit.kb-orig.1"))
        .expect("应保留用户的新 hook");
    assert!(extra.contains("OTHER-TOOL"), "{extra}");
}

#[test]
fn uninstall_keeps_a_hook_that_is_no_longer_ours() {
    let dir = repo();
    let manager = HookManager::open(dir.path()).expect("打开仓库");
    manager.install(Path::new("/tmp/x.sock")).expect("安装");
    write_hook(dir.path(), "post-commit", "#!/bin/sh\necho USER-LATEST\n");

    manager.uninstall().expect("卸载");
    let content = std::fs::read_to_string(dir.path().join(".git/hooks/post-commit")).expect("读");
    assert!(
        content.contains("USER-LATEST"),
        "不是 kb 装的 hook 不应被覆盖:{content}"
    );
}
