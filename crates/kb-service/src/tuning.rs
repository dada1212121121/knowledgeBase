//! 反馈调权(设计规范)。
//!
//! 读 `feedback` 表,按 **(collection, kind, 路径前缀)** 统计“有用率”,再按有用率与全局均值的差
//! 给出每个 collection 的 RRF 权重调整建议(单次幅度 ≤ `max_delta`,默认 ±0.2)。
//!
//! 这里只做**计算**,不写配置:确认后的落盘由能力层走 `update_config`(与 Web 改配置同一条路径),
//! 这样配置热重载、审计与回执都复用现成的那套。

use std::collections::BTreeMap;
use std::sync::Arc;

use kb_core::Result;
use kb_core::model::{Feedback, Page, RecordKind};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::{CollectionRepo, FeedbackRepo, MetaStore};

/// 调权参数。
#[derive(Clone, Debug)]
pub struct TuneOptions {
    /// 一个 collection 至少要有多少条反馈才给建议。
    pub min_samples: usize,
    /// 单次调整的最大幅度(绝对值)。
    pub max_delta: f64,
    /// 最多读多少条反馈。
    pub limit: u32,
    /// 小于这个幅度的建议直接丢弃(避免来回抖)。
    pub min_delta: f64,
}

impl Default for TuneOptions {
    fn default() -> Self {
        Self {
            min_samples: 5,
            max_delta: 0.2,
            limit: 5_000,
            min_delta: 0.05,
        }
    }
}

/// 一组(collection, kind, 路径前缀)的有用率。
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct UsefulnessGroup {
    /// collection 名。
    pub collection: String,
    /// 记录种类(`code` / `doc` / `insight`)。
    pub kind: String,
    /// 路径前缀(相对路径的第一段;insight 没有路径,为空)。
    pub prefix: String,
    /// 反馈条数。
    pub total: usize,
    /// 有用条数。
    pub useful: usize,
    /// 有用率(0..1)。
    pub rate: f64,
}

/// 一条权重调整建议。
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct WeightSuggestion {
    /// collection 名。
    pub collection: String,
    /// 当前权重。
    pub current: f64,
    /// 建议权重(已夹在 ±`max_delta` 与 [0.2, 2.0] 内)。
    pub suggested: f64,
    /// 调整量(`suggested - current`)。
    pub delta: f64,
    /// 样本数。
    pub samples: usize,
    /// 该 collection 的有用率。
    pub useful_rate: f64,
    /// 给用户看的一句话理由。
    pub reason: String,
}

/// 一次调权计划的输出。
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
pub struct TunePlan {
    /// 读到的反馈条数。
    pub feedback: usize,
    /// 能对上记录的反馈条数(对不上的说明条目已被删除)。
    pub matched: usize,
    /// 全局有用率。
    pub overall_rate: f64,
    /// 分组统计(按 collection / kind / prefix 排序)。
    pub groups: Vec<UsefulnessGroup>,
    /// 权重建议。
    pub suggestions: Vec<WeightSuggestion>,
    /// 没给建议的原因(样本不足 / 幅度太小 / 记录对不上)。
    pub skipped: Vec<String>,
}

/// 反馈调权服务。
pub struct FeedbackTuning {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    options: TuneOptions,
}

impl FeedbackTuning {
    /// 构造。
    pub fn new(meta: Arc<dyn MetaStore>, store: Arc<dyn VectorStore>) -> Self {
        Self {
            meta,
            store,
            options: TuneOptions::default(),
        }
    }

    /// 换参数。
    pub fn with_options(mut self, options: TuneOptions) -> Self {
        self.options = options;
        self
    }

    /// 计算调权计划(纯读)。
    pub async fn plan(&self, current_weights: &BTreeMap<String, f64>) -> Result<TunePlan> {
        let feedback = self.read_feedback().await?;
        let mut plan = TunePlan {
            feedback: feedback.len(),
            ..TunePlan::default()
        };
        if feedback.is_empty() {
            plan.skipped.push("还没有任何反馈".to_owned());
            return Ok(plan);
        }

        // item_id → (collection, kind, source)。按 collection 分批查记录:
        // feedback 里的 id 是记录 id,只有 LanceDB 行上才有 kind / source。
        let mut located: BTreeMap<String, (String, RecordKind, String)> = BTreeMap::new();
        let ids: Vec<String> = feedback.iter().map(|item| item.item_id.clone()).collect();
        for collection in CollectionRepo::list(self.meta.as_ref()).await? {
            let rows = self.store.get(&collection.active_table, &ids).await?;
            for row in rows {
                located.insert(
                    row.id.clone(),
                    (collection.name.clone(), row.kind, row.source.clone()),
                );
            }
        }
        plan.matched = feedback
            .iter()
            .filter(|item| located.contains_key(&item.item_id))
            .count();

        // 分组统计
        let mut buckets: BTreeMap<(String, String, String), (usize, usize)> = BTreeMap::new();
        for item in &feedback {
            let Some((collection, kind, source)) = located.get(&item.item_id) else {
                continue;
            };
            let key = (
                collection.clone(),
                kind_name(*kind).to_owned(),
                path_prefix(source),
            );
            let entry = buckets.entry(key).or_insert((0, 0));
            entry.0 += 1;
            if item.useful {
                entry.1 += 1;
            }
        }
        plan.groups = buckets
            .into_iter()
            .map(
                |((collection, kind, prefix), (total, useful))| UsefulnessGroup {
                    collection,
                    kind,
                    prefix,
                    total,
                    useful,
                    rate: useful as f64 / total.max(1) as f64,
                },
            )
            .collect();

        // 按 collection 汇总(权重是按 collection 生效的)
        let mut per_collection: BTreeMap<String, (usize, usize)> = BTreeMap::new();
        for group in &plan.groups {
            let entry = per_collection
                .entry(group.collection.clone())
                .or_insert((0, 0));
            entry.0 += group.total;
            entry.1 += group.useful;
        }
        let total: usize = per_collection.values().map(|(total, _)| *total).sum();
        let useful: usize = per_collection.values().map(|(_, useful)| *useful).sum();
        plan.overall_rate = useful as f64 / total.max(1) as f64;

        for (collection, (samples, useful)) in per_collection {
            let current = current_weights.get(&collection).copied().unwrap_or(1.0);
            match suggest_for(
                &collection,
                samples,
                useful,
                plan.overall_rate,
                current,
                &self.options,
            ) {
                Ok(suggestion) => plan.suggestions.push(suggestion),
                Err(reason) => plan.skipped.push(reason),
            }
        }
        plan.suggestions.sort_by(|left, right| {
            right
                .delta
                .abs()
                .partial_cmp(&left.delta.abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(plan)
    }

    async fn read_feedback(&self) -> Result<Vec<Feedback>> {
        let mut all = Vec::new();
        let page_size = 200u32;
        let mut offset = 0u32;
        while (all.len() as u32) < self.options.limit {
            let page = FeedbackRepo::list(self.meta.as_ref(), Page::new(page_size, offset)).await?;
            let fetched = page.len() as u32;
            all.extend(page);
            if fetched < page_size {
                break;
            }
            offset += fetched;
        }
        all.truncate(self.options.limit as usize);
        Ok(all)
    }
}

/// 单个 collection 的建议决策(抽成纯函数便于单测)。
///
/// 返回 `Err(reason)` 表示“不给建议”,`Ok(suggestion)` 表示建议调整。
fn suggest_for(
    collection: &str,
    samples: usize,
    useful: usize,
    overall_rate: f64,
    current: f64,
    options: &TuneOptions,
) -> std::result::Result<WeightSuggestion, String> {
    // `_global` 的权重走 `[search] global_weight`,写进 `collection_weights` 不生效
    if collection == "_global" {
        return Err("_global:权重由 [search] global_weight 决定,不在这里调".to_owned());
    }
    if samples < options.min_samples {
        return Err(format!(
            "{collection}:只有 {samples} 条反馈(至少 {} 条才调)",
            options.min_samples
        ));
    }
    let rate = useful as f64 / samples as f64;
    let raw = (rate - overall_rate) * 0.5;
    let delta = raw.clamp(-options.max_delta, options.max_delta);
    // 总权重保持在 1.0 ± max_delta 以内:反复点“应用”时不会一路漂到 0.2 / 2.0
    let lower = (1.0 - options.max_delta).max(0.2);
    let upper = (1.0 + options.max_delta).min(2.0);
    let suggested = (current + delta).clamp(lower, upper);
    let actual: f64 = (suggested - current).round_to();
    if actual.abs() < options.min_delta {
        return Err(format!(
            "{collection}:有用率 {:.0}% 与全局 {:.0}% 差得太小,不调",
            rate * 100.0,
            overall_rate * 100.0
        ));
    }
    Ok(WeightSuggestion {
        collection: collection.to_owned(),
        current,
        suggested: (current + actual).clamp(lower, upper),
        delta: actual,
        samples,
        useful_rate: rate,
        reason: format!(
            "有用率 {:.0}%(全局 {:.0}%,{samples} 条)",
            rate * 100.0,
            overall_rate * 100.0
        ),
    })
}

/// 保留两位小数。
trait RoundTo {
    /// 四舍五入到两位小数。
    fn round_to(self) -> f64;
}

impl RoundTo for f64 {
    fn round_to(self) -> f64 {
        (self * 100.0).round() / 100.0
    }
}

/// 记录种类的字符串形式。
fn kind_name(kind: RecordKind) -> &'static str {
    match kind {
        RecordKind::Code => "code",
        RecordKind::Doc => "doc",
        RecordKind::Insight => "insight",
        RecordKind::External => "external",
        RecordKind::Summary => "summary",
    }
}

/// 路径前缀:相对路径的第一段(文件在根目录时为空)。
fn path_prefix(source: &str) -> String {
    if source.starts_with("insight:") {
        return String::new();
    }
    match source.split_once('/') {
        Some((head, _)) => head.to_owned(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_prefix_takes_the_first_segment() {
        assert_eq!(path_prefix("src/main.rs"), "src");
        assert_eq!(path_prefix("README.md"), "");
        assert_eq!(path_prefix("insight:ins_1"), "");
    }

    #[test]
    fn global_collection_is_never_suggested() {
        // `_global` 的权重由 `[search] global_weight` 决定
        let options = TuneOptions::default();
        let error = suggest_for("_global", 20, 20, 0.5, 0.8, &options).unwrap_err();
        assert!(error.contains("global_weight"), "{error}");
    }

    #[test]
    fn weight_stays_within_one_plus_minus_max_delta() {
        // 反复应用也不会漂到 0.2 / 2.0:总权重夹在 1.0 ± max_delta
        let options = TuneOptions::default();
        let mut current = 1.0;
        let mut steps = 0;
        // 一直“应用”到不再给建议为止:权重只能停在上界,不会继续往外走
        while let Ok(suggestion) = suggest_for("proj_a", 20, 20, 0.0, current, &options) {
            current = suggestion.suggested;
            steps += 1;
            assert!(current <= 1.2 + 1e-9, "总权重不应超过 1.2,当前 {current}");
            assert!(steps < 10, "不应无限给建议");
        }
        assert_eq!(current, 1.2, "夹到上界后不再漂移");
    }

    #[test]
    fn too_few_samples_are_rejected_by_the_pure_decision() {
        let options = TuneOptions::default();
        assert!(suggest_for("proj_a", 4, 4, 0.5, 1.0, &options).is_err());
        assert!(suggest_for("proj_a", 5, 5, 0.5, 1.0, &options).is_ok());
    }

    #[test]
    fn delta_is_clamped_and_rounded() {
        // 直接验证夹取逻辑:0.9 的差 * 0.5 = 0.45 → 夹到 max_delta 0.2
        let raw: f64 = (1.0 - 0.0) * 0.5;
        assert_eq!(raw.clamp(-0.2, 0.2), 0.2);
        assert_eq!(0.1234_f64.round_to(), 0.12);
    }
}
