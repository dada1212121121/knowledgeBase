//! explain 输出（设计规范）。

use std::collections::HashMap;

use kb_core::model::{SearchExplain, StoreHit};

/// 把全文检索的名次收集成 `id -> rank`。
pub fn ranks(hits: &[StoreHit]) -> HashMap<String, usize> {
    hits.iter()
        .map(|hit| (hit.row.id.clone(), hit.rank))
        .collect()
}

/// 把某阶段的原始分数收集成 `id -> score`。
pub fn scores(hits: &[StoreHit]) -> HashMap<String, f32> {
    hits.iter()
        .map(|hit| (hit.row.id.clone(), hit.score))
        .collect()
}

/// 一个检索阶段的名次与分数(全文 / 向量各一份,供 explain 用)。
#[derive(Clone, Debug, Default)]
pub struct StageStats {
    /// `id -> 名次`(1 起)。
    pub ranks: HashMap<String, usize>,
    /// `id -> 原始分数`。
    pub scores: HashMap<String, f32>,
}

impl StageStats {
    /// 从一次存储层检索的结果收集。
    pub fn from_hits(hits: &[StoreHit]) -> Self {
        Self {
            ranks: ranks(hits),
            scores: scores(hits),
        }
    }
}

/// 组装一条命中的 explain 所需的融合侧信息。
pub struct FusedInfo<'a> {
    /// 来自哪个 collection。
    pub collection: &'a str,
    /// 表内混合检索的名次。
    pub store_rank: usize,
    /// 跨 collection 融合后的名次(1 起)。
    pub fused_rank: usize,
    /// 融合分数。
    pub fused_score: f64,
    /// 该 collection 的融合权重。
    pub fused_weight: f32,
    /// 记录 id。
    pub id: &'a str,
}

/// 组装一条命中的 explain。
pub fn build(
    info: FusedInfo<'_>,
    fts: Option<&StageStats>,
    vector: Option<&StageStats>,
) -> SearchExplain {
    let id = info.id;
    SearchExplain {
        collection: info.collection.to_owned(),
        fts_rank: fts.and_then(|stats| stats.ranks.get(id).copied()),
        fts_score: fts.and_then(|stats| stats.scores.get(id).copied()),
        vector_rank: vector.and_then(|stats| stats.ranks.get(id).copied()),
        vector_score: vector.and_then(|stats| stats.scores.get(id).copied()),
        store_rank: Some(info.store_rank),
        fused_rank: Some(info.fused_rank),
        fused_score: info.fused_score,
        fused_weight: Some(info.fused_weight),
        rerank_rank: None,
        rerank_score: None,
        window: None,
        pending: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::{ItemStatus, RecordKind, RecordRow};

    fn hit(id: &str, rank: usize) -> StoreHit {
        StoreHit {
            row: RecordRow {
                id: id.to_owned(),
                collection: "proj_demo".to_owned(),
                kind: RecordKind::Code,
                lang: None,
                source: "a.rs".to_owned(),
                start_line: Some(1),
                end_line: Some(2),
                symbol: None,
                title: None,
                text: "t".to_owned(),
                header: "h".to_owned(),
                lex: "l".to_owned(),
                tags: Vec::new(),
                status: ItemStatus::Active,
                content_hash: "c".to_owned(),
                meta_hash: "m".to_owned(),
                embed_input_hash: "e".to_owned(),
                updated_at: 0,
                anchor: None,
                vector: None,
            },
            score: 1.0,
            rank,
        }
    }

    #[test]
    fn ranks_map_ids_to_positions() {
        let map = ranks(&[hit("a", 1), hit("b", 2)]);
        assert_eq!(map.get("a"), Some(&1));
        assert_eq!(map.get("b"), Some(&2));
        assert_eq!(map.get("c"), None);
    }

    #[test]
    fn explain_carries_each_stage() {
        let fts = ranks(&[hit("a", 3)]);
        let explain = build(
            FusedInfo {
                collection: "proj_demo",
                store_rank: 2,
                fused_rank: 1,
                fused_score: 0.5,
                fused_weight: 1.0,
                id: "a",
            },
            Some(&StageStats {
                ranks: fts.clone(),
                scores: HashMap::new(),
            }),
            None,
        );
        assert_eq!(explain.collection, "proj_demo");
        assert_eq!(explain.store_rank, Some(2));
        assert_eq!(explain.fused_rank, Some(1));
        assert_eq!(explain.fts_rank, Some(3));
        assert_eq!(explain.vector_rank, None);
        assert_eq!(explain.fused_score, 0.5);
    }
}

#[cfg(test)]
mod score_tests {
    use super::*;
    use kb_core::model::{ItemStatus, RecordKind, RecordRow};

    fn hit(id: &str, rank: usize, score: f32) -> StoreHit {
        StoreHit {
            row: RecordRow {
                id: id.to_owned(),
                collection: "proj_demo".to_owned(),
                kind: RecordKind::Code,
                lang: None,
                source: "a.rs".to_owned(),
                start_line: Some(1),
                end_line: Some(2),
                symbol: None,
                title: None,
                text: "t".to_owned(),
                header: "h".to_owned(),
                lex: "l".to_owned(),
                tags: Vec::new(),
                status: ItemStatus::Active,
                content_hash: "c".to_owned(),
                meta_hash: "m".to_owned(),
                embed_input_hash: "e".to_owned(),
                updated_at: 1,
                anchor: None,
                vector: None,
            },
            score,
            rank,
        }
    }

    #[test]
    fn scores_are_collected_by_id() {
        let hits = vec![hit("a", 1, 12.5), hit("b", 2, 8.25)];
        let scores = scores(&hits);
        assert_eq!(scores.get("a").copied(), Some(12.5));
        assert_eq!(scores.get("b").copied(), Some(8.25));
    }

    #[test]
    fn build_carries_fts_and_vector_scores() {
        let fts = scores(&[hit("a", 2, 13.77)]);
        let fts_ranks = ranks(&[hit("a", 2, 13.77)]);
        let vec = scores(&[hit("a", 5, 0.779)]);
        let vec_ranks = ranks(&[hit("a", 5, 0.779)]);
        let explain = build(
            FusedInfo {
                collection: "proj_demo",
                store_rank: 5,
                fused_rank: 3,
                fused_score: 0.0318,
                fused_weight: 1.0,
                id: "a",
            },
            Some(&StageStats {
                ranks: fts_ranks.clone(),
                scores: fts.clone(),
            }),
            Some(&StageStats {
                ranks: vec_ranks.clone(),
                scores: vec.clone(),
            }),
        );
        assert_eq!(explain.fts_rank, Some(2));
        assert_eq!(explain.fts_score, Some(13.77));
        assert_eq!(explain.vector_rank, Some(5));
        assert_eq!(explain.vector_score, Some(0.779));
        assert_eq!(explain.fused_score, 0.0318);
    }
}
