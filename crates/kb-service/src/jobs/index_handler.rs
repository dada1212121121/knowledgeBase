//! 索引任务的分片执行器:每片处理若干个文件并保存检查点。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use kb_core::model::{Collection, FileChange, Job, JobFile, Project, ScanEntry, SkippedEntry};
use kb_core::ports::repo::{CollectionRepo, FileRepo, JobRepo, MetaStore, ProjectRepo};
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};

use crate::index::{FileStats, IndexService};
use crate::jobs::slots::{Lane, lane_of};
use crate::jobs::worker::{JobHandler, SliceProgress};

/// 索引任务的参数。
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct IndexPayload {
    /// 项目 id。
    pub project_id: String,
    /// `full` 或 `incremental`。
    pub mode: String,
    /// 增量模式下要处理的相对路径;空表示全部。
    #[serde(default)]
    pub paths: Vec<String>,
    /// 两阶段索引的阶段:`text` / `embed`;缺省按配置决定。
    #[serde(default)]
    pub phase: Option<String>,
    /// 文本阶段结束就停(手动 `--text-only`),不自动排空向量队列。
    #[serde(default)]
    pub stop_after_text: bool,
}

/// 索引任务的检查点。
///
/// 与设计规范的 `{last_path, done}` 等价但更稳:任务开始时把排好序的路径列表固化下来,
/// 续跑时按这份列表定位,文件被改动/新增/删除都不会让下标错位。
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct IndexCheckpoint {
    /// 任务开始时固化的文件顺序(相对路径)。
    #[serde(default)]
    pub paths: Vec<String>,
    /// 下一个要处理的路径下标。
    pub next: usize,
    /// 文件总数。
    pub total: usize,
    /// 已完成数。
    pub done: usize,
    /// 非致命错误数。
    pub errors: usize,
    /// 重新嵌入的块数。
    pub embedded: usize,
    /// 只更新元数据的块数。
    pub updated_meta: usize,
    /// 删除的块数。
    pub deleted_chunks: usize,
    /// 上次 optimize 之后写入的行数。
    pub rows_since_optimize: usize,
    /// 前几条错误(写进 jobs.error,便于定位)。
    #[serde(default)]
    pub error_samples: Vec<String>,
    /// 是否已经写过被过滤文件的 `files` 记录。
    #[serde(default)]
    pub skipped_recorded: bool,
    /// 当前阶段:`text`(只写正文)/ `embed`(补向量);空串在首次运行时按配置决定。
    #[serde(default)]
    pub phase: String,
    /// 文本阶段写入、等待补向量的块数。
    #[serde(default)]
    pub pending: usize,
}

/// 一次任务内的扫描缓存(避免每个分片重新扫描)。
struct CachedScan {
    job_id: String,
    order: Vec<String>,
    entries: HashMap<String, ScanEntry>,
    skipped: Vec<SkippedEntry>,
}

/// 索引任务处理器。
pub struct IndexJobHandler {
    service: Arc<IndexService>,
    meta: Arc<dyn MetaStore>,
    slice_files: usize,
    /// 一片最多跑多久,到点后在文件之间收尾(见 [`SLICE_TIME_BUDGET`])。
    slice_budget: std::time::Duration,
    cache: Mutex<Option<CachedScan>>,
}

impl IndexJobHandler {
    /// 构造;`slice_files` 是每个分片处理的文件数(设计规范建议 50)。
    pub fn new(service: Arc<IndexService>, meta: Arc<dyn MetaStore>, slice_files: usize) -> Self {
        Self {
            service,
            meta,
            slice_files: slice_files.max(1),
            slice_budget: SLICE_TIME_BUDGET,
            cache: Mutex::new(None),
        }
    }

    /// 改一片的时间预算(测试里设成 0:每片只做一个文件)。
    pub fn with_slice_budget(mut self, budget: std::time::Duration) -> Self {
        self.slice_budget = budget;
        self
    }

    async fn load(
        &self,
        job: &Job,
    ) -> Result<(Project, Collection, IndexPayload, IndexCheckpoint)> {
        let payload: IndexPayload = serde_json::from_str(&job.payload_json)
            .map_err(|err| KbError::InvalidInput(format!("索引任务参数非法: {err}")))?;
        let project = ProjectRepo::get(self.meta.as_ref(), &payload.project_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("project {}", payload.project_id)))?;
        let name = job
            .collection
            .clone()
            .ok_or_else(|| KbError::InvalidInput("索引任务缺少 collection".to_owned()))?;
        let collection = CollectionRepo::get(self.meta.as_ref(), &name)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {name}")))?;
        let checkpoint = match &job.checkpoint_json {
            Some(json) => match serde_json::from_str(json) {
                Ok(checkpoint) => checkpoint,
                Err(err) => {
                    tracing::warn!(error = %err, "检查点解析失败,从任务开头重新开始");
                    IndexCheckpoint::default()
                }
            },
            None => IndexCheckpoint::default(),
        };
        Ok((project, collection, payload, checkpoint))
    }

    /// 取(或建立)本任务的扫描缓存。
    fn scan(&self, job_id: &str, project: &Project) -> Result<CachedScan> {
        let mut guard = self
            .cache
            .lock()
            .map_err(|_| KbError::Internal("扫描缓存锁已中毒".to_owned()))?;
        if let Some(cache) = guard.as_ref()
            && cache.job_id == job_id
        {
            return Ok(CachedScan {
                job_id: cache.job_id.clone(),
                order: cache.order.clone(),
                entries: cache.entries.clone(),
                skipped: cache.skipped.clone(),
            });
        }
        let scan = self.service.scan_project(project)?;
        let order: Vec<String> = scan
            .files
            .iter()
            .map(|entry| entry.relative.clone())
            .collect();
        let entries: HashMap<String, ScanEntry> = scan
            .files
            .into_iter()
            .map(|entry| (entry.relative.clone(), entry))
            .collect();
        let cache = CachedScan {
            job_id: job_id.to_owned(),
            order,
            entries,
            skipped: scan.skipped,
        };
        let result = CachedScan {
            job_id: cache.job_id.clone(),
            order: cache.order.clone(),
            entries: cache.entries.clone(),
            skipped: cache.skipped.clone(),
        };
        *guard = Some(cache);
        Ok(result)
    }
}

/// 一个索引分片最多跑多久(到点后在文件之间收尾,让出给更高优先级的任务)。
const SLICE_TIME_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[async_trait]
impl JobHandler for IndexJobHandler {
    /// 全量索引 / 迁移是批量活,但 hook 增量与编辑(优先级 ≥ 80)是用户正等着的结果,
    /// 走交互通道,免得排在自己的全量索引后面。判定沿用 `lane_of`,不再看 `kind` 字符串。
    fn lane(&self, job: &Job) -> Lane {
        lane_of(job.priority)
    }

    async fn run_slice(&self, job: &Job) -> Result<SliceProgress> {
        // 写闸门:先拿读锁,再读 collection。分片耗时较长,
        // 迁移的收尾(写锁)会等这一片结束,因此本片不会把数据写进刚退役的表。
        let _writer = self.service.write_gate().writer().await;
        let (project, collection, payload, mut checkpoint) = self.load(job).await?;
        // 阶段在检查点里持久化:同一个 job 先跑 text、再切 embed,
        // 取消 / 重启时按阶段续跑,不会两个 job 抢同一张表,也不会让进度条跳变。
        if checkpoint.phase.is_empty() {
            checkpoint.phase = match payload.phase.as_deref() {
                // 显式 `full` 是「强制旧路径」,不受全局 text_first 影响:
                // 回退开关坏掉时,至少要能通过一次任务把内容按老顺序写完。
                Some("full") => "full".to_owned(),
                Some("text") => "text".to_owned(),
                Some("embed") => "embed".to_owned(),
                None if self.service.options().text_first => "text".to_owned(),
                None => "full".to_owned(),
                Some(other) => {
                    return Err(KbError::InvalidInput(format!(
                        "索引任务阶段应为 text / embed / full,收到 {other}"
                    )));
                }
            };
        }
        if checkpoint.phase == "embed" {
            return self
                .run_embed_slice(job, &project, &collection, checkpoint)
                .await;
        }
        let text_first = checkpoint.phase == "text";
        let scan = self.scan(&job.id, &project)?;
        let (entries, skipped) = (scan.entries, scan.skipped);
        let now = now_millis();

        // 项目里被用户删过的文件在 path_exclusions 里:即使磁盘上的原件还在,
        // 也不能借着下一次全量索引又加回来。按精确路径过滤,不用目录前缀。
        let excluded: HashSet<String> = self
            .meta
            .list_path_exclusions(&collection.name, &format!("project:{}", project.id))
            .await?
            .into_iter()
            .collect();
        if !excluded.is_empty() {
            checkpoint.paths.retain(|path| !excluded.contains(path));
        }
        // 第一次:固化文件顺序,并记录被过滤文件的 files 状态
        if checkpoint.paths.is_empty() {
            checkpoint.paths = if payload.mode == "incremental" && !payload.paths.is_empty() {
                let mut paths = Vec::new();
                for path in &payload.paths {
                    if excluded.contains(path) {
                        continue;
                    }
                    if entries.contains_key(path) {
                        paths.push(path.clone());
                    } else {
                        // 增量指定的文件已经不存在:清掉旧块
                        self.service.remove_source(&collection, path).await?;
                    }
                }
                paths
            } else {
                scan.order
                    .iter()
                    .filter(|path| !excluded.contains(*path))
                    .cloned()
                    .collect()
            };
            checkpoint.total = checkpoint.paths.len();
        }
        if !checkpoint.skipped_recorded {
            self.service
                .record_skipped(&collection, &skipped, now)
                .await?;
            checkpoint.skipped_recorded = true;
        }

        let end = (checkpoint.next + self.slice_files).min(checkpoint.paths.len());
        let started = std::time::Instant::now();
        let mut processed_to = checkpoint.next;
        // 逐文件结果攒到分片结束一次性写库:一个文件一条 SQL 会让几千个文件的任务多几千次 fsync
        let mut outcomes: Vec<JobFile> = Vec::new();
        for index in checkpoint.next..end {
            // 时间预算:一片按文件数切(50 个)在遇到大文件时能拖到几十分钟,期间同一个后台 worker 上的
            // 保存笔记、编辑、别的知识库的任务都得等。超过预算就在文件之间收尾,检查点记到做完的这个文件,
            // worker 会借此机会让给更高优先级的任务。至少做完一个文件,保证每片都在前进
            if index > checkpoint.next && started.elapsed() >= self.slice_budget {
                break;
            }
            processed_to = index + 1;
            let path = checkpoint.paths[index].clone();
            let done_at = now_millis();
            match entries.get(&path) {
                Some(entry) => {
                    // 「新增」还是「更新」只有索引前能分清(索引完 files 行已经在了);主键查询,很便宜
                    let existed = FileRepo::get(self.meta.as_ref(), &collection.name, &path)
                        .await?
                        .is_some();
                    let mode = if text_first {
                        crate::index::IndexMode::TextOnly
                    } else {
                        crate::index::IndexMode::Full
                    };
                    match self
                        .service
                        .index_entry_mode(&project, &collection, entry, mode)
                        .await
                    {
                        Ok(stats) => {
                            checkpoint.embedded += stats.embedded;
                            checkpoint.pending += stats.pending;
                            checkpoint.updated_meta += stats.updated_meta;
                            checkpoint.deleted_chunks += stats.deleted_chunks;
                            checkpoint.rows_since_optimize += stats.embedded + stats.pending;
                            outcomes.push(JobFile {
                                path,
                                change: change_of(&stats, existed),
                                chunks: stats.embedded + stats.pending,
                                meta_chunks: stats.updated_meta,
                                deleted_chunks: stats.deleted_chunks,
                                error: None,
                                done_at,
                            });
                        }
                        Err(err) if file_is_gone(&entry.path) => {
                            // 路径在任务开头的扫描快照里,读取前文件已被删(编辑器 / 构建工具的临时文件、
                            // 目录改名)。这不是索引失败而是一次删除:按快照里没有的路径同样处理,
                            // 清掉旧块与 files 行,记 Delete,不计入错误数,免得任务页「失败文件」里
                            // 混着正常的删除、WARN 日志淹没真问题。
                            let deleted = self.service.remove_source(&collection, &path).await?;
                            tracing::debug!(
                                path = %path,
                                error = %err,
                                "文件在索引前已消失,按删除处理"
                            );
                            outcomes.push(JobFile {
                                path,
                                change: FileChange::Delete,
                                chunks: 0,
                                meta_chunks: 0,
                                deleted_chunks: deleted,
                                error: None,
                                done_at,
                            });
                        }
                        Err(err) => {
                            checkpoint.errors += 1;
                            if checkpoint.error_samples.len() < 5 {
                                checkpoint.error_samples.push(format!("{path}: {err}"));
                            }
                            tracing::warn!(path = %path, error = %err, "索引单个文件失败");
                            outcomes.push(JobFile {
                                path,
                                change: FileChange::Error,
                                chunks: 0,
                                meta_chunks: 0,
                                deleted_chunks: 0,
                                error: Some(err.to_string()),
                                done_at,
                            });
                        }
                    }
                }
                None => {
                    // 任务开始后文件被删除 / 被过滤:清掉旧块
                    let deleted = self.service.remove_source(&collection, &path).await?;
                    outcomes.push(JobFile {
                        path,
                        change: FileChange::Delete,
                        chunks: 0,
                        meta_chunks: 0,
                        deleted_chunks: deleted,
                        error: None,
                        done_at,
                    });
                }
            }
        }
        if !outcomes.is_empty() {
            JobRepo::record_job_files(self.meta.as_ref(), &job.id, &outcomes).await?;
        }
        checkpoint.next = processed_to;
        checkpoint.done = processed_to;

        // 累计写入达到阈值就整理表。
        // 走到这里文件已经索引完、`job_files` 也已写库:整理只是合并碎片,失败(例如 Lance 的
        // `Retryable commit conflict`)不能让这一片作废,否则检查点不落盘、任务被整片重做。
        // 失败只记警告;计数**不清零**,下一片(或调度器每小时的整理)还会再试。
        if checkpoint.rows_since_optimize >= self.service.optimize_after_rows() {
            match self.service.optimize_locked(&collection).await {
                Ok(()) => checkpoint.rows_since_optimize = 0,
                Err(err) => tracing::warn!(
                    collection = %collection.name,
                    error = %err,
                    "按行数阈值整理向量表失败,已索引的内容不受影响,下一片再试"
                ),
            }
        }

        let finished = checkpoint.next >= checkpoint.paths.len();
        if finished && text_first && !payload.stop_after_text {
            // 先看队列:没有待补向量时直接走下面的收尾,避免把 optimize / 建索引做两遍。
            // 有队列才需要「压碎片 + 建 FTS」,让补向量期间的全文检索不因小片段变慢。
            let pending = self.service.pending_count(&collection.name).await?;
            if pending > 0 {
                match self.service.optimize_locked(&collection).await {
                    Ok(()) => checkpoint.rows_since_optimize = 0,
                    Err(err) => tracing::warn!(
                        collection = %collection.name,
                        error = %err,
                        "文本阶段收尾整理失败,继续补向量,稍后由调度器重试"
                    ),
                }
                // 全量任务在切到补向量之前就把消失的文件清掉:补向量阶段不再扫描目录,
                // 拖到那里就只能等下一次索引,期间这些文件仍能被搜到。
                if payload.mode == "full" {
                    self.service
                        .remove_vanished(
                            &project,
                            &collection,
                            &entries.values().cloned().collect::<Vec<_>>(),
                            &skipped,
                        )
                        .await?;
                }
                // 清理消失文件会连带删掉它们的待补队列项。切阶段前必须重新数一次:
                // 否则 `total` / `pending` 还是清理前的数,补向量阶段会显示一个
                // 永远对不上的进度(队列已经空了,进度条却还停在半路)。
                let pending = self.service.pending_count(&collection.name).await?;
                if pending > 0 {
                    self.service.ensure_indexes_locked(&collection).await?;
                    checkpoint.phase = "embed".to_owned();
                    checkpoint.pending = pending as usize;
                    checkpoint.total = pending as usize;
                    checkpoint.done = 0;
                    checkpoint.next = 0;
                    return Ok(SliceProgress {
                        done: 0,
                        total: Some(pending),
                        finished: false,
                        checkpoint: Some(serde_json::to_string(&checkpoint).unwrap_or_default()),
                        errors: checkpoint.error_samples.clone(),
                        rate_basis: checkpoint.embedded as u64,
                        paused: false,
                    });
                }
            }
        }
        if finished {
            // 全量索引结束时清理消失的文件。先清理再数队列:被删文件的块和队列项
            // 必须一起消失,收尾数字才是用户真正要补的量。
            if payload.mode == "full" {
                self.service
                    .remove_vanished(
                        &project,
                        &collection,
                        &entries.values().cloned().collect::<Vec<_>>(),
                        &skipped,
                    )
                    .await?;
            }
            // 向量补完了就不再是「待补」:进度与收尾摘要都按已补齐展示。
            // 手动 `--text-only` 是例外:任务到这里就结束,队列里的数字必须留着给用户看。
            // 这里要重新数一次总队列,不能只用手动文本阶段累计的 `stats.pending`:
            // 增量只处理一个文件时,更早任务留下的积压也要算进「待补向量」。
            if text_first && payload.stop_after_text {
                checkpoint.pending = self.service.pending_count(&collection.name).await? as usize;
            } else {
                checkpoint.pending = 0;
            }
            // 增量任务(保存一个文件触发)只写几行,结束时不再无条件整理:
            // 每次保存都整理一遍,会让一张几万行的表被反复重写(实测一个下午写了 9 GB)。
            // 它的整理交给上面的累计行数阈值,和调度器每小时一次的整理。
            // 收尾整理同样只是整理碎片:失败时仍要往下建索引、更新 `last_indexed_at`,
            // 否则一次提交冲突就把整个全量任务判成失败,已经做完的索引工作白做。调度器稍后会再整理。
            //
            // 手动 `--text-only` 的增量是例外:FTS 索引已经存在时,刚写进去的 pending 行
            // 还没有被索引覆盖,`ensure_indexes_locked` 又会因为索引存在直接跳过。
            // 不收尾整理一次,这些正文在补向量之前一直搜不到,文本优先就没有意义。
            let manual_text_only = text_first && payload.stop_after_text && checkpoint.pending > 0;
            if payload.mode == "full"
                && let Err(err) = self.service.optimize_locked(&collection).await
            {
                tracing::warn!(
                    collection = %collection.name,
                    error = %err,
                    "全量索引收尾整理向量表失败,继续建索引,稍后由调度器重试"
                );
            } else if payload.mode != "full"
                && manual_text_only
                && let Err(err) = self.service.optimize_locked(&collection).await
            {
                tracing::warn!(
                    collection = %collection.name,
                    error = %err,
                    "手动文本阶段收尾整理失败,新块可能暂时搜不到,稍后由调度器重试"
                );
            }
            self.service.ensure_indexes_locked(&collection).await?;
            let mut updated = project.clone();
            updated.last_indexed_at = Some(now);
            ProjectRepo::update(self.meta.as_ref(), updated).await?;
        }
        Ok(SliceProgress {
            done: checkpoint.done as u64,
            total: Some(checkpoint.total as u64),
            finished,
            checkpoint: Some(serde_json::to_string(&checkpoint).unwrap_or_default()),
            errors: checkpoint.error_samples.clone(),
            rate_basis: checkpoint.embedded as u64,
            paused: false,
        })
    }
}

impl IndexJobHandler {
    /// 补向量阶段:一个分片排空一批队列,队列空了才收尾建索引。
    async fn run_embed_slice(
        &self,
        job: &Job,
        project: &Project,
        collection: &Collection,
        mut checkpoint: IndexCheckpoint,
    ) -> Result<SliceProgress> {
        let before = self.service.pending_count(&collection.name).await?;
        // 队列可能比切阶段时更多(例如切阶段与这一片之间又写入了新的正文):
        // 先把总数抬到当前队列长度,否则 `total - remaining` 会在队列变长时低估进度。
        if before as usize > checkpoint.total {
            checkpoint.total = before as usize;
        }
        if checkpoint.total == 0 {
            checkpoint.total = before as usize;
        }
        // 补向量比文本阶段慢得多,一片多排一点,但保留按时间让路给高优先级任务的机会。
        let batch = (self.slice_files * 16).clamp(64, 1024);
        let embedded = self.service.embed_pending_batch(collection, batch).await?;
        let remaining = self.service.pending_count(&collection.name).await?;
        checkpoint.embedded += embedded;
        // 队列里可能有「向量已经写好、只是没来得及出队」的残留项:它们会在这批里
        // 直接出队而不调用嵌入器,所以完成数按队列算,`pending` 也按剩余队列实时更新。
        checkpoint.pending = remaining as usize;
        checkpoint.done = checkpoint.total.saturating_sub(remaining as usize);
        checkpoint.next = checkpoint.done;
        checkpoint.rows_since_optimize += embedded;
        let finished = remaining == 0;
        if finished {
            checkpoint.pending = 0;
            // 收尾整理 + 建向量索引(此时 ready 行够数才会真的建)。
            match self.service.optimize_locked(collection).await {
                Ok(()) => checkpoint.rows_since_optimize = 0,
                Err(err) => tracing::warn!(
                    collection = %collection.name,
                    error = %err,
                    "补向量收尾整理失败,稍后由调度器重试"
                ),
            }
            self.service.ensure_indexes_locked(collection).await?;
            let mut updated = project.clone();
            updated.last_indexed_at = Some(now_millis());
            ProjectRepo::update(self.meta.as_ref(), updated).await?;
        }
        let _ = job;
        Ok(SliceProgress {
            done: checkpoint.done as u64,
            total: Some(checkpoint.total as u64),
            finished,
            checkpoint: Some(serde_json::to_string(&checkpoint).unwrap_or_default()),
            errors: checkpoint.error_samples.clone(),
            // 速率口径是「累计嵌入的块数」,不能用队列完成数:残留队列项出队时不调用嵌入器,
            // 用完成数会让速率虚高。
            rate_basis: checkpoint.embedded as u64,
            paused: false,
        })
    }
}

/// 磁盘上这个路径是不是已经没了。
///
/// 索引单个文件失败后用它区分「文件在扫描之后被删了」和「文件还在但读不了」:
/// 只认 `NotFound`(以及路径中间的目录变成了文件的 `NotADirectory`)。
/// 不用 `Path::exists`:它把权限不足、符号链接成环等一切 stat 失败都当成「不存在」,
/// 那样会把一个仍在磁盘上、只是暂时读不了的文件的索引清掉。也不匹配错误文案。
fn file_is_gone(path: &std::path::Path) -> bool {
    match std::fs::metadata(path) {
        Ok(_) => false,
        Err(err) => matches!(
            err.kind(),
            std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory
        ),
    }
}

/// 一个文件处理完的变化类型。
///
/// 这是按块数统计推出来的结果(不是 diff):写入 / 重新嵌入过块就是内容变了;
/// 只更新了元数据记 `meta`;没有写入但删掉旧块(文件变短)也算内容变了;
/// 三者都是 0 说明指纹没变、这次什么都没写。
fn change_of(stats: &FileStats, existed: bool) -> FileChange {
    if stats.embedded + stats.pending > 0 {
        return if existed {
            FileChange::Update
        } else {
            FileChange::New
        };
    }
    if stats.updated_meta > 0 {
        return FileChange::Meta;
    }
    if stats.deleted_chunks > 0 {
        return FileChange::Update;
    }
    // 空文件:新建时一个块都没有、嵌入数也是 0;靠「原来在不在」区分,否则新文件会显示成「没变」
    if !existed {
        return FileChange::New;
    }
    FileChange::Skip
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats(chunks: usize, meta: usize, deleted: usize) -> FileStats {
        FileStats {
            chunks,
            embedded: chunks,
            pending: 0,
            updated_meta: meta,
            deleted_chunks: deleted,
        }
    }

    #[test]
    fn change_type_comes_from_what_was_written() {
        assert_eq!(
            change_of(&stats(0, 0, 0), true),
            FileChange::Skip,
            "指纹没变:什么都没写"
        );
        assert_eq!(
            change_of(&stats(0, 0, 0), false),
            FileChange::New,
            "新建的空文件也要算新增"
        );
        assert_eq!(
            change_of(&stats(2, 0, 0), false),
            FileChange::New,
            "库里原来没有"
        );
        assert_eq!(
            change_of(&stats(2, 0, 0), true),
            FileChange::Update,
            "原来有,内容变了"
        );
        assert_eq!(
            change_of(&stats(0, 4, 0), true),
            FileChange::Meta,
            "只更新元数据"
        );
        assert_eq!(
            change_of(&stats(0, 0, 1), true),
            FileChange::Update,
            "没有新块但删了旧块(文件变短)也算内容变了"
        );
    }
}
