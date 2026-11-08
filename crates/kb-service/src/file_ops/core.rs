//! 文件删除 / 移动 / 回收站。
//!
//! 这里的核心原则:
//! - **删除不是删除**:上传 / 压缩包只搬进 `KB_HOME/trash`;本地目录 / 项目 / Web / Git 只移除索引,
//! 绝不碰磁盘上的原件或源站。
//! - **路径按段匹配**:`docs` 不能匹配 `docs2`,所以所有文件夹判断都用 `path == dir || path.starts_with(dir + "/")`。
//! - **先记流水再动手**:一次文件夹操作可能搬几十个文件,中途失败必须能从 `file_ops` / `trash_entries` 知道做到哪了。
//! - **块 id 由路径派生**:移动后必须按新路径重新索引,不能改旧块 id。
//!
//! 分享授权、协作房间的清理在能力层做(需要 `SystemStore` / `CollabHub`),本服务只管文件与索引。
//! 新建、动作清单、删文件 / 删目录、移动(文件 / 一批 / 目录)。

use std::collections::BTreeSet;
use std::sync::Arc;

use kb_core::model::{
    FileActionAvailability, FileActions, FileOp, FileOpKind, FileOpState, FileOrigin,
};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::{FileRepo, MetaStore};
use kb_core::{KbError, Result};

use crate::index::IndexService;

/// 文件操作服务。
use super::*;

impl FileOpsService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        index: Arc<IndexService>,
        paths: kb_core::KbPaths,
    ) -> Self {
        Self {
            meta,
            store,
            index,
            paths,
        }
    }

    /// 前端菜单要问的:这个文件 / 文件夹能不能删、能不能移动,以及操作前要带上的指纹。
    pub async fn actions(&self, collection: &str, path: &str) -> Result<FileActions> {
        crate::safe_path::check_rel_path(path)?;
        let files = self.descendants(collection, path).await?;
        let exact = FileRepo::get(self.meta.as_ref(), collection, path).await?;
        let folder = exact.is_none() && !files.is_empty();
        if exact.is_none() && files.is_empty() {
            return Err(KbError::NotFound(format!("{collection}/{path}")));
        }
        if path.split('/').any(|segment| segment == "_attachments") {
            return Ok(FileActions {
                collection: collection.to_owned(),
                path: path.to_owned(),
                origin: FileOrigin::Attachment,
                managed: false,
                folder,
                files: files.len() as u64,
                fingerprint: self.folder_fingerprint(&files),
                delete: FileActionAvailability::no("附件随父条目一起删除,不能单独操作"),
                r#move: FileActionAvailability::no("附件不能单独移动"),
            });
        }
        let targets = if folder {
            self.locate_folder(collection, path, &files).await?
        } else {
            vec![self.locate_file(collection, path).await?]
        };
        let managed = targets.iter().all(|target| target.managed);
        let origin = common_origin(&targets);
        let blocked = targets.iter().find_map(|target| match target.origin {
            FileOrigin::Note => Some("这是手写笔记,请用「删除条目」"),
            FileOrigin::Attachment => Some("附件随父条目一起删除,不能单独操作"),
            FileOrigin::Unknown => Some("无法确定这个文件的来源,不能操作"),
            _ => None,
        });
        let delete = match blocked {
            Some(reason) => FileActionAvailability::no(reason),
            None => FileActionAvailability::yes(),
        };
        let move_reason = if !managed {
            Some("只有上传 / 压缩包里的文件可以移动;本地目录、项目、Web、Git 的文件请到原处移动")
        } else if targets.iter().any(|target| target.source_id.is_none()) {
            Some("这个文件没有数据源记录,不能移动")
        } else {
            None
        };
        let fingerprint = if folder {
            self.folder_fingerprint_targets(&targets)
        } else {
            self.file_fingerprint(&targets[0])
        };
        Ok(FileActions {
            collection: collection.to_owned(),
            path: path.to_owned(),
            origin,
            managed,
            folder,
            files: targets.len() as u64,
            fingerprint,
            delete,
            r#move: match move_reason {
                Some(reason) => FileActionAvailability::no(reason),
                None => FileActionAvailability::yes(),
            },
        })
    }

    /// 删除单个文件。`fingerprint` 是 `file_actions` 返回的值,执行前重算,不一致 409。
    pub async fn delete_file(
        &self,
        collection: &str,
        path: &str,
        fingerprint: &str,
    ) -> Result<FileOp> {
        let target = self.locate_file(collection, path).await?;
        self.ensure_fingerprint(&target, fingerprint)?;
        self.reject_unsupported(&target)?;
        let mut op = self
            .new_op(collection, FileOpKind::DeleteFile, 1, None)
            .await?;
        match self.delete_one(&target, &op.id).await {
            Ok(()) => {
                op.done = 1;
                op.state = FileOpState::Done;
                self.finish_op(op).await
            }
            Err(err) => {
                op.failed = 1;
                op.state = FileOpState::Failed;
                op.error = Some(err.to_string());
                self.finish_op(op).await?;
                Err(err)
            }
        }
    }

    /// 删除文件夹(按路径段边界列出全部后代,逐个按来源处理)。允许部分成功。
    pub async fn delete_folder(
        &self,
        collection: &str,
        path: &str,
        fingerprint: &str,
    ) -> Result<FileOp> {
        crate::safe_path::check_rel_path(path)?;
        let files = self.descendants(collection, path).await?;
        if files.is_empty() {
            return Err(KbError::NotFound(format!("{collection}/{path}")));
        }
        let targets = self.locate_folder(collection, path, &files).await?;
        self.ensure_folder_fingerprint(&targets, fingerprint)?;
        let mut op = self
            .new_op(
                collection,
                FileOpKind::DeleteFolder,
                targets.len() as u64,
                None,
            )
            .await?;
        let mut first_error = None;
        for target in &targets {
            if matches!(
                target.origin,
                FileOrigin::Attachment | FileOrigin::Note | FileOrigin::Unknown
            ) {
                op.failed += 1;
                if first_error.is_none() {
                    first_error = Some(format!("{}:{:?}", target.path, target.origin));
                }
                continue;
            }
            match self.delete_one(target, &op.id).await {
                Ok(()) => op.done += 1,
                Err(err) => {
                    op.failed += 1;
                    if first_error.is_none() {
                        first_error = Some(err.to_string());
                    }
                }
            }
        }
        op.state = if op.failed == 0 {
            FileOpState::Done
        } else if op.done == 0 {
            FileOpState::Failed
        } else {
            FileOpState::Partial
        };
        op.error = first_error;
        self.finish_op(op).await
    }

    /// 移动单个文件。
    pub async fn move_file(
        &self,
        collection: &str,
        path: &str,
        target_collection: &str,
        target_dir: &str,
        new_name: Option<&str>,
        fingerprint: &str,
    ) -> Result<FileOp> {
        let target_collection = target_collection.trim();
        let target_collection = if target_collection.is_empty() {
            collection
        } else {
            target_collection
        };
        self.ensure_target_collection(collection, target_collection)
            .await?;
        let target = self.locate_file(collection, path).await?;
        self.ensure_fingerprint(&target, fingerprint)?;
        self.reject_unsupported(&target)?;
        if !target.managed {
            return Err(KbError::InvalidInput(
                "只有上传 / 压缩包里的文件可以移动".to_owned(),
            ));
        }
        let to = join_target(target_dir, new_name.unwrap_or_else(|| file_name(path)))?;
        if target_collection == collection && to == path {
            return Err(KbError::InvalidInput("目标路径和原路径相同".to_owned()));
        }
        self.ensure_target_free(target_collection, &to).await?;
        // 跨知识库移动需要目标库自己的托管数据源;同库移动沿用原数据源。
        let (target_source, created_source) = if target_collection == collection {
            (None, false)
        } else {
            let (source, created) = self.move_source(target_collection).await?;
            (Some(source), created)
        };
        let mut op = self
            .new_op(
                collection,
                FileOpKind::MoveFile,
                1,
                (target_collection != collection).then_some(target_collection),
            )
            .await?;
        let mut moved = Vec::new();
        let result = self
            .move_single(
                collection,
                &target,
                target_collection,
                &to,
                target_source.as_ref(),
                &mut moved,
            )
            .await;
        match result {
            Ok(()) => {
                op.done = 1;
                op.state = FileOpState::Done;
                self.finish_op(op).await
            }
            Err(err) => {
                // 物理移动可能已经发生(index_new / repath 阶段才失败),单文件也必须回滚,
                // 否则用户看到「移动失败」但文件其实已经在新目录。
                let rollback = self.rollback_moves(&mut moved).await;
                if rollback.is_ok()
                    && created_source
                    && let Some(source) = target_source.as_ref()
                {
                    self.cleanup_move_source(source).await;
                }
                op.failed = 1;
                op.state = if rollback.is_ok() {
                    FileOpState::RolledBack
                } else {
                    FileOpState::Failed
                };
                op.error = Some(match rollback {
                    Ok(()) => err.to_string(),
                    Err(rollback) => format!("{err};回滚失败:{rollback}"),
                });
                self.finish_op(op).await?;
                Err(err)
            }
        }
    }

    /// 批量移动文件到同一个目录。任一文件失败会回滚已移动的部分。
    pub async fn move_files(
        &self,
        collection: &str,
        items: &[(String, String)],
        target_collection: &str,
        target_dir: &str,
    ) -> Result<FileOp> {
        if items.is_empty() {
            return Err(KbError::InvalidInput("没有选择要移动的文件".to_owned()));
        }
        if items.len() > 500 {
            return Err(KbError::InvalidInput("一次最多移动 500 个文件".to_owned()));
        }
        let target_collection = target_collection.trim();
        let target_collection = if target_collection.is_empty() {
            collection
        } else {
            target_collection
        };
        self.ensure_target_collection(collection, target_collection)
            .await?;
        let mut targets = Vec::with_capacity(items.len());
        for (path, fingerprint) in items {
            let target = self.locate_file(collection, path).await?;
            self.ensure_fingerprint(&target, fingerprint)?;
            self.reject_unsupported(&target)?;
            if !target.managed {
                return Err(KbError::InvalidInput(format!(
                    "{} 不是托管副本,不能移动",
                    target.path
                )));
            }
            targets.push(target);
        }
        let mut seen = BTreeSet::new();
        let mut plan = Vec::with_capacity(targets.len());
        for target in &targets {
            let to = join_target(target_dir, file_name(&target.path))?;
            if target_collection == collection && to == target.path {
                continue;
            }
            if !seen.insert(to.clone()) {
                return Err(KbError::InvalidInput(format!("目标路径重复:{to}")));
            }
            self.ensure_target_free(target_collection, &to).await?;
            plan.push((target.clone(), to));
        }
        if plan.is_empty() {
            return Err(KbError::InvalidInput(
                "所有文件都已经在目标目录里".to_owned(),
            ));
        }
        let (target_source, created_source) = if target_collection == collection {
            (None, false)
        } else {
            let (source, created) = self.move_source(target_collection).await?;
            (Some(source), created)
        };
        let mut op = self
            .new_op(
                collection,
                FileOpKind::MoveFiles,
                plan.len() as u64,
                (target_collection != collection).then_some(target_collection),
            )
            .await?;
        let mut moved = Vec::new();
        for (target, to) in &plan {
            match self
                .move_single(
                    collection,
                    target,
                    target_collection,
                    to,
                    target_source.as_ref(),
                    &mut moved,
                )
                .await
            {
                Ok(()) => op.done += 1,
                Err(err) => {
                    let rollback = self.rollback_moves(&mut moved).await;
                    if rollback.is_ok()
                        && created_source
                        && let Some(source) = target_source.as_ref()
                    {
                        self.cleanup_move_source(source).await;
                    }
                    op.state = if rollback.is_ok() {
                        FileOpState::RolledBack
                    } else {
                        FileOpState::Failed
                    };
                    op.error = Some(match rollback {
                        Ok(()) => err.to_string(),
                        Err(rollback) => format!("{err};回滚失败:{rollback}"),
                    });
                    self.finish_op(op).await?;
                    return Err(err);
                }
            }
        }
        op.state = FileOpState::Done;
        self.finish_op(op).await
    }

    /// 移动文件夹。同库移动要求同一个数据源;跨知识库移动会落到目标库的托管数据源。
    pub async fn move_folder(
        &self,
        collection: &str,
        path: &str,
        target_collection: &str,
        target_dir: &str,
        new_name: Option<&str>,
        fingerprint: &str,
    ) -> Result<FileOp> {
        crate::safe_path::check_rel_path(path)?;
        let target_collection = target_collection.trim();
        let target_collection = if target_collection.is_empty() {
            collection
        } else {
            target_collection
        };
        self.ensure_target_collection(collection, target_collection)
            .await?;
        let files = self.descendants(collection, path).await?;
        if files.is_empty() {
            return Err(KbError::NotFound(format!("{collection}/{path}")));
        }
        if files.len() > MAX_FOLDER_FILES {
            return Err(KbError::InvalidInput(format!(
                "这个文件夹里有 {} 个文件,超过一次 {MAX_FOLDER_FILES} 个的上限,请分批移动",
                files.len()
            )));
        }
        let targets = self.locate_folder(collection, path, &files).await?;
        self.ensure_folder_fingerprint(&targets, fingerprint)?;
        for target in &targets {
            self.reject_unsupported(target)?;
            if !target.managed {
                return Err(KbError::InvalidInput(format!(
                    "{} 不是托管副本,不能移动",
                    target.path
                )));
            }
        }
        // 必须每个文件都有数据源;filter_map 会把 None 当成“没有”静默忽略,
        // 让一个缺数据源的文件拖到 move_single 才失败,前面已经搬走的还得回滚。
        if targets.iter().any(|target| target.source_id.is_none()) {
            return Err(KbError::InvalidInput(
                "文件夹里有文件没有数据源记录,不能整体移动".to_owned(),
            ));
        }
        // 同库移动仍要求文件来自同一个数据源,否则没法推导一个物理目录;
        // 跨库移动全部落到目标库新建的托管数据源,不受源数据源数量限制。
        if target_collection == collection {
            let source_ids: BTreeSet<&str> = targets
                .iter()
                .filter_map(|target| target.source_id.as_deref())
                .collect();
            if source_ids.len() != 1 {
                return Err(KbError::InvalidInput(
                    "一个文件夹里有多个数据源的文件,不能整体移动".to_owned(),
                ));
            }
        }
        let dest_root = join_target(target_dir, new_name.unwrap_or_else(|| file_name(path)))?;
        if target_collection == collection {
            if dest_root == path {
                return Err(KbError::InvalidInput("目标路径和原路径相同".to_owned()));
            }
            if dest_root.starts_with(&format!("{path}/")) {
                return Err(KbError::InvalidInput(
                    "不能把文件夹移动到它自己里面".to_owned(),
                ));
            }
        }
        let mut plan = Vec::with_capacity(targets.len());
        for target in &targets {
            let rest = target
                .path
                .strip_prefix(path)
                .and_then(|tail| tail.strip_prefix('/'))
                .unwrap_or_else(|| file_name(&target.path));
            let to = format!("{dest_root}/{rest}");
            self.ensure_target_free(target_collection, &to).await?;
            plan.push((target.clone(), to));
        }
        let (target_source, created_source) = if target_collection == collection {
            (None, false)
        } else {
            let (source, created) = self.move_source(target_collection).await?;
            (Some(source), created)
        };
        let mut op = self
            .new_op(
                collection,
                FileOpKind::MoveFolder,
                plan.len() as u64,
                (target_collection != collection).then_some(target_collection),
            )
            .await?;
        let mut moved = Vec::new();
        for (target, to) in &plan {
            match self
                .move_single(
                    collection,
                    target,
                    target_collection,
                    to,
                    target_source.as_ref(),
                    &mut moved,
                )
                .await
            {
                Ok(()) => op.done += 1,
                Err(err) => {
                    let rollback = self.rollback_moves(&mut moved).await;
                    if rollback.is_ok()
                        && created_source
                        && let Some(source) = target_source.as_ref()
                    {
                        self.cleanup_move_source(source).await;
                    }
                    op.state = if rollback.is_ok() {
                        FileOpState::RolledBack
                    } else {
                        FileOpState::Failed
                    };
                    op.error = Some(match rollback {
                        Ok(()) => err.to_string(),
                        Err(rollback) => format!("{err};回滚失败:{rollback}"),
                    });
                    self.finish_op(op).await?;
                    return Err(err);
                }
            }
        }
        op.state = FileOpState::Done;
        self.finish_op(op).await
    }
}
