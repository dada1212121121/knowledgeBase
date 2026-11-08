use std::time::Duration;

use kb_core::account::PRIMARY_SPACE_ID;
use kb_core::config::Config;
use kb_core::model::{InsightKind, ItemStatus};

use super::*;

const T0: i64 = 1_800_000_000_000;

/// 假的笔记来源:按知识库 id 返回预置的笔记,可以设成读取失败。
#[derive(Default)]
struct FakeNotes {
    by_space: Mutex<HashMap<String, Vec<Insight>>>,
    fail: std::sync::atomic::AtomicBool,
    asked: Mutex<Vec<String>>,
}

#[async_trait]
impl NotesSource for FakeNotes {
    async fn insights(&self, space_id: &str) -> Result<Vec<Insight>> {
        self.asked.lock().unwrap().push(space_id.to_owned());
        if self.fail.load(Ordering::Relaxed) {
            return Err(KbError::Internal("数据库坏了 /secret/path".to_owned()));
        }
        // 只给被问到的那个知识库的笔记,别人的拿不到
        Ok(self
            .by_space
            .lock()
            .unwrap()
            .get(space_id)
            .cloned()
            .unwrap_or_default())
    }
}

fn insight(id: &str, title: &str, body: &str) -> Insight {
    Insight {
        id: id.to_owned(),
        collection: "_global".to_owned(),
        title: title.to_owned(),
        body_md: body.to_owned(),
        kind: InsightKind::Note,
        tags: vec![],
        related_paths: vec![],
        status: ItemStatus::Active,
        version: 1,
        valid_from: 0,
        valid_until: None,
        superseded_by: None,
        created_by: "user".to_owned(),
        batch_id: None,
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_000,
    }
}

struct Env {
    _dir: tempfile::TempDir,
    paths: KbPaths,
    manager: Arc<ExportManager>,
    notes: Arc<FakeNotes>,
}

fn env_with(reserve_gb: u64) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let paths = KbPaths::from_home(dir.path());
    paths.ensure_dirs().unwrap();
    let mut config = Config::default();
    config.quota.disk_reserve_gb = reserve_gb;
    // 固定时钟:完成时刻和测试里传入的 now 在同一条时间线上(否则假时间与真时间混用,过期判断全乱)
    let notes = Arc::new(FakeNotes::default());
    let manager = ExportManager::with_clock(
        paths.clone(),
        paths.exports_dir().to_path_buf(),
        Arc::new(ConfigStore::new(config)),
        notes.clone(),
        Arc::new(|| T0),
    );
    Env {
        _dir: dir,
        paths,
        manager,
        notes,
    }
}

fn env() -> Env {
    env_with(0)
}

impl Env {
    /// 给某个知识库的 sources 放文件。
    fn put(&self, space: &str, rel: &str, content: &[u8]) {
        let path = self.paths.for_space(space).unwrap().sources_dir().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    /// 等任务做完,返回最终状态。
    async fn finish(&self, user: &str, now: i64) -> ExportStatus {
        for _ in 0..200 {
            let status = self.manager.status(user, now).await.unwrap();
            if !matches!(status, ExportStatus::Running { .. }) {
                return status;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("导出一直没做完");
    }

    /// 读导出文件里的成员名。
    fn members(&self, path: &Path) -> Vec<String> {
        use std::io::Read;
        let mut raw = Vec::new();
        flate2::read::GzDecoder::new(std::fs::File::open(path).unwrap())
            .read_to_end(&mut raw)
            .unwrap();
        let (mut names, mut offset, mut long): (Vec<String>, usize, Option<String>) =
            (Vec::new(), 0, None);
        while offset + 512 <= raw.len() && raw[offset..offset + 512].iter().any(|b| *b != 0) {
            let header = &raw[offset..offset + 512];
            let text = |r: std::ops::Range<usize>| {
                String::from_utf8_lossy(&header[r])
                    .trim_end_matches('\0')
                    .trim()
                    .to_owned()
            };
            let size = usize::from_str_radix(&text(124..136), 8).unwrap();
            let name = text(0..100);
            offset += 512;
            let body = String::from_utf8_lossy(&raw[offset..offset + size])
                .trim_end_matches('\0')
                .to_owned();
            offset += size.div_ceil(512) * 512;
            if header[156] == b'L' {
                long = Some(body);
            } else {
                names.push(long.take().unwrap_or(name));
            }
        }
        names
    }
}

#[tokio::test]
async fn an_export_runs_in_the_background_then_offers_exactly_the_users_own_files() {
    let env = env();
    env.put("sp_alice", "paper.pdf", b"alice paper");
    env.put("sp_alice", "notes/day1.md", b"day one");
    env.put("sp_bob", "bob-secret.txt", b"bob private");
    let started = env
        .manager
        .start("usr_alice", Some("sp_alice"), T0)
        .await
        .unwrap();
    assert!(
        matches!(started, ExportStatus::Running { files: 2, .. }),
        "{started:?}"
    );
    let ExportStatus::Ready {
        size,
        files,
        skipped,
        expires_at,
        ..
    } = env.finish("usr_alice", T0).await
    else {
        panic!("应已完成");
    };
    assert_eq!((files, skipped.len()), (2, 0));
    assert!(size > 0 && expires_at > T0, "{size} {expires_at}");
    let (path, name) = env
        .manager
        .file("usr_alice", T0)
        .await
        .unwrap()
        .expect("可下载");
    assert!(
        is_export_name(&name) && name.starts_with("usr_alice-"),
        "{name}"
    );
    assert!(path.starts_with(env.paths.exports_dir()));
    assert_eq!(
        env.members(&path),
        [
            "manifest.json",
            "sources/notes/day1.md",
            "sources/paper.pdf"
        ]
    );
    // bob 看不到 alice 的文件,他自己还没导出过
    assert!(env.manager.file("usr_bob", T0).await.unwrap().is_none());
    assert!(matches!(
        env.manager.status("usr_bob", T0).await.unwrap(),
        ExportStatus::Idle { today_left: 3 }
    ));
}

#[tokio::test]
async fn the_owner_of_the_primary_space_exports_only_sources_never_the_data_root() {
    let env = env();
    // 主知识库就是数据根目录:同一层有配置、密钥和所有人的账号库
    let home = env.paths.home();
    std::fs::write(home.join("config.toml"), b"[server]").unwrap();
    std::fs::write(home.join("secrets.toml"), b"api_key = \"sk-SECRET\"").unwrap();
    std::fs::write(env.paths.system_db(), b"all accounts").unwrap();
    std::fs::create_dir_all(home.join("spaces/sp_bob")).unwrap();
    std::fs::write(home.join("spaces/sp_bob/meta.db"), b"bob notes").unwrap();
    env.put(PRIMARY_SPACE_ID, "mine.txt", b"admin's own upload");
    env.manager
        .start("usr_admin", Some(PRIMARY_SPACE_ID), T0)
        .await
        .unwrap();
    assert!(matches!(
        env.finish("usr_admin", T0).await,
        ExportStatus::Ready { files: 1, .. }
    ));
    let (path, _) = env.manager.file("usr_admin", T0).await.unwrap().unwrap();
    assert_eq!(env.members(&path), ["manifest.json", "sources/mine.txt"]);
    let raw = std::fs::read(&path).unwrap();
    // 压缩后看不到明文,所以解压后再查一遍
    let mut plain = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&raw[..]), &mut plain).unwrap();
    for needle in [
        &b"sk-SECRET"[..],
        b"all accounts",
        b"bob notes",
        b"[server]",
    ] {
        assert!(
            !plain.windows(needle.len()).any(|w| w == needle),
            "{:?}",
            String::from_utf8_lossy(needle)
        );
    }
}

#[tokio::test]
async fn only_one_export_per_person_at_a_time_and_three_per_day() {
    let env = env();
    env.put("sp_alice", "big.bin", &vec![1u8; 2_000_000]);
    env.manager
        .start("usr_alice", Some("sp_alice"), T0)
        .await
        .unwrap();
    // 第一个还没做完就再要一个:拒绝(可能碰巧已经做完,所以只在确实还在跑时断言)
    if matches!(
        env.manager.status("usr_alice", T0).await.unwrap(),
        ExportStatus::Running { .. }
    ) {
        let error = env
            .manager
            .start("usr_alice", Some("sp_alice"), T0)
            .await
            .unwrap_err();
        assert!(matches!(error, KbError::Exists(_)), "{error:?}");
    }
    env.finish("usr_alice", T0).await;
    for _ in 0..2 {
        env.manager
            .start("usr_alice", Some("sp_alice"), T0 + 1)
            .await
            .unwrap();
        env.finish("usr_alice", T0 + 1).await;
    }
    // 今天第 4 次:拒绝,并说清楚
    let error = env
        .manager
        .start("usr_alice", Some("sp_alice"), T0 + 2)
        .await
        .unwrap_err();
    assert!(
        matches!(&error, KbError::Forbidden(text) if text.contains("今天已经导出 3 次")),
        "{error:?}"
    );
    // 别人不受影响
    env.put("sp_bob", "x.txt", b"x");
    env.manager
        .start("usr_bob", Some("sp_bob"), T0 + 2)
        .await
        .unwrap();
    // 第二天恢复
    env.finish("usr_bob", T0 + 2).await;
    assert!(
        env.manager
            .start("usr_alice", Some("sp_alice"), T0 + 86_400_000)
            .await
            .is_ok()
    );
}

#[tokio::test]
async fn a_new_export_replaces_the_previous_file_instead_of_piling_up() {
    let env = env();
    env.put("sp_alice", "a.txt", b"a");
    env.manager
        .start("usr_alice", Some("sp_alice"), T0)
        .await
        .unwrap();
    env.finish("usr_alice", T0).await;
    let (first, _) = env.manager.file("usr_alice", T0).await.unwrap().unwrap();
    env.manager
        .start("usr_alice", Some("sp_alice"), T0 + 1)
        .await
        .unwrap();
    env.finish("usr_alice", T0 + 1).await;
    let (second, _) = env
        .manager
        .file("usr_alice", T0 + 1)
        .await
        .unwrap()
        .unwrap();
    assert_ne!(first, second);
    assert!(!first.exists(), "上一份应被删掉");
    assert_eq!(
        std::fs::read_dir(env.paths.exports_dir()).unwrap().count(),
        1
    );
}

#[tokio::test]
async fn nothing_to_export_without_a_knowledge_base_and_a_full_disk_refuses() {
    let env = env();
    let error = env.manager.start("usr_alice", None, T0).await.unwrap_err();
    assert!(matches!(error, KbError::NotFound(_)), "{error:?}");
    // 保留空间设成不可能满足的值,模拟磁盘不够
    let full = env_with(100_000_000);
    full.put("sp_alice", "a.txt", b"a");
    let error = full
        .manager
        .start("usr_alice", Some("sp_alice"), T0)
        .await
        .unwrap_err();
    assert!(
        matches!(&error, KbError::Unavailable(text) if text.contains("磁盘")),
        "{error:?}"
    );
    // 被拒绝的申请不占每日次数、不留文件
    assert!(matches!(
        full.manager.status("usr_alice", T0).await.unwrap(),
        ExportStatus::Idle { today_left: 3 }
    ));
    assert_eq!(
        std::fs::read_dir(full.paths.exports_dir()).unwrap().count(),
        0
    );
}

#[tokio::test]
async fn finished_exports_expire_and_orphans_from_a_restart_are_swept_by_age() {
    let env = env();
    env.put("sp_alice", "a.txt", b"a");
    env.manager
        .start("usr_alice", Some("sp_alice"), T0)
        .await
        .unwrap();
    env.finish("usr_alice", T0).await;
    let (path, _) = env.manager.file("usr_alice", T0).await.unwrap().unwrap();
    // 一天后过期:状态回到 Idle,文件被删
    // 任务时间线:完成时刻是固定时钟 T0,所以一天多一点之后就过期
    let later = T0 + KEEP_MS + 1;
    assert!(
        env.manager
            .file("usr_alice", later)
            .await
            .unwrap()
            .is_none()
    );
    assert!(!path.exists(), "过期的导出文件应被删除");
    assert!(matches!(
        env.manager.status("usr_alice", later).await.unwrap(),
        ExportStatus::Idle { .. }
    ));
    // 进程重启后内存状态没了,留在磁盘上的旧文件按修改时间清理;新文件不动
    let old = env
        .paths
        .exports_dir()
        .join("usr_x-0123456789abcdef.tar.gz.part");
    let fresh = env
        .paths
        .exports_dir()
        .join("usr_y-0123456789abcdef.tar.gz");
    std::fs::write(&old, b"x").unwrap();
    std::fs::write(&fresh, b"y").unwrap();
    let long_ago = std::time::SystemTime::now() - Duration::from_secs(48 * 3600);
    std::fs::File::options()
        .write(true)
        .open(&old)
        .unwrap()
        .set_modified(long_ago)
        .unwrap();
    env.manager.sweep(crate::daemon::now_millis());
    assert!(!old.exists() && fresh.exists());
}

#[tokio::test]
async fn discarding_removes_the_file_but_not_while_it_is_still_being_made() {
    let env = env();
    env.put("sp_alice", "a.txt", b"a");
    env.manager
        .start("usr_alice", Some("sp_alice"), T0)
        .await
        .unwrap();
    env.finish("usr_alice", T0).await;
    let (path, _) = env.manager.file("usr_alice", T0).await.unwrap().unwrap();
    env.manager.discard("usr_alice").await.unwrap();
    assert!(!path.exists());
    assert!(env.manager.file("usr_alice", T0).await.unwrap().is_none());
    env.manager.discard("usr_alice").await.unwrap(); // 重复删除安静通过
}

#[tokio::test]
async fn skipped_items_are_reported_to_the_user() {
    let env = env();
    env.put("sp_alice", "ok.txt", b"ok");
    env.put("sp_alice", ".quarantine/up/evil.exe", b"MZ");
    let sources = env
        .paths
        .for_space("sp_alice")
        .unwrap()
        .sources_dir()
        .to_path_buf();
    std::os::unix::fs::symlink("/etc/passwd", sources.join("link.txt")).unwrap();
    env.manager
        .start("usr_alice", Some("sp_alice"), T0)
        .await
        .unwrap();
    let ExportStatus::Ready { files, skipped, .. } = env.finish("usr_alice", T0).await else {
        panic!()
    };
    assert_eq!(files, 1);
    assert!(
        skipped
            .iter()
            .any(|line| line.contains("符号链接") && line.contains("link.txt")),
        "{skipped:?}"
    );
    assert!(
        !skipped.iter().any(|line| line.contains("evil")),
        "隔离区里的东西连名字都不透露:{skipped:?}"
    );
}

#[test]
fn export_file_names_are_recognised_strictly() {
    assert!(is_export_name("usr_abc-0123456789abcdef.tar.gz"));
    for bad in [
        "",
        "usr_abc-0123.tar.gz",
        "usr_abc-0123456789ABCDEF.tar.gz",
        "../usr_a-0123456789abcdef.tar.gz",
        "usr_a/b-0123456789abcdef.tar.gz",
        "usr_a-0123456789abcdef.zip",
        "other-0123456789abcdef.tar.gz",
        "usr_a-0123456789abcdef.tar.gz.part",
    ] {
        assert!(!is_export_name(bad), "{bad:?}");
    }
}

// ---------------------------------------------------------------- 笔记

#[tokio::test]
async fn notes_come_from_the_callers_own_space_only_and_are_packed_with_the_files() {
    let env = env();
    env.put("sp_alice", "paper.pdf", b"alice paper");
    env.notes.by_space.lock().unwrap().insert(
        "sp_alice".to_owned(),
        vec![insight("0192aaaa-1", "部署步骤", "alice 的笔记")],
    );
    env.notes.by_space.lock().unwrap().insert(
        "sp_bob".to_owned(),
        vec![insight("0192bbbb-1", "bob 的秘密", "bob private note")],
    );
    let started = env
        .manager
        .start("usr_alice", Some("sp_alice"), T0)
        .await
        .unwrap();
    assert!(
        matches!(
            started,
            ExportStatus::Running {
                files: 1,
                notes: 1,
                ..
            }
        ),
        "{started:?}"
    );
    let ExportStatus::Ready { files, notes, .. } = env.finish("usr_alice", T0).await else {
        panic!("应已完成");
    };
    assert_eq!((files, notes), (1, 1));
    let (path, _) = env.manager.file("usr_alice", T0).await.unwrap().unwrap();
    assert_eq!(
        env.members(&path),
        [
            "manifest.json",
            "notes/_global/部署步骤-0192aaaa.md",
            "sources/paper.pdf"
        ]
    );
    // 只问过 alice 自己的知识库,bob 的笔记不可能进来
    assert_eq!(*env.notes.asked.lock().unwrap(), ["sp_alice"]);
    let mut plain = Vec::new();
    std::io::Read::read_to_end(
        &mut flate2::read::GzDecoder::new(std::fs::File::open(&path).unwrap()),
        &mut plain,
    )
    .unwrap();
    let mine = "alice 的笔记".as_bytes();
    assert!(plain.windows(mine.len()).any(|w| w == mine));
    let theirs = b"bob private note";
    assert!(!plain.windows(theirs.len()).any(|w| w == theirs));
}

#[tokio::test]
async fn someone_with_only_notes_and_no_uploads_can_still_export() {
    let env = env();
    env.notes.by_space.lock().unwrap().insert(
        "sp_alice".to_owned(),
        vec![insight("0192cccc-1", "只有笔记", "内容")],
    );
    env.manager
        .start("usr_alice", Some("sp_alice"), T0)
        .await
        .unwrap();
    assert!(matches!(
        env.finish("usr_alice", T0).await,
        ExportStatus::Ready {
            files: 0,
            notes: 1,
            ..
        }
    ));
}

#[tokio::test]
async fn failing_to_read_notes_aborts_the_export_without_using_up_a_daily_run_or_leaking_details() {
    let env = env();
    env.put("sp_alice", "paper.pdf", b"x");
    env.notes.fail.store(true, Ordering::Relaxed);
    for _ in 0..5 {
        let error = env
            .manager
            .start("usr_alice", Some("sp_alice"), T0)
            .await
            .unwrap_err();
        assert!(matches!(error, KbError::Unavailable(_)), "{error:?}");
        assert!(!error.to_string().contains("/secret/path"), "{error}");
    }
    // 失败了不算一次:5 次失败之后今天的 3 次还都在
    assert!(matches!(
        env.manager.status("usr_alice", T0).await.unwrap(),
        ExportStatus::Idle { today_left: 3 }
    ));
    env.notes.fail.store(false, Ordering::Relaxed);
    env.manager
        .start("usr_alice", Some("sp_alice"), T0)
        .await
        .unwrap();
    assert!(matches!(
        env.finish("usr_alice", T0).await,
        ExportStatus::Ready { .. }
    ));
}
