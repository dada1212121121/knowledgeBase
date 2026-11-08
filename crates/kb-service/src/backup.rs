//! 手动与定时备份(设置页「备份」分区)。
//!
//! 定位:**把 KB_HOME 里“丢了就找不回来”的部分打成一个 `tar.gz`**,放到
//! `<KB_HOME>/backups/`。刻意不做的事(避免过度设计):
//!
//! - **不备份向量表**(`lance/`)与模型(`models/`):体积最大,而且重建索引就能恢复;
//! - **不备份 `secrets.toml`**:里面有 API key,备份文件常被拷来拷去,默认不带;
//! - **不做在线恢复**:恢复要停守护进程、覆盖 KB_HOME,风险高于收益。归档是标准
//!   `tar.gz`,手工解包即可(步骤写在设置页的说明里)。
//!
//! 数据库用 SQLite 自己的 `VACUUM INTO` 取一致性快照(经 [`DbSnapshot`] 端口注入),
//! 所以守护进程在跑的时候也能备份,不需要停服。
//!
//! 定时备份与保留策略见 [`BackupPolicy`]:守护进程每拍调 [`BackupService::run_auto`],
//! 到点才真的打包,打包完按策略删掉多余的归档。**“到点”以归档目录里最新一份的时间为准**,
//! 不靠内存状态,重启后不会重复备份。
//!
//! **清理时机**:自动备份成功后、以及手动 `prune`(CLI / 页面「按策略清理」)。
//! 调度器**不会**每拍单独清理 —— 调低保留份数不会立刻删归档,而是在下一次自动备份之后生效。
//! 打包失败时仍会按策略清理一次(磁盘写满时保留策略恰恰最该生效)。
//!
//! 归档布局(解包到 KB_HOME 即为原样):
//! ```text
//! manifest.json   备份说明(时间 / 版本 / 范围)
//! config.toml     配置(不存在就跳过)
//! meta.db         元数据库快照
//! skills/**       skills 清单
//! eval/**         评测历史与黄金集
//! sources/**      原件(可选,`include_sources = true` 时才有)
//! ```
//!
//! **打包进度**:`create` 会边写边把进度落到 `backups/.progress.json`(节流 400ms),
//! 并通过 [`BackupObserver`] 推给 Web(WS 的 `backup.progress`)。守护进程与能力调用各自
//! new 一个服务实例,内存状态互相看不见,所以进度也要落盘。
//!
//! **失败告警**:打包、清理(`prune`)、异地复制这三处的失败都会把「时间 + 触发方式 + 环节 + 原因」
//! 追加到 `backups/.failures.json`,并由 [`BackupService::alert`] 判定是否仍未解决(该环节之后
//! 有成功就算解决)—— 设置页与外壳横幅都读这一份,不只看 `.last-run.json` 的自动备份结果。
//!
//! **异地 / 外部存储**:`[backup] mirror_dirs` 里的每个目录都会拿到一份归档副本(见
//! [`BackupService::mirror_dirs`])。复制失败**不让本次备份失败**(本机已经有一份),但会进同一套
//! 失败告警;清理与删除也会同步到这些目录,不留“删不掉的副本”。
//!
//! **复制后校验**:每份副本改名落盘之后都会**回读一遍**算 sha256,与本机归档比对;对不上(或副本
//! 读不回来)就当成复制失败(删掉那份副本并记 `mirror` 告警),不让“目录里有一份、但内容是坏的”
//! 冒充已同步。
//!
//! **自动校验**:每份归档写完之后会立刻跑一次 [`BackupService::verify`] 同一套检查(解压一遍、
//! 核对 manifest 与 meta.db),结果落在 `backups/.verify.json` 并由 `backup_status.last_check`
//! 暴露 —— 不必人手点「校验」才知道这份备份能不能拿来恢复。校验失败**不删归档**,但记一条
//! `verify` 告警(一份解不开的备份等于没备份)。
//!
//! **恢复流程**:不提供破坏性的 `restore` 子命令。归档是标准 `tar.gz`,
//! 停服 → 校验([`BackupService::verify`] / `kb backup verify`)→ 解包 → 启动;
//! 完整步骤见 `docs/BACKUP_RESTORE.md` 与设置页「恢复步骤」。
//!
//! **文件布局**:`types`(状态与策略等小类型)、`service`(打包 / 校验 / 删除)、`schedule`(定时与清理)、
//! `mirror`(异地复制)、`progress`(进度落盘)、`archive_read` / `archive_write`(自己拼的 tar)、
//! `usage`(目录用量)。本文件只留转发与测试。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use flate2::Compression;
use flate2::write::GzEncoder;
use kb_core::hash::sha256_hex_file;
use kb_core::model::Millis;
use kb_core::paths::KbPaths;
use kb_core::{KbError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod archive_read;
mod archive_write;
mod mirror;
mod progress;
mod schedule;
mod service;
mod types;
mod usage;

pub(crate) use archive_read::*;
pub(crate) use archive_write::*;
pub use mirror::MirrorStatus;
pub(crate) use mirror::*;
pub use progress::BackupProgress;
pub(crate) use progress::*;
pub use service::BackupService;
pub(crate) use types::*;
pub use types::{
    AutoBackup, BackupEntry, BackupFailure, BackupFailureKind, BackupObserver, BackupOptions,
    BackupPolicy, BackupStage, BackupState, BackupStatus, BackupTrigger, DbSnapshot, LastAutoRun,
    LastCheck, PruneReport, SqliteSnapshotter,
};
pub(crate) use usage::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_name_uses_prefix_for_long_paths() {
        let short = "skills/demo/manifest.toml";
        assert_eq!(split_name(short), Some((short, "")));
        let long = format!("sources/{}/deep/file.txt", "x".repeat(120));
        let (name, prefix) = split_name(&long).expect("应能拆成 prefix");
        assert!(name.len() <= 100);
        assert!(prefix.len() <= 155);
        assert_eq!(format!("{prefix}/{name}"), long);
        // 单段超过 100 字节且没有 `/` 可拆
        assert_eq!(split_name(&"y".repeat(120)), None);
    }

    #[test]
    fn header_checksum_matches_the_ustar_rule() {
        let header = header_bytes("a.txt", 3, 0, b'0').expect("头");
        let stored = std::str::from_utf8(&header[148..154]).expect("八进制文本");
        let stored = u64::from_str_radix(stored, 8).expect("解析校验和");
        let mut copy = header;
        for byte in copy[148..156].iter_mut() {
            *byte = b' ';
        }
        let expected: u64 = copy.iter().map(|byte| u64::from(*byte)).sum();
        assert_eq!(stored, expected);
        assert_eq!(header[156], b'0');
        assert_eq!(&header[257..262], b"ustar");
    }

    #[test]
    fn octal_fields_are_nul_terminated() {
        let mut field = [0u8; 8];
        write_octal(&mut field, 0o644, "mode").expect("写权限位");
        assert_eq!(field, *b"0000644\0");
        let mut size = [0u8; 12];
        write_octal(&mut size, 1024, "size").expect("写大小");
        assert_eq!(size, *b"00000002000\0");
    }

    #[test]
    fn octal_boundary_at_eight_gib() {
        // 11 位八进制的上限正好是 8 GiB - 1:边界能写,超过就报错
        let mut size = [0u8; 12];
        assert!(write_octal(&mut size, MAX_OCTAL_11, "size").is_ok());
        assert_eq!(size, *b"77777777777\0");
        let mut over = [0u8; 12];
        assert!(write_octal(&mut over, MAX_OCTAL_11 + 1, "size").is_err());
    }

    #[test]
    fn progress_percent_prefers_bytes_and_falls_back_to_files() {
        let mut progress = BackupProgress {
            stage: BackupStage::Packing,
            started_at: 0,
            updated_at: 0,
            files_total: 4,
            files_done: 1,
            bytes_total: 1000,
            bytes_done: 250,
            current: None,
            error: None,
        };
        assert_eq!(progress.percent(), 25, "有字节总量时按字节算");
        // 字节总量还不知道(刚开始收集文件)→ 退回按文件数
        progress.bytes_total = 0;
        assert_eq!(progress.percent(), 25);
        // 都还不知道 → 0,不 panic
        progress.files_total = 0;
        assert_eq!(progress.percent(), 0);
        // 超过总量(理论上不该发生)夹到 100
        progress.bytes_total = 10;
        progress.bytes_done = 99;
        assert_eq!(progress.percent(), 100);
    }

    #[test]
    fn octal_overflow_is_an_error_not_a_truncation() {
        // 12 字节字段只能放 11 位八进制(8 GiB);放不下必须报错,不能悄悄截断
        let mut size = [0u8; 12];
        assert!(write_octal(&mut size, 9 * 1024 * 1024 * 1024, "size").is_err());
        // 毫秒当秒写进 mtime 字段会溢出:现在由 header_bytes 先除 1000,所以头里是秒
        let header = header_bytes("a.txt", 1, 1_792_737_291_576, b'0').expect("头");
        let text = std::str::from_utf8(&header[136..147]).expect("八进制文本");
        assert_eq!(u64::from_str_radix(text, 8).expect("解析"), 1_792_737_291);
    }

    #[test]
    fn copy_hash_comparison_catches_a_byte_that_differs() {
        // 复制后校验的核心:字节数一样、内容不一样也算失败(只比长度会漏掉这种)
        let dir = tempfile::tempdir().expect("临时目录");
        let source = dir.path().join("kb.tar.gz");
        let copy = dir.path().join("copy.tar.gz");
        std::fs::write(&source, b"same-length-body-1").expect("写源文件");
        let source_hash = sha256_hex_file(&source).expect("算源哈希");

        std::fs::write(&copy, b"same-length-body-2").expect("写副本");
        assert_eq!(
            std::fs::metadata(&copy).expect("副本元数据").len(),
            std::fs::metadata(&source).expect("源元数据").len(),
            "这条用例要的就是“长度一样”"
        );
        let err = sha256_of_copy(&copy, &source_hash).expect_err("内容不同必须报错");
        assert!(err.contains("不一致"), "{err}");
        assert!(err.contains(&source_hash), "要能看出两个哈希:{err}");

        // 一模一样就通过
        std::fs::copy(&source, &copy).expect("拷一份");
        assert!(sha256_of_copy(&copy, &source_hash).is_ok());

        // 副本读不回来(被删了 / 盘掉了)也是失败,不能当成“验过了”
        std::fs::remove_file(&copy).expect("删副本");
        let err = sha256_of_copy(&copy, &source_hash).expect_err("读不回来必须报错");
        assert!(err.contains("读不回来"), "{err}");
    }

    #[test]
    fn stage_labels_cover_verifying() {
        assert_eq!(BackupStage::Verifying.label(), "校验中");
        assert!(BackupStage::Verifying.is_running(), "校验也算进行中");
        assert!(!BackupStage::Done.is_running());
    }

    /// 自动校验的记账用例只要一个不干活的快照端口。
    struct NoSnapshot;

    #[async_trait]
    impl DbSnapshot for NoSnapshot {
        async fn snapshot_to(&self, _dest: &Path) -> Result<()> {
            Err(KbError::Internal("用例不需要快照".to_owned()))
        }
    }

    #[test]
    fn a_failed_auto_check_is_recorded_as_a_verify_alert() {
        // 自动校验没过必须进同一套告警(横幅 + 失败历史),不能只在日志里说一句
        let dir = tempfile::tempdir().expect("临时目录");
        let paths = KbPaths::from_home(dir.path().join("kb"));
        paths.ensure_dirs().expect("建目录");
        let service = BackupService::new(paths, Arc::new(NoSnapshot));

        let failed = service.record_check(
            "kb-20261024-120000.tar.gz",
            BackupTrigger::Auto,
            Err(corrupt("归档里没有 meta.db(不是 kb 备份?)")),
        );
        assert!(!failed.ok, "{failed:?}");
        let alert = service.alert().expect("要有告警");
        assert_eq!(alert.kind, BackupFailureKind::Verify, "{alert:?}");
        assert_eq!(alert.trigger, BackupTrigger::Auto);
        assert!(alert.error.contains("自动校验"), "{alert:?}");
        assert!(
            alert.error.contains("kb-20261024-120000.tar.gz"),
            "{alert:?}"
        );
        // 结论也落到状态文件里(`backup_status.last_check`)
        let last = service.last_check().expect("校验结果要落盘");
        assert!(!last.ok, "{last:?}");
        assert_eq!(last.name, "kb-20261024-120000.tar.gz");
        assert!(last.error.is_some());

        // 下一次校验通过 → 告警消失,失败历史保留
        let passed = service.record_check(
            "kb-20261024-130000.tar.gz",
            BackupTrigger::Auto,
            Ok(ArchiveCheck {
                files: 3,
                uncompressed_bytes: 4096,
                meta_db_bytes: 2048,
                ..ArchiveCheck::default()
            }),
        );
        assert!(passed.ok);
        assert!(service.alert().is_none(), "{:?}", service.failures());
        assert_eq!(service.failures().len(), 1, "失败历史要留着");
        let last = service.last_check().expect("校验结果");
        assert!(last.ok);
        assert_eq!(last.files, 3);
        assert_eq!(last.meta_db_bytes, 2048);
    }
}
