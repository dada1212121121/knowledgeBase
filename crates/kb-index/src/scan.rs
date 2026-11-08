//! 目录遍历。
//!
//! 遵守 `.gitignore`(由 `ignore` crate 负责)、项目 include/exclude 与 config.exclude;
//! 跳过二进制、超大文件与生成代码;结果按“文档优先,代码按 mtime 从新到旧”排序。

use std::io::Read;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use ignore::Match;
use ignore::WalkBuilder;
use kb_core::model::{Millis, ScanEntry, ScanOutcome, ScanRequest, SkipReason, SkippedEntry};
use kb_core::ports::Scanner;
use kb_core::{KbError, Result};

use crate::filter::{FileFilter, HEAD_BYTES, build_ignore, build_whitelist};
use crate::lang::{FileKind, detect_lang, kind_of};

/// 基于文件系统的扫描器(端口 [`Scanner`] 的实现)。
#[derive(Clone, Copy, Debug, Default)]
pub struct FsScanner;

impl Scanner for FsScanner {
    fn scan(&self, request: &ScanRequest) -> Result<ScanOutcome> {
        scan(request)
    }
}

/// 遍历项目目录。
pub fn scan(request: &ScanRequest) -> Result<ScanOutcome> {
    let root = &request.root;
    if !root.is_dir() {
        return Err(KbError::NotFound(format!("项目目录 {}", root.display())));
    }
    let filter = FileFilter::new(root, request.max_file_bytes, &request.exclude)?
        .with_legacy_office(request.legacy_office)
        .with_allow_binary(root, &request.allow_binary)?;
    let includes = build_whitelist(root, &request.include)?;
    // 目录剪枝用独立的匹配器:闭包需要 'static,而 filter 后面还要继续用
    let dir_excludes = FileFilter::from_matcher(
        build_ignore(root, &request.exclude)?,
        request.max_file_bytes,
    );

    let walker = WalkBuilder::new(root)
        // 项目目录不一定在 git 仓库里,但 .gitignore 仍然要生效
        .require_git(false)
        .filter_entry(move |entry| {
            let is_dir = entry
                .file_type()
                .is_some_and(|file_type| file_type.is_dir());
            // 只剪目录;文件留给 FileFilter 判断,这样被排除的文件也能记进 skipped
            if !is_dir {
                return true;
            }
            !dir_excludes.is_excluded(entry.path(), true)
        })
        .build();

    let mut result = ScanOutcome::default();
    for entry in walker {
        let entry = match entry {
            Ok(entry) => entry,
            Err(err) => {
                let path = error_path(&err);
                tracing_skip(&mut result, root, path, SkipReason::Unreadable);
                continue;
            }
        };
        if !entry
            .file_type()
            .is_some_and(|file_type| file_type.is_file())
        {
            continue;
        }
        let path = entry.path();
        let relative = relative_path(root, path);
        // include 为空 = 全部;否则只保留命中的文件
        if let Some(includes) = &includes {
            match includes.matched(path, false) {
                Match::Whitelist(_) => {}
                Match::Ignore(_) | Match::None => {
                    result.skipped.push(SkippedEntry {
                        relative,
                        reason: SkipReason::Excluded,
                    });
                    continue;
                }
            }
        }
        let metadata = match std::fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(_) => {
                result.skipped.push(SkippedEntry {
                    relative,
                    reason: SkipReason::Unreadable,
                });
                continue;
            }
        };
        let size = metadata.len();
        // 超过该文件有效上限的直接记 TooLarge,不必读头;没超的都要读头做二进制 / 生成代码判定。
        // 上限必须和 check 用同一个口径(size_limit_for):Markdown 文档放宽到 2 MiB 后,
        // 200KB 以上的文档如果还按 max_file_bytes 判断「不读头」,二进制和生成代码的检查就被绕过了。
        let head = if size > filter.size_limit_for(path) {
            Vec::new()
        } else {
            read_head(path).unwrap_or_default()
        };
        if let Some(reason) = filter.check(path, size, &head) {
            result.skipped.push(SkippedEntry { relative, reason });
            continue;
        }
        result.files.push(ScanEntry {
            path: path.to_path_buf(),
            relative,
            size,
            mtime: metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as Millis)
                .unwrap_or(0),
            lang: detect_lang(path).to_owned(),
            kind: kind_of(path),
        });
    }

    sort_files(&mut result.files);
    result
        .skipped
        .sort_by(|left, right| left.relative.cmp(&right.relative));
    Ok(result)
}

/// 排序规则:文档在前;同类里按 mtime 从新到旧,再按路径。
fn sort_files(files: &mut [ScanEntry]) {
    files.sort_by(|left, right| {
        let left_rank = if left.kind == FileKind::Doc { 0 } else { 1 };
        let right_rank = if right.kind == FileKind::Doc { 0 } else { 1 };
        left_rank
            .cmp(&right_rank)
            .then_with(|| right.mtime.cmp(&left.mtime))
            .then_with(|| left.relative.cmp(&right.relative))
    });
}

fn read_head(path: &Path) -> std::io::Result<Vec<u8>> {
    let mut file = std::fs::File::open(path)?;
    let mut buffer = vec![0u8; HEAD_BYTES];
    let mut read = 0usize;
    while read < buffer.len() {
        let count = file.read(&mut buffer[read..])?;
        if count == 0 {
            break;
        }
        read += count;
    }
    buffer.truncate(read);
    Ok(buffer)
}

fn relative_path(root: &Path, path: &Path) -> String {
    let relative = path.strip_prefix(root).unwrap_or(path);
    relative
        .components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

/// 从遍历错误里取出相关路径(`ignore::Error` 没有直接的 `path` 方法)。
fn error_path(err: &ignore::Error) -> Option<&Path> {
    match err {
        ignore::Error::WithPath { path, .. } => Some(path),
        ignore::Error::WithLineNumber { err, .. } | ignore::Error::WithDepth { err, .. } => {
            error_path(err)
        }
        ignore::Error::Loop { child, .. } => Some(child),
        _ => None,
    }
}

fn tracing_skip(result: &mut ScanOutcome, root: &Path, path: Option<&Path>, reason: SkipReason) {
    let relative = path
        .map(|path| relative_path(root, path))
        .unwrap_or_default();
    result.skipped.push(SkippedEntry { relative, reason });
}

/// 把 `SystemTime` 转成 Unix 毫秒(测试与调用方用)。
pub fn system_time_millis(time: SystemTime) -> Millis {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as Millis)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn write(root: &Path, relative: &str, content: &[u8]) {
        let path = root.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("建目录");
        }
        fs::write(path, content).expect("写文件");
    }

    fn options(root: &Path, max_file_bytes: u64) -> ScanRequest {
        ScanRequest {
            root: root.to_path_buf(),
            include: Vec::new(),
            exclude: vec![
                "**/node_modules/**".to_owned(),
                "**/*.lock".to_owned(),
                "**/package-lock.json".to_owned(),
            ],
            max_file_bytes,
            legacy_office: false,
            allow_binary: Vec::new(),
        }
    }

    #[test]
    fn missing_root_is_not_found() {
        let dir = tempfile::tempdir().expect("临时目录");
        let err = scan(&options(&dir.path().join("nope"), 1024));
        assert!(matches!(err, Err(KbError::NotFound(_))));
    }

    #[test]
    fn basic_scan_orders_docs_before_code_and_skips_by_rules() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path();
        write(root, ".gitignore", b"*.log\nignored_dir/\n");
        write(root, "docs/guide.md", b"# guide\n");
        write(root, "docs/readme.txt", b"readme\n");
        write(root, "src/main.rs", b"fn main() {}\n");
        write(root, "src/app.py", b"print(1)\n");
        write(root, "node_modules/pkg/index.js", b"module.exports = 1;\n");
        write(root, "assets/logo.png", b"\x89PNG\0\0\0binary");
        write(
            root,
            "generated.rs",
            b"// @generated by protoc\nfn a() {}\n",
        );
        write(root, "package-lock.json", b"{}\n");
        write(root, "debug.log", b"log line\n");
        write(root, "ignored_dir/a.rs", b"fn a() {}\n");
        let big = vec![b'x'; 2048];
        write(root, "huge.txt", &big);
        // 同类文件按 mtime 新→旧排:显式设一下,别让写入顺序/文件系统时间粒度影响断言
        let now = std::time::SystemTime::now();
        let set_mtime = |relative: &str, at: std::time::SystemTime| {
            let file = std::fs::File::options()
                .write(true)
                .open(root.join(relative))
                .expect("打开文件");
            file.set_times(std::fs::FileTimes::new().set_modified(at))
                .expect("设置 mtime");
        };
        set_mtime("docs/guide.md", now);
        set_mtime(
            "docs/readme.txt",
            now - std::time::Duration::from_secs(3600),
        );

        let result = scan(&options(root, 1024)).expect("扫描");
        let kept: Vec<&str> = result.files.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(
            kept,
            vec![
                "docs/guide.md",
                "docs/readme.txt",
                "src/app.py",
                "src/main.rs"
            ],
            "只保留通过过滤的文件,且文档排在代码前面"
        );

        let skipped: Vec<(&str, SkipReason)> = result
            .skipped
            .iter()
            .map(|file| (file.relative.as_str(), file.reason))
            .collect();
        // node_modules 整个目录被剪掉,里面文件既不入库也不逐个记录
        assert!(!kept.contains(&"node_modules/pkg/index.js"));
        assert!(
            !skipped
                .iter()
                .any(|(path, _)| *path == "node_modules/pkg/index.js")
        );
        assert!(skipped.contains(&("package-lock.json", SkipReason::Excluded)));
        assert!(skipped.contains(&("assets/logo.png", SkipReason::Binary)));
        assert!(skipped.contains(&("generated.rs", SkipReason::Generated)));
        assert!(skipped.contains(&("huge.txt", SkipReason::TooLarge)));
        // .gitignore 命中的文件由遍历器直接忽略,不会出现在任何列表里
        assert!(!kept.contains(&"debug.log"));
        assert!(!kept.contains(&"ignored_dir/a.rs"));
        assert!(!skipped.iter().any(|(path, _)| *path == "debug.log"));
    }

    #[test]
    fn docs_come_before_code_and_code_is_newest_first() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path();
        write(root, "a.rs", b"fn a() {}\n");
        std::thread::sleep(Duration::from_millis(20));
        write(root, "b.rs", b"fn b() {}\n");
        write(root, "z.md", b"# z\n");

        let result = scan(&options(root, 1024)).expect("扫描");
        let kept: Vec<&str> = result.files.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(
            kept,
            vec!["z.md", "b.rs", "a.rs"],
            "文档优先,代码按 mtime 新→旧"
        );
    }

    #[test]
    fn include_patterns_restrict_the_scan() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path();
        write(root, "src/a.rs", b"fn a() {}\n");
        write(root, "docs/b.md", b"# b\n");

        let mut options = options(root, 1024);
        options.include = vec!["src/**".to_owned()];
        let result = scan(&options).expect("扫描");
        let kept: Vec<&str> = result.files.iter().map(|f| f.relative.as_str()).collect();
        assert_eq!(kept, vec!["src/a.rs"]);
        assert!(
            result
                .skipped
                .iter()
                .any(|file| file.relative == "docs/b.md" && file.reason == SkipReason::Excluded)
        );
    }

    #[test]
    fn language_and_kind_are_filled_in() {
        let dir = tempfile::tempdir().expect("临时目录");
        let root = dir.path();
        write(root, "src/lib.rs", b"pub fn f() {}\n");
        write(root, "README.md", b"# hi\n");

        let result = scan(&options(root, 1024)).expect("扫描");
        let rs = result
            .files
            .iter()
            .find(|file| file.relative == "src/lib.rs")
            .expect("rs 文件");
        assert_eq!(rs.lang, "rust");
        assert_eq!(rs.kind, FileKind::Code);
        assert!(rs.size > 0);
        assert!(rs.mtime > 0);

        let md = result
            .files
            .iter()
            .find(|file| file.relative == "README.md")
            .expect("md 文件");
        assert_eq!(md.lang, "markdown");
        assert_eq!(md.kind, FileKind::Doc);
    }
}
