//! `kb mcp`:stdio 桥接与 `/mcp` 的 token 管理。
//!
//! **stdout 只能输出 MCP 协议数据**;所有日志都走 stderr / 文件。

use std::path::Path;
use std::process::ExitCode;

use kb_core::KbError;
use kb_core::config::Config;
use kb_core::paths::KbPaths;
use kb_mcp::bridge::{Bridge, serve_stdio};
use kb_mcp::uds::UdsClient;

use crate::error::CliError;

/// `kb mcp` 的参数。
#[derive(Clone, Debug, Default)]
pub struct McpArgs {
    /// 管理 `/mcp` 的 token:`None` = 启动 stdio 桥接;`Some(false)` = 查看/生成;`Some(true)` = 轮换。
    pub token: Option<TokenAction>,
    /// 只暴露这些工具组(逗号分隔;空 = 全部)。
    pub features: Option<String>,
}

/// token 子命令的动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenAction {
    /// 显示路径与当前 token(不存在则生成)。
    Show,
    /// 轮换(重新生成)。
    Rotate,
}

/// 启动 stdio 桥接;守护进程没在跑就先拉起来。
pub async fn run(paths: &KbPaths, config: &Config, args: McpArgs) -> Result<ExitCode, CliError> {
    if let Some(action) = args.token {
        return token(paths, action);
    }
    if !config.mcp.stdio_enabled() {
        return Err(KbError::InvalidInput(
            "mcp.transports 里没有 stdio,`kb mcp` 无法启动(可改成 [\"stdio\"] 或 [\"stdio\",\"http\"])"
                .to_owned(),
        )
        .into());
    }
    let (client, agent_mode) = match (
        std::env::var("KB_AGENT_SOCK"),
        std::env::var("KB_AGENT_TOKEN"),
    ) {
        (Ok(socket), Ok(token)) if !socket.trim().is_empty() && !token.trim().is_empty() => {
            (UdsClient::new(socket).with_bearer(token), true)
        }
        _ => (UdsClient::new(paths.socket()), false),
    };
    if agent_mode {
        if !client.is_running().await {
            return Err(KbError::Unavailable(
                "连不上 agent.sock;伴生进程只能跟着已经在跑的守护进程".to_owned(),
            )
            .into());
        }
    } else if !client.is_running().await {
        start_daemon(paths)?;
        wait_for_daemon(&client).await?;
    }
    // stdio:上下文来自本进程(即客户端),这是设计规范的 KB_PROJECT / cwd 用法
    let mut bridge = Bridge::with_context(
        client,
        config.search.mcp_max_output_chars,
        kb_mcp::bridge::BridgeContext {
            cwd: std::env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned()),
            project: std::env::var("KB_PROJECT").ok().filter(|v| !v.is_empty()),
        },
    );
    if let Some(features) = args.features {
        bridge = bridge.with_features(features.split(',').map(str::to_owned).collect());
    }
    serve_stdio(bridge).await?;
    Ok(ExitCode::SUCCESS)
}

/// `kb mcp token [--rotate]`。
pub fn token(paths: &KbPaths, action: TokenAction) -> Result<ExitCode, CliError> {
    let file = paths.mcp_token_file();
    let value = match action {
        TokenAction::Rotate => write_token(&file)?,
        TokenAction::Show => match std::fs::read_to_string(&file) {
            Ok(existing) if !existing.trim().is_empty() => existing.trim().to_owned(),
            _ => write_token(&file)?,
        },
    };
    println!("token 文件:{}", file.display());
    println!("token:{value}");
    println!("\n在远程客户端里配置:Authorization: Bearer {value}");
    Ok(ExitCode::SUCCESS)
}

/// 生成并写入 token(0600)。
fn write_token(file: &Path) -> Result<String, CliError> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
        })?;
    }
    let token = random_token();
    std::fs::write(file, format!("{token}\n"))
        .map_err(|err| KbError::Internal(format!("写 token 失败: {err}")))?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))
        .map_err(|err| KbError::Internal(format!("chmod 0600 失败: {err}")))?;
    Ok(token)
}

/// 32 字节随机数的十六进制(读 `/dev/urandom`;不引额外依赖)。
fn random_token() -> String {
    use std::io::Read;
    let mut bytes = [0u8; 32];
    match std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(&mut bytes)) {
        Ok(()) => bytes.iter().map(|byte| format!("{byte:02x}")).collect(),
        Err(err) => {
            // 极端情况下退回 uuid v4(仍含 122 位随机)
            tracing::warn!(error = %err, "读 /dev/urandom 失败,退回 uuid v4");
            format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            )
        }
    }
}

/// 用 `kb daemon --detach` 拉起守护进程。
fn start_daemon(paths: &KbPaths) -> Result<(), CliError> {
    let exe = std::env::current_exe()
        .map_err(|err| KbError::Internal(format!("取当前可执行文件失败: {err}")))?;
    std::process::Command::new(exe)
        .args(["daemon", "--detach"])
        .env("KB_HOME", paths.home())
        // 不要把自己的 KB_PROJECT 传染给长驻守护进程
        .env_remove("KB_PROJECT")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|err| KbError::Internal(format!("拉起守护进程失败: {err}")))?;
    Ok(())
}

/// 等 socket 可用(最多 60 秒)。
async fn wait_for_daemon(client: &UdsClient) -> Result<(), CliError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        if client.is_running().await {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            return Err(KbError::Unavailable(
                "守护进程在 60 秒内没有启动完成,请手动运行 `kb daemon`".to_owned(),
            )
            .into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}
