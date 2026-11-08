//! 调度器:每小时 optimize、每天夜间全量指纹校验。
//!
//! 不引入 cron 库:用 `chrono` 判断“到点了没有”,时钟可注入以便测试。

use std::sync::Arc;

use chrono::{DateTime, Utc};
use kb_core::model::{Collection, Event, Project};
use kb_core::ports::VectorStore;
use kb_core::ports::repo::MetaStore;
use kb_core::ports::repo::{CollectionRepo, EventRepo, FileRepo, ProjectRepo};
use kb_core::{KbError, Result};

use crate::index::IndexService;
use crate::jobs::queue::{JobQueue, NewJob};

/// 可注入的时钟。
///
/// `now` 返回 UTC(用于计算间隔),`local_minutes` 返回**站点时区**的“当天第几分钟”,
/// `nightly_at` 按站点时区解释(默认北京时间;不再依赖服务器 OS 的 `TZ`)。
pub trait Clock: Send + Sync {
    /// 当前时间(UTC)。
    fn now(&self) -> DateTime<Utc>;
    /// 站点时区的当天第几分钟(0..1440)。
    fn local_minutes(&self) -> u32;
    /// 站点时区日期(用于“每天只跑一次”)。
    fn local_date(&self) -> chrono::NaiveDate;
}

/// 系统时钟。
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
    fn local_minutes(&self) -> u32 {
        kb_core::timezone::local_minutes(Utc::now().timestamp_millis())
    }
    fn local_date(&self) -> chrono::NaiveDate {
        kb_core::timezone::local_date(Utc::now().timestamp_millis())
    }
}

/// 固定时钟(测试用):时间点按 UTC 给出,站点时区读数由同一瞬间推出。
pub struct FixedClock {
    /// UTC 时间。
    pub at: DateTime<Utc>,
    /// 站点时区当天第几分钟。
    pub local_minutes: u32,
    /// 站点时区日期。
    pub local_date: chrono::NaiveDate,
}

impl FixedClock {
    /// 用 UTC 时间构造(站点读数按 `[site] timezone` 换算)。
    pub fn new(at: DateTime<Utc>) -> Self {
        let millis = at.timestamp_millis();
        Self {
            at,
            local_minutes: kb_core::timezone::local_minutes(millis),
            local_date: kb_core::timezone::local_date(millis),
        }
    }

    /// 指定“站点时区第几分钟”构造(测试跨时区 / 临界点用);日期仍按同一瞬间的站点日期。
    pub fn with_local(at: DateTime<Utc>, local_minutes: u32) -> Self {
        Self {
            at,
            local_minutes,
            local_date: kb_core::timezone::local_date(at.timestamp_millis()),
        }
    }
}

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.at
    }
    fn local_minutes(&self) -> u32 {
        self.local_minutes
    }
    fn local_date(&self) -> chrono::NaiveDate {
        self.local_date
    }
}

/// 调度配置(来自 `[schedule]`)。
#[derive(Clone, Debug)]
pub struct ScheduleOptions {
    /// 夜间校验时间 `HH:MM`。
    pub nightly_at: String,
    /// optimize 间隔(分钟)。
    pub optimize_interval_minutes: u64,
    /// 热点表(上次整理后又被写过)的 optimize 间隔(分钟)。
    pub hot_optimize_interval_minutes: u64,
}

impl Default for ScheduleOptions {
    fn default() -> Self {
        Self {
            nightly_at: "03:00".to_owned(),
            optimize_interval_minutes: 60,
            hot_optimize_interval_minutes: 10,
        }
    }
}

/// 一次 tick 的决定。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TickPlan {
    /// 是否该做 optimize。
    pub optimize: bool,
    /// 是否该做夜间校验。
    pub nightly: bool,
    /// 是否该做定时备份(没接备份服务或未启用时恒为 false)。
    pub backup: bool,
}

/// 夜间校验的结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct NightlyReport {
    /// 投递了增量任务的项目数。
    pub resynced: usize,
    /// 指纹一致、无需重扫的项目数。
    pub clean: usize,
    /// 清理掉的退役表数。
    pub dropped_tables: usize,
    /// 建了向量索引的表数。
    pub indexed_tables: usize,
    /// 夜间去重扫了几个 collection。
    pub deduped_collections: usize,
    /// 夜间去重标出了几对重复(整批可撤销)。
    pub dedup_pairs: usize,
    /// 按保留策略清掉的历史行数(四张表合计;没接清理器时为 0)。
    pub pruned_rows: u64,
    /// 夜间质量门禁是否真跑了一次黄金集抽样。
    pub quality_checked: bool,
    /// 夜间质量门禁是否判出回退(同样本 hit@1 比上一期跌超过 [`QUALITY_DROP_LIMIT`])。
    pub quality_dropped: bool,
    /// 夜间清掉了几条过期回收站记录。
    pub purged_trash: u64,
    /// 夜间做完「元数据 ⇄ 向量库」一致性校验的 collection 数(拿不到写闸门的不算,它们挂在重试里)。
    pub verified_collections: usize,
    /// 校验发现有差异(块缺失或哈希不一致)的文件数,不论后来修没修。
    pub divergent_files: usize,
    /// 已清掉旧块、排了增量任务重建的文件数(护栏拦下、非项目集合的差异不计入)。
    pub repaired_files: usize,
}

/// 夜间一致性校验:每个集合每晚最多修这么多个文件,超出的下一晚接着修。
///
/// 失效一个文件会让它暂时搜不到(直到增量任务把它重建出来),所以单晚设上限,
/// 免得一次清掉太多文件、重建队列排上几个小时。
pub const VERIFY_MAX_FILES_PER_NIGHT: usize = 200;
/// 自动修复的护栏下限:差异块数不超过这个数,一律当作正常残留去修。
pub const VERIFY_GUARD_MIN_BLOCKS: usize = 50;
/// 自动修复的护栏比例(百分比):差异块数超过元数据块数的这个比例,也认为不是正常残留。
pub const VERIFY_GUARD_PERCENT: usize = 20;

/// 差异大到不该自动修:`差异块数 > max(50, 元数据块数 × 20%)`。
///
/// 正常的残留(取消、重启留下的半截文件)只有零星几块。成片的差异多半是备份恢复了旧的 `meta.db`、
/// 换过向量库或者手工动过数据,这时按「差异」逐个失效会把大半个知识库清空再重建
/// (全库重嵌入要一两天),必须交给人去判断。
fn exceeds_repair_guard(diverging_chunks: usize, meta_rows: usize) -> bool {
    let limit = VERIFY_GUARD_MIN_BLOCKS.max(meta_rows.saturating_mul(VERIFY_GUARD_PERCENT) / 100);
    diverging_chunks > limit
}

/// 一个集合一次「校验 + 修复」的结果。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct VerifyOutcome {
    /// 校验跑完了;`false` 表示拿不到写闸门(有索引分片在写)或修复时被占住,需要之后重试。
    done: bool,
    /// 有差异的文件数。
    divergent_files: usize,
    /// 已失效并排了增量任务的文件数。
    repaired_files: usize,
}

/// 距 `since` 过去了多少毫秒(夜间分步耗时用)。
fn elapsed_ms(since: std::time::Instant) -> u128 {
    since.elapsed().as_millis()
}

/// 夜间质量门禁允许的回退幅度:同一份黄金集(同 `set_hash`)的 hit@1 跌过这条线才算回退。
pub const QUALITY_DROP_LIMIT: f64 = 0.05;

/// 一次夜间质量抽样的结果。
#[derive(Clone, Debug, PartialEq)]
pub struct QualityMeasure {
    /// 黄金集指纹:只有指纹相同,两期的 hit@1 才可比。
    pub set_hash: String,
    /// 抽了几条用例。
    pub cases: usize,
    /// 本期 hit@1。
    pub hit_at_1: f64,
    /// 上一期同指纹的 hit@1(第一次跑、或上一期指纹不同时为 None)。
    pub previous_hit_at_1: Option<f64>,
}

/// 门禁的判定结果。
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum QualityVerdict {
    /// 没有可比基线(第一次跑 / 黄金集换过),只记录不报警。
    NoBaseline,
    /// 持平或变好。
    Steady,
    /// 回退超过 [`QUALITY_DROP_LIMIT`],差多少一起带出去。
    Dropped {
        /// 上一期减本期(正数)。
        delta: f64,
    },
}

/// 比一比两期 hit@1。
///
/// 只比**同指纹**的两期:黄金集换了(set_hash 变了)就重新开始攒基线,否则跌的是「用例换了」而不是质量。
pub fn judge_quality(measure: &QualityMeasure) -> QualityVerdict {
    let Some(previous) = measure.previous_hit_at_1 else {
        return QualityVerdict::NoBaseline;
    };
    let delta = previous - measure.hit_at_1;
    // 浮点比较留一点余量:0.86 - 0.80 在二进制里可能得到 0.05999999999999994
    if delta > QUALITY_DROP_LIMIT + 1e-9 {
        QualityVerdict::Dropped { delta }
    } else {
        QualityVerdict::Steady
    }
}

/// 数据保留:由组装根提供(要同时清知识库库与账号库,端口都在上层)。
#[async_trait::async_trait]
pub trait RetentionHook: Send + Sync {
    /// 清一次,返回每张表删掉(或会删)的行数。`dry_run` 只数不删。
    async fn prune(&self, dry_run: bool) -> Result<Vec<(String, u64)>>;
}

/// 回收站清理:由组装根提供(要按知识库的存储路径搬文件,端口在上层)。
#[async_trait::async_trait]
pub trait TrashHook: Send + Sync {
    /// 删掉超过保留期(30 天)的回收站条目,返回删了几条。
    async fn purge_trash(&self) -> Result<u64>;
}

/// 夜间质量门禁:由组装根提供(评测要拼检索服务、读黄金集、追加历史,都在上层)。
#[async_trait::async_trait]
pub trait QualityGate: Send + Sync {
    /// 跑一次抽样评测。
    ///
    /// 返回 `Ok(None)` 表示「今天没什么可比的」(没装黄金集、抽不出用例),不算失败;
    /// 抽出错只记事件,不让夜间校验整体失败。
    async fn measure(&self) -> Result<Option<QualityMeasure>>;
}

/// 调度器。
pub struct Scheduler {
    meta: Arc<dyn MetaStore>,
    store: Arc<dyn VectorStore>,
    index: Arc<IndexService>,
    queue: JobQueue,
    /// 调度参数。
    options: std::sync::RwLock<ScheduleOptions>,
    clock: Arc<dyn Clock>,
    /// 上次 optimize 的时间(内存里,重启后重新计时)。
    last_optimize: std::sync::Mutex<Option<DateTime<Utc>>>,
    /// 上次夜间校验的日期。
    last_nightly: std::sync::Mutex<Option<chrono::NaiveDate>>,
    /// 外部资料刷新;没接就跳过。
    sources: Option<Arc<crate::sources::SourceService>>,
    /// 夜间去重;没接就跳过。
    dedup: Option<Arc<crate::evolution::DedupService>>,
    /// 定时备份(设置页「备份」);没接就跳过。
    backup: Option<Arc<crate::backup::BackupService>>,
    /// 上次**尝试**自动备份的时间(失败后按退避窗口重试,不要每拍都重试)。
    last_backup_attempt: std::sync::Mutex<Option<DateTime<Utc>>>,
    /// 孤儿向量对账时拿不到独占闸门(有索引分片在写)而跳过的 collection:之后每拍只重试这几个,
    /// 不用干等到下一个整点 optimize;对上了(或没有孤儿)就移出。
    reconcile_pending: std::sync::Mutex<std::collections::BTreeSet<String>>,
    /// 一致性校验时拿不到独占闸门而跳过的 collection(knowledgeBase 这类持续有写入的集合经常这样):
    /// 之后每拍重试,直到做成,不能等到下一个夜间再碰运气。
    verify_pending: std::sync::Mutex<std::collections::BTreeSet<String>>,
    /// 上次整理时各表的版本号:版本没变就说明这段时间没人写过,热点整理可以跳过。
    optimized_versions: std::sync::Mutex<std::collections::BTreeMap<String, u64>>,
    /// 上次做热点整理的时间(内存里,重启后重新计时)。
    last_hot_optimize: std::sync::Mutex<Option<DateTime<Utc>>>,
    /// 夜间质量门禁;没接就跳过。
    quality_gate: Option<Arc<dyn QualityGate>>,
    /// 历史表清理;没接就跳过。
    retention: Option<Arc<dyn RetentionHook>>,
    /// 回收站过期清理;没接就跳过。
    trash: Option<Arc<dyn TrashHook>>,
}

/// 调度器记住的「上次什么时候做过」。
///
/// 非主知识库空闲时会被关掉、下次访问再打开,每次打开都新建调度器;不把这两个时间带过去的话,
/// 每次重新打开都会把 optimize 和当天的夜间校验各重跑一遍(新调度器以为从没跑过)。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScheduleHistory {
    /// 上次 optimize 的时间。
    pub last_optimize: Option<DateTime<Utc>>,
    /// 上次夜间校验的本地日期。
    pub last_nightly: Option<chrono::NaiveDate>,
}

impl Scheduler {
    /// 接上数据源服务(启用外部资料定期刷新)。
    pub fn with_sources(mut self, sources: Arc<crate::sources::SourceService>) -> Self {
        self.sources = Some(sources);
        self
    }

    /// 接着上一个调度器的进度(见 [`ScheduleHistory`])。
    pub fn with_history(self, history: ScheduleHistory) -> Self {
        *self
            .last_optimize
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = history.last_optimize;
        *self
            .last_nightly
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = history.last_nightly;
        self
    }

    /// 现在的进度,交给下一次打开时新建的调度器。
    pub fn history(&self) -> ScheduleHistory {
        ScheduleHistory {
            last_optimize: *self
                .last_optimize
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()),
            last_nightly: *self
                .last_nightly
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()),
        }
    }

    /// 接上备份服务(启用定时备份 + 保留策略)。
    ///
    /// 是否启用、多久一次、留几份都由 `[backup]` 决定(见 [`BackupService::set_policy`]);
    /// 到点判断以归档目录里最新一份的时间为准,所以重启后不会重复备份。
    pub fn with_backup(mut self, backup: Arc<crate::backup::BackupService>) -> Self {
        self.backup = Some(backup);
        self
    }

    /// 接上去重服务(夜间顺带跑一次去重)。
    ///
    /// 是否启用由组装根决定:`[evolution] nightly_dedup = false` 时不要接。
    pub fn with_dedup(mut self, dedup: Arc<crate::evolution::DedupService>) -> Self {
        self.dedup = Some(dedup);
        self
    }

    /// 构造。
    pub fn new(
        meta: Arc<dyn MetaStore>,
        store: Arc<dyn VectorStore>,
        index: Arc<IndexService>,
        options: ScheduleOptions,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let queue = JobQueue::new(meta.clone());
        Self {
            meta,
            store,
            index,
            queue,
            options: std::sync::RwLock::new(options),
            clock,
            last_optimize: std::sync::Mutex::new(None),
            last_nightly: std::sync::Mutex::new(None),
            sources: None,
            dedup: None,
            backup: None,
            last_backup_attempt: std::sync::Mutex::new(None),
            reconcile_pending: std::sync::Mutex::new(std::collections::BTreeSet::new()),
            verify_pending: std::sync::Mutex::new(std::collections::BTreeSet::new()),
            optimized_versions: std::sync::Mutex::new(std::collections::BTreeMap::new()),
            last_hot_optimize: std::sync::Mutex::new(None),
            quality_gate: None,
            retention: None,
            trash: None,
        }
    }

    /// 接上历史表清理:夜里顺带按 `[retention]` 的期限清一次。
    pub fn with_retention(mut self, retention: Arc<dyn RetentionHook>) -> Self {
        self.retention = Some(retention);
        self
    }

    /// 接上回收站清理:夜里删掉超过 30 天的回收站条目。
    pub fn with_trash(mut self, trash: Arc<dyn TrashHook>) -> Self {
        self.trash = Some(trash);
        self
    }

    /// 接上夜间质量门禁:夜里顺带跑一次黄金集抽样,跌了才告警。
    pub fn with_quality_gate(mut self, gate: Arc<dyn QualityGate>) -> Self {
        self.quality_gate = Some(gate);
        self
    }

    /// 换一份调度参数。
    pub fn set_options(&self, options: ScheduleOptions) {
        *self
            .options
            .write()
            .unwrap_or_else(|poison| poison.into_inner()) = options;
    }

    /// 当前调度参数的快照。
    fn options(&self) -> ScheduleOptions {
        self.options
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    /// 判断这一拍要不要干活。
    pub fn plan(&self) -> TickPlan {
        let now = self.clock.now();
        let optimize = {
            let last = *self
                .last_optimize
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            match last {
                None => true,
                Some(last) => {
                    (now - last).num_minutes() >= self.options().optimize_interval_minutes as i64
                }
            }
        };
        let nightly = {
            let (hour, minute) = parse_hhmm(&self.options().nightly_at).unwrap_or((3, 0));
            // 按**站点时区**比较:`local_minutes` 与 `local_date` 必须成对使用,
            // 否则时区非 UTC 时“到点判断”和“今天已跑过”会用两套日历,夜间校验每分钟重跑。
            let due = self.clock.local_minutes() >= hour * 60 + minute;
            let done_today = self
                .last_nightly
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .is_some_and(|date| date == self.clock.local_date());
            due && !done_today
        };
        TickPlan {
            optimize,
            nightly,
            // 定时备份:到点判断在 BackupService 里(以归档目录最新一份的时间为准),
            // 再叠加一层“失败退避”——否则备份持续失败时每拍都会重试
            backup: self.backup.as_ref().is_some_and(|backup| {
                backup.due(now.timestamp_millis()) && self.backup_retry_due(now, backup)
            }),
        }
    }

    /// 上次尝试距今是否已经超过退避窗口(从没试过就算到点)。
    fn backup_retry_due(&self, now: DateTime<Utc>, backup: &crate::backup::BackupService) -> bool {
        let last = *self
            .last_backup_attempt
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        retry_due(last, now, backup_retry_window_minutes(&backup.policy()))
    }

    /// 执行一拍(只做 plan 里为真的部分)。
    /// 到点刷新外部资料:只处理设了 `refresh_minutes` 且到点的数据源。
    pub async fn refresh_sources(
        &self,
        now: kb_core::model::Millis,
    ) -> Result<crate::refresh::RefreshReport> {
        let Some(sources) = &self.sources else {
            return Ok(crate::refresh::RefreshReport::default());
        };
        let due = crate::refresh::due_sources(self.meta.as_ref(), now).await?;
        let mut report = crate::refresh::RefreshReport {
            attempted: due.len() as u64,
            ..crate::refresh::RefreshReport::default()
        };
        for source in due {
            match sources.sync("scheduler", &source.id).await {
                Ok(outcome) => {
                    report.refreshed += 1;
                    report.queued += outcome.queued;
                }
                Err(err) => report.failed.push((source.name.clone(), err.to_string())),
            }
        }
        Ok(report)
    }

    pub async fn tick(&self) -> Result<(TickPlan, NightlyReport)> {
        let plan = self.plan();
        let mut report = NightlyReport::default();
        // :外部资料到点刷新(与 optimize / nightly 共用这次 tick)
        if let Err(err) = self
            .refresh_sources(self.clock.now().timestamp_millis())
            .await
        {
            tracing::warn!(error = %err, "外部资料刷新失败");
        }
        // 定时备份(设置页「备份」):到点才打包,打包完按保留策略清理旧归档。
        // 备份失败不影响这一拍的 optimize / nightly,只记日志。
        if plan.backup
            && let Some(backup) = &self.backup
        {
            // 先记下“试过了”:失败后要按退避窗口等一会儿再试
            *self
                .last_backup_attempt
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(self.clock.now());
            match backup.run_auto(self.clock.now().timestamp_millis()).await {
                Ok(Some(auto)) => tracing::info!(
                    archive = %auto.entry.name,
                    size_bytes = auto.entry.size_bytes,
                    pruned = auto.pruned.removed.len(),
                    kept = auto.pruned.kept,
                    "定时备份完成"
                ),
                Ok(None) => {}
                Err(err) => tracing::warn!(error = %err, "定时备份失败"),
            }
        }
        if plan.optimize {
            self.optimize_all().await?;
            let now = self.clock.now();
            *self
                .last_optimize
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(now);
            // 整份 optimize 已经把所有表都收过一遍:热点整理从现在重新计时,
            // 否则紧接着的下一拍会对着同样的版本号再收一次。
            *self
                .last_hot_optimize
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(now);
        } else {
            // 这一拍没做整份 optimize(它自己会对账):热点表在这里补收,再补上被跳过的对账
            self.optimize_hot().await;
            self.retry_pending_reconcile().await;
            self.retry_pending_verify().await;
        }
        if plan.nightly {
            report = self.nightly().await?;
            *self
                .last_nightly
                .lock()
                .unwrap_or_else(|poison| poison.into_inner()) = Some(self.clock.local_date());
        }
        Ok((plan, report))
    }

    /// 对所有 collection 做一次 optimize（设计规范）。
    async fn optimize_all(&self) -> Result<()> {
        for collection in CollectionRepo::list(self.meta.as_ref()).await? {
            if let Err(err) = self.index.optimize(&collection).await {
                tracing::warn!(error = %err, collection = %collection.name, "optimize 失败");
            }
            self.remember_version(&collection.active_table).await;
            // 顺手清孤儿向量:比较两边行数很便宜,只有对不上才会真的去列
            self.reconcile_one(&collection).await;
        }
        Ok(())
    }

    /// 热点表整理:上次整理后又被写过的表,不等整点,每 10 分钟收一次碎片。
    ///
    /// 判据是**表版本号变没变**,而不是猜「最近一小时有没有写入」:索引任务每批写都提交一次,
    /// 版本号一动就说明有新碎片;整理完记下新版本,下一拍就不会白跑。
    /// 这一步只在没做整份 optimize 的那一拍里跑,两者不会重复整理同一张表。
    async fn optimize_hot(&self) {
        let interval = self.options().hot_optimize_interval_minutes as i64;
        let now = self.clock.now();
        {
            let last = *self
                .last_hot_optimize
                .lock()
                .unwrap_or_else(|poison| poison.into_inner());
            if let Some(last) = last
                && (now - last).num_minutes() < interval
            {
                return;
            }
        }
        *self
            .last_hot_optimize
            .lock()
            .unwrap_or_else(|poison| poison.into_inner()) = Some(now);

        let collections = match CollectionRepo::list(self.meta.as_ref()).await {
            Ok(collections) => collections,
            Err(err) => {
                tracing::warn!(error = %err, "读 collection 列表失败,跳过热点整理");
                return;
            }
        };
        // 一次取齐所有表的版本号,别为每张表各开一次数据集
        let versions: std::collections::BTreeMap<String, u64> = match self.store.table_stats().await
        {
            Ok(stats) => stats
                .into_iter()
                .map(|stat| (stat.table, stat.version))
                .collect(),
            Err(err) => {
                tracing::warn!(error = %err, "读表状况失败,跳过热点整理");
                return;
            }
        };
        for collection in collections {
            let table = collection.active_table.clone();
            let Some(&version) = versions.get(&table) else {
                continue;
            };
            // 版本号没变 = 上次整理之后没人写过,不用再收一次
            let changed = self
                .optimized_versions
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .get(&table)
                .is_none_or(|seen| *seen != version);
            if !changed {
                continue;
            }
            if let Err(err) = self.index.optimize(&collection).await {
                tracing::warn!(error = %err, collection = %collection.name, "热点表 optimize 失败");
                continue;
            }
            self.remember_version(&table).await;
        }
    }

    /// 记下这张表整理时的版本号(下一拍热点整理的判据)。
    async fn remember_version(&self, table: &str) {
        match self.store.table_stats().await {
            Ok(stats) => {
                if let Some(stat) = stats.into_iter().find(|stat| stat.table == table) {
                    self.optimized_versions
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .insert(table.to_owned(), stat.version);
                }
            }
            Err(err) => {
                tracing::debug!(error = %err, table, "读表版本失败,热点整理下一拍重试")
            }
        }
    }

    /// 对一个 collection 做孤儿向量对账,并记下有没有被跳过(有索引分片在写时拿不到闸门)。
    async fn reconcile_one(&self, collection: &kb_core::model::Collection) {
        let outcome = self.index.reconcile_orphans(collection).await;
        let mut pending = self
            .reconcile_pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        match outcome {
            Ok(Some(_)) => {
                pending.remove(&collection.name);
            }
            Ok(None) => {
                if pending.insert(collection.name.clone()) {
                    tracing::info!(
                        collection = %collection.name,
                        "有索引分片在写入,孤儿向量对账推后,之后每拍重试"
                    );
                }
            }
            Err(err) => {
                tracing::warn!(error = %err, collection = %collection.name, "孤儿向量对账失败")
            }
        }
    }

    /// 重试之前被跳过的对账。每拍都调用;没有待办时什么都不做,拿不到闸门时立即返回,几乎没有开销。
    pub async fn retry_pending_reconcile(&self) {
        let names: Vec<String> = self
            .reconcile_pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .iter()
            .cloned()
            .collect();
        for name in names {
            match CollectionRepo::get(self.meta.as_ref(), &name).await {
                Ok(Some(collection)) => self.reconcile_one(&collection).await,
                // 这期间 collection 被删了:不用再对账
                Ok(None) => {
                    self.reconcile_pending
                        .lock()
                        .unwrap_or_else(|poison| poison.into_inner())
                        .remove(&name);
                }
                Err(err) => {
                    tracing::warn!(error = %err, collection = %name, "读取 collection 失败")
                }
            }
        }
    }

    /// 重试之前因拿不到写闸门而推后的一致性校验。每拍都调用;没有待办时什么都不做,
    /// 拿不到闸门时立即返回,几乎没有开销。
    pub async fn retry_pending_verify(&self) {
        let names: Vec<String> = self
            .verify_pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .iter()
            .cloned()
            .collect();
        for name in names {
            let collection = match CollectionRepo::get(self.meta.as_ref(), &name).await {
                Ok(Some(collection)) => collection,
                // 这期间 collection 被删了:不用再校验
                Ok(None) => {
                    self.set_verify_pending(&name, false);
                    continue;
                }
                Err(err) => {
                    tracing::warn!(error = %err, collection = %name, "读取 collection 失败");
                    continue;
                }
            };
            match self.verify_and_repair(&collection).await {
                Ok(outcome) if outcome.done => {
                    self.set_verify_pending(&name, false);
                    tracing::info!(
                        collection = %name,
                        divergent_files = outcome.divergent_files,
                        repaired_files = outcome.repaired_files,
                        "推后的一致性校验已补做"
                    );
                }
                // 还是拿不到闸门:留在待办里,下一拍再试
                Ok(_) => {}
                Err(err) => {
                    // 出错(表打不开等)就不再每拍重试刷日志,留给下一个夜间
                    tracing::warn!(error = %err, collection = %name, "推后的一致性校验失败");
                    self.set_verify_pending(&name, false);
                }
            }
        }
    }

    /// 登记 / 撤销「一致性校验待重试」。
    fn set_verify_pending(&self, name: &str, pending: bool) {
        let mut set = self
            .verify_pending
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        if pending {
            if set.insert(name.to_owned()) {
                tracing::info!(
                    collection = %name,
                    "有索引分片在写入(或正在迁移),一致性校验推后,之后每拍重试"
                );
            }
        } else {
            set.remove(name);
        }
    }

    /// 校验一个 collection 的元数据与向量库是否一致,项目集合里有差异的文件就修。
    ///
    /// 修的办法是**失效后重建**:清掉文件在向量库与元数据里的旧块和 `files` 行,再排一个增量任务。
    /// 增量索引只认文件哈希,不清掉 `files` 行就会一直 skip(缺失的块永远补不上)。
    /// 护栏与上限见 [`exceeds_repair_guard`]、[`VERIFY_MAX_FILES_PER_NIGHT`];
    /// 非项目集合(`_global`、外部资料)没有可排增量任务的项目,只校验和报告。
    async fn verify_and_repair(&self, collection: &Collection) -> Result<VerifyOutcome> {
        if collection.migrating_to.is_some() {
            // 换嵌入模型的迁移正在拷贝这张表:此时失效文件会和迁移的追平互相踩。
            // 当作「还没做成」,挂在待重试里,迁移结束后的某一拍补做
            tracing::debug!(collection = %collection.name, "collection 正在迁移,一致性校验推后");
            return Ok(VerifyOutcome::default());
        }
        let Some(report) = self.index.verify_chunks(collection).await? else {
            return Ok(VerifyOutcome::default());
        };
        let mut outcome = VerifyOutcome {
            done: true,
            divergent_files: report.files.len(),
            repaired_files: 0,
        };
        if report.orphans_in_store > 0 {
            // 孤儿归 reconcile_orphans 管(整点 optimize 时会清)。夜间校验是唯一每天必跑的
            // 观测点,所以用 warn 留痕:对账如果一直被写入饿住,这里能持续看到数字。
            tracing::warn!(
                collection = %collection.name,
                orphans = report.orphans_in_store,
                "向量库里有元数据找不到的块,等孤儿对账清理"
            );
        }
        if report.files.is_empty() {
            return Ok(outcome);
        }

        let samples: Vec<&str> = report.files.keys().take(5).map(String::as_str).collect();
        tracing::warn!(
            collection = %collection.name,
            missing_chunks = report.missing_in_store,
            stale_chunks = report.stale_in_store,
            files = report.files.len(),
            samples = ?samples,
            "元数据与向量库不一致:有的块只在元数据里、或哈希对不上"
        );

        let project = match &collection.project_id {
            Some(project_id) => ProjectRepo::get(self.meta.as_ref(), project_id).await?,
            None => None,
        };
        let Some(project) = project else {
            tracing::warn!(
                collection = %collection.name,
                "不是项目集合,没有可排增量任务的项目,只报告不修复"
            );
            return Ok(outcome);
        };
        if exceeds_repair_guard(report.diverging_chunks(), report.meta_rows) {
            tracing::warn!(
                collection = %collection.name,
                diverging_chunks = report.diverging_chunks(),
                meta_rows = report.meta_rows,
                "差异过大,不自动修复,请人工重建索引(多半是 meta.db 被恢复过或换过向量库)"
            );
            return Ok(outcome);
        }

        let all: Vec<String> = report.files.keys().cloned().collect();
        if all.len() > VERIFY_MAX_FILES_PER_NIGHT {
            tracing::warn!(
                collection = %collection.name,
                divergent = all.len(),
                limit = VERIFY_MAX_FILES_PER_NIGHT,
                "有差异的文件超过单晚上限,先修一部分,剩下的下一晚继续"
            );
        }
        let paths: Vec<String> = all.into_iter().take(VERIFY_MAX_FILES_PER_NIGHT).collect();

        match self.index.invalidate_files(collection, &paths).await {
            Ok(cleared) => outcome.repaired_files = cleared,
            Err(KbError::Unavailable(reason)) => {
                // 校验和失效之间有索引分片抢到了闸门:什么都没动,整个挪到之后的拍子里重做
                tracing::info!(collection = %collection.name, reason = %reason, "失效推后");
                outcome.done = false;
                return Ok(outcome);
            }
            Err(err) => {
                // 可能已经清掉了一部分文件:照样排增量任务。没清掉的文件哈希没变会被 skip,
                // 清掉的会被重建;排不上的话,下个夜间的指纹校验也会把缺了 files 行的文件当新文件补上
                tracing::warn!(
                    error = %err,
                    collection = %collection.name,
                    "清理差异文件时出错,仍排增量任务重建已清掉的部分"
                );
            }
        }
        if let Err(err) = self
            .queue
            .enqueue(NewJob::incremental_index(
                &project.id,
                &collection.name,
                &paths,
            ))
            .await
        {
            tracing::warn!(
                error = %err,
                collection = %collection.name,
                "排增量任务失败,这些文件要等夜间指纹校验当新文件补上"
            );
        }
        Ok(outcome)
    }

    /// 夜间的一致性校验:对每个 collection 跑一遍 [`Self::verify_and_repair`] 并汇总进报告。
    async fn verify_consistency(&self, report: &mut NightlyReport) {
        let collections = match CollectionRepo::list(self.meta.as_ref()).await {
            Ok(collections) => collections,
            Err(err) => {
                tracing::warn!(error = %err, "读 collection 列表失败,跳过一致性校验");
                return;
            }
        };
        for collection in collections {
            match self.verify_and_repair(&collection).await {
                Ok(outcome) => {
                    if outcome.done {
                        report.verified_collections += 1;
                        self.set_verify_pending(&collection.name, false);
                    } else {
                        self.set_verify_pending(&collection.name, true);
                    }
                    report.divergent_files += outcome.divergent_files;
                    report.repaired_files += outcome.repaired_files;
                }
                Err(err) => {
                    tracing::warn!(error = %err, collection = %collection.name, "一致性校验失败");
                }
            }
        }
    }

    /// 夜间:全量指纹校验 + 清理退役表 + 建向量索引 + 质量门禁 + 元数据/向量库一致性校验。
    ///
    /// 每个阶段单独计时,结束时输出一行汇总(引擎检查时只看到整体 6.5 分钟,分不清慢在哪一步)。
    pub async fn nightly(&self) -> Result<NightlyReport> {
        let total_started = std::time::Instant::now();
        let mut report = NightlyReport::default();

        // 阶段 1:磁盘指纹校验
        let stage = std::time::Instant::now();
        for project in ProjectRepo::list(self.meta.as_ref()).await? {
            match self.fingerprint_diff(&project).await {
                Ok(Some(paths)) if !paths.is_empty() => {
                    let collection = format!("proj_{}", project.slug);
                    self.queue
                        .enqueue(NewJob::incremental_index(&project.id, &collection, &paths))
                        .await?;
                    report.resynced += 1;
                }
                Ok(_) => report.clean += 1,
                Err(err) => {
                    tracing::warn!(error = %err, project = %project.name, "指纹校验失败");
                }
            }
        }
        let fingerprint_ms = elapsed_ms(stage);

        // 阶段 2:建向量索引(行数超过阈值的表)
        let stage = std::time::Instant::now();
        for collection in CollectionRepo::list(self.meta.as_ref()).await? {
            if self.index.ensure_indexes(&collection).await.is_ok() {
                report.indexed_tables += 1;
            }
        }
        let index_ms = elapsed_ms(stage);

        // 阶段 3: 夜间去重(只用向量,不调 LLM;整批可撤销)
        let stage = std::time::Instant::now();
        if let Some(dedup) = &self.dedup {
            for collection in CollectionRepo::list(self.meta.as_ref()).await? {
                match dedup.dedup(&collection.name, false, "scheduler").await {
                    Ok(plan) => {
                        report.deduped_collections += 1;
                        report.dedup_pairs += plan.changed;
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, collection = %collection.name, "夜间去重失败");
                    }
                }
            }
        }
        let dedup_ms = elapsed_ms(stage);

        // 阶段 4:清理退役表(除当前 active 表之外的旧表,按 collection 记录的表名)
        let stage = std::time::Instant::now();
        for collection in CollectionRepo::list(self.meta.as_ref()).await? {
            for table in &collection.retired_tables {
                if table == &collection.active_table {
                    continue;
                }
                match self.store.drop_table(table).await {
                    Ok(()) => report.dropped_tables += 1,
                    Err(err) => tracing::warn!(error = %err, table = %table, "删除退役表失败"),
                }
            }
        }
        // :按保留策略清历史表。放在质量门禁之前:门禁自己会写一条历史 +
        // 一条 `eval/history.jsonl`,让它在清理之后跑,那一晚的记录不会被自己刚删的窗口带走。
        self.prune_history(&mut report).await;
        self.purge_trash(&mut report).await;
        let cleanup_ms = elapsed_ms(stage);

        // 阶段 5: 质量门禁。指纹校验/索引/去重都跑完了,量到的才是今晚收工时的检索效果。
        let stage = std::time::Instant::now();
        self.check_quality(&mut report).await;
        let gate_ms = elapsed_ms(stage);

        // 阶段 6:元数据 ⇄ 向量库一致性校验。放在门禁之后:修复会先清掉差异文件的块、
        // 再等增量任务重建,放在门禁之前的话,那些文件在测量时恰好搜不到,会被误判成质量回退。
        let stage = std::time::Instant::now();
        self.verify_consistency(&mut report).await;
        let consistency_ms = elapsed_ms(stage);

        tracing::info!(
            "夜间校验耗时 总计={}ms 指纹={}ms 建索引={}ms 去重={}ms 清理={}ms 门禁={}ms 一致性={}ms",
            elapsed_ms(total_started),
            fingerprint_ms,
            index_ms,
            dedup_ms,
            cleanup_ms,
            gate_ms,
            consistency_ms,
        );
        Ok(report)
    }

    /// 跑一次历史表清理(失败只告警,不影响夜间校验的其余部分)。
    async fn prune_history(&self, report: &mut NightlyReport) {
        let Some(retention) = &self.retention else {
            return;
        };
        match retention.prune(false).await {
            Ok(counts) => {
                let total: u64 = counts.iter().map(|(_, rows)| *rows).sum();
                report.pruned_rows = total;
                if total > 0 {
                    tracing::info!(
                        rows = total,
                        detail = ?counts,
                        "按保留策略清理了历史表"
                    );
                }
            }
            Err(err) => tracing::warn!(error = %err, "清理历史表失败"),
        }
    }

    /// 删掉回收站里超过保留期的条目。分批删,单晚最多 25 批,
    /// 避免一次积压几十万条时把夜间任务的其它步骤全堵住。
    async fn purge_trash(&self, report: &mut NightlyReport) {
        let Some(trash) = &self.trash else {
            return;
        };
        let total = purge_trash_in_batches(trash.as_ref()).await;
        report.purged_trash = total;
        if total > 0 {
            tracing::info!(rows = total, "清理了过期回收站条目");
        }
    }

    /// 跑一次夜间质量抽样并判定回退。
    ///
    /// 门禁自身出错只记事件,不让夜间校验失败(索引该做的事已经做完了)。
    async fn check_quality(&self, report: &mut NightlyReport) {
        let Some(gate) = &self.quality_gate else {
            return;
        };
        match gate.measure().await {
            Ok(Some(measure)) => {
                report.quality_checked = true;
                match judge_quality(&measure) {
                    QualityVerdict::NoBaseline => tracing::info!(
                        set_hash = %measure.set_hash,
                        cases = measure.cases,
                        hit_at_1 = measure.hit_at_1,
                        "夜间质量门禁:第一次给这份黄金集记基线,之后每晚比一次"
                    ),
                    QualityVerdict::Steady => tracing::info!(
                        set_hash = %measure.set_hash,
                        cases = measure.cases,
                        hit_at_1 = measure.hit_at_1,
                        previous = measure.previous_hit_at_1,
                        "夜间质量门禁:命中率没有回退"
                    ),
                    QualityVerdict::Dropped { delta } => {
                        report.quality_dropped = true;
                        tracing::warn!(
                            set_hash = %measure.set_hash,
                            cases = measure.cases,
                            hit_at_1 = measure.hit_at_1,
                            previous = measure.previous_hit_at_1,
                            delta,
                            "夜间质量门禁:命中率回退{:.0}%,检查最近的索引/切分/阈值改动",
                            delta * 100.0
                        );
                        self.record_quality_event(&measure, Some(delta)).await;
                    }
                }
                // 判出回退时上面已经写过事件;持平/首期不写,免得事件流里全是「一切正常」
            }
            Ok(None) => tracing::debug!("夜间质量门禁:没有可用的黄金集抽样,跳过"),
            Err(err) => {
                // 「失败只记事件、不告警」:黄金集无效、嵌入器降级这类问题不该半夜把人叫起来
                tracing::info!(error = %err, "夜间质量门禁没跑成,已记事件");
                self.record_quality_failure(&err.to_string()).await;
            }
        }
    }

    /// 把回退写进 `events`(Web 的事件流能看到一条,归到系统)。
    async fn record_quality_event(&self, measure: &QualityMeasure, delta: Option<f64>) {
        let payload = serde_json::json!({
            "gate": "nightly_quality",
            "set_hash": measure.set_hash,
            "cases": measure.cases,
            "hit_at_1": measure.hit_at_1,
            "previous_hit_at_1": measure.previous_hit_at_1,
            "delta": delta,
        });
        if let Err(err) = self.append_event("quality_gate", payload).await {
            tracing::warn!(error = %err, "写质量门禁事件失败");
        }
    }

    /// 门禁没跑成也留一条,便于事后核对「那晚为什么没有记录」。
    async fn record_quality_failure(&self, reason: &str) {
        let payload = serde_json::json!({ "gate": "nightly_quality", "error": reason });
        if let Err(err) = self.append_event("quality_gate", payload).await {
            tracing::warn!(error = %err, "写质量门禁事件失败");
        }
    }

    async fn append_event(&self, kind: &str, payload: serde_json::Value) -> Result<()> {
        EventRepo::append(
            self.meta.as_ref(),
            Event {
                id: uuid::Uuid::now_v7().to_string(),
                kind: kind.to_owned(),
                project_id: None,
                payload_json: payload.to_string(),
                received_at: self.clock.now().timestamp_millis(),
                processed_at: Some(self.clock.now().timestamp_millis()),
                result: None,
            },
        )
        .await
    }

    /// 比对磁盘与库里的记录,返回需要重扫的路径。
    ///
    /// - 只比较 `status = 'ok'` 的行(被过滤文件 `file_hash` 为空,永远会“不一致”);
    /// - 用扫描器的结果与库对账:**新增**、**变化**、**消失**三类都算;
    /// - 先比 `size + mtime`,不同才读内容算哈希;
    /// - 扫描与读文件都放到阻塞线程池,避免占住 tokio 工作线程。
    async fn fingerprint_diff(&self, project: &Project) -> Result<Option<Vec<String>>> {
        let collection = format!("proj_{}", project.slug);
        let known = FileRepo::list_paths(self.meta.as_ref(), &collection).await?;
        if known.is_empty() {
            return Ok(None);
        }

        // 扫描(与索引同一套过滤),放到阻塞线程池
        let index = self.index.clone();
        let project_clone = project.clone();
        let scanned = tokio::task::spawn_blocking(move || index.scan_project(&project_clone))
            .await
            .map_err(|err| KbError::Internal(format!("扫描任务失败: {err}")))??;

        let mut changed: Vec<String> = Vec::new();
        let mut on_disk: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        // 被跳过的文件也在磁盘上:不能当成“消失”,否则每晚都会把它们塞进增量任务
        for entry in &scanned.skipped {
            on_disk.insert(entry.relative.clone());
        }
        for entry in &scanned.files {
            on_disk.insert(entry.relative.clone());
            let row = FileRepo::get(self.meta.as_ref(), &collection, &entry.relative).await?;
            match row {
                None => changed.push(entry.relative.clone()),
                Some(row) => {
                    // 被过滤的文件:`files.status` 记的是 `excluded` / `too_large` / `binary` /
                    // `generated` / `unreadable`,且 `size`/`mtime` 一律记 0(见 `record_skipped`),
                    // 与磁盘上的真实值永远不等 → 不能比 size/mtime,直接跳过,
                    // 否则每晚都会把它们塞进增量任务。
                    if row.status != "ok" {
                        // 之前被过滤(二进制/超大/生成代码/exclude),现在能索引了 → 要补索引
                        // (已知被过滤且仍被过滤的不会出现在 `scanned.files` 里,所以不会重复投递)
                        changed.push(entry.relative.clone());
                        continue;
                    }
                    if row.size != entry.size || row.mtime != entry.mtime {
                        changed.push(entry.relative.clone());
                    }
                }
            }
        }
        // 状态反转:原来可索引、现在被过滤(变二进制/超大/加了 @generated/命中新 exclude)
        // → 要重新处理(清掉旧块);反过来在 `scanned.files` 那一支里已经覆盖
        for entry in &scanned.skipped {
            let row = FileRepo::get(self.meta.as_ref(), &collection, &entry.relative).await?;
            if row.map(|row| row.status) == Some("ok".to_owned()) {
                changed.push(entry.relative.clone());
            }
        }

        // 消失的文件
        for path in known {
            if !on_disk.contains(&path) {
                changed.push(path);
            }
        }
        changed.sort();
        changed.dedup();
        Ok(Some(changed))
    }
}

/// 自动备份失败后的重试窗口(分钟)。
///
/// 取 `min(interval_hours * 60, 60)`:间隔再长也最多每小时试一次,避免持续失败时
/// 每拍都做一次快照;间隔很短(1 小时)时按间隔走。
fn backup_retry_window_minutes(policy: &crate::backup::BackupPolicy) -> i64 {
    policy.interval_hours.saturating_mul(60).clamp(1, 60) as i64
}

/// 现在能不能再试一次(上次尝试距今 >= 窗口)。
fn retry_due(last: Option<DateTime<Utc>>, now: DateTime<Utc>, window_minutes: i64) -> bool {
    match last {
        None => true,
        Some(last) => (now - last).num_minutes() >= window_minutes,
    }
}

/// 解析 `HH:MM`。
fn parse_hhmm(value: &str) -> Option<(u32, u32)> {
    let (hour, minute) = value.split_once(':')?;
    let hour: u32 = hour.trim().parse().ok()?;
    let minute: u32 = minute.trim().parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((hour, minute))
}

/// 把 `[schedule]` 配置转成调度参数。
pub fn options_from(config: &kb_core::config::ScheduleConfig) -> ScheduleOptions {
    ScheduleOptions {
        nightly_at: config.nightly_at.clone(),
        optimize_interval_minutes: config.optimize_interval_minutes,
        hot_optimize_interval_minutes: config.hot_optimize_interval_minutes,
    }
}

/// 分批清回收站:每次最多 200 条,一轮夜间最多 25 批。
///
/// 分批是为了不长时间占着元数据库写锁;`Ok(0)` 或不足一批就说明已经清完。
/// 单批失败只告警并停下,已经清掉的条目仍然算数,下一晚继续。
async fn purge_trash_in_batches(trash: &dyn TrashHook) -> u64 {
    let mut total = 0u64;
    for _ in 0..25 {
        match trash.purge_trash().await {
            Ok(0) => break,
            Ok(rows) => {
                total += rows;
                if rows < 200 {
                    break;
                }
            }
            Err(err) => {
                tracing::warn!(error = %err, "清理回收站失败");
                break;
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Timelike;

    fn at(hour: u32, minute: u32) -> DateTime<Utc> {
        chrono::TimeZone::with_ymd_and_hms(&Utc, 2026, 10, 20, hour, minute, 0).unwrap()
    }

    #[test]
    fn hhmm_parsing() {
        assert_eq!(parse_hhmm("03:00"), Some((3, 0)));
        assert_eq!(parse_hhmm("23:59"), Some((23, 59)));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("oops"), None);
    }

    #[test]
    fn nightly_is_due_after_the_configured_time_once_per_day() {
        assert!(at(3, 0) >= at(3, 0));
        let now = at(2, 59);
        let due = now.hour() as i32 * 60 + now.minute() as i32 >= 3 * 60;
        assert!(!due, "03:00 之前不该跑");
        let now = at(3, 0);
        let due = now.hour() as i32 * 60 + now.minute() as i32 >= 3 * 60;
        assert!(due);
    }

    #[test]
    fn backup_retry_window_is_capped_at_one_hour() {
        use crate::backup::BackupPolicy;
        // 间隔 1 小时 → 窗口 60 分钟;间隔 24 小时 → 封顶 60 分钟;间隔 0(配置校验会拒)也不为 0
        for (hours, expected) in [(1u64, 60i64), (6, 60), (24, 60), (0, 1)] {
            let policy = BackupPolicy {
                interval_hours: hours,
                ..BackupPolicy::default()
            };
            assert_eq!(
                backup_retry_window_minutes(&policy),
                expected,
                "interval_hours = {hours}"
            );
        }
    }

    #[test]
    fn retry_waits_for_the_window_after_a_failed_attempt() {
        let start = at(10, 0);
        assert!(retry_due(None, start, 60), "从没试过 → 立刻可以试");
        assert!(!retry_due(Some(start), at(10, 30), 60), "半小时内不重试");
        assert!(retry_due(Some(start), at(11, 0), 60), "满一小时可以重试");
    }

    #[test]
    fn dates_are_compared_per_day() {
        let date = at(3, 0).date_naive();
        assert_eq!(date, chrono::NaiveDate::from_ymd_opt(2026, 10, 20).unwrap());
        assert_ne!(date, at(3, 0).date_naive().succ_opt().unwrap());
    }

    fn measure(current: f64, previous: Option<f64>) -> QualityMeasure {
        QualityMeasure {
            set_hash: "abc123".to_owned(),
            cases: 15,
            hit_at_1: current,
            previous_hit_at_1: previous,
        }
    }

    struct FakeTrash {
        replies: std::sync::Mutex<std::collections::VecDeque<Result<u64>>>,
        calls: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl TrashHook for FakeTrash {
        async fn purge_trash(&self) -> Result<u64> {
            self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.replies.lock().unwrap().pop_front().unwrap_or(Ok(0))
        }
    }

    #[tokio::test]
    async fn purging_stops_on_a_short_batch_and_keeps_what_was_already_deleted() {
        let trash = FakeTrash {
            replies: std::sync::Mutex::new(
                [Ok(200), Ok(200), Ok(37), Ok(999)].into_iter().collect(),
            ),
            calls: std::sync::atomic::AtomicUsize::new(0),
        };
        assert_eq!(purge_trash_in_batches(&trash).await, 437);
        assert_eq!(trash.calls.load(std::sync::atomic::Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn purging_a_failing_batch_returns_the_count_so_far() {
        let trash = FakeTrash {
            replies: std::sync::Mutex::new(
                [Ok(200), Err(KbError::Internal("锁超时".to_owned()))]
                    .into_iter()
                    .collect(),
            ),
            calls: std::sync::atomic::AtomicUsize::new(0),
        };
        assert_eq!(purge_trash_in_batches(&trash).await, 200);
        assert_eq!(trash.calls.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[test]
    fn repair_guard_is_the_larger_of_50_blocks_and_20_percent_of_the_metadata() {
        // 小库:下限 50 块生效。恰好 50 块还修,51 块就拦
        assert!(!exceeds_repair_guard(50, 100));
        assert!(exceeds_repair_guard(51, 100));
        assert!(!exceeds_repair_guard(0, 0));
        // 元数据块数 × 20% 超过 50 之后,按比例:300 块的 20% 是 60
        assert!(!exceeds_repair_guard(60, 300));
        assert!(exceeds_repair_guard(61, 300));
        // 大库(sampleproj 约 11.2 万块):几十块的零星差异照修,成片的差异不修
        assert!(!exceeds_repair_guard(4, 112_583));
        assert!(!exceeds_repair_guard(22_516, 112_583));
        assert!(exceeds_repair_guard(22_517, 112_583));
        // 不能因为乘法溢出而放行
        assert!(exceeds_repair_guard(usize::MAX, usize::MAX));
    }

    #[test]
    fn quality_verdict_needs_a_baseline_and_a_real_drop() {
        // 第一期没有基线:只记数字,不判回退
        assert_eq!(
            judge_quality(&measure(0.6, None)),
            QualityVerdict::NoBaseline
        );
        // 正好跌 5% 是边界:计划写的是「跌 >0.05」,所以不算回退(浮点误差要留余量)
        assert_eq!(
            judge_quality(&measure(0.75, Some(0.80))),
            QualityVerdict::Steady
        );
        // 变好、持平都不算
        assert_eq!(
            judge_quality(&measure(0.90, Some(0.80))),
            QualityVerdict::Steady
        );
        // 真正跌了才带出跌幅
        match judge_quality(&measure(0.74, Some(0.80))) {
            QualityVerdict::Dropped { delta } => assert!((delta - 0.06).abs() < 1e-9),
            other => panic!("应判为回退:{other:?}"),
        }
    }
}
