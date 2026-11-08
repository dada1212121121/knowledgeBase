//! 到期账号的清理(多用户设计说明):冷静期结束后真正删掉账号和他的全部数据。
//!
//! 删除不可逆,所以每一步都先问「这样做会不会删到别人的东西」:
//! - 主知识库就是数据根目录 `KB_HOME`,拥有它的账号**永远不清理**(存储层在申请时就拒绝,这里再挡一次);
//! - 要删的目录必须落在 `<KB_HOME>/spaces/` 之内,路径由经过校验的知识库 id 算出,不拼接任何外部字符串;
//! - 顺序是「先会话 → 缓存 → 文件 → 最后才删库里的行」:任何一步失败都停在这里、记日志,
//!   账号行还在,下一轮会重试;反过来先删行会让磁盘上的数据变成没人再去清理的孤儿。

use std::path::PathBuf;
use std::sync::Arc;

use kb_core::account::PRIMARY_SPACE_ID;
use kb_core::model::Millis;
use kb_core::paths::KbPaths;
use kb_core::{KbError, Result};
use kb_meta::SystemStore;
use kb_meta::system::Purgeable;
use kb_web::avatar;

use crate::spaces::SpaceRegistry;

/// 一个到期账号的处理结果。
#[derive(Debug, PartialEq, Eq)]
pub enum Purge {
    /// 已删除。
    Done,
    /// 不该由自动任务删除(原因写在里面),需要人处理。
    Skipped(String),
    /// 中途失败,账号行还在,下一轮重试。
    Failed(String),
}

/// 知识库目录的安全路径:id 必须合法,结果必须在 `spaces/` 之内。
pub fn safe_space_dir(paths: &KbPaths, space_id: &str) -> Result<PathBuf> {
    if space_id == PRIMARY_SPACE_ID {
        return Err(KbError::Forbidden(
            "主知识库不能当作普通目录删除".to_owned(),
        ));
    }
    let dir = paths.space_dir(space_id)?;
    if !dir.starts_with(paths.spaces_dir()) || dir == paths.spaces_dir() {
        return Err(KbError::Forbidden(format!(
            "知识库目录不在 spaces/ 之内:{}",
            dir.display()
        )));
    }
    Ok(dir)
}

/// 清理所有到期的账号。返回 `(用户 id, 结果)`。
pub async fn purge_due_accounts(
    system: &SystemStore,
    spaces: Option<&Arc<SpaceRegistry>>,
    paths: &KbPaths,
    now: Millis,
) -> Result<Vec<(String, Purge)>> {
    let mut results = Vec::new();
    for user_id in system.due_for_deletion(now).await? {
        let outcome = purge_one(system, spaces, paths, &user_id, now).await;
        match &outcome {
            Purge::Done => tracing::info!(user = %user_id, "已清理到期注销的账号"),
            Purge::Skipped(reason) => {
                tracing::warn!(user = %user_id, %reason, "到期账号不能自动清理,需要人处理");
            }
            Purge::Failed(reason) => {
                tracing::error!(user = %user_id, %reason, "清理到期账号失败,下一轮重试");
            }
        }
        results.push((user_id, outcome));
    }
    Ok(results)
}

async fn purge_one(
    system: &SystemStore,
    spaces: Option<&Arc<SpaceRegistry>>,
    paths: &KbPaths,
    user_id: &str,
    now: Millis,
) -> Purge {
    let fail = |step: &str, err: KbError| Purge::Failed(format!("{step}:{err}"));
    let user = match system.get_user(user_id).await {
        Ok(Some(user)) => user,
        Ok(None) => return Purge::Done, // 已经删过了
        Err(err) => return fail("读取账号", err),
    };
    let space = match system.personal_space(user_id).await {
        Ok(space) => space,
        Err(err) => return fail("读取知识库", err),
    };
    if space
        .as_ref()
        .is_some_and(|space| space.id == PRIMARY_SPACE_ID)
    {
        return Purge::Skipped("账号拥有主知识库(数据根目录),不能自动清理".to_owned());
    }
    // 删任何文件之前先问存储层「现在能删吗」(主库拥有者、团队知识库、冷静期状态……):
    // 否则会出现「目录已经删了,账号行却被拒绝」的半截状态
    match system.check_purgeable(user_id, now).await {
        Ok(Purgeable::Yes) => {}
        Ok(Purgeable::AlreadyGone) => return Purge::Done,
        Err(KbError::Exists(reason)) | Err(KbError::Forbidden(reason)) => {
            return Purge::Skipped(reason);
        }
        Err(err) => return fail("检查能否删除", err),
    }
    // 所有可能失败的校验放在最前面,没问题了才开始有副作用的动作:目录不合规就一点都不动
    let dir = match space.as_ref().map(|space| safe_space_dir(paths, &space.id)) {
        Some(Ok(dir)) => Some(dir),
        Some(Err(err)) => return fail("计算知识库目录", err),
        None => None,
    };
    // 让他所有设备上的登录失效,之后没有新请求会再碰他的知识库
    if let Err(err) = system.delete_user_sessions(user_id, None).await {
        return fail("清除登录", err);
    }
    if let (Some(space), Some(dir)) = (&space, &dir) {
        if let Some(spaces) = spaces
            && let Err(err) = spaces.evict(&space.id).await
        {
            return fail("释放知识库", err);
        }
        match std::fs::remove_dir_all(dir) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Purge::Failed(format!("删除知识库目录 {}:{err}", dir.display())),
        }
    }
    if let Some(name) = &user.avatar {
        avatar::remove(paths.avatars_dir(), name);
    }
    // 他生成过的数据导出(里面是他的原件)也一起删;文件名以 `<用户id>-` 开头
    remove_exports_of(paths.exports_dir(), user_id);
    match system.purge_user(user_id, now).await {
        Ok(()) => Purge::Done,
        Err(KbError::Exists(reason)) | Err(KbError::Forbidden(reason)) => Purge::Skipped(reason),
        Err(err) => fail("删除账号", err),
    }
}

/// 删掉导出目录里属于这个用户的文件(含没写完的 `.part`)。
///
/// 按**精确的用户 id** 匹配(文件名是 `<用户id>-<16 位十六进制>.tar.gz[.part]`),而不是只看前缀:
/// 前缀匹配在一个用户 id 恰好是另一个的前缀时会误删别人的导出。
fn remove_exports_of(dir: &std::path::Path, user_id: &str) {
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for item in read.flatten() {
        let name = item.file_name().to_string_lossy().into_owned();
        if export_owner(&name) == Some(user_id) {
            let _ = std::fs::remove_file(item.path());
        }
    }
}

/// 导出文件名属于哪个用户;不是我们生成的样子返回 `None`。
fn export_owner(name: &str) -> Option<&str> {
    let stem = name.strip_suffix(".part").unwrap_or(name);
    let stem = stem.strip_suffix(".tar.gz")?;
    let (owner, token) = stem.rsplit_once('-')?;
    let token_ok = token.len() == 16
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    token_ok.then_some(owner)
}

#[cfg(test)]
mod tests;
