//! 数据源管理。
//!
//! 六种数据源（设计规范）:本地目录、Git 仓库、网页、文件上传、压缩包、手写笔记。
//! 分工:
//! - **本地目录 / Git / 笔记**:`sync` 时扫描(或克隆)出文件清单,写进 `ingest_files` 并投递解析任务;
//! - **上传 / 压缩包**:由上传接口自动创建数据源(见 [`crate::upload`]),这里只管列出 / 移除 / 重新入队;
//! - **网页**:抓取见 [`crate::sources_web`];打开 `ai_extract` 时同步末尾再投一个 AI 规范化任务(见 [`crate::web_extract`])。
//!
//! 每次同步 = 一个批次,新增文件在 `changes` 里各留一条 `ingest.file`,可整批撤销。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use kb_core::config::UploadConfig;
use kb_core::filter::validate_tag_value;
use kb_core::model::{
    IngestFile, IngestFilter, IngestState, Millis, Page, ScanRequest, Source, SourceKind,
    SourceStatus,
};
use kb_core::paths::KbPaths;
use kb_core::ports::repo::{AuditRepo, CollectionRepo, IngestRepo, MetaStore, SourceRepo};
use kb_core::ports::{Scanner, VectorStore};
use kb_core::{KbError, Result};
use serde::Serialize;
use serde_json::{Value, json};

use crate::jobs::queue::{JobQueue, NewJob, priority};
use crate::upload::ingest::record_ingest_change;
use crate::write_gate::WriteGate;

/// 网页抓取深度上限(抓取规则)。
pub const MAX_WEB_DEPTH: u32 = 3;

/// 添加数据源的请求。
#[derive(Clone, Debug, Default)]
pub struct AddSourceRequest {
    /// 种类。
    pub kind: Option<String>,
    /// 显示名(默认取路径 / 仓库 / 主机的名字)。
    pub name: Option<String>,
    /// 地址:本地路径 / git URL / 网页 URL;`note` 时是正文。
    pub uri: Option<String>,
    /// 目标 collection。
    pub collection: Option<String>,
    /// 标签。
    pub tags: Vec<String>,
    /// include glob。
    pub include: Vec<String>,
    /// exclude glob。
    pub exclude: Vec<String>,
    /// 网页抓取深度。
    pub depth: Option<u32>,
    /// 网页域名白名单。
    pub allow_hosts: Vec<String>,
    /// 定时刷新间隔(分钟)。
    pub refresh_minutes: Option<u64>,
    /// 网页来源:是否交给内置模型做 AI 规范化(不给 = 取 `[web_extract] enabled_by_default`)。
    pub ai_extract: Option<bool>,
    /// 网页来源的提取要求(空 = 自动)。
    pub extract_prompt: Option<String>,
}

/// 修改数据源的请求(只改给出的字段)。
#[derive(Clone, Debug, Default)]
pub struct UpdateSourceRequest {
    /// 数据源 id。
    pub id: String,
    /// 显示名。
    pub name: Option<String>,
    /// 地址(只有本地目录 / 网页 / 笔记允许改)。
    pub uri: Option<String>,
    /// 目标 collection。
    pub collection: Option<String>,
    /// 标签。
    pub tags: Option<Vec<String>>,
    /// include glob。
    pub include: Option<Vec<String>>,
    /// exclude glob。
    pub exclude: Option<Vec<String>>,
    /// 网页抓取深度。
    pub depth: Option<u32>,
    /// 网页域名白名单。
    pub allow_hosts: Option<Vec<String>>,
    /// 定时刷新间隔(`Some(None)` 表示关掉)。
    pub refresh_minutes: Option<Option<u64>>,
    /// 网页来源:AI 规范化开关。
    pub ai_extract: Option<bool>,
    /// 网页来源:提取要求(给空串表示改回自动)。
    pub extract_prompt: Option<String>,
}

/// 提取要求的长度上限(字符)。写得再细也就几百字;太长的要求会挤占正文的输入预算。
pub const MAX_EXTRACT_PROMPT_CHARS: usize = 2_000;

/// 一次同步的结果。
#[derive(Clone, Debug, Serialize)]
pub struct SyncOutcome {
    /// 数据源。
    pub source: Source,
    /// 本次新入队 / 重新入队的文件数。
    pub queued: u64,
    /// 批次 id(可撤销)。
    pub batch_id: String,
    /// 解析任务 id(没有新文件时为 `None`)。
    pub job_id: Option<String>,
    /// 网页来源从站点上消失、被清掉的页面数。
    #[serde(default)]
    pub removed: u64,
    /// AI 规范化任务 id(没开、或已有一个在排队时为 `None`)。
    #[serde(default)]
    pub ai_job_id: Option<String>,
}

/// 移除数据源的结果。
#[derive(Clone, Debug, Serialize)]
pub struct RemovedSource {
    /// 数据源 id。
    pub id: String,
    /// 清掉的 ingest 文件数。
    pub files: u64,
    /// 清掉的块数。
    pub chunks: usize,
}

/// 数据源服务。
pub struct SourceService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    scanner: Arc<dyn Scanner>,
    paths: KbPaths,
    config: UploadConfig,
    queue: JobQueue,
    gate: WriteGate,
    /// 网页来源是否可以抓内网 / 本机地址(`[network] crawl_allow_private`,默认否)。
    allow_private_web: bool,
    /// 声明式 skills / 插件:挂了 `source` 钩子的插件可以接管网页来源。
    skills: Option<Arc<crate::skills::SkillRegistry>>,
    /// 新建网页来源时 AI 规范化的默认值(`[web_extract] enabled_by_default`)。
    ai_extract_default: bool,
    /// AI 规范化的付费人(多用户下发起这次调用的用户);`None` = 只受全站预算约束。
    payer: Option<String>,
    /// 调用者是否有 AI 规范化的功能权限(`ai.extract`);没有时同步不投递规范化任务。
    ai_permitted: bool,
}

impl SourceService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        scanner: Arc<dyn Scanner>,
        paths: KbPaths,
        config: UploadConfig,
    ) -> Self {
        Self {
            queue: JobQueue::new(meta.clone()),
            meta,
            store,
            scanner,
            paths,
            config,
            gate: WriteGate::new(),
            allow_private_web: false,
            skills: None,
            ai_extract_default: kb_core::config::WebExtractConfig::default().enabled_by_default,
            payer: None,
            ai_permitted: true,
        }
    }

    /// 新建网页来源时 AI 规范化的默认值。
    #[must_use]
    pub fn with_ai_extract_default(mut self, enabled: bool) -> Self {
        self.ai_extract_default = enabled;
        self
    }

    /// AI 规范化记到谁的 AI 额度上(多用户)。
    #[must_use]
    pub fn with_payer(mut self, payer: Option<String>) -> Self {
        self.payer = payer;
        self
    }

    /// 调用者有没有 AI 规范化的功能权限(没有时新建默认关、显式打开被拒、同步不投递)。
    #[must_use]
    pub fn with_ai_permitted(mut self, permitted: bool) -> Self {
        self.ai_permitted = permitted;
        self
    }

    /// 允许网页来源抓内网 / 本机地址(默认不允许,见 `CrawlOptions::allow_private`)。
    #[must_use]
    pub fn with_allow_private_web(mut self, allow: bool) -> Self {
        self.allow_private_web = allow;
        self
    }

    /// 挂上声明式 skills:带 `source` 钩子的插件可以接管匹配的网页来源,
    /// 抓取失败或插件没命中时仍走内置爬虫。
    #[must_use]
    pub fn with_skills(mut self, skills: Arc<crate::skills::SkillRegistry>) -> Self {
        self.skills = Some(skills);
        self
    }

    /// 换用共享的写闸门。
    pub fn with_write_gate(mut self, gate: WriteGate) -> Self {
        self.gate = gate;
        self
    }

    /// 列出全部数据源。
    pub async fn list(&self) -> Result<Vec<Source>> {
        SourceRepo::list(self.meta.as_ref()).await
    }

    /// 取一个数据源。
    pub async fn get(&self, id: &str) -> Result<Source> {
        SourceRepo::get(self.meta.as_ref(), id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("source {id}")))
    }

    /// 添加数据源(不立即同步;`note` 会先把正文写成文件)。
    pub async fn add(&self, request: AddSourceRequest) -> Result<Source> {
        let kind_text = request
            .kind
            .as_deref()
            .ok_or_else(|| KbError::InvalidInput("缺少数据源类型 kind".to_owned()))?;
        let kind = SourceKind::parse(kind_text).ok_or_else(|| {
            KbError::InvalidInput(format!(
                "kind 只能是 local_dir / git / web / upload / archive / note,收到 {kind_text}"
            ))
        })?;
        let collection = request
            .collection
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| KbError::InvalidInput("缺少目标 collection".to_owned()))?
            .to_owned();
        if CollectionRepo::get(self.meta.as_ref(), &collection)
            .await?
            .is_none()
        {
            return Err(KbError::NotFound(format!("collection {collection}")));
        }
        for tag in &request.tags {
            validate_tag_value(tag)?;
        }
        let uri = request.uri.unwrap_or_default();
        let id = uuid::Uuid::now_v7().to_string();
        let (name, uri, depth, allow_hosts) = match kind {
            SourceKind::LocalDir => {
                let path = PathBuf::from(uri.trim());
                if !path.is_dir() {
                    return Err(KbError::InvalidInput(format!(
                        "{} 不是目录",
                        path.display()
                    )));
                }
                let name = default_name(request.name.as_deref(), || {
                    path.file_name()
                        .map(|value| value.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "本地目录".to_owned())
                });
                (name, path.display().to_string(), 1, Vec::new())
            }
            SourceKind::Git => {
                if uri.trim().is_empty() {
                    return Err(KbError::InvalidInput("Git 数据源要填仓库地址".to_owned()));
                }
                let name = default_name(request.name.as_deref(), || {
                    uri.trim()
                        .trim_end_matches(".git")
                        .rsplit(['/', ':'])
                        .next()
                        .unwrap_or("仓库")
                        .to_owned()
                });
                // 克隆到 KB_HOME/sources/<id>(设计规范的目录布局)
                (name, uri.trim().to_owned(), 1, Vec::new())
            }
            SourceKind::Web => {
                let url = uri.trim();
                if !(url.starts_with("http://") || url.starts_with("https://")) {
                    return Err(KbError::InvalidInput(
                        "网页数据源要以 http:// 或 https:// 开头".to_owned(),
                    ));
                }
                let depth = request.depth.unwrap_or(1).clamp(1, MAX_WEB_DEPTH);
                let name = default_name(request.name.as_deref(), || {
                    url.split("://")
                        .nth(1)
                        .and_then(|rest| rest.split('/').next())
                        .unwrap_or("网页")
                        .to_owned()
                });
                (name, url.to_owned(), depth, request.allow_hosts)
            }
            SourceKind::Note => {
                let name = default_name(request.name.as_deref(), || "手写笔记".to_owned());
                let dir = self.paths.source_dir(&id);
                std::fs::create_dir_all(&dir)
                    .map_err(|err| KbError::Internal(format!("创建目录失败: {err}")))?;
                let file = dir.join("note.md");
                let body = if uri.trim().is_empty() {
                    format!("# {name}\n")
                } else {
                    uri.clone()
                };
                std::fs::write(&file, body)
                    .map_err(|err| KbError::Internal(format!("写笔记失败: {err}")))?;
                (name, dir.display().to_string(), 1, Vec::new())
            }
            SourceKind::Upload | SourceKind::Archive => {
                return Err(KbError::InvalidInput(
                    "上传 / 压缩包数据源由上传接口自动创建,不能手工添加".to_owned(),
                ));
            }
        };
        let (ai_extract, extract_prompt) = if kind == SourceKind::Web {
            let extract_prompt = clean_extract_prompt(request.extract_prompt.as_deref())?;
            let ai_extract = match request.ai_extract {
                Some(true) if !self.ai_permitted => {
                    return Err(KbError::Forbidden(
                        "AI 规范化需要「自动提炼与审核」功能权限".to_owned(),
                    ));
                }
                Some(flag) => flag,
                // 没有权限的人新建时默认关,而不是建出一个跑不起来的开关
                None => self.ai_extract_default && self.ai_permitted,
            };
            (ai_extract, extract_prompt)
        } else {
            // 只有网页来源有这两项;其它种类传了也不存(不报错,前端可以统一传参)
            (false, String::new())
        };
        let source = Source {
            id,
            kind,
            name,
            uri,
            collection,
            tags: request.tags,
            include: request.include,
            exclude: request.exclude,
            depth,
            allow_hosts,
            refresh_minutes: request.refresh_minutes,
            status: SourceStatus::Idle,
            last_synced_at: None,
            last_error: None,
            files: 0,
            created_at: now_millis(),
            ai_extract,
            extract_prompt,
            ai_status: None,
        };
        SourceRepo::create(self.meta.as_ref(), source.clone()).await?;
        Ok(source)
    }

    /// 修改数据源。
    pub async fn update(&self, request: UpdateSourceRequest) -> Result<Source> {
        let mut source = self.get(&request.id).await?;
        if let Some(name) = request.name {
            let name = name.trim().to_owned();
            if name.is_empty() {
                return Err(KbError::InvalidInput("名字不能为空".to_owned()));
            }
            source.name = name;
        }
        if let Some(collection) = request.collection {
            let collection = collection.trim().to_owned();
            if CollectionRepo::get(self.meta.as_ref(), &collection)
                .await?
                .is_none()
            {
                return Err(KbError::NotFound(format!("collection {collection}")));
            }
            source.collection = collection;
        }
        if let Some(uri) = request.uri {
            match source.kind {
                SourceKind::LocalDir => {
                    let path = PathBuf::from(uri.trim());
                    if !path.is_dir() {
                        return Err(KbError::InvalidInput(format!(
                            "{} 不是目录",
                            path.display()
                        )));
                    }
                    source.uri = path.display().to_string();
                }
                SourceKind::Web => {
                    if !(uri.starts_with("http://") || uri.starts_with("https://")) {
                        return Err(KbError::InvalidInput(
                            "网页数据源要以 http:// 或 https:// 开头".to_owned(),
                        ));
                    }
                    source.uri = uri;
                }
                SourceKind::Note => {
                    let file = Path::new(&source.uri).join("note.md");
                    std::fs::write(&file, &uri)
                        .map_err(|err| KbError::Internal(format!("写笔记失败: {err}")))?;
                }
                other => {
                    return Err(KbError::InvalidInput(format!(
                        "{} 数据源的地址由系统管理,不能手工修改",
                        other.as_str()
                    )));
                }
            }
        }
        if let Some(tags) = request.tags {
            for tag in &tags {
                validate_tag_value(tag)?;
            }
            source.tags = tags;
        }
        if let Some(include) = request.include {
            source.include = include;
        }
        if let Some(exclude) = request.exclude {
            source.exclude = exclude;
        }
        if let Some(depth) = request.depth {
            source.depth = depth.clamp(1, MAX_WEB_DEPTH);
        }
        if let Some(allow_hosts) = request.allow_hosts {
            source.allow_hosts = allow_hosts;
        }
        if let Some(refresh) = request.refresh_minutes {
            source.refresh_minutes = refresh;
        }
        if source.kind == SourceKind::Web {
            if let Some(prompt) = request.extract_prompt.as_deref() {
                // 改了提取要求:提示词哈希跟着变,下次同步时每页都按新要求重新整理
                source.extract_prompt = clean_extract_prompt(Some(prompt))?;
            }
            if let Some(flag) = request.ai_extract {
                if flag && !source.ai_extract && !self.ai_permitted {
                    return Err(KbError::Forbidden(
                        "AI 规范化需要「自动提炼与审核」功能权限".to_owned(),
                    ));
                }
                // 关掉不删已有结果,只是不再生成;重新打开后下次同步补齐
                source.ai_extract = flag;
            }
        }
        SourceRepo::update(self.meta.as_ref(), source.clone()).await?;
        Ok(source)
    }

    /// 移除数据源:清掉它索引出来的块、向量、队列行与磁盘文件。
    pub async fn remove(&self, id: &str) -> Result<RemovedSource> {
        let source = self.get(id).await?;
        let files = IngestRepo::list(
            self.meta.as_ref(),
            IngestFilter {
                collection: None,
                batch_id: None,
                source_id: Some(id.to_owned()),
                state: None,
            },
            Page::new(10_000, 0),
        )
        .await?;
        // 只有 KB 托管副本才能删物理文件。LocalDir 指向用户磁盘上的源目录，
        // 移除数据源只能清索引，绝不能碰原文件；旧实现对所有 ingest 行都 remove_file，
        // 会把本地目录里的文件真删掉。
        let managed = !matches!(source.kind, SourceKind::LocalDir);
        let mut chunks = 0usize;
        for file in &files {
            chunks += crate::revert::remove_indexed_path(
                self.meta.as_ref(),
                self.store.as_ref(),
                &self.gate,
                &file.collection,
                &file.rel_path,
            )
            .await?;
            IngestRepo::delete(self.meta.as_ref(), &file.id).await?;
            if managed && !file.abs_path.is_empty() {
                let path = PathBuf::from(&file.abs_path);
                // 双重保险：只删 sources 目录下的副本，避免历史脏数据把外部路径带进来。
                if path.starts_with(self.paths.sources_dir()) {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        // 托管数据源的目录整体清掉；Web 的 URL 清单在 sources/.urls 下，单独删。
        // 本地目录没有托管目录，这里什么都不做。
        if managed {
            let dir = match source.kind {
                SourceKind::Git | SourceKind::Web => Some(self.paths.source_dir(&source.id)),
                SourceKind::Upload | SourceKind::Archive | SourceKind::Note => {
                    Some(PathBuf::from(&source.uri))
                }
                SourceKind::LocalDir => None,
            };
            if let Some(dir) = dir
                && dir.starts_with(self.paths.sources_dir())
                && dir.exists()
            {
                let _ = std::fs::remove_dir_all(&dir);
            }
            if matches!(source.kind, SourceKind::Web) {
                let manifest = self
                    .paths
                    .sources_dir()
                    .join(".urls")
                    .join(format!("{}.json", source.id));
                let _ = std::fs::remove_file(manifest);
            }
        }
        if source.kind == SourceKind::Web {
            // 规范化结果与抓取清单都在扫描根之外(`sources/.ai/<id>`、`sources/.urls/<id>.json`),
            // 上面按 ingest 行删文件删不到它们的留档
            let ai_dir = crate::web_extract::ai_dir(&self.paths, &source.id);
            if ai_dir.exists()
                && let Err(err) = std::fs::remove_dir_all(&ai_dir)
            {
                tracing::warn!(dir = %ai_dir.display(), error = %err, "删除规范化结果目录失败");
            }
            let _ =
                std::fs::remove_file(crate::web_extract::manifest_path(&self.paths, &source.id));
        }
        SourceRepo::delete(self.meta.as_ref(), id).await?;
        Ok(RemovedSource {
            id: id.to_owned(),
            files: files.len() as u64,
            chunks,
        })
    }

    /// 同步数据源(把文件清单写进解析队列并投递任务)。
    pub async fn sync(&self, actor: &str, id: &str) -> Result<SyncOutcome> {
        let mut source = self.get(id).await?;
        let batch_id = uuid::Uuid::now_v7().to_string();
        let now = now_millis();
        // 网页来源:清掉的页面数、这次有没有抓到页面(没抓到就不投 AI 规范化)
        let mut removed = 0u64;
        let mut crawled_pages = false;
        let mut paths: Vec<(String, PathBuf)> = match source.kind {
            SourceKind::Web => {
                // :抓取 → 落盘到 sources/<id>/<host>/<path>,再走既有解析队列。
                // :匹配到插件 source 钩子时由插件接管抓取;插件失败回退内置爬虫,
                // 保证“插件坏了”只影响本次抓取,不会让数据源永远同步失败。
                let dir = self.paths.source_dir(&source.id);
                let plugin_pages = if let Some(skills) = &self.skills {
                    let plugin = skills.source_plugin("web", &source.uri).map(str::to_owned);
                    match plugin {
                        Some(plugin) => match skills.source_with_plugin(&plugin, &source).await {
                            Ok(pages) => Some(pages),
                            Err(err) => {
                                tracing::warn!(
                                    plugin = %plugin,
                                    source = %source.name,
                                    error = %err,
                                    "插件 source 失败,回退内置网页抓取"
                                );
                                None
                            }
                        },
                        None => None,
                    }
                } else {
                    None
                };
                if let Some(pages) = plugin_pages {
                    let count = pages.len();
                    self.write_source_pages(&dir, &source, &pages)?;
                    source.status = SourceStatus::Idle;
                    source.last_error = if count == 0 {
                        Some("插件这次没有返回任何页面".to_owned())
                    } else {
                        None
                    };
                    SourceRepo::update(self.meta.as_ref(), source.clone()).await?;
                    crawled_pages = count > 0;
                    self.scan_dir(&dir, &source)?
                } else {
                    let outcome = self
                        .crawl_web(&source.uri, &dir, source.depth, &source.allow_hosts)
                        .await?;
                    source.status = SourceStatus::Idle;
                    source.last_error = if outcome.pages.is_empty() {
                        Some("没有抓到任何页面(检查 URL、robots.txt 与白名单)".to_owned())
                    } else {
                        None
                    };
                    SourceRepo::update(self.meta.as_ref(), source.clone()).await?;
                    // 一页都没抓到(站点挂了)或有页面临时抓失败时不清理:那不代表页面从站点上删了
                    if !outcome.pages.is_empty() && !crawl_incomplete(&outcome) {
                        removed = self.prune_web_pages(&source, &outcome).await?;
                    }
                    crawled_pages = !outcome.pages.is_empty();
                    self.scan_dir(&dir, &source)?
                }
            }
            SourceKind::LocalDir => self.scan_dir(Path::new(&source.uri), &source)?,
            SourceKind::Git => {
                // `uri` 始终是仓库地址;克隆目录固定在 `KB_HOME/sources/<id>`
                let dir = self.paths.source_dir(&source.id);
                self.sync_git(&source.uri, &dir).await?;
                self.scan_dir(&dir, &source)?
            }
            SourceKind::Note => {
                let file = Path::new(&source.uri).join("note.md");
                if !file.is_file() {
                    return Err(KbError::NotFound(format!(
                        "笔记文件 {} 不存在",
                        file.display()
                    )));
                }
                vec![("note.md".to_owned(), file)]
            }
            SourceKind::Upload | SourceKind::Archive => {
                // 上传类:把没跑完的文件重新入队(不重新上传)
                let files = IngestRepo::list(
                    self.meta.as_ref(),
                    IngestFilter {
                        collection: None,
                        batch_id: None,
                        source_id: Some(source.id.clone()),
                        state: None,
                    },
                    Page::new(10_000, 0),
                )
                .await?;
                let mut queued = 0u64;
                for file in &files {
                    if matches!(
                        file.state,
                        IngestState::Failed | IngestState::Quarantined | IngestState::Queued
                    ) {
                        IngestRepo::set_state(
                            self.meta.as_ref(),
                            &file.id,
                            IngestState::Queued,
                            None,
                        )
                        .await?;
                        queued += 1;
                    }
                }
                let job_id = if queued > 0 {
                    let job = self.enqueue(&batch_id, &source.collection).await?;
                    Some(job.id)
                } else {
                    None
                };
                source.last_synced_at = Some(now);
                source.status = SourceStatus::Idle;
                source.last_error = None;
                SourceRepo::update(self.meta.as_ref(), source.clone()).await?;
                return Ok(SyncOutcome {
                    source,
                    queued,
                    batch_id,
                    job_id,
                    removed: 0,
                    ai_job_id: None,
                });
            }
        };

        // 用户删过的文件在 path_exclusions 里:同步时按**精确路径**过滤,
        // 不能拿目录前缀,否则删了 docs/a.md 会把 docs2/a.md 也挡掉。
        let excluded: HashSet<String> = self
            .meta
            .list_path_exclusions(&source.collection, &source.id)
            .await?
            .into_iter()
            .collect();
        if !excluded.is_empty() {
            paths.retain(|(rel_path, _)| !excluded.contains(rel_path));
        }

        // 已有文件:内容 / 大小没变就不重复入队
        let existing: HashSet<String> = IngestRepo::list(
            self.meta.as_ref(),
            IngestFilter {
                collection: Some(source.collection.clone()),
                batch_id: None,
                source_id: Some(source.id.clone()),
                state: None,
            },
            Page::new(10_000, 0),
        )
        .await?
        .into_iter()
        .map(|file| file.rel_path)
        .collect();

        AuditRepo::ensure_batch(
            self.meta.as_ref(),
            &batch_id,
            actor,
            &format!("同步数据源 {}", source.name),
        )
        .await?;

        let mut queued = 0u64;
        for (rel_path, abs_path) in &paths {
            let size = std::fs::metadata(abs_path)
                .map(|meta| meta.len())
                .unwrap_or(0);
            if size == 0 {
                continue;
            }
            if existing.contains(rel_path) {
                // 已入库:大小变了、或者大小没变但内容哈希变了,才重新入队
                // (只比大小会漏掉“改了同样长度的字”, 的刷新验收就踩到过)
                if let Some(file) =
                    IngestRepo::get_by_path(self.meta.as_ref(), &source.collection, rel_path)
                        .await?
                {
                    let changed = if file.size != size {
                        true
                    } else if let Some(previous) = &file.sha256 {
                        kb_core::hash::sha256_hex_file(abs_path)
                            .map(|current| &current != previous)
                            .unwrap_or(true)
                    } else {
                        false
                    };
                    if changed {
                        // 并进新批次,否则新批次的任务不会处理它
                        IngestRepo::set_batch(self.meta.as_ref(), &file.id, Some(&batch_id))
                            .await?;
                        IngestRepo::set_state(
                            self.meta.as_ref(),
                            &file.id,
                            IngestState::Queued,
                            None,
                        )
                        .await?;
                        queued += 1;
                    }
                }
                continue;
            }
            let file = IngestFile {
                id: uuid::Uuid::now_v7().to_string(),
                batch_id: Some(batch_id.clone()),
                source_id: Some(source.id.clone()),
                upload_id: None,
                collection: source.collection.clone(),
                rel_path: rel_path.clone(),
                abs_path: abs_path.display().to_string(),
                size,
                // 记下内容哈希,下次同步才能判断“大小没变但内容变了”
                sha256: kb_core::hash::sha256_hex_file(abs_path).ok(),
                state: IngestState::Queued,
                error: None,
                chunks: 0,
                vectors: 0,
                extract_meta: None,
                derived_from: None,
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
                    "sha256": Value::Null,
                    "size": file.size,
                }),
            )
            .await?;
            queued += 1;
        }

        let job_id = if queued > 0 {
            Some(self.enqueue(&batch_id, &source.collection).await?.id)
        } else {
            None
        };
        source.last_synced_at = Some(now);
        source.status = SourceStatus::Idle;
        source.last_error = None;
        SourceRepo::update(self.meta.as_ref(), source.clone()).await?;
        SourceRepo::set_file_count(
            self.meta.as_ref(),
            &source.id,
            IngestRepo::count(
                self.meta.as_ref(),
                IngestFilter {
                    collection: None,
                    batch_id: None,
                    source_id: Some(source.id.clone()),
                    state: None,
                },
            )
            .await?,
        )
        .await?;
        // 网页来源打开了 AI 规范化:原文入队之后投一个后台任务,不在这次请求里等模型
        let ai_job_id = if source.kind == SourceKind::Web && source.ai_extract && crawled_pages {
            self.enqueue_ai_extract(actor, &source, &batch_id).await?
        } else {
            None
        };
        Ok(SyncOutcome {
            source,
            queued,
            batch_id,
            job_id,
            removed,
            ai_job_id,
        })
    }

    /// 把插件返回的页面写到数据源目录,并落一份 URL 出处清单(与内置爬虫同格式)。
    ///
    /// 每次先清空目录:插件返回的是“当前完整快照”,不能把上一轮已删除的页面继续留在磁盘上。
    /// URL 清单即使为空也要写:否则上一轮的旧清单会继续指向已经不存在的页面。
    fn write_source_pages(
        &self,
        dir: &Path,
        source: &Source,
        pages: &[crate::skills::SourcePage],
    ) -> Result<()> {
        if dir.exists() {
            std::fs::remove_dir_all(dir).map_err(|err| {
                KbError::Internal(format!("清理数据源目录 {} 失败: {err}", dir.display()))
            })?;
        }
        std::fs::create_dir_all(dir).map_err(|err| {
            KbError::Internal(format!("创建数据源目录 {} 失败: {err}", dir.display()))
        })?;
        for page in pages {
            let rel = page.rel_path.replace('\\', "/");
            let target = dir.join(&rel);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|err| {
                    KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
                })?;
            }
            std::fs::write(&target, page.content.as_bytes()).map_err(|err| {
                KbError::Internal(format!("写入插件页面 {} 失败: {err}", target.display()))
            })?;
        }
        let manifest: std::collections::BTreeMap<&str, &str> = pages
            .iter()
            .map(|page| (page.rel_path.as_str(), page.url.as_str()))
            .collect();
        if let Ok(json) = serde_json::to_string_pretty(&manifest)
            && let Some(parent) = dir.parent()
        {
            let manifest_dir = parent.join(".urls");
            let _ = std::fs::create_dir_all(&manifest_dir);
            let _ = std::fs::write(manifest_dir.join(format!("{}.json", source.id)), json);
        }
        Ok(())
    }

    /// 投递 AI 规范化任务;调用者没有功能权限时只在数据源上留一句说明。
    async fn enqueue_ai_extract(
        &self,
        actor: &str,
        source: &Source,
        sync_batch_id: &str,
    ) -> Result<Option<String>> {
        if !self.ai_permitted {
            SourceRepo::set_ai_status(
                self.meta.as_ref(),
                &source.id,
                Some(kb_core::model::SourceAiStatus {
                    note: Some(
                        "AI 规范化没有运行:发起同步的人没有「自动提炼与审核」功能权限".to_owned(),
                    ),
                    updated_at: now_millis(),
                    ..source.ai_status.clone().unwrap_or_default()
                }),
            )
            .await?;
            return Ok(None);
        }
        let payload = crate::web_extract::WebExtractPayload {
            source_id: source.id.clone(),
            sync_batch_id: sync_batch_id.to_owned(),
            actor: actor.to_owned(),
            payer: self.payer.clone(),
        };
        Ok(crate::web_extract::enqueue(&self.meta, source, &payload)
            .await?
            .map(|job| job.id))
    }

    /// 网页来源:这次没抓到的页面(站点上删了、链接撤了、深度 / 白名单改小了)从库里清掉,
    /// 连同它的 AI 规范化结果。返回清掉的原文页面数。
    async fn prune_web_pages(
        &self,
        source: &Source,
        outcome: &crate::sources_web::CrawlOutcome,
    ) -> Result<u64> {
        let current: HashSet<&str> = outcome
            .pages
            .iter()
            .map(|page| page.rel_path.as_str())
            .collect();
        let rows = IngestRepo::list(
            self.meta.as_ref(),
            IngestFilter {
                collection: None,
                batch_id: None,
                source_id: Some(source.id.clone()),
                state: None,
            },
            Page::new(10_000, 0),
        )
        .await?;
        let mut removed = 0u64;
        for row in rows {
            let ai_output = crate::web_extract::is_ai_output(&row);
            // 规范化结果跟着它的原文页面走
            let page = if ai_output {
                row.derived_from.clone().unwrap_or_default()
            } else {
                row.rel_path.clone()
            };
            if current.contains(page.as_str()) {
                continue;
            }
            crate::revert::remove_indexed_path(
                self.meta.as_ref(),
                self.store.as_ref(),
                &self.gate,
                &row.collection,
                &row.rel_path,
            )
            .await?;
            IngestRepo::delete(self.meta.as_ref(), &row.id).await?;
            // 只删数据目录里的文件(原文页面在 sources/<id>/,规范化结果在 sources/.ai/<id>/)
            let abs = PathBuf::from(&row.abs_path);
            if !row.abs_path.is_empty() && abs.starts_with(self.paths.sources_dir()) {
                let _ = std::fs::remove_file(&abs);
            }
            crate::web_extract::remove_page_outputs(&self.paths, &source.id, &page);
            if !ai_output {
                removed += 1;
            }
        }
        if removed > 0 {
            tracing::info!(source = %source.id, removed, "清掉了站点上已经没有的页面");
        }
        Ok(removed)
    }

    /// 抓取网页数据源并把页面写进 `sources/<id>/`。
    async fn crawl_web(
        &self,
        seed: &str,
        dir: &Path,
        depth: u32,
        allow_hosts: &[String],
    ) -> Result<crate::sources_web::CrawlOutcome> {
        let options = crate::sources_web::CrawlOptions::from_source(depth, allow_hosts, 200)
            .with_allow_private(self.allow_private_web);
        let crawler = crate::sources_web::WebCrawler::new(options)?;
        let outcome = crawler.crawl(seed).await?;
        for page in &outcome.pages {
            let target = dir.join(&page.rel_path);
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent).map_err(|err| {
                    KbError::Internal(format!("创建抓取目录 {} 失败: {err}", parent.display()))
                })?;
            }
            std::fs::write(&target, page.html.as_bytes()).map_err(|err| {
                KbError::Internal(format!("写入抓取页面 {} 失败: {err}", target.display()))
            })?;
        }
        // 落一份 `urls.json`(相对路径 → 原始 URL),检索结果里要能标明 URL 出处
        if !outcome.pages.is_empty() {
            let manifest: std::collections::BTreeMap<&str, &str> = outcome
                .pages
                .iter()
                .map(|page| (page.rel_path.as_str(), page.url.as_str()))
                .collect();
            if let Ok(json) = serde_json::to_string_pretty(&manifest) {
                // 放在扫描根之外的 `.urls/` 目录,避免被当成待索引文件
                if let (Some(parent), Some(name)) = (dir.parent(), dir.file_name()) {
                    let manifest_dir = parent.join(".urls");
                    let _ = std::fs::create_dir_all(&manifest_dir);
                    let _ = std::fs::write(
                        manifest_dir.join(format!("{}.json", name.to_string_lossy())),
                        json,
                    );
                }
            }
        }
        if !outcome.skipped.is_empty() {
            tracing::info!(
                seed,
                pages = outcome.pages.len(),
                skipped = outcome.skipped.len(),
                "网页抓取完成"
            );
        }
        Ok(outcome)
    }

    /// 扫描目录(遵守 include / exclude / 大小上限,`.gitignore` 由扫描器负责)。
    fn scan_dir(&self, root: &Path, source: &Source) -> Result<Vec<(String, PathBuf)>> {
        if !root.is_dir() {
            return Err(KbError::NotFound(format!("目录 {} 不存在", root.display())));
        }
        let allow_binary = self
            .skills
            .as_ref()
            .map(|skills| skills.extract_globs(&source.collection))
            .unwrap_or_default();
        let outcome = self.scanner.scan(&ScanRequest {
            root: root.to_path_buf(),
            include: source.include.clone(),
            exclude: source.exclude.clone(),
            max_file_bytes: self.config.max_file_mb * 1024 * 1024,
            // 数据源目录是导入用的,旧格式 Office 走上传入库那条转换路径,这里不放行
            legacy_office: false,
            allow_binary,
        })?;
        Ok(outcome
            .files
            .into_iter()
            .map(|entry| (entry.relative, entry.path))
            .collect())
    }

    /// 克隆或更新一个 git 仓库到 `dir`。
    ///
    /// 用 `git` 命令行而不是 git2 的网络传输:`git2` 在设计规范里关掉了 ssh / https
    /// feature(见下文),而命令行沿用用户自己的凭据、代理与 SSH agent 配置。
    async fn sync_git(&self, uri: &str, dir: &Path) -> Result<()> {
        if dir.join(".git").exists() {
            run_git(&["fetch", "--all", "--prune"], Some(dir)).await?;
            // 尽量快进到上游;失败(例如本地有改动)不算致命
            if let Err(err) = run_git(&["reset", "--hard", "@{upstream}"], Some(dir)).await {
                tracing::warn!(error = %err, "git 仓库快进失败,沿用当前工作区");
            }
            return Ok(());
        }
        if dir.exists() {
            std::fs::remove_dir_all(dir)
                .map_err(|err| KbError::Internal(format!("清理旧目录失败: {err}")))?;
        }
        if let Some(parent) = dir.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| KbError::Internal(format!("创建目录失败: {err}")))?;
        }
        run_git(
            &["clone", "--depth", "1", uri, &dir.display().to_string()],
            None,
        )
        .await?;
        Ok(())
    }

    /// 投递解析任务。
    async fn enqueue(&self, batch_id: &str, collection: &str) -> Result<kb_core::model::Job> {
        self.queue
            .enqueue(NewJob {
                kind: "ingest".to_owned(),
                collection: Some(collection.to_owned()),
                priority: priority::REVIEW_EXTRACT,
                payload: json!({ "batch_id": batch_id, "collection": collection }),
            })
            .await
    }
}

/// 跑一条 git 命令(失败时把 stderr 带进错误)。
async fn run_git(args: &[&str], cwd: Option<&Path>) -> Result<String> {
    let mut command = tokio::process::Command::new("git");
    command.args(args);
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    // 不要交互式提示:守护进程里没有人能回答
    command.env("GIT_TERMINAL_PROMPT", "0");
    let output = command
        .output()
        .await
        .map_err(|err| KbError::Unavailable(format!("无法执行 git: {err}")))?;
    if !output.status.success() {
        return Err(KbError::Internal(format!(
            "git {} 失败: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 名字:显式给的优先,否则用闭包算出来的默认值。
fn default_name(explicit: Option<&str>, fallback: impl FnOnce() -> String) -> String {
    match explicit.map(str::trim).filter(|value| !value.is_empty()) {
        Some(name) => name.to_owned(),
        None => fallback(),
    }
}

/// 提取要求:去首尾空白;超长、带控制字符(换行与制表符除外)的拒绝。
fn clean_extract_prompt(raw: Option<&str>) -> Result<String> {
    let text = raw.unwrap_or_default().trim();
    if text.chars().count() > MAX_EXTRACT_PROMPT_CHARS {
        return Err(KbError::InvalidInput(format!(
            "提取要求不能超过 {MAX_EXTRACT_PROMPT_CHARS} 个字"
        )));
    }
    if text
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
    {
        return Err(KbError::InvalidInput("提取要求里有不能用的字符".to_owned()));
    }
    Ok(text.to_owned())
}

/// 这次抓取是否有页面**临时**没抓到(网络错误、5xx、限流)。
///
/// 有的话不清理“消失的页面”:它们很可能只是这一次没抓到,或者是挂在没抓到的页面下面。
/// 404 / 410、robots 禁止、跨域、超出深度或页数都算确定的结果,不影响清理。
fn crawl_incomplete(outcome: &crate::sources_web::CrawlOutcome) -> bool {
    outcome.skipped.iter().any(|(_, reason)| {
        reason.starts_with("抓取失败")
            || reason.starts_with("读取正文失败")
            || reason
                .strip_prefix("HTTP ")
                .and_then(|code| code.trim().parse::<u16>().ok())
                .is_some_and(|code| code >= 500 || code == 429 || code == 408)
    })
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
