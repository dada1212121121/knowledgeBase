//! 元数据仓储 trait（设计规范）。
//!
//! 实体结构体在 [`crate::model`] 里,字段与设计规范的列同名;时间统一是 [`Millis`]。
//! 所有方法都是异步的:实现方需要把阻塞的 SQLite 调用包在 `spawn_blocking` 里（设计规范）。
//!
//! 签名说明:设计规范只给了方法名,参数与返回类型按 `&self` + `Result<Option<T>>`
//! 的形式补齐;`get` 找不到对象时返回 `Ok(None)`,需要对象存在的地方(例如 `update`)
//! 由实现方返回 [`crate::KbError::NotFound`]。

use async_trait::async_trait;

use crate::error::Result;
use crate::model::{
    ActivityCounts, ApiToken, AuditEntry, AuditFilter, AuditOverview, Batch, Change, ChunkMeta,
    Collection, Draft, DraftState, Edge, EdgeRel, Event, Feedback, FileChange, FileRecord,
    IngestBatch, IngestBatchState, IngestFile, IngestFilter, IngestOverview, IngestStage,
    IngestStageEvent, IngestStageStatus, IngestState, Insight, ItemStatus, Job, JobFile, JobFilter,
    JobSeries, JobState, JobStats, LlmSend, LlmUsage, Millis, Page, PendingChunk, PendingStats,
    Project, Session, Source, SourceIngestStats, Upload, UploadPart,
};

/// `projects` 表。
#[async_trait]
pub trait ProjectRepo: Send + Sync {
    /// 新建项目。
    async fn create(&self, project: Project) -> Result<()>;
    /// 按 id 取。
    async fn get(&self, id: &str) -> Result<Option<Project>>;
    /// 按名字取。
    async fn get_by_name(&self, name: &str) -> Result<Option<Project>>;
    /// 列出全部项目。
    async fn list(&self) -> Result<Vec<Project>>;
    /// 更新项目。
    async fn update(&self, project: Project) -> Result<()>;
    /// 删除项目(级联删除 collection 等)。
    async fn delete(&self, id: &str) -> Result<()>;
    /// 按 `root_path` 最长前缀匹配当前目录属于哪个项目。
    async fn match_cwd(&self, path: &str) -> Result<Option<Project>>;
}

/// `collections` 表。
#[async_trait]
pub trait CollectionRepo: Send + Sync {
    /// 新建 collection。
    async fn create(&self, collection: Collection) -> Result<()>;
    /// 按名字取。
    async fn get(&self, name: &str) -> Result<Option<Collection>>;
    /// 列出全部 collection。
    async fn list(&self) -> Result<Vec<Collection>>;
    /// 更新 collection。
    async fn update(&self, collection: Collection) -> Result<()>;
    /// 删除 collection(连同它的全部派生数据,见 [`Self::purge_data`])。
    async fn delete(&self, name: &str) -> Result<()>;
    /// 清掉该 collection 的派生数据(chunks / insights / 草稿 / 版本 / 批注 / 关系边 /
    /// 解析队列 / 上传会话),**不动** `collections` 行本身。
    ///
    /// 删除集合与「同名重建集合」都要先跑一次:只删 `collections` 行会留下孤儿 `chunks`,
    /// 重建后增量 diff 会把它们当成“没变的块”而跳过,新表永远是空的。
    async fn purge_data(&self, name: &str) -> Result<()>;
    /// 在一个事务里切换物理表指针(设计规范第 7 步)。
    async fn switch_active(
        &self,
        name: &str,
        new_table: &str,
        embedder_id: &str,
        dim: usize,
    ) -> Result<()>;
}

/// `files` 表:文件级指纹。
#[async_trait]
pub trait FileRepo: Send + Sync {
    /// 取单个文件记录。
    async fn get(&self, collection: &str, path: &str) -> Result<Option<FileRecord>>;
    /// 写入或覆盖文件记录。
    async fn upsert(&self, record: FileRecord) -> Result<()>;
    /// 列出该 collection 已索引的路径。
    async fn list_paths(&self, collection: &str) -> Result<Vec<String>>;
    /// 删除单个文件记录。
    async fn delete(&self, collection: &str, path: &str) -> Result<()>;
}

/// `file_ops` / `trash_entries` / `path_exclusions` 表。
#[async_trait]
pub trait FileOpsRepo: Send + Sync {
    /// 新建一条操作流水。
    async fn create_file_op(&self, op: crate::model::FileOp) -> Result<()>;
    /// 更新一条操作流水。
    async fn update_file_op(&self, op: &crate::model::FileOp) -> Result<()>;
    /// 按 id 取。
    async fn get_file_op(&self, id: &str) -> Result<Option<crate::model::FileOp>>;
    /// 往回收站记一条。
    async fn add_trash(&self, entry: crate::model::TrashEntry) -> Result<()>;
    /// 按 id 取一条回收站记录。
    async fn get_trash(&self, id: &str) -> Result<Option<crate::model::TrashEntry>>;
    /// 列出回收站里还没恢复 / 没彻底删除的条目(新 → 旧)。
    async fn list_trash(
        &self,
        collection: Option<&str>,
        page: Page,
    ) -> Result<Vec<crate::model::TrashEntry>>;
    /// 回收站里还没恢复 / 没彻底删除的条目总数(分页要显示总页数)。
    async fn count_trash(&self, collection: Option<&str>) -> Result<u64>;
    /// 列出已过期、还没清理的条目。
    async fn list_expired_trash(
        &self,
        now: crate::model::Millis,
        limit: u32,
    ) -> Result<Vec<crate::model::TrashEntry>>;
    /// 标记已恢复。
    async fn mark_trash_restored(&self, id: &str, at: crate::model::Millis) -> Result<()>;
    /// 标记已彻底删除。
    async fn mark_trash_purged(&self, id: &str, at: crate::model::Millis) -> Result<()>;
    /// 记一条同步排除标记(重复调用幂等)。
    async fn add_path_exclusion(
        &self,
        collection: &str,
        source_id: &str,
        path: &str,
        at: crate::model::Millis,
    ) -> Result<()>;
    /// 去掉同步排除标记。
    async fn remove_path_exclusion(
        &self,
        collection: &str,
        source_id: &str,
        path: &str,
    ) -> Result<()>;
    /// 这个文件是否被用户删过(同步扫到时不要再加回来)。
    async fn path_excluded(&self, collection: &str, source_id: &str, path: &str) -> Result<bool>;
    /// 某个数据源的全部排除路径(同步扫描时一次性取出来过滤)。
    async fn list_path_exclusions(&self, collection: &str, source_id: &str) -> Result<Vec<String>>;
}

/// `doc_links` / `doc_link_sources` 表:文档链接图谱。
#[async_trait]
pub trait DocLinkRepo: Send + Sync {
    /// 用一篇文档的最新解析结果整体替换它的链接(删旧 + 插新),同时更新来源登记。
    async fn replace_source(
        &self,
        source: crate::model::DocLinkSource,
        links: &[crate::model::DocLink],
    ) -> Result<()>;
    /// 取一篇来源文档的登记;没解析过返回 `None`。
    async fn get_source(
        &self,
        source_kind: &str,
        collection: &str,
        id: &str,
    ) -> Result<Option<crate::model::DocLinkSource>>;
    /// 列出 collection 里已登记的来源文档。
    async fn list_sources(&self, collection: &str) -> Result<Vec<crate::model::DocLinkSource>>;
    /// 一篇文档的对外链接(按行号、href 排序)。
    async fn links_from(
        &self,
        source_kind: &str,
        collection: &str,
        id: &str,
    ) -> Result<Vec<crate::model::DocLink>>;
    /// 指向某个目标的反向链接(最多 `limit` 条,新索引的在前)。
    async fn links_to(
        &self,
        target_kind: &str,
        collection: &str,
        id: &str,
        limit: u32,
    ) -> Result<Vec<crate::model::DocLink>>;
    /// 指向某个文件 / 文件夹下所有目标的反向链接。
    async fn links_under(
        &self,
        collection: &str,
        path_prefix: &str,
        limit: u32,
    ) -> Result<Vec<crate::model::DocLink>>;
    /// 某个文件 / 文件夹下所有来源文档的对外链接(移动影响用)。
    async fn links_from_under(
        &self,
        collection: &str,
        path_prefix: &str,
        limit: u32,
    ) -> Result<Vec<crate::model::DocLink>>;
    /// 来源文档改名 / 移动:只改登记,链接在重新解析时更新。
    async fn rename_source(
        &self,
        source_kind: &str,
        collection: &str,
        old_id: &str,
        new_id: &str,
    ) -> Result<()>;
    /// 目标文件 / 文件夹被删除 / 移走:把指向它的链接标记成失效,不篡改正文。
    async fn mark_target_missing(&self, collection: &str, path_prefix: &str) -> Result<()>;
    /// 删除一篇来源文档的全部链接与登记。
    async fn delete_source(&self, source_kind: &str, collection: &str, id: &str) -> Result<()>;
    /// 删除 collection 的全部链接(集合被删 / 重建时)。
    async fn purge_collection(&self, collection: &str) -> Result<()>;
}

/// `chunks` 表:块级三哈希。
#[async_trait]
pub trait ChunkRepo: Send + Sync {
    /// 取某个文件的全部块(按 ordinal 升序)。
    async fn by_path(&self, collection: &str, path: &str) -> Result<Vec<ChunkMeta>>;
    /// 用新结果替换某个文件的全部块(单个事务)。
    async fn replace_for_path(
        &self,
        collection: &str,
        path: &str,
        chunks: Vec<ChunkMeta>,
    ) -> Result<()>;
    /// 按 id 顺序翻页(迁移用,设计规范)。
    async fn ids_after(
        &self,
        collection: &str,
        after_id: Option<&str>,
        limit: u32,
    ) -> Result<Vec<ChunkMeta>>;
    /// 取 `updated_at > ts` 且 `(updated_at, id) > after` 的块(迁移追平用,带水位线)。
    ///
    /// `after` 传上一批最后一条的 `(updated_at, id)`,保证每轮都前进、不会死循环。
    async fn updated_since_after(
        &self,
        collection: &str,
        ts: Millis,
        after: Option<(Millis, &str)>,
        limit: u32,
    ) -> Result<Vec<ChunkMeta>>;

    /// 取 `updated_at > ts` 的块(迁移追平用)。
    async fn updated_since(
        &self,
        collection: &str,
        ts: Millis,
        limit: u32,
    ) -> Result<Vec<ChunkMeta>>;
    /// 该 collection 的块数。
    async fn count(&self, collection: &str) -> Result<u64>;
    /// 批量按 id 改写 `embed_input_hash`(换嵌入器迁移用),单个事务,返回实际命中的行数。
    ///
    /// `embed_input_hash` 把嵌入器 id 算了进去,迁移改了向量就必须同步改它,否则下一次
    /// 全量扫描会把每个块判成「嵌入输入变了」而整份重嵌入。
    ///
    /// **只改这一列**,不碰 `updated_at` 等其他列:`updated_at` 是迁移追平的水位线,
    /// 动了它会让追平把没变的块重复复制一遍。`collection` 下不存在的 id 直接忽略
    /// (迁移写进新表的 id 里还有 insight 行,它们在 `chunks` 里本来就没有记录)。
    async fn set_embed_input_hashes(
        &self,
        collection: &str,
        updates: &[(String, String)],
    ) -> Result<u64>;

    /// 整体替换某个 path 的块,并在**同一个事务**里重置待补向量队列。
    ///
    /// 文本优先索引必须用这个入口:先写正文再单独入队会在两次提交之间留一个崩溃窗口,
    /// 重启后「块在、队列没有」会让 pending 块永远补不上向量。
    async fn replace_for_path_with_pending(
        &self,
        collection: &str,
        path: &str,
        chunks: Vec<ChunkMeta>,
        pending: &[(String, String)],
        enqueued_at: Millis,
    ) -> Result<()> {
        let _ = (pending, enqueued_at);
        self.replace_for_path(collection, path, chunks).await
    }

    /// 把待补向量的块放进队列(已存在则保持原入队时间)。
    ///
    /// 默认实现是空操作:内存 / 测试替身没有文本优先索引,不会产生 pending 行。
    async fn enqueue_pending(
        &self,
        collection: &str,
        chunks: &[(String, String)],
        enqueued_at: Millis,
    ) -> Result<()> {
        let _ = (collection, chunks, enqueued_at);
        Ok(())
    }

    /// 待补向量的块数。
    async fn pending_count(&self, collection: &str) -> Result<u64> {
        let _ = collection;
        Ok(0)
    }

    /// 待补队列概览:块数、涉及文件数、最老入队时间(观测用)。
    ///
    /// 默认实现只数块;真实实现应当一条 SQL 同时取三个值,不要为文件数和最老时间
    /// 再各查一遍(每次观测都会扫 `pending_embeds`)。
    async fn pending_stats(&self, collection: &str) -> Result<PendingStats> {
        Ok(PendingStats {
            chunks: self.pending_count(collection).await?,
            files: 0,
            oldest_enqueued_at: None,
        })
    }

    /// 是否还有待补向量的块。检索热路径用它决定是否启用 pending 补充检索。
    async fn has_pending(&self, collection: &str) -> Result<bool> {
        Ok(self.pending_count(collection).await? > 0)
    }

    /// 补完向量的块出队;不存在的 id 直接忽略。
    async fn clear_pending(&self, collection: &str, ids: &[String]) -> Result<()> {
        let _ = (collection, ids);
        Ok(())
    }

    /// 这些 id 里哪些还在 `chunks` 表里。
    ///
    /// 补向量时 LanceDB 找不到队列里的行,要靠它区分「块已被删除,队列是残留」和
    /// 「块还在、向量行丢了」:前者可以安全出队,后者必须报错,让用户重跑文本阶段。
    async fn existing_ids(&self, collection: &str, ids: &[String]) -> Result<Vec<String>> {
        let _ = (collection, ids);
        Ok(Vec::new())
    }

    /// 清空一个 collection 的待补队列。
    ///
    /// 迁移会把 pending 行一起按新嵌入器重算成 ready;切换后队列必须整体清掉,
    /// 否则检索每次都要多跑一次 pending 补充查询,直到队列被下一轮补向量偶然排空。
    /// 默认实现是空操作,理由同 [`ChunkRepo::enqueue_pending`]。
    async fn clear_all_pending(&self, collection: &str) -> Result<()> {
        let _ = collection;
        Ok(())
    }

    /// 某个文件还在队列里的块 id。
    ///
    /// 增量索引用它判断「哈希没变也不能跳过」:正文没变但向量还没补。
    async fn pending_for_path(&self, collection: &str, path: &str) -> Result<Vec<String>> {
        let _ = (collection, path);
        Ok(Vec::new())
    }

    /// 按 chunk_id 顺序翻页取待补向量的队列项(恢复 / 全量补齐用)。
    async fn pending_after(
        &self,
        collection: &str,
        after: Option<&str>,
        limit: u32,
    ) -> Result<Vec<PendingChunk>> {
        let _ = (collection, after, limit);
        Ok(Vec::new())
    }
}

/// `insights` 表:经验条目。
#[async_trait]
pub trait InsightRepo: Send + Sync {
    /// 新建。
    async fn create(&self, insight: Insight) -> Result<()>;
    /// 按 id 取。
    async fn get(&self, id: &str) -> Result<Option<Insight>>;
    /// 乐观锁更新;版本不符返回 [`crate::KbError::Conflict`],成功时返回新版本。
    async fn update(&self, insight: Insight, expected_version: i64) -> Result<Insight>;
    /// 分页列出某个 collection 的条目。
    async fn list(
        &self,
        collection: &str,
        status: Option<ItemStatus>,
        page: Page,
    ) -> Result<Vec<Insight>>;
    /// 创建时间不早于 `since` 的条目,只返回 `(collection, created_at)`:
    /// 统计「近几天新增」用,不需要把正文读出来。
    async fn created_since(&self, since: Millis) -> Result<Vec<(String, Millis)>>;
    /// 沿 `superseded_by` 双向遍历的演进链。
    async fn history(&self, id: &str) -> Result<Vec<Insight>>;
    /// 删除一条(`delete_item`;LanceDB 里的副本由调用方一起删)。
    async fn delete(&self, id: &str) -> Result<()>;
}

/// `edges` 表:轻量关系。
#[async_trait]
pub trait EdgeRepo: Send + Sync {
    /// 新增一条边(重复时忽略)。
    async fn add(&self, edge: Edge) -> Result<()>;
    /// 按源查询。
    async fn by_src(&self, src_id: &str) -> Result<Vec<Edge>>;
    /// 按目标查询。
    async fn by_dst(&self, dst: &str) -> Result<Vec<Edge>>;
    /// 删除一条边。
    async fn remove(&self, src_id: &str, dst: &str, rel: EdgeRel) -> Result<()>;
    /// 删除所有指向这个目标的边(文件被删除时清理 `path:` 悬挂边)。
    async fn remove_by_dst(&self, dst: &str) -> Result<u64>;
    /// 把指向旧路径的边改到新路径(文件 / 文件夹移动)。
    async fn rekey_dst(&self, from: &str, to: &str) -> Result<u64>;
}

/// `jobs` 表:任务队列。
#[async_trait]
pub trait JobRepo: Send + Sync {
    /// 入队。
    async fn enqueue(&self, job: Job) -> Result<()>;
    /// 取下一个可执行任务:按「有效优先级」降序、创建时间升序。
    /// 有效优先级 = 优先级 + 排队等待的加成(防低优先级任务被饿死,有上限,不会越过保存经验 / 编辑单条)。
    async fn next_runnable(&self) -> Result<Option<Job>>;
    /// 认领下一个可执行任务:查到就**在同一个写事务里**把它转成 `running`。
    ///
    /// 一个知识库的后台同时跑好几个分片时(见 `index.parallel_slices`),取任务必须走它:
    /// `next_runnable` + `update` 两步之间别的分片会把同一个任务领走,变成两片跑同一批文件
    /// (文件会被领两遍、进度算两遍)。没有可认领的任务时返回 `None`。
    async fn claim_next(&self) -> Result<Option<Job>>;
    /// 更新任务(状态、进度、检查点)。
    async fn update(&self, job: Job) -> Result<()>;
    /// 按 id 取。
    async fn get(&self, id: &str) -> Result<Option<Job>>;
    /// 列出任务。
    async fn list(&self, state: Option<JobState>) -> Result<Vec<Job>>;
    /// 列出任务摘要:SQL 层就不读 `payload_json` / `checkpoint_json`(返回的 `payload_json` 为空串、
    /// `checkpoint_json` 为 `None`)。索引任务的这两列单条能到几 MB,只要展示列表就不该读出来。
    async fn list_summaries(&self, state: Option<JobState>) -> Result<Vec<Job>>;
    /// 最近创建的 `limit` 条任务摘要(新的在前),字段约定同 [`JobRepo::list_summaries`]。
    async fn recent_summaries(&self, limit: u32) -> Result<Vec<Job>>;
    /// 按状态计数,6 种状态都会出现(没有的为 0)。
    async fn count_by_state(&self) -> Result<Vec<(JobState, u64)>>;
    /// 分页列出任务摘要(字段约定同 [`JobRepo::list_summaries`]),同时返回符合条件的总数。
    ///
    /// 顺序:运行中 → 排队(优先级高的、先到的在前,即执行顺序)→ 其余按结束时间倒序(没有结束时间按创建时间)。
    async fn list_page(&self, filter: JobFilter, page: Page) -> Result<(Vec<Job>, u64)>;
    /// 任务统计;`recent_since` 之后结束(没有结束时间按创建时间)的任务算「最近」。
    async fn stats(&self, filter: JobFilter, recent_since: Millis) -> Result<JobStats>;
    /// 任务随时间的变化:从 `start` 起 `count` 个宽 `step_ms` 的桶,每个桶的创建 / 完成 / 失败 / 取消数、平均用时、桶末排队深度。
    async fn series(
        &self,
        filter: JobFilter,
        start: Millis,
        step_ms: i64,
        count: usize,
    ) -> Result<JobSeries>;
    /// 是否有优先级高于 `priority` 的排队任务。
    async fn has_queued_above(&self, priority: i32) -> Result<bool>;
    /// 清理 `finished_at`(没有则取 `created_at`)早于 `before` 的失败任务,返回条数;
    /// `dry_run` 为真时只数不删。只动 `failed` 状态,别的状态一律不碰。
    async fn prune_failed(&self, before: Millis, dry_run: bool) -> Result<u64>;
    /// 启动恢复:把 `running` 改回 `queued`,返回受影响的行数。
    async fn requeue_running(&self) -> Result<u64>;
    /// 记下任务对若干个文件做了什么。同一任务同一个路径重复处理只留最后一次(续跑重写)。
    async fn record_job_files(&self, job_id: &str, files: &[JobFile]) -> Result<()>;
    /// 一个任务处理过的文件:按 [`FileChange::order`] 排(失败 / 删除 / 新增在前,没变的最后),
    /// 同类型按路径排;同时返回总数和每种变化类型的条数。
    ///
    /// 老任务(`job_files` 表引入前就跑完的)查出来是空的,调用方要回退到任务参数里的清单。
    async fn list_job_files(
        &self,
        job_id: &str,
        page: Page,
    ) -> Result<(Vec<JobFile>, u64, Vec<(FileChange, u64)>)>;
}

/// 按天的活动计数(首页 / 系统概览的趋势):一次查询把笔记、编辑、导入、检索、完成的任务、模型 token 都按天数好。
#[async_trait]
pub trait ActivityRepo: Send + Sync {
    /// 从 `start`(第一天的零点,毫秒)起连续 `labels.len` 天,每天的计数。
    /// `labels` 是每天的 `YYYY-MM-DD`(站点时区,由调用方算好):按天归桶用固定的 24 小时宽度,
    /// 夏令时切换那天最多差一小时的边界,对趋势图无影响;模型 token 按 `labels` 里的日期字符串对表里的 `day` 列。
    async fn activity(&self, start: Millis, labels: Vec<String>) -> Result<ActivityCounts>;

    /// 导入概况:各状态的文件数、从 `start` 起 `count` 个宽 `step_ms` 的桶里每段时间进来 / 成功 / 失败的文件数、失败原因 Top `errors` 个。
    async fn ingest_overview(
        &self,
        start: Millis,
        step_ms: i64,
        count: usize,
        errors: usize,
    ) -> Result<IngestOverview>;

    /// 审计概况:`since` 之后的调用,按「周几 × 几点」(`offset_secs` 是站点时区相对 UTC 的偏移)数次数,
    /// 以及最常用的 `top` 个能力。`ignore` 里的能力(页面自动刷新用的读取)不参与:它们的次数反映的是页面开了多久,不是谁在用。
    async fn audit_overview(
        &self,
        since: Millis,
        offset_secs: i64,
        ignore: Vec<String>,
        top: usize,
    ) -> Result<AuditOverview>;

    /// 每个集合里各种文件状态(`ok` / `binary` / `excluded` / `too_large` / `generated` / `error` …)的数量。
    /// 项目页用它画「这个项目的文件有多少进了库、多少被跳过」。
    async fn file_status_counts(&self) -> Result<Vec<(String, String, u64)>>;
}

/// `audit` / `batches` / `changes` 表。
#[async_trait]
pub trait AuditRepo: Send + Sync {
    /// 写一条审计,返回自增 id。
    async fn record(&self, entry: AuditEntry) -> Result<i64>;
    /// 开一个批次,返回批次 id。
    async fn begin_batch(&self, actor: &str, description: &str) -> Result<String>;
    /// 确保指定 id 的批次存在(已存在时什么也不做)。
    ///
    /// 上传是一次请求一个文件,但“一次上传(一个文件夹 / 一批拖拽)= 一个 batch”,
    /// 所以批次 id 由客户端在 `POST /uploads` 里带上,这里按需补齐批次行。
    async fn ensure_batch(&self, id: &str, actor: &str, description: &str) -> Result<()>;
    /// 记录批次内的一条变更(实现方应校验 `change.batch_id == batch_id`)。
    async fn record_change(&self, batch_id: &str, change: Change) -> Result<()>;
    /// 取批次。
    async fn batch(&self, id: &str) -> Result<Option<Batch>>;
    /// 分页查询审计。
    async fn list(&self, filter: Option<AuditFilter>, page: Page) -> Result<Vec<AuditEntry>>;
    /// 审计条数(与 `list` 同一套过滤条件,给分页用)。
    async fn count(&self, filter: Option<AuditFilter>) -> Result<u64>;
    /// 批次内的全部变更,按 `seq` 升序(`revert_batch`)。
    async fn changes(&self, batch_id: &str) -> Result<Vec<Change>>;
    /// 分页列出批次(新的在前)。
    async fn list_batches(&self, page: Page) -> Result<Vec<Batch>>;
    /// 批次总数(给 `batch_list` 的分页用)。
    async fn count_batches(&self) -> Result<u64>;
    /// 标记批次已撤销。
    async fn mark_reverted(&self, batch_id: &str, at: Millis) -> Result<()>;
}

/// `settings` / `sessions` / `api_tokens` 表(早期实现)。
#[async_trait]
pub trait AuthRepo: Send + Sync {
    /// 读一个设置项。
    async fn get_setting(&self, key: &str) -> Result<Option<String>>;
    /// 写一个设置项。
    async fn set_setting(&self, key: &str, value: &str) -> Result<()>;
    /// 新建会话。
    async fn create_session(&self, session: Session) -> Result<()>;
    /// 按令牌哈希取会话。
    async fn get_session(&self, token_hash: &str) -> Result<Option<Session>>;
    /// 滑动续期。
    async fn touch_session(
        &self,
        token_hash: &str,
        last_seen: Millis,
        expires_at: Millis,
    ) -> Result<()>;
    /// 删除会话(登出)。
    async fn delete_session(&self, token_hash: &str) -> Result<()>;
    /// 清理过期会话,返回删除条数。
    async fn delete_expired_sessions(&self, now: Millis) -> Result<u64>;
    /// 新建 API 令牌。
    async fn create_api_token(&self, token: ApiToken) -> Result<()>;
    /// 按令牌哈希取 API 令牌。
    async fn get_api_token(&self, token_hash: &str) -> Result<Option<ApiToken>>;
    /// 列出全部 API 令牌。
    async fn list_api_tokens(&self) -> Result<Vec<ApiToken>>;
    /// 撤销令牌。
    async fn revoke_api_token(&self, id: &str, at: Millis) -> Result<()>;
}

/// `feedback` 表(后续使用)。
#[async_trait]
pub trait FeedbackRepo: Send + Sync {
    /// 记录一条反馈,返回自增 id。
    async fn record(&self, feedback: Feedback) -> Result<i64>;
    /// 分页列出反馈。
    async fn list(&self, page: Page) -> Result<Vec<Feedback>>;
}

/// `events` 表(进化事件使用)。
#[async_trait]
pub trait EventRepo: Send + Sync {
    /// 追加事件。
    async fn append(&self, event: Event) -> Result<()>;
    /// 按 id 取。
    async fn get(&self, id: &str) -> Result<Option<Event>>;
    /// 取未处理事件。
    async fn list_unprocessed(&self, limit: u32) -> Result<Vec<Event>>;
    /// 最近的若干条事件(不分处理状态,新的在前;Dashboard 的「最近事件」用)。
    async fn recent(&self, limit: u32) -> Result<Vec<Event>>;
    /// 某种事件的最近若干条(会话事件的去重窗口用:别的种类不会把它挤掉)。
    async fn recent_by_kind(&self, kind: &str, limit: u32) -> Result<Vec<Event>>;
    /// 标记为已处理。
    async fn mark_processed(&self, id: &str, at: Millis, result: Option<&str>) -> Result<()>;
}

/// `drafts` 表(AI 使用)。
#[async_trait]
pub trait DraftRepo: Send + Sync {
    /// 新建草稿。
    async fn create(&self, draft: Draft) -> Result<()>;
    /// 按 id 取。
    async fn get(&self, id: &str) -> Result<Option<Draft>>;
    /// 分页列出草稿。
    async fn list(&self, state: Option<DraftState>, page: Page) -> Result<Vec<Draft>>;
    /// 分页列出**多个状态**的草稿(收件箱的「已通过」页签要同时看 approved 与 revised)。
    async fn list_states(&self, states: &[DraftState], page: Page) -> Result<Vec<Draft>>;
    /// 草稿条数(给 Dashboard 的「待审草稿」用)。
    async fn count(&self, state: Option<DraftState>) -> Result<u64>;
    /// 多个状态的草稿条数。
    async fn count_states(&self, states: &[DraftState]) -> Result<u64>;
    /// 抢占一条草稿(收件箱的乐观锁):只有“还没被抢过(或抢占已过期)、也还没转正”的草稿能抢到。
    ///
    /// `at` 是当前时间,`ttl` 是抢占的有效期:超过 `ttl` 的抢占视为失效(请求被取消 / 进程被杀
    /// 之后不用手工改库)。返回 `true` 表示抢到了;调用方失败时要 [`Self::release_claim`] 放回去。
    async fn claim(
        &self,
        id: &str,
        at: crate::model::Millis,
        ttl: crate::model::Millis,
    ) -> Result<bool>;
    /// 释放抢占标记(转正失败时用)。
    ///
    /// `at` 必须是 [`Self::claim`] 时用的那个时间戳:只有自己抢到的那一次才会被释放,
    /// 慢请求不会把别人接管的抢占清掉。
    async fn release_claim(&self, id: &str, at: crate::model::Millis) -> Result<()>;
    /// 清掉所有过期的抢占标记(守护进程启动时调一次),返回清掉的行数。
    async fn clear_stale_claims(
        &self,
        now: crate::model::Millis,
        ttl: crate::model::Millis,
    ) -> Result<u64>;
    /// 更新草稿(审核结果、状态)。
    async fn update(&self, draft: Draft) -> Result<()>;
}

/// `agent_messages` 表:AI 管家会话记录。
#[async_trait]
pub trait AgentRepo: Send + Sync {
    /// 追加一条消息(序号由仓储分配)。
    async fn append(&self, message: crate::model::AgentMessage) -> Result<i64>;
    /// 某个会话的全部消息(按序号升序)。
    async fn list(&self, session_id: &str, limit: u32) -> Result<Vec<crate::model::AgentMessage>>;
    /// 最近的会话(置顶在前,其余按最后一条消息倒序)。
    async fn sessions(
        &self,
        limit: u32,
        project: Option<&str>,
    ) -> Result<Vec<crate::model::AgentSessionSummary>>;
    /// 会话被使用:补一行元数据并刷新 `updated_at`(project 非空时一并写入)。
    async fn touch_session(
        &self,
        session_id: &str,
        project: Option<&str>,
        at: crate::model::Millis,
    ) -> Result<()>;
    /// 改会话标题;会话不存在返回 `false`。
    async fn rename_session(
        &self,
        session_id: &str,
        title: &str,
        at: crate::model::Millis,
    ) -> Result<bool>;
    /// 置顶 / 取消置顶;会话不存在返回 `false`。
    async fn pin_session(
        &self,
        session_id: &str,
        pinned: bool,
        at: crate::model::Millis,
    ) -> Result<bool>;
    /// 删掉一个会话的全部消息,返回删除的条数。
    async fn delete_session(&self, session_id: &str) -> Result<usize>;
    /// 读会话元数据(ACP 映射 / 摘要);没有行时返回默认值。
    async fn session_meta(&self, session_id: &str) -> Result<crate::model::AgentSessionMeta>;
    /// 写 ACP 映射(backend / agent / session)。
    async fn set_acp_session(
        &self,
        session_id: &str,
        agent: &str,
        acp_session: &str,
        at: crate::model::Millis,
    ) -> Result<()>;
    /// 记下这次会话的代理有没有沙箱。
    async fn set_sandboxed(
        &self,
        session_id: &str,
        sandboxed: bool,
        at: crate::model::Millis,
    ) -> Result<()>;
    /// 写上下文摘要与覆盖到的序号。
    async fn set_summary(
        &self,
        session_id: &str,
        summary: &str,
        upto: i64,
        at: crate::model::Millis,
    ) -> Result<()>;
}

/// `chunk_context` 表:LLM 生成的块上下文缓存(按 content_hash)。
#[async_trait]
pub trait ContextRepo: Send + Sync {
    /// 取缓存。
    async fn get_context(&self, content_hash: &str) -> Result<Option<String>>;
    /// 写缓存(已存在则覆盖)。
    async fn put_context(
        &self,
        content_hash: &str,
        context: &str,
        model: &str,
        at: crate::model::Millis,
    ) -> Result<()>;
}

/// `evolution_exclusions` 表:“不再提炼”的指纹与向量。
#[async_trait]
pub trait EvolutionRepo: Send + Sync {
    /// 记一条排除(只存指纹、向量、原因)。
    async fn exclude(
        &self,
        collection: &str,
        fingerprint: &str,
        embedding: Option<Vec<f32>>,
        embedder_id: Option<&str>,
        reason: &str,
        at: crate::model::Millis,
    ) -> Result<()>;
    /// 指纹是否已被排除。
    async fn is_excluded(&self, collection: &str, fingerprint: &str) -> Result<bool>;
    /// 某个 collection 里最近的排除向量(只返回 embedder_id 相同的)。
    async fn excluded_vectors(
        &self,
        collection: &str,
        embedder_id: &str,
        limit: u32,
    ) -> Result<Vec<(String, Vec<f32>)>>;
    /// 指纹是否已存在于草稿表(任意状态)。
    async fn draft_exists(&self, collection: &str, fingerprint: &str) -> Result<bool>;
    /// 某个 collection 里指定状态的草稿向量(最多 `limit` 条)。
    async fn draft_vectors(
        &self,
        collection: &str,
        embedder_id: &str,
        states: &[crate::model::DraftState],
        limit: u32,
    ) -> Result<Vec<(String, Vec<f32>)>>;
}

/// `llm_usage` / `llm_sends` 表(AI 使用)。
#[async_trait]
pub trait LlmUsageRepo: Send + Sync {
    /// 累加某天的用量。
    async fn add_usage(&self, usage: LlmUsage) -> Result<()>;
    /// 取某天的用量。
    async fn usage_of_day(&self, day: &str) -> Result<Vec<LlmUsage>>;
    /// 记录一次外发,返回自增 id。
    async fn record_send(&self, send: LlmSend) -> Result<i64>;
    /// 从 `at`(unix 毫秒)起外发了几次(`[llm] max_calls_per_hour` 用)。
    async fn count_sends_since(&self, at: Millis) -> Result<u64>;
}

/// `sources` 表。
#[async_trait]
pub trait SourceRepo: Send + Sync {
    /// 新建数据源(名字唯一,冲突返回 [`crate::KbError::InvalidInput`])。
    async fn create(&self, source: Source) -> Result<()>;
    /// 按 id 取。
    async fn get(&self, id: &str) -> Result<Option<Source>>;
    /// 按名字取。
    async fn get_by_name(&self, name: &str) -> Result<Option<Source>>;
    /// 列出全部数据源(新的在前)。
    async fn list(&self) -> Result<Vec<Source>>;
    /// 更新(整行覆盖)。
    async fn update(&self, source: Source) -> Result<()>;
    /// 删除。
    async fn delete(&self, id: &str) -> Result<()>;
    /// 只改状态 / 错误 / 上次同步时间(同步前后用,避免整行覆盖掉并发修改)。
    async fn set_status(
        &self,
        id: &str,
        status: &str,
        error: Option<&str>,
        synced_at: Option<Millis>,
    ) -> Result<()>;
    /// 回写已入库文件数(同步结束后统计)。
    async fn set_file_count(&self, id: &str, files: u64) -> Result<()>;
    /// 只写 AI 规范化的整理情况。
    ///
    /// 数据源已被删掉时什么都不做。
    async fn set_ai_status(
        &self,
        id: &str,
        status: Option<crate::model::SourceAiStatus>,
    ) -> Result<()>;
}

/// `uploads` / `upload_parts` 表(分片续传)。
#[async_trait]
pub trait UploadRepo: Send + Sync {
    /// 新建上传。
    async fn create(&self, upload: Upload) -> Result<()>;
    /// 按 id 取。
    async fn get(&self, id: &str) -> Result<Option<Upload>>;
    /// 整行更新。
    async fn update(&self, upload: Upload) -> Result<()>;
    /// 删除上传(分片记录一起删)。
    async fn delete(&self, id: &str) -> Result<()>;
    /// 未完成的上传(24 小时清理用)。
    async fn list_pending(&self) -> Result<Vec<Upload>>;
    /// 记录一个分片(重复上传同一片时覆盖,幂等)。
    async fn put_part(&self, part: UploadPart) -> Result<()>;
    /// 已收到的分片(按序号升序)。
    async fn parts(&self, upload_id: &str) -> Result<Vec<UploadPart>>;
    /// 某个分片。
    async fn part(&self, upload_id: &str, part_no: u32) -> Result<Option<UploadPart>>;
    /// 删掉全部分片记录(合并完成 / 取消后)。
    async fn delete_parts(&self, upload_id: &str) -> Result<()>;
}

/// 批注。
#[async_trait]
pub trait AnnotationRepo: Send + Sync {
    /// 新建。
    async fn create(&self, annotation: crate::model::Annotation) -> Result<()>;
    /// 某个文件的批注(新 → 旧)。
    async fn list_by_source(
        &self,
        collection: &str,
        source: &str,
        limit: u32,
    ) -> Result<Vec<crate::model::Annotation>>;
    /// 按 id 取。
    async fn get(&self, id: &str) -> Result<Option<crate::model::Annotation>>;
    /// 删除。
    async fn delete(&self, id: &str) -> Result<()>;
    /// 一条评论底下的回复(旧 → 新)。
    async fn list_replies(&self, parent_id: &str) -> Result<Vec<crate::model::Annotation>>;
    /// 标记 / 取消已解决。`resolved_at` 为 `None` 表示取消。评论不存在返回 `NotFound`。
    async fn set_resolved(
        &self,
        id: &str,
        resolved_at: Option<crate::model::Millis>,
        resolved_by: Option<&str>,
    ) -> Result<()>;
    /// 作者以 `prefix` 开头的批注(最多 `limit` 条)。「清除某个访客的所有评论」用。
    async fn list_by_author_prefix(
        &self,
        prefix: &str,
        limit: u32,
    ) -> Result<Vec<crate::model::Annotation>>;
    /// 文件 / 文件夹被移动:把挂在旧路径(及后代路径)上的批注改到新路径。
    async fn rekey_source_prefix(&self, collection: &str, from: &str, to: &str) -> Result<u64>;
    /// 跨 collection 移动文件 / 文件夹:批注随文件换库,路径按段前缀替换。
    ///
    /// 与同库移动分开,是因为批注的检索行还要在目标库里重建、旧的删掉,
    /// 只改 SQLite 会让两边都留下半份数据。
    async fn move_across_collections(
        &self,
        from_collection: &str,
        from: &str,
        to_collection: &str,
        to: &str,
    ) -> Result<u64>;
}

/// 条目版本历史。
#[async_trait]
pub trait VersionRepo: Send + Sync {
    /// 写一条新版本(版本号由调用方按 `next_version` 算好)。
    async fn create(&self, version: crate::model::ItemVersion) -> Result<()>;
    /// 某个条目的版本列表(新 → 旧)。
    async fn list(&self, item_id: &str, limit: u32) -> Result<Vec<crate::model::ItemVersion>>;
    /// 某个文件(collection + source)的版本列表(新 → 旧)。
    async fn list_by_source(
        &self,
        collection: &str,
        source: &str,
        limit: u32,
    ) -> Result<Vec<crate::model::ItemVersion>>;
    /// 按 id 取一版。
    async fn get(&self, id: &str) -> Result<Option<crate::model::ItemVersion>>;
    /// 当前最新版本号(没有版本时为 0)。
    async fn latest_version(&self, item_id: &str) -> Result<i64>;
    /// 删掉这几条版本记录(旧版本超出保留份数时清理),返回删了几条。
    async fn delete_many(&self, ids: &[String]) -> Result<u64>;
    /// 改一条版本记录的正文和作者(多人协同的一次会话合并成一个版本:每次落地更新它,而不是每次新增一条)。
    async fn amend(
        &self,
        id: &str,
        body: &str,
        author: &str,
        at: crate::model::Millis,
    ) -> Result<()>;
    /// 有多少条版本记录的正文包含 `needle`(二进制备份的引用被几个版本用着:没人用了才能删备份文件)。
    async fn count_body_containing(&self, needle: &str) -> Result<u64>;
    /// 文件 / 文件夹被移动:把这个路径(及后代路径)的版本改到新路径。
    /// `item_id` 与 `source` 一起改,否则版本历史按旧 id 查会变成空。
    async fn rekey_source_prefix(&self, collection: &str, from: &str, to: &str) -> Result<u64>;
    /// 跨 collection 移动:版本记录的 collection、source 与 item_id 一起换库。
    async fn move_across_collections(
        &self,
        from_collection: &str,
        from: &str,
        to_collection: &str,
        to: &str,
    ) -> Result<u64>;
}

/// `ingest_files` 表(解析队列)。
#[async_trait]
pub trait IngestRepo: Send + Sync {
    /// 新建(同一 collection 下 `rel_path` 唯一,冲突返回 [`crate::KbError::InvalidInput`])。
    async fn create(&self, file: IngestFile) -> Result<()>;
    /// 按 id 取。
    async fn get(&self, id: &str) -> Result<Option<IngestFile>>;
    /// 按 `(collection, rel_path)` 取。
    async fn get_by_path(&self, collection: &str, rel_path: &str) -> Result<Option<IngestFile>>;
    /// 按条件列出(新的在前)。
    async fn list(&self, filter: IngestFilter, page: Page) -> Result<Vec<IngestFile>>;
    /// 与 `list` 同一套条件的条数。
    async fn count(&self, filter: IngestFilter) -> Result<u64>;
    /// 取下一个待处理的文件(可按批次限定;`created_at` 升序,先进先出)。
    async fn next_queued(&self, batch_id: Option<&str>) -> Result<Option<IngestFile>>;
    /// 卡在“处理中”(`extracting` / `chunking` / `embedding`)的文件。
    ///
    /// 进程被强杀时正在解析的文件会停在这几个状态:它们既不在队列里(不会重跑),
    /// 也不算完成(进度永远差几个)。启动时靠这张清单把它们拨回 `queued`。
    async fn list_inflight(&self) -> Result<Vec<IngestFile>>;
    /// 批次里“有父条目且已入库”的行(`rel_path`, `derived_from`),用来补齐派生边。
    ///
    /// 解析任务收尾时按这张清单把缺失的 `derived_from` 边补上(幂等):
    /// 进程在“写完状态、还没写边”之间被杀掉时,重启后靠它补回来。
    async fn derived_done(&self, batch_id: &str) -> Result<Vec<(String, String)>>;
    /// 换批次(数据源重新同步时,变化的文件要并进新批次才会被新任务处理)。
    async fn set_batch(&self, id: &str, batch_id: Option<&str>) -> Result<()>;
    /// 只改状态(阶段推进)。
    async fn set_state(&self, id: &str, state: IngestState, error: Option<&str>) -> Result<()>;
    /// 写入抽取元信息(页数 / 表数 / 幻灯片 / 时长;JSON 文本)。
    async fn set_extract_meta(&self, id: &str, meta: Option<&str>) -> Result<()>;
    /// 按数据源汇总解析队列(总数 / 今日新增 / 失败 / 隔离 / 待处理)。
    async fn stats_by_source(&self, since: Millis) -> Result<Vec<SourceIngestStats>>;
    /// 结束一个文件:状态 + 块数 / 向量数 / 耗时。
    async fn finish(
        &self,
        id: &str,
        state: IngestState,
        chunks: u64,
        vectors: u64,
        elapsed_ms: u64,
        error: Option<&str>,
    ) -> Result<()>;
    /// 找同 collection 里内容相同且已完成的文件(秒传判定)。
    async fn find_done_by_sha(&self, collection: &str, sha256: &str) -> Result<Option<IngestFile>>;
    /// 删除一条。
    async fn delete(&self, id: &str) -> Result<()>;
    /// 文件 / 文件夹被移动:把解析队列里的路径(及后代路径)改到新路径。
    async fn repath_prefix(&self, collection: &str, from: &str, to: &str) -> Result<u64>;
    /// 跨 collection 移动:解析队列换库、换 source、换物理路径,并脱离原上传批次。
    ///
    /// 必须清空 `batch_id` / `upload_id`:原批次的回滚只能影响它自己的 collection,
    /// 留着旧批次会把已经属于目标库的文件重新删掉。
    // 跨库迁移本来就要同时交代源/目标/新数据源/时间,拆结构体会让 trait 与 SQL 都更难读。
    #[allow(clippy::too_many_arguments)]
    async fn move_across_collections(
        &self,
        from_collection: &str,
        from: &str,
        to_collection: &str,
        to: &str,
        source_id: &str,
        source_root: &str,
        at: Millis,
    ) -> Result<u64>;
}

/// `ingest_stage_events` / `ingest_batches` 表(流水线进度)。
#[async_trait]
pub trait IngestProgressRepo: Send + Sync {
    /// 开始一个阶段,返回事件 id。
    async fn begin_stage(
        &self,
        file_id: &str,
        batch_id: Option<&str>,
        stage: IngestStage,
        at: Millis,
    ) -> Result<i64>;
    /// 结束一个阶段(写状态、耗时之外的产出与原因)。
    async fn end_stage(
        &self,
        id: i64,
        status: IngestStageStatus,
        error: Option<&str>,
        chunks: u64,
        vectors: u64,
        at: Millis,
    ) -> Result<()>;
    /// 某个文件的全部阶段(按开始时间升序)。
    async fn stages_of_file(&self, file_id: &str) -> Result<Vec<IngestStageEvent>>;
    /// 某个批次的全部阶段(按开始时间升序)。
    async fn stages_of_batch(&self, batch_id: &str) -> Result<Vec<IngestStageEvent>>;
    /// 某批次在 `since` 之后结束的“可检索”阶段的块数与文件数(ETA 的吞吐口径)。
    async fn completed_since(&self, batch_id: &str, since: Millis) -> Result<(u64, u64)>;
    /// 确保批次行存在(幂等)。
    async fn ensure_ingest_batch(&self, batch_id: &str, collection: &str, at: Millis)
    -> Result<()>;
    /// 取批次状态。
    async fn ingest_batch(&self, batch_id: &str) -> Result<Option<IngestBatch>>;
    /// 删掉某个文件从 `stage` 起的阶段事件(`retry_file_stage` 重新计时的用)。
    async fn reset_stages_from(&self, file_id: &str, stage: IngestStage) -> Result<u64>;
    /// 改批次状态。
    async fn set_ingest_batch_state(
        &self,
        batch_id: &str,
        state: IngestBatchState,
        at: Millis,
    ) -> Result<()>;
    /// 收尾:批次仍是 `running` 才改成 `done`,返回有没有真写进去。
    ///
    /// 收尾和取消 / 暂停是并发的,用「先查状态再写」会留下 TOCTOU 窗口:用户刚点取消,
    /// 另一边正好写完最后一个文件,批次又被改回 `done`,界面显示成功而用户以为已经取消
    /// (批量导入时点取消就会撞上)。所以收尾必须是条件更新,且**取消优先**。
    async fn finish_ingest_batch_if_running(&self, batch_id: &str, at: Millis) -> Result<bool>;
}

/// 元数据存储的组合 trait。
///
/// 说明(见架构设计说明):代码行只列了 9 个 Repo,
/// 但服务层只拿到 `Arc<dyn MetaStore>`(`kb-testkit::TestEnv` 就是这么注入的),
/// 因此这里把 `feedback` / `events` / `drafts` / `llm_usage` 四组 trait 也一并组合进来。
/// 又加了 `source` / `upload` / `ingest` 三组(见下文)。
pub trait MetaStore:
    ProjectRepo
    + CollectionRepo
    + FileRepo
    + FileOpsRepo
    + ChunkRepo
    + DocLinkRepo
    + InsightRepo
    + EdgeRepo
    + JobRepo
    + AuditRepo
    + AuthRepo
    + FeedbackRepo
    + EventRepo
    + DraftRepo
    + LlmUsageRepo
    + SourceRepo
    + UploadRepo
    + IngestRepo
    + IngestProgressRepo
    + VersionRepo
    + AnnotationRepo
    + EvolutionRepo
    + ContextRepo
    + AgentRepo
    + ActivityRepo
{
}

impl<T> MetaStore for T where
    T: ProjectRepo
        + CollectionRepo
        + FileRepo
        + FileOpsRepo
        + ChunkRepo
        + DocLinkRepo
        + InsightRepo
        + EdgeRepo
        + JobRepo
        + AuditRepo
        + AuthRepo
        + FeedbackRepo
        + EventRepo
        + DraftRepo
        + LlmUsageRepo
        + SourceRepo
        + UploadRepo
        + IngestRepo
        + IngestProgressRepo
        + VersionRepo
        + AnnotationRepo
        + EvolutionRepo
        + ContextRepo
        + AgentRepo
        + ActivityRepo
{
}
