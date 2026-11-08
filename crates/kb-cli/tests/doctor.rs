//! `kb doctor` 与 CLI 骨架的端到端检查(验收的自动化版本)。
//!
//! 每个测试都通过 `KB_HOME` 指向自己的临时目录,不会读写真实的 `~/.kb`。

use std::process::Command;

/// 指向本包构建出的 `kb` 二进制(Cargo 自动注入)。
fn kb() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kb"))
}

#[test]
fn doctor_creates_layout_and_exits_zero() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = kb()
        .env("KB_HOME", dir.path())
        .arg("doctor")
        .output()
        .expect("运行 kb doctor");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(output.status.success(), "doctor 应退出 0;stdout=\n{stdout}");
    assert!(stdout.contains("doctor: 0 error"), "stdout=\n{stdout}");
    // 模型缓存与 socket 在临时 KB_HOME 下必然缺失,应当只产生 warn
    assert!(
        stdout.contains("warn:"),
        "应至少有一条 warn;stdout=\n{stdout}"
    );

    for path in [
        "lang/jieba/default/dict.txt",
        "run",
        "logs",
        "models",
        "skills",
        "eval",
    ] {
        assert!(dir.path().join(path).exists(), "{path} 未被创建");
    }
    let dict = std::fs::read(dir.path().join("lang/jieba/default/dict.txt")).expect("读取词典");
    assert!(dict.len() > 1_000_000, "词典内容异常:{} 字节", dict.len());

    // 日志文件按天滚动
    let logs = std::fs::read_dir(dir.path().join("logs")).expect("logs 目录");
    let names: Vec<String> = logs
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    assert!(
        names.iter().any(|name| name.starts_with("kb.log.")),
        "日志文件未生成: {names:?}"
    );
}

#[test]
fn version_is_printed() {
    let output = kb().arg("--version").output().expect("运行 kb --version");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.starts_with("kb "), "stdout={stdout}");
}

#[test]
fn invalid_config_is_rejected() {
    let dir = tempfile::tempdir().expect("tempdir");
    std::fs::write(
        dir.path().join("config.toml"),
        "[server]\nlisten = \"not-an-address\"\n",
    )
    .expect("写配置");
    let output = kb()
        .env("KB_HOME", dir.path())
        .arg("doctor")
        .output()
        .expect("运行 kb doctor");
    assert!(!output.status.success(), "非法配置应导致非零退出码");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("invalid input"), "stderr={stderr}");
}

#[test]
fn models_dir_override_shows_up_in_doctor() {
    let dir = tempfile::tempdir().expect("tempdir");
    let models = dir.path().join("custom-models");
    std::fs::write(
        dir.path().join("config.toml"),
        format!("[paths]\nmodels_dir = \"{}\"\n", models.display()),
    )
    .expect("写配置");
    let output = kb()
        .env("KB_HOME", dir.path())
        .arg("doctor")
        .output()
        .expect("运行 kb doctor");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains(&models.display().to_string()),
        "模型目录覆盖未生效;stdout=\n{stdout}"
    );
}

#[test]
fn c17_env_vars_point_into_kb_home() {
    let dir = tempfile::tempdir().expect("tempdir");
    let output = kb()
        .env("KB_HOME", dir.path())
        .arg("doctor")
        .output()
        .expect("运行 kb doctor");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let lang = dir.path().join("lang").display().to_string();
    let models = dir.path().join("models").display().to_string();
    assert!(
        stdout.contains(&format!("LANCE_LANGUAGE_MODEL_HOME={lang}")),
        "LANCE_LANGUAGE_MODEL_HOME 未指向 KB_HOME/lang;stdout=\n{stdout}"
    );
    assert!(
        stdout.contains(&format!("FASTEMBED_CACHE_DIR={models}")),
        "FASTEMBED_CACHE_DIR 未指向 KB_HOME/models;stdout=\n{stdout}"
    );
    assert!(
        stdout.contains(&format!("HF_HOME={models}")),
        "HF_HOME 未指向 KB_HOME/models;stdout=\n{stdout}"
    );
}
