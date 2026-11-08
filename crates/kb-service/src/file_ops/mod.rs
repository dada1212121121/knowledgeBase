//! 文件删除 / 移动 / 回收站。
//!
//! 这里的核心原则:
//! - **删除不是删除**:上传 / 压缩包只搬进 `KB_HOME/trash`;本地目录 / 项目 / Web / Git 只移除索引,
//!   绝不碰磁盘上的原件或源站。
//! - **路径按段匹配**:`docs` 不能匹配 `docs2`,所以所有文件夹判断都用 `path == dir || path.starts_with(dir + "/")`。
//! - **先记流水再动手**:一次文件夹操作可能搬几十个文件,中途失败必须能从 `file_ops` / `trash_entries` 知道做到哪了。
//! - **块 id 由路径派生**:移动后必须按新路径重新索引,不能改旧块 id。
//!
//! 分享授权、协作房间的清理在能力层做(需要 `SystemStore` / `CollabHub`),本服务只管文件与索引。
//! 拆成四块(2026-11-08,超长文件棘轮):1963 行的 `impl FileOpsService` 按原文件的
//! 方法顺序切成三段,搬的时候不重排、不改行为;`impl` 允许跨文件。
//! - `core`:新建、动作清单、删除、移动;
//! - `trash`:回收站与路径定位;
//! - `support`:指纹、索引、元数据、操作记录;
//! - 本文件尾部:自由函数与 `TrashHook` 实现。

use std::path::Path;
use std::sync::Arc;

use kb_core::model::{FileOrigin, FileTarget, Millis, SourceKind};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::MetaStore;
use kb_core::{KbError, Result};

use crate::index::IndexService;
use crate::scheduler::TrashHook;

/// 回收站保留时长。
pub const TRASH_RETENTION_MS: Millis = 30 * 24 * 60 * 60 * 1000;
/// 一次文件夹操作最多处理多少个文件:超了要求用户分批,避免一个请求把守护进程卡死。
pub const MAX_FOLDER_FILES: usize = 2_000;

/// 文件操作服务。
mod core;
mod support;
mod trash;

pub struct FileOpsService {
    pub(crate) meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    index: Arc<IndexService>,
    paths: kb_core::KbPaths,
}

/// 已经移动的文件(回滚用)。
pub(crate) struct MovedFile {
    target: FileTarget,
    from: String,
    to: String,
    abs_from: String,
    abs_to: String,
    from_collection: String,
    to_collection: String,
    from_source_id: Option<String>,
}

fn anchor_label(annotation: &kb_core::model::Annotation) -> String {
    annotation
        .anchor
        .as_ref()
        .map(kb_core::model::Anchor::label)
        .unwrap_or_else(|| "全文".to_owned())
}

fn origin_of(kind: SourceKind) -> FileOrigin {
    match kind {
        SourceKind::Upload => FileOrigin::Upload,
        SourceKind::Archive => FileOrigin::Archive,
        SourceKind::Web => FileOrigin::Web,
        SourceKind::Git => FileOrigin::Git,
        SourceKind::LocalDir => FileOrigin::LocalDir,
        SourceKind::Note => FileOrigin::Note,
    }
}

fn common_origin(targets: &[FileTarget]) -> FileOrigin {
    let first = targets.first().map(|target| target.origin);
    if targets.iter().all(|target| Some(target.origin) == first) {
        first.unwrap_or(FileOrigin::Unknown)
    } else {
        FileOrigin::Unknown
    }
}

fn replace_source_prefix(source: &str, from: &str, to: &str) -> String {
    if source == from {
        return to.to_owned();
    }
    match source
        .strip_prefix(from)
        .and_then(|tail| tail.strip_prefix('/'))
    {
        Some(tail) => format!("{to}/{tail}"),
        None => source.to_owned(),
    }
}

fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn join_target(dir: &str, name: &str) -> Result<String> {
    let name = name.trim();
    if name == "." || name == ".." {
        return Err(KbError::InvalidInput("新文件名不能是 . 或 ..".to_owned()));
    }
    crate::safe_path::check_rel_path(name)?;
    if name.contains('/') || name.contains('\\') {
        return Err(KbError::InvalidInput(
            "新文件名不能带路径,请用 target_dir 指定目录".to_owned(),
        ));
    }
    // 前端会 trim,但 API / 脚本可能带首尾斜杠;统一在这里收敛,
    // 否则库里会出现 `archive//a.md` 这种和实际物理路径不一致的路径。
    let dir = dir.trim_matches('/');
    if dir.is_empty() {
        return Ok(name.to_owned());
    }
    crate::safe_path::check_rel_path(dir)?;
    Ok(format!("{dir}/{name}"))
}

/// 同盘 rename;跨盘时 copy + fsync + rename,保证目标要么完整要么不存在。
async fn move_path(from: &Path, to: &Path) -> Result<()> {
    if let Some(parent) = to.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|err| {
            KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
        })?;
    }
    match tokio::fs::rename(from, to).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::CrossesDevices => {
            let temp = to.with_file_name(format!(".kb-move-{}", uuid::Uuid::now_v7()));
            tokio::fs::copy(from, &temp).await.map_err(|err| {
                KbError::Internal(format!(
                    "复制 {} → {} 失败: {err}",
                    from.display(),
                    to.display()
                ))
            })?;
            let file = tokio::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&temp)
                .await
                .map_err(|err| KbError::Internal(format!("打开 {} 失败: {err}", temp.display())))?;
            file.sync_all()
                .await
                .map_err(|err| KbError::Internal(format!("同步 {} 失败: {err}", temp.display())))?;
            tokio::fs::rename(&temp, to)
                .await
                .map_err(|err| KbError::Internal(format!("移动到 {} 失败: {err}", to.display())))?;
            tokio::fs::remove_file(from).await.map_err(|err| {
                KbError::Internal(format!("删除原件 {} 失败: {err}", from.display()))
            })?;
            Ok(())
        }
        Err(err) => Err(KbError::Internal(format!(
            "移动 {} → {} 失败: {err}",
            from.display(),
            to.display()
        ))),
    }
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[async_trait::async_trait]
impl TrashHook for FileOpsService {
    async fn purge_trash(&self) -> Result<u64> {
        // 每批 200 条:批量删要搬文件,一次开太多会让夜间任务的内存和磁盘压力不可控。
        self.purge_expired(200).await
    }
}
