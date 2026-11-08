//! 配置热重载（设计规范）。
//!
//! 守护进程起来之后 `config.toml` 还可能被手改,或由 Web 的 `update_config` 写回。
//! 这里负责三件事:
//!
//! 1. **读**:把文件读成 [`Config`] 并校验(非法配置整份丢弃,继续用旧配置);
//! 2. **分**:用 [`kb_core::config::Config::diff`] 分出“立即生效 / 要重启 / 要先迁移”;
//! 3. **生效**:把新配置写进 [`ConfigStore`],让各服务在**下一个请求**按新值走。
//!
//! 热更新项靠“按请求读取”生效,而不是重建服务:检索参数、重排、调度、日志级别、
//! 索引排除、MCP 输出上限都改成读 `ConfigStore`(组装根在 `kb-cli`)。
//! `embed.*` 的改动会改变向量维度,**不**在这里生效:只返回迁移计划,提示先迁移再重启。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use kb_core::Result;
use kb_core::config::{Config, ConfigStore};
use kb_core::ports::repo::{CollectionRepo, MetaStore};
use notify::{RecursiveMode, Watcher};
use tokio::sync::{mpsc, watch};

/// `config.toml` 的去抖窗口(设计规范:500ms)。
///
/// 编辑器保存一次会连发好几条事件(写临时文件 → rename → 改 mtime),去抖后只重载一次。
pub const CONFIG_DEBOUNCE_MS: u64 = 500;

/// embedder 改动的迁移计划(只描述,不执行)。
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct EmbedMigrationPlan {
    /// 当前 embedder(`backend:model`)。
    pub from: String,
    /// 目标 embedder。
    pub to: String,
    /// 是否同一兼容组(同组可以只改 `embedder_id`,不必重嵌入)。
    pub same_compat_group: bool,
    /// 受影响的 collection 名(升序)。
    pub collections: Vec<String>,
}

/// 一次重载的结果。
#[derive(Clone, Debug, Default, serde::Serialize)]
pub struct ReloadOutcome {
    /// 新配置是否已经生效(写进了 [`ConfigStore`])。
    pub applied: bool,
    /// 生效后的代际号(没生效时是当前代际号)。
    pub generation: u64,
    /// 立即生效的键。
    ///
    /// **只在 `applied = true` 时代表「已经生效」**;`migration` 分支里(整份未生效)
    /// 列出的是「迁移并重启后才会生效的键」,调用方不要只看这个字段就以为改完了。
    pub hot: Vec<String>,
    /// 要重启守护进程才生效的键。
    pub restart_required: Vec<String>,
    /// 需要先迁移的键(非空时整份配置都不生效)。
    pub migration: Vec<String>,
    /// 涉及 embedder 时的迁移计划。
    pub migration_plan: Option<EmbedMigrationPlan>,
    /// 给调用方的说明。
    pub notes: Vec<String>,
    /// 配置非法时的原因(旧配置继续生效)。
    pub error: Option<String>,
}

impl ReloadOutcome {
    /// 有没有需要人处理的事(非法配置 / 要重启 / 要迁移)。
    pub fn needs_attention(&self) -> bool {
        self.error.is_some() || !self.restart_required.is_empty() || !self.migration.is_empty()
    }

    /// 日志里的一行摘要。
    pub fn summary(&self) -> String {
        if let Some(error) = &self.error {
            return format!("配置未生效(保留旧配置): {error}");
        }
        if !self.migration.is_empty() {
            return format!(
                "配置里的 embed 改动需要先迁移({}),本次未生效",
                self.migration.join(", ")
            );
        }
        if self.applied {
            let mut text = format!("配置已热更新(代际 {})", self.generation);
            if !self.hot.is_empty() {
                text.push_str(&format!(";立即生效:{}", self.hot.join(", ")));
            }
            if !self.restart_required.is_empty() {
                text.push_str(&format!(";要重启:{}", self.restart_required.join(", ")));
            }
            return text;
        }
        "配置没有变化".to_owned()
    }
}

/// 重载结果的观察者(守护进程用它推 WS 事件、调日志级别)。
pub trait ConfigObserver: Send + Sync {
    /// 每次重载结束都会调用一次(包括“没变化”与“非法”)。
    fn on_outcome(&self, outcome: &ReloadOutcome);
}

/// 配置重载器。
pub struct ConfigReloader {
    store: Arc<ConfigStore>,
    config_file: PathBuf,
    meta: Option<Arc<dyn MetaStore>>,
    observer: Option<Arc<dyn ConfigObserver>>,
}

impl ConfigReloader {
    /// 用配置存储与 `config.toml` 路径构造。
    pub fn new(store: Arc<ConfigStore>, config_file: impl Into<PathBuf>) -> Self {
        Self {
            store,
            config_file: config_file.into(),
            meta: None,
            observer: None,
        }
    }

    /// 挂上元数据库(用于在迁移计划里列出受影响的 collection)。
    pub fn with_meta(mut self, meta: Arc<dyn MetaStore>) -> Self {
        self.meta = Some(meta);
        self
    }

    /// 挂上观察者。
    pub fn with_observer(mut self, observer: Arc<dyn ConfigObserver>) -> Self {
        self.observer = Some(observer);
        self
    }

    /// 当前的配置存储。
    pub fn store(&self) -> Arc<ConfigStore> {
        self.store.clone()
    }

    /// `config.toml` 路径。
    pub fn config_file(&self) -> &Path {
        &self.config_file
    }

    /// 读一次文件并生效。
    ///
    /// 语义(顺序即优先级):
    /// 1. 读 / 解析 / 校验失败 → **不改内存里的配置**,返回 `error`;
    /// 2. 与当前配置完全一致 → `applied = false`,不发事件(`notes` 里说明);
    /// 3. 有 `embed.*` 改动 → **整份不生效**,返回迁移计划(先迁移、再重启);
    /// 4. 其余情况 → 整份写进 `ConfigStore`,`hot` 立即生效,`restart_required` 只做提示。
    pub async fn reload(&self) -> ReloadOutcome {
        let current = self.store.get();
        // 文件被删 / 正在被重命名时**不要**退回默认配置:
        // `Config::load` 对不存在的文件返回 `Config::default`,照那样热生效会把热项悄悄重置。
        if !self.config_file.exists() {
            let outcome = ReloadOutcome {
                applied: false,
                generation: self.store.generation(),
                notes: vec![format!(
                    "配置文件 {} 不存在,继续用当前配置",
                    self.config_file.display()
                )],
                error: Some("配置文件不存在(可能正被删除或重命名)".to_owned()),
                ..ReloadOutcome::default()
            };
            self.notify(&outcome);
            return outcome;
        }
        let next = match Config::load(&self.config_file) {
            Ok(next) => next,
            Err(err) => {
                let outcome = ReloadOutcome {
                    applied: false,
                    generation: self.store.generation(),
                    notes: vec![format!(
                        "配置文件 {} 不可用,继续用当前配置",
                        self.config_file.display()
                    )],
                    error: Some(err.to_string()),
                    ..ReloadOutcome::default()
                };
                self.notify(&outcome);
                return outcome;
            }
        };

        if next == *current {
            let outcome = ReloadOutcome {
                applied: false,
                generation: self.store.generation(),
                notes: vec!["配置与当前生效的一致,没有变化".to_owned()],
                ..ReloadOutcome::default()
            };
            // “没变化”也要通知一次:Web 端点了“重新加载”要拿到回执
            self.notify(&outcome);
            return outcome;
        }

        let diff = current.diff(&next);
        if !diff.migration().is_empty() {
            let plan = self.migration_plan(&current, &next).await;
            let outcome = ReloadOutcome {
                applied: false,
                generation: self.store.generation(),
                hot: diff.hot(),
                restart_required: diff.restart_required(),
                migration: diff.migration(),
                migration_plan: plan,
                notes: vec![
                    "embed 段的改动会改变向量维度,不会热更新".to_owned(),
                    "先 `kb migrate <collection> --to <embedder>` 迁移,再重启 `kb daemon`"
                        .to_owned(),
                ],
                error: None,
            };
            self.notify(&outcome);
            return outcome;
        }

        let (generation, _) = self.store.replace(next);
        let outcome = ReloadOutcome {
            applied: true,
            generation,
            hot: diff.hot(),
            restart_required: diff.restart_required(),
            migration: Vec::new(),
            migration_plan: None,
            notes: if diff.restart_required().is_empty() {
                vec!["全部改动已生效".to_owned()]
            } else {
                vec![format!(
                    "{} 只在启动时读取,需要重启 `kb daemon` 才生效",
                    diff.restart_required().join(", ")
                )]
            },
            error: None,
        };
        self.notify(&outcome);
        outcome
    }

    /// 迁移计划:`from` / `to` + 受影响的 collection。
    async fn migration_plan(&self, current: &Config, next: &Config) -> Option<EmbedMigrationPlan> {
        let mut plan = EmbedMigrationPlan {
            from: format!("{}:{}", current.embed.backend, current.embed.model),
            to: format!("{}:{}", next.embed.backend, next.embed.model),
            same_compat_group: current.embed.same_compat_group(&next.embed),
            collections: Vec::new(),
        };
        if let Some(meta) = &self.meta {
            match CollectionRepo::list(meta.as_ref()).await {
                Ok(collections) => {
                    let mut names: Vec<String> =
                        collections.into_iter().map(|item| item.name).collect();
                    names.sort();
                    plan.collections = names;
                }
                Err(err) => {
                    tracing::warn!(error = %err, "列 collection 失败,迁移计划里不带受影响列表");
                }
            }
        }
        Some(plan)
    }

    fn notify(&self, outcome: &ReloadOutcome) {
        if let Some(observer) = &self.observer {
            observer.on_outcome(outcome);
        }
    }

    /// 监听 `config.toml`:500ms 去抖后重载;关闭信号到达时退出。
    ///
    /// 只监听配置文件所在目录(非递归)并只认这个文件名,所以同目录的
    /// `config.toml.tmp`(原子写的临时文件)、`meta.db-wal` 之类都不会触发重载。
    pub fn spawn_watch(self: Arc<Self>, shutdown: watch::Receiver<bool>) -> Result<ConfigWatcher> {
        let target = self.config_file.clone();
        let directory = target.parent().map(Path::to_path_buf).ok_or_else(|| {
            kb_core::KbError::InvalidInput(format!(
                "配置文件 {} 没有父目录,无法监听",
                target.display()
            ))
        })?;
        std::fs::create_dir_all(&directory).map_err(|err| {
            kb_core::KbError::Internal(format!("创建配置目录 {} 失败: {err}", directory.display()))
        })?;

        let (raw_tx, mut raw_rx) = mpsc::channel::<()>(64);
        let watched = target.clone();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                let Ok(event) = event else { return };
                if !matches!(
                    event.kind,
                    notify::EventKind::Create(_)
                        | notify::EventKind::Modify(_)
                        | notify::EventKind::Remove(_)
                ) {
                    return;
                }
                if event
                    .paths
                    .iter()
                    .any(|path| path.file_name() == watched.file_name())
                {
                    let _ = raw_tx.blocking_send(());
                }
            })
            .map_err(|err| kb_core::KbError::Internal(format!("创建配置监听器失败: {err}")))?;
        watcher
            .watch(&directory, RecursiveMode::NonRecursive)
            .map_err(|err| {
                kb_core::KbError::Internal(format!(
                    "监听配置目录 {} 失败: {err}",
                    directory.display()
                ))
            })?;

        let debounce = Duration::from_millis(CONFIG_DEBOUNCE_MS.max(1));
        let task = tokio::spawn(async move {
            let mut shutdown = shutdown;
            loop {
                tokio::select! {
                    received = raw_rx.recv() => {
                        if received.is_none() {
                            break;
                        }
                        // 去抖:窗口内的后续事件都吃掉,只重载一次
                        let deadline = tokio::time::Instant::now() + debounce;
                        while let Ok(Some(())) =
                            tokio::time::timeout_at(deadline, raw_rx.recv()).await
                        {}
                        let outcome = self.reload().await;
                        tracing::info!(target: "kb::config", "{}", outcome.summary());
                    }
                    _ = shutdown.changed() => {
                        if *shutdown.borrow() {
                            tracing::debug!("配置监听收到关闭信号");
                            break;
                        }
                    }
                }
            }
        });

        Ok(ConfigWatcher {
            _watcher: watcher,
            task,
        })
    }
}

/// 活着的配置监听(丢掉它监听就停了)。
pub struct ConfigWatcher {
    _watcher: notify::RecommendedWatcher,
    task: tokio::task::JoinHandle<()>,
}

impl ConfigWatcher {
    /// 等监听任务退出(测试用;生产环境随进程一起结束)。
    pub async fn join(self) {
        let _ = self.task.await;
    }

    /// 监听任务是否已经结束。
    pub fn is_finished(&self) -> bool {
        self.task.is_finished()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_summary_mentions_the_relevant_part() {
        let outcome = ReloadOutcome {
            applied: true,
            generation: 3,
            hot: vec!["search.k".to_owned()],
            restart_required: vec!["server.listen".to_owned()],
            notes: Vec::new(),
            ..ReloadOutcome::default()
        };
        let summary = outcome.summary();
        assert!(summary.contains("代际 3"), "{summary}");
        assert!(summary.contains("search.k"), "{summary}");
        assert!(summary.contains("要重启"), "{summary}");

        let rejected = ReloadOutcome {
            error: Some("解析配置失败".to_owned()),
            ..ReloadOutcome::default()
        };
        assert!(rejected.summary().contains("保留旧配置"));
        assert!(rejected.needs_attention());

        let untouched = ReloadOutcome::default();
        assert_eq!(untouched.summary(), "配置没有变化");
        assert!(!untouched.needs_attention());
    }
}
