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
//! 指纹校验、索引与元数据改写、操作记录这些支撑件。

use std::path::{Path, PathBuf};

use kb_core::hash::{embed_input_hash, xxh3_hex};
use kb_core::model::{
    Annotation, Collection, FileFingerprint, FileOp, FileOpKind, FileOpState, FileOrigin,
    FileRecord, FileTarget, RecordKind, RecordRow, ScanEntry, Source, SourceKind, SourceStatus,
    TrashEntry, TrashMode,
};
use kb_core::ports::repo::{
    AnnotationRepo, CollectionRepo, EdgeRepo, FileRepo, IngestRepo, ProjectRepo, SourceRepo,
    VersionRepo,
};
use kb_core::{KbError, Result};

use crate::index::{FileIndexSpec, pipeline};

/// 文件操作服务。
use super::*;

impl FileOpsService {
    /// 指纹 = 索引里的内容 hash + 磁盘上的 size / mtime。
    /// 只看索引就发现不了「同步还没跑、文件已经被改过」:那会把旧判断套在新内容上。
    /// 这里只 stat,不重新读文件;大文件也不会因为打开一次菜单就被完整哈希一遍。
    pub(crate) fn fingerprint_parts(target: &FileTarget) -> (u64, i64) {
        target
            .abs_path
            .as_deref()
            .and_then(|path| std::fs::metadata(path).ok())
            .map_or((target.size, target.mtime), |meta| {
                (meta.len(), crate::index::millis_of(&meta))
            })
    }

    pub(crate) fn file_fingerprint(&self, target: &FileTarget) -> FileFingerprint {
        let (size, mtime) = Self::fingerprint_parts(target);
        FileFingerprint {
            value: xxh3_hex(format!("{}\u{0}{}\u{0}{}", target.file_hash, size, mtime).as_bytes()),
            files: 1,
        }
    }

    pub(crate) fn folder_fingerprint_targets(&self, targets: &[FileTarget]) -> FileFingerprint {
        let mut text = String::new();
        for target in targets {
            let (size, mtime) = Self::fingerprint_parts(target);
            text.push_str(&target.path);
            text.push('\u{0}');
            text.push_str(&target.file_hash);
            text.push('\u{0}');
            text.push_str(&format!("{size}\u{0}{mtime}"));
            text.push('\n');
        }
        FileFingerprint {
            value: xxh3_hex(text.as_bytes()),
            files: targets.len() as u64,
        }
    }

    /// 附件 / `_attachments` 只用于回显不可操作的状态,没有按来源定位的目标,
    /// 用索引记录算一个稳定指纹即可(这些路径本来就不允许删除 / 移动)。
    pub(crate) fn folder_fingerprint(&self, files: &[FileRecord]) -> FileFingerprint {
        let mut text = String::new();
        for file in files {
            text.push_str(&file.path);
            text.push('\u{0}');
            text.push_str(&file.file_hash);
            text.push('\n');
        }
        FileFingerprint {
            value: xxh3_hex(text.as_bytes()),
            files: files.len() as u64,
        }
    }

    pub(crate) async fn ensure_target_free(&self, collection: &str, path: &str) -> Result<()> {
        crate::safe_path::check_rel_path(path)?;
        if FileRepo::get(self.meta.as_ref(), collection, path)
            .await?
            .is_some()
        {
            return Err(KbError::Exists(format!("目标位置已经有文件:{path}")));
        }
        // 解析队列的 (collection, rel_path) 有唯一约束:目标位置有一条残留的 ingest 行时,
        // 物理移动完成后才会在 repath 阶段失败。提前拦下,不把文件搬到一半再回滚。
        if IngestRepo::get_by_path(self.meta.as_ref(), collection, path)
            .await?
            .is_some()
        {
            return Err(KbError::Exists(format!("目标位置已经有解析记录:{path}")));
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // 删除
    // ------------------------------------------------------------------

    pub(crate) async fn delete_one(&self, target: &FileTarget, op_id: &str) -> Result<()> {
        let now = now_millis();
        let trash_id = format!("tr_{}", uuid::Uuid::now_v7());
        let metadata_key = format!("trash:{trash_id}");
        let mode = if target.managed {
            TrashMode::Trash
        } else {
            TrashMode::Unindex
        };
        let mut trash_path = None;
        let mut dest_path = None;
        if mode == TrashMode::Trash {
            let abs = target
                .abs_path
                .as_deref()
                .ok_or_else(|| KbError::Internal("托管副本缺少物理路径".to_owned()))?;
            let dest = self
                .paths
                .trash_dir()
                .join(op_id)
                .join(&trash_id)
                .join(file_name(&target.path));
            move_path(Path::new(abs), &dest).await?;
            trash_path = Some(dest.to_string_lossy().into_owned());
            dest_path = Some(dest);
        } else if let Some(source_id) = &target.source_id {
            self.meta
                .add_path_exclusion(&target.collection, source_id, &target.path, now)
                .await?;
        }
        let entry = TrashEntry {
            id: trash_id.clone(),
            op_id: op_id.to_owned(),
            collection: target.collection.clone(),
            original_path: target.path.clone(),
            trash_path,
            source_id: target.source_id.clone(),
            metadata_key: metadata_key.clone(),
            mode,
            size: target.size,
            created_at: now,
            expires_at: Some(now + TRASH_RETENTION_MS),
            restored_at: None,
            purged_at: None,
        };
        if let Err(err) = self.meta.add_trash(entry).await {
            // 回收站行没写进去,文件已经搬走了就必须搬回来,否则库里没有任何记录能找回它。
            if let Some(dest) = dest_path
                && let Some(abs) = target.abs_path.as_deref()
            {
                let _ = move_path(&dest, Path::new(abs)).await;
            }
            if let Some(source_id) = &target.source_id
                && mode == TrashMode::Unindex
            {
                let _ = self
                    .meta
                    .remove_path_exclusion(&target.collection, source_id, &target.path)
                    .await;
            }
            return Err(err);
        }
        let deleted = async {
            self.repath_metadata(
                &target.collection,
                &target.path,
                &metadata_key,
                &target.collection,
            )
            .await?;
            self.remove_index(&target.collection, &target.path).await?;
            Ok::<(), KbError>(())
        }
        .await;
        if let Err(err) = deleted {
            // 删除没有走完:把元数据、物理文件 / 排除标记和索引退回删除前。
            // 全部退回成功才把回收站行标记为已清,避免用户在回收站看到一条其实还活着的条目。
            let mut rolled_back = true;
            if let Err(rollback) = self
                .repath_metadata(
                    &target.collection,
                    &metadata_key,
                    &target.path,
                    &target.collection,
                )
                .await
            {
                tracing::warn!(error = %rollback, path = %target.path, "删除失败后恢复元数据失败");
                rolled_back = false;
            }
            if mode == TrashMode::Trash {
                if let (Some(dest), Some(abs)) = (dest_path.as_deref(), target.abs_path.as_deref())
                    && let Err(rollback) = move_path(dest, Path::new(abs)).await
                {
                    tracing::warn!(error = %rollback, path = %target.path, "删除失败后搬回原件失败");
                    rolled_back = false;
                }
            } else if let Some(source_id) = &target.source_id
                && let Err(rollback) = self
                    .meta
                    .remove_path_exclusion(&target.collection, source_id, &target.path)
                    .await
            {
                tracing::warn!(error = %rollback, path = %target.path, "删除失败后撤排除标记失败");
                rolled_back = false;
            }
            if let Some(abs) = target.abs_path.as_deref()
                && let Err(rollback) = self
                    .index_new(&target.collection, target, &target.path, abs)
                    .await
            {
                tracing::warn!(error = %rollback, path = %target.path, "删除失败后重建索引失败");
                rolled_back = false;
            }
            if rolled_back {
                let _ = self.meta.mark_trash_purged(&trash_id, now_millis()).await;
            }
            return Err(err);
        }
        // 删除已经完成,悬挂的入边再清理;失败只记日志,不影响“文件已删除”这个结果。
        // 放在成功之后是故意的:提前删边一旦后续步骤失败,回滚重建索引也补不回入边。
        if let Err(err) =
            EdgeRepo::remove_by_dst(self.meta.as_ref(), &format!("path:{}", target.path)).await
        {
            tracing::warn!(error = %err, path = %target.path, "删除后清理入边失败");
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // 移动
    // ------------------------------------------------------------------

    /// 跨知识库移动前确认目标 collection 存在且没有正在迁移。
    pub(crate) async fn ensure_target_collection(&self, from: &str, to: &str) -> Result<()> {
        if from == to {
            return Ok(());
        }
        let target = CollectionRepo::get(self.meta.as_ref(), to)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("目标知识库 {to}")))?;
        if target.migrating_to.is_some() {
            return Err(KbError::InvalidInput(format!(
                "目标知识库 {to} 正在迁移,暂时不能移入文件"
            )));
        }
        Ok(())
    }

    /// 目标知识库的托管数据源。一次跨库移动共用一个源,失败回滚后若目录仍为空就删掉。
    ///
    /// 为什么不用目标库里已有的上传批次:批次回滚会把 `ingest_files` 里的文件一起撤掉,
    /// 移动过来的文件必须脱离任何旧批次。名字固定为 `move:<collection>` 便于重复移动时复用。
    pub(crate) async fn move_source(&self, collection: &str) -> Result<(Source, bool)> {
        let name = format!("move:{collection}");
        if let Some(existing) = SourceRepo::get_by_name(self.meta.as_ref(), &name).await? {
            if existing.collection != collection {
                return Err(KbError::Internal(format!(
                    "移动数据源 {name} 属于 {},不能给 {collection} 使用",
                    existing.collection
                )));
            }
            if !matches!(existing.kind, SourceKind::Upload | SourceKind::Archive) {
                return Err(KbError::Internal(format!(
                    "移动数据源 {name} 的类型不是托管源"
                )));
            }
            tokio::fs::create_dir_all(self.paths.source_dir(&existing.id))
                .await
                .map_err(|err| KbError::Internal(format!("创建移动数据源目录失败: {err}")))?;
            return Ok((existing, false));
        }
        let id = uuid::Uuid::now_v7().to_string();
        let dir = self.paths.source_dir(&id);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|err| KbError::Internal(format!("创建移动数据源目录失败: {err}")))?;
        let source = Source {
            id,
            kind: SourceKind::Upload,
            name,
            uri: dir.display().to_string(),
            collection: collection.to_owned(),
            tags: Vec::new(),
            include: Vec::new(),
            exclude: Vec::new(),
            depth: 1,
            allow_hosts: Vec::new(),
            refresh_minutes: None,
            status: SourceStatus::Idle,
            last_synced_at: None,
            last_error: None,
            files: 0,
            created_at: now_millis(),
            ai_extract: false,
            extract_prompt: String::new(),
            ai_status: None,
        };
        if let Err(err) = SourceRepo::create(self.meta.as_ref(), source.clone()).await {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(err);
        }
        Ok((source, true))
    }

    /// 回滚成功且目标源是这次新建的、目录还空着时,把源和目录一起清掉。
    pub(crate) async fn cleanup_move_source(&self, source: &Source) {
        let dir = self.paths.source_dir(&source.id);
        let empty = match tokio::fs::read_dir(&dir).await {
            Ok(mut entries) => matches!(entries.next_entry().await, Ok(None)),
            Err(_) => false,
        };
        if !empty {
            return;
        }
        if let Err(err) = SourceRepo::delete(self.meta.as_ref(), &source.id).await {
            tracing::warn!(error = %err, source = %source.id, "清理空移动数据源失败");
            return;
        }
        let _ = tokio::fs::remove_dir_all(&dir).await;
    }

    /// 移动一个文件,并把版本 / 批注 / 解析队列 / 关系边 rekey。`moved` 非空时记录到里面供失败回滚。
    pub(crate) async fn move_single(
        &self,
        collection: &str,
        target: &FileTarget,
        to_collection: &str,
        to: &str,
        target_source: Option<&Source>,
        moved: &mut Vec<MovedFile>,
    ) -> Result<()> {
        let from_abs = target
            .abs_path
            .as_deref()
            .ok_or_else(|| KbError::Internal("托管副本缺少物理路径".to_owned()))?;
        let to_abs = if let Some(source) = target_source {
            if source.collection != to_collection {
                return Err(KbError::Internal(format!(
                    "移动数据源 {} 不属于目标知识库 {to_collection}",
                    source.id
                )));
            }
            self.paths.source_dir(&source.id).join(to)
        } else {
            if to_collection != collection {
                return Err(KbError::Internal("跨知识库移动缺少目标数据源".to_owned()));
            }
            self.physical_new_path(collection, target, to)
                .await?
                .map(PathBuf::from)
                .ok_or_else(|| KbError::Internal("无法推导移动后的物理路径".to_owned()))?
        };
        let to_abs = to_abs.to_string_lossy().into_owned();
        self.ensure_target_free(to_collection, to).await?;
        if Path::new(&to_abs).exists() {
            return Err(KbError::Exists(format!("目标位置已经有文件:{to_abs}")));
        }
        // 先把目标路径的解析队列占位检查一遍:ingest_files 的 (collection, rel_path) 唯一,
        // 直接 rekey 会在重复路径时失败。调用方已用 ensure_target_free 检查过 files 表。
        move_path(Path::new(from_abs), Path::new(&to_abs)).await?;
        // 从物理移动成功这一刻起就登记,后面的索引 / 元数据任何一步失败都由调用方回滚。
        // 不能等全部成功再登记:否则失败时文件已经在新位置,调用方却不知道要搬回来。
        let to_source_id = target_source
            .map(|source| source.id.clone())
            .or_else(|| target.source_id.clone());
        moved.push(MovedFile {
            target: target.clone(),
            from: target.path.clone(),
            to: to.to_owned(),
            abs_from: from_abs.to_owned(),
            abs_to: to_abs.clone(),
            from_collection: collection.to_owned(),
            to_collection: to_collection.to_owned(),
            from_source_id: target.source_id.clone(),
        });
        // 目标文件带目标数据源的标签;同库移动仍用原数据源。
        let mut new_target = target.clone();
        new_target.collection = to_collection.to_owned();
        new_target.path = to.to_owned();
        new_target.source_id = to_source_id;
        new_target.abs_path = Some(to_abs.clone());
        self.index_new(to_collection, &new_target, to, &to_abs)
            .await?;
        self.remove_index(collection, &target.path).await?;
        if to_collection == collection {
            self.repath_metadata(collection, &target.path, to, collection)
                .await?;
        } else {
            let source = target_source
                .ok_or_else(|| KbError::Internal("跨知识库移动缺少目标数据源".to_owned()))?;
            self.move_metadata_across(collection, &target.path, to_collection, to, &source.id)
                .await?;
        }
        // 关系边只有精确的 `path:` 目标,按单文件 rekey;文件夹移动由调用方逐文件走这里,
        // 所以不需要在前缀上猜 collection。
        let _ = EdgeRepo::rekey_dst(
            self.meta.as_ref(),
            &format!("path:{}", target.path),
            &format!("path:{to}"),
        )
        .await?;
        Ok(())
    }

    /// 回滚已经移动的文件:先删新索引,再搬回原位,最后按原路径重建索引。
    pub(crate) async fn rollback_moves(&self, moved: &mut Vec<MovedFile>) -> Result<()> {
        for file in moved.iter().rev() {
            let _ = self.remove_index(&file.to_collection, &file.to).await;
            if let Err(err) = move_path(Path::new(&file.abs_to), Path::new(&file.abs_from)).await {
                tracing::warn!(error = %err, from = %file.abs_to, to = %file.abs_from, "回滚移动失败");
                return Err(err);
            }
            if file.from_collection == file.to_collection {
                let _ = self
                    .repath_metadata(
                        &file.to_collection,
                        &file.to,
                        &file.from,
                        &file.to_collection,
                    )
                    .await;
            } else if let Some(source_id) = file.from_source_id.as_deref() {
                let _ = self
                    .move_metadata_across(
                        &file.to_collection,
                        &file.to,
                        &file.from_collection,
                        &file.from,
                        source_id,
                    )
                    .await;
            }
            let _ = EdgeRepo::rekey_dst(
                self.meta.as_ref(),
                &format!("path:{}", file.to),
                &format!("path:{}", file.from),
            )
            .await;
            // 用移动前保存的 target 重建,不依赖 files 行还在(旧索引可能已经被删掉一半)。
            if let Err(err) = self
                .index_new(
                    &file.from_collection,
                    &file.target,
                    &file.from,
                    &file.abs_from,
                )
                .await
            {
                tracing::warn!(error = %err, path = %file.from, "回滚后重建索引失败");
                return Err(err);
            }
        }
        moved.clear();
        Ok(())
    }

    /// 跨 collection 移动的元数据:版本 / 批注换库,解析队列换 source 与物理路径,
    /// 批注的检索行在目标库重建、旧库删掉。
    pub(crate) async fn move_metadata_across(
        &self,
        from_collection: &str,
        from: &str,
        to_collection: &str,
        to: &str,
        to_source_id: &str,
    ) -> Result<()> {
        let annotations =
            AnnotationRepo::list_by_source(self.meta.as_ref(), from_collection, from, u32::MAX)
                .await?;
        VersionRepo::move_across_collections(
            self.meta.as_ref(),
            from_collection,
            from,
            to_collection,
            to,
        )
        .await?;
        AnnotationRepo::move_across_collections(
            self.meta.as_ref(),
            from_collection,
            from,
            to_collection,
            to,
        )
        .await?;
        let source_root = self.paths.source_dir(to_source_id);
        IngestRepo::move_across_collections(
            self.meta.as_ref(),
            from_collection,
            from,
            to_collection,
            to,
            to_source_id,
            &source_root.to_string_lossy(),
            now_millis(),
        )
        .await?;
        self.reindex_moved_annotations(&annotations, from_collection, to_collection, from, to)
            .await
    }

    /// 批注正文没变,但换了知识库后检索行必须归到目标库;向量仍按目标库嵌入器重建,
    /// 不能直接复用旧库的向量(迁移中的集合可能已经换了嵌入器)。
    pub(crate) async fn reindex_moved_annotations(
        &self,
        annotations: &[Annotation],
        from_collection: &str,
        to_collection: &str,
        from: &str,
        to: &str,
    ) -> Result<()> {
        if annotations.is_empty() {
            return Ok(());
        }
        let target = CollectionRepo::get(self.meta.as_ref(), to_collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {to_collection}")))?;
        let old_table = if from_collection == to_collection {
            None
        } else {
            CollectionRepo::get(self.meta.as_ref(), from_collection)
                .await?
                .map(|collection| collection.active_table)
        };
        // 一批 100 条:批注通常不多,但一次移动整个文件夹时也不该把全部正文塞进一个请求。
        for chunk in annotations.chunks(100) {
            let mut rows = Vec::with_capacity(chunk.len());
            let mut texts = Vec::with_capacity(chunk.len());
            for annotation in chunk {
                let mut moved = annotation.clone();
                moved.collection = to_collection.to_owned();
                moved.source = replace_source_prefix(&annotation.source, from, to);
                let (row, text) = self.annotation_row(&moved, &target);
                rows.push(row);
                texts.push(text);
            }
            let vectors = self.index.embedder().embed_documents(texts).await?;
            if vectors.len() != rows.len() {
                return Err(KbError::Internal(
                    "嵌入器返回的批注向量数量不一致".to_owned(),
                ));
            }
            let rows: Vec<RecordRow> = rows
                .into_iter()
                .zip(vectors)
                .map(|(mut row, vector)| {
                    row.vector = Some(vector);
                    row
                })
                .collect();
            self.store.upsert(&target.active_table, rows).await?;
            if let Some(old_table) = &old_table {
                let ids: Vec<String> = chunk.iter().map(|item| item.id.clone()).collect();
                if let Err(err) = self.store.delete_ids(old_table, &ids).await
                    && !matches!(err, KbError::NotFound(_))
                {
                    tracing::warn!(error = %err, "删除旧库批注检索行失败");
                }
            }
        }
        Ok(())
    }

    /// 一条批注在向量库里的检索行(与 `AnnotationService` 的字段口径一致)。
    pub(crate) fn annotation_row(
        &self,
        annotation: &Annotation,
        collection: &Collection,
    ) -> (RecordRow, String) {
        let header = annotation.record_id.as_deref().map(|_| {
            format!(
                "{} · 批注 · {}",
                annotation.source,
                anchor_label(annotation)
            )
        });
        let header_text = header.as_deref().unwrap_or_default();
        let tags = vec!["批注".to_owned()];
        let text = format!("{header_text}\n{}", annotation.body);
        let row = RecordRow {
            id: annotation.id.clone(),
            collection: collection.name.clone(),
            kind: RecordKind::Insight,
            lang: None,
            source: format!("{}#annotation:{}", annotation.source, annotation.id),
            start_line: None,
            end_line: None,
            symbol: None,
            title: Some(format!("批注:{}", anchor_label(annotation))),
            text: annotation.body.clone(),
            header: header_text.to_owned(),
            lex: format!("{header_text}\n{}\n批注 annotation", annotation.body),
            tags: tags.clone(),
            status: kb_core::model::ItemStatus::Active,
            content_hash: kb_core::hash::content_hash(&annotation.body),
            meta_hash: kb_core::hash::meta_hash(&kb_core::hash::MetaHashInput {
                start_line: None,
                end_line: None,
                title: Some("批注"),
                tags: &tags,
                status: "active",
                symbol: None,
            }),
            embed_input_hash: kb_core::hash::embed_input_hash(
                self.index.embedder().id(),
                header_text,
                &annotation.body,
            ),
            updated_at: now_millis(),
            anchor: annotation.anchor.clone(),
            vector: None,
        };
        (row, text)
    }

    pub(crate) async fn index_new(
        &self,
        collection: &str,
        target: &FileTarget,
        to: &str,
        abs: &str,
    ) -> Result<()> {
        let collection_record = CollectionRepo::get(self.meta.as_ref(), collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {collection}")))?;
        let metadata = tokio::fs::metadata(abs)
            .await
            .map_err(|err| KbError::Internal(format!("读取新位置 {abs} 失败: {err}")))?;
        let abs_path = Path::new(abs);
        let entry = ScanEntry {
            path: abs_path.to_path_buf(),
            relative: to.to_owned(),
            size: metadata.len(),
            mtime: crate::index::millis_of(&metadata),
            lang: kb_index::detect_lang(abs_path).to_owned(),
            kind: kb_index::kind_of(abs_path),
        };
        let tags = match &target.source_id {
            Some(id) => SourceRepo::get(self.meta.as_ref(), id)
                .await?
                .map(|source| source.tags)
                .unwrap_or_default(),
            None => Vec::new(),
        };
        let spec = FileIndexSpec {
            source: to.to_owned(),
            kind: entry.kind,
            tags,
        };
        self.index
            .index_entry_with("", &collection_record, &entry, &spec, now_millis())
            .await?;
        Ok(())
    }

    /// 恢复时文件行已经被删掉了,不能再用 `locate_file` 反查,直接用回收站条目重建目标。
    pub(crate) async fn reindex_restored(&self, entry: &TrashEntry) -> Result<()> {
        let source_id = entry.source_id.clone().unwrap_or_default();
        let source = if source_id.is_empty() {
            None
        } else {
            SourceRepo::get(self.meta.as_ref(), &source_id).await?
        };
        let origin = source
            .as_ref()
            .map(|source| origin_of(source.kind))
            .unwrap_or(FileOrigin::Unknown);
        let abs = self
            .physical_original_path(&entry.collection, &entry.original_path, &source_id)
            .await
            .ok_or_else(|| KbError::NotFound(format!("找不到 {} 的原件", entry.original_path)))?;
        let metadata = tokio::fs::metadata(&abs)
            .await
            .map_err(|err| KbError::NotFound(format!("读取 {} 失败: {err}", abs.display())))?;
        let target = FileTarget {
            collection: entry.collection.clone(),
            path: entry.original_path.clone(),
            origin,
            managed: origin.is_managed(),
            source_id: entry.source_id.clone(),
            abs_path: Some(abs.to_string_lossy().into_owned()),
            file_hash: String::new(),
            size: metadata.len(),
            mtime: crate::index::millis_of(&metadata),
        };
        self.index_new(
            &entry.collection,
            &target,
            &entry.original_path,
            &abs.to_string_lossy(),
        )
        .await
    }

    pub(crate) async fn physical_new_path(
        &self,
        collection: &str,
        target: &FileTarget,
        to: &str,
    ) -> Result<Option<String>> {
        if let Some(source_id) = &target.source_id
            && let Some(source) = SourceRepo::get(self.meta.as_ref(), source_id).await?
        {
            let root = match source.kind {
                SourceKind::Upload | SourceKind::Archive => self.paths.source_dir(&source.id),
                SourceKind::Git | SourceKind::Web => self.paths.source_dir(&source.id),
                SourceKind::LocalDir => PathBuf::from(&source.uri),
                SourceKind::Note => return Ok(None),
            };
            return Ok(Some(root.join(to).to_string_lossy().into_owned()));
        }
        let _ = collection;
        Ok(None)
    }

    pub(crate) async fn physical_original_path(
        &self,
        collection: &str,
        path: &str,
        source_id: &str,
    ) -> Option<PathBuf> {
        if source_id.starts_with("project:") {
            let project_id = source_id.trim_start_matches("project:");
            let project = ProjectRepo::list(self.meta.as_ref())
                .await
                .ok()?
                .into_iter()
                .find(|project| project.id == project_id)?;
            return Some(Path::new(&project.root_path).join(path));
        }
        let source = SourceRepo::get(self.meta.as_ref(), source_id)
            .await
            .ok()??;
        let root = match source.kind {
            SourceKind::Upload | SourceKind::Archive | SourceKind::Git | SourceKind::Web => {
                self.paths.source_dir(&source.id)
            }
            SourceKind::LocalDir => PathBuf::from(&source.uri),
            SourceKind::Note => return None,
        };
        let _ = collection;
        Some(root.join(path))
    }

    pub(crate) fn physical_source_path(
        &self,
        source: &kb_core::model::Source,
        path: &str,
    ) -> Option<String> {
        let root = match source.kind {
            SourceKind::Upload | SourceKind::Archive | SourceKind::Git | SourceKind::Web => {
                self.paths.source_dir(&source.id)
            }
            SourceKind::LocalDir => PathBuf::from(&source.uri),
            SourceKind::Note => return None,
        };
        crate::safe_path::resolve_inside(&root, path)
            .map(|path| path.to_string_lossy().into_owned())
            .or_else(|| Some(root.join(path).to_string_lossy().into_owned()))
    }

    pub(crate) async fn remove_index(&self, collection: &str, path: &str) -> Result<usize> {
        crate::revert::remove_indexed_path(
            self.meta.as_ref(),
            self.store.as_ref(),
            &self.index.write_gate(),
            collection,
            path,
        )
        .await
    }

    // ------------------------------------------------------------------
    // 元数据
    // ------------------------------------------------------------------

    pub(crate) async fn repath_metadata(
        &self,
        collection: &str,
        from: &str,
        to: &str,
        _collection_for_versions: &str,
    ) -> Result<()> {
        // 批注的检索记录要跟着改 source/header/lex,但正文向量不重新嵌入:
        // 批注正文没有变,重新嵌入整份文件会让一次移动变成一次大索引。
        let annotations =
            AnnotationRepo::list_by_source(self.meta.as_ref(), collection, from, u32::MAX).await?;
        VersionRepo::rekey_source_prefix(self.meta.as_ref(), collection, from, to).await?;
        AnnotationRepo::rekey_source_prefix(self.meta.as_ref(), collection, from, to).await?;
        IngestRepo::repath_prefix(self.meta.as_ref(), collection, from, to).await?;
        if annotations.is_empty() {
            return Ok(());
        }
        let collection_record = CollectionRepo::get(self.meta.as_ref(), collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {collection}")))?;
        let table = collection_record.active_table;
        for annotation in annotations {
            let new_source = replace_source_prefix(&annotation.source, from, to);
            let record_source = format!("{}#annotation:{}", new_source, annotation.id);
            let header = annotation
                .record_id
                .as_deref()
                .map(|_| format!("{new_source} · 批注 · {}", anchor_label(&annotation)));
            let lex = pipeline::lex_of(header.as_deref().unwrap_or_default(), &annotation.body);
            let hash = embed_input_hash(
                &collection_record.embedder_id,
                header.as_deref().unwrap_or_default(),
                &annotation.body,
            );
            let patch = kb_core::model::MetaPatch {
                source: Some(record_source),
                header,
                lex: Some(lex),
                embed_input_hash: Some(hash),
                updated_at: Some(now_millis()),
                ..Default::default()
            };
            if let Err(err) = self.store.update_meta(&table, &annotation.id, patch).await {
                // 批注向量行不存在(旧数据 / 已清理)不算移动失败,SQLite 里的 source 已经改好。
                if !matches!(err, KbError::NotFound(_)) {
                    tracing::warn!(error = %err, annotation = %annotation.id, "批注检索记录改路径失败");
                }
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------------
    // 流水
    // ------------------------------------------------------------------

    pub(crate) async fn new_op(
        &self,
        collection: &str,
        kind: FileOpKind,
        total: u64,
        target_collection: Option<&str>,
    ) -> Result<FileOp> {
        let op = FileOp {
            id: format!("fop_{}", uuid::Uuid::now_v7()),
            collection: collection.to_owned(),
            target_collection: target_collection.map(str::to_owned),
            kind,
            state: FileOpState::Running,
            total,
            done: 0,
            failed: 0,
            error: None,
            created_at: now_millis(),
            finished_at: None,
        };
        self.meta.create_file_op(op.clone()).await?;
        Ok(op)
    }

    pub(crate) async fn finish_op(&self, mut op: FileOp) -> Result<FileOp> {
        op.finished_at = Some(now_millis());
        self.meta.update_file_op(&op).await?;
        Ok(op)
    }
}
