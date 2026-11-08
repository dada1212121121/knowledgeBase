//! `kb` 命令行入口。
//!
//! 启动顺序:
//! 1. 解析命令行参数;
//! 2. 解析 `KB_HOME` 与配置——**此时还没有 tokio 运行时**;
//! 3. 设置 `LANCE_LANGUAGE_MODEL_HOME` / `FASTEMBED_CACHE_DIR` / `HF_HOME`,
//!    并按需把 `.hf.co` 追加进 `NO_PROXY`(必须在任何线程创建之前);
//! 4. 初始化日志(stderr + 按天滚动的文件);
//! 5. 创建数据目录、写出 jieba 词典;
//! 6. 手动构建 tokio 运行时(**不要用 `#[tokio::main]`**,否则运行时先于环境变量创建);
//! 7. 分发子命令。

/// 全局分配器:jemalloc,空闲内存 1 秒后还给系统(见 Cargo.toml 里的说明)。
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

/// jemalloc 的默认参数(可被环境变量 `_RJEM_MALLOC_CONF` 覆盖):后台线程回收、脏页 / 闲置页 1 秒衰减。
#[unsafe(export_name = "_rjem_malloc_conf")]
pub static MALLOC_CONF: &[u8] = b"background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000\0";

mod account_cleanup;
mod admin_backend;
mod admin_registration;
mod admin_view_gate;
mod bundle;
mod capability_backend;
mod cli;
mod collab_backend;
mod commands;
mod comment_backend;
mod daemon;
mod doctor;
mod error;
mod link_backend;
mod logging;
mod nightly_gate;
mod office_collab;
mod pending;
mod personal_export;
mod retention;
mod runtime;
mod share_backend;
mod share_housekeeping;
mod shared_gate;
mod shared_search;
mod social_backend;
mod spaces;
mod storage_guard;
mod usage_task;

use std::path::Path;
use std::process::ExitCode;

use clap::Parser;
use kb_core::config::Config;
use kb_core::paths::KbPaths;
use kb_core::{KbError, Result};

use crate::error::CliError;

/// 打包进二进制的 jieba 词典(5MB),启动时写到 `<KB_HOME>/lang/jieba/default/dict.txt`。
const JIEBA_DICT: &[u8] = include_bytes!("../../../assets/jieba/dict.txt");

fn main() -> ExitCode {
    match run() {
        Ok(code) => code,
        Err(err) => {
            eprintln!("kb: {err}");
            err.exit_code()
        }
    }
}

/// 旧配置键的迁移提示(启动时打一次)。
///
/// `server.enable_http_mcp` 早就废弃了,实际开关是 `[mcp] transports`。旧配置里还留着它时
/// 必须明确说一声,否则“配置里写着 true、`/mcp` 却是 404”会被当成服务故障。
fn warn_legacy_config_keys(paths: &KbPaths) {
    let Ok(text) = std::fs::read_to_string(paths.config_file()) else {
        return;
    };
    if text.contains("enable_http_mcp") {
        tracing::warn!(
            path = %paths.config_file().display(),
            "server.enable_http_mcp 已废弃且被忽略;要开 /mcp 请设置 [mcp] transports = [\"stdio\", \"http\"]"
        );
    }
}

fn run() -> std::result::Result<ExitCode, CliError> {
    let cli = cli::Cli::parse();

    let paths = KbPaths::from_env()?;
    let config = Config::load(paths.config_file())?;
    let paths = paths.with_config(&config)?;

    apply_env(&paths, &config)?;
    // 多格式抽取的配置(OCR / 转写):进程内注入一次,抽取器读它
    let _ = kb_extract::install(config.extract.clone());
    // integrate 只打印/改客户端配置:不建数据目录、也不写文件日志(否则会创建 ~/.kb/logs)
    // hook 挂在别人的会话上:不建数据目录、不写文件日志(守护进程没跑就直接跳过)
    let is_hook = matches!(&cli.command, cli::Command::Hook { .. });
    // skill 只打印内置静态文件:不建数据目录、不写日志,也不该顺手创建 ~/.kb
    let is_skill = matches!(&cli.command, cli::Command::Skill(_));
    let wants_file_log =
        !matches!(&cli.command, cli::Command::Integrate(_)) && !is_hook && !is_skill;
    let _logging = logging::init_with(&paths, &config.log.level, wants_file_log)?;
    warn_legacy_config_keys(&paths);

    // doctor 自己创建目录并把失败报成检查项,其它子命令直接失败退出。
    let is_doctor = matches!(&cli.command, cli::Command::Doctor { .. });
    // integrate 只打印 / 改客户端配置,不需要数据目录(也不该顺手创建 ~/.kb)
    let needs_dirs =
        !is_doctor && !matches!(&cli.command, cli::Command::Integrate(_)) && !is_hook && !is_skill;
    if needs_dirs {
        prepare(&paths)?;
    }

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|err| KbError::Internal(format!("创建 tokio 运行时失败: {err}")))?;

    let remote = cli.remote;
    let local = cli.local;
    let code = runtime.block_on(async {
        match cli.command {
            cli::Command::Doctor { json, what } => {
                doctor::run(&paths, &config, json, what.as_deref())
                    .await
                    .map_err(CliError::from)
            }
            cli::Command::Project { action } => match action {
                cli::ProjectAction::Add { path, name } => {
                    commands::project::add(&paths, &config, path, name).await
                }
                cli::ProjectAction::List => commands::project::list(&paths, &config).await,
                cli::ProjectAction::Show { name } => {
                    commands::project::show(&paths, &config, name).await
                }
                cli::ProjectAction::Remove { name } => {
                    commands::project::remove(&paths, &config, name).await
                }
            },
            cli::Command::Index(args) => {
                commands::index::run(
                    &paths,
                    &config,
                    commands::index::IndexArgs {
                        project: args.project,
                        full: args.full,
                        paths: args.paths,
                        global: args.global,
                        tag: args.tag,
                        remote,
                        local,
                        text_only: args.text_only,
                        embed_pending: args.embed_pending,
                    },
                )
                .await
            }
            cli::Command::Jobs(args) => match args.action {
                Some(cli::JobsAction::Prune {
                    older_than_hours,
                    yes,
                    json,
                }) => commands::jobs::prune(&paths, &config, older_than_hours, yes, json).await,
                None => commands::jobs::list(&paths, &config, args.state, args.json).await,
            },
            cli::Command::Retention(args) => {
                commands::retention::prune(&paths, &config, args.yes, args.json).await
            }
            cli::Command::Migrate {
                collection,
                to,
                dry_run,
            } => commands::migrate::run(&paths, &config, &collection, &to, dry_run).await,
            cli::Command::Accel { action } => {
                let action = match action.as_str() {
                    "install" => commands::accel::AccelAction::Install,
                    "bench" => commands::accel::AccelAction::Bench,
                    _ => commands::accel::AccelAction::Status,
                };
                commands::accel::run(&paths, &config, action).await
            }
            cli::Command::Auth { action } => {
                let action = match action {
                    cli::AuthAction::SetPassword => commands::auth::AuthAction::SetPassword,
                    cli::AuthAction::Token { action } => match action {
                        cli::AuthTokenAction::Create { name, scope } => {
                            commands::auth::AuthAction::TokenCreate { name, scope }
                        }
                        cli::AuthTokenAction::List => commands::auth::AuthAction::TokenList,
                        cli::AuthTokenAction::Revoke { id } => {
                            commands::auth::AuthAction::TokenRevoke { id }
                        }
                    },
                };
                commands::auth::run(&paths, action).await
            }
            cli::Command::User { action } => {
                let action = match action {
                    cli::UserAction::List { json } => commands::user::UserAction::List { json },
                    cli::UserAction::Create {
                        username,
                        email,
                        role,
                        name,
                    } => commands::user::UserAction::Create {
                        username,
                        email,
                        role,
                        name,
                    },
                    cli::UserAction::Passwd { user } => commands::user::UserAction::Passwd { user },
                    cli::UserAction::Disable { user } => {
                        commands::user::UserAction::Disable { user }
                    }
                    cli::UserAction::Enable { user } => commands::user::UserAction::Enable { user },
                    cli::UserAction::Role { user, role } => {
                        commands::user::UserAction::SetRole { user, role }
                    }
                    cli::UserAction::Roles => commands::user::UserAction::Roles,
                };
                commands::user::run(&paths, action).await
            }
            cli::Command::Service {
                action,
                system,
                print,
                unit_dir,
            } => {
                let action = match action.as_str() {
                    "install" => commands::service::ServiceAction::Install,
                    "uninstall" => commands::service::ServiceAction::Uninstall,
                    _ => commands::service::ServiceAction::Status,
                };
                commands::service::run(
                    &paths,
                    &config,
                    commands::service::ServiceArgs {
                        action,
                        system,
                        print,
                        unit_dir,
                    },
                )
                .await
            }
            cli::Command::Hooks { action, project } => {
                let action = match action.as_str() {
                    "install" => commands::hooks::HookAction::Install,
                    "uninstall" => commands::hooks::HookAction::Uninstall,
                    _ => commands::hooks::HookAction::Status,
                };
                commands::hooks::run(&paths, &config, action, &project).await
            }
            cli::Command::Hook { action } => {
                let hook = commands::hook::SessionHook::parse(&action).ok_or_else(|| {
                    CliError::Kb(KbError::InvalidInput(format!("未知的 hook:{action}")))
                })?;
                commands::hook::run(&paths, hook).await
            }
            cli::Command::Convert { action } => match action {
                cli::ConvertAction::Install { from, json } => {
                    commands::convert::install(&paths, from, json).await
                }
                cli::ConvertAction::Status { json } => {
                    commands::convert::status(&paths, &config, json).await
                }
            },
            cli::Command::Backup { action } => {
                let action = match action {
                    cli::BackupAction::Create {
                        include_sources,
                        json,
                    } => commands::backup::BackupAction::Create {
                        include_sources,
                        json,
                    },
                    cli::BackupAction::List { json } => {
                        commands::backup::BackupAction::List { json }
                    }
                    cli::BackupAction::Delete { name } => {
                        commands::backup::BackupAction::Delete { name }
                    }
                    cli::BackupAction::Verify { name, json } => {
                        commands::backup::BackupAction::Verify { name, json }
                    }
                    cli::BackupAction::Prune {
                        keep,
                        days,
                        dry_run,
                        json,
                    } => commands::backup::BackupAction::Prune {
                        keep,
                        days,
                        dry_run,
                        json,
                    },
                };
                commands::backup::run(&paths, &config, action).await
            }
            cli::Command::Mcp(args) => {
                let token = match args.action {
                    Some(cli::McpAction::Token { rotate: true }) => {
                        Some(commands::mcp::TokenAction::Rotate)
                    }
                    Some(cli::McpAction::Token { rotate: false }) => {
                        Some(commands::mcp::TokenAction::Show)
                    }
                    None => None,
                };
                commands::mcp::run(
                    &paths,
                    &config,
                    commands::mcp::McpArgs {
                        token,
                        features: args.features,
                    },
                )
                .await
            }
            cli::Command::Integrate(args) => {
                commands::integrate::run(commands::integrate::IntegrateArgs {
                    client: args.client,
                    apply: args.apply,
                    print: args.print,
                })
                .await
            }
            cli::Command::Skill(args) => commands::skill::run(args.out.as_deref())
                .map(|()| ExitCode::SUCCESS)
                .map_err(CliError::from),
            cli::Command::Daemon(args) => {
                daemon::run(
                    &paths,
                    &config,
                    daemon::DaemonArgs {
                        detach: args.detach,
                    },
                )
                .await
            }
            cli::Command::Eval(args) => {
                commands::eval::run(
                    &paths,
                    &config,
                    commands::eval::EvalArgs {
                        set: args.set,
                        k: args.k,
                        json: args.json,
                        allow_degraded: args.allow_degraded,
                        by_format: args.by_format,
                        sample: args.sample,
                        seed: args.seed,
                        allow_invalid: args.allow_invalid,
                        rerank: args.rerank,
                    },
                )
                .await
            }
            cli::Command::Search(args) => {
                commands::search::run(
                    &paths,
                    &config,
                    commands::search::SearchArgs {
                        query: args.query,
                        project: args.project,
                        kind: args.kind,
                        k: args.k,
                        explain: args.explain,
                        json: args.json,
                        local,
                        remote,
                        env_project: std::env::var("KB_PROJECT").ok().filter(|v| !v.is_empty()),
                    },
                )
                .await
            }
        }
    });
    runtime.shutdown_timeout(std::time::Duration::from_secs(5));
    code
}

/// 创建数据目录并写出 jieba 词典。
pub(crate) fn prepare(paths: &KbPaths) -> Result<()> {
    paths.ensure_dirs()?;
    write_jieba_dict(paths)
}

/// 写出 jieba 词典,内容不同才覆盖(避免每次启动都写 5MB)。
fn write_jieba_dict(paths: &KbPaths) -> Result<()> {
    let dir = paths.jieba_dir();
    let file = dir.join("dict.txt");
    let unchanged = std::fs::read(&file)
        .map(|existing| existing == JIEBA_DICT)
        .unwrap_or(false);
    if unchanged {
        return Ok(());
    }
    std::fs::create_dir_all(&dir)
        .map_err(|err| KbError::Internal(format!("创建目录 {} 失败: {err}", dir.display())))?;
    std::fs::write(&file, JIEBA_DICT)
        .map_err(|err| KbError::Internal(format!("写出词典 {} 失败: {err}", file.display())))?;
    tracing::info!(path = %file.display(), "写出 jieba 词典");
    Ok(())
}

/// 这些环境变量必须在创建 tokio 运行时之前设置好。
fn apply_env(paths: &KbPaths, config: &Config) -> Result<()> {
    let lang = path_to_string(paths.lang_dir())?;
    let models = path_to_string(paths.models_dir())?;
    // SAFETY: edition 2024 下 `set_var` 是 unsafe,因为其它线程可能正在读环境变量。
    // 这里还没有创建任何线程(日志与 tokio 运行时都在之后),且这些变量此后不再修改。
    unsafe {
        std::env::set_var("LANCE_LANGUAGE_MODEL_HOME", &lang);
        std::env::set_var("FASTEMBED_CACHE_DIR", &models);
        std::env::set_var("HF_HOME", &models);
    }
    if config.network.hf_cdn_direct {
        append_no_proxy(".hf.co");
    }
    Ok(())
}

/// 把一个域名追加进 `NO_PROXY` / `no_proxy`(已存在则跳过)。
fn append_no_proxy(domain: &str) {
    for key in ["NO_PROXY", "no_proxy"] {
        let current = std::env::var(key).unwrap_or_default();
        if current.split(',').any(|item| item.trim() == domain) {
            continue;
        }
        let updated = if current.trim().is_empty() {
            domain.to_owned()
        } else {
            format!("{current},{domain}")
        };
        // SAFETY: 同 apply_env——此时进程仍是单线程。
        unsafe { std::env::set_var(key, updated) };
    }
}

fn path_to_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| KbError::InvalidInput(format!("路径不是合法的 UTF-8: {}", path.display())))
}
