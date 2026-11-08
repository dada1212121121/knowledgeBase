//! `kb hooks install|uninstall|status <project>`。

use std::process::ExitCode;

use kb_core::config::Config;
use kb_core::paths::KbPaths;
use serde_json::{Value, json};

use crate::error::CliError;
use crate::runtime::Embedded;

/// hooks 子命令。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookAction {
    /// 安装。
    Install,
    /// 卸载。
    Uninstall,
    /// 查看状态。
    Status,
}

/// 执行。
pub async fn run(
    paths: &KbPaths,
    config: &Config,
    action: HookAction,
    project: &str,
) -> Result<ExitCode, CliError> {
    // 守护进程在跑时走 UDS:装 / 卸 hook 不需要 `run/daemon.lock`,也不该逼用户停服
    // 状态查询是只读的,继续走嵌入式,不必依赖守护进程。
    let client = kb_mcp::uds::UdsClient::new(paths.socket());
    if action != HookAction::Status && client.is_running().await {
        let capability = match action {
            HookAction::Install => "install_hooks",
            HookAction::Uninstall => "uninstall_hooks",
            HookAction::Status => unreachable!("status 不走 UDS"),
        };
        let data = client
            .call(
                capability,
                json!({ "project": project }),
                &kb_mcp::uds::CallOptions {
                    cwd: std::env::current_dir()
                        .ok()
                        .map(|value| value.to_string_lossy().into_owned()),
                    client: None,
                    project: Some(project.to_owned()),
                    surface: Some("web".to_owned()),
                    dry_run: false,
                },
            )
            .await?;
        print_report(paths, &data);
        return Ok(ExitCode::SUCCESS);
    }

    let runtime = Embedded::open(paths, config, action != HookAction::Status).await?;
    let project = runtime.projects().resolve(project).await?;
    let manager = kb_service::evolution::HookManager::open(&project.root_path)?;
    let report = match action {
        HookAction::Install => manager.install(paths.socket())?,
        HookAction::Uninstall => manager.uninstall()?,
        HookAction::Status => manager.status()?,
    };

    if action != HookAction::Status {
        // 记录到项目行
        let mut updated = project.clone();
        updated.hooks_installed = action == HookAction::Install;
        kb_core::ports::repo::ProjectRepo::update(runtime.meta.as_ref(), updated).await?;
    }
    print_report(paths, &report_json(&report));
    Ok(ExitCode::SUCCESS)
}

/// `HookReport` → 与能力层一致的 JSON 形状。
fn report_json(report: &kb_service::evolution::HookReport) -> Value {
    json!({
        "hooks_dir": report.hooks_dir,
        "managed_by_other": report.managed_by_other,
        "hooks": report.hooks.iter().map(|hook| json!({
            "name": hook.name,
            "installed": hook.installed,
            "has_original": hook.has_original,
        })).collect::<Vec<_>>(),
    })
}

/// 打印安装 / 卸载结果(嵌入式与 UDS 两条路径共用)。
fn print_report(paths: &KbPaths, data: &Value) {
    let hooks_dir = data.get("hooks_dir").and_then(Value::as_str).unwrap_or("-");
    if data
        .get("managed_by_other")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        println!("hooks 目录由别的工具托管({hooks_dir}),kb 不改动它。");
        println!(
            "请手动在 post-commit 等 hook 里加一行:\n  \
             curl -s --max-time 1 --unix-socket {} -X POST \
             -H 'content-type: application/json' \
             --data '{{\"kind\":\"git_commit\",\"project_root\":\"'\"$PWD\"'\"}}' \
             http://localhost/api/v1/events >/dev/null 2>&1 &",
            paths.socket().display()
        );
        return;
    }
    println!("hooks 目录:{hooks_dir}");
    for hook in data
        .get("hooks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let name = hook.get("name").and_then(Value::as_str).unwrap_or("-");
        let state = if hook
            .get("installed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "已安装"
        } else {
            "未安装"
        };
        let backup = if hook
            .get("has_original")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            "(原 hook 已备份)"
        } else {
            ""
        };
        println!("  {name:<14} {state}{backup}");
    }
}
