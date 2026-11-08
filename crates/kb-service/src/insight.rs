//! InsightService。
//!
//! insight 的**权威数据在 SQLite**(`insights` 表);每次保存都投递一个优先级 90 的任务,
//! 由 [`InsightJobHandler`] 嵌入后写进 LanceDB(`kind = insight`,`source = insight:<id>`)。
//! 检索侧因此能像普通记录一样搜到它,而编辑 / 版本演进仍走 SQLite 的乐观锁。

use std::sync::Arc;

use async_trait::async_trait;
use kb_core::hash::{MetaHashInput, content_hash, embed_input_hash, meta_hash};
use kb_core::model::{
    Collection, DocLink, DocLinkSource, Edge, EdgeRel, Feedback, Insight, InsightKind, ItemStatus,
    Job, JobState, Millis, RecordKind, RecordRow,
};
use kb_core::ports::repo::{
    CollectionRepo, DocLinkRepo, EdgeRepo, FeedbackRepo, InsightRepo, JobRepo, MetaStore,
    ProjectRepo,
};
use kb_core::ports::{Embedder, VectorStore};
use kb_core::text::identifier_words;
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};

use crate::collections::CollectionService;
use crate::index::pipeline::lex_of;
use crate::jobs::queue::{JobQueue, NewJob, priority};
use crate::jobs::slots::{Lane, lane_of};
use crate::jobs::worker::{JobHandler, SliceProgress};

/// `save_insight` 的参数。
#[derive(Clone, Debug)]
pub struct SaveInsightRequest {
    /// 标题(一句话)。
    pub title: String,
    /// 正文(markdown)。
    pub body_md: String,
    /// 种类,默认 `note`。
    pub kind: Option<InsightKind>,
    /// 目标项目(名字或 slug);与 `global` 二选一。
    pub project: Option<String>,
    /// 直接指定 collection(Web 端新建条目时用,优先于 `project` / `global`)。
    pub collection: Option<String>,
    /// 写进 `_global`。
    pub global: bool,
    /// 标签。
    pub tags: Vec<String>,
    /// 相关文件(项目内相对路径)。
    pub related_paths: Vec<String>,
    /// 被本条取代的旧 insight id。
    pub supersedes: Option<String>,
    /// 来源:`user` / `mcp:<client>` / `agent`。
    pub created_by: String,
    /// 调用方工作目录(设计规范:显式 project > KB_PROJECT > cwd 匹配)。
    pub cwd: Option<String>,
    /// 正文引用语法不合法时直接报错(默认只记录,不拦保存)。
    pub strict_links: bool,
}

/// 保存结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaveInsightResult {
    /// 新 insight 的 id。
    pub id: String,
    /// 版本号。
    pub version: i64,
    /// 写入的 collection。
    pub collection: String,
    /// 嵌入任务 id(异步)。
    pub job_id: String,
}

/// 反馈请求。
#[derive(Clone, Debug)]
pub struct FeedbackRequest {
    /// 原始查询。
    pub query: String,
    /// 被评价的记录 id。
    pub item_id: String,
    /// 是否有用。
    pub useful: bool,
    /// 备注。
    pub note: Option<String>,
    /// 来源(`mcp` / `web` / `cli`)。
    pub source: String,
}

/// 重新索引请求。
#[derive(Clone, Debug)]
pub struct ReindexRequest {
    /// 项目名或 slug。
    pub project: String,
    /// `incremental`(默认)或 `full`。
    pub mode: Option<String>,
    /// 增量模式下的路径。
    pub paths: Vec<String>,
    /// 两阶段索引的阶段(`text` / `embed`);`None` 按配置决定。
    pub phase: Option<String>,
    /// 只做文本阶段,不自动排空向量队列。
    pub stop_after_text: bool,
}

/// Insight 服务。
pub struct InsightService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    queue: JobQueue,
    /// 与索引 / 迁移共享的写闸门。
    gate: crate::write_gate::WriteGate,
}

impl InsightService {
    /// 用注入的端口构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
    ) -> Self {
        let queue = JobQueue::new(meta.clone());
        Self {
            meta,
            store,
            embedder,
            queue,
            gate: crate::write_gate::WriteGate::new(),
        }
    }

    /// 换用与索引 / 迁移共享的写闸门(组装根注入同一个实例)。
    ///
    /// :insight 的 `update_meta` 也要持读锁,否则迁移收尾时它可能把行写进刚退役的表。
    pub fn with_write_gate(mut self, gate: crate::write_gate::WriteGate) -> Self {
        self.gate = gate;
        self
    }

    /// 保存一条 insight。
    pub async fn save(&self, request: SaveInsightRequest) -> Result<SaveInsightResult> {
        if request.title.trim().is_empty() {
            return Err(KbError::InvalidInput("title 不能为空".to_owned()));
        }
        if request.body_md.trim().is_empty() {
            return Err(KbError::InvalidInput("body 不能为空".to_owned()));
        }
        if !is_known_actor(&request.created_by) {
            return Err(KbError::InvalidInput(format!(
                "created_by 取值应为 user / mcp:<client> / agent,收到 {}",
                request.created_by
            )));
        }
        let collection = match request.collection.as_deref() {
            // 显式 collection 优先(Web 的「新建条目」直接指定它);仍要求已存在
            Some(name) => CollectionRepo::get(self.meta.as_ref(), name)
                .await?
                .ok_or_else(|| KbError::NotFound(format!("collection {name}")))?,
            None => {
                self.resolve_collection(
                    request.project.as_deref(),
                    request.global,
                    request.cwd.as_deref(),
                )
                .await?
            }
        };

        if request.strict_links {
            let links = crate::doc_links::parse_doc_links(&request.body_md, &collection.name, None);
            if let Some(link) = links.iter().find(|link| link.target_kind == "invalid") {
                return Err(KbError::InvalidInput(format!(
                    "第 {} 行的引用不能解析({}):{}",
                    link.line,
                    link.reason.as_deref().unwrap_or("语法不合法"),
                    link.href
                )));
            }
        }

        // 取代关系:先确认旧条目存在且属于同一 collection
        let previous = match request.supersedes.as_deref() {
            Some(old_id) => {
                let old = InsightRepo::get(self.meta.as_ref(), old_id)
                    .await?
                    .ok_or_else(|| KbError::NotFound(format!("insight {old_id}")))?;
                if old.collection != collection.name {
                    return Err(KbError::InvalidInput(format!(
                        "supersedes 的条目属于 {} ,与目标 collection {} 不一致",
                        old.collection, collection.name
                    )));
                }
                // 已经被别人取代的旧条目不能再被取代一次(否则演进链会分叉):
                // 要改就基于最新的那一条改。并发时的同一类竞争在下面用版本号兜底
                if old.status != ItemStatus::Active || old.superseded_by.is_some() {
                    return Err(KbError::Exists(format!(
                        "insight {old_id} 已经被 {} 取代,请重新检索后基于最新一条修订",
                        old.superseded_by.as_deref().unwrap_or("另一条经验")
                    )));
                }
                Some(old)
            }
            None => None,
        };

        let now = now_millis();
        let id = uuid::Uuid::now_v7().to_string();
        let mut insight = Insight {
            id: id.clone(),
            collection: collection.name.clone(),
            title: request.title.trim().to_owned(),
            body_md: request.body_md.clone(),
            kind: request.kind.unwrap_or(InsightKind::Note),
            tags: request.tags.clone(),
            related_paths: request.related_paths.clone(),
            status: ItemStatus::Active,
            version: 1,
            valid_from: now,
            valid_until: None,
            superseded_by: None,
            created_by: request.created_by.clone(),
            batch_id: None,
            created_at: now,
            updated_at: now,
        };
        InsightRepo::create(self.meta.as_ref(), insight.clone()).await?;
        // 链接图谱是辅助信息:失败不阻塞保存,下次编辑 / 重建时补
        if let Err(err) = refresh_note_links(self.meta.as_ref(), &insight).await {
            tracing::warn!(insight = %insight.id, error = %err, "刷新笔记链接失败");
        }

        // 取代旧条目:带版本号去占。两个客户端同时取代同一条旧经验时,只有一个占得到;
        // 输家刚建的新条目在这里撤销,调用方得到冲突,不会留下一条没人指向的有效条目。
        // (要先建新条目:旧条目的 superseded_by 是外键)
        if let Some(old) = &previous {
            let mut claimed = old.clone();
            claimed.status = ItemStatus::Superseded;
            claimed.superseded_by = Some(id.clone());
            claimed.updated_at = now;
            if let Err(err) = InsightRepo::update(self.meta.as_ref(), claimed, old.version).await {
                if let Err(undo) = InsightRepo::delete(self.meta.as_ref(), &id).await {
                    tracing::warn!(error = %undo, insight = %id, "取代失败后撤销新条目也失败了");
                }
                return Err(match err {
                    KbError::Conflict { .. } => KbError::Exists(format!(
                        "insight {} 刚刚被别人取代或修改了,请重新检索后基于最新一条修订",
                        old.id
                    )),
                    other => other,
                });
            }
        }

        // 关系:相关文件
        for path in &request.related_paths {
            EdgeRepo::add(
                self.meta.as_ref(),
                Edge {
                    src_id: id.clone(),
                    dst: format!("path:{path}"),
                    rel: EdgeRel::AboutFile,
                    created_at: now,
                },
            )
            .await?;
        }
        // 关系:取代旧条目,并把旧条目标成 superseded
        if let Some(old) = previous {
            EdgeRepo::add(
                self.meta.as_ref(),
                Edge {
                    src_id: id.clone(),
                    dst: old.id.clone(),
                    rel: EdgeRel::Supersedes,
                    created_at: now,
                },
            )
            .await?;
            // LanceDB 里的旧行也要同步状态;只有“还没嵌入过”(NotFound)可以忽略。
            // 先拿读锁再读 active 表:迁移可能刚切换了表。
            let (_guard, table) =
                crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                    .await?;
            if let Err(err) = self
                .store
                .update_meta(
                    &table,
                    &old.id,
                    kb_core::model::MetaPatch {
                        status: Some(ItemStatus::Superseded),
                        meta_hash: Some(meta_hash_for(&old, ItemStatus::Superseded)),
                        updated_at: Some(now),
                        ..kb_core::model::MetaPatch::default()
                    },
                )
                .await
                && !matches!(err, KbError::NotFound(_))
            {
                tracing::warn!(error = %err, insight = %old.id, "同步旧条目的 LanceDB 状态失败");
            }
            insight.status = ItemStatus::Active;
        }

        // 投递嵌入任务(优先级 90)
        let job = self
            .queue
            .enqueue(NewJob {
                kind: "save_insight".to_owned(),
                collection: Some(collection.name.clone()),
                priority: priority::SAVE_INSIGHT,
                payload: serde_json::json!({
                    "insight_id": id,
                    "collection": collection.name,
                }),
            })
            .await?;

        Ok(SaveInsightResult {
            id,
            version: insight.version,
            collection: collection.name,
            job_id: job.id,
        })
    }

    /// 记录一条反馈。
    pub async fn feedback(&self, request: FeedbackRequest) -> Result<i64> {
        if request.item_id.trim().is_empty() {
            return Err(KbError::InvalidInput("item_id 不能为空".to_owned()));
        }
        FeedbackRepo::record(
            self.meta.as_ref(),
            Feedback {
                id: None,
                at: now_millis(),
                query: request.query,
                item_id: request.item_id,
                useful: request.useful,
                note: request.note,
                source: request.source,
            },
        )
        .await
    }

    /// 投递重新索引任务。
    pub async fn reindex(&self, request: ReindexRequest) -> Result<String> {
        let project = ProjectRepo::get_by_name(self.meta.as_ref(), &request.project)
            .await?
            .or(ProjectRepo::get_by_name(
                self.meta.as_ref(),
                &kb_core::ids::project_slug(&request.project),
            )
            .await?)
            .ok_or_else(|| KbError::NotFound(format!("project {}", request.project)))?;
        let collection = format!("proj_{}", project.slug);
        let mode = request.mode.as_deref().unwrap_or("incremental");
        let mut new_job = match mode {
            "full" => NewJob::full_index(&project.id, &collection),
            "incremental" => NewJob::incremental_index(&project.id, &collection, &request.paths),
            other => {
                return Err(KbError::InvalidInput(format!(
                    "mode 应为 incremental 或 full,收到 {other}"
                )));
            }
        };
        if let Some(phase) = request.phase.as_deref() {
            if !matches!(phase, "text" | "embed" | "full") {
                return Err(KbError::InvalidInput(format!(
                    "phase 应为 text / embed / full,收到 {phase}"
                )));
            }
            // 手动入口:只跑文本阶段、只排空队列,或强制旧路径
            new_job.payload["phase"] = serde_json::Value::String(phase.to_owned());
        }
        if request.stop_after_text {
            new_job.payload["stop_after_text"] = serde_json::Value::Bool(true);
        }
        let job = self.queue.enqueue(new_job).await?;
        Ok(job.id)
    }

    /// 修改条目状态(SQLite + LanceDB)。
    pub async fn set_status(&self, id: &str, status: ItemStatus) -> Result<Insight> {
        let insight = InsightRepo::get(self.meta.as_ref(), id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("insight {id}")))?;
        let version = insight.version;
        let mut updated = insight.clone();
        updated.status = status;
        updated.updated_at = now_millis();
        let updated = InsightRepo::update(self.meta.as_ref(), updated, version).await?;

        if let Some(collection) =
            CollectionRepo::get(self.meta.as_ref(), &updated.collection).await?
            && let Ok((_guard, table)) =
                crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                    .await
            && let Err(err) = self
                .store
                .update_meta(
                    &table,
                    id,
                    kb_core::model::MetaPatch {
                        status: Some(status),
                        meta_hash: Some(meta_hash_for(&updated, status)),
                        updated_at: Some(updated.updated_at),
                        ..kb_core::model::MetaPatch::default()
                    },
                )
                .await
            && !matches!(err, KbError::NotFound(_))
        {
            tracing::warn!(error = %err, insight = %id, "同步 LanceDB 状态失败");
        }
        Ok(updated)
    }

    /// 用 `new_id` 取代 `old_id`。
    pub async fn supersede(&self, old_id: &str, new_id: &str) -> Result<Insight> {
        if old_id == new_id {
            return Err(KbError::InvalidInput("不能用自己取代自己".to_owned()));
        }
        let old = InsightRepo::get(self.meta.as_ref(), old_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("insight {old_id}")))?;
        let new = InsightRepo::get(self.meta.as_ref(), new_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("insight {new_id}")))?;
        if old.collection != new.collection {
            return Err(KbError::InvalidInput(
                "两条 insight 属于不同 collection".to_owned(),
            ));
        }
        EdgeRepo::add(
            self.meta.as_ref(),
            Edge {
                src_id: new_id.to_owned(),
                dst: old_id.to_owned(),
                rel: EdgeRel::Supersedes,
                created_at: now_millis(),
            },
        )
        .await?;
        self.set_status(old_id, ItemStatus::Superseded).await
    }

    /// 演进链(按 `superseded_by` 双向遍历)。
    pub async fn history(&self, id: &str) -> Result<Vec<Insight>> {
        InsightRepo::history(self.meta.as_ref(), id).await
    }

    /// 按 id 取一条。
    pub async fn get(&self, id: &str) -> Result<Insight> {
        InsightRepo::get(self.meta.as_ref(), id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("insight {id}")))
    }

    /// 作用域解析（设计规范）:显式 project > `KB_PROJECT` > cwd 匹配;`global` 直接写 `_global`。
    pub async fn resolve_collection(
        &self,
        project: Option<&str>,
        global: bool,
        cwd: Option<&str>,
    ) -> Result<Collection> {
        let collections =
            CollectionService::new(self.meta.clone(), self.store.clone(), self.embedder.clone());
        if global {
            return collections.ensure_global().await;
        }
        // 只认显式参数(守护进程不读进程环境变量，见下文)
        let explicit = project.map(str::to_owned);
        if let Some(name) = explicit {
            let project = ProjectRepo::get_by_name(self.meta.as_ref(), &name)
                .await?
                .or(ProjectRepo::get_by_name(
                    self.meta.as_ref(),
                    &kb_core::ids::project_slug(&name),
                )
                .await?)
                .ok_or_else(|| KbError::NotFound(format!("project {name}")))?;
            let collection_name = format!("proj_{}", project.slug);
            return CollectionRepo::get(self.meta.as_ref(), &collection_name)
                .await?
                .ok_or_else(|| KbError::NotFound(format!("collection {collection_name}")));
        }
        if let Some(cwd) = cwd
            && let Some(project) = ProjectRepo::match_cwd(self.meta.as_ref(), cwd).await?
        {
            let collection_name = format!("proj_{}", project.slug);
            return CollectionRepo::get(self.meta.as_ref(), &collection_name)
                .await?
                .ok_or_else(|| KbError::NotFound(format!("collection {collection_name}")));
        }
        Err(KbError::InvalidInput(
            "没有指定作用域:请传 project,或 global=true".to_owned(),
        ))
    }
}

/// `save_insight` 任务的处理。
pub struct InsightJobHandler {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    /// 与索引 / 迁移共享的写闸门。
    gate: crate::write_gate::WriteGate,
}

impl InsightJobHandler {
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
        }
    }

    /// 换用共享的写闸门。
    pub fn with_write_gate(mut self, gate: crate::write_gate::WriteGate) -> Self {
        self.gate = gate;
        self
    }
}

/// `save_insight` 任务的参数。
#[derive(Clone, Debug, Serialize, Deserialize)]
struct InsightPayload {
    insight_id: String,
    collection: String,
}

#[async_trait]
impl JobHandler for InsightJobHandler {
    /// 保存洞察是「用户点完在等结果」的活(优先级 90),走交互通道。
    fn lane(&self, job: &Job) -> Lane {
        lane_of(job.priority)
    }

    async fn run_slice(&self, job: &Job) -> Result<SliceProgress> {
        let payload: InsightPayload = serde_json::from_str(&job.payload_json)
            .map_err(|err| KbError::InvalidInput(format!("save_insight 参数非法: {err}")))?;
        let insight = InsightRepo::get(self.meta.as_ref(), &payload.insight_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("insight {}", payload.insight_id)))?;
        // 写闸门:先拿读锁,再读 active 表 —— 迁移收尾持写锁,
        // 因此这一行要么写进切换前的表(会被迁移搬走),要么写进切换后的表。
        let (_guard, table) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &payload.collection)
                .await?;

        let row = insight_row(&insight, self.embedder.id());
        let text = format!("{}\n{}", row.header, row.text);
        let vector = self.embedder.embed_documents(vec![text]).await?.pop();
        let Some(vector) = vector else {
            return Err(KbError::Internal("嵌入器没有返回向量".to_owned()));
        };
        let mut row = row;
        row.vector = Some(vector);
        self.store.upsert(&table, vec![row]).await?;
        Ok(SliceProgress {
            done: 1,
            total: Some(1),
            finished: true,
            checkpoint: None,
            errors: Vec::new(),
            rate_basis: 1,
            paused: false,
        })
    }
}

/// 把一条 insight 转成待写入 LanceDB 的记录。
pub fn insight_row(insight: &Insight, embedder_id: &str) -> RecordRow {
    let header = insight.title.clone();
    let text = insight.body_md.clone();
    let lex = lex_of(
        &header,
        &format!("{} {}", insight.body_md, identifier_words(&insight.body_md)),
    );
    RecordRow {
        id: insight.id.clone(),
        collection: insight.collection.clone(),
        kind: RecordKind::Insight,
        lang: None,
        source: format!("insight:{}", insight.id),
        start_line: None,
        end_line: None,
        symbol: None,
        title: Some(insight.title.clone()),
        text,
        header,
        lex,
        tags: insight.tags.clone(),
        status: insight.status,
        content_hash: content_hash(&insight.body_md),
        meta_hash: meta_hash_for(insight, insight.status),
        embed_input_hash: embed_input_hash(embedder_id, &insight.title, &insight.body_md),
        updated_at: insight.updated_at,
        anchor: None,
        vector: None,
    }
}

fn meta_hash_for(insight: &Insight, status: ItemStatus) -> String {
    meta_hash(&MetaHashInput {
        start_line: None,
        end_line: None,
        title: Some(&insight.title),
        tags: &insight.tags,
        status: status.as_str(),
        symbol: None,
    })
}

fn is_known_actor(created_by: &str) -> bool {
    created_by == "user" || created_by == "agent" || created_by.starts_with("mcp:")
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 把任务标成失败(能力层取消任务时用)。
pub async fn cancel_job(meta: &dyn MetaStore, job_id: &str) -> Result<Job> {
    let mut job = JobRepo::get(meta, job_id)
        .await?
        .ok_or_else(|| KbError::NotFound(format!("job {job_id}")))?;
    if job.state != JobState::Queued {
        return Err(KbError::InvalidInput(format!(
            "任务 {} 当前状态是 {},只有 queued 的任务可以取消",
            job.id,
            job.state.as_str()
        )));
    }
    job.state = JobState::Canceled;
    JobRepo::update(meta, job.clone()).await?;
    Ok(job)
}

/// 重新解析一篇笔记的引用,写入链接图谱。
///
/// 笔记的正文在 SQLite,不经过文件索引器,所以保存 / 协作落地后要单独调一次。
pub async fn refresh_note_links(meta: &dyn MetaStore, insight: &Insight) -> Result<usize> {
    let parsed = crate::doc_links::parse_doc_links(&insight.body_md, &insight.collection, None);
    let links: Vec<DocLink> = parsed
        .into_iter()
        .map(|link| DocLink {
            source_kind: "note".to_owned(),
            source_collection: insight.collection.clone(),
            source_id: insight.id.clone(),
            source_title: insight.title.clone(),
            href: link.href,
            line: link.line,
            label: link.label,
            target_kind: link.target_kind,
            target_collection: link.target_collection,
            target_id: link.target_id,
            reason: link.reason,
            indexed_at: insight.updated_at,
        })
        .collect();
    let count = links.len();
    DocLinkRepo::replace_source(
        meta,
        DocLinkSource {
            source_kind: "note".to_owned(),
            collection: insight.collection.clone(),
            id: insight.id.clone(),
            title: insight.title.clone(),
            // 笔记没有文件 mtime;用 updated_at 让调用方一眼看出解析的是哪一版
            mtime: insight.updated_at,
            indexed_at: insight.updated_at,
        },
        &links,
    )
    .await?;
    Ok(count)
}
