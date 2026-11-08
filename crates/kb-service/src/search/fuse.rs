//! 跨 collection 融合与去重（设计规范）。

use kb_core::model::{RecordRow, StoreHit};
use kb_core::rrf::{RankedList, weighted_rrf};

/// 一个 collection 的检索结果。
#[derive(Clone, Debug)]
pub struct CollectionHits {
    /// collection 名。
    pub collection: String,
    /// 融合权重(项目 1.0,`_global` 用 `search.global_weight`)。
    pub weight: f64,
    /// 表内检索结果,已按相关度降序。
    pub hits: Vec<StoreHit>,
}

/// 融合后的一条命中。
#[derive(Clone, Debug)]
pub struct FusedHit {
    /// 记录。
    pub row: RecordRow,
    /// 融合分数。
    pub score: f64,
    /// 来源 collection。
    pub collection: String,
    /// 表内名次。
    pub store_rank: usize,
}

/// 按排名做加权 RRF 融合。
pub fn fuse(lists: &[CollectionHits], rrf_k: usize) -> Vec<FusedHit> {
    let ids: Vec<Vec<String>> = lists
        .iter()
        .map(|list| {
            list.hits
                .iter()
                .map(|hit| hit.row.id.clone())
                .collect::<Vec<_>>()
        })
        .collect();
    let ranked: Vec<RankedList<'_>> = lists
        .iter()
        .zip(ids.iter())
        .map(|(list, ids)| RankedList {
            weight: list.weight,
            ids,
        })
        .collect();
    let fused = weighted_rrf(&ranked, rrf_k);

    let mut by_id: Vec<FusedHit> = Vec::with_capacity(fused.len());
    for entry in &fused {
        if let Some((list, hit)) = find(lists, &entry.id) {
            by_id.push(FusedHit {
                row: hit.row.clone(),
                score: entry.score,
                collection: list.collection.clone(),
                store_rank: hit.rank,
            });
        }
    }
    by_id
}

fn find<'a>(lists: &'a [CollectionHits], id: &str) -> Option<(&'a CollectionHits, &'a StoreHit)> {
    for list in lists {
        if let Some(hit) = list.hits.iter().find(|hit| hit.row.id == id) {
            return Some((list, hit));
        }
    }
    None
}

/// 去掉同一 source 里行范围重叠的较低分结果。
///
/// 保留分数更高(即先出现)的那条;没有行号的记录(insight 等)按 id 去重。
pub fn dedupe_overlaps(hits: Vec<FusedHit>) -> Vec<FusedHit> {
    let mut kept: Vec<FusedHit> = Vec::with_capacity(hits.len());
    'outer: for hit in hits {
        for existing in &kept {
            // 不同 collection 里同名的相对路径是两份不同的内容,不能互相去重
            if existing.collection != hit.collection || existing.row.source != hit.row.source {
                continue;
            }
            if ranges_overlap(&existing.row, &hit.row) {
                continue 'outer;
            }
            if existing.row.id == hit.row.id {
                continue 'outer;
            }
        }
        kept.push(hit);
    }
    kept
}

fn ranges_overlap(left: &RecordRow, right: &RecordRow) -> bool {
    match (
        left.start_line,
        left.end_line,
        right.start_line,
        right.end_line,
    ) {
        (Some(left_start), Some(left_end), Some(right_start), Some(right_end)) => {
            left_start <= right_end && right_start <= left_end
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_core::model::{ItemStatus, RecordKind};

    fn row(id: &str, source: &str, start: i32, end: i32) -> RecordRow {
        RecordRow {
            id: id.to_owned(),
            collection: "proj_demo".to_owned(),
            kind: RecordKind::Code,
            lang: Some("rust".to_owned()),
            source: source.to_owned(),
            start_line: Some(start),
            end_line: Some(end),
            symbol: None,
            title: None,
            text: format!("text of {id}"),
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
        }
    }

    fn hit(row: RecordRow, rank: usize) -> StoreHit {
        StoreHit {
            row,
            score: 1.0 / rank as f32,
            rank,
        }
    }

    fn list(collection: &str, weight: f64, hits: Vec<StoreHit>) -> CollectionHits {
        CollectionHits {
            collection: collection.to_owned(),
            weight,
            hits,
        }
    }

    #[test]
    fn both_collections_contribute() {
        let project = list("proj_demo", 1.0, vec![hit(row("a", "src/a.rs", 1, 2), 1)]);
        let global = list("_global", 0.8, vec![hit(row("b", "doc.md", 3, 4), 1)]);
        let fused = fuse(&[project, global], 60);
        assert_eq!(fused.len(), 2);
        assert_eq!(fused[0].row.id, "a", "项目权重更高,排前面");
        assert_eq!(fused[1].row.id, "b");
    }

    #[test]
    fn same_id_in_two_lists_adds_scores() {
        // RRF 按列表内的位置排名,所以两个列表里都排第 1
        let project = list("proj_demo", 1.0, vec![hit(row("a", "src/a.rs", 1, 2), 1)]);
        let global = list("_global", 0.8, vec![hit(row("a", "src/a.rs", 1, 2), 1)]);
        let fused = fuse(&[project, global], 60);
        assert_eq!(fused.len(), 1);
        let expected = 1.0 / 61.0 + 0.8 / 61.0;
        assert!(
            (fused[0].score - expected).abs() < 1e-9,
            "score={} expected={expected}",
            fused[0].score
        );
    }

    #[test]
    fn overlapping_ranges_are_merged() {
        let hits = vec![
            FusedHit {
                row: row("a", "src/a.rs", 1, 10),
                score: 0.5,
                collection: "proj_demo".to_owned(),
                store_rank: 1,
            },
            FusedHit {
                row: row("b", "src/a.rs", 8, 20),
                score: 0.4,
                collection: "proj_demo".to_owned(),
                store_rank: 2,
            },
            FusedHit {
                row: row("c", "src/a.rs", 30, 40),
                score: 0.3,
                collection: "proj_demo".to_owned(),
                store_rank: 3,
            },
        ];
        let kept = dedupe_overlaps(hits);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].row.id, "a");
        assert_eq!(kept[1].row.id, "c");
    }

    #[test]
    fn different_sources_do_not_merge() {
        let hits = vec![
            FusedHit {
                row: row("a", "src/a.rs", 1, 10),
                score: 0.5,
                collection: "proj_demo".to_owned(),
                store_rank: 1,
            },
            FusedHit {
                row: row("b", "src/b.rs", 1, 10),
                score: 0.4,
                collection: "proj_demo".to_owned(),
                store_rank: 2,
            },
        ];
        assert_eq!(dedupe_overlaps(hits).len(), 2);
    }
}
