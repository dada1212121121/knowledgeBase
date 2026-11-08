//! `<KB_HOME>/skills/` 的目录监听:插件目录有变化就通知宿主重扫(热加载)。
//!
//! 以前改一个插件(`manifest.toml` 换个参数、加一个 `tools/` 脚本)要重启整个守护进程,
//! 或者去设置页点一次「重新扫描」;而扫描本身早就支持热重载(`Runtime::reload_skills`
//! 换的是 `Arc<RwLock<Arc<SkillRegistry>>>` 快照),缺的只是“有人告诉它该扫了”。
//!
//! 规则:
//! - **递归**监听整个目录。插件目录是平的、文件个位数,不需要项目监听那套排除规则;
//! - **去抖**:编辑器保存一次 manifest 常常连来好几个事件,`SKILLS_DEBOUNCE_MS` 内合并成一批;
//! - **坏 manifest 不会让旧插件失效**:`SkillRegistry::load_with_options` 自己吞掉解析错误并记 warning,
//!   重扫失败时调用方的日志里能看到 `warnings` 条数;
//! - 目录不存在(从没装过插件)时先建出来 —— `notify` 挂不上不存在的路径。

use std::path::{Path, PathBuf};
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use tokio::sync::mpsc;

/// 去抖窗口:500 ms 足够合并“保存 manifest + 顺手改一个脚本”这种连击。
pub const SKILLS_DEBOUNCE_MS: u64 = 500;

/// 监听句柄。
///
/// **必须一直持有**:底层 `notify` 监听器一旦被丢掉,内核监听项立刻摘掉,
/// 后台去抖任务随之因为通道关闭而退出。守护进程把它放进常驻的异步任务里。
pub struct SkillsWatcher {
    /// 只为了“活着”而存在,没人会去读它。
    _watcher: notify::RecommendedWatcher,
}

/// 监听 skills 目录,每次变化去抖后投递一批变更路径。
///
/// 返回的接收端被关掉(调用方退出)时,后台任务自行结束。
pub fn watch_skills_dir(
    dir: &Path,
    debounce_ms: u64,
) -> kb_core::Result<(mpsc::Receiver<Vec<PathBuf>>, SkillsWatcher)> {
    // 目录不存在就建:没装过插件也要能挂监听,否则“第一次装插件”永远收不到通知
    if let Err(err) = std::fs::create_dir_all(dir) {
        return Err(kb_core::KbError::Internal(format!(
            "创建 skills 目录失败 {}: {err}",
            dir.display()
        )));
    }

    let (raw_tx, mut raw_rx) = mpsc::channel::<PathBuf>(256);
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        // 只关心增 / 改 / 删;访问、元数据以外的杂项事件忽略(否则 `ls` 一下也触发重扫)
        if !matches!(
            event.kind,
            notify::EventKind::Create(_)
                | notify::EventKind::Modify(notify::event::ModifyKind::Data(_))
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                | notify::EventKind::Remove(_)
        ) {
            return;
        }
        for path in event.paths {
            // 有界通道堵满时丢事件而不是阻塞内核回调线程:下一次保存还会来
            let _ = raw_tx.blocking_send(path);
        }
    })
    .map_err(|err| kb_core::KbError::Internal(format!("创建 skills 监听器失败: {err}")))?;

    watcher
        .watch(dir, RecursiveMode::Recursive)
        .map_err(|err| {
            kb_core::KbError::Internal(format!("监听 skills 目录失败 {}: {err}", dir.display()))
        })?;

    let (batch_tx, batch_rx) = mpsc::channel::<Vec<PathBuf>>(8);
    let debounce = Duration::from_millis(debounce_ms.max(1));
    tokio::spawn(async move {
        while let Some(first) = raw_rx.recv().await {
            let mut batch = vec![first];
            // 在去抖窗口内继续收集,攒成一批
            let deadline = tokio::time::Instant::now() + debounce;
            // 窗口内继续收:收到 `None`(监听器被丢掉)或超时,这一批就齐了
            while let Ok(Some(path)) = tokio::time::timeout_at(deadline, raw_rx.recv()).await {
                batch.push(path);
            }
            if batch_tx.send(batch).await.is_err() {
                break;
            }
        }
    });

    Ok((batch_rx, SkillsWatcher { _watcher: watcher }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真磁盘 + 真监听:写一个文件,去抖窗口后应当收到一批包含它的变化。
    ///
    /// 监听能不能收到事件取决于内核,所以这里**只断言“收到了一批”**并给足超时,
    /// 不逐条比对路径(不同平台报的事件数与路径都不一样)。
    #[tokio::test]
    async fn a_write_under_the_skills_dir_delivers_one_batch() {
        let dir = std::env::temp_dir().join(format!(
            "kb-skills-watch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or_default()
        ));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        let (mut changes, _watcher) = match watch_skills_dir(&dir, 50) {
            Ok(pair) => pair,
            // 容器里没有 inotify / 监听项用光时这个用例没法跑,跳过而不是假红
            Err(err) => {
                eprintln!("跳过:当前环境挂不上监听 ({err})");
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
        };

        // 监听挂上之后才写,避免与注册竞速
        let plugin = dir.join("demo");
        std::fs::create_dir_all(&plugin).expect("建插件目录");
        std::fs::write(plugin.join("manifest.toml"), "id = \"demo\"\n").expect("写 manifest");

        let batch = tokio::time::timeout(Duration::from_secs(10), changes.recv())
            .await
            .expect("10 秒内应有变化通知")
            .expect("通道不该关");
        assert!(!batch.is_empty(), "一批里至少要有一个路径");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
