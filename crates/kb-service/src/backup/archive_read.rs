//! 读归档:解包一遍,核对 manifest 与 meta.db。
//!
//! 校验(`verify` / 自动校验)与恢复前的检查走同一套代码,手工写 `tar` 解析是因为
//! 归档格式固定(自己写出来的,只有 512 字节头和 ustar 前缀),引入 tar 依赖反而更难保证
//! 「读到一半出错就停」的边界。

use super::*;

/// 校验归档:解压一遍(顺带让 flate2 校验 gzip 的 CRC32)、逐条检查 tar 头、核对 manifest 与 meta.db。
pub(crate) fn check_archive(path: &Path, name: &str, size_bytes: u64) -> Result<ArchiveCheck> {
    let file = std::fs::File::open(path)
        .map_err(|err| KbError::Internal(format!("打开归档 {} 失败: {err}", path.display())))?;
    let decoder = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut check = ArchiveCheck {
        name: name.to_owned(),
        size_bytes,
        ..ArchiveCheck::default()
    };
    let mut manifest: Option<Manifest> = None;
    let mut meta_db_bytes = 0u64;
    let mut roots: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut files = 0usize;
    let mut uncompressed_bytes = 0u64;
    let mut members: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();

    walk_archive(decoder, |entry, size, data| {
        // 解包时会写到 KB_HOME 之外的成员:这种归档不能拿去恢复
        if entry.starts_with('/') || entry.split('/').any(|part| part == "..") {
            return Err(corrupt(format!("归档里有越界路径:{entry}")));
        }
        if let Some(root) = entry.split('/').next() {
            roots.insert(root.to_owned());
        }
        uncompressed_bytes = uncompressed_bytes.saturating_add(size);
        match entry {
            "manifest.json" => {
                if size > MAX_MANIFEST_BYTES {
                    return Err(corrupt(format!(
                        "manifest.json 有 {size} 字节,不像一份说明文件"
                    )));
                }
                let mut bytes = Vec::new();
                data.read_to_end(&mut bytes)
                    .map_err(|err| corrupt(format!("读 manifest.json 失败:{err}")))?;
                let parsed: Manifest = serde_json::from_slice(&bytes)
                    .map_err(|err| corrupt(format!("manifest.json 解析失败:{err}")))?;
                manifest = Some(parsed);
            }
            "meta.db" => {
                if size < SQLITE_MAGIC.len() as u64 {
                    return Err(corrupt(format!("归档里的 meta.db 只有 {size} 字节")));
                }
                let mut head = [0u8; 16];
                data.read_exact(&mut head)
                    .map_err(|err| corrupt(format!("读 meta.db 失败:{err}")))?;
                if &head != SQLITE_MAGIC {
                    return Err(corrupt("归档里的 meta.db 不是 SQLite 文件"));
                }
                meta_db_bytes = size;
                files += 1;
            }
            "config.toml" => {
                check.config_present = true;
                files += 1;
            }
            // 账号库与各用户知识库的元数据库:同样必须是 SQLite 文件
            name if name == "system.db"
                || (name.starts_with("spaces/") && name.ends_with("/meta.db")) =>
            {
                let mut head = [0u8; 16];
                if size < SQLITE_MAGIC.len() as u64 {
                    return Err(corrupt(format!("归档里的 {name} 只有 {size} 字节")));
                }
                data.read_exact(&mut head)
                    .map_err(|err| corrupt(format!("读 {name} 失败:{err}")))?;
                if &head != SQLITE_MAGIC {
                    return Err(corrupt(format!("归档里的 {name} 不是 SQLite 文件")));
                }
                members.insert(name.to_owned());
                files += 1;
            }
            // manifest.files 统计的是“进归档的文件数”,meta.db 与 config.toml 也算
            _ => files += 1,
        }
        Ok(())
    })?;

    let manifest = manifest.ok_or_else(|| corrupt("归档里没有 manifest.json(不是 kb 备份?)"))?;
    if meta_db_bytes == 0 {
        return Err(corrupt("归档里没有 meta.db(不是 kb 备份?)"));
    }
    if manifest.files != files {
        return Err(corrupt(format!(
            "manifest 说有 {} 个文件,归档里实际有 {files} 个",
            manifest.files
        )));
    }
    // 多用户:manifest 说带了的库,归档里必须真的有(缺了说明这份备份不完整,不能拿去恢复)
    if manifest.system_db && !members.contains("system.db") {
        return Err(corrupt("manifest 说带了账号库 system.db,归档里却没有"));
    }
    for id in &manifest.spaces {
        if id.contains('/')
            || id.contains("..")
            || !members.contains(&format!("spaces/{id}/meta.db"))
        {
            return Err(corrupt(format!(
                "manifest 说带了知识库 {id} 的元数据库,归档里却没有(或名字不合法)"
            )));
        }
    }
    check.system_db = manifest.system_db;
    check.spaces = manifest.spaces.len();
    check.created_at = manifest.created_at;
    check.version = manifest.version;
    check.include_sources = manifest.include_sources;
    check.files = files;
    check.uncompressed_bytes = uncompressed_bytes;
    check.meta_db_bytes = meta_db_bytes;
    check.skipped = manifest.skipped;
    check.roots = roots.into_iter().collect();
    Ok(check)
}

/// 顺序读一个 tar 流:每个条目交给 `on_entry`(归档内名字, 字节数, 该条目的数据读取器)。
///
/// 只认我们自己写的那两种条目:普通文件(`'0'`)与 GNU 长名字(`'L'`)。
/// `on_entry` 没读完的部分由这里跳过,保证下一个头对齐;流末尾整体读完,
/// 这样 gzip 的 CRC32 不符时能在这里暴露出来。
pub(crate) fn walk_archive<R: std::io::Read>(
    mut reader: R,
    mut on_entry: impl FnMut(&str, u64, &mut dyn std::io::Read) -> Result<()>,
) -> Result<()> {
    let mut long_name: Option<String> = None;
    let mut ended = false;
    loop {
        let mut header = [0u8; 512];
        let read = read_header(&mut reader, &mut header)?;
        if read == 0 {
            break;
        }
        if read < header.len() {
            return Err(corrupt("归档在条目头处被截断"));
        }
        if header.iter().all(|byte| *byte == 0) {
            // 归档结尾是两个全零块:看到第二个就停
            if ended {
                break;
            }
            ended = true;
            continue;
        }
        if ended {
            return Err(corrupt("归档结尾块之后还有数据"));
        }
        verify_header(&header)?;
        let size = parse_octal(&header[124..136], "size")?;
        let typeflag = header[156];
        if typeflag == b'L' {
            // GNU 长名字条目:内容是名字本身(以 NUL 结尾)
            if size > MAX_LONG_NAME_BYTES {
                return Err(corrupt(format!("长名字条目有 {size} 字节,不像一个路径")));
            }
            let mut bytes = vec![0u8; size as usize];
            reader
                .read_exact(&mut bytes)
                .map_err(|err| corrupt(format!("读长名字失败:{err}")))?;
            skip_padding(&mut reader, size)?;
            long_name = Some(
                String::from_utf8_lossy(&bytes)
                    .trim_end_matches('\0')
                    .to_owned(),
            );
            continue;
        }
        if typeflag != b'0' {
            return Err(corrupt(format!(
                "归档里有不支持的条目类型 `{}`",
                typeflag as char
            )));
        }
        let name = match long_name.take() {
            Some(name) => name,
            None => entry_name(&header),
        };
        let mut limited = std::io::Read::take(reader.by_ref(), size);
        on_entry(&name, size, &mut limited)?;
        // 回调没读完的补齐(否则下一个头会错位)
        std::io::copy(&mut limited, &mut std::io::sink())
            .map_err(|err| corrupt(format!("读归档失败:{err}")))?;
        skip_padding(&mut reader, size)?;
    }
    if !ended {
        return Err(corrupt("归档没有结尾块(可能被截断)"));
    }
    // 读到底:gzip 的 CRC32 / 长度不对时 GzDecoder 会在这里报错
    std::io::copy(&mut reader, &mut std::io::sink())
        .map_err(|err| corrupt(format!("归档尾部校验失败:{err}")))?;
    Ok(())
}

/// 长名字条目的上限(路径不会长到这个量级,超过就是坏数据)。
pub(crate) const MAX_LONG_NAME_BYTES: u64 = 8 * 1024;

/// 读一个 512 字节的头,返回实际读到的字节数(0 = 正常结尾)。
pub(crate) fn read_header<R: std::io::Read>(
    reader: &mut R,
    buffer: &mut [u8; 512],
) -> Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..]) {
            Ok(0) => break,
            Ok(read) => filled += read,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => return Err(corrupt(format!("读归档失败:{err}"))),
        }
    }
    Ok(filled)
}

/// 检查 ustar 头:魔数与校验和。
pub(crate) fn verify_header(header: &[u8; 512]) -> Result<()> {
    if &header[257..262] != b"ustar" {
        return Err(corrupt("条目头不是 ustar 格式"));
    }
    let stored = parse_octal(&header[148..156], "checksum")?;
    let mut copy = *header;
    for byte in copy[148..156].iter_mut() {
        *byte = b' ';
    }
    let expected: u64 = copy.iter().map(|byte| u64::from(*byte)).sum();
    if stored != expected {
        return Err(corrupt(format!(
            "条目头校验和不符(记录 {stored},实际 {expected})"
        )));
    }
    Ok(())
}

/// 跳过条目数据后的 512 字节对齐填充。
pub(crate) fn skip_padding<R: std::io::Read>(reader: &mut R, size: u64) -> Result<()> {
    let pad = padding(size);
    if pad == 0 {
        return Ok(());
    }
    std::io::copy(&mut std::io::Read::take(reader, pad), &mut std::io::sink())
        .map_err(|err| corrupt(format!("读归档填充失败:{err}")))?;
    Ok(())
}

/// 头里的名字(`name` + `prefix` 两段拼回来)。
pub(crate) fn entry_name(header: &[u8; 512]) -> String {
    let name = field_text(&header[0..100]);
    let prefix = field_text(&header[345..500]);
    if prefix.is_empty() {
        name
    } else {
        format!("{prefix}/{name}")
    }
}

/// 取以 NUL 结尾的字段文本。
pub(crate) fn field_text(field: &[u8]) -> String {
    let end = field
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(field.len());
    String::from_utf8_lossy(&field[..end]).to_string()
}

/// 解析八进制数字字段(结尾可能是 NUL 或空格)。
pub(crate) fn parse_octal(field: &[u8], what: &str) -> Result<u64> {
    let text = field_text(field);
    let text = text.trim();
    if text.is_empty() {
        return Ok(0);
    }
    u64::from_str_radix(text, 8).map_err(|err| corrupt(format!("条目头的 {what} 不是八进制:{err}")))
}
