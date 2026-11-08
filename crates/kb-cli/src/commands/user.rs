//! `kb user` / `kb role`:本机管理员管理账号与角色(多用户设计说明)。
//!
//! 直接读写 `system.db`(和 `kb.sock` 一样,能执行这些命令的人本来就是本机管理员)。
//! 守护进程在跑也没关系:SQLite 是 WAL,守护进程对「用户 → 身份」只缓存 5 秒,改动最多 5 秒后生效。
//! 密码一律从**标准输入**读取,不放命令行参数里。

use std::io::Read;
use std::process::ExitCode;

use kb_core::KbError;
use kb_core::account::{NewUser, ROLE_ADMIN, ROLE_USER, UserStatus};
use kb_core::paths::KbPaths;
use kb_meta::SystemStore;
use kb_meta::system::{UserFilter, UserUpdate};

use crate::error::CliError;

/// `kb user` 的动作。
#[derive(Debug, Clone)]
pub enum UserAction {
    /// 列出用户。
    List {
        /// 输出 JSON。
        json: bool,
    },
    /// 新建用户(密码从标准输入读)。
    Create {
        /// 登录名。
        username: String,
        /// 邮箱。
        email: Option<String>,
        /// 角色(`admin` / `user` / 角色 id)。
        role: String,
        /// 显示名。
        name: Option<String>,
    },
    /// 重设密码(从标准输入读),并让该用户的所有会话失效。
    Passwd {
        /// 登录名或邮箱。
        user: String,
    },
    /// 停用(立即踢下线)。
    Disable {
        /// 登录名或邮箱。
        user: String,
    },
    /// 启用。
    Enable {
        /// 登录名或邮箱。
        user: String,
    },
    /// 改角色。
    SetRole {
        /// 登录名或邮箱。
        user: String,
        /// 角色(`admin` / `user` / 角色 id)。
        role: String,
    },
    /// 列出角色。
    Roles,
}

fn open(paths: &KbPaths) -> Result<SystemStore, CliError> {
    Ok(SystemStore::open(paths.system_db())?)
}

/// `admin` / `user` 两个简写 → 内置角色 id;其余当作角色 id 原样用。
fn role_id(raw: &str) -> String {
    match raw.trim() {
        "admin" | "管理员" => ROLE_ADMIN.to_owned(),
        "user" | "普通用户" => ROLE_USER.to_owned(),
        other => other.to_owned(),
    }
}

fn read_password() -> Result<String, CliError> {
    eprintln!("请输入密码(至少 8 个字符),从标准输入读取:");
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

async fn find(system: &SystemStore, login: &str) -> Result<kb_core::account::User, CliError> {
    system
        .find_user_by_login(login)
        .await?
        .ok_or_else(|| CliError::Kb(KbError::NotFound(format!("用户 {login}"))))
}

/// 执行。
pub async fn run(paths: &KbPaths, action: UserAction) -> Result<ExitCode, CliError> {
    let system = open(paths)?;
    match action {
        UserAction::List { json } => {
            let (users, total) = system.list_users(UserFilter::default(), 200, 0).await?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(
                        &serde_json::json!({ "total": total, "users": users })
                    )
                    .map_err(|err| KbError::Internal(err.to_string()))?
                );
                return Ok(ExitCode::SUCCESS);
            }
            println!(
                "{:<22} {:<14} {:<24} {:<10} 状态",
                "用户名", "角色", "邮箱", "最近登录"
            );
            for user in users {
                println!(
                    "{:<22} {:<14} {:<24} {:<10} {}",
                    user.username,
                    user.role_id,
                    user.email.as_deref().unwrap_or("-"),
                    user.last_login_at
                        .map_or("-".to_owned(), |at| (at / 1000).to_string()),
                    user.status.as_str()
                );
            }
            println!("共 {total} 个用户");
            Ok(ExitCode::SUCCESS)
        }
        UserAction::Create {
            username,
            email,
            role,
            name,
        } => {
            let hash = kb_web::auth::password::hash_password(&read_password()?)?;
            let (user, space) = system
                .create_user(NewUser {
                    username,
                    email,
                    display_name: name,
                    password_hash: hash,
                    role_id: role_id(&role),
                    status: UserStatus::Active,
                    registered_via: "cli".to_owned(),
                    must_change_password: false,
                    email_verified: false,
                })
                .await?;
            let _ = system
                .record_audit(
                    None,
                    "user.create",
                    Some(&user.id),
                    &serde_json::json!({ "via": "cli" }),
                    None,
                )
                .await;
            println!(
                "已创建用户 {}(角色 {},知识库 {})",
                user.username, user.role_id, space.id
            );
            Ok(ExitCode::SUCCESS)
        }
        UserAction::Passwd { user } => {
            let found = find(&system, &user).await?;
            let hash = kb_web::auth::password::hash_password(&read_password()?)?;
            system
                .set_password_hash(&found.id, &hash, false, None)
                .await?;
            let _ = system
                .record_audit(
                    None,
                    "password.set",
                    Some(&found.id),
                    &serde_json::json!({ "via": "cli" }),
                    None,
                )
                .await;
            println!("{} 的密码已重设,他的其它登录会话已失效。", found.username);
            Ok(ExitCode::SUCCESS)
        }
        UserAction::Disable { user } => set_status(&system, &user, UserStatus::Disabled).await,
        UserAction::Enable { user } => set_status(&system, &user, UserStatus::Active).await,
        UserAction::SetRole { user, role } => {
            let found = find(&system, &user).await?;
            let updated = system
                .update_user(
                    &found.id,
                    UserUpdate {
                        role_id: Some(role_id(&role)),
                        ..Default::default()
                    },
                )
                .await?;
            println!("{} 的角色已改为 {}。", updated.username, updated.role_id);
            Ok(ExitCode::SUCCESS)
        }
        UserAction::Roles => {
            for role in system.list_roles().await? {
                println!(
                    "{:<14} {}{}  {}",
                    role.id,
                    role.name,
                    if role.builtin { "(内置)" } else { "" },
                    if role.all_features {
                        "全部功能".to_owned()
                    } else {
                        role.features.join(", ")
                    }
                );
            }
            Ok(ExitCode::SUCCESS)
        }
    }
}

/// 停用 / 启用。停用会立即让他的会话失效;系统里最后一个管理员不能被停用(账号库会拒绝)。
async fn set_status(
    system: &SystemStore,
    login: &str,
    status: UserStatus,
) -> Result<ExitCode, CliError> {
    let found = find(system, login).await?;
    let updated = system
        .update_user(
            &found.id,
            UserUpdate {
                status: Some(status),
                ..Default::default()
            },
        )
        .await?;
    let _ = system
        .record_audit(
            None,
            if status == UserStatus::Disabled {
                "user.disable"
            } else {
                "user.enable"
            },
            Some(&updated.id),
            &serde_json::json!({ "via": "cli" }),
            None,
        )
        .await;
    println!(
        "{} 已{}。",
        updated.username,
        if status == UserStatus::Disabled {
            "停用"
        } else {
            "启用"
        }
    );
    Ok(ExitCode::SUCCESS)
}
