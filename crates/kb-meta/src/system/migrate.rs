//! system.db 的迁移:按 `PRAGMA user_version` 顺序执行 `system_migrations/sNNNN_*.sql`,
//! 每个脚本一个事务,幂等(与 meta.db 的迁移同一套规则)。

use kb_core::{KbError, Result};
use rusqlite::Connection;

use crate::sql::map_sqlite_error;

/// 内置迁移脚本:(版本号, SQL)。新增迁移时在末尾追加。
pub(crate) const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../../system_migrations/s0001_init.sql")),
    // 邮箱验证码、邀请码、发信记录
    (
        2,
        include_str!("../../system_migrations/s0002_registration.sql"),
    ),
    // 用户界面偏好
    (
        3,
        include_str!("../../system_migrations/s0003_user_prefs.sql"),
    ),
    // 按用户的 LLM 用量
    (
        4,
        include_str!("../../system_migrations/s0004_llm_usage.sql"),
    ),
    // 知识库占用明细
    (
        5,
        include_str!("../../system_migrations/s0005_space_usage.sql"),
    ),
    // 好友、拉黑、站内通知
    (6, include_str!("../../system_migrations/s0006_social.sql")),
    // 通知邮件偏好与合并发送队列
    (
        7,
        include_str!("../../system_migrations/s0007_notify_prefs.sql"),
    ),
    // 邀请码自动加好友
    (
        8,
        include_str!("../../system_migrations/s0008_invite_auto_friend.sql"),
    ),
    // 文档授权、停止继承、共享列表隐藏、访问申请
    (9, include_str!("../../system_migrations/s0009_grants.sql")),
    // 分享链接、游客
    (
        10,
        include_str!("../../system_migrations/s0010_share_links.sql"),
    ),
    // 代理工作目录占用(计入配额)
    (
        11,
        include_str!("../../system_migrations/s0011_workspace_usage.sql"),
    ),
    // 两步验证(TOTP):密钥与恢复码
    (12, include_str!("../../system_migrations/s0012_totp.sql")),
    // 用户 admin key(含给已有用户补发)
    (
        13,
        include_str!("../../system_migrations/s0013_admin_keys.sql"),
    ),
    // 资源采样:每分钟一行,保留 30 天(监控图表用)
    (
        14,
        include_str!("../../system_migrations/s0014_metric_samples.sql"),
    ),
];

pub(crate) fn current_version(conn: &Connection) -> Result<i64> {
    conn.query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(map_sqlite_error)
}

pub(crate) fn run(conn: &mut Connection) -> Result<i64> {
    let mut version = current_version(conn)?;
    for (target, sql) in MIGRATIONS {
        if *target <= version {
            continue;
        }
        let tx = conn.transaction().map_err(map_sqlite_error)?;
        tx.execute_batch(sql).map_err(map_sqlite_error)?;
        tx.pragma_update(None, "user_version", *target)
            .map_err(map_sqlite_error)?;
        tx.commit().map_err(map_sqlite_error)?;
        version = *target;
    }
    if version == 0 {
        return Err(KbError::Internal("system.db 没有可用的迁移脚本".to_owned()));
    }
    Ok(version)
}
