//! 读 zip 容器(当前阶段):OOXML / EPUB 都是 zip + XML。
//!
//! 这里是**只读**实现:解析中央目录、按条目解压到内存,并在解压过程中做安全校验
//! (路径穿越、单文件上限、总量上限、条目数上限)。写盘与嵌套解包在 `kb-service` 的上传模块里
//! (它还要算压缩比与配额)。
//!
//! 为什么不引 `zip` crate:设计规范的依赖表里没有它,而这里只需要“读中央目录 + deflate”,
//! 安全校验本来就要自己写(见下文)。

use std::io::Read;
use std::path::{Component, PathBuf};

/// 读 zip 的限制。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ZipLimits {
    /// 单个条目解压后的字节上限。
    pub max_file_bytes: u64,
    /// 所有条目解压后的总字节上限。
    pub max_total_bytes: u64,
    /// 条目数上限。
    pub max_entries: usize,
}

impl Default for ZipLimits {
    fn default() -> Self {
        Self {
            max_file_bytes: 512 * 1024 * 1024,
            max_total_bytes: 2 * 1024 * 1024 * 1024,
            max_entries: 20_000,
        }
    }
}

/// 一个解压出来的条目。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZipEntry {
    /// 条目名(已校验:`/` 分隔、无 `..`、非绝对路径)。
    pub name: String,
    /// 解压后的内容。
    pub data: Vec<u8>,
}

impl ZipEntry {
    /// 按 UTF-8 读文本(容错)。
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.data).into_owned()
    }
}

/// 读失败的原因。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ZipError {
    /// 不安全(路径穿越 / 炸弹 / 条目太多):整包拒收。
    Unsafe(String),
    /// 不支持的压缩算法或结构。
    Unsupported(String),
    /// 读写错误。
    Io(String),
}

impl std::fmt::Display for ZipError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unsafe(reason) => write!(formatter, "压缩包不安全: {reason}"),
            Self::Unsupported(reason) => write!(formatter, "不支持的压缩包: {reason}"),
            Self::Io(reason) => write!(formatter, "读取压缩包失败: {reason}"),
        }
    }
}

impl std::error::Error for ZipError {}

/// 是否是 zip(按魔数)。
pub fn looks_like_zip(head: &[u8]) -> bool {
    head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06")
}

/// 把整个 zip 读进内存(带安全限制)。
pub fn read_all(bytes: &[u8], limits: ZipLimits) -> Result<Vec<ZipEntry>, ZipError> {
    let entries = read_central_directory(bytes)?;
    if entries.len() > limits.max_entries {
        return Err(ZipError::Unsafe(format!(
            "条目数 {} 超过上限 {}",
            entries.len(),
            limits.max_entries
        )));
    }
    let declared: u64 = entries.iter().map(|entry| entry.uncompressed).sum();
    if declared > limits.max_total_bytes {
        return Err(ZipError::Unsafe(format!(
            "声明解压总量 {declared} 字节超过上限 {}",
            limits.max_total_bytes
        )));
    }
    let mut out = Vec::with_capacity(entries.len());
    let mut total = 0u64;
    for entry in entries {
        if entry.is_dir {
            continue;
        }
        let relative = safe_relative_path(&entry.name)?;
        if relative.as_os_str().is_empty() {
            continue;
        }
        let data = extract_entry(bytes, &entry, limits)?;
        total += data.len() as u64;
        if total > limits.max_total_bytes {
            return Err(ZipError::Unsafe(format!(
                "解压总量超过上限 {}",
                limits.max_total_bytes
            )));
        }
        out.push(ZipEntry {
            name: relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/"),
            data,
        });
    }
    Ok(out)
}

/// 改写后的 zip 里,中央目录要写出的一条记录。
struct RewrittenEntry {
    name: String,
    method: u16,
    crc: u32,
    compressed: u32,
    uncompressed: u32,
    /// 本地头在新文件里的偏移。
    offset: u32,
    /// 通用标志位(2 字节)加修改时间 / 日期(4 字节),照原文件保留,中央目录要和本地头一致。
    meta: [u8; 6],
}

/// 改写一个 zip:`replace` 里列出的条目换成新内容(deflate 重新压缩),其余条目**原样拷贝**
/// (本地头 + 压缩数据逐字节不动),条目顺序不变。
///
/// 给"表格改值"用:一个 xlsx 里只有被改的那张工作表要重写,图片、图表、样式、其余工作表都不该被碰;
/// 原样拷贝也避免了"解压再压缩"在大文件上的开销。新内容的条目名必须已经存在(只替换,不新增)。
pub fn rewrite(bytes: &[u8], replace: &[(&str, &[u8])]) -> Result<Vec<u8>, ZipError> {
    use std::io::Write as _;
    let entries = read_central_directory(bytes)?;
    for (name, _) in replace {
        if !entries.iter().any(|entry| entry.name == *name) {
            return Err(ZipError::Unsupported(format!("{name} 不在压缩包里")));
        }
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut directory: Vec<RewrittenEntry> = Vec::with_capacity(entries.len());
    for entry in &entries {
        let offset = usize::try_from(entry.local_offset)
            .map_err(|_| ZipError::Unsupported("本地头偏移非法".to_owned()))?;
        if offset + 30 > bytes.len() || bytes[offset..offset + 4] != [0x50, 0x4b, 0x03, 0x04] {
            return Err(ZipError::Unsupported(format!(
                "{} 的本地头签名不对",
                entry.name
            )));
        }
        let flags = u16_at(bytes, offset + 6)?;
        let name_len = u16_at(bytes, offset + 26)? as usize;
        let extra_len = u16_at(bytes, offset + 28)? as usize;
        let data_start = offset + 30 + name_len + extra_len;
        let data_end = data_start
            .checked_add(entry.compressed as usize)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(|| ZipError::Unsupported(format!("{} 的数据越界", entry.name)))?;
        // 时间与标志:从本地头取(修改时间 / 日期),写回时保持不变
        let mut meta = [0u8; 6];
        meta[..2].copy_from_slice(&bytes[offset + 6..offset + 8]);
        meta[2..].copy_from_slice(&bytes[offset + 10..offset + 14]);
        let new_offset = u32::try_from(out.len())
            .map_err(|_| ZipError::Unsupported("改写后超过 4 GB".to_owned()))?;
        match replace.iter().find(|(name, _)| *name == entry.name) {
            Some((_, data)) => {
                let mut crc = flate2::Crc::new();
                crc.update(data);
                let mut encoder =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                encoder
                    .write_all(data)
                    .map_err(|err| ZipError::Io(err.to_string()))?;
                let compressed = encoder
                    .finish()
                    .map_err(|err| ZipError::Io(err.to_string()))?;
                let (crc, csize, usize_) = (crc.sum(), compressed.len() as u32, data.len() as u32);
                // 新写的条目不再用"数据描述符"(标志位 3),大小和 CRC 直接写进本地头
                let new_flags = flags & !0x0008;
                out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
                out.extend_from_slice(&20u16.to_le_bytes());
                out.extend_from_slice(&new_flags.to_le_bytes());
                out.extend_from_slice(&8u16.to_le_bytes());
                out.extend_from_slice(&meta[2..]);
                out.extend_from_slice(&crc.to_le_bytes());
                out.extend_from_slice(&csize.to_le_bytes());
                out.extend_from_slice(&usize_.to_le_bytes());
                out.extend_from_slice(&(entry.name.len() as u16).to_le_bytes());
                out.extend_from_slice(&0u16.to_le_bytes());
                out.extend_from_slice(entry.name.as_bytes());
                out.extend_from_slice(&compressed);
                let mut flag_meta = meta;
                flag_meta[..2].copy_from_slice(&new_flags.to_le_bytes());
                directory.push(RewrittenEntry {
                    name: entry.name.clone(),
                    method: 8,
                    crc,
                    compressed: csize,
                    uncompressed: usize_,
                    offset: new_offset,
                    meta: flag_meta,
                });
            }
            None => {
                // 原样拷贝本地头 + 数据;用了数据描述符的,把紧跟在数据后面的描述符也带上
                let crc = crc_of_central(bytes, &entries, entry)?;
                let mut end = data_end;
                if flags & 0x0008 != 0 {
                    let has_sig = bytes.get(end..end + 4) == Some(&[0x50, 0x4b, 0x07, 0x08][..]);
                    end += if has_sig { 16 } else { 12 };
                    if end > bytes.len() {
                        return Err(ZipError::Unsupported(format!(
                            "{} 的数据描述符越界",
                            entry.name
                        )));
                    }
                }
                out.extend_from_slice(&bytes[offset..end]);
                directory.push(RewrittenEntry {
                    name: entry.name.clone(),
                    method: entry.method,
                    crc,
                    compressed: entry.compressed as u32,
                    uncompressed: entry.uncompressed as u32,
                    offset: new_offset,
                    meta,
                });
            }
        }
    }
    let cd_offset = out.len() as u32;
    for item in &directory {
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&item.meta[..2]);
        out.extend_from_slice(&item.method.to_le_bytes());
        out.extend_from_slice(&item.meta[2..]);
        out.extend_from_slice(&item.crc.to_le_bytes());
        out.extend_from_slice(&item.compressed.to_le_bytes());
        out.extend_from_slice(&item.uncompressed.to_le_bytes());
        out.extend_from_slice(&(item.name.len() as u16).to_le_bytes());
        out.extend_from_slice(&[0u8; 12]);
        out.extend_from_slice(&item.offset.to_le_bytes());
        out.extend_from_slice(item.name.as_bytes());
    }
    let cd_size = out.len() as u32 - cd_offset;
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    out.extend_from_slice(&(directory.len() as u16).to_le_bytes());
    out.extend_from_slice(&(directory.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    Ok(out)
}

/// 原中央目录里记的 CRC(原样拷贝的条目沿用它,不用重新解压计算)。
fn crc_of_central(bytes: &[u8], entries: &[Entry], target: &Entry) -> Result<u32, ZipError> {
    let index = entries
        .iter()
        .position(|entry| entry.local_offset == target.local_offset)
        .ok_or_else(|| ZipError::Unsupported("中央目录对不上".to_owned()))?;
    let eocd = (bytes.len().saturating_sub(64 * 1024 + 22)..=bytes.len() - 22)
        .rev()
        .find(|offset| bytes[*offset..*offset + 4] == [0x50, 0x4b, 0x05, 0x06])
        .ok_or_else(|| ZipError::Unsupported("找不到 zip 中央目录结尾".to_owned()))?;
    let mut cursor = u32_at(bytes, eocd + 16)? as usize;
    for _ in 0..index {
        let name_len = u16_at(bytes, cursor + 28)? as usize;
        let extra_len = u16_at(bytes, cursor + 30)? as usize;
        let comment_len = u16_at(bytes, cursor + 32)? as usize;
        cursor += 46 + name_len + extra_len + comment_len;
    }
    u32_at(bytes, cursor + 16)
}

/// 按名字取一个条目(OOXML 只关心 `word/document.xml` 这几个)。
pub fn read_entry(
    bytes: &[u8],
    limits: ZipLimits,
    name: &str,
) -> Result<Option<ZipEntry>, ZipError> {
    let entries = read_central_directory(bytes)?;
    for entry in entries {
        if entry.is_dir || entry.name != name {
            continue;
        }
        let data = extract_entry(bytes, &entry, limits)?;
        return Ok(Some(ZipEntry {
            name: entry.name,
            data,
        }));
    }
    Ok(None)
}

/// 列出条目名(不解压),用于找 `word/document.xml` 之类的路径。
pub fn list_names(bytes: &[u8]) -> Result<Vec<String>, ZipError> {
    Ok(read_central_directory(bytes)?
        .into_iter()
        .filter(|entry| !entry.is_dir)
        .map(|entry| entry.name)
        .collect())
}

/// 造一个最小 zip(stored,不压缩)。测试与样例生成用(不需要写盘,也不引第三方 zip 库)。
pub fn build_stored_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut directory = Vec::new();
    for (name, data) in entries {
        let offset = out.len() as u32;
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&[0u8; 8]);
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
        directory.push((*name, data.len() as u32, offset));
    }
    let cd_offset = out.len() as u32;
    for (name, size, offset) in &directory {
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&[0u8; 8]);
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&size.to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        // extra(2) + comment(2) + disk(2) + internal attrs(2) + external attrs(4)
        out.extend_from_slice(&[0u8; 12]);
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
    }
    let cd_size = out.len() as u32 - cd_offset;
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0u8; 4]);
    out.extend_from_slice(&(directory.len() as u16).to_le_bytes());
    out.extend_from_slice(&(directory.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_offset.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out
}

/// 中央目录里的一条记录。
#[derive(Clone, Debug, PartialEq, Eq)]
struct Entry {
    name: String,
    method: u16,
    compressed: u64,
    uncompressed: u64,
    local_offset: u64,
    is_dir: bool,
}

fn read_central_directory(bytes: &[u8]) -> Result<Vec<Entry>, ZipError> {
    const EOCD_SIG: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
    const CENTRAL_SIG: [u8; 4] = [0x50, 0x4b, 0x01, 0x02];
    if bytes.len() < 22 {
        return Err(ZipError::Unsupported("文件太小,不是 zip".to_owned()));
    }
    let search_from = bytes.len().saturating_sub(64 * 1024 + 22);
    let eocd = (search_from..=bytes.len() - 22)
        .rev()
        .find(|offset| bytes[*offset..*offset + 4] == EOCD_SIG)
        .ok_or_else(|| ZipError::Unsupported("找不到 zip 中央目录结尾".to_owned()))?;
    let total = u16_at(bytes, eocd + 10)?;
    let cd_size = u32_at(bytes, eocd + 12)? as u64;
    let cd_offset = u32_at(bytes, eocd + 16)? as u64;
    if total == u16::MAX || cd_size == u32::MAX as u64 || cd_offset == u32::MAX as u64 {
        return Err(ZipError::Unsupported(
            "zip64 暂不支持(单文件上限 512 MB,正常不会用到)".to_owned(),
        ));
    }
    let cd_start =
        usize::try_from(cd_offset).map_err(|_| ZipError::Unsupported("偏移非法".to_owned()))?;
    let cd_end = cd_start
        .checked_add(cd_size as usize)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| ZipError::Unsupported("中央目录越界".to_owned()))?;

    let mut entries = Vec::with_capacity(total as usize);
    let mut cursor = cd_start;
    while cursor + 46 <= cd_end {
        if bytes[cursor..cursor + 4] != CENTRAL_SIG {
            return Err(ZipError::Unsupported("中央目录记录签名不对".to_owned()));
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
            return Err(ZipError::Unsupported("条目名越界".to_owned()));
        }
        let name = String::from_utf8_lossy(&bytes[name_start..name_end]).into_owned();
        if flags & 0x0001 != 0 {
            return Err(ZipError::Unsupported(format!(
                "{name} 是加密条目(暂不支持加密压缩包)"
            )));
        }
        let is_dir = name.ends_with('/') || name.ends_with('\\');
        entries.push(Entry {
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
        return Err(ZipError::Unsupported(format!(
            "中央目录声明 {} 条,实际读到 {} 条",
            total,
            entries.len()
        )));
    }
    Ok(entries)
}

fn extract_entry(bytes: &[u8], entry: &Entry, limits: ZipLimits) -> Result<Vec<u8>, ZipError> {
    const LOCAL_SIG: [u8; 4] = [0x50, 0x4b, 0x03, 0x04];
    if entry.uncompressed > limits.max_file_bytes {
        return Err(ZipError::Unsafe(format!(
            "{} 声明解压后 {} 字节,超过单文件上限 {}",
            entry.name, entry.uncompressed, limits.max_file_bytes
        )));
    }
    let offset = usize::try_from(entry.local_offset)
        .map_err(|_| ZipError::Unsupported("本地头偏移非法".to_owned()))?;
    if offset + 30 > bytes.len() || bytes[offset..offset + 4] != LOCAL_SIG {
        return Err(ZipError::Unsupported(format!(
            "{} 的本地头签名不对",
            entry.name
        )));
    }
    let name_len = u16_at(bytes, offset + 26)? as usize;
    let extra_len = u16_at(bytes, offset + 28)? as usize;
    let start = offset + 30 + name_len + extra_len;
    let end = start
        .checked_add(entry.compressed as usize)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| ZipError::Unsupported(format!("{} 的数据越界", entry.name)))?;
    let data = &bytes[start..end];

    let cap = entry.uncompressed.min(limits.max_file_bytes).max(1) as usize;
    let mut out = Vec::with_capacity(cap.min(data.len().max(1024)));
    match entry.method {
        0 => {
            out.extend_from_slice(data);
        }
        8 => {
            let mut decoder = flate2::read::DeflateDecoder::new(data);
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                let read = decoder
                    .read(&mut buffer)
                    .map_err(|err| ZipError::Io(format!("解压 {} 失败: {err}", entry.name)))?;
                if read == 0 {
                    break;
                }
                out.extend_from_slice(&buffer[..read]);
                if out.len() as u64 > limits.max_file_bytes {
                    return Err(ZipError::Unsafe(format!(
                        "{} 解压后超过单文件上限 {}",
                        entry.name, limits.max_file_bytes
                    )));
                }
            }
        }
        other => {
            return Err(ZipError::Unsupported(format!(
                "{} 用了不支持的压缩算法 {other}(只支持 stored / deflate)",
                entry.name
            )));
        }
    }
    if out.len() as u64 != entry.uncompressed {
        return Err(ZipError::Unsafe(format!(
            "{} 声明 {} 字节,实际解出 {} 字节",
            entry.name,
            entry.uncompressed,
            out.len()
        )));
    }
    Ok(out)
}

/// 条目名 → 安全的相对路径。
pub fn safe_relative_path(name: &str) -> Result<PathBuf, ZipError> {
    if name.is_empty() {
        return Err(ZipError::Unsafe("条目名为空".to_owned()));
    }
    if name.contains('\\') {
        return Err(ZipError::Unsafe(format!("条目名含反斜杠: {name}")));
    }
    if name.starts_with('/') || name.starts_with('~') {
        return Err(ZipError::Unsafe(format!("条目名是绝对路径: {name}")));
    }
    let bytes = name.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return Err(ZipError::Unsafe(format!("条目名带盘符: {name}")));
    }
    let mut path = PathBuf::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(ZipError::Unsafe(format!("条目名含 ..: {name}")));
        }
        if part.chars().any(|ch| ch.is_control()) {
            return Err(ZipError::Unsafe(format!("条目名含控制字符: {name}")));
        }
        path.push(part);
    }
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(ZipError::Unsafe(format!("条目名不合法: {name}")));
    }
    Ok(path)
}

fn u16_at(bytes: &[u8], offset: usize) -> Result<u16, ZipError> {
    bytes
        .get(offset..offset + 2)
        .map(|slice| u16::from_le_bytes([slice[0], slice[1]]))
        .ok_or_else(|| ZipError::Unsupported("zip 结构被截断".to_owned()))
}

fn u32_at(bytes: &[u8], offset: usize) -> Result<u32, ZipError> {
    bytes
        .get(offset..offset + 4)
        .map(|slice| u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
        .ok_or_else(|| ZipError::Unsupported("zip 结构被截断".to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个最小 zip(stored,无压缩),避免测试依赖 kb-testkit。
    pub(super) fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        super::build_stored_zip(entries)
    }

    #[test]
    fn reads_entries_in_memory() {
        let zip = build_zip(&[
            ("word/document.xml", b"<w:document/>"),
            ("docProps/core.xml", b"<core/>"),
        ]);
        assert!(looks_like_zip(&zip));
        let entries = read_all(&zip, ZipLimits::default()).expect("读 zip");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "word/document.xml");
        assert_eq!(entries[0].text(), "<w:document/>");
        let one = read_entry(&zip, ZipLimits::default(), "docProps/core.xml")
            .expect("读条目")
            .expect("存在");
        assert_eq!(one.text(), "<core/>");
        let names = list_names(&zip).expect("列条目");
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn rejects_path_traversal_and_absolute_names() {
        let zip = build_zip(&[("../evil.txt", b"x")]);
        let error = read_all(&zip, ZipLimits::default()).expect_err("应拒绝");
        assert!(matches!(error, ZipError::Unsafe(_)), "{error}");
        let zip = build_zip(&[("/etc/passwd", b"x")]);
        assert!(read_all(&zip, ZipLimits::default()).is_err());
        let zip = build_zip(&[("a\\b.txt", b"x")]);
        assert!(read_all(&zip, ZipLimits::default()).is_err());
    }

    #[test]
    fn enforces_size_and_entry_limits() {
        let zip = build_zip(&[("a.txt", b"0123456789")]);
        let limits = ZipLimits {
            max_file_bytes: 4,
            ..ZipLimits::default()
        };
        let error = read_all(&zip, limits).expect_err("单文件超限");
        assert!(matches!(error, ZipError::Unsafe(_)), "{error}");

        let limits = ZipLimits {
            max_entries: 0,
            ..ZipLimits::default()
        };
        assert!(read_all(&zip, limits).is_err(), "条目数超限");
    }

    #[test]
    fn garbage_is_rejected() {
        assert!(read_all(b"not a zip", ZipLimits::default()).is_err());
        assert!(!looks_like_zip(b"not a zip"));
    }
    #[test]
    fn rewrite_replaces_one_entry_and_copies_the_rest_byte_for_byte() {
        let original = build_stored_zip(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("xl/worksheets/sheet1.xml", b"<old sheet/>"),
            ("xl/media/image1.png", b"\x89PNG-binary-\x00\x01"),
        ]);
        let changed = rewrite(
            &original,
            &[(
                "xl/worksheets/sheet1.xml",
                b"<new sheet with more content/>",
            )],
        )
        .expect("改写");
        let entries = read_all(&changed, ZipLimits::default()).expect("改写后还是合法 zip");
        let names: Vec<&str> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(
            names,
            [
                "[Content_Types].xml",
                "xl/worksheets/sheet1.xml",
                "xl/media/image1.png"
            ],
            "顺序不变"
        );
        assert_eq!(entries[1].data, b"<new sheet with more content/>");
        assert_eq!(
            entries[2].data, b"\x89PNG-binary-\x00\x01",
            "没改的条目内容不变"
        );
        // 没改的条目连压缩数据都原样拷贝:在新包里能找到原来那段字节
        let marker: &[u8] = b"\x89PNG-binary-\x00\x01";
        assert!(changed.windows(marker.len()).any(|window| window == marker));
    }

    #[test]
    fn rewrite_refuses_to_add_entries_that_are_not_there() {
        let original = build_stored_zip(&[("a.xml", b"a")]);
        assert!(rewrite(&original, &[("b.xml", b"b")]).is_err());
    }

    #[test]
    fn rewriting_twice_still_reads_back() {
        let original = build_stored_zip(&[("a.xml", b"one"), ("b.xml", b"two")]);
        let first = rewrite(&original, &[("a.xml", b"ONE")]).expect("1");
        let second = rewrite(&first, &[("b.xml", b"TWO")]).expect("2");
        let entries = read_all(&second, ZipLimits::default()).expect("读");
        assert_eq!(
            (entries[0].data.as_slice(), entries[1].data.as_slice()),
            (&b"ONE"[..], &b"TWO"[..])
        );
    }
}
