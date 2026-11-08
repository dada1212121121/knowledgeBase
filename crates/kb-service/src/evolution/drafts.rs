//! 提炼草稿的状态机（设计规范）。
//!
//! 一次事件的处理顺序(与卡片一致):
//!
//! ```text
//! 项目开关 → 提炼(extract_model)→ 逐条候选:
//!   ① 指纹已在 drafts(任意状态)或排除表 → skipped_fingerprint(不建草稿、不审核)
//!   ② 向量与 rejected / duplicate 草稿或排除表 ≥ dedup_similarity → duplicate(previously_rejected),不审核
//!   ③ 向量与已有 insight ≥ dedup_similarity → duplicate,不审核
//!   → 审核(review_model)→ 按 review_mode 决定 approved(转正)/ pending(进收件箱)
//! ```
//!
//! **硬约束**:草稿只存在 `drafts` 表;只有 approved / revised 才写入 insights 与 LanceDB,
//! 因此“转正之前搜索不到”是结构性保证,而不是靠过滤。

use std::sync::Arc;

use kb_core::config::EvolutionConfig;
use kb_core::hash::candidate_fingerprint;
use kb_core::model::{
    ChatResponse, Draft, DraftState, InsightKind, Millis, RecordKind, SearchMode, StoreQuery,
    ToolSpec,
};
use kb_core::ports::repo::{CollectionRepo, DraftRepo, EvolutionRepo, MetaStore, ProjectRepo};
use kb_core::ports::{ChatModel, Embedder, VectorStore};
use kb_core::{KbError, Result};
use serde::Serialize;

use crate::evolution::extract::{self, Candidate, ExtractInput};
use crate::evolution::review::{self, Decision, DraftView, Review, SimilarItem};
use crate::insight::{InsightService, SaveInsightRequest};
use crate::llm_gate::{LlmGate, Purpose};

/// 一条候选的处理结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum CandidateOutcome {
    /// 指纹重复(已有草稿或已排除)。
    SkippedFingerprint {
        /// 指纹。
        fingerprint: String,
    },
    /// 向量重复(之前被驳回 / 排除过)。
    PreviouslyRejected {
        /// 相似度。
        similarity: f32,
        /// 与哪条草稿重复。
        with: String,
    },
    /// 与已有 insight 重复。
    Duplicate {
        /// 相似度。
        similarity: f32,
        /// 与哪条 insight 重复。
        with: String,
    },
    /// 审核通过并转正。
    Approved {
        /// 草稿 id。
        draft_id: String,
        /// 生成的 insight id。
        insight_id: String,
        /// 审核分数。
        score: f64,
    },
    /// 审核通过但等人工确认(收件箱)。
    PendingReview {
        /// 草稿 id。
        draft_id: String,
        /// 审核分数。
        score: f64,
        /// 结论(approve / revise)。
        decision: String,
    },
    /// 审核驳回。
    Rejected {
        /// 草稿 id。
        draft_id: String,
        /// 分数。
        score: f64,
        /// 理由。
        reasons: Vec<String>,
    },
}

/// 一次事件的处理结果(写进 `events.result`)。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ProcessOutcome {
    /// 是否因为项目没开 / 没授权而跳过(此时**没有调用任何 LLM**)。
    pub skipped_unauthorized: bool,
    /// 提炼出的候选数。
    pub candidates: usize,
    /// 每条候选的结果。
    pub outcomes: Vec<CandidateOutcome>,
    /// 调了几次审核模型。
    pub review_calls: usize,
}

impl ProcessOutcome {
    /// 转成 `events.result` 的文本。
    pub fn to_result_text(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_owned())
    }

    /// 是否命中过指纹。
    pub fn has_skipped_fingerprint(&self) -> bool {
        self.outcomes
            .iter()
            .any(|outcome| matches!(outcome, CandidateOutcome::SkippedFingerprint { .. }))
    }
}

/// 提炼服务。
pub struct EvolutionService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    gate: LlmGate,
    extract_model: Arc<dyn ChatModel>,
    review_model: Arc<dyn ChatModel>,
    config: EvolutionConfig,
    /// 声明式 skills:`type = "prompt"` 的 skill 覆盖提炼 / 审核提示词。
    skills: Option<Arc<crate::skills::SkillRegistry>>,
}

impl EvolutionService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
        gate: LlmGate,
        extract_model: Arc<dyn ChatModel>,
        review_model: Arc<dyn ChatModel>,
        config: EvolutionConfig,
    ) -> Self {
        Self {
            meta,
            store,
            embedder,
            gate,
            extract_model,
            review_model,
            config,
            skills: None,
        }
    }

    /// 挂上声明式 skills:`type = "prompt"` 的 skill 覆盖提炼 / 审核提示词。
    pub fn with_skills(mut self, skills: Arc<crate::skills::SkillRegistry>) -> Self {
        self.skills = Some(skills);
        self
    }

    /// 某个阶段的提示词覆盖;没有 skill 时返回 `None`(调用方用编进二进制的默认模板)。
    fn prompt(&self, stage: crate::skills::PromptStage) -> Option<&str> {
        self.skills.as_ref().and_then(|skills| skills.prompt(stage))
    }

    /// 处理一次事件。
    pub async fn process(
        &self,
        project_id: &str,
        event_kind: &str,
        content: &str,
    ) -> Result<ProcessOutcome> {
        let project = ProjectRepo::get(self.meta.as_ref(), project_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("project {project_id}")))?;
        // 触发条件:extract_enabled 与 allow_cloud_llm 同时满足,否则一次 LLM 都不调
        if !project.extract_enabled || !project.allow_cloud_llm {
            return Ok(ProcessOutcome {
                skipped_unauthorized: true,
                ..ProcessOutcome::default()
            });
        }
        // 项目对应 collection 的命名规则与 ProjectService 一致:proj_<slug>
        let collection = format!("proj_{}", project.slug);
        let input = ExtractInput {
            project: project.name.clone(),
            event_kind: event_kind.to_owned(),
            content: content.to_owned(),
            model: extract_model_name(&self.extract_model),
        };
        let request =
            extract::build_request(&input, self.prompt(crate::skills::PromptStage::Extract));
        let response = self
            .gate
            .send(
                Some(project_id),
                Purpose::Extract,
                &self.extract_model,
                request,
            )
            .await?;
        let candidates = extract::parse_candidates(response_text(&response))?;

        let mut outcome = ProcessOutcome {
            candidates: candidates.len(),
            ..ProcessOutcome::default()
        };
        for candidate in &candidates {
            let result = self
                .handle_candidate(&collection, candidate, &project.name)
                .await?;
            if let CandidateOutcome::PendingReview { .. }
            | CandidateOutcome::Approved { .. }
            | CandidateOutcome::Rejected { .. } = result
            {
                outcome.review_calls += 1;
            }
            outcome.outcomes.push(result);
        }
        Ok(outcome)
    }

    /// 把一条**外部产生**的候选(例如 主题归纳的结果)送进同一套状态机。
    ///
    /// 与 [`Self::process`] 的区别:不提炼(候选已经由调用方生成),其余步骤完全一致
    /// —— 指纹 → 与驳回 / 排除过的向量比较 → 与已有 insight 去重 → 审核 → 按 `review_mode`
    /// 转正或进收件箱。项目开关由调用方决定(归纳是用户主动触发的,不受 `extract_enabled` 限制),
    /// 但外发仍受 `allow_cloud_llm` 约束(闸门在审核调用时判定)。
    pub async fn ingest_candidate(
        &self,
        project_id: &str,
        candidate: &Candidate,
    ) -> Result<CandidateOutcome> {
        let project = ProjectRepo::get(self.meta.as_ref(), project_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("project {project_id}")))?;
        let collection = format!("proj_{}", project.slug);
        self.handle_candidate(&collection, candidate, &project.name)
            .await
    }

    /// 单条候选:指纹 → 向量去重 → 审核 → 落库。
    async fn handle_candidate(
        &self,
        collection: &str,
        candidate: &Candidate,
        project_name: &str,
    ) -> Result<CandidateOutcome> {
        let fingerprint = candidate_fingerprint(
            candidate.kind.as_str(),
            &candidate.title,
            &candidate.related_paths,
        );
        // ① 指纹
        if EvolutionRepo::draft_exists(self.meta.as_ref(), collection, &fingerprint).await?
            || EvolutionRepo::is_excluded(self.meta.as_ref(), collection, &fingerprint).await?
        {
            return Ok(CandidateOutcome::SkippedFingerprint { fingerprint });
        }

        // 候选向量:算一次,后面去重与审核都用它
        let vector = self
            .embedder
            .embed_documents(vec![format!("{}\n{}", candidate.title, candidate.body_md)])
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| KbError::Internal("嵌入器没有返回向量".to_owned()))?;
        let embedder_id = self.embedder.id().to_owned();

        // ② 之前驳回 / 排除过的
        let excluded =
            EvolutionRepo::excluded_vectors(self.meta.as_ref(), collection, &embedder_id, 500)
                .await?;
        let rejected = EvolutionRepo::draft_vectors(
            self.meta.as_ref(),
            collection,
            &embedder_id,
            &[DraftState::Rejected, DraftState::Duplicate],
            500,
        )
        .await?;
        for (id, other) in rejected.iter().chain(excluded.iter()) {
            let similarity = cosine(&vector, other);
            if similarity as f64 >= self.config.dedup_similarity {
                let draft = self
                    .store_draft(
                        collection,
                        candidate,
                        &fingerprint,
                        Some(vector.clone()),
                        Some(embedder_id.clone()),
                        DraftState::Duplicate,
                        Some(format!("previously_rejected:{id}")),
                        None,
                    )
                    .await?;
                return Ok(CandidateOutcome::PreviouslyRejected {
                    similarity,
                    with: draft.id,
                });
            }
        }

        // ③ 与已有 insight 重复
        if let Some((id, similarity)) = self.nearest_insight(collection, &vector).await? {
            let draft = self
                .store_draft(
                    collection,
                    candidate,
                    &fingerprint,
                    Some(vector.clone()),
                    Some(embedder_id.clone()),
                    DraftState::Duplicate,
                    Some(format!("duplicate_of:{id}")),
                    None,
                )
                .await?;
            let _ = draft;
            return Ok(CandidateOutcome::Duplicate {
                similarity,
                with: id,
            });
        }

        // 审核:带上最相似的 3 条已有 insight
        let similar = self.similar_insights(collection, &vector, 3).await?;
        let request = review::build_request(
            &review_model_name(&self.review_model),
            &DraftView {
                title: candidate.title.clone(),
                body_md: candidate.body_md.clone(),
                kind: candidate.kind.as_str().to_owned(),
                evidence: candidate.evidence.clone(),
            },
            &similar,
            self.prompt(crate::skills::PromptStage::Review),
        );
        let response = self
            .gate
            .send(None, Purpose::Review, &self.review_model, request)
            .await?;
        let review = review::parse_review(response_text(&response))?;
        let review_json = serde_json::to_string(&review_json_of(&review)).ok();

        // 判定
        let pass =
            review.decision != Decision::Reject && review.score >= self.config.approve_threshold;
        let (state, title, body) = match (pass, review.decision) {
            (true, Decision::Revise) => (
                DraftState::Revised,
                review
                    .revised
                    .as_ref()
                    .map(|(title, _)| title.clone())
                    .unwrap_or_else(|| candidate.title.clone()),
                review
                    .revised
                    .as_ref()
                    .map(|(_, body)| body.clone())
                    .unwrap_or_else(|| candidate.body_md.clone()),
            ),
            (true, _) => (
                DraftState::Approved,
                candidate.title.clone(),
                candidate.body_md.clone(),
            ),
            (false, _) => (
                DraftState::Rejected,
                candidate.title.clone(),
                candidate.body_md.clone(),
            ),
        };
        // 落库状态要按 `review_mode` 决定:除 `ai` 之外的两种模式都必须**留在收件箱**,
        // 不能把“AI 建议通过”直接写成 approved —— 否则收件箱(按 pending 过滤)看不到它,
        // Dashboard 的“待审草稿”也永远是 0。AI 的结论仍然写进 `review_json`,供人工参考。
        let persisted = match state {
            DraftState::Approved | DraftState::Revised if self.config.review_mode != "ai" => {
                DraftState::Pending
            }
            other => other,
        };
        let draft = self
            .store_draft(
                collection,
                &Candidate {
                    title: title.clone(),
                    body_md: body.clone(),
                    ..candidate.clone()
                },
                &fingerprint,
                Some(vector),
                Some(embedder_id),
                persisted,
                Some(format!(
                    "score={:.2} decision={}",
                    review.score,
                    review.decision.as_str()
                )),
                review_json,
            )
            .await?;

        match state {
            DraftState::Rejected => Ok(CandidateOutcome::Rejected {
                draft_id: draft.id,
                score: review.score,
                reasons: review.reasons.clone(),
            }),
            DraftState::Approved | DraftState::Revised => {
                if self.config.review_mode == "ai" {
                    // 转正失败时把草稿放回收件箱:否则会留下“approved 但没有 insight_id”的行,
                    // 页面上没人能处理
                    let insight_id = match self.promote(&draft, &title, &body, project_name).await {
                        Ok(insight_id) => insight_id,
                        Err(err) => {
                            let mut fallback = draft.clone();
                            fallback.state = DraftState::Pending;
                            fallback.decided_at = None;
                            if let Err(update_err) =
                                DraftRepo::update(self.meta.as_ref(), fallback).await
                            {
                                tracing::warn!(error = %update_err, draft = %draft.id, "转正失败后放回收件箱失败");
                            }
                            return Err(err);
                        }
                    };
                    Ok(CandidateOutcome::Approved {
                        draft_id: draft.id,
                        insight_id,
                        score: review.score,
                    })
                } else {
                    Ok(CandidateOutcome::PendingReview {
                        draft_id: draft.id,
                        score: review.score,
                        decision: review.decision.as_str().to_owned(),
                    })
                }
            }
            _ => Ok(CandidateOutcome::PendingReview {
                draft_id: draft.id,
                score: review.score,
                decision: review.decision.as_str().to_owned(),
            }),
        }
    }

    /// 写一条草稿(只写 `drafts`,不进 LanceDB)。
    #[allow(clippy::too_many_arguments)]
    async fn store_draft(
        &self,
        collection: &str,
        candidate: &Candidate,
        fingerprint: &str,
        embedding: Option<Vec<f32>>,
        embedder_id: Option<String>,
        state: DraftState,
        review_note: Option<String>,
        review_json: Option<String>,
    ) -> Result<Draft> {
        let now = now_millis();
        let draft = Draft {
            id: uuid::Uuid::now_v7().to_string(),
            collection: collection.to_owned(),
            title: candidate.title.clone(),
            body_md: candidate.body_md.clone(),
            kind: candidate.kind,
            tags: candidate.tags.clone(),
            evidence_json: serde_json::json!([{ "quote": candidate.evidence }]).to_string(),
            related_paths: candidate.related_paths.clone(),
            extractor_id: "llm:extract".to_owned(),
            event_id: None,
            state,
            review_json: review_json.or(review_note),
            insight_id: None,
            fingerprint: fingerprint.to_owned(),
            embedding,
            embedder_id,
            created_at: now,
            decided_at: if state == DraftState::Pending {
                None
            } else {
                Some(now)
            },
        };
        DraftRepo::create(self.meta.as_ref(), draft.clone()).await?;
        Ok(draft)
    }

    /// 把草稿转正成 insight(写入 insights 表 + LanceDB)。
    async fn promote(
        &self,
        draft: &Draft,
        title: &str,
        body: &str,
        project_name: &str,
    ) -> Result<String> {
        let saved =
            InsightService::new(self.meta.clone(), self.store.clone(), self.embedder.clone())
                .save(SaveInsightRequest {
                    title: title.to_owned(),
                    body_md: body.to_owned(),
                    kind: Some(draft.kind),
                    project: Some(project_name.to_owned()),
                    global: false,
                    collection: Some(draft.collection.clone()),
                    tags: draft.tags.clone(),
                    // 收尾(迁移 0008):转正时带上候选的关联文件,不再丢
                    related_paths: draft.related_paths.clone(),
                    supersedes: None,
                    created_by: "agent".to_owned(),
                    cwd: None,
                    strict_links: false,
                })
                .await?;
        let mut updated = draft.clone();
        updated.insight_id = Some(saved.id.clone());
        DraftRepo::update(self.meta.as_ref(), updated).await?;
        Ok(saved.id)
    }

    /// 最相似的 insight(≥ dedup_similarity 才算)。
    async fn nearest_insight(
        &self,
        collection: &str,
        vector: &[f32],
    ) -> Result<Option<(String, f32)>> {
        let Some(record) = CollectionRepo::get(self.meta.as_ref(), collection).await? else {
            return Ok(None);
        };
        let hits = self
            .store
            .search(
                &record.active_table,
                &StoreQuery {
                    mode: SearchMode::Vector,
                    text: None,
                    vector: Some(vector.to_vec()),
                    filter: kb_core::filter::Filter {
                        kinds: vec![RecordKind::Insight],
                        ..Default::default()
                    },
                    limit: 1,
                    offset: 0,
                    with_vector: false,
                },
            )
            .await?;
        let Some(hit) = hits.first() else {
            return Ok(None);
        };
        let similarity = 1.0 - hit.score;
        if (similarity as f64) >= self.config.dedup_similarity {
            Ok(Some((hit.row.id.clone(), similarity)))
        } else {
            Ok(None)
        }
    }

    /// 给审核模型参考的相似 insight。
    async fn similar_insights(
        &self,
        collection: &str,
        vector: &[f32],
        limit: usize,
    ) -> Result<Vec<SimilarItem>> {
        let Some(record) = CollectionRepo::get(self.meta.as_ref(), collection).await? else {
            return Ok(Vec::new());
        };
        let hits = self
            .store
            .search(
                &record.active_table,
                &StoreQuery {
                    mode: SearchMode::Vector,
                    text: None,
                    vector: Some(vector.to_vec()),
                    filter: kb_core::filter::Filter {
                        kinds: vec![RecordKind::Insight],
                        ..Default::default()
                    },
                    limit,
                    offset: 0,
                    with_vector: false,
                },
            )
            .await?;
        Ok(hits
            .into_iter()
            .map(|hit| SimilarItem {
                id: hit.row.id,
                title: hit.row.title.unwrap_or_default(),
                snippet: hit.row.text.chars().take(120).collect(),
            })
            .collect())
    }
}

/// 余弦相似度(向量已归一化时等于点积,这里仍按定义算,容错)。
pub fn cosine(left: &[f32], right: &[f32]) -> f32 {
    if left.len() != right.len() || left.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut left_norm = 0.0f32;
    let mut right_norm = 0.0f32;
    for (a, b) in left.iter().zip(right.iter()) {
        dot += a * b;
        left_norm += a * a;
        right_norm += b * b;
    }
    if left_norm == 0.0 || right_norm == 0.0 {
        return 0.0;
    }
    dot / (left_norm.sqrt() * right_norm.sqrt())
}

/// 响应文本(没有内容时按空串处理)。
fn response_text(response: &ChatResponse) -> &str {
    response.message.content.as_deref().unwrap_or("")
}

/// 提炼模型名(提示词里不强制,这里只用于日志 / 请求)。
fn extract_model_name(model: &Arc<dyn ChatModel>) -> String {
    model.id().to_owned()
}

/// 审核模型名。
fn review_model_name(model: &Arc<dyn ChatModel>) -> String {
    model.id().to_owned()
}

/// 审核结果 → JSON(存进 `drafts.review_json`)。
fn review_json_of(review: &Review) -> serde_json::Value {
    serde_json::json!({
        "decision": review.decision.as_str(),
        "score": review.score,
        "reasons": review.reasons,
        "duplicate_of": review.duplicate_of,
        "revised": review.revised.as_ref().map(|(title, body)| serde_json::json!({
            "title": title,
            "body_md": body,
        })),
    })
}

fn now_millis() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 候选的种类(给外部构造测试数据用)。
pub fn kind_of(name: &str) -> InsightKind {
    match name {
        "pitfall" => InsightKind::Pitfall,
        "howto" => InsightKind::Howto,
        "convention" => InsightKind::Convention,
        _ => InsightKind::Decision,
    }
}

/// 空工具列表(提炼 / 审核都不调工具,占位以统一签名)。
pub fn no_tools() -> Vec<ToolSpec> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cosine_of_identical_vectors_is_one() {
        let a = vec![1.0, 0.0, 0.0];
        assert!((cosine(&a, &a) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_of_orthogonal_vectors_is_zero() {
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn cosine_of_mismatched_lengths_is_zero() {
        assert_eq!(cosine(&[1.0, 0.0], &[1.0]), 0.0);
        assert_eq!(cosine(&[], &[]), 0.0);
    }

    #[test]
    fn outcome_text_reports_skips() {
        let outcome = ProcessOutcome {
            candidates: 1,
            outcomes: vec![CandidateOutcome::SkippedFingerprint {
                fingerprint: "abc".to_owned(),
            }],
            ..ProcessOutcome::default()
        };
        assert!(outcome.has_skipped_fingerprint());
        assert!(outcome.to_result_text().contains("skipped_fingerprint"));
    }
}
