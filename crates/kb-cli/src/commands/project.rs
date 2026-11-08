//! `kb project add|list|show|remove`。

use std::path::PathBuf;
use std::process::ExitCode;

use kb_core::config::Config;
use kb_core::paths::KbPaths;

use crate::error::CliError;
use crate::runtime::Embedded;

/// 注册项目。
pub async fn add(
    paths: &KbPaths,
    config: &Config,
    path: PathBuf,
    name: Option<String>,
) -> Result<ExitCode, CliError> {
    // 守护进程在跑就走 UDS（设计规范）;否则嵌入式
    let client = kb_mcp::uds::UdsClient::new(paths.socket());
    if client.is_running().await {
        let data = client
            .call(
                "add_project",
                serde_json::json!({
                    "path": path.to_string_lossy(),
                    "name": name,
                }),
                &kb_mcp::uds::CallOptions {
                    cwd: std::env::current_dir()
                        .ok()
                        .map(|value| value.to_string_lossy().into_owned()),
                    client: None,
                    project: None,
                    surface: Some("web".to_owned()),
                    dry_run: false,
                },
            )
            .await?;
        println!(
            "已通过守护进程注册项目 {},并投递任务 {}",
            data.get("project")
                .and_then(|value| value.as_str())
                .unwrap_or("-"),
            data.get("job_id")
                .and_then(|value| value.as_str())
                .unwrap_or("-")
        );
        return Ok(ExitCode::SUCCESS);
    }
    let runtime = Embedded::open(paths, config, true).await?;
    let project = runtime.projects().add(&path, name.as_deref()).await?;
    println!(
        "已注册项目 {} (slug: {}, collection: proj_{})",
        project.name, project.slug, project.slug
    );
    println!("根目录: {}", project.root_path);
    Ok(ExitCode::SUCCESS)
}

/// 列出项目。
pub async fn list(paths: &KbPaths, config: &Config) -> Result<ExitCode, CliError> {
    let runtime = Embedded::open(paths, config, false).await?;
    let projects = runtime.projects().list().await?;
    if projects.is_empty() {
        println!("还没有注册任何项目。用 `kb project add <路径>` 添加。");
        return Ok(ExitCode::SUCCESS);
    }
    println!("{:<20} {:<28} {:>8}  路径", "名称", "collection", "块数");
    for info in projects {
        println!(
            "{:<20} {:<28} {:>8}  {}",
            info.project.name, info.collection, info.rows, info.project.root_path
        );
    }
    Ok(ExitCode::SUCCESS)
}

/// 项目详情。
pub async fn show(paths: &KbPaths, config: &Config, name: String) -> Result<ExitCode, CliError> {
    let runtime = Embedded::open(paths, config, false).await?;
    let info = runtime.projects().show(&name).await?;
    let project = &info.project;
    println!("名称: {}", project.name);
    println!("slug: {}", project.slug);
    println!("collection: {}", info.collection);
    println!("根目录: {}", project.root_path);
    println!("git 仓库: {}", project.is_git);
    println!("块数: {}", info.rows);
    println!(
        "上次索引: {}",
        project
            .last_indexed_at
            .map(|value| value.to_string())
            .unwrap_or_else(|| "从未".to_owned())
    );
    println!(
        "上次提交: {}",
        project.last_commit.as_deref().unwrap_or("-")
    );
    Ok(ExitCode::SUCCESS)
}

/// 移除项目。
pub async fn remove(paths: &KbPaths, config: &Config, name: String) -> Result<ExitCode, CliError> {
    // 守护进程在跑时走 UDS:删项目是治理操作,不该逼用户先停服。
    let client = kb_mcp::uds::UdsClient::new(paths.socket());
    if client.is_running().await {
        client
            .call(
                "remove_project",
                serde_json::json!({ "project": name }),
                &kb_mcp::uds::CallOptions {
                    cwd: std::env::current_dir()
                        .ok()
                        .map(|value| value.to_string_lossy().into_owned()),
                    client: None,
                    project: Some(name.clone()),
                    surface: Some("web".to_owned()),
                    dry_run: false,
                },
            )
            .await?;
        println!("已移除项目 {name}(collection 与物理表已删除)");
        return Ok(ExitCode::SUCCESS);
    }
    let runtime = Embedded::open(paths, config, true).await?;
    runtime.projects().remove(&name).await?;
    println!("已移除项目 {name}(collection 与物理表已删除)");
    Ok(ExitCode::SUCCESS)
}
