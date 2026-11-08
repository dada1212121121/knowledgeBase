//! 夜间质量门禁:每晚抽一小组黄金集跑一遍,命中率跌了才出声。
//!
//! 为什么放在 CLI 这一层:评测要拼检索服务、读 `<KB_HOME>/eval/golden.toml`、往
//! `eval/history.jsonl` 追加记录,这些能力都在组装根这里;`kb-service` 只留
//! [`kb_service::scheduler::QualityGate`] 这个口子和「跌多少算跌」的判定。
//!
//! 与 `kb eval` 同口径的关键几点:同一条评分路径(`run_inline`)、剔除黄金集自命中、
//! 预检先于检索、种子固定——否则两期的差里混着用例的差。

use std::sync::Arc;

use kb_core::config::ConfigStore;
use kb_core::ports::repo::MetaStore;
use kb_core::ports::{Embedder, VectorStore};
use kb_core::{KbError, Result};
use kb_service::scheduler::QualityMeasure;

use crate::runtime::Embedded;

/// 每晚抽多少条(评估成本,不追求精度:15 条 × 约 250 ms ≈ 4 秒)。
pub const NIGHTLY_SAMPLE: usize = 15;
/// 固定的抽样种子:每晚、每次重启抽到的都是同一批用例,否则比出来的差没有意义。
pub const NIGHTLY_SEED: u64 = 7;
/// 历史记录里标记「夜间门禁跑出来的」的取值。
///
/// 不复用 `mode`:那个字段表示检索方式(全集 / 混合 / 带重排, / 评测页口径),
/// 拿它标夜间会把两件事混成一个字段。
pub const GATE_TAG: &str = "nightly";

/// 用当前进程里的运行时跑一次夜间抽样。
///
/// 字段直接展开成端口而不再握住整个运行时:门禁只需要「配置 + 三个端口 + 评测目录」,
/// 这样单测可以用 `kb-testkit` 的假嵌入器把整条链路跑一遍,不必加载真模型。
pub struct NightlyEvalGate {
    config: Arc<ConfigStore>,
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    eval_dir: std::path::PathBuf,
}

impl NightlyEvalGate {
    /// 接到进程里的知识库运行时上。
    pub fn new(runtime: Arc<Embedded>) -> Self {
        Self {
            config: runtime.config.clone(),
            meta: runtime.meta.clone(),
            store: runtime.store(),
            embedder: runtime.embedder.clone(),
            eval_dir: runtime.paths.eval_dir().to_path_buf(),
        }
    }
}

#[async_trait::async_trait]
impl kb_service::scheduler::QualityGate for NightlyEvalGate {
    async fn measure(&self) -> Result<Option<QualityMeasure>> {
        // 没装黄金集的知识库不跑门禁:比不出东西,也不该半夜报「跑不了」
        let Some(set_path) = crate::commands::eval::golden_paths(&self.eval_dir)
            .into_iter()
            .find(|candidate| candidate.exists())
        else {
            return Ok(None);
        };
        let dir = self.eval_dir.clone();
        let config = self.config.get();
        let result = crate::commands::eval::run_inline(
            &config,
            self.meta.clone(),
            self.store.clone(),
            self.embedder.clone(),
            &set_path,
            Some(5),
            Some(NIGHTLY_SAMPLE),
            Some(NIGHTLY_SEED),
            // 门禁量的是「今晚收工时的检索」:重排开不开按配置来,不在这里强制
            None,
        )
        .await?;

        // 一条有效用例都没有 / 嵌入器不可用(纯全文)时,这批数字不能当基线:
        // 抛出去让调度器记事件(不告警),而不是把假数字写进历史当下一期的基准。
        let valid_cases = result["valid_cases"].as_u64().unwrap_or(0);
        if result["status"].as_str() == Some("invalid_set") || valid_cases == 0 {
            return Err(KbError::InvalidInput(format!(
                "黄金集里抽不出有效用例({})",
                set_path.display()
            )));
        }
        let degraded_cases = result["degraded_cases"].as_u64().unwrap_or(0);
        if degraded_cases >= valid_cases {
            return Err(KbError::InvalidInput(
                "嵌入器不可用,本次全走纯全文,命中率不能当基线".to_owned(),
            ));
        }
        let Some(hit_at_1) = result["hit_at_1"].as_f64() else {
            return Err(KbError::Internal("评测结果里没有 hit_at_1".to_owned()));
        };
        let set_hash = result["set_hash"].as_str().unwrap_or_default().to_owned();
        // 历史先读再写:读完才追加本期,否则本期会被当成上一期跟自己比
        let previous_hit_at_1 = previous_nightly(&dir, &set_hash)?;
        if let Err(err) =
            crate::capability_backend::append_eval_history(&dir, &result, Some(GATE_TAG))
        {
            // 写不进历史不影响判定(本期数字已经在手里),但要留痕
            tracing::warn!(error = %err, "写夜间门禁历史失败");
        }
        Ok(Some(QualityMeasure {
            set_hash,
            cases: valid_cases as usize,
            hit_at_1,
            previous_hit_at_1,
        }))
    }
}

/// 上一次夜间门禁的 hit@1(同一份黄金集指纹)。
///
/// 只看 `gate = nightly` 且 `set_hash` 相同的记录:换过黄金集就从新基线开始,
/// 否则「跌」的其实是题目换了。
fn previous_nightly(dir: &std::path::Path, set_hash: &str) -> Result<Option<f64>> {
    for record in crate::capability_backend::read_eval_history(dir, 200)? {
        if record["gate"].as_str() != Some(GATE_TAG) {
            continue;
        }
        if record["set_hash"].as_str() != Some(set_hash) {
            continue;
        }
        if let Some(hit_at_1) = record["hit_at_1"].as_f64() {
            return Ok(Some(hit_at_1));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use kb_service::scheduler::QualityGate;

    fn record(gate: Option<&str>, set_hash: &str, hit_at_1: f64) -> serde_json::Value {
        serde_json::json!({
            "gate": gate,
            "set_hash": set_hash,
            "hit_at_1": hit_at_1,
        })
    }

    /// 只认同一份黄金集的夜间记录:别的模式、别的指纹都不算基线。
    #[test]
    fn previous_baseline_must_match_gate_and_set_hash() {
        let dir = tempfile::tempdir().expect("临时目录");
        let eval_dir = dir.path();
        let mut text = String::new();
        text.push_str(&format!(
            "{}\n",
            record(Some(GATE_TAG), "old", 0.9) // 指纹不同:不是这道题的基线
        ));
        text.push_str(&format!(
            "{}\n",
            record(None, "current", 0.95) // 手跑的评测:不比
        ));
        text.push_str(&format!("{}\n", record(Some(GATE_TAG), "current", 0.8)));
        text.push_str(&format!(
            "{}\n",
            record(Some(GATE_TAG), "current", 0.86) // 最新的一条才算「上一期」
        ));
        std::fs::write(eval_dir.join("history.jsonl"), text).expect("写历史");
        let previous = previous_nightly(eval_dir, "current").expect("读历史");
        assert_eq!(previous, Some(0.86));
    }

    /// 没有基线时返回 None(第一次跑,不报警)。
    #[test]
    fn no_baseline_when_history_is_missing() {
        let dir = tempfile::tempdir().expect("临时目录");
        assert_eq!(
            previous_nightly(dir.path(), "current").expect("读历史"),
            None
        );
    }

    /// 端到端:真索引一个文件、真跑一次抽样评测,历史里留下 `gate = nightly` 的两条记录,
    /// 第二期把第一期当基线。
    #[tokio::test]
    async fn gate_measures_and_chains_the_baseline_through_history() {
        let env = kb_testkit::TestEnv::new().await;
        let dir = tempfile::tempdir().expect("项目目录");
        std::fs::write(
            dir.path().join("a.md"),
            "# 门禁\n\n夜间质量门禁的一句话。\n",
        )
        .expect("写文件");
        let project = kb_core::model::Project {
            id: "p1".to_owned(),
            name: "demo".to_owned(),
            slug: "demo".to_owned(),
            root_path: dir.path().to_string_lossy().into_owned(),
            include: Vec::new(),
            exclude: Vec::new(),
            is_git: false,
            last_commit: None,
            last_indexed_at: None,
            allow_cloud_llm: false,
            extract_enabled: false,
            hooks_installed: false,
            created_at: 1_700_000_000_000,
        };
        kb_core::ports::repo::ProjectRepo::create(env.meta.as_ref(), project.clone())
            .await
            .expect("写项目");
        let collection = kb_service::CollectionService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
        )
        .create_for_project("p1", "demo")
        .await
        .expect("建 collection");
        let index = kb_service::IndexService::new(
            env.meta.clone(),
            env.store.clone(),
            env.embedder.clone(),
            env.chunker.clone(),
            env.scanner.clone(),
            kb_service::IndexOptions::default(),
        );
        index
            .index_project(&project, &collection)
            .await
            .expect("索引");

        let eval_dir = env.paths().eval_dir().to_path_buf();
        std::fs::create_dir_all(&eval_dir).expect("建评测目录");
        std::fs::write(
            eval_dir.join("golden.toml"),
            format!(
                "[[case]]\nquery = \"夜间质量门禁\"\ncollection = \"{}\"\nexpect = [{{ source = \"a.md\" }}]\n",
                collection.name
            ),
        )
        .expect("写黄金集");

        let gate = NightlyEvalGate {
            config: Arc::new(ConfigStore::new(kb_core::config::Config::default())),
            meta: env.meta.clone(),
            store: env.store.clone(),
            embedder: env.embedder.clone(),
            eval_dir: eval_dir.clone(),
        };
        let first = gate.measure().await.expect("第一期").expect("应抽到用例");
        assert_eq!(first.previous_hit_at_1, None, "第一期没有基线");
        assert_eq!(first.cases, 1, "黄金集只有一条用例");
        assert_eq!(first.hit_at_1, 1.0, "唯一一条用例应当命中");

        let second = gate.measure().await.expect("第二期").expect("应抽到用例");
        assert_eq!(
            second.previous_hit_at_1,
            Some(first.hit_at_1),
            "第二期要把上一期当基线"
        );

        let history = crate::capability_backend::read_eval_history(&eval_dir, 10).expect("读历史");
        assert_eq!(history.len(), 2, "两次测量各留一条历史");
        for record in &history {
            assert_eq!(record["gate"], GATE_TAG);
            assert_eq!(record["sample"], NIGHTLY_SAMPLE as u64);
            assert_eq!(record["seed"], NIGHTLY_SEED);
        }
    }

    /// 没装黄金集的知识库:返回 None(不算失败,也不写历史)。
    #[tokio::test]
    async fn gate_skips_when_there_is_no_golden_set() {
        let env = kb_testkit::TestEnv::new().await;
        let eval_dir = tempfile::tempdir().expect("评测目录");
        let gate = NightlyEvalGate {
            config: Arc::new(ConfigStore::new(kb_core::config::Config::default())),
            meta: env.meta.clone(),
            store: env.store.clone(),
            embedder: env.embedder.clone(),
            eval_dir: eval_dir.path().to_path_buf(),
        };
        assert!(gate.measure().await.expect("不该报错").is_none());
        assert!(!eval_dir.path().join("history.jsonl").exists());
    }
}
