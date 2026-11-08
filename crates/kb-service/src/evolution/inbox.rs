//! 审核收件箱(收尾阶段):列草稿、人工通过 / 修订 / 驳回、「不再提炼」。
//!
//! 状态机在 [`crate::evolution::EvolutionService`] 里(提炼 → 审核 → 按 `review_mode` 转正或
//! 进收件箱)。这里只负责**人工那一步**:
//!
//! - `list`:按状态列草稿,顺带解析审核结论(分数 / 理由 / 重复对象)与证据,前端不用再解析 JSON;
//! - `approve`:通过(可同时改标题 / 正文 / 标签)→ 转正成 insight,整批可撤销;
//! - `reject`:`never_extract` 时写入 `evolution_exclusions`(只存指纹与向量)并清空正文。
//!
//! 硬约束:草稿本身**从不进 LanceDB**,只有转正之后的 insight 才写向量表（设计规范）。

use kb_core::model::{Draft, DraftState, InsightKind, Millis, Page};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::{
    AuditRepo, CollectionRepo, DraftRepo, EdgeRepo, EvolutionRepo, InsightRepo, MetaStore,
    ProjectRepo,
};
use kb_core::{KbError, Result};
use serde::Serialize;
use std::sync::Arc;

use crate::insight::{InsightService, SaveInsightRequest};
use crate::revert::{OP_INSIGHT_CREATE, record_op};

/// 收件箱里的一条草稿(给前端直接渲染)。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InboxItem {
    /// 草稿 id。
    pub id: String,
    /// 目标 collection。
    pub collection: String,
    /// 项目名(从 `proj_<slug>` 反查;查不到就是 `None`)。
    pub project: Option<String>,
    /// 标题。
    pub title: String,
    /// 正文。
    pub body_md: String,
    /// 种类。
    pub kind: String,
    /// 标签。
    pub tags: Vec<String>,
    /// 关联文件。
    pub related_paths: Vec<String>,
    /// 证据片段(从 `evidence_json` 里取 `quote`)。
    pub evidence: Vec<String>,
    /// 状态。
    pub state: String,
    /// 审核分数(0..1;没有审核结论就是 `None`)。
    pub score: Option<f64>,
    /// 审核结论 `approve` / `revise` / `reject`。
    pub decision: Option<String>,
    /// 审核理由。
    pub reasons: Vec<String>,
    /// 与哪条已有条目重复。
    pub duplicate_of: Option<String>,
    /// 转正后的 insight id。
    pub insight_id: Option<String>,
    /// 创建时间。
    pub created_at: Millis,
    /// 审核时间。
    pub decided_at: Option<Millis>,
}

/// 列表结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InboxPage {
    /// 本页草稿。
    pub drafts: Vec<InboxItem>,
    /// 该状态下的总数。
    pub total: u64,
    /// 各状态计数(前端做页签角标)。
    pub counts: Counts,
}

/// 各状态计数。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct Counts {
    /// 待审。
    pub pending: u64,
    /// 已通过 / 修订通过。
    pub approved: u64,
    /// 已驳回。
    pub rejected: u64,
    /// 重复。
    pub duplicate: u64,
}

/// 通过时的可选修改。
#[derive(Clone, Debug, Default)]
pub struct ApproveEdits {
    /// 新标题(空表示不改)。
    pub title: Option<String>,
    /// 新正文(空表示不改)。
    pub body_md: Option<String>,
    /// 新标签(`None` 表示不改)。
    pub tags: Option<Vec<String>>,
}

/// 通过的结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ApproveOutcome {
    /// 草稿 id。
    pub draft_id: String,
    /// 转正后的 insight id。
    pub insight_id: String,
    /// 是否改了内容(改了就是 `revised`)。
    pub revised: bool,
    /// 可撤销的批次号。
    pub batch_id: String,
}

/// 驳回的结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RejectOutcome {
    /// 草稿 id。
    pub draft_id: String,
    /// 是否写入了「不再提炼」。
    pub excluded: bool,
}

/// 抢占的有效期:超过这个时间没回写,视为上一次请求已经死了(请求取消 / 进程被杀)。
pub const CLAIM_TTL_MS: i64 = 120_000;

/// 审核收件箱服务。
pub struct DraftInbox {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn kb_core::ports::Embedder>,
}

impl DraftInbox {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn kb_core::ports::Embedder>,
    ) -> Self {
        Self {
            meta,
            store,
            embedder,
        }
    }

    /// 列出草稿(状态为空表示全部)。
    ///
    /// `approved` 在收件箱里代表“已通过”,包含 `revised`(修订后通过)—— 页签的计数也是两者之和,
    /// 只查 `approved` 会让修订通过的草稿在任何一个页签里都看不到。
    pub async fn list(&self, state: Option<DraftState>, page: Page) -> Result<InboxPage> {
        let states = states_of(state);
        let drafts = DraftRepo::list_states(self.meta.as_ref(), &states, page).await?;
        let mut items = Vec::with_capacity(drafts.len());
        for draft in drafts {
            items.push(self.to_item(draft).await?);
        }
        let counts = Counts {
            pending: DraftRepo::count_states(self.meta.as_ref(), &[DraftState::Pending]).await?,
            approved: DraftRepo::count_states(
                self.meta.as_ref(),
                &[DraftState::Approved, DraftState::Revised],
            )
            .await?,
            rejected: DraftRepo::count_states(self.meta.as_ref(), &[DraftState::Rejected]).await?,
            duplicate: DraftRepo::count_states(self.meta.as_ref(), &[DraftState::Duplicate])
                .await?,
        };
        let total = DraftRepo::count_states(self.meta.as_ref(), &states).await?;
        Ok(InboxPage {
            drafts: items,
            total,
            counts,
        })
    }

    /// 人工通过:可选改标题 / 正文 / 标签,然后转正。
    ///
    /// 流程:**抢占(claimed_at)→ 建批次 → 转正 → 回写草稿 → 记 `insight.create`**。
    /// 抢占之后的任何失败都会走同一条补偿出口:删掉刚建的 insight(连边与向量)、
    /// 释放抢占,让用户可以重试。抢占本身带过期时间,进程被杀也能自愈。
    pub async fn approve(
        &self,
        id: &str,
        edits: &ApproveEdits,
        actor: &str,
    ) -> Result<ApproveOutcome> {
        let draft = self.load(id).await?;
        if draft.insight_id.is_some() {
            return Err(KbError::InvalidInput(format!(
                "草稿 {id} 已经通过(insight {}),不能重复通过",
                draft.insight_id.as_deref().unwrap_or("—")
            )));
        }
        // 乐观锁:两个标签页同时点“通过”时只有一个能抢到。
        let claimed_at = now_millis();
        if !DraftRepo::claim(self.meta.as_ref(), id, claimed_at, CLAIM_TTL_MS).await? {
            let current = self.load(id).await?;
            return Err(KbError::InvalidInput(match current.state {
                DraftState::Rejected => format!("草稿 {id} 已驳回,不能通过;需要的话重新提炼"),
                _ if current.insight_id.is_some() => {
                    format!("草稿 {id} 已经转正,不能重复通过")
                }
                _ => format!("草稿 {id} 正在被另一个请求处理(抢占超时后可以重试)"),
            }));
        }

        match self.approve_claimed(id, &draft, edits, actor).await {
            Ok(outcome) => Ok(outcome),
            Err(err) => {
                // 统一出口:抢占一定释放,不然这条草稿会永远点不了通过
                if let Err(release_err) =
                    DraftRepo::release_claim(self.meta.as_ref(), id, claimed_at).await
                {
                    tracing::warn!(error = %release_err, draft = id, "释放审核抢占失败");
                }
                Err(err)
            }
        }
    }

    /// 抢占成功之后的那一段;出错时由 [`Self::approve`] 统一释放抢占。
    async fn approve_claimed(
        &self,
        id: &str,
        draft: &Draft,
        edits: &ApproveEdits,
        actor: &str,
    ) -> Result<ApproveOutcome> {
        let title = edits
            .title
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| draft.title.clone());
        let body = edits
            .body_md
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| draft.body_md.clone());
        // 修订判定:比较去掉首尾空白后的文本,标签按内容比较
        let tags_changed = edits.tags.as_ref().is_some_and(|tags| tags != &draft.tags);
        let revised = title.trim() != draft.title.trim()
            || body.trim() != draft.body_md.trim()
            || tags_changed;
        let mut updated = draft.clone();
        if let Some(tags) = &edits.tags {
            updated.tags = tags.clone();
        }

        let project_name = self.project_name(&draft.collection).await?;
        let insight_id = self
            .promote(&updated, &title, &body, project_name.as_deref(), actor)
            .await?;

        // 转正之后立刻开批次;开不出来就把条目删掉,不留“撤销不了的条目”。
        // 放在转正之后而不是之前:失败时不会留下空批次。
        let batch_id = uuid::Uuid::now_v7().to_string();
        if let Err(err) = AuditRepo::ensure_batch(
            self.meta.as_ref(),
            &batch_id,
            actor,
            &format!("审核通过草稿 {id}"),
        )
        .await
        {
            self.undo_insight(&draft.collection, &insight_id).await;
            return Err(err);
        }

        // 取快照要在回写之前:失败时草稿还没被改动,回滚更简单。
        // 读失败也要补偿,不然会留下“没关联、没 op”的孤儿条目
        let snapshot = match InsightRepo::get(self.meta.as_ref(), &insight_id).await {
            Ok(snapshot) => snapshot,
            Err(err) => {
                self.undo_insight(&draft.collection, &insight_id).await;
                return Err(err);
            }
        };

        // 先回写草稿(关联是权威的),再记撤销用的 op
        updated.title = title;
        updated.body_md = body;
        updated.state = if revised {
            DraftState::Revised
        } else {
            DraftState::Approved
        };
        updated.insight_id = Some(insight_id.clone());
        updated.decided_at = Some(now_millis());
        if let Err(err) = DraftRepo::update(self.meta.as_ref(), updated.clone()).await {
            self.undo_insight(&draft.collection, &insight_id).await;
            return Err(err);
        }

        if let Err(err) = record_op(
            self.meta.as_ref(),
            &batch_id,
            &insight_id,
            OP_INSIGHT_CREATE,
            None,
            snapshot.and_then(|insight| serde_json::to_value(insight).ok()),
        )
        .await
        {
            // 撤销不了就别留着。顺序很重要:**先撤草稿的关联并确认写成功,再删 insight**
            // —— 反过来一旦后面失败,会留下“草稿指向一个已删除的条目”,两边都点不动
            let mut rolled_back = updated.clone();
            rolled_back.state = draft.state; // 恢复成抢占前的状态(可能是 duplicate)
            rolled_back.title = draft.title.clone();
            rolled_back.body_md = draft.body_md.clone();
            rolled_back.tags = draft.tags.clone();
            rolled_back.insight_id = None;
            rolled_back.decided_at = draft.decided_at;
            if let Err(rollback_err) = DraftRepo::update(self.meta.as_ref(), rolled_back).await {
                tracing::warn!(error = %rollback_err, draft = id, "回滚草稿失败,条目仍然保留");
                // 两个错误都带出去:页面要能提示“条目已建、只是没有撤销记录”
                return Err(KbError::Internal(format!(
                    "撤销记录写入失败({err}),回滚草稿也失败({rollback_err});这条草稿可能已转正,请到条目列表确认"
                )));
            }
            self.undo_insight(&draft.collection, &insight_id).await;
            return Err(err);
        }

        Ok(ApproveOutcome {
            draft_id: draft.id.clone(),
            insight_id,
            revised,
            batch_id,
        })
    }

    /// 补偿:删掉刚建的 insight —— 边、SQLite 行、向量表里的副本(与撤销新建同口径)。
    async fn undo_insight(&self, collection: &str, insight_id: &str) {
        for edge in EdgeRepo::by_src(self.meta.as_ref(), insight_id)
            .await
            .unwrap_or_default()
        {
            let _ = EdgeRepo::remove(self.meta.as_ref(), &edge.src_id, &edge.dst, edge.rel).await;
        }
        for edge in EdgeRepo::by_dst(self.meta.as_ref(), insight_id)
            .await
            .unwrap_or_default()
        {
            let _ = EdgeRepo::remove(self.meta.as_ref(), &edge.src_id, &edge.dst, edge.rel).await;
        }
        if let Err(err) = InsightRepo::delete(self.meta.as_ref(), insight_id).await {
            tracing::warn!(error = %err, insight = insight_id, "补偿删除 insight 失败");
        }
        if let Ok(Some(record)) = CollectionRepo::get(self.meta.as_ref(), collection).await
            && let Err(err) = self
                .store
                .delete_ids(
                    &record.active_table,
                    std::slice::from_ref(&insight_id.to_owned()),
                )
                .await
            && !matches!(err, KbError::NotFound(_))
        {
            tracing::warn!(error = %err, insight = insight_id, "补偿删除 LanceDB 副本失败");
        }
    }

    /// 人工驳回;`never_extract` 为真时同时写入排除表(只存指纹与向量)并清空正文。
    pub async fn reject(&self, id: &str, never_extract: bool) -> Result<RejectOutcome> {
        let draft = self.load(id).await?;
        if draft.insight_id.is_some() {
            // 已经转正:驳回不会删掉那条 insight,容易让人以为“撤回了”。要走删除条目 + 撤销批次
            return Err(KbError::InvalidInput(format!(
                "草稿 {id} 已经转正(insight {}),驳回不会删掉它;请在条目列表里删除或撤销批次",
                draft.insight_id.as_deref().unwrap_or("—")
            )));
        }
        if draft.state == DraftState::Rejected && !never_extract {
            return Ok(RejectOutcome {
                draft_id: draft.id,
                excluded: false,
            });
        }
        // 与 approve 抢同一把锁:驳回也要先抢占,否则会拿旧快照把正在转正的草稿整行覆盖回去。
        // 已经是 rejected 的草稿不再抢(重复驳回 / 补记「不再提炼」是幂等的)。
        let already_rejected = draft.state == DraftState::Rejected;
        let claimed_at = now_millis();
        if !already_rejected
            && !DraftRepo::claim(self.meta.as_ref(), id, claimed_at, CLAIM_TTL_MS).await?
        {
            let current = self.load(id).await?;
            // 先看真实状态:并发驳回时后到的那个其实已经完成,提示要说得对
            return Err(KbError::InvalidInput(match current.state {
                DraftState::Rejected => format!("草稿 {id} 已经驳回"),
                _ => format!(
                    "草稿 {id} 正在被另一个请求处理(抢占超时后可以重试),当前状态 {}",
                    state_text(current.state)
                ),
            }));
        }
        let result = self.reject_claimed(draft, never_extract).await;
        if !already_rejected
            && let Err(release_err) =
                DraftRepo::release_claim(self.meta.as_ref(), id, claimed_at).await
        {
            tracing::warn!(error = %release_err, draft = id, "释放驳回的抢占失败");
        }
        result
    }

    /// 抢占之后的驳回逻辑;抢占由 [`Self::reject`] 统一释放。
    async fn reject_claimed(&self, mut draft: Draft, never_extract: bool) -> Result<RejectOutcome> {
        let now = now_millis();
        if never_extract {
            // 设计规范的隐私要求:排除表不存标题与正文,只留指纹 / 向量 / 原因
            EvolutionRepo::exclude(
                self.meta.as_ref(),
                &draft.collection,
                &draft.fingerprint,
                draft.embedding.clone(),
                draft.embedder_id.as_deref(),
                "manual:never_extract",
                now,
            )
            .await?;
            // 正文清空,草稿行留着(便于追溯“这条被否过”)
            draft.body_md = String::new();
            draft.evidence_json = "[]".to_owned();
        }
        draft.state = DraftState::Rejected;
        draft.decided_at = Some(now);
        DraftRepo::update(self.meta.as_ref(), draft.clone()).await?;
        Ok(RejectOutcome {
            draft_id: draft.id,
            excluded: never_extract,
        })
    }

    /// 取一条草稿,不存在就报错。
    async fn load(&self, id: &str) -> Result<Draft> {
        DraftRepo::get(self.meta.as_ref(), id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("draft {id}")))
    }

    /// 转正:写 insights 表 + LanceDB(与 `EvolutionService` 的转正路径一致)。
    async fn promote(
        &self,
        draft: &Draft,
        title: &str,
        body: &str,
        project_name: Option<&str>,
        actor: &str,
    ) -> Result<String> {
        let created_by = if actor.starts_with("mcp:") || actor == "agent" {
            actor.to_owned()
        } else {
            "user".to_owned()
        };
        let saved =
            InsightService::new(self.meta.clone(), self.store.clone(), self.embedder.clone())
                .save(SaveInsightRequest {
                    title: title.to_owned(),
                    body_md: body.to_owned(),
                    kind: Some(draft.kind),
                    project: project_name.map(str::to_owned),
                    global: false,
                    collection: Some(draft.collection.clone()),
                    tags: draft.tags.clone(),
                    related_paths: draft.related_paths.clone(),
                    supersedes: None,
                    created_by,
                    cwd: None,
                    strict_links: false,
                })
                .await?;
        Ok(saved.id)
    }

    /// `proj_<slug>` → 项目名(找不到就是 `None`,由 collection 兜底)。
    async fn project_name(&self, collection: &str) -> Result<Option<String>> {
        let Some(record) = CollectionRepo::get(self.meta.as_ref(), collection).await? else {
            return Ok(None);
        };
        let Some(project_id) = record.project_id.clone() else {
            return Ok(None);
        };
        Ok(ProjectRepo::get(self.meta.as_ref(), &project_id)
            .await?
            .map(|project| project.name))
    }

    /// 草稿 → 前端视图(顺带把审核 JSON 与证据摊平)。
    async fn to_item(&self, draft: Draft) -> Result<InboxItem> {
        let project = self.project_name(&draft.collection).await?;
        let (score, decision, reasons, duplicate_of) = parse_review(draft.review_json.as_deref());
        Ok(InboxItem {
            id: draft.id,
            collection: draft.collection,
            project,
            title: draft.title,
            body_md: draft.body_md,
            kind: kind_text(draft.kind).to_owned(),
            tags: draft.tags,
            related_paths: draft.related_paths,
            evidence: parse_evidence(&draft.evidence_json),
            state: state_text(draft.state).to_owned(),
            score,
            decision,
            reasons,
            duplicate_of,
            insight_id: draft.insight_id,
            created_at: draft.created_at,
            decided_at: draft.decided_at,
        })
    }
}

/// 审核结论:`review_json` 里是 `{decision, score, reasons, duplicate_of, revised}`。
///
/// 早期版本把 `score=0.86 decision=approve` 这样的短句写进同一列,解析不了就只给 `None`
/// (前端显示“无审核结论”),不猜。
fn parse_review(raw: Option<&str>) -> (Option<f64>, Option<String>, Vec<String>, Option<String>) {
    let Some(text) = raw else {
        return (None, None, Vec::new(), None);
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return (None, None, Vec::new(), None);
    };
    let score = value.get("score").and_then(serde_json::Value::as_f64);
    let decision = value
        .get("decision")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    let reasons = value
        .get("reasons")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(serde_json::Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let duplicate_of = value
        .get("duplicate_of")
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned);
    (score, decision, reasons, duplicate_of)
}

/// 证据列(`[{"quote": "…"}]`)→ 字符串数组。
fn parse_evidence(raw: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(items) = value.as_array() else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| item.get("quote").and_then(serde_json::Value::as_str))
        .map(str::to_owned)
        .collect()
}

/// 收件箱的页签状态 → 数据库里的状态集合。
///
/// `approved` 包含 `revised`(页签叫“已通过”),其余一一对应;`None` 表示全部。
fn states_of(state: Option<DraftState>) -> Vec<DraftState> {
    match state {
        None => vec![
            DraftState::Pending,
            DraftState::Approved,
            DraftState::Revised,
            DraftState::Rejected,
            DraftState::Duplicate,
        ],
        Some(DraftState::Approved) => vec![DraftState::Approved, DraftState::Revised],
        Some(other) => vec![other],
    }
}

/// 草稿状态 → 文本(与数据库里的取值一致)。
pub fn state_text(state: DraftState) -> &'static str {
    match state {
        DraftState::Pending => "pending",
        DraftState::Approved => "approved",
        DraftState::Revised => "revised",
        DraftState::Rejected => "rejected",
        DraftState::Duplicate => "duplicate",
    }
}

/// 解析前端传来的状态名。
pub fn parse_state(raw: &str) -> Result<Option<DraftState>> {
    Ok(match raw.trim() {
        "" | "all" => None,
        "pending" => Some(DraftState::Pending),
        "approved" => Some(DraftState::Approved),
        "revised" => Some(DraftState::Revised),
        "rejected" => Some(DraftState::Rejected),
        "duplicate" => Some(DraftState::Duplicate),
        other => {
            return Err(KbError::InvalidInput(format!(
                "状态取值应为 pending / approved / revised / rejected / duplicate / all,收到 {other}"
            )));
        }
    })
}

/// insight 种类 → 文本。
fn kind_text(kind: InsightKind) -> &'static str {
    kind.as_str()
}

fn now_millis() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
