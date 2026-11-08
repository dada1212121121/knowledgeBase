//! `kb backup`(设置页「备份」的 CLI 入口):create / list / delete / verify / prune。
//!
//! 只有 `create` 会打开元数据库(备份不需要 LanceDB 与嵌入模型,所以嵌入模型没装好时也能备份);
//! `list` / `prune` / `delete` 只动归档目录,不碰数据库 —— 打开它会建库、跑迁移。
//! 定时备份由守护进程的调度器负责(`[backup] enabled`),这里只管手动操作。
//!
//! `verify` 是**恢复流程的第一步**(只读):把归档解压一遍,检查 gzip 的 CRC、每个 tar 头的
//! 校验和、`manifest.json` 与 `meta.db` 是否自洽。完整的恢复步骤见 `docs/BACKUP_RESTORE.md`。
//!
//! **异地副本**(`[backup] mirror_dirs`):`create` 会把归档再复制到这些目录,`list` 会显示
//! 每个目录里有没有最新那份;复制失败不影响本机备份,但会进 `backups/.failures.json` 的告警。
//! 副本落盘后会回读比对 sha256,所以“复制成功”意味着副本内容与本机归档一致。
//!
//! **自动校验**:每份备份写完之后服务端自己跑一次 `verify`,结论落在 `backups/.verify.json`。
//! `create` 与 `list` 都会把它打出来(`最近校验`),不必再手动跑一次才知道备份能不能用。

use std::process::ExitCode;
use std::sync::Arc;

use kb_core::config::{BackupConfig, Config};
use kb_core::paths::KbPaths;
use kb_core::{KbError, Result};
use kb_service::backup::{
    BackupOptions, BackupPolicy, BackupService, DbSnapshot, LastCheck, MirrorStatus, PruneReport,
};

use crate::error::CliError;
use crate::runtime::MetaDbSnapshot;

/// `kb backup` 的子命令。
pub enum BackupAction {
    /// 立即新建一份备份。
    Create {
        /// 把原件(sources)也打进归档。
        include_sources: bool,
        /// 输出 JSON。
        json: bool,
    },
    /// 列出已有备份。
    List {
        /// 输出 JSON。
        json: bool,
    },
    /// 删除一份备份。
    Delete {
        /// 归档文件名。
        name: String,
    },
    /// 校验一份归档(只读;恢复前先跑)。
    Verify {
        /// 归档文件名。
        name: String,
        /// 输出 JSON。
        json: bool,
    },
    /// 按保留策略清理旧备份。
    Prune {
        /// 覆盖保留份数。
        keep: Option<u64>,
        /// 覆盖保留天数。
        days: Option<u64>,
        /// 只列不删。
        dry_run: bool,
        /// 输出 JSON。
        json: bool,
    },
}

/// 不打包时用的快照端口。
///
/// `list` / `prune` / `delete` 只动归档目录,**不该打开元数据库** ——
/// 打开它会建库、跑迁移(手工冒烟时就因此在 `~/.kb` 里凭空建出了 `meta.db`)。
struct NoSnapshot;

#[async_trait::async_trait]
impl DbSnapshot for NoSnapshot {
    async fn snapshot_to(&self, _dest: &std::path::Path) -> Result<()> {
        Err(KbError::Internal(
            "这个子命令不需要数据库快照(只有 `kb backup create` 才打包元数据库)".to_owned(),
        ))
    }
}

/// 备份服务(策略取当前配置的 `[backup]`)。
///
/// `with_snapshot = false` 时不打开元数据库。
fn service(
    paths: &KbPaths,
    config: &Config,
    with_snapshot: bool,
) -> std::result::Result<BackupService, CliError> {
    let snapshot: Arc<dyn DbSnapshot> = if with_snapshot {
        Arc::new(MetaDbSnapshot::open(paths, config)?)
    } else {
        Arc::new(NoSnapshot)
    };
    Ok(BackupService::new(paths.clone(), snapshot)
        .with_extra_snapshotter(Arc::new(crate::runtime::MetaFileSnapshotter))
        .with_policy(BackupPolicy::from_config(&config.backup)))
}

/// 执行子命令。
pub async fn run(
    paths: &KbPaths,
    config: &Config,
    action: BackupAction,
) -> std::result::Result<ExitCode, CliError> {
    match action {
        BackupAction::Create {
            include_sources,
            json,
        } => {
            // 只有打包才需要元数据库快照
            let service = service(paths, config, true)?;
            create(&service, include_sources, json).await
        }
        BackupAction::List { json } => list(&service(paths, config, false)?, json),
        BackupAction::Delete { name } => delete(&service(paths, config, false)?, &name),
        BackupAction::Verify { name, json } => verify(&service(paths, config, false)?, &name, json),
        BackupAction::Prune {
            keep,
            days,
            dry_run,
            json,
        } => prune(&service(paths, config, false)?, keep, days, dry_run, json),
    }
}

/// 立即备份。
async fn create(
    service: &BackupService,
    include_sources: bool,
    json: bool,
) -> std::result::Result<ExitCode, CliError> {
    let entry = service.create(&BackupOptions { include_sources }).await?;
    if json {
        print_json(&entry)?;
        return Ok(ExitCode::SUCCESS);
    }
    println!(
        "已备份 {}:{}({})",
        entry.name,
        timestamp_text(entry.created_at),
        format_bytes(entry.size_bytes)
    );
    println!("归档目录:{}", service.dir().display());
    if entry.skipped > 0 {
        println!(
            "有 {} 个文件被跳过(名字非法或超过 8 GiB),详见归档里的 manifest.json",
            entry.skipped
        );
    }
    // 异地副本:复制失败不影响本次备份,但要让人看见(同一份记录也会挂到设置页横幅上)
    let mirrors = service.mirrors();
    for mirror in &mirrors {
        println!("异地副本 {}", mirror_line(mirror));
    }
    // 服务端写完就自己验过一遍:结论直接打出来,不用再手动 `kb backup verify`
    if let Some(check) = service
        .last_check()
        .filter(|check| check.name == entry.name)
    {
        println!("自动校验 {}", check_line(&check));
    }
    Ok(ExitCode::SUCCESS)
}

/// 列出归档(顺带打印保留策略、下次自动备份时间与异地副本状态)。
fn list(service: &BackupService, json: bool) -> std::result::Result<ExitCode, CliError> {
    let status = service.status()?;
    if json {
        print_json(&status)?;
        return Ok(ExitCode::SUCCESS);
    }
    println!("数据目录:{}", status.home);
    println!("归档目录:{}", status.dir);
    println!(
        "定时备份:{};保留:{};下次:{}",
        if status.policy.enabled {
            format!("每 {} 小时", status.policy.interval_hours)
        } else {
            "关闭".to_owned()
        },
        retention_text(&status.policy),
        status
            .next_backup_at
            .map(timestamp_text)
            .unwrap_or_else(|| "—".to_owned()),
    );
    for mirror in &status.mirrors {
        println!("异地副本 {}", mirror_line(mirror));
    }
    if let Some(check) = &status.last_check {
        println!(
            "最近校验 {}:{}",
            timestamp_text(check.at),
            check_line(check)
        );
    }
    if status.entries.is_empty() {
        println!("还没有备份。");
        return Ok(ExitCode::SUCCESS);
    }
    println!();
    println!("{:<34} {:>10}  时间", "归档", "大小");
    for entry in &status.entries {
        println!(
            "{:<34} {:>10}  {}",
            entry.name,
            format_bytes(entry.size_bytes),
            timestamp_text(entry.created_at)
        );
    }
    println!();
    println!(
        "共 {} 份,占用 {}",
        status.entries.len(),
        format_bytes(status.usage.backups_bytes)
    );
    Ok(ExitCode::SUCCESS)
}

/// 删除一份归档。
fn delete(service: &BackupService, name: &str) -> std::result::Result<ExitCode, CliError> {
    service.delete(name)?;
    println!("已删除 {name}");
    Ok(ExitCode::SUCCESS)
}

/// 校验一份归档(只读:不解包到 KB_HOME,也不碰数据库)。
fn verify(
    service: &BackupService,
    name: &str,
    json: bool,
) -> std::result::Result<ExitCode, CliError> {
    let check = service.verify(name)?;
    if json {
        print_json(&check)?;
        return Ok(ExitCode::SUCCESS);
    }
    println!("归档 {} 校验通过", check.name);
    println!(
        "生成时间:{};kb 版本:{};{}",
        timestamp_text(check.created_at),
        check.version,
        if check.include_sources {
            "含原件(sources)"
        } else {
            "不含原件"
        }
    );
    println!(
        "内容:{} 个文件,解压后 {};元数据库 {};配置 {}",
        check.files,
        format_bytes(check.uncompressed_bytes),
        format_bytes(check.meta_db_bytes),
        if check.config_present {
            "在"
        } else {
            "没有(全新实例可以没有)"
        }
    );
    println!("顶层条目:{}", check.roots.join("、"));
    if !check.skipped.is_empty() {
        println!(
            "注意:备份时有 {} 个文件被跳过(详见归档里的 manifest.json)",
            check.skipped.len()
        );
    }
    Ok(ExitCode::SUCCESS)
}

/// 按保留策略清理(可用 `--keep` / `--days` 覆盖配置)。
fn prune(
    service: &BackupService,
    keep: Option<u64>,
    days: Option<u64>,
    dry_run: bool,
    json: bool,
) -> std::result::Result<ExitCode, CliError> {
    if keep.is_some() || days.is_some() {
        // 命令行覆盖只影响这一次(服务是本次命令新建的,不写回配置文件)。
        // 这里不走配置校验,所以范围自己卡住:否则 `--days` 的溢出会在 prune 里变成“全删”。
        let mut policy = service.policy();
        if let Some(keep) = keep {
            if keep > BackupConfig::MAX_KEEP_COUNT {
                return Err(CliError::Kb(KbError::InvalidInput(format!(
                    "--keep 不能超过 {}(当前 {keep})",
                    BackupConfig::MAX_KEEP_COUNT
                ))));
            }
            policy.keep_count = keep;
        }
        if let Some(days) = days {
            if days > BackupConfig::MAX_KEEP_DAYS {
                return Err(CliError::Kb(KbError::InvalidInput(format!(
                    "--days 不能超过 {}(当前 {days})",
                    BackupConfig::MAX_KEEP_DAYS
                ))));
            }
            policy.keep_days = days;
        }
        service.set_policy(policy);
    }
    let report = service.prune(dry_run)?;
    let (text, code) = prune_outcome(&report, &service.policy(), dry_run, json)?;
    print!("{text}");
    Ok(ExitCode::from(code))
}

/// 清理结果的渲染与退出码(纯函数:不打印、不删文件,便于单测)。
///
/// 退出码规则:**只要 `failed` 非空就返回 1**,与输出模式(`--json` / 文本)无关 ——
/// 脚本判断成败不该因为加了 `--json` 就失效;而“要删的全都删不掉”也不能被当成
/// “没有需要清理的归档”报成功。
fn prune_outcome(
    report: &PruneReport,
    policy: &BackupPolicy,
    dry_run: bool,
    json: bool,
) -> std::result::Result<(String, u8), CliError> {
    let code = u8::from(!report.failed.is_empty());
    if json {
        let text = serde_json::to_string_pretty(report)
            .map_err(|err| KbError::Internal(format!("序列化输出失败: {err}")))?;
        return Ok((format!("{text}\n"), code));
    }
    let mut out = String::new();
    if report.removed.is_empty() && report.failed.is_empty() {
        out.push_str(&format!(
            "没有需要清理的归档(保留 {} 份,策略:{})。\n",
            report.kept,
            retention_text(policy)
        ));
        return Ok((out, code));
    }
    for name in &report.removed {
        out.push_str(&format!(
            "{}{name}\n",
            if dry_run { "将删除 " } else { "已删除 " }
        ));
    }
    if !report.removed.is_empty() {
        out.push_str(&format!(
            "{} {} 份,保留 {} 份\n",
            if dry_run {
                "预演:会删除"
            } else {
                "共删除"
            },
            report.removed.len(),
            report.kept
        ));
    }
    for (name, reason) in &report.failed {
        out.push_str(&format!("删除失败 {name}:{reason}\n"));
    }
    if !report.failed.is_empty() {
        // 失败同时进了告警通道(设置页与外壳横幅都读 `.failures.json`),这里提醒一句
        out.push_str("清理失败已记入备份告警(设置页「备份」与页面横幅可见)\n");
    }
    Ok((out, code))
}

/// 保留策略的人话。
fn retention_text(policy: &BackupPolicy) -> String {
    match (policy.keep_count, policy.keep_days) {
        (0, 0) => "不自动清理".to_owned(),
        (count, 0) => format!("留最近 {count} 份"),
        (0, days) => format!("只留 {days} 天内的"),
        (count, days) => format!("留最近 {count} 份且 {days} 天内的"),
    }
}

/// 一个异地目录的一行说明。
///
/// `has_latest` 是“目录里有没有最新那份归档”——`create` 之后看它就是这次复制成没成。
fn mirror_line(mirror: &MirrorStatus) -> String {
    let mut text = format!("{}:", mirror.dir);
    match (&mirror.last_error, mirror.has_latest) {
        (_, true) => text.push_str("最新一份已在"),
        (Some(error), false) => text.push_str(&format!("最新一份不在,上次失败:{error}")),
        (None, false) => text.push_str("最新一份不在"),
    }
    text.push_str(&format!("({} 份", mirror.copies));
    // 时间取更近的那一次:失败之后还说“上次复制 …”会让人以为刚刚复制成功
    if mirror.error_at > mirror.last_ok_at && mirror.error_at > 0 {
        text.push_str(&format!(",失败于 {}", timestamp_text(mirror.error_at)));
    } else if mirror.last_ok_at > 0 {
        text.push_str(&format!(",上次复制 {}", timestamp_text(mirror.last_ok_at)));
    }
    text.push(')');
    text
}

/// 最近一次自动校验的一行说明(通过 / 没通过)。
///
/// 没通过时**只报原因**:`kb backup verify` 能给出更细的内容统计,这里要的是一眼看出
/// “这份备份能不能拿去恢复”。
fn check_line(check: &LastCheck) -> String {
    match &check.error {
        Some(error) => format!("{} 没通过:{error}", check.name),
        None => format!(
            "{} 通过({} 个文件,解压后 {};元数据库 {})",
            check.name,
            check.files,
            format_bytes(check.uncompressed_bytes),
            format_bytes(check.meta_db_bytes)
        ),
    }
}

/// 时间戳(站点时区,与归档名 / 界面一致)。
fn timestamp_text(millis: i64) -> String {
    use chrono::TimeZone;
    kb_core::timezone::site_timezone()
        .timestamp_millis_opt(millis)
        .single()
        .map(|datetime| datetime.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| "-".to_owned())
}

/// 人读的字节数。
fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// 打印 JSON。
fn print_json<T: serde::Serialize>(value: &T) -> std::result::Result<(), CliError> {
    let text = serde_json::to_string_pretty(value)
        .map_err(|err| kb_core::KbError::Internal(format!("序列化输出失败: {err}")))?;
    println!("{text}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(removed: &[&str], failed: &[(&str, &str)], kept: usize) -> PruneReport {
        PruneReport {
            removed: removed.iter().map(|name| (*name).to_owned()).collect(),
            failed: failed
                .iter()
                .map(|(name, reason)| ((*name).to_owned(), (*reason).to_owned()))
                .collect(),
            kept,
            dry_run: false,
        }
    }

    fn policy() -> BackupPolicy {
        BackupPolicy::default()
    }

    #[test]
    fn prune_reports_success_and_failure_together() {
        // 有成功也有失败:两条都打印,退出码 1
        let report = report(&["a.tar.gz"], &[("b.tar.gz", "permission denied")], 3);
        let (text, code) = prune_outcome(&report, &policy(), false, false).expect("渲染");
        assert!(text.contains("已删除 a.tar.gz"), "{text}");
        assert!(
            text.contains("删除失败 b.tar.gz:permission denied"),
            "{text}"
        );
        assert!(text.contains("共删除 1 份,保留 3 份"), "{text}");
        assert_eq!(code, 1, "有删不掉的归档就不能报成功");
    }

    #[test]
    fn prune_does_not_swallow_an_all_failed_run() {
        // 要删的一份都没删成:不能打印“没有需要清理”,退出码 1(原始缺陷)
        let report = report(&[], &[("b.tar.gz", "read-only fs")], 3);
        let (text, code) = prune_outcome(&report, &policy(), false, false).expect("渲染");
        assert!(!text.contains("没有需要清理"), "{text}");
        assert!(text.contains("删除失败 b.tar.gz:read-only fs"), "{text}");
        assert_eq!(code, 1);
    }

    #[test]
    fn prune_json_keeps_the_failure_exit_code() {
        let report = report(&[], &[("b.tar.gz", "read-only fs")], 3);
        let (text, code) = prune_outcome(&report, &policy(), false, true).expect("渲染");
        assert!(text.contains("\"failed\""), "{text}");
        assert_eq!(code, 1, "--json 不该把失败吞成 0");
    }

    #[test]
    fn prune_says_nothing_to_do_only_when_nothing_happened() {
        let report = report(&[], &[], 3);
        let (text, code) = prune_outcome(&report, &policy(), false, false).expect("渲染");
        assert!(text.contains("没有需要清理的归档"), "{text}");
        assert_eq!(code, 0);
    }

    #[test]
    fn prune_dry_run_phrases_are_future_tense() {
        let report = report(&["a.tar.gz"], &[], 2);
        let (text, code) = prune_outcome(&report, &policy(), true, false).expect("渲染");
        assert!(text.contains("将删除 a.tar.gz"), "{text}");
        assert!(text.contains("预演:会删除 1 份,保留 2 份"), "{text}");
        assert_eq!(code, 0);
    }

    #[test]
    fn prune_failure_output_points_at_the_alert_channel() {
        // 删不掉不只在终端里说一句:它同时进了 `.failures.json` 的告警,输出里要提一句,
        // 否则用户看完终端就以为“只有这一个地方提示过”。
        let failed = report(&[], &[("b.tar.gz", "read-only fs")], 3);
        let (text, _) = prune_outcome(&failed, &policy(), false, false).expect("渲染");
        assert!(text.contains("备份告警"), "{text}");
        // 没有失败时不提
        let cleaned = report(&["a.tar.gz"], &[], 2);
        let (text, _) = prune_outcome(&cleaned, &policy(), false, false).expect("渲染");
        assert!(!text.contains("备份告警"), "{text}");
    }

    fn mirror(dir: &str, copies: usize, has_latest: bool, error: Option<&str>) -> MirrorStatus {
        MirrorStatus {
            dir: dir.to_owned(),
            last_ok_at: 1_700_000_000_000,
            last_error: error.map(|text| text.to_owned()),
            // 失败比上次成功更近:一行里该显示失败时间
            error_at: if error.is_some() {
                1_700_000_100_000
            } else {
                0
            },
            copies,
            has_latest,
        }
    }

    #[test]
    fn mirror_lines_say_whether_the_latest_archive_arrived() {
        let copied = mirror_line(&mirror("/mnt/usb/kb", 3, true, None));
        assert!(copied.contains("/mnt/usb/kb"), "{copied}");
        assert!(copied.contains("最新一份已在"), "{copied}");
        assert!(copied.contains("3 份"), "{copied}");

        // 复制失败:原因要出现在这一行里(外接盘没挂上是最常见的),
        // 时间说“失败于”而不是上一次成功的“上次复制”
        let broken = mirror_line(&mirror("/mnt/usb/kb", 0, false, Some("建目录失败")));
        assert!(broken.contains("最新一份不在"), "{broken}");
        assert!(broken.contains("建目录失败"), "{broken}");
        assert!(broken.contains("失败于"), "{broken}");
        assert!(!broken.contains("上次复制"), "{broken}");

        // 还没复制过、也没有失败记录
        let fresh = mirror_line(&mirror("/mnt/usb/kb", 0, false, None));
        assert!(fresh.contains("最新一份不在"), "{fresh}");
        assert!(fresh.contains("0 份"), "{fresh}");
    }

    fn last_check(ok: bool) -> LastCheck {
        LastCheck {
            at: 1_700_000_000_000,
            name: "kb-20261024-120000.tar.gz".to_owned(),
            ok,
            error: (!ok).then(|| "归档里没有 meta.db(不是 kb 备份?)".to_owned()),
            files: if ok { 7 } else { 0 },
            uncompressed_bytes: if ok { 2_048 } else { 0 },
            meta_db_bytes: if ok { 1_024 } else { 0 },
        }
    }

    #[test]
    fn check_lines_say_whether_the_backup_can_be_restored() {
        let passed = check_line(&last_check(true));
        assert!(passed.contains("kb-20261024-120000.tar.gz"), "{passed}");
        assert!(passed.contains("通过"), "{passed}");
        assert!(passed.contains("7 个文件"), "{passed}");
        assert!(passed.contains("2.0 KB"), "{passed}");

        // 没通过时要说清为什么 —— 一份解不开的备份等于没有备份
        let failed = check_line(&last_check(false));
        assert!(failed.contains("没通过"), "{failed}");
        assert!(failed.contains("meta.db"), "{failed}");
        assert!(!failed.contains("通过("), "{failed}");
    }
}
