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
//! 回收站:还原、彻底删除、过期清理、列表与计数,以及按路径定位目标。

use std::collections::BTreeSet;
use std::path::Path;

use kb_core::model::{
    FileOp, FileOpKind, FileOpState, FileOrigin, FileRecord, FileTarget, Page, TrashEntry,
    TrashMode,
};
use kb_core::ports::repo::{
    AnnotationRepo, CollectionRepo, FileRepo, IngestRepo, ProjectRepo, SourceRepo, VersionRepo,
};
use kb_core::{KbError, Result};

/// 文件操作服务。
use super::*;

impl FileOpsService {
    /// 从回收站恢复一个条目。目标路径已经被占用时返回 409,不覆盖。
    pub async fn restore(&self, trash_id: &str) -> Result<FileOp> {
        let entry = self
            .meta
            .get_trash(trash_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("回收站条目 {trash_id}")))?;
        if entry.restored_at.is_some() || entry.purged_at.is_some() {
            return Err(KbError::InvalidInput(
                "这条记录已经恢复或彻底删除".to_owned(),
            ));
        }
        let collection = entry.collection.clone();
        let mut op = self
            .new_op(&collection, FileOpKind::Restore, 1, None)
            .await?;
        if FileRepo::get(self.meta.as_ref(), &collection, &entry.original_path)
            .await?
            .is_some()
        {
            op.state = FileOpState::Failed;
            op.failed = 1;
            op.error = Some("原路径已经有同名文件,请先移走它".to_owned());
            self.finish_op(op).await?;
            return Err(KbError::Conflict {
                expected: 1,
                actual: 0,
            });
        }
        let source_id = entry.source_id.clone().unwrap_or_default();
        if entry.mode == TrashMode::Unindex {
            self.meta
                .remove_path_exclusion(&collection, &source_id, &entry.original_path)
                .await?;
            if let Err(err) = self
                .repath_metadata(
                    &collection,
                    &entry.metadata_key,
                    &entry.original_path,
                    &entry.collection,
                )
                .await
            {
                let _ = self
                    .meta
                    .add_path_exclusion(&collection, &source_id, &entry.original_path, now_millis())
                    .await;
                op.state = FileOpState::Failed;
                op.failed = 1;
                op.error = Some(err.to_string());
                self.finish_op(op).await?;
                return Err(err);
            }
            // 删除时索引行已经删掉了,不能再用 locate_file 反查,必须直接从回收站条目重建。
            if let Err(err) = self.reindex_restored(&entry).await {
                let _ = self.remove_index(&collection, &entry.original_path).await;
                let _ = self
                    .repath_metadata(
                        &collection,
                        &entry.original_path,
                        &entry.metadata_key,
                        &entry.collection,
                    )
                    .await;
                let _ = self
                    .meta
                    .add_path_exclusion(&collection, &source_id, &entry.original_path, now_millis())
                    .await;
                op.state = FileOpState::Failed;
                op.failed = 1;
                op.error = Some(err.to_string());
                self.finish_op(op).await?;
                return Err(err);
            }
        } else {
            let trash_path = entry
                .trash_path
                .as_ref()
                .ok_or_else(|| KbError::Internal("回收站条目没有物理路径".to_owned()))?;
            let target = self
                .physical_original_path(&collection, &entry.original_path, &source_id)
                .await
                .ok_or_else(|| {
                    KbError::NotFound(format!("还原目标目录不存在:{}", entry.original_path))
                })?;
            if target.exists() {
                op.state = FileOpState::Failed;
                op.failed = 1;
                op.error = Some(format!("目标位置已经有同名文件:{}", target.display()));
                self.finish_op(op).await?;
                return Err(KbError::Conflict {
                    expected: 1,
                    actual: 0,
                });
            }
            move_path(Path::new(trash_path), &target).await?;
            if let Err(err) = self
                .repath_metadata(
                    &collection,
                    &entry.metadata_key,
                    &entry.original_path,
                    &collection,
                )
                .await
            {
                // 元数据没改回来就把文件搬回回收站,条目仍是可恢复状态。
                let _ = move_path(&target, Path::new(trash_path)).await;
                op.state = FileOpState::Failed;
                op.failed = 1;
                op.error = Some(err.to_string());
                self.finish_op(op).await?;
                return Err(err);
            }
            if let Err(err) = self.reindex_restored(&entry).await {
                // 索引失败时把索引、版本 / 批注和物理文件都退回回收站,
                // 别让用户看到“恢复了但搜不到”的半状态,也不能让旧文件占用原路径的元数据。
                let _ = self.remove_index(&collection, &entry.original_path).await;
                let _ = self
                    .repath_metadata(
                        &collection,
                        &entry.original_path,
                        &entry.metadata_key,
                        &collection,
                    )
                    .await;
                let _ = move_path(&target, Path::new(trash_path)).await;
                op.state = FileOpState::Failed;
                op.failed = 1;
                op.error = Some(err.to_string());
                self.finish_op(op).await?;
                return Err(err);
            }
        }
        self.meta
            .mark_trash_restored(trash_id, now_millis())
            .await?;
        op.done = 1;
        op.state = FileOpState::Done;
        self.finish_op(op).await
    }

    /// 彻底删除一个回收站条目(不可恢复)。
    pub async fn purge(&self, trash_id: &str) -> Result<FileOp> {
        let entry = self
            .meta
            .get_trash(trash_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("回收站条目 {trash_id}")))?;
        if entry.restored_at.is_some() || entry.purged_at.is_some() {
            return Err(KbError::InvalidInput(
                "这条记录已经恢复或彻底删除".to_owned(),
            ));
        }
        let mut op = self
            .new_op(&entry.collection, FileOpKind::Purge, 1, None)
            .await?;
        if let Err(err) = self.purge_entry(&entry).await {
            // 用户点「彻底删除」失败要让流水里看得到原因;条目保持可用,重试还能继续
            // (物理文件已经删掉也没关系,下次按“文件不存在”继续清元数据)。
            op.state = FileOpState::Failed;
            op.failed = 1;
            op.error = Some(err.to_string());
            self.finish_op(op).await?;
            return Err(err);
        }
        op.done = 1;
        op.state = FileOpState::Done;
        self.finish_op(op).await
    }

    /// 清理过期(30 天)的回收站条目。返回清理条数。
    pub async fn purge_expired(&self, limit: u32) -> Result<u64> {
        let expired = self.meta.list_expired_trash(now_millis(), limit).await?;
        let mut purged = 0;
        for entry in expired {
            // 单条失败不能卡住整批:一条权限 / 磁盘错误会让后面所有过期条目永远清不掉。
            // 失败只记 warn,下个夜间任务还会再试。
            match self.purge_entry(&entry).await {
                Ok(()) => purged += 1,
                Err(err) => {
                    tracing::warn!(trash_id = %entry.id, error = %err, "清理过期回收站条目失败");
                }
            }
        }
        Ok(purged)
    }

    /// 清一条回收站:物理副本 → 隐藏键元数据 → 标记已清。
    pub(crate) async fn purge_entry(&self, entry: &TrashEntry) -> Result<()> {
        if let Some(trash_path) = &entry.trash_path {
            let path = Path::new(trash_path);
            if path.exists() {
                tokio::fs::remove_file(path).await.map_err(|err| {
                    KbError::Internal(format!("删除 {} 失败: {err}", path.display()))
                })?;
            }
        }
        // 物理文件没了,还要把删除时挪到隐藏键 `trash:<id>` 的版本 / 批注 / 解析记录清掉;
        // 否则「彻底删除」只删了磁盘,评论、旧版本和解析队列还留在库里。
        self.purge_metadata(entry).await?;
        self.meta.mark_trash_purged(&entry.id, now_millis()).await?;
        // 标记成功之后再收空目录,避免清完目录但库里还是“未清”状态
        if let Some(trash_path) = &entry.trash_path {
            let path = Path::new(trash_path);
            if let Some(parent) = path.parent()
                && parent != self.paths.trash_dir()
            {
                let _ = tokio::fs::remove_dir(parent).await;
                if let Some(op_dir) = parent.parent()
                    && op_dir != self.paths.trash_dir()
                {
                    let _ = tokio::fs::remove_dir(op_dir).await;
                }
            }
        }
        Ok(())
    }

    /// 彻底删除时清掉挂在隐藏键上的版本、批注及其向量、二进制备份。
    ///
    /// 顺序:先删批注向量(失败就整条重试,物理文件已没了也不会丢数据),
    /// 再删批注行;版本行删完后再看备份文件还有没有别人引用。
    pub(crate) async fn purge_metadata(&self, entry: &TrashEntry) -> Result<()> {
        let annotations = AnnotationRepo::list_by_source(
            self.meta.as_ref(),
            &entry.collection,
            &entry.metadata_key,
            u32::MAX,
        )
        .await?;
        if !annotations.is_empty() {
            if let Some(collection) =
                CollectionRepo::get(self.meta.as_ref(), &entry.collection).await?
            {
                for chunk in annotations.chunks(500) {
                    let ids: Vec<String> = chunk.iter().map(|item| item.id.clone()).collect();
                    self.store
                        .delete_ids(&collection.active_table, &ids)
                        .await?;
                }
            }
            for annotation in &annotations {
                AnnotationRepo::delete(self.meta.as_ref(), &annotation.id).await?;
            }
        }

        // 删除时把解析队列的路径临时改到隐藏键;彻底删除要把这行一起删掉,
        // 否则 (collection, rel_path) 会留下一个指向不存在文件的幽灵记录。
        if let Some(file) =
            IngestRepo::get_by_path(self.meta.as_ref(), &entry.collection, &entry.metadata_key)
                .await?
        {
            IngestRepo::delete(self.meta.as_ref(), &file.id).await?;
        }

        let versions = VersionRepo::list_by_source(
            self.meta.as_ref(),
            &entry.collection,
            &entry.metadata_key,
            u32::MAX,
        )
        .await?;
        if versions.is_empty() {
            return Ok(());
        }
        let mut blobs = BTreeSet::new();
        for version in &versions {
            if let Some(blob) = crate::edit::binary::blob_of(&version.body) {
                blobs.insert(blob.sha256);
            }
        }
        let ids: Vec<String> = versions.into_iter().map(|version| version.id).collect();
        VersionRepo::delete_many(self.meta.as_ref(), &ids).await?;
        // 同样内容的备份可能还被别的文件引用;没人用了才删备份文件。
        for sha256 in blobs {
            if VersionRepo::count_body_containing(self.meta.as_ref(), &sha256).await? == 0 {
                let path = self
                    .paths
                    .home()
                    .join("file-versions")
                    .join(&sha256[..2])
                    .join(&sha256);
                let _ = tokio::fs::remove_file(path).await;
            }
        }
        Ok(())
    }

    /// 列回收站。
    pub async fn list_trash(
        &self,
        collection: Option<&str>,
        page: Page,
    ) -> Result<Vec<TrashEntry>> {
        self.meta.list_trash(collection, page).await
    }

    /// 回收站条目总数(前端分页显示总页数)。
    pub async fn count_trash(&self, collection: Option<&str>) -> Result<u64> {
        self.meta.count_trash(collection).await
    }

    /// 查一次操作的状态(恢复 / 回滚时前端轮询)。
    pub async fn op(&self, id: &str) -> Result<FileOp> {
        self.meta
            .get_file_op(id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("文件操作 {id}")))
    }

    // ------------------------------------------------------------------
    // 定位与校验
    // ------------------------------------------------------------------

    pub(crate) async fn locate_file(&self, collection: &str, path: &str) -> Result<FileTarget> {
        crate::safe_path::check_rel_path(path)?;
        let record = FileRepo::get(self.meta.as_ref(), collection, path)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("{collection}/{path}")))?;
        self.locate_record(&record).await
    }

    pub(crate) async fn locate_record(&self, record: &FileRecord) -> Result<FileTarget> {
        let collection = record.collection.as_str();
        let path = record.path.as_str();
        let ingest = IngestRepo::get_by_path(self.meta.as_ref(), collection, path).await?;
        let source = match ingest.as_ref().and_then(|file| file.source_id.as_deref()) {
            Some(id) => SourceRepo::get(self.meta.as_ref(), id).await?,
            None => None,
        };
        let mut target = FileTarget {
            collection: collection.to_owned(),
            path: path.to_owned(),
            origin: FileOrigin::Unknown,
            managed: false,
            source_id: None,
            abs_path: None,
            file_hash: record.file_hash.clone(),
            size: record.size,
            mtime: record.mtime,
        };
        if let (Some(file), Some(source)) = (ingest.as_ref(), source.as_ref()) {
            target.source_id = Some(source.id.clone());
            target.origin = origin_of(source.kind);
            target.managed = target.origin.is_managed();
            target.abs_path = self
                .physical_source_path(source, path)
                .or_else(|| Some(file.abs_path.clone()));
        }
        if target.origin == FileOrigin::Unknown {
            // 项目文件没有解析队列行:用 collection.project_id 找项目根,再校验真实路径还在根内。
            // 只按 `root_path` 前缀判断会把 /a/docs 和 /a/docs2 串在一起,所以必须 resolve_inside。
            let collection_record = CollectionRepo::get(self.meta.as_ref(), collection)
                .await?
                .ok_or_else(|| KbError::NotFound(format!("collection {collection}")))?;
            if let Some(project_id) = collection_record.project_id {
                for project in ProjectRepo::list(self.meta.as_ref()).await? {
                    if project.id != project_id {
                        continue;
                    }
                    target.origin = FileOrigin::Project;
                    target.source_id = Some(format!("project:{}", project.id));
                    target.abs_path =
                        crate::safe_path::resolve_inside(Path::new(&project.root_path), path)
                            .map(|path| path.to_string_lossy().into_owned());
                    break;
                }
            }
        }
        if path.split('/').any(|segment| segment == "_attachments") {
            target.origin = FileOrigin::Attachment;
            target.managed = false;
        }
        Ok(target)
    }

    pub(crate) async fn locate_folder(
        &self,
        collection: &str,
        path: &str,
        files: &[FileRecord],
    ) -> Result<Vec<FileTarget>> {
        if files.is_empty() {
            return Err(KbError::NotFound(format!("{collection}/{path}")));
        }
        let mut targets = Vec::with_capacity(files.len());
        for file in files {
            targets.push(self.locate_record(file).await?);
        }
        Ok(targets)
    }

    pub(crate) async fn descendants(
        &self,
        collection: &str,
        path: &str,
    ) -> Result<Vec<FileRecord>> {
        let prefix = format!("{path}/");
        let mut out = Vec::new();
        for file_path in self.meta.list_paths(collection).await? {
            if file_path == path {
                continue;
            }
            if file_path.starts_with(&prefix)
                && let Some(record) =
                    FileRepo::get(self.meta.as_ref(), collection, &file_path).await?
            {
                out.push(record);
            }
        }
        out.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(out)
    }

    pub(crate) fn reject_unsupported(&self, target: &FileTarget) -> Result<()> {
        match target.origin {
            FileOrigin::Note => Err(KbError::InvalidInput(
                "这是手写笔记,请用「删除条目」".to_owned(),
            )),
            FileOrigin::Attachment => Err(KbError::InvalidInput(
                "附件随父条目一起删除,不能单独操作".to_owned(),
            )),
            FileOrigin::Unknown => Err(KbError::InvalidInput(
                "无法确定这个文件的来源,不能操作".to_owned(),
            )),
            _ => Ok(()),
        }
    }

    pub(crate) fn ensure_fingerprint(&self, target: &FileTarget, expected: &str) -> Result<()> {
        let actual = self.file_fingerprint(target);
        if actual.value != expected {
            return Err(KbError::Conflict {
                expected: 1,
                actual: 0,
            });
        }
        Ok(())
    }

    pub(crate) fn ensure_folder_fingerprint(
        &self,
        targets: &[FileTarget],
        expected: &str,
    ) -> Result<()> {
        let actual = self.folder_fingerprint_targets(targets);
        if actual.value != expected {
            return Err(KbError::Conflict {
                expected: 1,
                actual: 0,
            });
        }
        Ok(())
    }
}
