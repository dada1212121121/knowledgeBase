//! 主题归纳(设计规范的 `consolidate_project`)。
//!
//! 与去重不同,这一步**需要 LLM**:
//!
//! ```text
//! 有效 insight → 重新嵌入 → 按余弦聚类(不调 LLM)
//!   → 每个主题(成员数 ≥ consolidate_min_members)拼一段提示词
//!   → LLM 归纳成 1 条候选
//! → 走 的草稿状态机(指纹 → 向量去重 → 审核 → 按 review_mode 转正 / 进收件箱)
//! ```
//!
//! 复用状态机是有意的:归纳出来的条目与自动提炼的条目走**同一套**去重与审核,
//! 因此“转正之前搜不到”“重复的不进审核”“驳回过的不会再进来”这些性质自动成立。
//!
//! `dry_run`(默认)只做聚类,一次 LLM 都不调 —— 用户先看“会归纳出哪几个主题”再决定执行。
//! 执行时新建的 insight 会记一条 `insight.create` 变更,整批可用 `revert_batch` 撤销。

use std::collections::HashMap;
use std::sync::Arc;

use kb_core::config::EvolutionConfig;
use kb_core::model::{ChatMessage, ChatRequest, Edge, EdgeRel, Insight, ItemStatus, Page};
use kb_core::ports::repo::{
    AuditRepo, CollectionRepo, EdgeRepo, InsightRepo, MetaStore, ProjectRepo,
};
use kb_core::ports::{ChatModel, Embedder, VectorStore};
use kb_core::{KbError, Result};
use serde::Serialize;

use crate::evolution::drafts::{CandidateOutcome, EvolutionService, cosine};
use crate::evolution::extract;
use crate::llm_gate::{LlmGate, Purpose};
use crate::revert::{OP_INSIGHT_CREATE, record_op};

/// 提示词模板(与提炼 / 审核一样编进二进制)。
pub const CONSOLIDATE_PROMPT: &str = include_str!("../../../kb-llm/prompts/consolidate.md");

/// 一次最多取多少条 insight 参与聚类(防止一次跑爆内存)。
pub const MAX_INSIGHTS: usize = 500;

/// 一个主题最多包含多少条成员(超出的留给下一轮)。
pub const MAX_MEMBERS: usize = 8;

/// 送进提示词的单条正文上限(字符)。
pub const MAX_MEMBER_CHARS: usize = 600;

/// 一个主题的成员。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TopicMember {
    /// 条目 id。
    pub id: String,
    /// 标题。
    pub title: String,
    /// 与代表条目的余弦相似度。
    pub similarity: f32,
}

/// 一个主题(聚类结果)。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TopicCluster {
    /// 主题名(取代表条目的标题)。
    pub topic: String,
    /// 代表条目 id(成员里最新的那条)。
    pub representative_id: String,
    /// 成员(按创建时间从新到旧)。
    pub members: Vec<TopicMember>,
}

impl TopicCluster {
    /// 成员 id 列表。
    pub fn member_ids(&self) -> Vec<String> {
        self.members
            .iter()
            .map(|member| member.id.clone())
            .collect()
    }
}

/// 一个主题的处理结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum ClusterOutcome {
    /// 只演练(没调 LLM)。
    Planned {
        /// 主题名。
        topic: String,
    },
    /// 归纳出的候选被判为重复 / 指纹重复。
    Skipped {
        /// 主题名。
        topic: String,
        /// 状态机给出的结论。
        result: CandidateOutcome,
    },
    /// LLM 没给出可用候选(低置信 / 空)。
    NoSummary {
        /// 主题名。
        topic: String,
    },
    /// 归纳出的候选进了审核流程。
    Reviewed {
        /// 主题名。
        topic: String,
        /// 状态机给出的结论(approved / pending / rejected)。
        result: CandidateOutcome,
    },
}

/// `consolidate_project` 的结果。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct ConsolidateReport {
    /// 项目名。
    pub project: String,
    /// collection 名。
    pub collection: String,
    /// 是否只演练。
    pub dry_run: bool,
    /// 参与聚类的条目数。
    pub compared: usize,
    /// 找到的主题。
    pub clusters: Vec<TopicCluster>,
    /// 每个主题的处理结果(演练时每个主题一条 `planned`)。
    pub outcomes: Vec<ClusterOutcome>,
    /// 归纳调用了几次 LLM(审核调用不计在这里)。
    pub llm_calls: usize,
    /// 新建了几条 insight(演练时为 0)。
    pub created: usize,
    /// 改动所属批次(可撤销;演练或没有新建时为 `None`)。
    pub batch_id: Option<String>,
}

/// 主题归纳服务。
pub struct ConsolidateService {
    meta: Arc<dyn MetaStore>,
    embedder: Arc<dyn Embedder>,
    gate: LlmGate,
    model: Arc<dyn ChatModel>,
    evolution: EvolutionService,
    config: EvolutionConfig,
}

impl ConsolidateService {
    /// 构造。
    ///
    /// `model` 用来归纳,`review_model` 用来审核(与 一样,两者应是不同模型);
    /// 归纳结果交给内部的 [`EvolutionService`] 走状态机。
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
        gate: LlmGate,
        model: Arc<dyn ChatModel>,
        review_model: Arc<dyn ChatModel>,
        config: EvolutionConfig,
    ) -> Self {
        let evolution = EvolutionService::new(
            meta.clone(),
            store,
            embedder.clone(),
            gate.clone(),
            model.clone(),
            review_model,
            config.clone(),
        );
        Self {
            meta,
            embedder,
            gate,
            model,
            evolution,
            config,
        }
    }

    /// 挂上声明式 skills:内部的 [`EvolutionService`] 会用它覆盖提炼 / 审核提示词。
    /// 归纳结果仍要经过同一套审核,不能因为走了归纳入口就绕过规范。
    pub fn with_skills(mut self, skills: Arc<crate::skills::SkillRegistry>) -> Self {
        self.evolution = self.evolution.with_skills(skills);
        self
    }

    /// 归纳一个项目(`dry_run` 只聚类、不调 LLM)。
    pub async fn run(
        &self,
        project_id: &str,
        dry_run: bool,
        actor: &str,
    ) -> Result<ConsolidateReport> {
        let project = ProjectRepo::get(self.meta.as_ref(), project_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("project {project_id}")))?;
        let collection = format!("proj_{}", project.slug);
        CollectionRepo::get(self.meta.as_ref(), &collection)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {collection}")))?;
        let insights = InsightRepo::list(
            self.meta.as_ref(),
            &collection,
            Some(ItemStatus::Active),
            Page::new(MAX_INSIGHTS as u32, 0),
        )
        .await?;
        let mut report = ConsolidateReport {
            project: project.name.clone(),
            collection: collection.clone(),
            dry_run,
            ..ConsolidateReport::default()
        };
        if insights.len() < self.min_members() {
            return Ok(report);
        }

        // 向量:与去重一样重新嵌入(批量,上限见 MAX_INSIGHTS)
        let vectors = self.embed_insights(&insights).await?;
        report.compared = vectors.len();
        report.clusters = cluster(
            &insights,
            &vectors,
            self.config.consolidate_similarity,
            self.min_members(),
            self.config.consolidate_max_clusters,
        );
        if report.clusters.is_empty() {
            return Ok(report);
        }
        if dry_run {
            report.outcomes = report
                .clusters
                .iter()
                .map(|cluster| ClusterOutcome::Planned {
                    topic: cluster.topic.clone(),
                })
                .collect();
            return Ok(report);
        }

        // 执行:逐个主题归纳 → 状态机
        let by_id: HashMap<&str, &Insight> = insights
            .iter()
            .map(|insight| (insight.id.as_str(), insight))
            .collect();
        let mut created_ids: Vec<String> = Vec::new();
        for cluster in &report.clusters {
            let members: Vec<&Insight> = cluster
                .members
                .iter()
                .filter_map(|member| by_id.get(member.id.as_str()).copied())
                .collect();
            let request = build_request(&project.name, &cluster.topic, &members, self.model.id());
            let response = self
                .gate
                .send(Some(project_id), Purpose::Consolidate, &self.model, request)
                .await?;
            report.llm_calls += 1;
            let text = response.message.content.unwrap_or_default();
            let candidate = extract::parse_candidates(&text)?.into_iter().next();
            let Some(mut candidate) = candidate else {
                report.outcomes.push(ClusterOutcome::NoSummary {
                    topic: cluster.topic.clone(),
                });
                continue;
            };
            // 归纳出的条目带上主题成员的文件与标签,便于检索时聚合
            if candidate.related_paths.is_empty() {
                candidate.related_paths = cluster_paths(&members);
            }
            if candidate.evidence.trim().is_empty() {
                candidate.evidence = cluster.member_ids().join(",");
            }
            let result = self
                .evolution
                .ingest_candidate(project_id, &candidate)
                .await?;
            if let CandidateOutcome::Approved { insight_id, .. } = &result {
                // 草稿表不存 related_paths,转正后在这里补上(否则质量报告会把它算成“无关联文件”)
                self.attach_paths(insight_id, &candidate.related_paths)
                    .await?;
                created_ids.push(insight_id.clone());
            }
            let outcome = match &result {
                CandidateOutcome::Approved { .. }
                | CandidateOutcome::PendingReview { .. }
                | CandidateOutcome::Rejected { .. } => ClusterOutcome::Reviewed {
                    topic: cluster.topic.clone(),
                    result,
                },
                _ => ClusterOutcome::Skipped {
                    topic: cluster.topic.clone(),
                    result,
                },
            };
            report.outcomes.push(outcome);
        }

        if created_ids.is_empty() {
            return Ok(report);
        }
        // 整批可撤销:每个新建条目记一条 `insight.create`
        let batch_id = uuid::Uuid::now_v7().to_string();
        AuditRepo::ensure_batch(
            self.meta.as_ref(),
            &batch_id,
            actor,
            &format!("主题归纳 {collection}"),
        )
        .await?;
        for id in &created_ids {
            // 快照进 `after`,撤销时按 id 删掉这条 insight(SQLite + LanceDB)
            let snapshot = InsightRepo::get(self.meta.as_ref(), id).await?;
            record_op(
                self.meta.as_ref(),
                &batch_id,
                id,
                OP_INSIGHT_CREATE,
                None,
                snapshot.and_then(|insight| serde_json::to_value(insight).ok()),
            )
            .await?;
            report.created += 1;
        }
        report.batch_id = Some(batch_id);
        Ok(report)
    }

    /// 给转正后的条目补关联文件(行内字段 + `about_file` 边,与 `InsightService::save` 一致)。
    async fn attach_paths(&self, insight_id: &str, paths: &[String]) -> Result<()> {
        if paths.is_empty() {
            return Ok(());
        }
        let Some(mut insight) = InsightRepo::get(self.meta.as_ref(), insight_id).await? else {
            return Ok(());
        };
        let now = now_millis();
        for path in paths {
            EdgeRepo::add(
                self.meta.as_ref(),
                Edge {
                    src_id: insight_id.to_owned(),
                    dst: format!("path:{path}"),
                    rel: EdgeRel::AboutFile,
                    created_at: now,
                },
            )
            .await?;
        }
        if insight.related_paths.is_empty() {
            insight.related_paths = paths.to_vec();
            insight.updated_at = now;
            let expected = insight.version;
            InsightRepo::update(self.meta.as_ref(), insight, expected).await?;
        }
        Ok(())
    }

    /// 主题条数下限(配置写错时退回 2,不让它变成 0 / 1)。
    fn min_members(&self) -> usize {
        self.config.consolidate_min_members.max(2)
    }

    /// 批量重新嵌入(每批 32 条)。
    async fn embed_insights(&self, insights: &[Insight]) -> Result<HashMap<String, Vec<f32>>> {
        let mut vectors: HashMap<String, Vec<f32>> = HashMap::new();
        for batch in insights.chunks(32) {
            let texts: Vec<String> = batch
                .iter()
                .map(|insight| format!("{}\n{}", insight.title, insight.body_md))
                .collect();
            let embedded = self.embedder.embed_documents(texts).await?;
            for (insight, vector) in batch.iter().zip(embedded) {
                vectors.insert(insight.id.clone(), vector);
            }
        }
        Ok(vectors)
    }
}

/// 按向量聚类:从新到旧取代表,把相似度 ≥ `similarity` 的未分配条目收进同一主题。
///
/// 纯函数,便于单测。`similarity` 是**成员与代表**的阈值(不是成员两两之间),
/// 这样簇不会因为链式相似而无限扩张;`max_members` 之外的不进本簇(留给后续轮次)。
pub fn cluster(
    insights: &[Insight],
    vectors: &HashMap<String, Vec<f32>>,
    similarity: f64,
    min_members: usize,
    max_clusters: usize,
) -> Vec<TopicCluster> {
    let mut sorted: Vec<&Insight> = insights
        .iter()
        .filter(|insight| vectors.contains_key(&insight.id))
        .collect();
    sorted.sort_by_key(|insight| std::cmp::Reverse(insight.created_at));
    let mut claimed: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut clusters: Vec<TopicCluster> = Vec::new();
    for representative in &sorted {
        if clusters.len() >= max_clusters.max(1) {
            break;
        }
        if claimed.contains(representative.id.as_str()) {
            continue;
        }
        let Some(representative_vector) = vectors.get(&representative.id) else {
            continue;
        };
        let mut members = vec![TopicMember {
            id: representative.id.clone(),
            title: representative.title.clone(),
            similarity: 1.0,
        }];
        for other in &sorted {
            if members.len() >= MAX_MEMBERS {
                break;
            }
            if other.id == representative.id || claimed.contains(other.id.as_str()) {
                continue;
            }
            let Some(other_vector) = vectors.get(&other.id) else {
                continue;
            };
            let score = cosine(representative_vector, other_vector);
            if score as f64 >= similarity {
                members.push(TopicMember {
                    id: other.id.clone(),
                    title: other.title.clone(),
                    similarity: score,
                });
            }
        }
        if members.len() < min_members.max(2) {
            continue;
        }
        for member in &members {
            claimed.insert(member.id.clone());
        }
        clusters.push(TopicCluster {
            topic: representative.title.clone(),
            representative_id: representative.id.clone(),
            members,
        });
    }
    clusters
}

/// 拼归纳请求。
pub fn build_request(project: &str, topic: &str, members: &[&Insight], model: &str) -> ChatRequest {
    let members_text = members
        .iter()
        .map(|insight| {
            format!(
                "- id:{} · {}\n  正文:{}\n  文件:{}",
                insight.id,
                insight.title,
                excerpt(&insight.body_md, MAX_MEMBER_CHARS),
                if insight.related_paths.is_empty() {
                    "(无)".to_owned()
                } else {
                    insight.related_paths.join(", ")
                }
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let prompt = CONSOLIDATE_PROMPT
        .replace("{{project}}", project)
        .replace("{{members}}", &format!("(主题:{topic})\n{members_text}"));
    ChatRequest {
        model: model.to_owned(),
        messages: vec![ChatMessage {
            role: "user".to_owned(),
            content: Some(prompt),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }],
        tools: Vec::new(),
        json_output: true,
        thinking: false,
        max_tokens: Some(2048),
        temperature: Some(0.2),
    }
}

/// 成员的文件并集(最多 10 个)。
fn cluster_paths(members: &[&Insight]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for insight in members {
        for path in &insight.related_paths {
            if !paths.contains(path) {
                paths.push(path.clone());
            }
            if paths.len() >= 10 {
                return paths;
            }
        }
    }
    paths
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 按字符截断正文(保留开头)。
fn excerpt(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::InsightKind;

    fn insight(id: &str, title: &str, body: &str, created_at: i64) -> Insight {
        Insight {
            id: id.to_owned(),
            collection: "proj_demo".to_owned(),
            title: title.to_owned(),
            body_md: body.to_owned(),
            kind: InsightKind::Decision,
            tags: Vec::new(),
            related_paths: Vec::new(),
            status: ItemStatus::Active,
            version: 1,
            valid_from: created_at,
            valid_until: None,
            superseded_by: None,
            created_by: "agent".to_owned(),
            batch_id: None,
            created_at,
            updated_at: created_at,
        }
    }

    #[test]
    fn cluster_groups_similar_and_keeps_the_newest_as_representative() {
        let insights = vec![
            insight("old", "旧", "同一主题", 1_000),
            insight("new", "新", "同一主题", 2_000),
            insight("other", "无关", "完全不同", 3_000),
        ];
        let mut vectors = HashMap::new();
        vectors.insert("old".to_owned(), vec![1.0, 0.0]);
        vectors.insert("new".to_owned(), vec![0.99, 0.01]);
        vectors.insert("other".to_owned(), vec![0.0, 1.0]);
        let clusters = cluster(&insights, &vectors, 0.9, 2, 5);
        assert_eq!(clusters.len(), 1, "{clusters:?}");
        assert_eq!(clusters[0].representative_id, "new", "代表取最新的");
        assert_eq!(clusters[0].topic, "新");
        assert_eq!(clusters[0].member_ids(), vec!["new", "old"]);
    }

    #[test]
    fn single_member_clusters_are_dropped() {
        let insights = vec![
            insight("a", "A", "正文", 1_000),
            insight("b", "B", "正文", 2_000),
        ];
        let mut vectors = HashMap::new();
        vectors.insert("a".to_owned(), vec![1.0, 0.0]);
        vectors.insert("b".to_owned(), vec![0.0, 1.0]);
        assert!(cluster(&insights, &vectors, 0.9, 2, 5).is_empty());
    }

    #[test]
    fn cluster_count_is_capped() {
        let insights = vec![
            insight("a1", "A1", "x", 1_000),
            insight("a2", "A2", "x", 2_000),
            insight("b1", "B1", "y", 3_000),
            insight("b2", "B2", "y", 4_000),
        ];
        let mut vectors = HashMap::new();
        vectors.insert("a1".to_owned(), vec![1.0, 0.0]);
        vectors.insert("a2".to_owned(), vec![1.0, 0.0]);
        vectors.insert("b1".to_owned(), vec![0.0, 1.0]);
        vectors.insert("b2".to_owned(), vec![0.0, 1.0]);
        assert_eq!(cluster(&insights, &vectors, 0.9, 2, 1).len(), 1);
        assert_eq!(cluster(&insights, &vectors, 0.9, 2, 5).len(), 2);
    }

    #[test]
    fn prompt_lists_members_and_fills_placeholders() {
        let a = insight("i1", "标题一", "正文一", 1_000);
        let b = insight("i2", "标题二", "正文二", 2_000);
        let request = build_request("demo", "主题", &[&a, &b], "mock");
        let content = request.messages[0].content.clone().unwrap();
        assert!(content.contains("项目:demo"), "{content}");
        assert!(content.contains("id:i1"), "{content}");
        assert!(content.contains("id:i2"));
        assert!(content.contains("主题:主题"));
        assert!(!content.contains("{{"), "占位符都应被替换");
        assert!(request.json_output);
    }

    #[test]
    fn long_bodies_are_excerpted() {
        let long = insight("i1", "t", &"字".repeat(MAX_MEMBER_CHARS + 100), 1_000);
        let short = insight("i1", "t", "字", 1_000);
        let long_prompt = build_request("demo", "t", &[&long], "mock").messages[0]
            .content
            .clone()
            .unwrap();
        let short_prompt = build_request("demo", "t", &[&short], "mock").messages[0]
            .content
            .clone()
            .unwrap();
        assert!(long_prompt.contains("字…"), "应截断并加省略号");
        // 模板本身就有几百字,所以比较的是“长正文比短正文多出来的部分”
        let extra = long_prompt.chars().count() - short_prompt.chars().count();
        assert!(
            extra <= MAX_MEMBER_CHARS + 10,
            "正文应截到 {MAX_MEMBER_CHARS} 字左右,实际多出 {extra} 字"
        );
    }

    #[test]
    fn paths_are_unioned_with_a_cap() {
        let mut a = insight("a", "A", "x", 1);
        a.related_paths = vec!["src/a.rs".to_owned(), "src/b.rs".to_owned()];
        let mut b = insight("b", "B", "x", 2);
        b.related_paths = vec!["src/b.rs".to_owned(), "src/c.rs".to_owned()];
        assert_eq!(
            cluster_paths(&[&a, &b]),
            vec!["src/a.rs", "src/b.rs", "src/c.rs"]
        );
    }
}
