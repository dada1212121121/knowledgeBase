//! 加权 RRF 融合（设计规范）。
//!
//! LanceDB 只在**同一张表内**做 RRF;跨 collection(项目 + `_global`)的融合由服务层
//! 按排名再做一次加权 RRF:`score = Σ w_c / (rrf_k + rank)`,`_global` 的权重默认 0.8。
//! 因为各表的 `_relevance_score` 不可比(设计规范坑 16),这里只使用排名,不使用原始分数。

use std::collections::HashMap;

/// 一个 collection 的排名结果。
#[derive(Clone, Copy, Debug)]
pub struct RankedList<'a> {
    /// 该列表的权重(项目 1.0,`_global` 用 `search.global_weight`)。
    pub weight: f64,
    /// 已按相关度降序排好的 id 列表,第 1 个 id 的 rank 为 1。
    pub ids: &'a [String],
}

/// 融合结果。
#[derive(Clone, Debug, PartialEq)]
pub struct RrfEntry {
    /// 记录 id。
    pub id: String,
    /// 融合分数,越大越靠前。
    pub score: f64,
}

/// 单条命中对总分的贡献。
///
/// `rank` 从 1 开始(第 1 名贡献 `weight / (rrf_k + 1)`)。
pub fn rrf_score(weight: f64, rrf_k: usize, rank: usize) -> f64 {
    weight / (rrf_k as f64 + rank.max(1) as f64)
}

/// 按排名做加权 RRF 融合,返回按分数降序排列的结果。
///
/// 同一个 id 出现在多个列表时分数相加;同一个列表内的重复 id 只按最好名次计一次。
/// 分数相同时按 id 升序,保证输出稳定。
pub fn weighted_rrf(lists: &[RankedList<'_>], rrf_k: usize) -> Vec<RrfEntry> {
    let mut scores: HashMap<&str, f64> = HashMap::new();
    for list in lists {
        let mut seen_in_list: HashMap<&str, ()> = HashMap::new();
        for (index, id) in list.ids.iter().enumerate() {
            let rank = index + 1;
            // 同一个列表内的重复 id 只按最好名次计一次
            if seen_in_list.insert(id.as_str(), ()).is_some() {
                continue;
            }
            *scores.entry(id.as_str()).or_insert(0.0) += rrf_score(list.weight, rrf_k, rank);
        }
    }
    let mut out: Vec<RrfEntry> = scores
        .into_iter()
        .map(|(id, score)| RrfEntry {
            id: id.to_owned(),
            score,
        })
        .collect();
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.id.cmp(&b.id))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(values: &[&str]) -> Vec<String> {
        values.iter().map(|v| (*v).to_owned()).collect()
    }

    fn approx(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn single_list_keeps_order() {
        let list = ids(&["a", "b", "c"]);
        let fused = weighted_rrf(
            &[RankedList {
                weight: 1.0,
                ids: &list,
            }],
            60,
        );
        assert_eq!(fused.len(), 3);
        assert_eq!(fused[0].id, "a");
        assert_eq!(fused[1].id, "b");
        assert_eq!(fused[2].id, "c");
        assert!(approx(fused[0].score, 1.0 / 61.0));
        assert!(approx(fused[1].score, 1.0 / 62.0));
    }

    #[test]
    fn global_weight_lowers_its_contribution() {
        let project = ids(&["p1"]);
        let global = ids(&["g1"]);
        let fused = weighted_rrf(
            &[
                RankedList {
                    weight: 1.0,
                    ids: &project,
                },
                RankedList {
                    weight: 0.8,
                    ids: &global,
                },
            ],
            60,
        );
        assert_eq!(fused[0].id, "p1");
        assert_eq!(fused[1].id, "g1");
        assert!(approx(fused[1].score, 0.8 / 61.0));
        assert!(fused[0].score > fused[1].score);
    }

    #[test]
    fn same_id_in_two_lists_sums_scores() {
        let project = ids(&["x", "y"]);
        let global = ids(&["y", "z"]);
        let fused = weighted_rrf(
            &[
                RankedList {
                    weight: 1.0,
                    ids: &project,
                },
                RankedList {
                    weight: 0.8,
                    ids: &global,
                },
            ],
            60,
        );
        let y = fused.iter().find(|e| e.id == "y").expect("y present");
        assert!(approx(y.score, 1.0 / 62.0 + 0.8 / 61.0));
        // y 在两个列表里都不算第一,但累加后仍然超过只有一处命中的 x、z
        assert_eq!(fused[0].id, "y");
    }

    #[test]
    fn larger_rrf_k_flattens_scores() {
        let list = ids(&["a", "b"]);
        let small = weighted_rrf(
            &[RankedList {
                weight: 1.0,
                ids: &list,
            }],
            1,
        );
        let large = weighted_rrf(
            &[RankedList {
                weight: 1.0,
                ids: &list,
            }],
            1000,
        );
        let small_gap = small[0].score - small[1].score;
        let large_gap = large[0].score - large[1].score;
        assert!(small_gap > large_gap);
    }

    #[test]
    fn duplicate_ids_within_one_list_count_once() {
        let list = ids(&["a", "a", "b"]);
        let fused = weighted_rrf(
            &[RankedList {
                weight: 1.0,
                ids: &list,
            }],
            60,
        );
        assert_eq!(fused.len(), 2);
        let a = fused.iter().find(|e| e.id == "a").expect("a present");
        assert!(approx(a.score, 1.0 / 61.0));
    }

    #[test]
    fn ties_break_by_id_for_stable_output() {
        let left = ids(&["b"]);
        let right = ids(&["a"]);
        let fused = weighted_rrf(
            &[
                RankedList {
                    weight: 1.0,
                    ids: &left,
                },
                RankedList {
                    weight: 1.0,
                    ids: &right,
                },
            ],
            60,
        );
        assert_eq!(fused[0].id, "a");
        assert_eq!(fused[1].id, "b");
        assert!(approx(fused[0].score, fused[1].score));
    }

    #[test]
    fn empty_input_yields_empty_output() {
        assert!(weighted_rrf(&[], 60).is_empty());
        let empty: Vec<String> = Vec::new();
        let fused = weighted_rrf(
            &[RankedList {
                weight: 1.0,
                ids: &empty,
            }],
            60,
        );
        assert!(fused.is_empty());
    }
}
