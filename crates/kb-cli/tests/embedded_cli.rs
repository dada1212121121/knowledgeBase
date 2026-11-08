//! 嵌入式 CLI 的端到端冒烟测试(Fake 后端,需要 `testkit` feature)。
//!
//! 运行:`cargo test -p kb-cli --features testkit --test embedded_cli`

#![cfg(feature = "testkit")]

use std::path::Path;
use std::process::Command;

fn kb() -> Command {
    Command::new(env!("CARGO_BIN_EXE_kb"))
}

fn write(path: &Path, content: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建目录");
    }
    std::fs::write(path, content).expect("写文件");
}

#[test]
fn project_add_index_and_jobs_work_end_to_end() {
    let home = tempfile::tempdir().expect("KB_HOME");
    let project = tempfile::tempdir().expect("项目目录");
    write(
        &project.path().join("src/lib.rs"),
        "fn alpha() -> u32 {\n    1\n}\n\nfn beta() -> u32 {\n    2\n}\n",
    );
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );

    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };

    let path = project.path().to_string_lossy().into_owned();
    let (ok, stdout, stderr) = run(&["project", "add", &path, "--name", "demo"]);
    assert!(ok, "project add 失败:{stderr}");
    assert!(stdout.contains("已注册项目 demo"), "stdout={stdout}");

    let (ok, stdout, stderr) = run(&["index", "demo"]);
    assert!(ok, "index 失败:{stderr}");
    assert!(
        stdout.contains("嵌入 2 块"),
        "首次索引应嵌入 2 块;stdout={stdout}"
    );

    let (ok, stdout, stderr) = run(&["index", "demo"]);
    assert!(ok, "第二次 index 失败:{stderr}");
    assert!(
        stdout.contains("0 个块需要嵌入"),
        "第二次应输出 0 个块需要嵌入;stdout={stdout}"
    );

    let (ok, stdout, stderr) = run(&["jobs"]);
    assert!(ok, "jobs 失败:{stderr}");
    assert_eq!(
        stdout.matches("done").count(),
        2,
        "应有两条完成任务;stdout={stdout}"
    );
    assert!(
        stdout.contains("待补向量: 无"),
        "没有队列时也要打印队列状态;stdout={stdout}"
    );

    let (ok, stdout, stderr) = run(&["project", "list"]);
    assert!(ok, "project list 失败:{stderr}");
    assert!(stdout.contains("demo"), "stdout={stdout}");
    assert!(stdout.contains("proj_demo"), "stdout={stdout}");

    let (ok, _, stderr) = run(&["project", "remove", "demo"]);
    assert!(ok, "project remove 失败:{stderr}");
    let (ok, stdout, _) = run(&["project", "list"]);
    assert!(ok);
    assert!(stdout.contains("还没有注册任何项目"), "stdout={stdout}");
}

#[test]
fn index_global_imports_a_document() {
    let home = tempfile::tempdir().expect("KB_HOME");
    let docs = tempfile::tempdir().expect("文档目录");
    write(
        &docs.path().join("guide.md"),
        "# 指南\n\n## 双哈希增量索引\n\n只更新元数据,跳过 embedding。\n",
    );
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let path = docs.path().join("guide.md").to_string_lossy().into_owned();

    let output = kb()
        .env("KB_HOME", home.path())
        .args(["index", "--global", &path, "--tag", "文档"])
        .output()
        .expect("运行 kb");
    assert!(output.status.success(), "index --global 失败");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("已导入 1 个文件"), "stdout={stdout}");
    assert!(stdout.contains("嵌入"), "stdout={stdout}");
}

#[test]
fn crashed_job_is_recovered_on_the_next_run() {
    use kb_core::model::JobState;
    use kb_core::ports::repo::JobRepo;

    let home = tempfile::tempdir().expect("KB_HOME");
    let project = tempfile::tempdir().expect("项目目录");
    for index in 0..4 {
        write(
            &project.path().join(format!("src/f{index}.rs")),
            &format!("fn f{index}() -> u32 {{\n    {index}\n}}\n"),
        );
    }
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );

    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };

    let path = project.path().to_string_lossy().into_owned();
    let (ok, _, stderr) = run(&["project", "add", &path, "--name", "demo"]);
    assert!(ok, "project add 失败:{stderr}");
    let (ok, _, stderr) = run(&["index", "demo"]);
    assert!(ok, "index 失败:{stderr}");

    // 模拟“被强杀”:把任务改回 running,并把检查点退回到第 1 个文件
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("运行时");
    runtime.block_on(async {
        let meta = kb_meta::SqliteMetaStore::open(home.path().join("meta.db")).expect("打开");
        let jobs = JobRepo::list(&meta, Some(JobState::Done))
            .await
            .expect("列表");
        let job = jobs.into_iter().next().expect("有已完成任务");
        let mut checkpoint: serde_json::Value =
            serde_json::from_str(job.checkpoint_json.as_deref().expect("检查点")).expect("解析");
        checkpoint["next"] = serde_json::json!(1);
        checkpoint["done"] = serde_json::json!(1);
        let mut stale = job.clone();
        stale.state = JobState::Running;
        stale.checkpoint_json = Some(checkpoint.to_string());
        JobRepo::update(&meta, stale).await.expect("改回 running");
    });

    let (ok, stdout, stderr) = run(&["index", "demo"]);
    assert!(ok, "续跑失败:{stderr}");
    assert!(
        stdout.contains("恢复了 1 个上次中断的任务"),
        "应提示恢复;stdout={stdout}"
    );
    assert!(stdout.contains("索引完成"), "stdout={stdout}");

    let (ok, stdout, _) = run(&["jobs"]);
    assert!(ok);
    assert!(
        !stdout.contains("running"),
        "不应残留 running 任务;stdout={stdout}"
    );
}

#[test]
fn search_prints_the_documented_text_format() {
    let home = tempfile::tempdir().expect("KB_HOME");
    let project = tempfile::tempdir().expect("项目目录");
    write(
        &project.path().join("src/search.rs"),
        "pub fn hybrid_search(query: &str) -> Vec<String> {\n    let _ = query;\n    Vec::new()\n}\n",
    );
    write(
        &project.path().join("guide.md"),
        "# 指南\n\n## 双哈希增量索引\n\n只更新元数据,跳过 embedding。\n",
    );
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let path = project.path().to_string_lossy().into_owned();
    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };
    let (ok, _, stderr) = run(&["project", "add", &path, "--name", "demo"]);
    assert!(ok, "project add 失败:{stderr}");
    let (ok, _, stderr) = run(&["index", "demo"]);
    assert!(ok, "index 失败:{stderr}");

    // 文本格式:`[1] collection · kind · source:start-end · symbol · id=...`
    let (ok, stdout, stderr) = run(&["search", "hybrid_search"]);
    assert!(ok, "search 失败:{stderr}");
    let first = stdout.lines().next().expect("应有输出");
    assert!(
        first.starts_with("[1] proj_demo · code · src/search.rs:1-"),
        "{first}"
    );
    assert!(first.contains("id="), "{first}");
    assert!(stdout.contains("pub fn hybrid_search"), "{stdout}");
    assert!(stderr.contains("耗时"), "应打印耗时;stderr={stderr}");

    // --json 是设计规范的响应形状
    let (ok, stdout, stderr) = run(&["search", "hybrid_search", "--json"]);
    assert!(ok, "search --json 失败:{stderr}");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("合法 JSON");
    assert_eq!(value["ok"], true);
    assert_eq!(value["meta"]["dry_run"], false);
    assert!(value["meta"]["took_ms"].as_u64().is_some());
    let hits = value["data"]["hits"].as_array().expect("hits");
    assert!(!hits.is_empty());
    assert_eq!(hits[0]["collection"], "proj_demo");
    assert!(hits[0]["id"].as_str().is_some_and(|id| id.len() == 32));
    assert!(
        value["data"]["scope"]
            .as_array()
            .is_some_and(|scope| !scope.is_empty())
    );

    // --kind 过滤
    let (ok, stdout, stderr) = run(&["search", "双哈希", "--kind", "doc"]);
    assert!(ok, "search --kind 失败:{stderr}");
    for line in stdout.lines().filter(|line| line.starts_with('[')) {
        assert!(line.contains(" · doc · "), "应只返回文档:{line}");
    }

    // --k 限制条数
    let (ok, stdout, stderr) = run(&["search", "指南", "--k", "1"]);
    assert!(ok, "search --k 失败:{stderr}");
    let headers = stdout.lines().filter(|line| line.starts_with('[')).count();
    assert_eq!(headers, 1, "应只返回 1 条:{stdout}");
}

#[test]
fn search_with_a_lazy_embedder_is_not_degraded() {
    let home = tempfile::tempdir().expect("KB_HOME");
    let project = tempfile::tempdir().expect("项目目录");
    write(
        &project.path().join("src/search.rs"),
        "pub fn hybrid_search(query: &str) -> Vec<String> {\n    let _ = query;\n    Vec::new()\n}\n",
    );
    // 索引时用普通 fake;查询时换成惰性 fake(第一次使用前 state 是 Unloaded)
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let path = project.path().to_string_lossy().into_owned();
    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };
    let (ok, _, stderr) = run(&["project", "add", &path, "--name", "demo"]);
    assert!(ok, "project add 失败:{stderr}");
    let (ok, _, stderr) = run(&["index", "demo"]);
    assert!(ok, "index 失败:{stderr}");

    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake-lazy\"\n",
    );
    let (ok, stdout, stderr) = run(&["search", "hybrid_search", "--json"]);
    assert!(ok, "search 失败:{stderr}");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("合法 JSON");
    assert_eq!(
        value["meta"]["degraded"],
        serde_json::Value::Null,
        "惰性嵌入器应先被预热加载,不应降级"
    );
    assert!(!value["data"]["hits"].as_array().expect("hits").is_empty());
}

#[test]
fn eval_fails_loudly_when_the_embedder_is_unavailable() {
    let home = tempfile::tempdir().expect("KB_HOME");
    let project = tempfile::tempdir().expect("项目目录");
    write(
        &project.path().join("a.md"),
        "# 指南\n\n## 双哈希\n\n正文\n",
    );
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let set = home.path().join("golden.toml");
    write(
        &set,
        "[[case]]\nquery = \"双哈希\"\ncollection = \"proj_demo\"\nexpect = [{ source = \"a.md\" }]\n",
    );
    let path = project.path().to_string_lossy().into_owned();
    let set_path = set.to_string_lossy().into_owned();
    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.code(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };
    let (_, _, stderr) = run(&["project", "add", &path, "--name", "demo"]);
    assert!(stderr.is_empty() || stderr.contains("INFO"), "{stderr}");
    let (_, _, _) = run(&["index", "demo"]);

    // 把后端换成永远失败的嵌入器:评测必须失败而不是“成功”
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake-failing\"\n",
    );
    let (code, _, stderr) = run(&["eval", "--set", &set_path]);
    assert_eq!(code, Some(1), "模型不可用时应以 1 退出;stderr={stderr}");
    assert!(
        stderr.contains("不可用") || stderr.contains("嵌入"),
        "应说明原因:{stderr}"
    );
}

#[test]
fn eval_reports_hit_rates() {
    let home = tempfile::tempdir().expect("KB_HOME");
    let project = tempfile::tempdir().expect("项目目录");
    write(
        &project.path().join("src/search.rs"),
        "pub fn hybrid_search(query: &str) -> Vec<String> {\n    let _ = query;\n    Vec::new()\n}\n",
    );
    write(
        &project.path().join("guide.md"),
        "# 指南\n\n## 双哈希增量索引\n\n只更新元数据,跳过 embedding。\n",
    );
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let set = home.path().join("golden.toml");
    write(
        &set,
        "[[case]]\nquery = \"双哈希增量索引\"\ncollection = \"proj_demo\"\nexpect = [{ source = \"guide.md\", title_contains = \"双哈希\" }]\n\n[[case]]\nquery = \"hybrid_search\"\ncollection = \"proj_demo\"\nexpect = [{ source = \"src/search.rs\" }]\n",
    );
    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };
    let path = project.path().to_string_lossy().into_owned();
    let (ok, _, stderr) = run(&["project", "add", &path, "--name", "demo"]);
    assert!(ok, "project add 失败:{stderr}");
    let (ok, _, stderr) = run(&["index", "demo"]);
    assert!(ok, "index 失败:{stderr}");

    let set_path = set.to_string_lossy().into_owned();
    let (ok, stdout, stderr) = run(&["eval", "--set", &set_path, "--k", "5"]);
    assert!(ok, "eval 失败:{stderr}");
    assert!(stdout.contains("hit@1 ="), "stdout={stdout}");
    assert!(stdout.contains("hit@5 ="), "stdout={stdout}");
    assert!(stdout.contains("MRR ="), "stdout={stdout}");

    let (ok, stdout, stderr) = run(&["eval", "--set", &set_path, "--json"]);
    assert!(ok, "eval --json 失败:{stderr}");
    let value: serde_json::Value = serde_json::from_str(&stdout).expect("合法 JSON");
    assert_eq!(value["ok"], true);
    assert_eq!(value["data"]["cases"].as_array().map(Vec::len), Some(2));
    assert!(value["data"]["hit_at_1"].as_f64().is_some());
}

#[test]
fn integrate_codex_does_not_overwrite_a_different_entry() {
    let home = tempfile::tempdir().expect("HOME");
    write(
        &home.path().join(".codex/config.toml"),
        "[mcp_servers.kb]\ncommand = \"mine\"\n",
    );
    let output = kb()
        .env("HOME", home.path())
        .env("KB_HOME", home.path().join("kb"))
        .args(["integrate", "codex", "--apply"])
        .output()
        .expect("运行 kb");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("内容与推荐不同"), "应说明内容不同:{stdout}");
    let content = std::fs::read_to_string(home.path().join(".codex/config.toml")).expect("读配置");
    assert!(
        content.contains("command = \"mine\""),
        "不应覆盖用户条目:{content}"
    );
}

#[test]
fn integrate_does_not_create_data_dirs() {
    let home = tempfile::tempdir().expect("HOME");
    let kb_home = home.path().join("never-created");
    for args in [
        vec!["integrate", "kiro"],
        vec!["integrate", "codex", "--print"],
        vec!["integrate", "claude"],
    ] {
        let output = kb()
            .env("HOME", home.path())
            .env("KB_HOME", &kb_home)
            .args(&args)
            .output()
            .expect("运行 kb");
        assert!(output.status.success(), "{args:?} 应成功");
    }
    assert!(
        !kb_home.exists(),
        "integrate 不应创建 KB_HOME:{}",
        kb_home.display()
    );
    assert!(
        !home.path().join(".kb").exists(),
        "integrate 不应创建 ~/.kb"
    );
}

#[test]
fn search_without_any_collection_is_friendly() {
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let output = kb()
        .env("KB_HOME", home.path())
        .args(["search", "anything"])
        .output()
        .expect("运行 kb");
    assert!(output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("还没有任何已索引的 collection"),
        "stderr={stderr}"
    );
}

#[test]
fn remote_mode_without_daemon_exits_with_code_2() {
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let output = kb()
        .env("KB_HOME", home.path())
        .args(["index", "--remote", "demo"])
        .output()
        .expect("运行 kb");
    assert_eq!(output.status.code(), Some(2), "应以退出码 2 结束");
}

#[test]
fn service_install_prints_a_usable_unit() {
    // `--print` 只打印、不落盘、不碰 systemctl(本机可能没有 systemd)
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let output = kb()
        .env("KB_HOME", home.path())
        .args(["service", "install", "--print"])
        .output()
        .expect("运行 kb");
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("ExecStart="), "{stdout}");
    assert!(stdout.contains("daemon"), "{stdout}");
    assert!(stdout.contains("Restart=on-failure"), "{stdout}");
    assert!(stdout.contains("Environment=NO_PROXY="), "{stdout}");
}

#[test]
fn service_install_and_uninstall_with_explicit_unit_dir() {
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let unit_dir = home.path().join("systemd");
    let output = kb()
        .env("KB_HOME", home.path())
        .args([
            "service",
            "install",
            "--unit-dir",
            &unit_dir.to_string_lossy(),
        ])
        .output()
        .expect("运行 kb");
    assert!(output.status.success(), "{output:?}");
    let unit = std::fs::read_to_string(unit_dir.join("kb.service")).expect("unit 文件");
    assert!(unit.contains("Restart=on-failure"), "{unit}");

    // 卸载:删掉文件
    let output = kb()
        .env("KB_HOME", home.path())
        .args([
            "service",
            "uninstall",
            "--unit-dir",
            &unit_dir.to_string_lossy(),
        ])
        .output()
        .expect("运行 kb");
    assert!(output.status.success(), "{output:?}");
    assert!(!unit_dir.join("kb.service").exists());
}

#[test]
fn service_uninstall_print_keeps_the_unit_file() {
    // 质量检查 :`--print` 是纯 dry-run,连文件都不能删
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let unit_dir = home.path().join("systemd");
    let install = kb()
        .env("KB_HOME", home.path())
        .args([
            "service",
            "install",
            "--unit-dir",
            &unit_dir.to_string_lossy(),
        ])
        .output()
        .expect("运行 kb");
    assert!(install.status.success(), "{install:?}");
    assert!(unit_dir.join("kb.service").is_file());

    let output = kb()
        .env("KB_HOME", home.path())
        .args([
            "service",
            "uninstall",
            "--unit-dir",
            &unit_dir.to_string_lossy(),
            "--print",
        ])
        .output()
        .expect("运行 kb");
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("未删除"), "{stdout}");
    assert!(
        unit_dir.join("kb.service").is_file(),
        "--print 不应删除 unit 文件"
    );
}

#[test]
fn backup_command_creates_lists_prunes_and_deletes() {
    let home = tempfile::tempdir().expect("KB_HOME");
    // 保留策略收紧到 2 份,便于一次就看出清理效果
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n\n[backup]\nkeep_count = 2\n",
    );
    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };

    let (ok, stdout, stderr) = run(&["backup", "list"]);
    assert!(ok, "backup list 失败:{stderr}");
    assert!(stdout.contains("还没有备份"), "stdout={stdout}");

    let (ok, stdout, stderr) = run(&["backup", "create"]);
    assert!(ok, "backup create 失败:{stderr}");
    assert!(stdout.contains("已备份"), "stdout={stdout}");

    let dir = home.path().join("backups");
    let archives = || -> Vec<String> {
        std::fs::read_dir(&dir)
            .map(|read| {
                read.flatten()
                    .map(|item| item.file_name().to_string_lossy().to_string())
                    .filter(|name| name.ends_with(".tar.gz"))
                    .collect()
            })
            .unwrap_or_default()
    };
    let created = archives();
    assert_eq!(created.len(), 1, "应有一份归档:{created:?}");
    let archive = created[0].clone();

    // 补两份更旧的假归档(名字与修改时间都更早)
    let now = std::time::SystemTime::now();
    for (name, hours) in [
        ("kb-20260101-000000.tar.gz", 30u64),
        ("kb-20260102-000000.tar.gz", 28),
    ] {
        let path = dir.join(name);
        std::fs::write(&path, b"fake").expect("写假归档");
        let mtime = now - std::time::Duration::from_secs(hours * 3600);
        std::fs::File::options()
            .write(true)
            .open(&path)
            .expect("打开假归档")
            .set_modified(mtime)
            .expect("设置修改时间");
    }

    let (ok, stdout, stderr) = run(&["backup", "list"]);
    assert!(ok, "backup list 失败:{stderr}");
    assert!(stdout.contains(&archive), "stdout={stdout}");
    assert!(stdout.contains("留最近 2 份"), "stdout={stdout}");
    assert!(stdout.contains("共 3 份"), "stdout={stdout}");

    // 预演只列不删
    let (ok, stdout, stderr) = run(&["backup", "prune", "--dry-run"]);
    assert!(ok, "backup prune --dry-run 失败:{stderr}");
    assert!(
        stdout.contains("将删除 kb-20260101-000000.tar.gz"),
        "stdout={stdout}"
    );
    assert!(dir.join("kb-20260101-000000.tar.gz").exists(), "预演不该删");

    let (ok, stdout, stderr) = run(&["backup", "prune"]);
    assert!(ok, "backup prune 失败:{stderr}");
    assert!(
        stdout.contains("已删除 kb-20260101-000000.tar.gz"),
        "stdout={stdout}"
    );
    assert!(!dir.join("kb-20260101-000000.tar.gz").exists());
    assert_eq!(archives().len(), 2, "保留 2 份");

    let (ok, stdout, stderr) = run(&["backup", "delete", &archive]);
    assert!(ok, "backup delete 失败:{stderr}");
    assert!(stdout.contains("已删除"), "stdout={stdout}");
    assert_eq!(archives().len(), 1);
}

#[test]
fn backup_verify_accepts_real_archives_and_rejects_broken_ones() {
    // 恢复流程的第一步就是校验归档:真实归档要过,截断 / 不存在都要非零退出并说清原因。
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };

    let (ok, _, stderr) = run(&["backup", "create"]);
    assert!(ok, "backup create 失败:{stderr}");
    let dir = home.path().join("backups");
    let archive = std::fs::read_dir(&dir)
        .expect("读目录")
        .flatten()
        .map(|item| item.file_name().to_string_lossy().to_string())
        .find(|name| name.ends_with(".tar.gz"))
        .expect("应有一份归档");

    let (ok, stdout, stderr) = run(&["backup", "verify", &archive]);
    assert!(ok, "backup verify 失败:{stderr}");
    assert!(stdout.contains("校验通过"), "stdout={stdout}");
    assert!(stdout.contains("元数据库"), "stdout={stdout}");
    assert!(stdout.contains("meta.db"), "stdout={stdout}");

    // --json 有结构化字段(脚本判断用)
    let (ok, stdout, stderr) = run(&["backup", "verify", &archive, "--json"]);
    assert!(ok, "backup verify --json 失败:{stderr}");
    assert!(stdout.contains("\"files\""), "stdout={stdout}");
    assert!(stdout.contains("\"meta_db_bytes\""), "stdout={stdout}");

    // 截断的归档:非零退出,原因可读
    let bytes = std::fs::read(dir.join(&archive)).expect("读归档");
    std::fs::write(
        dir.join("kb-20250101-000000.tar.gz"),
        &bytes[..bytes.len() / 2],
    )
    .expect("写截断归档");
    let (ok, _, stderr) = run(&["backup", "verify", "kb-20250101-000000.tar.gz"]);
    assert!(!ok, "截断的归档不能校验通过");
    assert!(stderr.contains("归档校验失败"), "stderr={stderr}");

    // 不存在的归档
    let (ok, _, stderr) = run(&["backup", "verify", "kb-20200101-000000.tar.gz"]);
    assert!(!ok);
    assert!(stderr.contains("备份不存在"), "stderr={stderr}");

    // verify 只读:不建元数据库(与 list / prune / delete 同一条约束)。
    // `create` 会打开数据库,所以先删掉再看 verify 会不会把它建回来。
    let meta_db = home.path().join("meta.db");
    let _ = std::fs::remove_file(&meta_db);
    let (ok, _, stderr) = run(&["backup", "verify", &archive]);
    assert!(ok, "backup verify 失败:{stderr}");
    assert!(!meta_db.exists(), "backup verify 不该创建 meta.db");
}

#[test]
fn backup_list_and_prune_do_not_create_the_metadata_database() {
    // `list` / `prune` / `delete` 只动归档目录:打开元数据库会建库、跑迁移,
    // 手工冒烟时就因此在 `~/.kb` 里凭空建出了 `meta.db`。
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };
    let meta_db = home.path().join("meta.db");

    let (ok, stdout, stderr) = run(&["backup", "list"]);
    assert!(ok, "backup list 失败:{stderr}");
    assert!(stdout.contains("还没有备份"), "{stdout}");
    assert!(!meta_db.exists(), "backup list 不该创建 meta.db");

    let (ok, _, stderr) = run(&["backup", "prune", "--dry-run"]);
    assert!(ok, "backup prune 失败:{stderr}");
    assert!(!meta_db.exists(), "backup prune 不该创建 meta.db");

    // 只有 create 需要数据库快照
    let (ok, _, stderr) = run(&["backup", "create"]);
    assert!(ok, "backup create 失败:{stderr}");
    assert!(meta_db.exists(), "create 应打开(必要时创建)元数据库");
}

#[test]
fn backup_prune_rejects_out_of_range_overrides() {
    // `--keep` / `--days` 不走配置校验,越界要在命令行就拦住:
    // 否则 `--days` 的巨大值会在 prune 里溢出成负数,把所有归档判成“太旧”。
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };
    let (ok, stderr) = run(&["backup", "prune", "--keep", "100000"]);
    assert!(!ok, "越界的 --keep 应失败");
    assert!(stderr.contains("--keep"), "{stderr}");
    let (ok, stderr) = run(&["backup", "prune", "--days", "999999999"]);
    assert!(!ok, "越界的 --days 应失败");
    assert!(stderr.contains("--days"), "{stderr}");
    // 边界内的覆盖照常工作
    let (ok, stderr) = run(&[
        "backup",
        "prune",
        "--keep",
        "1",
        "--days",
        "30",
        "--dry-run",
    ]);
    assert!(ok, "合法覆盖应通过:{stderr}");
}

#[test]
fn backup_json_shape_and_delete_errors_are_stable() {
    // 前端与脚本吃的是 `--json` 的形状;`delete` 的失败也要能靠退出码 / stderr 判断。
    let home = tempfile::tempdir().expect("KB_HOME");
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };

    let (ok, stdout, stderr) = run(&["backup", "list", "--json"]);
    assert!(ok, "backup list --json 失败:{stderr}");
    let status: serde_json::Value = serde_json::from_str(&stdout).expect("list --json 应是 JSON");
    for key in [
        "home",
        "dir",
        "entries",
        "last_backup_at",
        "policy",
        "next_backup_at",
        "last_auto",
        "usage",
        "notes",
    ] {
        assert!(
            status.get(key).is_some(),
            "list --json 缺字段 {key}:{status}"
        );
    }
    assert_eq!(status["policy"]["interval_hours"], 24, "{status}");
    assert_eq!(status["policy"]["keep_count"], 7, "{status}");

    let (ok, stdout, stderr) = run(&["backup", "create", "--json"]);
    assert!(ok, "backup create --json 失败:{stderr}");
    let entry: serde_json::Value = serde_json::from_str(&stdout).expect("create --json 应是 JSON");
    for key in ["name", "size_bytes", "created_at", "skipped"] {
        assert!(
            entry.get(key).is_some(),
            "create --json 缺字段 {key}:{entry}"
        );
    }

    // 删除不存在 / 非法的归档:非零退出 + 可读的原因
    let name = entry["name"].as_str().expect("name").to_owned();
    let (ok, _, stderr) = run(&["backup", "delete", "kb-19700101-000000.tar.gz"]);
    assert!(!ok, "删除不存在的归档应失败");
    assert!(stderr.contains("备份不存在"), "{stderr}");

    let (ok, _, stderr) = run(&["backup", "delete", "../evil.tar.gz"]);
    assert!(!ok, "非法归档名应失败");
    assert!(stderr.contains("备份名不合法"), "{stderr}");

    let (ok, _, stderr) = run(&["backup", "delete", &name]);
    assert!(ok, "删除刚建的归档失败:{stderr}");
}

#[test]
fn backup_mirrors_to_an_external_dir_and_reports_failures() {
    // 异地 / 外部存储(`[backup] mirror_dirs`):归档要真的复制过去,
    // 复制失败要在终端与 `.failures.json` 的告警里都看得见 —— 本机备份本身仍然成功。
    let offsite = tempfile::tempdir().expect("异地目录");
    let target = offsite.path().join("kb-backups");
    // 归档名只精确到秒,所以两种情形各用一个 KB_HOME(同一秒里连备两次会撞名,见 service 用例)
    let home = tempfile::tempdir().expect("KB_HOME");
    let broken_home = tempfile::tempdir().expect("KB_HOME(异地目录不可用)");
    // 用一个**普通文件**占住目录名:复制时 `create_dir_all` 必然失败
    let blocked = offsite.path().join("blocked");
    std::fs::write(&blocked, b"x").expect("占位文件");
    for (root, mirror) in [(&home, &target), (&broken_home, &blocked)] {
        write(
            &root.path().join("config.toml"),
            &format!(
                "[embed]\nbackend = \"fake\"\n\n[backup]\nmirror_dirs = [\"{}\"]\n",
                mirror.display()
            ),
        );
    }
    let run = |root: &tempfile::TempDir, args: &[&str]| {
        let output = kb()
            .env("KB_HOME", root.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };
    let archives = |root: &tempfile::TempDir| -> Vec<String> {
        std::fs::read_dir(root.path().join("backups"))
            .map(|read| {
                read.flatten()
                    .map(|item| item.file_name().to_string_lossy().to_string())
                    .filter(|name| name.ends_with(".tar.gz"))
                    .collect()
            })
            .unwrap_or_default()
    };

    // ① 正常情形:副本落到外部目录,字节数与本机归档一致
    let (ok, stdout, stderr) = run(&home, &["backup", "create"]);
    assert!(ok, "backup create 失败:{stderr}");
    assert!(stdout.contains("异地副本"), "stdout={stdout}");
    assert!(stdout.contains("最新一份已在"), "stdout={stdout}");
    // 写完就自己验过一遍:结论直接打在终端上,不用再手动 `kb backup verify`
    assert!(stdout.contains("自动校验"), "stdout={stdout}");
    assert!(stdout.contains(" 通过("), "stdout={stdout}");
    assert!(
        home.path().join("backups/.verify.json").is_file(),
        "校验结论要落盘,另一个进程(Web / 下一次 list)才读得到"
    );

    let created = archives(&home);
    assert_eq!(created.len(), 1, "{created:?}");
    let archive = created[0].clone();
    let copy = target.join(&archive);
    assert!(copy.is_file(), "异地副本应存在:{}", copy.display());
    assert_eq!(
        std::fs::metadata(&copy).expect("副本元数据").len(),
        std::fs::metadata(home.path().join("backups").join(&archive))
            .expect("归档元数据")
            .len(),
        "副本大小应与归档一致"
    );
    assert!(
        !home.path().join("backups/.failures.json").exists(),
        "复制成功时不该有失败记录"
    );
    // 恢复手册里的做法:本机归档没了也能直接校验异地副本(verify 认路径)
    let (ok, stdout, stderr) = run(&home, &["backup", "verify", &copy.display().to_string()]);
    assert!(ok, "校验异地副本失败:{stderr}");
    assert!(stdout.contains("校验通过"), "stdout={stdout}");

    // `list` 里也要能看到这个目录(验收:副本跟不跟得上)与最近一次自动校验
    let (ok, stdout, stderr) = run(&home, &["backup", "list"]);
    assert!(ok, "backup list 失败:{stderr}");
    assert!(stdout.contains("异地副本"), "stdout={stdout}");
    assert!(stdout.contains("最新一份已在"), "stdout={stdout}");
    assert!(stdout.contains("最近校验"), "stdout={stdout}");
    assert!(stdout.contains(&archive), "最近校验要说清是哪一份:{stdout}");

    // ② 异地目录不可用:备份命令仍然成功(本机有一份),但副本失败要看得见
    let (ok, stdout, stderr) = run(&broken_home, &["backup", "create"]);
    assert!(ok, "复制失败不该让备份命令失败:{stderr}");
    assert!(stdout.contains("最新一份不在"), "stdout={stdout}");
    assert_eq!(archives(&broken_home).len(), 1, "本机归档要正常落盘");
    let failures = std::fs::read_to_string(broken_home.path().join("backups/.failures.json"))
        .expect("应有失败记录");
    assert!(
        failures.contains("\"mirror\""),
        "失败记录要标明是异地副本:{failures}"
    );
    // 同一条记录也会出现在 list 里(设置页与外壳横幅读的是同一份)
    let (ok, stdout, stderr) = run(&broken_home, &["backup", "list"]);
    assert!(ok, "backup list 失败:{stderr}");
    assert!(stdout.contains("最新一份不在"), "stdout={stdout}");
}

/// 组装根的接线:`[convert]` 打开且装了转换器时,嵌入式 `kb index` 会把项目里的旧格式 `.doc`
/// 转换后入库、能搜到;没打开时仍按二进制跳过。(假 soffice 把一份现成的 docx 当转换结果。)
#[test]
fn kb_index_converts_a_legacy_doc_in_the_project_when_the_converter_is_enabled() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().expect("KB_HOME");
    let project = tempfile::tempdir().expect("项目目录");
    write(&project.path().join("README.md"), "# 项目\n\n说明\n");
    let mut old = vec![0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0];
    old.extend_from_slice(b"legacy word");
    std::fs::create_dir_all(project.path().join("docs")).expect("建目录");
    std::fs::write(project.path().join("docs/old.doc"), &old).expect("写 .doc");

    // 假的转换结果:一份只有一段话的 docx
    let docx = kb_extract::zip::build_stored_zip(&[
        ("[Content_Types].xml", b"<Types/>"),
        (
            "word/document.xml",
            "<?xml version=\"1.0\"?><w:document xmlns:w=\"w\"><w:body><w:p><w:r><w:t>旧文档里的结论是预算上调</w:t></w:r></w:p></w:body></w:document>"
                .as_bytes(),
        ),
    ]);
    let converted = home.path().join("converted.docx");
    std::fs::write(&converted, docx).expect("写转换结果");
    let install = home.path().join("fake-lo");
    std::fs::create_dir_all(install.join("program")).expect("建目录");
    let soffice = install.join("program").join("soffice");
    std::fs::write(
        &soffice,
        format!(
            "#!/bin/sh\nout=''; prev=''; last=''\nfor a in \"$@\"; do\n  if [ \"$prev\" = '--outdir' ]; then out=\"$a\"; fi\n  prev=\"$a\"; last=\"$a\"\ndone\nstem=$(basename \"$last\"); stem=\"${{stem%.*}}\"\ncp '{}' \"$out/$stem.docx\"\n",
            converted.display()
        ),
    )
    .expect("写假 soffice");
    std::fs::set_permissions(&soffice, std::fs::Permissions::from_mode(0o755)).expect("权限");

    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };
    let path = project.path().to_string_lossy().into_owned();

    // 没打开转换:搜不到 .doc 里的字
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n",
    );
    let (ok, _, stderr) = run(&["project", "add", &path, "--name", "demo"]);
    assert!(ok, "project add 失败:{stderr}");
    let (ok, _, stderr) = run(&["index", "demo"]);
    assert!(ok, "index 失败:{stderr}");
    let (ok, stdout, _) = run(&["search", "预算上调"]);
    assert!(ok);
    assert!(
        !stdout.contains("docs/old.doc"),
        "没打开转换不该搜到:{stdout}"
    );

    // 打开转换、指向假安装目录,重建索引:搜得到,来源仍是原来的 .doc
    write(
        &home.path().join("config.toml"),
        &format!(
            "[embed]\nbackend = \"fake\"\n[convert]\nenabled = true\ninstall_dir = \"{}\"\n",
            install.display()
        ),
    );
    let (ok, _, stderr) = run(&["index", "demo", "--full"]);
    assert!(ok, "index --full 失败:{stderr}");
    let (ok, stdout, stderr) = run(&["search", "预算上调"]);
    assert!(ok, "search 失败:{stderr}");
    assert!(stdout.contains("docs/old.doc"), "转换后应能搜到:{stdout}");
    assert!(stdout.contains("预算上调"), "{stdout}");
    assert_eq!(
        std::fs::read(project.path().join("docs/old.doc")).expect("读"),
        old,
        "原件不动"
    );
}

/// 观测:文本阶段的队列要能在 `kb jobs` / `kb doctor` 里看见,补完以后要归零。
#[test]
fn text_only_pending_is_visible_in_jobs_and_doctor() {
    let home = tempfile::tempdir().expect("KB_HOME");
    let project = tempfile::tempdir().expect("项目目录");
    write(
        &project.path().join("docs/note.md"),
        "# 待补向量\n\n文本阶段先写正文与全文索引。\n",
    );
    write(
        &home.path().join("config.toml"),
        "[embed]\nbackend = \"fake\"\n[index]\ntext_first = true\n",
    );

    let run = |args: &[&str]| {
        let output = kb()
            .env("KB_HOME", home.path())
            .args(args)
            .output()
            .expect("运行 kb");
        (
            output.status.success(),
            String::from_utf8_lossy(&output.stdout).into_owned(),
            String::from_utf8_lossy(&output.stderr).into_owned(),
        )
    };

    let path = project.path().to_string_lossy().into_owned();
    let (ok, _, stderr) = run(&["project", "add", &path, "--name", "demo"]);
    assert!(ok, "project add 失败:{stderr}");
    let (ok, stdout, stderr) = run(&["index", "demo", "--text-only"]);
    assert!(ok, "index --text-only 失败:{stderr}");
    assert!(stdout.contains("待补向量"), "stdout={stdout}");

    let (ok, stdout, stderr) = run(&["jobs"]);
    assert!(ok, "jobs 失败:{stderr}");
    assert!(
        stdout.contains("待补向量: 1 块 / 1 个文件"),
        "任务页要能看见待补队列;stdout={stdout}"
    );
    assert!(stdout.contains("proj_demo"), "stdout={stdout}");

    let (ok, stdout, stderr) = run(&["doctor"]);
    assert!(ok, "doctor 失败:{stderr}");
    assert!(stdout.contains("表账: proj_demo"), "stdout={stdout}");
    assert!(stdout.contains("待补向量: 1 块"), "stdout={stdout}");
    assert!(stdout.contains("队列体检"), "stdout={stdout}");

    let (ok, _, stderr) = run(&["index", "demo", "--embed-pending"]);
    assert!(ok, "index --embed-pending 失败:{stderr}");
    let (ok, stdout, stderr) = run(&["jobs"]);
    assert!(ok, "jobs 失败:{stderr}");
    assert!(
        stdout.contains("待补向量: 无"),
        "补完后队列要归零;stdout={stdout}"
    );
}
