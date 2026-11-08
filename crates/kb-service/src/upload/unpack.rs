//! 压缩包安全解包。
//!
//! 只处理 zip(再补 tar / 7z / rar),规则按设计规范:
//! - **防 zip-slip**:条目名不能是绝对路径、不能含 `..`、不能含反斜杠,解出来的真实路径必须仍在目标目录内;
//! - **防炸弹**:解压总量 ≤ 压缩包大小的 `max_ratio` 倍、且 ≤ 配额上限;单文件 ≤ `max_bytes`;
//!   条目数 ≤ `max_files`;嵌套层数 ≤ `max_depth`;
//! - 越界一律返回 [`UnpackError::Unsafe`],由调用方把该文件移入隔离(不中断整批)。
//!
//! 为什么不引 `zip` crate:设计规范的依赖表里没有它,而这里只需要
//! “读中央目录 + deflate 解压”两件事(安全校验本来就必须自己写),用已在依赖树里的
//! `flate2` 即可,避免为一张卡引入十来个传递依赖(见架构设计说明)。
//!
//! 读取以**中央目录**为准:流式写入的 zip(bit 3 = 数据描述符)在本地头里尺寸是 0,
//! 只有中央目录是可信的。

use std::io::Read;
use std::path::{Component, Path, PathBuf};

/// 解包限制。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnpackLimits {
    /// 解压总量相对压缩包大小的倍数。
    pub max_ratio: u64,
    /// 嵌套层数上限(顶层压缩包算 1 层)。
    pub max_depth: u32,
    /// 一次解包最多多少个文件。
    pub max_files: u32,
    /// 单个文件的字节上限。
    pub max_bytes: u64,
    /// 解压总量上限(配额;`0` = 不限)。
    pub max_total_bytes: u64,
}

impl Default for UnpackLimits {
    fn default() -> Self {
        Self {
            max_ratio: 10,
            max_depth: 3,
            max_files: 2000,
            max_bytes: 512 * 1024 * 1024,
            max_total_bytes: 0,
        }
    }
}

/// 解出来的一个文件。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnpackedFile {
    /// 相对解包根目录的路径(`/` 分隔)。
    pub rel_path: String,
    /// 落盘的绝对路径。
    pub abs_path: PathBuf,
    /// 字节数。
    pub size: u64,
}

/// 解包结果。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct UnpackOutcome {
    /// 解出来的文件(已按路径排序)。
    pub files: Vec<UnpackedFile>,
    /// 被跳过的条目(目录、空文件)与原因。
    pub skipped: Vec<String>,
}

/// 解包失败的原因。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UnpackError {
    /// 不安全(路径穿越 / 炸弹 / 嵌套过深):整包进隔离。
    Unsafe(String),
    /// 不支持的压缩算法或格式。
    Unsupported(String),
    /// 读写出错(磁盘满、权限等)。
    Io(String),
}

impl UnpackError {
    /// 是否属于“恶意 / 不安全”,调用方据此决定隔离而不是重试。
    pub fn is_unsafe(&self) -> bool {
        matches!(self, Self::Unsafe(_))
    }
}

impl std::fmt::Display for UnpackError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsafe(reason) => write!(formatter, "压缩包不安全: {reason}"),
            Self::Unsupported(reason) => write!(formatter, "不支持的压缩包: {reason}"),
            Self::Io(reason) => write!(formatter, "解包失败: {reason}"),
        }
    }
}

impl std::error::Error for UnpackError {}

/// 是否是 zip(按魔数判断,不看扩展名)。
pub fn looks_like_zip(head: &[u8]) -> bool {
    head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06")
}

/// 解包一个 zip 到 `dest`(目录不存在时创建)。
pub fn unpack_zip(
    archive: &Path,
    dest: &Path,
    limits: UnpackLimits,
) -> Result<UnpackOutcome, UnpackError> {
    unpack_zip_at_depth(archive, dest, limits, 1)
}

fn unpack_zip_at_depth(
    archive: &Path,
    dest: &Path,
    limits: UnpackLimits,
    depth: u32,
) -> Result<UnpackOutcome, UnpackError> {
    let archive_size = std::fs::metadata(archive)
        .map_err(|err| UnpackError::Io(format!("读取 {} 失败: {err}", archive.display())))?
        .len();
    let bytes = std::fs::read(archive)
        .map_err(|err| UnpackError::Io(format!("读取 {} 失败: {err}", archive.display())))?;
    let entries = read_central_directory(&bytes)?;

    // 先按中央目录的声明做总量校验,再真正解压(避免“边写边炸”)
    let declared_total: u64 = entries.iter().map(|entry| entry.uncompressed).sum();
    check_total(declared_total, archive_size, limits)?;
    if entries.iter().filter(|entry| !entry.is_dir).count() as u32 > limits.max_files {
        return Err(UnpackError::Unsafe(format!(
            "条目数超过上限 {}",
            limits.max_files
        )));
    }
    for entry in &entries {
        if entry.uncompressed > limits.max_bytes {
            return Err(UnpackError::Unsafe(format!(
                "{} 声明解压后 {} 字节,超过单文件上限 {}",
                entry.name, entry.uncompressed, limits.max_bytes
            )));
        }
    }

    std::fs::create_dir_all(dest)
        .map_err(|err| UnpackError::Io(format!("创建目录 {} 失败: {err}", dest.display())))?;
    let root = std::fs::canonicalize(dest)
        .map_err(|err| UnpackError::Io(format!("解析目录 {} 失败: {err}", dest.display())))?;

    let mut outcome = UnpackOutcome::default();
    let mut written_total = 0u64;
    for entry in &entries {
        let relative = safe_relative_path(&entry.name)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let target = root.join(&relative);
        // 真实路径必须仍在 root 之内(双重保险:上面已经拒绝 `..` 与绝对路径)
        if !target.starts_with(&root) {
            return Err(UnpackError::Unsafe(format!(
                "条目 {} 会写到解包目录之外",
                entry.name
            )));
        }
        if entry.is_dir {
            std::fs::create_dir_all(&target)
                .map_err(|err| UnpackError::Io(format!("创建目录失败: {err}")))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| UnpackError::Io(format!("创建目录失败: {err}")))?;
        }
        let size = extract_entry(&bytes, entry, &target, limits, &mut written_total)?;
        if size == 0 {
            outcome.skipped.push(format!("{}: 空文件", entry.name));
            let _ = std::fs::remove_file(&target);
            continue;
        }
        let rel_path = relative
            .components()
            .map(|component| component.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");

        // 嵌套压缩包:在剩余层数内继续解包到同名目录,解完删掉压缩包本身。
        // 只看开头几个字节判断,不把每个解出来的文件整个读进内存
        if crate::upload::offload::file_starts_with_zip_magic(&target) {
            if depth >= limits.max_depth {
                return Err(UnpackError::Unsafe(format!(
                    "压缩包嵌套超过 {} 层({})",
                    limits.max_depth, entry.name
                )));
            }
            let nested_dest = target.with_extension("");
            let nested_prefix = nested_dest
                .strip_prefix(&root)
                .unwrap_or(&nested_dest)
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            let nested = unpack_zip_at_depth(&target, &nested_dest, limits, depth + 1)?;
            for mut file in nested.files {
                file.rel_path = format!("{nested_prefix}/{}", file.rel_path);
                outcome.files.push(file);
            }
            outcome.skipped.extend(nested.skipped);
            std::fs::remove_file(&target)
                .map_err(|err| UnpackError::Io(format!("删除嵌套压缩包失败: {err}")))?;
            continue;
        }

        outcome.files.push(UnpackedFile {
            rel_path,
            abs_path: target,
            size,
        });
    }
    outcome
        .files
        .sort_by(|left, right| left.rel_path.cmp(&right.rel_path));
    Ok(outcome)
}

/// 解压总量校验。
fn check_total(total: u64, archive_size: u64, limits: UnpackLimits) -> Result<(), UnpackError> {
    let ratio_cap = archive_size.saturating_mul(limits.max_ratio.max(1));
    let mut cap = ratio_cap;
    if limits.max_total_bytes > 0 {
        cap = cap.min(limits.max_total_bytes);
    }
    if total > cap {
        return Err(UnpackError::Unsafe(format!(
            "解压总量 {total} 字节超过上限 {cap}(压缩包 {archive_size} 字节 × {} 倍)",
            limits.max_ratio
        )));
    }
    Ok(())
}

/// 把一个条目解到 `target`,返回写入的字节数。
fn extract_entry(
    archive: &[u8],
    entry: &ZipEntry,
    target: &Path,
    limits: UnpackLimits,
    written_total: &mut u64,
) -> Result<u64, UnpackError> {
    let data = entry_data(archive, entry)?;
    let mut out = std::fs::File::create(target)
        .map_err(|err| UnpackError::Io(format!("创建 {} 失败: {err}", target.display())))?;
    let mut written = 0u64;
    let mut sink = |chunk: &[u8]| -> Result<(), UnpackError> {
        written += chunk.len() as u64;
        *written_total += chunk.len() as u64;
        // 边写边校验:声明的尺寸可能撒谎,磁盘不能被骗
        if written > limits.max_bytes {
            return Err(UnpackError::Unsafe(format!(
                "{} 实际解压超过单文件上限 {}",
                entry.name, limits.max_bytes
            )));
        }
        if limits.max_total_bytes > 0 && *written_total > limits.max_total_bytes {
            return Err(UnpackError::Unsafe(format!(
                "解压总量超过配额 {}",
                limits.max_total_bytes
            )));
        }
        std::io::Write::write_all(&mut out, chunk)
            .map_err(|err| UnpackError::Io(format!("写入失败: {err}")))
    };

    match entry.method {
        0 => sink(data)?,
        8 => {
            let mut decoder = flate2::read::DeflateDecoder::new(data);
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let read = decoder
                    .read(&mut buffer)
                    .map_err(|err| UnpackError::Io(format!("解压 {} 失败: {err}", entry.name)))?;
                if read == 0 {
                    break;
                }
                sink(&buffer[..read])?;
            }
        }
        other => {
            return Err(UnpackError::Unsupported(format!(
                "{} 用了不支持的压缩算法 {other}(只支持 stored / deflate)",
                entry.name
            )));
        }
    }
    if written != entry.uncompressed {
        return Err(UnpackError::Unsafe(format!(
            "{} 声明 {} 字节,实际解出 {written} 字节",
            entry.name, entry.uncompressed
        )));
    }
    Ok(written)
}

/// 中央目录里的一条记录。
#[derive(Clone, Debug, PartialEq, Eq)]
struct ZipEntry {
    name: String,
    method: u16,
    compressed: u64,
    uncompressed: u64,
    local_offset: u64,
    is_dir: bool,
}

/// 读中央目录(末尾 64 KB 内找 EOCD)。
fn read_central_directory(bytes: &[u8]) -> Result<Vec<ZipEntry>, UnpackError> {
    const EOCD_SIG: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
    const CENTRAL_SIG: [u8; 4] = [0x50, 0x4b, 0x01, 0x02];
    if bytes.len() < 22 {
        return Err(UnpackError::Unsupported("文件太小,不是 zip".to_owned()));
    }
    let search_from = bytes.len().saturating_sub(64 * 1024 + 22);
    let eocd = (search_from..=bytes.len() - 22)
        .rev()
        .find(|offset| bytes[*offset..*offset + 4] == EOCD_SIG)
        .ok_or_else(|| UnpackError::Unsupported("找不到 zip 中央目录结尾".to_owned()))?;
    let total = u16_at(bytes, eocd + 10)?;
    let cd_size = u32_at(bytes, eocd + 12)? as u64;
    let cd_offset = u32_at(bytes, eocd + 16)? as u64;
    if total == u16::MAX || cd_size == u32::MAX as u64 || cd_offset == u32::MAX as u64 {
        return Err(UnpackError::Unsupported(
            "zip64 暂不支持(单文件上限 512 MB,正常不会用到)".to_owned(),
        ));
    }
    let cd_start = usize::try_from(cd_offset)
        .map_err(|_| UnpackError::Unsupported("中央目录偏移非法".to_owned()))?;
    let cd_end = cd_start
        .checked_add(cd_size as usize)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| UnpackError::Unsupported("中央目录越界".to_owned()))?;

    let mut entries = Vec::with_capacity(total as usize);
    let mut cursor = cd_start;
    while cursor + 46 <= cd_end {
        if bytes[cursor..cursor + 4] != CENTRAL_SIG {
            return Err(UnpackError::Unsupported("中央目录记录签名不对".to_owned()));
        }
        let flags = u16_at(bytes, cursor + 8)?;
        let method = u16_at(bytes, cursor + 10)?;
        let compressed = u32_at(bytes, cursor + 20)? as u64;
        let uncompressed = u32_at(bytes, cursor + 24)? as u64;
        let name_len = u16_at(bytes, cursor + 28)? as usize;
        let extra_len = u16_at(bytes, cursor + 30)? as usize;
        let comment_len = u16_at(bytes, cursor + 32)? as usize;
        let local_offset = u32_at(bytes, cursor + 42)? as u64;
        let name_start = cursor + 46;
        let name_end = name_start + name_len;
        if name_end > cd_end {
            return Err(UnpackError::Unsupported("条目名越界".to_owned()));
        }
        // bit 11 = UTF-8 文件名;非 UTF-8 时按有损转换(中文压缩包多数是 UTF-8)
        let raw_name = &bytes[name_start..name_end];
        let name = String::from_utf8_lossy(raw_name).into_owned();
        if flags & 0x0001 != 0 {
            return Err(UnpackError::Unsupported(format!(
                "{name} 是加密条目(暂不支持加密压缩包)"
            )));
        }
        let is_dir = name.ends_with('/') || name.ends_with('\\');
        entries.push(ZipEntry {
            name,
            method,
            compressed,
            uncompressed,
            local_offset,
            is_dir,
        });
        cursor = name_end + extra_len + comment_len;
    }
    if entries.len() != total as usize {
        return Err(UnpackError::Unsupported(format!(
            "中央目录声明 {} 条,实际读到 {} 条",
            total,
            entries.len()
        )));
    }
    Ok(entries)
}

/// 取一个条目的压缩数据(以本地头里的名字 / 扩展区长度定位数据起点)。
fn entry_data<'a>(archive: &'a [u8], entry: &ZipEntry) -> Result<&'a [u8], UnpackError> {
    const LOCAL_SIG: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];
    let offset = usize::try_from(entry.local_offset)
        .map_err(|_| UnpackError::Unsupported("本地头偏移非法".to_owned()))?;
    if offset + 30 > archive.len() || archive[offset..offset + 4] != LOCAL_SIG {
        return Err(UnpackError::Unsupported(format!(
            "{} 的本地头签名不对",
            entry.name
        )));
    }
    let name_len = u16_at(archive, offset + 26)? as usize;
    let extra_len = u16_at(archive, offset + 28)? as usize;
    let start = offset + 30 + name_len + extra_len;
    let end = start
        .checked_add(entry.compressed as usize)
        .filter(|end| *end <= archive.len())
        .ok_or_else(|| UnpackError::Unsupported(format!("{} 的数据越界", entry.name)))?;
    Ok(&archive[start..end])
}

/// 条目名 → 安全的相对路径(拒绝绝对路径、`..`、盘符、反斜杠)。
fn safe_relative_path(name: &str) -> Result<PathBuf, UnpackError> {
    if name.is_empty() {
        return Err(UnpackError::Unsafe("条目名为空".to_owned()));
    }
    if name.contains('\\') {
        return Err(UnpackError::Unsafe(format!("条目名含反斜杠: {name}")));
    }
    if name.starts_with('/') || name.starts_with('~') {
        return Err(UnpackError::Unsafe(format!("条目名是绝对路径: {name}")));
    }
    // Windows 盘符
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return Err(UnpackError::Unsafe(format!("条目名带盘符: {name}")));
    }
    let mut path = PathBuf::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(UnpackError::Unsafe(format!("条目名含 ..: {name}")));
        }
        // 控制字符会让日志与后续处理出问题
        if part.chars().any(|ch| ch.is_control()) {
            return Err(UnpackError::Unsafe(format!("条目名含控制字符: {name}")));
        }
        path.push(part);
    }
    // 只允许普通组件(防御性:上面已经排除了 . / .. / 根)
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(UnpackError::Unsafe(format!("条目名不合法: {name}")));
    }
    Ok(path)
}

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, UnpackError> {
    bytes
        .get(offset..offset + 2)
        .map(|slice| u16::from_le_bytes([slice[0], slice[1]]))
        .ok_or_else(|| UnpackError::Unsupported("zip 结构被截断".to_owned()))
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, UnpackError> {
    bytes
        .get(offset..offset + 4)
        .map(|slice| u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
        .ok_or_else(|| UnpackError::Unsupported("zip 结构被截断".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limits() -> UnpackLimits {
        UnpackLimits {
            max_ratio: 10,
            max_depth: 3,
            max_files: 100,
            max_bytes: 1024 * 1024,
            max_total_bytes: 0,
        }
    }

    #[test]
    fn normal_archive_is_unpacked_with_directories() {
        let dir = tempfile::tempdir().expect("临时目录");
        let archive = dir.path().join("a.zip");
        kb_testkit::zip::write_zip(
            &archive,
            &[
                (
                    "docs/readme.md",
                    kb_testkit::zip::Entry::deflate("# 你好\n正文".repeat(50).as_bytes()),
                ),
                (
                    "src/lib.rs",
                    kb_testkit::zip::Entry::stored(b"pub fn f() {}\n"),
                ),
                ("empty.txt", kb_testkit::zip::Entry::stored(b"")),
            ],
        );
        let dest = dir.path().join("out");
        let outcome = unpack_zip(&archive, &dest, limits()).expect("解包");
        assert_eq!(outcome.files.len(), 2, "空文件应被跳过:{:?}", outcome);
        assert_eq!(outcome.files[0].rel_path, "docs/readme.md");
        assert_eq!(outcome.files[1].rel_path, "src/lib.rs");
        assert!(dest.join("docs/readme.md").is_file());
        assert_eq!(
            std::fs::read_to_string(dest.join("src/lib.rs")).expect("读"),
            "pub fn f() {}\n"
        );
        assert!(outcome.skipped.iter().any(|line| line.contains("空文件")));
    }

    #[test]
    fn path_traversal_is_rejected() {
        let dir = tempfile::tempdir().expect("临时目录");
        let archive = dir.path().join("evil.zip");
        kb_testkit::zip::write_zip(
            &archive,
            &[("../escape.txt", kb_testkit::zip::Entry::stored(b"x"))],
        );
        let error = unpack_zip(&archive, &dir.path().join("out"), limits()).expect_err("应拒绝");
        assert!(error.is_unsafe(), "{error}");
        assert!(!dir.path().join("escape.txt").exists(), "不能写出目标目录");
    }

    #[test]
    fn absolute_and_backslash_names_are_rejected() {
        for name in ["/etc/passwd", "C:/windows/x", "a\\b.txt"] {
            let dir = tempfile::tempdir().expect("临时目录");
            let archive = dir.path().join("evil.zip");
            kb_testkit::zip::write_zip(&archive, &[(name, kb_testkit::zip::Entry::stored(b"x"))]);
            let error =
                unpack_zip(&archive, &dir.path().join("out"), limits()).expect_err("应拒绝");
            assert!(error.is_unsafe(), "{name} 应被判为不安全:{error}");
        }
    }

    #[test]
    fn zip_bomb_is_rejected_by_ratio() {
        let dir = tempfile::tempdir().expect("临时目录");
        let archive = dir.path().join("bomb.zip");
        // 1 MB 的 0 压出来只有几百字节,压缩比远超 10 倍
        kb_testkit::zip::write_zip(
            &archive,
            &[(
                "big.bin",
                kb_testkit::zip::Entry::deflate(&vec![0u8; 1024 * 1024]),
            )],
        );
        let error = unpack_zip(&archive, &dir.path().join("out"), limits()).expect_err("应拒绝");
        assert!(error.is_unsafe(), "{error}");
        assert!(!dir.path().join("out/big.bin").exists());
    }

    #[test]
    fn too_many_entries_is_rejected() {
        let dir = tempfile::tempdir().expect("临时目录");
        let archive = dir.path().join("many.zip");
        let entries: Vec<(String, kb_testkit::zip::Entry)> = (0..20)
            .map(|index| {
                (
                    format!("f{index}.txt"),
                    kb_testkit::zip::Entry::stored(b"x"),
                )
            })
            .collect();
        let refs: Vec<(&str, kb_testkit::zip::Entry)> = entries
            .iter()
            .map(|(name, entry)| (name.as_str(), entry.clone()))
            .collect();
        kb_testkit::zip::write_zip(&archive, &refs);
        let mut small = limits();
        small.max_files = 10;
        let error = unpack_zip(&archive, &dir.path().join("out"), small).expect_err("应拒绝");
        assert!(error.is_unsafe(), "{error}");
    }

    #[test]
    fn nested_archives_are_unpacked_until_the_depth_limit() {
        let dir = tempfile::tempdir().expect("临时目录");
        // 内层 zip
        let inner = dir.path().join("inner.zip");
        kb_testkit::zip::write_zip(
            &inner,
            &[("deep.txt", kb_testkit::zip::Entry::stored(b"deep"))],
        );
        // 外层 zip 里放内层 zip
        let outer = dir.path().join("outer.zip");
        let inner_bytes = std::fs::read(&inner).expect("读内层");
        kb_testkit::zip::write_zip(
            &outer,
            &[(
                "bundle/inner.zip",
                kb_testkit::zip::Entry::stored(&inner_bytes),
            )],
        );
        let dest = dir.path().join("out");
        let outcome = unpack_zip(&outer, &dest, limits()).expect("解包");
        assert_eq!(outcome.files.len(), 1);
        assert_eq!(outcome.files[0].rel_path, "bundle/inner/deep.txt");
        assert!(dest.join("bundle/inner/deep.txt").is_file());
        assert!(
            !dest.join("bundle/inner.zip").exists(),
            "嵌套压缩包应被删掉"
        );

        // 层数用尽 → 判为不安全
        let mut shallow = limits();
        shallow.max_depth = 1;
        let error = unpack_zip(&outer, &dir.path().join("out2"), shallow).expect_err("应拒绝");
        assert!(error.is_unsafe(), "{error}");
    }

    #[test]
    fn unsupported_compression_is_reported() {
        let dir = tempfile::tempdir().expect("临时目录");
        let archive = dir.path().join("bz.zip");
        kb_testkit::zip::write_zip(
            &archive,
            &[("a.txt", kb_testkit::zip::Entry::with_method(12, b"x"))],
        );
        let error = unpack_zip(&archive, &dir.path().join("out"), limits()).expect_err("应拒绝");
        assert!(matches!(error, UnpackError::Unsupported(_)), "{error}");
    }

    #[test]
    fn garbage_is_not_a_zip() {
        let dir = tempfile::tempdir().expect("临时目录");
        let archive = dir.path().join("junk.zip");
        std::fs::write(&archive, b"not a zip at all").expect("写");
        let error = unpack_zip(&archive, &dir.path().join("out"), limits()).expect_err("应拒绝");
        assert!(matches!(error, UnpackError::Unsupported(_)), "{error}");
        assert!(!looks_like_zip(b"not a zip"));
        assert!(looks_like_zip(b"PK\x03\x04rest"));
    }
}
