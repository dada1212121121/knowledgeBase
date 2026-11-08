//! 网页来源的 AI 规范化。
//!
//! 网页数据源同步完(原文照常入库)之后,如果打开了 `ai_extract`,同步会投递一个 `web_extract`
//! 后台任务。任务逐页:
//! 1. 用 `extract_html` 取正文,算正文哈希与提示词哈希;两者都没变就跳过,**不调模型**;
//! 2. 经 [`LlmGate`] 外发(AI 开关、项目 `allow_cloud_llm`、脱敏、留痕、全站与个人额度都在那里);
//! 3. 解析模型输出(宽松解析 + 长度上限 + 链接白名单),超长页面分段后合并;
//! 4. 渲染成 Markdown 写到 `sources/.ai/<id>/<页面>.ai.md`,结果 JSON 与哈希写到
//!    `sources/.ai/<id>/<页面>.json`(都在扫描根之外,同步不会把它们当成普通文件);
//! 5. Markdown 进解析队列(同一个 collection、同一组标签,另加 `ai-extract`),派生边指向原文页面。
//!
//! 闸门拒绝(AI 关了、项目没开外发、额度用完、每小时次数到顶)时**暂停、不算失败**:
//! 在数据源上留一句人话,没整理的页下次同步自动补(因为它们的结果文件不存在或哈希对不上)。

pub mod normalize;
pub mod prompt;
pub mod render;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use kb_core::config::WebExtractConfig;
use kb_core::model::{
    IngestFile, IngestState, Job, JobState, Millis, Source, SourceAiStatus, SourceKind,
};
use kb_core::paths::KbPaths;
use kb_core::ports::ChatModel;
use kb_core::ports::repo::{AuditRepo, CollectionRepo, IngestRepo, JobRepo, MetaStore, SourceRepo};
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::jobs::queue::{JobQueue, NewJob, priority};
use crate::jobs::{JobHandler, SliceProgress};
use crate::llm_gate::{LlmGate, Purpose};
use crate::upload::ingest::record_ingest_change;

use normalize::NormalizedPage;
use prompt::{PageInput, WEB_EXTRACT_PROMPT};
use render::RenderMeta;

/// 任务类型。
pub const JOB_KIND: &str = "web_extract";

/// AI 规范化结果额外打的标签(检索时可以 `tag:ai-extract` 只看 / 排除它们)。
pub const AI_TAG: &str = "ai-extract";

/// 规范化结果文件的后缀。
pub const AI_SUFFIX: &str = ".ai.md";

/// 任务优先级:比解析(60)低,上传 / 原文入库排在它前面;一页一个分片,分片之间可以被抢占。
pub const PRIORITY: i32 = priority::FULL_INDEX + 10;

/// 失败原因最多在说明里列几条(其余只计数)。
const MAX_FAILURE_NOTES: usize = 3;

/// 后台任务需要、但 `kb-service` 自己拿不到的部件,由组装根(`kb-cli`)实现。
///
/// 每个分片现取:配置、模型、skills 都可能被热更新,改完下一页就按新的走。
pub trait WebExtractDeps: Send + Sync {
    /// 当前的 `[web_extract]` 配置。
    fn settings(&self) -> WebExtractConfig;
    /// AI 总开关与「自动提炼与审核」子开关是否都开着(规范化属于后台自动调用模型)。
    fn ai_enabled(&self) -> bool;
    /// 外发闸门;`payer` 是付费人(多用户下发起同步的用户),`None` 只受全站预算约束。
    fn gate(&self, payer: Option<&str>) -> LlmGate;
    /// 对话模型;没有配置 API key 时返回 `None`(这时不跑,也不写假结果)。
    fn model(&self) -> Result<Option<Arc<dyn ChatModel>>>;
    /// skills 里 `stage = "web_extract"` 的提示词覆盖。
    fn prompt_override(&self) -> Option<String>;
}

/// 任务参数。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct WebExtractPayload {
    /// 数据源。
    pub source_id: String,
    /// 触发这次整理的同步批次(日志与排查用)。
    pub sync_batch_id: String,
    /// 谁触发的(写进审计批次)。
    pub actor: String,
    /// 付费人(多用户下发起同步的用户 id)。
    #[serde(default)]
    pub payer: Option<String>,
}

/// 分片之间的检查点。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
struct Checkpoint {
    /// 处理到第几页(按相对路径排序后的下标)。
    cursor: usize,
    /// 这次任务里调过模型的页数(含失败的),到 `max_pages_per_sync` 为止。
    called: usize,
    /// 结果与正文、提取要求一致的页数(含本来就没变的)。
    done: u64,
    /// 留到下次的页数。
    pending: u64,
    /// 失败的页数。
    failed: u64,
    /// 失败原因(最多几条)。
    failures: Vec<String>,
    /// 规范化结果入库用的批次(第一次写结果时才建)。
    batch_id: Option<String>,
    /// 批次里排了几个文件。
    queued: u64,
}

/// 一页结果的留档(`sources/.ai/<id>/<页面>.json`)。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PageRecord {
    /// 格式版本。
    pub version: u32,
    /// 页面地址。
    pub url: String,
    /// 正文哈希。
    pub content_hash: String,
    /// 提示词哈希。
    pub prompt_hash: String,
    /// 用的模型。
    pub model: String,
    /// 整理时间。
    pub at: Millis,
    /// 切了几段。
    pub parts: usize,
    /// 规范化结果。
    pub result: NormalizedPage,
}

// ---------------- 路径约定 ----------------

/// 规范化结果的根目录:`<KB_HOME>/sources/.ai/<source_id>`(扫描根之外)。
pub fn ai_dir(paths: &KbPaths, source_id: &str) -> PathBuf {
    paths.sources_dir().join(".ai").join(source_id)
}

/// 抓取清单(相对路径 → URL),由同步写:`<KB_HOME>/sources/.urls/<source_id>.json`。
pub fn manifest_path(paths: &KbPaths, source_id: &str) -> PathBuf {
    paths
        .sources_dir()
        .join(".urls")
        .join(format!("{source_id}.json"))
}

/// 原文页面的相对路径 → 规范化结果的相对路径(`a/index.html` → `a/index.ai.md`)。
pub fn ai_rel_path(rel_path: &str) -> String {
    let lower = rel_path.to_ascii_lowercase();
    for ext in [".html", ".htm", ".xhtml"] {
        if lower.ends_with(ext) {
            return format!("{}{AI_SUFFIX}", &rel_path[..rel_path.len() - ext.len()]);
        }
    }
    format!("{rel_path}{AI_SUFFIX}")
}

/// 规范化结果 Markdown 的绝对路径。
pub fn output_path(paths: &KbPaths, source_id: &str, rel_path: &str) -> PathBuf {
    ai_dir(paths, source_id).join(ai_rel_path(rel_path))
}

/// 一页结果留档的绝对路径。
pub fn record_path(paths: &KbPaths, source_id: &str, rel_path: &str) -> PathBuf {
    ai_dir(paths, source_id).join(format!("{rel_path}.json"))
}

/// 解析队列里的这一行是不是规范化结果(解析任务据此加 `ai-extract` 标签)。
pub fn is_ai_output(file: &IngestFile) -> bool {
    file.derived_from.is_some() && file.rel_path.ends_with(AI_SUFFIX)
}

/// 读抓取清单(按相对路径排序;没有清单返回空)。
pub fn read_manifest(paths: &KbPaths, source_id: &str) -> Vec<(String, String)> {
    let Ok(text) = std::fs::read_to_string(manifest_path(paths, source_id)) else {
        return Vec::new();
    };
    serde_json::from_str::<BTreeMap<String, String>>(&text)
        .map(|map| map.into_iter().collect())
        .unwrap_or_default()
}

/// 删掉一页的规范化结果(Markdown 与留档)。页面从站点上消失时同步调用。
pub fn remove_page_outputs(paths: &KbPaths, source_id: &str, rel_path: &str) {
    for path in [
        output_path(paths, source_id, rel_path),
        record_path(paths, source_id, rel_path),
    ] {
        if path.exists()
            && let Err(err) = std::fs::remove_file(&path)
        {
            tracing::warn!(path = %path.display(), error = %err, "删除规范化结果失败");
        }
    }
}

/// 投递一次规范化任务;同一个数据源已经有排队中的任务时不重复投递(定时刷新很频繁时不会堆积)。
pub async fn enqueue(
    meta: &Arc<dyn MetaStore>,
    source: &Source,
    payload: &WebExtractPayload,
) -> Result<Option<Job>> {
    let queued = JobRepo::list(meta.as_ref(), Some(JobState::Queued)).await?;
    let pending = queued.iter().any(|job| {
        job.kind == JOB_KIND
            && serde_json::from_str::<WebExtractPayload>(&job.payload_json)
                .is_ok_and(|existing| existing.source_id == source.id)
    });
    if pending {
        return Ok(None);
    }
    let job = JobQueue::new(meta.clone())
        .enqueue(NewJob {
            kind: JOB_KIND.to_owned(),
            collection: Some(source.collection.clone()),
            priority: PRIORITY,
            payload: serde_json::to_value(payload)
                .map_err(|err| KbError::Internal(format!("序列化任务参数失败: {err}")))?,
        })
        .await?;
    Ok(Some(job))
}

// ---------------- 后台任务 ----------------

/// `web_extract` 任务处理器。
pub struct WebExtractJobHandler {
    meta: Arc<dyn MetaStore>,
    paths: KbPaths,
    deps: Arc<dyn WebExtractDeps>,
}

/// 一页当前的状态。
enum PageState {
    /// 原文文件不在了(同步之间被清理),跳过。
    Missing,
    /// 没有正文(纯脚本页面之类),不送模型。
    Empty,
    /// 结果与正文、提取要求一致。
    Current,
    /// 需要整理。
    Work(Box<PageWork>),
}

/// 一页待整理的材料。
struct PageWork {
    rel_path: String,
    url: String,
    title: Option<String>,
    lines: Vec<String>,
    links: Vec<String>,
    content_hash: String,
}

/// 一页整理的结果。
enum PageOutcome {
    /// 写好了。
    Done,
    /// 闸门拒绝 / 额度用完:整个任务暂停。
    Paused(String),
    /// 这一页失败(其它页照常)。
    Failed(String),
}

/// 一次任务共用的上下文。
struct RunCtx<'a> {
    source: &'a Source,
    payload: &'a WebExtractPayload,
    settings: &'a WebExtractConfig,
    template: Option<&'a str>,
    prompt_hash: &'a str,
    project_id: Option<&'a str>,
    gate: &'a LlmGate,
    model: &'a Arc<dyn ChatModel>,
}

impl WebExtractJobHandler {
    /// 构造。
    pub fn new(meta: Arc<dyn MetaStore>, paths: KbPaths, deps: Arc<dyn WebExtractDeps>) -> Self {
        Self { meta, paths, deps }
    }

    /// 判断一页需不需要整理(只读本地文件,不联网)。
    fn page_state(
        &self,
        source: &Source,
        rel_path: &str,
        url: &str,
        prompt_hash: &str,
    ) -> PageState {
        let html_path = self.paths.source_dir(&source.id).join(rel_path);
        let Ok(bytes) = std::fs::read(&html_path) else {
            return PageState::Missing;
        };
        let html = String::from_utf8_lossy(&bytes);
        let page = kb_extract::html::extract_html(&html);
        let lines = prompt::body_lines(&page.blocks);
        if lines.is_empty() {
            return PageState::Empty;
        }
        let content_hash = prompt::content_hash(page.title.as_deref(), &lines);
        let current = std::fs::read_to_string(record_path(&self.paths, &source.id, rel_path))
            .ok()
            .and_then(|text| serde_json::from_str::<PageRecord>(&text).ok())
            .is_some_and(|record| {
                record.content_hash == content_hash
                    && record.prompt_hash == prompt_hash
                    && output_path(&self.paths, &source.id, rel_path).is_file()
            });
        if current {
            return PageState::Current;
        }
        PageState::Work(Box::new(PageWork {
            rel_path: rel_path.to_owned(),
            url: url.to_owned(),
            title: page.title,
            links: crate::sources_web::page_links(url, &html),
            lines,
            content_hash,
        }))
    }

    /// 剩下的页里有几页需要整理(暂停 / 前置条件不满足时给“待整理”计数)。
    fn count_pending(&self, source: &Source, pages: &[(String, String)], prompt_hash: &str) -> u64 {
        pages
            .iter()
            .filter(|(rel, url)| {
                matches!(
                    self.page_state(source, rel, url, prompt_hash),
                    PageState::Work(_)
                )
            })
            .count() as u64
    }

    /// 整理一页:分段调用模型、解析、合并、渲染、落盘、入队。
    async fn normalize_page(
        &self,
        ctx: &RunCtx<'_>,
        work: &PageWork,
        checkpoint: &mut Checkpoint,
    ) -> Result<PageOutcome> {
        // 结果路径已被占用时跳过,不花这次调用:站点上恰好有一个叫 `index.ai.md` 的真实页面,
        // 或者同一个集合里另一个数据源抓了同一个站点(原文入库本来就会冲突)
        if let Some(existing) = IngestRepo::get_by_path(
            self.meta.as_ref(),
            &ctx.source.collection,
            &ai_rel_path(&work.rel_path),
        )
        .await?
            && (!is_ai_output(&existing)
                || existing.source_id.as_deref() != Some(ctx.source.id.as_str()))
        {
            return Ok(PageOutcome::Failed(
                "规范化结果的路径已被站点上的真实页面或另一个数据源占用,跳过".to_owned(),
            ));
        }
        let (parts, truncated) = prompt::split_parts(
            &work.lines,
            ctx.settings.max_input_chars,
            ctx.settings.max_parts,
        );
        let input = PageInput {
            url: work.url.clone(),
            title: work.title.clone(),
            fetched_on: crate::llm_gate::today(),
            requirement: ctx.source.extract_prompt.clone(),
            model: ctx.model.id().to_owned(),
        };
        let mut results = Vec::with_capacity(parts.len());
        for (index, part) in parts.iter().enumerate() {
            let request = prompt::build_request(&input, ctx.template, part, index, parts.len());
            // 输出不是合法 JSON 时同一段重试 1 次;两次都不行这一页算失败
            let mut parsed = None;
            let mut last_error = String::new();
            for _attempt in 0..2 {
                let response = match ctx
                    .gate
                    .send(
                        ctx.project_id,
                        Purpose::WebExtract,
                        ctx.model,
                        request.clone(),
                    )
                    .await
                {
                    Ok(response) => response,
                    // 闸门拒绝、额度用完、模型鉴权失败 / 限流:不是这一页的问题,整个任务暂停
                    Err(KbError::Forbidden(reason) | KbError::Unavailable(reason)) => {
                        return Ok(PageOutcome::Paused(reason));
                    }
                    Err(err) => return Ok(PageOutcome::Failed(err.to_string())),
                };
                let text = response.message.content.unwrap_or_default();
                match normalize::parse_output(&text, &work.links) {
                    Ok(page) => {
                        parsed = Some(page);
                        break;
                    }
                    Err(err) => last_error = err.to_string(),
                }
            }
            match parsed {
                Some(page) => results.push(page),
                None => {
                    return Ok(PageOutcome::Failed(format!(
                        "模型两次都没有返回合法的规范化结果({last_error})"
                    )));
                }
            }
        }
        let mut merged = normalize::merge(results);
        merged.truncated |= truncated;
        let markdown = render::render_markdown(
            &merged,
            &RenderMeta {
                url: &work.url,
                fetched_on: &input.fetched_on,
                model: &input.model,
                fallback_title: work.title.as_deref(),
                parts: parts.len(),
            },
        );
        let record = PageRecord {
            version: prompt::FORMAT_VERSION,
            url: work.url.clone(),
            content_hash: work.content_hash.clone(),
            prompt_hash: ctx.prompt_hash.to_owned(),
            model: input.model.clone(),
            at: now_millis(),
            parts: parts.len(),
            result: merged,
        };
        let output = output_path(&self.paths, &ctx.source.id, &work.rel_path);
        write_file(&output, markdown.as_bytes())?;
        // 留档最后写:进程在两步之间被杀时,下次看到留档缺失会重新整理,而不是误以为已经是最新
        let record_json = serde_json::to_vec_pretty(&record)
            .map_err(|err| KbError::Internal(format!("序列化规范化结果失败: {err}")))?;
        self.register(ctx, work, &output, markdown.len() as u64, checkpoint)
            .await?;
        write_file(
            &record_path(&self.paths, &ctx.source.id, &work.rel_path),
            &record_json,
        )?;
        Ok(PageOutcome::Done)
    }

    /// 结果 Markdown 进解析队列(已有行就并进本次批次重新解析)。
    async fn register(
        &self,
        ctx: &RunCtx<'_>,
        work: &PageWork,
        output: &Path,
        size: u64,
        checkpoint: &mut Checkpoint,
    ) -> Result<()> {
        let batch_id = match &checkpoint.batch_id {
            Some(batch_id) => batch_id.clone(),
            None => {
                let batch_id = uuid::Uuid::now_v7().to_string();
                AuditRepo::ensure_batch(
                    self.meta.as_ref(),
                    &batch_id,
                    &ctx.payload.actor,
                    &format!("AI 规范化 {}", ctx.source.name),
                )
                .await?;
                checkpoint.batch_id = Some(batch_id.clone());
                batch_id
            }
        };
        let rel_path = ai_rel_path(&work.rel_path);
        match IngestRepo::get_by_path(self.meta.as_ref(), &ctx.source.collection, &rel_path).await?
        {
            Some(file) => {
                IngestRepo::set_batch(self.meta.as_ref(), &file.id, Some(&batch_id)).await?;
                IngestRepo::set_state(self.meta.as_ref(), &file.id, IngestState::Queued, None)
                    .await?;
            }
            None => {
                let now = now_millis();
                let file = IngestFile {
                    id: uuid::Uuid::now_v7().to_string(),
                    batch_id: Some(batch_id.clone()),
                    source_id: Some(ctx.source.id.clone()),
                    upload_id: None,
                    collection: ctx.source.collection.clone(),
                    rel_path: rel_path.clone(),
                    abs_path: output.display().to_string(),
                    size,
                    // 不记内容哈希:这一行的内容每次整理都会重写,而解析队列没有“改哈希”的接口,
                    // 留一个旧哈希反而会让上传秒传误判成“已有相同内容”
                    sha256: None,
                    state: IngestState::Queued,
                    error: None,
                    chunks: 0,
                    vectors: 0,
                    extract_meta: None,
                    // 派生边:规范化结果 → 原文页面(解析完成后由解析任务补边)
                    derived_from: Some(work.rel_path.clone()),
                    elapsed_ms: None,
                    created_at: now,
                    updated_at: now,
                };
                IngestRepo::create(self.meta.as_ref(), file.clone()).await?;
                record_ingest_change(
                    self.meta.as_ref(),
                    &batch_id,
                    &file.id,
                    None,
                    json!({
                        "ingest_id": file.id,
                        "collection": file.collection,
                        "rel_path": file.rel_path,
                        "source_id": file.source_id,
                        "abs_path": file.abs_path,
                        "sha256": serde_json::Value::Null,
                        "size": file.size,
                    }),
                )
                .await?;
            }
        }
        checkpoint.queued += 1;
        Ok(())
    }

    /// 收尾:投递解析任务、写整理情况。
    async fn finish(
        &self,
        source: &Source,
        checkpoint: &Checkpoint,
        note: Option<String>,
    ) -> Result<()> {
        if let Some(batch_id) = &checkpoint.batch_id
            && checkpoint.queued > 0
        {
            // 解析任务在最后统一投:批次一旦被解析任务标成“完成”,后面再往里加的文件就没人处理了
            JobQueue::new(self.meta.clone())
                .enqueue(NewJob {
                    kind: "ingest".to_owned(),
                    collection: Some(source.collection.clone()),
                    priority: priority::REVIEW_EXTRACT,
                    payload: json!({ "batch_id": batch_id, "collection": source.collection }),
                })
                .await?;
        }
        let note = note.or_else(|| summary_note(checkpoint));
        SourceRepo::set_ai_status(
            self.meta.as_ref(),
            &source.id,
            Some(SourceAiStatus {
                done: checkpoint.done,
                pending: checkpoint.pending,
                failed: checkpoint.failed,
                note,
                updated_at: now_millis(),
            }),
        )
        .await
    }

    /// 前置条件不满足(AI 关了 / 项目没开外发 / 没配模型):不调模型,记下还有几页待整理。
    ///
    /// `prior` 是前面分片的检查点:任务跑到一半 AI 被关掉时,已经写好的结果仍要投递解析。
    async fn blocked(
        &self,
        source: &Source,
        pages: &[(String, String)],
        prompt_hash: &str,
        reason: String,
        prior: &Checkpoint,
    ) -> Result<SliceProgress> {
        let mut checkpoint = Checkpoint {
            batch_id: prior.batch_id.clone(),
            queued: prior.queued,
            ..Checkpoint::default()
        };
        for (rel, url) in pages {
            match self.page_state(source, rel, url, prompt_hash) {
                PageState::Current => checkpoint.done += 1,
                PageState::Work(_) => checkpoint.pending += 1,
                PageState::Missing | PageState::Empty => {}
            }
        }
        self.finish(source, &checkpoint, Some(reason)).await?;
        Ok(finished_progress(pages.len() as u64))
    }
}

#[async_trait]
impl JobHandler for WebExtractJobHandler {
    async fn run_slice(&self, job: &Job) -> Result<SliceProgress> {
        let payload: WebExtractPayload = serde_json::from_str(&job.payload_json)
            .map_err(|err| KbError::InvalidInput(format!("规范化任务参数非法: {err}")))?;
        let mut checkpoint: Checkpoint = job
            .checkpoint_json
            .as_deref()
            .and_then(|text| serde_json::from_str(text).ok())
            .unwrap_or_default();
        // 数据源被删了、改成不整理了:安静结束,不改它的状态
        let Some(source) = SourceRepo::get(self.meta.as_ref(), &payload.source_id).await? else {
            return Ok(finished_progress(0));
        };
        if source.kind != SourceKind::Web || !source.ai_extract {
            return Ok(finished_progress(0));
        }
        let pages = read_manifest(&self.paths, &source.id);
        if pages.is_empty() {
            self.finish(
                &source,
                &checkpoint,
                Some("还没有抓到页面,先同步一次".to_owned()),
            )
            .await?;
            return Ok(finished_progress(0));
        }
        let settings = self.deps.settings();
        let template = self.deps.prompt_override();
        let prompt_hash = prompt::prompt_hash(
            template.as_deref().unwrap_or(WEB_EXTRACT_PROMPT),
            &source.extract_prompt,
            settings.max_input_chars,
            settings.max_parts,
        );

        if !self.deps.ai_enabled() {
            return self
                .blocked(
                    &source,
                    &pages,
                    &prompt_hash,
                    "AI 规范化已暂停:AI 功能(或其中的「自动提炼与审核」)已关闭".to_owned(),
                    &checkpoint,
                )
                .await;
        }
        let project_id = match CollectionRepo::get(self.meta.as_ref(), &source.collection).await? {
            Some(collection) => collection.project_id,
            None => {
                return Err(KbError::NotFound(format!(
                    "collection {}",
                    source.collection
                )));
            }
        };
        let gate = self.deps.gate(payload.payer.as_deref());
        if !gate.allowed(project_id.as_deref()).await? {
            return self
                .blocked(
                    &source,
                    &pages,
                    &prompt_hash,
                    "AI 规范化已暂停:目标集合所属的项目没有允许把内容发给云端模型(allow_cloud_llm)"
                        .to_owned(),
                    &checkpoint,
                )
                .await;
        }
        let Some(model) = self.deps.model()? else {
            return self
                .blocked(
                    &source,
                    &pages,
                    &prompt_hash,
                    "AI 规范化没有运行:还没有配置模型的 API key(设置 → 模型)".to_owned(),
                    &checkpoint,
                )
                .await;
        };

        let ctx = RunCtx {
            source: &source,
            payload: &payload,
            settings: &settings,
            template: template.as_deref(),
            prompt_hash: &prompt_hash,
            project_id: project_id.as_deref(),
            gate: &gate,
            model: &model,
        };
        let total = pages.len() as u64;
        let mut called_this_slice = false;
        let mut paused: Option<String> = None;
        while checkpoint.cursor < pages.len() {
            let (rel, url) = &pages[checkpoint.cursor];
            match self.page_state(&source, rel, url, &prompt_hash) {
                PageState::Missing | PageState::Empty => {}
                PageState::Current => checkpoint.done += 1,
                PageState::Work(work) => {
                    // 一个分片最多调一页模型:模型慢,分片之间 worker 才能让给更高优先级的任务
                    if called_this_slice {
                        break;
                    }
                    if checkpoint.called >= settings.max_pages_per_sync {
                        checkpoint.pending += 1;
                    } else {
                        called_this_slice = true;
                        checkpoint.called += 1;
                        match self.normalize_page(&ctx, &work, &mut checkpoint).await? {
                            PageOutcome::Done => checkpoint.done += 1,
                            PageOutcome::Failed(reason) => {
                                tracing::warn!(source = %source.id, page = %rel, %reason, "网页规范化失败");
                                checkpoint.failed += 1;
                                if checkpoint.failures.len() < MAX_FAILURE_NOTES {
                                    checkpoint.failures.push(format!("{rel}:{reason}"));
                                }
                            }
                            PageOutcome::Paused(reason) => {
                                // 这一页和后面所有需要整理的页都留到下次
                                checkpoint.pending += self.count_pending(
                                    &source,
                                    &pages[checkpoint.cursor..],
                                    &prompt_hash,
                                );
                                paused = Some(format!("AI 规范化已暂停:{reason}"));
                                break;
                            }
                        }
                    }
                }
            }
            checkpoint.cursor += 1;
        }

        let finished = paused.is_some() || checkpoint.cursor >= pages.len();
        if finished {
            self.finish(&source, &checkpoint, paused).await?;
        } else {
            // 还没跑完:先把进度写给界面看
            SourceRepo::set_ai_status(
                self.meta.as_ref(),
                &source.id,
                Some(SourceAiStatus {
                    done: checkpoint.done,
                    pending: checkpoint.pending,
                    failed: checkpoint.failed,
                    note: Some(format!(
                        "正在整理:已处理 {} / {} 页",
                        checkpoint.cursor, total
                    )),
                    updated_at: now_millis(),
                }),
            )
            .await?;
        }
        Ok(SliceProgress {
            done: checkpoint.cursor as u64,
            total: Some(total),
            finished,
            checkpoint: Some(
                serde_json::to_string(&checkpoint)
                    .map_err(|err| KbError::Internal(format!("序列化检查点失败: {err}")))?,
            ),
            errors: checkpoint.failures.clone(),
            rate_basis: checkpoint.done,
            paused: false,
        })
    }
}

/// 正常结束时的说明:有留到下次的、有失败的才写。
fn summary_note(checkpoint: &Checkpoint) -> Option<String> {
    let mut notes = Vec::new();
    if checkpoint.pending > 0 {
        notes.push(format!(
            "每次同步最多整理 {} 页,剩余 {} 页下次同步补",
            checkpoint.called, checkpoint.pending
        ));
    }
    if checkpoint.failed > 0 {
        let mut text = format!("{} 页整理失败", checkpoint.failed);
        if let Some(first) = checkpoint.failures.first() {
            text.push_str(&format!("(例如 {first})"));
        }
        notes.push(text);
    }
    (!notes.is_empty()).then(|| notes.join(";"))
}

fn finished_progress(total: u64) -> SliceProgress {
    SliceProgress {
        done: total,
        total: Some(total),
        finished: true,
        ..SliceProgress::default()
    }
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
        })?;
    }
    std::fs::write(path, bytes)
        .map_err(|err| KbError::Internal(format!("写入 {} 失败: {err}", path.display())))
}

fn now_millis() -> Millis {
    crate::llm_gate::today_now_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ai_paths_sit_next_to_the_page_name_outside_the_scan_root() {
        assert_eq!(ai_rel_path("a.com/index.html"), "a.com/index.ai.md");
        assert_eq!(ai_rel_path("a.com/docs/A.HTM"), "a.com/docs/A.ai.md");
        assert_eq!(ai_rel_path("a.com/page.php"), "a.com/page.php.ai.md");
        let paths = KbPaths::from_home(Path::new("/kb"));
        assert_eq!(
            output_path(&paths, "s1", "a.com/index.html"),
            PathBuf::from("/kb/sources/.ai/s1/a.com/index.ai.md")
        );
        assert_eq!(
            record_path(&paths, "s1", "a.com/index.html"),
            PathBuf::from("/kb/sources/.ai/s1/a.com/index.html.json")
        );
        assert_eq!(
            manifest_path(&paths, "s1"),
            PathBuf::from("/kb/sources/.urls/s1.json")
        );
        let file = IngestFile {
            id: "f".to_owned(),
            batch_id: None,
            source_id: Some("s1".to_owned()),
            upload_id: None,
            collection: "_global".to_owned(),
            rel_path: "a.com/index.ai.md".to_owned(),
            abs_path: String::new(),
            size: 1,
            sha256: None,
            state: IngestState::Queued,
            error: None,
            chunks: 0,
            vectors: 0,
            extract_meta: None,
            derived_from: Some("a.com/index.html".to_owned()),
            elapsed_ms: None,
            created_at: 0,
            updated_at: 0,
        };
        assert!(is_ai_output(&file));
        assert!(!is_ai_output(&IngestFile {
            derived_from: None,
            ..file.clone()
        }));
        assert!(!is_ai_output(&IngestFile {
            rel_path: "a.com/notes.md".to_owned(),
            ..file
        }));
    }

    #[test]
    fn summary_note_mentions_leftovers_and_failures() {
        assert_eq!(summary_note(&Checkpoint::default()), None);
        let note = summary_note(&Checkpoint {
            called: 2,
            pending: 3,
            failed: 1,
            failures: vec!["a.html:坏 JSON".to_owned()],
            ..Checkpoint::default()
        })
        .unwrap_or_default();
        assert!(note.contains("最多整理 2 页"), "{note}");
        assert!(note.contains("剩余 3 页"), "{note}");
        assert!(note.contains("1 页整理失败(例如 a.html:坏 JSON)"), "{note}");
    }
}
