//! `kb convert install|status`(旧格式 Office 入库转换用的 LibreOffice)。
//!
//! 不开 `testkit`:这两个子命令不打开知识库。真实的官方整包安装见 `kb-service` 里
//! `office_install` 的单测(用 `dpkg-deb` 现做的假整包)和手工验证记录。

use std::path::Path;
use std::process::Command;

fn kb(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_kb"));
    command.env("KB_HOME", home);
    command
}

fn status_json(home: &Path) -> serde_json::Value {
    let output = kb(home)
        .args(["convert", "status", "--json"])
        .output()
        .expect("运行 kb");
    assert!(
        output.status.success(),
        "status 失败:{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("status --json 应输出 JSON")
}

#[test]
fn status_on_a_fresh_home_says_nothing_is_installed_and_conversion_is_off() {
    let home = tempfile::tempdir().expect("KB_HOME");
    let status = status_json(home.path());
    assert_eq!(status["enabled"], false, "默认不转换");
    assert!(status["soffice"].is_null(), "没装:{status}");
    assert!(status["installed_version"].is_null());
    assert_eq!(status["locked_version"], "26.2.6");
    // 只读命令不该建出数据目录里的东西
    assert!(!home.path().join("bin").join("libreoffice").exists());
}

#[test]
fn status_finds_an_install_in_the_default_place_and_in_a_configured_directory() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().expect("KB_HOME");
    let fake = |dir: &Path| {
        std::fs::create_dir_all(dir.join("program")).expect("建目录");
        let soffice = dir.join("program").join("soffice");
        std::fs::write(&soffice, "#!/bin/sh\nexit 0\n").expect("写");
        std::fs::set_permissions(&soffice, std::fs::Permissions::from_mode(0o755)).expect("权限");
        soffice
    };
    let default_dir = home.path().join("bin").join("libreoffice");
    let soffice = fake(&default_dir);
    let status = status_json(home.path());
    assert_eq!(
        status["soffice"].as_str(),
        Some(soffice.to_string_lossy().as_ref()),
        "默认位置 <KB_HOME>/bin/libreoffice:{status}"
    );
    assert!(
        status["installed_version"].is_null(),
        "手工放进去的没有安装标记,不冒充已知版本"
    );

    // 配置里指到别处:只看那里
    let elsewhere = home.path().join("elsewhere");
    std::fs::write(
        home.path().join("config.toml"),
        format!(
            "[convert]\nenabled = true\ninstall_dir = \"{}\"\n",
            elsewhere.display()
        ),
    )
    .expect("写配置");
    let status = status_json(home.path());
    assert_eq!(status["enabled"], true);
    assert!(status["soffice"].is_null(), "那里没装:{status}");
    let moved = fake(&elsewhere);
    let status = status_json(home.path());
    assert_eq!(
        status["soffice"].as_str(),
        Some(moved.to_string_lossy().as_ref())
    );
}

#[test]
fn install_from_a_file_that_is_not_the_locked_package_installs_nothing() {
    let home = tempfile::tempdir().expect("KB_HOME");
    let bogus = home
        .path()
        .join("LibreOffice_26.2.6_Linux_x86-64_deb.tar.gz");
    std::fs::write(&bogus, b"not the real package").expect("写");
    let output = kb(home.path())
        .args(["convert", "install", "--from"])
        .arg(&bogus)
        .output()
        .expect("运行 kb");
    assert!(!output.status.success(), "大小对不上必须失败");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("大小"), "要说清楚是哪一项不对:{stderr}");
    let bin = home.path().join("bin");
    assert!(!bin.join("libreoffice").exists(), "链接没建");
    assert!(!bin.join("libreoffice-26.2.6").exists(), "安装目录没建");
    assert!(bogus.exists(), "用户给的文件不删");

    let missing = kb(home.path())
        .args([
            "convert",
            "install",
            "--from",
            "/nonexistent/package.tar.gz",
        ])
        .output()
        .expect("运行 kb");
    assert!(!missing.status.success(), "文件不存在也要失败");
}
