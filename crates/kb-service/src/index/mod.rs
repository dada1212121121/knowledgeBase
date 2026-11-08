//! IndexService:扫描 → 过滤 → 分块 → 增量 diff → 嵌入 → 写回（设计规范）。
//!
//! 依赖全部通过 trait 注入:元数据(`MetaStore`)、向量与全文(`VectorStore`)、
//! 嵌入器(`Embedder`)、分块器(`Chunker`)。

pub mod diff;
pub mod pipeline;
mod verify;

pub use verify::{ConsistencyReport, FileDivergence};

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;

use kb_core::config::Config;
use kb_core::model::{
    Chunk, ChunkMeta, Collection, DocLink, DocLinkSource, FileRecord, MetaPatch, Millis, Project,
    RecordRow, ScanEntry, ScanRequest, SourceDoc,
};
use kb_core::ports::repo::MetaStore;
use kb_core::ports::repo::{ChunkRepo, CollectionRepo, DocLinkRepo, FileRepo};
use kb_core::ports::{Chunker, Embedder, Scanner, VectorStore};
use kb_core::{KbError, Result};

use crate::index::diff::{ChunkAction, diff_with_pending};
use crate::index::pipeline::{build_rows, embed_text, file_hash};

/// 向量库每次写入攒多少行。128 行的向量 + 正文约 0.7 MB,内存可忽略。
const UPSERT_FLUSH_ROWS: usize = 128;

/// 元数据补丁一次提交最多带多少行。
///
/// 一批就是一次提交、一个碎片,所以没必要切太细;512 行的批次本身也足够小,
/// 崩了只丢这一批的元数据(下次索引会重新比对出来)。
const META_PATCH_FLUSH_ROWS: usize = 512;

/// 「已经有向量」的存储层过滤条件(Lance `embed_state` 列)。
///
/// 服务层不依赖具体存储实现,所以这里只存一份字面量;`kb-store-lance` 的
/// `schema::READY_FILTER` 必须与它一致(NULL 是升级前的老行,按 ready 处理)。
const READY_FILTER: &str = "(embed_state = 'ready' OR embed_state IS NULL)";

/// 对账时,最近这么久(毫秒)写入的行不当孤儿删。
const ORPHAN_GRACE_MS: Millis = 10 * 60 * 1000;
/// 孤儿数超过这个数、并且占了向量库一半以上,才认为是 `meta.db` 被换过而不是正常残留。
const ORPHAN_MIN_FOR_GUARD: usize = 1000;

/// 办公文档(PDF / Word / Excel 等)单文件最多入库多少块。
///
/// 一份 6 MB 的 Excel 业务导出能拆出 4.2 万块、1500 万字,按每秒 2~3 块向量化要占着后台 worker 好几个小时,
/// 期间别的任务(包括保存笔记)都得排队;而这种数据表本来也不是拿来按语义检索的。
/// 2000 块够装下一本几百页的书(最坏约 12 分钟);超出的部分不入库,在文件记录里写明。
/// 在线查看和编辑读的是原文件,不受这个上限影响。
pub const RICH_DOC_MAX_CHUNKS: usize = 2000;

/// 文本 / Markdown / 代码文件单文件最多入库多少块。
///
/// 文本路径此前没有块数上限;扫描器把文档类纯文本的体积上限放宽到 2 MiB 之后,最坏情况放大约 10 倍:
/// 构造的病态 Markdown(每两行一个标题,2 MiB)能切出 70,276 块,按每秒 2~3 块向量化要占着唯一的写 worker
/// 好几个小时,期间所有项目的索引任务和笔记保存都得排队。
/// 3000 这个数的依据(2026-11 的实测):生产上单文件最多 636 块,没有文件超过 1000 块;
/// 2 MiB 的真实 Markdown 约 1561 块。所以 3000 留足了余量,不影响任何现有数据,只拦病态输入
/// (最坏约 20 分钟,和办公文档的 2000 块同一量级)。超出的部分不入库,在文件记录里写明;
/// 在线查看和编辑读的是原文件,不受影响。
pub const TEXT_FILE_MAX_CHUNKS: usize = 3000;

/// 索引参数。
#[derive(Clone, Debug)]
pub struct IndexOptions {
    /// 单文件大小上限。
    pub max_file_bytes: u64,
    /// 全局排除 glob(config.exclude)。
    pub exclude: Vec<String>,
    /// 每次调用嵌入器的批量。
    pub batch_size: usize,
    /// 累计写入多少行后做一次 optimize（设计规范）。
    pub optimize_after_rows: u64,
    /// 文本优先索引:先写正文 / 全文索引,向量由补队列完成。
    pub text_first: bool,
    /// 表的行数达到多少才建向量索引(`[index].vector_index_min_rows`)。
    ///
    /// 1 万行:真实 3.3 万行表上暴力扫描 394 ms CPU,建完索引走生产路径 21 ms、
    /// 召回 0.973;建索引本身只要几秒,比 nightly 里让每条查询多付 0.3 s 划算。
    pub vector_index_min_rows: u64,
}

impl Default for IndexOptions {
    fn default() -> Self {
        Self {
            max_file_bytes: 204_800,
            exclude: Vec::new(),
            batch_size: 8,
            optimize_after_rows: 2000,
            vector_index_min_rows: 10_000,
            text_first: false,
        }
    }
}

impl IndexOptions {
    /// 从全局配置构造。
    pub fn from_config(config: &Config) -> Self {
        Self {
            max_file_bytes: config.index.max_file_bytes,
            exclude: config.index.exclude.clone(),
            batch_size: config.embed.batch_size.clamp(1, 64),
            optimize_after_rows: config.index.optimize_after_rows,
            vector_index_min_rows: config.index.vector_index_min_rows,
            text_first: config.index.text_first,
        }
    }
}

/// 一次索引的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct IndexReport {
    /// 扫描到的文件数。
    pub scanned: usize,
    /// 被过滤掉的条目数。
    pub skipped: usize,
    /// 实际处理的文件数。
    pub indexed_files: usize,
    /// 处理后的块数。
    pub chunks: usize,
    /// 重新嵌入的块数。
    pub embedded: usize,
    /// 只写了正文、等待补向量的块数(文本优先索引)。
    pub pending: usize,
    /// 只更新元数据的块数。
    pub updated_meta: usize,
    /// 删除的块数。
    pub deleted_chunks: usize,
    /// 因文件消失而清理的文件数。
    pub deleted_files: usize,
    /// 单个文件的失败信息(不中断整批)。
    pub errors: Vec<String>,
}

/// 单文件处理过程中的阶段(上传解析用它推进 `ingest_files.state`)。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexStage {
    /// 正在分块。
    Chunking,
    /// 正在向量化。
    Embedding,
    /// 正在写入索引(upsert 向量、更新块表)。
    Writing,
}

/// 单文件索引模式。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IndexMode {
    /// 正文 + 向量一次写完(既有行为)。
    Full,
    /// 只写正文 / 全文索引,把向量留给补队列(文本优先索引的第一阶段)。
    TextOnly,
}

/// 单文件写入时的来源信息。
#[derive(Clone, Debug)]
pub struct FileIndexSpec {
    /// 记录里的 `source`(项目内相对路径,或 `--global` 时的文件名)。
    pub source: String,
    /// 记录种类(由扫描结果决定,`.txt` / `.rst` 也是 doc)。
    pub kind: kb_core::model::FileKind,
    /// 附加标签。
    pub tags: Vec<String>,
}

/// `--global` 导入时的 source:绝对路径的文件名部分。
fn source_name(entry: &ScanEntry) -> String {
    entry
        .path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| entry.relative.clone())
}

/// 索引服务。
pub struct IndexService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    chunker: Arc<dyn Chunker>,
    scanner: Arc<dyn Scanner>,
    /// 索引参数。
    options: std::sync::RwLock<IndexOptions>,
    /// 与迁移共享的写闸门:写入前拿读锁,拿到之后再读 collection。
    gate: crate::write_gate::WriteGate,
    /// 声明式 skills:loader-rule 决定文件的语言与附加标签。
    /// 与组装根共享同一个句柄,`reload_skills` 后这里立即可见。
    skills: Arc<std::sync::RwLock<Arc<crate::skills::SkillRegistry>>>,
    /// 旧格式 Office 转换器(LibreOffice):装了,项目里的 `.doc` / `.xls` / `.ods` 才会被转换后抽取;
    /// 没装就跟以前一样按二进制跳过。
    converter: Option<crate::office_convert::Converter>,
}

impl IndexService {
    /// 用注入的端口构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
        chunker: Arc<dyn Chunker>,
        scanner: Arc<dyn Scanner>,
        options: IndexOptions,
    ) -> Self {
        Self {
            meta,
            store,
            embedder,
            chunker,
            scanner,
            options: std::sync::RwLock::new(options),
            gate: crate::write_gate::WriteGate::new(),
            skills: Arc::new(std::sync::RwLock::new(Arc::new(
                crate::skills::SkillRegistry::empty(),
            ))),
            converter: None,
        }
    }

    /// 挂上旧格式 Office 转换器。项目目录里的旧格式文件**只为抽取文字而转换**:原件不动、不替换,
    /// 转换产物用完即删;文件记录按原件的哈希记,所以只有内容真的变了才会重新转换。
    pub fn with_converter(mut self, converter: crate::office_convert::Converter) -> Self {
        self.converter = Some(converter);
        self
    }

    /// 挂上声明式 skills(组装根在守护进程里注入)。
    pub fn with_skills(mut self, skills: Arc<crate::skills::SkillRegistry>) -> Self {
        self.skills = Arc::new(std::sync::RwLock::new(skills));
        self
    }

    /// 与组装根**共享**同一个 skills 句柄。
    pub fn with_shared_skills(
        mut self,
        skills: Arc<std::sync::RwLock<Arc<crate::skills::SkillRegistry>>>,
    ) -> Self {
        self.skills = skills;
        self
    }

    /// 换一份 skills 快照(热加载:后台索引任务持有同一个实例,下一个文件就按新规则走)。
    pub fn set_skills(&self, skills: Arc<crate::skills::SkillRegistry>) {
        *self
            .skills
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = skills;
    }

    /// 当前 skills 快照。
    fn skills(&self) -> Arc<crate::skills::SkillRegistry> {
        self.skills
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// 换一份索引参数。
    ///
    /// 后台索引任务持有的是同一个 `IndexService`,所以这里换掉之后**下一个分片**
    /// 就按新的排除规则扫描,不必重启守护进程。
    pub fn set_options(&self, options: IndexOptions) {
        *self
            .options
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = options;
    }

    /// 当前索引参数的快照。
    pub(crate) fn options(&self) -> IndexOptions {
        self.options
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// 换用与迁移共享的写闸门(组装根在守护进程 / 嵌入式 CLI 里注入同一个实例)。
    pub fn with_write_gate(mut self, gate: crate::write_gate::WriteGate) -> Self {
        self.gate = gate;
        self
    }

    /// 写闸门(便于组装根共享同一实例)。
    pub fn write_gate(&self) -> crate::write_gate::WriteGate {
        self.gate.clone()
    }

    /// 当前嵌入器:跨集合移动批注时要按目标库的嵌入器重建检索行。
    pub fn embedder(&self) -> &Arc<dyn Embedder> {
        &self.embedder
    }

    /// 重新读 collection:迁移可能刚切换了 `active_table`,不能沿用调用方手里的快照。
    async fn fresh_collection(&self, name: &str) -> Result<Collection> {
        CollectionRepo::get(self.meta.as_ref(), name)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {name}")))
    }

    /// 扫描一个项目(同步:调用方在需要时放进 `spawn_blocking`)。
    ///
    /// 插件的纯排除规则(`[index] exclude`)在扫描结果上再过滤一次:它们可能按项目生效,
    /// 也可能只作用于某个插件自己 include 的范围,不能简单拼进 Scanner 的全局 exclude。
    /// 被过滤掉的文件会从 `files` 里消失,全量索引结束时由 `remove_vanished` 清掉旧块。
    pub fn scan_project(&self, project: &Project) -> Result<kb_core::model::ScanOutcome> {
        let options = self.options();
        let skills = self.skills();
        let mut exclude = project.exclude.clone();
        exclude.extend(options.exclude.iter().cloned());
        let mut outcome = self.scanner.scan(&ScanRequest {
            root: PathBuf::from(&project.root_path),
            include: project.include.clone(),
            exclude,
            max_file_bytes: options.max_file_bytes,
            legacy_office: self.converter.is_some(),
            // 插件 extract 认领的新二进制格式要能进扫描结果,否则内置的「含 NUL 即二进制」会先挡掉。
            allow_binary: skills.extract_globs(&project.name),
        })?;
        let before = outcome.files.len();
        outcome
            .files
            .retain(|entry| !skills.is_excluded(&project.name, &entry.relative));
        if outcome.files.len() != before {
            tracing::debug!(
                project = %project.name,
                excluded = before - outcome.files.len(),
                "插件排除规则过滤了文件"
            );
        }
        Ok(outcome)
    }

    /// 清理磁盘上已消失的文件(全量索引结束时调用)。
    ///
    /// 被过滤掉的文件(`skipped`)不算“消失”,它们的 `files` 行要保留;
    /// 扫描结果为空而 `files` 非空时拒绝清理(项目目录被卸载 / 暂时为空)。
    pub async fn remove_vanished(
        &self,
        _project: &Project,
        collection: &Collection,
        scanned: &[ScanEntry],
        skipped: &[kb_core::model::SkippedEntry],
    ) -> Result<usize> {
        let mut known: HashSet<&str> = scanned
            .iter()
            .map(|entry| entry.relative.as_str())
            .collect();
        known.extend(skipped.iter().map(|entry| entry.relative.as_str()));
        let mut removed = 0usize;
        let existing = FileRepo::list_paths(self.meta.as_ref(), &collection.name).await?;
        if scanned.is_empty() && !existing.is_empty() {
            tracing::warn!(
                collection = %collection.name,
                "扫描结果为空但 files 表非空,跳过清理以免误删"
            );
            return Ok(0);
        }
        for path in existing {
            if !known.contains(path.as_str()) {
                self.remove_path(collection, &path).await?;
                removed += 1;
            }
        }
        Ok(removed)
    }

    /// 记录被过滤掉的文件(`files.status` = 跳过原因),并清掉它们以前的块。
    pub async fn record_skipped(
        &self,
        collection: &Collection,
        skipped: &[kb_core::model::SkippedEntry],
        now: Millis,
    ) -> Result<()> {
        for entry in skipped {
            self.remove_path(collection, &entry.relative).await?;
            FileRepo::upsert(
                self.meta.as_ref(),
                FileRecord {
                    collection: collection.name.clone(),
                    path: entry.relative.clone(),
                    file_hash: String::new(),
                    size: 0,
                    mtime: 0,
                    indexed_at: now,
                    status: entry.reason.as_str().to_owned(),
                    error: Some(entry.reason.detail().to_owned()),
                },
            )
            .await?;
        }
        Ok(())
    }

    /// 整理物理表(设计规范:累计写入达到 `optimize_after_rows` 或任务结束时)。
    ///
    /// 整理会重写数据文件并清理旧版本,和迁移/孤儿对账一样属于 Lance 写操作。先在**最外层**
    /// 拿读锁再读 `active_table`:否则一次整理可能落到刚被迁移切换掉的退役表上,而迁移收尾
    /// 也会和压缩并发提交,轻则白做、重则让刚删掉的行以旧版本复活。
    pub async fn optimize(&self, collection: &Collection) -> Result<()> {
        let _writer = self.gate.writer().await;
        let current = self.fresh_collection(&collection.name).await?;
        self.optimize_locked(&current).await
    }

    /// 已经持有写闸门读锁时使用的整理入口(调用方必须先读 `active_table`)。
    ///
    /// 不能在持读锁的路径里再调 [`Self::optimize`]:tokio 的 `RwLock` 写优先,迁移排队时
    /// 第二次 `read` 会自锁。`index_project` / 索引分片 / 上传分片都在最外层持锁。
    pub(crate) async fn optimize_locked(&self, collection: &Collection) -> Result<()> {
        self.store.optimize(&collection.active_table).await
    }

    /// 确保索引存在:有数据就建全文索引;行数达到 `vector_index_min_rows` 再建向量索引。
    ///
    /// 向量索引以前只在换模型迁移时建,日常索引从没建过,表再大每次检索也是暴力扫描
    /// (13.6 万块的表单次检索约 1.7 秒 CPU)。已经建过的会直接跳过;之后新增的行由
    /// `optimize` 并入索引。建不成(训练失败等)只记警告:检索会退回暴力扫描,结果不变,只是慢一些,
    /// 下次再试,不能因此让全文索引和后面的流程失败。
    pub async fn ensure_indexes(&self, collection: &Collection) -> Result<()> {
        // 建 FTS / 向量索引同样是 Lance 写操作:先拿读锁,再读 active 表。
        let _writer = self.gate.writer().await;
        let current = self.fresh_collection(&collection.name).await?;
        self.ensure_indexes_locked(&current).await
    }

    /// 已经持有写闸门读锁时使用的建索引入口(调用方必须先读 `active_table`)。
    pub(crate) async fn ensure_indexes_locked(&self, collection: &Collection) -> Result<()> {
        // 升级路径:旧表可能还没有 `embed_state`。下面按 READY_FILTER 数 ready 行,
        // 缺列时会直接报错;即使本次没有任何文件变化、没有走 upsert,也要先把列补出来。
        self.store
            .ensure_table(&collection.active_table, collection.dim)
            .await?;
        let rows = self.store.count(&collection.active_table, None).await?;
        if rows == 0 {
            return Ok(());
        }
        self.store
            .ensure_fts_index(&collection.active_table)
            .await?;
        // 向量索引只能用 ready 行训练:文本阶段全 pending 时建索引会报
        // `KMeans cannot train 1 centroids with 0 vectors`。FTS 索引仍要建,文本已可搜。
        let ready = self
            .store
            .count(&collection.active_table, Some(READY_FILTER))
            .await?;
        if ready < self.options().vector_index_min_rows {
            if rows >= self.options().vector_index_min_rows {
                tracing::info!(
                    collection = %collection.name,
                    rows,
                    ready,
                    "待补向量较多,跳过本次向量索引重建"
                );
            }
            return Ok(());
        }
        if let Err(err) = self
            .store
            .ensure_vector_index(&collection.active_table)
            .await
        {
            tracing::warn!(
                error = %err,
                collection = %collection.name,
                rows,
                "建向量索引失败,检索暂时退回暴力扫描"
            );
        }
        Ok(())
    }

    /// 索引一个项目。
    ///
    /// 同步入口固定走 [`IndexMode::Full`]:它没有索引任务、没有补向量队列,文本阶段写完
    /// 就没人接着补向量了。`[index] text_first` 只作用于任务分片路径(编辑 / 保存 / 手动索引);
    /// 夜间门禁等同步调用必须一次写完整,否则随后的评测会读到 pending 行。
    pub async fn index_project(
        &self,
        project: &Project,
        collection: &Collection,
    ) -> Result<IndexReport> {
        // 写闸门:先拿读锁,拿到之后再读 collection。
        // 迁移收尾持写锁,因此这次索引要么整体在切换前完成,要么整体写在切换后的 active 表上。
        let _writer = self.gate.writer().await;
        let current = self.fresh_collection(&collection.name).await?;
        let collection = &current;
        let scan_result = self.scan_project(project)?;
        let now = now_millis();
        let mut report = IndexReport {
            scanned: scan_result.files.len(),
            skipped: scan_result.skipped.len(),
            ..IndexReport::default()
        };

        // 1. 被过滤掉的文件:记录状态,清掉它以前的块
        self.record_skipped(collection, &scan_result.skipped, now)
            .await?;

        // 2. 逐个文件处理
        for file in &scan_result.files {
            match self.index_entry(project, collection, file).await {
                Ok(stats) => {
                    report.indexed_files += 1;
                    report.chunks += stats.chunks;
                    report.embedded += stats.embedded;
                    report.pending += stats.pending;
                    report.updated_meta += stats.updated_meta;
                    report.deleted_chunks += stats.deleted_chunks;
                }
                Err(err) => report.errors.push(format!("{}: {err}", file.relative)),
            }
        }

        // 3. 磁盘上已消失的文件:清理块与记录
        report.deleted_files = self
            .remove_vanished(
                project,
                collection,
                &scan_result.files,
                &scan_result.skipped,
            )
            .await?;

        // 4. 整理表并确保全文索引存在(本函数已持读锁,用 locked 入口避免自锁)
        self.optimize_locked(collection).await?;
        self.ensure_indexes_locked(collection).await?;
        Ok(report)
    }

    /// 把一份文件或目录里的文档索引进指定 collection(`kb index --global`)。
    ///
    /// `source` 记为绝对路径的文件名部分;`kind` 取自扫描结果(设计规范要求 doc);
    /// `tags` 写到每个块的 tags 列。复用与项目索引相同的 file_hash / diff 逻辑,
    /// 因此重复导入不会再嵌入,文件变短时旧块会被删除。
    ///
    /// `_global` 没有任务队列,同样固定走 [`IndexMode::Full`];`--text-only` 之类的开关
    /// 在 CLI 层就被拒绝,避免用户以为正文已经先落库。
    pub async fn index_global_path(
        &self,
        collection: &Collection,
        path: &std::path::Path,
        tags: &[String],
    ) -> Result<IndexReport> {
        // 写闸门:同 `index_project`
        let _writer = self.gate.writer().await;
        let current = self.fresh_collection(&collection.name).await?;
        let collection = &current;
        // 统一成绝对路径,后面按路径过滤才可靠
        let path = std::fs::canonicalize(path)
            .map_err(|err| KbError::InvalidInput(format!("{} 不可用: {err}", path.display())))?;
        let root = if path.is_dir() {
            path.clone()
        } else {
            match path.parent() {
                Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
                _ => std::path::PathBuf::from("."),
            }
        };
        let options = self.options();
        let scan = self.scanner.scan(&ScanRequest {
            root,
            include: Vec::new(),
            exclude: options.exclude.clone(),
            max_file_bytes: options.max_file_bytes,
            legacy_office: self.converter.is_some(),
            allow_binary: self.skills().extract_globs(&collection.name),
        })?;
        let entries: Vec<ScanEntry> = scan
            .files
            .into_iter()
            .filter(|entry| path.is_dir() || entry.path == path)
            .collect();

        // 同名文件会写成同一个 source,必须报错而不是静默覆盖
        let mut sources: HashSet<String> = HashSet::new();
        for entry in &entries {
            let source = source_name(entry);
            if !sources.insert(source.clone()) {
                return Err(KbError::InvalidInput(format!(
                    "目录里有多个文件会写成同一个 source({source}),请分别导入"
                )));
            }
        }

        let mut report = IndexReport {
            scanned: entries.len(),
            ..IndexReport::default()
        };
        let now = now_millis();
        for entry in &entries {
            let spec = FileIndexSpec {
                source: source_name(entry),
                kind: entry.kind,
                tags: tags.to_vec(),
            };
            match self
                .index_entry_with(&collection.name, collection, entry, &spec, now)
                .await
            {
                Ok(stats) => {
                    report.indexed_files += 1;
                    report.chunks += stats.chunks;
                    report.embedded += stats.embedded;
                    report.pending += stats.pending;
                    report.updated_meta += stats.updated_meta;
                    report.deleted_chunks += stats.deleted_chunks;
                }
                Err(err) => report.errors.push(format!("{}: {err}", entry.relative)),
            }
        }
        self.optimize_locked(collection).await?;
        self.ensure_indexes_locked(collection).await?;
        Ok(report)
    }

    /// 处理单个文件(供任务分片复用)。
    pub async fn index_entry(
        &self,
        project: &Project,
        collection: &Collection,
        file: &ScanEntry,
    ) -> Result<FileStats> {
        let spec = FileIndexSpec {
            source: file.relative.clone(),
            kind: file.kind,
            tags: Vec::new(),
        };
        self.index_entry_with(&project.name, collection, file, &spec, now_millis())
            .await
    }

    /// 同 [`Self::index_entry`],但可以只写正文(文本优先索引)。
    pub async fn index_entry_mode(
        &self,
        project: &Project,
        collection: &Collection,
        file: &ScanEntry,
        mode: IndexMode,
    ) -> Result<FileStats> {
        let spec = FileIndexSpec {
            source: file.relative.clone(),
            kind: file.kind,
            tags: Vec::new(),
        };
        self.index_entry_with_mode(
            &project.name,
            collection,
            file,
            &spec,
            now_millis(),
            mode,
            &|_| {},
        )
        .await
    }

    /// 通用单文件处理:`spec` 决定 source / kind / tags。
    pub async fn index_entry_with(
        &self,
        project_name: &str,
        collection: &Collection,
        file: &ScanEntry,
        spec: &FileIndexSpec,
        now: Millis,
    ) -> Result<FileStats> {
        self.index_entry_with_stages(project_name, collection, file, spec, now, &|_stage| {})
            .await
    }

    /// 同 [`Self::index_entry_with`],但在进入分块 / 向量化时回调 `on_stage`。
    ///
    /// 上传解析要把 `extracting → chunking → embedding → done` 真实地写进
    /// `ingest_files`,而不是只在外面包一层猜的状态;回调同步执行、不得阻塞。
    pub async fn index_entry_with_stages(
        &self,
        project_name: &str,
        collection: &Collection,
        file: &ScanEntry,
        spec: &FileIndexSpec,
        now: Millis,
        on_stage: &(dyn Fn(IndexStage) + Send + Sync),
    ) -> Result<FileStats> {
        self.index_entry_with_mode(
            project_name,
            collection,
            file,
            spec,
            now,
            IndexMode::Full,
            on_stage,
        )
        .await
    }

    /// 同 [`Self::index_entry_with_stages`],但可以只写正文(文本优先索引)。
    #[allow(clippy::too_many_arguments)] // `mode` 与 `on_stage` 都是调用方必须显式给出的语义,合并成结构体反而更难读
    pub async fn index_entry_with_mode(
        &self,
        project_name: &str,
        collection: &Collection,
        file: &ScanEntry,
        spec: &FileIndexSpec,
        now: Millis,
        mode: IndexMode,
        on_stage: &(dyn Fn(IndexStage) + Send + Sync),
    ) -> Result<FileStats> {
        // 声明式 skills / 插件快照:同一文件的排除、语言、标签、钩子都按同一份快照判断,
        // 避免 reload_skills 刚好发生在两次读取之间,出现“规则命中一半”的怪状态。
        let skills = self.skills();
        if skills.is_excluded(project_name, &file.relative) {
            // 扫描路径会把这些文件直接过滤掉;上传 / 单文件入口走到这里时也不能再写块。
            return Ok(FileStats::default());
        }
        let plugin_match = skills.match_plugins(project_name, &file.relative);

        // PDF / Word / Excel / PPT 等是二进制容器,不能当文本读,走抽取器。
        // 如果插件声明了 extract 钩子,就交给插件先试;失败再回退内置抽取。
        let has_extract_plugin = plugin_match.extract_plugin.is_some();
        if !has_extract_plugin
            && (kb_index::is_rich_doc(&file.path)
                || (self.converter.is_some() && kb_index::is_legacy_office(&file.path)))
        {
            return self
                .index_rich_doc(project_name, collection, file, spec, now, mode, on_stage)
                .await;
        }
        let bytes = std::fs::read(&file.path).map_err(|err| {
            KbError::Internal(format!("读取 {} 失败: {err}", file.path.display()))
        })?;
        let hash = file_hash(&bytes);
        let existing_chunks =
            ChunkRepo::by_path(self.meta.as_ref(), &collection.name, &spec.source).await?;
        // 哈希没变也可能有块还没补向量:先把队列读出来,快路径和 diff 都要用。
        let pending_ids: HashSet<String> =
            ChunkRepo::pending_for_path(self.meta.as_ref(), &collection.name, &spec.source)
                .await?
                .into_iter()
                .collect();
        // tags / kind 也是 meta_hash 的输入:带标签导入时不走“文件哈希没变就跳过”,
        // 让 diff 把标签变化走成 update_meta
        // 插件命中时不能走这条快路径:文件内容没变,但插件可能刚升级、清单里的 lang / tags
        // 可能刚改过,只有重跑 extract/chunk/enrich 才能把这些变化落到已索引的文件上。
        if plugin_match.is_empty()
            && spec.tags.is_empty()
            && let Some(record) =
                FileRepo::get(self.meta.as_ref(), &collection.name, &spec.source).await?
            && record.file_hash == hash
            && !existing_chunks.is_empty()
            && pending_ids.is_empty()
        {
            // 内容没变、只是修改时间变了(git checkout、同步工具、touch):把新的 size / mtime 补记回 files。
            // 夜间校验(`fingerprint_diff`)只比 size + mtime,不补记的话这些文件每晚都被当成「变了」
            // 重新排任务、再被这里跳过,`resynced` 永远非零,真正的漂移信号被淹没。
            // 只改指纹两列,哈希 / 索引时间 / 状态原样保留;不动块、不触发嵌入。
            if record.size != file.size || record.mtime != file.mtime {
                FileRepo::upsert(
                    self.meta.as_ref(),
                    FileRecord {
                        size: file.size,
                        mtime: file.mtime,
                        ..record
                    },
                )
                .await?;
            }
            // 文件指纹没变,直接跳过(仍然把已有的块数计入报告)
            return Ok(FileStats {
                chunks: existing_chunks.len(),
                ..FileStats::default()
            });
        }

        // 插件 extract 钩子优先;失败只记 warning,然后按内置路径继续,不能让一个坏插件
        // 把整个文件索引失败。二进制文件回退到内置富文档抽取,文本文件回退到编码解码。
        let extracted = match &plugin_match.extract_plugin {
            Some(plugin) => match skills
                .extract_with_plugin(
                    plugin,
                    &file.relative,
                    project_name,
                    file.size,
                    file.mtime,
                    &bytes,
                )
                .await
            {
                Ok(extracted) => Some(extracted),
                Err(err) => {
                    tracing::warn!(
                        plugin = %plugin,
                        file = %file.relative,
                        error = %err,
                        "插件 extract 失败,回退内置抽取"
                    );
                    None
                }
            },
            None => None,
        };
        let (text, extracted_lang) = match extracted {
            Some(extracted) => (extracted.text, extracted.lang),
            None => {
                if kb_index::is_rich_doc(&file.path)
                    || (self.converter.is_some() && kb_index::is_legacy_office(&file.path))
                {
                    return self
                        .index_rich_doc(project_name, collection, file, spec, now, mode, on_stage)
                        .await;
                }
                // 不是 UTF-8 的文本文件(GBK 的 CSV、带 BOM 的 UTF-8 / UTF-16)按它真实的编码解开,
                // 以前一律 `from_utf8_lossy`,GBK 文件里的中文全变成替换字符,既搜不到、也不能按行分块出对的内容
                (kb_extract::csv::decode_text(&bytes), None)
            }
        };

        // 声明式 skills 的 loader-rule与插件 [index]:命中就把语言(决定分块器)
        // 与附加标签换掉。插件优先于旧 loader-rule,标签合并去重。
        let legacy = skills.apply_loader(&file.relative);
        let lang = plugin_match
            .lang
            .clone()
            .or(extracted_lang)
            .or_else(|| legacy.as_ref().map(|hit| hit.lang.clone()))
            .unwrap_or_else(|| file.lang.clone());
        let mut tags = spec.tags.clone();
        if let Some(hit) = legacy {
            for tag in hit.tags {
                if !tags.contains(&tag) {
                    tags.push(tag);
                }
            }
        }
        for tag in &plugin_match.tags {
            if !tags.contains(tag) {
                tags.push(tag.clone());
            }
        }
        let spec = FileIndexSpec {
            source: spec.source.clone(),
            kind: spec.kind,
            tags,
        };
        let doc = SourceDoc {
            source: spec.source.clone(),
            lang,
            text,
            file_hash: hash.clone(),
            size: file.size,
            mtime: file.mtime,
            project_name: project_name.to_owned(),
        };
        self.index_text_doc(&doc, collection, &spec, &plugin_match, now, mode, on_stage)
            .await
    }

    /// 文本 / 代码文件的公共尾段:插件分块(失败回退内置)→ 插件增强(失败保留原块)→ 写索引。
    ///
    /// `mode` 必须一路传到最后一步:文本优先索引只写正文,漏传就会在这里
    /// 悄悄退回「正文 + 向量一次写完」,任务报告里看不出差别,但队列是空的。
    #[allow(clippy::too_many_arguments)]
    async fn index_text_doc(
        &self,
        doc: &SourceDoc,
        collection: &Collection,
        spec: &FileIndexSpec,
        plugin_match: &crate::skills::PluginIndexMatch,
        now: Millis,
        mode: IndexMode,
        on_stage: &(dyn Fn(IndexStage) + Send + Sync),
    ) -> Result<FileStats> {
        let skills = self.skills();
        on_stage(IndexStage::Chunking);
        let chunks = match &plugin_match.chunk_plugin {
            Some(plugin) => match skills.chunk_with_plugin(plugin, doc).await {
                Ok(chunks) => chunks,
                Err(err) => {
                    tracing::warn!(
                        plugin = %plugin,
                        file = %doc.source,
                        error = %err,
                        "插件 chunk 失败,回退内置分块器"
                    );
                    self.chunker.chunk(doc)
                }
            },
            None => self.chunker.chunk(doc),
        };
        let mut chunks = match &plugin_match.enrich_plugin {
            Some(plugin) => match skills.enrich_with_plugin(plugin, doc, &chunks).await {
                Ok(chunks) => chunks,
                Err(err) => {
                    tracing::warn!(
                        plugin = %plugin,
                        file = %doc.source,
                        error = %err,
                        "插件 enrich 失败,保留原块"
                    );
                    chunks
                }
            },
            None => chunks,
        };
        // 块数上限放在插件分块 / 增强之后:插件产出的块同样要受限。截的是固定前缀,
        // 同一份内容每次都留下同样的块,重复索引仍然不会重复嵌入。
        let total_chunks = chunks.len();
        chunks.truncate(TEXT_FILE_MAX_CHUNKS);
        let stats = self
            .index_prepared_chunks_mode(doc, collection, spec, chunks, now, mode, on_stage)
            .await?;
        if total_chunks > TEXT_FILE_MAX_CHUNKS {
            // 文件记录里写明只收了前面一部分,免得有人搜不到后半截内容却不知道为什么。
            // 上面写回的记录 error 总是 None,所以内容之后缩回上限以内时,这条提示会被自然清掉。
            tracing::warn!(
                path = %spec.source,
                total = total_chunks,
                kept = TEXT_FILE_MAX_CHUNKS,
                "文本文件块数超过上限,只索引前面一部分"
            );
            if let Some(record) =
                FileRepo::get(self.meta.as_ref(), &collection.name, &spec.source).await?
            {
                FileRepo::upsert(
                    self.meta.as_ref(),
                    FileRecord {
                        error: Some(format!(
                            "内容较多,只索引了前 {TEXT_FILE_MAX_CHUNKS} 块(共 {total_chunks} 块);查看和编辑读的是原文件,不受影响"
                        )),
                        ..record
                    },
                )
                .await?;
            }
        }
        Ok(stats)
    }

    /// 办公文档(PDF / docx / xlsx / pptx / odt / rtf / epub):抽取 → 文档分块 → 索引。
    ///
    /// 和文本文件的三点区别:
    /// - 读不出文字(加密、损坏、扫描件没有文字层)不算失败,记成 `skipped` 并写明原因。
    ///   否则每次扫描都会把同一份读不出的文件重新解析一遍,任务也会一直带着"失败"数;
    /// - 这类文件动辄几十 MB,先比大小和修改时间,没变就直接沿用上次结果,不读盘;
    /// - 不套 skills 的 loader-rule(那是给文本文件挑分块语言用的)。
    #[allow(clippy::too_many_arguments)] // 与 `index_entry_with_mode` 共用参数形状,保持调用点一致
    async fn index_rich_doc(
        &self,
        project_name: &str,
        collection: &Collection,
        file: &ScanEntry,
        spec: &FileIndexSpec,
        now: Millis,
        mode: IndexMode,
        on_stage: &(dyn Fn(IndexStage) + Send + Sync),
    ) -> Result<FileStats> {
        let existing = FileRepo::get(self.meta.as_ref(), &collection.name, &spec.source).await?;
        let has_pending =
            !ChunkRepo::pending_for_path(self.meta.as_ref(), &collection.name, &spec.source)
                .await?
                .is_empty();
        // 带标签导入要让 diff 把标签变化走成 update_meta,不走"没变就跳过"的快路径
        if !has_pending
            && spec.tags.is_empty()
            && let Some(record) = &existing
            && record.size == file.size
            && record.mtime == file.mtime
            && let Some(chunks) = self.rich_doc_unchanged(collection, record).await?
        {
            return Ok(FileStats {
                chunks,
                ..FileStats::default()
            });
        }

        let bytes = std::fs::read(&file.path).map_err(|err| {
            KbError::Internal(format!("读取 {} 失败: {err}", file.path.display()))
        })?;
        let hash = file_hash(&bytes);
        if !has_pending
            && spec.tags.is_empty()
            && let Some(record) = existing
            && record.file_hash == hash
            && let Some(chunks) = self.rich_doc_unchanged(collection, &record).await?
        {
            // 内容没变、只是修改时间变了(同步工具常这样):补记新时间,下次走快路径
            FileRepo::upsert(
                self.meta.as_ref(),
                FileRecord {
                    size: file.size,
                    mtime: file.mtime,
                    ..record
                },
            )
            .await?;
            return Ok(FileStats {
                chunks,
                ..FileStats::default()
            });
        }

        on_stage(IndexStage::Chunking);
        let extension = file
            .path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let source = kb_core::model::SourceRef {
            scheme: "file".to_owned(),
            location: spec.source.clone(),
            project_root: None,
        };
        // 旧格式 Office(没有抽取器):转成 OOXML 再抽取。哈希已经按原件算好了,转换产物每次都可能不同,
        // 不能拿它当「有没有变」的依据
        let converted;
        let (extract_bytes, extract_ext): (&[u8], &str) = if kb_index::is_legacy_office(&file.path)
        {
            let Some(converter) = &self.converter else {
                return self
                    .skip_rich_doc(
                        collection,
                        file,
                        spec,
                        &hash,
                        "旧格式 Office 需要先安装转换器",
                    )
                    .await;
            };
            match converter.convert(&file.path).await {
                Ok((target, output)) => {
                    converted = (target.extension(), output);
                    (&converted.1, converted.0)
                }
                // 转换器启动不了 / 超时 / 读写出错多半是暂时的(机器忙、正在升级):不记成「跳过」,
                // 否则内容不变就永远不再重试。往上报,下次扫描还会再试
                Err(
                    err @ (crate::office_convert::ConvertError::Timeout
                    | crate::office_convert::ConvertError::Spawn(_)
                    | crate::office_convert::ConvertError::Io(_)),
                ) => {
                    return Err(KbError::Unavailable(format!(
                        "{} 的旧格式转换暂时失败,下次再试:{err}",
                        spec.source
                    )));
                }
                // 转换器明确说转不了(文件损坏、加载失败、空文件、产物不合法):这是这份内容的确定结果,
                // 记成跳过并写明原因;内容变了才会重试
                Err(err) => {
                    tracing::warn!(path = %spec.source, error = %err, "旧格式转换失败,已跳过");
                    return self
                        .skip_rich_doc(
                            collection,
                            file,
                            spec,
                            &hash,
                            &format!("旧格式转换失败:{err}"),
                        )
                        .await;
                }
            }
        } else {
            (&bytes, extension)
        };
        // 进程级注册表:插件/测试注入的抽取器与这里看到的是同一份。
        let doc = match kb_extract::registry::global()
            .extract(&source, extract_bytes, extract_ext)
            .await
        {
            Ok(doc) => doc,
            // 文件本身读不了(加密 / 损坏 / 不支持的子类型):跳过并记原因。
            // 其它错误(线程异常等)可能是暂时的,照常往上报,下次还会重试
            Err(err @ (KbError::InvalidInput(_) | KbError::Unavailable(_))) => {
                tracing::warn!(path = %spec.source, error = %err, "办公文档无法解析,已跳过");
                return self
                    .skip_rich_doc(collection, file, spec, &hash, &format!("无法解析:{err}"))
                    .await;
            }
            Err(err) => return Err(err),
        };
        // 整份只有图片、没有任何文字层(扫描件):抽取器给每页塞的是"needs_ocr"提示图注,
        // 那不是正文,入库只会产生一堆搜不到东西的噪声块
        let needs_ocr = kb_core::model::ExtractMeta::from_doc(&doc).needs_ocr;
        let mut chunks = if needs_ocr {
            Vec::new()
        } else {
            // 目标 token 数与上传解析保持一致(512),同一份文件两条路径入库的分块才一样
            let chunker = kb_extract::DocChunkerImpl::new(
                kb_extract::DocChunkOptions::from_config(512, project_name),
            );
            kb_core::ports::DocChunker::chunk_doc(&chunker, &doc)
        };
        let total_chunks = chunks.len();
        chunks.truncate(RICH_DOC_MAX_CHUNKS);
        if chunks.is_empty() {
            let reason = if needs_ocr {
                "没有文字层(扫描件或纯图片),抽不出可检索的文字"
            } else {
                "没有可索引的文字"
            };
            return self
                .skip_rich_doc(collection, file, spec, &hash, reason)
                .await;
        }

        let doc_src = SourceDoc {
            source: spec.source.clone(),
            lang: doc.meta.lang.clone(),
            text: doc.text(),
            file_hash: hash,
            size: file.size,
            mtime: file.mtime,
            project_name: project_name.to_owned(),
        };
        let spec = FileIndexSpec {
            kind: kb_core::model::FileKind::Doc,
            ..spec.clone()
        };
        let stats = self
            .index_prepared_chunks_mode(&doc_src, collection, &spec, chunks, now, mode, on_stage)
            .await?;
        if total_chunks > RICH_DOC_MAX_CHUNKS {
            // 文件记录里写明只收了前面一部分,免得有人搜不到后半截内容却不知道为什么
            tracing::warn!(
                path = %spec.source,
                total = total_chunks,
                kept = RICH_DOC_MAX_CHUNKS,
                "办公文档块数超过上限,只索引前面一部分"
            );
            if let Some(record) =
                FileRepo::get(self.meta.as_ref(), &collection.name, &spec.source).await?
            {
                FileRepo::upsert(
                    self.meta.as_ref(),
                    FileRecord {
                        error: Some(format!(
                            "内容较多,只索引了前 {RICH_DOC_MAX_CHUNKS} 块(共 {total_chunks} 块);查看和编辑读的是原文件,不受影响"
                        )),
                        ..record
                    },
                )
                .await?;
            }
        }
        Ok(stats)
    }

    /// 上次对这份办公文档的处理结果还能用吗?能就返回块数(`skipped` 的文件是 0)。
    ///
    /// 只认 `ok` / `skipped` 两种状态;`ok` 但块已经没了(被清理过)要重做。
    async fn rich_doc_unchanged(
        &self,
        collection: &Collection,
        record: &FileRecord,
    ) -> Result<Option<usize>> {
        match record.status.as_str() {
            "skipped" => Ok(Some(0)),
            "ok" => {
                let chunks = ChunkRepo::by_path(self.meta.as_ref(), &collection.name, &record.path)
                    .await?
                    .len();
                Ok((chunks > 0).then_some(chunks))
            }
            _ => Ok(None),
        }
    }

    /// 办公文档读不出可索引的文字:清掉它以前的块(文件可能刚被换成扫描件 / 损坏版本,
    /// 留着旧块搜到的就是过期内容),并记一条带原因的 `skipped` 文件记录。
    async fn skip_rich_doc(
        &self,
        collection: &Collection,
        file: &ScanEntry,
        spec: &FileIndexSpec,
        hash: &str,
        reason: &str,
    ) -> Result<FileStats> {
        let removed = self.remove_path(collection, &spec.source).await?;
        FileRepo::upsert(
            self.meta.as_ref(),
            FileRecord {
                collection: collection.name.clone(),
                path: spec.source.clone(),
                file_hash: hash.to_owned(),
                size: file.size,
                mtime: file.mtime,
                indexed_at: now_millis(),
                status: "skipped".to_owned(),
                error: Some(reason.to_owned()),
            },
        )
        .await?;
        Ok(FileStats {
            deleted_chunks: removed,
            ..FileStats::default()
        })
    }

    /// 用**已经切好的块**写索引(当前阶段:PDF / Office 走 `DocChunker`,分块方式与代码路径不同)。
    ///
    /// 与 [`Self::index_entry_with_stages`] 共用“嵌入 → 写 LanceDB → 写 chunks/files 表”这一段。
    pub async fn index_prepared_chunks(
        &self,
        doc: &SourceDoc,
        collection: &Collection,
        spec: &FileIndexSpec,
        chunks: Vec<Chunk>,
        now: Millis,
        on_stage: &(dyn Fn(IndexStage) + Send + Sync),
    ) -> Result<FileStats> {
        self.index_prepared_chunks_mode(
            doc,
            collection,
            spec,
            chunks,
            now,
            IndexMode::Full,
            on_stage,
        )
        .await
    }

    /// 同 [`Self::index_prepared_chunks`],但可以只写正文(文本优先索引)。
    #[allow(clippy::too_many_arguments)] // 文本优先需要把 `mode` 一路传到底,参数形状与上面的入口保持一致
    pub async fn index_prepared_chunks_mode(
        &self,
        doc: &SourceDoc,
        collection: &Collection,
        spec: &FileIndexSpec,
        chunks: Vec<Chunk>,
        now: Millis,
        mode: IndexMode,
        on_stage: &(dyn Fn(IndexStage) + Send + Sync),
    ) -> Result<FileStats> {
        let hash = doc.file_hash.clone();
        let text_only = mode == IndexMode::TextOnly;
        let existing_chunks =
            ChunkRepo::by_path(self.meta.as_ref(), &collection.name, &spec.source).await?;
        // 队列里的块即使哈希没变也要重走 Embed:正文已写好,向量还空着。
        let mut pending_in_queue: HashSet<String> =
            ChunkRepo::pending_for_path(self.meta.as_ref(), &collection.name, &spec.source)
                .await?
                .into_iter()
                .collect();
        // 补向量阶段是「先写 Lance 向量、再删队列」:中途崩溃会在队列里留下已经 ready 的 id。
        // 文本阶段若照着队列把它重新写成 pending,会把已经补好的向量抹掉。这里用 Lance
        // 的真实状态过滤:只丢掉「行还在且已经是 ready」的 id。
        // 行已经不在 Lance 里(被孤儿对账清掉 / 手工删除)时必须保留 —— 否则下面的 diff 会判成
        // Skip,随后队列被整体重置,这个块就永远没有向量、也不会再进队列。
        if text_only && !pending_in_queue.is_empty() {
            let ids: Vec<String> = pending_in_queue.iter().cloned().collect();
            let in_store: HashSet<String> = self
                .store
                .get(&collection.active_table, &ids)
                .await?
                .into_iter()
                .map(|row| row.id)
                .collect();
            let still_pending: HashSet<String> = self
                .store
                .get_pending(&collection.active_table, &ids)
                .await?
                .into_iter()
                .map(|row| row.id)
                .collect();
            pending_in_queue.retain(|id| !in_store.contains(id) || still_pending.contains(id));
        }
        // 这里不再按文件哈希直接跳过:调用方(文本索引 / 办公文档 / 上传解析)已经各自做过
        // “内容没变”的判断;文本路径命中插件时会刻意绕过快路径,若这里再拦一次,插件升级
        // 或清单改标签后仍然不会重跑。没有变化时下面的 diff 只会做元数据比对,不会重新嵌入。
        let rows = build_rows(
            doc,
            &chunks,
            &collection.name,
            self.embedder.id(),
            spec.kind,
            &spec.tags,
            now,
        );
        // 同一文件内 id 必须唯一,否则 chunks 表主键冲突、LanceDB 与 SQLite 会不一致
        let mut ids: HashSet<&str> = HashSet::with_capacity(rows.len());
        for row in &rows {
            if !ids.insert(row.id.as_str()) {
                return Err(KbError::InvalidInput(format!(
                    "分块结果出现重复 id({}),文件 {}",
                    row.id, spec.source
                )));
            }
        }
        let plan = diff_with_pending(&existing_chunks, &rows, &pending_in_queue);

        // 删除旧块。
        //
        // 文本阶段把删除推迟到元数据提交之后:队列与块在同一个事务里落库,先删 Lance 行
        // 再提交元数据时一旦崩溃,`chunks` 还是旧的、队列是空的,下一次会命中「文件哈希
        // 没变」的快路径,被删掉的块就永久没有向量了。推迟之后最坏只是多留一会儿旧行,
        // 由孤儿对账清理;补向量阶段也能按队列把新行补齐。
        let deferred_deletes = if text_only {
            plan.delete_ids.clone()
        } else {
            Vec::new()
        };
        if !text_only && !plan.delete_ids.is_empty() {
            self.store
                .delete_ids(&collection.active_table, &plan.delete_ids)
                .await?;
        }

        // 需要嵌入的块:批量嵌入后 upsert
        let mut embedded = 0usize;
        let mut pending: Vec<RecordRow> = Vec::new();
        for (row, action) in rows.iter().zip(plan.actions.iter()) {
            if *action == ChunkAction::Embed {
                pending.push(row.clone());
            }
        }
        // 文本优先:不调用嵌入器,把正文写成 `embed_state=pending` 的行,
        // 由补队列稍后填向量。写入仍走同一条 upsert,只是 vector 为空。
        //
        // 先把待补 id 单独写进队列,再写 Lance:反过来的话,「Lance 已写、元数据事务未提交」
        // 的崩溃窗口会留下没有队列项的 pending 行;文件哈希随后没变,下一次文本索引会被
        // 快路径直接跳过,这个块就永远没有向量。先入队最坏只是多一条残留队列项,
        // 下一次文本阶段 / 补向量会按 Lance 真状态把它清掉。
        if text_only && !pending.is_empty() {
            let queued: Vec<(String, String)> = pending
                .iter()
                .map(|row| (row.id.clone(), row.source.clone()))
                .collect();
            ChunkRepo::enqueue_pending(self.meta.as_ref(), &collection.name, &queued, now).await?;
        }
        if !text_only {
            on_stage(IndexStage::Embedding);
        }
        let batch_size = self.options().batch_size.max(1);
        // 嵌入按小批做(占内存少、查询能插队),但向量库每写一次就多一个版本和一批数据文件:
        // 攒够 UPSERT_FLUSH_ROWS 行再一起写,写入次数降到原来的十几分之一
        let mut buffered: Vec<RecordRow> = Vec::with_capacity(UPSERT_FLUSH_ROWS + batch_size);
        if text_only {
            // 只写正文:pending 行的 vector 是 None,`rows_to_batch` 会落 embed_state=pending。
            self.store
                .upsert(&collection.active_table, pending.clone())
                .await?;
        } else {
            for batch in pending.chunks(batch_size) {
                let texts: Vec<String> = batch.iter().map(embed_text).collect();
                let vectors = self.embedder.embed_documents(texts).await?;
                if vectors.len() != batch.len() {
                    return Err(KbError::Internal(format!(
                        "嵌入器返回 {} 条向量,期望 {} 条",
                        vectors.len(),
                        batch.len()
                    )));
                }
                for (row, vector) in batch.iter().zip(vectors) {
                    let mut row = row.clone();
                    row.vector = Some(vector);
                    buffered.push(row);
                }
                embedded += batch.len();
                if buffered.len() >= UPSERT_FLUSH_ROWS {
                    self.store
                        .upsert(&collection.active_table, std::mem::take(&mut buffered))
                        .await?;
                }
            }
            if !buffered.is_empty() {
                self.store
                    .upsert(&collection.active_table, buffered)
                    .await?;
            }
        }

        on_stage(IndexStage::Writing);
        // 只更新元数据的块:攒成一批再写。逐行写是碎片的主源——编辑文件后行号整体位移,
        // 一个文件的几十个块全部要走这里,一次一行就是一个版本、一个 1 行碎片。
        let mut updated_meta = 0usize;
        let mut patches: Vec<(String, MetaPatch)> = Vec::new();
        for (row, action) in rows.iter().zip(plan.actions.iter()) {
            if *action == ChunkAction::UpdateMeta {
                patches.push((row.id.clone(), meta_patch(row)));
                if patches.len() >= META_PATCH_FLUSH_ROWS {
                    self.store
                        .update_meta_batch(&collection.active_table, std::mem::take(&mut patches))
                        .await?;
                }
                updated_meta += 1;
            }
        }
        if !patches.is_empty() {
            self.store
                .update_meta_batch(&collection.active_table, patches)
                .await?;
        }

        // 写回 chunks 表(整体替换该 source)
        let metas: Vec<ChunkMeta> = rows
            .iter()
            .enumerate()
            .map(|(ordinal, row)| ChunkMeta {
                id: row.id.clone(),
                collection: row.collection.clone(),
                path: row.source.clone(),
                ordinal: ordinal as u32,
                content_hash: row.content_hash.clone(),
                meta_hash: row.meta_hash.clone(),
                embed_input_hash: row.embed_input_hash.clone(),
                updated_at: now,
            })
            .collect();
        // 文本优先:块与待补队列同一个事务写入,消灭「块在、队列没有」的崩溃窗口。
        let queued: Vec<(String, String)> = if text_only {
            pending
                .iter()
                .map(|row| (row.id.clone(), row.source.clone()))
                .collect()
        } else {
            Vec::new()
        };
        ChunkRepo::replace_for_path_with_pending(
            self.meta.as_ref(),
            &collection.name,
            &spec.source,
            metas,
            &queued,
            now,
        )
        .await?;

        FileRepo::upsert(
            self.meta.as_ref(),
            FileRecord {
                collection: collection.name.clone(),
                path: spec.source.clone(),
                file_hash: hash,
                size: doc.size,
                mtime: doc.mtime,
                indexed_at: now,
                status: "ok".to_owned(),
                error: None,
            },
        )
        .await?;

        // 文本阶段推迟到这里:元数据(块 + 队列)和文件记录都已经落库,再删旧行。
        // 即使删除失败,新行也在、队列也能补向量;旧行会被孤儿对账按「不在 chunks 里」清掉。
        if !deferred_deletes.is_empty() {
            self.store
                .delete_ids(&collection.active_table, &deferred_deletes)
                .await?;
        }

        // 链接图谱跟着正文一起刷新:不阻塞索引,失败下次保存 / 重建时再补
        let title = spec
            .source
            .rsplit('/')
            .next()
            .unwrap_or(&spec.source)
            .to_owned();
        if let Err(err) = self
            .refresh_doc_links(collection, &spec.source, &title, doc.mtime, &doc.text, now)
            .await
        {
            tracing::warn!(path = %spec.source, error = %err, "刷新文档链接失败");
        }

        Ok(FileStats {
            chunks: rows.len(),
            embedded,
            pending: if text_only { pending.len() } else { 0 },
            updated_meta,
            deleted_chunks: plan.delete_ids.len(),
        })
    }

    /// 待补向量的块数(检索 / 监控 / doctor 用)。
    pub async fn pending_count(&self, collection: &str) -> Result<u64> {
        ChunkRepo::pending_count(self.meta.as_ref(), collection).await
    }

    /// 补一批向量:从 SQLite 队列取一批 id,在 LanceDB 找对应 pending 行,嵌入后写成 ready。
    ///
    /// 只处理**队列里登记过**的 id:文本阶段先写 LanceDB 再提交元数据,崩溃可能留下
    /// 一批没有元数据的 pending 行;那些是孤儿,交给孤儿对账,不能在这里嵌入。
    /// 返回补完的行数。
    pub async fn embed_pending_batch(
        &self,
        collection: &Collection,
        limit: usize,
    ) -> Result<usize> {
        let queued = ChunkRepo::pending_after(
            self.meta.as_ref(),
            &collection.name,
            None,
            limit.min(u32::MAX as usize) as u32,
        )
        .await?;
        if queued.is_empty() {
            return Ok(0);
        }
        let table = &collection.active_table;
        // 升级路径:旧表可能还没 `embed_state`。补向量会同时读 get/get_pending 两条路径，
        // 这里先按需补列，避免第一次 `--embed-pending` 就报“列不存在”。补列本身是幂等的。
        self.store.ensure_table(table, collection.dim).await?;
        let ids: Vec<String> = queued.iter().map(|item| item.chunk_id.clone()).collect();
        // 按队列 id 精确取:不能只取一批 pending 再过滤,否则 LanceDB 里排在前面的
        // 孤儿 pending 行会把真正要补的 id 挤出 limit,后面的队列就永远轮不到。
        let rows = self.store.get_pending(table, &ids).await?;
        // 队列里的 id 在 LanceDB 找不到时不能一律当成「块已删除」:如果它还在 `chunks` 表里,
        // 说明向量行丢了(手工删除 / 对账误删 / 写入中断),直接出队会让这个块永远没有向量,
        // 下一次增量还会因为文件哈希没变走快路径。这里只对「不在 chunks 表」的残留 id 出队,
        // 其余报错交给用户重跑文本阶段重建;先补能补的,错误也不会丢掉已写的向量。
        let found: HashSet<String> = rows.iter().map(|row| row.id.clone()).collect();
        // 行在 Lance 里但不在 pending 结果里 = 已经 ready(补完向量后崩溃留下的残留队列),
        // 这种可以直接出队;行完全不在 Lance 里才需要进一步区分是不是块也被删了。
        let present: HashSet<String> = self
            .store
            .get(table, &ids)
            .await?
            .into_iter()
            .map(|row| row.id)
            .collect();
        let stale_ready: Vec<String> = present
            .iter()
            .filter(|id| !found.contains(*id))
            .cloned()
            .collect();
        let missing: Vec<String> = ids
            .iter()
            .filter(|id| !present.contains(*id))
            .cloned()
            .collect();
        let broken: HashSet<String> = if missing.is_empty() {
            HashSet::new()
        } else {
            ChunkRepo::existing_ids(self.meta.as_ref(), &collection.name, &missing)
                .await?
                .into_iter()
                .collect()
        };
        let ready: Vec<RecordRow> = rows;
        let batch_size = self.options().batch_size.max(1);
        let mut embedded = 0usize;
        for batch in ready.chunks(batch_size) {
            let texts: Vec<String> = batch.iter().map(embed_text).collect();
            let vectors = self.embedder.embed_documents(texts).await?;
            if vectors.len() != batch.len() {
                return Err(KbError::Internal(format!(
                    "嵌入器返回 {} 条向量,期望 {} 条",
                    vectors.len(),
                    batch.len()
                )));
            }
            let mut rows = Vec::with_capacity(batch.len());
            for (row, vector) in batch.iter().zip(vectors) {
                let mut row = row.clone();
                row.vector = Some(vector);
                rows.push(row);
            }
            self.store.upsert(table, rows).await?;
            embedded += batch.len();
        }
        // 只出队「已补完」「已经是 ready」和「chunks 表里也没有」的 id;
        // 最后一种确实是已删除块的残留队列项。
        let mut clear_ids: Vec<String> = found.into_iter().collect();
        clear_ids.extend(stale_ready);
        clear_ids.extend(missing.iter().filter(|id| !broken.contains(*id)).cloned());
        ChunkRepo::clear_pending(self.meta.as_ref(), &collection.name, &clear_ids).await?;
        if !broken.is_empty() {
            return Err(KbError::Internal(format!(
                "补向量时发现 {} 个块的向量行在 LanceDB 里不存在(元数据仍在,文件不会被判定为新增);请对这些文件重跑文本阶段或重建索引",
                broken.len()
            )));
        }
        Ok(embedded)
    }

    /// 对账:删掉向量库里有、`chunks` 表里没有的代码 / 文档行(孤儿向量)。
    ///
    /// 来源:一个文件向量化到一半进程被停(重启、崩溃、任务被取消),已经写进向量库的那些块
    /// 还没来得及登记进 `chunks` 表。它们能被浏览和检索到,却没有任何文件记录指着它们,
    /// 删文件 / 改排除规则时按 `chunks` 表找 id 也找不到,会一直留着。
    ///
    /// 保护:
    /// - 只在拿得到独占闸门时做(没有索引分片在写),拿不到返回 `None`,下一轮再试;
    /// - 只看 `code` / `doc` 两种(洞察、批注、摘要不经过 `chunks` 表);
    /// - 最近 [`ORPHAN_GRACE_MS`] 内写的不动(保存笔记等不走索引任务的写入);
    /// - 孤儿占了大头(`meta.db` 被旧备份恢复、或换过库)时拒绝自动删,交给人去重建索引。
    pub async fn reconcile_orphans(&self, collection: &Collection) -> Result<Option<usize>> {
        let Some(_exclusive) = self.gate.try_exclusive() else {
            return Ok(None);
        };
        // 先锁后读:持锁期间迁移也进不来,active 表不会变
        let current = self.fresh_collection(&collection.name).await?;
        let table = current.active_table.as_str();
        // 不能拿「向量库行数 <= 元数据块数」当无事发生的捷径:两边行数相等时仍可能
        // 一边缺 5 块、另一边多 5 条孤儿(取消/重启留下的半截文件),行数完全抵消。
        // 这里直接取 id 逐条对比;10 万行的指纹列表在 debug 下约 74 ms,每小时一次可以接受。
        let fingerprints = self
            .store
            .list_fingerprints(table, Some("kind IN ('code', 'doc')"))
            .await?;
        let in_store = fingerprints.len();
        if in_store == 0 {
            return Ok(Some(0));
        }
        let in_meta = ChunkRepo::count(self.meta.as_ref(), &current.name).await?;

        let mut known: HashSet<String> = HashSet::with_capacity(in_meta as usize);
        let mut after: Option<String> = None;
        loop {
            let page =
                ChunkRepo::ids_after(self.meta.as_ref(), &current.name, after.as_deref(), 5000)
                    .await?;
            let Some(last) = page.last() else { break };
            after = Some(last.id.clone());
            known.extend(page.into_iter().map(|meta| meta.id));
        }
        let cutoff = now_millis() - ORPHAN_GRACE_MS;
        let orphans: Vec<String> = fingerprints
            .into_iter()
            .filter(|fingerprint| {
                !known.contains(&fingerprint.id) && fingerprint.updated_at < cutoff
            })
            .map(|fingerprint| fingerprint.id)
            .collect();
        if orphans.is_empty() {
            return Ok(Some(0));
        }
        if orphans.len() > ORPHAN_MIN_FOR_GUARD && orphans.len() as u64 * 2 > in_store as u64 {
            tracing::warn!(
                collection = %current.name,
                orphans = orphans.len(),
                in_store,
                "向量库里有一半以上的行在 chunks 表里找不到,疑似 meta.db 被恢复过,不自动删除,请重建索引"
            );
            return Ok(Some(0));
        }
        self.store.delete_ids(table, &orphans).await?;
        tracing::info!(
            collection = %current.name,
            removed = orphans.len(),
            "已清理孤儿向量"
        );
        Ok(Some(orphans.len()))
    }

    /// 本表累计写入多少行后做一次 optimize。
    pub fn optimize_after_rows(&self) -> usize {
        self.options().optimize_after_rows as usize
    }

    /// 重新解析一篇 Markdown 的引用并写入链接图谱。
    ///
    /// 链接是辅助信息:解析 / 写库失败只记 warning,不能把文件索引或笔记保存带崩。
    /// 非 Markdown 的正文不参与图谱(代码、PDF 里的“[x](y)”不是可点击的文档引用)。
    pub async fn refresh_doc_links(
        &self,
        collection: &Collection,
        source: &str,
        title: &str,
        mtime: Millis,
        text: &str,
        now: Millis,
    ) -> Result<usize> {
        if !is_markdown_path(source) {
            DocLinkRepo::delete_source(self.meta.as_ref(), "file", &collection.name, source)
                .await?;
            return Ok(0);
        }
        let parsed = crate::doc_links::parse_doc_links(text, &collection.name, Some(source));
        let links: Vec<DocLink> = parsed
            .into_iter()
            .map(|link| DocLink {
                source_kind: "file".to_owned(),
                source_collection: collection.name.clone(),
                source_id: source.to_owned(),
                source_title: title.to_owned(),
                href: link.href,
                line: link.line,
                label: link.label,
                target_kind: link.target_kind,
                target_collection: link.target_collection,
                target_id: link.target_id,
                reason: link.reason,
                indexed_at: now,
            })
            .collect();
        let count = links.len();
        DocLinkRepo::replace_source(
            self.meta.as_ref(),
            DocLinkSource {
                source_kind: "file".to_owned(),
                collection: collection.name.clone(),
                id: source.to_owned(),
                title: title.to_owned(),
                mtime,
                indexed_at: now,
            },
            &links,
        )
        .await?;
        Ok(count)
    }

    /// 删除某个 source 的全部块与文件记录(文件消失或被过滤时用)。
    pub async fn remove_source(&self, collection: &Collection, source: &str) -> Result<usize> {
        self.remove_path(collection, source).await
    }

    /// 删除某个路径的全部块与文件记录(文件消失或被过滤时用)。
    async fn remove_path(&self, collection: &Collection, path: &str) -> Result<usize> {
        let existing = ChunkRepo::by_path(self.meta.as_ref(), &collection.name, path).await?;
        if existing.is_empty() {
            // 没有块也可能还有待补向量的队列项(正文块刚被删、向量还没补):
            // 用空替换走一次事务,把队列一并清掉,否则补向量任务会一直去找不存在的块。
            ChunkRepo::replace_for_path(self.meta.as_ref(), &collection.name, path, Vec::new())
                .await?;
            FileRepo::delete(self.meta.as_ref(), &collection.name, path).await?;
            let _ = DocLinkRepo::delete_source(self.meta.as_ref(), "file", &collection.name, path)
                .await;
            return Ok(0);
        }
        let ids: Vec<String> = existing.iter().map(|meta| meta.id.clone()).collect();
        self.store
            .delete_ids(&collection.active_table, &ids)
            .await?;
        ChunkRepo::replace_for_path(self.meta.as_ref(), &collection.name, path, Vec::new()).await?;
        FileRepo::delete(self.meta.as_ref(), &collection.name, path).await?;
        let _ =
            DocLinkRepo::delete_source(self.meta.as_ref(), "file", &collection.name, path).await;
        Ok(ids.len())
    }
}

/// 只有 Markdown 正文有可点击的引用;其它文件即使内容像 Markdown 也不进图谱。
fn is_markdown_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".md", ".markdown", ".mdx", ".mdown", ".mkd"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// 文件元数据的修改时间(Unix 毫秒)。
pub fn millis_of(metadata: &std::fs::Metadata) -> Millis {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_else(now_millis)
}

/// 单个文件的处理结果。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FileStats {
    /// 处理后的块数。
    pub chunks: usize,
    /// 重新嵌入的块数。
    pub embedded: usize,
    /// 只写了正文、等待补向量的块数(文本优先索引)。
    pub pending: usize,
    /// 只更新元数据的块数。
    pub updated_meta: usize,
    /// 删除的块数。
    pub deleted_chunks: usize,
}

fn meta_patch(row: &RecordRow) -> MetaPatch {
    MetaPatch {
        start_line: row.start_line,
        end_line: row.end_line,
        title: row.title.clone(),
        symbol: row.symbol.clone(),
        tags: Some(row.tags.clone()),
        status: Some(row.status),
        meta_hash: Some(row.meta_hash.clone()),
        updated_at: Some(row.updated_at),
        // 新补丁字段默认不动:重排只改元数据,不重算 source/header/lex/embed_input_hash。
        ..Default::default()
    }
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
