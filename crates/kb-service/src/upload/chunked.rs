//! 分片上传的协议细节:分片规划、合并、整体校验与失败重试策略。
//!
//! 协议（设计规范）:
//! 1. `POST /uploads` 声明 `{name, size, sha256?, rel_path, collection, tags}` → 分片大小与已收分片;
//! 2. `PUT /uploads/{id}/parts/{n}` 逐个分片,单片带 sha256;
//! 3. `POST /uploads/{id}/complete` 合并、校验整体 sha256、入解析队列。
//!
//! 续传靠 [`crate::upload::UploadService::status`] 返回的已收分片列表,不靠客户端记忆;
//! 重传同一片是幂等的(覆盖),所以“断网重连后只补传缺失分片”不需要额外的服务端状态。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use kb_core::{KbError, Result};
use sha2::Digest;

/// 默认分片大小(MB)。
pub const DEFAULT_CHUNK_MB: u64 = 8;

/// 一次上传的分片规划。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkPlan {
    /// 每片字节数。
    pub chunk_size: u64,
    /// 分片总数(空文件为 0)。
    pub parts_total: u32,
}

/// 按总大小与分片大小算分片规划。
pub fn plan(size: u64, chunk_mb: u64) -> ChunkPlan {
    let chunk_size = chunk_mb.max(1) * 1024 * 1024;
    let parts_total = size.div_ceil(chunk_size).min(u32::MAX as u64) as u32;
    ChunkPlan {
        chunk_size,
        parts_total,
    }
}

/// 第 `part_no` 片应有的字节数(`None` = 序号越界)。
pub fn part_len(plan: ChunkPlan, size: u64, part_no: u32) -> Option<u64> {
    if part_no >= plan.parts_total {
        return None;
    }
    let start = u64::from(part_no) * plan.chunk_size;
    Some((size - start).min(plan.chunk_size))
}

/// 分片文件路径(`<dir>/<n>.part`)。
pub fn part_path(dir: &Path, part_no: u32) -> PathBuf {
    dir.join(format!("{part_no}.part"))
}

/// 原子写入一个分片:先写 `.tmp` 再改名,避免半个分片被当成分片。
pub fn write_part(dir: &Path, part_no: u32, bytes: &[u8]) -> Result<()> {
    std::fs::create_dir_all(dir)
        .map_err(|err| KbError::Internal(format!("创建目录 {} 失败: {err}", dir.display())))?;
    let target = part_path(dir, part_no);
    let temp = target.with_extension("part.tmp");
    {
        let mut file = std::fs::File::create(&temp)
            .map_err(|err| KbError::Internal(format!("创建分片 {} 失败: {err}", temp.display())))?;
        file.write_all(bytes)
            .map_err(|err| KbError::Internal(format!("写分片失败: {err}")))?;
        file.sync_all()
            .map_err(|err| KbError::Internal(format!("刷分片失败: {err}")))?;
    }
    std::fs::rename(&temp, &target)
        .map_err(|err| KbError::Internal(format!("落盘分片失败: {err}")))?;
    Ok(())
}

/// 合并后的文件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergedFile {
    /// 总字节数。
    pub size: u64,
    /// 整体 sha256。
    pub sha256: String,
}

/// 按序号把分片合并成一个文件,同时算总大小与整体 sha256。
///
/// 分片缺失或尺寸不符都算调用方的错(合并前 [`crate::upload::UploadService::complete`] 已检查过)。
pub fn merge_parts(dir: &Path, parts_total: u32, out: &Path) -> Result<MergedFile> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).map_err(|err| {
            KbError::Internal(format!("创建目录 {} 失败: {err}", parent.display()))
        })?;
    }
    let mut writer = std::fs::File::create(out)
        .map_err(|err| KbError::Internal(format!("创建 {} 失败: {err}", out.display())))?;
    let mut hasher = sha2::Sha256::new();
    let mut size = 0u64;
    let mut buffer = vec![0u8; 64 * 1024];
    for part_no in 0..parts_total {
        let path = part_path(dir, part_no);
        let mut file = std::fs::File::open(&path).map_err(|err| {
            KbError::InvalidInput(format!("缺少分片 {part_no}({}): {err}", path.display()))
        })?;
        loop {
            let read = file
                .read(&mut buffer)
                .map_err(|err| KbError::Internal(format!("读分片失败: {err}")))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            writer
                .write_all(&buffer[..read])
                .map_err(|err| KbError::Internal(format!("写合并文件失败: {err}")))?;
            size += read as u64;
        }
    }
    writer
        .sync_all()
        .map_err(|err| KbError::Internal(format!("刷合并文件失败: {err}")))?;
    Ok(MergedFile {
        size,
        sha256: hex(&hasher.finalize()),
    })
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// 失败分片的重试策略:默认 3 次、指数退避。
///
/// 服务端每次分片写入都是幂等的,重试由客户端做。浏览器端的上传 worker
/// (`web-ui`, 追加)沿用同一份参数;这里把它写成可测的 Rust 实现,
/// 让“3 次重试”有确定的行为定义,而不是只存在于前端代码里。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    /// 最多尝试几次(含第一次)。
    pub attempts: u32,
    /// 第一次重试前等多久,之后每次翻倍。
    pub base_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            attempts: 3,
            base_delay: Duration::from_millis(200),
        }
    }
}

/// 重试用尽。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RetryFailure<E> {
    /// 尝试次数。
    pub attempts: u32,
    /// 最后一次的错误。
    pub last: E,
}

impl RetryPolicy {
    /// 执行 `op`,`op` 收到“第几次尝试”(从 1 起);失败按退避重试,次数用尽返回最后一次错误。
    pub async fn run<T, E, F, Fut>(&self, mut op: F) -> std::result::Result<T, RetryFailure<E>>
    where
        F: FnMut(u32) -> Fut,
        Fut: std::future::Future<Output = std::result::Result<T, E>>,
    {
        let attempts = self.attempts.max(1);
        let mut delay = self.base_delay;
        let mut attempt = 1;
        loop {
            match op(attempt).await {
                Ok(value) => return Ok(value),
                Err(error) => {
                    if attempt >= attempts {
                        return Err(RetryFailure {
                            attempts: attempt,
                            last: error,
                        });
                    }
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                        delay = delay.saturating_mul(2);
                    }
                    attempt += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::Digest;

    #[test]
    fn chunk_plan_covers_the_whole_file() {
        let big = plan(200 * 1024 * 1024, 8);
        assert_eq!(big.chunk_size, 8 * 1024 * 1024);
        assert_eq!(big.parts_total, 25);
        let total: u64 = (0..big.parts_total)
            .map(|part| part_len(big, 200 * 1024 * 1024, part).expect("序号合法"))
            .sum();
        assert_eq!(total, 200 * 1024 * 1024);

        // 最后一片比标准片小
        let small = plan(10, 8);
        assert_eq!(small.parts_total, 1);
        assert_eq!(part_len(small, 10, 0), Some(10));
        assert_eq!(part_len(small, 10, 1), None);

        let uneven = plan(9 * 1024 * 1024, 8);
        assert_eq!(uneven.parts_total, 2);
        assert_eq!(part_len(uneven, 9 * 1024 * 1024, 1), Some(1024 * 1024));

        // 空文件没有分片
        assert_eq!(plan(0, 8).parts_total, 0);
    }

    #[test]
    fn merge_rebuilds_the_original_bytes_and_hash() {
        let dir = tempfile::tempdir().expect("临时目录");
        let parts = [b"hello ".as_slice(), b"world".as_slice()];
        for (index, bytes) in parts.iter().enumerate() {
            write_part(dir.path(), index as u32, bytes).expect("写分片");
        }
        let out = dir.path().join("merged.bin");
        let merged = merge_parts(dir.path(), 2, &out).expect("合并");
        assert_eq!(merged.size, 11);
        assert_eq!(std::fs::read(&out).expect("读"), b"hello world");
        let expected = {
            let mut hasher = sha2::Sha256::new();
            hasher.update(b"hello world");
            hex(&hasher.finalize())
        };
        assert_eq!(merged.sha256, expected);

        // 缺片要报错
        std::fs::remove_file(part_path(dir.path(), 1)).expect("删分片");
        assert!(merge_parts(dir.path(), 2, &dir.path().join("x.bin")).is_err());
    }

    #[tokio::test]
    async fn retry_succeeds_after_transient_failures() {
        let policy = RetryPolicy {
            attempts: 3,
            base_delay: Duration::from_millis(0),
        };
        let mut calls = 0;
        let result = policy
            .run(|attempt| {
                calls += 1;
                async move {
                    if attempt < 3 {
                        Err("网络断了")
                    } else {
                        Ok(attempt)
                    }
                }
            })
            .await;
        assert_eq!(result.expect("第 3 次应成功"), 3);
        assert_eq!(calls, 3);
    }

    #[tokio::test]
    async fn retry_gives_up_after_three_attempts() {
        let policy = RetryPolicy {
            attempts: 3,
            base_delay: Duration::from_millis(0),
        };
        let mut calls = 0;
        let failure = policy
            .run(|_attempt| {
                calls += 1;
                async { Err::<(), _>("一直失败") }
            })
            .await
            .expect_err("应放弃");
        assert_eq!(failure.attempts, 3);
        assert_eq!(failure.last, "一直失败");
        assert_eq!(calls, 3, "默认策略正好 3 次");
    }
}
