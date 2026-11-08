//! `kb eval`:黄金查询集评测。
//!
//! 输出 hit@1 / hit@5 / MRR 以及每条查询的实际排名。
//!
//! 评测还要「说得住」:
//! - **预检**:collection 不存在、期望的文件不在库里、用例没写 `expect` 的,一律先摘出来;
//!   这些用例不管检索做得多好都只会记「未命中」,留在分母里就是把命中率往下拉,
//!   42.9% 这种数字一半是黄金集过期而不是检索退步。
//! - **随机**:每次按 `seed` 打乱用例顺序(并可选抽 N 条),同一个 seed + 同一份黄金集给出同一批用例,
//!   换了 seed 就是另一批——固定顺序的 7 条用例容易被「记住」,测出来的不是真实分布。
//! - **可比**:结果里带 `set_hash`(这一批用例的指纹)与 `k`,两次评测只有在两者都相同时也才谈得上谁高谁低。
//! - **区间**:命中率是比例,给出 Wilson 95% 区间;7 条用例全中,真实命中率的下界也只有 65%。
//! - **不测自己**:黄金集文件若在索引根里(比如就放在被索引的仓库里),它的正文就是每条查询的原话,
//!   检索会把「黄金集自己」排在最前面顶掉真答案。评分时按路径把这条结果剔掉,并把次数报出来。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use kb_core::KbError;
use kb_core::config::Config;
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{CollectionRepo, FileRepo, MetaStore, ProjectRepo};
use kb_service::search::{SearchOptions, SearchRequest, SearchService};
use serde::Deserialize;

use crate::error::CliError;
use crate::runtime::Embedded;

/// `kb eval` 的参数。
#[derive(Clone, Debug)]
pub struct EvalArgs {
    /// 黄金集路径(默认 `eval/golden.example.toml`)。
    pub set: Option<PathBuf>,
    /// 评测的 k(默认 5)。
    pub k: Option<usize>,
    /// 输出 JSON。
    pub json: bool,
    /// 允许在降级(只做全文检索)状态下评测。
    pub allow_degraded: bool,
    /// 按文件格式拆分命中率。
    pub by_format: bool,
    /// 从黄金集里随机抽 N 条(默认全部);配 `--seed` 可复现同一批。
    pub sample: Option<usize>,
    /// 随机种子(默认取当前毫秒时间戳,会写进结果里)。
    pub seed: Option<u64>,
    /// 有无效用例(集合 / 期望文件不存在)时仍按有效用例算分,不以退出码 6 报告。
    pub allow_invalid: bool,
    /// 重排:on / off / auto(默认按配置);A/B 对比时两次必须显式给同一个值。
    pub rerank: crate::cli::RerankFlag,
}

/// 一条黄金查询。
#[derive(Clone, Debug, Deserialize)]
pub struct GoldenCase {
    /// 查询串。
    pub query: String,
    /// 在哪个 collection 里检索。
    pub collection: String,
    /// 命中条件(任一满足即算命中)。
    #[serde(default)]
    pub expect: Vec<Expectation>,
}

/// 命中条件。
#[derive(Clone, Debug, Deserialize)]
pub struct Expectation {
    /// 记录的 source。
    pub source: String,
    /// title 里必须包含的片段。
    #[serde(default)]
    pub title_contains: Option<String>,
}

/// 黄金集文件。
#[derive(Clone, Debug, Default, Deserialize)]
pub struct GoldenSet {
    /// 全部用例。
    #[serde(default)]
    pub case: Vec<GoldenCase>,
}

/// 单条评测结果。
#[derive(Clone, Debug)]
pub struct CaseResult {
    /// 查询。
    pub query: String,
    /// 期望命中的排名(1 起),未命中为 `None`。
    pub rank: Option<usize>,
    /// 实际返回的前几条(未命中时用来说明)。
    pub top: Vec<String>,
    /// 黄金集里期望的源文件(前端按扩展名做“按格式拆分”的统计)。
    pub expect: Option<String>,
}

/// 一种格式的统计。
#[derive(Clone, Debug, PartialEq)]
pub struct FormatStat {
    /// 格式(扩展名小写;没有期望源时是 `未标注`)。
    pub format: String,
    /// 用例数。
    pub total: usize,
    /// 命中(rank ≤ k)的用例数。
    pub hits: usize,
    /// MRR。
    pub mrr: f64,
}

/// 按期望源的扩展名分组统计(`--by-format`)。
pub fn by_format(results: &[CaseResult], k: usize) -> Vec<FormatStat> {
    let mut buckets: std::collections::BTreeMap<String, (usize, usize, f64)> =
        std::collections::BTreeMap::new();
    for result in results {
        let format = result
            .expect
            .as_deref()
            .and_then(|source| source.rsplit_once('.'))
            .map(|(_, ext)| ext.to_ascii_lowercase())
            .filter(|ext| !ext.is_empty())
            .unwrap_or_else(|| "未标注".to_owned());
        let entry = buckets.entry(format).or_insert((0, 0, 0.0));
        entry.0 += 1;
        if let Some(rank) = result.rank {
            if rank <= k {
                entry.1 += 1;
            }
            entry.2 += 1.0 / rank as f64;
        }
    }
    buckets
        .into_iter()
        .map(|(format, (total, hits, reciprocal))| FormatStat {
            format,
            total,
            hits,
            mrr: reciprocal / total.max(1) as f64,
        })
        .collect()
}

// ---------------------------------------------------------------- 预检:黄金集还对得上库吗

/// 一条用例被判无效的原因。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProblemKind {
    /// 用例所在的 collection 不存在(改名 / 删库 / 写错字)。
    MissingCollection,
    /// 期望的源文件不在这个 collection 的已索引文件里(改名 / 删了 / 从没入过库)。
    MissingSource,
    /// 用例没写 `expect`:永远不可能命中,属于黄金集自己的缺陷。
    NoExpectation,
}

impl ProblemKind {
    /// 给人看的一句话(命令行与 Web 页共用同一套说法)。
    pub fn text(self) -> &'static str {
        match self {
            Self::MissingCollection => "集合不存在",
            Self::MissingSource => "期望的文件不在库里",
            Self::NoExpectation => "没写应该找到的文件",
        }
    }
}

/// 预检发现的一条问题。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaseProblem {
    /// 出问题的查询。
    pub query: String,
    /// 问题类别。
    pub kind: ProblemKind,
    /// 具体是哪一步对不上(collection 名 / 缺哪个文件)。
    pub detail: String,
}

/// 预检:collection 存不存在、期望的文件在不在库里。
///
/// 这件事必须在检索之前做:无效用例在检索侧只会表现为「没找到」,
/// 和「检索退步了」长得一模一样,历史里的 42.9% 就是这么来的。
async fn preflight(meta: &dyn MetaStore, golden: &GoldenSet) -> kb_core::Result<Vec<CaseProblem>> {
    let mut problems = Vec::new();
    // 每个 collection 只查一次库:黄金集里同一个项目往往有十几条用例,逐条查会把文件表扫好多遍
    let mut cache: std::collections::HashMap<String, Option<HashSet<String>>> =
        std::collections::HashMap::new();
    for case in &golden.case {
        if case.expect.is_empty() {
            problems.push(CaseProblem {
                query: case.query.clone(),
                kind: ProblemKind::NoExpectation,
                detail: case.collection.clone(),
            });
        }
        if !cache.contains_key(&case.collection) {
            let indexed = match CollectionRepo::get(meta, &case.collection).await? {
                Some(_) => Some(
                    FileRepo::list_paths(meta, &case.collection)
                        .await?
                        .into_iter()
                        .collect(),
                ),
                None => None,
            };
            cache.insert(case.collection.clone(), indexed);
        }
        let Some(indexed) = cache.get(&case.collection).and_then(Option::as_ref) else {
            problems.push(CaseProblem {
                query: case.query.clone(),
                kind: ProblemKind::MissingCollection,
                detail: case.collection.clone(),
            });
            continue;
        };
        for expect in &case.expect {
            if !indexed.contains(&expect.source) {
                problems.push(CaseProblem {
                    query: case.query.clone(),
                    kind: ProblemKind::MissingSource,
                    detail: format!("{}(期望 {})", case.collection, expect.source),
                });
            }
        }
    }
    Ok(problems)
}

// ---------------------------------------------------------------- 随机:同一 seed 给同一批用例

/// 评测用的随机源(splitmix64)。只用它把用例打乱 / 抽样,不用于任何安全用途。
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// `0..n` 的均匀整数(拒绝采样,避免取模把小的那几个数抽得更频繁)。
    fn below(&mut self, n: usize) -> usize {
        debug_assert!(n > 0);
        let n = n as u64;
        let zone = u64::MAX - (u64::MAX % n);
        loop {
            let value = self.next_u64();
            if value < zone {
                return (value % n) as usize;
            }
        }
    }
}

/// 按 `seed` 打乱再从池子里抽 `sample` 条(不传抽样就是全部)。
///
/// 顺序也要打乱:固定顺序时前几条查询的耗时、缓存命中、模型预热都会偏向排在前面的用例。
pub fn draw_cases(cases: &[GoldenCase], sample: Option<usize>, seed: u64) -> Vec<GoldenCase> {
    let mut pool: Vec<GoldenCase> = cases.to_vec();
    let mut rng = Rng::new(seed);
    for tail in (1..pool.len()).rev() {
        let pick = rng.below(tail + 1);
        pool.swap(tail, pick);
    }
    if let Some(size) = sample {
        pool.truncate(size.min(pool.len()));
    }
    pool
}

/// 这一批用例的指纹(与书写顺序无关)。
///
/// 两次评测只有在 `k` 与指纹都相同时才可比:用例换了、抽样换了,命中率的差就不是检索的差。
pub fn case_set_hash(cases: &[GoldenCase]) -> String {
    // 分隔符用正文里不会出现的控制字符,避免 "/a b" 与 "/a" + "b" 这类拼接歧义
    let mut keys: Vec<String> = cases
        .iter()
        .map(|case| {
            let mut expects: Vec<String> = case
                .expect
                .iter()
                .map(|expect| {
                    let mut text = expect.source.clone();
                    text.push('\u{0}');
                    text.push_str(expect.title_contains.as_deref().unwrap_or_default());
                    text
                })
                .collect();
            expects.sort();
            let mut key = case.collection.clone();
            key.push('\u{0}');
            key.push_str(&case.query);
            key.push('\u{0}');
            key.push_str(&expects.join("\u{1}"));
            key
        })
        .collect();
    keys.sort();
    kb_core::hash::xxh3_128_hex(keys.join("\u{2}").as_bytes())
}

// ---------------------------------------------------------------- 区间:这批用例能证明多少

/// 命中率的 Wilson 95% 置信区间(小样本 / 极端比例下也说得通,不像正态近似会算出负数)。
///
/// 7 条用例全中,真实命中率的下界也只有 65% 左右——区间宽度就是「这批用例能证明多少」。
pub fn wilson_interval(hits: usize, total: usize) -> (f64, f64) {
    if total == 0 {
        return (0.0, 1.0);
    }
    const Z: f64 = 1.96;
    let n = total as f64;
    let p = hits as f64 / n;
    let z2 = Z * Z;
    let denom = 1.0 + z2 / n;
    let centre = p + z2 / (2.0 * n);
    let margin = Z * ((p * (1.0 - p) / n) + z2 / (4.0 * n * n)).sqrt();
    (
        ((centre - margin) / denom).max(0.0),
        ((centre + margin) / denom).min(1.0),
    )
}

/// 黄金集文件自己在索引里时的身份(集合 + 集合内的相对路径)。
///
/// 黄金集常放在被索引的仓库里(`eval/golden.toml`),它的正文就是每条查询的原话:
/// 检索时它会被当成一条「完美匹配」顶在最前面,真答案被挤下去,命中率凭空变差。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelfRef {
    /// 索引里的 collection 名。
    pub collection: String,
    /// 集合内的相对路径(与检索结果里的 `source` 同一种写法)。
    pub source: String,
}

/// 找黄金集文件在索引里的身份;不在任何项目根里(或该项目还没建集合)就是 `None`。
pub async fn self_ref(meta: &dyn MetaStore, set_path: &Path) -> kb_core::Result<Option<SelfRef>> {
    // 用绝对路径调用 match_cwd(最长前缀匹配),再用相对路径对齐检索结果里的 source
    let Ok(abs) = set_path.canonicalize() else {
        return Ok(None);
    };
    let Some(project) = ProjectRepo::match_cwd(meta, &abs.to_string_lossy()).await? else {
        return Ok(None);
    };
    let Some(source) = rel_source(&project.root_path, &abs) else {
        return Ok(None);
    };
    let collection = format!("proj_{}", project.slug);
    // 项目在库里但集合还没建(刚注册没索引过):照旧当它不在索引里
    if CollectionRepo::get(meta, &collection).await?.is_none() {
        return Ok(None);
    }
    Ok(Some(SelfRef { collection, source }))
}

/// 文件在项目根里的相对路径(与检索结果里的 `source` 同一种写法);不在根里就是 `None`。
fn rel_source(root_path: &str, abs: &Path) -> Option<String> {
    let rel = abs.strip_prefix(root_path).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// `evaluate` 跑完之后的附带计数。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct EvalCounters {
    /// 嵌入器不可用的用例数(这些用例的数字不能当基线)。
    pub degraded_cases: usize,
    /// 被剔掉的「黄金集自己」命中次数。
    pub self_hits: usize,
    /// 真的重排过的用例数(`rerank = on` 时应当等于用例数)。
    pub reranked_cases: usize,
}

/// 一次评测实际要跑什么:先预检摘掉无效用例,再按 seed 打乱 / 抽样。
pub struct Prepared {
    /// 真正要跑的用例(已剔除无效用例、已打乱、已抽样)。
    pub cases: Vec<GoldenCase>,
    /// 预检发现的问题(被剔除的用例一条一条列出来)。
    pub problems: Vec<CaseProblem>,
    /// 黄金集里的总条数。
    pub pool: usize,
    /// 抽样的条数(没抽样是 `None`)。
    pub sample: Option<usize>,
    /// 本次用的随机种子。
    pub seed: u64,
}

impl Prepared {
    /// 这一批用例的指纹。
    pub fn set_hash(&self) -> String {
        case_set_hash(&self.cases)
    }

    /// 状态:`ok` / `partial`(剔过无效用例)/ `invalid_set`(一条有效的都没有)。
    pub fn status(&self) -> &'static str {
        if self.cases.is_empty() {
            "invalid_set"
        } else if self.problems.is_empty() {
            "ok"
        } else {
            "partial"
        }
    }
}

/// 预检 + 打乱 + 抽样。
pub async fn prepare(
    meta: &dyn MetaStore,
    golden: &GoldenSet,
    sample: Option<usize>,
    seed: Option<u64>,
) -> kb_core::Result<Prepared> {
    // 抽 0 条不是「跑一次空评测」,是参数写错了:当场报错,别让它伪装成「一条有效用例都没有」
    if sample == Some(0) {
        return Err(KbError::InvalidInput(
            "抽样条数至少为 1(要跑全部就别传抽样条数)".to_owned(),
        ));
    }
    let problems = preflight(meta, golden).await?;
    // 按查询串去重:黄金集里重复的查询本来就说不清该命中哪一条,一起摘掉
    let bad: HashSet<&str> = problems
        .iter()
        .map(|problem| problem.query.as_str())
        .collect();
    let valid: Vec<GoldenCase> = golden
        .case
        .iter()
        .filter(|case| !bad.contains(case.query.as_str()))
        .cloned()
        .collect();
    // 没给 seed 就现取一个并写进结果:想复现这一批,把它抄回去即可
    let seed = seed.unwrap_or_else(|| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default()
    });
    Ok(Prepared {
        cases: draw_cases(&valid, sample, seed),
        problems,
        pool: golden.case.len(),
        sample,
        seed,
    })
}

/// 无效用例打给人看的一行(命令行与 Web 共用)。
pub fn problem_text(problem: &CaseProblem) -> String {
    format!(
        "[{}] {} → {}",
        problem.kind.text(),
        problem.query,
        problem.detail
    )
}

/// 黄金集的候选路径(先看 `KB_HOME/eval/`,再看仓库里的示例集)。
pub fn golden_paths(eval_dir: &Path) -> Vec<PathBuf> {
    vec![
        eval_dir.join("golden.toml"),
        PathBuf::from("eval/golden.example.toml"),
    ]
}

/// 条命中是不是「黄金集自己」(它的正文就是这条查询的原话)。
fn is_self_hit(hit_self: Option<&SelfRef>, hit: &kb_core::model::SearchHit) -> bool {
    // 比的是命中自己的 collection:同名文件在别的集合里不算「自己」
    hit_self.is_some_and(|me| me.collection == hit.collection && me.source == hit.source)
}

/// 这条用例排第几(1 起)以及剔掉了几条「黄金集自己」。
///
/// 两条评测路径(`evaluate` 与 `run_inline`)共用这一段:口径只写一份,
/// 免得一处剔了自命中、另一处没剔,前后对比又变成假的。
pub fn rank_of(
    case: &GoldenCase,
    hits: &[kb_core::model::SearchHit],
    hit_self: Option<&SelfRef>,
) -> (Option<usize>, usize) {
    let mut seen = 0usize;
    let mut self_hits = 0usize;
    for hit in hits {
        if is_self_hit(hit_self, hit) {
            self_hits += 1;
            continue;
        }
        seen += 1;
        let matched = case.expect.iter().any(|expect| {
            expect.source == hit.source
                && expect.title_contains.as_deref().is_none_or(|needle| {
                    hit.title
                        .as_deref()
                        .is_some_and(|title| title.contains(needle))
                })
        });
        if matched {
            return (Some(seen), self_hits);
        }
    }
    (None, self_hits)
}

/// 用已有的检索服务跑一遍黄金集。
///
/// `kb eval` 与 `tune_retrieval` 的前后对比共用这一段,避免两处各写一份评测口径。
pub async fn evaluate(
    service: &SearchService,
    golden: &GoldenSet,
    k: usize,
    hit_self: Option<&SelfRef>,
    rerank: Option<bool>,
) -> Result<(Vec<CaseResult>, EvalCounters), CliError> {
    let mut results = Vec::with_capacity(golden.case.len());
    let mut counters = EvalCounters::default();
    // 队列非空也算降级,即使待补块没有进 top-k:它已经从候选集里消失,
    // 命中率可能因此下降。只看响应里的 `degraded` 会漏掉「队列有积压但没命中」的评测。
    let mut pending_collections: HashSet<String> = HashSet::new();
    for case in &golden.case {
        if pending_collections.contains(&case.collection) {
            continue;
        }
        if service.has_pending(&case.collection).await? {
            pending_collections.insert(case.collection.clone());
        }
    }
    for case in &golden.case {
        let response = service
            .search(SearchRequest {
                query: case.query.clone(),
                collections: vec![case.collection.clone()],
                k: Some(k),
                explain: false,
                rerank,
            })
            .await?;
        // 黄金集自己被检索到时先剔掉再排名:它的正文就是这条查询的原话,
        // 留着会让「自己命中自己」占掉第一名,把真答案顶到 k 之外
        let (rank, self_hits) = rank_of(case, &response.hits, hit_self);
        counters.self_hits += self_hits;
        let hits: Vec<_> = response
            .hits
            .iter()
            .filter(|hit| !is_self_hit(hit_self, hit))
            .collect();
        // 嵌入器不可用(纯全文检索)和待补向量队列非空都算“评测数字不能当基线”:
        // 前者是整段向量缺失,后者是部分块只按全文排序,两者都会让命中率与基线不可比。
        // 重排不可用只影响排序,不算检索降级。
        let queue_pending = pending_collections.contains(&case.collection);
        if counts_as_degraded(queue_pending, response.degraded.as_deref()) {
            counters.degraded_cases += 1;
        }
        // 重排是否真的跑过由检索服务如实给出:`mode = auto` 且没装重排器时它是 false
        if response.reranked {
            counters.reranked_cases += 1;
        }
        results.push(CaseResult {
            query: case.query.clone(),
            rank,
            top: hits
                .iter()
                .take(k)
                .map(|hit| match hit.title.as_deref() {
                    Some(title) => format!("{} · {title}", hit.source),
                    None => format!(
                        "{} · {}",
                        hit.source,
                        hit.symbol.clone().unwrap_or_default()
                    ),
                })
                .collect(),
            expect: case.expect.first().map(|expect| expect.source.clone()),
        });
    }
    Ok((results, counters))
}

/// 这条用例是否算「降级状态下评测」。
///
/// 队伍里有待补块就算,即使它没进 top-k:那一条已经从候选集里消失,分数不再可比。
/// 响应里的 `embedder*` / `vector_pending` 也计入,两个来源只由调用方加一次。
fn counts_as_degraded(queue_pending: bool, reason: Option<&str>) -> bool {
    queue_pending
        || reason.is_some_and(|reason| reason.starts_with("embedder") || reason == "vector_pending")
}

/// 执行评测。
pub async fn run(paths: &KbPaths, config: &Config, args: EvalArgs) -> Result<ExitCode, CliError> {
    // 没给 `--set` 时先看 `KB_HOME/eval/golden.toml`,再看仓库里的示例集。
    // 以前只按 cwd 找示例集:在生产机上随手跑一次 `kb eval`,量的是示例集对生产库的命中率
    // (示例集的集合名大多不存在,报一堆「无效用例」),而自己那份黄金集根本没用上。
    let set_path = match &args.set {
        Some(path) => path.clone(),
        None => golden_paths(paths.eval_dir())
            .into_iter()
            .find(|candidate| candidate.exists())
            .unwrap_or_else(|| PathBuf::from("eval/golden.example.toml")),
    };
    let golden = load(&set_path)?;
    if golden.case.is_empty() {
        return Err(
            KbError::InvalidInput(format!("{} 里没有 [[case]]", set_path.display())).into(),
        );
    }
    let k = args.k.unwrap_or(5).max(1);

    let runtime = Embedded::open(paths, config, false).await?;
    // 预热:表句柄与倒排索引(与守护进程常驻一致)
    let store = runtime.store();
    let mut collections: Vec<String> = golden
        .case
        .iter()
        .map(|case| case.collection.clone())
        .collect();
    collections.sort();
    collections.dedup();
    for name in &collections {
        if let Some(collection) = CollectionRepo::get(runtime.meta.as_ref(), name).await? {
            let _ = store
                .search(
                    &collection.active_table,
                    &kb_core::model::StoreQuery {
                        mode: kb_core::model::SearchMode::Fts,
                        text: Some("kb".to_owned()),
                        vector: None,
                        filter: kb_core::filter::Filter::default(),
                        limit: 1,
                        offset: 0,
                        with_vector: false,
                    },
                )
                .await;
        }
    }
    // 评测必须跑真实的混合检索:模型加载失败就直接失败,不要静默降级
    runtime
        .warm_embedder(std::time::Duration::from_secs(60))
        .await?;

    let service = SearchService::new(
        runtime.meta.clone(),
        store,
        runtime.embedder.clone(),
        crate::runtime::build_reranker(config),
        SearchOptions::from_config(config),
    );

    // 先预检再把用例打乱(可能再抽样):无效用例不能进分母,固定顺序不能当基准
    let prepared = prepare(runtime.meta.as_ref(), &golden, args.sample, args.seed).await?;
    let problems_text: Vec<String> = prepared.problems.iter().map(problem_text).collect();
    if !problems_text.is_empty() {
        eprintln!(
            "警告:黄金集里有 {} 条用例无效,已从分母剔除(集合或期望文件不存在时,检索再好也只会记未命中):",
            prepared.problems.len()
        );
        for line in &problems_text {
            eprintln!("  {line}");
        }
    }
    if prepared.cases.is_empty() {
        // 分母是空的时候 --allow-invalid 也救不了:没有用例就没有命中率这回事
        eprintln!(
            "黄金集 {} 里没有一条能跑的用例(共 {} 条):先把上面列出的问题修好再跑(分母是空的,加 --allow-invalid 也没用)",
            set_path.display(),
            prepared.pool
        );
        return Ok(ExitCode::from(6));
    }
    let selected = GoldenSet {
        case: prepared.cases.clone(),
    };

    let started = Instant::now();
    // 黄金集文件自己若在索引根里(比如就放在被索引的仓库),它的正文就是每条查询的原话:
    // 先查清它的身份,评分时按路径剔掉,否则「自己命中自己」会把真答案顶下去
    let hit_self = self_ref(runtime.meta.as_ref(), &set_path).await?;
    let (results, counters) = evaluate(
        &service,
        &selected,
        k,
        hit_self.as_ref(),
        args.rerank.to_request(),
    )
    .await?;
    let degraded_cases = counters.degraded_cases;
    let took_ms = started.elapsed().as_millis();
    let metrics = metrics_of(&results, k);
    let hit_at_1 = metrics.hit_at_1;
    let hit_at_k = metrics.hit_at_k;
    let mrr = metrics.mrr;
    let hits = results
        .iter()
        .filter(|result| result.rank.is_some_and(|rank| rank <= k))
        .count();
    let (ci_low, ci_high) = wilson_interval(hits, results.len());
    let set_hash = prepared.set_hash();

    if counters.self_hits > 0 {
        eprintln!(
            "注意:黄金集自己也在索引里({}),这次有 {} 条结果命中它本身,已从结果里剔除;\
             想让分数彻底干净,把黄金集移出索引根,或在项目的排除规则里加上它",
            hit_self
                .as_ref()
                .map(|me| format!("{}: {}", me.collection, me.source))
                .unwrap_or_default(),
            counters.self_hits
        );
    }
    let degraded = (degraded_cases > 0).then(|| "degraded".to_owned());
    if degraded.is_some() && !args.allow_degraded {
        eprintln!(
            "警告:{degraded_cases}/{} 条查询是在降级状态(嵌入器不可用或部分向量待补)下评测的,\
             数字不能当基线;确认要在降级状态下评测请加 --allow-degraded",
            results.len()
        );
    }
    let formats = by_format(&results, k);
    if args.json {
        let cases: Vec<serde_json::Value> = results
            .iter()
            .map(|result| {
                serde_json::json!({
                    "query": result.query,
                    "rank": result.rank,
                    "top": result.top,
                })
            })
            .collect();
        let value = serde_json::json!({
            "ok": true,
            "data": {
                "status": prepared.status(),
                "hit_at_1": hit_at_1,
                "hit_at_k": hit_at_k,
                "hit_at_k_ci95": [ci_low, ci_high],
                "k": k,
                "seed": prepared.seed,
                "sample": prepared.sample,
                "pool": prepared.pool,
                "set_hash": set_hash,
                "valid_cases": results.len(),
                "invalid_cases": problems_text,
                "self_indexed": hit_self.is_some(),
                "self_hits": counters.self_hits,
                // 重排的开关与覆盖面一起给:只看 `mode` 会把「配了自动但没装重排器」当成重排过
                "rerank": args.rerank.as_str(),
                "reranked_cases": counters.reranked_cases,
                "mrr": mrr,
                "cases": cases,
                "by_format": formats
                    .iter()
                    .map(|stat| serde_json::json!({
                        "format": stat.format,
                        "total": stat.total,
                        "hits": stat.hits,
                        "hit_rate": if stat.total == 0 { 0.0 } else { stat.hits as f64 / stat.total as f64 },
                        "mrr": stat.mrr,
                    }))
                    .collect::<Vec<_>>(),
            },
            "meta": {
                "took_ms": took_ms,
                "set": set_path.display().to_string(),
                "degraded": degraded,
                "degraded_cases": degraded_cases,
            },
        });
        println!(
            "{}",
            serde_json::to_string_pretty(&value).unwrap_or_default()
        );
        return Ok(exit_code(
            degraded_cases,
            args.allow_degraded,
            prepared.problems.len(),
            args.allow_invalid,
        ));
    }

    println!(
        "黄金集 {} 条 · 本次跑 {} 条{} · seed {}",
        prepared.pool,
        results.len(),
        match prepared.sample {
            Some(size) => format!("(抽样 {size} 条)"),
            None => String::new(),
        },
        prepared.seed
    );
    println!(
        "命中 {}/{} · hit@1 = {:.2} · hit@{} = {:.2}(95% 区间 {:.0}%–{:.0}%) · MRR = {:.3}",
        hits,
        results.len(),
        hit_at_1,
        k,
        hit_at_k,
        ci_low * 100.0,
        ci_high * 100.0,
        mrr
    );
    // 重排开没开、实际跑了几条,一起说清楚:只看命中率会以为「配置改了」,其实没装上
    println!(
        "重排 {} · 实际重排 {} 条{}",
        match args.rerank {
            crate::cli::RerankFlag::On => "强制开",
            crate::cli::RerankFlag::Off => "强制关",
            crate::cli::RerankFlag::Auto => "按配置",
        },
        counters.reranked_cases,
        if args.rerank == crate::cli::RerankFlag::On && counters.reranked_cases == 0 {
            "(一条都没重排:重排器没装好,先跑 kb accel status 看看)"
        } else {
            ""
        }
    );
    for result in &results {
        match result.rank {
            Some(rank) if rank <= k => println!("[命中 #{rank}] {}", result.query),
            Some(rank) => println!("[超出 top{k} · #{rank}] {}", result.query),
            None => {
                println!("[未中] {}", result.query);
                for (index, top) in result.top.iter().enumerate() {
                    println!("    {}: {top}", index + 1);
                }
            }
        }
    }
    if args.by_format && !formats.is_empty() {
        println!("按格式:");
        for stat in &formats {
            println!(
                "  {:<10} {:>3}/{:<3} 命中率 {:>5.1}% · MRR {:.3}",
                stat.format,
                stat.hits,
                stat.total,
                if stat.total == 0 {
                    0.0
                } else {
                    stat.hits as f64 * 100.0 / stat.total as f64
                },
                stat.mrr
            );
        }
    }
    println!("耗时 {took_ms} ms(共 {} 条查询)", results.len());
    if degraded_cases > 0 {
        println!("注意:{degraded_cases} 条查询处于降级状态(只做了全文检索)");
    }
    if !prepared.problems.is_empty() {
        println!(
            "注意:{} 条用例无效、已从分母剔除;数字只代表剩下 {} 条的检索效果",
            prepared.problems.len(),
            results.len()
        );
    }
    Ok(exit_code(
        degraded_cases,
        args.allow_degraded,
        prepared.problems.len(),
        args.allow_invalid,
    ))
}

/// 退出码:有无效用例 -> 6(数字不可信,不能当基线);降级 -> 4;否则 0。
///
/// 两种都不允许时以 6 为准:黄金集对不上库是更要紧的问题,
/// 而降级只影响这一次的数字(两者都写进了输出,不会丢信息)。
fn exit_code(
    degraded_cases: usize,
    allow_degraded: bool,
    invalid_cases: usize,
    allow_invalid: bool,
) -> ExitCode {
    ExitCode::from(exit_code_value(
        degraded_cases,
        allow_degraded,
        invalid_cases,
        allow_invalid,
    ))
}

/// `exit_code` 的纯逻辑部分(退出码本身不好断言,单测直接对着数字)。
fn exit_code_value(
    degraded_cases: usize,
    allow_degraded: bool,
    invalid_cases: usize,
    allow_invalid: bool,
) -> u8 {
    if invalid_cases > 0 && !allow_invalid {
        6
    } else if degraded_cases > 0 && !allow_degraded {
        4
    } else {
        0
    }
}

/// 读取黄金集。
pub fn load(path: &Path) -> Result<GoldenSet, CliError> {
    let text = std::fs::read_to_string(path).map_err(|err| {
        KbError::InvalidInput(format!("读取黄金集 {} 失败: {err}", path.display()))
    })?;
    toml::from_str(&text).map_err(|err| {
        KbError::InvalidInput(format!("解析黄金集 {} 失败: {err}", path.display())).into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn case(query: &str, rank: Option<usize>, expect: Option<&str>) -> CaseResult {
        CaseResult {
            query: query.to_owned(),
            rank,
            top: Vec::new(),
            expect: expect.map(str::to_owned),
        }
    }

    fn hit(source: &str) -> kb_core::model::SearchHit {
        kb_core::model::SearchHit {
            id: source.to_owned(),
            collection: "proj_demo".to_owned(),
            kind: kb_core::model::RecordKind::Doc,
            source: source.to_owned(),
            start_line: None,
            end_line: None,
            symbol: None,
            title: None,
            snippet: String::new(),
            score: 0.0,
            related: Vec::new(),
            explain: None,
            anchor: None,
        }
    }

    fn golden_case(query: &str, expect: &[&str]) -> GoldenCase {
        GoldenCase {
            query: query.to_owned(),
            collection: "proj_demo".to_owned(),
            expect: expect
                .iter()
                .map(|source| Expectation {
                    source: (*source).to_owned(),
                    title_contains: None,
                })
                .collect(),
        }
    }

    /// 黄金集自己的正文就是查询原话:它排第一时必须剔掉,真答案的排名**不能**因此往后挪一格
    #[test]
    fn rank_of_drops_the_golden_set_itself() {
        let me = SelfRef {
            collection: "proj_demo".to_owned(),
            source: "eval/golden.toml".to_owned(),
        };
        let hits = vec![hit("eval/golden.toml"), hit("docs/answer.md")];
        let (rank, self_hits) = rank_of(&golden_case("q", &["docs/answer.md"]), &hits, Some(&me));
        assert_eq!(rank, Some(1), "剔掉自己之后,真答案就是第一名");
        assert_eq!(self_hits, 1);
        // 没给 self_ref(黄金集不在索引里)时不该动结果
        let (rank, self_hits) = rank_of(&golden_case("q", &["docs/answer.md"]), &hits, None);
        assert_eq!(rank, Some(2));
        assert_eq!(self_hits, 0);
        // 同名文件在别的集合里不算「自己」:只认同一个集合里的那一条
        let mut other = hit("eval/golden.toml");
        other.collection = "proj_other".to_owned();
        let (rank, self_hits) = rank_of(
            &golden_case("q", &["eval/golden.toml"]),
            &[other],
            Some(&me),
        );
        assert_eq!(rank, Some(1));
        assert_eq!(self_hits, 0);
    }

    #[test]
    fn rel_source_is_relative_to_the_project_root() {
        assert_eq!(
            rel_source(
                "/srv/workspace/demo",
                Path::new("/srv/workspace/demo/eval/golden.toml")
            )
            .as_deref(),
            Some("eval/golden.toml")
        );
        // 根外面的文件(比如 `KB_HOME/eval/` 里那份)不该被当成索引里的一条
        assert_eq!(
            rel_source(
                "/srv/workspace/demo",
                Path::new("/opt/kb/home/eval/golden.toml")
            ),
            None
        );
    }

    #[test]
    fn run_id_is_six_base36_digits() {
        let id = base36(1_700_000_000_000);
        assert_eq!(id.len(), 6, "{id}");
        assert!(
            id.chars()
                .all(|ch| ch.is_ascii_alphanumeric() && !ch.is_ascii_uppercase())
        );
        // 相差 1 毫秒的两个时间戳不会撞
        assert_ne!(base36(1_700_000_000_000), base36(1_700_000_000_001));
        assert_eq!(base36(0), "000000");
    }

    #[test]
    fn hit_rate_at_counts_ranks_within_n() {
        let results = vec![
            case("q1", Some(1), None),
            case("q2", Some(3), None),
            case("q3", Some(10), None),
            case("q4", None, None),
        ];
        assert_eq!(hit_rate_at(&results, 1), 0.25);
        assert_eq!(hit_rate_at(&results, 3), 0.5);
        assert_eq!(hit_rate_at(&results, 10), 0.75);
        assert_eq!(hit_rate_at(&[], 3), 0.0);
    }

    #[test]
    fn percentile_picks_the_nearest_rank() {
        assert_eq!(percentile(&[], 0.95), 0.0);
        assert_eq!(percentile(&[42.0], 0.95), 42.0);
        // 1..=100 的 p95 落在 95 附近(最近秩法)
        let values: Vec<f64> = (1..=100).map(|value| value as f64).collect();
        assert!((percentile(&values, 0.95) - 95.0).abs() <= 1.0);
        // 乱序输入不影响结果
        assert_eq!(percentile(&[30.0, 10.0, 20.0], 1.0), 30.0);
    }

    #[test]
    fn groups_hit_rate_by_extension() {
        let results = vec![
            case("q1", Some(1), Some("docs/a.pdf")),
            case("q2", Some(3), Some("docs/b.pdf")),
            case("q3", None, Some("docs/c.pdf")),
            case("q4", Some(1), Some("src/lib.rs")),
            case("q5", Some(2), None),
        ];
        let stats = by_format(&results, 5);
        let pdf = stats.iter().find(|s| s.format == "pdf").expect("pdf");
        assert_eq!(pdf.total, 3);
        assert_eq!(pdf.hits, 2, "rank 3 ≤ k=5 也算命中");
        assert!((pdf.mrr - (1.0 + 1.0 / 3.0) / 3.0).abs() < 1e-9, "{pdf:?}");
        let rs = stats.iter().find(|s| s.format == "rs").expect("rs");
        assert_eq!((rs.total, rs.hits), (1, 1));
        let unknown = stats.iter().find(|s| s.format == "未标注").expect("未标注");
        assert_eq!((unknown.total, unknown.hits), (1, 1));
        // k 变小后同一个 rank 不再算命中
        let strict = by_format(&results, 2);
        let pdf = strict.iter().find(|s| s.format == "pdf").expect("pdf");
        assert_eq!(pdf.hits, 1);
    }

    #[test]
    fn parses_the_documented_shape() {
        let text = r#"
[[case]]
query = "双哈希增量索引怎么判断是否需要重新嵌入"
collection = "_global"
expect = [{ source = "ARCHITECTURE.md", title_contains = "14.1" }]

[[case]]
query = "没有 expect 也可以"
collection = "proj_demo"
"#;
        let golden: GoldenSet = toml::from_str(text).expect("解析");
        assert_eq!(golden.case.len(), 2);
        assert_eq!(golden.case[0].expect[0].source, "ARCHITECTURE.md");
        assert_eq!(
            golden.case[0].expect[0].title_contains.as_deref(),
            Some("14.1")
        );
        assert!(golden.case[1].expect.is_empty());
    }

    #[test]
    fn the_example_set_has_twenty_cases() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../eval/golden.example.toml");
        let golden = load(&path).expect("读取示例集");
        assert_eq!(golden.case.len(), 20);
        assert!(
            golden
                .case
                .iter()
                .all(|case| !case.expect.is_empty() && case.collection == "_global")
        );
    }

    fn golden(query: &str, collection: &str, source: &str) -> GoldenCase {
        GoldenCase {
            query: query.to_owned(),
            collection: collection.to_owned(),
            expect: vec![Expectation {
                source: source.to_owned(),
                title_contains: None,
            }],
        }
    }

    fn pool(size: usize) -> Vec<GoldenCase> {
        (0..size)
            .map(|index| golden(&format!("q{index}"), "c", "a.md"))
            .collect()
    }

    fn queries(cases: &[GoldenCase]) -> Vec<String> {
        cases.iter().map(|case| case.query.clone()).collect()
    }

    #[test]
    fn draw_cases_is_reproducible_and_really_shuffles() {
        let cases = pool(20);
        let first = draw_cases(&cases, None, 42);
        assert_eq!(first.len(), 20, "不抽样时全部都要跑");
        assert_eq!(
            queries(&first),
            queries(&draw_cases(&cases, None, 42)),
            "同 seed 同顺序"
        );
        // 20 条恰好戳回原序的概率小到可以当断言(约 1/20!)
        assert_ne!(queries(&first), queries(&cases), "顺序应该被打乱");
        assert_ne!(
            queries(&first),
            queries(&draw_cases(&cases, None, 43)),
            "换 seed 就是另一批顺序"
        );
        // 打乱不能变成丢用例 / 重复用例
        let mut seen = queries(&first);
        seen.sort();
        seen.dedup();
        assert_eq!(seen.len(), 20);
    }

    #[test]
    fn draw_cases_samples_without_replacement() {
        let cases = pool(50);
        let picked = draw_cases(&cases, Some(7), 7);
        assert_eq!(picked.len(), 7);
        let mut names = queries(&picked);
        names.sort();
        names.dedup();
        assert_eq!(names.len(), 7, "抽样不能抽重");
        assert!(
            picked
                .iter()
                .all(|case| cases.iter().any(|item| item.query == case.query)),
            "抽出来的必须是黄金集里的用例"
        );
        // 抽的条数比池子还大就退化成全部
        assert_eq!(draw_cases(&cases[..3], Some(10), 1).len(), 3);
    }

    #[test]
    fn set_hash_ignores_order_but_not_content() {
        let left = golden("q1", "c1", "a.md");
        let right = golden("q2", "c1", "b.md");
        let forward = case_set_hash(&[left.clone(), right.clone()]);
        assert_eq!(
            forward,
            case_set_hash(&[right.clone(), left.clone()]),
            "书写顺序不影响指纹"
        );
        assert_ne!(
            forward,
            case_set_hash(std::slice::from_ref(&left)),
            "少一条就是另一道题"
        );
        let mut changed = right;
        changed.expect[0].source = "c.md".to_owned();
        assert_ne!(
            forward,
            case_set_hash(&[left, changed]),
            "期望文件变了就是另一道题"
        );
        // 抽样后的子集必然不是原来那道题
        let cases = pool(10);
        assert_ne!(
            case_set_hash(&cases),
            case_set_hash(&draw_cases(&cases, Some(3), 9))
        );
    }

    #[test]
    fn wilson_interval_widens_when_the_sample_is_small() {
        // 7 条命中 3 条:约 42.9%,区间的下界离 0 很远、上界离 1 也很远
        let (low, high) = wilson_interval(3, 7);
        assert!((low - 0.158).abs() < 0.01, "{low}");
        assert!((high - 0.750).abs() < 0.01, "{high}");
        // 7 条全中也给不出「一定命中」
        let (low_all, _) = wilson_interval(7, 7);
        assert!(low_all < 0.7, "{low_all}");
        // 样本大了区间才收紧
        let (low_big, high_big) = wilson_interval(70, 70);
        assert!(low_big > low_all && high_big >= low_big, "{low_big}");
        // 空集不能除零
        assert_eq!(wilson_interval(0, 0), (0.0, 1.0));
    }

    #[test]
    fn queue_backlog_counts_as_degraded_even_without_a_pending_hit() {
        assert!(!counts_as_degraded(false, None));
        assert!(counts_as_degraded(true, None), "队列有积压就算降级");
        assert!(counts_as_degraded(false, Some("vector_pending")));
        assert!(counts_as_degraded(false, Some("embedder_loading")));
        assert!(
            !counts_as_degraded(false, Some("rerank_timeout")),
            "重排超时不是向量缺失,不按降级扣基线"
        );
    }

    #[test]
    fn invalid_cases_outrank_degraded_in_exit_code() {
        assert_eq!(exit_code_value(0, false, 0, false), 0);
        assert_eq!(exit_code_value(2, false, 0, false), 4);
        assert_eq!(exit_code_value(0, false, 3, false), 6);
        // 两种都有时报 6:黄金集对不上库比降级更要紧
        assert_eq!(exit_code_value(2, false, 3, false), 6);
        assert_eq!(exit_code_value(2, true, 3, true), 0);
    }

    #[test]
    fn problem_text_names_the_query_and_the_reason() {
        let problem = CaseProblem {
            query: "登录入口".to_owned(),
            kind: ProblemKind::MissingSource,
            detail: "proj_demo(期望 src/auth.rs)".to_owned(),
        };
        let text = problem_text(&problem);
        assert!(text.contains("期望的文件不在库里"), "{text}");
        assert!(
            text.contains("登录入口") && text.contains("src/auth.rs"),
            "{text}"
        );
    }
}

/// 指标。
#[derive(Clone, Copy, Debug)]
pub struct Metrics {
    /// hit@1。
    pub hit_at_1: f64,
    /// hit@k。
    pub hit_at_k: f64,
    /// 平均倒数排名。
    pub mrr: f64,
}

/// 从逐条结果算指标。
pub fn metrics_of(results: &[CaseResult], k: usize) -> Metrics {
    let total = results.len() as f64;
    if total == 0.0 {
        return Metrics {
            hit_at_1: 0.0,
            hit_at_k: 0.0,
            mrr: 0.0,
        };
    }
    Metrics {
        hit_at_1: results.iter().filter(|r| r.rank == Some(1)).count() as f64 / total,
        hit_at_k: results
            .iter()
            .filter(|r| r.rank.is_some_and(|rank| rank <= k))
            .count() as f64
            / total,
        mrr: results
            .iter()
            .map(|r| r.rank.map(|rank| 1.0 / rank as f64).unwrap_or(0.0))
            .sum::<f64>()
            / total,
    }
}

/// 供能力层(`eval_run`)复用的评测:返回 `{status, hit_at_1, hit_at_k, mrr, cases, degraded_cases, …}`。
#[allow(clippy::too_many_arguments)]
pub async fn run_inline(
    config: &Config,
    meta: std::sync::Arc<dyn kb_core::ports::repo::MetaStore>,
    store: std::sync::Arc<dyn kb_core::ports::VectorStore>,
    embedder: std::sync::Arc<dyn kb_core::ports::Embedder>,
    set: &std::path::Path,
    k: Option<usize>,
    sample: Option<usize>,
    seed: Option<u64>,
    rerank: Option<bool>,
) -> kb_core::Result<serde_json::Value> {
    // 路径由调用方解析(能力层 / 夜间门禁都按 `golden_paths` 找 KB_HOME 优先)。
    // 以前这里自己退回相对 cwd 的 `eval/golden.example.toml`,Web 评测页因此在生产上
    // 量的是仓库里的 7 条演示用例,页面只会报「全都对不上库」。
    let path = set;
    let golden = load(path).map_err(|err| KbError::InvalidInput(err.to_string()))?;
    let k = k.unwrap_or(5).max(1);
    // 预检 + 打乱/抽样要在检索之前做:无效用例只会在检索侧表现为「没找到」
    let prepared = prepare(meta.as_ref(), &golden, sample, seed).await?;
    let set_hash = prepared.set_hash();
    let invalid_cases: Vec<serde_json::Value> = prepared
        .problems
        .iter()
        .map(|problem| {
            serde_json::json!({
                "query": problem.query,
                "kind": problem.kind.text(),
                "detail": problem.detail,
            })
        })
        .collect();
    // 与 `kb eval` 同一口径:黄金集自己在索引里时,它的正文会被当成「完美匹配」顶掉真答案
    let hit_self = self_ref(meta.as_ref(), path).await?;
    let self_indexed = hit_self.is_some();
    // `ev_` + 毫秒时间戳的 base36 末 6 位:同一秒内连跑两次也不会撞
    let run_id = new_run_id();
    // 这次的用例来自哪个文件:只回文件名,不回绝对路径(Web 侧不需要、也不该看到服务器目录结构)。
    // 「报的是哪一份黄金集」说清楚,页面才不会被「示例集」的数字骗过去。
    let set_label = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned());
    // 一条有效用例都没有:不下结论,只说清楚为什么不能跑(否则就是拿一串假数字污染历史)
    if prepared.cases.is_empty() {
        return Ok(serde_json::json!({
            "status": "invalid_set",
            "run_id": run_id,
            "set": set_label,
            "mode": serde_json::Value::Null,
            "hit_at_1": serde_json::Value::Null,
            "hit_at_k": serde_json::Value::Null,
            "hit_at_3": serde_json::Value::Null,
            "hit_at_10": serde_json::Value::Null,
            "hit_at_k_ci95": serde_json::Value::Null,
            "k": k,
            "seed": prepared.seed,
            "sample": prepared.sample,
            "pool": prepared.pool,
            "set_hash": set_hash,
            "valid_cases": 0,
            "invalid_cases": invalid_cases,
            "mrr": serde_json::Value::Null,
            "p95_ms": serde_json::Value::Null,
            "degraded_cases": 0,
            "reranked_cases": 0,
            "self_indexed": self_indexed,
            "self_hits": 0,
            "cases": Vec::<serde_json::Value>::new(),
        }));
    }
    let service = SearchService::new(
        meta,
        store,
        embedder,
        crate::runtime::build_reranker(config),
        SearchOptions::from_config(config),
    );
    let mut self_hits = 0usize;
    let mut results = Vec::with_capacity(prepared.cases.len());
    let mut degraded_cases = 0usize;
    // 每条查询的耗时,最后算 p95(设计稿的历次结果表有「p95 ms」一列)
    let mut latencies_ms: Vec<f64> = Vec::with_capacity(prepared.cases.len());
    let mut saw_hybrid = false;
    let mut rerank_cases = 0usize;
    for case in &prepared.cases {
        let started = std::time::Instant::now();
        let response = service
            .search(SearchRequest {
                query: case.query.clone(),
                collections: vec![case.collection.clone()],
                k: Some(k),
                explain: false,
                rerank,
            })
            .await?;
        latencies_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        let (rank, dropped) = rank_of(case, &response.hits, hit_self.as_ref());
        self_hits += dropped;
        // 只有嵌入器不可用(纯全文检索)才算“评测数字不能当基线”;
        // 重排不可用只影响排序,不是全文降级。
        match response.degraded.as_deref() {
            Some(reason) if reason.starts_with("embedder") => degraded_cases += 1,
            Some(_) => saw_hybrid = true,
            None => saw_hybrid = true,
        }
        // `reranked` 由检索服务如实给出:`rerank.mode = auto` 且没装重排器时它是 false,
        // 不能拿 `degraded == None` 推断“重排跑过了”
        if response.reranked {
            rerank_cases += 1;
        }
        results.push(CaseResult {
            query: case.query.clone(),
            rank,
            top: Vec::new(),
            expect: case.expect.first().map(|expect| expect.source.clone()),
        });
    }
    let metrics = metrics_of(&results, k);
    // `expect` 是黄金集里期望的源文件,前端按它的扩展名做“按格式拆分”的统计
    let cases: Vec<serde_json::Value> = results
        .iter()
        .map(|result| {
            serde_json::json!({
                "query": result.query,
                "rank": result.rank,
                "expect": result.expect,
            })
        })
        .collect();
    // 模式:纯全文(嵌入器不可用)/ hybrid / hybrid+rerank(设计稿的「模式」列)
    // `mode` 只看两件事:**是否全部用例都真的重排过**、以及是否全部用例都退回纯全文。
    // 部分用例 embedder 降级时仍会重排,所以那种情况仍是 `hybrid+rerank`——
    // 降级要看 `degraded_cases`,重排覆盖面看 `reranked_cases`,不要拿 `mode` 推断降级
    let mode = if !saw_hybrid {
        "fts"
    } else if rerank_cases == results.len() && !results.is_empty() {
        "hybrid+rerank"
    } else {
        "hybrid"
    };
    // `ev_` + 毫秒时间戳的 base36 末 6 位:同一秒内连跑两次也不会撞
    let run_id = new_run_id();
    // 命中率的 95% 区间:比例类指标必须带区间,否则 7 条用例里差 1 条看起来像「退步了」
    let hits = results
        .iter()
        .filter(|result| result.rank.is_some_and(|rank| rank <= k))
        .count();
    let (ci_low, ci_high) = wilson_interval(hits, results.len());
    Ok(serde_json::json!({
        "status": prepared.status(),
        "run_id": run_id,
        "set": set_label,
        "mode": mode,
        "hit_at_1": metrics.hit_at_1,
        "hit_at_k": metrics.hit_at_k,
        "hit_at_k_ci95": [ci_low, ci_high],
        // 设计稿的历次结果表固定展示 hit@10 / hit@3,这里一并算出来
        "hit_at_3": hit_rate_at(&results, 3),
        "hit_at_10": hit_rate_at(&results, 10),
        "k": k,
        // 这两项让历次结果能判断「能不能比」:用例集指纹不同、k 不同就不是同一道题
        "seed": prepared.seed,
        "sample": prepared.sample,
        "pool": prepared.pool,
        "set_hash": set_hash,
        "valid_cases": results.len(),
        "invalid_cases": invalid_cases,
        "mrr": metrics.mrr,
        "p95_ms": percentile(&latencies_ms, 0.95),
        "degraded_cases": degraded_cases,
        // 本次是要重排还是关掉,和实际重排了几条一起给(`mode` 推不出来)
        "rerank": match rerank {
            Some(true) => "on",
            Some(false) => "off",
            None => "auto",
        },
        "reranked_cases": rerank_cases,
        "self_indexed": self_indexed,
        "self_hits": self_hits,
        "cases": cases,
    }))
}

/// 新的运行编号。
fn new_run_id() -> String {
    format!(
        "ev_{}",
        base36(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default()
        )
    )
}

/// 把时间戳转成 6 位 base36(短的补 0,超长的截断;只用来做运行 id)。
fn base36(value: u64) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut digits = Vec::new();
    let mut rest = value;
    while rest > 0 {
        digits.push(ALPHABET[(rest % 36) as usize] as char);
        rest /= 36;
    }
    while digits.len() < 6 {
        digits.push('0');
    }
    digits.reverse();
    let text: String = digits.into_iter().collect();
    text[text.len().saturating_sub(6)..].to_owned()
}

/// 命中率(名次 ≤ n 的用例占比)。
fn hit_rate_at(results: &[CaseResult], n: usize) -> f64 {
    if results.is_empty() {
        return 0.0;
    }
    let hits = results
        .iter()
        .filter(|result| result.rank.is_some_and(|rank| rank <= n))
        .count();
    hits as f64 / results.len() as f64
}

/// 百分位(输入为空时 0;`q` 取 0..1)。
fn percentile(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|left, right| left.partial_cmp(right).unwrap_or(std::cmp::Ordering::Equal));
    let index = ((sorted.len() as f64 - 1.0) * q).round() as usize;
    sorted[index.min(sorted.len() - 1)]
}
