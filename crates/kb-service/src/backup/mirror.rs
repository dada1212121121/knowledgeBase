//! 异地 / 外部存储:把归档复制过去、回读校验、删不掉的副本同步删掉。
//!
//! 复制失败**不让本次备份失败**(本机已经有一份),但会进失败告警。
//! 每份副本改名落盘之后都回读一遍算 sha256 与本机比对:对不上就当成复制失败并删掉那份副本,
//! 不让「目录里有一份、但内容是坏的」冒充已同步。

use super::*;

/// 一个异地目录的**落盘状态**(`backups/.mirrors.json`,每个目录一条)。
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub(crate) struct MirrorRecord {
    /// 目录(解析后的绝对路径)。
    pub(crate) dir: String,
    /// 最近一次复制成功的时间(0 = 还没成功过)。
    #[serde(default)]
    pub(crate) last_ok_at: i64,
    /// 最近一次失败的原因(成功后清空)。
    #[serde(default)]
    pub(crate) last_error: Option<String>,
    /// 最近一次失败的时间。
    #[serde(default)]
    pub(crate) error_at: i64,
}

/// 一次复制到某个异地目录的结果(进程内传递,不落盘)。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MirrorOutcome {
    /// 目录(绝对路径)。
    pub(crate) dir: String,
    /// 失败原因(`None` = 成功)。
    pub(crate) error: Option<String>,
}

/// 一个异地目录的状态(设置页「异地副本」与 `kb backup list` 用)。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct MirrorStatus {
    /// 目录(绝对路径)。
    pub dir: String,
    /// 最近一次复制成功(**并通过 sha256 比对**)的时间(unix 毫秒;0 = 还没成功过)。
    pub last_ok_at: i64,
    /// 最近一次失败的原因(成功后清空)。
    pub last_error: Option<String>,
    /// 最近一次失败的时间。
    pub error_at: i64,
    /// 这个目录里现在有几份归档(数不出来就是 0)。
    pub copies: usize,
    /// 目录里有没有**最新**那份归档(验收用:异地副本是否跟得上)。
    pub has_latest: bool,
}

/// 把归档复制到每个异地目录,并在 `sink` 上推进度。
///
/// 单个目录失败不中断其余目录(原因逐个收集,由调用方记进告警)。
/// 每个目录复制完都会回读比对 sha256(见 [`copy_to_mirror`]),所以“复制成功”= 副本真的可用。
pub(crate) fn mirror_archive_to_all(
    archive: &Path,
    archive_dir: &Path,
    name: &str,
    dirs: &[PathBuf],
    sink: &mut ProgressSink,
) -> Vec<MirrorOutcome> {
    if dirs.is_empty() {
        return Vec::new();
    }
    let size = file_size(archive);
    sink.stage(BackupStage::Mirroring);
    sink.mirror_totals(dirs.len() as u64, size.saturating_mul(dirs.len() as u64));
    let mut outcomes = Vec::with_capacity(dirs.len());
    for dir in dirs {
        sink.begin_file(&format!("{}/{name}", dir.display()));
        let error = copy_to_mirror(archive, archive_dir, dir, name, sink).err();
        sink.end_file();
        outcomes.push(MirrorOutcome {
            dir: dir.display().to_string(),
            error,
        });
    }
    outcomes
}

/// 复制一份归档到 `dir`(先写 `.<名字>.part` 再改名,断电时不会留下半份副本)。
///
/// 新建一个只有属主能读写(0600)的文件。
///
/// 归档里有账号库(密码哈希、两步验证密钥)和每个用户的全部笔记。本机的 `backups/` 在 0700 的数据目录里,
/// 但异地副本目录(移动硬盘 / NAS)的权限由别人定,文件自己必须是私密的。
pub(crate) fn create_private_file(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
}

/// 分块拷贝而不是 `std::fs::copy`:复制一份几 GB 的归档时进度条也要动。
///
/// **复制后校验**:改名落盘之后把副本**回读一遍**算 sha256,与拷贝时边读边算的本机归档
/// sha256 比对。对不上(或副本读不回来)就把这份副本删掉并报错(它会进 `mirror` 告警)——
/// 只比字节数不够:外接盘写坏、网络盘缓存回写出错时,长度对得上、内容不对。
/// 回读的那一遍不推进进度(进度总量是“要复制的字节数”,回读再加一遍会让百分比停在一半)。
pub(crate) fn copy_to_mirror(
    archive: &Path,
    archive_dir: &Path,
    dir: &Path,
    name: &str,
    sink: &mut ProgressSink,
) -> std::result::Result<(), String> {
    // 与归档目录相同时会把归档“复制给自己”(读的同时覆盖),直接当成配置错误报出来
    if dir == archive_dir {
        return Err("与归档目录相同(请换一个目录)".to_owned());
    }
    std::fs::create_dir_all(dir).map_err(|err| format!("建目录 {} 失败: {err}", dir.display()))?;
    let target = dir.join(name);
    let part = dir.join(format!(".{name}.part"));
    // 拷贝时顺带算本机归档的 sha256(不多读一遍)
    let mut hasher = Sha256::new();
    let copy = (|| -> std::io::Result<()> {
        let mut source = std::fs::File::open(archive)?;
        let mut out = create_private_file(&part)?;
        let mut buffer = vec![0u8; COPY_CHUNK];
        loop {
            let read = std::io::Read::read(&mut source, &mut buffer)?;
            if read == 0 {
                break;
            }
            out.write_all(&buffer[..read])?;
            hasher.update(&buffer[..read]);
            sink.add_bytes(read as u64);
        }
        out.flush()?;
        // 先把副本刷到盘上再改名:否则“改名成功但内容还在页缓存里”断电后会变成空文件
        out.sync_all()?;
        std::fs::rename(&part, &target)
    })();
    if let Err(err) = copy {
        let _ = std::fs::remove_file(&part);
        return Err(format!("复制到 {} 失败: {err}", target.display()));
    }
    let source_hash = format!("{:x}", hasher.finalize());
    match sha256_of_copy(&target, &source_hash) {
        Ok(()) => Ok(()),
        Err(reason) => {
            // 验不了的副本不能留在异地目录里冒充“已同步”(`has_latest` 会把它当成跟上了)
            let _ = std::fs::remove_file(&target);
            Err(format!("{reason};已删掉这份副本"))
        }
    }
}

/// 回读副本、与本机归档的 sha256 比对(复制后校验)。
///
/// 只比字节数不够:外接盘写坏、网络盘缓存回写出错时,长度对得上而内容不对。
pub(crate) fn sha256_of_copy(copy: &Path, source_hash: &str) -> std::result::Result<(), String> {
    match sha256_hex_file(copy) {
        Ok(copy_hash) if copy_hash == source_hash => Ok(()),
        Ok(copy_hash) => Err(format!(
            "副本 {} 与本机归档不一致(sha256 {copy_hash} ≠ {source_hash})",
            copy.display()
        )),
        Err(err) => Err(format!(
            "副本 {} 复制完了但读不回来(没法比对 sha256):{}",
            copy.display(),
            failure_reason(&err)
        )),
    }
}

impl BackupService {
    /// 一个异地目录的落盘状态(读 `.mirrors.json`;坏文件当作没有)。
    pub(crate) fn mirror_records(&self) -> Vec<MirrorRecord> {
        let Ok(text) = std::fs::read_to_string(self.dir().join(MIRRORS_FILE)) else {
            return Vec::new();
        };
        serde_json::from_str(&text).unwrap_or_default()
    }

    /// 写 `.mirrors.json`(同上:状态写不进去只告警)。
    pub(crate) fn write_mirror_records(&self, records: &[MirrorRecord]) {
        let path = self.dir().join(MIRRORS_FILE);
        match serde_json::to_vec_pretty(records) {
            Ok(bytes) => {
                if let Err(err) = std::fs::write(&path, bytes) {
                    tracing::warn!(error = %err, path = %path.display(), "写异地副本状态失败");
                }
            }
            Err(err) => tracing::warn!(error = %err, "序列化异地副本状态失败"),
        }
    }

    /// 每个异地目录的现状(设置页「异地副本」与 `kb backup list` 用)。
    ///
    /// “最新一份”取自本机归档目录,所以 `create` 之后看它就能判断这次复制成没成。
    pub fn mirrors(&self) -> Vec<MirrorStatus> {
        let latest = self
            .entries()
            .ok()
            .and_then(|entries| entries.first().map(|entry| entry.name.clone()));
        self.mirrors_of(latest.as_deref())
    }

    /// 每个异地目录的现状(设置页「异地副本」与 `kb backup list` 用)。
    ///
    /// `latest` 是当前最新一份归档的名字:用它判断副本是否跟得上(`has_latest`)。
    pub(crate) fn mirrors_of(&self, latest: Option<&str>) -> Vec<MirrorStatus> {
        let records = self.mirror_records();
        self.mirror_dirs()
            .into_iter()
            .map(|dir| {
                let key = dir.display().to_string();
                let record = records.iter().find(|record| record.dir == key);
                let (copies, has_latest) = count_archives(&dir, latest);
                MirrorStatus {
                    dir: key,
                    last_ok_at: record.map(|record| record.last_ok_at).unwrap_or(0),
                    last_error: record.and_then(|record| record.last_error.clone()),
                    error_at: record.map(|record| record.error_at).unwrap_or(0),
                    copies,
                    has_latest,
                }
            })
            .collect()
    }

    /// 把这一轮异地复制的结果记下来(状态文件 + 失败告警)。
    ///
    /// 全部成功 → 清掉各目录的 `last_error` 并解决告警;有失败 → 汇总成**一条**
    /// [`BackupFailureKind::Mirror`] 失败(与打包失败同一套通道,横幅只显示一条)。
    pub(crate) fn record_mirrors(&self, outcomes: &[MirrorOutcome], trigger: BackupTrigger) {
        if outcomes.is_empty() {
            return;
        }
        let now = now_millis();
        let mut records = self.mirror_records();
        for outcome in outcomes {
            let record = match records.iter_mut().find(|record| record.dir == outcome.dir) {
                Some(record) => record,
                None => {
                    records.push(MirrorRecord {
                        dir: outcome.dir.clone(),
                        ..MirrorRecord::default()
                    });
                    records.last_mut().expect("刚 push 过")
                }
            };
            match &outcome.error {
                None => {
                    record.last_ok_at = now;
                    record.last_error = None;
                    record.error_at = 0;
                }
                Some(error) => {
                    record.last_error = Some(error.clone());
                    record.error_at = now;
                }
            }
        }
        self.write_mirror_records(&records);

        let failures: Vec<&MirrorOutcome> = outcomes
            .iter()
            .filter(|outcome| outcome.error.is_some())
            .collect();
        if failures.is_empty() {
            self.record_success(BackupFailureKind::Mirror);
            return;
        }
        let summary = failures
            .iter()
            .map(|outcome| {
                format!(
                    "{}:{}",
                    outcome.dir,
                    outcome.error.as_deref().unwrap_or("未知原因")
                )
            })
            .collect::<Vec<_>>()
            .join(";");
        // 横幅上已经说了“异地副本在 … 失败”,这里只列目录与原因
        self.record_failure(trigger, BackupFailureKind::Mirror, summary);
    }
}
