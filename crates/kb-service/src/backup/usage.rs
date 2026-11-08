//! 目录用量、文件大小、时间戳这些小工具,以及失败原因的归一化文案。
//!
//! 设置页要显示「备份占多少空间」,所以这里只算归档目录,不遍历 `sources/`。

use super::*;

/// 各部分占用的磁盘字节数(设置页用来解释“备份会有多大”)。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct DataUsage {
    /// 元数据库。
    pub meta_db_bytes: u64,
    /// 向量表(不备份)。
    pub lance_bytes: u64,
    /// 原件(可选备份)。
    pub sources_bytes: u64,
    /// 未完成的上传分片(不备份)。
    pub uploads_bytes: u64,
    /// skills 清单。
    pub skills_bytes: u64,
    /// 评测数据。
    pub eval_bytes: u64,
    /// 配置 + secrets(secrets 不备份)。
    pub config_bytes: u64,
    /// 备份目录里已有的归档。
    pub backups_bytes: u64,
}

/// 失败原因(给人看):去掉 `invalid input:` / `internal:` 这类错误码前缀。
///
/// 错误码在日志与 HTTP 响应里有用,但设置页的告警与失败历史里只需要一句人话。
pub(crate) fn failure_reason(err: &KbError) -> String {
    match err {
        KbError::NotFound(message)
        | KbError::InvalidInput(message)
        | KbError::Forbidden(message)
        | KbError::Exists(message)
        | KbError::Unavailable(message)
        | KbError::Upstream(message)
        | KbError::Internal(message) => message.clone(),
        KbError::Conflict { expected, actual } => {
            format!("版本冲突:期望 {expected},实际 {actual}")
        }
        KbError::Unauthorized => "未通过鉴权".to_owned(),
    }
}

/// 归档坏了(用户给的文件有问题,不是服务端 bug)。
pub(crate) fn corrupt(message: impl std::fmt::Display) -> KbError {
    KbError::InvalidInput(format!("归档校验失败:{message}"))
}

/// 文件大小;不存在或读不到都算 0(状态页不该因为缺文件报错)。
pub(crate) fn file_size(path: &Path) -> u64 {
    std::fs::metadata(path)
        .map(|meta| meta.len())
        .unwrap_or_default()
}

/// 目录占用(递归;读不到的项跳过)。
pub(crate) fn dir_size(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let read = match std::fs::read_dir(&dir) {
            Ok(read) => read,
            Err(_) => continue,
        };
        for item in read.flatten() {
            let path = item.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.is_dir() {
                stack.push(path);
            } else {
                total += meta.len();
            }
        }
    }
    total
}

/// 数一个异地目录里现在有几份归档,以及里面有没有**最新**那份。
///
/// 目录不存在 / 读不出来都当作 0 份(状态页不该因为外接盘没挂上就报错 ——
/// 那种情况会通过 `last_error` 显示)。
pub(crate) fn count_archives(dir: &Path, latest: Option<&str>) -> (usize, bool) {
    let has_latest = latest.is_some_and(|name| dir.join(name).is_file());
    let Ok(read) = std::fs::read_dir(dir) else {
        return (0, has_latest);
    };
    let copies = read
        .flatten()
        .filter(|item| {
            let name = item.file_name().to_string_lossy().to_string();
            !name.starts_with('.') && name.ends_with(ARCHIVE_EXT)
        })
        .count();
    (copies, has_latest)
}

/// 文件修改时间(unix 毫秒;取不到就 0)。
pub(crate) fn mtime_millis(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 当前时间(unix 毫秒)。
pub(crate) fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

/// 归档文件名里的时间戳:`YYYYmmdd-HHMMSS`(站点时区,和界面 / 备份记录一致)。
pub(crate) fn timestamp_text(millis: i64) -> String {
    use chrono::TimeZone;
    kb_core::timezone::now()
        .timezone()
        .timestamp_millis_opt(millis)
        .single()
        .unwrap_or_else(kb_core::timezone::now)
        .format("%Y%m%d-%H%M%S")
        .to_string()
}
