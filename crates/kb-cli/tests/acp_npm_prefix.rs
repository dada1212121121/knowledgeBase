//! `npm install -g --prefix` 必须把可执行文件放到 `<prefix>/bin`。

use std::path::Path;
use std::process::Command;

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

#[test]
fn npm_global_prefix_puts_the_binary_in_bin() {
    let npm = Command::new("npm").arg("--version").output();
    assert!(npm.is_ok(), "本机应有 npm,否则安装路径无法验收");
    let root = tempfile::tempdir().expect("临时目录");
    let pkg = root.path().join("pkg");
    let prefix = root.path().join("acp-tools");
    write(
        &pkg.join("package.json"),
        r#"{"name":"fake-acp-pkg","version":"1.0.0","bin":{"fake-acp":"index.js"}}"#,
    );
    write(&pkg.join("index.js"), "#!/usr/bin/env node\n");
    let status = Command::new("npm")
        .args([
            "install",
            "-g",
            "--prefix",
            &prefix.display().to_string(),
            &pkg.display().to_string(),
        ])
        .status()
        .expect("启动 npm");
    assert!(status.success(), "npm install -g --prefix 失败");
    let bin = prefix.join("bin/fake-acp");
    assert!(
        bin.exists(),
        "可执行文件应在 acp-tools/bin,实际没有 {}",
        bin.display()
    );
}
