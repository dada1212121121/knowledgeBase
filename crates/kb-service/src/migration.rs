//! 换模型迁移（设计规范）。
//!
//! 流程:估算 → 建新表 → 按 chunks 表 id 顺序分批重嵌入并写检查点 →
//! 追平迁移期间的写入 → 条数校验 → 切 `active_table` → 旧表进退役列表 →
//! 把新表里重算过的 `embed_input_hash` 写回 SQLite `chunks`。
//!
//! 检索始终读 `active_table`,迁移失败不影响现有查询。

use std::sync::Arc;

use kb_core::hash::embed_input_hash;
use kb_core::model::{Collection, Millis, Page};
use kb_core::ports::repo::{ChunkRepo, CollectionRepo, InsightRepo, MetaStore};
use kb_core::ports::{Embedder, VectorStore};
use kb_core::{KbError, Result};

/// 每批处理的条数（设计规范）。
pub const BATCH: u32 = 256;

/// `retired_tables` 最多保留多少张(③:列表不该无限增长;物理表由夜间维护删除)。
pub const MAX_RETIRED_TABLES: usize = 5;

/// 迁移估算(dry_run)。
#[derive(Clone, Debug, PartialEq)]
pub struct MigrationPlan {
    /// collection。
    pub collection: String,
    /// 当前表。
    pub from_table: String,
    /// 目标表。
    pub to_table: String,
    /// 需要重嵌入的总行数(`chunks` + `insights`)。
    pub rows: u64,
    /// 其中 insight 行数。
    pub insight_rows: u64,
    /// 估算耗时(秒)。
    pub estimated_seconds: u64,
    /// 兼容组相同 → 可以免迁移(需 `kb eval` 确认 hit@5 下降 ≤ 0.02)。
    pub can_switch_without_reembed: bool,
    /// 旧 embedder id → 新 embedder id。
    pub from_embedder: String,
    /// 新 embedder id。
    pub to_embedder: String,
}

/// 迁移结果。
#[derive(Clone, Debug, PartialEq)]
pub struct MigrationReport {
    /// 已迁移(含追平)的块数。
    pub migrated: u64,
    /// 是否从检查点续跑。
    pub resumed: bool,
    /// 新表。
    pub to_table: String,
    /// 旧表(已进退役列表)。
    pub retired_table: String,
    /// 两表条数(校验通过才会切换)。
    pub rows: u64,
    /// 切换之后才发现的非致命问题(对账 / 补齐失败)。
    ///
    /// 这些步骤失败时迁移**已经生效**,不能回滚,但也不能只留一行日志:
    /// 调用方要能看到“新表可能少了 N 行”。
    pub warnings: Vec<String>,
}

/// 迁移分片的阶段。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MigrationPhase {
    /// 主遍历:按 `chunks` id 顺序复制。
    Copy,
    /// 复制 insight 行。
    Insights,
    /// 收尾(写锁内切换)。
    Finalize,
}

/// 一次迁移的分片状态。
///
/// 同步的 [`MigrationService::run`] 把它放在栈上;入队版本放在
/// `MigrateJobHandler` 的内存表里 —— 进程重启后状态丢失,按“续跑”处理
/// (重建目标表从头复制）,`jobs.checkpoint_json` 只用来判断是不是续跑。
#[derive(Clone, Debug)]
pub struct MigrationState {
    /// collection 名。
    pub collection: String,
    /// 迁移前的 active 表(追平与对账的源)。
    pub from_table: String,
    /// 目标表。
    pub to_table: String,
    /// 迁移开始时间(追平的水位线)。
    pub started_at: Millis,
    /// 是否续跑(续跑会先重建目标表)。
    pub resumed: bool,
    /// 主遍历游标(上一批的最后一个 chunk id)。
    pub after: Option<String>,
    /// 已写进新表的 id(对账用)。
    pub written: std::collections::BTreeSet<String>,
    /// 已复制的块数(进度)。
    pub chunks_done: u64,
    /// 迁移开始时的块数(进度分母的一部分)。
    pub chunk_total: u64,
    /// 迁移开始时的 insight 行数(进度分母的另一部分)。
    pub insight_total: u64,
    /// insight 行是否已复制。
    pub insights_done: bool,
    /// 当前阶段。
    pub phase: MigrationPhase,
}

impl MigrationState {
    /// 已完成的工作量(块数 + 已复制的 insight 行数)。
    pub fn done(&self) -> u64 {
        let insights = if self.insights_done {
            self.insight_total
        } else {
            0
        };
        self.chunks_done + insights
    }

    /// 总工作量(进度分母)。
    pub fn total(&self) -> u64 {
        self.chunk_total + self.insight_total
    }
}

/// 迁移服务。
pub struct MigrationService {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    embedder: Arc<dyn Embedder>,
    /// 与索引服务共享的写闸门。
    gate: crate::write_gate::WriteGate,
}

impl MigrationService {
    /// 构造;`embedder` 是**新**嵌入器。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        embedder: Arc<dyn Embedder>,
    ) -> Self {
        Self {
            meta,
            store,
            embedder,
            gate: crate::write_gate::WriteGate::new(),
        }
    }

    /// 换用与索引服务共享的写闸门(组装根注入同一个实例)。
    pub fn with_write_gate(mut self, gate: crate::write_gate::WriteGate) -> Self {
        self.gate = gate;
        self
    }

    /// dry_run:估算行数与耗时。
    pub async fn plan(&self, collection: &str, to_embedder: &str) -> Result<MigrationPlan> {
        self.ensure_target(to_embedder)?;
        let current = self.collection(collection).await?;
        let chunk_rows = ChunkRepo::count(self.meta.as_ref(), collection).await?;
        let insight_rows = self.insight_rows(collection).await?;
        let rows = chunk_rows + insight_rows;
        // 实测速度:嵌入 4 条短文本,换算成 块/秒
        let started = std::time::Instant::now();
        let sample = vec!["迁移速度探针".to_owned(); 4];
        let _ = self.embedder.embed_documents(sample).await?;
        let elapsed = started.elapsed().as_secs_f64().max(0.001);
        let per_second = 4.0 / elapsed;
        let estimated_seconds = (rows as f64 / per_second).ceil() as u64;
        Ok(MigrationPlan {
            collection: collection.to_owned(),
            from_table: current.active_table.clone(),
            to_table: next_table(&current, self.embedder.id()),
            rows,
            insight_rows,
            estimated_seconds,
            can_switch_without_reembed: normalize_group(self.embedder.compat_group())
                == normalize_group(&current.embedder_id),
            from_embedder: current.embedder_id.clone(),
            to_embedder: to_embedder.to_owned(),
        })
    }

    /// 执行迁移(同步一次跑完;CLI 与测试用)。
    ///
    /// 入队版本由 [`crate::jobs::MigrateJobHandler`] 按
    /// [`Self::begin`] / [`Self::copy_slice`] / [`Self::copy_insights_slice`] / [`Self::finalize`]
    /// 分片驱动,两者共用同一套步骤。
    pub async fn run(
        &self,
        collection: &str,
        to_embedder: &str,
        checkpoint: Option<String>,
    ) -> Result<MigrationReport> {
        let resuming =
            checkpoint.is_some() || self.collection(collection).await?.migrating_to.is_some();
        let mut state = self.begin(collection, to_embedder, resuming).await?;
        while self.copy_slice(&mut state).await? {}
        self.copy_insights_slice(&mut state).await?;
        self.finalize(&state).await
    }

    /// 准备迁移:判定续跑、建目标表、记下 `migrating_to`,返回分片状态。
    pub async fn begin(
        &self,
        collection: &str,
        to_embedder: &str,
        resuming: bool,
    ) -> Result<MigrationState> {
        self.ensure_target(to_embedder)?;
        let mut current = self.collection(collection).await?;
        let to_table = current
            .migrating_to
            .clone()
            .unwrap_or_else(|| next_table(&current, self.embedder.id()));
        let started_at = current.migration_started_at.unwrap_or_else(now_millis);
        let chunk_total = ChunkRepo::count(self.meta.as_ref(), collection).await?;
        let insight_total = self.insight_rows(collection).await?;

        // 记下迁移状态(中断后能续跑)
        if current.migrating_to.as_deref() != Some(&to_table) {
            current.migrating_to = Some(to_table.clone());
            current.migration_started_at = Some(started_at);
            CollectionRepo::update(self.meta.as_ref(), current.clone()).await?;
        }
        // 续跑:上一轮可能留下孤儿行(上次进程写过、后来块被删),`VectorStore` 没有枚举 id 的 API,
        // 因此续跑时重建目标表,保证新表只含本次写入的行。
        if resuming {
            // 只忽略“表不存在”(第一次迁移时目标表还没建),其他错误向上传(残)
            match self.store.drop_table(&to_table).await {
                Ok(()) | Err(KbError::NotFound(_)) => {}
                Err(err) => return Err(err),
            }
        }
        self.store
            .ensure_table(&to_table, self.embedder.dim())
            .await?;
        Ok(MigrationState {
            collection: collection.to_owned(),
            from_table: current.active_table.clone(),
            to_table,
            started_at,
            resumed: resuming,
            after: None,
            written: std::collections::BTreeSet::new(),
            chunks_done: 0,
            chunk_total,
            insight_total,
            insights_done: false,
            phase: MigrationPhase::Copy,
        })
    }

    /// 复制一片块(主遍历);返回是否还有更多。
    pub async fn copy_slice(&self, state: &mut MigrationState) -> Result<bool> {
        let batch = ChunkRepo::ids_after(
            self.meta.as_ref(),
            &state.collection,
            state.after.as_deref(),
            BATCH,
        )
        .await?;
        if batch.is_empty() {
            state.phase = MigrationPhase::Insights;
            return Ok(false);
        }
        let ids: Vec<String> = batch.iter().map(|chunk| chunk.id.clone()).collect();
        let copied = self
            .copy_rows(&state.from_table, &state.to_table, &ids)
            .await?;
        state.chunks_done += copied;
        state.written.extend(ids.iter().cloned());
        state.after = ids.last().cloned();
        Ok(true)
    }

    /// 复制 insight 行(一次做完;条数少,不再分片)。
    ///
    /// 这里复制是为了让进度与行数估算对得上;**收尾时会在写锁内再复制一次**,
    /// 因为两次之间可能有人编辑了 insight。
    pub async fn copy_insights_slice(&self, state: &mut MigrationState) -> Result<()> {
        self.copy_insights(&state.collection, &state.to_table, &mut state.written)
            .await?;
        state.insights_done = true;
        state.phase = MigrationPhase::Finalize;
        Ok(())
    }

    /// 收尾:写锁内追平 → 对账 → 条数校验 → 建索引 → 切换 → 切换后对账 / 补齐。
    pub async fn finalize(&self, state: &MigrationState) -> Result<MigrationReport> {
        let collection = &state.collection;
        let to_table = state.to_table.clone();
        let lock_wait_started = std::time::Instant::now();
        let _switch = self.gate.migration().await;
        let lock_wait = lock_wait_started.elapsed();
        let switch_started = std::time::Instant::now();
        let mut written = state.written.clone();
        let mut migrated = state.chunks_done;

        // / (b):insight 行不是 `chunks` 派生出来的,必须单独搬。
        // 写锁内再复制一次:此时 insight 的写入(也持读锁)已经不可能插进来。
        migrated += self
            .copy_insights(collection, &to_table, &mut written)
            .await?;

        // 追平 + 对账:最多 3 轮,直到两表条数一致(设计规范第 5~6 步）
        let mut old_rows;
        let mut new_rows;
        let mut attempt = 0u32;
        loop {
            migrated += self
                .catch_up(
                    collection,
                    &state.from_table,
                    &to_table,
                    state.started_at,
                    &mut written,
                )
                .await?;
            // 迁移期间被删除/替换的块:新表里已不在 chunks 中,要删掉,否则条数永远对不上
            self.reconcile(collection, &to_table, &mut written).await?;
            // 一致性以 **SQLite** 为准:旧表在切换窗口里可能继续收到写入,
            // 拿它当基准会让结果依赖时序。基准 = `chunks`(代码 / 文档块)+ `insights`(经验条目,
            // :以前漏搬 insight,基准只有 chunks,新表里也就没有它们)。
            let expected = ChunkRepo::count(self.meta.as_ref(), collection).await?
                + self.insight_rows(collection).await?;
            old_rows = self.store.count(&state.from_table, None).await?;
            new_rows = self.store.count(&to_table, None).await?;
            if new_rows == expected {
                break;
            }
            attempt += 1;
            if attempt == 3 {
                return Err(KbError::Internal(format!(
                    concat!(
                        "迁移条数不一致:新表 {} 行,SQLite {} 行",
                        "(旧表 {} 行;保留检查点,可续跑)"
                    ),
                    new_rows, expected, old_rows
                )));
            }
        }

        // 建索引
        self.store.ensure_fts_index(&to_table).await?;
        self.store.ensure_vector_index(&to_table).await?;

        // 切换
        let mut current = self.collection(collection).await?;
        let retired_now = vec![current.active_table.clone()];
        current.retired_tables.push(current.active_table.clone());
        // 列表只保留最近几张(③):物理表由夜间维护删除,列表本身不该无限增长
        if current.retired_tables.len() > MAX_RETIRED_TABLES {
            let excess = current.retired_tables.len() - MAX_RETIRED_TABLES;
            current.retired_tables.drain(0..excess);
        }
        current.active_table = to_table.clone();
        current.embedder_id = self.embedder.id().to_owned();
        current.dim = self.embedder.dim();
        current.migrating_to = None;
        current.migration_started_at = None;
        CollectionRepo::update(self.meta.as_ref(), current.clone()).await?;

        // 切换后对账:① 删掉新表里已不在 SQLite 的行;② 补上窗口内写进旧表、
        // 因而没被复制过来的行,保证“active 表行数 == SQLite 行数”。
        // 只从**本次刚退役**的那张表补,历史退役表可能已被夜间清理删掉。
        // 切换已经生效:这两步失败只告警,不要让调用方以为迁移没做
        let mut warnings = Vec::new();
        if let Err(err) = self.reconcile(collection, &to_table, &mut written).await {
            tracing::warn!(error = %err, "切换后对账失败(迁移已生效)");
            warnings.push(format!("切换后对账失败(迁移已生效): {err}"));
        }
        if let Err(err) = self.fill_missing(collection, &retired_now, &to_table).await {
            tracing::warn!(error = %err, "切换后补齐缺失行失败(迁移已生效)");
            warnings.push(format!("切换后补齐缺失行失败(迁移已生效): {err}"));
        }
        // `copy_rows` 会把 pending 行也按新嵌入器重算成 ready;切换后队列里的这些 id
        // 已经无效,不清掉的话每次检索都会多跑一次 pending 补充查询(结果为空但不降级)。
        // 必须在切换之后清:迁移中途失败时旧表的 pending 行还要靠队列继续补向量。
        if let Err(err) = ChunkRepo::clear_all_pending(self.meta.as_ref(), collection).await {
            tracing::warn!(error = %err, "切换后清理待补向量队列失败(迁移已生效)");
            warnings.push(format!("切换后清理待补向量队列失败(迁移已生效): {err}"));
        }
        // 把新表里块的 embed_input_hash 写回 SQLite `chunks`:索引 diff 比的是 SQLite 里的值,
        // 它必须和新表(已按新嵌入器 id 重算)一致。放在切换之后、补齐之后、仍持写闸门期间:
        // 这样 fill_missing 补进来的行也覆盖到,而且没有索引写入能插进来。
        // 写失败只告警:迁移已生效,后果是这些块在下次扫描时重嵌入一次(再迁一次到同一嵌入器可修复)。
        if let Err(err) = self.sync_chunk_hashes(collection, &to_table).await {
            tracing::warn!(error = %err, "切换后同步 chunks.embed_input_hash 失败(迁移已生效)");
            warnings.push(format!(
                "切换后同步 chunks.embed_input_hash 失败(迁移已生效,下次扫描会重嵌入受影响的块): {err}"
            ));
        }
        // 切换已经生效:这里再失败也不能让调用方以为迁移没做,告警并回退到切换前的校验值
        let final_rows = match self.store.count(&to_table, None).await {
            Ok(rows) => rows,
            Err(err) => {
                tracing::warn!(error = %err, "切换后统计新表行数失败(迁移已生效)");
                new_rows
            }
        };

        // 写锁覆盖整段收尾:把等待与持锁耗时记下来,便于观察“短暂暂停写任务”到底多长
        tracing::info!(
            collection = %collection,
            waited_ms = lock_wait.as_millis() as u64,
            held_ms = switch_started.elapsed().as_millis() as u64,
            "迁移收尾完成(此期间该进程内的索引写入被暂停)"
        );

        Ok(MigrationReport {
            migrated,
            resumed: state.resumed,
            to_table,
            retired_table: current.retired_tables.last().cloned().unwrap_or_default(),
            rows: final_rows,
            warnings,
        })
    }

    /// 把新表里块的 `embed_input_hash` 写回 SQLite `chunks`,返回改了多少行。
    ///
    /// 以新表(已由 [`Self::copy_rows`] 按新嵌入器重算)为准,逐批读出与 SQLite 不同的值再批量写回,
    /// 每批一个事务,**只改这一列**(`updated_at` 是追平的水位线,见 `ChunkRepo::set_embed_input_hashes`)。
    ///
    /// 遍历的是 SQLite 里现存的块而不是 `written`:`fill_missing` 补进新表的行不在 `written` 里,
    /// 漏掉它们就会留下一批哈希不对的块。insight 行在 `chunks` 里没有记录,天然不会被碰到。
    /// 新表里没有的块(理论上已被 `fill_missing` 补齐)跳过,不动它的哈希。
    /// 哈希已经一致的块不写,所以同一嵌入器重迁、或重复调用都是幂等的。
    async fn sync_chunk_hashes(&self, collection: &str, to: &str) -> Result<u64> {
        let mut changed = 0u64;
        let mut after: Option<String> = None;
        loop {
            let batch =
                ChunkRepo::ids_after(self.meta.as_ref(), collection, after.as_deref(), BATCH)
                    .await?;
            if batch.is_empty() {
                break;
            }
            let ids: Vec<String> = batch.iter().map(|chunk| chunk.id.clone()).collect();
            let current: std::collections::HashMap<&str, &str> = batch
                .iter()
                .map(|chunk| (chunk.id.as_str(), chunk.embed_input_hash.as_str()))
                .collect();
            let updates: Vec<(String, String)> = self
                .store
                .get(to, &ids)
                .await?
                .into_iter()
                .filter(|row| current.get(row.id.as_str()) != Some(&row.embed_input_hash.as_str()))
                .map(|row| (row.id, row.embed_input_hash))
                .collect();
            if !updates.is_empty() {
                changed +=
                    ChunkRepo::set_embed_input_hashes(self.meta.as_ref(), collection, &updates)
                        .await?;
            }
            after = ids.last().cloned();
        }
        Ok(changed)
    }

    /// 把 `chunks` 里有、目标表里没有的块从旧表补过来(切换窗口内的写入)。
    async fn fill_missing(
        &self,
        collection: &str,
        from_tables: &[String],
        to: &str,
    ) -> Result<u64> {
        let mut copied = 0u64;
        let mut after: Option<String> = None;
        loop {
            let batch =
                ChunkRepo::ids_after(self.meta.as_ref(), collection, after.as_deref(), BATCH)
                    .await?;
            if batch.is_empty() {
                break;
            }
            let ids: Vec<String> = batch.iter().map(|chunk| chunk.id.clone()).collect();
            let present = self.store.get(to, &ids).await?;
            let have: std::collections::BTreeSet<&str> =
                present.iter().map(|row| row.id.as_str()).collect();
            let missing: Vec<String> = ids
                .iter()
                .filter(|id| !have.contains(id.as_str()))
                .cloned()
                .collect();
            if !missing.is_empty() {
                for table in from_tables {
                    match self.copy_rows(table, to, &missing).await {
                        Ok(count) => copied += count,
                        // 只降级“表不存在”(历史退役表可能已被夜间清理删掉);
                        // I/O、损坏、权限等错误必须向上传,否则漏补的行只剩一行日志
                        Err(KbError::NotFound(_)) => {
                            tracing::warn!(table = %table, "补齐缺失行时旧表已不存在")
                        }
                        Err(err) => return Err(err),
                    }
                }
            }
            after = ids.last().cloned();
        }
        Ok(copied)
    }

    /// 带水位线的追平:每轮从上一批的 `(updated_at, id)` 继续,直到没有新数据。
    async fn catch_up(
        &self,
        collection: &str,
        from: &str,
        to: &str,
        started_at: Millis,
        written: &mut std::collections::BTreeSet<String>,
    ) -> Result<u64> {
        let mut migrated = 0u64;
        let mut cursor: Option<(Millis, String)> = None;
        loop {
            let after = cursor.as_ref().map(|(ts, id)| (*ts, id.as_str()));
            let batch = ChunkRepo::updated_since_after(
                self.meta.as_ref(),
                collection,
                started_at,
                after,
                BATCH,
            )
            .await?;
            if batch.is_empty() {
                break;
            }
            let ids: Vec<String> = batch.iter().map(|chunk| chunk.id.clone()).collect();
            migrated += self.copy_rows(from, to, &ids).await?;
            written.extend(ids.iter().cloned());
            // 游标严格前进,保证循环一定结束
            let last = batch.last().expect("非空");
            cursor = Some((last.updated_at, last.id.clone()));
        }
        Ok(migrated)
    }

    /// 对账:删掉新表里已经不在 SQLite 的 id(迁移期间被删除/替换的块、被删的 insight)。
    ///
    /// “还活着”的 id = `chunks` ∪ `insights`;漏掉 insight 会把刚搬过去的经验条目删掉。
    async fn reconcile(
        &self,
        collection: &str,
        to: &str,
        written: &mut std::collections::BTreeSet<String>,
    ) -> Result<()> {
        let mut alive: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        let mut after: Option<String> = None;
        loop {
            let batch =
                ChunkRepo::ids_after(self.meta.as_ref(), collection, after.as_deref(), BATCH)
                    .await?;
            if batch.is_empty() {
                break;
            }
            for chunk in &batch {
                alive.insert(chunk.id.clone());
            }
            after = batch.last().map(|chunk| chunk.id.clone());
        }
        for insight in self.insights(collection).await? {
            alive.insert(insight.id);
        }
        let stale: Vec<String> = written.difference(&alive).cloned().collect();
        if !stale.is_empty() {
            self.store.delete_ids(to, &stale).await?;
            for id in &stale {
                written.remove(id);
            }
        }
        Ok(())
    }

    /// 把 collection 的 insight 行重新嵌入并写进新表)。
    ///
    /// 正文与标题在 SQLite(`insights` 表)里,和 `InsightJobHandler` 走同一个
    /// [`crate::insight::insight_row`] 构造,保证新表里的行与“重新保存一次”等价。
    async fn copy_insights(
        &self,
        collection: &str,
        to: &str,
        written: &mut std::collections::BTreeSet<String>,
    ) -> Result<u64> {
        let insights = self.insights(collection).await?;
        let mut copied = 0u64;
        for batch in insights.chunks(BATCH as usize) {
            let mut rows: Vec<kb_core::model::RecordRow> = batch
                .iter()
                .map(|insight| crate::insight::insight_row(insight, self.embedder.id()))
                .collect();
            let inputs: Vec<String> = rows
                .iter()
                .map(|row| format!("{}\n{}", row.header, row.text))
                .collect();
            let vectors = self.embedder.embed_documents(inputs).await?;
            if vectors.len() != rows.len() {
                return Err(KbError::Internal(format!(
                    "嵌入器返回 {} 条向量,期望 {}",
                    vectors.len(),
                    rows.len()
                )));
            }
            for (row, vector) in rows.iter_mut().zip(vectors) {
                if vector.len() != self.embedder.dim() {
                    return Err(KbError::Internal(format!(
                        "新嵌入器返回 {} 维,期望 {}",
                        vector.len(),
                        self.embedder.dim()
                    )));
                }
                row.vector = Some(vector);
            }
            let ids: Vec<String> = rows.iter().map(|row| row.id.clone()).collect();
            self.store.upsert(to, rows).await?;
            copied += ids.len() as u64;
            written.extend(ids);
        }
        Ok(copied)
    }

    /// collection 的全部 insight(不分状态;迁移要搬的是“存在的条目”)。
    async fn insights(&self, collection: &str) -> Result<Vec<kb_core::model::Insight>> {
        // 单个 collection 的经验条目量级很小;一次取全量,避免分页游标的边界问题
        InsightRepo::list(self.meta.as_ref(), collection, None, Page::new(10_000, 0)).await
    }

    /// insight 行数(条数校验的基准之一)。
    async fn insight_rows(&self, collection: &str) -> Result<u64> {
        Ok(self.insights(collection).await?.len() as u64)
    }

    /// 从旧表读一批,重嵌入后写新表。
    async fn copy_rows(&self, from: &str, to: &str, ids: &[String]) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let rows = self.store.get(from, ids).await?;
        if rows.is_empty() {
            return Ok(0);
        }
        let inputs: Vec<String> = rows
            .iter()
            .map(crate::index::pipeline::embed_text)
            .collect();
        let vectors = self.embedder.embed_documents(inputs).await?;
        let mut out = Vec::with_capacity(rows.len());
        for (mut row, vector) in rows.into_iter().zip(vectors) {
            if vector.len() != self.embedder.dim() {
                return Err(KbError::Internal(format!(
                    "新嵌入器返回 {} 维,期望 {}",
                    vector.len(),
                    self.embedder.dim()
                )));
            }
            row.vector = Some(vector);
            // `embed_input_hash` 把嵌入器 id 算进去了(换模型必须让它变),这里和索引写入共用
            // `kb_core::hash::embed_input_hash`(`pipeline::build_rows` 用的同一个函数),不复制公式。
            // 不重算的话,命中插件的文件在迁移后的每次全量扫描里都会被判成「嵌入输入变了」而整份重嵌入。
            row.embed_input_hash = embed_input_hash(self.embedder.id(), &row.header, &row.text);
            out.push(row);
        }
        let count = out.len() as u64;
        self.store.upsert(to, out).await?;
        Ok(count)
    }

    /// `--to` 必须与真正使用的嵌入器一致,否则会把向量与 `embedder_id` 写错配。
    fn ensure_target(&self, to_embedder: &str) -> Result<()> {
        if to_embedder != self.embedder.id() {
            return Err(KbError::InvalidInput(format!(
                "--to {to_embedder} 与当前配置的嵌入器 {} 不一致;请先在 config.toml 里切换 embed 配置",
                self.embedder.id()
            )));
        }
        Ok(())
    }

    async fn collection(&self, name: &str) -> Result<Collection> {
        CollectionRepo::get(self.meta.as_ref(), name)
            .await?
            .ok_or_else(|| KbError::NotFound(format!("collection {name}")))
    }
}

/// 下一张表的物理名:`{coll}__{slug}__v{n+1}`(slug 来自**新**嵌入器）。
fn next_table(collection: &Collection, embedder_id: &str) -> String {
    let slug = embedder_slug(embedder_id);
    let version = table_version(&collection.active_table);
    format!("{}__{slug}__v{}", collection.name, version + 1)
}

/// 从表名尾部解析 `__v<digits>`;没有就当作 0。
fn table_version(table: &str) -> u32 {
    table
        .rsplit("__v")
        .next()
        .filter(|tail| !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

/// 嵌入器 id → 表名里的 slug(`fastembed:bge-m3-int8` → `fastembed_bge_m3_int8`)。
///
/// 保留后端前缀,避免不同后端同维度时表名冲突(`fake:16` 与 `http:16`)。
fn embedder_slug(embedder_id: &str) -> String {
    let mut slug = String::new();
    for ch in embedder_id.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if !slug.ends_with('_') && !slug.is_empty() {
            slug.push('_');
        }
    }
    let slug = slug.trim_matches('_').to_owned();
    if slug.is_empty() {
        "v".to_owned()
    } else {
        slug
    }
}

/// 兼容组归一化:去掉后端前缀(`fastembed:` / `http:` / `fake:`)与量化后缀(`-int8` / `-fp16`)。
///
/// `fastembed:bge-m3-int8` → `bge-m3`;`http:bge-m3` → `bge-m3`;`fake:8` → `8`。
fn normalize_group(embedder_id: &str) -> String {
    let model = embedder_id
        .split_once(':')
        .map(|(_, rest)| rest)
        .unwrap_or(embedder_id);
    model
        .trim_end_matches("-int8")
        .trim_end_matches("-fp16")
        .to_owned()
}

fn now_millis() -> Millis {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_table_increments_the_version() {
        let mut collection = sample_collection("proj_demo__bge_m3__v1");
        assert_eq!(next_table(&collection, "fake:16"), "proj_demo__fake_16__v2");
        collection.active_table = "proj_demo__bge_m3__v7".to_owned();
        assert_eq!(next_table(&collection, "fake:16"), "proj_demo__fake_16__v8");
        // collection 名里含 `__v` 也不能切错
        let mut tricky = sample_collection("my__vault__bge_m3__v3");
        tricky.name = "my__vault".to_owned();
        assert_eq!(next_table(&tricky, "fake:16"), "my__vault__fake_16__v4");
    }

    #[test]
    fn embedder_slugs_are_safe() {
        assert_eq!(
            embedder_slug("fastembed:bge-m3-int8"),
            "fastembed_bge_m3_int8"
        );
        assert_eq!(embedder_slug("fake:16"), "fake_16");
        assert_eq!(embedder_slug("http://x"), "http_x");
    }

    #[test]
    fn compat_group_strips_backend_prefix_and_quantization() {
        assert_eq!(normalize_group("fastembed:bge-m3-int8"), "bge-m3");
        assert_eq!(normalize_group("http:bge-m3"), "bge-m3");
        assert_eq!(normalize_group("fake:8"), "8");
        assert_eq!(normalize_group("plain"), "plain");
    }

    fn sample_collection(table: &str) -> Collection {
        Collection {
            name: "proj_demo".to_owned(),
            kind: kb_core::model::CollectionKind::Project,
            project_id: Some("p1".to_owned()),
            embedder_id: "fastembed:bge-m3-int8".to_owned(),
            dim: 1024,
            active_table: table.to_owned(),
            retired_tables: Vec::new(),
            migrating_to: None,
            migration_started_at: None,
            context_mode: kb_core::model::ContextMode::Header,
            table_version: 1,
            created_at: 1_700_000_000_000,
        }
    }
}
