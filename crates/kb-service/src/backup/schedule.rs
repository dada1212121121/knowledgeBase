//! 定时备份与保留策略:`run_auto` / `prune`,以及失败告警的记账。
//!
//! **「到点」以归档目录里最新一份的时间为准**,不靠内存状态,重启后不会重复备份。
//! 清理只在自动备份成功后(以及手动 prune)跑,调低保留份数不会立刻删归档;
//! 打包失败时仍会清理一次 —— 磁盘写满时保留策略恰恰最该生效。

use super::*;

impl BackupService {
    /// 读 `.failures.json`(坏文件 / 不存在都当作空)。
    pub(crate) fn failure_log(&self) -> FailureLog {
        let Ok(text) = std::fs::read_to_string(self.dir().join(FAILURES_FILE)) else {
            return FailureLog::default();
        };
        serde_json::from_str(&text).unwrap_or_default()
    }

    /// 写 `.failures.json`(失败只告警:记录写不进去不该影响备份本身)。
    pub(crate) fn write_failure_log(&self, log: &FailureLog) {
        let path = self.dir().join(FAILURES_FILE);
        match serde_json::to_vec_pretty(log) {
            Ok(bytes) => {
                if let Err(err) = std::fs::write(&path, bytes) {
                    tracing::warn!(error = %err, path = %path.display(), "写备份失败记录失败");
                }
            }
            Err(err) => tracing::warn!(error = %err, "序列化备份失败记录失败"),
        }
    }

    /// 最近一次**自动校验**的结果(读 `.verify.json`;坏文件 / 不存在都当作没有)。
    pub fn last_check(&self) -> Option<LastCheck> {
        let text = std::fs::read_to_string(self.dir().join(VERIFY_FILE)).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// 写 `.verify.json`(写不进去只告警:它不参与备份成败的判断)。
    pub(crate) fn write_last_check(&self, check: &LastCheck) {
        let path = self.dir().join(VERIFY_FILE);
        match serde_json::to_vec_pretty(check) {
            Ok(bytes) => {
                if let Err(err) = std::fs::write(&path, bytes) {
                    tracing::warn!(error = %err, path = %path.display(), "写备份校验结果失败");
                }
            }
            Err(err) => tracing::warn!(error = %err, "序列化备份校验结果失败"),
        }
    }

    /// 记下这次自动校验的结果(状态文件 + 失败告警)。
    ///
    /// 校验没过**不删归档**(解不开的归档也是现场证据),但要让它在横幅与失败历史里露出来 ——
    /// 一份解不开的备份等于没有备份,不能只在日志里说一句。下次校验通过时告警自然消失。
    pub(crate) fn record_check(
        &self,
        name: &str,
        trigger: BackupTrigger,
        check: Result<ArchiveCheck>,
    ) -> LastCheck {
        let at = now_millis();
        let last = match check {
            Ok(check) => LastCheck {
                at,
                name: name.to_owned(),
                ok: true,
                error: None,
                files: check.files,
                uncompressed_bytes: check.uncompressed_bytes,
                meta_db_bytes: check.meta_db_bytes,
            },
            Err(err) => LastCheck {
                at,
                name: name.to_owned(),
                ok: false,
                error: Some(failure_reason(&err)),
                files: 0,
                uncompressed_bytes: 0,
                meta_db_bytes: 0,
            },
        };
        self.write_last_check(&last);
        match &last.error {
            None => self.record_success(BackupFailureKind::Verify),
            Some(error) => {
                // 横幅上已经说了“校验在 … 失败”,这里只说哪一份、为什么
                self.record_failure(
                    trigger,
                    BackupFailureKind::Verify,
                    format!("自动校验 {name} 没通过:{error}"),
                );
            }
        }
        last
    }

    /// 这一拍该不该自动备份(`now` 是 unix 毫秒)。
    ///
    /// 判据只看**归档目录里最新一份的时间**:从没备份过就立刻备份,否则距上次不足
    /// `interval_hours` 就不动。这样重启后不会重复备份,也不需要在内存里记状态。
    pub fn due(&self, now: Millis) -> bool {
        let policy = self.policy();
        if !policy.enabled {
            return false;
        }
        let entries = match self.entries() {
            Ok(entries) => entries,
            // 目录读不出来时不当成到点:否则每拍都重试并刷日志
            Err(err) => {
                tracing::warn!(error = %err, "读取备份目录失败,跳过本次定时备份判断");
                return false;
            }
        };
        match entries.first() {
            None => true,
            Some(newest) => now.saturating_sub(newest.created_at) >= policy.interval_millis(),
        }
    }

    /// 按保留策略清理旧归档(手动触发)。
    ///
    /// **最新一份永远保留**;`keep_count` / `keep_days` 为 0 表示不按那一维清理。
    /// `dry_run` 只列不删。单个删除失败不中断整轮(记进 `failed`),并**进告警**
    /// (`.failures.json` + WS `backup.failed` + 页面横幅),不只留在页面提示与日志里。
    pub fn prune(&self, dry_run: bool) -> Result<PruneReport> {
        self.prune_with(dry_run, BackupTrigger::Manual)
    }

    /// 按保留策略清理旧归档,并记下触发方式(定时清理用 [`BackupTrigger::Auto`])。
    pub fn prune_with(&self, dry_run: bool, trigger: BackupTrigger) -> Result<PruneReport> {
        let policy = self.policy();
        let entries = self.entries()?;
        let now = now_millis();
        let mut victims: Vec<String> = Vec::new();
        for (index, entry) in entries.iter().enumerate() {
            // entries 已按时间倒序:第 0 份是最新的
            if index == 0 {
                continue;
            }
            let beyond_count = policy.keep_count > 0 && index as u64 >= policy.keep_count;
            // `keep_days` 是 u64:直接 `as i64` 在超大的值上会变成负数,进而把所有归档都判成“太旧”。
            // 命令行 `--days` 不经过配置校验,所以这里自己做饱和转换。
            let age_limit = i64::try_from(policy.keep_days)
                .unwrap_or(i64::MAX)
                .saturating_mul(DAY_MS);
            let too_old = policy.keep_days > 0 && now.saturating_sub(entry.created_at) > age_limit;
            if beyond_count || too_old {
                victims.push(entry.name.clone());
            }
        }
        let mut report = PruneReport {
            removed: Vec::new(),
            failed: Vec::new(),
            kept: entries.len(),
            dry_run,
        };
        for name in victims {
            if dry_run {
                // 预演的 `kept` 必须是**清理后**的份数,否则“会删除 3 份,保留 5 份”自相矛盾
                report.removed.push(name);
                report.kept = report.kept.saturating_sub(1);
                continue;
            }
            match self.delete_local(&name) {
                Ok(()) => {
                    report.removed.push(name.clone());
                    report.kept -= 1;
                    // 本机删掉了才动异地副本:本机删不掉时至少还留着一份
                    report.failed.extend(self.delete_mirrors(&name));
                }
                Err(err) => {
                    tracing::warn!(archive = %name, error = %err, "删除旧备份失败");
                    report.failed.push((name, err.to_string()));
                }
            }
        }
        // 从旧到新,便于阅读
        report.removed.reverse();
        if !dry_run {
            self.record_prune_outcome(&report, trigger);
        }
        Ok(report)
    }

    /// 把一次清理的结果写进告警:有删不掉的就记一条失败,全都删成了就把上一次的告警解决掉。
    ///
    /// 预演(`dry_run`)不调用这里 —— 什么都没删,不该产生告警。
    pub(crate) fn record_prune_outcome(&self, report: &PruneReport, trigger: BackupTrigger) {
        if report.failed.is_empty() {
            if !report.removed.is_empty() {
                self.record_success(BackupFailureKind::Prune);
            }
            return;
        }
        // 只列前两条原因:横幅上要能读完,完整清单在 `prune` 的返回值与日志里
        let detail = report
            .failed
            .iter()
            .take(2)
            .map(|(name, reason)| format!("{name}({reason})"))
            .collect::<Vec<_>>()
            .join("、");
        let rest = report.failed.len().saturating_sub(2);
        let tail = if rest > 0 {
            format!(",另有 {rest} 份")
        } else {
            String::new()
        };
        // 横幅上已经说了“清理在 … 失败”,这里只需要说清哪几份删不掉
        self.record_failure(
            trigger,
            BackupFailureKind::Prune,
            format!("删不掉 {} 份:{detail}{tail}", report.failed.len()),
        );
    }

    /// 定时备份:到点就打包 + 按策略清理;不到点(或未启用)返回 `None`。
    ///
    /// 打包失败时**仍然按策略清理一次**:磁盘写满导致备份失败是最典型的情形,
    /// 而那时保留策略恰恰最需要生效。失败原因写进 `.last-run.json`。
    pub async fn run_auto(&self, now: Millis) -> Result<Option<AutoBackup>> {
        if !self.due(now) {
            return Ok(None);
        }
        let policy = self.policy();
        let created = self
            .create_with(
                &BackupOptions {
                    include_sources: policy.include_sources,
                },
                BackupTrigger::Auto,
            )
            .await;
        // 先清理:不管打包成没成,旧的归档都该按策略收敛
        let pruned = match self.prune_with(false, BackupTrigger::Auto) {
            Ok(report) => report,
            Err(err) => {
                tracing::warn!(error = %err, "定时备份后的清理失败");
                // 整轮清理都没跑起来(读目录失败等)也要进告警,不能只留一行日志
                self.record_failure(
                    BackupTrigger::Auto,
                    BackupFailureKind::Prune,
                    format!("清理没跑起来:{err}"),
                );
                // 清理失败时别把 `kept` 写成 0(日志里会变成“保留了 0 份”):
                // 用目录里实际的份数兜底
                PruneReport {
                    kept: self.entries().map(|entries| entries.len()).unwrap_or(0),
                    ..PruneReport::default()
                }
            }
        };
        match created {
            Ok(entry) => {
                self.write_last_run(&LastAutoRun {
                    at: now_millis(),
                    ok: true,
                    error: None,
                });
                Ok(Some(AutoBackup { entry, pruned }))
            }
            Err(err) => {
                self.write_last_run(&LastAutoRun {
                    at: now_millis(),
                    ok: false,
                    error: Some(err.to_string()),
                });
                Err(err)
            }
        }
    }

    /// 最近一次自动备份的结果(读 `.last-run.json`;坏文件当作没有)。
    pub fn last_auto(&self) -> Option<LastAutoRun> {
        let text = std::fs::read_to_string(self.dir().join(LAST_RUN_FILE)).ok()?;
        serde_json::from_str(&text).ok()
    }

    /// 写最近一次自动备份的结果(失败只告警:不该因为写不进去而让备份本身报错)。
    pub(crate) fn write_last_run(&self, run: &LastAutoRun) {
        let path = self.dir().join(LAST_RUN_FILE);
        match serde_json::to_vec_pretty(run) {
            Ok(bytes) => {
                if let Err(err) = std::fs::write(&path, bytes) {
                    tracing::warn!(error = %err, path = %path.display(), "写备份结果失败");
                }
            }
            Err(err) => tracing::warn!(error = %err, "序列化备份结果失败"),
        }
    }

    /// 记一次失败(落盘 + 通知观察者)。
    pub(crate) fn record_failure(
        &self,
        trigger: BackupTrigger,
        kind: BackupFailureKind,
        error: impl Into<String>,
    ) {
        let failure = BackupFailure {
            at: now_millis(),
            trigger,
            kind,
            error: error.into(),
        };
        let mut log = self.failure_log();
        log.failures.insert(0, failure.clone());
        log.failures.truncate(MAX_FAILURES);
        self.write_failure_log(&log);
        if let Some(observer) = &self.observer {
            observer.failed(&failure);
        }
    }

    /// 记一次成功(把**该环节**的告警“解决”掉;失败历史保留,设置页仍能看)。
    ///
    /// 没有失败历史时不写文件:正常运行时备份目录里只该有归档。
    pub(crate) fn record_success(&self, kind: BackupFailureKind) {
        let mut log = self.failure_log();
        if log.failures.is_empty() {
            return;
        }
        log.resolve(kind, now_millis());
        self.write_failure_log(&log);
    }
}
