//! 批次撤销(`revert_batch`)。
//!
//! 能力包装层([`kb_capability::invoke::Invoker`])在每次 W/G 级调用时都会往 `changes`
//! 表里写一条占位记录(`target = "failed"` 表示失败批次),那条**不可回滚**;
//! 真正可回滚的变更由各个能力自己写,`after_json` 里带一个 `op` 字段:
//!
//! ```jsonc
//! { "op": "insight.update", "before": { /* insight 快照 */ }, "after": { /* 新快照 */ } }
//! ```
//!
//! 撤销时按 `seq` 倒序逐条取反;认不出的 `op`(例如包装层的占位)记进 `skipped`,
//! 不影响其余条目。

use std::sync::Arc;

use kb_core::filter::validate_tag_value;
use kb_core::model::Collection;
use kb_core::model::{
    Batch, Change, IngestFile, IngestState, Insight, ItemStatus, MetaPatch, Millis, RecordRow,
};
use kb_core::ports::repo::{
    AuditRepo, ChunkRepo, CollectionRepo, EdgeRepo, FileRepo, IngestRepo, InsightRepo, MetaStore,
};
use kb_core::ports::{Embedder, VectorStore};
use kb_core::{KbError, Result};
use serde::Serialize;
use serde_json::Value;

use crate::items::{find_collection_of, insight_meta_hash, row_meta_hash};
use crate::jobs::queue::{JobQueue, NewJob, priority};

/// 改了一条 insight(标题 / 正文 / 标签 / 种类 / 状态)。
pub const OP_INSIGHT_UPDATE: &str = "insight.update";
/// 新建了一条 insight。
pub const OP_INSIGHT_CREATE: &str = "insight.create";
/// 删掉了一条 insight。
pub const OP_INSIGHT_DELETE: &str = "insight.delete";
/// 改了派生条目(代码 / 文档块)的标签。
pub const OP_ITEM_TAGS: &str = "item.tags";
/// 改了条目状态。
pub const OP_ITEM_STATUS: &str = "item.status";
/// 删掉了一条非 insight 条目。
pub const OP_ITEM_DELETE: &str = "item.delete";
/// 文本类文件的一次在线编辑。
pub const OP_FILE_EDIT: &str = "file.edit";

/// 包装层写的那条占位变更(不可回滚,见 `invoke.rs` 的注释)。
const FAILED_TARGET: &str = "failed";

/// 写一条可回滚的变更。
///
/// `seq` 由仓储按批次自增,这里传 0 即可。
pub async fn record_op(
    audit: &dyn AuditRepo,
    batch_id: &str,
    target: &str,
    op: &str,
    before: Option<Value>,
    after: Option<Value>,
) -> Result<()> {
    let payload = serde_json::json!({
        "op": op,
        "before": before,
        "after": after,
    });
    audit
        .record_change(
            batch_id,
            Change {
                batch_id: batch_id.to_owned(),
                seq: 0,
                target: target.to_owned(),
                before_json: payload
                    .get("before")
                    .filter(|value| !value.is_null())
                    .map(Value::to_string),
                after_json: payload.to_string(),
            },
        )
        .await
}

/// 一条被撤销的变更。
#[derive(Clone, Debug, Serialize)]
pub struct RevertedOp {
    /// 目标 id。
    pub target: String,
    /// 撤销的操作。
    pub op: String,
}

/// 一条被跳过的变更。
#[derive(Clone, Debug, Serialize)]
pub struct SkippedOp {
    /// 目标 id。
    pub target: String,
    /// 跳过原因。
    pub reason: String,
}

/// `revert_batch` 的结果。
#[derive(Clone, Debug, Serialize)]
pub struct RevertReport {
    /// 批次 id。
    pub batch_id: String,
    /// 已撤销的变更(按撤销顺序)。
    pub reverted: Vec<RevertedOp>,
    /// 跳过的变更。
    pub skipped: Vec<SkippedOp>,
    /// 撤销时间。
    pub at: Millis,
}

/// 批次撤销服务。
pub struct RevertService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    /// 与索引 / 迁移共享的写闸门。
    gate: crate::write_gate::WriteGate,
    /// 文件编辑服务(撤销 `file.edit` 要用;没接时该类型变更会被跳过)。
    files: Option<Arc<crate::edit::FileEditService>>,
}

impl RevertService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
    ) -> Self {
        Self {
            meta,
            store,
            embedder,
            gate: crate::write_gate::WriteGate::new(),
            files: None,
        }
    }

    /// 接上文件编辑服务(撤销 `file.edit` 用)。
    pub fn with_file_edits(mut self, files: Arc<crate::edit::FileEditService>) -> Self {
        self.files = Some(files);
        self
    }

    /// 换用共享的写闸门。
    pub fn with_write_gate(mut self, gate: crate::write_gate::WriteGate) -> Self {
        self.gate = gate;
        self
    }

    /// 取一个批次。
    pub async fn batch(&self, id: &str) -> Result<Option<Batch>> {
        AuditRepo::batch(self.meta.as_ref(), id).await
    }

    /// 撤销一个批次。
    pub async fn revert(&self, batch_id: &str) -> Result<RevertReport> {
        let batch = AuditRepo::batch(self.meta.as_ref(), batch_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("batch {batch_id}")))?;
        if batch.reverted_at.is_some() {
            return Err(KbError::InvalidInput(format!(
                "批次 {batch_id} 已经在 {} 撤销过",
                batch.reverted_at.unwrap_or_default()
            )));
        }
        let changes = AuditRepo::changes(self.meta.as_ref(), batch_id).await?;
        let mut reverted = Vec::new();
        let mut skipped = Vec::new();
        // 倒序:后发生的先撤销,才能回到批次开始前的状态
        for change in changes.iter().rev() {
            if change.target == FAILED_TARGET {
                skipped.push(SkippedOp {
                    target: change.target.clone(),
                    reason: "失败批次的占位记录不可回滚".to_owned(),
                });
                continue;
            }
            let payload: Value = match serde_json::from_str(&change.after_json) {
                Ok(payload) => payload,
                Err(_) => {
                    skipped.push(SkippedOp {
                        target: change.target.clone(),
                        reason: "变更记录不是 JSON".to_owned(),
                    });
                    continue;
                }
            };
            let Some(op) = payload.get("op").and_then(Value::as_str) else {
                skipped.push(SkippedOp {
                    target: change.target.clone(),
                    reason: "没有可识别的 op(包装层的调用记录)".to_owned(),
                });
                continue;
            };
            match self.revert_one(op, &change.target, &payload).await {
                Ok(()) => reverted.push(RevertedOp {
                    target: change.target.clone(),
                    op: op.to_owned(),
                }),
                Err(KbError::InvalidInput(reason)) => skipped.push(SkippedOp {
                    target: change.target.clone(),
                    reason,
                }),
                Err(err) => return Err(err),
            }
        }
        let at = now_millis();
        AuditRepo::mark_reverted(self.meta.as_ref(), batch_id, at).await?;
        Ok(RevertReport {
            batch_id: batch_id.to_owned(),
            reverted,
            skipped,
            at,
        })
    }

    /// 撤销单条变更。
    ///
    /// 返回 [`KbError::InvalidInput`] 表示这条**跳过**(不是致命错误)。
    async fn revert_one(&self, op: &str, target: &str, payload: &Value) -> Result<()> {
        match op {
            OP_INSIGHT_UPDATE => self.revert_insight_update(target, payload).await,
            OP_INSIGHT_CREATE => self.revert_insight_create(target).await,
            OP_INSIGHT_DELETE => self.revert_insight_delete(payload).await,
            OP_ITEM_TAGS => self.revert_item_tags(target, payload).await,
            OP_ITEM_STATUS => self.revert_item_status(target, payload).await,
            OP_ITEM_DELETE => self.revert_item_delete(payload).await,
            // :一次上传的文件(含压缩包解出来的)
            crate::upload::OP_INGEST_FILE => self.revert_ingest_file(target, payload).await,
            // :文件编辑(把内容写回改动前)
            OP_FILE_EDIT => self.revert_file_edit(payload).await,
            other => Err(KbError::InvalidInput(format!("不支持的变更类型 {other}"))),
        }
    }

    /// 撤销一次文件编辑:把改动前的内容写回文件并重新索引。
    async fn revert_file_edit(&self, payload: &Value) -> Result<()> {
        let before = payload
            .get("before")
            .ok_or_else(|| KbError::InvalidInput("缺少 before 快照".to_owned()))?;
        let collection = before
            .get("collection")
            .and_then(Value::as_str)
            .ok_or_else(|| KbError::InvalidInput("缺少 collection".to_owned()))?;
        let path = before
            .get("path")
            .and_then(Value::as_str)
            .ok_or_else(|| KbError::InvalidInput("缺少 path".to_owned()))?;
        let content = before
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let Some(edits) = self.files.as_ref() else {
            return Err(KbError::InvalidInput(
                "撤销服务没有接文件编辑(缺 FileEditService)".to_owned(),
            ));
        };
        edits
            .save(crate::edit::SaveFileRequest {
                collection: collection.to_owned(),
                path: path.to_owned(),
                content: content.to_owned(),
                expected_version: None,
                author: "revert".to_owned(),
                tags: Vec::new(),
            })
            .await?;
        Ok(())
    }

    async fn revert_insight_update(&self, target: &str, payload: &Value) -> Result<()> {
        let before: Insight = parse_snapshot(payload, "before")?;
        let Some(current) = InsightRepo::get(self.meta.as_ref(), target).await? else {
            return Err(KbError::InvalidInput(format!(
                "insight {target} 已经不存在,跳过"
            )));
        };
        let mut restored = current.clone();
        restored.title = before.title;
        restored.body_md = before.body_md;
        restored.tags = before.tags;
        restored.kind = before.kind;
        restored.status = before.status;
        restored.updated_at = now_millis();
        let reembed = restored.title != current.title || restored.body_md != current.body_md;
        let restored = InsightRepo::update(self.meta.as_ref(), restored, current.version).await?;
        // collection 取自 insight 行本身:LanceDB 里的副本可能还没嵌入
        let collection = self.collection(&restored.collection).await?;
        if reembed {
            self.enqueue_insight(&restored, &collection.name).await?;
        } else {
            self.sync_meta(&collection.name, &restored).await;
        }
        Ok(())
    }

    async fn revert_insight_create(&self, target: &str) -> Result<()> {
        let Some(insight) = InsightRepo::get(self.meta.as_ref(), target).await? else {
            return Err(KbError::InvalidInput(format!(
                "insight {target} 已经不存在,跳过"
            )));
        };
        for edge in EdgeRepo::by_src(self.meta.as_ref(), target).await? {
            EdgeRepo::remove(self.meta.as_ref(), &edge.src_id, &edge.dst, edge.rel).await?;
        }
        for edge in EdgeRepo::by_dst(self.meta.as_ref(), target).await? {
            EdgeRepo::remove(self.meta.as_ref(), &edge.src_id, &edge.dst, edge.rel).await?;
        }
        InsightRepo::delete(self.meta.as_ref(), target).await?;
        let collection = self.collection(&insight.collection).await?;
        let (_guard, table) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                .await?;
        if let Err(err) = self.store.delete_ids(&table, &[insight.id]).await
            && !matches!(err, KbError::NotFound(_))
        {
            tracing::warn!(error = %err, insight = %target, "撤销新建时删除 LanceDB 副本失败");
        }
        Ok(())
    }

    async fn revert_insight_delete(&self, payload: &Value) -> Result<()> {
        let snapshot: Insight = parse_snapshot(payload, "before")?;
        if InsightRepo::get(self.meta.as_ref(), &snapshot.id)
            .await?
            .is_some()
        {
            return Err(KbError::InvalidInput(format!(
                "insight {} 已经存在,跳过",
                snapshot.id
            )));
        }
        let collection = self.collection(&snapshot.collection).await?;
        InsightRepo::create(self.meta.as_ref(), snapshot.clone()).await?;
        self.enqueue_insight(&snapshot, &collection.name).await?;
        Ok(())
    }

    async fn revert_item_tags(&self, target: &str, payload: &Value) -> Result<()> {
        let tags = tags_of(payload)?;
        let collection = self.row_collection(target).await?;
        let rows = self
            .store
            .get(
                &collection.active_table,
                std::slice::from_ref(&target.to_owned()),
            )
            .await?;
        let row = rows
            .into_iter()
            .next()
            .ok_or_else(|| KbError::InvalidInput(format!("条目 {target} 已经不存在,跳过")))?;
        let (_guard, table) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                .await?;
        self.store
            .update_meta(
                &table,
                target,
                MetaPatch {
                    tags: Some(tags.clone()),
                    meta_hash: Some(row_meta_hash(&row, &tags, row.status)),
                    updated_at: Some(now_millis()),
                    ..MetaPatch::default()
                },
            )
            .await?;
        Ok(())
    }

    async fn revert_item_status(&self, target: &str, payload: &Value) -> Result<()> {
        let before = payload
            .get("before")
            .ok_or_else(|| KbError::InvalidInput("变更记录里没有 before".to_owned()))?;
        let status = before
            .get("status")
            .and_then(Value::as_str)
            .and_then(parse_status)
            .ok_or_else(|| KbError::InvalidInput("变更记录里的状态不合法".to_owned()))?;
        if let Some(insight) = InsightRepo::get(self.meta.as_ref(), target).await? {
            let mut restored = insight.clone();
            restored.status = status;
            restored.updated_at = now_millis();
            let restored =
                InsightRepo::update(self.meta.as_ref(), restored, insight.version).await?;
            let collection = self.collection(&restored.collection).await?;
            self.sync_meta(&collection.name, &restored).await;
            return Ok(());
        }
        let collection = self.row_collection(target).await?;
        let rows = self
            .store
            .get(
                &collection.active_table,
                std::slice::from_ref(&target.to_owned()),
            )
            .await?;
        let row = rows
            .into_iter()
            .next()
            .ok_or_else(|| KbError::InvalidInput(format!("条目 {target} 已经不存在,跳过")))?;
        let (_guard, table) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                .await?;
        self.store
            .update_meta(
                &table,
                target,
                MetaPatch {
                    status: Some(status),
                    meta_hash: Some(row_meta_hash(&row, &row.tags, status)),
                    updated_at: Some(now_millis()),
                    ..MetaPatch::default()
                },
            )
            .await?;
        Ok(())
    }

    async fn revert_item_delete(&self, payload: &Value) -> Result<()> {
        let before = payload
            .get("before")
            .ok_or_else(|| KbError::InvalidInput("变更记录里没有 before".to_owned()))?;
        let name = before
            .get("collection")
            .and_then(Value::as_str)
            .ok_or_else(|| KbError::InvalidInput("变更记录里没有 collection".to_owned()))?;
        let mut row: RecordRow = serde_json::from_value(
            before
                .get("row")
                .cloned()
                .ok_or_else(|| KbError::InvalidInput("变更记录里没有 row".to_owned()))?,
        )
        .map_err(|err| KbError::InvalidInput(format!("变更记录里的 row 不合法: {err}")))?;
        let collection = self.collection(name).await?;
        // 向量没有存进变更记录,这里重新嵌入一次
        let text = format!("{}\n{}", row.header, row.text);
        let vector = self.embedder.embed_documents(vec![text]).await?.pop();
        let Some(vector) = vector else {
            return Err(KbError::Internal("嵌入器没有返回向量".to_owned()));
        };
        row.vector = Some(vector);
        let (_guard, table) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                .await?;
        self.store.upsert(&table, vec![row]).await?;
        Ok(())
    }

    /// 按名字取 collection(撤销时用)。
    async fn collection(&self, name: &str) -> Result<Collection> {
        CollectionRepo::get(self.meta.as_ref(), name)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {name}")))
    }

    /// 派生条目所在的 collection(找不到就当跳过)。
    async fn row_collection(&self, target: &str) -> Result<Collection> {
        find_collection_of(self.meta.as_ref(), self.store.as_ref(), target)
            .await
            .map_err(|_| KbError::InvalidInput(format!("条目 {target} 已经不存在,跳过")))
    }

    async fn sync_meta(&self, collection: &str, insight: &Insight) {
        let Ok((_guard, table)) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), collection).await
        else {
            tracing::warn!(collection = %collection, insight = %insight.id, "撤销时读不到 collection,跳过元数据同步");
            return;
        };
        if let Err(err) = self
            .store
            .update_meta(
                &table,
                &insight.id,
                MetaPatch {
                    title: Some(insight.title.clone()),
                    tags: Some(insight.tags.clone()),
                    status: Some(insight.status),
                    meta_hash: Some(insight_meta_hash(insight)),
                    updated_at: Some(insight.updated_at),
                    ..MetaPatch::default()
                },
            )
            .await
            && !matches!(err, KbError::NotFound(_))
        {
            tracing::warn!(error = %err, insight = %insight.id, "同步 LanceDB 元数据失败");
        }
    }

    /// 撤销一个上传 / 解析出来的文件:块、向量、`files` 行、`ingest_files` 行与磁盘字节一起清掉;
    /// 覆盖上传时把旧版本从备份还原并重新入队。
    async fn revert_ingest_file(&self, target: &str, payload: &Value) -> Result<()> {
        let after = payload.get("after").cloned().unwrap_or(Value::Null);
        let before = payload.get("before").cloned().unwrap_or(Value::Null);
        let collection = after
            .get("collection")
            .and_then(Value::as_str)
            .ok_or_else(|| KbError::InvalidInput("ingest.file 记录里没有 collection".to_owned()))?;
        let rel_path = after
            .get("rel_path")
            .and_then(Value::as_str)
            .ok_or_else(|| KbError::InvalidInput("ingest.file 记录里没有 rel_path".to_owned()))?;
        let abs_path = after
            .get("abs_path")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();

        // 1. 块 + 向量 + files 行
        remove_indexed_path(
            self.meta.as_ref(),
            self.store.as_ref(),
            &self.gate,
            collection,
            rel_path,
        )
        .await?;
        // 2. ingest_files 行
        if IngestRepo::get(self.meta.as_ref(), target).await?.is_some() {
            IngestRepo::delete(self.meta.as_ref(), target).await?;
        }
        // 3. 磁盘上的字节
        if !abs_path.is_empty() {
            let _ = std::fs::remove_file(&abs_path);
        }

        // 4. 覆盖上传:把旧版本还原回去并重新入队(块由解析任务重建)
        let backup = before
            .get("backup_path")
            .and_then(Value::as_str)
            .filter(|path| std::path::Path::new(path).is_file());
        if let Some(backup) = backup {
            let restore_to = before
                .get("abs_path")
                .and_then(Value::as_str)
                .unwrap_or(&abs_path)
                .to_owned();
            if !restore_to.is_empty() {
                std::fs::rename(backup, &restore_to).map_err(|err| {
                    KbError::Internal(format!("还原旧文件到 {restore_to} 失败: {err}"))
                })?;
                let batch_id = before
                    .get("batch_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let now = now_millis();
                let file = IngestFile {
                    id: before
                        .get("ingest_id")
                        .and_then(Value::as_str)
                        .unwrap_or(target)
                        .to_owned(),
                    batch_id: batch_id.clone(),
                    source_id: before
                        .get("source_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    upload_id: None,
                    collection: collection.to_owned(),
                    rel_path: rel_path.to_owned(),
                    abs_path: restore_to,
                    size: before.get("size").and_then(Value::as_u64).unwrap_or(0),
                    sha256: before
                        .get("sha256")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    state: IngestState::Queued,
                    error: None,
                    chunks: 0,
                    vectors: 0,
                    extract_meta: None,
                    derived_from: None,
                    elapsed_ms: None,
                    created_at: now,
                    updated_at: now,
                };
                IngestRepo::create(self.meta.as_ref(), file).await?;
                if let Some(batch_id) = batch_id {
                    let queue = JobQueue::new(self.meta.clone());
                    queue
                        .enqueue(NewJob {
                            kind: "ingest".to_owned(),
                            collection: Some(collection.to_owned()),
                            priority: priority::REVIEW_EXTRACT,
                            payload: serde_json::json!({
                                "batch_id": batch_id,
                                "collection": collection,
                            }),
                        })
                        .await?;
                }
            }
        }
        Ok(())
    }

    async fn enqueue_insight(&self, insight: &Insight, collection: &str) -> Result<String> {
        let queue = JobQueue::new(self.meta.clone());
        let job = queue
            .enqueue(NewJob {
                kind: "save_insight".to_owned(),
                collection: Some(collection.to_owned()),
                priority: priority::SAVE_INSIGHT,
                payload: serde_json::json!({
                    "insight_id": insight.id,
                    "collection": collection,
                }),
            })
            .await?;
        Ok(job.id)
    }
}

/// 取 `payload.before` 里的 insight 快照。
fn parse_snapshot<T: serde::de::DeserializeOwned>(payload: &Value, key: &str) -> Result<T> {
    serde_json::from_value(
        payload
            .get(key)
            .cloned()
            .ok_or_else(|| KbError::InvalidInput(format!("变更记录里没有 {key}")))?,
    )
    .map_err(|err| KbError::InvalidInput(format!("变更记录里的 {key} 不合法: {err}")))
}

fn tags_of(payload: &Value) -> Result<Vec<String>> {
    // `batch_tag` 记录的是 `{"tags": [...]}`;兼容直接存数组的旧格式
    let before = payload
        .get("before")
        .ok_or_else(|| KbError::Internal("变更记录缺少 before".to_owned()))?;
    let tags: Vec<String> = match before {
        Value::Array(_) => serde_json::from_value(before.clone())
            .map_err(|err| KbError::Internal(format!("变更记录里的 before 不合法: {err}")))?,
        other => {
            let tags = other
                .get("tags")
                .ok_or_else(|| KbError::Internal("变更记录里的 before 缺少 tags".to_owned()))?;
            serde_json::from_value(tags.clone()).map_err(|err| {
                KbError::Internal(format!("变更记录里的 before.tags 不合法: {err}"))
            })?
        }
    };
    for tag in &tags {
        validate_tag_value(tag)?;
    }
    Ok(tags)
}

fn parse_status(value: &str) -> Option<ItemStatus> {
    match value {
        "active" => Some(ItemStatus::Active),
        "superseded" => Some(ItemStatus::Superseded),
        "deprecated" => Some(ItemStatus::Deprecated),
        _ => None,
    }
}

/// 删除某个 collection 里某个来源路径的全部块、向量与 `files` 行。
///
/// 撤销上传批次与移除数据源共用;内部按“先拿写闸门读锁、再读 active 表”的次序写入。
pub async fn remove_indexed_path(
    meta: &dyn MetaStore,
    store: &dyn VectorStore,
    gate: &crate::write_gate::WriteGate,
    collection: &str,
    rel_path: &str,
) -> Result<usize> {
    let chunks = ChunkRepo::by_path(meta, collection, rel_path).await?;
    if chunks.is_empty() {
        FileRepo::delete(meta, collection, rel_path).await?;
        return Ok(0);
    }
    let ids: Vec<String> = chunks.iter().map(|chunk| chunk.id.clone()).collect();
    // 以块 id 为起点的关系(邮件附件 / 压缩包内文件的 `derived_from`、Markdown 副本)
    // 跟着块一起删:否则撤销批次后留下指向已删块的悬挂边
    for id in &ids {
        for edge in EdgeRepo::by_src(meta, id).await? {
            EdgeRepo::remove(meta, &edge.src_id, &edge.dst, edge.rel).await?;
        }
    }
    let (_guard, table) = crate::write_gate::lock_and_table(gate, meta, collection).await?;
    if let Err(err) = store.delete_ids(&table, &ids).await
        && !matches!(err, KbError::NotFound(_))
    {
        return Err(err);
    }
    ChunkRepo::replace_for_path(meta, collection, rel_path, Vec::new()).await?;
    FileRepo::delete(meta, collection, rel_path).await?;
    Ok(ids.len())
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
