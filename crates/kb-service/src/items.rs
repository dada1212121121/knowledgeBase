//! 条目读写:`list_items` / `edit_item` / `create_item` / `delete_item`。
//!
//! 权威数据的分工（设计规范）:
//! - **insight** 的正文与版本在 SQLite(`insights` 表),LanceDB 里只是检索副本,改动后投递
//!   `save_insight` 任务重新嵌入;
//! - **代码 / 文档块**由源文件派生,正文与标题**只读**,只能改标签(改完只更新元数据列,
//!   不重新嵌入);删除同理:它们会随源文件重新出现,因此拒绝单独删除。
//!
//! 每个改动都会在批次里留一条可回滚的变更(见 [`crate::revert`]),供 `revert_batch` 撤销。

use std::sync::Arc;

use kb_core::filter::{Filter, validate_tag_value};
use kb_core::hash::{MetaHashInput, meta_hash};
use kb_core::model::{
    Collection, Insight, InsightKind, ItemStatus, ItemVersion, ListQuery, MetaPatch, Millis, Page,
    RecordKind, RecordRow,
};
use kb_core::ports::repo::{
    CollectionRepo, EdgeRepo, InsightRepo, MetaStore, ProjectRepo, VersionRepo,
};
use kb_core::ports::{Embedder, VectorStore};
use kb_core::{KbError, Result};
use serde::Serialize;
use serde_json::Value;

use crate::insight::{InsightService, SaveInsightRequest, SaveInsightResult};
use crate::jobs::queue::{JobQueue, NewJob, priority};
use crate::revert::{
    OP_INSIGHT_CREATE, OP_INSIGHT_DELETE, OP_INSIGHT_UPDATE, OP_ITEM_TAGS, record_op,
};

/// 协作落地时笔记正文的上限(与单条消息上限分开:消息上限是协议层的,这里是存储层的)。
pub const MAX_LANDED_BODY_BYTES: usize = 1024 * 1024;

/// `list_items` 的请求。
#[derive(Clone, Debug, Default)]
pub struct ListRequest {
    /// collection 名(必填)。
    pub collection: String,
    /// 只返回这个种类。
    pub kind: Option<RecordKind>,
    /// 只返回这个 insight 子类型(decision / pitfall / howto / convention / note)。
    ///
    /// 子类型只在 SQLite 的 `insights` 表里,所以先捞 id 再过滤向量表。
    pub insight_kind: Option<kb_core::model::InsightKind>,
    /// 状态白名单;空 = 只取 `active`,三种全含 = 不限。
    pub statuses: Vec<ItemStatus>,
    /// 路径前缀。
    pub path_prefix: Option<String>,
    /// 标签。
    pub tag: Option<String>,
    /// 关键词(标题 / 符号 / 路径的包含匹配)。
    pub q: Option<String>,
    /// 页码,1 起。
    pub page: u32,
    /// 每页条数。
    pub page_size: u32,
    /// 排序列(白名单见 [`ListQuery::COLUMNS`])。
    pub sort: Option<String>,
    /// 是否升序。
    pub ascending: bool,
    /// 按文件列:同一个 `source` 的所有块归并成一条(浏览器用)。
    ///
    /// 向量库里一份文档被切成很多块,那是检索的单位;人浏览、预览、编辑的单位是文件。
    /// 不开这个选项时仍是一块一行(检索、按路径找块、评测等内部用法需要块级的行)。
    pub group_by_file: bool,
}

/// 列表里的一行(不含正文与向量,设计规范的 `list_items` 形状)。
#[derive(Clone, Debug, Serialize)]
pub struct ItemSummary {
    /// 记录 id。
    pub id: String,
    /// collection。
    pub collection: String,
    /// 种类。
    pub kind: RecordKind,
    /// 语言。
    pub lang: Option<String>,
    /// 路径 / `insight:<id>`。
    pub source: String,
    /// 起始行。
    pub start_line: Option<i32>,
    /// 结束行。
    pub end_line: Option<i32>,
    /// 符号路径。
    pub symbol: Option<String>,
    /// 标题。
    pub title: Option<String>,
    /// 状态。
    pub status: ItemStatus,
    /// 标签。
    pub tags: Vec<String>,
    /// 更新时间。
    pub updated_at: Millis,
    /// 乐观锁版本(insight 取 `insights.version`;代码 / 文档块没有版本,为 `None`)。
    pub version: Option<i64>,
    /// 这个文件被切成了多少块;只有按文件列(`group_by_file`)时才有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chunks: Option<u32>,
}

impl ItemSummary {
    /// 从存储行裁剪出摘要。
    pub fn of(row: &RecordRow) -> Self {
        Self {
            id: row.id.clone(),
            collection: row.collection.clone(),
            kind: row.kind,
            lang: row.lang.clone(),
            source: row.source.clone(),
            start_line: row.start_line,
            end_line: row.end_line,
            symbol: row.symbol.clone(),
            title: row.title.clone(),
            status: row.status,
            tags: row.tags.clone(),
            updated_at: row.updated_at,
            version: None,
            chunks: None,
        }
    }

    /// 一个文件的摘要:用代表块的 id 打开(打开它就是打开整份文件),标题取文档的总标题,
    /// 标签是各块的并集,更新时间是各块里最新的。
    pub fn of_file(file: &kb_core::model::FileEntry) -> Self {
        let first = &file.first;
        // 文档块的标题是「总标题 › 章 › 节」的路径,文件级只要最前面的总标题;
        // 代码块的符号只属于那一块,文件级不带
        let title = match first.kind {
            RecordKind::Doc => first
                .title
                .as_deref()
                .and_then(|title| title.split(" › ").next())
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .map(str::to_owned),
            RecordKind::Code => None,
            _ => first.title.clone(),
        };
        Self {
            id: first.id.clone(),
            collection: first.collection.clone(),
            kind: first.kind,
            lang: first.lang.clone(),
            source: first.source.clone(),
            start_line: None,
            end_line: None,
            symbol: None,
            title,
            status: first.status,
            tags: file.tags.clone(),
            updated_at: file.updated_at,
            version: None,
            chunks: Some(file.chunks),
        }
    }
}

/// `list_items` 的结果。
#[derive(Clone, Debug, Serialize)]
pub struct ListResponse {
    /// 本页的行。
    pub items: Vec<ItemSummary>,
    /// 过滤后的总条数。
    pub total: u64,
    /// 页码(1 起)。
    pub page: u32,
    /// 每页条数。
    pub page_size: u32,
}

/// `edit_item` 的请求。
#[derive(Clone, Debug, Default)]
pub struct EditRequest {
    /// 记录 id。
    pub id: String,
    /// 乐观锁版本(insight 必填;代码 / 文档块没有版本,忽略)。
    pub version: Option<i64>,
    /// 新标题(代码 / 文档块只读)。
    pub title: Option<String>,
    /// 新正文(代码 / 文档块只读)。
    pub body: Option<String>,
    /// 新标签。
    pub tags: Option<Vec<String>>,
    /// 新的 insight 种类。
    pub kind: Option<InsightKind>,
    /// 谁改的(写进版本历史;不填按 `web`)。
    pub author: Option<String>,
}

/// `edit_item` / `create_item` 的结果（设计规范）。
#[derive(Clone, Debug, Serialize)]
pub struct EditResult {
    /// 记录 id。
    pub id: String,
    /// 新版本(insight 是 `insights.version`;代码 / 文档块用新的 `updated_at`)。
    pub version: i64,
    /// 所属 collection。
    pub collection: String,
    /// 需要重新嵌入时投递的任务 id。
    pub job_id: Option<String>,
}

/// `create_item` 的请求。
#[derive(Clone, Debug)]
pub struct CreateRequest {
    /// 直接指定 collection(优先于 project / global)。
    pub collection: Option<String>,
    /// 目标项目。
    pub project: Option<String>,
    /// 写进 `_global`。
    pub global: bool,
    /// 标题。
    pub title: String,
    /// 正文。
    pub body: String,
    /// 种类。
    pub kind: Option<InsightKind>,
    /// 标签。
    pub tags: Vec<String>,
    /// 相关文件。
    pub related_paths: Vec<String>,
    /// 来源。
    pub created_by: String,
    /// 调用方工作目录。
    pub cwd: Option<String>,
}

/// `delete_item` 的结果。
#[derive(Clone, Debug, Serialize)]
pub struct DeleteResult {
    /// 被删的记录 id。
    pub id: String,
    /// 所属 collection。
    pub collection: String,
    /// 是否连同 SQLite 里的 insight 行一起删掉。
    pub insight: bool,
}

/// 一次 `batch_tag` 最多改多少条。
pub const MAX_BATCH_TAG: usize = 200;

/// `batch_tag` 里的一条结果。
#[derive(Clone, Debug, Serialize)]
pub struct TaggedItem {
    /// 记录 id。
    pub id: String,
    /// 改动前的标签。
    pub before: Vec<String>,
    /// 改动后的标签。
    pub tags: Vec<String>,
}

/// `batch_tag` 的结果。
#[derive(Clone, Debug, Serialize)]
pub struct BatchTagResult {
    /// 每条的结果。
    pub updated: Vec<TaggedItem>,
}

/// 条目服务。
pub struct ItemService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    queue: JobQueue,
    /// 与索引 / 迁移共享的写闸门。
    gate: crate::write_gate::WriteGate,
    /// 声明式 skills:`type = "insight-template"` 的 skill 决定必填字段与长度上限。
    skills: Arc<crate::skills::SkillRegistry>,
}

impl ItemService {
    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
    ) -> Self {
        let queue = JobQueue::new(meta.clone());
        Self {
            meta,
            store,
            embedder,
            queue,
            gate: crate::write_gate::WriteGate::new(),
            skills: Arc::new(crate::skills::SkillRegistry::empty()),
        }
    }

    /// 挂上声明式 skills:新建 insight 时按 `insight-template` 校验。
    pub fn with_skills(mut self, skills: Arc<crate::skills::SkillRegistry>) -> Self {
        self.skills = skills;
        self
    }

    /// 换用共享的写闸门。
    pub fn with_write_gate(mut self, gate: crate::write_gate::WriteGate) -> Self {
        self.gate = gate;
        self
    }

    /// 按文件列:取满足条件的全部块的瘦行,归并成文件,排序后再分页。
    ///
    /// 排序键沿用 `list_items` 的白名单:`updated_at`(文件里最新的块)、`source`、`kind`;
    /// `start_line` 对文件没有意义,按 `source` 处理。同值时用 `source` 兜底,翻页顺序是稳定的。
    async fn list_files(
        &self,
        table: &str,
        sql: Option<&str>,
        request: &ListRequest,
        page: u32,
        page_size: u32,
    ) -> Result<ListResponse> {
        // 先校验排序列:非法的值和块级列表同样报 InvalidInput
        let order = ListQuery::new(1, 0).with_order(request.sort.as_deref(), request.ascending)?;
        // 只带「种类 / 状态」过滤时(浏览器的分类计数和按类型筛选):种类在内存里筛,SQL 只带状态——
        // 这样「全部 / 笔记 / 文档 / 代码」几个计数和列表、树的分面用的是同一份缓存,不会各扫一遍表。
        // 带路径前缀、标签、关键词、id 白名单时仍按完整条件查(它们的语义在 SQL 里,不在内存里重做一遍)。
        let kind_in_memory = request.path_prefix.is_none()
            && request.tag.is_none()
            && request.q.is_none()
            && request.insight_kind.is_none();
        let cached = if kind_in_memory {
            let status_only = Filter {
                statuses: request.statuses.clone(),
                ..Filter::default()
            }
            .to_sql()?;
            self.store.list_files(table, status_only.as_deref()).await?
        } else {
            self.store.list_files(table, sql).await?
        };
        // 缓存里的是共享的、按 source 升序的一份;排序在自己的引用数组上做,不动它
        let mut files: Vec<&kb_core::model::FileEntry> = cached
            .iter()
            .filter(|file| {
                !kind_in_memory || request.kind.is_none_or(|kind| file.first.kind == kind)
            })
            .collect();
        match order.order_by.as_str() {
            "source" | "start_line" => files.sort_by(|a, b| a.first.source.cmp(&b.first.source)),
            "kind" => files.sort_by(|a, b| {
                (a.first.kind.as_str(), &a.first.source)
                    .cmp(&(b.first.kind.as_str(), &b.first.source))
            }),
            _ => files.sort_by(|a, b| {
                a.updated_at
                    .cmp(&b.updated_at)
                    .then_with(|| b.first.source.cmp(&a.first.source))
            }),
        }
        if !order.ascending {
            files.reverse();
        }
        let total = files.len() as u64;
        let start = ((page - 1) as usize).saturating_mul(page_size as usize);
        let items = files
            .iter()
            .skip(start)
            .take(page_size as usize)
            .map(|file| ItemSummary::of_file(file))
            .collect();
        Ok(ListResponse {
            items,
            total,
            page,
            page_size,
        })
    }

    /// 各种类有多少个文件(按文件算,同一份文档的几十个块只算一个);没有的种类不出现。
    /// 和 [`ItemService::list`] 按文件列时共用同一份缓存,浏览器一次展开不会重复扫表。
    pub async fn count_files_by_kind(
        &self,
        collection: &str,
        statuses: &[ItemStatus],
    ) -> Result<Vec<(RecordKind, u64)>> {
        let collection = self.collection(collection).await?;
        let filter = Filter {
            statuses: statuses.to_vec(),
            ..Filter::default()
        }
        .to_sql()?;
        let files = self
            .store
            .list_files(&collection.active_table, filter.as_deref())
            .await?;
        let mut counts: std::collections::BTreeMap<&'static str, (RecordKind, u64)> =
            std::collections::BTreeMap::new();
        for file in files.iter() {
            counts
                .entry(file.first.kind.as_str())
                .or_insert((file.first.kind, 0))
                .1 += 1;
        }
        Ok(counts.into_values().collect())
    }

    /// 分类 → 数量 → 一级目录分布(`item_facets.kinds[].dirs`),外加全部目录前缀。
    ///
    /// 分类下的 `dirs` 只按**第一段路径**归并:文件夹是虚拟前缀,没有稳定 id,树里也只展示一层;
    /// 用 `path == dir || starts_with(dir + "/")` 的语义由前端按前缀查询时保证,这里只给出计数。
    /// 返回值第二个是全部目录前缀(含多级),给移动弹窗的下拉用,不参与树形展示。
    pub async fn count_files_by_kind_dir(
        &self,
        collection: &str,
        statuses: &[ItemStatus],
    ) -> Result<(
        Vec<(RecordKind, u64, std::collections::BTreeMap<String, u64>)>,
        Vec<String>,
    )> {
        let collection = self.collection(collection).await?;
        let filter = Filter {
            statuses: statuses.to_vec(),
            ..Filter::default()
        }
        .to_sql()?;
        let files = self
            .store
            .list_files(&collection.active_table, filter.as_deref())
            .await?;
        let mut counts: std::collections::BTreeMap<
            &'static str,
            (RecordKind, u64, std::collections::BTreeMap<String, u64>),
        > = std::collections::BTreeMap::new();
        // 移动弹窗要能选多级目录,这里顺手把所有非文件本身的路径前缀收集起来;
        // 与分类下的一级目录分布共用同一次 list_files,不额外扫库。
        let mut all_dirs = std::collections::BTreeSet::new();
        for file in files.iter() {
            let entry = counts
                .entry(file.first.kind.as_str())
                .or_insert_with(|| (file.first.kind, 0, std::collections::BTreeMap::new()));
            entry.1 += 1;
            let segments: Vec<&str> = file.first.source.split('/').collect();
            for end in 1..segments.len() {
                if segments[..end].iter().any(|segment| segment.is_empty()) {
                    continue;
                }
                all_dirs.insert(segments[..end].join("/"));
            }
            // `path_prefix` 用的是 LIKE 前缀,目录名本身要按路径段取第一段,
            // 不能把 `docs/a.md` 整个路径当成目录写进树里。
            if let Some(dir) = segments
                .first()
                .filter(|dir| **dir != file.first.source && !dir.is_empty())
            {
                *entry.2.entry((*dir).to_owned()).or_insert(0) += 1;
            }
        }
        Ok((
            counts.into_values().collect(),
            all_dirs.into_iter().collect(),
        ))
    }

    /// 分页列出条目。
    pub async fn list(&self, request: ListRequest) -> Result<ListResponse> {
        let collection = self.collection(&request.collection).await?;
        let (page, page_size) = normalize_page(request.page, request.page_size);
        let mut filter = list_filter(&request);
        if let Some(kind) = request.insight_kind {
            let ids: Vec<String> = InsightRepo::list(
                self.meta.as_ref(),
                &collection.name,
                None,
                Page::new(10_000, 0),
            )
            .await?
            .into_iter()
            .filter(|insight| insight.kind == kind)
            .map(|insight| insight.id)
            .collect();
            if ids.is_empty() {
                return Ok(ListResponse {
                    items: Vec::new(),
                    total: 0,
                    page,
                    page_size,
                });
            }
            filter.ids = ids;
        }
        let sql = filter.to_sql()?;
        if request.group_by_file {
            return self
                .list_files(
                    &collection.active_table,
                    sql.as_deref(),
                    &request,
                    page,
                    page_size,
                )
                .await;
        }
        let total = self
            .store
            .count(&collection.active_table, sql.as_deref())
            .await?;
        let query = ListQuery::new(page_size as usize, ((page - 1) * page_size) as usize)
            .with_filter(sql)
            .with_order(request.sort.as_deref(), request.ascending)?;
        let rows = self.store.list(&collection.active_table, &query).await?;
        // insight 的版本在 SQLite 里:一次取全量(单个 collection 的经验条目量级很小),
        // 避免给每一行单独查一次库
        let versions: std::collections::HashMap<String, i64> = InsightRepo::list(
            self.meta.as_ref(),
            &collection.name,
            None,
            Page::new(10_000, 0),
        )
        .await?
        .into_iter()
        .map(|insight| (insight.id, insight.version))
        .collect();
        let items = rows
            .iter()
            .map(|row| {
                let mut summary = ItemSummary::of(row);
                summary.version = versions.get(&row.id).copied();
                summary
            })
            .collect();
        Ok(ListResponse {
            items,
            total,
            page,
            page_size,
        })
    }

    /// 编辑一条。
    ///
    /// - insight:正文 / 标题变化要重新嵌入(投递任务),只改标签 / 种类则只更新元数据;
    /// - 代码 / 文档块:只允许改标签,正文与标题一律拒绝。
    pub async fn edit(&self, request: EditRequest, batch_id: Option<&str>) -> Result<EditResult> {
        validate_tags(request.tags.as_deref().unwrap_or_default())?;
        match InsightRepo::get(self.meta.as_ref(), &request.id).await? {
            Some(insight) => self.edit_insight(insight, request, batch_id).await,
            None => self.edit_derived(request, batch_id).await,
        }
    }

    /// 新建一条 insight(Web 端「新建条目」)。
    pub async fn create(
        &self,
        request: CreateRequest,
        batch_id: Option<&str>,
    ) -> Result<SaveInsightResult> {
        validate_tags(&request.tags)?;
        // 声明式 skills 的 insight-template:必填字段与长度上限
        self.skills
            .validate_insight(&request.title, &request.body, &request.tags)?;
        let created_by = request.created_by.clone();
        let saved =
            InsightService::new(self.meta.clone(), self.store.clone(), self.embedder.clone())
                .save(SaveInsightRequest {
                    title: request.title,
                    body_md: request.body,
                    kind: request.kind,
                    project: request.project,
                    global: request.global,
                    collection: request.collection,
                    tags: request.tags,
                    related_paths: request.related_paths,
                    supersedes: None,
                    created_by: request.created_by,
                    cwd: request.cwd,
                    strict_links: false,
                })
                .await?;
        // 新建即落一条 v1:笔记的历史从「刚写下的这一版」开始,之后每次保存是 v2、v3…
        // (以前要等第一次改动才补基线,新建后没改过的笔记在历史面板里是空的)
        self.insight_baseline(&saved.id, &created_by).await?;
        if let Some(batch_id) = batch_id {
            let after = serde_json::json!({ "id": saved.id, "collection": saved.collection });
            record_op(
                self.meta.as_ref(),
                batch_id,
                &saved.id,
                OP_INSIGHT_CREATE,
                None,
                Some(after),
            )
            .await?;
        }
        Ok(saved)
    }

    /// 删除一条:insight 删 SQLite 行 + LanceDB 副本;代码 / 文档块拒绝删除。
    pub async fn delete(&self, id: &str, batch_id: Option<&str>) -> Result<DeleteResult> {
        if let Some(insight) = InsightRepo::get(self.meta.as_ref(), id).await? {
            let collection = self.collection(&insight.collection).await?;
            let before = serde_json::to_value(&insight)
                .map_err(|err| KbError::Internal(format!("序列化 insight 失败: {err}")))?;
            // 关系是双向的:出边与入边都要清掉,否则会留下指向空 id 的孤儿边
            for edge in EdgeRepo::by_src(self.meta.as_ref(), id).await? {
                EdgeRepo::remove(self.meta.as_ref(), &edge.src_id, &edge.dst, edge.rel).await?;
            }
            for edge in EdgeRepo::by_dst(self.meta.as_ref(), id).await? {
                EdgeRepo::remove(self.meta.as_ref(), &edge.src_id, &edge.dst, edge.rel).await?;
            }
            InsightRepo::delete(self.meta.as_ref(), id).await?;
            let _ = kb_core::ports::repo::DocLinkRepo::delete_source(
                self.meta.as_ref(),
                "note",
                &insight.collection,
                id,
            )
            .await;
            let (_guard, table) =
                crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                    .await?;
            if let Err(err) = self.store.delete_ids(&table, &[id.to_owned()]).await
                && !matches!(err, KbError::NotFound(_))
            {
                tracing::warn!(error = %err, insight = %id, "删除 LanceDB 副本失败");
            }
            if let Some(batch_id) = batch_id {
                record_op(
                    self.meta.as_ref(),
                    batch_id,
                    id,
                    OP_INSIGHT_DELETE,
                    Some(before),
                    None,
                )
                .await?;
            }
            return Ok(DeleteResult {
                id: id.to_owned(),
                collection: collection.name,
                insight: true,
            });
        }
        // 不是 insight:找它在哪个 collection
        let (collection, row) = self.find_row(id).await?;
        if matches!(row.kind, RecordKind::Code | RecordKind::Doc) {
            return Err(KbError::InvalidInput(format!(
                "条目 {id} 是{}块,由源文件派生,不能单独删除;请改源文件后重新索引",
                if row.kind == RecordKind::Code {
                    "代码"
                } else {
                    "文档"
                }
            )));
        }
        let (_guard, table) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                .await?;
        self.store.delete_ids(&table, &[id.to_owned()]).await?;
        if let Some(batch_id) = batch_id {
            let before = serde_json::to_value(&row)
                .map_err(|err| KbError::Internal(format!("序列化记录失败: {err}")))?;
            record_op(
                self.meta.as_ref(),
                batch_id,
                id,
                crate::revert::OP_ITEM_DELETE,
                Some(serde_json::json!({ "collection": collection.name, "row": before })),
                None,
            )
            .await?;
        }
        Ok(DeleteResult {
            id: id.to_owned(),
            collection: collection.name,
            insight: false,
        })
    }

    /// 批量打标签(Web 的「批量操作」):一次调用改多条,整体可撤销。
    ///
    /// 只改标签,不改正文 / 标题,所以不触发重新嵌入;insight 的标签同时写回 SQLite,
    /// 代码 / 文档块只改 LanceDB 的元数据列。返回每条的新标签。
    pub async fn batch_tag(
        &self,
        ids: &[String],
        add: &[String],
        remove: &[String],
        batch_id: Option<&str>,
    ) -> Result<BatchTagResult> {
        if ids.is_empty() {
            return Err(KbError::InvalidInput("ids 不能为空".to_owned()));
        }
        if ids.len() > MAX_BATCH_TAG {
            return Err(KbError::InvalidInput(format!(
                "一次最多给 {MAX_BATCH_TAG} 条打标签,收到 {}",
                ids.len()
            )));
        }
        if add.is_empty() && remove.is_empty() {
            return Err(KbError::InvalidInput(
                "add / remove 至少要有一项".to_owned(),
            ));
        }
        validate_tags(add)?;
        validate_tags(remove)?;
        let mut updated = Vec::with_capacity(ids.len());
        for id in ids {
            let (before, after) = self.tag_one(id, add, remove, batch_id).await?;
            updated.push(TaggedItem {
                id: id.clone(),
                before,
                tags: after,
            });
        }
        Ok(BatchTagResult { updated })
    }

    /// 给一条打 / 去标签,返回 (旧标签, 新标签)。
    async fn tag_one(
        &self,
        id: &str,
        add: &[String],
        remove: &[String],
        batch_id: Option<&str>,
    ) -> Result<(Vec<String>, Vec<String>)> {
        // insight:标签在 SQLite 里是权威数据
        if let Some(insight) = InsightRepo::get(self.meta.as_ref(), id).await? {
            let before = insight.tags.clone();
            let tags = merge_tags(&insight.tags, add, remove);
            if tags == before {
                return Ok((before, tags));
            }
            let mut next = insight.clone();
            next.tags = tags.clone();
            next.updated_at = now_millis();
            let saved = InsightRepo::update(self.meta.as_ref(), next, insight.version).await?;
            let collection = self.collection(&saved.collection).await?;
            let (_guard, table) =
                crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                    .await?;
            if let Err(err) = self
                .store
                .update_meta(
                    &table,
                    &saved.id,
                    MetaPatch {
                        tags: Some(saved.tags.clone()),
                        meta_hash: Some(insight_meta_hash(&saved)),
                        updated_at: Some(saved.updated_at),
                        ..MetaPatch::default()
                    },
                )
                .await
                && !matches!(err, KbError::NotFound(_))
            {
                tracing::warn!(error = %err, insight = %saved.id, "同步 LanceDB 标签失败");
            }
            if let Some(batch_id) = batch_id {
                record_op(
                    self.meta.as_ref(),
                    batch_id,
                    &saved.id,
                    OP_ITEM_TAGS,
                    Some(serde_json::json!({ "tags": before })),
                    Some(serde_json::json!({
                        "tags": saved.tags,
                        "collection": collection.name,
                    })),
                )
                .await?;
            }
            return Ok((before, saved.tags));
        }
        // 代码 / 文档块:标签只在 LanceDB 的元数据列里
        let (collection, row) = self.find_row(id).await?;
        let before = row.tags.clone();
        let tags = merge_tags(&row.tags, add, remove);
        if tags == before {
            return Ok((before, tags));
        }
        let (_guard, table) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                .await?;
        self.store
            .update_meta(
                &table,
                id,
                MetaPatch {
                    tags: Some(tags.clone()),
                    meta_hash: Some(row_meta_hash(&row, &tags, row.status)),
                    updated_at: Some(now_millis()),
                    ..MetaPatch::default()
                },
            )
            .await?;
        if let Some(batch_id) = batch_id {
            record_op(
                self.meta.as_ref(),
                batch_id,
                id,
                OP_ITEM_TAGS,
                Some(serde_json::json!({ "tags": before })),
                Some(serde_json::json!({ "tags": tags, "collection": collection.name })),
            )
            .await?;
        }
        Ok((before, tags))
    }

    /// 按名字取 collection。
    pub async fn collection(&self, name: &str) -> Result<Collection> {
        CollectionRepo::get(self.meta.as_ref(), name)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {name}")))
    }

    // ---------------------------------------------------------------- 多人协作落地

    /// 笔记当前的正文。
    pub async fn insight_body(&self, id: &str) -> Result<String> {
        InsightRepo::get(self.meta.as_ref(), id)
            .await?
            .map(|insight| insight.body_md)
            .ok_or_else(|| KbError::NotFound(format!("笔记 {id}")))
    }

    /// 协作开始前 / 新建笔记时留一条基线版本(此前没有任何版本记录时)。
    /// 协作落地会直接覆盖正文、新建笔记更是没有历史,没有基线的话旧正文就找不回来了。
    /// 已经有记录则什么也不做。
    pub async fn insight_baseline(&self, id: &str, author: &str) -> Result<()> {
        let insight = InsightRepo::get(self.meta.as_ref(), id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("笔记 {id}")))?;
        let source = format!("insight:{id}");
        let existing =
            VersionRepo::list_by_source(self.meta.as_ref(), &insight.collection, &source, 1)
                .await?;
        if !existing.is_empty() {
            return Ok(());
        }
        VersionRepo::create(
            self.meta.as_ref(),
            ItemVersion {
                id: uuid::Uuid::now_v7().to_string(),
                item_id: insight.id.clone(),
                collection: insight.collection.clone(),
                source,
                version: 1,
                title: Some(insight.title.clone()),
                body: insight.body_md.clone(),
                tags: insight.tags.clone(),
                author: Some(author.to_owned()),
                batch_id: None,
                created_at: now_millis(),
            },
        )
        .await
    }

    /// 协作落地:把协作编辑出来的 Markdown 直接写回笔记正文。
    ///
    /// 与 [`ItemService::edit`] 的区别:不要求版本号(协作期间 API 写入已被拒绝,房间是唯一的写入者),
    /// 不生成版本历史(只在保存点生成)、不立刻重新嵌入(太频繁,由调用方去抖后再调
    /// [`ItemService::reindex_insight`])。正文没变化就不写。返回 `(是否写入了, 正文哈希)`。
    pub async fn land_insight(&self, id: &str, body_md: &str) -> Result<(bool, String)> {
        if body_md.len() > MAX_LANDED_BODY_BYTES {
            return Err(KbError::InvalidInput(format!(
                "笔记正文超过 {} KB,无法保存",
                MAX_LANDED_BODY_BYTES / 1024
            )));
        }
        let insight = InsightRepo::get(self.meta.as_ref(), id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("笔记 {id}")))?;
        let hash = kb_core::hash::content_hash(body_md);
        if insight.body_md == body_md {
            return Ok((false, hash));
        }
        let mut updated = insight.clone();
        updated.body_md = body_md.to_owned();
        updated.updated_at = now_millis();
        InsightRepo::update(self.meta.as_ref(), updated.clone(), insight.version).await?;
        if let Err(err) = crate::insight::refresh_note_links(self.meta.as_ref(), &updated).await {
            tracing::warn!(insight = %updated.id, error = %err, "刷新笔记链接失败");
        }
        Ok((true, hash))
    }

    /// 保存点:把笔记当前正文记成版本历史里的一条,`author` 写本段时间内的参与者。
    /// 和上一条版本的正文一样就不重复记。返回是否新记了一条。
    pub async fn insight_savepoint(&self, id: &str, author: &str) -> Result<bool> {
        let insight = InsightRepo::get(self.meta.as_ref(), id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("笔记 {id}")))?;
        let source = format!("insight:{id}");
        let latest =
            VersionRepo::list_by_source(self.meta.as_ref(), &insight.collection, &source, 1)
                .await?;
        if latest
            .first()
            .is_some_and(|last| last.body == insight.body_md)
        {
            return Ok(false);
        }
        let version = latest.first().map_or(0, |last| last.version) + 1;
        VersionRepo::create(
            self.meta.as_ref(),
            ItemVersion {
                id: uuid::Uuid::now_v7().to_string(),
                item_id: insight.id.clone(),
                collection: insight.collection.clone(),
                source,
                version,
                title: Some(insight.title.clone()),
                body: insight.body_md.clone(),
                tags: insight.tags.clone(),
                author: Some(author.to_owned()),
                batch_id: None,
                created_at: now_millis(),
            },
        )
        .await?;
        Ok(true)
    }

    /// 把一次改动记进版本历史(`item_versions`)。
    ///
    /// - 每改一次就记一条,同一内容不重复记;
    /// - 之前一条历史都没有时,先把**改动前**的样子补成基线,否则第一条历史直接从改动后开始,
    ///   旧正文就再也找不回来了(sampleERP 那篇笔记就是这么丢的)。
    async fn record_insight_history(
        &self,
        before: &Insight,
        after: &Insight,
        author: &str,
    ) -> Result<()> {
        let body_or_title_changed = before.body_md != after.body_md || before.title != after.title;
        if !body_or_title_changed && before.tags == after.tags && before.kind == after.kind {
            return Ok(());
        }
        let source = format!("insight:{}", after.id);
        let latest =
            VersionRepo::list_by_source(self.meta.as_ref(), &after.collection, &source, 1).await?;
        let mut version = latest.first().map_or(0, |last| last.version);
        if latest.is_empty() && body_or_title_changed {
            version += 1;
            VersionRepo::create(
                self.meta.as_ref(),
                ItemVersion {
                    id: uuid::Uuid::now_v7().to_string(),
                    item_id: before.id.clone(),
                    collection: before.collection.clone(),
                    source: source.clone(),
                    version,
                    title: Some(before.title.clone()),
                    body: before.body_md.clone(),
                    tags: before.tags.clone(),
                    author: Some("baseline".to_owned()),
                    batch_id: None,
                    created_at: now_millis(),
                },
            )
            .await?;
        }
        let next = version + 1;
        VersionRepo::create(
            self.meta.as_ref(),
            ItemVersion {
                id: uuid::Uuid::now_v7().to_string(),
                item_id: after.id.clone(),
                collection: after.collection.clone(),
                source,
                version: next,
                title: Some(after.title.clone()),
                body: after.body_md.clone(),
                tags: after.tags.clone(),
                author: Some(author.to_owned()),
                batch_id: None,
                created_at: now_millis(),
            },
        )
        .await
    }

    /// 把一条笔记恢复到某一版(恢复本身也是一次编辑:产生新版本,可再恢复回来)。
    pub async fn restore_insight_version(
        &self,
        version_id: &str,
        author: &str,
    ) -> Result<EditResult> {
        let version = VersionRepo::get(self.meta.as_ref(), version_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("版本 {version_id}")))?;
        let insight = InsightRepo::get(self.meta.as_ref(), &version.item_id)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("笔记 {}", version.item_id)))?;
        self.edit(
            EditRequest {
                id: insight.id.clone(),
                version: Some(insight.version),
                title: version.title.clone(),
                body: Some(version.body.clone()),
                tags: Some(version.tags.clone()),
                kind: None,
                author: Some(author.to_owned()),
            },
            None,
        )
        .await
    }

    /// 协作落地之后重新嵌入(调用方去抖)。返回投递的任务 id。
    pub async fn reindex_insight(&self, id: &str) -> Result<Option<String>> {
        let Some(insight) = InsightRepo::get(self.meta.as_ref(), id).await? else {
            return Ok(None);
        };
        let collection = self.collection(&insight.collection).await?;
        Ok(Some(self.enqueue_insight(&insight, &collection).await?))
    }

    /// 把一个集合里的所有经验条目重新投递嵌入(从备份恢复后向量表是空的)。返回投递条数。
    pub async fn reindex_collection(&self, collection: &str) -> Result<usize> {
        let Some(target) = CollectionRepo::get(self.meta.as_ref(), collection).await? else {
            return Ok(0);
        };
        let mut queued = 0usize;
        let mut offset = 0u32;
        loop {
            let page = InsightRepo::list(
                self.meta.as_ref(),
                collection,
                None,
                kb_core::model::Page::new(200, offset),
            )
            .await?;
            if page.is_empty() {
                break;
            }
            offset += page.len() as u32;
            for insight in &page {
                self.enqueue_insight(insight, &target).await?;
                queued += 1;
            }
        }
        Ok(queued)
    }

    /// 找出某个 id 落在哪个 collection 的哪一行。
    pub async fn find_row(&self, id: &str) -> Result<(Collection, RecordRow)> {
        for name in CollectionRepo::list(self.meta.as_ref())
            .await?
            .into_iter()
            .map(|collection| collection.name)
        {
            let Some(collection) = CollectionRepo::get(self.meta.as_ref(), &name).await? else {
                continue;
            };
            let rows = self
                .store
                .get(
                    &collection.active_table,
                    std::slice::from_ref(&id.to_owned()),
                )
                .await?;
            if let Some(row) = rows.into_iter().next() {
                return Ok((collection, row));
            }
        }
        Err(KbError::NotFound(format!("item {id}")))
    }

    async fn edit_insight(
        &self,
        insight: Insight,
        request: EditRequest,
        batch_id: Option<&str>,
    ) -> Result<EditResult> {
        let Some(expected) = request.version else {
            return Err(KbError::InvalidInput(
                "编辑经验条目必须带 version(乐观锁),可用 list_items 拿到当前版本".to_owned(),
            ));
        };
        if expected != insight.version {
            return Err(KbError::Conflict {
                expected,
                actual: insight.version,
            });
        }
        let before = serde_json::to_value(&insight)
            .map_err(|err| KbError::Internal(format!("序列化 insight 失败: {err}")))?;
        let mut updated = insight.clone();
        if let Some(title) = &request.title {
            if title.trim().is_empty() {
                return Err(KbError::InvalidInput("title 不能为空".to_owned()));
            }
            updated.title = title.trim().to_owned();
        }
        if let Some(body) = &request.body {
            if body.trim().is_empty() {
                return Err(KbError::InvalidInput("body 不能为空".to_owned()));
            }
            updated.body_md = body.clone();
        }
        if let Some(tags) = &request.tags {
            updated.tags = tags.clone();
        }
        if let Some(kind) = request.kind {
            updated.kind = kind;
        }
        let now = now_millis();
        updated.updated_at = now;
        // 标题与正文进了 embed_input_hash,变了就必须重新嵌入
        let reembed = updated.title != insight.title || updated.body_md != insight.body_md;
        let updated = InsightRepo::update(self.meta.as_ref(), updated, insight.version).await?;
        if let Err(err) = crate::insight::refresh_note_links(self.meta.as_ref(), &updated).await {
            tracing::warn!(insight = %updated.id, error = %err, "刷新笔记链接失败");
        }
        // 每次真的改了内容就留一条版本历史:阅读态 / 历史面板据此能翻回任意一版、对比改动
        self.record_insight_history(
            &insight,
            &updated,
            request.author.as_deref().unwrap_or("web"),
        )
        .await?;
        let collection = self.collection(&updated.collection).await?;

        let job_id = if reembed {
            Some(self.enqueue_insight(&updated, &collection).await?)
        } else {
            // 只改了标签 / 种类:同步 LanceDB 的元数据列即可
            let (_guard, table) =
                crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                    .await?;
            if let Err(err) = self
                .store
                .update_meta(
                    &table,
                    &updated.id,
                    MetaPatch {
                        title: Some(updated.title.clone()),
                        tags: Some(updated.tags.clone()),
                        status: Some(updated.status),
                        meta_hash: Some(insight_meta_hash(&updated)),
                        updated_at: Some(now),
                        ..MetaPatch::default()
                    },
                )
                .await
                && !matches!(err, KbError::NotFound(_))
            {
                tracing::warn!(error = %err, insight = %updated.id, "同步 LanceDB 元数据失败");
            }
            None
        };

        if let Some(batch_id) = batch_id {
            let after = serde_json::to_value(&updated)
                .map_err(|err| KbError::Internal(format!("序列化 insight 失败: {err}")))?;
            record_op(
                self.meta.as_ref(),
                batch_id,
                &updated.id,
                OP_INSIGHT_UPDATE,
                Some(before),
                Some(after),
            )
            .await?;
        }
        Ok(EditResult {
            id: updated.id,
            version: updated.version,
            collection: collection.name,
            job_id,
        })
    }

    /// 代码 / 文档 / 外部条目:只允许改标签。
    async fn edit_derived(
        &self,
        request: EditRequest,
        batch_id: Option<&str>,
    ) -> Result<EditResult> {
        if request.title.is_some() || request.body.is_some() || request.kind.is_some() {
            return Err(KbError::InvalidInput(
                "代码 / 文档块的正文与标题只读,只能改标签".to_owned(),
            ));
        }
        let tags = request
            .tags
            .clone()
            .ok_or_else(|| KbError::InvalidInput("没有要改的字段(只能改标签)".to_owned()))?;
        let (collection, row) = self.find_row(&request.id).await?;
        let before = serde_json::json!({ "tags": row.tags });
        let now = now_millis();
        let meta_hash = row_meta_hash(&row, &tags, row.status);
        let (_guard, table) =
            crate::write_gate::lock_and_table(&self.gate, self.meta.as_ref(), &collection.name)
                .await?;
        self.store
            .update_meta(
                &table,
                &row.id,
                MetaPatch {
                    tags: Some(tags.clone()),
                    meta_hash: Some(meta_hash),
                    updated_at: Some(now),
                    ..MetaPatch::default()
                },
            )
            .await?;
        if let Some(batch_id) = batch_id {
            let after = serde_json::json!({ "tags": tags, "collection": collection.name });
            record_op(
                self.meta.as_ref(),
                batch_id,
                &row.id,
                OP_ITEM_TAGS,
                Some(before),
                Some(after),
            )
            .await?;
        }
        Ok(EditResult {
            id: row.id,
            // 代码 / 文档块没有版本列,用新的 updated_at 作为版本回给调用方
            version: now,
            collection: collection.name,
            job_id: None,
        })
    }

    /// 投递一条 `save_insight` 任务(重新嵌入)。
    pub async fn enqueue_insight(
        &self,
        insight: &Insight,
        collection: &Collection,
    ) -> Result<String> {
        let job = self
            .queue
            .enqueue(NewJob {
                kind: "save_insight".to_owned(),
                collection: Some(collection.name.clone()),
                priority: priority::SAVE_INSIGHT,
                payload: serde_json::json!({
                    "insight_id": insight.id,
                    "collection": collection.name,
                }),
            })
            .await?;
        Ok(job.id)
    }
}

/// 把一个 id 解析成它所属的 collection(其它模块也要用)。
pub async fn find_collection_of(
    meta: &dyn MetaStore,
    store: &dyn VectorStore,
    id: &str,
) -> Result<Collection> {
    for name in CollectionRepo::list(meta)
        .await?
        .into_iter()
        .map(|collection| collection.name)
    {
        let Some(collection) = CollectionRepo::get(meta, &name).await? else {
            continue;
        };
        let rows = store
            .get(
                &collection.active_table,
                std::slice::from_ref(&id.to_owned()),
            )
            .await?;
        if !rows.is_empty() {
            return Ok(collection);
        }
    }
    Err(KbError::NotFound(format!("item {id}")))
}

/// 页码与每页条数的边界:页码从 1 起,每页 1..=200,默认 50。
pub fn normalize_page(page: u32, page_size: u32) -> (u32, u32) {
    let page = page.max(1);
    let page_size = if page_size == 0 {
        Page::DEFAULT_LIMIT
    } else {
        page_size.min(200)
    };
    (page, page_size)
}

/// 标签校验(逗号会破坏 `,a,b,` 编码,一律拒绝)。
pub fn validate_tags(tags: &[String]) -> Result<()> {
    for tag in tags {
        validate_tag_value(tag)?;
    }
    Ok(())
}

fn list_filter(request: &ListRequest) -> Filter {
    Filter {
        kinds: request.kind.into_iter().collect(),
        statuses: request.statuses.clone(),
        path_prefix: request.path_prefix.clone(),
        tag: request.tag.clone(),
        contains: request.q.clone(),
        ..Filter::default()
    }
}

/// insight 的 `meta_hash`(与 `insight_row` 里那份一致)。
pub fn insight_meta_hash(insight: &Insight) -> String {
    meta_hash(&MetaHashInput {
        start_line: None,
        end_line: None,
        title: Some(&insight.title),
        tags: &insight.tags,
        status: insight.status.as_str(),
        symbol: None,
    })
}

/// 派生行的 `meta_hash`(改标签后要重算)。
pub fn row_meta_hash(row: &RecordRow, tags: &[String], status: ItemStatus) -> String {
    meta_hash(&MetaHashInput {
        start_line: row.start_line,
        end_line: row.end_line,
        title: row.title.as_deref(),
        tags,
        status: status.as_str(),
        symbol: row.symbol.as_deref(),
    })
}

/// 把一个 insight 快照还原到 SQLite(撤销删除用)。
pub async fn restore_insight(meta: &dyn MetaStore, snapshot: &Value) -> Result<Insight> {
    let insight: Insight = serde_json::from_value(snapshot.clone())
        .map_err(|err| KbError::InvalidInput(format!("变更记录里的 insight 快照不合法: {err}")))?;
    InsightRepo::create(meta, insight.clone()).await?;
    Ok(insight)
}

/// 项目里有没有这个 id(给统计与调试用)。
pub async fn project_of_collection(
    meta: &dyn MetaStore,
    collection: &Collection,
) -> Result<Option<kb_core::model::Project>> {
    match &collection.project_id {
        Some(id) => ProjectRepo::get(meta, id).await,
        None => Ok(None),
    }
}

/// 合并标签:保留原有顺序,加入 `add`(去重),去掉 `remove`。
fn merge_tags(current: &[String], add: &[String], remove: &[String]) -> Vec<String> {
    let mut tags: Vec<String> = current
        .iter()
        .filter(|tag| !remove.contains(tag))
        .cloned()
        .collect();
    for tag in add {
        if !tags.contains(tag) {
            tags.push(tag.clone());
        }
    }
    tags
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
