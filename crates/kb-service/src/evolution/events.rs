//! 事件接收与增量投递。
//!
//! 事件体 `{kind, project_root, head?, payload?}`。git 事件按
//! `projects.last_commit..HEAD` + 工作区未提交变化投递增量任务;
//! `last_commit` 不可用(rebase / force push / 首次)时退回全量。
//!
//! `session_end`(收尾阶段)除了索引,还会把会话记录整理成对话文本交给
//! [`EvolutionService`] 提炼经验;提炼结果(或失败原因)写进 `events.result`。
//!
//! 会话记录路径来自**外部输入**(hook 的 stdin → HTTP 请求体),服务端不采信:
//! 必须 canonicalize 之后落在允许的目录里(`~/.claude`、`~/.kiro` 或项目根)、
//! 是 `.jsonl` 普通文件、且不命中 的路径黑名单。守护进程里提炼在**后台任务**
//! 里跑,客户端断开不会取消(否则 LLM 已经调用、事件却永远停在未处理)。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use kb_core::model::{Event, Millis, Project};
use kb_core::ports::repo::{EventRepo, MetaStore, ProjectRepo};
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};

use crate::evolution::drafts::{EvolutionService, ProcessOutcome};
use crate::evolution::git::GitRepo;
use crate::evolution::session;
use crate::jobs::queue::{JobQueue, NewJob};

/// 事件种类。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
    /// `git commit` 之后。
    GitCommit,
    /// `git merge` 之后。
    GitMerge,
    /// `git checkout` / `switch` 之后。
    GitCheckout,
    /// 会话结束(Claude Code / Kiro hook)。
    SessionEnd,
    /// 文件变化(监听器)。
    FileChange,
    /// 手动触发。
    Manual,
}

impl EventKind {
    /// 数据库里的字符串。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::GitCommit => "git_commit",
            Self::GitMerge => "git_merge",
            Self::GitCheckout => "git_checkout",
            Self::SessionEnd => "session_end",
            Self::FileChange => "file_change",
            Self::Manual => "manual",
        }
    }

    /// 从字符串解析。
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "git_commit" => Some(Self::GitCommit),
            "git_merge" => Some(Self::GitMerge),
            "git_checkout" => Some(Self::GitCheckout),
            "session_end" => Some(Self::SessionEnd),
            "file_change" => Some(Self::FileChange),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }

    /// 是否 git 事件(需要算 diff)。
    pub fn is_git(self) -> bool {
        matches!(self, Self::GitCommit | Self::GitMerge | Self::GitCheckout)
    }
}

/// 一次事件请求(HTTP 请求体)。
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct EventRequest {
    /// 事件种类。
    pub kind: String,
    /// 项目根目录。
    pub project_root: String,
    /// 当前 HEAD(可选,仅作记录)。
    #[serde(default)]
    pub head: Option<String>,
    /// 附加信息(hook 名、会话路径等)。
    #[serde(default)]
    pub payload: Option<serde_json::Value>,
}

/// 一次事件的处理结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EventOutcome {
    /// 事件 id。
    pub event_id: String,
    /// 命中的项目名。
    pub project: String,
    /// collection。
    pub collection: String,
    /// 投递的任务 id;没有变化时为 `None`。
    pub job_id: Option<String>,
    /// 变化的文件数。
    pub changed_files: usize,
    /// `incremental` / `full` / `noop`。
    pub mode: String,
    /// 写进 `events.result` 的 JSON 文本(索引模式 + 提炼结果或失败原因)。
    pub result: String,
}

/// 会话事件里“提炼”这一步的结局。
enum SessionExtract {
    /// 提炼跑完了(结果写进 `events.result.evolution`)。
    Extracted(ProcessOutcome),
    /// 这次没什么可提炼的,附原因。
    Skipped(String),
}

/// 提炼在哪跑。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtractMode {
    /// 等提炼跑完再返回(嵌入式 CLI 与测试:调用方要拿到结果)。
    Inline,
    /// 先落库、立即返回,提炼在后台跑完再更新同一行(守护进程:客户端断开不影响)。
    Background,
}

/// 后台提炼的路径占位:同一份会话同时只允许一个提炼在跑。
///
/// `EventService` 每个请求新建一次,所以占位集合必须是进程级的。用 `Drop` 守卫
/// 释放,任务 panic 也不会漏。
type ClaimKey = (PathBuf, u64, i64);
static CLAIMS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<ClaimKey>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

/// 占住一份会话;`Drop` 时释放。
struct SessionClaim {
    path: PathBuf,
    /// 内容指纹:在途期间内容又变了,不该被当成同一次
    bytes: u64,
    mtime_ms: i64,
}

impl SessionClaim {
    /// 尝试占位;已经在跑就返回 `None`。
    fn acquire(target: &SessionTarget) -> Option<Self> {
        let key = (target.path.clone(), target.bytes, target.mtime_ms);
        let mut claims = CLAIMS.lock().unwrap_or_else(|poison| poison.into_inner());
        if !claims.insert(key) {
            return None;
        }
        Some(Self {
            path: target.path.clone(),
            bytes: target.bytes,
            mtime_ms: target.mtime_ms,
        })
    }
}

impl Drop for SessionClaim {
    fn drop(&mut self) {
        let mut claims = CLAIMS.lock().unwrap_or_else(|poison| poison.into_inner());
        claims.remove(&(self.path.clone(), self.bytes, self.mtime_ms));
    }
}

/// 在途判定窗口:超过它还没写完的 `pending` 视为残留(后台任务 panic / 被杀),
/// 不再挡下一次提炼。LLM 最坏耗时 ≈ 120 s × (3 次重试 + 1) + 退避,取 15 分钟。
const IN_FLIGHT_MS: i64 = 15 * 60 * 1000;

/// 一次提炼的输入(已通过路径校验)。
#[derive(Clone, Debug, PartialEq, Eq)]
struct SessionTarget {
    /// 规范化后的会话记录路径。
    path: PathBuf,
    /// 文件字节数(去重用)。
    bytes: u64,
    /// 修改时间(unix 毫秒,去重用)。
    mtime_ms: i64,
}

/// 事件服务。
pub struct EventService {
    meta: Arc<dyn MetaStore>,
    queue: JobQueue,
    /// 自动提炼。没接线时 `session_end` 只做索引,`events.result` 里不会出现提炼字段。
    evolution: Option<Arc<EvolutionService>>,
    /// 会话记录允许落在哪些目录(项目根总是允许,这里补 `~/.claude` / `~/.kiro`)。
    session_roots: Vec<PathBuf>,
    /// 提炼的执行方式。
    extract_mode: ExtractMode,
}

impl EventService {
    /// 构造。
    pub fn new(meta: Arc<dyn MetaStore>) -> Self {
        let queue = JobQueue::new(meta.clone());
        Self {
            meta,
            queue,
            evolution: None,
            session_roots: Vec::new(),
            extract_mode: ExtractMode::Inline,
        }
    }

    /// 接上自动提炼:`session_end` 事件会触发提炼(组装根决定接不接)。
    pub fn with_evolution(mut self, evolution: Arc<EvolutionService>) -> Self {
        self.evolution = Some(evolution);
        self
    }

    /// 允许读哪些目录下的会话记录(项目根之外)。守护进程传 `~/.claude` 与 `~/.kiro`。
    pub fn with_session_roots(mut self, roots: Vec<PathBuf>) -> Self {
        self.session_roots = roots;
        self
    }

    /// 提炼放到后台跑(守护进程用):先返回,提炼完再更新 `events.result`。
    pub fn with_background_extraction(mut self) -> Self {
        self.extract_mode = ExtractMode::Background;
        self
    }

    /// 处理一条事件。
    pub async fn handle(&self, request: EventRequest) -> Result<EventOutcome> {
        let kind = EventKind::parse(&request.kind)
            .ok_or_else(|| KbError::InvalidInput(format!("未知的事件种类 {}", request.kind)))?;
        let project = self.resolve_project(&request.project_root).await?;
        let collection = format!("proj_{}", project.slug);
        let event_id = uuid::Uuid::now_v7().to_string();
        let now = now_millis();
        EventRepo::append(
            self.meta.as_ref(),
            Event {
                id: event_id.clone(),
                kind: kind.as_str().to_owned(),
                project_id: Some(project.id.clone()),
                payload_json: serde_json::json!({
                    "project_root": request.project_root,
                    "head": request.head,
                    "payload": request.payload,
                })
                .to_string(),
                received_at: now,
                processed_at: None,
                result: None,
            },
        )
        .await?;

        let (mode, paths, head) = if kind.is_git() {
            let repo = GitRepo::open(&project.root_path)?;
            let changed = repo.changed_since(project.last_commit.as_deref())?;
            let head = changed.head.clone().or(request.head.clone());
            if changed.fallback {
                ("full", Vec::new(), head)
            } else if changed.is_empty() {
                ("noop", Vec::new(), head)
            } else {
                ("incremental", changed.paths, head)
            }
        } else {
            // 非 git 事件:按 payload 里的 paths 处理,没有就全量
            let paths = request
                .payload
                .as_ref()
                .and_then(|payload| payload.get("paths"))
                .and_then(|value| value.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_owned))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if paths.is_empty() {
                // 会话结束只是“该提炼了”的信号:文件变化由监听器负责,
                // 不在这里顺带全量重索引,否则每结束一次会话就重跑整个项目。
                if kind == EventKind::SessionEnd {
                    ("noop", Vec::new(), None)
                } else {
                    ("full", Vec::new(), None)
                }
            } else {
                ("incremental", paths, None)
            }
        };

        let job_id = match mode {
            "full" => {
                let job = self
                    .queue
                    .enqueue(NewJob::full_index(&project.id, &collection))
                    .await?;
                Some(job.id)
            }
            "incremental" => {
                let job = self
                    .queue
                    .enqueue(NewJob::incremental_index(&project.id, &collection, &paths))
                    .await?;
                Some(job.id)
            }
            _ => None,
        };

        // 记录 HEAD,下次从这里开始算
        if let Some(head) = &head {
            let mut updated = project.clone();
            updated.last_commit = Some(head.clone());
            ProjectRepo::update(self.meta.as_ref(), updated).await?;
        }

        // 收尾:会话结束事件顺带提炼经验。提炼失败只写进 `events.result`,
        // 不影响已经投递的索引任务(索引是必做,提炼是加分)。
        let mut result = serde_json::json!({
            "index": match mode {
                "full" => "full_index",
                "incremental" => "incremental_index",
                _ => "noop",
            },
            "changed_files": paths.len(),
        });
        // 后台提炼的目标:落库之后再 spawn(客户端断开不会取消)
        let mut deferred: Option<(SessionTarget, SessionClaim)> = None;
        if kind == EventKind::SessionEnd
            && let Some(evolution) = self.evolution.clone()
        {
            match self.session_target(&project, request.payload.as_ref()) {
                Ok(Some(target)) => {
                    result["session_bytes"] = serde_json::json!(target.bytes);
                    result["session_mtime_ms"] = serde_json::json!(target.mtime_ms);
                    // 项目没开提炼:同步给结论(不必排进后台,`kb hook` 当场就能说明原因)
                    if !project.extract_enabled || !project.allow_cloud_llm {
                        result["evolution"] = serde_json::json!({ "skipped_unauthorized": true });
                    } else {
                        match self.already_extracted(&target).await {
                            Ok(Some(reason)) => {
                                result["evolution"] = serde_json::json!({ "skipped": reason });
                            }
                            Ok(None) if self.extract_mode == ExtractMode::Background => {
                                match SessionClaim::acquire(&target) {
                                    Some(claim) => {
                                        // 先记“已排入后台”,跑完再更新同一行
                                        result["evolution"] =
                                            serde_json::json!({ "pending": true });
                                        deferred = Some((target, claim));
                                    }
                                    None => {
                                        // 同一份会话已经有一个提炼在跑
                                        result["evolution"] =
                                            serde_json::json!({ "skipped": "提炼进行中" });
                                    }
                                }
                            }
                            Ok(None) => {
                                let extract = extract_session(&evolution, &project, &target).await;
                                merge_extract(&mut result, extract);
                            }
                            Err(err) => {
                                tracing::warn!(error = %err, project = %project.name, "会话查重失败");
                                result["evolution_error"] = serde_json::json!(err.to_string());
                            }
                        }
                    }
                }
                Ok(None) => {
                    result["evolution"] =
                        serde_json::json!({ "skipped": "事件里没有会话记录路径" });
                }
                Err(err) => {
                    // 路径不合法 / 读不出来:原因写进 result,不回显绝对路径与系统错误原文
                    tracing::warn!(error = %err, project = %project.name, "会话提炼失败");
                    result["evolution_error"] = serde_json::json!(err.to_string());
                }
            }
        }
        let result_text = result.to_string();

        EventRepo::mark_processed(
            self.meta.as_ref(),
            &event_id,
            now_millis(),
            Some(&result_text),
        )
        .await?;

        // 后台提炼:客户端断开也照跑;跑完把同一行事件的结果补上
        if let Some((target, claim)) = deferred
            && let Some(evolution) = self.evolution.clone()
        {
            let meta = self.meta.clone();
            let base = result.clone();
            let event = event_id.clone();
            let project = project.clone();
            tokio::spawn(async move {
                // 占位跟着任务走:任务结束(含 panic)时 `Drop` 释放
                let _claim = claim;
                // 内层再 spawn 一次:提炼任务 panic 时能拿到 `JoinError`,把事件写成失败
                // 而不是让它永远停在 `pending`
                let inner =
                    tokio::spawn(
                        async move { extract_session(&evolution, &project, &target).await },
                    )
                    .await;
                let extract = match inner {
                    Ok(extract) => extract,
                    Err(err) => {
                        tracing::error!(error = %err, event = %event, "后台提炼任务异常结束");
                        Err(KbError::Internal("提炼任务异常退出".to_owned()))
                    }
                };
                let mut done = base;
                merge_extract(&mut done, extract);
                if let Err(err) = EventRepo::mark_processed(
                    meta.as_ref(),
                    &event,
                    now_millis(),
                    Some(&done.to_string()),
                )
                .await
                {
                    tracing::warn!(error = %err, event = %event, "写回后台提炼结果失败");
                }
            });
        }

        Ok(EventOutcome {
            event_id,
            project: project.name,
            collection,
            job_id,
            changed_files: paths.len(),
            mode: mode.to_owned(),
            result: result_text,
        })
    }

    /// 校验并解析这次事件要提炼的会话记录(路径来自外部输入,不能直接采信)。
    ///
    /// 返回 `Ok(None)` 表示事件里没带路径;路径不合法时返回 `Err`,原因里**不含**
    /// 绝对路径与系统错误原文。
    fn session_target(
        &self,
        project: &Project,
        payload: Option<&serde_json::Value>,
    ) -> Result<Option<SessionTarget>> {
        let Some(raw) = session_path(payload) else {
            return Ok(None);
        };
        let path = validate_session_path(&raw, &project.root_path, &self.session_roots)?;
        let metadata = std::fs::metadata(&path)
            .map_err(|_| KbError::InvalidInput("读不到会话记录".to_owned()))?;
        let mtime_ms = metadata
            .modified()
            .ok()
            .and_then(|when| when.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_millis() as i64)
            .unwrap_or_default();
        Ok(Some(SessionTarget {
            path,
            bytes: metadata.len(),
            mtime_ms,
        }))
    }

    /// 同一份会话(路径 + 大小 + 修改时间)已经提炼过就跳过。
    ///
    /// `Stop` 这类 hook 是**每轮**触发的:没有这道闸,一个长会话会一轮调一次提炼
    /// (外加每条候选一次审核)。判据存在事件表里(`session_bytes` / `session_mtime_ms`),
    /// 不额外建表。
    async fn already_extracted(&self, target: &SessionTarget) -> Result<Option<String>> {
        // 只看最近 200 条**会话事件**(文件监听器写的 `file_change` 不会把窗口挤掉)
        for event in
            EventRepo::recent_by_kind(self.meta.as_ref(), EventKind::SessionEnd.as_str(), 200)
                .await?
        {
            if event.processed_at.is_none() {
                continue;
            }
            let payload: serde_json::Value =
                serde_json::from_str(&event.payload_json).unwrap_or(serde_json::Value::Null);
            let Some(path) = session_path(payload.get("payload")) else {
                continue;
            };
            if Path::new(&path) != target.path {
                continue;
            }
            let Some(result) = event
                .result
                .as_deref()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
            else {
                continue;
            };
            let same_content = result["session_bytes"].as_u64() == Some(target.bytes)
                && result["session_mtime_ms"].as_i64() == Some(target.mtime_ms);
            if !same_content {
                continue;
            }
            // 还在跑的那一份:同一份会话在提炼期间又被触发(Stop + SessionEnd 连发、
            // 重复注册的 hook、宿主重试)不该再排一次。
            // 超过在途窗口的 `pending` 是残留(任务 panic / 进程被杀),不挡下一次。
            if result["evolution"]["pending"].as_bool() == Some(true) {
                let fresh = now_millis() - event.received_at < IN_FLIGHT_MS;
                return Ok(Some(match fresh {
                    true => "提炼进行中".to_owned(),
                    false => continue,
                }));
            }
            // 只有“真的跑过提炼”或“会话里没有对话”才算命中;
            // `skipped_unauthorized`(项目没开提炼)不算,否则打开开关后同一份会话
            // 永远提炼不到。
            let extracted = result["evolution"]["skipped_unauthorized"].as_bool() != Some(true)
                && (result["evolution"].get("candidates").is_some()
                    || result["evolution"].get("outcomes").is_some()
                    || result["evolution"]
                        .get("skipped")
                        .and_then(serde_json::Value::as_str)
                        == Some("会话记录里没有可提炼的对话"));
            if extracted {
                return Ok(Some("会话自上次提炼后没有新内容".to_owned()));
            }
        }
        Ok(None)
    }

    /// 按根目录找项目(最长前缀匹配)。
    async fn resolve_project(&self, root: &str) -> Result<Project> {
        let path = PathBuf::from(root);
        let canonical = std::fs::canonicalize(&path).unwrap_or(path);
        let root = canonical.to_string_lossy().into_owned();
        if let Some(project) = ProjectRepo::match_cwd(self.meta.as_ref(), &root).await? {
            return Ok(project);
        }
        Err(KbError::NotFound(format!("project for {root}")))
    }
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 从事件的 `payload` 里找会话记录路径。
///
/// `kb hook` 自己写 `session_path`;Claude Code 的 hook 输入里叫 `transcript_path`,
/// 两个都认(见下文)。
fn session_path(payload: Option<&serde_json::Value>) -> Option<String> {
    let payload = payload?;
    ["session_path", "transcript_path"]
        .iter()
        .find_map(|key| payload.get(*key).and_then(serde_json::Value::as_str))
        .map(str::to_owned)
}

/// 校验会话记录路径(外部输入)。
///
/// 必须:存在、是普通文件、扩展名 `.jsonl`、canonicalize 之后落在允许的目录里
/// (项目根 / `~/.claude` / `~/.kiro`),且不命中 的路径黑名单。错误信息里
/// **不带**绝对路径与系统错误原文 —— 它是外部输入,不该借错误回显探测本机文件。
fn validate_session_path(raw: &str, project_root: &str, roots: &[PathBuf]) -> Result<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(KbError::InvalidInput("会话记录路径为空".to_owned()));
    }
    let path = PathBuf::from(trimmed);
    let canonical = std::fs::canonicalize(&path)
        .map_err(|_| KbError::InvalidInput("会话记录不存在或打不开".to_owned()))?;
    if !canonical.is_file() {
        return Err(KbError::InvalidInput(
            "会话记录不是普通文件(目录 / 设备 / FIFO 都不读)".to_owned(),
        ));
    }
    // :命中路径黑名单的文件(密钥 / .env / 凭据)一律不读
    if kb_core::redact::is_blacklisted_path(&canonical.to_string_lossy()) {
        return Err(KbError::InvalidInput(
            "会话记录命中禁止读取的路径规则".to_owned(),
        ));
    }
    if !canonical
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
    {
        return Err(KbError::InvalidInput(
            "会话记录必须是 .jsonl 文件".to_owned(),
        ));
    }
    let mut allowed: Vec<PathBuf> = roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect();
    if let Ok(root) = std::fs::canonicalize(project_root) {
        allowed.push(root);
    }
    if !allowed.iter().any(|root| canonical.starts_with(root)) {
        return Err(KbError::InvalidInput(
            "会话记录不在允许的目录里(项目根或 [evolution] session_roots 里列出的目录)".to_owned(),
        ));
    }
    Ok(canonical)
}

/// 读会话记录 → 交给 [`EvolutionService`] 提炼。
async fn extract_session(
    evolution: &EvolutionService,
    project: &Project,
    target: &SessionTarget,
) -> Result<SessionExtract> {
    // 会话记录可能几十上百 MB:读盘 + 逐行解析放 blocking 池,别占着 async 线程
    let reader = target.path.clone();
    let text = tokio::task::spawn_blocking(move || session::read_session_text(&reader))
        .await
        .map_err(|err| KbError::Internal(format!("读会话记录的任务失败: {err}")))??;
    // 空会话也调一次 LLM 是纯浪费:本机实测有 sidecar 已写 cwd、正文还是 0 字节的会话
    if text.trim().is_empty() {
        return Ok(SessionExtract::Skipped(
            "会话记录里没有可提炼的对话".to_owned(),
        ));
    }
    let outcome = evolution.process(&project.id, "session_end", &text).await?;
    Ok(SessionExtract::Extracted(outcome))
}

/// 守护进程启动时调用:把上一进程留下的 `pending` 收尾。
///
/// 后台提炼跑在 `tokio::spawn` 里,进程被杀就没人回写 —— 那行会永远停在
/// `pending`,去重闸也会把它当成“已提炼”。启动时统一改写成
/// `evolution_error`,下次同一份会话再触发就会重新提炼。
///
/// 返回改写的条数。
pub async fn recover_interrupted_pending(meta: Arc<dyn MetaStore>) -> Result<usize> {
    let mut fixed = 0;
    for event in
        EventRepo::recent_by_kind(meta.as_ref(), EventKind::SessionEnd.as_str(), 200).await?
    {
        let Some(result) = event.result.as_deref() else {
            continue;
        };
        let Ok(mut value) = serde_json::from_str::<serde_json::Value>(result) else {
            continue;
        };
        if value["evolution"]["pending"].as_bool() != Some(true) {
            continue;
        }
        if let Some(object) = value.as_object_mut() {
            object.remove("evolution");
        }
        value["evolution_error"] = serde_json::json!("守护进程重启,提炼中断");
        EventRepo::mark_processed(
            meta.as_ref(),
            &event.id,
            now_millis(),
            Some(&value.to_string()),
        )
        .await?;
        fixed += 1;
    }
    if fixed > 0 {
        tracing::info!(count = fixed, "把中断的后台提炼标记为失败");
    }
    Ok(fixed)
}

/// 把提炼结局并进 `events.result`。
///
/// 合并前先清掉上一次写的 `evolution`(里面是 `pending: true`):失败时不能留下
/// “既在排队又已经失败”的矛盾状态。
fn merge_extract(result: &mut serde_json::Value, extract: Result<SessionExtract>) {
    if let Some(object) = result.as_object_mut() {
        object.remove("evolution");
    }
    match extract {
        Ok(SessionExtract::Extracted(outcome)) => {
            result["evolution"] = serde_json::to_value(&outcome)
                .unwrap_or_else(|err| serde_json::json!({ "serialize_error": err.to_string() }));
        }
        Ok(SessionExtract::Skipped(reason)) => {
            result["evolution"] = serde_json::json!({ "skipped": reason });
        }
        Err(err) => {
            tracing::warn!(error = %err, "会话提炼失败");
            result["evolution_error"] = serde_json::json!(err.to_string());
        }
    }
}
