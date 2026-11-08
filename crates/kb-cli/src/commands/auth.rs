//! `kb auth`:设置 Web 登录密码、管理 API 令牌。
//!
//! 一律走 UDS(只有本机用户能执行);密码从**标准输入**读取,不放在命令行参数里
//! (避免出现在 `ps` 与 shell 历史里)。

use std::io::Read;
use std::process::ExitCode;

use kb_core::KbError;
use kb_core::paths::KbPaths;

use crate::error::CliError;

/// `kb auth` 的动作。
#[derive(Debug, Clone)]
pub enum AuthAction {
    /// 设置 Web 登录密码(从标准输入读取)。
    SetPassword,
    /// 新建 API 令牌。
    TokenCreate {
        /// 令牌名(唯一)。
        name: String,
        /// `mcp` 或 `api`。
        scope: String,
    },
    /// 列出令牌(不显示明文)。
    TokenList,
    /// 撤销令牌(按 id)。
    TokenRevoke {
        /// 令牌 id。
        id: String,
    },
}

/// 执行。
pub async fn run(paths: &KbPaths, action: AuthAction) -> Result<ExitCode, CliError> {
    let client = kb_mcp::uds::UdsClient::new(paths.socket());
    if !client.is_running().await {
        return Err(CliError::DaemonNotRunning);
    }
    match action {
        AuthAction::SetPassword => {
            let password = read_password()?;
            let response = client
                .post_json(
                    "/api/v1/auth/password",
                    serde_json::json!({ "password": password }),
                )
                .await?;
            if response["ok"].as_bool() != Some(true) {
                return Err(CliError::Kb(error_of(&response)));
            }
            println!("密码已设置。现在可以用它登录 Web 管理端。");
            Ok(ExitCode::SUCCESS)
        }
        AuthAction::TokenCreate { name, scope } => {
            if scope != "mcp" && scope != "api" {
                return Err(CliError::Kb(KbError::InvalidInput(
                    "scope 只能是 mcp 或 api".to_owned(),
                )));
            }
            let response = client
                .post_json(
                    "/api/v1/auth/tokens",
                    serde_json::json!({ "name": name, "scope": scope }),
                )
                .await?;
            if response["ok"].as_bool() != Some(true) {
                return Err(CliError::Kb(error_of(&response)));
            }
            let data = &response["data"];
            println!("令牌已创建(只显示这一次,请立刻保存):");
            println!();
            println!("  {}", data["token"].as_str().unwrap_or_default());
            println!();
            println!(
                "  id: {}  name: {}  scope: {}",
                data["id"].as_str().unwrap_or_default(),
                data["name"].as_str().unwrap_or_default(),
                data["scope"].as_str().unwrap_or_default()
            );
            Ok(ExitCode::SUCCESS)
        }
        AuthAction::TokenList => {
            let response = client.get_json("/api/v1/auth/tokens").await?;
            if response["ok"].as_bool() != Some(true) {
                return Err(CliError::Kb(error_of(&response)));
            }
            let tokens = response["data"]["tokens"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if tokens.is_empty() {
                println!("还没有 API 令牌。用 `kb auth token create <name> --scope mcp` 创建。");
                return Ok(ExitCode::SUCCESS);
            }
            println!("{:<38} {:<16} {:<6} 状态", "id", "name", "scope");
            for token in tokens {
                let revoked = token["revoked_at"].is_number();
                println!(
                    "{:<38} {:<16} {:<6} {}",
                    token["id"].as_str().unwrap_or_default(),
                    token["name"].as_str().unwrap_or_default(),
                    token["scope"].as_str().unwrap_or_default(),
                    if revoked { "已撤销" } else { "有效" }
                );
            }
            Ok(ExitCode::SUCCESS)
        }
        AuthAction::TokenRevoke { id } => {
            let response = client
                .delete_json(&format!("/api/v1/auth/tokens/{id}"))
                .await?;
            if response["ok"].as_bool() != Some(true) {
                return Err(CliError::Kb(error_of(&response)));
            }
            println!("令牌 {id} 已撤销。");
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// 从标准输入读一行密码(去掉行尾换行)。
fn read_password() -> Result<String, CliError> {
    eprintln!("请输入新密码(至少 8 个字符),从标准输入读取:");
    let mut raw = String::new();
    std::io::stdin()
        .read_to_string(&mut raw)
        .map_err(|err| CliError::Kb(KbError::Internal(format!("读取标准输入失败: {err}"))))?;
    let password = raw.trim_end_matches(['\n', '\r']).to_owned();
    if password.is_empty() {
        return Err(CliError::Kb(KbError::InvalidInput(
            "密码不能为空(从标准输入读取一行)".to_owned(),
        )));
    }
    Ok(password)
}

/// 从错误响应里取 `KbError`。
fn error_of(response: &serde_json::Value) -> KbError {
    let message = response["error"]["message"]
        .as_str()
        .unwrap_or("请求失败")
        .to_owned();
    match response["error"]["code"].as_str() {
        Some("forbidden") => KbError::Forbidden(message),
        Some("unauthorized") => KbError::Unauthorized,
        Some("invalid_input") => KbError::InvalidInput(message),
        Some("not_found") => KbError::NotFound(message),
        _ => KbError::Internal(message),
    }
}
