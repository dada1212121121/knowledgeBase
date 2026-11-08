//! 备份(设置页「备份」分区)验收:归档内容、原件可选、删除与名字校验、状态统计。
//!
//! 归档是标准 `tar.gz`,所以这里用**系统 `tar`** 解开归档来断言内容 ——
//! 自己写的 ustar 头必须被真实实现认。测试全部在临时 `KB_HOME` 下进行。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use async_trait::async_trait;
use kb_core::Result;
use kb_core::paths::KbPaths;
use kb_service::backup::{
    BackupOptions, BackupPolicy, BackupService, DbSnapshot, SqliteSnapshotter,
};

/// 假快照:写一段固定内容(真实实现是 SQLite 的 `VACUUM INTO`)。
struct FakeSnapshot {
    bytes: Vec<u8>,
}

#[async_trait]
impl DbSnapshot for FakeSnapshot {
    async fn snapshot_to(&self, dest: &Path) -> Result<()> {
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| kb_core::KbError::Internal(format!("建目录失败: {err}")))?;
        }
        std::fs::write(dest, &self.bytes)
            .map_err(|err| kb_core::KbError::Internal(format!("写快照失败: {err}")))
    }
}

/// 搭一个假的 KB_HOME。
fn home() -> (tempfile::TempDir, KbPaths, PathBuf) {
    let dir = tempfile::tempdir().expect("临时目录");
    let paths = KbPaths::from_home(dir.path().join("kb"));
    paths.ensure_dirs().expect("建目录");
    // 配置、skills、评测、原件、向量表各放一点东西
    std::fs::write(paths.config_file(), "[search]\nk = 8\n").expect("写配置");
    std::fs::write(
        paths.secrets_file(),
        "[llm]\napi_key = \"sk-should-not-leak\"\n",
    )
    .expect("写密钥");
    std::fs::create_dir_all(paths.skills_dir().join("demo")).expect("建 skill 目录");
    std::fs::write(
        paths.skills_dir().join("demo").join("manifest.toml"),
        "kind = \"loader-rule\"\n",
    )
    .expect("写 skill");
    std::fs::write(paths.eval_dir().join("history.jsonl"), "{\"run\":1}\n").expect("写评测");
    let source_dir = paths.source_dir("src1");
    std::fs::create_dir_all(source_dir.join("docs")).expect("建原件目录");
    std::fs::write(source_dir.join("docs").join("a.md"), "# 原件\n").expect("写原件");
    std::fs::create_dir_all(paths.lance_dir().join("tbl")).expect("建向量目录");
    std::fs::write(
        paths.lance_dir().join("tbl").join("data.lance"),
        vec![7u8; 4096],
    )
    .expect("写向量");
    let archive_dir = paths.backups_dir().to_path_buf();
    (dir, paths, archive_dir)
}

fn service(paths: &KbPaths) -> BackupService {
    BackupService::new(
        paths.clone(),
        Arc::new(FakeSnapshot {
            bytes: b"SQLite format 3\0fake-meta-db".to_vec(),
        }),
    )
}

/// 备份目录里残留的**中间产物**(快照 / 半成品)。
///
/// `.failures.json` / `.progress.json` / `.verify.json` 是设计上会留下的状态文件
/// (失败历史、打包进度、最近一次自动校验),不算残留 —— 真正的残留是
/// `.snapshot-*.db` 与 `.*.part`。
fn leftover_temp_files(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .expect("读目录")
        .flatten()
        .map(|item| item.file_name().to_string_lossy().to_string())
        .filter(|name| {
            name.starts_with('.')
                && name != ".failures.json"
                && name != ".progress.json"
                && name != ".verify.json"
        })
        .collect()
}

/// 用系统 tar 列出归档里的条目。
///
/// `--quoting-style=literal`:tar 默认会把反斜杠等字符转义成 `\\`,那样就分不清
/// “名字里真有反斜杠”和“tar 转义过”(用例需要看到原始名字)。
fn tar_list(archive: &Path) -> Vec<String> {
    let output = Command::new("tar")
        .arg("--quoting-style=literal")
        .arg("-tzf")
        .arg(archive)
        .output()
        .expect("运行 tar");
    assert!(
        output.status.success(),
        "tar 读不了归档:{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().to_owned())
        .filter(|line| !line.is_empty())
        .collect()
}

/// 用系统 tar 取出归档里某个文件的内容。
fn tar_read(archive: &Path, name: &str) -> Vec<u8> {
    let output = Command::new("tar")
        .arg("-xzOf")
        .arg(archive)
        .arg(name)
        .output()
        .expect("运行 tar");
    assert!(
        output.status.success(),
        "tar 取不出 {name}:{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

#[tokio::test]
async fn backup_contains_metadata_and_skips_vectors() {
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths);
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份成功");

    let archive = archive_dir.join(&entry.name);
    assert!(archive.is_file(), "归档应落盘");
    assert!(entry.name.starts_with("kb-"), "文件名形如 kb-<时间>.tar.gz");
    assert!(entry.name.ends_with(".tar.gz"));
    assert!(entry.size_bytes > 0);
    assert_eq!(entry.size_bytes, std::fs::metadata(&archive).unwrap().len());
    assert_eq!(entry.skipped, 0, "正常目录不该有跳过的文件");

    let names = tar_list(&archive);
    for expected in [
        "manifest.json",
        "config.toml",
        "meta.db",
        "skills/demo/manifest.toml",
        "eval/history.jsonl",
    ] {
        assert!(
            names.iter().any(|name| name == expected),
            "归档里缺少 {expected};实际:{names:?}"
        );
    }
    // 向量、模型、密钥、未完成上传都不进归档
    assert!(
        !names.iter().any(|name| name.starts_with("lance/")),
        "不该备份向量表"
    );
    assert!(!names.iter().any(|name| name.starts_with("models/")));
    assert!(
        !names.iter().any(|name| name == "secrets.toml"),
        "不该备份密钥"
    );
    assert!(
        !names.iter().any(|name| name.starts_with("sources/")),
        "默认不含原件"
    );

    // 内容原样:配置、快照、skill
    assert_eq!(tar_read(&archive, "config.toml"), b"[search]\nk = 8\n");
    assert_eq!(
        tar_read(&archive, "meta.db"),
        b"SQLite format 3\0fake-meta-db"
    );
    let manifest = String::from_utf8(tar_read(&archive, "manifest.json")).expect("UTF-8");
    assert!(
        manifest.contains("\"include_sources\": false"),
        "{manifest}"
    );
    assert!(manifest.contains("version"), "{manifest}");

    // 中间产物(快照 / 半成品)不留下来
    let leftovers = leftover_temp_files(&archive_dir);
    assert!(leftovers.is_empty(), "不应残留临时文件:{leftovers:?}");
}

#[tokio::test]
async fn backup_can_include_originals_and_lists_them() {
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths);
    let entry = service
        .create(&BackupOptions {
            include_sources: true,
        })
        .await
        .expect("备份成功");
    // 归档里带没带原件,以 manifest 为准(列表不再给一个会说谎的字段)

    let archive = archive_dir.join(&entry.name);
    let names = tar_list(&archive);
    assert!(
        names.iter().any(|name| name == "sources/src1/docs/a.md"),
        "含原件的备份应带上 sources;实际:{names:?}"
    );
    assert_eq!(
        tar_read(&archive, "sources/src1/docs/a.md"),
        b"# \xe5\x8e\x9f\xe4\xbb\xb6\n"
    );
    let manifest = String::from_utf8(tar_read(&archive, "manifest.json")).expect("UTF-8");
    assert!(manifest.contains("\"include_sources\": true"), "{manifest}");

    // 状态里能看到这份归档与各部分占用
    let status = service.status().expect("状态");
    assert_eq!(status.entries.len(), 1);
    assert_eq!(status.entries[0].name, entry.name);
    // 列表里的时间是文件修改时间,与创建时间只差几毫秒
    let last = status.last_backup_at.expect("有备份时间");
    assert!(
        (last - entry.created_at).abs() < 2_000,
        "备份时间偏差过大:{last} vs {}",
        entry.created_at
    );
    assert!(status.usage.meta_db_bytes > 0 || status.usage.sources_bytes > 0);
    assert!(status.usage.sources_bytes > 0, "原件占用应被统计");
    assert!(status.usage.lance_bytes >= 4096, "向量占用应被统计");
    assert!(status.usage.backups_bytes >= entry.size_bytes);
    assert!(status.notes.len() >= 3, "说明文案由后端给,前端不再重复写");
}

/// 大文件要能完整进归档(实现是流式拷贝,不是整份读进内存)。
#[tokio::test]
async fn large_original_is_streamed_into_the_archive() {
    let (_dir, paths, archive_dir) = home();
    // 3 MB 的可压缩内容(比 gzip 缓冲大得多,能暴露填充 / 长度算错)
    let payload: Vec<u8> = (0..3 * 1024 * 1024u32)
        .map(|index| (index % 251) as u8)
        .collect();
    std::fs::write(
        paths.source_dir("src1").join("docs").join("big.bin"),
        &payload,
    )
    .expect("写大文件");

    let service = service(&paths);
    let entry = service
        .create(&BackupOptions {
            include_sources: true,
        })
        .await
        .expect("备份成功");
    let archive = archive_dir.join(&entry.name);
    let extracted = tar_read(&archive, "sources/src1/docs/big.bin");
    assert_eq!(extracted.len(), payload.len(), "长度不一致");
    assert!(extracted == payload, "内容不一致");
}

/// 归档里的 mtime 必须是**秒**。
#[tokio::test]
async fn archive_timestamps_are_in_this_decade() {
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths);
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份成功");
    let archive = archive_dir.join(&entry.name);

    // 用系统 tar 看时间:年份必须落在 [2020, 2100)
    let output = Command::new("tar")
        .arg("-tvzf")
        .arg(&archive)
        .output()
        .expect("运行 tar");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let listing = String::from_utf8_lossy(&output.stdout).into_owned();
    let years: Vec<u32> = listing
        .lines()
        .filter_map(|line| line.split_whitespace().nth(3))
        .filter_map(|stamp| stamp.get(..4))
        .filter_map(|year| year.parse::<u32>().ok())
        .collect();
    assert!(!years.is_empty(), "tar -tvzf 里没找到年份:{listing}");
    for year in &years {
        assert!(
            (2020..2100).contains(year),
            "归档时间戳落在 {year} 年,说明 mtime 单位错了:{listing}"
        );
    }
    // gzip 之后不能直接读头,所以 mtime 靠 tar -tvzf 的年份判断;这里顺带核对归档大小
    let raw = std::fs::read(&archive).expect("读归档");
    assert_eq!(raw.len() as u64, entry.size_bytes);
}

/// 反斜杠在 Linux 上是普通字符:不能变成路径分隔符,更不能造出带 `..` 的成员。
#[tokio::test]
async fn backslash_names_stay_single_segments() {
    let (_dir, paths, archive_dir) = home();
    let docs = paths.source_dir("src1").join("docs");
    // 合法但看着危险的单段文件名:如果被当成路径分隔符,就会变成 ../../evil.txt
    std::fs::write(docs.join(r"x\..\..\evil.txt"), "不该穿越").expect("写文件");
    // 正常名字里带反斜杠:必须原样保留(不能被改成子目录)
    std::fs::write(docs.join(r"a\b.txt"), "反斜杠是普通字符").expect("写文件");

    let service = service(&paths);
    let entry = service
        .create(&BackupOptions {
            include_sources: true,
        })
        .await
        .expect("备份成功");
    let archive = archive_dir.join(&entry.name);
    let names = tar_list(&archive);
    assert!(
        names
            .iter()
            .any(|name| name == r"sources/src1/docs/a\b.txt"),
        "反斜杠文件名应原样保留:{names:?}"
    );
    // 成员名按 `/` 切分后不能出现 `..` 段(反斜杠里的 `..` 只是普通字符)
    for name in &names {
        assert!(
            !name.split('/').any(|part| part == ".."),
            "归档里出现了带 `..` 段的成员:{name}"
        );
    }
    // 注意:`tar -xO <名字>` 会把名字里的 `\` 当转义,所以这里不解单文件,统一走整体解包后比对
    // 那个看着危险的名字仍然是一个文件,落在 docs 下面
    assert!(
        names
            .iter()
            .any(|name| name == r"sources/src1/docs/x\..\..\evil.txt"),
        "单段名字应原样保留:{names:?}"
    );

    // 系统 tar 能完整解包(没有 “Member name contains '..'”),文件还在 docs 里
    let extract = tempfile::tempdir().expect("解包目录");
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(extract.path())
        .output()
        .expect("运行 tar");
    assert!(
        status.status.success(),
        "解包失败:{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let restored = extract.path().join("sources/src1/docs");
    assert_eq!(
        std::fs::read(restored.join(r"a\b.txt")).expect("反斜杠文件"),
        "反斜杠是普通字符".as_bytes()
    );
    assert!(
        !extract.path().join("sources/src1/evil.txt").exists()
            && !extract.path().join("evil.txt").exists(),
        "不该出现被穿越出来的文件"
    );
}

/// 非 UTF-8 的文件名:跳过并写进 manifest.skipped,`create` 的返回里也有计数。
#[tokio::test]
async fn non_utf8_names_are_skipped_and_reported() {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;

    let (_dir, paths, archive_dir) = home();
    let docs = paths.source_dir("src1").join("docs");
    let bad = OsStr::from_bytes(b"bad-\xff-name.txt");
    std::fs::write(docs.join(bad), "非 UTF-8").expect("写文件");
    std::fs::write(docs.join("ok.txt"), "正常").expect("写文件");

    let service = service(&paths);
    let entry = service
        .create(&BackupOptions {
            include_sources: true,
        })
        .await
        .expect("备份成功");
    assert_eq!(entry.skipped, 1, "一个非 UTF-8 名字应被跳过");

    let archive = archive_dir.join(&entry.name);
    let names = tar_list(&archive);
    assert!(names.iter().any(|name| name == "sources/src1/docs/ok.txt"));
    assert!(
        !names.iter().any(|name| name.contains("bad-")),
        "非 UTF-8 名字不该进归档:{names:?}"
    );
    let manifest = String::from_utf8(tar_read(&archive, "manifest.json")).expect("UTF-8");
    assert!(
        manifest.contains("非 UTF-8"),
        "manifest 应说明跳过的原因:{manifest}"
    );
    assert!(
        !manifest.contains("\\\\x"),
        "说明文字不该带 Debug 转义:{manifest}"
    );
}

/// 单个文件超过 8 GiB:跳过、记进 manifest、返回计数。
#[tokio::test]
async fn oversized_file_is_skipped_and_recorded() {
    let (_dir, paths, archive_dir) = home();
    let docs = paths.source_dir("src1").join("docs");
    std::fs::write(docs.join("ok.txt"), "正常").expect("写正常文件");
    // 稀疏文件:8 GiB + 1 字节,不占磁盘
    let big = docs.join("huge.bin");
    let file = std::fs::File::create(&big).expect("建大文件");
    file.set_len(8 * 1024 * 1024 * 1024 + 1)
        .expect("设为 8 GiB");
    drop(file);

    let service = service(&paths);
    let entry = service
        .create(&BackupOptions {
            include_sources: true,
        })
        .await
        .expect("超大文件不该让备份失败");
    assert_eq!(entry.skipped, 1, "跳过的计数应回到调用方");

    let archive = archive_dir.join(&entry.name);
    let names = tar_list(&archive);
    assert!(names.iter().any(|name| name == "sources/src1/docs/ok.txt"));
    assert!(
        !names.iter().any(|name| name.contains("huge.bin")),
        "超过 8 GiB 的文件不该进归档:{names:?}"
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&tar_read(&archive, "manifest.json")).expect("manifest JSON");
    assert_eq!(manifest["skipped"].as_array().expect("skipped").len(), 1);
    assert!(
        manifest["skipped"][0]
            .as_str()
            .unwrap_or_default()
            .contains("huge.bin"),
        "manifest 里要写清跳过了哪个文件:{manifest}"
    );
    // files 计数只算真正进归档的数据文件(manifest.json 自己不算):config + meta + ok.txt
    let data_files = names.iter().filter(|name| *name != "manifest.json").count();
    assert_eq!(
        manifest["files"].as_u64().expect("files") as usize,
        data_files,
        "manifest.files 应等于归档里的数据文件数:{manifest} / {names:?}"
    );
}

/// 必备文件(config.toml / meta.db)超过 8 GiB:整份备份失败,不能“成功但少了元数据”。
#[tokio::test]
async fn oversized_meta_snapshot_fails_loudly() {
    let (_dir, paths, _archive_dir) = home();
    // 假的快照端口:写出一个 8 GiB + 1 的稀疏文件
    struct BigSnapshot;
    #[async_trait::async_trait]
    impl DbSnapshot for BigSnapshot {
        async fn snapshot_to(&self, dest: &Path) -> Result<()> {
            let file = std::fs::File::create(dest).expect("建快照");
            file.set_len(8 * 1024 * 1024 * 1024 + 1)
                .expect("撑到 8 GiB");
            Ok(())
        }
    }
    let service = BackupService::new(paths.clone(), Arc::new(BigSnapshot));
    let error = service
        .create(&BackupOptions::default())
        .await
        .expect_err("快照过大应报错");
    let text = error.to_string();
    assert!(text.contains("meta.db"), "错误里要写清是哪个文件:{text}");
    // 没有留下半成品(失败历史不算)
    let leftovers = leftover_temp_files(paths.backups_dir());
    assert!(leftovers.is_empty(), "失败后不该留文件:{leftovers:?}");
}

/// 快照端口声称成功却没写出文件:必备的 meta.db 缺失要报错,不能静默少文件。
#[tokio::test]
async fn missing_meta_snapshot_fails_loudly() {
    let (_dir, paths, _archive_dir) = home();
    struct NoopSnapshot;
    #[async_trait::async_trait]
    impl DbSnapshot for NoopSnapshot {
        async fn snapshot_to(&self, _dest: &Path) -> Result<()> {
            Ok(())
        }
    }
    let service = BackupService::new(paths.clone(), Arc::new(NoopSnapshot));
    let error = service
        .create(&BackupOptions::default())
        .await
        .expect_err("没有元数据库快照应报错");
    assert!(
        error.to_string().contains("元数据库快照"),
        "错误里要写清缺的是什么:{error}"
    );
    let leftovers = leftover_temp_files(paths.backups_dir());
    assert!(leftovers.is_empty(), "失败后不该留文件:{leftovers:?}");
}

/// 远期 mtime 夹到字段上限,不让整份备份失败。
#[tokio::test]
async fn far_future_mtime_is_clamped_instead_of_failing() {
    let (_dir, paths, archive_dir) = home();
    let file = paths.source_dir("src1").join("docs").join("future.txt");
    std::fs::write(&file, "来自未来").expect("写文件");
    // 2300 年:秒数放不进 11 位八进制
    let handle = std::fs::File::options()
        .write(true)
        .open(&file)
        .expect("打开");
    handle
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(10_413_792_000))
        .expect("改 mtime");
    drop(handle);

    let service = service(&paths);
    let entry = service
        .create(&BackupOptions {
            include_sources: true,
        })
        .await
        .expect("远期 mtime 不该让备份失败");
    let archive = archive_dir.join(&entry.name);
    let names = tar_list(&archive);
    assert!(
        names.iter().any(|name| name.ends_with("future.txt")),
        "{names:?}"
    );
    // 系统 tar 能解开(不报 “in the future” 之外的错)
    let extract = tempfile::tempdir().expect("解包目录");
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(extract.path())
        .output()
        .expect("运行 tar");
    assert!(
        status.status.success(),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
}

/// 各种长度的名字都要能被系统 tar 解开。
#[tokio::test]
async fn awkward_file_names_round_trip_through_tar() {
    let (_dir, paths, archive_dir) = home();
    let docs = paths.source_dir("src1").join("docs");
    let long_dir = docs.join("d".repeat(60)).join("e".repeat(60));
    std::fs::create_dir_all(&long_dir).expect("建长目录");
    std::fs::write(long_dir.join("f.txt"), "长路径").expect("写文件");
    std::fs::write(docs.join("n".repeat(200)), "200 字节的单段名").expect("写文件");
    std::fs::write(docs.join("汉".repeat(60)), "60 个汉字").expect("写文件");
    std::fs::write(docs.join("empty.txt"), b"").expect("写空文件");
    std::fs::write(docs.join("exactly512.bin"), vec![7u8; 512]).expect("写 512 字节");

    let service = service(&paths);
    let entry = service
        .create(&BackupOptions {
            include_sources: true,
        })
        .await
        .expect("备份成功");
    let archive = archive_dir.join(&entry.name);

    let extract = tempfile::tempdir().expect("解包目录");
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(&archive)
        .arg("-C")
        .arg(extract.path())
        .output()
        .expect("运行 tar");
    assert!(
        status.status.success(),
        "解包失败:{}",
        String::from_utf8_lossy(&status.stderr)
    );
    let restored = extract.path().join("sources/src1/docs");
    assert_eq!(
        std::fs::read(restored.join("empty.txt"))
            .expect("空文件")
            .len(),
        0
    );
    assert_eq!(
        std::fs::read(restored.join("exactly512.bin"))
            .expect("512")
            .len(),
        512
    );
    assert_eq!(
        std::fs::read(restored.join("汉".repeat(60))).expect("中文名"),
        "60 个汉字".as_bytes()
    );
    assert_eq!(
        std::fs::read(
            restored
                .join("d".repeat(60))
                .join("e".repeat(60))
                .join("f.txt")
        )
        .expect("长路径"),
        "长路径".as_bytes()
    );
}

#[tokio::test]
async fn delete_removes_archive_and_rejects_bad_names() {
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths);
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份成功");

    // 路径穿越与非法名一律拒绝
    for bad in [
        "../evil.tar.gz",
        "sub/dir.tar.gz",
        "no-extension",
        ".hidden.tar.gz",
    ] {
        let error = service.delete(bad).expect_err("非法名字应被拒");
        assert!(
            matches!(error, kb_core::KbError::InvalidInput(_)),
            "{bad} 的错误类型不对:{error}"
        );
    }
    // 合法名字但文件不在
    let error = service
        .delete("kb-19700101-000000.tar.gz")
        .expect_err("不存在");
    assert!(matches!(error, kb_core::KbError::NotFound(_)), "{error}");

    service.delete(&entry.name).expect("删除成功");
    assert!(!archive_dir.join(&entry.name).exists());
    assert!(service.status().expect("状态").entries.is_empty());
}

#[tokio::test]
async fn two_backups_in_a_row_get_distinct_names() {
    let (_dir, paths, _archive_dir) = home();
    let service = service(&paths);
    let first = service
        .create(&BackupOptions::default())
        .await
        .expect("第一次备份");
    // 同一秒内再备一次:不能覆盖已有归档(时间戳撞了就报错,而不是悄悄覆盖)
    match service.create(&BackupOptions::default()).await {
        Ok(second) => assert_ne!(second.name, first.name),
        Err(error) => assert!(
            matches!(error, kb_core::KbError::InvalidInput(_)),
            "撞名应报参数错误:{error}"
        ),
    }
    assert!(!service.status().expect("状态").entries.is_empty());
}

// ===== 定时备份与保留策略(设置页「备份」的缺口) =====

/// 当前 unix 毫秒(测试里判断“到点”用)。
fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .expect("系统时间早于 1970")
}

/// 造一份“已有归档”:内容不重要,名字与修改时间由调用方给(列表按 mtime 排序)。
///
/// 直接 `create` 太慢也不可控 —— 归档名只精确到秒,同一秒内连建多份会撞名。
fn fake_archive(dir: &Path, name: &str, created_at: i64) {
    let path = dir.join(name);
    std::fs::write(&path, b"fake-archive").expect("写假归档");
    let mtime = std::time::UNIX_EPOCH + std::time::Duration::from_millis(created_at as u64);
    std::fs::File::options()
        .write(true)
        .open(&path)
        .expect("打开假归档")
        .set_modified(mtime)
        .expect("设置修改时间");
}

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 86_400_000;

#[tokio::test]
async fn auto_backup_is_due_once_per_interval() {
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths).with_policy(BackupPolicy {
        enabled: true,
        interval_hours: 24,
        ..BackupPolicy::default()
    });
    let now = unix_millis();

    // 从没备份过 → 立刻到点
    assert!(service.due(now), "没有归档时应立刻备份");
    // 状态里能看到策略与下次时间
    let status = service.status().expect("状态");
    assert_eq!(status.policy, service.policy());
    assert_eq!(status.policy.interval_hours, 24);
    assert!(status.next_backup_at.is_some(), "启用时应有下次时间");

    // 23 小时前刚备份过 → 不到点,也不该打包
    fake_archive(
        &archive_dir,
        "kb-20260101-000000.tar.gz",
        now - 23 * HOUR_MS,
    );
    assert!(!service.due(now), "间隔内不该再备份");
    assert!(
        service.run_auto(now).await.expect("查询").is_none(),
        "不到点不该打包"
    );

    // 同一份归档又老了两小时(超过 24 小时间隔)→ 到点,并真的落一份新归档
    fake_archive(
        &archive_dir,
        "kb-20260101-000000.tar.gz",
        now - 25 * HOUR_MS,
    );
    assert!(service.due(now), "超过间隔应到点");
    let auto = service
        .run_auto(now)
        .await
        .expect("自动备份")
        .expect("应到点");
    assert!(archive_dir.join(&auto.entry.name).is_file());
    assert_eq!(auto.entry.skipped, 0);
    // 刚备份完:再判一次就不该到点了(判据是归档文件本身,不是内存状态)
    assert!(!service.due(now), "刚备份完不该重复备份");
    assert_eq!(service.entries().expect("列表").len(), 2);
}

#[tokio::test]
async fn disabled_policy_never_backs_up() {
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths).with_policy(BackupPolicy {
        enabled: false,
        ..BackupPolicy::default()
    });
    let now = unix_millis();
    assert!(!service.due(now), "关掉定时备份后永远不到点");
    assert!(service.run_auto(now).await.expect("查询").is_none());
    assert!(
        service.entries().expect("列表").is_empty(),
        "关掉时不该产生归档"
    );
    assert!(archive_dir.is_dir());
    assert_eq!(service.status().expect("状态").next_backup_at, None);
}

#[tokio::test]
async fn retention_keeps_the_newest_and_prunes_beyond_the_count() {
    let (_dir, paths, archive_dir) = home();
    let keeper = service(&paths).with_policy(BackupPolicy {
        keep_count: 3,
        keep_days: 0,
        ..BackupPolicy::default()
    });
    // 只剩一份时用的“收紧策略”实例
    let tight = service(&paths).with_policy(BackupPolicy {
        keep_count: 1,
        ..BackupPolicy::default()
    });
    let now = unix_millis();
    for index in 0..5 {
        fake_archive(
            &archive_dir,
            &format!("kb-2026010{index}-000000.tar.gz"),
            now - (5 - index as i64) * HOUR_MS,
        );
    }

    // 预演:只列不删,按时间从旧到新
    let dry = keeper.prune(true).expect("预演");
    assert!(dry.dry_run);
    assert_eq!(dry.kept, 3, "预演也要报清理后的份数(5 份留 3 份)");
    assert_eq!(
        dry.removed,
        vec![
            "kb-20260100-000000.tar.gz".to_owned(),
            "kb-20260101-000000.tar.gz".to_owned(),
        ]
    );
    assert_eq!(keeper.entries().expect("列表").len(), 5, "预演不删文件");

    // 真删:只留最新 3 份
    let report = keeper.prune(false).expect("清理");
    assert!(!report.dry_run);
    assert_eq!(report.removed.len(), 2);
    assert_eq!(report.kept, 3);
    assert!(report.failed.is_empty());
    let names: Vec<String> = keeper
        .entries()
        .expect("列表")
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert_eq!(
        names,
        vec![
            "kb-20260104-000000.tar.gz".to_owned(),
            "kb-20260103-000000.tar.gz".to_owned(),
            "kb-20260102-000000.tar.gz".to_owned(),
        ]
    );

    // 份数收紧到 1:只留最新那份,最新一份本身永远不被删
    let report = tight.prune(false).expect("清理");
    assert_eq!(
        report.removed,
        vec![
            "kb-20260102-000000.tar.gz".to_owned(),
            "kb-20260103-000000.tar.gz".to_owned(),
        ]
    );
    assert_eq!(report.kept, 1);
    let names: Vec<String> = tight
        .entries()
        .expect("列表")
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert_eq!(names, vec!["kb-20260104-000000.tar.gz".to_owned()]);
}

#[tokio::test]
async fn retention_prunes_by_age_too() {
    let (_dir, paths, archive_dir) = home();
    let aged = service(&paths).with_policy(BackupPolicy {
        // 只按天数清:份数不限
        keep_count: 0,
        keep_days: 30,
        ..BackupPolicy::default()
    });
    // 两个维度都为 0 的“不清理”实例
    let idle = service(&paths).with_policy(BackupPolicy {
        keep_count: 0,
        keep_days: 0,
        ..BackupPolicy::default()
    });
    let now = unix_millis();
    for (name, age_days) in [
        ("kb-20260100-000000.tar.gz", 40i64),
        ("kb-20260101-000000.tar.gz", 31),
        ("kb-20260102-000000.tar.gz", 29),
        ("kb-20260103-000000.tar.gz", 1),
    ] {
        fake_archive(&archive_dir, name, now - age_days * DAY_MS);
    }
    let report = aged.prune(false).expect("清理");
    assert_eq!(
        report.removed,
        vec![
            "kb-20260100-000000.tar.gz".to_owned(),
            "kb-20260101-000000.tar.gz".to_owned(),
        ],
        "超过 30 天的两份应被删掉"
    );
    assert_eq!(report.kept, 2);
    assert_eq!(aged.entries().expect("列表").len(), 2);

    // 两个维度都为 0 = 不清理
    fake_archive(
        &archive_dir,
        "kb-20250101-000000.tar.gz",
        now - 400 * DAY_MS,
    );
    let report = idle.prune(false).expect("清理");
    assert!(report.removed.is_empty(), "两个维度都为 0 时不该删任何归档");
    assert_eq!(report.kept, 3);
}

#[tokio::test]
async fn auto_backup_prunes_old_archives_after_packing() {
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths).with_policy(BackupPolicy {
        enabled: true,
        interval_hours: 24,
        keep_count: 2,
        ..BackupPolicy::default()
    });
    let now = unix_millis();
    fake_archive(
        &archive_dir,
        "kb-20260101-000000.tar.gz",
        now - 30 * HOUR_MS,
    );
    fake_archive(
        &archive_dir,
        "kb-20260102-000000.tar.gz",
        now - 28 * HOUR_MS,
    );

    let auto = service
        .run_auto(now)
        .await
        .expect("自动备份")
        .expect("应到点");
    // 新建一份 + 留 2 份 → 最旧的那份被清掉
    assert_eq!(
        auto.pruned.removed,
        vec!["kb-20260101-000000.tar.gz".to_owned()]
    );
    assert_eq!(auto.pruned.kept, 2);
    let names: Vec<String> = service
        .entries()
        .expect("列表")
        .into_iter()
        .map(|entry| entry.name)
        .collect();
    assert_eq!(names.len(), 2);
    assert!(names.contains(&auto.entry.name));
    assert!(!names.contains(&"kb-20260101-000000.tar.gz".to_owned()));
}

#[test]
fn policy_follows_the_config_section() {
    let config = kb_core::config::BackupConfig {
        enabled: false,
        interval_hours: 6,
        keep_count: 2,
        keep_days: 90,
        include_sources: true,
        mirror_dirs: vec!["/mnt/offsite".to_owned()],
    };
    let policy = BackupPolicy::from_config(&config);
    assert_eq!(
        policy,
        BackupPolicy {
            enabled: false,
            interval_hours: 6,
            keep_count: 2,
            keep_days: 90,
            include_sources: true,
            mirror_dirs: vec!["/mnt/offsite".to_owned()],
        }
    );
    // 默认值与 `[backup]` 的默认值一致
    assert_eq!(
        BackupPolicy::default(),
        BackupPolicy::from_config(&kb_core::config::BackupConfig::default())
    );
}

#[tokio::test]
async fn newest_archive_survives_the_age_rule() {
    // 守护进程停了很久的真实场景:只剩一份 40 天前的归档,而策略是“留 1 份且只留 30 天内”。
    // 两个维度都想删它,但“最新一份永远保留”必须赢 —— 否则会把仅有的备份删光。
    // (去掉 `prune` 里的 `index == 0` 守卫,这条用例会红。)
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths).with_policy(BackupPolicy {
        keep_count: 1,
        keep_days: 30,
        ..BackupPolicy::default()
    });
    fake_archive(
        &archive_dir,
        "kb-20250101-000000.tar.gz",
        unix_millis() - 40 * DAY_MS,
    );
    let report = service.prune(false).expect("清理");
    assert!(report.removed.is_empty(), "最新一份不该被删:{report:?}");
    assert_eq!(report.kept, 1);
    assert!(archive_dir.join("kb-20250101-000000.tar.gz").exists());
}

#[tokio::test]
async fn huge_keep_days_does_not_wipe_everything() {
    // `keep_days` 是 u64:直接 `as i64 * DAY_MS` 在超大值上会溢出成负数,
    // 把所有归档都判成“太旧”(CLI 的 `--days` 越界会被拦,服务层要自己守住)。
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths).with_policy(BackupPolicy {
        keep_count: 0,
        keep_days: u64::MAX,
        ..BackupPolicy::default()
    });
    let now = unix_millis();
    for index in 0..3 {
        fake_archive(
            &archive_dir,
            &format!("kb-2026010{index}-000000.tar.gz"),
            now - (3 - index as i64) * DAY_MS,
        );
    }
    let report = service.prune(false).expect("清理");
    assert!(
        report.removed.is_empty(),
        "超大 keep_days 不该删任何归档:{report:?}"
    );
    assert_eq!(report.kept, 3);
}

/// 给文件加 / 去掉不可变位;文件系统不支持时返回 `false`(调用方跳过)。
fn set_immutable(path: &Path, on: bool) -> bool {
    std::process::Command::new("chattr")
        .arg(if on { "+i" } else { "-i" })
        .arg(path)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[tokio::test]
async fn prune_reports_archives_it_cannot_delete() {
    // 删不掉的归档要进 `failed`,而不是让整轮清理报错或悄悄算作已删。
    // 用 `chattr +i` 造这个场景;文件系统不支持时明确跳过(不是把测试标 ignore)。
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths).with_policy(BackupPolicy {
        keep_count: 1,
        ..BackupPolicy::default()
    });
    let now = unix_millis();
    fake_archive(&archive_dir, "kb-20260101-000000.tar.gz", now - 2 * DAY_MS);
    fake_archive(&archive_dir, "kb-20260102-000000.tar.gz", now - DAY_MS);
    let victim = archive_dir.join("kb-20260101-000000.tar.gz");
    if !set_immutable(&victim, true) {
        eprintln!("跳过:当前文件系统不支持 chattr +i(无法构造删除失败)");
        return;
    }

    let report = service
        .prune(false)
        .expect("单个文件删不掉不该让整轮清理失败");
    set_immutable(&victim, false);

    assert!(report.removed.is_empty(), "{report:?}");
    assert_eq!(report.failed.len(), 1, "{report:?}");
    assert!(
        report.failed[0].0.contains("kb-20260101"),
        "失败项要带归档名:{report:?}"
    );
    assert_eq!(report.kept, 2, "删不掉的那份要算在保留里:{report:?}");
    assert!(victim.exists(), "删不掉的文件应当还在");
}

// ===== 打包进度 / 失败告警 / 归档校验(设置页「备份」的体验补齐) =====

use kb_service::backup::{
    BackupEntry, BackupFailure, BackupFailureKind, BackupObserver, BackupProgress, BackupStage,
    BackupTrigger,
};

/// 把服务推来的事件记下来(进度 / 成功 / 失败)。
#[derive(Default)]
struct Recorder {
    progress: std::sync::Mutex<Vec<BackupProgress>>,
    done: std::sync::Mutex<Vec<String>>,
    failed: std::sync::Mutex<Vec<BackupFailure>>,
}

impl BackupObserver for Recorder {
    fn progress(&self, progress: &BackupProgress) {
        self.progress.lock().expect("锁").push(progress.clone());
    }

    fn done(&self, entry: &BackupEntry, _trigger: BackupTrigger) {
        self.done.lock().expect("锁").push(entry.name.clone());
    }

    fn failed(&self, failure: &BackupFailure) {
        self.failed.lock().expect("锁").push(failure.clone());
    }
}

/// 第一次取快照就失败、之后成功(用来验证“失败 → 告警 → 成功 → 告警消失”)。
struct FlakySnapshot {
    fail_once: std::sync::atomic::AtomicBool,
}

#[async_trait]
impl DbSnapshot for FlakySnapshot {
    async fn snapshot_to(&self, dest: &Path) -> Result<()> {
        if self
            .fail_once
            .swap(false, std::sync::atomic::Ordering::SeqCst)
        {
            return Err(kb_core::KbError::Internal(
                "取元数据库快照失败:磁盘写满(测试构造)".to_owned(),
            ));
        }
        std::fs::write(dest, b"SQLite format 3\0fake-meta-db")
            .map_err(|err| kb_core::KbError::Internal(format!("写快照失败: {err}")))
    }
}

#[tokio::test]
async fn progress_is_reported_while_packing_and_cleaned_up_afterwards() {
    let (_dir, paths, archive_dir) = home();
    let recorder = Arc::new(Recorder::default());
    let service = service(&paths).with_observer(recorder.clone());
    let entry = service
        .create(&BackupOptions {
            include_sources: true,
        })
        .await
        .expect("备份");

    let events = recorder.progress.lock().expect("锁").clone();
    assert_eq!(
        events.first().map(|progress| progress.stage),
        Some(BackupStage::Preparing),
        "第一阶段应是准备中:{events:?}"
    );
    let packing = events
        .iter()
        .find(|progress| progress.stage == BackupStage::Packing)
        .expect("应有打包阶段");
    assert!(
        packing.files_total > 0 && packing.bytes_total > 0,
        "打包阶段要带上文件 / 字节总数:{packing:?}"
    );
    let last = events.last().expect("至少一条进度");
    assert_eq!(last.stage, BackupStage::Done);
    assert_eq!(
        last.files_done, last.files_total,
        "完成时文件数要对上:{last:?}"
    );
    assert_eq!(
        last.bytes_done, last.bytes_total,
        "完成时字节数要对上:{last:?}"
    );
    assert!(
        events.iter().any(|progress| progress.current.is_some()),
        "应报告正在写的文件:{events:?}"
    );

    // 收尾:进度文件删掉,状态里不再显示“正在打包”
    assert!(
        !archive_dir.join(".progress.json").exists(),
        "完成后不该留下进度文件"
    );
    assert!(service.progress().is_none());
    assert!(service.status().expect("状态").progress.is_none());
    assert_eq!(
        recorder.done.lock().expect("锁").as_slice(),
        std::slice::from_ref(&entry.name)
    );
    assert!(recorder.failed.lock().expect("锁").is_empty());
}

#[tokio::test]
async fn a_failed_backup_is_recorded_and_the_alert_clears_on_success() {
    let (_dir, paths, _archive_dir) = home();
    let recorder = Arc::new(Recorder::default());
    let service = BackupService::new(
        paths.clone(),
        Arc::new(FlakySnapshot {
            fail_once: std::sync::atomic::AtomicBool::new(true),
        }),
    )
    .with_policy(BackupPolicy::default())
    .with_observer(recorder.clone());

    let err = service
        .create(&BackupOptions::default())
        .await
        .expect_err("快照失败要让整份备份失败");
    assert!(err.to_string().contains("快照"), "{err}");

    let failures = service.failures();
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert_eq!(failures[0].trigger, BackupTrigger::Manual);
    assert!(
        failures[0].error.contains("磁盘写满"),
        "失败原因要落盘:{failures:?}"
    );
    assert!(service.alert().is_some(), "失败后应有未解决的告警");
    assert_eq!(recorder.failed.lock().expect("锁").len(), 1);
    assert!(service.state().expect("轻量状态").alert.is_some());
    assert!(service.state().expect("轻量状态").last_success_at.is_none());

    // 再备份一次成功:告警消失,但失败历史保留(设置页还能看到原因)
    service
        .create(&BackupOptions::default())
        .await
        .expect("这次应成功");
    assert!(service.alert().is_none(), "成功一次后告警应消失");
    assert_eq!(service.failures().len(), 1, "历史仍可查");
    assert!(
        service.state().expect("轻量状态").last_success_at.is_some(),
        "成功时间应可见"
    );
}

#[tokio::test]
async fn verify_reports_what_is_in_the_archive() {
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths);
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份");

    let check = service.verify(&entry.name).expect("校验应通过");
    assert_eq!(check.name, entry.name);
    assert_eq!(check.size_bytes, entry.size_bytes);
    assert_eq!(check.created_at, entry.created_at);
    assert!(!check.include_sources);
    // home 里:meta.db + config.toml + skills/demo/manifest.toml + eval/history.jsonl
    assert!(check.files >= 4, "归档里的文件数:{check:?}");
    assert!(check.meta_db_bytes > 0, "{check:?}");
    assert!(check.config_present, "{check:?}");
    assert!(
        check.uncompressed_bytes >= check.meta_db_bytes,
        "解压后总量应不小于 meta.db:{check:?}"
    );
    assert!(
        check.roots.contains(&"meta.db".to_owned()) && check.roots.contains(&"skills".to_owned()),
        "顶层条目:{:?}",
        check.roots
    );
    assert!(check.skipped.is_empty(), "{check:?}");

    // 与系统 tar 对同一个归档的说法一致(我们自己写的头要被真实实现认)
    let listed = tar_list(&archive_dir.join(&entry.name));
    assert!(listed.contains(&"meta.db".to_owned()), "{listed:?}");
    assert!(listed.contains(&"manifest.json".to_owned()), "{listed:?}");
}

#[tokio::test]
async fn verify_rejects_corrupted_and_foreign_archives() {
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths);
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份");
    let bytes = std::fs::read(archive_dir.join(&entry.name)).expect("读归档");

    // 截断:gzip 流不完整
    std::fs::write(
        archive_dir.join("kb-20250101-000000.tar.gz"),
        &bytes[..bytes.len() / 2],
    )
    .expect("写截断归档");
    let err = service
        .verify("kb-20250101-000000.tar.gz")
        .expect_err("截断的归档必须报错");
    assert!(
        err.to_string().contains("归档校验失败"),
        "错误要说清是校验失败:{err}"
    );

    // 改一个字节:CRC32 / tar 头校验和必然对不上
    let mut flipped = bytes.clone();
    let index = flipped.len() / 2;
    flipped[index] ^= 0xFF;
    std::fs::write(archive_dir.join("kb-20250102-000000.tar.gz"), &flipped).expect("写坏归档");
    assert!(
        service.verify("kb-20250102-000000.tar.gz").is_err(),
        "被改过的归档必须报错"
    );

    // 根本不是归档
    std::fs::write(
        archive_dir.join("kb-20250103-000000.tar.gz"),
        b"not an archive",
    )
    .expect("写垃圾");
    assert!(service.verify("kb-20250103-000000.tar.gz").is_err());

    // 不存在 / 非法名字
    assert!(matches!(
        service.verify("kb-20200101-000000.tar.gz"),
        Err(kb_core::KbError::NotFound(_))
    ));
    assert!(service.verify("../etc/passwd.tar.gz").is_err());
}

#[test]
fn stale_progress_files_are_not_reported_as_running() {
    // 进程被杀会留下进度文件:两分钟没更新就不该再显示“正在打包”
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths);
    let now = unix_millis();
    let mut progress = BackupProgress {
        stage: BackupStage::Packing,
        started_at: now - 120_000,
        updated_at: now - 120_000,
        files_total: 4,
        files_done: 1,
        bytes_total: 100,
        bytes_done: 25,
        current: Some("meta.db".to_owned()),
        error: None,
    };
    let path = archive_dir.join(".progress.json");
    std::fs::write(&path, serde_json::to_vec(&progress).expect("序列化")).expect("写进度");
    assert!(service.progress().is_none(), "过期进度不该再当成正在打包");

    progress.updated_at = now;
    std::fs::write(&path, serde_json::to_vec(&progress).expect("序列化")).expect("写进度");
    let running = service.progress().expect("新鲜进度应能读到");
    assert_eq!(running.percent(), 25);
    assert_eq!(running.stage.label(), "打包中");
    assert!(
        service.state().expect("轻量状态").running.is_some(),
        "轻量状态也要能看到进度"
    );
}

// ===== 清理失败进告警 / 异地副本(本阶段补齐的两项) =====

/// 失败记录里某个环节的条目(新的在前)。
fn failures_of(service: &BackupService, kind: BackupFailureKind) -> Vec<BackupFailure> {
    service
        .failures()
        .into_iter()
        .filter(|failure| failure.kind == kind)
        .collect()
}

#[tokio::test]
async fn prune_failures_reach_the_same_alert_channel_as_packing() {
    // 删不掉的旧归档不能只在页面上提示一下:要进 `.failures.json` 与观察者(WS `backup.failed`),
    // 否则定时清理一直失败也没人会发现。
    let (_dir, paths, archive_dir) = home();
    let recorder = Arc::new(Recorder::default());
    let service = service(&paths)
        .with_policy(BackupPolicy {
            keep_count: 1,
            ..BackupPolicy::default()
        })
        .with_observer(recorder.clone());
    let now = unix_millis();
    fake_archive(&archive_dir, "kb-20260101-000000.tar.gz", now - 2 * DAY_MS);
    fake_archive(&archive_dir, "kb-20260102-000000.tar.gz", now - DAY_MS);
    fake_archive(&archive_dir, "kb-20260103-000000.tar.gz", now - 60_000);
    let victim = archive_dir.join("kb-20260102-000000.tar.gz");
    if !set_immutable(&victim, true) {
        eprintln!("跳过:当前文件系统不支持 chattr +i(无法构造删除失败)");
        return;
    }

    let report = service.prune(false).expect("单个删不掉不该让整轮清理失败");
    assert_eq!(report.failed.len(), 1, "{report:?}");

    // ① 落盘:一条 `prune` 失败,原因里带归档名
    let failures = failures_of(&service, BackupFailureKind::Prune);
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
        failures[0].error.contains("kb-20260102"),
        "失败原因要带归档名:{failures:?}"
    );
    // ② 告警:设置页与外壳横幅都读这两个
    let alert = service.alert().expect("清理失败要产生告警");
    assert_eq!(alert.kind, BackupFailureKind::Prune);
    assert_eq!(
        service.state().expect("轻量状态").alert.map(|a| a.kind),
        Some(BackupFailureKind::Prune)
    );
    // ③ 观察者:守护进程把它推成 WS 的 `backup.failed`
    let events = recorder.failed.lock().expect("锁").clone();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0].kind, BackupFailureKind::Prune);
    // 打包失败与清理失败互不冒充
    assert!(failures_of(&service, BackupFailureKind::Pack).is_empty());

    // 能删了之后再清一次:告警消失,失败历史保留
    set_immutable(&victim, false);
    let report = service.prune(false).expect("清理");
    assert_eq!(report.failed.len(), 0, "{report:?}");
    assert!(!report.removed.is_empty(), "{report:?}");
    assert!(service.alert().is_none(), "清理成功后告警应消失");
    assert_eq!(
        failures_of(&service, BackupFailureKind::Prune).len(),
        1,
        "历史仍可查"
    );
}

#[tokio::test]
async fn dry_run_prune_never_raises_an_alert() {
    // 预演什么都没删:不该留下告警(否则点一次「预演」就挂一条横幅)
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths).with_policy(BackupPolicy {
        keep_count: 1,
        ..BackupPolicy::default()
    });
    let now = unix_millis();
    fake_archive(&archive_dir, "kb-20260101-000000.tar.gz", now - 2 * DAY_MS);
    fake_archive(&archive_dir, "kb-20260102-000000.tar.gz", now - DAY_MS);
    let report = service.prune(true).expect("预演");
    assert_eq!(report.removed.len(), 1, "{report:?}");
    assert!(service.alert().is_none(), "{:?}", service.failures());
    assert!(!archive_dir.join(".failures.json").exists());
}

#[tokio::test]
async fn archives_are_copied_to_the_mirror_dirs_and_pruned_together() {
    // 异地 / 外部存储:归档在本机落盘后再复制一份到 `mirror_dirs` 里的目录,
    // 清理与删除要同步过去,否则外部目录会永远留着删不掉的历史。
    let (_dir, paths, archive_dir) = home();
    let offsite = tempfile::tempdir().expect("临时异地目录");
    let offsite_dir = offsite.path().join("kb-backups");
    let recorder = Arc::new(Recorder::default());
    let service = service(&paths)
        .with_policy(BackupPolicy {
            mirror_dirs: vec![offsite_dir.display().to_string()],
            ..BackupPolicy::default()
        })
        .with_observer(recorder.clone());

    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份");
    // ① 副本真的落到了外部目录,字节数与本机一致(还没配置这个目录时它并不存在)
    let copy = offsite_dir.join(&entry.name);
    assert!(copy.is_file(), "异地副本应存在:{}", copy.display());
    assert_eq!(
        std::fs::metadata(&copy).expect("副本元数据").len(),
        entry.size_bytes,
        "副本大小应与归档一致"
    );
    assert_eq!(
        std::fs::read(&copy).expect("读副本"),
        std::fs::read(archive_dir.join(&entry.name)).expect("读归档"),
        "副本内容应与归档逐字节一致"
    );
    // 不留半份文件
    assert!(
        !offsite_dir.join(format!(".{}.part", entry.name)).exists(),
        "复制完不该留下 .part"
    );
    // ② 进度里出现过「复制中」,收尾后进度文件删掉
    let stages: Vec<BackupStage> = recorder
        .progress
        .lock()
        .expect("锁")
        .iter()
        .map(|progress| progress.stage)
        .collect();
    assert!(
        stages.contains(&BackupStage::Mirroring),
        "配置了异地目录就该有复制阶段:{stages:?}"
    );
    assert_eq!(stages.last().copied(), Some(BackupStage::Done));
    assert!(service.progress().is_none(), "完成后不该留下进度文件");
    // ③ 状态页能看到这个目录的现状(验收:副本跟不跟得上)
    let mirrors = service.status().expect("状态").mirrors;
    assert_eq!(mirrors.len(), 1, "{mirrors:?}");
    assert_eq!(mirrors[0].dir, offsite_dir.display().to_string());
    assert!(mirrors[0].last_ok_at > 0, "{mirrors:?}");
    assert!(mirrors[0].last_error.is_none(), "{mirrors:?}");
    assert!(mirrors[0].has_latest, "{mirrors:?}");
    assert_eq!(mirrors[0].copies, 1, "{mirrors:?}");
    assert!(service.alert().is_none(), "复制成功不该有告警");

    // ④ 删除一份归档:异地副本跟着删掉
    service.delete(&entry.name).expect("删除");
    assert!(!copy.exists(), "异地副本应随本机归档一起删掉");
    assert!(!archive_dir.join(&entry.name).exists());
}

#[tokio::test]
async fn prune_removes_mirror_copies_too() {
    // 保留策略对外部目录同样生效:否则异地目录只增不减,迟早把外接盘吃满
    let (_dir, paths, archive_dir) = home();
    let offsite = tempfile::tempdir().expect("临时异地目录");
    let offsite_dir = offsite.path().join("kb-backups");
    let service = service(&paths).with_policy(BackupPolicy {
        keep_count: 1,
        mirror_dirs: vec![offsite_dir.display().to_string()],
        ..BackupPolicy::default()
    });
    std::fs::create_dir_all(&offsite_dir).expect("建异地目录");
    let now = unix_millis();
    for (name, at) in [
        ("kb-20260101-000000.tar.gz", now - 2 * DAY_MS),
        ("kb-20260102-000000.tar.gz", now - DAY_MS),
    ] {
        fake_archive(&archive_dir, name, at);
        fake_archive(&offsite_dir, name, at);
    }
    let report = service.prune(false).expect("清理");
    assert_eq!(report.removed.len(), 1, "{report:?}");
    assert!(report.failed.is_empty(), "{report:?}");
    assert!(
        !offsite_dir.join("kb-20260101-000000.tar.gz").exists(),
        "被清掉的那份副本也该消失"
    );
    assert!(
        offsite_dir.join("kb-20260102-000000.tar.gz").exists(),
        "保留的那份副本要在"
    );
    let mirrors = service.status().expect("状态").mirrors;
    assert_eq!(mirrors[0].copies, 1, "{mirrors:?}");
}

#[tokio::test]
async fn a_broken_mirror_is_reported_without_failing_the_backup() {
    // 外接盘没挂上 / 只读:本机备份照样算成功(它确实存下来了),但要有可见的告警
    let (_dir, paths, archive_dir) = home();
    let offsite = tempfile::tempdir().expect("临时异地目录");
    // 用一个**普通文件**占住目录名,`create_dir_all` 必然失败
    let blocked = offsite.path().join("not-a-dir");
    std::fs::write(&blocked, b"x").expect("写占位文件");
    let recorder = Arc::new(Recorder::default());
    let service = service(&paths)
        .with_policy(BackupPolicy {
            mirror_dirs: vec![blocked.display().to_string()],
            ..BackupPolicy::default()
        })
        .with_observer(recorder.clone());

    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("异地复制失败不该让备份失败");
    assert!(
        archive_dir.join(&entry.name).is_file(),
        "本机归档应正常落盘"
    );

    let failures = failures_of(&service, BackupFailureKind::Mirror);
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(
        failures[0].error.contains("not-a-dir"),
        "失败原因要带目录:{failures:?}"
    );
    assert_eq!(recorder.failed.lock().expect("锁").len(), 1);
    let alert = service.alert().expect("复制失败要产生告警");
    assert_eq!(alert.kind, BackupFailureKind::Mirror);
    // 打包本身是成功的:这条告警不该把“最近一次成功备份”弄丢
    assert!(
        service.state().expect("轻量状态").last_success_at.is_some(),
        "本机备份成功就该有成功时间"
    );
    let mirrors = service.status().expect("状态").mirrors;
    assert!(mirrors[0].last_error.is_some(), "{mirrors:?}");
    assert!(!mirrors[0].has_latest, "{mirrors:?}");

    // 修好之后(把占位文件换成目录)再备份一次:告警消失,历史保留。
    // 归档名只精确到秒,同一秒里连备两次会撞名,所以等过这一秒再备。
    std::fs::remove_file(&blocked).expect("删占位文件");
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    service
        .create(&BackupOptions::default())
        .await
        .expect("第二次备份");
    assert!(service.alert().is_none(), "复制成功后告警应消失");
    assert_eq!(
        failures_of(&service, BackupFailureKind::Mirror).len(),
        1,
        "成功的那次不新增失败记录,历史保留一条"
    );
    assert!(
        service.status().expect("状态").mirrors[0]
            .last_error
            .is_none(),
        "修好之后 last_error 应清掉"
    );
}

#[tokio::test]
async fn mirror_dir_equal_to_the_archive_dir_is_reported_not_copied() {
    // 配成 `backups` 自己是最容易犯的错:照做会把归档“复制给自己”,所以要直接报出来
    let (_dir, paths, archive_dir) = home();
    let service = service(&paths).with_policy(BackupPolicy {
        mirror_dirs: vec![archive_dir.display().to_string()],
        ..BackupPolicy::default()
    });
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份本身应成功");
    assert!(archive_dir.join(&entry.name).is_file());
    let failures = failures_of(&service, BackupFailureKind::Mirror);
    assert_eq!(failures.len(), 1, "{failures:?}");
    assert!(failures[0].error.contains("与归档目录相同"), "{failures:?}");
}

#[tokio::test]
async fn relative_mirror_dirs_resolve_under_kb_home() {
    let (_dir, paths, _archive_dir) = home();
    let service = service(&paths).with_policy(BackupPolicy {
        mirror_dirs: vec!["offsite".to_owned()],
        ..BackupPolicy::default()
    });
    assert_eq!(service.mirror_dirs(), vec![paths.home().join("offsite")]);
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份");
    assert!(
        paths.home().join("offsite").join(&entry.name).is_file(),
        "相对路径按 KB_HOME 解析"
    );
}

#[tokio::test]
async fn verify_accepts_a_path_so_mirror_copies_can_be_checked_in_place() {
    // 本机磁盘坏了、只剩异地副本时,校验要能直接看副本 —— 否则得先把它挪回 backups/ 才能验。
    let (_dir, paths, archive_dir) = home();
    let offsite = tempfile::tempdir().expect("异地目录");
    let offsite_dir = offsite.path().join("kb-backups");
    let service = service(&paths).with_policy(BackupPolicy {
        mirror_dirs: vec![offsite_dir.display().to_string()],
        ..BackupPolicy::default()
    });
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份");
    let copy = offsite_dir.join(&entry.name);

    let check = service
        .verify(&copy.display().to_string())
        .expect("副本应能直接校验");
    assert_eq!(check.name, entry.name, "报告里用文件名,不整条路径");
    assert!(check.meta_db_bytes > 0, "{check:?}");

    // 不是归档的路径 / 不存在的路径都要报错,而不是当成“没找到备份”
    assert!(matches!(
        service.verify("/tmp/not-an-archive.txt"),
        Err(kb_core::KbError::InvalidInput(_))
    ));
    assert!(matches!(
        service.verify("/tmp/definitely-missing.tar.gz"),
        Err(kb_core::KbError::NotFound(_))
    ));
    // 删除仍然只认文件名(不允许借路径删别处的文件)
    assert!(service.delete(&copy.display().to_string()).is_err());
    assert!(copy.exists(), "路径形式的删除必须被拒,副本不能被删");
    assert!(archive_dir.join(&entry.name).is_file());
}

#[tokio::test]
async fn every_backup_is_verified_automatically_and_the_result_is_visible() {
    // 备份写完就自己验一遍:不必等人手点「校验」才知道这份归档能不能拿去恢复
    let (_dir, paths, archive_dir) = home();
    let recorder = Arc::new(Recorder::default());
    let service = service(&paths).with_observer(recorder.clone());
    assert!(
        service.status().expect("状态").last_check.is_none(),
        "还没备份过就不该有校验结果"
    );

    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份");
    let last = service
        .status()
        .expect("状态")
        .last_check
        .expect("校验结果");
    assert!(last.ok, "{last:?}");
    assert_eq!(last.name, entry.name);
    assert!(last.files >= 2, "至少 meta.db 与 config.toml:{last:?}");
    assert!(last.uncompressed_bytes > 0, "{last:?}");
    assert!(last.meta_db_bytes > 0, "{last:?}");
    assert!(last.at > 0);
    assert!(last.error.is_none());
    // 结论也落了盘(另一个进程 / CLI 读得到)
    assert!(
        archive_dir.join(".verify.json").is_file(),
        "校验结果应落到 backups/.verify.json"
    );
    assert!(service.alert().is_none(), "校验通过不该有告警");

    // 进度里出现过「校验中」:大归档校验要几秒,页面不该在这段时间显示“已完成”
    let stages: Vec<BackupStage> = recorder
        .progress
        .lock()
        .expect("锁")
        .iter()
        .map(|progress| progress.stage)
        .collect();
    assert!(
        stages.contains(&BackupStage::Verifying),
        "写完之后应有校验阶段:{stages:?}"
    );

    // 手工 verify 不覆盖“最近一次自动校验”的记录(它只回答“我手上这份怎么样”)
    service.verify(&entry.name).expect("手工校验");
    assert_eq!(
        service
            .status()
            .expect("状态")
            .last_check
            .expect("校验结果")
            .at,
        last.at,
        "手工校验不改最近一次自动校验的时间"
    );
}

// ---------------------------------------------------------------- 多用户:账号库与各用户的知识库

/// 假快照器:直接拷文件(真实实现是另开连接 `VACUUM INTO`)。
struct CopySnapshotter {
    fail_on: Option<&'static str>,
}

impl SqliteSnapshotter for CopySnapshotter {
    fn snapshot(&self, src: &Path, dst: &Path) -> Result<()> {
        if self
            .fail_on
            .is_some_and(|name| src.to_string_lossy().contains(name))
        {
            return Err(kb_core::KbError::Internal("这个库拍不下来".to_owned()));
        }
        std::fs::copy(src, dst)
            .map(|_| ())
            .map_err(|err| kb_core::KbError::Internal(format!("拷快照失败: {err}")))
    }
}

fn sqlite_like(tag: &str) -> Vec<u8> {
    let mut bytes = b"SQLite format 3\0".to_vec();
    bytes.extend_from_slice(tag.as_bytes());
    bytes
}

/// 在假 KB_HOME 里放一个账号库、两个用户知识库(其中一个有原件)、头像,和一个不合法的目录。
fn multiuser_home(paths: &KbPaths) {
    std::fs::write(paths.system_db(), sqlite_like("system")).unwrap();
    for id in ["sp_alice", "sp_bob"] {
        let dir = paths.space_dir(id).unwrap();
        std::fs::create_dir_all(dir.join("lance/tbl")).unwrap();
        std::fs::write(dir.join("meta.db"), sqlite_like(id)).unwrap();
        std::fs::write(dir.join("lance/tbl/data.lance"), vec![9u8; 2048]).unwrap();
    }
    let alice = paths.space_dir("sp_alice").unwrap();
    std::fs::create_dir_all(alice.join("sources/docs")).unwrap();
    std::fs::write(alice.join("sources/docs/a.md"), "# alice 的原件\n").unwrap();
    // 对备份不重要的东西不能进归档:向量、没做完的上传、代理工作目录
    std::fs::create_dir_all(alice.join("agent-workspace")).unwrap();
    std::fs::write(alice.join("agent-workspace/scratch.txt"), "临时").unwrap();
    std::fs::create_dir_all(paths.avatars_dir()).unwrap();
    std::fs::write(paths.avatars_dir().join("usr_1.png"), b"png").unwrap();
    // 名字不是合法知识库 id 的目录:不进归档
    let junk = paths.spaces_dir().join("not a space");
    std::fs::create_dir_all(&junk).unwrap();
    std::fs::write(junk.join("meta.db"), sqlite_like("junk")).unwrap();
}

fn multiuser_service(paths: &KbPaths, fail_on: Option<&'static str>) -> BackupService {
    service(paths).with_extra_snapshotter(Arc::new(CopySnapshotter { fail_on }))
}

#[tokio::test]
async fn a_multiuser_backup_carries_the_account_database_and_every_users_library() {
    let (_dir, paths, archive_dir) = home();
    multiuser_home(&paths);
    let service = multiuser_service(&paths, None);
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份");
    let listed = tar_list(&archive_dir.join(&entry.name));
    for member in [
        "meta.db",
        "system.db",
        "spaces/sp_alice/meta.db",
        "spaces/sp_bob/meta.db",
        "avatars/usr_1.png",
    ] {
        assert!(
            listed.contains(&member.to_owned()),
            "缺 {member}:{listed:?}"
        );
    }
    // 内容是各自的快照,不是串了
    assert_eq!(
        tar_read(&archive_dir.join(&entry.name), "system.db"),
        sqlite_like("system")
    );
    assert_eq!(
        tar_read(&archive_dir.join(&entry.name), "spaces/sp_bob/meta.db"),
        sqlite_like("sp_bob")
    );
    // 不该进归档的
    for unwanted in ["lance", "agent-workspace", "not a space", "sources"] {
        assert!(
            !listed.iter().any(|name| name.contains(unwanted)),
            "不该有 {unwanted}:{listed:?}"
        );
    }
    // 校验认得出来
    let check = service.verify(&entry.name).expect("校验通过");
    assert!(check.system_db);
    assert_eq!(check.spaces, 2);
    // 打包用的中间快照不残留
    assert!(
        leftover_temp_files(&archive_dir).is_empty(),
        "{:?}",
        leftover_temp_files(&archive_dir)
    );
    // 不含原件的备份不带用户的原件
    assert!(
        !listed
            .iter()
            .any(|name| name.starts_with("spaces/sp_alice/sources"))
    );
}

#[tokio::test]
async fn including_originals_also_includes_each_users_originals() {
    let (_dir, paths, archive_dir) = home();
    multiuser_home(&paths);
    let service = multiuser_service(&paths, None);
    let entry = service
        .create(&BackupOptions {
            include_sources: true,
        })
        .await
        .expect("备份");
    let listed = tar_list(&archive_dir.join(&entry.name));
    assert!(
        listed.contains(&"spaces/sp_alice/sources/docs/a.md".to_owned()),
        "{listed:?}"
    );
    assert_eq!(
        tar_read(
            &archive_dir.join(&entry.name),
            "spaces/sp_alice/sources/docs/a.md"
        ),
        "# alice 的原件\n".as_bytes()
    );
    assert!(service.verify(&entry.name).is_ok());
}

#[tokio::test]
async fn one_library_that_cannot_be_snapshotted_fails_the_whole_backup_loudly() {
    let (_dir, paths, archive_dir) = home();
    multiuser_home(&paths);
    // 宁可这次备份失败,也不要一份「成功」却悄悄少了 bob 全部数据的备份
    let service = multiuser_service(&paths, Some("sp_bob"));
    let err = service
        .create(&BackupOptions::default())
        .await
        .expect_err("应失败");
    assert!(err.to_string().contains("拍不下来"), "{err}");
    assert!(
        std::fs::read_dir(&archive_dir)
            .unwrap()
            .flatten()
            .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tar.gz")),
        "失败后不该留下归档"
    );
    assert!(leftover_temp_files(&archive_dir).is_empty());
}

#[tokio::test]
async fn an_archive_whose_manifest_promises_a_library_that_is_missing_is_not_valid() {
    let (_dir, paths, archive_dir) = home();
    multiuser_home(&paths);
    let service = multiuser_service(&paths, None);
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份");
    // 手工造一份「缺了 bob」的归档:拿正常归档解出来,删掉 bob 的库,再按同样的 manifest 重新打包
    let work = tempfile::tempdir().unwrap();
    let status = Command::new("tar")
        .arg("-xzf")
        .arg(archive_dir.join(&entry.name))
        .arg("-C")
        .arg(work.path())
        .status()
        .unwrap();
    assert!(status.success());
    std::fs::remove_file(work.path().join("spaces/sp_bob/meta.db")).unwrap();
    // manifest.files 也要对得上,否则会先报「文件数不符」;这里要验的是「承诺了却缺」那条
    let manifest_path = work.path().join("manifest.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&manifest_path).unwrap()).unwrap();
    manifest["files"] = (manifest["files"].as_u64().unwrap() - 1).into();
    std::fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
    let broken = archive_dir.join("kb-20250105-000000.tar.gz");
    // 只打普通文件(校验器不认目录条目),manifest 放在最前面
    let mut names: Vec<String> = Vec::new();
    let mut stack = vec![work.path().to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            if entry.path().is_dir() {
                stack.push(entry.path());
            } else {
                names.push(
                    entry
                        .path()
                        .strip_prefix(work.path())
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    names.sort_by_key(|name| name != "manifest.json");
    let list = work.path().join("..").join("members.txt");
    std::fs::write(&list, names.join("\n")).unwrap();
    let status = Command::new("tar")
        .arg("-czf")
        .arg(&broken)
        .arg("-C")
        .arg(work.path())
        .arg("--no-recursion")
        .arg("-T")
        .arg(&list)
        .status()
        .unwrap();
    assert!(status.success());
    let err = service
        .verify("kb-20250105-000000.tar.gz")
        .expect_err("缺库的归档必须报错");
    assert!(
        err.to_string().contains("sp_bob"),
        "要点名缺的是哪个库:{err}"
    );
    // 老归档(manifest 没有 system_db / spaces 字段)照常能校验:不带这两项就按没有处理
    let old_work = tempfile::tempdir().unwrap();
    let plain = service_plain_archive(&paths, &archive_dir, old_work.path()).await;
    assert!(service.verify(&plain).is_ok());
}

/// 没有挂快照器的备份(单用户部署 / 老用法)。
async fn service_plain_archive(paths: &KbPaths, archive_dir: &Path, _scratch: &Path) -> String {
    let plain = service(paths);
    // 归档名精确到秒:等一秒,免得和上一份撞名
    tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
    let entry = plain.create(&BackupOptions::default()).await.expect("备份");
    let listed = tar_list(&archive_dir.join(&entry.name));
    assert!(
        !listed.contains(&"system.db".to_owned()),
        "没挂快照器就只有主知识库:{listed:?}"
    );
    entry.name
}

#[tokio::test]
async fn archives_and_their_mirror_copies_are_readable_by_the_owner_only() {
    use std::os::unix::fs::PermissionsExt;
    let (dir, paths, archive_dir) = home();
    let mirror = dir.path().join("usb");
    let service = service(&paths).with_policy(BackupPolicy {
        mirror_dirs: vec![mirror.display().to_string()],
        ..BackupPolicy::default()
    });
    let entry = service
        .create(&BackupOptions::default())
        .await
        .expect("备份");
    // 归档里有账号库和每个人的笔记:不管所在目录的权限怎么样,文件本身只有属主能读
    let local = std::fs::metadata(archive_dir.join(&entry.name)).unwrap();
    assert_eq!(local.permissions().mode() & 0o777, 0o600, "本机归档");
    let copy = std::fs::metadata(mirror.join(&entry.name)).expect("异地副本在");
    assert_eq!(copy.permissions().mode() & 0o777, 0o600, "异地副本");
}
