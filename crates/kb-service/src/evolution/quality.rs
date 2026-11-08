//! 巩固与质量报告（设计规范）。
//!
//! - [`dedup_insights`](DedupService::dedup):**只用向量相似度**,不调用 LLM。两两比较同一
//!   collection 里有效状态的 insight,相似度 ≥ `dedup_similarity` 的记一对;执行时把**较旧**
//!   的那条标为 `superseded` 并写 `duplicate_of` 边(整批可撤销);
//! - [`quality_report`](DedupService::quality_report):统计重复率、过期比例、没有关联文件的
//!   条目、低反馈条目,以及待审草稿数;
//! - `dry_run` 只出计划、不改任何东西(两个能力都支持)。
//!
//! `consolidate_project`(需要 LLM 的主题归纳)不在本轮:它要走审核流程,依赖 的收件箱 UI。

use std::sync::Arc;

use kb_core::config::EvolutionConfig;
use kb_core::model::{
    Edge, EdgeRel, Insight, ItemStatus, Millis, Page, RecordKind, SearchMode, StoreQuery,
};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::{
    AuditRepo, CollectionRepo, DraftRepo, EdgeRepo, InsightRepo, MetaStore,
};
use kb_core::{KbError, Result};
use serde::Serialize;

use crate::evolution::drafts::cosine;
use crate::revert::{OP_ITEM_STATUS, record_op};

/// 一对重复条目。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct DuplicatePair {
    /// 保留的那条(较新)。
    pub keep_id: String,
    /// 保留条目的标题。
    pub keep_title: String,
    /// 被标为重复的那条(较旧)。
    pub duplicate_id: String,
    /// 被标重复的标题。
    pub duplicate_title: String,
    /// 余弦相似度。
    pub similarity: f32,
}

/// `dedup_insights` 的结果。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct DedupPlan {
    /// collection 名。
    pub collection: String,
    /// 比较了多少条。
    pub compared: usize,
    /// 找到的重复对。
    pub pairs: Vec<DuplicatePair>,
    /// 是否只演练。
    pub dry_run: bool,
    /// 实际改动的条数(演练时为 0)。
    pub changed: usize,
    /// 改动所属批次(可撤销;演练时为 `None`)。
    pub batch_id: Option<String>,
}

/// 一个低反馈条目。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LowFeedback {
    /// 条目 id。
    pub id: String,
    /// 标题。
    pub title: String,
    /// 有用次数。
    pub useful: u64,
    /// 无用次数。
    pub useless: u64,
}

/// 质量报告。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct QualityReport {
    /// collection 名。
    pub collection: String,
    /// 有效条目数。
    pub active: u64,
    /// 已取代 / 过期条目数。
    pub inactive: u64,
    /// 重复对数量。
    pub duplicates: u64,
    /// 重复率(重复对数 / 有效条目数)。
    pub duplicate_ratio: f64,
    /// 过期条目数(`valid_until` 已过)。
    pub expired: u64,
    /// 过期比例。
    pub expired_ratio: f64,
    /// 没有关联文件的条目数。
    pub without_paths: u64,
    /// 低反馈条目(有用 0、无用 ≥1)。
    pub low_feedback: Vec<LowFeedback>,
    /// 待审草稿数。
    pub pending_drafts: u64,
}

/// 巩固服务。
pub struct DedupService {
    meta: Arc<dyn MetaStore>,
    embedder: Arc<dyn kb_core::ports::Embedder>,
    config: EvolutionConfig,
}

impl DedupService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        embedder: Arc<dyn kb_core::ports::Embedder>,
        config: EvolutionConfig,
    ) -> Self {
        Self {
            meta,
            embedder,
            config,
        }
    }

    /// 去重(`dry_run` 只出计划)。
    pub async fn dedup(&self, collection: &str, dry_run: bool, actor: &str) -> Result<DedupPlan> {
        // collection 必须存在(不存在直接 404,而不是给一份空计划)
        CollectionRepo::get(self.meta.as_ref(), collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {collection}")))?;
        let insights = InsightRepo::list(
            self.meta.as_ref(),
            collection,
            Some(ItemStatus::Active),
            Page::new(5_000, 0),
        )
        .await?;
        let mut plan = DedupPlan {
            collection: collection.to_owned(),
            dry_run,
            ..DedupPlan::default()
        };
        if insights.len() < 2 {
            return Ok(plan);
        }
        // 向量:直接对标题 + 正文重新嵌入(LanceDB 的 `get` 不带向量,而这里只需要向量本身)。
        // 去重是夜间任务,批量嵌入的开销可以接受;上限 5000 条,避免一次跑爆内存。
        let mut vectors: std::collections::HashMap<&str, Vec<f32>> =
            std::collections::HashMap::new();
        for batch in insights.chunks(32) {
            let texts: Vec<String> = batch
                .iter()
                .map(|insight| format!("{}\n{}", insight.title, insight.body_md))
                .collect();
            let embedded = self.embedder.embed_documents(texts).await?;
            for (insight, vector) in batch.iter().zip(embedded) {
                vectors.insert(insight.id.as_str(), vector);
            }
        }
        plan.compared = vectors.len();

        // 两两比较:较旧的标为重复(保留较新的一条)
        let mut by_id: std::collections::HashMap<&str, &Insight> = insights
            .iter()
            .map(|insight| (insight.id.as_str(), insight))
            .collect();
        let mut sorted: Vec<&Insight> = insights.iter().collect();
        sorted.sort_by_key(|insight| std::cmp::Reverse(insight.created_at));
        let mut claimed: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for (index, keep) in sorted.iter().enumerate() {
            if claimed.contains(keep.id.as_str()) {
                continue;
            }
            let Some(keep_vector) = vectors.get(keep.id.as_str()) else {
                continue;
            };
            for other in sorted.iter().skip(index + 1) {
                if claimed.contains(other.id.as_str()) {
                    continue;
                }
                let Some(other_vector) = vectors.get(other.id.as_str()) else {
                    continue;
                };
                let similarity = cosine(keep_vector, other_vector);
                if similarity as f64 >= self.config.dedup_similarity {
                    claimed.insert(other.id.as_str());
                    plan.pairs.push(DuplicatePair {
                        keep_id: keep.id.clone(),
                        keep_title: keep.title.clone(),
                        duplicate_id: other.id.clone(),
                        duplicate_title: other.title.clone(),
                        similarity,
                    });
                }
            }
        }
        by_id.clear();

        if dry_run || plan.pairs.is_empty() {
            return Ok(plan);
        }
        // 执行:标 superseded + 写 duplicate_of 边,整批可撤销
        let batch_id = uuid::Uuid::now_v7().to_string();
        AuditRepo::ensure_batch(
            self.meta.as_ref(),
            &batch_id,
            actor,
            &format!("去重 {collection}"),
        )
        .await?;
        for pair in &plan.pairs {
            let Some(mut duplicate) =
                InsightRepo::get(self.meta.as_ref(), &pair.duplicate_id).await?
            else {
                continue;
            };
            let before = serde_json::to_value(&duplicate).ok();
            duplicate.status = ItemStatus::Superseded;
            duplicate.superseded_by = Some(pair.keep_id.clone());
            duplicate.updated_at = now_millis();
            let expected = duplicate.version;
            let updated = InsightRepo::update(self.meta.as_ref(), duplicate, expected).await?;
            let after = serde_json::to_value(&updated).ok();
            record_op(
                self.meta.as_ref(),
                &batch_id,
                &pair.duplicate_id,
                OP_ITEM_STATUS,
                before,
                after,
            )
            .await?;
            EdgeRepo::add(
                self.meta.as_ref(),
                Edge {
                    src_id: pair.duplicate_id.clone(),
                    dst: pair.keep_id.clone(),
                    rel: EdgeRel::DuplicateOf,
                    created_at: now_millis(),
                },
            )
            .await?;
            plan.changed += 1;
        }
        plan.batch_id = Some(batch_id);
        Ok(plan)
    }

    /// 质量报告。
    pub async fn quality_report(&self, collection: &str) -> Result<QualityReport> {
        let insights = InsightRepo::list(
            self.meta.as_ref(),
            collection,
            Some(ItemStatus::Active),
            Page::new(5_000, 0),
        )
        .await?;
        let inactive = InsightRepo::list(
            self.meta.as_ref(),
            collection,
            Some(ItemStatus::Superseded),
            Page::new(5_000, 0),
        )
        .await?
        .len() as u64;
        let deprecated = InsightRepo::list(
            self.meta.as_ref(),
            collection,
            Some(ItemStatus::Deprecated),
            Page::new(5_000, 0),
        )
        .await?
        .len() as u64;
        let now = now_millis();
        let active = insights.len() as u64;
        let expired = insights
            .iter()
            .filter(|insight| insight.valid_until.is_some_and(|until| until <= now))
            .count() as u64;
        let without_paths = insights
            .iter()
            .filter(|insight| insight.related_paths.is_empty())
            .count() as u64;
        let duplicate_edges = insights
            .iter()
            .map(|insight| insight.id.clone())
            .collect::<Vec<_>>();
        let mut duplicates = 0u64;
        for id in &duplicate_edges {
            let edges = EdgeRepo::by_src(self.meta.as_ref(), id).await?;
            duplicates += edges
                .iter()
                .filter(|edge| edge.rel == EdgeRel::DuplicateOf)
                .count() as u64;
        }
        let pending_drafts = DraftRepo::count(self.meta.as_ref(), None).await?;

        // 低反馈:有用 0 次、无用 ≥1 次
        let feedback =
            kb_core::ports::repo::FeedbackRepo::list(self.meta.as_ref(), Page::new(5_000, 0))
                .await?;
        let mut stats: std::collections::HashMap<String, (u64, u64)> =
            std::collections::HashMap::new();
        for entry in &feedback {
            let counter = stats.entry(entry.item_id.clone()).or_insert((0, 0));
            if entry.useful {
                counter.0 += 1;
            } else {
                counter.1 += 1;
            }
        }
        let mut low_feedback: Vec<LowFeedback> = insights
            .iter()
            .filter_map(|insight| {
                let (useful, useless) = stats.get(&insight.id).copied().unwrap_or((0, 0));
                (useful == 0 && useless >= 1).then(|| LowFeedback {
                    id: insight.id.clone(),
                    title: insight.title.clone(),
                    useful,
                    useless,
                })
            })
            .collect();
        low_feedback.sort_by_key(|item| std::cmp::Reverse(item.useless));

        Ok(QualityReport {
            collection: collection.to_owned(),
            active,
            inactive: inactive + deprecated,
            duplicates,
            duplicate_ratio: if active == 0 {
                0.0
            } else {
                duplicates as f64 / active as f64
            },
            expired,
            expired_ratio: if active == 0 {
                0.0
            } else {
                expired as f64 / active as f64
            },
            without_paths,
            low_feedback,
            pending_drafts,
        })
    }
}

/// 只在测试 / 调试里用的相似度查询(走 LanceDB 向量检索,不拉全表)。
pub async fn nearest_ids(
    store: &Arc<dyn VectorStore>,
    table: &str,
    vector: Vec<f32>,
    limit: usize,
) -> Result<Vec<String>> {
    let hits = store
        .search(
            table,
            &StoreQuery {
                mode: SearchMode::Vector,
                text: None,
                vector: Some(vector),
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
    Ok(hits.into_iter().map(|hit| hit.row.id).collect())
}

fn now_millis() -> Millis {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicate_ratio_handles_empty_collections() {
        let report = QualityReport::default();
        assert_eq!(report.duplicate_ratio, 0.0);
        assert_eq!(report.expired_ratio, 0.0);
    }

    #[test]
    fn plan_serialises_the_pair_details() {
        let plan = DedupPlan {
            collection: "proj_demo".to_owned(),
            compared: 3,
            pairs: vec![DuplicatePair {
                keep_id: "new".to_owned(),
                keep_title: "新".to_owned(),
                duplicate_id: "old".to_owned(),
                duplicate_title: "旧".to_owned(),
                similarity: 0.97,
            }],
            dry_run: true,
            changed: 0,
            batch_id: None,
        };
        let text = serde_json::to_string(&plan).expect("序列化");
        assert!(text.contains("\"duplicate_id\":\"old\""), "{text}");
        assert!(text.contains("\"dry_run\":true"));
    }
}
