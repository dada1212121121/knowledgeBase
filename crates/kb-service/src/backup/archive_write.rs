//! 写归档:`tar.gz` 自己拼,只收白名单里的目录。
//!
//! 不用 tar 库的原因同 `archive_read`;另外这里要控制「写进去什么」:
//! 向量表、模型、`secrets.toml` 都不进归档,白名单写在 `collect_files` 里。

use super::*;

/// 打包时每次读 / 写多少字节(进度粒度;256 KB 对本机磁盘没有可感开销)。
pub(crate) const COPY_CHUNK: usize = 256 * 1024;

/// 写归档,返回归档字节数。
///
/// 用系统 `tar` 能直接解开的 ustar 格式;超长路径用 GNU 的 `@LongLink` 扩展,
/// 避免为了几十个字节引一个 tar 依赖。
#[allow(clippy::too_many_arguments)]
/// 多用户部署比单用户多出来的那些归档成员。
#[derive(Default)]
pub(crate) struct Extras {
    /// (归档内名字, 磁盘路径)。
    pub(crate) files: Vec<(String, PathBuf)>,
    /// 中间产物(其它库的快照),打完包要删。
    pub(crate) temps: Vec<PathBuf>,
    /// 带了哪些用户知识库。
    pub(crate) spaces: Vec<String>,
    /// 带了账号库。
    pub(crate) system_db: bool,
    /// 被跳过的文件说明(并进 manifest.skipped)。
    pub(crate) skipped: Vec<String>,
}

/// 收集账号库、各用户知识库的元数据库(`include_sources` 时还有它们的原件)和头像。
///
/// 其它库一律先做一致性快照再打包(守护进程正在写也行)。**任何一个库拍不下来都让整份备份失败**:
/// 宁可没有备份,也不要一份"成功"却悄悄少了某个用户的数据的备份。
pub(crate) fn gather_extras(
    paths: &KbPaths,
    snapshotter: &dyn SqliteSnapshotter,
    tmp_dir: &Path,
    stamp: i64,
    include_sources: bool,
) -> Result<Extras> {
    let mut extras = Extras::default();
    let result = (|| -> Result<()> {
        // 头像(体积很小,总是带上)
        extras.files.extend(collect_files(
            paths.avatars_dir(),
            "avatars",
            &mut extras.skipped,
        )?);
        if paths.system_db().is_file() {
            let temp = tmp_dir.join(format!(".extra-{stamp}-system.db"));
            extras.temps.push(temp.clone());
            snapshotter.snapshot(paths.system_db(), &temp)?;
            extras.files.push(("system.db".to_owned(), temp));
            extras.system_db = true;
        }
        let Ok(read) = std::fs::read_dir(paths.spaces_dir()) else {
            return Ok(());
        };
        let mut ids: Vec<String> = read
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            // 只认合法的知识库 id(`sp_` 开头):别的目录名不进归档,也就不会写出奇怪的成员路径
            .filter(|id| paths.space_dir(id).is_ok())
            .collect();
        ids.sort();
        for id in ids {
            let dir = paths.space_dir(&id)?;
            let meta = dir.join("meta.db");
            if !meta.is_file() {
                continue;
            }
            let temp = tmp_dir.join(format!(".extra-{stamp}-{id}.db"));
            extras.temps.push(temp.clone());
            snapshotter.snapshot(&meta, &temp)?;
            extras.files.push((format!("spaces/{id}/meta.db"), temp));
            if include_sources {
                extras.files.extend(collect_files(
                    &dir.join("sources"),
                    &format!("spaces/{id}/sources"),
                    &mut extras.skipped,
                )?);
            }
            extras.spaces.push(id);
        }
        Ok(())
    })();
    match result {
        Ok(()) => Ok(extras),
        Err(err) => {
            for temp in &extras.temps {
                let _ = std::fs::remove_file(temp);
            }
            Err(err)
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn write_archive(
    part_path: &Path,
    created_at: i64,
    include_sources: bool,
    config_file: &Path,
    snapshot: &Path,
    skills_dir: &Path,
    eval_dir: &Path,
    sources_dir: Option<&Path>,
    extras: &Extras,
    sink: &mut ProgressSink,
) -> Result<(u64, Vec<String>)> {
    let file = create_private_file(part_path).map_err(|err| {
        KbError::Internal(format!("创建归档 {} 失败: {err}", part_path.display()))
    })?;
    let mut encoder = GzEncoder::new(file, Compression::default());

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    // 元数据库是必备的:超过 ustar 能表示的大小、或者根本没生成,都要让整份备份失败,
    // 不能“成功但少了元数据”。config.toml 是可选的(全新实例可能还没有)。
    if !snapshot.is_file() {
        return Err(KbError::Internal(format!(
            "备份必需的元数据库快照不存在:{}",
            snapshot.display()
        )));
    }
    let snapshot_size = std::fs::metadata(snapshot)
        .map(|meta| meta.len())
        .map_err(|err| KbError::Internal(format!("读取元数据库快照大小失败: {err}")))?;
    if snapshot_size > MAX_OCTAL_11 {
        return Err(KbError::Internal(format!(
            "备份必需的 meta.db 有 {snapshot_size} 字节,超过归档格式能表示的上限(8 GiB)"
        )));
    }
    files.push(("meta.db".to_owned(), snapshot.to_path_buf()));
    if config_file.is_file() {
        let size = std::fs::metadata(config_file)
            .map(|meta| meta.len())
            .unwrap_or(0);
        if size > MAX_OCTAL_11 {
            return Err(KbError::Internal(format!(
                "备份必需的 config.toml 有 {size} 字节,超过归档格式能表示的上限(8 GiB)"
            )));
        }
        files.push(("config.toml".to_owned(), config_file.to_path_buf()));
    }
    files.extend(collect_files(skills_dir, "skills", &mut skipped)?);
    files.extend(collect_files(eval_dir, "eval", &mut skipped)?);
    if let Some(dir) = sources_dir {
        files.extend(collect_files(dir, "sources", &mut skipped)?);
    }
    // 多用户:账号库、各用户的元数据库(和原件)、头像
    files.extend(extras.files.iter().cloned());
    skipped.extend(extras.skipped.iter().cloned());

    // 单个文件超过 ustar 能表示的大小:在**构造 manifest 之前**就剔掉,
    // 这样 manifest.files 等于实际进归档的文件数、skipped 里也有它们
    files.retain(|(name, path)| {
        let too_big = std::fs::metadata(path)
            .map(|meta| meta.len() > MAX_OCTAL_11)
            .unwrap_or(false);
        if too_big {
            let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0);
            skipped.push(format!("文件超过 8 GiB,已跳过:{name}({size} 字节)"));
        }
        !too_big
    });
    let manifest = Manifest {
        created_at,
        version: env!("CARGO_PKG_VERSION").to_owned(),
        include_sources,
        files: files.len(),
        skipped: skipped.clone(),
        system_db: extras.system_db,
        spaces: extras.spaces.clone(),
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest)
        .map_err(|err| KbError::Internal(format!("序列化备份说明失败: {err}")))?;
    write_entry_bytes(&mut encoder, "manifest.json", &manifest_json, now_millis())?;
    // 文件清单确定后才有总数:从这里开始页面能看到“3/7 个文件 · 1.2 MB/4.8 MB”
    let total_bytes: u64 = files
        .iter()
        .map(|(_, path)| std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0))
        .sum();
    sink.totals(files.len() as u64, total_bytes);
    sink.stage(BackupStage::Packing);
    for (name, path) in &files {
        let meta = std::fs::metadata(path)
            .map_err(|err| KbError::Internal(format!("读取 {} 失败: {err}", path.display())))?;
        let mut source = std::fs::File::open(path)
            .map_err(|err| KbError::Internal(format!("打开 {} 失败: {err}", path.display())))?;
        // 逐个文件流式写进归档:原件目录可能有几百 MB 的文件,整份读进内存会撑爆进程
        sink.begin_file(name);
        {
            let mut on_bytes = |delta: u64| sink.add_bytes(delta);
            write_entry(
                &mut encoder,
                name,
                &mut source,
                meta.len(),
                mtime_millis(&meta),
                &mut on_bytes,
            )?;
        }
        sink.end_file();
    }
    // 归档末尾:两个 512 字节的空块
    encoder
        .write_all(&[0u8; 1024])
        .map_err(|err| KbError::Internal(format!("写归档结尾失败: {err}")))?;
    let file = encoder
        .finish()
        .map_err(|err| KbError::Internal(format!("关闭归档失败: {err}")))?;
    file.sync_all()
        .map_err(|err| KbError::Internal(format!("归档落盘失败: {err}")))?;
    // 返回**压缩后**的实际字节数(界面上显示的大小)与被跳过的文件说明
    let size = file
        .metadata()
        .map(|meta| meta.len())
        .map_err(|err| KbError::Internal(format!("读归档大小失败: {err}")))?;
    Ok((size, manifest.skipped))
}

/// 递归收集目录下的普通文件,返回 (归档内路径, 磁盘路径)。
///
/// 跳过符号链接:归档里出现指向 KB_HOME 之外的链接,解包时会变成读别处的文件。
pub(crate) fn collect_files(
    root: &Path,
    prefix: &str,
    skipped: &mut Vec<String>,
) -> Result<Vec<(String, PathBuf)>> {
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let read = std::fs::read_dir(&dir)
            .map_err(|err| KbError::Internal(format!("读取目录 {} 失败: {err}", dir.display())))?;
        for item in read {
            let item = item.map_err(|err| {
                KbError::Internal(format!("读取目录 {} 失败: {err}", dir.display()))
            })?;
            let path = item.path();
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(err) => {
                    // 读不到(权限等)不能静默丢:记进 skipped(用归档内相对名,别把 KB_HOME 的绝对路径写进归档)
                    let name = path
                        .strip_prefix(root)
                        .map(|rel| format!("{prefix}/{}", rel.to_string_lossy()))
                        .unwrap_or_else(|_| prefix.to_owned());
                    skipped.push(format!("读不到,已跳过:{name} ({err})"));
                    continue;
                }
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let rel = match path.strip_prefix(root) {
                Ok(rel) => rel,
                Err(_) => continue,
            };
            // 归档成员名按原样拼:Linux 上 `\` 就是普通字符,替换成 `/` 会改变恢复后的位置,
            // 还会把 `x\..\..\evil` 这种名字变成带 `..` 的成员
            let Some(rel) = rel.to_str() else {
                skipped.push(format!(
                    "非 UTF-8 文件名,已跳过:{prefix}/{}",
                    rel.to_string_lossy()
                ));
                continue;
            };
            // 不做反斜杠替换:Linux 上它是普通字符,换成分隔符会改变恢复后的位置
            if rel.split('/').any(|part| part == ".." || part == ".") {
                skipped.push(format!("名字里有 `..` 段,已跳过:{prefix}/{rel}"));
                continue;
            }
            out.push((format!("{prefix}/{rel}"), path));
        }
    }
    // 顺序稳定,便于比对
    out.sort_by(|left, right| left.0.cmp(&right.0));
    Ok(out)
}

/// 写一个内存里的文件条目(`manifest.json` 用)。
pub(crate) fn write_entry_bytes<W: Write>(
    out: &mut W,
    name: &str,
    bytes: &[u8],
    mtime: i64,
) -> Result<()> {
    let mut cursor = std::io::Cursor::new(bytes);
    write_entry(
        out,
        name,
        &mut cursor,
        bytes.len() as u64,
        mtime,
        &mut |_| {},
    )
}

/// 11 位八进制字段的上限(8 GiB − 1 / 2242 年):放不下就夹住或跳过,不能写出坏头。
pub(crate) const MAX_OCTAL_11: u64 = 0o77777777777;

/// 写一个 ustar 文件条目:头 + 正文(流式拷贝)+ 512 字节对齐填充。
///
/// `on_bytes` 每拷进一段就回调一次(打包进度用;`manifest.json` 传空实现)。
pub(crate) fn write_entry<W: Write, R: std::io::Read>(
    out: &mut W,
    name: &str,
    source: &mut R,
    size: u64,
    mtime: i64,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<()> {
    // 超长路径:先写一个 GNU `@LongLink` 扩展头
    if split_name(name).is_none() {
        let long_name = format!("{name}\0");
        let header = header_bytes("././@LongLink", long_name.len() as u64, mtime, b'L')?;
        out.write_all(&header)
            .map_err(|err| KbError::Internal(format!("写归档失败: {err}")))?;
        out.write_all(long_name.as_bytes())
            .map_err(|err| KbError::Internal(format!("写归档失败: {err}")))?;
        let pad = padding(long_name.len() as u64);
        out.write_all(&vec![0u8; pad as usize])
            .map_err(|err| KbError::Internal(format!("写归档失败: {err}")))?;
    }
    let header = header_bytes(name, size, mtime, b'0')?;
    out.write_all(&header)
        .map_err(|err| KbError::Internal(format!("写归档失败: {err}")))?;
    // 只拷头里声明的大小:读的过程中文件被追加(eval 历史这类)也不会把归档写坏。
    // 自己按块拷(不用 `std::io::copy`),才能边写边报进度:一个 4 GB 的原件也要能看到它在动。
    let mut buffer = vec![0u8; COPY_CHUNK];
    let mut copied = 0u64;
    while copied < size {
        let want = (size - copied).min(buffer.len() as u64) as usize;
        let read = source
            .read(&mut buffer[..want])
            .map_err(|err| KbError::Internal(format!("写归档时读 {name} 失败: {err}")))?;
        if read == 0 {
            // 变短了就没法补:宁可失败也不留一个内容不足的成员
            return Err(KbError::Internal(format!(
                "写归档时 {name} 变短了(头里 {size} 字节,实际读到 {copied} 字节)"
            )));
        }
        out.write_all(&buffer[..read])
            .map_err(|err| KbError::Internal(format!("写归档失败: {err}")))?;
        copied += read as u64;
        on_bytes(read as u64);
    }
    let pad = padding(size);
    out.write_all(&vec![0u8; pad as usize])
        .map_err(|err| KbError::Internal(format!("写归档失败: {err}")))?;
    Ok(())
}

/// 512 字节对齐所需的填充字节数。
pub(crate) fn padding(size: u64) -> u64 {
    (512 - (size % 512)) % 512
}

/// 把路径拆成 (name, prefix) 两个字段;装不下时返回 `None`。
pub(crate) fn split_name(name: &str) -> Option<(&str, &str)> {
    if name.len() <= 100 {
        return Some((name, ""));
    }
    let bytes = name.as_bytes();
    // 从右往左找第一个能放下 prefix(≤155)与 name(≤100)的 `/`
    for index in (0..bytes.len()).rev() {
        if bytes[index] != b'/' {
            continue;
        }
        let (prefix, rest) = (&name[..index], &name[index + 1..]);
        if prefix.len() <= 155 && !rest.is_empty() && rest.len() <= 100 {
            return Some((rest, prefix));
        }
    }
    None
}

/// 生成一个 ustar 头。
pub(crate) fn header_bytes(
    name: &str,
    size: u64,
    mtime_ms: i64,
    typeflag: u8,
) -> Result<[u8; 512]> {
    let mut header = [0u8; 512];
    let (short, prefix) = split_name(name).unwrap_or_else(|| {
        // 超长路径已经写过 `@LongLink`,这里放一个截断的名字即可(解包时以扩展头为准)
        let cut = name.len().min(100);
        (&name[..floor_char_boundary(name, cut)], "")
    });
    header[..short.len()].copy_from_slice(short.as_bytes());
    header[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
    // 权限 0644 / 所有者 0:解包时由 umask 决定,不携带本机 uid
    write_octal(&mut header[100..108], 0o644, "mode")?;
    write_octal(&mut header[108..116], 0, "uid")?;
    write_octal(&mut header[116..124], 0, "gid")?;
    write_octal(&mut header[124..136], size, "size")?;
    // tar 的 mtime 字段是**秒**;传进来的是毫秒,不换算会溢出 11 位八进制。
    // 远期时间戳(NTFS / 时钟错乱的机器)夹到字段能表示的最大值,不让整份备份失败
    let seconds = u64::try_from(mtime_ms / 1000)
        .unwrap_or(0)
        .min(MAX_OCTAL_11);
    write_octal(&mut header[136..148], seconds, "mtime")?;
    header[156] = typeflag;
    header[257..263].copy_from_slice(b"ustar\0");
    header[263..265].copy_from_slice(b"00");
    // 校验和:先按空格算,再按 tar 的老规矩写成「6 位八进制 + NUL + 空格」
    for byte in header[148..156].iter_mut() {
        *byte = b' ';
    }
    let sum: u64 = header.iter().map(|byte| u64::from(*byte)).sum();
    let text = format!("{sum:06o}");
    header[148..154].copy_from_slice(text.as_bytes());
    header[154] = 0;
    header[155] = b' ';
    Ok(header)
}

/// 取字符串在 `limit` 之内的最大合法字符边界。
pub(crate) fn floor_char_boundary(text: &str, limit: usize) -> usize {
    let mut index = limit.min(text.len());
    while index > 0 && !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

/// 写八进制数字字段(末尾留 NUL)。
///
/// 放不下时报错而不是截断:截断会写出一个“看起来正常、实际是垃圾”的头
/// (mtime 就是这样变成 2161 年的; 的单文件 ≥ 8 GiB 同理)。
pub(crate) fn write_octal(field: &mut [u8], value: u64, what: &str) -> Result<()> {
    let width = field.len() - 1;
    let text = format!("{value:o}");
    if text.len() > width {
        return Err(KbError::Internal(format!(
            "归档头里的 {what} 放不下:{value} 需要 {} 位八进制,字段只有 {width} 位",
            text.len()
        )));
    }
    let start = width - text.len();
    field[..start].fill(b'0');
    field[start..width].copy_from_slice(text.as_bytes());
    field[width] = 0;
    Ok(())
}
