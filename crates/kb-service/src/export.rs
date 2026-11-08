//! 个人数据导出(多用户设计说明):把一个用户**自己的笔记和上传的原始文件**打成一个 tar.gz 让他带走。
//!
//! 归档里有三类东西:`manifest.json`(说明)、`notes/`(知识库里的笔记,每条一个带前置元数据的 `.md`)、
//! `sources/`(上传的原始文件)。笔记存在知识库的 `meta.db` 里,不是磁盘文件,所以由调用方读出来交给
//! [`ExportPlan::add_notes`];这里只负责把它们变成安全的文件名与内容。
//!
//! 导出是「把数据交到用户手里」,所以规矩比备份严:
//! - 只从传入的那一个目录(用户知识库的 `sources/`)往下收集,**绝不**碰它的上级——主知识库的上级就是数据根目录,
//!   里面有 `config.toml`、`secrets.toml`、`system.db`(所有人的账号);
//! - 符号链接一律不跟随(指向目录外的链接会让导出读到别处的文件);
//! - 以 `.` 开头的文件和目录一律不收:`.quarantine/` 是被判定为可疑的上传文件,不能借导出绕过隔离再发出去;
//! - 输出文件不能落在要打包的目录里(否则会把自己打进去);
//! - 归档成员名都由 `strip_prefix` 得出并以 `sources/` 起头,不会有 `..` 或绝对路径。
//!
//! 打包复用备份的 ustar 写入器(超长路径、边读边防文件变短、流式拷贝都已经处理好)。

use std::io::Write;
use std::path::{Path, PathBuf};

use flate2::Compression;
use flate2::write::GzEncoder;
use kb_core::model::{Insight, ItemStatus, Millis};
use kb_core::{KbError, Result};
use serde::Serialize;

use crate::backup::{MAX_OCTAL_11, mtime_millis, write_entry, write_entry_bytes};

/// 笔记部分的字节上限。笔记在打包前整批读进内存,要有个顶,免得一个人的几十万条笔记把进程撑爆;
/// 超出的部分不会悄悄丢掉,而是记进 `skipped` 告诉用户。
pub const MAX_NOTES_BYTES: u64 = 256 * 1024 * 1024;

/// 一条要打进归档的笔记(已经渲染成 Markdown 文本)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExportNote {
    /// 归档内路径,形如 `notes/<知识库分组>/<标题>-<id 前 8 位>.md`。
    pub name: String,
    /// 文件内容(UTF-8)。
    pub content: Vec<u8>,
    /// 修改时间(毫秒)。
    pub mtime: Millis,
}

/// 要打包的内容。
#[derive(Debug, Default)]
pub struct ExportPlan {
    /// `(归档内路径, 磁盘路径)`。
    pub files: Vec<(String, PathBuf)>,
    /// 笔记(读自知识库数据库,不在磁盘上)。
    pub notes: Vec<ExportNote>,
    /// 没打进去的东西和原因,写进 `manifest.json`,也给用户看。
    pub skipped: Vec<String>,
    /// 原始字节数合计(压缩前,文件 + 笔记)。
    pub total_bytes: u64,
}

impl ExportPlan {
    /// 把笔记加进计划。`total_bytes` 同步增加,这样进度条的分母和磁盘空间预估都把笔记算在内。
    pub fn add_notes(&mut self, notes: Vec<ExportNote>, skipped: Vec<String>) {
        self.total_bytes += notes
            .iter()
            .map(|note| note.content.len() as u64)
            .sum::<u64>();
        self.notes.extend(notes);
        self.skipped.extend(skipped);
        self.skipped.sort();
    }
}

/// 文件名里不允许出现的字符(跨平台:Windows 也要能解开)。
fn is_unsafe_name_char(ch: char) -> bool {
    ch.is_control()
        || matches!(
            ch,
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\u{202E}' | '\u{200B}'
        )
}

/// 把任意文字变成一个安全的文件名片段:不含路径分隔符与控制字符,不以 `.` 开头(和 `sources` 一样,
/// 点开头的名字一律不出现在归档里),最长 `max_bytes` 字节(按字符边界截),空了就用 `untitled`。
fn safe_component(raw: &str, max_bytes: usize) -> String {
    let mapped: String = raw
        .trim()
        .chars()
        .map(|ch| if is_unsafe_name_char(ch) { '_' } else { ch })
        .collect();
    let mut name = mapped
        .trim_matches(|ch: char| ch == '.' || ch.is_whitespace())
        .to_owned();
    while name.len() > max_bytes {
        name.pop();
    }
    let name = name.trim_end().to_owned();
    if name.is_empty() {
        return "untitled".to_owned();
    }
    // Windows 保留设备名(CON、NUL……)作为文件名会让解压出错
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit());
    if reserved { format!("_{name}") } else { name }
}

fn iso_utc(millis: Millis) -> String {
    chrono::DateTime::from_timestamp_millis(millis)
        .map(|time| time.format("%Y-%m-%dT%H:%M:%SZ").to_string())
        .unwrap_or_default()
}

/// JSON 字符串是合法的 YAML 双引号标量,用它来转义标题、标签里的冒号、引号、换行,前置元数据才不会被写坏。
fn yaml_text(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_owned())
}

fn render_note(insight: &Insight) -> String {
    let kind = serde_json::to_value(insight.kind)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_default();
    let list = |items: &[String]| {
        format!(
            "[{}]",
            items
                .iter()
                .map(|item| yaml_text(item))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "---\ntitle: {}\nid: {}\ncollection: {}\nkind: {}\ntags: {}\nrelated_paths: {}\ncreated_by: {}\ncreated_at: {}\nupdated_at: {}\n---\n\n{}\n",
        yaml_text(&insight.title),
        yaml_text(&insight.id),
        yaml_text(&insight.collection),
        yaml_text(&kind),
        list(&insight.tags),
        list(&insight.related_paths),
        yaml_text(&insight.created_by),
        yaml_text(&iso_utc(insight.created_at)),
        yaml_text(&iso_utc(insight.updated_at)),
        insight.body_md.trim_end_matches('\n'),
    )
}

/// 把笔记变成归档成员。只导出**有效**的笔记(被取代、已废弃的是历史,不是用户现在的内容)。
///
/// 返回 `(笔记, 被跳过的说明)`。文件名由标题和 id 前 8 位组成,id 保证同标题的笔记不会互相覆盖;
/// 万一前 8 位也撞了(几乎不可能),退回完整 id。总量超过 [`MAX_NOTES_BYTES`] 后的笔记不再收,并写明。
pub fn notes_to_entries(insights: &[Insight]) -> (Vec<ExportNote>, Vec<String>) {
    notes_to_entries_capped(insights, MAX_NOTES_BYTES)
}

/// 同 [`notes_to_entries`],字节上限可调(测试用)。
pub(crate) fn notes_to_entries_capped(
    insights: &[Insight],
    cap: u64,
) -> (Vec<ExportNote>, Vec<String>) {
    let mut active: Vec<&Insight> = insights
        .iter()
        .filter(|insight| insight.status == ItemStatus::Active)
        .collect();
    // 稳定顺序:同样的数据每次导出的包结构一致
    active.sort_by(|a, b| {
        (&a.collection, a.created_at, &a.id).cmp(&(&b.collection, b.created_at, &b.id))
    });
    let mut notes = Vec::new();
    let mut skipped = Vec::new();
    let mut used = std::collections::HashSet::new();
    let mut total: u64 = 0;
    let mut dropped = 0usize;
    for insight in active {
        let content = render_note(insight).into_bytes();
        if total + content.len() as u64 > cap {
            dropped += 1;
            continue;
        }
        let group = safe_component(&insight.collection, 80);
        let title = safe_component(&insight.title, 80);
        let short: String = insight.id.chars().take(8).collect();
        let mut name = format!("notes/{group}/{title}-{}.md", safe_component(&short, 16));
        if !used.insert(name.to_lowercase()) {
            name = format!(
                "notes/{group}/{title}-{}.md",
                safe_component(&insight.id, 64)
            );
            used.insert(name.to_lowercase());
        }
        total += content.len() as u64;
        notes.push(ExportNote {
            name,
            content,
            mtime: insight.updated_at,
        });
    }
    if dropped > 0 {
        skipped.push(format!(
            "笔记总量超过 {} MB,有 {dropped} 条没有收进来",
            cap / 1024 / 1024
        ));
    }
    (notes, skipped)
}

/// 导出完成后写在归档里的说明。
#[derive(Serialize)]
struct Manifest<'a> {
    kind: &'static str,
    created_at: i64,
    owner: &'a str,
    /// 笔记条数(`notes/` 下)。
    notes: usize,
    /// 原始文件个数(`sources/` 下)。
    files: usize,
    total_bytes: u64,
    skipped: &'a [String],
}

/// 收集 `sources_dir` 下该导出的文件。目录不存在算「没有文件」,不是错误。
pub fn plan_export(sources_dir: &Path) -> Result<ExportPlan> {
    let mut plan = ExportPlan::default();
    if !sources_dir.is_dir() {
        return Ok(plan);
    }
    let mut stack = vec![sources_dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let read = std::fs::read_dir(&dir)
            .map_err(|err| KbError::Internal(format!("读取目录失败:{err}")))?;
        for item in read {
            let item = item.map_err(|err| KbError::Internal(format!("读取目录失败:{err}")))?;
            let path = item.path();
            let rel = match path.strip_prefix(sources_dir) {
                Ok(rel) => rel.to_path_buf(),
                Err(_) => continue,
            };
            // 点开头的文件 / 目录(隔离区、临时文件)一律不收,也不往里走
            if rel
                .components()
                .any(|part| part.as_os_str().to_string_lossy().starts_with('.'))
            {
                continue;
            }
            let meta = match std::fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(err) => {
                    plan.skipped
                        .push(format!("读不到,已跳过:{}({err})", rel.display()));
                    continue;
                }
            };
            if meta.file_type().is_symlink() {
                plan.skipped
                    .push(format!("符号链接,已跳过:{}", rel.display()));
                continue;
            }
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let Some(rel_text) = rel.to_str() else {
                plan.skipped.push(format!(
                    "文件名不是合法的 UTF-8,已跳过:{}",
                    rel.to_string_lossy()
                ));
                continue;
            };
            if meta.len() > MAX_OCTAL_11 {
                plan.skipped.push(format!(
                    "文件超过 8 GiB,已跳过:{rel_text}({} 字节)",
                    meta.len()
                ));
                continue;
            }
            plan.total_bytes += meta.len();
            plan.files.push((format!("sources/{rel_text}"), path));
        }
    }
    // 稳定的顺序:同样的内容每次打出来的包结构一致,也方便测试
    plan.files.sort_by(|a, b| a.0.cmp(&b.0));
    plan.skipped.sort();
    Ok(plan)
}

/// 把计划写成 tar.gz。返回压缩后的字节数。
///
/// `out_path` 不能在 `sources_dir` 里面;先写到 `<out_path>.part` 再改名,下载方不会拿到写了一半的文件。
pub fn write_export(
    plan: &ExportPlan,
    sources_dir: &Path,
    out_path: &Path,
    owner: &str,
    created_at: i64,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<u64> {
    let canonical_sources = sources_dir.canonicalize().ok();
    let canonical_out_dir = out_path.parent().and_then(|dir| dir.canonicalize().ok());
    if let (Some(sources), Some(out_dir)) = (&canonical_sources, &canonical_out_dir)
        && out_dir.starts_with(sources)
    {
        return Err(KbError::Internal(
            "导出文件不能放在要打包的目录里".to_owned(),
        ));
    }
    let part = {
        let mut name = out_path.as_os_str().to_owned();
        name.push(".part");
        PathBuf::from(name)
    };
    let result = write_archive(plan, &part, owner, created_at, on_bytes);
    match result {
        Ok(size) => {
            std::fs::rename(&part, out_path).map_err(|err| {
                let _ = std::fs::remove_file(&part);
                KbError::Internal(format!("保存导出文件失败:{err}"))
            })?;
            Ok(size)
        }
        Err(err) => {
            let _ = std::fs::remove_file(&part);
            Err(err)
        }
    }
}

fn write_archive(
    plan: &ExportPlan,
    part: &Path,
    owner: &str,
    created_at: i64,
    on_bytes: &mut dyn FnMut(u64),
) -> Result<u64> {
    let file = std::fs::File::create(part)
        .map_err(|err| KbError::Internal(format!("创建导出文件失败:{err}")))?;
    let mut encoder = GzEncoder::new(file, Compression::default());
    let manifest = Manifest {
        kind: "kb-personal-export",
        created_at,
        owner,
        notes: plan.notes.len(),
        files: plan.files.len(),
        total_bytes: plan.total_bytes,
        skipped: &plan.skipped,
    };
    let manifest_json = serde_json::to_vec_pretty(&manifest)
        .map_err(|err| KbError::Internal(format!("序列化导出说明失败:{err}")))?;
    write_entry_bytes(&mut encoder, "manifest.json", &manifest_json, created_at)?;
    for note in &plan.notes {
        write_entry_bytes(&mut encoder, &note.name, &note.content, note.mtime)?;
        on_bytes(note.content.len() as u64);
    }
    for (name, path) in &plan.files {
        // 打开前再确认一次:计划做完到真正读取之间,文件可能被换成了符号链接
        let meta = std::fs::symlink_metadata(path)
            .map_err(|err| KbError::Internal(format!("读取 {name} 失败:{err}")))?;
        if meta.file_type().is_symlink() || !meta.is_file() {
            return Err(KbError::Internal(format!(
                "{name} 在打包过程中被改动了,请重试"
            )));
        }
        let mut source = std::fs::File::open(path)
            .map_err(|err| KbError::Internal(format!("打开 {name} 失败:{err}")))?;
        write_entry(
            &mut encoder,
            name,
            &mut source,
            meta.len(),
            mtime_millis(&meta),
            on_bytes,
        )?;
    }
    encoder
        .write_all(&[0u8; 1024])
        .map_err(|err| KbError::Internal(format!("写导出结尾失败:{err}")))?;
    let file = encoder
        .finish()
        .map_err(|err| KbError::Internal(format!("关闭导出文件失败:{err}")))?;
    file.sync_all()
        .map_err(|err| KbError::Internal(format!("导出文件落盘失败:{err}")))?;
    file.metadata()
        .map(|meta| meta.len())
        .map_err(|err| KbError::Internal(format!("读导出文件大小失败:{err}")))
}

#[cfg(test)]
mod tests;
